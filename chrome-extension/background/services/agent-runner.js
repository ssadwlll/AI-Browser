// ============ Agent 主运行循环 ============
// 从 agent-service.js 提取的 run() 方法
// 包含：LLM API 调用、工具执行分发、待办进度管理

import { executeDOMTool } from './agent-dom-executor.js'
import { shouldStoreToPayload, storeToPayload, smartTruncateResult, buildDataOverview, normalizePayload, formatSchemaSummary } from './agent-payload-utils.js'
import { runJudge, saveToChatHistoryStorage, getTargetTab, recordMemory } from './agent-judge.js'
import { buildTools } from './agent-tool-builder.js'
import { WorkingMemory } from './working-memory.js'
import { ContextCompressor } from './context-compressor.js'
import { ScratchpadService } from './scratchpad-service.js'
import { OutputService } from './output-service.js'
import { fetchWithTimeout } from '../../shared/utils.js'

// 上传对话归档到后端（在 finish_task 时调用，非阻塞主流程）
async function uploadConversationArchive(configService, data) {
  const syncConfig = await configService.getSyncConfig()
  if (!syncConfig.serverUrl || !syncConfig.appKey || !syncConfig.appSecret) {
    console.log('[ConversationArchive] 未配置后端服务器，跳过上传')
    return
  }
  const baseUrl = String(syncConfig.serverUrl).replace(/\/+$/, '')
  const url = `${baseUrl}/api/conversation-archives`
  const headers = await configService.generateAuthHeaders(syncConfig.appKey, syncConfig.appSecret)
  headers['Content-Type'] = 'application/json'
  // 单条消息可能较大（16轮 × 30KB ≈ 500KB），使用 60s 超时
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  }, 60000)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = await res.json()
  if (!json.success) throw new Error(json.error || '上传失败')
  return json.data
}

// 从后端检索历史成功任务经验（RAG）
// 调用 POST /api/conversation-archives/rag，返回格式化的经验提示字符串（无匹配返回 null）
// 检索 RAG 历史经验（同时校验脚本是否在当前可用工具列表中，避免推荐已删除的脚本）
// availableScriptIds: 当前已注册的 inject_script_N 的 ID 集合，用于过滤历史经验
async function retrieveRAGExperiences(configService, userMessage, pageUrl, availableScriptIds = null) {
  const syncConfig = await configService.getSyncConfig()
  if (!syncConfig.serverUrl || !syncConfig.appKey || !syncConfig.appSecret) {
    return null  // 未配置后端，跳过
  }
  const baseUrl = String(syncConfig.serverUrl).replace(/\/+$/, '')
  const url = `${baseUrl}/api/conversation-archives/rag`
  const headers = await configService.generateAuthHeaders(syncConfig.appKey, syncConfig.appSecret)
  headers['Content-Type'] = 'application/json'
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ userMessage, pageUrl, topK: 3 }),
  }, 15000)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = await res.json()
  if (!json.success) throw new Error(json.error || 'RAG 检索失败')
  const data = json.data || {}
  const matches = Array.isArray(data.matches) ? data.matches : []
  if (matches.length === 0) return null

  // 格式化为可读的经验提示
  const lines = []
  const usedVector = data.usedVectorRank === true
  lines.push(`[RAG 检索到 ${matches.length} 条相似历史任务经验，命中关键词: ${(data.keywords || []).join(', ')}${usedVector ? '，向量语义精排生效' : '，关键词匹配'}]`)
  matches.forEach((m, i) => {
    const vecScoreStr = (usedVector && typeof m.vectorScore === 'number') ? `，语义相似度=${m.vectorScore.toFixed(2)}` : ''
    lines.push(`\n--- 经验 ${i + 1}（任务 ${m.taskId}，${m.totalToolCalls} 次工具调用，${(m.durationMs / 1000).toFixed(0)}s${vecScoreStr}）${m.domainBoost ? ' [同域名加权]' : ''} ---`)
    lines.push(`用户原始请求: ${m.userMessage}`)
    if (m.summary) lines.push(`任务总结: ${m.summary}`)

    // 选择器反馈：区分可用/已失效
    if (m.selectorFeedback && m.selectorFeedback.length > 0) {
      const validSels = m.selectorFeedback.filter(s => !s.isStale)
      const staleSels = m.selectorFeedback.filter(s => s.isStale)
      if (validSels.length > 0) {
        lines.push(`✅ 已验证可用选择器（${validSels.length} 个，可直接使用）:`)
        validSels.forEach(s => {
          const succInfo = s.successCount > 0 ? ` (成功${s.successCount}次)` : ''
          lines.push(`  - ${s.selector}${succInfo}`)
        })
      }
      if (staleSels.length > 0) {
        lines.push(`❌ 已失效选择器（${staleSels.length} 个，请勿使用，可能页面已改版）:`)
        staleSels.forEach(s => {
          lines.push(`  - ${s.selector} (失败${s.failCount}次，最后失败: ${s.lastFailureAt || '未知'})`)
        })
      }
    } else if (m.selectors && m.selectors.length > 0) {
      // 没有反馈数据时降级为原始列表（首次任务或后端不可用）
      lines.push(`成功使用的选择器（未验证，仅供参考）: ${m.selectors.join(', ')}`)
    }

    if (m.scriptsUsed && m.scriptsUsed.length > 0) {
      // 过滤掉当前工具列表中不存在的脚本（避免推荐已删除/下架的脚本）
      // m.scriptsUsed 形如 ["脚本 #10", "脚本 #9"]
      const filterScripts = (arr) => {
        if (!availableScriptIds || availableScriptIds.size === 0) return arr
        return arr.filter(s => {
          const match = String(s).match(/#(\d+)/)
          if (!match) return true  // 格式异常，保留
          return availableScriptIds.has(Number(match[1]))
        })
      }
      const validScripts = filterScripts(m.scriptsUsed)
      const droppedCount = m.scriptsUsed.length - validScripts.length
      if (validScripts.length > 0) {
        lines.push(`调用的脚本: ${validScripts.join(', ')}`)
      }
      if (droppedCount > 0) {
        lines.push(`⚠️ 历史经验中有 ${droppedCount} 个脚本当前不可用（已从工具列表中移除，请改用 DOM 工具或 search_tools 查找其他可用脚本）`)
      }
    }
    if (m.toolsUsed && m.toolsUsed.length > 0) {
      // 工具调用顺序也过滤掉不可用的 inject_script_N
      const filterTools = (arr) => {
        if (!availableScriptIds || availableScriptIds.size === 0) return arr
        return arr.filter(t => {
          const match = String(t).match(/^inject_script_(\d+)$/)
          if (!match) return true  // 非 inject_script_N 工具，保留
          return availableScriptIds.has(Number(match[1]))
        })
      }
      const validTools = filterTools(m.toolsUsed)
      if (validTools.length > 0) {
        lines.push(`工具调用顺序: ${validTools.join(' → ')}`)
      }
    }
  })
  // 根据反馈状态定制尾部提示
  const hasAnyStale = matches.some(m => m.selectorFeedback?.some(s => s.isStale))
  const staleTip = hasAnyStale
    ? '⚠️ 已失效选择器来自旧版页面，请勿直接使用。优先使用"✅ 已验证可用"的选择器，并以 detect_page_template 实时结果为准。'
    : '⚠️ 以上为历史经验参考，仅供参考选择器/脚本方向。当前页面结构可能不同，请基于实际 detect_page_template 结果决定。'
  lines.push(staleTip)
  return lines.join('\n')
}

