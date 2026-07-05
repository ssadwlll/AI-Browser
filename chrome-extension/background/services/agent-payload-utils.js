// ============ PayloadStore 工具函数（纯函数，无 this 依赖） ============

/**
 * 从数据中自动检测 schema（字段名→类型）
 * 取前2条数据合并字段，生成类型映射
 */
export function autoDetectSchema(items) {
  if (!Array.isArray(items) || items.length === 0) return null
  const schema = {}
  const samples = items.slice(0, 2)
  for (const item of samples) {
    if (!item || typeof item !== 'object') continue
    // 处理扁平字段
    for (const [k, v] of Object.entries(item)) {
      if (k === 'attrs' && typeof v === 'object' && v !== null) {
        // 展开 attrs 子字段
        for (const [ak, av] of Object.entries(v)) {
          const key = `attrs.${ak}`
          if (!schema[key]) schema[key] = Array.isArray(av) ? 'array' : typeof av
        }
        continue
      }
      if (!schema[k]) schema[k] = Array.isArray(v) ? 'array' : typeof v
    }
  }
  return Object.keys(schema).length > 0 ? schema : null
}

/**
 * 提取2条截断样例数据（用于摘要，控制长度）
 */
export function extractSamples(items, maxFieldLen = 60) {
  if (!Array.isArray(items) || items.length === 0) return []
  return items.slice(0, 2).map(item => {
    if (!item || typeof item !== 'object') return String(item).slice(0, maxFieldLen)
    const truncated = {}
    for (const [k, v] of Object.entries(item)) {
      if (k === 'attrs' && typeof v === 'object' && v !== null) {
        truncated.attrs = {}
        for (const [ak, av] of Object.entries(v)) {
          truncated.attrs[ak] = typeof av === 'string' ? av.slice(0, maxFieldLen) : av
        }
        continue
      }
      truncated[k] = typeof v === 'string' ? v.slice(0, maxFieldLen) : v
    }
    return truncated
  })
}

/**
 * 标准化工具输出为统一信封格式
 * {items, schema, count, source, sample}
 * 所有数据工具的输出经此包装后格式一致
 */
export function normalizePayload(raw, toolName) {
  // 已经是标准信封格式
  if (raw && typeof raw === 'object' && raw._envelope === true) return raw

  // 统一为对象
  let obj = raw
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw) } catch { obj = null }
  }

  // null/undefined
  if (obj == null) {
    return { _envelope: true, items: [], schema: null, count: 0, source: toolName, sample: [] }
  }

  // 提取数据数组：支持多种嵌套结构
  let items = []
  if (Array.isArray(obj)) {
    items = obj
  } else if (obj.ok && Array.isArray(obj.result)) {
    items = obj.result
  } else if (obj.ok && obj.result && Array.isArray(obj.result.elements)) {
    items = obj.result.elements
  } else if (Array.isArray(obj.pages)) {
    // inject_script 批量结果
    items = obj.pages
  } else if (obj.ok && obj.result && Array.isArray(obj.result.pages)) {
    // inject_script_N 返回 {ok, result: {pages: [...], total, successCount}}，剥离包装层
    items = obj.result.pages
  } else if (typeof obj === 'object') {
    // 单对象包装为数组
    items = [obj]
  }

  const schema = autoDetectSchema(items)
  const sample = extractSamples(items)

  return { _envelope: true, items, schema, count: items.length, source: toolName, sample }
}

/**
 * 生成 schema+样例 的摘要文本（用于 messages 注入）
 * 格式：p1(tool): 15条(数组) | {field:string, ...} | 样例: [...]
 * 关键：标注数据类型（数组/对象/字符串），让 AI 知道 window.__store.p1 的实际格式
 */
