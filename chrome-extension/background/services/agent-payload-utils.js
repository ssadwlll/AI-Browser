// ============ PayloadStore 工具函数（纯函数，无 this 依赖） ============

/**
 * 判断工具结果是否需要存入 payloadStore
 */
export function shouldStoreToPayload(result, toolName) {
  if (toolName === 'recall_data') return false
  if (toolName === 'search_tools') return false
  const threshold = 1500
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
 * 存入 payloadStore 并返回摘要
 */
export function storeToPayload(payloadStore, result, toolName) {
  const summary = generatePayloadSummary(result, toolName)
  const metadata = {
    count: getPayloadCount(result),
    sample: getPayloadSample(result)
  }
  const entryId = payloadStore.add(toolName, result, summary, metadata)
  return `${summary}（存储ID: ${entryId}，详细内容可调用 recall_data 查询）`
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
