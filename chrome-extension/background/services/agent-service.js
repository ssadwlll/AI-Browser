// ============ 动作循环检测器 ============
// 追踪重复动作模式和页面停滞，向AI发出分级提醒
class ActionLoopDetector {
  constructor(windowSize = 15) {
    this.windowSize = windowSize
    this.recentActions = []       // [{key, name, url}]
    this.consecutiveStagnant = 0  // 连续页面无变化次数
    this._lastPageState = null    // {url, elementCount}
  }

  record(name, params, currentUrl) {
    const selector = params?.selector || ''
    const navUrl = params?.url || ''
    const key = `${name}|${selector}|${navUrl}`
    this.recentActions.push({ key, name, url: currentUrl })
    if (this.recentActions.length > this.windowSize) {
      this.recentActions = this.recentActions.slice(-this.windowSize)
    }
  }

  recordPageState(url, elementCount) {
    const state = `${url}|${elementCount}`
    if (this._lastPageState === state) {
      this.consecutiveStagnant++
    } else {
      this.consecutiveStagnant = 0
      this._lastPageState = state
    }
  }

  getNudge() {
    const msgs = []

    // 动作重复检测
    const counts = {}
    for (const a of this.recentActions) {
      counts[a.key] = (counts[a.key] || 0) + 1
    }
    const maxRepeat = Math.max(...Object.values(counts), 0)

    if (maxRepeat >= 12) {
      msgs.push(`严重警告：同一操作已重复 ${maxRepeat} 次（最近 ${this.recentActions.length} 个动作中）。如果每次都在推进，请继续；否则强烈建议更换策略或调用 finish_task 报告。`)
    } else if (maxRepeat >= 8) {
      msgs.push(`注意：同一操作已重复 ${maxRepeat} 次。是否每次都有进展？如果没有，建议尝试不同方法。`)
    } else if (maxRepeat >= 5) {
      msgs.push(`提示：同一操作已重复 ${maxRepeat} 次。如果是有意为之且持续有进展，请继续；否则值得重新考虑策略。`)
    }

    // 页面停滞检测
    if (this.consecutiveStagnant >= 5) {
      msgs.push(`页面内容已连续 ${this.consecutiveStagnant} 步没有变化，DOM操作可能没有生效。建议尝试不同的元素或策略。`)
    }

    return msgs.length > 0 ? msgs.join('\n') : null
  }
}

// ============ AgentService ============
export class AgentService {
  constructor(configService, toolService, pageService, scriptService) {
    this.configService = configService
    this.toolService = toolService
    this.pageService = pageService
    this.scriptService = scriptService
    this.MAX_AI_REQUESTS = 15    // AI API 请求次数上限（每次请求可执行多个工具）
    this.MAX_TOOL_CALLS = 30     // 工具调用总次数上限（防止本地工具无限调用）
    this.TIMEOUT_MS = 600000       // 总超时10分钟
    this.ACTION_TIMEOUT_MS = 60000  // 单动作超时60秒
    // Plan B: Agent 生命周期与 Port 解耦
    // tabId → { port, messages:[], running:bool }
    this.agentStates = new Map()
    // 域名策略缓存（每次 run 时刷新）
    this._allowedDomains = null
    this._prohibitedDomains = null
    this._blockIPAddresses = false
    // 按 URL 缓存过滤后的工具脚本，避免每轮重复过滤
    this._filteredScriptsCache = new Map()
    // 跟踪已记录过域名不匹配的脚本，避免日志刷屏
    this._domainMismatchLogged = new Set()
    // 记录已读取过的页面 URL，防止重复 read_page_content
    this._pageReadCache = new Map()
  }

