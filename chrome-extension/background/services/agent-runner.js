// ============ Agent 主运行循环 ============
// 从 agent-service.js 提取的 run() 方法
// 包含：LLM API 调用、工具执行分发、待办进度管理、阶段切换

import { executeDOMTool } from './agent-dom-executor.js'
import { shouldStoreToPayload, storeToPayload, smartTruncateResult, buildDataOverview } from './agent-payload-utils.js'
import { runJudge, saveToChatHistoryStorage, getTargetTab, recordMemory } from './agent-judge.js'
import { buildPhase1Tools, buildPhase2Tools } from './agent-tool-builder.js'
import { WorkingMemory } from './working-memory.js'
import { ContextCompressor } from './context-compressor.js'
import { ScratchpadService } from './scratchpad-service.js'
import { OutputService } from './output-service.js'

/**
 * Agent 主运行循环
 * @param {object} ctx - 运行上下文（包含所有依赖）
 */
export async function runAgent(ctx) {
  const {
    configService, toolService, scriptService,
    agentStates, domainPolicy, payloadStore, todoScheduler,
    filteredScriptsCache, domainMismatchLogged, pageReadCache,
    MAX_AI_REQUESTS, TIMEOUT_MS, ACTION_TIMEOUT_MS,
    postToUI, yieldUI, checkPortConnected,
    tabId, userMessage, chatHistory,
    toolRecordingService, // Feature 4: 工具调用录制
  } = ctx

  const startTime = Date.now()
  await domainPolicy.load()

  let maxRounds = 15
  let enableJudge = true
  let debug = false
  try {
    const agentCfg = await configService.getAgentConfig()
    if (agentCfg?.maxRounds >= 5) maxRounds = agentCfg.maxRounds
    enableJudge = agentCfg?.enableJudge !== false
    debug = agentCfg?.debug === true
  } catch {}

  const _debugLog = (label, detail) => {
    if (!debug) return
    const summary = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)
    console.log(`[AgentDebug] ${label}`, detail)
    try { postToUI(tabId, { type: 'agentDebug', label, detail: summary }) } catch(e) { console.warn('[AgentDebug] postToUI失败', e) }
  }

  // ===== 对话全景窗口消息发送 =====
  let _conversationChannel = null
  const _sendToConversationViewer = (type, payload) => {
    try {
      if (!_conversationChannel) _conversationChannel = new BroadcastChannel('ai-browser-conversation')
      _conversationChannel.postMessage({ type, payload })
    } catch (e) { console.warn('[ConversationViewer] 发送失败', e) }
  }

  const MAX_TOOL_CALLS = Math.min(200, Math.max(30, maxRounds * 3))
  let aiRequestCount = 0
  let totalToolCalls = 0
  let searchResults = []
  const executedTools = []
  const _injections = []

  // ===== ScratchpadService & OutputService 初始化 =====
  const scratchpadService = new ScratchpadService()
  const outputService = new OutputService()
  const _startTime = Date.now()  // 任务开始时间
  let _taskId = null  // 任务 ID（在 finish_task 时生成）

  // ===== WorkingMemory & ContextCompressor 初始化 =====
  // sessionId 已在 agent-service.js 中设置并继承上一轮数据
  const sessionId = payloadStore.getSessionId() || `s_${tabId}_${Date.now()}`
  payloadStore.setSessionId(sessionId)
  const workingMemory = new WorkingMemory()
  const contextCompressor = new ContextCompressor(configService)
  let hasSearchedTools = false
  let _roundRecallDataCount = 0  // 每轮recall_data调用次数
  todoScheduler.clear()
  let currentPhase = 1
  const _recallDataCallCount = new Map()
  const _usedSelectorToolCombo = new Set()

  const rawHistory = (chatHistory || [])
  // 移除末尾连续的失败 agent 回复及其对应 user 消息，避免 LLM 被历史错误误导重复生成相同内容
  const failureMarkers = ['❌', '脚本语法错误', '执行失败', 'Unexpected identifier', 'appKey', 'appSecret', '认证失败', '401', '403']
  while (rawHistory.length >= 2) {
    const last = rawHistory[rawHistory.length - 1]
    if (last.role === 'assistant' && failureMarkers.some(m => last.content?.includes(m))) {
      rawHistory.pop() // 移除失败的 assistant 回复
      // 同时移除对应的 user 消息（如果末尾是 user）
      if (rawHistory.length > 0 && rawHistory[rawHistory.length - 1].role === 'user') {
        rawHistory.pop()
      }
    } else {
      break
    }
  }
  const cleanHistory = rawHistory.map(m => {
    const { toolCalls, tool_calls, ...clean } = m
    // 对长assistant消息进行压缩：保留前500字符+摘要标记
    // 避免对话1的完整输出带入对话2导致上下文膨胀
    if (clean.role === 'assistant' && typeof clean.content === 'string' && clean.content.length > 1000) {
      const original = clean.content
      const head = original.slice(0, 500)
      const tail = original.slice(-200)
      clean.content = head + `\n\n...(对话历史已压缩，原始${original.length}字符)...\n\n` + tail
    }
    return clean
  })

  // ===== Stage 1 系统提示词 =====
  const phase1SystemPrompt = `你是AI Browser智能体，一个能操作网页、调用脚本、整理数据的自主助手。你通过三阶段调度系统执行任务。

=== 三阶段调度系统 ===
系统将任务拆分为三个阶段，每个阶段有不同的工具权限，阶段间自动切换：

Stage 1（页面探索）：使用DOM工具直接在页面上操作（点击、提取、导航等）
  - 目标：获取页面结构信息，提取关键数据（如列表条目、链接、文本等）
  - 原则：只做页面级的探索和数据提取，不逐条深入处理细节
Stage 2（脚本处理）：调用服务端脚本批量处理数据
  - 目标：用专用脚本高效完成需要批量操作的任务（如逐页获取详情、批量转换等）
  - 脚本以 inject_script_N 形式调用，N 是脚本的实际ID数字（请先 search_tools 查看可用脚本的ID，切勿编造不存在的脚本ID）
Stage 3（结果汇总）：输出最终结果
  - 目标：汇总所有已收集的数据，用 finish_task 输出

=== 工作流程 ===
1. 了解当前页面：使用 get_interactive_elements / read_page_content 获取页面概览
2. 规划任务：调用 create_todo 创建三阶段待办列表
3. 系统自动校验待办合规性和数据依赖合法性
4. 按待办顺序执行工具操作，系统自动追踪进度
5. 每个阶段完成后系统自动切换到下一阶段
6. 所有待办完成 → 调用 finish_task 汇报结果

=== Stage 1 可用工具 ===
read_page_content: 读取当前页面标题、URL和正文
extract_content: 提取指定选择器的内容（支持:contains伪类）
click_element: 点击元素
fill_input: 填写输入框
wait_for_element: 等待元素出现
navigate_to: 导航到URL
go_back / go_forward: 浏览器前进/后退
find_text_on_page: 在页面文本中搜索关键词
get_element_info: 获取元素详细信息
get_interactive_elements: 获取可交互元素列表
scroll_page: 滚动页面
hover_element: 悬停元素
select_dropdown: 选择下拉框选项
press_key: 按键
recall_data: 查询已存储的工具执行结果（当结果被自动截断为摘要时，用此工具查看完整数据）
create_todo: 创建分阶段待办列表
search_tools: 搜索工具库，查找可用脚本
finish_task: 任务完成，汇报结果

=== 数据流转机制 ===
工具返回的数据量较大时，系统会自动存储完整数据，只发回摘要+存储ID（如"存储ID: p1"）。
需要查看完整数据时，调用 recall_data(entry_id="p1")。
设置 dataOutputKey 的待办，其输出数据会自动存入全局存储，供后续阶段通过 dataDependKeys 引用。

=== 待办模板 ===
每个子待办需指定:
- action: 使用的工具名称（Stage2必须使用 inject_script_N 格式，N为脚本ID数字）
- dataDependKeys: 依赖的数据key列表（从之前待办的dataOutputKey获取）
- dataOutputKey: 输出数据的语义key（供后续待办引用，无输出设为null）

重要：待办列表创建后不可修改，请在 create_todo 时充分规划。

=== 各阶段职责 ===
Stage 1（页面探索）：获取页面信息和关键数据
  典型流程：1. 了解页面结构  2. 提取所需条目
  注意：不要在Stage1逐条深入处理，需要批量操作的任务交给Stage2的脚本
Stage 2（脚本处理）：用专用脚本批量处理
  典型流程：将Stage1提取的数据传给脚本，由脚本高效完成
Stage 3（结果汇总）：整理并输出结果

=== 示例（以新闻页面为例）===
用户要求"采集新闻列表和内页内容"：
  Stage1: [get_interactive_elements] + [extract_content 提取标题和链接, dataOutputKey="links"]
  Stage2: [inject_script_9 批量获取内页, dataDependKeys=["links"], dataOutputKey="details"]
  Stage3: [finish_task 汇总, dataDependKeys=["links","details"]]

=== 硬性规则（系统强制执行） ===
- Stage 1 不暴露 inject_script_* 工具（必须先在页面探索完才能用脚本）
- 连续4次无进展 → 系统自动切换到Stage 2
- 连续3次脚本失败 → 系统自动切换到Stage 3

=== 任务边界处理 ===
当用户请求超出当前可用工具能力时，请：
1. 检查工具列表：如果不存在完成该请求的工具（如导出文件、下载、写入本地等），直接调用 finish_task 说明
2. 提供替代方案：将数据以用户要求的格式（如CSV、表格）输出在 summary 中，让用户复制使用
3. 不要反复尝试无法完成的操作，避免陷入循环

当连续5次工具调用都无法推进任务时，请调用 finish_task 汇报当前已有结果，说明遇到的困难。

=== 输出规范 ===
- 自然语言总结结果，不输出原始JSON
- 错误时分析原因并在finish_task中告知

=== 对话上下文 ===
你正在与用户进行连续对话。如果上下文中存在"上轮任务数据"或"历史存储数据"，表示之前已执行过任务并产生了结果。
- 这些数据可供你参考和使用，无需重新执行页面操作
- 用户的新需求可能是：继续处理、补充信息、导出结果、修改格式等任何合理请求
- 根据实际需求选择：直接复用历史数据，或执行新操作获取新数据
- 获取历史数据：recall_data(entry_id="all")`

  const systemMsg = { role: 'system', content: phase1SystemPrompt }

  // ===== 自动读取页面内容 =====
  let autoPageContent = null
  try {
    const targetTab = await getTargetTab(tabId)
    if (targetTab) {
      const response = await chrome.tabs.sendMessage(targetTab.id, { type: 'extractPageContent' })
      autoPageContent = response?.data || null
      if (autoPageContent) {
        console.log('[Agent] 自动读取页面内容:', autoPageContent.title, 'URL:', autoPageContent.url, '内容长度:', (autoPageContent.content || '').length)
      }
    }
  } catch (e) {
    console.warn('[Agent] 自动读取页面内容失败（非致命）:', e.message)
  }

  // ===== 自动搜索服务端工具库 =====
  let autoSearchKeywords = []
  try {
    const chineseWords = userMessage.match(/[\u4e00-\u9fff]{2,4}/g) || []
    const pageKeywords = []
    if (autoPageContent) {
      const urlHost = (autoPageContent.url || '').match(/(?:https?:\/\/)?([^./]+)/)?.[1] || ''
      if (urlHost.length >= 2) pageKeywords.push(urlHost)
      const titleWords = (autoPageContent.title || '').match(/[\u4e00-\u9fff]{2,4}/g) || []
      pageKeywords.push(...titleWords.slice(0, 3))
      const contentWords = (autoPageContent.content || '').match(/[\u4e00-\u9fff]{2,4}/g) || []
      const noiseWords = new Set(['可以', '已经', '但是', '因为', '所以', '或者', '如果', '虽然', '我们', '他们', '这个', '那个', '什么', '怎么', '就是', '也是', '不是', '还是', '只是', '以及', '其中', '其他', '一些', '这些', '那些'])
      const meaningfulContentWords = contentWords.filter(w => !noiseWords.has(w)).slice(0, 5)
      pageKeywords.push(...meaningfulContentWords)
    }
    const INTENT_KEYWORDS = {
      '采集': ['采集', '批量'], '批量': ['批量', '采集'], '抓取': ['抓取', '采集'],
      '新闻': ['新闻', '采集'], '导出': ['导出', '下载'], '下载': ['下载', '导出'],
      '翻译': ['翻译'], '监控': ['监控'], '搜索': ['搜索'], '热点': ['热点', '热搜'],
    }
    const expandedWords = new Set(chineseWords)
    for (const word of chineseWords) {
      if (INTENT_KEYWORDS[word]) INTENT_KEYWORDS[word].forEach(w => expandedWords.add(w))
    }
    for (const pw of pageKeywords) {
      if (!expandedWords.has(pw)) expandedWords.add(pw)
    }
    autoSearchKeywords = [...expandedWords].slice(0, 6)
  } catch {}

  if (autoSearchKeywords.length > 0) {
    try {
      const autoResults = await toolService.searchScripts(autoSearchKeywords.join(' '))
      if (autoResults.length > 0) {
        const existingIds = new Set(searchResults.map(s => s.id))
        for (const r of autoResults) {
          if (!existingIds.has(r.id)) {
            searchResults.push(r)
            existingIds.add(r.id)
          }
        }
        hasSearchedTools = true
        console.log(`[Agent] 自动搜索命中${autoResults.length}个脚本:`, autoResults.map(s => `${s.name}(#${s.id})`).join(', '))
      } else {
        hasSearchedTools = true
        console.log('[Agent] 自动搜索无结果:', autoSearchKeywords.join(' '))
      }
    } catch (e) {
      console.warn('[Agent] 自动搜索失败（非致命）:', e.message)
    }
  }

  // ===== 注入页面内容到上下文 =====
  // 明确标注这是 read_page_content 结果，避免AI重复调用
  if (autoPageContent) {
    const pageContentBrief = (autoPageContent.content || '').slice(0, 500)
    let pageContextMsg = `[已执行 read_page_content] 标题: ${autoPageContent.title || '无标题'} | URL: ${autoPageContent.url || ''}\n页面正文: ${pageContentBrief}\n\n⚠️ read_page_content 已自动执行，请勿重复调用此工具。如需更多内容可滚动页面(scroll_page)后再次提取。`
    if (searchResults.length > 0) {
      pageContextMsg += `\n\n已匹配到 ${searchResults.length} 个专用脚本（当前阶段不暴露脚本工具，如DOM工具无法完成任务将自动切换到脚本模式）。`
    } else {
      pageContextMsg += '\n暂无匹配的专用脚本，可使用本地DOM工具操作页面。'
    }
    _injections.push(pageContextMsg)
    // 初始化 WorkingMemory
    workingMemory.init(sessionId, userMessage, autoPageContent)
    const pageUrl = autoPageContent.url || ''
    if (pageUrl) {
      pageReadCache.set(pageUrl, JSON.stringify({
        ok: true,
        title: autoPageContent.title || '',
        url: autoPageContent.url || '',
        content: (autoPageContent.content || '').slice(0, 3000),
      }))
    }
  } else {
    // 无自动页面内容时也初始化 WorkingMemory
    workingMemory.init(sessionId, userMessage)
  }

  const lastHistoryMsg = cleanHistory.length > 0 ? cleanHistory[cleanHistory.length - 1] : null
  const lastIsUserMsg = lastHistoryMsg?.role === 'user' && lastHistoryMsg?.content === userMessage
  const messages = lastIsUserMsg
    ? [systemMsg, ...cleanHistory]
    : [systemMsg, ...cleanHistory, { role: 'user', content: userMessage }]

  // ===== 注入 payloadStore 历史数据摘要（供第二轮对话理解上下文） =====
  const payloadSummary = payloadStore.getSummaryForFinish()
  const globalSummaries = todoScheduler.globalDataStore.getAllSummaries()
  if (payloadSummary || globalSummaries.length > 0) {
    const parts = []
    if (payloadSummary) {
      parts.push(`上一轮执行的工具及结果（${payloadSummary.count}条）：`)
      for (const item of payloadSummary.items) {
        // 显示完整摘要，帮助LLM理解数据内容
        parts.push(`  - ${item.id}(${item.toolName}): ${item.summary}`)
      }
    }
    if (globalSummaries.length > 0) {
      parts.push(`\n全局存储数据：\n${globalSummaries.join('\n')}`)
    }
    _injections.push(`=== 上轮任务数据 ===\n${parts.join('\n')}\n\n你可以用 recall_data(entry_id="all") 获取完整数据，根据用户需求决定如何使用。`)
  }

  // ===== 简单请求快速路径 =====
  // 检测用户请求是否为纯数据操作（导出、格式化、翻译等）且已有上轮数据
  // 此类请求不需要页面探索和脚本执行，直接进入Stage3模式
  const SIMPLE_REQUEST_PATTERNS = ['导出', 'csv', 'excel', '格式化', '整理成', '转换', '翻译', '汇总', '合并', '去重', '统计', '分析', '列表', '重新输出', '再给我']
  // 追问模式：短消息 + 有上轮数据，视为对上次结果的追问
  const isFollowUp = cleanHistory.length > 0
    && (payloadSummary || globalSummaries.length > 0)
    && userMessage.length <= 20
    && !userMessage.match(/采集|抓取|批量获取|爬|下载|打开|访问|点击/)
  const isSimpleDataRequest = (cleanHistory.length > 0
    && (payloadSummary || globalSummaries.length > 0)
    && SIMPLE_REQUEST_PATTERNS.some(p => userMessage.includes(p))
    && !userMessage.match(/采集|抓取|批量获取|爬|下载|打开|访问|点击/))
    || isFollowUp

  if (isSimpleDataRequest) {
    currentPhase = 3
    const allData = todoScheduler.globalDataStore.getAllSummaries()
    const payloadItems = payloadSummary ? payloadSummary.items.map(i => `  - ${i.id}(${i.toolName}): ${i.summary}`).join('\n') : ''
    const quickPrompt = `你是AI Browser智能体。用户请求是对已有数据的简单操作或追问，无需页面探索或脚本执行，直接回答即可。

=== 可用工具 ===
recall_data: 查询已存储的数据（每轮限2次）
finish_task: 输出结果

=== 执行要点 ===
1. 下方已有上轮数据摘要，直接使用即可
2. 如需完整数据，可调用1次recall_data
3. 处理完成后立即调用finish_task输出结果
4. 如果用户是在追问（如"在哪里呢"、"怎么用"），直接回答问题，无需查数据

=== 上轮数据 ===
${allData.length > 0 ? '全局存储:\n' + allData.join('\n') : ''}${payloadItems ? '\n工具结果:\n' + payloadItems : ''}`
    messages.length = 0
    messages.push({ role: 'system', content: quickPrompt })
    messages.push({ role: 'user', content: userMessage })
    _debugLog('⚡ 简单请求快速路径', isFollowUp ? '追问模式，跳过Stage1/2' : '跳过Stage1/2，直接Stage3模式')
  }

  postToUI(tabId, { type: 'agentStart' })
  _debugLog('🐛 调试模式已开启', '待办调度系统：系统驱动进度追踪、收敛提示、阶段切换')
  _debugLog('⚙️ Agent配置', { maxRounds, enableJudge, debug })
  _debugLog('📋 系统提示词', systemMsg.content)

  // ===== 主循环开始 =====
  while (aiRequestCount < maxRounds) {
    // 检查是否被新任务中止
    const curState = agentStates.get(tabId)
    if (curState?.aborted) {
      console.log('[Agent] 检测到中止信号，退出主循环')
      return
    }
    if (Date.now() - startTime > TIMEOUT_MS) {
      postToUI(tabId, { type: 'agentError', error: 'Agent执行超时' })
      await saveToChatHistoryStorage('⚠️ Agent 执行超时，请简化任务后重试。', [])
      return
    }
    if (totalToolCalls >= MAX_TOOL_CALLS) {
      postToUI(tabId, { type: 'agentError', error: '工具调用次数超限，请简化任务重试' })
      await saveToChatHistoryStorage('⚠️ 工具调用次数超限，请简化任务后重试。', [])
      return
    }

    aiRequestCount++
    _roundRecallDataCount = 0  // 每轮重置recall_data计数
    
    // ===== 清理临时消息（_temp标记） =====
    // 上一轮注入的依赖数据已使用完毕，清理避免累积膨胀
    const tempMsgs = messages.filter(m => m._temp)
    if (tempMsgs.length > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]._temp) {
          messages.splice(i, 1)
        }
      }
      _debugLog('🧹 清理临时消息', { removed: tempMsgs.length })
    }
    
    // ===== 同步 currentPhase =====
    if (todoScheduler.parentTodo && todoScheduler.currentStage !== currentPhase) {
      const newPhase = todoScheduler.currentStage
      _debugLog('🔄 阶段正常完成，同步 currentPhase', { from: currentPhase, to: newPhase })

      // 记录阶段切换到 WorkingMemory
      workingMemory.addStageSwitch(currentPhase, newPhase, `阶段${currentPhase}待办全部完成`, aiRequestCount)

      // 生成阶段交接摘要（LLM驱动 + WorkingMemory补充）
      const handoffSummary = await contextCompressor.generateHandoff(
        messages, userMessage, workingMemory, currentPhase, newPhase,
        `阶段${currentPhase}待办全部完成`
      )

      if (newPhase === 2) {
        let scriptList = ''
        if (searchResults.length > 0) {
          scriptList = '\n\n=== 已匹配的专用脚本 ===\n' + searchResults.map(s => {
            const params = s.toolConfig?.parameters?.properties ? Object.keys(s.toolConfig.parameters.properties) : []
            const paramHint = params.length > 0 ? `（参数: ${params.join(', ')}）` : ''
            return `  - inject_script_${s.id}(${s.name})${paramHint}: ${(s.description || '').slice(0, 80)}`
          }).join('\n')
        }
        let dataSummary = ''
        const summaries = todoScheduler.globalDataStore.getAllSummaries()
        if (summaries.length > 0) {
          dataSummary = '\n\n=== 全局存储数据 ===\n  ' + summaries.join('\n  ')
          const allUrls = todoScheduler.globalDataStore.getAllUrls()
          if (allUrls.length > 0) {
            dataSummary += `\n\n💡 已有${allUrls.length}个URL链接，可直接传给inject_script_*作为参数。`
          }
        }
        
        // ===== 依赖数据自动注入（不进入 messages 历史，标记 _temp） =====
        let dependDataInjection = ''
        const currentTodo = todoScheduler.getCurrentTodo()
        if (currentTodo?.dataDependKeys?.length > 0) {
          _debugLog('📦 依赖数据注入', { keys: currentTodo.dataDependKeys })
          const dependDataItems = []
          for (const key of currentTodo.dataDependKeys) {
            const data = todoScheduler.globalDataStore.get(key)
            if (data) {
              dependDataItems.push({ key, data })
            }
          }
          if (dependDataItems.length > 0) {
            dependDataInjection = '\n\n=== 依赖数据已自动加载 ===\n以下数据已从全局存储自动注入，可直接使用，无需 recall_data：\n'
            for (const { key, data } of dependDataItems) {
              // 精简展示（截断到2000字符，避免注入过大）
              const dataPreview = typeof data === 'string' ? data : JSON.stringify(data)
              const truncatedPreview = dataPreview.length > 2000 ? dataPreview.slice(0, 2000) + '\n...(数据过长已截断，完整数据存储于全局)' : dataPreview
              dependDataInjection += `\n【${key}】:\n${truncatedPreview}\n`
            }
            dependDataInjection += '\n⚠️ 此数据为本轮临时注入（不进入历史），下轮自动清理。'
          }
        }
        
        const phase2Prompt = `你是AI Browser智能体，现在进入 Stage 2（脚本处理阶段）。

=== 核心任务 ===
查看待办列表中 Stage 2 的子待办，使用专用脚本完成批量处理。

=== Stage 2 可用工具 ===
search_tools: 搜索工具库，查找可用脚本
inject_script_N: 执行ID为N的脚本（请使用 search_tools 查到的脚本ID，勿编造）
recall_data: 查询已存储的工具执行结果（每轮限2次）
read_page_content: 读取当前页面（仅辅助查看，不算任务进展）
finish_task: 任务完成，汇报结果

=== 执行要点 ===
1. 优先调用 inject_script_* 执行脚本，这是Stage2的主要工作
2. 当前待办的依赖数据已自动注入上下文，直接使用即可，无需recall_data重复查询
3. 脚本执行成功后，结果会自动存入全局存储，直接调用 finish_task 汇报即可
4. read_page_content 只在需要确认页面状态时使用，不应替代脚本执行
5. 如果脚本未匹配或多次失败，调用 finish_task 说明原因${scriptList}`
        // 阶段切换：清空消息但注入交接摘要，保留上下文连续性
        messages.length = 0
        messages.push({ role: 'system', content: phase2Prompt })
        if (handoffSummary) {
          messages.push({ role: 'system', content: `=== 前序阶段交接 ===\n${handoffSummary}` })
        }
        // 依赖数据临时注入（标记 _temp，下轮清理）
        if (dependDataInjection) {
          messages.push({ role: 'system', content: dependDataInjection, _temp: true })
        }
        messages.push({ role: 'user', content: userMessage + (dataSummary || '\n\n（无已收集数据，请直接使用脚本或搜索工具库。）') })
        _debugLog('🔄 Stage2提示词已注入（正常完成路径）', { scriptCount: searchResults.length, dataKeys: summaries.length, hasHandoff: !!handoffSummary, hasDependData: !!dependDataInjection })
      } else if (newPhase === 3) {
        const allData = todoScheduler.globalDataStore.getAllSummaries()
        const phase3Prompt = `你是AI Browser智能体，现在进入 Stage 3（结果汇总阶段）。

=== 核心任务 ===
汇总前面阶段收集的所有数据，输出结构化的最终结果。

=== Stage 3 可用工具 ===
recall_data: 查询已存储的数据（每轮限2次，仅当上下文中的数据摘要不够时使用）
finish_task: 输出最终汇总结果

=== 执行要点 ===
1. 下方已有全局存储数据摘要和依赖数据，优先直接使用，避免浪费轮次
2. 将数据整理为清晰的汇总：包含数据条数、核心字段、代表性样本
3. 调用 finish_task 输出结果，用自然语言描述而非原始JSON
4. 如果用户要求导出/格式转换（如CSV、表格），直接在finish_task的summary中输出格式化文本

=== 全局存储数据 ===
${allData.length > 0 ? allData.join('\n') : '（无数据）'}`
        // 阶段切换：清空消息但注入交接摘要
        messages.length = 0
        messages.push({ role: 'system', content: phase3Prompt })
        if (handoffSummary) {
          messages.push({ role: 'system', content: `=== 前序阶段交接 ===\n${handoffSummary}` })
        }
        messages.push({ role: 'user', content: userMessage + '\n\n请汇总所有已收集的数据并输出最终结果。' })
        _debugLog('🔄 Stage3提示词已注入（正常完成路径）', { dataKeys: allData.length, hasHandoff: !!handoffSummary })
      }
      currentPhase = newPhase
    }

    // ===== Port 连接检查 =====
    // 如果用户关闭了 SidePanel，终止任务避免后台空转
    if (checkPortConnected && !checkPortConnected(tabId)) {
      console.log('[Agent] Port 已断开，终止任务')
      _debugLog('🚫 Port 断开终止', { round: aiRequestCount })
      return
    }

    postToUI(tabId, { type: 'agentStatus', text: `思考中... (第${aiRequestCount}轮)` })
    await yieldUI()

    // 收敛提示
    const convergencePrompt = todoScheduler.getConvergencePrompt(aiRequestCount, maxRounds)
    if (convergencePrompt) {
      _debugLog('💡 系统收敛提示', convergencePrompt)
      _injections.push(convergencePrompt)
    }

    // 待办进度上下文
    if (todoScheduler.parentTodo) {
      const stageCtx = todoScheduler.getStageContext()
      if (stageCtx) _injections.push(stageCtx)
    }

    // ===== WorkingMemory 结构化上下文注入 =====
    // 去重策略：
    //   - 阶段切换后前2轮，交接摘要已包含完整 WorkingMemory 信息，不重复注入
    //   - 页面信息已在 userMessage 中，toContext 跳过 includePage
    //   - 交接摘要覆盖 discoveries/decisions/dataRefs/stageHistory，只补充 errors
    if (aiRequestCount > 1) {
      const roundsSinceStageSwitch = workingMemory.state.stageHistory.length > 0
        ? aiRequestCount - (workingMemory.state.stageHistory[workingMemory.state.stageHistory.length - 1]?.round || 0)
        : 999
      if (roundsSinceStageSwitch > 2) {
        // 距阶段切换超过2轮，注入完整 WorkingMemory（不含页面信息，避免与 userMessage 重复）
        const memoryContext = workingMemory.toContext({ includeErrors: true, includePage: false, maxLen: 1200 })
        if (memoryContext) _injections.push(memoryContext)
      } else {
        // 阶段切换后前2轮，只注入错误和排除信息（交接摘要已包含其他信息）
        const recentErrors = workingMemory.state.errors.slice(-3)
        const excluded = workingMemory.state.excluded
        const extraParts = []
        if (recentErrors.length > 0) {
          extraParts.push(`近期错误:\n${recentErrors.map(e => `  - ${e.tool}: ${e.error}`).join('\n')}`)
        }
        if (excluded.length > 0) {
          extraParts.push(`已排除: ${excluded.join('; ')}`)
        }
        if (extraParts.length > 0) {
          _injections.push(extraParts.join('\n\n'))
        }
      }
    }

    // 获取当前页面URL
    let currentPageUrl = ''
    try {
      const tab = await getTargetTab(tabId)
      currentPageUrl = tab?.url || ''
    } catch {}

    postToUI(tabId, { type: 'agentStatus', text: `阶段${currentPhase} 第${aiRequestCount}轮` })

    // 构建工具列表
    let tools
    if (currentPhase === 1) {
      tools = buildPhase1Tools(currentPageUrl, aiRequestCount + 1, scriptService, filteredScriptsCache, domainMismatchLogged)
    } else if (currentPhase === 2) {
      tools = buildPhase2Tools(searchResults, currentPageUrl, aiRequestCount + 1, scriptService, filteredScriptsCache, domainMismatchLogged)
    } else {
      tools = [
        { type: 'function', function: { name: 'recall_data', description: '从已存储的工具结果中查询数据', parameters: { type: 'object', properties: { entry_id: { type: 'string' }, tool_name: { type: 'string' }, filter: { type: 'string' }, fields: { type: 'string' } } } } },
        { type: 'function', function: { name: 'finish_task', description: '任务完成，汇报结果', parameters: { type: 'object', properties: { summary: { type: 'string', description: '完成摘要' } }, required: ['summary'] } } }
      ]
    }

    console.log(`[Agent] 阶段${currentPhase} 第${aiRequestCount}轮API请求, tools:${tools.length}个, 已搜到${searchResults.length}个脚本`)
    _debugLog(`🔧 阶段${currentPhase} 第${aiRequestCount}轮 工具(${tools.length}个)`, tools.map(t => `  ${t.function.name}`).join('\n'))

    // 系统消息聚合
    const systemNudges = []
    while (_injections.length > 0) systemNudges.push(_injections.shift())
    if (systemNudges.length > 0) {
      messages.push({ role: 'system', content: systemNudges.join('\n') })
    }

    const config = await configService.getAIConfig()
    const auth = await configService.getAppAuth()
    const body = {
      model: config.model, messages, temperature: 0.3,
      max_tokens: Math.min(Math.max(config.maxTokens || 2048, 2048), 4096),
      tools, tool_choice: 'auto',
    }

    const msgSummary = messages.map((m, i) => {
      // assistant 消息有 tool_calls 时，显示工具调用信息而非 null content
      if (m.role === 'assistant' && m.tool_calls?.length > 0) {
        return {
          idx: i, role: m.role,
          preview: `tool_calls: ${m.tool_calls.map(tc => tc.function?.name).join(', ')}`,
          len: m.tool_calls.length,
          tool_calls: m.tool_calls.map(tc => ({ name: tc.function?.name, id: tc.id }))
        }
      }
      // 其他消息正常处理
      return {
        idx: i, role: m.role,
        preview: typeof m.content === 'string' ? (m.content.length > 100 ? m.content.slice(0, 100) + '...' : m.content) : String(m.content ?? ''),
        len: typeof m.content === 'string' ? m.content.length : 0,
        tc_id: m.tool_call_id || undefined
      }
    })
    _debugLog(`📤 第${aiRequestCount}轮 发送LLM`, JSON.stringify({ model: config.model, msgs: messages.length, lastRole: messages[messages.length - 1]?.role, tools: tools.length, msgSummary }, null, 2))

    // ===== 对话全景：记录发送前的messages（不含本轮响应和工具结果） =====
    const _requestMessagesSnapshot = messages.slice()

    const url = await configService.getAIProxyUrl()

   try {
      const headers = await configService.generateAuthHeaders(auth.appKey, auth.appSecret)
      const MAX_API_RETRIES = 2
      const API_TIMEOUT_MS = 60000
      let res, lastError
      
      // ===== 心跳机制：保持 Service Worker 活跃 =====
      // Chrome Service Worker 空闲约30秒后会终止，定期心跳可延长存活时间
      const heartbeatInterval = setInterval(() => {
        chrome.storage.local.get('_heartbeat', () => {
          console.log('[Agent] 心跳：保持 Service Worker 活跃')
        })
      }, 20000)  // 每20秒发送一次心跳
      
      for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
        try {
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
          const waitNotifyId = setTimeout(() => {
            postToUI(tabId, { type: 'agentStatus', status: 'thinking', text: `思考中... (第${aiRequestCount + 1}轮) - API响应较慢，请耐心等待` })
          }, 15000)
          res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
          clearTimeout(timeoutId)
          clearTimeout(waitNotifyId)
          clearInterval(heartbeatInterval)  // API响应后停止心跳
          if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) break
          if (attempt < MAX_API_RETRIES) {
            const waitMs = (attempt + 1) * 1000
            console.warn(`[Agent] API返回 ${res.status}，${waitMs}ms后重试 (${attempt + 1}/${MAX_API_RETRIES})`)
            postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: '等待重试', status: 'waiting' })
            await new Promise(r => setTimeout(r, waitMs))
          }
        } catch (e) {
          lastError = e
          const isTimeout = e.name === 'AbortError'
          clearInterval(heartbeatInterval)  // 异常时也停止心跳
          if (isTimeout) {
            console.warn(`[Agent] API请求超时(${API_TIMEOUT_MS}ms)，尝试 ${attempt + 1}/${MAX_API_RETRIES + 1}`)
            if (attempt < MAX_API_RETRIES) postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: '请求超时，重试中', status: 'waiting' })
          } else {
            console.warn(`[Agent] API请求异常: ${e.message}，${(attempt + 1) * 1000}ms后重试 (${attempt + 1}/${MAX_API_RETRIES})`)
          }
          if (attempt < MAX_API_RETRIES) await new Promise(r => setTimeout(r, (attempt + 1) * 1000))
        }
      }

      if (!res || !res.ok) {
        let errDetail = ''
        try { const errJson = await res?.json(); errDetail = errJson?.error?.message || errJson?.message || JSON.stringify(errJson).slice(0, 200) } catch {}
        console.error('[Agent] API请求失败:', res?.status, errDetail)
        if ((res?.status === 400 || res?.status === 413) && body.tools) {
          console.warn('[Agent] API返回', res.status, '，尝试不带tools参数重试。原因:', errDetail)
          const fallbackBody = { ...body }
          delete fallbackBody.tools
          delete fallbackBody.tool_choice
          const fbMessages = [...fallbackBody.messages]
          for (let i = fbMessages.length - 1; i >= Math.max(0, fbMessages.length - 3); i--) {
            if (fbMessages[i].content && fbMessages[i].content.length > 800) {
              fbMessages[i] = { ...fbMessages[i], content: fbMessages[i].content.slice(0, 800) + '...(已截断)' }
            }
          }
          fallbackBody.messages = fbMessages
          try {
            const controller2 = new AbortController()
            const timeoutId2 = setTimeout(() => controller2.abort(), API_TIMEOUT_MS)
            const fallbackRes = await fetch(url, { method: 'POST', headers, body: JSON.stringify(fallbackBody), signal: controller2.signal })
            clearTimeout(timeoutId2)
            if (fallbackRes.ok) {
              res = fallbackRes
            } else {
              let fbErr = ''
              try { const fe = await fallbackRes?.json(); fbErr = fe?.error?.message || fe?.message || JSON.stringify(fe).slice(0, 200) } catch {}
              console.error('[Agent] 不带tools重试也失败:', fallbackRes?.status, fbErr)
              postToUI(tabId, { type: 'agentError', error: `AI API错误: ${fallbackRes?.status || '未知'} — ${fbErr || errDetail || '不支持Function Calling或请求过大'}` })
              return
            }
          } catch (e2) {
            postToUI(tabId, { type: 'agentError', error: `AI API错误: ${e2.message}` })
            return
          }
        } else {
          postToUI(tabId, { type: 'agentError', error: `AI API错误: ${res?.status || '网络错误'}${lastError ? ' (' + lastError.message + ')' : ''}` })
          return
        }
      }

      const data = await res.json()
      const choice = data.choices?.[0]
      const msg = choice?.message
      console.log(`[Agent] 第${aiRequestCount}轮响应:`, msg?.tool_calls?.length ? `tool_calls:${msg.tool_calls.length}` : (msg?.content ? `text:${msg.content}` : 'empty'))

      if (!msg) {
        postToUI(tabId, { type: 'agentError', error: 'AI返回为空' })
        return
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        console.log('[Agent] tool_calls:', msg.tool_calls.map(t => t.function.name).join(', '))
        _debugLog(`📥 第${aiRequestCount}轮 LLM响应: tool_calls`, msg.tool_calls.map(t => `${t.function.name}(${JSON.stringify(t.function.arguments || {})})`).join('\n'))
        // 输出已存储数据信息
        const storedDataSummary = payloadStore.entries.filter(e => e.sessionId === sessionId).map(e => {
          const dataPreview = Array.isArray(e.data) ? `数组${e.data.length}条` : typeof e.data === 'object' ? '对象' : `字符串${String(e.data).length}字符`
          return `${e.id}: ${e.toolName} (${dataPreview})`
        })
        if (storedDataSummary.length > 0) {
          _debugLog(`💾 已存储数据 (${storedDataSummary.length}条)`, storedDataSummary.join('\n'))
        }
        messages.push({ role: 'assistant', content: null, tool_calls: msg.tool_calls })
        let shouldTerminateSequence = false

        // ===== 对话全景：收集工具执行结果 =====
        const _roundToolResults = []

        for (const toolCall of msg.tool_calls) {
          if (shouldTerminateSequence) {
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ skipped: true, reason: '页面已跳转，后续操作被跳过' }) })
            continue
          }
          if (totalToolCalls >= MAX_TOOL_CALLS) {
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ skipped: true, reason: '工具调用次数已达上限' }) })
            continue
          }

          const funcName = toolCall.function.name
          let funcArgs = {}
          try { funcArgs = JSON.parse(toolCall.function.arguments || '{}') } catch {}

          // 工具名称验证
          const allowedToolNames = tools.map(t => t.function.name)
          if (!allowedToolNames.includes(funcName)) {
            const rejectMsg = JSON.stringify({ ok: false, error: `工具 "${funcName}" 不在当前可用工具列表中，调用被拒绝。可用工具：${allowedToolNames.join('、')}。请仅使用列表中的工具。` })
            console.warn(`[Agent] 工具幻觉拦截: ${funcName}`)
            _debugLog('🚫 工具幻觉拦截', { rejected: funcName, allowed: allowedToolNames })
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: rejectMsg })
            postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls + 1, toolName: `${funcName}(幻觉拦截)`, result: rejectMsg, done: false })
            continue
          }

          totalToolCalls++
          let _intercepted = false

          postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: funcArgs })
          await yieldUI()

          // Feature 4: 工具调用计时起点
          const _toolStartTime = Date.now()
          let toolResult
          if (funcName === 'recall_data') {
            _roundRecallDataCount++
            // 每轮限制recall_data最多2次，防止循环浪费轮次
            if (_roundRecallDataCount > 2) {
              toolResult = JSON.stringify({ error: '本轮recall_data已用完(限2次)，请直接使用已有数据推进任务，或调用finish_task输出结果。', hint: '避免反复查询相同数据浪费轮次' })
              console.log('[Agent] recall_data 被拦截：本轮已调用2次')
            } else {
            const entryIds = (funcArgs.entry_id || '').split(',').map(s => s.trim()).filter(Boolean)
            const mode = funcArgs.mode || 'summary'  // 支持 mode 参数
            
            let overLimitIds = []
            for (const eid of entryIds) {
              const count = (_recallDataCallCount.get(eid) || 0) + 1
              _recallDataCallCount.set(eid, count)
              if (count > 3) overLimitIds.push(`${eid}(已查${count}次)`)
            }
            if (overLimitIds.length > 0) {
              _injections.push(`💡 提示：以下存储数据已查询3次以上：${overLimitIds.join(', ')}。建议推进下一步操作或调用finish_task。`)
            }
            // 先查 PayloadStore，再回退查 GlobalDataStore
            let queryResult = payloadStore.query(funcArgs)
            const isPayloadEmpty = queryResult?.error || (Array.isArray(queryResult?.entries) && queryResult.entries.length === 0)
            if (isPayloadEmpty && todoScheduler.globalDataStore) {
              const gdsResult = todoScheduler.globalDataStore.query(funcArgs)
              if (gdsResult && !gdsResult.error) {
                // GlobalDataStore 结果必须走截断：将完整数据存入 PayloadStore，只发摘要
                if (gdsResult.entries && gdsResult.entries.length > 0) {
                  const truncatedEntries = gdsResult.entries.map(entry => {
                    const fullData = entry.value ?? entry.data
                    const dataStr = typeof fullData === 'string' ? fullData : JSON.stringify(fullData || '')
                    if (dataStr.length > 1500) {
                      // 大数据：存入 PayloadStore，只返回摘要+ID
                      const storeId = payloadStore.add('recall_data', fullData, entry.summary || dataStr.slice(0, 100), { sourceKey: entry.id || entry.key, count: Array.isArray(fullData) ? fullData.length : 1 })
                      // 同步更新 WorkingMemory 数据引用
                      workingMemory.addDataRef(entry.id || entry.key, storeId, Array.isArray(fullData) ? fullData.length : 1, entry.summary || 'GlobalDataStore数据')
                      return { id: entry.id || entry.key, storeId, summary: entry.summary || dataStr.slice(0, 150), hint: `数据已存储(ID:${storeId})，如需完整内容请用 recall_data(entry_id="${storeId}", mode="full")` }
                    }
                    // 小数据：直接返回
                    return entry
                  })
                  queryResult = { entries: truncatedEntries, count: gdsResult.count, source: 'GlobalDataStore' }
                } else {
                  queryResult = gdsResult
                }
              }
            }
            
            // ===== mode="full" 时返回完整数据 =====
            if (mode === 'full' && queryResult?.entries?.length > 0) {
              const fullDataEntries = queryResult.entries.map(entry => {
                // 从 PayloadStore 获取完整数据
                const fullEntry = payloadStore.entries.find(e => e.id === entry.id || e.id === entry.storeId)
                const fullData = fullEntry?.data || entry.value || entry.data
                return { id: entry.id || entry.storeId, data: fullData }
              })
              // 完整数据返回（标记 _temp，下轮清理）
              toolResult = JSON.stringify({ ok: true, entries: fullDataEntries, mode: 'full', _hint: '完整数据已返回，此消息为本轮临时注入（下轮清理）' })
              console.log(`[Agent] recall_data mode=full，返回完整数据（${fullDataEntries.length}条）`)
            } else {
              // mode="summary"（默认）：返回精简摘要
              toolResult = JSON.stringify(queryResult)
              console.log('[Agent] recall_data:', funcArgs, '→', JSON.stringify(queryResult).slice(0, 100))
            }
            
            postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: 'recall_data', result: typeof queryResult === 'object' ? JSON.stringify(queryResult).slice(0, 200) : queryResult, done: false })
            } // end of else (recall_data正常执行)
          } else if (funcName === 'finish_task') {
            console.log('[Agent] finish_task, summary:', funcArgs.summary, 'data_refs:', funcArgs.data_refs)

            // ===== finish_task 也需要更新待办进度 =====
            if (todoScheduler.parentTodo) {
              const currentTodo = todoScheduler.getCurrentTodo()
              if (currentTodo && currentTodo.action === 'finish_task') {
                todoScheduler.markTodoResult('done', { summary: funcArgs.summary })
                todoScheduler.recordProgress()
              }
              postToUI(tabId, { type: 'agentTodoUpdate', data: { stages: todoScheduler.parentTodo.stages || [], progress: todoScheduler.getProgress(), currentStage: todoScheduler.currentStage, lastTool: 'finish_task', lastProgress: true } })
            }

            // ===== 处理 data_refs 参数：自动注入引用数据 =====
            let referencedDataContent = ''
            const dataRefsStr = funcArgs.data_refs || ''
            if (dataRefsStr) {
              const dataRefIds = dataRefsStr.split(',').map(s => s.trim()).filter(Boolean)
              _debugLog('📦 finish_task 数据引用', { refs: dataRefIds })
              for (const refId of dataRefIds) {
                const entry = payloadStore.entries.find(e => e.id === refId)
                if (entry?.data) {
                  // 格式化数据输出
                  const dataPreview = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2)
                  referencedDataContent += `\n\n=== 数据 ${refId} (${entry.toolName}) ===\n${dataPreview}`
                }
              }
              if (referencedDataContent) {
                referencedDataContent = '\n\n【引用的完整数据】' + referencedDataContent
              }
            }
            
            const payloadSummary = payloadStore.getSummaryForFinish()
            if (payloadSummary) {
              const summaryHint = `\n[存储数据汇总] 共${payloadSummary.count}条存储：${payloadSummary.items.map(e => `${e.id}(${e.toolName})`).join(', ')}。需要详细内容可调用 recall_data(entry_id="all")`
              messages.push({ role: 'system', content: summaryHint })
            }
            const summary = funcArgs.summary || '任务已完成'
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ ok: true, summary }) })
            
            // ===== 事后自评（先执行，结果合并到 summary 后统一输出） =====
            let judgeResult = null
            let finalOutput = summary + referencedDataContent  // 包含引用数据
            if (enableJudge) {
              try {
                judgeResult = await runJudge(configService, userMessage, summary, executedTools)
                if (judgeResult) {
                  const judgeMsg = `\n\n---\n📋 **结果评估**：${judgeResult.verdict === 'success' ? '✅ 任务完成' : judgeResult.verdict === 'partial' ? '⚠️ 部分完成' : '❌ 可能未完成'}\n${judgeResult.comment || ''}`
                  finalOutput = summary + referencedDataContent + judgeMsg
                }
              } catch (e) { console.warn('[Agent] 事后自评失败（非致命）:', e.message) }
            }
            
            // 流式输出完整内容（summary + referencedData + judgeMsg）
            for (const char of finalOutput) {
              postToUI(tabId, { type: 'streamChunk', content: char })
              await new Promise(r => setTimeout(r, 15))
            }
            postToUI(tabId, { type: 'streamDone' })
            
            // 只调用一次 saveToChatHistoryStorage（保存完整输出）
            await saveToChatHistoryStorage(finalOutput, executedTools.map(t => ({ name: t.name, result: typeof t.result === 'string' ? t.result : JSON.stringify(t.result || '') })))
            
            // Feature 4: finish_task 录制
            if (toolRecordingService) {
              try { toolRecordingService.record('finish_task', funcArgs, summary, Date.now() - _toolStartTime) } catch {}
            }
            
            // ===== Output 持久化 =====
            // 生成任务 ID 并保存完整输出
            _taskId = outputService.generateTaskId()
            const endTime = Date.now()
            const output = {
              taskId: _taskId,
              sessionId: sessionId,
              userMessage: userMessage,
              startTime: _startTime,
              endTime: endTime,
              durationMs: endTime - _startTime,
              status: judgeResult?.verdict || 'unknown',
              summary: summary,
              workingMemoryState: workingMemory.state,
              dataOutputs: payloadStore.entries.map(e => ({
                id: e.id,
                toolName: e.toolName,
                summary: e.summary,
                count: Array.isArray(e.data) ? e.data.length : 1,
              })),
              judgeResult: judgeResult || null,
            }
            try {
              await outputService.save(output)
              console.log(`[OutputService] 任务输出已保存: taskId=${_taskId}`)
            } catch (e) {
              console.warn('[OutputService] 保存失败（非致命）:', e.message)
            }
            
            // ===== 任务完成后关闭待办面板 =====
            // 延迟2秒关闭，让用户看到最终完成状态后再自动关闭
            setTimeout(() => {
              try {
                const bc = new BroadcastChannel('ai-browser-todo')
                bc.postMessage({ type: 'agentTodoClear' })
                bc.close()
              } catch {}
              try {
                chrome.tabs.sendMessage(tabId, { type: 'todoUpdate', data: { stages: [], progress: { total: 0, completed: 0 }, currentStage: 1, _taskDone: true } }).catch(() => {})
              } catch {}
              // 对话全景：发送任务完成标记
              _sendToConversationViewer('conversationTaskDone', null)
            }, 2000)
            
            return
          } else if (funcName === 'capture_network') {
            const targetTab = await getTargetTab(tabId)
            if (!targetTab) {
              toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用' })
            } else {
              const filter = { url: funcArgs.url, status: funcArgs.status, limit: funcArgs.limit || 10 }
              try {
                const [captureResult] = await chrome.scripting.executeScript({
                  target: { tabId: targetTab.id },
                  func: (filter) => { if (!window.__aiBrowserGetCaptured) return { ok: false, error: '网络捕获未就绪' }; return { ok: true, result: window.__aiBrowserGetCaptured(filter) } },
                  args: [filter],
                })
                toolResult = JSON.stringify(captureResult?.result || { ok: false, error: '无数据' })
              } catch (e) { toolResult = JSON.stringify({ ok: false, error: e.message }) }
            }
          } else if (funcName === 'search_tools') {
            hasSearchedTools = true
            const query = funcArgs.query || userMessage
            postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: 'search_tools', toolArgs: { query }, status: 'searching' })
            const newResults = await toolService.searchScripts(query)
            const existingIds = new Set(searchResults.map(s => s.id))
            for (const r of newResults) { if (!existingIds.has(r.id)) { searchResults.push(r); existingIds.add(r.id) } }
            if (newResults.length === 0) {
              const noResultHint = currentPhase === 2
                ? `未找到与"${query}"匹配的专用脚本。请尝试搜索其他关键词，如果多次搜索无果，请调用finish_task总结当前结果并告知用户需要开发专用脚本。`
                : `未找到与"${query}"匹配的专用工具。你可以用本地DOM工具直接在页面上操作，也可以尝试搜索其他关键词。`
              toolResult = JSON.stringify({ ok: true, result: noResultHint })
            } else {
              toolResult = JSON.stringify(newResults.slice(0, 5).map(t => ({ id: t.id, name: t.name, description: t.description, toolType: t.toolType, toolConfig: t.toolConfig ? '已配置' : '未配置' })))
            }
            executedTools.push({ name: 'search_tools', result: { ok: newResults.length > 0, count: newResults.length } })
            postToUI(tabId, { type: 'agentSearchResult', results: newResults.slice(0, 5) })
          } else if (funcName === 'create_todo') {
            let stagesArg = funcArgs.stages || []
            if (typeof stagesArg === 'string') { try { const parsed = JSON.parse(stagesArg.trim()); if (Array.isArray(parsed)) stagesArg = parsed } catch {} }

            // ===== 脚本ID存在性校验 =====
            // 提取所有 inject_script_N 的 action，检查对应脚本是否在搜索结果中
            const availableScriptIds = new Set(searchResults.map(s => `inject_script_${s.id}`))
            const scriptIdErrors = []
            if (Array.isArray(stagesArg)) {
              for (const stage of stagesArg) {
                if (!Array.isArray(stage?.subTodos)) continue
                for (const todo of stage.subTodos) {
                  if (todo.action && todo.action.startsWith('inject_script_')) {
                    if (!availableScriptIds.has(todo.action)) {
                      const available = [...availableScriptIds].join(', ') || '（请先调用 search_tools 搜索）'
                      scriptIdErrors.push(`待办 ${todo.id || '?'} 的 action "${todo.action}" 对应的脚本不存在。当前可用脚本: ${available}`)
                    }
                  }
                }
              }
            }
            if (scriptIdErrors.length > 0) {
              toolResult = JSON.stringify({ ok: false, error: `待办列表校验失败：\n${scriptIdErrors.join('\n')}\n请使用 search_tools 查询到的脚本ID，勿编造不存在的脚本。` })
              _debugLog('❌ 脚本ID不存在', scriptIdErrors)
            } else {
              const submitResult = todoScheduler.submitTodo(stagesArg)
              if (submitResult.ok) {
                const progress = todoScheduler.getProgress()
                toolResult = JSON.stringify({ ok: true, result: `待办列表已创建并通过校验：共${progress.total}个待办。系统将按待办顺序驱动执行，自动跟踪进度和切换阶段。当前待办: ${todoScheduler.getCurrentTodo()?.id || '无'} - ${todoScheduler.getCurrentTodo()?.description || ''}` })
                _debugLog('📋 待办列表已创建', { total: progress.total, currentStage: todoScheduler.currentStage })
              } else {
                const errors = submitResult.errors || [submitResult.error || '校验失败']
                toolResult = JSON.stringify({ ok: false, error: `待办列表校验失败：\n${errors.join('\n')}\n请修正后重新提交。` })
                _debugLog('❌ 待办校验失败', errors)
              }
            }
            const isCreateTodoOk = !scriptIdErrors.length && todoScheduler.parentTodo
            executedTools.push({ name: 'create_todo', result: { ok: isCreateTodoOk, total: todoScheduler.totalTodos || 0 } })
            postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: 'create_todo', result: toolResult, done: false })
            if (isCreateTodoOk) {
              postToUI(tabId, { type: 'agentTodoUpdate', data: { stages: todoScheduler.parentTodo?.stages || [], progress: todoScheduler.getProgress(), currentStage: todoScheduler.currentStage } })
            }
          } else if (funcName === 'read_page_content') {
            const targetTab = await getTargetTab(tabId)
            if (!targetTab) {
              toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用' })
            } else {
              const pageUrl = targetTab.url || ''
              const cachedRead = pageReadCache.get(pageUrl)
              if (cachedRead) {
                console.log('[Agent] read_page_content 命中缓存:', pageUrl)
                toolResult = cachedRead
              } else {
                let pageData = null
                try { const response = await chrome.tabs.sendMessage(targetTab.id, { type: 'extractPageContent' }); pageData = response?.data || null } catch {}
                if (!pageData) {
                  toolResult = JSON.stringify({ ok: false, error: '无法读取页面内容。' })
                } else {
                  toolResult = JSON.stringify({ ok: true, title: pageData.title || '', url: pageData.url || '', content: (pageData.content || '').slice(0, 3000) })
                  pageReadCache.set(pageUrl, toolResult)
                }
              }
            }
          } else if (funcName.startsWith('inject_script_')) {
            const scriptId = parseInt(funcName.replace('inject_script_', ''))
            if (!scriptId || isNaN(scriptId)) {
              toolResult = JSON.stringify({ ok: false, error: '无效的脚本ID' })
            } else {
              const tool = searchResults.find(t => t.id === scriptId) || { id: scriptId, name: '脚本#' + scriptId, toolType: 'js', toolConfig: {}, metadata: {}, precheck: '' }
              const targetTab = await getTargetTab(tabId)
              if (!targetTab) {
                toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用' })
                executedTools.push({ name: `${funcName}(标签页不可用)`, result: toolResult })
                postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
                messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
                continue
              }
              // precheck
              if (tool.precheck && tool.precheck.trim()) {
                postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: { check: 'precheck' }, status: 'running' })
                try {
                  const [precheckResult] = await chrome.scripting.executeScript({
                    target: { tabId: targetTab.id },
                    func: (code) => { try { const fn = new Function(code); const r = fn(); return { ok: true, result: r } } catch (e) { return { ok: false, error: e.message } } },
                    args: [tool.precheck],
                  })
                  const pr = precheckResult?.result
                  if (pr && !pr.ok && pr.result?.ok === false) {
                    const precheckReason = pr.result.reason || pr.result.error || '未知原因'
                    toolResult = JSON.stringify({ ok: false, error: `前置检查失败: ${precheckReason}` })
                    executedTools.push({ name: `${funcName}(precheck失败)`, result: toolResult })
                    recordMemory(configService, scriptId, false, 0, `前置检查失败: ${precheckReason}`, '').catch(() => {})
                    postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
                    messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
                    continue
                  }
                } catch (e) {
                  if (e.message?.includes('Cannot access a chrome:// URL') || e.message?.includes('Cannot access contents of url')) {
                    toolResult = JSON.stringify({ ok: false, error: '当前页面为系统页面，无法执行脚本。' })
                    executedTools.push({ name: `${funcName}(系统页面)`, result: toolResult })
                    postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
                    messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
                    continue
                  }
                  console.warn('[Agent] precheck 执行异常，继续执行:', e.message)
                }
              }
              postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: { scriptId, scriptName: tool.name }, status: 'running' })
              const execStart = Date.now()
              const execResult = await toolService.executeTool(tool, targetTab.id, funcArgs)
              const execDuration = Date.now() - execStart
              toolResult = JSON.stringify(execResult)
              if (execResult?.ok && (tool.toolType === 'api' || tool.toolConfig?.apiEndpoint)) {
                _injections.push(`脚本 ${tool.name} 已成功执行并返回完整结果，可直接基于这些数据继续后续步骤或 finish_task，无需再用其他工具重复获取。`)
              }
              executedTools.push({ name: tool.name || funcName, result: execResult })
              const memOk = execResult?.ok === true
              let memSummary = ''
              const innerResult = execResult?.result
              if (typeof innerResult === 'string') memSummary = innerResult.slice(0, 200)
              else if (innerResult && typeof innerResult === 'object') {
                if (Array.isArray(innerResult.data)) { memSummary = `${innerResult.data.length}条数据`; if (innerResult.total !== undefined) memSummary += ` (共${innerResult.total})`; memSummary = memSummary.slice(0, 200) }
                else if (Array.isArray(innerResult)) memSummary = `${innerResult.length}条结果`
                else memSummary = JSON.stringify(innerResult).slice(0, 200)
              }
              recordMemory(configService, scriptId, memOk, execDuration, memOk ? '' : (execResult?.error || ''), memSummary).catch(() => {})
            }
          } else if (funcName === 'screenshot_visible') {
            toolResult = await (async () => {
              try {
                const targetTab = await getTargetTab(tabId)
                if (!targetTab) return JSON.stringify({ ok: false, error: '目标标签页不可用' })
                postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, status: 'running' })
                const dataUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId, { format: 'jpeg', quality: 60 })
                const header = dataUrl.slice(0, 100)
                const sizeKB = Math.round(dataUrl.length / 1024)
                return JSON.stringify({ ok: true, result: `截图已获取 (${sizeKB}KB, JPEG)，格式: ${header}...`, _hasScreenshot: true, _dataUrl: dataUrl })
              } catch (e) { return JSON.stringify({ ok: false, error: `截图失败: ${e.message}` }) }
            })()
            executedTools.push({ name: funcName, result: toolResult })
          } else if (['extract_content','click_element','fill_input','wait_for_element','save_as_file','navigate_to','go_back','find_text_on_page','get_element_info','scroll_page','hover_element','select_dropdown','press_key','go_forward','get_interactive_elements'].includes(funcName)) {
            const selectorTools = ['extract_content', 'get_element_info', 'find_text_on_page']
            if (selectorTools.includes(funcName) && funcArgs.selector) {
              const comboKey = `${funcArgs.selector}|${funcName}`
              if (_usedSelectorToolCombo.has(comboKey)) {
                _injections.push(`💡 提示：已用 ${funcName} 提取过选择器 "${funcArgs.selector}" 的数据，重复提取可能浪费时间。建议推进下一步操作或调用finish_task，但你可以自主决定。`)
              }
              _usedSelectorToolCombo.add(comboKey)
            }
            if (funcName === 'navigate_to' && !domainPolicy.isUrlAllowed(funcArgs.url)) {
              toolResult = JSON.stringify({ ok: false, error: `导航被安全策略阻止：${funcArgs.url} 不在允许的域名范围内。` })
              executedTools.push({ name: `${funcName}(域名被拦截)`, result: toolResult })
              postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
              messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
              _intercepted = true
            } else if (funcName === 'navigate_to' && aiRequestCount / maxRounds >= 0.85) {
              _debugLog('💡 预算提示: navigate_to接近预算上限', { round: aiRequestCount, maxRounds })
              _injections.push(`💡 提示：已使用${Math.round(aiRequestCount / maxRounds * 100)}%预算，导航新页面可能消耗较多轮次。请评估剩余轮次能否完成，如不能请调用finish_task汇总已有结果。`)
              const targetTab = await getTargetTab(tabId)
              if (!targetTab) { toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用' }) }
              else {
                postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: funcArgs, status: 'running' })
                const domResult = await Promise.race([ executeDOMTool(targetTab.id, funcName, funcArgs), new Promise((_, reject) => setTimeout(() => reject(new Error('动作超时')), ACTION_TIMEOUT_MS)) ]).catch(e => ({ ok: false, error: e.message }))
                toolResult = JSON.stringify(domResult)
                executedTools.push({ name: funcName, result: domResult })
              }
            } else {
              const targetTab = await getTargetTab(tabId)
              if (!targetTab) { toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用' }) }
              else {
                postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: funcArgs, status: 'running' })
                const domResult = await Promise.race([ executeDOMTool(targetTab.id, funcName, funcArgs), new Promise((_, reject) => setTimeout(() => reject(new Error('动作超时')), ACTION_TIMEOUT_MS)) ]).catch(e => ({ ok: false, error: e.message }))
                toolResult = JSON.stringify(domResult)
                executedTools.push({ name: funcName, result: domResult })
              }
            }
            if (['navigate_to', 'go_back', 'go_forward'].includes(funcName) && !toolResult.includes('域名被拦截') && !toolResult.includes('"ok":false')) {
              shouldTerminateSequence = true
            }
          } else {
            toolResult = JSON.stringify({ ok: false, error: `未知工具: ${funcName}` })
          }

          if (_intercepted) continue
          _debugLog(`⚙️ 工具结果: ${funcName}`, toolResult || '')

          // ===== WorkingMemory 自动提取 =====
          workingMemory.autoExtractFromToolResult(funcName, funcArgs, toolResult, aiRequestCount)

          // ===== 待办调度：匹配工具调用到当前待办 =====
          const matchedTodo = todoScheduler.matchToolCall(funcName)
          let hasProgress = false
          try {
            const parsed = JSON.parse(toolResult)
            if (parsed?.ok === false) {
              hasProgress = false
              if (matchedTodo) todoScheduler.markTodoResult('failed')
            } else if (funcName === 'search_tools') {
              const results = Array.isArray(parsed) ? parsed : parsed?.result
              hasProgress = Array.isArray(results) && results.length > 0
              if (matchedTodo && hasProgress) todoScheduler.markTodoResult('done', parsed)
              else if (matchedTodo) todoScheduler.markTodoResult('failed')
            } else if (funcName === 'recall_data') {
              const data = parsed?.data || parsed?.result || parsed
              if (parsed?.error) hasProgress = false
              else if (Array.isArray(data) && data.length > 0) hasProgress = true
              else if (data && typeof data === 'object' && !Array.isArray(data)) hasProgress = (data.count > 0) || (data.entries?.length > 0) || (Array.isArray(data.data) && data.data.length > 0)
              else if (typeof data === 'string' && data.length > 10 && !data.includes('无存储数据') && !data.includes('未找到')) hasProgress = true
              if (matchedTodo && hasProgress) todoScheduler.markTodoResult('done', parsed)
            } else if (funcName === 'create_todo') {
              hasProgress = parsed?.ok === true
              if (hasProgress && matchedTodo) todoScheduler.markTodoResult('done', parsed)
            } else if (parsed?.ok === true || parsed?.ok === undefined) {
              const hasContent = parsed?.result !== undefined && String(parsed.result).length > 0 || parsed?.content !== undefined && String(parsed.content).length > 0 || parsed?.title !== undefined
              hasProgress = hasContent && !parsed?.error
              if (matchedTodo && hasProgress) todoScheduler.markTodoResult('done', parsed)
              else if (!matchedTodo && hasProgress && parsed) todoScheduler.globalDataStore.set(funcName, parsed, 'auto')
            }
          } catch {}

          // ===== 进度记录（Stage 2 中 read_page_content 不重置 stageFailCount） =====
          if (hasProgress) {
            if (currentPhase === 2 && funcName === 'read_page_content') {
              // Stage 2 中 read_page_content 成功不算进展，不重置 stageFailCount
            } else {
              todoScheduler.recordProgress()
            }
          } else {
            todoScheduler.recordNoProgress(funcName)
          }

          // 发送待办进度更新
          if (todoScheduler.parentTodo) {
            postToUI(tabId, { type: 'agentTodoUpdate', data: { stages: todoScheduler.parentTodo.stages || [], progress: todoScheduler.getProgress(), currentStage: todoScheduler.currentStage, lastTool: funcName, lastProgress: hasProgress } })
          }

          // 检查硬性规则
          const stageSwitch = todoScheduler.shouldSwitchStage()
          if (stageSwitch.switch) {
            _debugLog('🔄 硬性规则触发阶段切换', stageSwitch)
            // 记录到 WorkingMemory
            workingMemory.addStageSwitch(currentPhase, stageSwitch.to, stageSwitch.reason, aiRequestCount)
            // 生成阶段交接摘要
            const handoffSummary = await contextCompressor.generateHandoff(
              messages, userMessage, workingMemory, currentPhase, stageSwitch.to, stageSwitch.reason
            )
            todoScheduler.forceSwitchToStage(stageSwitch.to)
            currentPhase = stageSwitch.to
            if (stageSwitch.to === 2) {
              let scriptList = ''
              if (searchResults.length > 0) {
                scriptList = '\n\n=== 已匹配的专用脚本 ===\n' + searchResults.map(s => {
                  const params = s.toolConfig?.parameters?.properties ? Object.keys(s.toolConfig.parameters.properties) : []
                  const paramHint = params.length > 0 ? `（参数: ${params.join(', ')}）` : ''
                  return `  - inject_script_${s.id}(${s.name})${paramHint}: ${(s.description || '').slice(0, 80)}`
                }).join('\n')
              }
              const phase2Prompt = `你是AI Browser智能体，现在使用远程专用脚本执行任务。\n\n=== 工作流程 ===\n1. 查看待办列表中Stage 2的子待办\n2. 如需数据参数，先 recall_data 获取已收集的数据\n3. 调用 inject_script_* 执行脚本\n4. 完成后 → finish_task\n\n=== Stage 2 可用工具 ===\nsearch_tools, inject_script_*, recall_data, read_page_content, finish_task\n\n=== 脚本使用指南 ===\n- 直接调用匹配到的脚本，不要犹豫\n- 如果脚本需要URL列表参数，先 recall_data 获取\n- 脚本执行成功后，基于结果直接 finish_task\n- 多次搜索无果或脚本失败 → 调用 finish_task 总结失败原因${scriptList}`
              let dataSummary = ''
              const summaries = todoScheduler.globalDataStore.getAllSummaries()
              if (summaries.length > 0) {
                dataSummary = '\n\n=== 全局存储数据 ===\n  ' + summaries.join('\n  ')
                const allUrls = todoScheduler.globalDataStore.getAllUrls()
                if (allUrls.length > 0) dataSummary += `\n\n💡 已有${allUrls.length}个URL链接，可直接传给inject_script_*作为参数。`
              }
              messages.length = 0
              messages.push({ role: 'system', content: phase2Prompt })
              if (handoffSummary) {
                messages.push({ role: 'system', content: `=== 前序阶段交接 ===\n${handoffSummary}` })
              }
              messages.push({ role: 'user', content: userMessage + (dataSummary || '\n\n（无已收集数据，请直接使用脚本或搜索工具库。）') })
              _debugLog('🔄 Stage2提示词已注入', { scriptCount: searchResults.length, dataKeys: summaries.length, hasHandoff: !!handoffSummary })
            } else if (stageSwitch.to === 3) {
              const allData = todoScheduler.globalDataStore.getAllSummaries()
              const phase3Prompt = `你是AI Browser智能体，正在执行Stage 3数据汇总。\n\n=== 工作流程 ===\n1. 查看全局存储中的所有数据摘要\n2. 生成结构化汇总\n3. 调用 finish_task 输出汇总\n\n=== Stage 3 可用工具 ===\nfinish_task, recall_data\n\n=== 全局存储数据 ===\n${allData.length > 0 ? allData.join('\n') : '（无数据）'}`
              messages.length = 0
              messages.push({ role: 'system', content: phase3Prompt })
              if (handoffSummary) {
                messages.push({ role: 'system', content: `=== 前序阶段交接 ===\n${handoffSummary}` })
              }
              messages.push({ role: 'user', content: userMessage + '\n\n请汇总所有已收集的数据并输出最终结果。' })
              _debugLog('🔄 Stage3提示词已注入', { dataKeys: allData.length, hasHandoff: !!handoffSummary })
            }
            postToUI(tabId, { type: 'agentTodoUpdate', data: { stages: todoScheduler.parentTodo?.stages || [], progress: todoScheduler.getProgress(), currentStage: todoScheduler.currentStage, stageSwitch } })
          }

          postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })

          // Feature 4: 工具调用录制（结果已生成，记录到会话）
          if (toolRecordingService) {
            try {
              toolRecordingService.record(funcName, funcArgs, toolResult, Date.now() - _toolStartTime)
            } catch (e) {
              console.warn('[ToolRecording] record 失败（非致命）:', e.message)
            }
          }

          // ===== 工具结果处理：支持 return_mode =====
          // AI 可自主决定返回模式：summary（概览）或 full（完整数据）
          let finalResult
          const returnMode = funcArgs.return_mode || 'summary'
          
          // 数据采集类工具支持 return_mode
          const dataTools = ['extract_content', 'get_interactive_elements', 'get_element_info']
          
          if (dataTools.includes(funcName) && returnMode === 'full') {
            // return_mode="full": 直接返回完整数据（不截断，不存储，标记_temp）
            finalResult = toolResult
            console.log(`[Agent] ${funcName} return_mode=full，返回完整数据（${toolResult.length}字符）`)
          } else if (dataTools.includes(funcName) && returnMode === 'summary') {
            // return_mode="summary"（默认）：返回概览，让 AI 了解数据内容
            const overview = buildDataOverview(toolResult, funcName)
            // 存储完整数据到 PayloadStore（供后续需要时获取）
            const storeId = payloadStore.add(funcName, toolResult, overview._hint || '', { count: overview._overview?.total || 1 })
            overview._stored = storeId
            overview._hint += `。完整数据已存储(ID:${storeId})，如需全部可设置 return_mode="full"`
            finalResult = JSON.stringify(overview)
            console.log(`[Agent] ${funcName} return_mode=summary，返回概览（存储ID:${storeId}）`)
            // 同步更新 WorkingMemory
            if (storeId) {
              const count = overview._overview?.content_count || overview._overview?.total || 1
              workingMemory.addDataRef(funcName, storeId, count, overview._hint)
            }
          } else if (shouldStoreToPayload(toolResult, funcName)) {
            // 其他工具：原有存储逻辑
            finalResult = storeToPayload(payloadStore, toolResult, funcName)
            const storeId = payloadStore.entries[payloadStore.entries.length - 1]?.id
            console.log('[Agent] payloadStore 存储:', funcName, '→ ID:', storeId)
            // 同步更新 WorkingMemory 的数据引用
            if (storeId) {
              try {
                const parsed = typeof toolResult === 'string' ? JSON.parse(toolResult) : toolResult
                const count = Array.isArray(parsed?.result) ? parsed.result.length :
                  (parsed?.total || parsed?.data?.length || 1)
                const summary = funcName.includes('inject_script') ? '脚本处理结果' :
                  funcName.includes('read_page') ? '页面内容' : '工具结果'
                workingMemory.addDataRef(funcName, storeId, count, summary)
              } catch {}
            }
          } else {
            finalResult = smartTruncateResult(toolResult)
          }
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: finalResult })
          // ===== 对话全景：收集工具执行结果 =====
          _roundToolResults.push({ toolName: funcName, args: funcArgs, result: toolResult, finalResult, ok: !toolResult?.includes('error') && !toolResult?.includes('skipped') })
          await new Promise(r => setTimeout(r, 200))
        }

        // ===== 对话全景：发送本轮完整数据 =====
        const roundData = {
          round: aiRequestCount,
          stage: currentPhase,
          request: {
            messages: _requestMessagesSnapshot.map(m => {
              // tool 消息已经是经过 smartTruncateResult/storeToPayload 处理的结果，不应再截断
              if (m.role === 'tool') {
                return { role: m.role, content: m.content }
              }
              // system/user/assistant 消息适度截断用于可视化
              return {
                role: m.role,
                content: typeof m.content === 'string' ? (m.content.length > 800 ? m.content.slice(0, 400) + '\n...(已压缩)' : m.content) : m.content,
                tool_calls: m.tool_calls?.map(tc => ({ name: tc.function?.name, args: tc.function?.arguments }))
              }
            }),
            toolsCount: tools.length
          },
          response: msg,
          toolResults: _roundToolResults,
          storedData: payloadStore.entries.filter(e => e.sessionId === sessionId).map(e => ({
            id: e.id, toolName: e.toolName, preview: Array.isArray(e.data) ? `数组${e.data.length}条` : typeof e.data === 'object' ? '对象' : `字符串${String(e.data).length}字符`, data: e.data
          }))
        }
        _sendToConversationViewer('conversationRound', roundData)

        // ===== Scratchpad 持久化 =====
        // 每轮结束后保存中间推理状态，支持断点续传
        try {
          await scratchpadService.save(sessionId, workingMemory.state, {
            round: aiRequestCount,
            stage: currentPhase,
          })
        } catch (e) {
          console.warn('[ScratchpadService] 保存失败（非致命）:', e.message)
        }

        // ===== 消息上下文压缩（LLM驱动 + WorkingMemory 增强） =====
        const MAX_MESSAGES = 40
        if (messages.length > MAX_MESSAGES) {
          const keepRecent = Math.floor(MAX_MESSAGES * 0.6)
          let cutOff = messages.length - keepRecent
          if (cutOff > 1) {
            while (cutOff < messages.length && messages[cutOff]?.role === 'tool') cutOff++
          }
          if (cutOff > 1) {
            // 使用 ContextCompressor 进行 LLM 驱动压缩
            const summaryMsg = await contextCompressor.compress(messages, cutOff, userMessage, workingMemory)
            if (summaryMsg) {
              messages.splice(1, cutOff - 1, summaryMsg)
            }
          }
          // 移除孤立 tool 消息
          const validToolCallIds = new Set()
          for (const m of messages) { if (m.role === 'assistant' && m.tool_calls) { for (const tc of m.tool_calls) validToolCallIds.add(tc.id) } }
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'tool' && !validToolCallIds.has(messages[i].tool_call_id)) {
              console.warn('[Agent] 移除孤立tool消息:', messages[i].tool_call_id)
              messages.splice(i, 1)
            }
          }
        }
      } else {
        // 纯文本回复
        console.log('[Agent] 纯文本回复（无tool_calls）:', (msg.content || '').slice(0, 80))
        const content = msg.content || ''
        const textContent = content || 'AI未返回有效响应，请重试。'
        if (content) {
          for (const char of content) {
            try { postToUI(tabId, { type: 'streamChunk', content: char }) } catch {}
            await new Promise(r => setTimeout(r, 15))
          }
        } else {
          console.warn('[Agent] AI返回空内容且无工具调用，强制结束')
          postToUI(tabId, { type: 'streamChunk', content: textContent })
        }
        postToUI(tabId, { type: 'streamDone' })
        await saveToChatHistoryStorage(textContent)
        return
      }
    } catch (e) {
      console.error('[AgentService] iteration error:', e)
      postToUI(tabId, { type: 'agentError', error: e.message })
      return
    }
  }

  // ===== 循环结束：达到最大轮次 =====
  postToUI(tabId, { type: 'agentError', error: 'Agent达到最大请求次数，请简化任务重试' })
  _debugLog('🛑 Agent终止: 达到最大轮次', { maxRounds, executedToolsCount: executedTools.length })
  const finalNote = `⚠️ Agent 已达到最大请求次数（${maxRounds} 轮）。任务可能未完成，请简化需求后重试。`
  const toolCallsSummary = executedTools.length > 0
    ? executedTools.filter(t => !t.name?.includes('search_tools') && !t.name?.includes('read_page_content')).slice(0, 15)
    : []
  await saveToChatHistoryStorage(finalNote, toolCallsSummary)
}
