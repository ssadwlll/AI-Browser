// ============ AgentService ============
export class AgentService {
  constructor(configService, toolService, pageService) {
    this.configService = configService
    this.toolService = toolService
    this.pageService = pageService
    this.MAX_AI_REQUESTS = 15    // AI API 请求次数上限（每次请求可执行多个工具）
    this.MAX_TOOL_CALLS = 30     // 工具调用总次数上限（防止本地工具无限调用）
    this.TIMEOUT_MS = 120000
    // Plan B: Agent 生命周期与 Port 解耦
    // tabId → { port, messages:[], running:bool }
    this.agentStates = new Map()
  }

  buildToolDefinitions(userQuery, searchResults) {
    const tools = []

    // 核心工具：始终提供
    tools.push({
      type: 'function',
      function: {
        name: 'search_tools',
        description: '搜索工具脚本库，传简短中文关键词(2-4字)',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '核心关键词，如"新闻"、"采集"' },
          },
          required: ['query'],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'read_page_content',
        description: '读取当前页面标题、URL和正文',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    })

    // P2: Network Capture
    tools.push({
      type: 'function',
      function: {
        name: 'capture_network',
        description: '获取页面XHR/Fetch请求响应列表，用于发现API数据源',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '按URL过滤（可选）' },
            status: { type: 'string', enum: ['ok', 'error'], description: '按状态过滤' },
            limit: { type: 'number', description: '返回条数，默认10' },
          },
          required: [],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'extract_content',
        description: '提取页面元素文本',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS选择器' },
            multiple: { type: 'boolean', description: '提取所有匹配元素' },
            limit: { type: 'number', description: '最多条数，默认10' },
          },
          required: ['selector'],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'click_element',
        description: '点击页面元素',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS选择器' },
            index: { type: 'number', description: '第几个(从0起)' },
          },
          required: ['selector'],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'fill_input',
        description: '填写输入框',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS选择器' },
            value: { type: 'string', description: '填入内容' },
            submit: { type: 'boolean', description: '填入后回车提交' },
          },
          required: ['selector', 'value'],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'wait_for_element',
        description: '等待页面元素出现，导航/提交后必须调用',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS选择器' },
            timeout: { type: 'number', description: '等待毫秒，默认5000' },
          },
          required: ['selector'],
        },
      },
    })

    // 搜索结果中的工具脚本（最多6个，累积不覆盖）
    for (const s of (searchResults || []).slice(0, 6)) {
      const tc = s.toolConfig || {}
      const meta = s.metadata || {}
      // 拼接增强描述：基础描述 + 触发词 + 分页约束 + 平台限制
      let desc = (tc.toolDescription || s.description || `执行: ${s.name}`).slice(0, 80)
      // P0: 注入 metadata 信息
      if (meta.triggers && meta.triggers.length > 0) desc += ` [触发:${meta.triggers.slice(0,3).join(',')}]`
      if (meta.requires_login) desc += ' [需登录]'
      // P4: 分页约束
      if (meta.pagination && meta.pagination.strategy !== 'none') {
        desc += ` [分页:${meta.pagination.strategy},≤${meta.pagination.maxPages||20}次]`
      }
      // P1: precheck 标记
      const hasPrecheck = !!(s.precheck && s.precheck.trim())
      if (hasPrecheck) desc += ' [有前置检查]'
      // P3: 经验记忆提示
      if (s.memorySuccess !== undefined) {
        desc += ` [记忆:${s.memorySuccess}/${s.memoryTotal}次成功]`
      }

      tools.push({
        type: 'function',
        function: {
          name: `inject_script_${s.id}`,
          description: desc,
          parameters: tc.parameters || { type: 'object', properties: {}, required: [] },
        },
      })
    }

    tools.push({
      type: 'function',
      function: {
        name: 'finish_task',
        description: '任务完成，汇报结果',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '完成摘要' },
          },
          required: ['summary'],
        },
      },
    })

    return tools
  }

  async executeDOMTool(tabId, toolName, args) {
    const funcs = {
      extract_content: (selector, multiple, limit) => {
        const els = document.querySelectorAll(selector)
        const results = []
        const max = Math.min(els.length, limit || 10)
        for (let i = 0; i < max; i++) {
          results.push(els[i].textContent.trim().slice(0, 500))
        }
        const content = multiple !== false ? results : (results[0] || '')

        // 检测页面阻塞元素（登录弹窗、遮罩层等）
        const blockerSelectors = [
          '[class*="login"]', '[class*="Login"]',
          '[class*="modal"]', '[class*="dialog"]', '[class*="overlay"]',
          '[class*="mask"]', '[class*="popup"]',
          '[id*="login"]', '[id*="modal"]', '[id*="dialog"]',
        ]
        const foundBlockers = []
        for (const bs of blockerSelectors) {
          try {
            const bEls = document.querySelectorAll(bs)
            for (const el of bEls) {
              const style = getComputedStyle(el)
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue
              const rect = el.getBoundingClientRect()
              if (rect.width === 0 || rect.height === 0) continue
              foundBlockers.push({ selector: bs, text: el.textContent.trim().slice(0, 60) })
              if (foundBlockers.length >= 3) break
            }
          } catch {}
          if (foundBlockers.length >= 3) break
        }

        if (foundBlockers.length > 0) {
          return {
            content,
            blocker: '页面检测到弹窗/遮罩层，可能阻碍操作: ' + JSON.stringify(foundBlockers),
            hint: '如果弹窗是你的操作目标，继续操作；如果是登录/验证弹窗阻碍了你，尝试 press_key(Escape) 或 click_element 关闭按钮。若多次尝试无效，用 finish_task 报告用户：页面需要登录才能操作',
          }
        }
        return content
      },

      click_element: (selector, index) => {
        const els = document.querySelectorAll(selector)
        const el = els[index || 0]
        if (!el) return '元素未找到: ' + selector
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.click()
        return '已点击: ' + (el.textContent.trim().slice(0, 50) || el.tagName)
      },

      fill_input: (selector, value, submit) => {
        const els = document.querySelectorAll(selector)
        const el = els[0]
        if (!el) return '输入框未找到: ' + selector
        el.focus()
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        nativeInputValueSetter.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        if (submit) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }))
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }))
          const form = el.closest('form')
          if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        }
        return '已填入: ' + value.slice(0, 50) + (submit ? '（已提交）' : '')
      },

      wait_for_element: (selector, timeout) => {
        return new Promise((resolve) => {
          const start = Date.now()
          const max = timeout || 5000
          function check() {
            const els = document.querySelectorAll(selector)
            if (els.length > 0) {
              resolve({ found: true, count: els.length, elapsed: Date.now() - start, selector })
              return
            }
            if (Date.now() - start > max) {
              resolve({ found: false, count: 0, elapsed: Date.now() - start, selector, hint: `等待${max}ms后未找到元素"${selector}"，请检查选择器是否正确，或页面可能加载失败` })
              return
            }
            setTimeout(check, 200)
          }
          check()
        })
      },
    }

    const func = funcs[toolName]
    if (!func) return { ok: false, error: `未知DOM工具: ${toolName}` }

    const argMap = {
      extract_content: [args.selector, args.multiple, args.limit],
      click_element: [args.selector, args.index],
      fill_input: [args.selector, args.value, args.submit],
      wait_for_element: [args.selector, args.timeout],
    }

    try {
      console.log('[Agent] executeDOMTool:', toolName, 'args:', JSON.stringify(args).slice(0, 80))
      const serializedArgs = (argMap[toolName] || []).map(v => v === undefined ? null : v)
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args: serializedArgs,
      })
      console.log('[Agent] executeDOMTool result:', JSON.stringify(result?.result).slice(0, 200))
      return { ok: true, result: result?.result }
    } catch (e) {
      console.error('[Agent] executeDOMTool error:', toolName, e.message)
      return { ok: false, error: e.message }
    }
  }

  // P3: 记录脚本执行经验记忆（异步，不阻塞主流程）
  async _recordMemory(scriptId, success, durationMs, errorMessage, resultSummary) {
    const config = await this.configService.getSyncConfig()
    if (!config?.serverUrl) return
    try {
      const auth = await this.configService.getAppAuth()
      const authHeaders = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)
      await fetch(`${config.serverUrl}/api/scripts/${scriptId}/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          scriptId,
          sessionId: null,
          ok: success,
          durationMs,
          errorMessage: (errorMessage || '').slice(0, 500),
          resultSummary: (resultSummary || '').slice(0, 200),
        }),
      })
    } catch (e) {
      // memory 记录失败不影响主流程
    }
  }

  // Plan B: 入口方法，管理 Port 绑定 =====
  async startAgent(port, userMessage, chatHistory) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const tabId = tab?.id
    if (!tabId) {
      try { port.postMessage({ type: 'agentError', error: '无法获取标签页' }) } catch {}
      return
    }

    // 如果该 tab 已有 Agent 运行中，attach 新 port（重连场景）
    // 如果已完成但状态未清理（30s 内），清理后继续走新 Agent 流程
    const existingState = this.agentStates.get(tabId)
    if (existingState?.running) {
      this.attachPort(tabId, port)
      return
    }
    if (existingState) {
      this.agentStates.delete(tabId)
    }

    const state = { port, messages: [], running: true }
    this.agentStates.set(tabId, state)

    try {
      await this.run(tabId, userMessage, chatHistory)
    } finally {
      // 保留状态 30 秒，供重连时回放消息
      const state = this.agentStates.get(tabId)
      if (state) state.running = false
      setTimeout(() => {
        this.agentStates.delete(tabId)
      }, 30000)
    }
  }

  attachPort(tabId, port) {
    const state = this.agentStates.get(tabId)
    if (!state) return
    state.port = port
    // 重放排队消息
    if (state.messages.length > 0) {
      console.log('[Agent] Port 重连，回放', state.messages.length, '条消息')
      for (const msg of state.messages) {
        try { port.postMessage(msg) } catch { break }
      }
      state.messages = []
    }
  }

  detachPortByPort(port) {
    for (const [tabId, state] of this.agentStates) {
      if (state.port === port) {
        console.log('[Agent] Port 断开，Agent 继续运行 (tabId:', tabId, ')')
        state.port = null
        return
      }
    }
  }

  postToUI(tabId, msg) {
    const state = this.agentStates.get(tabId)
    if (!state) return
    if (state.port) {
      try {
        state.port.postMessage(msg)
      } catch {
        state.port = null
        state.messages.push(msg)
      }
    } else {
      state.messages.push(msg)
    }
  }

  // 统一入口：Agent 完成时写入 chatHistory，是唯一写入方
  async _saveToChatHistoryStorage(tabId, content, toolCalls) {
    try {
      const historyData = await chrome.storage.local.get('chatHistory')
      const history = (historyData.chatHistory || []).slice()
      // 去重：如果最后一条 assistant 消息内容相同，跳过
      const lastMsg = history[history.length - 1]
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content === content) {
        console.log('[Agent] chatHistory 已存在相同内容，跳过写入')
        return
      }
      const record = { role: 'assistant', content }
      if (toolCalls && toolCalls.length > 0) {
        record.toolCalls = toolCalls.map(t => ({ name: t.name, summary: String(t.result || '').slice(0, 200) }))
      }
      history.push(record)
      const MAX_CHARS = 8000, MAX_ITEMS = 50
      let trimmed = history.slice(-MAX_ITEMS)
      let totalChars = 0
      const keep = []
      for (let i = trimmed.length - 1; i >= 0; i--) {
        const m = trimmed[i]
        const charLen = (m.content || '').length + (m.role || '').length
        totalChars += charLen
        if (m.attachments && (m.attachments.image || m.attachments.pdf)) { keep.unshift(m); continue }
        if (totalChars > MAX_CHARS && keep.length >= 2) break
        keep.unshift(m)
      }
      await chrome.storage.local.set({ chatHistory: keep })
      console.log('[Agent] chatHistory 已写入 storage, 长度:', content.length)
    } catch (e) {
      console.error('[Agent] chatHistory 写入失败:', e)
    }
  }

  async run(tabId, userMessage, chatHistory) {
    const startTime = Date.now()
    let aiRequestCount = 0      // AI API 请求次数（每次 while 循环 +1）
    let totalToolCalls = 0      // 工具调用总次数（含本地工具，防止无限调用）
    let searchResults = []
    const executedTools = []
    let resultsText = ''          // finish_task 时工具结果文本（提升作用域供 storage 保存使用）
    let consecutiveFailCount = 0  // 连续无进展计数（工具失败或结果无变化时+1，有进展时重置为0）
    const MAX_CONSECUTIVE_FAILS = 5 // 连续无进展上限

    // 清理 chatHistory 中的自定义字段，避免 API 拒绝
    const cleanHistory = (chatHistory || []).map(m => {
      const { toolCalls, tool_calls, ...clean } = m
      return clean
    })

    const systemMsg = {
      role: 'system',
      content: `你是AI Browser智能助手，可调用工具完成网页操作任务。

可用工具：
- search_tools: 搜索工具脚本库
- read_page_content: 读取当前页面内容
- extract_content: 按CSS选择器提取元素文本
- click_element: 点击页面元素
- fill_input: 填写输入框(可回车提交)
- wait_for_element: 等待元素出现(导航/提交后必须调用)
- inject_script_*: 执行工具库中已审核的脚本(需先search_tools搜索)
- finish_task: 汇报结果并结束

限制：
- 不能即时编写JS代码注入页面，只能通过search_tools搜索并执行工具库中已有的脚本
- 如果用户需求需要自定义代码，用finish_task告知用户"该功能需要开发对应脚本后上传到工具库"

P4 分页规范：
- 注入脚本会自动执行，你只需调用一次inject_script即可
- 如果工具描述含 [分页:scroll,≤N次]，工具会自动滚动翻页，无需重复调用
- 如果工具描述含 [分页:url-page,≤N次]，工具会自动URL分页
- 不要自己循环调用inject_script来翻页，工具内有内置分页逻辑

P1 输出规范：
- 用自然语言整理工具返回的结果，禁止输出原始JSON
- 如果结果数据较多，列出要点即可
- 如果工具返回错误，分析原因并用finish_task告知用户

工作流程：
1. 先用search_tools搜相关工具，搜不到则用DOM工具直接操作
2. 导航/提交后必须wait_for_element等页面加载
3. 最多3-4个工具就finish_task，不要反复调用
4. 每次只调用一个函数`,
    }

    const messages = [systemMsg, ...cleanHistory, { role: 'user', content: userMessage }]

    this.postToUI(tabId, { type: 'agentStart' })

    while (aiRequestCount < this.MAX_AI_REQUESTS) {
      if (Date.now() - startTime > this.TIMEOUT_MS) {
        this.postToUI(tabId, { type: 'agentError', error: 'Agent执行超时' })
        return
      }
      if (totalToolCalls >= this.MAX_TOOL_CALLS) {
        this.postToUI(tabId, { type: 'agentError', error: '工具调用次数超限，请简化任务重试' })
        return
      }

      aiRequestCount++

      const tools = this.buildToolDefinitions(userMessage, searchResults)

      const config = await this.configService.getAIConfig()
      const auth = await this.configService.getAppAuth()
      const body = {
        model: config.model,
        messages,
        temperature: 0.3,
        max_tokens: Math.max(config.maxTokens || 4096, 8192),  // Agent模式至少8192，避免tool_calls被截断
        tools,
        tool_choice: 'auto',
      }

      const url = await this.configService.getAIProxyUrl()

      try {
        const headers = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)

        // API 请求重试机制：429限流、5xx临时错误重试，4xx错误不重试
        const MAX_API_RETRIES = 2
        const API_TIMEOUT_MS = 60000  // 单次API请求超时60秒
        let res, lastError
        for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
          try {
            // 带超时的 fetch
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
            res = await fetch(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal: controller.signal,
            })
            clearTimeout(timeoutId)
            if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
              break  // 成功 或 4xx非限流错误（如401鉴权失败、400参数错误）不重试
            }
            // 429 或 5xx → 等待后重试
            if (attempt < MAX_API_RETRIES) {
              const waitMs = (attempt + 1) * 1000  // 1s, 2s
              console.warn(`[Agent] API返回 ${res.status}，${waitMs}ms后重试 (${attempt + 1}/${MAX_API_RETRIES})`)
              this.postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: '等待重试', status: 'waiting' })
              await new Promise(r => setTimeout(r, waitMs))
            }
          } catch (e) {
            lastError = e
            const isTimeout = e.name === 'AbortError'
            if (isTimeout) {
              console.warn(`[Agent] API请求超时(${API_TIMEOUT_MS}ms)，尝试 ${attempt + 1}/${MAX_API_RETRIES + 1}`)
              if (attempt < MAX_API_RETRIES) {
                this.postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: '请求超时，重试中', status: 'waiting' })
              }
            } else {
              console.warn(`[Agent] API请求异常: ${e.message}，${waitMs}ms后重试 (${attempt + 1}/${MAX_API_RETRIES})`)
            }
            if (attempt < MAX_API_RETRIES) {
              const waitMs = (attempt + 1) * 1000
              await new Promise(r => setTimeout(r, waitMs))
            }
          }
        }

        if (!res || !res.ok) {
          // 400错误可能是tools参数不支持，尝试不带tools重试一次
          if (res?.status === 400 && body.tools) {
            console.warn('[Agent] API返回400，尝试不带tools参数重试')
            const fallbackBody = { ...body }
            delete fallbackBody.tools
            delete fallbackBody.tool_choice
            try {
              const controller2 = new AbortController()
              const timeoutId2 = setTimeout(() => controller2.abort(), API_TIMEOUT_MS)
              const fallbackRes = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(fallbackBody),
                signal: controller2.signal,
              })
              clearTimeout(timeoutId2)
              if (fallbackRes.ok) {
                res = fallbackRes
              } else {
                const errStatus = res?.status || '网络错误'
                this.postToUI(tabId, { type: 'agentError', error: `AI API错误: ${errStatus}（该模型可能不支持Function Calling）` })
                return
              }
            } catch (e2) {
              this.postToUI(tabId, { type: 'agentError', error: `AI API错误: ${e2.message}` })
              return
            }
          } else {
            const errStatus = res?.status || '网络错误'
            this.postToUI(tabId, { type: 'agentError', error: `AI API错误: ${errStatus}${lastError ? ' (' + lastError.message + ')' : ''}` })
            return
          }
        }

        const data = await res.json()
        const choice = data.choices?.[0]
        const msg = choice?.message

        if (!msg) {
          this.postToUI(tabId, { type: 'agentError', error: 'AI返回为空' })
          return
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          console.log('[Agent] tool_calls:', msg.tool_calls.map(t => t.function.name).join(', '))

          // 推送 assistant 消息（包含所有 tool_calls）
          messages.push({ role: 'assistant', content: null, tool_calls: msg.tool_calls })

          // 逐个执行 tool calls（串行执行，因为很多操作依赖同一标签页状态）
          for (const toolCall of msg.tool_calls) {
            if (totalToolCalls >= this.MAX_TOOL_CALLS) break

            const funcName = toolCall.function.name
            let funcArgs = {}
            try { funcArgs = JSON.parse(toolCall.function.arguments || '{}') } catch {}

            totalToolCalls++

            // 无进展检测：在工具执行后判断是否有进展（见下方 result 判断）

            this.postToUI(tabId, {
              type: 'agentStep',
              step: totalToolCalls,
              toolName: funcName,
              toolArgs: funcArgs,
            })

            let toolResult
            if (funcName === 'finish_task') {
              console.log('[Agent] finish_task, summary:', funcArgs.summary)
              const summary = funcArgs.summary || '任务已完成'
              this.postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, result: summary, done: true })
              for (const char of summary) {
                this.postToUI(tabId, { type: 'streamChunk', content: char })
                await new Promise(r => setTimeout(r, 15))
              }
              if (executedTools.length > 0) {
                resultsText = '\n\n---\n### 工具执行结果\n' + executedTools.map((t, i) => {
                  let display = ''
                  try {
                    const parsed = typeof t.result === 'string' ? JSON.parse(t.result) : t.result
                    if (parsed?.ok && parsed?.result) {
                      display = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result, null, 2)
                    } else if (parsed?.error) {
                      display = '错误: ' + parsed.error
                    } else {
                      display = JSON.stringify(parsed, null, 2)
                    }
                  } catch {
                    display = String(t.result || '')
                  }
                  return (i + 1) + '. **' + t.name + '**\n' + display
                }).join('\n\n')
                for (const char of resultsText) {
                  this.postToUI(tabId, { type: 'streamChunk', content: char })
                  await new Promise(r => setTimeout(r, 5))
                }
              }
              this.postToUI(tabId, { type: 'streamDone' })
              const fullContent = summary + (executedTools.length > 0 ? resultsText : '')
              const toolResults = executedTools.map(t => ({
                name: t.name,
                result: typeof t.result === 'string' ? t.result : JSON.stringify(t.result || '')
              }))
              await this._saveToChatHistoryStorage(tabId, fullContent, toolResults)
              return
            } else if (funcName === 'capture_network') {
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
              const filter = { url: funcArgs.url, status: funcArgs.status, limit: funcArgs.limit || 10 }
              try {
                const [captureResult] = await chrome.scripting.executeScript({
                  target: { tabId: tab?.id },
                  func: (filter) => {
                    if (!window.__aiBrowserGetCaptured) return { ok: false, error: '网络捕获未就绪，请刷新页面' }
                    return { ok: true, result: window.__aiBrowserGetCaptured(filter) }
                  },
                  args: [filter],
                })
                toolResult = JSON.stringify(captureResult?.result || { ok: false, error: '无数据' })
              } catch (e) {
                toolResult = JSON.stringify({ ok: false, error: e.message })
              }
            } else if (funcName === 'search_tools') {
              const query = funcArgs.query || userMessage
              this.postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: 'search_tools', toolArgs: { query }, status: 'searching' })
              const newResults = await this.toolService.searchScripts(query)
              // 累积搜索结果（按ID去重），不覆盖之前的，保证工具定义一致
              const existingIds = new Set(searchResults.map(s => s.id))
              for (const r of newResults) {
                if (!existingIds.has(r.id)) {
                  searchResults.push(r)
                  existingIds.add(r.id)
                }
              }
              if (newResults.length === 0) {
                toolResult = JSON.stringify({
                  ok: true,
                  result: `未找到与"${query}"匹配的专用工具。请改用 DOM工具（extract_content/fill_input/click_element）直接在页面上操作完成需求。不要再调用 search_tools。`,
                })
              } else {
                toolResult = JSON.stringify(newResults.slice(0, 5).map(t => ({
                  id: t.id, name: t.name, description: t.description,
                  toolType: t.toolType, toolConfig: t.toolConfig ? '已配置' : '未配置',
                })))
              }
              executedTools.push({ name: 'search_tools', result: { ok: newResults.length > 0, count: newResults.length } })
              this.postToUI(tabId, { type: 'agentSearchResult', results: newResults.slice(0, 5) })
            } else if (funcName === 'read_page_content') {
              const pageData = await this.pageService.getContent()
              toolResult = JSON.stringify({
                ok: true,
                title: pageData?.title || '',
                url: pageData?.url || '',
                content: (pageData?.content || '').slice(0, 3000),
              })
            } else if (funcName.startsWith('inject_script_')) {
              const scriptId = parseInt(funcName.replace('inject_script_', ''))
              if (!scriptId || isNaN(scriptId)) {
                toolResult = JSON.stringify({ ok: false, error: '无效的脚本ID' })
              } else {
                const tool = searchResults.find(t => t.id === scriptId) || { id: scriptId, name: '脚本#' + scriptId, toolType: 'js', toolConfig: {}, metadata: {}, precheck: '' }
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })

                // P1: 执行前检查
                if (tool.precheck && tool.precheck.trim()) {
                  this.postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: { check: 'precheck' }, status: 'running' })
                  try {
                    const [precheckResult] = await chrome.scripting.executeScript({
                      target: { tabId: tab?.id },
                      func: (code) => {
                        try {
                          const fn = new Function(code)
                          const r = fn()
                          return { ok: true, result: r }
                        } catch (e) { return { ok: false, error: e.message } }
                      },
                      args: [tool.precheck],
                    })
                    const pr = precheckResult?.result
                    if (pr && !pr.ok && pr.result?.ok === false) {
                      toolResult = JSON.stringify({ ok: false, error: `前置检查失败: ${pr.result.reason || pr.result.error || '未知原因'}` })
                      executedTools.push({ name: `${funcName}(precheck失败)`, result: toolResult })
                      // 记录失败记忆
                      this._recordMemory(scriptId, false, 0, toolResult, '').catch(() => {})
                      this.postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
                      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
                      continue
                    }
                  } catch (e) {
                    // precheck 执行异常，继续执行脚本（precheck 不阻塞）
                    console.warn('[Agent] precheck 执行异常，继续执行:', e.message)
                  }
                }

                this.postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: { scriptId, scriptName: tool.name }, status: 'running' })
                const execStart = Date.now()
                const execResult = await this.toolService.executeTool(tool, tab?.id)
                const execDuration = Date.now() - execStart
                toolResult = JSON.stringify(execResult)
                executedTools.push({ name: tool.name || funcName, result: execResult })
                // P3: 记录经验记忆
                const memOk = execResult?.ok === true
                const memSummary = typeof execResult?.result === 'string' ? execResult.result.slice(0, 200) : JSON.stringify(execResult).slice(0, 200)
                this._recordMemory(scriptId, memOk, execDuration, memOk ? '' : (execResult?.error || ''), memSummary).catch(() => {})
              }
            } else if (funcName === 'extract_content' || funcName === 'click_element' || funcName === 'fill_input' || funcName === 'wait_for_element') {
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
              if (!tab?.id) {
                toolResult = JSON.stringify({ ok: false, error: '无法获取目标标签页' })
              } else {
                this.postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: funcArgs, status: 'running' })
                const domResult = await this.executeDOMTool(tab.id, funcName, funcArgs)
                toolResult = JSON.stringify(domResult)
                executedTools.push({ name: funcName, result: domResult })
              }
            } else {
              toolResult = JSON.stringify({ ok: false, error: `未知工具: ${funcName}` })
            }

            // ===== 统一无进展检测 =====
            // 判断工具执行是否有进展：基于结构化字段，不依赖字符串匹配
            let hasProgress = false
            try {
              const parsed = JSON.parse(toolResult)
              // 明确失败 → 无进展
              if (parsed?.ok === false) {
                hasProgress = false
              }
              // search_tools 不重置计数（搜到工具不等于任务有进展，可能执行后仍失败）
              else if (funcName === 'search_tools') {
                hasProgress = false
              }
              // ok=true 或 无ok字段但有有效内容 → 有进展
              else if (parsed?.ok === true || parsed?.ok === undefined) {
                const hasContent = parsed?.result !== undefined && String(parsed.result).length > 0
                  || parsed?.content !== undefined && String(parsed.content).length > 0
                  || parsed?.title !== undefined
                hasProgress = hasContent && !parsed?.error
              }
            } catch {
              // JSON 解析失败 → 无进展
            }

            if (hasProgress) {
              if (consecutiveFailCount > 0) {
                console.log('[Agent] 恢复进展，重置无进展计数 (was:', consecutiveFailCount, ')')
              }
              consecutiveFailCount = 0
            } else {
              consecutiveFailCount++
              console.warn('[Agent] 无进展 #' + consecutiveFailCount, funcName, toolResult?.slice(0, 100))
            }

            if (consecutiveFailCount >= MAX_CONSECUTIVE_FAILS) {
              console.warn('[Agent] 连续', consecutiveFailCount, '次无进展，强制结束')
              const stopMsg = `任务无法继续：已连续${consecutiveFailCount}次操作无进展（工具失败或结果未变化），可能页面被阻塞或任务超出能力范围。请调整后重试。`
              for (const char of stopMsg) {
                this.postToUI(tabId, { type: 'streamChunk', content: char })
                await new Promise(r => setTimeout(r, 10))
              }
              this.postToUI(tabId, { type: 'streamDone' })
              await this._saveToChatHistoryStorage(tabId, stopMsg)
              return
            }

            this.postToUI(tabId, {
              type: 'agentStepResult',
              step: totalToolCalls,
              toolName: funcName,
              result: toolResult,
              done: false,
            })

            // 截断过长的工具结果
            const MAX_TOOL_RESULT_LEN = 2000
            let truncatedResult = toolResult
            if (toolResult && toolResult.length > MAX_TOOL_RESULT_LEN) {
              truncatedResult = toolResult.slice(0, MAX_TOOL_RESULT_LEN) + `\n...(结果过长已截断，共${toolResult.length}字符)`
            }
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: truncatedResult,
            })

            await new Promise(r => setTimeout(r, 200))
          }

          // 防止 messages 上下文无限膨胀：按完整分组裁剪，确保 assistant+tool 配对完整
          const MAX_MESSAGES = 30
          if (messages.length > MAX_MESSAGES) {
            // 按分组边界裁剪：找到第一个可以安全删除的边界
            // 分组规则：system | (user | (assistant [tool_calls] | tool*) | assistant text)*
            let removeCount = messages.length - MAX_MESSAGES
            let idx = 1 // 从索引1开始（跳过system）
            while (removeCount > 0 && idx < messages.length) {
              if (messages[idx].role === 'assistant' && messages[idx].tool_calls?.length > 0) {
                // assistant + 紧随的 tool 消息作为一组删除
                const toolCount = messages[idx].tool_calls.length
                const delEnd = Math.min(idx + 1 + toolCount, messages.length)
                const groupSize = delEnd - idx
                messages.splice(idx, groupSize)
                removeCount -= groupSize
              } else {
                // 单条消息（user / assistant文本 / 单独tool）
                messages.splice(idx, 1)
                removeCount--
              }
              // 删除后 idx 不变，因为后面的元素前移了
            }
          }
        } else {
          console.log('[Agent] 纯文本回复（无tool_calls）:', (msg.content || '').slice(0, 80))
          const content = msg.content || ''
          const textContent = content || 'AI未返回有效响应，请重试。'
          if (content) {
            for (const char of content) {
              try { this.postToUI(tabId, { type: 'streamChunk', content: char }) } catch {}
              await new Promise(r => setTimeout(r, 15))
            }
          } else {
            console.warn('[Agent] AI返回空内容且无工具调用，强制结束')
            this.postToUI(tabId, { type: 'streamChunk', content: textContent })
          }
          this.postToUI(tabId, { type: 'streamDone' })
          await this._saveToChatHistoryStorage(tabId, textContent)
          return
        }
      } catch (e) {
        console.error('[AgentService] iteration error:', e)
        this.postToUI(tabId, { type: 'agentError', error: e.message })
        return
      }
    }

    this.postToUI(tabId, { type: 'agentError', error: 'Agent达到最大请求次数，请简化任务重试' })
  }
}