  buildToolDefinitions(userQuery, searchResults, currentPageUrl, round) {
    const tools = []
    const roundNum = round || 1
    const onlySpeedTools = roundNum <= 2  // 前2轮仅快速工具，降低LLM决策负担

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
        description: '读取当前页面标题、URL和正文，用于了解页面结构',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'click_element',
        description: '点击页面元素（仅用于简单交互：点击按钮、登录等）',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS选择器，支持 :contains("文本")' },
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
        description: '填写输入框（仅用于登录、搜索框等简单场景）',
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
            selector: { type: 'string', description: 'CSS选择器，支持 :contains("文本")' },
            timeout: { type: 'number', description: '等待毫秒，默认5000' },
          },
          required: ['selector'],
        },
      },
    })

    // ===== P0: 零LLM成本探查工具 =====
    tools.push({
      type: 'function',
      function: {
        name: 'get_interactive_elements',
        description: '获取页面可交互元素列表（链接、按钮、输入框等），每个元素带 index 编号。一次性了解页面结构后立即行动，不要在每轮重复调用。零LLM成本。',
        parameters: {
          type: 'object',
          properties: {
            selectorHint: { type: 'string', description: '可选：限定查询的CSS选择器范围，如"a.news-item"。不传则返回所有可交互元素' },
          },
          required: [],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'find_text_on_page',
        description: '在页面文本中搜索关键词，返回匹配数量、位置摘要。零LLM成本，优先使用。适用场景：确认页面是否包含某数据、定位内容位置',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            caseSensitive: { type: 'boolean', description: '是否区分大小写，默认false' },
          },
          required: ['query'],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'get_element_info',
        description: '用CSS选择器查询DOM元素，返回数量、文本摘要和属性。仅在需要统计数量或确认结构时使用。采集数据请用 extract_content，不要用此工具反复查询同一个选择器。零LLM成本。',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS选择器，支持 :contains("文本")' },
            limit: { type: 'number', description: '最多返回条数，默认5' },
            attributes: { type: 'string', description: '逗号分隔的属性名，如"href,src,alt"' },
          },
          required: ['selector'],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'extract_content',
        description: '用CSS选择器批量提取页面元素的文本内容和属性（如href链接）。采集列表数据的主力工具——一次调用即可获取所有新闻标题+链接。数据可直接信任使用，不需要再用其他工具验证。用attributes参数指定要提取的属性名。零LLM成本。',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS选择器，如".news-list a"或"a.news-title"。支持:contains("文本")过滤' },
            multiple: { type: 'boolean', description: '是否返回多条结果。列表采集设为true，单条提取设为false。默认true' },
            limit: { type: 'number', description: '最多返回条数，默认10，最大50' },
            attributes: { type: 'string', description: '逗号分隔的要提取的属性名。提取链接时必传"href"。如"href,title,data-id"' },
          },
          required: ['selector'],
        },
      },
    })

    // ===== P1: 辅助操作工具（仅第3轮起暴露，减少早期决策负担）=====
    if (!onlySpeedTools) {
    tools.push({
      type: 'function',
      function: {
        name: 'scroll_page',
        description: '滚动页面（read_page_content只能读取首屏，需要更多内容时使用）',
        parameters: {
          type: 'object',
          properties: {
            direction: { type: 'string', description: '方向: "down"(默认), "up"' },
            amount: { type: 'string', description: '滚动量: "page"(一屏,默认), "half"(半屏), 或像素值如"300"' },
          },
          required: [],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'hover_element',
        description: '悬停页面元素（触发下拉菜单、tooltip等，click无法替代）',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS选择器，支持 :contains("文本")' },
            index: { type: 'number', description: '第几个(从0起)，默认0' },
          },
          required: ['selector'],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'select_dropdown',
        description: '选择<select>下拉框选项（fill_input对原生下拉框无效，必须用此工具）',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: '下拉框CSS选择器' },
            value: { type: 'string', description: '选项文本或value值' },
            by: { type: 'string', description: '匹配方式: "text"(选项文本,默认), "value"(option的value属性), "index"(第几个)' },
          },
          required: ['selector', 'value'],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'press_key',
        description: '发送键盘操作（Escape关闭弹窗/遮罩层、PageDown翻页、Enter确认、Tab切换焦点等）',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '按键，如"Escape", "PageDown", "PageUp", "Enter", "Tab", "ArrowDown", "ArrowUp"' },
            selector: { type: 'string', description: '可选：聚焦此元素后按键（如搜索框按Enter）' },
          },
          required: ['key'],
        },
      },
    })

    // ===== P2: 辅助输出/导航工具 =====
    if (!onlySpeedTools) {
    tools.push({
      type: 'function',
      function: {
        name: 'screenshot_visible',
        description: '截取当前可视区域截图。用于视觉验证操作结果、确认页面加载状态',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    })
    }
    }

    tools.push({
      type: 'function',
      function: {
        name: 'navigate_to',
        description: '直接导航到指定URL。从 extract_content 获取链接后，用此工具打开内页。比 click_element 更可靠——不会因选择器不精确而失败',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '目标URL（绝对路径）。从 extract_content 返回的 attrs.href 中获取' },
          },
          required: ['url'],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'go_back',
        description: '返回上一页',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'go_forward',
        description: '前进到下一页',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    })

    // 搜索结果中的工具脚本（最多6个，仅第3轮起暴露以加速早期响应）
    // P0: 根据当前页面域名过滤不适用的脚本（缓存过滤结果，避免每轮重复计算）
    if (!onlySpeedTools && searchResults && searchResults.length > 0) {
    const cacheKey = currentPageUrl || '__no_url__'
    let cached = this._filteredScriptsCache.get(cacheKey)
    if (!cached) {
      cached = []
      const loggedSet = this._domainMismatchLogged
      for (const s of searchResults.slice(0, 12)) {
        if (cached.length >= 6) break
        // 域名过滤：脚本有 urlPattern 且当前页面不匹配 → 跳过
        if (s.urlPattern && s.urlPattern !== '*' && currentPageUrl) {
          if (!this.scriptService.matchUrl(s.urlPattern, currentPageUrl)) {
            // 每个脚本只打印一次域名不匹配日志
            const msgKey = `${s.id}_${cacheKey}`
            if (!loggedSet.has(msgKey)) {
              loggedSet.add(msgKey)
              console.log(`[Agent] 脚本域名不匹配，跳过: ${s.name} (urlPattern=${s.urlPattern})`)
            }
            continue
          }
        }
        cached.push(s)
      }
      this._filteredScriptsCache.set(cacheKey, cached)
    }

    // 按经验记忆成功率排序（成功率高的优先推荐）
    const sortedScripts = [...cached].sort((a, b) => {
      const rateA = a.memoryTotal > 0 ? (a.memorySuccess || 0) / a.memoryTotal : -1
      const rateB = b.memoryTotal > 0 ? (b.memorySuccess || 0) / b.memoryTotal : -1
      return rateB - rateA  // 高成功率在前，无记忆数据的排最后
    })

    for (const s of sortedScripts) {

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
      // P3: 经验记忆提示（含成功率标记）
      if (s.memorySuccess !== undefined && s.memoryTotal > 0) {
        const rate = Math.round(s.memorySuccess / s.memoryTotal * 100)
        desc += ` [成功率:${rate}%(${s.memorySuccess}/${s.memoryTotal})]`
      } else if (s.memoryTotal === 0) {
        desc += ' [无历史记录]'
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
    }  // end if(!onlySpeedTools) 脚本块

    tools.push({
      type: 'function',
      function: {
        name: 'create_plan',
        description: '创建或更新任务执行计划（复杂任务建议在第1-2轮制定计划）。plan_items 为有序步骤列表，每步含 step(描述)和 estimatedTools(预计使用工具)',
        parameters: {
          type: 'object',
          properties: {
            plan_items: {
              type: 'array',
              description: '有序计划步骤列表',
              items: {
                type: 'object',
                properties: {
                  step: { type: 'string', description: '步骤描述' },
                  estimatedTools: { type: 'string', description: '预计使用的工具，如"search_tools + inject_script"' },
                },
                required: ['step'],
              },
            },
            current_step: { type: 'number', description: '当前正在执行的步骤索引(从0起)，默认0' },
          },
          required: ['plan_items'],
        },
      },
    })

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
    // 注意：chrome.scripting.executeScript 会序列化 func，闭包变量会丢失
    // 所以每个工具函数必须自包含 qsa 定义（不能依赖外层闭包）
    const funcs = {

      extract_content: (selector, multiple, limit, attributes) => {
        const qsa=(s)=>{const m=s.match(/^(.*):contains\("([^"]*)"\)(.*)$/);if(!m)return document.querySelectorAll(s);const c=(m[1]+m[3]).trim()||'*';const t=m[2].toLowerCase();return[...document.querySelectorAll(c)].filter(e=>(e.textContent||'').toLowerCase().includes(t))}
        const els = qsa(selector)
        // 兼容字符串和数组格式的 attributes 参数
        const attrList = (() => {
          if (!attributes) return null
          if (typeof attributes === 'string' && attributes.length > 0) return attributes.split(',').map(s => s.trim()).filter(Boolean)
          if (Array.isArray(attributes) && attributes.length > 0) return attributes
          return null
        })()
        const results = []
        const max = Math.min(els.length, limit || 10)
        for (let i = 0; i < max; i++) {
          const item = { text: els[i].textContent.trim().slice(0, 500) }
          if (attrList) {
            item.attrs = {}
            for (const attr of attrList) {
              const val = els[i].getAttribute(attr)
              if (val !== null && val !== undefined) item.attrs[attr] = val
            }
          }
          results.push(item)
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
        const qsa=(s)=>{const m=s.match(/^(.*):contains\("([^"]*)"\)(.*)$/);if(!m)return document.querySelectorAll(s);const c=(m[1]+m[3]).trim()||'*';const t=m[2].toLowerCase();return[...document.querySelectorAll(c)].filter(e=>(e.textContent||'').toLowerCase().includes(t))}
        const els = qsa(selector)
        const el = els[index || 0]
        if (!el) return '元素未找到: ' + selector
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        // 如果是链接且有 href，强制同标签页导航，避免打开新标签导致 Agent 丢失上下文
        const linkHref = el.tagName === 'A' && el.href ? el.getAttribute('href') : null
        if (el.tagName === 'A') {
          el.removeAttribute('target')  // 移除 target="_blank"
          el.setAttribute('target', '_self')
        }
        el.click()
        const text = (el.textContent || '').trim().slice(0, 50)
        if (linkHref) return `已点击链接: ${text || el.tagName} → ${linkHref}`
        return '已点击: ' + (text || el.tagName)
      },

      fill_input: (selector, value, submit) => {
        const qsa=(s)=>{const m=s.match(/^(.*):contains\("([^"]*)"\)(.*)$/);if(!m)return document.querySelectorAll(s);const c=(m[1]+m[3]).trim()||'*';const t=m[2].toLowerCase();return[...document.querySelectorAll(c)].filter(e=>(e.textContent||'').toLowerCase().includes(t))}
        const els = qsa(selector)
        const el = els[0]
        if (!el) return '输入框未找到: ' + selector
        el.focus()
        // 区分 input 和 textarea
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        if (el.tagName === 'TEXTAREA' && nativeTextareaSetter) {
          nativeTextareaSetter.call(el, value)
        } else if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, value)
        } else {
          el.value = value
        }
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
        const qsa=(s)=>{const m=s.match(/^(.*):contains\("([^"]*)"\)(.*)$/);if(!m)return document.querySelectorAll(s);const c=(m[1]+m[3]).trim()||'*';const t=m[2].toLowerCase();return[...document.querySelectorAll(c)].filter(e=>(e.textContent||'').toLowerCase().includes(t))}
        return new Promise((resolve) => {
          const start = Date.now()
          const max = timeout || 5000
          function check() {
            const els = qsa(selector)
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

      save_as_file: (content, filename, mimeType) => {
        const blob = new Blob([content], { type: mimeType || 'text/plain' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        return '文件已触发下载: ' + filename + ' (大小: ' + (content.length > 1024 ? (content.length / 1024).toFixed(1) + 'KB' : content.length + '字符') + ')'
      },

      navigate_to: (url) => {
        if (!url || !url.startsWith('http')) return '无效URL: ' + url
        window.location.href = url
        return '正在导航到: ' + url
      },

      go_back: () => {
        window.history.back()
        return '已返回上一页'
      },

      // ===== P0: 零LLM成本探查 =====
      find_text_on_page: (query, caseSensitive) => {
        const text = document.body.innerText
        const flags = caseSensitive ? 'g' : 'gi'
        const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
        const matches = text.match(regex) || []
        // 返回匹配信息和上下文摘要
        const previews = []
        for (let i = 0; i < Math.min(matches.length, 5); i++) {
          // 使用 search 定位原文中的位置（与 regex 的 flag 一致）
          const idx = text.search(new RegExp(matches[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i'))
          if (idx === -1) continue
          const start = Math.max(0, idx - 30)
          const end = Math.min(text.length, idx + matches[i].length + 30)
          previews.push('...' + text.slice(start, end).replace(/\n/g, ' ') + '...')
        }
        return {
          found: matches.length > 0,
          matchCount: matches.length,
          query,
          previews,
          hint: matches.length === 0 ? `未找到"${query}"。建议：检查拼写、尝试简化关键词、或用read_page_content重新读取页面` : null
        }
      },

      get_element_info: (selector, limit, attributes) => {
        const qsa=(s)=>{const m=s.match(/^(.*):contains\("([^"]*)"\)(.*)$/);if(!m)return document.querySelectorAll(s);const c=(m[1]+m[3]).trim()||'*';const t=m[2].toLowerCase();return[...document.querySelectorAll(c)].filter(e=>(e.textContent||'').toLowerCase().includes(t))}
        const els = qsa(selector)
        const max = Math.min(els.length, limit || 5)
        const attrList = attributes ? attributes.split(',').map(a => a.trim()).filter(Boolean) : null
        const items = []
        for (let i = 0; i < max; i++) {
          const text = (els[i].textContent || '').trim().slice(0, 80)
          let line = `[${i}] <${els[i].tagName.toLowerCase()}> ${text || '(空文本)'}`
          if (attrList) {
            const pairs = []
            for (const attr of attrList) {
              let val = els[i].getAttribute(attr)
              if (val !== null && val !== undefined) {
                if (attr === 'href' && val.length > 60) val = val.slice(0, 57) + '...'
                pairs.push(`${attr}="${val}"`)
              }
            }
            if (pairs.length > 0) line += ' | ' + pairs.join(', ')
          }
          items.push(line)
        }
        let summary = `共${els.length}个匹配，返回前${items.length}条:\n` + items.join('\n')
        if (els.length > max) summary += `\n(还有${els.length - max}条未显示，可用 index 参数翻页)`
        return summary
      },

      // ===== P1: 辅助操作 =====
      scroll_page: (direction, amount) => {
        const dir = direction === 'up' ? -1 : 1
        let px = window.innerHeight * 0.8
        if (amount === 'half') px = window.innerHeight * 0.5
        else if (amount && /^\d+$/.test(amount)) px = parseInt(amount)
        window.scrollBy({ top: dir * px, behavior: 'smooth' })
        const scrolled = Math.round(window.scrollY)
        const total = Math.round(document.documentElement.scrollHeight - window.innerHeight)
        return `已${direction === 'up' ? '向上' : '向下'}滚动${px}px，当前位置: ${scrolled}/${total} (${Math.round(scrolled/Math.max(total,1)*100)}%)`
      },

      hover_element: (selector, index) => {
        const qsa=(s)=>{const m=s.match(/^(.*):contains\("([^"]*)"\)(.*)$/);if(!m)return document.querySelectorAll(s);const c=(m[1]+m[3]).trim()||'*';const t=m[2].toLowerCase();return[...document.querySelectorAll(c)].filter(e=>(e.textContent||'').toLowerCase().includes(t))}
        const els = qsa(selector)
        const el = els[index || 0]
        if (!el) return { ok: false, error: '元素未找到: ' + selector }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        return '已悬停: ' + ((el.textContent || '').trim().slice(0, 50) || el.tagName)
      },

      select_dropdown: (selector, value, by) => {
        const qsa=(s)=>{const m=s.match(/^(.*):contains\("([^"]*)"\)(.*)$/);if(!m)return document.querySelectorAll(s);const c=(m[1]+m[3]).trim()||'*';const t=m[2].toLowerCase();return[...document.querySelectorAll(c)].filter(e=>(e.textContent||'').toLowerCase().includes(t))}
        const els = qsa(selector)
        const el = els[0]
        if (!el || el.tagName !== 'SELECT') return { ok: false, error: '未找到<select>元素: ' + selector }
        const mode = by || 'text'
        let matched = false
        for (const opt of el.options) {
          const isMatch = mode === 'index' ? (opt.index === parseInt(value))
            : mode === 'value' ? (opt.value === value)
            : ((opt.textContent || '').trim() === value || opt.text === value)
          if (isMatch) {
            el.value = opt.value
            matched = true
            break
          }
        }
        if (!matched) return { ok: false, error: `在下拉框中未找到选项: "${value}" (by=${mode})。可用选项: ` + [...el.options].map(o => (o.textContent||'').trim()).slice(0,10).join(', ') }
        el.dispatchEvent(new Event('change', { bubbles: true }))
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return `已选择: ${value}`
      },

      press_key: (key, selector) => {
        const opts = { key, code: key, keyCode: { Escape: 27, Enter: 13, Tab: 9, PageDown: 34, PageUp: 33, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 }[key] || 0, bubbles: true }
        let target = document
        if (selector) {
          const els = document.querySelectorAll(selector)
          const el = els[0]
          if (el) { el.focus(); target = el }
        }
        target.dispatchEvent(new KeyboardEvent('keydown', opts))
        target.dispatchEvent(new KeyboardEvent('keyup', opts))
        return `已按键: ${key}` + (selector ? ` (目标: ${selector})` : '')
      },

      // ===== P2: 辅助输出/导航 =====
      go_forward: () => {
        window.history.forward()
        return '已前进到下一页'
      },

      // ===== 可交互元素索引（减少LLM选择器幻觉）=====
      get_interactive_elements: (selectorHint) => {
        const interactives = ['a', 'button', 'input', 'select', 'textarea', '[onclick]', '[role="button"]', '[tabindex]', '[class*="btn"]', '[class*="link"]', '[class*="item"]']
        const selector = selectorHint || interactives.join(',')
        const els = document.querySelectorAll(selector)
        const results = []
        const max = Math.min(els.length, 20)
        for (let i = 0; i < max; i++) {
          const el = els[i]
          const style = getComputedStyle(el)
          if (style.display === 'none' || style.visibility === 'hidden') continue
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) continue
          const text = (el.textContent || '').trim().slice(0, 40) || (el.value || '').slice(0, 40)
          const tag = el.tagName.toLowerCase()
          const id = el.id ? `#${el.id}` : ''
          const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : ''
          const href = el.tagName === 'A' ? (el.getAttribute('href') || '').slice(0, 50) : ''
          results.push({
            index: results.length,
            tag,
            text,
            selector: `${tag}${id}${cls}`.slice(0, 60),
            href,
            type: el.type || '',
          })
        }
        return {
          total: els.length,
          listed: results.length,
          elements: results,
          hint: `使用 click_element 配合上述元素的 selector 或 index 参数进行交互。例如: click_element(selector="${results[0]?.selector || ''}")`,
        }
      },
    }

    const func = funcs[toolName]
    if (!func) return { ok: false, error: `未知DOM工具: ${toolName}` }

    const argMap = {
      extract_content: [args.selector, args.multiple, args.limit, args.attributes],
      click_element: [args.selector, args.index],
      fill_input: [args.selector, args.value, args.submit],
      wait_for_element: [args.selector, args.timeout],
      save_as_file: [args.content, args.filename, args.mimeType],
      navigate_to: [args.url],
      go_back: [],
      // P0
      find_text_on_page: [args.query, args.caseSensitive],
      get_element_info: [args.selector, args.limit, args.attributes],
      // P1
      scroll_page: [args.direction, args.amount],
      hover_element: [args.selector, args.index],
      select_dropdown: [args.selector, args.value, args.by],
      press_key: [args.key, args.selector],
      // P2
      go_forward: [],
      get_interactive_elements: [args.selectorHint],
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
      if (e.message?.includes('Cannot access a chrome:// URL') || e.message?.includes('Cannot access contents of url')) {
        return { ok: false, error: '当前页面为系统页面（chrome://），无法执行DOM操作。必须用finish_task告知用户：请在普通网页上执行此操作，当前页面不支持自动化。不要再调用DOM工具。' }
      }
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

  // ============ 域名安全策略 ============
  // 加载域名策略配置（每次 run 开始时调用）
  async _loadDomainPolicy() {
    try {
      const agentCfg = await this.configService.getAgentConfig()
      const allowed = agentCfg?.allowedDomains
      const prohibited = agentCfg?.prohibitedDomains
      // 未设置时保持 null，跳过检查
      this._allowedDomains = (allowed && allowed.length > 0) ? allowed : null
      this._prohibitedDomains = (prohibited && prohibited.length > 0) ? prohibited : null
      this._blockIPAddresses = !!agentCfg?.blockIPAddresses
    } catch {
      this._allowedDomains = null
      this._prohibitedDomains = null
      this._blockIPAddresses = false
    }
  }

  // 判断 URL 是否被允许
  _isUrlAllowed(url) {
    // 未设置任何策略 → 全部放行
    if (!this._allowedDomains && !this._prohibitedDomains && !this._blockIPAddresses) return true

    try {
      const parsed = new URL(url)
      const hostname = parsed.hostname

      // 禁止IP直连
      if (this._blockIPAddresses && /^[\d.]+$/.test(hostname)) return false

      // 白名单优先
      if (this._allowedDomains) {
        return this._allowedDomains.some(pattern => this._matchDomain(hostname, pattern))
      }
      // 黑名单
      if (this._prohibitedDomains) {
        return !this._prohibitedDomains.some(pattern => this._matchDomain(hostname, pattern))
      }
    } catch { return false }
    return true
  }

  // 域名匹配：支持 *.example.com、example.com（自动匹配 www 变体）
  _matchDomain(hostname, pattern) {
    const h = hostname.toLowerCase()
    const p = pattern.toLowerCase()
    // *.example.com → 匹配 sub.example.com 和 example.com
    if (p.startsWith('*.')) {
      const domainPart = p.slice(2)
      return h === domainPart || h.endsWith('.' + domainPart)
    }
    // 精确匹配 + www 变体
    if (h === p) return true
    if (h === 'www.' + p) return true
    if ('www.' + h === p) return true
    return false
  }

  // 判断 URL 是否匹配脚本的 urlPattern（用于 inject_script 过滤）
  // URL 匹配已委托给 scriptService.matchUrl，此方法保留仅为向后兼容
  _matchUrlToDomain(pageUrl, urlPattern) {
    return this.scriptService.matchUrl(urlPattern, pageUrl)
  }

  // ============ 智能结果截断 ============
  // 按结构截断，而非一刀切截断到固定字符数
  _smartTruncateResult(result, maxLen = 2000) {
    if (!result || result.length <= maxLen) return result
    try {
      const obj = JSON.parse(result)
      // 数组：保留前10条 + 总数
      if (Array.isArray(obj)) {
        return JSON.stringify({
          total: obj.length,
          items: obj.slice(0, 10),
          _truncated: obj.length > 10
        })
      }
      // 对象：截断过长的字符串字段
      if (typeof obj === 'object' && obj !== null) {
        for (const key of Object.keys(obj)) {
          if (typeof obj[key] === 'string' && obj[key].length > 500) {
            obj[key] = obj[key].slice(0, 500) + '...(truncated)'
          }
        }
        const s = JSON.stringify(obj)
        if (s.length <= maxLen) return s
      }
    } catch {}
    // 兜底：纯文本截断
    return result.slice(0, maxLen) + `\n...(结果过长已截断，共${result.length}字符)`
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

    // 检查是否系统页面，拒绝在此类页面上执行 Agent
    const tabUrl = tab?.url || ''
    if (tabUrl.startsWith('chrome://') || tabUrl.startsWith('chrome-extension://') || tabUrl.startsWith('edge://') || tabUrl.startsWith('about:')) {
      try { port.postMessage({ type: 'agentError', error: 'Agent 无法在系统页面上运行，请在普通网页上使用。' }) } catch {}
      return
    }

    const state = { port, messages: [], running: true, tabId, tabUrl }
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

  // 检查指定 tab 是否有活跃 Agent（content script 查询用）
  isRunning(tabId) {
    const state = this.agentStates.get(tabId)
    return !!(state?.running)
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

  // MV3 SW 中 port.postMessage 不立即投递，需让出事件循环来刷新消息队列
  async _yieldUI() {
    await new Promise(r => setTimeout(r, 0))
  }

  // 任务复杂度预评估：快速判断任务是否需要开发专用脚本
  async _assessComplexity(tabId, userMessage, chatHistory) {
    try {
      const config = await this.configService.getAIConfig()
      const url = await this.configService.getAIProxyUrl()
      const auth = await this.configService.getAppAuth()
      const headers = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)

      const assessMessages = [
        {
          role: 'system',
          content: '你是一个任务复杂度评估器。分析用户请求，仅输出一行JSON，格式：{"level":"simple|medium|complex","estimatedRounds":数字,"needsScript":true|false}。评估标准：simple(≤5轮,单页面简单操作)、medium(6-12轮,多步骤单页面)、complex(13+轮,多页面/翻页/批量结构化提取)。needsScript=true表示任务最好用专用脚本而非DOM工具逐个操作。只输出JSON，不要任何解释。'
        },
        {
          role: 'user',
          content: `评估这个任务的复杂度：${userMessage}\n\n历史上下文摘要：${(chatHistory || []).slice(-3).map(m => `${m.role}: ${(m.content || '').slice(0, 100)}`).join(' | ')}`
        }
      ]

      const body = {
        model: config.model,
        messages: assessMessages,
        temperature: 0.1,
        max_tokens: 128,
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000)
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!res.ok) return { level: 'unknown', estimatedRounds: 0, needsScript: false }

      const data = await res.json()
      const text = data.choices?.[0]?.message?.content?.trim() || ''
      // 提取JSON
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return { level: 'unknown', estimatedRounds: 0, needsScript: false }

      const result = JSON.parse(jsonMatch[0])
      return {
        level: result.level || 'unknown',
        estimatedRounds: parseInt(result.estimatedRounds) || 0,
        needsScript: !!result.needsScript,
      }
    } catch (e) {
      console.log('[Agent] 复杂度评估失败（非致命）:', e.message)
      return { level: 'unknown', estimatedRounds: 0, needsScript: false }
    }
  }

  // 事后自评：对Agent执行结果进行快速评判
  async _runJudge(tabId, userMessage, agentSummary, executedTools) {
    try {
      const config = await this.configService.getAIConfig()
      const url = await this.configService.getAIProxyUrl()
      const auth = await this.configService.getAppAuth()
      const headers = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)

      const toolSummary = executedTools.slice(0, 10).map(t => {
        const name = t.name || ''
        const resultStr = typeof t.result === 'string' ? t.result : JSON.stringify(t.result || '')
        return `${name}: ${resultStr.slice(0, 120)}`
      }).join('\n')

      const judgeMessages = [
        {
          role: 'system',
          content: '你是任务结果评判器。对比原始需求和Agent执行结果，判断任务完成度。仅输出一行JSON：{"verdict":"success|partial|failure","comment":"简短评语(20字内)"}。success=任务完全达成，partial=部分达成，failure=未达成。只输出JSON。',
        },
        {
          role: 'user',
          content: `原始需求：${userMessage}\n\nAgent结论：${agentSummary.slice(0, 500)}\n\n执行工具摘要：\n${toolSummary.slice(0, 1000)}`,
        },
      ]

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000)
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: config.model, messages: judgeMessages, temperature: 0.1, max_tokens: 128 }),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!res.ok) return null
      const data = await res.json()
      const text = data.choices?.[0]?.message?.content?.trim() || ''
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return null
      return JSON.parse(jsonMatch[0])
    } catch (e) {
      console.log('[Agent] Judge失败（非致命）:', e.message)
      return null
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

  // 获取并校验目标标签页（Agent 生命周期内锁定同一个 tab）
  async _getTargetTab(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (!tab) return null
      const url = tab.url || ''
      if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://') || url.startsWith('about:')) {
        return null // 用户可能导航到了系统页面
      }
      return tab
    } catch {
      return null
    }
  }

  async run(tabId, userMessage, chatHistory) {
    const startTime = Date.now()
    // 加载域名安全策略（未设置则跳过检查）
    await this._loadDomainPolicy()
    // 从配置读取所有可配置参数
    let maxRounds = 15
    let MAX_CONSECUTIVE_FAILS = 5
    let MAX_LOW_VALUE = 3
    let MAX_IDLE_TEXT = 2
    let EXPLORATION_LIMIT = 5
    let enableJudge = true
    let enablePlanning = true
    let debug = false
    try {
      const agentCfg = await this.configService.getAgentConfig()
      if (agentCfg?.maxRounds >= 5) maxRounds = agentCfg.maxRounds
      if (agentCfg?.maxConsecutiveFails >= 2) MAX_CONSECUTIVE_FAILS = agentCfg.maxConsecutiveFails
      if (agentCfg?.maxLowValue >= 2) MAX_LOW_VALUE = agentCfg.maxLowValue
      if (agentCfg?.maxIdleText >= 1) MAX_IDLE_TEXT = agentCfg.maxIdleText
      if (agentCfg?.explorationLimit >= 2) EXPLORATION_LIMIT = agentCfg.explorationLimit
      enableJudge = agentCfg?.enableJudge !== false
      enablePlanning = agentCfg?.enablePlanning !== false
      debug = agentCfg?.debug === true
    } catch {}
    const _debugLog = (label, detail) => {
      if (!debug) return
      const summary = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)
      console.log(`[AgentDebug] ${label}`, detail)
      try { this.postToUI(tabId, { type: 'agentDebug', label, detail: summary.slice(0, 2000) }) } catch(e) { console.warn('[AgentDebug] postToUI失败', e) }
    }
    // 工具调用上限 = 轮次 * 3，最低30，最高200
    const MAX_TOOL_CALLS = Math.min(200, Math.max(30, maxRounds * 3))
    let aiRequestCount = 0      // AI API 请求次数（每次 while 循环 +1）
    let totalToolCalls = 0      // 工具调用总次数（含本地工具，防止无限调用）
    let searchResults = []
    const executedTools = []
    let _budget20Warned = false   // 绝对轮次警告(≥20轮)
    let _budget70Warned = false   // 70%预算警告
    let _idleTextCount = 0        // 连续纯文本无工具调用次数
    let consecutiveFailCount = 0  // 连续无进展计数（工具失败或结果无变化时+1，有进展时重置为0）
    let lowValueStreak = 0         // 连续低价值操作（find_text/screenshot/get_element_info/get_interactive 等）计数
    const LOW_VALUE_TOOLS = new Set(['find_text_on_page', 'screenshot_visible', 'get_element_info', 'get_interactive_elements'])
    const _injections = []        // 系统注入消息（不写入主消息数组，避免破坏 assistant/tool 交替结构）
    const COMPLEXITY_THRESHOLD = 8 // 预估轮次超过此值提示用户需要开发专用脚本
    // P2: 初始化动作循环检测器
    const loopDetector = new ActionLoopDetector(15)
    // 探索上限跟踪：无脚本匹配的探索轮次计数
    let explorationRounds = 0
    let _explorationWarned = false
    // 计划跟踪
    let currentPlan = null        // { plan_items, current_step, created_at_round }
    let planStepProgress = 0      // 计划步骤推进计数（用于检测计划停滞）

    // 清理 chatHistory 中的自定义字段，避免 API 拒绝
    const cleanHistory = (chatHistory || []).map(m => {
      const { toolCalls, tool_calls, ...clean } = m
      return clean
    })

    const systemMsg = {
      role: 'system',
      content: `你是AI Browser脚本调度器。分析用户需求，匹配工具库中的脚本执行；脚本无法覆盖的简单交互可使用DOM工具辅助。

注意：工具分阶段暴露。第1-2轮只有核心+探查工具（search_tools、read、find_text、get_element_info、get_interactive_elements、click、fill_input、wait、scroll、create_plan、navigate_to、go_back/forward、finish_task），第3轮起释放全部工具（hover、select_dropdown、press_key、screenshot、inject_script_*）。前2轮专注了解页面、定位数据、搜索脚本、制定计划。

=== 任务规划（重要！复杂任务必须先规划再执行） ===
- 对于需要3步以上操作的任务，第1轮就用 create_plan 制定计划
- plan_items 是步骤列表，current_step 指示当前进度（从0开始）
- 每完成一个计划步骤，再次调用 create_plan 更新 current_step
- 如果计划执行受阻，可修改后续 plan_items 调整策略
- 简单任务（1-2步）可以跳过规划直接执行

=== 工具成本分类（重要！按成本从低到高选择） ===

零LLM成本工具（优先使用，即时返回）：
- extract_content: 批量提取元素文本和属性。**采集列表数据时首选**——一次调用提取所有标题+链接。传 attributes="href" 获取链接
- get_interactive_elements: 获取页面可交互元素列表（链接、按钮、输入框），每个带index编号。构建选择器前先用此工具了解页面结构
- find_text_on_page: 在页面文本中搜索关键词，返回匹配数量和上下文。确认"页面有没有XX"时首选
- get_element_info: CSS选择器查DOM，返回元素数量、文本、属性。仅在 extract_content 不适合时使用（如只需统计数量）。采集链接请用 extract_content
- read_page_content: 读取页面标题、URL、正文摘要
- click_element: 点击页面元素，支持 :contains("文本") 按文字匹配，也支持 get_interactive_elements 返回的 index
- fill_input: 填写输入框，支持回车提交
- wait_for_element: 等待页面元素出现（仅 click 触发的跳转需要；navigate_to 后页面已加载，直接用 read/extract）

低成本辅助工具（合理使用）：
- scroll_page: 滚动页面。read_page_content只读首屏，要查看更多内容时先滚动
- hover_element: 悬停元素（触发下拉菜单/tooltip）。click不能替代
- select_dropdown: 选择<select>下拉框。fill_input对原生下拉框无效
- press_key: 发送键盘操作。Escape关闭弹窗、PageDown翻页、Enter确认等
- screenshot_visible: 截图当前视口。视觉验证操作结果时使用
- go_back: 返回上一页
- go_forward: 前进到下一页
- navigate_to: 直接导航到指定URL。从 extract_content 的 attrs.href 获取链接后使用，比 click_element 更可靠。**导航后页面已加载，不要再用 wait_for_element，直接用 read_page_content 或 extract_content 获取内容。**

核心工具：
- create_plan: 创建/更新任务执行计划（复杂任务第1轮使用）
- search_tools: 搜索工具脚本库，传简短中文关键词(2-4字)
- inject_script_*: 执行工具库中已审核的脚本（需先search_tools搜索，已按当前页面域名过滤）
- finish_task: 汇报结果并结束任务

=== 工具选择原则 ===
1. 采集列表/批量提取数据 → extract_content(selector, attributes="href") 一次性完成，不要分步
2. extract_content 成功后 → 直接用返回的数据推进下一步（navigate_to/go_back/finish_task），不要验证
3. 不确定页面选择器 → 先用 get_interactive_elements 了解结构（最多1次），然后 extract_content
4. 需要操作页面 → click/fill/scroll/hover/select/press_key
5. 需要循环翻页 → inject_script_* 脚本
6. 遇到弹窗/遮罩 → press_key("Escape") 或 click_element 关闭
7. 同一工具被反复调用≥3次 → 立即 finish_task("需要脚本")

=== 脚本匹配规则 ===
- search_tools 返回的脚本仅适用于其目标平台，确认平台匹配当前页面后再注入
- 无匹配脚本且需求超出DOM工具能力 → finish_task("该网站暂无采集脚本，请上传到工具库后重试")
- 禁止跨站注入

=== 操作铁律（违反将导致大量浪费轮次） ===
- extract_content 返回的数据即为最终数据，严禁再用 get_element_info / find_text / screenshot 重复验证同一批元素
- extract_content 后禁止用 get_element_info 查相同选择器——这是完全重复的劳动
- 只在操作明显失败（返回error/空结果）时才验证，成功则直接推进下一步
- 导航到内页后 → extract_content 或 read_page_content 提取内容 → 立刻 go_back 或继续下一条链接，不要在内页反复探查
- 同一操作失败2次后必须换策略，严禁重复失败操作
- 如果导航(URL)跳转到了系统页面(chrome://)，用finish_task立即汇报
- 每次 click 触发的跳转后调用 wait_for_element 等待页面稳定（navigate_to 后不需要）

=== 输出规范 ===
- 用自然语言总结工具返回的结果，不要输出原始JSON
- 工具返回错误时分析原因并在 finish_task 中告知用户

=== 典型工作流程（采集列表+内页）===
1. read_page_content 了解页面
2. extract_content(selector, attributes="href") → 得到所有标题+链接
3. create_plan（可选，多步任务时用）
4. navigate_to(第1条链接) → extract_content 提取内页 → go_back（注意：navigate_to后直接用extract，不要wait）
5. 重复步骤4，**每5篇检查剩余轮次（预算）。当剩余轮次不足完成所有内页时，立即 finish_task 汇总已采集的**`,

    }

    const messages = [systemMsg, ...cleanHistory, { role: 'user', content: userMessage }]

    // ===== 任务复杂度预评估 =====
    const complexity = await this._assessComplexity(tabId, userMessage, chatHistory)
    if (complexity.estimatedRounds > COMPLEXITY_THRESHOLD) {
      console.log(`[Agent] 复杂度评估: ${complexity.level}, 预估${complexity.estimatedRounds}轮, 建议开发专用脚本`)
      _injections.push(`任务复杂度评估：${complexity.level}（预估需${complexity.estimatedRounds}轮）。如果任务涉及循环翻页、批量提取结构化数据、或多页面操作，请立即调用 finish_task 告知用户："该任务复杂度较高，建议开发专用脚本上传到工具库后执行，效率更高且结果更可靠。" 否则正常执行。`)
    } else if (complexity.estimatedRounds > 0) {
      console.log(`[Agent] 复杂度评估: ${complexity.level}, 预估${complexity.estimatedRounds}轮, 正常执行`)
    }

    this.postToUI(tabId, { type: 'agentStart' })
    _debugLog('🐛 调试模式已开启', '每步的信息（提示词、工具调用、规则触发）将在外部 Log 窗口中显示')

    // ===== 调试：输出配置摘要 =====
    _debugLog('⚙️ Agent配置', { maxRounds, MAX_CONSECUTIVE_FAILS, MAX_LOW_VALUE, MAX_IDLE_TEXT, EXPLORATION_LIMIT, enableJudge, enablePlanning, debug })
    _debugLog('📋 系统提示词（前500字）', systemMsg.content.slice(0, 500))

    while (aiRequestCount < maxRounds) {
      if (Date.now() - startTime > this.TIMEOUT_MS) {
        this.postToUI(tabId, { type: 'agentError', error: 'Agent执行超时' })
        await this._saveToChatHistoryStorage(tabId, '⚠️ Agent 执行超时，请简化任务后重试。', [])
        return
      }
      if (totalToolCalls >= MAX_TOOL_CALLS) {
        this.postToUI(tabId, { type: 'agentError', error: '工具调用次数超限，请简化任务重试' })
        await this._saveToChatHistoryStorage(tabId, '⚠️ 工具调用次数超限，请简化任务后重试。', [])
        return
      }

      aiRequestCount++

      // 告知UI正在思考
      this.postToUI(tabId, { type: 'agentStatus', text: `思考中... (第${aiRequestCount}轮)` })
      // 让出事件循环，确保状态消息即时送达侧边栏
      await this._yieldUI()

      // P2: 步骤预算通知（两级提醒）
      const budgetRatio = aiRequestCount / maxRounds
      // 第一级：70%时温和提醒
      if (budgetRatio >= 0.7 && budgetRatio < 0.85 && !_budget70Warned) {
        _budget70Warned = true
        _debugLog('⚠️ 规则触发: 预算警告(70%)', { round: aiRequestCount, maxRounds, budgetRatio: Math.round(budgetRatio * 100) + '%' })
        _injections.push(`注意：已使用 ${aiRequestCount}/${maxRounds} 轮 (${Math.round(budgetRatio * 100)}%)。仅剩 ${maxRounds - aiRequestCount} 轮！如果是逐篇采集任务，估算剩余轮次能否覆盖所有内页（每篇约2轮），不能则立即 finish_task 汇总已采集的。不要再等待、不再浏览新页面。`)
      }
      // 第二级：85%以上紧急收尾
      if (budgetRatio >= 0.85 && aiRequestCount < maxRounds - 1) {
        _debugLog('🚨 规则触发: 紧急收尾(85%)', { round: aiRequestCount, maxRounds, budgetRatio: Math.round(budgetRatio * 100) + '%' })
        _injections.push(`紧急：仅剩 ${maxRounds - aiRequestCount} 轮！严禁开始任何新操作，尤其是 navigate_to 打开新内页。立即汇总已有结果（说出已采集的文章标题），调用 finish_task 结束任务。不要再浏览、搜索或等待。`)
      }

      // 低价值操作提示
      if (lowValueStreak >= MAX_LOW_VALUE) {
        lowValueStreak = 0
        _debugLog('⚠️ 规则触发: 低价值操作', { streak: lowValueStreak })
        messages.push({
          role: 'system',
          content: '提示：已连续执行多轮搜索/截图辅助操作。如果核心数据已采集完毕，请立即调用 finish_task 汇总结果，不要再进行低价值的信息挖掘。'
        })
      }

      // 探索上限：无脚本匹配时累加，搜索到脚本或有数据产出时重置
      if (searchResults.length === 0 && aiRequestCount > 2) {
        explorationRounds++
      } else {
        explorationRounds = 0
      }
      if (explorationRounds >= EXPLORATION_LIMIT && !_explorationWarned) {
        _explorationWarned = true
        _debugLog('⚠️ 规则触发: 探索上限', { explorationRounds })
        messages.push({
          role: 'system',
          content: `已探索 ${explorationRounds} 轮但未找到匹配脚本。如果当前页面需求超出DOM工具能力，请调用 finish_task 告知用户："该网站暂无采集脚本，请上传脚本到工具库后重试"。如果可用DOM工具完成任务，请立即开始执行，不要再搜索。`
        })
      }

      // 探查调用溢出检查已禁用（EXPLORATION_TOOLS 为空集，计数器永不递增）

      // 绝对轮次警告
      if (aiRequestCount >= 20 && aiRequestCount / maxRounds < 0.7 && !_budget20Warned) {
        _budget20Warned = true
        _debugLog('⚠️ 规则触发: 绝对轮次警告(≥20轮)', { round: aiRequestCount, maxRounds })
        messages.push({
          role: 'system',
          content: `已执行 ${aiRequestCount} 轮（${Math.round(aiRequestCount / maxRounds * 100)}%）。任务应在数轮内完成，请立即推进到核心操作阶段，不要再进行探索性操作。`
        })
      }

      // 计划停滞检测
      if (currentPlan && aiRequestCount - currentPlan.created_at_round >= 5 && planStepProgress === currentPlan.current_step) {
        const stuckRounds = aiRequestCount - currentPlan.created_at_round
        _debugLog('⚠️ 规则触发: 计划停滞', { planAge: stuckRounds, stuckAtStep: currentPlan.current_step + 1 })
        if (stuckRounds >= 8) {
          // 硬终止：8轮 stuck 后强制跳过当前步骤
          _debugLog('🛑 计划停滞硬终止: 强制跳过当前步骤', { stuckRounds })
          currentPlan.current_step++
          planStepProgress = currentPlan.current_step
          messages.push({
            role: 'system',
            content: `计划已在第${currentPlan.current_step}步停滞 ${stuckRounds} 轮！**系统已强制跳过当前步骤。你已经有足够的数据（extract_content 的返回结果），立即用 navigate_to 打开已获取的链接采集内页，不要再探查、搜索翻页、或重复读取页面。如果已有内页数据，直接 finish_task 汇总。**`
          })
        } else {
          messages.push({
            role: 'system',
            content: `当前计划已执行 ${stuckRounds} 轮但步骤未推进（停留在第${currentPlan.current_step + 1}步）。如果当前步骤受阻，请跳过并继续下一步，或直接调用 finish_task。`
          })
        }
      }

      // 获取当前页面URL用于工具过滤
      let currentPageUrl = ''
      try {
        const tab = await this._getTargetTab(tabId)
        currentPageUrl = tab?.url || ''
      } catch {}

      const tools = this.buildToolDefinitions(userMessage, searchResults, currentPageUrl, aiRequestCount + 1)
      console.log(`[Agent] 第${aiRequestCount}轮API请求, tools:${tools.length}个, 已搜到${searchResults.length}个脚本`)
      _debugLog(`🔧 第${aiRequestCount}轮 工具(${tools.length}个)`, tools.map(t => `  ${t.function.name}`).join('\n'))

      const config = await this.configService.getAIConfig()
      const auth = await this.configService.getAppAuth()
      const body = {
        model: config.model,
        messages,
        temperature: 0.3,
        max_tokens: Math.min(Math.max(config.maxTokens || 2048, 2048), 4096),  // Agent模式2048-4096，避免工具过多时请求爆炸
        tools,
        tool_choice: 'auto',
      }
      // 构建发送给 LLM 的消息摘要
      const msgSummary = messages.map((m, i) => ({
        idx: i,
        role: m.role,
        preview: typeof m.content === 'string' ? m.content.slice(0, 500) : (Array.isArray(m.content) ? JSON.stringify(m.content).slice(0, 500) : String(m.content).slice(0, 500)),
        len: typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length,
        tc_id: m.tool_call_id || undefined
      }))
      _debugLog(`📤 第${aiRequestCount}轮 发送LLM`, JSON.stringify({
        model: config.model,
        msgs: messages.length,
        lastRole: messages[messages.length - 1]?.role,
        tools: tools.length,
        msgSummary
      }, null, 2))

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
            // 15s 后通知 UI 等待中
            const waitNotifyId = setTimeout(() => {
              this.postToUI(tabId, { type: 'agentStatus', status: 'thinking', text: `思考中... (第${aiRequestCount + 1}轮) - API响应较慢，请耐心等待` })
            }, 15000)
            res = await fetch(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal: controller.signal,
            })
            clearTimeout(timeoutId)
            clearTimeout(waitNotifyId)
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
          // 尝试读取具体错误信息
          let errDetail = ''
          try { const errJson = await res?.json(); errDetail = errJson?.error?.message || errJson?.message || JSON.stringify(errJson).slice(0, 200) } catch {}
          console.error('[Agent] API请求失败:', res?.status, errDetail)

          // 400/413可尝试不带tools重试
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
                let fbErr = ''
                try { const fe = await fallbackRes?.json(); fbErr = fe?.error?.message || fe?.message || JSON.stringify(fe).slice(0, 200) } catch {}
                console.error('[Agent] 不带tools重试也失败:', fallbackRes?.status, fbErr)
                this.postToUI(tabId, { type: 'agentError', error: `AI API错误: ${fallbackRes?.status || '未知'} — ${fbErr || errDetail || '不支持Function Calling或请求过大'}` })
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
        console.log(`[Agent] 第${aiRequestCount}轮响应:`, msg?.tool_calls?.length ? `tool_calls:${msg.tool_calls.length}` : (msg?.content ? `text:${msg.content.slice(0,60)}` : 'empty'))

        if (!msg) {
          this.postToUI(tabId, { type: 'agentError', error: 'AI返回为空' })
          return
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          console.log('[Agent] tool_calls:', msg.tool_calls.map(t => t.function.name).join(', '))
          _debugLog(`📥 第${aiRequestCount}轮 LLM响应: tool_calls`, msg.tool_calls.map(t => `${t.function.name}(${JSON.stringify(t.function.arguments || {}).slice(0, 100)})`).join('\n'))

          // 有工具调用时重置纯文本空闲计数
          _idleTextCount = 0

          // 推送 assistant 消息（包含所有 tool_calls）
          messages.push({ role: 'assistant', content: null, tool_calls: msg.tool_calls })

          // P1: 动作终止标志——导航类动作后跳过后续调用
          let shouldTerminateSequence = false

          // 逐个执行 tool calls
          for (const toolCall of msg.tool_calls) {
            if (shouldTerminateSequence) {
              // 已终止序列：给剩余 tool_call 补一个占位响应，避免 API 报"orphaned tool_call"错误
              messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ skipped: true, reason: '页面已跳转，后续操作被跳过' }) })
              continue
            }
            if (totalToolCalls >= MAX_TOOL_CALLS) {
              // 超限：给剩余 tool_call 补占位响应
              messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ skipped: true, reason: '工具调用次数已达上限' }) })
              continue
            }

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
            // 让出事件循环，确保 SW 刷新 Port 消息到侧边栏
            await this._yieldUI()

            let toolResult
            if (funcName === 'finish_task') {
              console.log('[Agent] finish_task, summary:', funcArgs.summary)
              const summary = funcArgs.summary || '任务已完成'
              messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ ok: true, summary }) })
              this.postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, result: summary, done: true })
              for (const char of summary) {
                this.postToUI(tabId, { type: 'streamChunk', content: char })
                await new Promise(r => setTimeout(r, 15))
              }
              this.postToUI(tabId, { type: 'streamDone' })
              await this._saveToChatHistoryStorage(tabId, summary, executedTools.map(t => ({
                name: t.name, result: typeof t.result === 'string' ? t.result : JSON.stringify(t.result || '')
              })))
              // 事后自评：对任务结果进行快速评判
              if (enableJudge) {
                try {
                  const judgeResult = await this._runJudge(tabId, userMessage, summary, executedTools)
                  if (judgeResult) {
                    const judgeMsg = `\n\n---\n📋 **结果评估**：${judgeResult.verdict === 'success' ? '✅ 任务完成' : judgeResult.verdict === 'partial' ? '⚠️ 部分完成' : '❌ 可能未完成'}\n${judgeResult.comment || ''}`
                    for (const char of judgeMsg) {
                      this.postToUI(tabId, { type: 'streamChunk', content: char })
                      await new Promise(r => setTimeout(r, 10))
                    }
                    await this._saveToChatHistoryStorage(tabId, summary + judgeMsg, [])
                  }
                } catch (e) {
                  console.warn('[Agent] 事后自评失败（非致命）:', e.message)
                }
              }
              return
            } else if (funcName === 'capture_network') {
              const targetTab = await this._getTargetTab(tabId)
              if (!targetTab) {
                toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用（可能已关闭或导航到了系统页面）。必须用finish_task告知用户。' })
              } else {
                const filter = { url: funcArgs.url, status: funcArgs.status, limit: funcArgs.limit || 10 }
                try {
                  const [captureResult] = await chrome.scripting.executeScript({
                    target: { tabId: targetTab.id },
                    func: (filter) => {
                      if (!window.__aiBrowserGetCaptured) return { ok: false, error: '网络捕获未就绪，请刷新页面' }
                      return { ok: true, result: window.__aiBrowserGetCaptured(filter) }
                    },
                    args: [filter],
                  })
                  toolResult = JSON.stringify(captureResult?.result || { ok: false, error: '无数据' })
                } catch (e) {
                  if (e.message?.includes('Cannot access a chrome:// URL') || e.message?.includes('Cannot access contents of url')) {
                    toolResult = JSON.stringify({ ok: false, error: '当前页面为系统页面，无法执行网络捕获。必须用finish_task告知用户：请在普通网页上执行此操作。不要再调用网络捕获工具。' })
                  } else {
                    toolResult = JSON.stringify({ ok: false, error: e.message })
                  }
                }
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
            } else if (funcName === 'create_plan') {
              const planItems = funcArgs.plan_items || []
              const currentStep = funcArgs.current_step || 0
              currentPlan = {
                plan_items: planItems,
                current_step: currentStep,
                created_at_round: aiRequestCount,
              }
              const planSummary = planItems.map((p, i) => `${i === currentStep ? '▶' : '  '} [${i}] ${p.step}${p.estimatedTools ? ' (' + p.estimatedTools + ')' : ''}`).join('\n')
              toolResult = JSON.stringify({ ok: true, plan: planItems, current_step: currentStep, summary: `计划已${planStepProgress > 0 ? '更新' : '创建'}（共${planItems.length}步）：\n${planSummary}` })
              planStepProgress = currentStep
              executedTools.push({ name: 'create_plan', result: { planLength: planItems.length, currentStep } })
              this.postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: 'create_plan', result: `计划: ${planItems.length}步, 当前第${currentStep + 1}步`, done: false })
              this.postToUI(tabId, { type: 'agentSearchResult', results: [] })  // 复用该类型展示计划
            } else if (funcName === 'read_page_content') {
              const targetTab = await this._getTargetTab(tabId)
              if (!targetTab) {
                toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用（可能已关闭或导航到了系统页面）。必须用finish_task告知用户。' })
              } else {
                // 防重复读取：同一URL已读取过则返回缓存（节省API轮次）
                const pageUrl = targetTab.url || ''
                const cachedRead = this._pageReadCache.get(pageUrl)
                if (cachedRead) {
                  console.log('[Agent] read_page_content 命中缓存:', pageUrl)
                  toolResult = cachedRead
                } else {
                  let pageData = null
                  try {
                    const response = await chrome.tabs.sendMessage(targetTab.id, { type: 'extractPageContent' })
                    pageData = response?.data || null
                  } catch {}
                  if (!pageData) {
                    toolResult = JSON.stringify({ ok: false, error: '无法读取页面内容。如果当前是系统页面（chrome://），DOM操作不可用。必须用finish_task告知用户：请在普通网页上执行此操作。' })
                  } else {
                    toolResult = JSON.stringify({
                      ok: true,
                      title: pageData.title || '',
                      url: pageData.url || '',
                      content: (pageData.content || '').slice(0, 3000),
                    })
                    this._pageReadCache.set(pageUrl, toolResult)
                  }
                }
              }
            } else if (funcName.startsWith('inject_script_')) {
              const scriptId = parseInt(funcName.replace('inject_script_', ''))
              if (!scriptId || isNaN(scriptId)) {
                toolResult = JSON.stringify({ ok: false, error: '无效的脚本ID' })
              } else {
                const tool = searchResults.find(t => t.id === scriptId) || { id: scriptId, name: '脚本#' + scriptId, toolType: 'js', toolConfig: {}, metadata: {}, precheck: '' }
                const targetTab = await this._getTargetTab(tabId)
                if (!targetTab) {
                  toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用（可能已关闭或导航到了系统页面）。必须用finish_task告知用户。' })
                  executedTools.push({ name: `${funcName}(标签页不可用)`, result: toolResult })
                  this.postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
                  messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
                  continue
                }

                // P1: 执行前检查
                if (tool.precheck && tool.precheck.trim()) {
                  this.postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: { check: 'precheck' }, status: 'running' })
                  try {
                    const [precheckResult] = await chrome.scripting.executeScript({
                      target: { tabId: targetTab.id },
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
                      const precheckReason = pr.result.reason || pr.result.error || '未知原因'
                      toolResult = JSON.stringify({ ok: false, error: `前置检查失败: ${precheckReason}` })
                      executedTools.push({ name: `${funcName}(precheck失败)`, result: toolResult })
                      // 记录失败记忆
                      this._recordMemory(scriptId, false, 0, `前置检查失败: ${precheckReason}`, '').catch(() => {})
                      this.postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
                      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
                      continue
                    }
                  } catch (e) {
                    // precheck 执行异常
                    if (e.message?.includes('Cannot access a chrome:// URL') || e.message?.includes('Cannot access contents of url')) {
                      toolResult = JSON.stringify({ ok: false, error: '当前页面为系统页面，无法执行脚本。必须用finish_task告知用户：请在普通网页上执行此操作。不要再调用工具脚本。' })
                      executedTools.push({ name: `${funcName}(系统页面)`, result: toolResult })
                      this.postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
                      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
                      continue
                    }
                    // 其他异常不阻塞，继续执行脚本
                    console.warn('[Agent] precheck 执行异常，继续执行:', e.message)
                  }
                }

                this.postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: { scriptId, scriptName: tool.name }, status: 'running' })
                const execStart = Date.now()
                const execResult = await this.toolService.executeTool(tool, targetTab.id, funcArgs)
                const execDuration = Date.now() - execStart
                toolResult = JSON.stringify(execResult)
                executedTools.push({ name: tool.name || funcName, result: execResult })
                // P3: 记录经验记忆
                const memOk = execResult?.ok === true
                // 从执行结果中提取有意义的摘要
                let memSummary = ''
                const innerResult = execResult?.result
                if (typeof innerResult === 'string') {
                  memSummary = innerResult.slice(0, 200)
                } else if (innerResult && typeof innerResult === 'object') {
                  if (Array.isArray(innerResult.data)) {
                    memSummary = `${innerResult.data.length}条数据`
                    if (innerResult.total !== undefined) memSummary += ` (共${innerResult.total})`
                    // 附加前3条标题
                    const titles = innerResult.data.slice(0, 3).map(d => d?.title || d?.name || '').filter(Boolean)
                    if (titles.length) memSummary += ': ' + titles.join('; ')
                    memSummary = memSummary.slice(0, 200)
                  } else if (Array.isArray(innerResult)) {
                    memSummary = `${innerResult.length}条结果`
                  } else {
                    memSummary = JSON.stringify(innerResult).slice(0, 200)
                  }
                }
                this._recordMemory(scriptId, memOk, execDuration, memOk ? '' : (execResult?.error || ''), memSummary).catch(() => {})
              }
            } else if (funcName === 'screenshot_visible') {
              // P2: 截图（需 Chrome API，不走 executeDOMTool）
              toolResult = await (async () => {
                try {
                  const targetTab = await this._getTargetTab(tabId)
                  if (!targetTab) return JSON.stringify({ ok: false, error: '目标标签页不可用' })
                  this.postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, status: 'running' })
                  const dataUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId, { format: 'jpeg', quality: 60 })
                  // 截断 base64 避免 token 爆炸：只保留头部信息
                  const header = dataUrl.slice(0, 100)
                  const sizeKB = Math.round(dataUrl.length / 1024)
                  return JSON.stringify({ ok: true, result: `截图已获取 (${sizeKB}KB, JPEG)，格式: ${header}...`, _hasScreenshot: true, _dataUrl: dataUrl })
                } catch (e) {
                  return JSON.stringify({ ok: false, error: `截图失败: ${e.message}` })
                }
              })()
              executedTools.push({ name: funcName, result: toolResult })
            } else if (funcName === 'extract_content' || funcName === 'click_element' || funcName === 'fill_input' || funcName === 'wait_for_element' || funcName === 'save_as_file' || funcName === 'navigate_to' || funcName === 'go_back' || funcName === 'find_text_on_page' || funcName === 'get_element_info' || funcName === 'scroll_page' || funcName === 'hover_element' || funcName === 'select_dropdown' || funcName === 'press_key' || funcName === 'go_forward' || funcName === 'get_interactive_elements') {
              // P1: navigate_to 执行前检查域名安全策略
              if (funcName === 'navigate_to' && !this._isUrlAllowed(funcArgs.url)) {
                toolResult = JSON.stringify({ ok: false, error: `导航被安全策略阻止：${funcArgs.url} 不在允许的域名范围内。请用finish_task告知用户。` })
                executedTools.push({ name: `${funcName}(域名被拦截)`, result: toolResult })
                this.postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
                messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
                // 跳过实际导航，但不设置终止标志
                loopDetector.record(funcName, funcArgs, currentPageUrl)
              } else {
                const targetTab = await this._getTargetTab(tabId)
                if (!targetTab) {
                  toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用（可能已关闭或导航到了系统页面）。必须用finish_task告知用户。' })
                } else {
                  this.postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: funcArgs, status: 'running' })
                  // P3: 单动作超时包装
                  const domResult = await Promise.race([
                    this.executeDOMTool(targetTab.id, funcName, funcArgs),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('动作超时')), this.ACTION_TIMEOUT_MS))
                  ]).catch(e => ({ ok: false, error: e.message }))
                  toolResult = JSON.stringify(domResult)
                  executedTools.push({ name: funcName, result: domResult })
                }
              }
              // 导航类动作 → 终止后续
              if (['navigate_to', 'go_back', 'go_forward'].includes(funcName) && !toolResult.includes('域名被拦截')) {
                shouldTerminateSequence = true
              }
            } else {
              toolResult = JSON.stringify({ ok: false, error: `未知工具: ${funcName}` })
            }

            // 工具执行结果调试
            _debugLog(`⚙️ 工具结果: ${funcName}`, (toolResult || '').slice(0, 300))

            // ===== P2: 动作循环检测（仅记录，不在此处注入消息） =====
            loopDetector.record(funcName, funcArgs, currentPageUrl)
            // 当 navigate_to 或 click_element 成功，且计划存在 → 重置计划停滞计时（Agent 正在推进）
            if (['navigate_to'].includes(funcName) && currentPlan && !toolResult.includes('域名被拦截') && !toolResult.includes('"ok":false')) {
              currentPlan.created_at_round = aiRequestCount
              _debugLog('🔄 计划停滞计时已重置（navigate_to 推进了任务）', { newRefRound: aiRequestCount })
            }
            try {
              const tab = await this._getTargetTab(tabId)
              if (tab) {
                const elementCount = await chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  func: () => document.querySelectorAll('[class],[id],[type]').length
                }).then(r => r[0]?.result || 0).catch(() => 0)
                loopDetector.recordPageState(tab.url || '', elementCount)
              }
            } catch {}

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

            // 使用更强烈的 nudge 重置无进展计数
            if (hasProgress) {
              consecutiveFailCount = 0
            } else {
              consecutiveFailCount++
              console.warn('[Agent] 无进展 #' + consecutiveFailCount, funcName, toolResult?.slice(0, 100))
            }

            // 低价值操作检测：仅当无进展时计数，有进展时重置（避免误杀合理的多关键词搜索）
            if (LOW_VALUE_TOOLS.has(funcName) && !hasProgress) {
              lowValueStreak++
              console.warn(`[Agent] 低价值操作 #${lowValueStreak}: ${funcName} (无进展)`)
            } else {
              lowValueStreak = 0
            }

            // extract_content 返回数据 → 不是"探索"，是"干活"，重置探索计数器
            if (funcName === 'extract_content' && hasProgress) {
              explorationRounds = 0
              _explorationWarned = false
            }


            if (consecutiveFailCount >= MAX_CONSECUTIVE_FAILS) {
              _debugLog('🛑 Agent终止: 连续无进展', { consecutiveFailCount, max: MAX_CONSECUTIVE_FAILS })
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

            // P3: 智能截断过长的工具结果（保留结构）
            const truncatedResult = this._smartTruncateResult(toolResult)
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: truncatedResult,
            })

            await new Promise(r => setTimeout(r, 200))
          }

          // 循环检测提醒（在所有 tool 响应之后注入，避免破坏 assistant-tool 配对）
          const nudge = loopDetector.getNudge()
          if (nudge) {
            messages.push({ role: 'system', content: nudge })
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
          // P3: 检测连续纯文本回复（无工具调用），防止AI陷入无效对话循环
          _idleTextCount++
          if (_idleTextCount >= MAX_IDLE_TEXT) {
            console.warn('[Agent] 连续', _idleTextCount, '次纯文本无工具调用，强制结束')
            this.postToUI(tabId, { type: 'agentError', error: 'AI连续回复纯文本未使用工具，可能任务无法继续' })
            await this._saveToChatHistoryStorage(tabId, '⚠️ AI连续回复纯文本未执行操作，请检查任务描述是否清晰。', [])
            return
          }
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

    // 写入 chatHistory，让 sidepanel 通过 storage.onChanged 感知完成并清理 streaming 状态
    _debugLog('🛑 Agent终止: 达到最大轮次', { maxRounds, executedToolsCount: executedTools.length })
    const finalNote = `⚠️ Agent 已达到最大请求次数（${maxRounds} 轮）。任务可能未完成，请简化需求后重试。`
    const toolCallsSummary = executedTools.length > 0
      ? executedTools.filter(t => !t.name?.includes('search_tools') && !t.name?.includes('read_page_content')).slice(0, 15)
      : []
    await this._saveToChatHistoryStorage(tabId, finalNote, toolCallsSummary)
  }
}
