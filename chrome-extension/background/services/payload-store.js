// ============ PayloadStore ============
// 工具结果暂存区：超过阈值的结果存此处，只发摘要给AI
// 支持按 sessionId 隔离：新任务只查自己 session 的数据
// 数据存储在 chrome.storage.session（页面导航不丢失，Service Worker重启不丢失）
// 内存索引用于快速查询摘要，全量数据按需从 storage 读取
export class PayloadStore {
  constructor() {
    this.entries = []        // 内存索引：{id, sessionId, toolName, timestamp, summary, metadata}
    this.maxEntries = 30
    // 单条全量数据读取上限（用于生成_script 注入前的校验，避免超大 payload 撑爆页面内存）
    this.maxEntryChars = 5000000
    // chrome.storage.session 总配额约 10MB，预留 2MB 给其他模块，安全阈值 8MB
    this._quotaBudgetBytes = 8 * 1024 * 1024
    this._usedBytes = 0  // 近似已用字节数（基于 JSON.stringify 估算）
    // 单调递增计数器，避免 FIFO 淘汰后 ID 复用导致数据错乱
    this._idCounter = 0
    this._sessionId = ''  // 当前会话ID，用于任务隔离
    this._storagePrefix = 'agent_data_'  // chrome.storage.session key前缀
  }

  /**
   * 设置当前会话ID（新任务启动时调用）
   */
  setSessionId(sessionId) {
    this._sessionId = sessionId || ''
  }

  /**
   * 获取当前会话ID
   */
  getSessionId() {
    return this._sessionId
  }

  // ===== chrome.storage.session 操作 =====

  async _storageSet(key, value) {
    try {
      await chrome.storage.session.set({ [key]: value })
      return true
    } catch (e) {
      console.warn('[PayloadStore] storage.session写入失败:', e.message)
      return false
    }
  }

  async _storageGet(key) {
    try {
      const result = await chrome.storage.session.get(key)
      return result[key] ?? null
    } catch (e) {
      console.warn('[PayloadStore] storage.session读取失败:', e.message)
      return null
    }
  }

  async _storageRemove(keys) {
    try {
      await chrome.storage.session.remove(keys)
    } catch (e) {
      console.warn('[PayloadStore] storage.session删除失败:', e.message)
    }
  }

  // 存储数据（全量数据写入 chrome.storage.session，内存只存索引）
  // 改为 async：先写入 storage，成功后再建索引；写入失败则不污染 entries
  async add(toolName, data, summary, metadata) {
    // 确保 data 是解析后的对象（不是JSON字符串），注入页面时 window.__store.p1 直接可用
    let storedData = data
    if (typeof storedData === 'string') {
      try { storedData = JSON.parse(storedData) } catch { /* 保留原始字符串 */ }
    }

    // 大小校验：避免单条数据撑爆 chrome.storage.session 配额（10MB）
    let dataChars = 0
    try {
      dataChars = JSON.stringify(storedData).length
    } catch (e) {
      console.warn('[PayloadStore] 数据序列化失败，拒绝写入:', e.message)
      return null
    }
    if (dataChars > this.maxEntryChars) {
      console.warn(`[PayloadStore] 数据过大 (${dataChars} > ${this.maxEntryChars})，拒绝写入: ${toolName}`)
      return null
    }

    // 主动配额管理：写入前预估总用量，超阈值时淘汰最旧条目
    // 避免盲目写入触发 QUOTA_BYTES 错误后才回滚（P1: quota 检查与隔离）
    while (this.entries.length > 0 && (this._usedBytes + dataChars > this._quotaBudgetBytes)) {
      const removed = this.entries.shift()
      if (removed) {
        const removedChars = removed._dataChars || 0
        this._usedBytes = Math.max(0, this._usedBytes - removedChars)
        await this._storageRemove(`${this._storagePrefix}${removed.id}`)
        console.warn(`[PayloadStore] 配额预警，淘汰旧条目: ${removed.id} (${removedChars}字符)`)
      }
    }

    if (this.entries.length >= this.maxEntries) {
      // FIFO淘汰：移除最旧的条目
      const removed = this.entries.shift()
      if (removed) {
        const removedChars = removed._dataChars || 0
        this._usedBytes = Math.max(0, this._usedBytes - removedChars)
        await this._storageRemove(`${this._storagePrefix}${removed.id}`)
      }
    }
    // 使用单调递增计数器生成 ID，永不复用
    this._idCounter++
    const entryId = `p${this._idCounter}`

    // 先写入 storage，确认成功再建索引
    const storageKey = `${this._storagePrefix}${entryId}`
    const ok = await this._storageSet(storageKey, storedData)
    if (!ok) {
      console.warn(`[PayloadStore] 写入失败，回滚索引: ${entryId}`)
      // 回滚计数器，避免 ID 跳号
      this._idCounter--
      return null
    }
    console.log(`[PayloadStore] 数据已写入session storage: ${entryId} (${dataChars}字符)`)

    const entry = {
      id: entryId,
      sessionId: this._sessionId,  // 绑定当前会话
      toolName,
      timestamp: Date.now(),
      summary,
      metadata: metadata || {},
      _dataChars: dataChars,  // 记录字节数，淘汰时用于扣减 _usedBytes
    }
    this.entries.push(entry)
    this._usedBytes += dataChars
    return entryId
  }