// 上报选择器使用结果到后端（用于构建反馈闭环，加速 RAG 失效检测）
// 设计原则：非阻塞主流程，失败时静默降级（不影响任务执行）
// 仅上报使用 selector 的工具，且页面有明确 host 时才上报
let _feedbackQueue = Promise.resolve()
function reportSelectorFeedback(configService, { host, selector, toolName, taskId, resultStatus, itemCount }) {
  if (!host || !selector || !['success', 'failure'].includes(resultStatus)) return Promise.resolve()
  // 串行化上报，避免并发请求风暴
  _feedbackQueue = _feedbackQueue.then(async () => {
    try {
      const syncConfig = await configService.getSyncConfig()
      if (!syncConfig.serverUrl || !syncConfig.appKey || !syncConfig.appSecret) return
      const baseUrl = String(syncConfig.serverUrl).replace(/\/+$/, '')
      const url = `${baseUrl}/api/selector-feedback/report`
      const headers = await configService.generateAuthHeaders(syncConfig.appKey, syncConfig.appSecret)
      headers['Content-Type'] = 'application/json'
      await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ host, selector, toolName, taskId, resultStatus, itemCount: itemCount || 0 }),
      }, 8000)
    } catch (e) {
      console.warn('[SelectorFeedback] 上报失败（非致命）:', e.message)
    }
  })
  return _feedbackQueue
}

// 解析 host：从 url 提取 hostname
function _extractHost(url) {
  try { return new URL(url).hostname || '' } catch { return '' }
}

// 统一规范 data_refs 参数：兼容数组、字符串（"p1,p2"）、undefined
function normalizeDataRefs(raw) {
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean)
  if (typeof raw === 'string' && raw.length > 0) return raw.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

// 流式输出大字符串：超过阈值时一次性发送，避免逐字符 setTimeout 累计超时
const STREAM_CHAR_THRESHOLD = 2000
const STREAM_DELAY_MS = 15

/** 将文本流式发送到 UI；超长内容采用分段/一次性发送以避免 15ms/字符累计超时 */
async function streamToUI(postToUI, tabId, text) {
  if (!text) {
    postToUI(tabId, { type: 'streamDone' })
    return
  }
  if (text.length > STREAM_CHAR_THRESHOLD) {
    // 分段一次性发送：每段不超过 8000 字符，避免单条消息过大
    const SEGMENT = 8000
    for (let i = 0; i < text.length; i += SEGMENT) {
      postToUI(tabId, { type: 'streamChunk', content: text.slice(i, i + SEGMENT) })
      // 让出 UI 主线程，避免消息风暴
      await new Promise(r => setTimeout(r, 30))
    }
  } else {
    for (const char of text) {
      postToUI(tabId, { type: 'streamChunk', content: char })
      await new Promise(r => setTimeout(r, STREAM_DELAY_MS))
    }
  }
  postToUI(tabId, { type: 'streamDone' })
}

