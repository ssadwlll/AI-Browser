import { PayloadStore } from './payload-store.js'
import { DomainPolicy } from './domain-policy.js'
import { TodoScheduler, STAGE } from './todo-scheduler.js'

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
    // 域名安全策略（每次 run 时加载）
    this.domainPolicy = new DomainPolicy(configService, scriptService)
    // 按 URL 缓存过滤后的工具脚本，避免每轮重复过滤
    this._filteredScriptsCache = new Map()
    // 跟踪已记录过域名不匹配的脚本，避免日志刷屏
    this._domainMismatchLogged = new Set()
    // 记录已读取过的页面 URL，防止重复 read_page_content
    this._pageReadCache = new Map()
    // 工具结果暂存区（超过阈值的结果存此处，只发摘要给AI）
    this.payloadStore = new PayloadStore()
    // 分阶段AI待办调度引擎（内含全局持久存储+阶段临时缓存）
    this.todoScheduler = new TodoScheduler()
  }

  buildToolDefinitions(userQuery, searchResults, currentPageUrl, round) {
    const tools = []
    const roundNum = round || 1

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

    // ===== P1: 辅助操作工具 =====
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
    tools.push({
      type: 'function',
      function: {
        name: 'screenshot_visible',
        description: '截取当前可视区域截图。用于视觉验证操作结果、确认页面加载状态',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    })

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

    // 搜索结果中的工具脚本（最多6个，从第1轮就暴露——新流程：先读取页面+搜索工具，再综合分析）
    // P0: 根据当前页面域名过滤不适用的脚本（缓存过滤结果，避免每轮重复计算）
    if (searchResults && searchResults.length > 0) {
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
    }  // end 脚本块

    // ===== P0: 数据查询工具（始终暴露）=====
    tools.push({
      type: 'function',
      function: {
        name: 'recall_data',
        description: '查询已存储的工具执行结果。某些工具（extract_content、inject_script、read_page_content等）返回大量数据时只发送摘要，详细内容存于存储中。需要查看完整或部分数据时调用此工具。',
        parameters: {
          type: 'object',
          properties: {
            entry_id: { type: 'string', description: '存储条目ID（工具结果中标注）。不传则返回所有条目汇总。多条目用逗号分隔如"p1,p2"' },
            tool_name: { type: 'string', description: '来源工具名。不传entry_id时按工具名查询最新条目' },
            filter: { type: 'string', description: '过滤条件："前N条"、"第N-M条"、"含关键词xxx"' },
            fields: { type: 'string', description: '需要的字段，逗号分隔如"title,url"。不传返回全部字段' },
          },
          required: [],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'create_todo',
        description: '创建分阶段待办列表。系统校验合规性和数据依赖合法性，然后按待办顺序驱动执行。建议在第1轮创建。',
        parameters: {
          type: 'object',
          properties: {
            stages: {
              type: 'array',
              description: '三阶段待办列表',
              items: {
                type: 'object',
                properties: {
                  stage: { type: 'number', enum: [1, 2, 3], description: '阶段编号: 1=本地DOM工具, 2=远程脚本, 3=数据汇总' },
                  name: { type: 'string', description: '阶段名称' },
                  subTodos: {
                    type: 'array',
                    description: '该阶段的子待办列表',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', description: '待办ID，如 "s1-1"' },
                        action: { type: 'string', description: '使用的工具名称，如 read_page_content / extract_content / inject_script_N / finish_task' },
                        description: { type: 'string', description: '待办描述' },
                        dataDependKeys: { type: 'array', items: { type: 'string' }, description: '依赖的数据key列表（从之前待办的dataOutputKey获取）' },
                        dataOutputKey: { type: 'string', description: '输出数据的语义key（供后续待办引用，无输出设为null）' },
                      },
                      required: ['id', 'action', 'description'],
                    },
                  },
                },
                required: ['stage', 'subTodos'],
              },
            },
          },
          required: ['stages'],
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

  // ===== 阶段1工具列表：本地DOM工具 + search_tools + finish_task（不含inject_script_*） =====
  _buildPhase1Tools(userMessage, currentPageUrl, round) {
    // 直接复用 buildToolDefinitions，但不传入 searchResults，这样就不会暴露 inject_script_*
    return this.buildToolDefinitions(userMessage, [], currentPageUrl, round)
  }

  // ===== 阶段2工具列表：仅 search_tools + inject_script_* + read_page_content + recall_data + finish_task =====
  _buildPhase2Tools(searchResults, currentPageUrl, round) {
    const tools = []

    // search_tools：搜索远程脚本
    tools.push({
      type: 'function',
      function: {
        name: 'search_tools',
        description: '搜索服务器远程工具库，传简短中文关键词(2-4字)。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '核心关键词，如"新闻"、"采集"、"翻译"' },
          },
          required: ['query'],
        },
      },
    })

    // read_page_content：了解当前页面（辅助脚本判断）
    tools.push({
      type: 'function',
      function: {
        name: 'read_page_content',
        description: '读取当前页面标题、URL和正文。用于向脚本提供页面上下文。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    })

    // recall_data：查询已有数据
    tools.push({
      type: 'function',
      function: {
        name: 'recall_data',
        description: '查询已存储的工具执行结果。需要详细数据时调用。',
        parameters: {
          type: 'object',
          properties: {
            entry_id: { type: 'string', description: '存储条目ID' },
            tool_name: { type: 'string', description: '来源工具名' },
            filter: { type: 'string', description: '过滤条件' },
            fields: { type: 'string', description: '需要的字段' },
          },
          required: [],
        },
      },
    })

    // 远程脚本工具
    if (searchResults && searchResults.length > 0) {
      const cacheKey = currentPageUrl || '__no_url__'
      let cached = this._filteredScriptsCache.get(cacheKey)
      if (!cached) {
        cached = []
        const loggedSet = this._domainMismatchLogged
        for (const s of searchResults.slice(0, 12)) {
          if (cached.length >= 6) break
          if (s.urlPattern && s.urlPattern !== '*' && currentPageUrl) {
            if (!this.scriptService.matchUrl(s.urlPattern, currentPageUrl)) {
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

      // 按经验记忆排序
      const sortedScripts = [...cached].sort((a, b) => {
        const rateA = a.memoryTotal > 0 ? (a.memorySuccess || 0) / a.memoryTotal : -1
        const rateB = b.memoryTotal > 0 ? (b.memorySuccess || 0) / b.memoryTotal : -1
        return rateB - rateA
      })

      for (const s of sortedScripts) {
        const tc = s.toolConfig || {}
        const meta = s.metadata || {}
        let desc = (tc.toolDescription || s.description || `执行: ${s.name}`).slice(0, 80)
        if (meta.triggers && meta.triggers.length > 0) desc += ` [触发:${meta.triggers.slice(0,3).join(',')}]`
        if (meta.requires_login) desc += ' [需登录]'
        if (meta.pagination && meta.pagination.strategy !== 'none') {
          desc += ` [分页:${meta.pagination.strategy},≤${meta.pagination.maxPages||20}次]`
        }
        const hasPrecheck = !!(s.precheck && s.precheck.trim())
        if (hasPrecheck) desc += ' [有前置检查]'
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
    }

    // finish_task
    tools.push({
      type: 'function',
      function: {
        name: 'finish_task',
        description: '任务完成，汇报结果。阶段2失败时也调用此工具总结失败原因和建议。',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '完成摘要或失败原因分析' },
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
        return multiple !== false ? results : (results[0] || '')
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
      console.log('[Agent] executeDOMTool:', toolName, 'args:', JSON.stringify(args))
      const serializedArgs = (argMap[toolName] || []).map(v => v === undefined ? null : v)
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args: serializedArgs,
      })
      console.log('[Agent] executeDOMTool result:', JSON.stringify(result?.result))
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

  // ============ 域名安全策略（委托给 DomainPolicy） ============
  async _loadDomainPolicy() {
    await this.domainPolicy.load()
  }

  _isUrlAllowed(url) {
    return this.domainPolicy.isUrlAllowed(url)
  }

  _matchUrlToDomain(pageUrl, urlPattern) {
    return this.domainPolicy.matchUrlToDomain(pageUrl, urlPattern)
  }

  // ============ PayloadStore 存储判断 ============
  // 判断工具结果是否需要存 payloadStore
  _shouldStoreToPayload(result, toolName) {
    // recall_data 不存（避免嵌套JSON噩梦）
    if (toolName === 'recall_data') return false
    // search_tools 不存（搜索结果会更新searchResults变量，不需要再存）
    if (toolName === 'search_tools') return false
    const threshold = 1500  // 字符阈值
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
    return resultStr.length > threshold
  }

  // 生成 payloadStore 摘要（发给AI的）
  _generatePayloadSummary(result, toolName) {
    try {
      const obj = typeof result === 'string' ? JSON.parse(result) : result

      // 数组类型（extract_content 等工具返回的批量数据）
      if (Array.isArray(obj)) {
        const count = obj.length
        if (count === 0) return '已获取0条数据（空结果）'

        // 检测核心字段
        const firstItem = obj[0] || {}
        const fieldSet = new Set()
        for (const item of obj.slice(0, 5)) {
          if (item.text) fieldSet.add('text')
          if (item.attrs) {
            for (const k of Object.keys(item.attrs)) fieldSet.add(`attrs.${k}`)
          }
          if (item.title) fieldSet.add('title')
          if (item.href) fieldSet.add('href')
          for (const k of Object.keys(item)) {
            if (!['text', 'attrs', 'title', 'href'].includes(k)) fieldSet.add(k)
          }
        }
        const fields = [...fieldSet].slice(0, 6).join(', ')

        // 样本预览：前3条的关键信息
        const samples = obj.slice(0, 3).map((item, i) => {
          const parts = []
          if (item.attrs?.href) parts.push(`href="${item.attrs.href.slice(0, 50)}"`)
          if (item.title) parts.push(`title="${item.title.slice(0, 30)}"`)
          if (item.text) parts.push(`text="${item.text.slice(0, 40)}"`)
          if (!parts.length) parts.push(JSON.stringify(item).slice(0, 50))
          return `[${i}] ${parts.join(' | ')}`
        }).join('\n  ')

        return `已获取${count}条数据（字段: ${fields}）\n  样本预览:\n  ${samples}${count > 3 ? `\n  ...(共${count}条，可用recall_data查看全部)` : ''}`
      }

      // 对象类型
      if (typeof obj === 'object' && obj !== null) {
        const keys = Object.keys(obj)
        if (obj.ok && obj.pages) {
          const pageCount = obj.pages.length || obj.successCount || 0
          return `处理完成：${pageCount}条结果（字段: ${keys.join(', ')}）`
        }
        if (obj.ok && obj.total) {
          return `处理完成：${obj.total}条结果（字段: ${keys.join(', ')}）`
        }
        // 通用对象：列出字段和值预览
        const fieldPreview = keys.slice(0, 5).map(k => {
          const v = obj[k]
          if (typeof v === 'string') return `${k}="${v.slice(0, 40)}"`
          if (typeof v === 'number') return `${k}=${v}`
          if (Array.isArray(v)) return `${k}=[${v.length}项]`
          return `${k}=...`
        }).join(', ')
        return `已获取数据（${keys.length}个字段: ${fieldPreview}）`
      }

      // 字符串类型
      if (typeof obj === 'string') {
        return `已获取文本数据（${obj.length}字符）: ${obj.slice(0, 60)}...`
      }

      return '已获取数据'
    } catch {
      return '已获取数据'
    }
  }

  // 存入 payloadStore 并返回摘要
  _storeToPayload(result, toolName) {
    const summary = this._generatePayloadSummary(result, toolName)
    const metadata = {
      count: this._getPayloadCount(result),
      sample: this._getPayloadSample(result)
    }
    const entryId = this.payloadStore.add(toolName, result, summary, metadata)
    return `${summary}（存储ID: ${entryId}，详细内容可调用 recall_data 查询）`
  }

  // 获取数据条数
  _getPayloadCount(result) {
    try {
      const obj = typeof result === 'string' ? JSON.parse(result) : result
      if (Array.isArray(obj)) return obj.length
      if (obj.pages) return obj.pages.length
      if (obj.total) return obj.total
      if (typeof obj === 'object') return Object.keys(obj).length
      return 1
    } catch {
      return 1
    }
  }

  // 获取数据样本
  _getPayloadSample(result) {
    try {
      const obj = typeof result === 'string' ? JSON.parse(result) : result
      if (Array.isArray(obj) && obj.length > 0) {
        const first = obj[0]
        if (first.attrs?.href) return first.attrs.href.slice(0, 60)
        if (first.title) return first.title.slice(0, 60)
        if (first.text) return first.text.slice(0, 60)
        return JSON.stringify(first).slice(0, 60)
      }
      return ''
    } catch {
      return ''
    }
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
      // 清空 payloadStore（任务结束后释放内存）
      this.payloadStore.clear()
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
    let enableJudge = true
    let debug = false
    try {
      const agentCfg = await this.configService.getAgentConfig()
      if (agentCfg?.maxRounds >= 5) maxRounds = agentCfg.maxRounds
      if (agentCfg?.maxConsecutiveFails >= 2) MAX_CONSECUTIVE_FAILS = agentCfg.maxConsecutiveFails
      enableJudge = agentCfg?.enableJudge !== false
      debug = agentCfg?.debug === true
    } catch {}
    const _debugLog = (label, detail) => {
      if (!debug) return
      const summary = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)
      console.log(`[AgentDebug] ${label}`, detail)
      try { this.postToUI(tabId, { type: 'agentDebug', label, detail: summary }) } catch(e) { console.warn('[AgentDebug] postToUI失败', e) }
    }
    // 工具调用上限 = 轮次 * 3，最低30，最高200
    const MAX_TOOL_CALLS = Math.min(200, Math.max(30, maxRounds * 3))
    let aiRequestCount = 0      // AI API 请求次数（每次 while 循环 +1）
    let totalToolCalls = 0      // 工具调用总次数（含本地工具，防止无限调用）
    let searchResults = []
    const executedTools = []
    let consecutiveFailCount = 0  // 连续无进展计数（保留作为硬性规则触发器）
    const _injections = []        // 系统注入消息（不写入主消息数组，避免破坏 assistant/tool 交替结构）
    let hasSearchedTools = false  // 自动搜索命中或LLM主动调用 search_tools 后置true
    // ===== 待办调度引擎初始化（三层存储+进度追踪+硬性规则） =====
    this.todoScheduler.clear()
    // 阶段切换由 todoScheduler 管理，本地变量用于构建工具列表
    let currentPhase = 1             // 映射到 todoScheduler.currentStage
    let phase1FailCount = 0
    const PHASE1_FAIL_THRESHOLD = 4
    let phase2FailCount = 0
    const PHASE2_FAIL_THRESHOLD = 3
    // 辅助跟踪（recall_data和selector重复提示）
    const _recallDataCallCount = new Map()
    const _usedSelectorToolCombo = new Set()

    // 清理 chatHistory 中的自定义字段，避免 API 拒绝
    const cleanHistory = (chatHistory || []).map(m => {
      const { toolCalls, tool_calls, ...clean } = m
      return clean
    })

    // ===== 阶段1系统提示词（隔离：仅描述DOM工具，不提及inject_script/阶段2/阶段3） =====
    const phase1SystemPrompt = `你是AI Browser智能体，按照待办调度系统执行任务。

=== 工作流程 ===
1. 调用 create_todo 创建分阶段待办列表（Stage1: DOM工具, Stage2: 远程脚本, Stage3: 汇总）
2. 系统校验待办合规性和数据依赖合法性
3. 按待办顺序执行工具操作
4. 系统客观统计进度，到达阈值自动下发收敛提示
5. 所有待办完成 → 调用 finish_task 汇报结果

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
recall_data: 查询已存储的工具执行结果
create_todo: 创建分阶段待办列表
search_tools: 搜索工具库（如有需要）
finish_task: 任务完成，汇报结果

=== 待办模板 ===
每个子待办需指定:
- action: 使用的工具名称
- dataDependKeys: 依赖的数据key（从之前待办的dataOutputKey获取）
- dataOutputKey: 输出的数据key（供后续待办引用，无输出设为null）

=== 硬性规则（系统强制，无需AI判断） ===
- Stage 1 不暴露 inject_script_* 工具
- 连续4次无进展 → 系统自动切换到Stage 2
- 连续3次脚本失败 → 系统自动切换到Stage 3

=== 导航规则 ===
- navigate_to后页面已加载，直接extract/read获取内容
- 提取内页后立刻go_back或继续下一条

=== 数据存储 ===
- 大量数据自动存储，只发摘要+存储ID
- 需要详情时调用 recall_data(entry_id="xxx")

=== 输出规范 ===
- 自然语言总结结果，不输出原始JSON
- 错误时分析原因并在finish_task中告知`

    const systemMsg = {
      role: 'system',
      content: phase1SystemPrompt,
    }

    // ===== 第一步：自动读取页面内容，了解当前页面 =====
    let autoPageContent = null
    try {
      const targetTab = await this._getTargetTab(tabId)
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

    // ===== 第二步：基于页面内容+用户需求，自动搜索服务端工具库 =====
    let autoSearchKeywords = []
    try {
      // 从用户消息中提取2-4字中文关键词
      const chineseWords = userMessage.match(/[\u4e00-\u9fff]{2,4}/g) || []
      // 从页面内容中提取领域关键词（标题、URL中的语义信息）
      const pageKeywords = []
      if (autoPageContent) {
        // 从URL域名提取领域词
        const urlHost = (autoPageContent.url || '').match(/(?:https?:\/\/)?([^./]+)/)?.[1] || ''
        if (urlHost.length >= 2) pageKeywords.push(urlHost)
        // 从标题中提取关键短词
        const titleWords = (autoPageContent.title || '').match(/[\u4e00-\u9fff]{2,4}/g) || []
        pageKeywords.push(...titleWords.slice(0, 3))
        // 从内容中提取高频短词（简化处理：取前几个中文词）
        const contentWords = (autoPageContent.content || '').match(/[\u4e00-\u9fff]{2,4}/g) || []
        // 过滤常见无关词
        const noiseWords = new Set(['可以', '已经', '但是', '因为', '所以', '或者', '如果', '虽然', '我们', '他们', '这个', '那个', '什么', '怎么', '就是', '也是', '不是', '还是', '只是', '以及', '其中', '其他', '一些', '这些', '那些'])
        const meaningfulContentWords = contentWords.filter(w => !noiseWords.has(w)).slice(0, 5)
        pageKeywords.push(...meaningfulContentWords)
      }
      // 常见任务意图关键词映射（扩展用户消息中可能缺失的搜索词）
      const INTENT_KEYWORDS = {
        '采集': ['采集', '批量'], '批量': ['批量', '采集'], '抓取': ['抓取', '采集'],
        '新闻': ['新闻', '采集'], '导出': ['导出', '下载'], '下载': ['下载', '导出'],
        '翻译': ['翻译'], '监控': ['监控'], '搜索': ['搜索'], '热点': ['热点', '热搜'],
      }
      const expandedWords = new Set(chineseWords)
      for (const word of chineseWords) {
        if (INTENT_KEYWORDS[word]) INTENT_KEYWORDS[word].forEach(w => expandedWords.add(w))
      }
      // 合合页面关键词
      for (const pw of pageKeywords) {
        if (!expandedWords.has(pw)) expandedWords.add(pw)
      }
      autoSearchKeywords = [...expandedWords].slice(0, 6)
    } catch {}

    if (autoSearchKeywords.length > 0) {
      try {
        const autoResults = await this.toolService.searchScripts(autoSearchKeywords.join(' '))
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

    // ===== 将自动读取的页面内容注入到用户消息上下文中，供AI综合分析 =====
    if (autoPageContent) {
      // 精简版页面概览（只保留关键信息，避免上下文膨胀）
      const pageContentBrief = (autoPageContent.content || '').slice(0, 300)
      let pageContextMsg = `[页面概览] 标题: ${autoPageContent.title || '无标题'} | URL: ${autoPageContent.url || ''}\n内容摘要: ${pageContentBrief}`
      if (searchResults.length > 0) {
        pageContextMsg += `\n\n已匹配到 ${searchResults.length} 个专用脚本（当前阶段不暴露脚本工具，如DOM工具无法完成任务将自动切换到脚本模式）。`
      } else {
        pageContextMsg += '\n暂无匹配的专用脚本，可使用本地DOM工具操作页面。'
      }
      _injections.push(pageContextMsg)
      // 缓存页面读取结果，避免后续 read_page_content 重复调用
      const pageUrl = autoPageContent.url || ''
      if (pageUrl) {
        this._pageReadCache.set(pageUrl, JSON.stringify({
          ok: true,
          title: autoPageContent.title || '',
          url: autoPageContent.url || '',
          content: (autoPageContent.content || '').slice(0, 3000),
        }))
      }
    }

    // 避免用户消息重复：chatHistory 可能已包含用户消息（从 sidepanel 传来）
    const lastHistoryMsg = cleanHistory.length > 0 ? cleanHistory[cleanHistory.length - 1] : null
    const lastIsUserMsg = lastHistoryMsg?.role === 'user' && lastHistoryMsg?.content === userMessage
    const messages = lastIsUserMsg
      ? [systemMsg, ...cleanHistory]
      : [systemMsg, ...cleanHistory, { role: 'user', content: userMessage }]

    this.postToUI(tabId, { type: 'agentStart' })
    _debugLog('🐛 调试模式已开启', '待办调度系统：系统驱动进度追踪、收敛提示、阶段切换')

    // ===== 调试：输出配置摘要 =====
    _debugLog('⚙️ Agent配置', { maxRounds, MAX_CONSECUTIVE_FAILS, enableJudge, debug })
    _debugLog('📋 系统提示词', systemMsg.content)

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

      // ===== 系统驱动收敛提示（替代原有AI自主判断的软性规则） =====
      const convergencePrompt = this.todoScheduler.getConvergencePrompt(aiRequestCount, maxRounds)
      if (convergencePrompt) {
        _debugLog('💡 系统收敛提示', convergencePrompt)
        _injections.push(convergencePrompt)
      }

      // ===== 待办进度上下文注入（让AI知道当前待办和进度） =====
      if (this.todoScheduler.parentTodo) {
        const stageCtx = this.todoScheduler.getStageContext()
        if (stageCtx) {
          _injections.push(stageCtx)
        }
      }

      // 获取当前页面URL用于工具过滤
      let currentPageUrl = ''
      try {
        const tab = await this._getTargetTab(tabId)
        currentPageUrl = tab?.url || ''
      } catch {}

      // ===== 阶段状态显示 =====
      this.postToUI(tabId, { type: 'agentStatus', text: `阶段${currentPhase} 第${aiRequestCount}轮` })

      // 根据当前阶段构建工具列表（阶段切换由调度引擎在工具执行后处理）
      let tools
      if (currentPhase === 1) {
        // 阶段1：暴露所有本地DOM工具 + search_tools + finish_task（不暴露inject_script_*）
        tools = this._buildPhase1Tools(userMessage, currentPageUrl, aiRequestCount + 1)
      } else if (currentPhase === 2) {
        // 阶段2：只暴露 search_tools + inject_script_* + read_page_content + recall_data + finish_task
        tools = this._buildPhase2Tools(searchResults, currentPageUrl, aiRequestCount + 1)
      } else {
        // 阶段3：只有 finish_task
        tools = [{
          type: 'function',
          function: {
            name: 'finish_task',
            description: '任务完成，汇报结果',
            parameters: { type: 'object', properties: { summary: { type: 'string', description: '完成摘要' } }, required: ['summary'] }
          }
        }]
      }

      console.log(`[Agent] 阶段${currentPhase} 第${aiRequestCount}轮API请求, tools:${tools.length}个, 已搜到${searchResults.length}个脚本`)
      _debugLog(`🔧 阶段${currentPhase} 第${aiRequestCount}轮 工具(${tools.length}个)`, tools.map(t => `  ${t.function.name}`).join('\n'))

      // ===== 系统消息聚合：将 _injections 合并为单条消息 =====
      const systemNudges = []
      while (_injections.length > 0) {
        systemNudges.push(_injections.shift())
      }
      // 聚合为单条系统消息
      if (systemNudges.length > 0) {
        messages.push({
          role: 'system',
          content: systemNudges.join('\n'),
        })
      }

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
      // 构建发送给 LLM 的消息摘要（日志不截断）
      const msgSummary = messages.map((m, i) => ({
        idx: i,
        role: m.role,
        preview: typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? JSON.stringify(m.content) : String(m.content)),
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
        console.log(`[Agent] 第${aiRequestCount}轮响应:`, msg?.tool_calls?.length ? `tool_calls:${msg.tool_calls.length}` : (msg?.content ? `text:${msg.content}` : 'empty'))

        if (!msg) {
          this.postToUI(tabId, { type: 'agentError', error: 'AI返回为空' })
          return
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          console.log('[Agent] tool_calls:', msg.tool_calls.map(t => t.function.name).join(', '))
          _debugLog(`📥 第${aiRequestCount}轮 LLM响应: tool_calls`, msg.tool_calls.map(t => `${t.function.name}(${JSON.stringify(t.function.arguments || {})})`).join('\n'))

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

            // ===== 工具名称验证：防止LLM调用不存在工具（幻觉） =====
            const allowedToolNames = tools.map(t => t.function.name)
            if (!allowedToolNames.includes(funcName)) {
              const rejectMsg = JSON.stringify({ ok: false, error: `工具 "${funcName}" 不在当前可用工具列表中，调用被拒绝。可用工具：${allowedToolNames.join('、')}。请仅使用列表中的工具。` })
              console.warn(`[Agent] 工具幻觉拦截: ${funcName} 不在当前工具列表中`, allowedToolNames)
              _debugLog('🚫 工具幻觉拦截', { rejected: funcName, allowed: allowedToolNames })
              messages.push({ role: 'tool', tool_call_id: toolCall.id, content: rejectMsg })
              this.postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls + 1, toolName: `${funcName}(幻觉拦截)`, result: rejectMsg, done: false })
              continue  // 跳过执行，不递增 totalToolCalls
            }

            totalToolCalls++
            let _intercepted = false  // 安全拦截标志：仅用于域名安全策略拦截，跳过通用post-processing

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
            if (funcName === 'recall_data') {
              // ===== recall_data 重复查询提醒（不再硬拦截） =====
              const entryIds = (funcArgs.entry_id || '').split(',').map(s => s.trim()).filter(Boolean)
              let overLimitIds = []
              for (const eid of entryIds) {
                const count = (_recallDataCallCount.get(eid) || 0) + 1
                _recallDataCallCount.set(eid, count)
                if (count > 3) overLimitIds.push(`${eid}(已查${count}次)`)
              }
              if (overLimitIds.length > 0) {
                // 温和提示而非硬拦截，允许继续查询
                _injections.push(`💡 提示：以下存储数据已查询3次以上：${overLimitIds.join(', ')}。建议推进下一步操作或调用finish_task，但你可以自主决定。`)
              }
              // 查询 payloadStore（不再阻断查询）
              const queryResult = this.payloadStore.query(funcArgs)
              toolResult = JSON.stringify(queryResult)
              console.log('[Agent] recall_data:', funcArgs, '→', JSON.stringify(queryResult).slice(0, 100))
              this.postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: 'recall_data', result: typeof queryResult === 'object' ? JSON.stringify(queryResult).slice(0, 200) : queryResult, done: false })
            } else if (funcName === 'finish_task') {
              console.log('[Agent] finish_task, summary:', funcArgs.summary)

              // P0: payloadStore 汇总注入（如果有存储数据）
              const payloadSummary = this.payloadStore.getSummaryForFinish()
              if (payloadSummary) {
                const summaryHint = `\n[存储数据汇总] 共${payloadSummary.count}条存储：${payloadSummary.items.map(e => `${e.id}(${e.toolName})`).join(', ')}。需要详细内容可调用 recall_data(entry_id="all")`
                messages.push({ role: 'system', content: summaryHint })
                console.log('[Agent] finish_task payloadStore 汇总:', payloadSummary)
              }

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
              hasSearchedTools = true  // 标记已主动搜索过工具库
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
                const noResultHint = currentPhase === 2
                  ? `未找到与"${query}"匹配的专用脚本。请尝试搜索其他关键词，如果多次搜索无果，请调用finish_task总结当前结果并告知用户需要开发专用脚本。`
                  : `未找到与"${query}"匹配的专用工具。你可以用本地DOM工具直接在页面上操作，也可以尝试搜索其他关键词。`
                toolResult = JSON.stringify({
                  ok: true,
                  result: noResultHint,
                })
              } else {
                toolResult = JSON.stringify(newResults.slice(0, 5).map(t => ({
                  id: t.id, name: t.name, description: t.description,
                  toolType: t.toolType, toolConfig: t.toolConfig ? '已配置' : '未配置',
                })))
              }
              executedTools.push({ name: 'search_tools', result: { ok: newResults.length > 0, count: newResults.length } })
              this.postToUI(tabId, { type: 'agentSearchResult', results: newResults.slice(0, 5) })
            } else if (funcName === 'create_todo') {
              // ===== 系统校验待办合规性和数据依赖合法性 =====
              const submitResult = this.todoScheduler.submitTodo(funcArgs.stages || [])
              if (submitResult.ok) {
                const progress = this.todoScheduler.getProgress()
                toolResult = JSON.stringify({
                  ok: true,
                  result: `待办列表已创建并通过校验：共${progress.total}个待办。系统将按待办顺序驱动执行，自动跟踪进度和切换阶段。当前待办: ${this.todoScheduler.getCurrentTodo()?.id || '无'} - ${this.todoScheduler.getCurrentTodo()?.description || ''}`,
                })
                _debugLog('📋 待办列表已创建', { total: progress.total, currentStage: this.todoScheduler.currentStage })
              } else {
                const errors = submitResult.errors || [submitResult.error || '校验失败']
                toolResult = JSON.stringify({
                  ok: false,
                  error: `待办列表校验失败：\n${errors.join('\n')}\n请修正后重新提交。`,
                })
                _debugLog('❌ 待办校验失败', errors)
              }
              executedTools.push({ name: 'create_todo', result: { ok: submitResult.ok, total: submitResult.totalTodos || 0 } })
              this.postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: 'create_todo', result: toolResult, done: false })
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
                // API 类型脚本成功执行后注入提示，避免 LLM 忽略结果继续重复操作
                if (execResult?.ok && (tool.toolType === 'api' || tool.toolConfig?.apiEndpoint)) {
                  _injections.push(`脚本 ${tool.name} 已成功执行并返回完整结果，可直接基于这些数据继续后续步骤或 finish_task，无需再用其他工具重复获取。`)
                }
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
              // ===== 重复selector+tool组合提醒（不再硬拦截，允许重复执行） =====
              const selectorTools = ['extract_content', 'get_element_info', 'find_text_on_page']
              if (selectorTools.includes(funcName) && funcArgs.selector) {
                const comboKey = `${funcArgs.selector}|${funcName}`
                if (_usedSelectorToolCombo.has(comboKey)) {
                  // 温和提示，不再硬拦截阻断执行
                  _injections.push(`💡 提示：已用 ${funcName} 提取过选择器 "${funcArgs.selector}" 的数据，重复提取可能浪费时间。建议推进下一步操作或调用finish_task，但你可以自主决定。`)
                }
                _usedSelectorToolCombo.add(comboKey)
              }
              // 统一执行逻辑：域名安全策略检查 → 预算提示 → 正常执行
              // P1: navigate_to 执行前检查域名安全策略
              if (funcName === 'navigate_to' && !this._isUrlAllowed(funcArgs.url)) {
                toolResult = JSON.stringify({ ok: false, error: `导航被安全策略阻止：${funcArgs.url} 不在允许的域名范围内。请用finish_task告知用户。` })
                executedTools.push({ name: `${funcName}(域名被拦截)`, result: toolResult })
                this.postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
                messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
                _intercepted = true
              } else if (funcName === 'navigate_to' && aiRequestCount / maxRounds >= 0.85) {
                // 预算接近上限时温和提示（不再硬拦截，继续执行）
                _debugLog('💡 预算提示: navigate_to接近预算上限', { round: aiRequestCount, maxRounds })
                _injections.push(`💡 提示：已使用${Math.round(aiRequestCount / maxRounds * 100)}%预算，导航新页面可能消耗较多轮次。请评估剩余轮次能否完成，如不能请调用finish_task汇总已有结果。`)
                // 继续正常执行导航
                const targetTab = await this._getTargetTab(tabId)
                if (!targetTab) {
                  toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用（可能已关闭或导航到了系统页面）。必须用finish_task告知用户。' })
                } else {
                  this.postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: funcArgs, status: 'running' })
                  const domResult = await Promise.race([
                    this.executeDOMTool(targetTab.id, funcName, funcArgs),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('动作超时')), this.ACTION_TIMEOUT_MS))
                  ]).catch(e => ({ ok: false, error: e.message }))
                  toolResult = JSON.stringify(domResult)
                  executedTools.push({ name: funcName, result: domResult })
                }
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
              // 导航类动作 → 终止后续调用（排除失败的情况）
              if (['navigate_to', 'go_back', 'go_forward'].includes(funcName) && !toolResult.includes('域名被拦截') && !toolResult.includes('"ok":false')) {
                shouldTerminateSequence = true
              }
            } else {
              toolResult = JSON.stringify({ ok: false, error: `未知工具: ${funcName}` })
            }

            // ===== 拦截跳过：拦截块已自行处理tool消息和UI，跳过通用post-processing =====
            if (_intercepted) continue

            // ===== 阶段失败计数已在无进展检测中处理 =====

            // 工具执行结果调试（不截断）
            _debugLog(`⚙️ 工具结果: ${funcName}`, toolResult || '')

            // ===== 待办调度：匹配工具调用到当前待办，记录输出数据 =====
            const matchedTodo = this.todoScheduler.matchToolCall(funcName)
            let hasProgress = false
            try {
              const parsed = JSON.parse(toolResult)
              // 明确失败 → 无进展
              if (parsed?.ok === false) {
                hasProgress = false
                if (matchedTodo) this.todoScheduler.markTodoResult('failed')
              }
              // search_tools 找到结果 → 有进展
              else if (funcName === 'search_tools') {
                const results = Array.isArray(parsed) ? parsed : parsed?.result
                hasProgress = Array.isArray(results) && results.length > 0
                if (matchedTodo && hasProgress) this.todoScheduler.markTodoResult('done', parsed)
                else if (matchedTodo) this.todoScheduler.markTodoResult('failed')
              }
              // recall_data 返回数据 → 有进展
              else if (funcName === 'recall_data') {
                const data = parsed?.data || parsed?.result || parsed
                if (parsed?.error) {
                  hasProgress = false
                } else if (Array.isArray(data) && data.length > 0) {
                  hasProgress = true
                } else if (data && typeof data === 'object' && !Array.isArray(data)) {
                  hasProgress = (data.count > 0) || (data.entries?.length > 0) || (Array.isArray(data.data) && data.data.length > 0)
                } else if (typeof data === 'string' && data.length > 10 && !data.includes('无存储数据') && !data.includes('未找到')) {
                  hasProgress = true
                }
                if (matchedTodo && hasProgress) this.todoScheduler.markTodoResult('done', parsed)
              }
              // create_todo → 有进展
              else if (funcName === 'create_todo') {
                hasProgress = parsed?.ok === true
                if (hasProgress && matchedTodo) this.todoScheduler.markTodoResult('done', parsed)
              }
              // ok=true 或 无ok字段但有有效内容 → 有进展
              else if (parsed?.ok === true || parsed?.ok === undefined) {
                const hasContent = parsed?.result !== undefined && String(parsed.result).length > 0
                  || parsed?.content !== undefined && String(parsed.content).length > 0
                  || parsed?.title !== undefined
                hasProgress = hasContent && !parsed?.error
                // 匹配到待办且有进展 → 记录输出数据
                if (matchedTodo && hasProgress) {
                  this.todoScheduler.markTodoResult('done', parsed)
                }
              }
            } catch {
              // JSON 解析失败 → 无进展
            }

            // 检查硬性规则：是否应该切换阶段
            const stageSwitch = this.todoScheduler.shouldSwitchStage()
            if (stageSwitch.switch) {
              _debugLog('🔄 硬性规则触发阶段切换', stageSwitch)
              this.todoScheduler.forceSwitchToStage(stageSwitch.to)
              currentPhase = stageSwitch.to
              phase1FailCount = 0
              phase2FailCount = 0
              consecutiveFailCount = 0
              // 阶段切换时注入上下文（复用现有的阶段切换逻辑）
              if (stageSwitch.to === 2) {
                // 切换到Stage2：构建隔离提示词
                let scriptList = ''
                if (searchResults.length > 0) {
                  scriptList = '\n\n=== 已匹配的专用脚本 ===\n' + searchResults.map(s => {
                    const params = s.toolConfig?.parameters?.properties ? Object.keys(s.toolConfig.parameters.properties) : []
                    const paramHint = params.length > 0 ? `（参数: ${params.join(', ')}）` : ''
                    return `  - inject_script_${s.id}(${s.name})${paramHint}: ${(s.description || '').slice(0, 80)}`
                  }).join('\n')
                }
                const phase2Prompt = `你是AI Browser智能体，现在使用远程专用脚本执行任务。

=== 工作流程 ===
1. 查看待办列表中Stage 2的子待办
2. 如需数据参数，先 recall_data 获取已收集的数据
3. 调用 inject_script_* 执行脚本
4. 完成后 → finish_task

=== Stage 2 可用工具 ===
search_tools, inject_script_*, recall_data, read_page_content, finish_task

=== 脚本使用指南 ===
- 直接调用匹配到的脚本，不要犹豫
- 如果脚本需要URL列表参数，先 recall_data 获取
- 脚本执行成功后，基于结果直接 finish_task
- 多次搜索无果或脚本失败 → 调用 finish_task 总结失败原因${scriptList}`

                // 注入阶段1数据摘要
                let dataSummary = ''
                const summaries = this.todoScheduler.globalDataStore.getAllSummaries()
                if (summaries.length > 0) {
                  dataSummary = '\n\n=== 全局存储数据 ===\n  ' + summaries.join('\n  ')
                  const allUrls = this.todoScheduler.globalDataStore.getAllUrls()
                  if (allUrls.length > 0) {
                    dataSummary += `\n\n💡 已有${allUrls.length}个URL链接，可直接传给inject_script_*作为参数。`
                  }
                }
                // 重置消息历史
                messages.length = 0
                messages.push({ role: 'system', content: phase2Prompt })
                messages.push({ role: 'user', content: userMessage + (dataSummary || '\n\n（无已收集数据，请直接使用脚本或搜索工具库。）') })
                _debugLog('🔄 Stage2提示词已注入', { scriptCount: searchResults.length, dataKeys: summaries.length })
              } else if (stageSwitch.to === 3) {
                // 切换到Stage3：数据汇总
                const allData = this.todoScheduler.globalDataStore.getAllSummaries()
                const phase3Prompt = `你是AI Browser智能体，正在执行Stage 3数据汇总。

=== 工作流程 ===
1. 查看全局存储中的所有数据摘要
2. 生成结构化汇总：数据条数、核心字段、样本预览
3. 调用 finish_task 输出汇总

=== Stage 3 可用工具 ===
finish_task, recall_data

=== 全局存储数据 ===
${allData.length > 0 ? allData.join('\n') : '（无数据）'}`

                messages.length = 0
                messages.push({ role: 'system', content: phase3Prompt })
                messages.push({ role: 'user', content: userMessage + '\n\n请汇总所有已收集的数据并输出最终结果。' })
                _debugLog('🔄 Stage3提示词已注入', { dataKeys: allData.length })
              }
            }

            // 使用更强烈的 nudge 重置无进展计数
            if (hasProgress) {
              consecutiveFailCount = 0
              // 阶段失败计数也重置（有进展说明当前阶段有效）
              if (currentPhase === 1) phase1FailCount = 0
              if (currentPhase === 2) phase2FailCount = 0
            } else {
              consecutiveFailCount++
              // 阶段失败计数：阶段1所有无进展都计，阶段2只有inject_script_*失败才计
              if (currentPhase === 1) {
                phase1FailCount++
                _debugLog('📊 阶段1失败计数', { phase1FailCount, round: aiRequestCount, tool: funcName })
              }
              if (currentPhase === 2) {
                // 阶段2只计脚本执行失败，search_tools/recall_data是信息收集不算失败
                if (funcName.startsWith('inject_script_') || funcName.includes('inject_script')) {
                  phase2FailCount++
                  phase2ScriptAttempted = true
                  _debugLog('📊 阶段2脚本失败计数', { phase2FailCount, round: aiRequestCount, tool: funcName })
                }
                // 如果没有脚本可用，search_tools多次搜索无结果也算失败
                else if (funcName === 'search_tools' && searchResults.length === 0) {
                  phase2FailCount++
                  _debugLog('📊 阶段2搜索无果计数', { phase2FailCount, round: aiRequestCount })
                }
                // 其他工具在阶段2不计为失败
              }
              console.warn('[Agent] 无进展 #' + consecutiveFailCount, funcName, toolResult)
            }

            if (consecutiveFailCount >= MAX_CONSECUTIVE_FAILS) {
              _debugLog('💡 提示: 连续无进展较多', { consecutiveFailCount, max: MAX_CONSECUTIVE_FAILS, phase: currentPhase })
              // 根据当前阶段给出不同提示
              if (currentPhase === 1) {
                phase1FailCount += MAX_CONSECUTIVE_FAILS  // 批量计入阶段1失败，加速阶段切换
                _injections.push(`💡 阶段1提示：已连续${consecutiveFailCount}次操作无进展。如果DOM工具无法完成任务，将自动切换到阶段2（远程脚本库模式）。`)
              } else if (currentPhase === 2) {
                phase2FailCount += 1
                _injections.push(`💡 阶段2提示：已连续${consecutiveFailCount}次操作无进展。请尝试搜索其他关键词或调用finish_task。`)
              }
              // 重置通用计数
              consecutiveFailCount = 0
            }

            this.postToUI(tabId, {
              type: 'agentStepResult',
              step: totalToolCalls,
              toolName: funcName,
              result: toolResult,
              done: false,
            })

            // P0: PayloadStore 存储判断（超过阈值的结果存payloadStore，只发摘要给AI）
            let finalResult
            if (this._shouldStoreToPayload(toolResult, funcName)) {
              finalResult = this._storeToPayload(toolResult, funcName)
              console.log('[Agent] payloadStore 存储:', funcName, '→ ID:', this.payloadStore.entries[this.payloadStore.entries.length - 1]?.id)
            } else {
              // P3: 智能截断过长的工具结果（保留结构）
              finalResult = this._smartTruncateResult(toolResult)
            }

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: finalResult,
            })

            await new Promise(r => setTimeout(r, 200))
          }

          // 防止 messages 上下文无限膨胀：滑动窗口 + 分级摘要压缩
          const MAX_MESSAGES = 40
          if (messages.length > MAX_MESSAGES) {
            // 保留最近的 60% 消息，压缩更早的
            const keepRecent = Math.floor(MAX_MESSAGES * 0.6)
            let cutOff = messages.length - keepRecent

            // 向前调整切割点：确保不在 assistant(tool_calls)+tool 配对中间切割
            if (cutOff > 1) {
              while (cutOff < messages.length && messages[cutOff]?.role === 'tool') {
                cutOff++
              }
            }

            if (cutOff > 1) {
              // 构建 tool_call_id → toolName 映射（从 assistant.tool_calls 获取）
              const toolNameMap = new Map()
              for (let i = 1; i < cutOff; i++) {
                const m = messages[i]
                if (m.role === 'assistant' && m.tool_calls) {
                  for (const tc of m.tool_calls) {
                    toolNameMap.set(tc.id, tc.function.name)
                  }
                }
              }

              // === 消息分级收集 ===
              // S级：链接列表、批量采集结果（完整保留）
              const sLevelParts = []
              // A级：关键操作摘要（navigate成功/404、create_todo、search_tools、inject_script结果）
              const aLevelParts = []
              // B级：一般操作结论（read_page_content、extract_content正文压缩为结论）
              const bLevelParts = []
              // C级：系统提示（合并去重）
              const cLevelMessages = []

              for (let i = 1; i < cutOff; i++) {
                const m = messages[i]

                if (m.role === 'tool' && m.content) {
                  const toolName = toolNameMap.get(m.tool_call_id) || ''
                  try {
                    const parsed = JSON.parse(m.content)

                    // S级：extract_content 返回含 href 的链接列表
                    if (toolName === 'extract_content' && parsed?.ok && Array.isArray(parsed.result)) {
                      const hasHref = parsed.result.some(item => item?.attrs?.href)
                      if (hasHref) {
                        // 提取为结构化链接清单
                        const links = parsed.result
                          .filter(item => item?.attrs?.href && item?.text)
                          .map(item => {
                            const url = item.attrs.href
                            const title = item.text.slice(0, 30)
                            return `${url} | ${title}`
                          })
                        if (links.length > 0) {
                          sLevelParts.push(`[链接列表(${links.length}条)]\n${links.join('\n')}`)
                        }
                        continue
                      }
                    }

                    // S级：inject_script_* 返回批量采集结果
                    if (toolName.startsWith('inject_script_') && parsed?.ok && parsed?.result) {
                      const resultStr = typeof parsed.result === 'string'
                        ? parsed.result.slice(0, 500)
                        : JSON.stringify(parsed.result).slice(0, 500)
                      sLevelParts.push(`[脚本${toolName}结果] ${resultStr}`)
                      continue
                    }

                    // A级：navigate_to 结果
                    if (toolName === 'navigate_to') {
                      const isOk = parsed?.ok
                      const resultText = typeof parsed?.result === 'string' ? parsed.result : ''
                      const is404 = resultText.includes('404') || resultText.includes('not found') || resultText.includes('没有找到')
                      aLevelParts.push(isOk && !is404
                        ? `✓ 导航成功: ${resultText.slice(0, 60)}`
                        : `✗ 导航失败(404): ${resultText.slice(0, 60)}`)
                      continue
                    }

                    // A级：create_todo / search_tools 结果
                    if (toolName === 'create_todo' || toolName === 'search_tools') {
                      const summary = typeof parsed?.result === 'string'
                        ? parsed.result.slice(0, 120)
                        : JSON.stringify(parsed.result || '').slice(0, 120)
                      aLevelParts.push(`[${toolName}] ${summary}`)
                      continue
                    }

                    // B级：其他工具结果（压缩为结论）
                    if (parsed?.ok && parsed?.result) {
                      const resultStr = typeof parsed.result === 'string'
                        ? parsed.result.slice(0, 100)
                        : JSON.stringify(parsed.result).slice(0, 100)
                      bLevelParts.push(`[${toolName || '工具'}] ${resultStr}`)
                    } else if (parsed?.error) {
                      bLevelParts.push(`[${toolName || '工具'}] 错误: ${String(parsed.error).slice(0, 60)}`)
                    }
                  } catch {
                    // JSON 解析失败，简单保留
                    bLevelParts.push(`[工具结果] ${m.content.slice(0, 60)}`)
                  }
                } else if (m.role === 'system' && m.content) {
                  // C级：系统提示（收集后合并去重）
                  cLevelMessages.push(m.content)
                }
                // assistant 消息不单独保留（其信息已体现在 tool 结果中）
              }

              // === C级合并去重 ===
              const cLevelParts = []
              // 合并"页面连续N步无变化"
              const stagnantMsgs = cLevelMessages.filter(s => s.includes('没有变化') || s.includes('无变化'))
              const otherSystemMsgs = cLevelMessages.filter(s => !s.includes('没有变化') && !s.includes('无变化'))
              if (stagnantMsgs.length > 0) {
                // 提取最大步数
                const steps = stagnantMsgs.map(s => parseInt(s.match(/(\d+)\s*步/)?.[1] || '0'))
                const maxStep = Math.max(...steps)
                cLevelParts.push(`页面连续${steps.length}次检测无变化(最大${maxStep}步)`)
              }
              // 其他系统提示去重
              const seen = new Set()
              for (const s of otherSystemMsgs) {
                const key = s.slice(0, 40)
                if (!seen.has(key)) { seen.add(key); cLevelParts.push(s.slice(0, 80)) }
              }

              // === 组装摘要 ===
              const summarySections = []
              if (sLevelParts.length > 0) summarySections.push(sLevelParts.join('\n'))
              if (aLevelParts.length > 0) summarySections.push(aLevelParts.join('\n'))
              if (bLevelParts.length > 0) summarySections.push(bLevelParts.slice(-6).join('\n'))
              if (cLevelParts.length > 0) summarySections.push(cLevelParts.join('\n'))

              const summaryMsg = {
                role: 'system',
                content: `[上下文摘要] 以下为早期操作摘要：\n${summarySections.join('\n')}\n---\n原始用户需求: ${userMessage.slice(0, 200)}`,
              }
              // 删除早期消息，插入摘要
              messages.splice(1, cutOff - 1, summaryMsg)
            }

            // 安全网：移除孤立的 tool 消息（没有对应 assistant tool_calls 的）
            const validToolCallIds = new Set()
            for (const m of messages) {
              if (m.role === 'assistant' && m.tool_calls) {
                for (const tc of m.tool_calls) validToolCallIds.add(tc.id)
              }
            }
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === 'tool' && !validToolCallIds.has(messages[i].tool_call_id)) {
                console.warn('[Agent] 移除孤立tool消息:', messages[i].tool_call_id)
                messages.splice(i, 1)
              }
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

    // 写入 chatHistory，让 sidepanel 通过 storage.onChanged 感知完成并清理 streaming 状态
    _debugLog('🛑 Agent终止: 达到最大轮次', { maxRounds, executedToolsCount: executedTools.length })
    const finalNote = `⚠️ Agent 已达到最大请求次数（${maxRounds} 轮）。任务可能未完成，请简化需求后重试。`
    const toolCallsSummary = executedTools.length > 0
      ? executedTools.filter(t => !t.name?.includes('search_tools') && !t.name?.includes('read_page_content')).slice(0, 15)
      : []
    await this._saveToChatHistoryStorage(tabId, finalNote, toolCallsSummary)
  }
}