  /**
   * 获取条目的全量数据（从 chrome.storage.session 读取）
   */
  async getData(entryId) {
    return this._storageGet(`${this._storagePrefix}${entryId}`)
  }

  /**
   * 批量获取多个条目的全量数据
   * @param {string[]} entryIds - 条目ID数组
   * @returns {Object} - { p1: data1, p2: data2, ... }
   */
  async getDataByIds(entryIds) {
    const keys = entryIds.map(id => `${this._storagePrefix}${id}`)
    const result = {}
    try {
      const stored = await chrome.storage.session.get(keys)
      for (const id of entryIds) {
        const data = stored[`${this._storagePrefix}${id}`]
        if (data !== undefined) result[id] = data
      }
    } catch (e) {
      console.warn('[PayloadStore] 批量读取失败:', e.message)
    }
    return result
  }

  // 查询数据（同步，返回索引信息+schema+样例，不返回全量数据）
  // 全量数据通过 getData/getDataByIds 异步获取
  query(options = {}) {
    let results = []

    // 默认只查当前 sessionId 的条目
    const sessionIdFilter = options.crossSession ? null : this._sessionId

    // 按 entry_id 查询
    if (options.entry_id) {
      const entryId = options.entry_id.trim()
      // "all" 表示查询所有条目
      if (entryId === 'all') {
        results = sessionIdFilter
          ? this.entries.filter(e => e.sessionId === sessionIdFilter)
          : this.entries.slice()
      } else {
        const ids = entryId.split(',').map(s => s.trim())
        results = this.entries.filter(e => ids.includes(e.id) && (!sessionIdFilter || e.sessionId === sessionIdFilter))
      }
    }
    // 按 tool_name 查询最新
    else if (options.tool_name) {
      const filtered = sessionIdFilter
        ? this.entries.filter(e => e.toolName === options.tool_name && e.sessionId === sessionIdFilter)
        : this.entries.filter(e => e.toolName === options.tool_name)
      const entry = filtered.pop()
      if (entry) results = [entry]
    }
    // 查全部（返回汇总）
    else {
      return this._summaryAll(sessionIdFilter)
    }

    // 返回索引信息（不含全量data）
    if (results.length === 0) {
      return { error: '未找到匹配数据', entries: [] }
    }

    const entries = results.map(e => ({
      id: e.id,
      toolName: e.toolName,
      count: e.metadata?.count || 1,
      schema: e.metadata?.schema || null,
      sample: e.metadata?.sample || null,
      summary: e.summary || ''
    }))

    return {
      count: entries.length,
      entries,
      hint: '使用 generate_script(data_refs=["id1","id2"]) 操作全量数据，或用 payloadStore.getData(id) 异步读取'
    }
  }

