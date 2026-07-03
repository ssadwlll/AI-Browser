// ============ 工具定义构建器 ============
// 构建各阶段的 LLM 工具定义列表（buildToolDefinitions, buildPhase1Tools, buildPhase2Tools）
// 依赖：scriptService（域名过滤）、filteredScriptsCache、domainMismatchLogged

/**
 * 过滤并缓存域名匹配的脚本
 * @returns {Array} 过滤后的脚本列表
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
 * 按经验记忆排序并构建工具定义
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
 * 构建完整工具定义（Phase 1 使用，包含所有 DOM 工具）
 */
function buildToolDefinitions(searchResults, currentPageUrl, round, scriptService, filteredScriptsCache, domainMismatchLogged) {
  const tools = []

  // 核心工具
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
          selectorHint: { type: 'string', description: '可选：限定查询的CSS选择器范围，如"a.news-item"。不传则返回所有可交互元素' },
          return_mode: { type: 'string', description: '返回模式："summary"(概览，显示样本元素)或"full"(完整列表)。默认summary' },
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
          return_mode: { type: 'string', description: '返回模式："summary"(概览，用于查看数据结构)或"full"(完整数据，用于下一步处理)。默认summary' },
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

  // 搜索结果中的脚本工具
  const filteredScripts = filterScripts(searchResults, currentPageUrl, scriptService, filteredScriptsCache, domainMismatchLogged)
  if (filteredScripts.length > 0) {
    tools.push(...buildScriptToolDefs(filteredScripts))
  }

  // recall_data
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

  // create_todo
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

  // finish_task
  tools.push({
    type: 'function',
    function: {
      name: 'finish_task',
      description: '任务完成，汇报结果。系统会自动从存储获取引用数据并格式化输出。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '完成摘要' },
          data_refs: { type: 'string', description: '引用的数据ID列表（逗号分隔，如"p1,p2"）。系统会自动获取完整数据并注入到输出中' },
        },
        required: ['summary'],
      },
    },
  })

  return tools
}

/**
 * Phase 1 工具列表：本地 DOM 工具 + search_tools + finish_task（不含 inject_script_*）
 */
export function buildPhase1Tools(currentPageUrl, round, scriptService, filteredScriptsCache, domainMismatchLogged) {
  return buildToolDefinitions([], currentPageUrl, round, scriptService, filteredScriptsCache, domainMismatchLogged)
}

/**
 * Phase 2 工具列表：search_tools + inject_script_* + read_page_content + recall_data + finish_task
 */
export function buildPhase2Tools(searchResults, currentPageUrl, round, scriptService, filteredScriptsCache, domainMismatchLogged) {
  const tools = []

  // search_tools
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

  // read_page_content
  tools.push({
    type: 'function',
    function: {
      name: 'read_page_content',
      description: '读取当前页面标题、URL和正文。用于向脚本提供页面上下文。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  })

  // recall_data
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
  const filteredScripts = filterScripts(searchResults, currentPageUrl, scriptService, filteredScriptsCache, domainMismatchLogged)
  if (filteredScripts.length > 0) {
    tools.push(...buildScriptToolDefs(filteredScripts))
  }

  // finish_task
  tools.push({
    type: 'function',
    function: {
      name: 'finish_task',
      description: '任务完成，汇报结果。阶段2失败时也调用此工具总结失败原因和建议。系统会自动从存储获取引用数据并格式化输出。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '完成摘要或失败原因分析' },
          data_refs: { type: 'string', description: '引用的数据ID列表（逗号分隔，如"p1,p2"）。系统会自动获取完整数据并注入到输出中' },
        },
        required: ['summary'],
      },
    },
  })

  return tools
}
