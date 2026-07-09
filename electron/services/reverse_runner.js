// ============ 逆向分析 AI 引擎（reverse_runner.js） ============
// 独立于 agent_runner.js，专门用于逆向分析场景
// 复用：streamToUI 模式、LLM 调用、payloadStore 数据管理
// 区别：使用 REVERSE_TOOLS 工具集，专用逆向提示词，无 TodoScheduler

const { safeJsonStringify } = require('./utils')
const { fetchWithTimeout } = require('./utils')
const { REVERSE_TOOLS, executeReverseTool } = require('./reverse_tools')
const networkCapture = require('./network_capture')
const WorkingMemory = require('./working_memory')

// ============ 配置常量 ============
const STREAM_SEGMENT = 80
const STREAM_DELAY_MS = 15
const STREAM_CHAR_THRESHOLD = 2000
const DEFAULT_MAX_ROUNDS = 20
const MAX_API_RETRIES = 2
const API_TIMEOUT_MS = 60000

// ============ 逆向专用系统提示词 ============
const REVERSE_SYSTEM_PROMPT = `你是网页逆向分析专家。你擅长：
1. 分析网页 API 接口（请求/响应结构、参数加密、签名算法）
2. 逆向分析 JS 代码（反混淆、提取关键函数、识别加密算法）
3. 验证逆向结果（重放请求、对比响应）

=== 可用工具 ===
- get_captured_requests：获取已捕获的网络请求（含请求体/响应体）。逆向核心数据来源
- fetch_script_source：拉取指定 JS 文件源码（突破 CORS）
- replay_request：重放请求验证算法（可修改参数/headers）
- execute_js：在页面上下文执行 JS（调用加密函数、提取变量）
- read_page_content：读取页面内容
- get_page_html：获取页面 HTML
- finish_task：完成分析，输出报告

=== 分析流程 ===
1. 捕获目标 API → get_captured_requests(urlFilter="关键词")
2. 分析请求参数 → 识别动态生成的参数（sign/token/timestamp/nonce）
3. 定位加密 JS → fetch_script_source 拉取可疑脚本
4. 反混淆分析 → 识别加密算法（MD5/SHA/AES/RSA/自定义）
5. 验证算法 → execute_js 在页面调用加密函数，对比生成结果
6. 重放验证 → replay_request 修改参数验证算法正确性
7. finish_task 输出完整逆向报告

=== 输出报告规范 ===
finish_task 的 summary 必须包含：
- 接口分析：URL、方法、关键参数说明
- 加密参数：哪些参数是动态生成的，算法是什么
- 关键函数：函数名、所在文件 URL、行号范围
- 算法实现：伪代码 + 实际 JS 代码
- 验证结果：原始请求 vs 重放请求的响应对比
- 复用建议：如何独立调用该接口（含完整示例代码）

=== 注意事项 ===
- 优先分析 XHR/Fetch 请求，这些通常是核心 API
- sign/token 等参数多在请求头或请求体的特定字段
- 加密函数多在入口 JS 文件，按 script 标签 src 顺序排查
- 某些站点用 Webpack 打包，需先定位模块编号再找具体函数`

// ============ 流式输出到 UI（复用 agent_runner 模式） ============
async function streamToUI(sendEvent, text) {
  if (!text) {
    sendEvent('streamDone', {})
    return
  }
  console.log(`[Reverse] streamToUI 开始: ${text.length} 字符`)
  const segment = text.length > STREAM_CHAR_THRESHOLD ? 8000 : STREAM_SEGMENT
  let chunkCount = 0
  for (let i = 0; i < text.length; i += segment) {
    const chunk = text.slice(i, i + segment)
    sendEvent('streamChunk', { content: chunk })
    chunkCount++
    await new Promise(r => setTimeout(r, STREAM_DELAY_MS))
  }
  sendEvent('streamDone', {})
  console.log(`[Reverse] streamToUI 完成: ${chunkCount} 个 chunk, ${text.length} 字符`)
}