export function formatSchemaSummary(entryId, toolName, envelope) {
  const countStr = `${envelope.count}条`
  // 标注数据类型，让AI知道 window.__store.pX 的实际结构
  // 注意：存储的始终是数组，长度1时需用 [0] 访问元素
  const dataType = envelope.items.length > 1 ? `数组(长度${envelope.items.length})` : envelope.items.length === 1 ? '长度1的数组' : '空数组'
  const schemaStr = envelope.schema
    ? Object.entries(envelope.schema).map(([k, v]) => `${k}:${v}`).join(', ')
    : '未知结构'
  const sampleStr = envelope.sample && envelope.sample.length > 0
    ? JSON.stringify(envelope.sample).slice(0, 150)
    : ''
  let result = `${entryId}(${toolName}): ${countStr}(${dataType}) | {${schemaStr}}`
  if (sampleStr) result += ` | 样例: ${sampleStr}`
  return result
}

/**
 * 判断工具结果是否需要存入 payloadStore
 * 关键：大数据存储，小数据智能截断
 */
export function shouldStoreToPayload(result, toolName) {
  // 这些工具结果不需要存储（查询类/搜索类）
  if (toolName === 'search_tools') return false
  if (toolName === 'create_todo') return false
  if (toolName === 'finish_task') return false
  
  // 数据采集类工具：降低阈值，更容易触发存储
  // extract_content、get_interactive_elements、inject_script 等通常返回大数据
  const dataTools = ['extract_content', 'get_interactive_elements', 'inject_script', 'read_page_content']
  const threshold = dataTools.includes(toolName) ? 800 : 1500
  
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
  return resultStr.length > threshold
}

/**
 * 生成 payloadStore 摘要（发给 AI 的）
 */
