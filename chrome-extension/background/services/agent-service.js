// ============ AgentService ============
export class AgentService {
  constructor(configService, toolService) {
    this.configService = configService
    this.toolService = toolService
    this.MAX_ITERATIONS = 12
    this.TIMEOUT_MS = 120000
  }

  buildToolDefinitions(userQuery, searchResults) {
    const tools = []

    tools.push({
      type: 'function',
      function: {
        name: 'search_tools',
        description: '搜索AI Browser工具脚本库。传入简短的中文关键词(2-4字)，系统会智能分词匹配。例如搜[新闻]可找到热点新闻工具，搜[小红书]可找到小红书采集工具。不要传长句子，用核心名词搜索。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '简短的中文核心关键词(2-8字)，如[新闻]、[热点]、[小红书]、[翻译]、[数据采集]。多个关键词用空格分隔，如: 新闻 热点。' },
          },
          required: ['query'],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'read_page_content',
        description: '读取当前页面的标题、URL和正文内容。用于获取页面信息以辅助任务完成。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    })

    // DOM 操作工具
    tools.push({
      type: 'function',
      function: {
        name: 'navigate_to_url',
        description: '导航当前标签页到指定URL。用于打开搜索页面、切换网站等。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '要导航到的完整URL，如 https://www.xiaohongshu.com/search_result?keyword=温州一日游&type=51' },
          },
          required: ['url'],
        },
      },
    })
    tools.push({
      type: 'function',
      function: {
        name: 'extract_content',
        description: '从当前页面提取指定CSS选择器对应元素的文本内容。例如提取文章标题、列表、价格等。',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS选择器，如 h1, .article-title, #content p, [data-id="name"]' },
            multiple: { type: 'boolean', description: '是否提取所有匹配元素（true=返回数组，false=只取第一个）' },
            limit: { type: 'number', description: '最多提取条数，默认10' },
          },
          required: ['selector'],
        },
      },
    })
    tools.push({
      type: 'function',
      function: {
        name: 'click_element',
        description: '点击页面上匹配CSS选择器的元素。如按钮、链接等。',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS选择器定位要点击的元素' },
            index: { type: 'number', description: '如果有多个匹配元素，点击第几个（从0开始，默认0）' },
          },
          required: ['selector'],
        },
      },
    })
    tools.push({
      type: 'function',
      function: {
        name: 'fill_input',
        description: '向页面输入框填入文字内容。',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS选择器定位输入框，如 input[name="q"], #search-input, textarea' },
            value: { type: 'string', description: '要填入的文字内容' },
            submit: { type: 'boolean', description: '填入后是否触发回车键提交（默认false）' },
          },
          required: ['selector', 'value'],
        },
      },
    })
    tools.push({
      type: 'function',
      function: {
        name: 'scroll_page',
        description: '滚动当前页面。',
        parameters: {
          type: 'object',
          properties: {
            direction: { type: 'string', description: '滚动方向：down（向下）, up（向上）, top（回到顶部）, bottom（滚动到底部）' },
            amount: { type: 'number', description: '滚动像素数（仅down/up有效，默认300）' },
          },
          required: ['direction'],
        },
      },
    })
    tools.push({
      type: 'function',
      function: {
        name: 'get_element_info',
        description: '获取页面元素的详细信息，包括文本、属性、位置、是否可见等。用于分析页面结构。',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS选择器' },
            includeAttributes: { type: 'boolean', description: '是否包含元素属性（href, src, class 等）' },
            limit: { type: 'number', description: '最多返回几个元素信息，默认5' },
          },
          required: ['selector'],
        },
      },
    })
    tools.push({
      type: 'function',
      function: {
        name: 'wait_for_element',
        description: '等待页面上指定CSS选择器的元素出现（页面加载完成）。navigate_to_url或click_element/fill_input(submit)之后必须调用此工具确认页面已加载，再继续后续操作。',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: '等待出现的CSS选择器，如搜索结果列表 .search-result, 文章容器 .article-content, 任意特征元素。选一个页面加载后必然会出现的元素。' },
            timeout: { type: 'number', description: '最长等待毫秒数，默认5000。简单页面用3000，复杂SPA页面用8000。' },
          },
          required: ['selector'],
        },
      },
    })

    // 注入现有搜索结果中的工具
    for (const s of (searchResults || []).slice(0, 3)) {
      const tc = s.toolConfig || {}
      tools.push({
        type: 'function',
        function: {
          name: `inject_script_${s.id}`,
          description: tc.toolDescription || s.description || `执行工具: ${s.name}`,
          parameters: tc.parameters || { type: 'object', properties: {}, required: [] },
        },
      })
    }

    // 更多浏览器操作工具
    tools.push({
      type: 'function',
      function: {
        name: 'press_key',
        description: '向页面发送键盘按键事件。用于关闭弹窗(Escape)、翻页(ArrowDown/ArrowUp)、提交回车、Tab切换焦点等。',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '按键名称，如 Escape, Enter, ArrowDown, ArrowUp, Tab, PageDown, PageUp, Space, Backspace' },
            target: { type: 'string', description: '可选CSS选择器，指定要发送按键的目标元素（默认发到document）' },
          },
          required: ['key'],
        },
      },
    })
    tools.push({
      type: 'function',
      function: {
        name: 'go_back',
        description: '浏览器后退到上一页。导航到错误页面时使用此工具返回。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    })
    tools.push({
      type: 'function',
      function: {
        name: 'take_screenshot',
        description: '截取当前页面的可视区域截图。返回图片数据，可用于视觉分析或向用户展示页面状态。',
        parameters: {
          type: 'object',
          properties: {
            quality: { type: 'number', description: '截图质量 0-100，默认80。数值越高图片越清晰但数据越大' },
          },
          required: [],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'finish_task',
        description: '任务完成，向用户汇报最终结果。所有必要的操作都已完成时调用此函数。',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '任务完成摘要，用中文向用户汇报做了什么、结果如何' },
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
        return multiple !== false ? results : (results[0] || '')
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

      scroll_page: (direction, amount) => {
        const amt = amount || 300
        if (direction === 'top') { window.scrollTo({ top: 0, behavior: 'smooth' }); return '已滚动到顶部' }
        if (direction === 'bottom') { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); return '已滚动到底部' }
        if (direction === 'up') { window.scrollBy({ top: -amt, behavior: 'smooth' }); return '向上滚动' + amt + 'px' }
        window.scrollBy({ top: amt, behavior: 'smooth' })
        return '向下滚动' + amt + 'px，当前位置: ' + (window.scrollY || window.pageYOffset)
      },

      get_element_info: (selector, includeAttributes, limit) => {
        const els = document.querySelectorAll(selector)
        const results = []
        const max = Math.min(els.length, limit || 5)
        for (let i = 0; i < max; i++) {
          const el = els[i]
          const rect = el.getBoundingClientRect()
          const info = {
            tag: el.tagName.toLowerCase(),
            text: el.textContent.trim().slice(0, 100),
            visible: rect.width > 0 && rect.height > 0,
            position: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          }
          if (includeAttributes) {
            info.attrs = {}
            for (const a of el.attributes) { info.attrs[a.name] = a.value }
          }
          results.push(info)
        }
        return results
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

      press_key: (key, target) => {
        const el = target ? (document.querySelector(target) || document.body) : document.activeElement || document.body
        el.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, keyCode: key.charCodeAt?.(0) || 0, bubbles: true, cancelable: true }))
        el.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, keyCode: key.charCodeAt?.(0) || 0, bubbles: true, cancelable: true }))
        return `已发送按键: ${key}` + (target ? ` → ${target}` : '')
      },
    }

    const func = funcs[toolName]
    if (!func) return { ok: false, error: `未知DOM工具: ${toolName}` }

    const argMap = {
      extract_content: [args.selector, args.multiple, args.limit],
      click_element: [args.selector, args.index],
      fill_input: [args.selector, args.value, args.submit],
      scroll_page: [args.direction, args.amount],
      get_element_info: [args.selector, args.includeAttributes, args.limit],
      wait_for_element: [args.selector, args.timeout],
      press_key: [args.key, args.target],
    }

    try {
      console.log('[Agent] executeDOMTool:', toolName, 'args:', JSON.stringify(args).slice(0, 80))
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args: argMap[toolName] || [],
      })
      console.log('[Agent] executeDOMTool result:', JSON.stringify(result?.result).slice(0, 200))
      return { ok: true, result: result?.result }
    } catch (e) {
      console.error('[Agent] executeDOMTool error:', toolName, e.message)
      return { ok: false, error: e.message }
    }
  }

  async run(port, userMessage, chatHistory) {
    const startTime = Date.now()
    let iteration = 0
    let searchResults = []
    const executedTools = []
    const toolCallCount = {}
    let injectFailCount = 0  // 连续注入失败计数（跨不同 inject_script_N）

    // 清理 chatHistory 中的自定义字段，避免 API 拒绝
    const cleanHistory = (chatHistory || []).map(m => {
      const { toolCalls, ...clean } = m
      return clean
    })

    const systemMsg = {
      role: 'system',
      content: `你是 AI Browser 智能Agent助手。你可以：
1. 使用 search_tools 搜索工具库中的脚本工具
2. 使用 read_page_content 读取当前页面内容
3. 使用 navigate_to_url 导航到指定URL（搜索页、文章页等）
4. 使用 go_back 返回上一页（导航到错误页面时用）
5. 使用 extract_content 提取页面特定元素内容（支持CSS选择器）
6. 使用 click_element 点击页面元素（按钮、链接等）
7. 使用 fill_input 填写输入框并可选提交
8. 使用 press_key 发送键盘按键（Escape关闭弹窗、ArrowDown翻页、Enter提交、Tab切焦点）
9. 使用 scroll_page 滚动页面
10. 使用 get_element_info 获取元素详细信息（位置、属性、可见性等）
11. 使用 wait_for_element 等待页面元素加载完成（navigate/click/fill_input submit后必须调用）
12. 使用 take_screenshot 截取页面可视区域截图
13. 使用 inject_script_* 系列函数注入执行脚本到页面
14. 使用 finish_task 结束任务并汇报结果

工作流程：
- 收到用户需求后，先用 search_tools 搜索相关工具
- **搜索技巧**：使用简短核心词（2-4字），多个词用空格分隔。搜索支持中文智能分词和模糊匹配，语序不同也能搜到。例如用户要"最新热点新闻"→搜"新闻 热点"；用户要"采集小红书"→搜"小红书"。如果首次搜不到，换同义词重试（如"爬虫"→"采集"）。
- **搜不到专用工具时**：改用 navigate_to_url + DOM工具（extract_content/fill_input/click_element）直接操作页面完成需求。例如：用户要搜"温州一日游"，navigate_to_url 打开搜索URL，然后用 extract_content 采集结果
- 如果需求是页面操作（如提取内容、点击、填表），直接使用DOM工具，无需搜索
- **重要：页面导航/提交后必须等待加载**：navigate_to_url 之后 → wait_for_element 等待目标元素出现 → extract_content 提取。fill_input(submit=true) 之后 → wait_for_element 等待结果元素出现 → 再提取。直接提取会拿到旧页面内容
- **wait_for_element 选择器技巧**：选一个页面加载后必然会出现的特征元素。搜索结果页用 .search-result 或 [class*="result"]，文章页用 article 或 .content，列表页用 [class*="item"] 或 li
- 找到工具后先了解其功能，如果当前页面信息对任务有用，用 read_page_content 获取
- 再调用合适的 inject_script_* 执行工具
- **重要**：工具执行完成后，查看结果。如果结果已满足用户需求（即使有截断标注），立即用 finish_task 汇报，不要反复调用
- 每次只调用一个函数
- 最多调用3-4个工具就应该 finish_task，不要在工具之间反复横跳`,
    }

    const messages = [systemMsg, ...cleanHistory, { role: 'user', content: userMessage }]

    try { port.postMessage({ type: 'agentStart' }) } catch {}

    while (iteration < this.MAX_ITERATIONS) {
      if (Date.now() - startTime > this.TIMEOUT_MS) {
        try { port.postMessage({ type: 'agentError', error: 'Agent执行超时' }) } catch {}
        return
      }

      iteration++

      const tools = this.buildToolDefinitions(userMessage, searchResults)

      const config = await this.configService.getAIConfig()
      const body = {
        model: config.model,
        messages,
        temperature: 0.3,
        max_tokens: config.maxTokens || 4096,
        tools,
        tool_choice: 'auto',
      }

      let url = config.baseUrl
      if (!url.endsWith('/chat/completions') && !url.endsWith('/chat/completions/')) {
        url = url.replace(/\/+$/, '') + '/chat/completions'
      }

      try {
        const headers = { 'Content-Type': 'application/json' }
        if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`

        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })

        if (!res.ok) {
          const text = await res.text()
          try { port.postMessage({ type: 'agentError', error: `AI API错误: ${res.status}` }) } catch {}
          return
        }

        const data = await res.json()
        const choice = data.choices?.[0]
        const msg = choice?.message

        if (!msg) {
          try { port.postMessage({ type: 'agentError', error: 'AI返回为空' }) } catch {}
          return
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          console.log('[Agent] tool_calls:', msg.tool_calls.map(t => t.function.name).join(', '))
          const toolCall = msg.tool_calls[0]
          const funcName = toolCall.function.name
          let funcArgs = {}
          try { funcArgs = JSON.parse(toolCall.function.arguments || '{}') } catch {}

          // 循环检测
          toolCallCount[funcName] = (toolCallCount[funcName] || 0) + 1
          const lastExecuted = executedTools[executedTools.length - 1]
          if (toolCallCount[funcName] >= 3 && lastExecuted && !lastExecuted.result?.ok) {
            console.warn('[Agent] 检测到重复失败:', funcName, '强制结束')
            const stopMsg = `任务无法完成：工具 "${funcName}" 已连续失败${toolCallCount[funcName]}次，可能是工具配置有问题。`
            for (const char of stopMsg) {
              try { port.postMessage({ type: 'streamChunk', content: char }) } catch {}
              await new Promise(r => setTimeout(r, 10))
            }
            try { port.postMessage({ type: 'streamDone' }) } catch {}
            return
          }
          if (toolCallCount[funcName] >= 5) {
            console.warn('[Agent] 检测到重复循环:', funcName, '强制结束')
            const stopMsg = `任务已尝试"${funcName}" ${toolCallCount[funcName]}次，为避免死循环自动结束。请简化任务重试。`
            for (const char of stopMsg) {
              try { port.postMessage({ type: 'streamChunk', content: char }) } catch {}
              await new Promise(r => setTimeout(r, 10))
            }
            try { port.postMessage({ type: 'streamDone' }) } catch {}
            return
          }
          // 全局注入失败检测：不同 inject_script_N 连续失败也触发
          if (funcName.startsWith('inject_script_')) {
            injectFailCount++
            if (injectFailCount >= 3) {
              console.warn('[Agent] 检测到连续注入失败:', injectFailCount, '次，强制结束')
              const stopMsg = `已连续尝试${injectFailCount}个脚本均失败，可能是工具库脚本有问题或当前页面不兼容。请检查后重试。`
              for (const char of stopMsg) {
                try { port.postMessage({ type: 'streamChunk', content: char }) } catch {}
                await new Promise(r => setTimeout(r, 10))
              }
              try { port.postMessage({ type: 'streamDone' }) } catch {}
              return
            }
          } else {
            injectFailCount = 0  // 非注入工具调用，重置计数
          }

          try {
            port.postMessage({
              type: 'agentStep',
              step: iteration,
              toolName: funcName,
              toolArgs: funcArgs,
            })
          } catch {}

          messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] })

          let toolResult
          if (funcName === 'finish_task') {
            console.log('[Agent] finish_task, summary:', funcArgs.summary)
            const summary = funcArgs.summary || '任务已完成'
            try { port.postMessage({ type: 'agentStepResult', step: iteration, result: summary, done: true }) } catch {}
            for (const char of summary) {
              try { port.postMessage({ type: 'streamChunk', content: char }) } catch {}
              await new Promise(r => setTimeout(r, 15))
            }
            if (executedTools.length > 0) {
              const resultsText = '\n\n---\n### 工具执行结果\n' + executedTools.map((t, i) => {
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
                try { port.postMessage({ type: 'streamChunk', content: char }) } catch {}
                await new Promise(r => setTimeout(r, 5))
              }
            }
            try { port.postMessage({ type: 'streamDone' }) } catch {}
            return
          } else if (funcName === 'search_tools') {
            const query = funcArgs.query || userMessage
            try { port.postMessage({ type: 'agentStep', step: iteration, toolName: 'search_tools', toolArgs: { query }, status: 'searching' }) } catch {}
            searchResults = await this.toolService.searchScripts(query)
            if (searchResults.length === 0) {
              toolResult = JSON.stringify({
                ok: true,
                result: `未找到与"${query}"匹配的专用工具。请改用 navigate_to_url + DOM工具（extract_content/fill_input/click_element）直接在页面上操作完成需求。不要再调用 search_tools。`,
              })
            } else {
              toolResult = JSON.stringify(searchResults.slice(0, 5).map(t => ({
                id: t.id, name: t.name, description: t.description,
                toolType: t.toolType, toolConfig: t.toolConfig ? '已配置' : '未配置',
              })))
            }
            executedTools.push({ name: 'search_tools', result: { ok: searchResults.length > 0, count: searchResults.length } })
            try { port.postMessage({ type: 'agentSearchResult', results: searchResults.slice(0, 5) }) } catch {}
          } else if (funcName === 'read_page_content') {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
            const pageData = await this.toolService.getPageContent()
            toolResult = JSON.stringify({
              title: pageData?.title || '',
              url: pageData?.url || '',
              content: (pageData?.content || '').slice(0, 3000),
            })
          } else if (funcName.startsWith('inject_script_')) {
            const scriptId = parseInt(funcName.replace('inject_script_', ''))
            if (!scriptId || isNaN(scriptId)) {
              toolResult = JSON.stringify({ ok: false, error: '无效的脚本ID' })
            } else {
              const tool = searchResults.find(t => t.id === scriptId) || { id: scriptId, name: '脚本#' + scriptId, toolType: 'js', toolConfig: {} }
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
              try { port.postMessage({ type: 'agentStep', step: iteration, toolName: funcName, toolArgs: { scriptId, scriptName: tool.name }, status: 'running' }) } catch {}
              const execResult = await this.toolService.executeTool(tool, tab?.id)
              toolResult = JSON.stringify(execResult)
              executedTools.push({ name: tool.name || funcName, result: execResult })
            }
          } else if (funcName === 'navigate_to_url') {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
            if (!tab?.id) {
              toolResult = JSON.stringify({ ok: false, error: '无法获取当前标签页' })
            } else {
              try { port.postMessage({ type: 'agentStep', step: iteration, toolName: funcName, toolArgs: funcArgs, status: 'running' }) } catch {}
              await chrome.tabs.update(tab.id, { url: funcArgs.url })
              toolResult = JSON.stringify({ ok: true, result: `已导航到: ${funcArgs.url}` })
              executedTools.push({ name: funcName, result: { ok: true, result: funcArgs.url } })
            }
          } else if (funcName === 'go_back') {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
            if (!tab?.id) {
              toolResult = JSON.stringify({ ok: false, error: '无法获取当前标签页' })
            } else {
              try { port.postMessage({ type: 'agentStep', step: iteration, toolName: funcName, status: 'running' }) } catch {}
              try {
                await chrome.tabs.goBack(tab.id)
                toolResult = JSON.stringify({ ok: true, result: '已返回上一页' })
              } catch (e) {
                toolResult = JSON.stringify({ ok: false, error: '无更多历史记录: ' + e.message })
              }
              executedTools.push({ name: funcName, result: toolResult })
            }
          } else if (funcName === 'take_screenshot') {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
            if (!tab?.id) {
              toolResult = JSON.stringify({ ok: false, error: '无法获取当前标签页' })
            } else {
              try { port.postMessage({ type: 'agentStep', step: iteration, toolName: funcName, status: 'running' }) } catch {}
              try {
                const quality = funcArgs.quality || 80
                const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality })
                const base64Len = dataUrl?.length || 0
                // AI 只需要摘要不传 base64，完整数据通过 agentStepResult 传给 UI
                toolResult = JSON.stringify({ ok: true, result: `截图成功，图片大小约${Math.round(base64Len / 1024)}KB` })
                executedTools.push({ name: funcName, result: { ok: true, result: `截图大小约${Math.round(base64Len / 1024)}KB`, screenshot: dataUrl } })
              } catch (e) {
                toolResult = JSON.stringify({ ok: false, error: '截图失败: ' + e.message })
                executedTools.push({ name: funcName, result: { ok: false, error: e.message } })
              }
            }
          } else if (funcName === 'extract_content' || funcName === 'click_element' || funcName === 'fill_input' || funcName === 'scroll_page' || funcName === 'get_element_info' || funcName === 'wait_for_element' || funcName === 'press_key') {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
            if (!tab?.id) {
              toolResult = JSON.stringify({ ok: false, error: '无法获取当前标签页' })
            } else {
              try { port.postMessage({ type: 'agentStep', step: iteration, toolName: funcName, toolArgs: funcArgs, status: 'running' }) } catch {}
              const domResult = await this.executeDOMTool(tab.id, funcName, funcArgs)
              toolResult = JSON.stringify(domResult)
              executedTools.push({ name: funcName, result: domResult })
            }
          } else {
            toolResult = JSON.stringify({ ok: false, error: `未知工具: ${funcName}` })
          }

          try {
            port.postMessage({
              type: 'agentStepResult',
              step: iteration,
              toolName: funcName,
              result: toolResult,
              done: false,
            })
          } catch {}

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
        } else {
          console.log('[Agent] 纯文本回复（无tool_calls）:', (msg.content || '').slice(0, 80))
          const content = msg.content || ''
          if (content) {
            for (const char of content) {
              try { port.postMessage({ type: 'streamChunk', content: char }) } catch {}
              await new Promise(r => setTimeout(r, 15))
            }
            try { port.postMessage({ type: 'streamDone' }) } catch {}
            return
          }
        }
      } catch (e) {
        console.error('[AgentService] iteration error:', e)
        try { port.postMessage({ type: 'agentError', error: e.message }) } catch {}
        return
      }
    }

    try { port.postMessage({ type: 'agentError', error: 'Agent达到最大迭代次数，请简化任务重试' }) } catch {}
  }
}