// ============ 主运行函数 ============
/**
 * 运行逆向分析
 * @param {object} opts - { webContents, tabId, userMessage, chatHistory, modelInfo, configService, payloadStore, sendEvent }
 */
async function runReverseAnalysis(opts) {
  const {
    webContents, tabId, userMessage, chatHistory = [],
    modelInfo = {}, configService, payloadStore, sendEvent,
  } = opts

  if (!webContents) {
    sendEvent('agentError', { error: '无可用 webContents' })
    return
  }

  // 读取最大轮次配置（支持从 opts 或 agentConfig 传入，默认 20）
  const maxRounds = opts.maxRounds || DEFAULT_MAX_ROUNDS
  console.log(`[Reverse] 最大轮次配置: ${maxRounds}`)

  const workingMemory = new WorkingMemory()
  let aiRequestCount = 0
  let totalToolCalls = 0
  let consecutiveFails = 0
  const startTime = Date.now()

  // 发送开始事件
  sendEvent('agentStart', { tabId, userMessage })
  sendEvent('agentStatus', { text: '逆向分析启动中...' })

  // 自动开启网络捕获（如果未开启）
  if (!networkCapture.isCapturing(webContents)) {
    const capRes = await networkCapture.start(webContents)
    if (capRes.success) {
      console.log('[Reverse] 自动开启网络捕获')
      sendEvent('agentStatus', { text: '网络捕获已开启，请触发目标操作（如登录、查询）' })
    } else {
      console.warn('[Reverse] 网络捕获开启失败:', capRes.error)
    }
  }

  // 读取配置
  let aiConfig, auth
  try {
    aiConfig = await configService.getAIConfig()
    auth = await configService.getAppAuth()
  } catch (e) {
    sendEvent('agentError', { error: '配置读取失败: ' + e.message })
    return
  }

  // 构建 messages
  const messages = []
  messages.push({ role: 'system', content: REVERSE_SYSTEM_PROMPT })
  // 用户消息
  messages.push({ role: 'user', content: userMessage })
  // 注入历史上下文（如果有）
  if (chatHistory.length > 0) {
    for (const msg of chatHistory.slice(-10)) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content })
      }
    }
  }

  // 注入当前 URL 提示
  try {
    const currentUrl = webContents.getURL()
    if (currentUrl) {
      messages.push({
        role: 'system',
        content: `当前页面: ${currentUrl}\n页面标题: ${webContents.getTitle()}`,
        _temp: true,
      })
    }
  } catch {}

  // 工具集
  const tools = REVERSE_TOOLS.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }))

  // ===== 主循环 =====
  while (aiRequestCount < maxRounds) {
    // 检查中止
    if (opts._aborted) {
      sendEvent('agentStatus', { text: '任务已中止' })
      break
    }

    aiRequestCount++
    sendEvent('agentStatus', { text: `第${aiRequestCount}轮分析中...` })
    console.log(`[Reverse] 第${aiRequestCount}轮开始`)

    // 构建请求体
    const effectiveModel = modelInfo.modelId || aiConfig.model
    const temperature = modelInfo.temperature ?? aiConfig.temperature ?? 0.3
    const maxTokens = modelInfo.maxTokens || aiConfig.maxTokens || 4096
    const messagesForAI = messages.map(({ _temp, ...rest }) => rest)
    const body = {
      model: effectiveModel,
      messages: messagesForAI,
      temperature,
      max_tokens: Math.min(Math.max(maxTokens || 4096, 2048), 32768),
      tools,
      tool_choice: 'auto',
    }

    // 调用 LLM
    let llmResponse = null
    try {
      const url = await configService.getAIProxyUrl()
      const headers = await configService.generateAuthHeaders(auth.appKey, auth.appSecret)

      let res, lastError
      for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
        try {
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
          res = await fetch(url, {
            method: 'POST', headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          clearTimeout(timeoutId)
          if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) break
          if (attempt < MAX_API_RETRIES) await new Promise(r => setTimeout(r, (attempt + 1) * 1000))
        } catch (e) {
          lastError = e
          if (attempt < MAX_API_RETRIES) await new Promise(r => setTimeout(r, (attempt + 1) * 1000))
        }
      }

      if (!res || !res.ok) {
        let errDetail = ''
        try { const errJson = await res?.json(); errDetail = errJson?.error?.message || JSON.stringify(errJson).slice(0, 200) } catch {}
        throw new Error(`API 请求失败: ${res?.status || '无响应'} ${errDetail}`)
      }

      llmResponse = await res.json()
      console.log(`[Reverse] 第${aiRequestCount}轮响应: ${llmResponse.choices?.[0]?.message ? 'ok' : 'empty'}`)
    } catch (e) {
      console.error(`[Reverse] 第${aiRequestCount}轮 LLM 异常:`, e.message)
      sendEvent('agentError', { error: `LLM 请求失败: ${e.message}`, round: aiRequestCount })
      consecutiveFails++
      if (consecutiveFails >= 3) {
        sendEvent('agentStatus', { text: '连续3次失败，终止任务' })
        break
      }
      continue
    }
    consecutiveFails = 0

    const choice = llmResponse.choices?.[0]
    if (!choice) {
      console.warn('[Reverse] 无 choices')
      break
    }
    const msg = choice.message
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls })

    // 发送 AI 思考内容（每轮 LLM 返回的 content）
    if (msg.content && msg.content.trim()) {
      sendEvent('agentThinking', { round: aiRequestCount, content: msg.content })
    }

    // 无工具调用 → 直接回复
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const textContent = msg.content || '(无内容)'
      sendEvent('agentStep', { step: totalToolCalls, round: aiRequestCount, toolName: '回复', status: 'done' })
      // 如果是自然结束，发送流式回复
      if (aiRequestCount >= maxRounds || /任务完成|分析完成|finish_task/i.test(textContent)) {
        await streamToUI(sendEvent, textContent)
        break
      }
      // 否则继续下一轮
      continue
    }

    // 处理工具调用
    for (const toolCall of msg.tool_calls) {
      const funcName = toolCall.function.name
      let funcArgs = {}
      try { funcArgs = JSON.parse(toolCall.function.arguments || '{}') } catch {}

      totalToolCalls++
      sendEvent('agentStep', {
        step: totalToolCalls,
        round: aiRequestCount,
        toolName: funcName,
        args: funcArgs,
        status: 'running',
      })

      console.log(`[Reverse] 工具调用: ${funcName}`, funcArgs)

      // finish_task 特殊处理
      if (funcName === 'finish_task') {
        const summary = funcArgs.summary || '逆向分析完成'
        const dataRefs = funcArgs.data_refs || []
        let referencedData = ''

        // 注入引用数据
        if (dataRefs.length > 0 && payloadStore) {
          try {
            const dataMap = await payloadStore.getDataByIds(dataRefs)
            const parts = []
            for (const [id, data] of Object.entries(dataMap)) {
              const dataStr = safeJsonStringify(data)
              parts.push(`=== ${id} ===\n${dataStr.length > 5000 ? dataStr.slice(0, 5000) + '...[截断]' : dataStr}`)
            }
            referencedData = parts.length > 0 ? '\n\n--- 引用数据 ---\n' + parts.join('\n\n') : ''
          } catch (e) {
            console.warn('[Reverse] data_refs 注入失败:', e.message)
          }
        }

        const finalOutput = summary + referencedData
        sendEvent('agentStep', {
          step: totalToolCalls, round: aiRequestCount,
          toolName: 'finish_task', status: 'done',
        })

        // ★ 先发送最终回复
        console.log(`[Reverse] finish_task 即将发送最终回复: ${finalOutput.length} 字符`)
        await streamToUI(sendEvent, finalOutput)

        // 发送数据报告（如果有）
        if (dataRefs.length > 0 && payloadStore) {
          try {
            const items = []
            for (const id of dataRefs) {
              const data = payloadStore._dataCache?.[id]
              if (data) {
                items.push({
                  id,
                  toolName: 'reverse_analysis',
                  data,
                  renderType: typeof data === 'string' && /^\s*<html/i.test(data) ? 'html' : 'table',
                })
              }
            }
            if (items.length > 0) {
              sendEvent('agentDataReport', { items, summary })
            }
          } catch (e) {
            console.warn('[Reverse] 数据报告发送失败:', e.message)
          }
        }

        sendEvent('conversationTaskDone', { summary, totalRounds: aiRequestCount, totalToolCalls })
        // 清理 payloadStore
        try { payloadStore.clear?.() } catch {}
        return { summary, totalRounds: aiRequestCount, totalToolCalls }
      }

      // 执行其他工具
      let toolResult
      try {
        const ctx = { webContents, tabId, payloadStore, workingMemory }
        toolResult = await executeReverseTool(funcName, funcArgs, ctx)
      } catch (e) {
        toolResult = JSON.stringify({ ok: false, error: `工具执行异常: ${e.message}` })
      }

      // 添加 tool 消息
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult,
      })

      sendEvent('agentStep', {
        step: totalToolCalls,
        round: aiRequestCount,
        toolName: funcName,
        status: 'done',
        result: toolResult.length > 500 ? toolResult.slice(0, 500) + '...' : toolResult,
      })

      // 发送工具结果到全景对话
      try {
        sendEvent('conversationToolResult', {
          round: aiRequestCount,
          toolResult: {
            toolName: funcName, args: funcArgs,
            result: toolResult.slice(0, 500),
            ok: !toolResult.includes('"ok":false'),
          },
        })
      } catch {}
    }

    // 上下文压缩（避免 token 超限）
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0)
    if (totalChars > 50000) {
      // 保留最近 30 条，但起点必须回溯到最近一个带 tool_calls 的 assistant 消息，
      // 否则开头的 tool 消息会因找不到父级 tool_calls 触发 400 错误
      const TAIL = 30
      let cutIdx = Math.max(2, messages.length - TAIL)
      // 先跳过孤立 tool 消息，再回溯到带 tool_calls 的 assistant
      while (cutIdx < messages.length && messages[cutIdx].role === 'tool') cutIdx++
      while (cutIdx < messages.length) {
        const m = messages[cutIdx]
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) break
        cutIdx++
      }
      console.log(`[Reverse] 上下文压缩: ${totalChars} 字符，从 ${messages.length} 条压缩到 ${messages.length - cutIdx + 2} 条`)
      const keep = messages.slice(0, 2).concat(messages.slice(cutIdx))
      messages.length = 0
      messages.push(...keep)

      // 兜底：移除孤立的 tool 消息（tool_call_id 找不到对应 assistant.tool_calls.id）
      const validToolCallIds = new Set()
      for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) validToolCallIds.add(tc.id)
        }
      }
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'tool' && !validToolCallIds.has(messages[i].tool_call_id)) {
          console.warn('[Reverse] 移除孤立 tool 消息:', messages[i].tool_call_id)
          messages.splice(i, 1)
        }
      }
    }
  }

  // 达到最大轮次
  if (aiRequestCount >= maxRounds) {
    const finalNote = `⚠️ 逆向分析已达到最大轮次(${maxRounds})。\n已执行：${aiRequestCount} 轮分析，${totalToolCalls} 次工具调用。\n建议：1) 缩小分析范围 2) 手动查看捕获的请求 3) 分步骤分析 4) 在逆向窗口顶部调大「最大轮次」设置`
    sendEvent('agentStatus', { text: '达到最大轮次，生成总结...' })
    await streamToUI(sendEvent, finalNote)
  }

  sendEvent('agentDone', { totalRounds: aiRequestCount, totalToolCalls, durationMs: Date.now() - startTime })
  return { totalRounds: aiRequestCount, totalToolCalls }
}

module.exports = { runReverseAnalysis, REVERSE_SYSTEM_PROMPT }