/**
 * 带超时的 DOM 工具执行（避免 Promise.race 中的 setTimeout 残留）
 * 当 executeDOMTool 先完成时，自动清理定时器，避免悬挂的定时器占用资源
 * @param {number} tabId - 目标标签页 ID
 * @param {string} funcName - 工具函数名
 * @param {object} funcArgs - 工具参数
 * @param {number} timeoutMs - 超时毫秒数
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function executeDOMToolWithTimeout(tabId, funcName, funcArgs, timeoutMs) {
  let timeoutId = null
  try {
    const result = await Promise.race([
      executeDOMTool(tabId, funcName, funcArgs),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('动作超时')), timeoutMs)
      }),
    ])
    return result
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    // 无论 Promise.race 谁先完成，都清理定时器
    if (timeoutId !== null) clearTimeout(timeoutId)
  }
}

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
    modelInfo, // 模型单独配置（temperature / context_window / max_tokens），可选
  } = ctx

  const startTime = Date.now()
  await domainPolicy.load()

  // ===== 应用全局设置（从后端读取，缓存兜底） =====
  // agent_max_rounds: Agent 模式最大执行轮数
  // agent_system_prompt: Agent 模式系统提示词
  let appSettings = null
  try {
    appSettings = await configService.getAppSettings()
  } catch (e) {
    console.warn('[Agent] 读取应用设置失败，使用默认值:', e.message)
  }
  const backendMaxRounds = appSettings?.agent_max_rounds || 30
  const backendSystemPrompt = appSettings?.agent_system_prompt || ''

  // 兼容旧逻辑：本地 agentConfig.maxRounds 仅作 fallback（后端不可用时）
  // 后端设置优先，避免用户本地改值导致与后台不一致
  let maxRounds = backendMaxRounds
  let enableJudge = true
  let debug = false
  try {
    const agentCfg = await configService.getAgentConfig()
    // 仅在后端读取失败（appSettings=null）时使用本地 agentConfig.maxRounds
    if (!appSettings && agentCfg?.maxRounds >= 5) maxRounds = agentCfg.maxRounds
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
  // _allRoundsData: 收集所有轮次的完整数据，用于任务结束时上传到后端
  const _allRoundsData = []
  const _sendToConversationViewer = (type, payload) => {
    try {
      // 收集 round 数据用于后端上传
      if (type === 'conversationRound' && payload && payload.round) {
        _allRoundsData.push(payload)
      }
      if (!_conversationChannel) _conversationChannel = new BroadcastChannel('ai-browser-conversation')
      _conversationChannel.postMessage({ type, payload })
    } catch (e) { console.warn('[ConversationViewer] 发送失败', e) }
  }

  // 上限策略：完全信任后端 agent_max_rounds 配置（管理员可调）
  // 仅保留一个绝对硬上限防止后端配错（如配成 9999），不影响正常使用
  const ABSOLUTE_MAX_ROUNDS = 100
  const effectiveMaxRounds = Math.min(maxRounds, ABSOLUTE_MAX_ROUNDS)
  if (effectiveMaxRounds !== maxRounds) {
    console.warn(`[Agent] maxRounds ${maxRounds} 超过绝对硬上限 ${ABSOLUTE_MAX_ROUNDS}，自动收敛`)
  }
  // 工具调用上限：基础 30，按轮数缩放，但不超过 300（每轮平均 3 次工具调用）
  const MAX_TOOL_CALLS = Math.min(300, Math.max(30, effectiveMaxRounds * 3))
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
  todoScheduler.clear()
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
  // 清理末尾连续的孤儿 user 消息（上次任务中断导致未配对 assistant 回复）
  // 场景：用户发消息 → Agent 中断 → 用户重发相同消息
  // 此时历史为 [..., {user: 第一次}, {user: 第二次}]，AI 看到两条相同消息会重复执行
  // 兜底保护：即使前端 sidepanel 未回滚，此处也清理掉重复的孤儿消息
  while (rawHistory.length >= 1) {
    const last = rawHistory[rawHistory.length - 1]
    if (last?.role === 'user' && last?.content === userMessage) {
      // 末尾 user 消息内容等于本次新消息 → 移除（agent-runner 会重新添加本次消息）
      rawHistory.pop()
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

  // ===== 统一系统提示词（优先使用后端配置，兜底使用内置默认） =====
  // 后端 agent_system_prompt 用于集中控制所有客户端的 Agent 行为规范
  const DEFAULT_SYSTEM_PROMPT = `你是AI Browser智能体，一个能操作网页、调用脚本、整理数据的自主助手。

=== 工作流程 ===
1. 了解当前页面：使用 get_interactive_elements / read_page_content 获取页面概览（系统可能已自动注入页面内容，如有则直接使用）
2. 规划任务：复杂任务调用 create_todo 创建待办列表；简单任务（1-2步可完成）直接执行，无需创建待办
3. 按待办顺序执行工具操作，系统自动追踪进度
4. 所有待办完成 → 调用 finish_task 汇报结果

=== 工具使用策略 ===
- DOM工具（extract_content、click_element等）：用于页面探索、简单数据提取、交互操作
- inject_script_N：用于批量处理、深度数据采集（N是search_tools查到的脚本ID）
- generate_script：动态生成代码执行任意JS逻辑（fetch网络请求/DOM操作/数据处理等），运行在页面上下文。返回 HTML 字符串时可自动渲染为可视化报告
- search_tools：搜索脚本库，查找可用的远程脚本
- finish_task：完成所有任务后输出最终结果

=== 脚本选择优先级（必须遵守） ===
1️⃣ 优先查看系统注入的"📋 当前可用脚本库"清单，按 urlPattern 匹配当前页面选择 inject_script_N
2️⃣ 清单未明确匹配时，主动调用 search_tools 用任务关键词搜索脚本库
3️⃣ 以上都无匹配时，使用 DOM 工具组合完成（navigate_to + extract_content + click_element）
❌ 严禁：脚本库已有可用脚本却跳过，造成重复造轮子

=== 数据流转机制 ===
工具返回的数据量较大时，系统会自动存储完整数据，只发回 schema+样例摘要（如"p1: 15条 | {title:string, url:string} | 样例: [...]"）。
- 数据摘要可直接用于回答用户，或在 finish_task 中通过 data_refs 引用完整数据
- 操作全量数据：generate_script(data_refs=["p1","p2"]) — 系统自动注入全量数据到页面，代码中通过 window.__store.p1 访问
- 整合多份数据：generate_script(data_refs=["p1","p2"], code="return [...__store.p1, ...__store.p2]")

=== 任务边界处理 ===
当用户请求超出当前可用工具能力时，请：
1. 直接调用 finish_task 说明情况并提供替代方案
2. 不要反复尝试无法完成的操作，避免陷入循环

当连续5次工具调用都无法推进任务时，请调用 finish_task 汇报当前已有结果。

=== 输出规范 ===
- 自然语言总结结果，不输出原始JSON
- 错误时分析原因并在finish_task中告知

=== 对话上下文 ===
你正在与用户进行连续对话。如果上下文中存在"上轮任务数据"或"历史存储数据"，表示之前已执行过任务并产生了结果。
- 这些数据可供你参考和使用，无需重新执行页面操作
- 完整数据可通过 finish_task(data_refs) 在最终输出中引用`

  const systemPrompt = backendSystemPrompt || DEFAULT_SYSTEM_PROMPT

  const systemMsg = { role: 'system', content: systemPrompt }

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
      pageContextMsg += `\n\n已匹配到 ${searchResults.length} 个专用脚本，可直接使用：\n` + searchResults.slice(0, 5).map(s => {
        const params = s.toolConfig?.parameters?.properties ? Object.keys(s.toolConfig.parameters.properties) : []
        const paramHint = params.length > 0 ? `（参数: ${params.join(', ')}）` : ''
        return `  - inject_script_${s.id}(${s.name})${paramHint}: ${(s.description || '').slice(0, 80)}`
      }).join('\n')
    } else {
      pageContextMsg += '\n暂无匹配的专用脚本，请使用本地DOM工具（extract_content/click_element/scroll_page等）完成任务。'
    }
    _injections.push(pageContextMsg)

    // ===== 注入完整脚本索引（让 AI 全局可见所有可用脚本，避免盲目调用 DOM 工具） =====
    // 即使 autoSearch 关键词没命中，AI 也能根据完整列表主动选择合适脚本
    try {
      const allScripts = await toolService.fetchAgentIndex()
      if (allScripts.length > 0) {
        // 当前页面 URL 用于匹配 urlPattern
        const currentUrl = autoPageContent.url || ''
        let currentHost = ''
        try { currentHost = new URL(currentUrl).hostname || '' } catch {}

        // 按 urlPattern 优先级排序：匹配当前页面 host 的脚本排前面
        const sorted = [...allScripts].sort((a, b) => {
          const aMatch = a.urlPattern && currentHost && a.urlPattern.includes(currentHost) ? 1 : 0
          const bMatch = b.urlPattern && currentHost && b.urlPattern.includes(currentHost) ? 1 : 0
          return bMatch - aMatch
        })

        // 拼接脚本索引（每个一行，限制总长度避免上下文膨胀）
        const lines = sorted.map(s => {
          const host = s.urlPattern ? ` [适用: ${s.urlPattern.slice(0, 40)}]` : ''
          return `  - inject_script_${s.id}(${s.name})${host}: ${s.description || '无描述'}`
        })
        // 限制总长度在 4000 字符以内（约 30-50 个脚本）
        let scriptIndex = lines.join('\n')
        if (scriptIndex.length > 4000) {
          scriptIndex = scriptIndex.slice(0, 4000) + `\n  ...（共 ${allScripts.length} 个脚本，已截断）`
        }
        const indexMsg = `\n\n📋 当前可用脚本库（共 ${allScripts.length} 个，按当前页面匹配度排序）:\n${scriptIndex}\n\n⚠️ 优先使用上述脚本库中的 inject_script_N，脚本库中没有合适的再使用 DOM 工具组合。`
        _injections.push(indexMsg)
        console.log(`[Agent] 已注入全脚本索引: ${allScripts.length} 个脚本`)
      }
    } catch (e) {
      console.warn('[Agent] 全脚本索引注入失败（非致命）:', e.message)
    }

    // ===== 自动页面模板识别 + RAG 经验检索（仅首轮注入，加速决策） =====
    try {
      const targetTab = await getTargetTab(tabId)
      if (targetTab) {
        // 收集当前可用脚本 ID 集合（用于过滤 RAG 历史经验中已删除的脚本）
        // 避免 AI 借鉴历史经验调用不存在的 inject_script_N
        const availableScriptIds = new Set(searchResults.map(s => Number(s.id)).filter(Boolean))

        // 并行执行：页面模板识别 + RAG 经验检索
        const [templateResult, ragExperiences] = await Promise.allSettled([
          executeDOMToolWithTimeout(targetTab.id, 'detect_page_template', {}, 5000),
          retrieveRAGExperiences(configService, userMessage, autoPageContent.url || '', availableScriptIds),
        ])

        // 注入页面模板识别结果
        if (templateResult.status === 'fulfilled' && templateResult.value?.ok) {
          const tpl = templateResult.value.result
          if (tpl && tpl.pageType) {
            const selHint = tpl.recommendedSelectors ? Object.entries(tpl.recommendedSelectors).map(([k, v]) => `${k}=${v}`).join(', ') : ''
            const tplMsg = `[已自动执行 detect_page_template] 页面类型: ${tpl.pageType}（${tpl.pageTypeReason}）\n推荐选择器: ${selHint || '无'}\n${tpl.suggestion || ''}\n⚠️ detect_page_template 已自动执行，请勿重复调用。`
            _injections.push(tplMsg)
            console.log('[Agent] 页面模板识别:', tpl.pageType, '| 选择器:', selHint)
          }
        } else if (templateResult.status === 'rejected') {
          console.warn('[Agent] 页面模板识别失败（非致命）:', templateResult.reason?.message)
        }

        // 注入 RAG 经验
        if (ragExperiences.status === 'fulfilled' && ragExperiences.value) {
          _injections.push(ragExperiences.value)
          console.log('[Agent] RAG 经验已注入上下文')
        } else if (ragExperiences.status === 'rejected') {
          console.warn('[Agent] RAG 检索失败（非致命）:', ragExperiences.reason?.message)
        }
      }
    } catch (e) {
      console.warn('[Agent] 页面模板/RAG 注入失败（非致命）:', e.message)
    }

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
        // schema+样例格式，让AI理解数据结构
        if (item.schema) {
          const schemaStr = Object.entries(item.schema).map(([k, v]) => `${k}:${v}`).join(', ')
          const sampleStr = item.sample && item.sample.length > 0 ? JSON.stringify(item.sample).slice(0, 120) : ''
          let line = `  - ${item.id}(${item.toolName}): ${item.count}条 | {${schemaStr}}`
          if (sampleStr) line += ` | 样例: ${sampleStr}`
          parts.push(line)
        } else {
          parts.push(`  - ${item.id}(${item.toolName}): ${item.summary}`)
        }
      }
    }
    if (globalSummaries.length > 0) {
      parts.push(`\n全局存储数据：\n${globalSummaries.join('\n')}`)
    }
    _injections.push(`=== 上轮任务数据 ===\n${parts.join('\n')}\n\n这些数据可直接在 finish_task 中通过 data_refs 引用作为最终输出。`)
  }

  // ===== 简单请求快速路径 =====
  // 检测用户请求是否为纯数据操作（导出、格式化、翻译等）且已有上轮数据
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
    const allData = todoScheduler.globalDataStore.getAllSummaries()
    const payloadItems = payloadSummary ? payloadSummary.items.map(i => {
      if (i.schema) {
        const schemaStr = Object.entries(i.schema).map(([k, v]) => `${k}:${v}`).join(', ')
        return `  - ${i.id}(${i.toolName}): ${i.count}条 | {${schemaStr}}`
      }
      return `  - ${i.id}(${i.toolName}): ${i.summary}`
    }).join('\n') : ''
    const quickPrompt = `你是AI Browser智能体。用户请求是对已有数据的简单操作或追问，无需页面探索或脚本执行，直接回答即可。

=== 可用工具 ===
finish_task: 输出结果（通过 data_refs 可引用完整数据）

=== 执行要点 ===
1. 下方已有上轮数据摘要（含schema+样例），直接使用即可
2. 处理完成后立即调用finish_task输出结果
3. 如果用户是在追问（如"在哪里呢"、"怎么用"），直接回答问题，无需查数据

=== 上轮数据 ===
${allData.length > 0 ? '全局存储:\n' + allData.join('\n') : ''}${payloadItems ? '\n工具结果:\n' + payloadItems : ''}`
    messages.length = 0
    messages.push({ role: 'system', content: quickPrompt })
    messages.push({ role: 'user', content: userMessage })
    _debugLog('⚡ 简单请求快速路径', isFollowUp ? '追问模式，直接回答' : '数据操作，跳过页面探索')
  }

  postToUI(tabId, { type: 'agentStart' })
  _debugLog('🐛 调试模式已开启', '待办驱动调度系统：全工具可用、待办进度追踪、收敛提示')
  _debugLog('⚙️ Agent配置', { maxRounds: effectiveMaxRounds, enableJudge, debug })
  _debugLog('📋 系统提示词', systemMsg.content)

  // ===== 主循环开始 =====
  while (aiRequestCount < effectiveMaxRounds) {
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
    const convergencePrompt = todoScheduler.getConvergencePrompt(aiRequestCount, effectiveMaxRounds)
    if (convergencePrompt) {
      _debugLog('💡 系统收敛提示', convergencePrompt)
      _injections.push(convergencePrompt)
    }

    // 待办进度上下文
    if (todoScheduler.parentTodo) {
      const progressCtx = todoScheduler.getProgressContext()
      if (progressCtx) _injections.push(progressCtx)
    }

    // ===== WorkingMemory 结构化上下文注入 =====
    // 每轮都注入完整 WorkingMemory（不含页面信息，避免与 userMessage 重复）
    if (aiRequestCount > 1) {
      const memoryContext = workingMemory.toContext({ includeErrors: true, includePage: false, maxLen: 1200 })
      if (memoryContext) _injections.push(memoryContext)
    }

    // ===== shouldForceFinish 检查 =====
    const forceFinish = todoScheduler.shouldForceFinish()
    if (forceFinish.force) {
      _debugLog('🚨 硬性规则触发强制完成', forceFinish)
      _injections.push(`⚠️ 系统检测到${forceFinish.reason}，请立即调用 finish_task 汇报当前已有结果。不要再尝试其他操作。`)
    }

    // 获取当前页面URL
    let currentPageUrl = ''
    try {
      const tab = await getTargetTab(tabId)
      currentPageUrl = tab?.url || ''
    } catch {}

    postToUI(tabId, { type: 'agentStatus', text: `第${aiRequestCount}轮` })

    // 构建工具列表（全工具可用）
    const tools = buildTools(searchResults, currentPageUrl, aiRequestCount + 1, scriptService, filteredScriptsCache, domainMismatchLogged)

    console.log(`[Agent] 第${aiRequestCount}轮API请求, tools:${tools.length}个, 已搜到${searchResults.length}个脚本`)
    _debugLog(`🔧 第${aiRequestCount}轮 工具(${tools.length}个)`, tools.map(t => `  ${t.function.name}`).join('\n'))

    // 系统消息聚合
    const systemNudges = []
    while (_injections.length > 0) systemNudges.push(_injections.shift())
    if (systemNudges.length > 0) {
      // _temp 标记：本轮注入的临时系统消息，下一轮 AI 请求前会被清理（见上方 _temp 清理逻辑）
      // 避免逐轮累积 system 消息导致上下文膨胀
      messages.push({ role: 'system', content: systemNudges.join('\n'), _temp: true })
    }

    const config = await configService.getAIConfig()
    const auth = await configService.getAppAuth()
    // 模型单独配置优先：优先使用选中模型的 temperature / max_tokens（来自后端 ai_models 表）
    // modelInfo 由 sidepanel 在 agentStart 时传入，包含 temperature / contextWindow / maxTokens
    const modelTemperature = (modelInfo && typeof modelInfo.temperature === 'number')
      ? modelInfo.temperature
      : (config.temperature ?? 0.3)
    const modelMaxTokens = (modelInfo && modelInfo.maxTokens)
      ? modelInfo.maxTokens
      : (config.maxTokens || 2048)
    // 构造请求体：剥离内部字段（_temp）避免污染 AI 请求
    const messagesForAI = messages.map(({ _temp, ...rest }) => rest)
    const body = {
      model: config.model, messages: messagesForAI,
      temperature: modelTemperature,
      // max_tokens 控制单次输出上限：下限 2048（保证工具调用参数完整），
      // 上限 32768（避免超大输出导致响应慢/费用高），由后台 modelInfo.maxTokens 控制
      max_tokens: Math.min(Math.max(modelMaxTokens || 2048, 2048), 32768),
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
        // 输出已存储数据信息（从内存索引读取，无需异步）
        const storedDataSummary = payloadStore.entries.filter(e => e.sessionId === sessionId).map(e => {
          const count = e.metadata?.count || 1
          const schemaStr = e.metadata?.schema ? Object.entries(e.metadata.schema).map(([k, v]) => `${k}:${v}`).join(', ') : ''
          return schemaStr ? `${e.id}: ${e.toolName} (${count}条 | {${schemaStr}})` : `${e.id}: ${e.toolName} (${count}条)`
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

          if (funcName === 'finish_task') {
            console.log('[Agent] finish_task, summary:', funcArgs.summary, 'data_refs:', funcArgs.data_refs)

            // ===== finish_task 也需要更新待办进度 =====
            if (todoScheduler.parentTodo) {
              const currentTodo = todoScheduler.getCurrentTodo()
              if (currentTodo && currentTodo.action === 'finish_task') {
                todoScheduler.markTodoResult('done', { summary: funcArgs.summary })
                todoScheduler.recordProgress()
              }
              postToUI(tabId, { type: 'agentTodoUpdate', data: { items: todoScheduler.parentTodo.items || [], progress: todoScheduler.getProgress(), currentTodoIndex: todoScheduler.currentTodoIndex, lastTool: 'finish_task', lastProgress: true } })
            }

            // ===== 处理 data_refs 参数：结构化数据通过 agentDataReport 单独发送到 UI 渲染 =====
            let referencedDataContent = ''
            const dataRefIds = normalizeDataRefs(funcArgs.data_refs)
            const reportDataItems = []  // 收集结构化数据，用于发送 agentDataReport
            if (dataRefIds.length > 0) {
              _debugLog('📦 finish_task 数据引用', { refs: dataRefIds })
              const storeData = await payloadStore.getDataByIds(dataRefIds)
              for (const refId of dataRefIds) {
                const data = storeData[refId]
                const entry = payloadStore.entries.find(e => e.id === refId)
                if (data !== undefined) {
                  // 收集到报告数据（结构化，供 sidepanel 渲染表格）
                  reportDataItems.push({
                    id: refId,
                    toolName: entry?.toolName || 'unknown',
                    data: data,
                    schema: entry?.metadata?.schema || null,
                    count: entry?.metadata?.count || (Array.isArray(data) ? data.length : 1),
                    renderType: entry?.metadata?.renderType || null,
                    // 模板渲染相关（renderType === 'template' 时使用）
                    templateId: entry?.metadata?.template_id || null,
                    fieldMapping: entry?.metadata?.field_mapping || null,
                    reportTitle: entry?.metadata?.title || null,
                  })
                  // 同时保留文本摘要作为兜底（流式输出里显示简短摘要，而非完整 JSON）
                  const dataPreview = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
                  const MAX_REF_CHARS = 2000  // 文本摘要里只保留前 2000 字符，完整数据走 agentDataReport
                  const truncated = dataPreview.length > MAX_REF_CHARS
                    ? dataPreview.slice(0, MAX_REF_CHARS) + `\n...(完整数据见下方报告)`
                    : dataPreview
                  referencedDataContent += `\n\n=== 数据 ${refId} (${entry?.toolName || 'unknown'}) ===\n${truncated}`
                }
              }
              if (referencedDataContent) {
                referencedDataContent = '\n\n【引用数据摘要】' + referencedDataContent
              }
            }

            const payloadSummary = payloadStore.getSummaryForFinish()
            if (payloadSummary) {
              const summaryHint = `\n[存储数据汇总] 共${payloadSummary.count}条存储：${payloadSummary.items.map(e => `${e.id}(${e.toolName}:${e.count}条)`).join(', ')}。可在 finish_task 中通过 data_refs 引用完整数据。`
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
            
            // ===== 对话全景：finish_task 也发送本轮数据（修复最后一轮AI输出缺失） =====
            _roundToolResults.push({
              toolName: 'finish_task',
              args: funcArgs,
              result: { ok: true, summary, judgeResult },
              finalResult: finalOutput,
              ok: true,
              isFinishTask: true,
            })
            const finishRoundData = {
              round: aiRequestCount,
              request: {
                messages: _requestMessagesSnapshot.map(m => {
                  if (m.role === 'tool') return { role: m.role, content: m.content }
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
                id: e.id, toolName: e.toolName, count: e.metadata?.count || 1, schema: e.metadata?.schema || null
              })),
              isFinishRound: true,
            }
            _sendToConversationViewer('conversationRound', finishRoundData)

            // 流式输出完整内容（summary + referencedData 摘要 + judgeMsg）
            // 使用 streamToUI 避免逐字符 setTimeout 在大数据时累计超时
            await streamToUI(postToUI, tabId, finalOutput)

            // ===== 发送结构化数据报告到 sidepanel（方案A：自动渲染为可交互表格） =====
            if (reportDataItems.length > 0) {
              postToUI(tabId, {
                type: 'agentDataReport',
                items: reportDataItems.map(item => ({
                  id: item.id,
                  toolName: item.toolName,
                  schema: item.schema,
                  count: item.count,
                  // renderType: 'html' → iframe 渲染 AI 生成的 HTML
                  // renderType: 'template' → 用预设模板引擎渲染
                  // 否则 → 默认表格/卡片渲染
                  renderType: item.renderType,
                  templateId: item.templateId,
                  fieldMapping: item.fieldMapping,
                  reportTitle: item.reportTitle,
                  // 数据量过大时截断，避免 chrome.runtime.sendMessage 超限（64MB 限制，保守取 500KB）
                  data: (() => {
                    const dataStr = JSON.stringify(item.data)
                    if (dataStr.length > 500000) {
                      const truncated = JSON.parse(dataStr.slice(0, 500000))
                      return { _truncated: true, ...truncated }
                    }
                    return item.data
                  })(),
                })),
              })
            }
            
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
                count: e.metadata?.count || 1,
              })),
              judgeResult: judgeResult || null,
            }
            try {
              await outputService.save(output)
              console.log(`[OutputService] 任务输出已保存: taskId=${_taskId}`)
            } catch (e) {
              console.warn('[OutputService] 保存失败（非致命）:', e.message)
            }

            // ===== 上传对话归档到后端（便于后台管理页面查看） =====
            try {
              await uploadConversationArchive(configService, {
                taskId: _taskId,
                sessionId,
                userMessage,
                model: config.model,
                totalRounds: aiRequestCount,
                totalToolCalls: totalToolCalls,
                status: judgeResult?.verdict || 'unknown',
                durationMs: endTime - _startTime,
                summary,
                rounds: _allRoundsData,
              })
              console.log(`[ConversationArchive] 已上传至后端: taskId=${_taskId}`)
            } catch (e) {
              console.warn('[ConversationArchive] 上传失败（非致命）:', e.message)
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
                chrome.tabs.sendMessage(tabId, { type: 'todoUpdate', data: { items: [], progress: { total: 0, completed: 0 }, currentTodoIndex: 0, _taskDone: true } }).catch(() => {})
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
              const noResultHint = `未找到与"${query}"匹配的专用脚本。你可以用本地DOM工具直接在页面上操作，或尝试搜索其他关键词。`
              toolResult = JSON.stringify({ ok: true, result: noResultHint })
            } else {
              toolResult = JSON.stringify(newResults.slice(0, 5).map(t => ({ id: t.id, name: t.name, description: t.description, toolType: t.toolType, toolConfig: t.toolConfig ? '已配置' : '未配置' })))
            }
            executedTools.push({ name: 'search_tools', result: { ok: newResults.length > 0, count: newResults.length } })
            postToUI(tabId, { type: 'agentSearchResult', results: newResults.slice(0, 5) })
          } else if (funcName === 'create_todo') {
            let itemsArg = funcArgs.items || []
            if (typeof itemsArg === 'string') { try { const parsed = JSON.parse(itemsArg.trim()); if (Array.isArray(parsed)) itemsArg = parsed } catch {} }

            // ===== 脚本ID存在性校验 =====
            // 提取所有 inject_script_N 的 action，检查对应脚本是否在搜索结果中
            const availableScriptIds = new Set(searchResults.map(s => `inject_script_${s.id}`))
            const scriptIdErrors = []
            if (Array.isArray(itemsArg)) {
              for (const item of itemsArg) {
                if (item.action && item.action.startsWith('inject_script_')) {
                  if (!availableScriptIds.has(item.action)) {
                    const available = [...availableScriptIds].join(', ') || '（请先调用 search_tools 搜索）'
                    scriptIdErrors.push(`待办 ${item.id || '?'} 的 action "${item.action}" 对应的脚本不存在。当前可用脚本: ${available}`)
                  }
                }
              }
            }
            if (scriptIdErrors.length > 0) {
              toolResult = JSON.stringify({ ok: false, error: `待办列表校验失败：\n${scriptIdErrors.join('\n')}\n请使用 search_tools 查询到的脚本ID，勿编造不存在的脚本。` })
              _debugLog('❌ 脚本ID不存在', scriptIdErrors)
            } else {
              const submitResult = todoScheduler.submitTodo(itemsArg)
              if (submitResult.ok) {
                const progress = todoScheduler.getProgress()
                toolResult = JSON.stringify({ ok: true, result: `待办列表已创建并通过校验：共${progress.total}个待办。系统将按待办顺序驱动执行，自动跟踪进度。当前待办: ${todoScheduler.getCurrentTodo()?.id || '无'} - ${todoScheduler.getCurrentTodo()?.description || ''}` })
                _debugLog('📋 待办列表已创建', { total: progress.total, currentTodoIndex: todoScheduler.currentTodoIndex })
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
              postToUI(tabId, { type: 'agentTodoUpdate', data: { items: todoScheduler.parentTodo?.items || [], progress: todoScheduler.getProgress(), currentTodoIndex: todoScheduler.currentTodoIndex } })
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
          } else if (funcName === 'generate_script') {
            // 动态代码执行：把 data_refs 全量数据注入 window.__store，执行 code，返回 {ok, result}
            const targetTab = await getTargetTab(tabId)
            if (!targetTab) {
              toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用' })
              executedTools.push({ name: `${funcName}(标签页不可用)`, result: toolResult })
              postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
              messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
              continue
            }
            const code = typeof funcArgs.code === 'string' ? funcArgs.code : ''
            const dataRefIds = normalizeDataRefs(funcArgs.data_refs)
            if (!code.trim()) {
              toolResult = JSON.stringify({ ok: false, error: 'code 参数不能为空' })
              executedTools.push({ name: `${funcName}(空代码)`, result: toolResult })
              postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
              messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
              continue
            }
            postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: { description: funcArgs.description || '', data_refs: dataRefIds }, status: 'running' })
            try {
              // 读取 data_refs 对应的全量数据
              let storeData = {}
              if (dataRefIds.length > 0) {
                storeData = await payloadStore.getDataByIds(dataRefIds)
                // 校验引用数据是否都存在
                const missing = dataRefIds.filter(id => storeData[id] === undefined)
                if (missing.length > 0) {
                  toolResult = JSON.stringify({ ok: false, error: `引用的数据不存在: ${missing.join(', ')}` })
                  executedTools.push({ name: `${funcName}(引用缺失)`, result: toolResult })
                  postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
                  messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
                  continue
                }
              }
              // 在页面中注入 window.__store 并执行 code
              // 关键：必须用 world: 'MAIN'，否则 isolated world 受页面 CSP 限制，new Function 会被拦截
              // 参见 inject_script_N 的实现（tool-service.js executeJSTool）
              const [execResult] = await chrome.scripting.executeScript({
                target: { tabId: targetTab.id },
                world: 'MAIN',
                func: (storeObj, userCode) => {
                  try {
                    window.__store = window.__store || {}
                    if (storeObj && typeof storeObj === 'object') {
                      for (const k of Object.keys(storeObj)) window.__store[k] = storeObj[k]
                    }
                    const fn = new Function(userCode)
                    const r = fn()
                    return { ok: true, result: r }
                  } catch (e) {
                    return { ok: false, error: e.message }
                  }
                },
                args: [storeData, code],
              })
              const r = execResult?.result
              if (r && r.ok) {
                toolResult = JSON.stringify({ ok: true, result: r.result })
              } else {
                // CSP 失败时给替代方案提示，避免 AI 困惑循环
                const errMsg = r?.error || '代码执行失败'
                const hint = errMsg.includes('Content Security Policy') || errMsg.includes('unsafe-eval')
                  ? ' [建议：改用 inject_script_N（search_tools 查找）或 DOM 工具组合完成]'
                  : ''
                toolResult = JSON.stringify({ ok: false, error: errMsg + hint })
              }
            } catch (e) {
              if (e.message?.includes('Cannot access a chrome:// URL') || e.message?.includes('Cannot access contents of url')) {
                toolResult = JSON.stringify({ ok: false, error: '当前页面为系统页面，无法执行脚本。' })
              } else {
                toolResult = JSON.stringify({ ok: false, error: `执行失败: ${e.message}` })
              }
            }
            executedTools.push({ name: funcName, result: toolResult })
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
          } else if (['extract_content','click_element','fill_input','wait_for_element','save_as_file','navigate_to','go_back','find_text_on_page','get_element_info','scroll_page','hover_element','select_dropdown','press_key','go_forward','get_interactive_elements','detect_page_template'].includes(funcName)) {
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
            } else if (funcName === 'navigate_to' && aiRequestCount / effectiveMaxRounds >= 0.85) {
              _debugLog('💡 预算提示: navigate_to接近预算上限', { round: aiRequestCount, maxRounds: effectiveMaxRounds })
              _injections.push(`💡 提示：已使用${Math.round(aiRequestCount / effectiveMaxRounds * 100)}%预算，导航新页面可能消耗较多轮次。请评估剩余轮次能否完成，如不能请调用finish_task汇总已有结果。`)
              const targetTab = await getTargetTab(tabId)
              if (!targetTab) { toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用' }) }
              else {
                postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: funcArgs, status: 'running' })
                const domResult = await executeDOMToolWithTimeout(targetTab.id, funcName, funcArgs, ACTION_TIMEOUT_MS)
                toolResult = JSON.stringify(domResult)
                executedTools.push({ name: funcName, result: domResult })
              }
            } else {
              const targetTab = await getTargetTab(tabId)
              if (!targetTab) { toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用' }) }
              else {
                postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: funcArgs, status: 'running' })
                const domResult = await executeDOMToolWithTimeout(targetTab.id, funcName, funcArgs, ACTION_TIMEOUT_MS)
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

          // ===== 进度记录 =====
          // 只有实际推进任务的工具才重置 failCount
          // read_page_content / scroll_page 在没有待办匹配时不算进展
          if (hasProgress) {
            const isNonProgressTool = (funcName === 'read_page_content' || funcName === 'scroll_page') && !matchedTodo
            if (!isNonProgressTool) {
              todoScheduler.recordProgress()
            }
          } else {
            todoScheduler.recordNoProgress(funcName)
          }

          // 发送待办进度更新
          if (todoScheduler.parentTodo) {
            postToUI(tabId, { type: 'agentTodoUpdate', data: { items: todoScheduler.parentTodo.items || [], progress: todoScheduler.getProgress(), currentTodoIndex: todoScheduler.currentTodoIndex, lastTool: funcName, lastProgress: hasProgress } })
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

          // ===== 工具结果处理：标准化信封 + 存储 =====
          let finalResult
          const returnMode = funcArgs.return_mode || 'summary'

          // 数据采集类工具支持 return_mode
          const dataTools = ['extract_content', 'get_interactive_elements', 'get_element_info']

          if (dataTools.includes(funcName) && returnMode === 'full') {
            // return_mode="full": 存储纯数组数据，返回 schema+样例摘要
            const envelope = normalizePayload(toolResult, funcName)
            // 存入 envelope.items（纯数组），而非原始 toolResult（含 ok/_overview 等包装）
            // 这样 window.__store.p1 直接就是数组，AI可 .filter()/.map() 遍历
            const storeId = await payloadStore.add(funcName, envelope.items, formatSchemaSummary('?', funcName, envelope),
              { count: envelope.count, schema: envelope.schema, sample: envelope.sample })
            if (storeId === null) {
              // 存储失败：返回失败标记，避免后续引用不存在的数据
              finalResult = JSON.stringify({ ok: false, error: '数据存储失败（可能超过配额），请尝试缩小采集范围后重试' })
              console.warn(`[Agent] ${funcName} return_mode=full 存储失败`)
            } else {
              const summaryText = formatSchemaSummary(storeId, funcName, envelope)
              const typeHint = envelope.items.length > 1
                ? `共${envelope.items.length}条数据，schema 见上方`
                : envelope.items.length === 1
                ? `共1条数据`
                : `数据为空`
              finalResult = `${summaryText}\n完整数据已存储(ID:${storeId})，可在 finish_task 中通过 data_refs=["${storeId}"] 引用。${typeHint}。`
              console.log(`[Agent] ${funcName} return_mode=full，存储全量数据，返回schema摘要（存储ID:${storeId}）`)
              // 同步更新 WorkingMemory
              workingMemory.addDataRef(funcName, storeId, envelope.count, summaryText)
            }
          } else if (dataTools.includes(funcName) && returnMode === 'summary') {
            // return_mode="summary"（默认）：标准化 + 存储纯数组数据，返回 schema+样例
            const envelope = normalizePayload(toolResult, funcName)
            const storeId = await payloadStore.add(funcName, envelope.items, formatSchemaSummary('?', funcName, envelope),
              { count: envelope.count, schema: envelope.schema, sample: envelope.sample })
            if (storeId === null) {
              finalResult = JSON.stringify({ ok: false, error: '数据存储失败（可能超过配额），请尝试缩小采集范围后重试' })
              console.warn(`[Agent] ${funcName} return_mode=summary 存储失败`)
            } else {
              const summaryText = formatSchemaSummary(storeId, funcName, envelope)
              const overview = buildDataOverview(toolResult, funcName)
              overview._stored = storeId
              overview._schemaHint = summaryText
              finalResult = JSON.stringify(overview)
              console.log(`[Agent] ${funcName} return_mode=summary，返回概览（存储ID:${storeId}）`)
              // 同步更新 WorkingMemory
              const count = overview._overview?.content_count || overview._overview?.total || 1
              workingMemory.addDataRef(funcName, storeId, count, summaryText)
            }
          } else if (funcName === 'generate_script' && toolResult.includes('"ok":true')) {
            // generate_script 专用存储：直接存 result（AI return 的原始值），不包数组
            // 这样 window.__store.pX 就是 AI return 的东西，符合 AI 心智模型
            // 避免之前 normalizePayload 把对象包成 [obj] 导致 AI 写 p2.items 报 undefined
            try {
              const parsed = JSON.parse(toolResult)
              const actualData = parsed.result  // AI 实际 return 的值
              const dataStr = JSON.stringify(actualData)
              if (dataStr.length > 1500) {
                // 检测 HTML 报告：AI 用 generate_script 生成 HTML 字符串时，标记为 html 渲染类型
                // 框架在 sidepanel 用 sandboxed iframe 渲染，避免 AI 写的 CSS/JS 污染 sidepanel
                // 匹配常见 HTML 根标签开头（含 <style>、<script>、<header> 等），不区分大小写
                const isHtmlReport = typeof actualData === 'string'
                  && /^\s*<(?:!doctype\s+html|html|head|body|style|script|div|section|article|main|table|ul|ol|h[1-6]|p|header|footer|nav|figure|form)\b/i.test(actualData)
                const metadata = isHtmlReport
                  ? { renderType: 'html', count: 1 }
                  : { count: Array.isArray(actualData) ? actualData.length : 1 }
                const storeId = await payloadStore.add('generate_script', actualData,
                  `generate_script: ${funcArgs.description || ''}`.slice(0, 100),
                  metadata)
                if (storeId === null) {
                  finalResult = JSON.stringify({ ok: false, error: '数据存储失败（可能超过配额），请尝试缩小数据量后重试' })
                  console.warn('[Agent] generate_script 存储失败')
                } else {
                  // 根据实际数据类型生成准确的 typeHint（关键：描述与存储结构一致）
                  let typeHint
                  if (isHtmlReport) {
                    typeHint = `HTML 报告字符串（长度 ${actualData.length}），sidepanel 将用 iframe 渲染`
                  } else if (Array.isArray(actualData)) {
                    typeHint = actualData.length > 0
                      ? `window.__store.${storeId} 是数组（长度${actualData.length}），可直接 .filter()/.map()/.forEach() 遍历`
                      : `window.__store.${storeId} 是空数组`
                  } else if (actualData && typeof actualData === 'object') {
                    const keys = Object.keys(actualData).slice(0, 8)
                    typeHint = `window.__store.${storeId} 是对象，字段: ${keys.join(', ')}（访问用 window.__store.${storeId}.字段名）`
                  } else {
                    typeHint = `window.__store.${storeId} 是 ${typeof actualData}: ${String(actualData).slice(0, 50)}`
                  }
                  const preview = dataStr.slice(0, 200)
                  finalResult = `generate_script 已执行。返回值预览: ${preview}${dataStr.length > 200 ? '...' : ''}\n完整数据已存储(ID:${storeId})，使用 generate_script(data_refs=["${storeId}"]) 操作。${typeHint}。`
                  workingMemory.addDataRef('generate_script', storeId,
                    Array.isArray(actualData) ? actualData.length : 1, finalResult)
                  console.log(`[Agent] generate_script 存储原始返回值（ID:${storeId}），数据类型: ${isHtmlReport ? 'HTML报告' : (Array.isArray(actualData) ? `数组(${actualData.length}条)` : typeof actualData)}`)
                }
              } else {
                // 数据量小，不需要存储，直接返回原始结果
                finalResult = toolResult
              }
            } catch (e) {
              console.warn('[Agent] generate_script 存储异常:', e.message)
              finalResult = toolResult
            }
          } else if (funcName === 'render_report') {
            // render_report：用预设模板渲染数据报告
            // 从 data_refs 获取数据，存储到 payloadStore，metadata 带 renderType: 'template'
            // finish_task 时 AI 引用此存储ID，sidepanel 用模板引擎渲染
            try {
              const refIds = normalizeDataRefs(funcArgs.data_refs)
              if (refIds.length === 0) {
                finalResult = JSON.stringify({ ok: false, error: 'data_refs 不能为空' })
              } else {
                const storeData = await payloadStore.getDataByIds(refIds)
                // 合并多个数据引用的数据
                let combinedData = []
                for (const refId of refIds) {
                  const d = storeData[refId]
                  if (Array.isArray(d)) {
                    combinedData = combinedData.concat(d)
                  } else if (d !== undefined && d !== null) {
                    combinedData.push(d)
                  }
                }
                const templateId = funcArgs.template_id
                const fieldMapping = funcArgs.field_mapping || null
                const reportTitle = funcArgs.title || ''
                const storeId = await payloadStore.add('render_report', combinedData,
                  `render_report: ${templateId}`.slice(0, 100),
                  {
                    renderType: 'template',
                    template_id: templateId,
                    field_mapping: fieldMapping,
                    title: reportTitle,
                    count: combinedData.length,
                  })
                if (storeId === null) {
                  finalResult = JSON.stringify({ ok: false, error: '数据存储失败（可能超过配额）' })
                } else {
                  finalResult = JSON.stringify({
                    ok: true,
                    storeId,
                    template: templateId,
                    count: combinedData.length,
                    message: `报告已准备（模板:${templateId}，数据:${combinedData.length}条）。finish_task 时通过 data_refs=["${storeId}"] 引用即可显示`,
                  })
                  workingMemory.addDataRef('render_report', storeId, combinedData.length, `模板报告: ${templateId}`)
                  console.log(`[Agent] render_report 存储渲染请求（ID:${storeId}，模板:${templateId}，数据:${combinedData.length}条）`)
                }
              }
            } catch (e) {
              console.warn('[Agent] render_report 处理异常:', e.message)
              finalResult = JSON.stringify({ ok: false, error: e.message })
            }
          } else if (shouldStoreToPayload(toolResult, funcName)) {
            // 其他工具：标准化 + 存储纯数组
            const envelope = normalizePayload(toolResult, funcName)
            finalResult = await storeToPayload(payloadStore, envelope.items, funcName, envelope)
            const storeId = payloadStore.entries[payloadStore.entries.length - 1]?.id
            console.log('[Agent] payloadStore 存储:', funcName, '→ ID:', storeId)
            // 同步更新 WorkingMemory 的数据引用
            if (storeId) {
              const summaryText = formatSchemaSummary(storeId, funcName, envelope)
              workingMemory.addDataRef(funcName, storeId, envelope.count, summaryText)
            }
          } else {
            finalResult = smartTruncateResult(toolResult)
          }
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: finalResult })
          // ===== 对话全景：收集工具执行结果 =====
          _roundToolResults.push({ toolName: funcName, args: funcArgs, result: toolResult, finalResult, ok: !toolResult?.includes('error') && !toolResult?.includes('skipped') })

          // ===== 选择器反馈上报：构建主动学习闭环 =====
          // 仅对使用 selector/selectorHint 的工具上报，且仅在有明确页面 host 时
          // 判定成功/失败：基于工具返回的元素数量（0 个视为失效）
          try {
            const usedSelector = funcArgs.selector || funcArgs.selectorHint || null
            if (usedSelector && typeof usedSelector === 'string' && usedSelector.length > 0 && autoPageContent?.url) {
              const host = _extractHost(autoPageContent.url)
              if (host) {
                let itemCount = 0
                let isFailure = false
                try {
                  const parsed = JSON.parse(toolResult)
                  if (parsed?.ok === false) {
                    isFailure = true
                  } else if (parsed?.result) {
                    // 解析元素数量：extract_content/get_interactive_elements/get_element_info 的返回结构
                    if (Array.isArray(parsed.result)) {
                      itemCount = parsed.result.length
                    } else if (parsed.result.elements && Array.isArray(parsed.result.elements)) {
                      itemCount = parsed.result.elements.length
                    } else if (parsed.result.items && Array.isArray(parsed.result.items)) {
                      itemCount = parsed.result.items.length
                    } else if (parsed.result.total) {
                      itemCount = Number(parsed.result.total) || 0
                    } else if (parsed.result.count) {
                      itemCount = Number(parsed.result.count) || 0
                    }
                    // 0 元素视为失效
                    if (itemCount === 0) isFailure = true
                  }
                } catch {}
                reportSelectorFeedback(configService, {
                  host,
                  selector: usedSelector,
                  toolName: funcName,
                  taskId: _taskId,
                  resultStatus: isFailure ? 'failure' : 'success',
                  itemCount,
                })
              }
            }
          } catch (e) {
            // 上报失败不影响主流程
          }

          await new Promise(r => setTimeout(r, 200))
        }

        // ===== 对话全景：发送本轮完整数据 =====
        const roundData = {
          round: aiRequestCount,
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
            id: e.id, toolName: e.toolName, count: e.metadata?.count || 1, schema: e.metadata?.schema || null
          }))
        }
        _sendToConversationViewer('conversationRound', roundData)

        // ===== Scratchpad 持久化 =====
        // 每轮结束后保存中间推理状态，支持断点续传
        try {
          await scratchpadService.save(sessionId, workingMemory.state, {
            round: aiRequestCount,
            todoIndex: todoScheduler.currentTodoIndex,
          })
        } catch (e) {
          console.warn('[ScratchpadService] 保存失败（非致命）:', e.message)
        }

        // ===== 消息上下文压缩（基于 token 估算，动态适配模型 context window） =====
        // 借鉴 AI 编程工具策略：充分利用大窗口模型（128K/200K），按实际容量动态调整
        // 1 token ≈ 3-4 字符（中英混合），保守按 3.5 字符/token 估算
        const estimateContextChars = (msgs) => {
          let total = 0
          for (const m of msgs) {
            if (typeof m.content === 'string') total += m.content.length
            // tool_calls 的 arguments 也计入
            if (Array.isArray(m.tool_calls)) {
              for (const tc of m.tool_calls) {
                total += (tc.function?.arguments || '').length
              }
            }
          }
          return total
        }

        // 动态计算可用上下文预算（基于模型 context window）
        // modelInfo.contextWindow 来自后端 ai_models 表，单位 token
        const modelContextTokens = (modelInfo && modelInfo.contextWindow) || 32000  // 默认 32K
        // 预留空间：tools 定义(~2K) + system(~1K) + WorkingMemory(~1K) + AI响应(~4K) + 安全余量(15%)
        const RESERVED_TOKENS = 8000
        const SAFETY_RATIO = 0.85
        const availableTokens = Math.max(8000, Math.floor(modelContextTokens * SAFETY_RATIO) - RESERVED_TOKENS)
        // 转换为字符阈值（1 token ≈ 3.5 字符保守估算）
        const MAX_CONTEXT_CHARS = Math.floor(availableTokens * 3.5)
        // 压缩后保留 60% 字符预算给近期上下文
        const COMPRESS_KEEP_RATIO = 0.6

        const currentChars = estimateContextChars(messages)
        if (currentChars > MAX_CONTEXT_CHARS) {
          // 按字符预算保留近期上下文，至少 12 条确保 tool_calls 配对完整
          const targetChars = Math.floor(MAX_CONTEXT_CHARS * COMPRESS_KEEP_RATIO)
          let keepRecent = 0
          let keptChars = 0
          // 从末尾向前累计，直到达到目标字符数
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i]
            const mChars = (typeof m.content === 'string' ? m.content.length : 0)
              + (Array.isArray(m.tool_calls) ? m.tool_calls.reduce((s, tc) => s + (tc.function?.arguments || '').length, 0) : 0)
            if (keptChars + mChars > targetChars && keepRecent >= 12) break
            keptChars += mChars
            keepRecent++
          }
          // 确保 keepRecent 包含完整的 tool_calls 配对（assistant + 对应 tool 消息）
          // 向前扩展直到最近一个 assistant.tool_calls 之前
          while (keepRecent < messages.length) {
            const idx = messages.length - keepRecent - 1
            if (idx < 0) break
            if (messages[idx].role === 'assistant' && messages[idx].tool_calls) break
            keepRecent++
          }
          let cutOff = messages.length - keepRecent
          if (cutOff > 1) {
            // 跳过 tool 消息起点（避免从 tool 消息中间切断导致配对破坏）
            while (cutOff < messages.length && messages[cutOff]?.role === 'tool') cutOff++
          }
          if (cutOff > 1) {
            console.log(`[Agent] 上下文压缩: ${currentChars}字符 > ${MAX_CONTEXT_CHARS}字符(modelCtx=${modelContextTokens}t), 保留近${keepRecent}条(${keptChars}字符), 压缩前${cutOff - 1}条`)
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
        // ===== 检测：AI 输出了类工具调用文本但未走标准 tool_calls（如 <function=xxx> 标签） =====
        // 这种情况不能直接结束任务，否则 finish_task 永远不会被执行，待办卡死
        const looksLikeToolCall = /<function\s*=\s*[\w_]+|<parameter\s*=\s*\w+>|call\s+function[:：]\s*\w+/i.test(content)
        if (looksLikeToolCall) {
          console.warn('[Agent] 检测到 AI 用文本格式输出工具调用，注入纠正提示')
          _injections.push(`⚠️ 你上一轮的输出被识别为纯文本，工具调用未执行。请使用标准 tool_calls JSON 格式重新调用工具（不要用 <function=xxx> 标签）。如果任务已完成，请直接调用 finish_task。当前剩余轮次：${effectiveMaxRounds - aiRequestCount}`)
          // 不结束任务，继续下一轮，让 AI 重新用正确格式调用
          messages.push({ role: 'assistant', content: content || '(空文本)', _parseFailedToolCall: true })
          messages.push({ role: 'user', content: '请用标准 tool_calls 格式重新发起调用，或调用 finish_task 结束任务。', _temp: true })
          continue
        }
        // ===== 对话全景：纯文本回复也发送本轮数据（修复 AI 输出未在全景显示） =====
        const textRoundData = {
          round: aiRequestCount,
          request: {
            messages: _requestMessagesSnapshot.map(m => {
              if (m.role === 'tool') return { role: m.role, content: m.content }
              return {
                role: m.role,
                content: typeof m.content === 'string' ? (m.content.length > 800 ? m.content.slice(0, 400) + '\n...(已压缩)' : m.content) : m.content,
                tool_calls: m.tool_calls?.map(tc => ({ name: tc.function?.name, args: tc.function?.arguments }))
              }
            }),
            toolsCount: tools.length
          },
          response: msg,
          toolResults: [],
          storedData: payloadStore.entries.filter(e => e.sessionId === sessionId).map(e => ({
            id: e.id, toolName: e.toolName, count: e.metadata?.count || 1, schema: e.metadata?.schema || null
          })),
          isTextOnlyRound: true,
        }
        _sendToConversationViewer('conversationRound', textRoundData)
        const textContent = content || 'AI未返回有效响应，请重试。'
        if (content) {
          // 使用 streamToUI 统一流式逻辑（内部已发送 streamDone）
          await streamToUI(postToUI, tabId, content)
        } else {
          console.warn('[Agent] AI返回空内容且无工具调用，强制结束')
          postToUI(tabId, { type: 'streamChunk', content: textContent })
          postToUI(tabId, { type: 'streamDone' })
        }
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
  // 上限完全由后端 agent_max_rounds 控制（仅 ABSOLUTE_MAX_ROUNDS=100 防配错）
  const reachedRounds = aiRequestCount
  const reachedToolCalls = totalToolCalls
  postToUI(tabId, { type: 'agentError', error: `Agent达到最大请求次数（已执行 ${reachedRounds}/${effectiveMaxRounds} 轮），请简化任务重试` })
  _debugLog('🛑 Agent终止: 达到最大轮次', { effectiveMaxRounds, maxRounds, aiRequestCount, executedToolsCount: executedTools.length })
  const capNote = effectiveMaxRounds < maxRounds
    ? `（后端配置 ${maxRounds} 轮，超过绝对硬上限 100，已收敛为 ${effectiveMaxRounds} 轮）`
    : ''
  const finalNote = `⚠️ Agent 已达到最大请求次数上限，任务可能未完成。\n实际执行：${reachedRounds}/${effectiveMaxRounds} 轮 AI 请求，${reachedToolCalls} 次工具调用${capNote}。\n建议：1) 拆分任务为更小子任务 2) 简化需求描述 3) 后端调高 agent_max_rounds 配置（当前=${maxRounds}）。`
  const toolCallsSummary = executedTools.length > 0
    ? executedTools.filter(t => !t.name?.includes('search_tools') && !t.name?.includes('read_page_content')).slice(0, 15)
    : []
  await saveToChatHistoryStorage(finalNote, toolCallsSummary)
}
