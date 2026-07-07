// ============ GlobalDataStore（Electron 主进程版） ============
// 任务级全局数据存储：纯内存 Map 实现，任务全程共享
// 迁移自 chrome-extension/background/services/global-data-store.js
// 自动生成数据摘要，超限按 FIFO（最旧 timestamp）淘汰
// 无外部依赖，CommonJS 模块

/**
 * 全局数据存储类
 * 用于在 Agent 任务执行过程中共享数据（如工具输出、采集结果）
 * 每个 entry 由 key 索引，供 AI 通过 generate_script(data_refs=...) 注入到页面访问
 */
class GlobalDataStore {
  constructor() {
    // key → { value, summary, timestamp }
    this.entries = new Map()
    // 最大条目数，防止内存无限增长
    this.maxEntries = 20
  }

  /**
   * 存储数据（已存在的 key 直接覆盖，不计入新增条目）
   * 超过上限时按 FIFO（最旧 timestamp）淘汰
   * @param {string} key - 数据键（如 "news_links"、"page_content"）
   * @param {*} value - 工具执行结果
   */
  set(key, value) {
    const isUpdate = this.entries.has(key)
    const summary = this._generateSummary(value)
    this.entries.set(key, {
      value,
      summary,
      timestamp: Date.now(),
    })

    // 新增条目超限时淘汰最旧条目（FIFO，基于 timestamp）
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
   * @param {string} key - 数据键
   * @returns {*} 数据值，不存在返回 null
   */
  get(key) {
    const entry = this.entries.get(key)
    return entry ? entry.value : null
  }

  /**
   * 删除指定 key
   * @param {string} key - 数据键
   * @returns {boolean} 是否删除成功
   */
  delete(key) {
    return this.entries.delete(key)
  }

  /**
   * 检查 key 是否存在
   * @param {string} key - 数据键
   * @returns {boolean}
   */
  has(key) {
    return this.entries.has(key)
  }

  /**
   * 获取所有 key
   * @returns {string[]}
   */
  getKeys() {
    return Array.from(this.entries.keys())
  }

  /**
   * 生成全部数据的摘要文本
   * @param {number} maxLen - 最大返回字符数，默认 500
   * @returns {string} 摘要文本，无数据时返回空字符串
   */
  getSummary(maxLen = 500) {
    if (this.entries.size === 0) return ''
    const lines = []
    for (const [key, entry] of this.entries) {
      lines.push(`${key}: ${entry.summary}`)
    }
    let text = lines.join('\n')
    // 超长截断
    if (text.length > maxLen) {
      text = text.slice(0, maxLen) + '...'
    }
    return text
  }

  /**
   * 条目数（getter）
   * @returns {number}
   */
  get size() {
    return this.entries.size
  }

  /**
   * 清空所有数据（任务结束时释放内存）
   */
  clear() {
    this.entries.clear()
  }

  // ============ 内部辅助 ============

  /**
   * 为单个值生成摘要
   * 识别数组/对象/字符串等类型，提取字段与样例
   * @param {*} value - 原始值
   * @returns {string} 摘要文本
   */
  _generateSummary(value) {
    try {
      // 尝试解析 JSON 字符串，失败则保持原始值
      let obj = value
      if (typeof value === 'string') {
        try {
          obj = JSON.parse(value)
        } catch {
          obj = value
        }
      }

      // 数组类型：统计条数、字段、样例
      if (Array.isArray(obj)) {
        const count = obj.length
        if (count === 0) return '0条数据（空结果）'
        const fields = new Set()
        for (const item of obj.slice(0, 5)) {
          if (item && typeof item === 'object') {
            if (item.text) fields.add('text')
            if (item.attrs) {
              for (const k of Object.keys(item.attrs)) fields.add(`attrs.${k}`)
            }
            if (item.title) fields.add('title')
            if (item.href) fields.add('href')
            for (const k of Object.keys(item)) {
              if (!['text', 'attrs', 'title', 'href'].includes(k)) fields.add(k)
            }
          }
        }
        const fieldList = [...fields].slice(0, 6).join(', ')
        const sample = obj
          .slice(0, 2)
          .map((item) => {
            if (item && item.attrs && item.attrs.href) {
              return (item.text || '').slice(0, 30) || item.attrs.href.slice(0, 40)
            }
            if (item && item.title) return item.title.slice(0, 30)
            if (item && item.text) return item.text.slice(0, 30)
            return JSON.stringify(item).slice(0, 30)
          })
          .join(', ')
        return `${count}条数据（字段: ${fieldList}）: ${sample}${count > 2 ? '...' : ''}`
      }

      // 对象类型：识别常见结构
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
}

module.exports = GlobalDataStore