function generatePayloadSummary(result, toolName) {
  try {
    const obj = typeof result === 'string' ? JSON.parse(result) : result

    // 数组类型
    if (Array.isArray(obj)) {
      const count = obj.length
      if (count === 0) return '已获取0条数据（空结果）'
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
      const samples = obj.slice(0, 3).map((item, i) => {
        const parts = []
        if (item.attrs?.href) parts.push(`href="${item.attrs.href.slice(0, 50)}"`)
        if (item.title) parts.push(`title="${item.title.slice(0, 30)}"`)
        if (item.text) parts.push(`text="${item.text.slice(0, 40)}"`)
        if (!parts.length) parts.push(JSON.stringify(item).slice(0, 50))
        return `[${i}] ${parts.join(' | ')}`
      }).join('\n  ')
      return `已获取${count}条数据（字段: ${fields}）\n  样本预览:\n  ${samples}${count > 3 ? `\n  ...(共${count}条)` : ''}`
    }

    // 对象类型
    if (typeof obj === 'object' && obj !== null) {
      const keys = Object.keys(obj)
      // 含 result 数组时，展开数组的样本预览
      if (Array.isArray(obj.result) && obj.result.length > 0) {
        const count = obj.result.length
        const fieldSet = new Set()
        for (const item of obj.result.slice(0, 5)) {
          if (typeof item !== 'object' || item === null) { fieldSet.add(String(item)); continue }
          if (item.text) fieldSet.add('text')
          if (item.attrs) { for (const k of Object.keys(item.attrs)) fieldSet.add(`attrs.${k}`) }
          if (item.title) fieldSet.add('title')
          if (item.href) fieldSet.add('href')
          for (const k of Object.keys(item)) {
            if (!['text', 'attrs', 'title', 'href'].includes(k)) fieldSet.add(k)
          }
        }
        const fields = [...fieldSet].slice(0, 6).join(', ')
        const samples = obj.result.slice(0, 5).map((item, i) => {
          if (typeof item !== 'object' || item === null) return `[${i}] ${String(item).slice(0, 50)}`
          const parts = []
          if (item.attrs?.href) parts.push(`href="${item.attrs.href.slice(0, 50)}"`)
          if (item.title) parts.push(`title="${item.title.slice(0, 30)}"`)
          if (item.text) parts.push(`text="${item.text.slice(0, 40)}"`)
          if (!parts.length) parts.push(JSON.stringify(item).slice(0, 50))
          return `[${i}] ${parts.join(' | ')}`
        }).join('\n  ')
        return `已获取${count}条数据（字段: ${fields}）\n  样本预览:\n  ${samples}${count > 5 ? `\n  ...(共${count}条)` : ''}`
      }
      // 嵌套数组：obj.result.elements (get_interactive_elements)
      if (obj.result && typeof obj.result === 'object' && Array.isArray(obj.result.elements) && obj.result.elements.length > 0) {
        const count = obj.result.elements.length
        const samples = obj.result.elements.slice(0, 5).map((el, i) => {
          const parts = []
          if (el.href) parts.push(`href="${el.href.slice(0, 50)}"`)
          if (el.text) parts.push(`text="${el.text.slice(0, 30)}"`)
          if (el.selector) parts.push(`selector="${el.selector.slice(0, 40)}"`)
          if (el.index !== undefined) parts.push(`index=${el.index}`)
          if (!parts.length) parts.push(JSON.stringify(el).slice(0, 50))
          return `[${i}] ${parts.join(' | ')}`
        }).join('\n  ')
        return `已获取${count}个可交互元素\n  样本预览:\n  ${samples}${count > 5 ? `\n  ...(共${count}个元素)` : ''}\n  提示: ${obj.result.hint?.slice(0, 80) || '使用 click_element 配合 selector 或 index 参数进行交互'}`
      }
      if (obj.ok && obj.pages) {
        const pageCount = obj.pages.length || obj.successCount || 0
        return `处理完成：${pageCount}条结果（字段: ${keys.join(', ')}）`
      }
      if (obj.ok && obj.total) {
        return `处理完成：${obj.total}条结果（字段: ${keys.join(', ')}）`
      }
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

/**
 * 存入 payloadStore 并返回带 schema+样例 的截断结果
 * 关键改进：AI能看到schema+样例，无需额外查询即可理解数据结构
 */
export async function storeToPayload(payloadStore, result, toolName, envelope) {
  const summary = generatePayloadSummary(result, toolName)
  // 使用标准化信封的 schema 和 sample
  const metadata = envelope
    ? { count: envelope.count, schema: envelope.schema, sample: envelope.sample }
    : { count: getPayloadCount(result), sample: getPayloadSample(result) }
  const entryId = await payloadStore.add(toolName, result, summary, metadata)
  // 写入失败：返回错误提示，让调用方（agent-runner）记录为失败工具结果
  if (entryId === null) {
    return `${smartTruncateResult(result, 2500)}\n\n[注意：数据存储失败，inject_script_N 将无法通过 window.__store 访问全量数据。可重新尝试或缩小数据量]`
  }
  // 返回 schema+样例摘要（而非大段样本数据），让AI理解数据结构
  if (envelope) {
    const schemaSummary = formatSchemaSummary(entryId, toolName, envelope)
    const typeHint = envelope.items.length > 1
      ? `window.__store.${entryId} 是数组（长度${envelope.items.length}），可直接 .filter()/.map()/.forEach() 遍历`
      : envelope.items.length === 1
      ? `window.__store.${entryId} 是长度为1的数组，访问元素用 window.__store.${entryId}[0]`
      : `window.__store.${entryId} 为空`
    return `${schemaSummary}\n完整数据已存储(ID:${entryId})，inject_script_N 可通过 window.__store.${entryId} 访问。${typeHint}。`
  }
  // 兜底：无 envelope 时走旧逻辑
  const truncatedData = smartTruncateResult(result, 2500)
  return `${truncatedData}\n\n[完整数据已存储(ID:${entryId})，共${metadata.count}条。inject_script_N 可通过 window.__store.${entryId} 访问]`
}

/**
 * 获取数据条数
 */
function getPayloadCount(result) {
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

/**
 * 获取数据样本
 */
function getPayloadSample(result) {
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

/**
 * 智能结果截断（按结构截断，非一刀切）
 * 兼容字符串与对象输入
 * 支持嵌套数组结构：obj.result.elements、obj.pages 等
 */
export function smartTruncateResult(result, maxLen = 2000) {
  // 统一为字符串处理
  if (result == null) return ''
  if (typeof result !== 'string') {
    try {
      result = JSON.stringify(result)
    } catch {
      result = String(result)
    }
  }
  if (result.length <= maxLen) return result
  try {
    const obj = JSON.parse(result)
    if (Array.isArray(obj)) {
      return JSON.stringify({
        total: obj.length,
        items: obj.slice(0, 10),
        _truncated: obj.length > 10
      })
    }
    if (typeof obj === 'object' && obj !== null) {
      // 含 result 数组时，截断数组
      if (Array.isArray(obj.result) && obj.result.length > 5) {
        const truncated = { ...obj, result: obj.result.slice(0, 5), _total: obj.result.length, _truncated: true }
        const s = JSON.stringify(truncated)
        if (s.length <= maxLen) return s
        // 仍然超长，进一步精简
        const minimal = { ...obj, result: obj.result.slice(0, 3).map(item => {
          if (typeof item !== 'object' || item === null) return item
          const mini = {}
          if (item.text) mini.text = item.text.slice(0, 40)
          if (item.attrs?.href) mini.href = item.attrs.href.slice(0, 60)
          if (item.title) mini.title = item.title.slice(0, 40)
          return Object.keys(mini).length > 0 ? mini : item
        }), _total: obj.result.length, _truncated: true }
        return JSON.stringify(minimal)
      }
      // 嵌套数组：obj.result.elements (get_interactive_elements)
      if (obj.result && typeof obj.result === 'object' && Array.isArray(obj.result.elements) && obj.result.elements.length > 5) {
        const truncatedResult = {
          ...obj.result,
          elements: obj.result.elements.slice(0, 10),
          _total_elements: obj.result.elements.length,
          _truncated: true
        }
        const truncated = { ...obj, result: truncatedResult }
        const s = JSON.stringify(truncated)
        if (s.length <= maxLen) return s
        // 超长时进一步精简元素
        const minimalElements = obj.result.elements.slice(0, 5).map(el => ({
          href: el.href?.slice(0, 50),
          text: el.text?.slice(0, 30),
          selector: el.selector?.slice(0, 40),
          index: el.index
        }))
        const minimal = {
          ok: obj.ok,
          result: {
            elements: minimalElements,
            hint: obj.result.hint?.slice(0, 80),
            listed: obj.result.listed,
            total: obj.result.total,
            _truncated: true
          }
        }
        return JSON.stringify(minimal)
      }
      // obj.pages 数组 (inject_script 批量结果)
      if (Array.isArray(obj.pages) && obj.pages.length > 5) {
        const truncated = { ...obj, pages: obj.pages.slice(0, 5), _total_pages: obj.pages.length, _truncated: true }
        const s = JSON.stringify(truncated)
        if (s.length <= maxLen) return s
      }
      // 其他字符串字段截断
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'string' && obj[key].length > 500) {
          obj[key] = obj[key].slice(0, 500) + '...(truncated)'
        }
      }
      const s = JSON.stringify(obj)
      if (s.length <= maxLen) return s
    }
  } catch {}
  return result.slice(0, maxLen) + `\n...(结果过长已截断，共${result.length}字符)`
}

/**
 * 构建数据概览（用于 return_mode="summary"）
 * 精简返回，不被截断，让 AI 了解数据内容并自主决定是否需要完整数据
 */
export function buildDataOverview(result, toolName) {
  try {
    const obj = typeof result === 'string' ? JSON.parse(result) : result
    
    // 处理 extract_content 结果 {ok, result: [...]}
    if (obj.ok && Array.isArray(obj.result)) {
      const data = obj.result
      
      // 按通用规则评分（不预设类型）
      const scoredItems = data.map(item => {
        const text = item.text || ''
        const hasAttrs = item.attrs && Object.keys(item.attrs).length > 0
        const attrCount = hasAttrs ? Object.keys(item.attrs).length : 0
        
        let score = 0
        if (text.length > 15) score += 3     // 长文本（内容）
        if (text.length > 30) score += 1     // 更长文本
        if (hasAttrs) score += 2             // 有属性（更丰富）
        if (attrCount > 2) score += 1        // 多个属性
        
        return { item, score, textLen: text.length }
      })
      
      // 分类：高分（有意义） vs 低分（简单）
      const highScore = scoredItems.filter(s => s.score >= 3)
      const lowScore = scoredItems.filter(s => s.score < 3)
      
      // 去重低分数据（导航通常重复）
      const uniqueLowScore = []
      const seenText = new Set()
      for (const s of lowScore) {
        const shortText = s.textLen <= 10 ? (s.item.text || '').slice(0, 10) : ''
        if (shortText && !seenText.has(shortText)) {
          seenText.add(shortText)
          uniqueLowScore.push(s)
        }
        if (uniqueLowScore.length >= 3) break
      }
      
      // 构建概览
      const sampleItems = [
        ...highScore.slice(0, 10).map(s => s.item),  // 有意义的样本
        ...uniqueLowScore.slice(0, 3).map(s => s.item)  // 简单数据样本（去重）
      ]
      
      return {
        ok: obj.ok,
        _overview: {
          total: data.length,
          structure: '数组，每项含 {text, attrs}',
          sample: sampleItems,
          content_count: highScore.length,   // 有意义数据数量
          simple_count: lowScore.length      // 简单数据数量
        },
        _hint: generateOverviewHint(highScore.length, lowScore.length)
      }
    }
    
    // 处理 get_interactive_elements 结果 {ok, result: {elements: [...], ...}}
    if (obj.ok && obj.result && Array.isArray(obj.result.elements)) {
      const elements = obj.result.elements
      
      // 按文本长度筛选有意义元素
      const richElements = elements.filter(el => (el.text || '').length > 10)
      const simpleElements = elements.filter(el => (el.text || '').length <= 10)
      
      return {
        ok: obj.ok,
        _overview: {
          total: elements.length,
          structure: '数组，每项含 {href, text, selector, index}',
          sample: [...richElements.slice(0, 5), ...simpleElements.slice(0, 3)],
          rich_count: richElements.length,
          simple_count: simpleElements.length
        },
        _hint: `已获取${elements.length}个可交互元素（${richElements.length}个有文本+${simpleElements.length}个无文本）`,
        result: {
          hint: obj.result.hint,
          listed: obj.result.listed,
          total: obj.result.total
        }
      }
    }
    
    // 其他类型：直接返回概览
    return {
      ok: obj.ok,
      _overview: {
        total: Array.isArray(obj.result) ? obj.result.length : 1,
        structure: typeof obj.result,
        sample: Array.isArray(obj.result) ? obj.result.slice(0, 5) : [obj.result]
      },
      _hint: `已获取数据，完整数据已存储`
    }
  } catch (e) {
    return { ok: false, _overview: { error: e.message } }
  }
}

/**
 * 生成概览提示信息
 */
function generateOverviewHint(contentCount, simpleCount) {
  if (contentCount > 10) {
    return `已显示10条有意义样本（共${contentCount}条）+${simpleCount}条简单数据。inject_script_N 可通过 window.__store.存储ID 访问全量数据`
  }
  if (contentCount > 0) {
    return `已显示全部${contentCount}条有意义数据。另有${simpleCount}条简单数据。inject_script_N 可通过 window.__store.存储ID 访问全量数据`
  }
  return `已显示样本。inject_script_N 可通过 window.__store.存储ID 访问全量数据`
}
