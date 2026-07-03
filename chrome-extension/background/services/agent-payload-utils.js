// ============ PayloadStore 工具函数（纯函数，无 this 依赖） ============

/**
 * 判断工具结果是否需要存入 payloadStore
 * 关键：大数据存储，小数据智能截断
 */
export function shouldStoreToPayload(result, toolName) {
  // 这些工具结果不需要存储（查询类/搜索类）
  if (toolName === 'recall_data') return false
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
      return `已获取${count}条数据（字段: ${fields}）\n  样本预览:\n  ${samples}${count > 3 ? `\n  ...(共${count}条，可用recall_data查看全部)` : ''}`
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
 * 存入 payloadStore 并返回带样本的截断结果
 * 关键改进：AI能看到前10条样本数据，无需recall_data即可理解内容
 */
export function storeToPayload(payloadStore, result, toolName) {
  const summary = generatePayloadSummary(result, toolName)
  const metadata = {
    count: getPayloadCount(result),
    sample: getPayloadSample(result)
  }
  const entryId = payloadStore.add(toolName, result, summary, metadata)
  // 返回截断后的样本数据（而非纯摘要），让AI直接看到内容，减少recall_data需求
  const truncatedData = smartTruncateResult(result, 2500)
  return `${truncatedData}\n\n[完整数据已存储(ID:${entryId})，共${metadata.count}条。如需更多数据可用 recall_data(entry_id="${entryId}") 查询]`
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
    return `已显示10条有意义样本（共${contentCount}条）+${simpleCount}条简单数据。如需完整数据，调用时设置 return_mode="full"`
  }
  if (contentCount > 0) {
    return `已显示全部${contentCount}条有意义数据。另有${simpleCount}条简单数据。如需完整数据，设置 return_mode="full"`
  }
  return `已显示样本。如需完整数据，设置 return_mode="full"`
}
