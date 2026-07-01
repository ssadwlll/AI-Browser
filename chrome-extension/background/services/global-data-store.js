// ============ GlobalDataStore ============
// 跨阶段持久存储：Stage1/2/3 全程共享，自动生成数据摘要
// 每个 entry 由 dataOutputKey 索引，供后续待办通过 dataDependKeys 引用
export class GlobalDataStore {
  constructor() {
    this.entries = new Map()  // key → { value, summary, sourceTodo, timestamp }
  }

  /**
   * 存储数据，自动生成摘要
   * @param {string} key - dataOutputKey（如 "news_links"、"page_content"）
   * @param {*} value - 工具执行结果
   * @param {string} sourceTodo - 来源待办ID
   */
  set(key, value, sourceTodo = '') {
    const summary = this._generateSummary(value)
    this.entries.set(key, {
      value,
      summary,
      sourceTodo,
      timestamp: Date.now(),
    })
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
   * 检查 key 是否存在（用于数据依赖校验）
   */
  has(key) {
    return this.entries.has(key)
  }

  /**
   * 批量检查依赖是否满足
   */
  areDependenciesSatisfied(dataDependKeys = []) {
    return dataDependKeys.every(k => this.entries.has(k))
  }

  /**
   * 获取所有数据摘要（用于阶段切换时注入上下文）
   */
  getAllSummaries() {
    const result = []
    for (const [key, entry] of this.entries) {
      result.push(`${key}: ${entry.summary}`)
    }
    return result
  }

  /**
   * 获取指定 key 中的 URL 列表（用于脚本参数注入）
   */
  getUrls(key) {
    const value = this.get(key)
    if (value === null || value === undefined) return []
    try {
      let obj = value
      if (typeof value === 'string') {
        try { obj = JSON.parse(value) } catch { obj = value }
      }
      if (Array.isArray(obj)) {
        return obj.filter(item => item?.attrs?.href).map(item => item.attrs.href)
      }
      if (obj?.data && Array.isArray(obj.data)) {
        return obj.data.filter(item => item?.attrs?.href).map(item => item.attrs.href)
      }
    } catch {}
    return []
  }

  /**
   * 获取所有 URL（跨所有 key）
   */
  getAllUrls() {
    const urls = []
    for (const key of this.entries.keys()) {
      urls.push(...this.getUrls(key))
    }
    return urls
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
   * 兼容 PayloadStore.query 接口，供 recall_data 回退查询
   */
  query(options = {}) {
    // 按 entry_id 查询（映射为 key）
    if (options.entry_id) {
      const ids = options.entry_id.split(',').map(s => s.trim())
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
    // 查全部
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
   * 清空（任务结束时释放内存）
   */
  clear() {
    this.entries.clear()
  }
}
