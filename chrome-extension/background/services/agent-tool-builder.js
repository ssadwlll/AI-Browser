// ============ 工具定义构建器 ============
// 构建统一的 LLM 工具定义列表
// 依赖：scriptService（域名过滤）、filteredScriptsCache、domainMismatchLogged
import { getTemplateList } from '../../shared/report-templates.js'

/**
 * 过滤并缓存域名匹配的脚本
 */
function filterScripts(searchResults, currentPageUrl, scriptService, filteredScriptsCache, domainMismatchLogged) {
  if (!searchResults || searchResults.length === 0) return []
  const result = []
  for (const s of searchResults.slice(0, 12)) {
    if (result.length >= 6) break
    if (s.urlPattern && s.urlPattern !== '*' && currentPageUrl) {
      if (!scriptService.matchUrl(s.urlPattern, currentPageUrl)) {
        const msgKey = `${s.id}_${currentPageUrl || '__no_url__'}`
        if (!domainMismatchLogged.has(msgKey)) {
          domainMismatchLogged.add(msgKey)
          console.log(`[Agent] 脚本域名不匹配，跳过: ${s.name} (urlPattern=${s.urlPattern})`)
        }
        continue
      }
    }
    result.push(s)
  }
  return result
}

/**
 * 按经验记忆排序并构建脚本工具定义
 */
function buildScriptToolDefs(scripts) {
  const sortedScripts = [...scripts].sort((a, b) => {
    const rateA = a.memoryTotal > 0 ? (a.memorySuccess || 0) / a.memoryTotal : -1
    const rateB = b.memoryTotal > 0 ? (b.memorySuccess || 0) / b.memoryTotal : -1
    return rateB - rateA
  })

  const tools = []
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
  return tools
}

/**
 * 构建统一工具定义（单阶段，所有工具可用）
 */
