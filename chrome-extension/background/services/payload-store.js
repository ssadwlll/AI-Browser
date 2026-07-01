// ============ PayloadStore ============
// 工具结果暂存区：超过阈值的结果存此处，只发摘要给AI
export class PayloadStore {
  constructor() {
    this.entries = []
    this.maxEntries = 20
    this.maxRecallChars = 5000  // recall_data 单次返回上限
  }

  // 存储数据
  add(toolName, data, summary, metadata) {
    if (this.entries.length >= this.maxEntries) {
      this.entries.shift()  // FIFO淘汰
    }
    const entry = {
      id: `p${this.entries.length + 1}`,
      toolName,
      timestamp: Date.now(),
      data,
      summary,
      metadata: metadata || {}
    }
    this.entries.push(entry)
    return entry.id
  }

  // 查询数据
  query(options = {}) {
    let results = []

    // 按 entry_id 查询
    if (options.entry_id) {
      const ids = options.entry_id.split(',').map(s => s.trim())
      results = this.entries.filter(e => ids.includes(e.id))
    }
    // 按 tool_name 查询最新
    else if (options.tool_name) {
      const entry = this.entries.filter(e => e.toolName === options.tool_name).pop()
      if (entry) results = [entry]
    }
    // 查全部（返回汇总）
    else {
      return this._summaryAll()
    }

    // 应用 filter
    if (options.filter && results.length > 0) {
      results = this._applyFilter(results, options.filter)
    }

    // 应用 fields
    if (options.fields && results.length > 0) {
      results = this._applyFields(results, options.fields)
    }

    // 格式化并检查大小
    const formatted = this._formatResult(results)
    const charCount = JSON.stringify(formatted).length

    if (charCount > this.maxRecallChars) {
      // 不再返回warning阻塞LLM，而是自动截断返回核心数据
      // 对数组数据：保留前5条 + 总数摘要
      const truncated = this._autoTruncate(formatted, this.maxRecallChars)
      if (truncated) {
        truncated._note = `原始结果${charCount}字符已自动截断至核心数据。如需更多可指定 filter="前N条" 或 fields="指定字段"。`
        return truncated
      }
      // 截断失败时才返回摘要（兜底）
      return {
        summary: this._summarizeEntries(results),
        _note: `数据量较大，返回摘要。使用 filter="前N条" 或 fields="指定字段" 缩小范围获取详细数据。`
      }
    }

    return formatted
  }

  // 汇总所有条目
  _summaryAll() {
    return {
      summary: this.entries.map(e => `${e.id}(${e.toolName}:${e.metadata.count || 1}条)`).join(', ') || '无存储数据',
      hint: '调用 recall_data(entry_id="xxx") 查询具体条目'
    }
  }

  // 应用过滤条件
  _applyFilter(entries, filter) {
    const parsed = this._parseFilter(filter)
    if (!parsed) return entries

    return entries.map(entry => {
      const data = Array.isArray(entry.data) ? entry.data : [entry.data]
      let filtered = data

      if (parsed.type === 'range') {
        filtered = data.slice(parsed.start, parsed.end)
      } else if (parsed.type === 'first') {
        filtered = data.slice(0, parsed.n)
      } else if (parsed.type === 'keyword') {
        filtered = data.filter(item => {
          const text = item.text || item.title || item.content || JSON.stringify(item)
          return text.includes(parsed.keyword)
        })
      }

      return { ...entry, data: filtered }
    })
  }

  // 解析过滤条件
  _parseFilter(filter) {
    // "前N条"
    const firstMatch = filter.match(/前(\d+)条/)
    if (firstMatch) return { type: 'first', n: parseInt(firstMatch[1]) }

    // "第N-M条"
    const rangeMatch = filter.match(/第(\d+)[-~](\d+)条/)
    if (rangeMatch) return { type: 'range', start: parseInt(rangeMatch[1]) - 1, end: parseInt(rangeMatch[2]) }

    // "含关键词xxx"
    const keywordMatch = filter.match(/含(.+)/)
    if (keywordMatch) return { type: 'keyword', keyword: keywordMatch[1] }

    // 其他尝试作为关键词
    return { type: 'keyword', keyword: filter }
  }