  // 汇总所有条目（支持按 sessionId 过滤）
  _summaryAll(sessionIdFilter = null) {
    const entries = sessionIdFilter
      ? this.entries.filter(e => e.sessionId === sessionIdFilter)
      : this.entries
    if (entries.length === 0) return { summary: '无存储数据', hint: '' }
    // 使用 schema 格式化
    const lines = entries.map(e => {
      const count = e.metadata?.count || 1
      const schemaStr = e.metadata?.schema
        ? Object.entries(e.metadata.schema).map(([k, v]) => `${k}:${v}`).join(', ')
        : ''
      return schemaStr
        ? `${e.id}(${e.toolName}): ${count}条 | {${schemaStr}}`
        : `${e.id}(${e.toolName}): ${count}条`
    })
    return {
      summary: lines.join('\n'),
      hint: '使用 generate_script(data_refs=["id1","id2"]) 操作全量数据'
    }
  }

  // 清空（可选：只清空当前session的条目，或全部清空）
  async clear(options = {}) {
    const toRemove = []
    if (options.sessionOnly && this._sessionId) {
      const removed = this.entries.filter(e => e.sessionId === this._sessionId)
      toRemove.push(...removed.map(e => `${this._storagePrefix}${e.id}`))
      // 扣减已用字节
      let removedBytes = 0
      for (const e of removed) removedBytes += (e._dataChars || 0)
      this._usedBytes = Math.max(0, this._usedBytes - removedBytes)
      this.entries = this.entries.filter(e => e.sessionId !== this._sessionId)
    } else {
      toRemove.push(...this.entries.map(e => `${this._storagePrefix}${e.id}`))
      this.entries = []
      this._idCounter = 0
      this._usedBytes = 0
    }
    if (toRemove.length > 0) {
      await this._storageRemove(toRemove)
    }
  }

  /**
   * 继承上一轮数据：将最近的 N 条数据更新 sessionId 为当前 session
   * 用于用户连续对话时复用上一轮采集的数据（如"导出csv给我"）
   * @param {string} newSessionId - 新任务的 sessionId
   * @param {number} maxAgeMs - 最大继承数据的时间间隔（默认5分钟）
   */
  inheritFromLastSession(newSessionId, maxAgeMs = 300000) {
    const now = Date.now()
    const recentEntries = this.entries
      .filter(e => e.sessionId !== newSessionId && (now - e.timestamp) < maxAgeMs)
      .slice(-10)  // 最多继承10条最近数据

    for (const entry of recentEntries) {
      entry.sessionId = newSessionId
    }
    console.log(`[PayloadStore] 继承了 ${recentEntries.length} 条上一轮数据到新 session ${newSessionId}`)
    return recentEntries.length
  }

  // 列出所有条目ID
  listEntryIds() {
    return this.entries.map(e => e.id)
  }

  // 获取单个条目摘要
  getEntrySummary(entryId) {
    const entry = this.entries.find(e => e.id === entryId)
    if (!entry) return null
    const count = entry.metadata?.count || 1
    const schemaStr = entry.metadata?.schema
      ? Object.entries(entry.metadata.schema).map(([k, v]) => `${k}:${v}`).join(', ')
      : ''
    if (schemaStr) return `${count}条 | {${schemaStr}}`
    return entry.summary || `${count}条数据`
  }

  // 获取指定条目的URL列表（异步，从 storage 读取数据）
  async getEntryUrls(entryId) {
    const data = await this.getData(entryId)
    if (!Array.isArray(data)) return []
    return data.filter(d => d.attrs?.href).map(d => d.attrs.href)
  }

  // 获取汇总（用于finish_task，默认只返回当前session）
  getSummaryForFinish(options = {}) {
    const entries = options.crossSession
      ? this.entries
      : this.entries.filter(e => e.sessionId === this._sessionId)
    if (entries.length === 0) return null
    return {
      count: entries.length,
      items: entries.map(e => ({
        id: e.id,
        toolName: e.toolName,
        summary: e.summary,
        schema: e.metadata?.schema || null,
        sample: e.metadata?.sample || null,
        count: e.metadata?.count || 1
      }))
    }
  }
}