export function buildTools(searchResults, currentPageUrl, round, scriptService, filteredScriptsCache, domainMismatchLogged) {
  const tools = []

  // === DOM 工具 ===

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

  tools.push({
    type: 'function',
    function: {
      name: 'get_interactive_elements',
      description: '获取页面可交互元素列表（链接、按钮、输入框等），每个元素带 index 编号。一次性了解页面结构后立即行动，不要在每轮重复调用。零LLM成本。',
      parameters: {
        type: 'object',
        properties: {
          selectorHint: { type: 'string', description: '可选：限定查询的CSS选择器范围。不传则返回所有可交互元素' },
          return_mode: { type: 'string', description: '返回模式："summary"(概览+schema)或"full"(存储全量数据，返回schema摘要)。默认summary' },
        },
        required: [],
      },
    },
  })

  tools.push({
    type: 'function',
    function: {
      name: 'detect_page_template',
      description: '分析当前页面 DOM 结构，识别页面类型（如列表页/详情页/搜索结果/表格页）并推荐常用数据字段的选择器。任务开始时调用一次可大幅减少后续试错。零LLM成本。',
      parameters: {
        type: 'object',
        properties: {
          sample_limit: { type: 'number', description: '可选：分析的容器样本数上限，默认5' },
        },
        required: [],
      },
    },
  })

  tools.push({
    type: 'function',
    function: {
      name: 'find_text_on_page',
      description: '在页面文本中搜索关键词，返回匹配数量、位置摘要。零LLM成本，优先使用。',
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
      description: '用CSS选择器查询DOM元素，返回数量、文本摘要和属性。采集数据请用 extract_content。零LLM成本。',
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
      description: '用CSS选择器批量提取页面元素的文本内容和属性。采集列表数据的主力工具。零LLM成本。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS选择器，支持:contains("文本")过滤' },
          multiple: { type: 'boolean', description: '是否返回多条结果。列表采集设为true。默认true' },
          limit: { type: 'number', description: '最多返回条数，默认10，最大50' },
          attributes: { type: 'string', description: '逗号分隔的要提取的属性名。提取链接时必传"href"' },
          return_mode: { type: 'string', description: '返回模式："summary"(概览+schema)或"full"(存储全量数据，返回schema摘要)。默认summary' },
        },
        required: ['selector'],
      },
    },
  })

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
      description: '悬停页面元素（触发下拉菜单、tooltip等）',
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
      description: '选择<select>下拉框选项',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: '下拉框CSS选择器' },
          value: { type: 'string', description: '选项文本或value值' },
          by: { type: 'string', description: '匹配方式: "text"(默认), "value", "index"' },
        },
        required: ['selector', 'value'],
      },
    },
  })

  tools.push({
    type: 'function',
    function: {
      name: 'press_key',
      description: '发送键盘操作（Escape关闭弹窗、Enter确认等）',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '按键，如"Escape", "Enter", "PageDown"' },
          selector: { type: 'string', description: '可选：聚焦此元素后按键' },
        },
        required: ['key'],
      },
    },
  })

  tools.push({
    type: 'function',
    function: {
      name: 'screenshot_visible',
      description: '截取当前可视区域截图',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  })

  tools.push({
    type: 'function',
    function: {
      name: 'navigate_to',
      description: '直接导航到指定URL',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标URL' },
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

  // === 脚本工具（搜索结果中的匹配脚本）===
  const filteredScripts = filterScripts(searchResults, currentPageUrl, scriptService, filteredScriptsCache, domainMismatchLogged)
  if (filteredScripts.length > 0) {
    tools.push(...buildScriptToolDefs(filteredScripts))
  }

  // === generate_script（动态代码执行）===
  tools.push({
    type: 'function',
    function: {
      name: 'generate_script',
      description: '动态生成并执行JS代码，运行在页面上下文（MAIN world）。可执行任意JS逻辑：操作DOM、处理已存储数据(window.__store.pX)、同源fetch等。代码在 async 函数中执行，可直接使用 await。必须用 return 返回结果。返回 HTML 字符串（以 < 开头）时，框架会自动用 iframe 渲染为可视化报告。注意：受页面 CSP 限制，部分严格 CSP 的站点（如新浪）可能拒绝执行；跨域 fetch 受 CORS 限制，需用 fetch_url 工具。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要执行的JS代码。\n- 运行在 async 函数体中，可直接使用 await（无需包 async IIFE）\n- 必须用 return 返回结果；未 return 或返回空值会报错\n- 通过 window.__store.p1 访问 data_refs 注入的数据\n- 可用 document.querySelector、DOMParser 等操作当前页面 DOM\n- 跨域 fetch 会受 CORS 限制，改用 fetch_url 工具\n- 受页面 CSP 限制，若报 unsafe-eval 错误请改用 inject_script_N 或 DOM 工具\n- 返回 HTML 字符串（以 < 开头）会自动渲染为报告\n\n例1（数据处理）: return window.__store.p1.filter(x => x.text.length > 5)\n例2（HTML报告）: return `<div class="card"><h3>${item.title}</h3><p>${item.body}</p></div>`\n例3（同源fetch）: const r = await fetch("/api/data"); return await r.json()\n例4（批量处理）: const items = window.__store.p1; return items.map(x => ({title: x.text, url: x.attrs.href}))' },
          data_refs: { type: 'array', items: { type: 'string' }, description: '引用的数据ID列表，如 ["p1","p2"]。系统会把全量数据注入到 window.__store 供 code 访问' },
          description: { type: 'string', description: '代码功能简述（便于追踪）' },
        },
        required: ['code'],
      },
    },
  })

  // === fetch_url（后台代理 fetch，突破 CORS）===
  tools.push({
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '在扩展后台发起网络请求，突破页面 CORS 限制（manifest 已配 host_permissions: <all_urls>）。适用于跨域获取 HTML/JSON 数据。返回响应文本（字符串）。如需解析 HTML，可将结果存入 data_refs 后用 generate_script 配合 DOMParser 处理（注意 CSP 限制）。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '请求 URL' },
          method: { type: 'string', description: 'HTTP 方法，默认 GET' },
          headers: { type: 'object', description: '请求头，如 { "User-Agent": "Mozilla/5.0" }' },
          body: { type: 'string', description: '请求体（POST/PUT 时使用）' },
          return_mode: { type: 'string', description: '返回模式："text"(默认,返回响应文本) 或 "json"(尝试解析为JSON)' },
        },
        required: ['url'],
      },
    },
  })

  // === create_todo（扁平列表）===
  tools.push({
    type: 'function',
    function: {
      name: 'create_todo',
      description: '创建待办列表。系统校验后按顺序驱动执行。简单任务（1-2步可完成）无需创建，直接执行即可。复杂任务建议在第1轮创建。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: '待办列表',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '待办ID，如 "t1"' },
                action: { type: 'string', description: '工具名称。可用：extract_content / inject_script_N / click_element / navigate_to / read_page_content / generate_script / render_report / finish_task。其中 generate_script 用于代码执行类步骤（fetch/DOM操作/数据处理等），render_report 用预设模板渲染数据报告' },
                description: { type: 'string', description: '待办描述' },
              },
              required: ['id', 'action', 'description'],
            },
          },
        },
        required: ['items'],
      },
    },
  })

  // === render_report（模板化报告渲染）===
  // AI 选模板 + 框架套模板渲染，比 generate_script 写 HTML 更稳定
  // 模板从后端 report_templates 表加载（agent-runner 启动时预加载），加载失败降级用内置模板
  const _templateList = getTemplateList()
  const _templateDesc = _templateList.map(t => `· ${t.id}（${t.name}）: ${t.description}`).join('\n')
  tools.push({
    type: 'function',
    function: {
      name: 'render_report',
      description: `用预设模板渲染数据报告，比 generate_script 写 HTML 更稳定。模板渲染后用户可在 UI 切换其他模板。可选模板：\n${_templateDesc}`,
      parameters: {
        type: 'object',
        properties: {
          template_id: { type: 'string', description: '模板ID，如 news_card_list / data_table / timeline / product_grid' },
          data_refs: { type: 'array', items: { type: 'string' }, description: '数据引用ID列表，如 ["p1"]。数据应为数组形式' },
          field_mapping: { type: 'object', description: '可选，字段映射。key=模板字段名，value=数据字段名。如数据字段名为 link，模板字段为 url，传 {url: "link"}。不传则按模板字段名自动匹配' },
          title: { type: 'string', description: '可选，报告标题' },
        },
        required: ['template_id', 'data_refs'],
      },
    },
  })

  // === finish_task ===
  tools.push({
    type: 'function',
    function: {
      name: 'finish_task',
      description: '任务完成，汇报结果。系统会自动从存储获取引用数据并格式化输出。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '完成摘要' },
          data_refs: { type: 'string', description: '引用的数据ID列表（逗号分隔，如"p1,p2"）' },
        },
        required: ['summary'],
      },
    },
  })

  return tools
}

// 保留旧函数名作为别名（兼容期）
export function buildPhase1Tools(currentPageUrl, round, scriptService, filteredScriptsCache, domainMismatchLogged) {
  return buildTools([], currentPageUrl, round, scriptService, filteredScriptsCache, domainMismatchLogged)
}

export function buildPhase2Tools(searchResults, currentPageUrl, round, scriptService, filteredScriptsCache, domainMismatchLogged) {
  return buildTools(searchResults, currentPageUrl, round, scriptService, filteredScriptsCache, domainMismatchLogged)
}