  // 应用字段选择
  _applyFields(entries, fields) {
    const fieldList = fields.split(',').map(s => s.trim())

    return entries.map(entry => {
      const data = Array.isArray(entry.data) ? entry.data : [entry.data]

      const projected = data.map(item => {
        const newItem = {}
        for (const f of fieldList) {
          if (item[f] !== undefined) newItem[f] = item[f]
          if (item.attrs && item.attrs[f] !== undefined) newItem[f] = item.attrs[f]
        }
        // 如果没有匹配任何字段，保留原始（可能是数组或对象）
        if (Object.keys(newItem).length === 0) return item
        return newItem
      })

      return { ...entry, data: projected }
    })
  }

  // 格式化结果
  _formatResult(entries) {
    if (entries.length === 0) return { error: '未找到匹配数据' }

    const allData = entries.flatMap(e => Array.isArray(e.data) ? e.data : [e.data])

    if (entries.length === 1 && allData.length <= 10) {
      return allData
    }

    return {
      count: allData.length,
      entries: entries.map(e => ({ id: e.id, count: Array.isArray(e.data) ? e.data.length : 1 })),
      data: allData
    }
  }

  // 条目摘要
  _summarizeEntries(entries) {
    return entries.map(e => `${e.id}: ${e.summary || `${Array.isArray(e.data) ? e.data.length : 1}条数据`}`).join('\n')
  }

  // 自动截断大结果，保留核心数据
  _autoTruncate(formatted, maxChars) {
    try {
      // 如果是数组：保留前5条
      if (Array.isArray(formatted)) {
        const kept = formatted.slice(0, 5)
        const resultStr = JSON.stringify(kept)
        if (resultStr.length <= maxChars) {
          return { total: formatted.length, shown: kept.length, data: kept }
        }
        // 5条也太大，进一步压缩每条
        const compressed = kept.map(item => {
          if (item.text) return { text: item.text.slice(0, 50), attrs: item.attrs }
          return JSON.stringify(item).slice(0, 80)
        })
        return { total: formatted.length, shown: compressed.length, data: compressed }
      }
      // 如果是对象含data数组：截断data
      if (formatted.data && Array.isArray(formatted.data)) {
        const kept = formatted.data.slice(0, 5)
        const resultStr = JSON.stringify(kept)
        if (resultStr.length <= maxChars) {
          return { ...formatted, data: kept, total: formatted.data.length, shown: kept.length }
        }
        const compressed = kept.map(item => {
          if (item.text) return { text: item.text.slice(0, 50), attrs: item.attrs }
          return JSON.stringify(item).slice(0, 80)
        })
        return { ...formatted, data: compressed, total: formatted.data.length, shown: compressed.length }
      }
      // 字符串：直接截断
      if (typeof formatted === 'string') {
        return formatted.slice(0, maxChars)
      }
      return null
    } catch {
      return null
    }
  }

  // 清空
  clear() {
    this.entries = []
  }

  // 列出所有条目ID（用于阶段2上下文注入）
  listEntryIds() {
    return this.entries.map(e => e.id)
  }

  // 获取单个条目摘要（用于阶段2上下文注入）
  getEntrySummary(entryId) {
    const entry = this.entries.find(e => e.id === entryId)
    if (!entry) return null
    // 如果数据包含URL列表（常见于extract_content结果），提取URL摘要
    const data = entry.data
    if (Array.isArray(data)) {
      const urls = data.filter(d => d.attrs?.href).map(d => d.attrs.href)
      if (urls.length > 0) {
        return `${data.length}条数据，含${urls.length}个URL链接（可直接传给inject_script_*批量采集）`
      }
      return `${data.length}条数据: ${entry.summary || '结构化内容'}`
    }
    return entry.summary || `${typeof data === 'string' ? data.slice(0, 50) : '1条数据'}`
  }

  // 获取指定条目的URL列表（用于直接传给脚本）
  getEntryUrls(entryId) {
    const entry = this.entries.find(e => e.id === entryId)
    if (!entry) return []
    const data = entry.data
    if (!Array.isArray(data)) return []
    return data.filter(d => d.attrs?.href).map(d => d.attrs.href)
  }

  // 获取汇总（用于finish_task）
  getSummaryForFinish() {
    if (this.entries.length === 0) return null
    return {
      count: this.entries.length,
      items: this.entries.map(e => ({ id: e.id, toolName: e.toolName, summary: e.summary }))
    }
  }
}
