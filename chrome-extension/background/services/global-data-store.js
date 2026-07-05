// ============ GlobalDataStore ============
// 任务级持久存储：任务全程共享，自动生成数据摘要
// 每个 entry 由 dataOutputKey 索引，供 inject_script_N 通过 window.__store 访问全量数据
export class GlobalDataStore {
  constructor() {
    this.entries = new Map()  // key → { value, summary, sourceTodo, timestamp }
    this.maxEntries = 20     // 防止内存无限增长
  }

  /**
   * 存储数据，自动生成摘要
   * @param {string} key - dataOutputKey（如 "news_links"、"page_content"）
   * @param {*} value - 工具执行结果
   * @param {string} sourceTodo - 来源待办ID
   */
  set(key, value, sourceTodo = '') {
    // 已存在的 key 直接覆盖（不算新条目）
    const isUpdate = this.entries.has(key)
    const summary = this._generateSummary(value)
    this.entries.set(key, {
      value,
      summary,
      sourceTodo,
      timestamp: Date.now(),
    })
    // 超过上限时淘汰最旧条目（FIFO，基于 timestamp）
    if (!isUpdate && this.entries.size > this.maxEntries) {
      let oldestKey = null
      let oldestTs = Infinity
      for (const [k, e] of this.entries) {
        if (e.timestamp < oldestTs) {
          oldestTs = e.timestamp
          oldestKey = k
        }
      }
      if (oldestKey) {
        this.entries.delete(oldestKey)
        console.warn(`[GlobalDataStore] 超过上限 ${this.maxEntries}，淘汰旧条目: ${oldestKey}`)
      }
    }
    console.log(`[GlobalDataStore] set "${key}": ${summary.slice(0, 60)}`)
  }

  /**
   * 获取原始数据
   */
  get(key) {
    return this.entries.get(key)?.value ?? null
  }

  /**
   * 获取数据摘要
   */
  getSummary(key) {
    return this.entries.get(key)?.summary ?? null
  }

  /**
   * 检查 key 是否存在
   */
  has(key) {
    return this.entries.has(key)
  }

  /**
   * 获取所有数据摘要
   */
  getAllSummaries() {
    const result = []
    for (const [key, entry] of this.entries) {
      result.push(`${key}: ${entry.summary}`)
    }
    return result
  }

  /**
   * 查询数据
   * @param {object} options - { entry_id, tool_name }
   */
  query(options = {}) {
    const entryId = options.entry_id?.trim() || ''

    // 按 entry_id 查询
    if (entryId) {
      const ids = entryId.split(',').map(s => s.trim())
      if (ids.includes('all')) {
        return this._formatAll()
      }
      const matched = []
      for (const id of ids) {
        if (this.entries.has(id)) {
          const entry = this.entries.get(id)
          matched.push({ id, key: id, value: entry.value, summary: entry.summary, source: entry.sourceTodo })
        }
      }
      if (matched.length === 0) return { error: '未找到匹配数据', queriedKeys: ids }
      return { entries: matched, count: matched.length, source: 'GlobalDataStore' }
    }

    // 按 tool_name 查询（匹配 key 前缀或 sourceTodo）
    if (options.tool_name) {
      const matched = []
      for (const [key, entry] of this.entries) {
        if (key.startsWith(options.tool_name) || entry.sourceTodo === options.tool_name) {
          matched.push({ id: key, key, value: entry.value, summary: entry.summary, source: entry.sourceTodo })
        }
      }
      if (matched.length === 0) return { error: '未找到匹配数据', toolName: options.tool_name }
      return { entries: matched, count: matched.length, source: 'GlobalDataStore' }
    }

    // 无参数返回汇总
    return this._formatAll()
  }

  _formatAll() {
    const entries = []
    for (const [key, entry] of this.entries) {
      entries.push({ id: key, key, summary: entry.summary, source: entry.sourceTodo, timestamp: entry.timestamp })
    }
    if (entries.length === 0) return { error: '全局存储为空', count: 0 }
    return { entries, count: entries.length, source: 'GlobalDataStore' }
  }

  /**
   * 生成数据摘要
   */
  _generateSummary(value) {
    try {
      // 尝试解析JSON，失败则保持原始字符串
      let obj = value
      if (typeof value === 'string') {
        try { obj = JSON.parse(value) } catch { obj = value }
      }

      // 数组类型
      if (Array.isArray(obj)) {
        const count = obj.length
        if (count === 0) return '0条数据（空结果）'
        const fields = new Set()
        for (const item of obj.slice(0, 5)) {
          if (item?.text) fields.add('text')
          if (item?.attrs) for (const k of Object.keys(item.attrs)) fields.add(`attrs.${k}`)
          if (item?.title) fields.add('title')
          if (item?.href) fields.add('href')
          for (const k of Object.keys(item)) {
            if (!['text', 'attrs', 'title', 'href'].includes(k)) fields.add(k)
          }
        }
        const fieldList = [...fields].slice(0, 6).join(', ')
        const sample = obj.slice(0, 2).map(item => {
          if (item?.attrs?.href) return item.text?.slice(0, 30) || item.attrs.href.slice(0, 40)
          if (item?.title) return item.title.slice(0, 30)
          if (item?.text) return item.text.slice(0, 30)
          return JSON.stringify(item).slice(0, 30)
        }).join(', ')
        return `${count}条数据（字段: ${fieldList}）: ${sample}${count > 2 ? '...' : ''}`
      }

      // 对象类型
      if (typeof obj === 'object' && obj !== null) {
        const keys = Object.keys(obj)
        if (obj.ok && typeof obj.total === 'number') return `${obj.total}条结果`
        if (obj.data && Array.isArray(obj.data)) return `${obj.data.length}条数据`
        return `${keys.length}个字段: ${keys.slice(0, 5).join(', ')}`
      }

      // 字符串
      if (typeof obj === 'string') {
        return `${obj.length}字符: ${obj.slice(0, 50)}${obj.length > 50 ? '...' : ''}`
      }

      return '已存储'
    } catch {
      return '已存储'
    }
  }

  /**
   * 清空（任务结束时释放内存）
   */
  clear() {
    this.entries.clear()
  }
}
