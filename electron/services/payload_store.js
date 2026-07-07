// ============ PayloadStore（Electron 主进程版） ============
// 工具结果暂存区：按 sessionId 隔离，超限结果存此处只发摘要给 AI
// 迁移自 chrome-extension/background/services/payload-store.js
// 关键变更：用 StorageService（JSON 文件）替代 chrome.storage.session
// 配额管理：预算 8MB，单条上限 500 万字符，超限全局 FIFO 淘汰

const StorageService = require('./storage_service')

// 持久化到 StorageService 的键名
const STORAGE_KEY = 'payloadStoreData'

class PayloadStore {
  constructor() {
    // 所有会话数据：{ sessionId: Map<key, {value, summary, timestamp, size}> }
    this.sessions = {}
    // 配额预算：8MB（按字符数估算，1 字符 ≈ 1 字节）
    this._budget = 8 * 1024 * 1024
    // 单条数据上限：500 万字符
    this._maxEntryChars = 5000000
    // 已用字符数（近似）
    this._usedChars = 0
    // 是否已初始化
    this._initialized = false

    // ===== 兼容 agent_runner 的 entries 数组 + add/getDataByIds/getSummaryForFinish API =====
    // 内存索引：{id, sessionId, toolName, timestamp, summary, metadata, _dataChars}
    this.entries = []
    // 全量数据缓存：{ entryId: data }（与 entries 同步维护）
    this._dataCache = {}
    // 单调递增 ID 计数器（生成 p1, p2, ... 格式的 entryId）
    this._idCounter = 0
    // 当前会话 ID
    this._sessionId = null
    // 最大条目数
    this._maxEntries = 200
  }

  // ===== Session 管理 =====
  setSessionId(sessionId) { this._sessionId = sessionId }
  getSessionId() { return this._sessionId }

  /**
   * 初始化：从 StorageService 加载已有数据
   * 应在应用启动后、首次使用前调用
   */
  async init() {
    if (this._initialized) return
    try {
      const data = await StorageService.get(STORAGE_KEY)
      if (data && typeof data === 'object' && data.sessions) {
        let used = 0
        // 从数组格式还原 Map（Map 无法直接 JSON 序列化，持久化时转为 [key, entry] 数组）
        for (const sessionId of Object.keys(data.sessions)) {
          const arr = data.sessions[sessionId]
          const map = new Map()
          if (Array.isArray(arr)) {
            for (const pair of arr) {
              if (Array.isArray(pair) && pair.length === 2) {
                const [key, entry] = pair
                map.set(key, entry)
                used += (entry && entry.size) || 0
              }
            }
          }
          this.sessions[sessionId] = map
        }
        this._usedChars = data.usedChars || used
      }
    } catch (e) {
      console.warn('[PayloadStore] 加载已有数据失败:', e.message)
    }
    this._initialized = true
  }

  /**
   * 持久化到 StorageService
   * Map 转为 [key, entry] 数组以支持 JSON 序列化
   */
  async _persist() {
    const data = { sessions: {}, usedChars: this._usedChars }
    for (const sessionId of Object.keys(this.sessions)) {
      data.sessions[sessionId] = Array.from(this.sessions[sessionId].entries())
    }
    await StorageService.set(STORAGE_KEY, data)
  }

  /**
   * 确保会话的 Map 存在
   */
  _ensureSession(sessionId) {
    if (!this.sessions[sessionId]) {
      this.sessions[sessionId] = new Map()
    }
    return this.sessions[sessionId]
  }

  /**
   * 存储数据（含配额管理）
   * @param {string} sessionId - 会话 ID
   * @param {string} key - 数据键
   * @param {*} value - 数据值
   * @param {string} summary - 数据摘要
   * @returns {Promise<string|null>} entryId（格式 sessionId_key），失败返回 null
   */
  async set(sessionId, key, value, summary = '') {
    // 大小校验：序列化失败或超限则拒绝写入
    let size = 0
    try {
      size = JSON.stringify(value).length
    } catch (e) {
      console.warn('[PayloadStore] 数据序列化失败，拒绝写入:', e.message)
      return null
    }
    if (size > this._maxEntryChars) {
      console.warn(`[PayloadStore] 数据过大 (${size} > ${this._maxEntryChars})，拒绝写入: ${key}`)
      return null
    }

    const map = this._ensureSession(sessionId)

    // 若 key 已存在，先扣减旧值占用的配额
    if (map.has(key)) {
      const oldEntry = map.get(key)
      this._usedChars = Math.max(0, this._usedChars - (oldEntry.size || 0))
    }

    // 主动配额管理：写入前预估总用量，超阈值时全局淘汰最旧条目（FIFO）
    while (this._usedChars + size > this._budget && this._hasAnyEntry()) {
      this._evictOldest()
    }

    // 写入新条目
    const entry = {
      value,
      summary,
      timestamp: Date.now(),
      size,
    }
    map.set(key, entry)
    this._usedChars += size

    await this._persist()
    console.log(`[PayloadStore] set ${sessionId}/${key} (${size}字符)`)
    return `${sessionId}_${key}`
  }

  /**
   * 获取数据
   * @param {string} sessionId - 会话 ID
   * @param {string} key - 数据键
   * @returns {Promise<*>} 数据值，不存在返回 null
   */
  async get(sessionId, key) {
    const map = this.sessions[sessionId]
    if (!map) return null
    const entry = map.get(key)
    return entry ? entry.value : null
  }

  /**
   * 按 entryId 获取（entryId 格式：sessionId_key）
   * @param {string} entryId - 条目 ID
   * @returns {Promise<*>} 数据值，不存在返回 null
   */
  async getByEntryId(entryId) {
    const idx = entryId.indexOf('_')
    if (idx < 0) return null
    const sessionId = entryId.slice(0, idx)
    const key = entryId.slice(idx + 1)
    return this.get(sessionId, key)
  }

  /**
   * 列出会话所有 key
   * @param {string} sessionId - 会话 ID
   * @returns {Promise<string[]>}
   */
  async listKeys(sessionId) {
    const map = this.sessions[sessionId]
    if (!map) return []
    return Array.from(map.keys())
  }

  /**
   * 清除指定会话数据
   * @param {string} sessionId - 会话 ID
   */
  async clearSession(sessionId) {
    const map = this.sessions[sessionId]
    if (!map) return
    // 扣减配额
    for (const entry of map.values()) {
      this._usedChars = Math.max(0, this._usedChars - (entry.size || 0))
    }
    map.clear()
    delete this.sessions[sessionId]
    await this._persist()
  }

  /**
   * 清除所有数据
   */
  async clearAll() {
    this.sessions = {}
    this._usedChars = 0
    await StorageService.remove(STORAGE_KEY)
  }

  /**
   * 生成会话数据摘要
   * @param {string} sessionId - 会话 ID
   * @returns {Promise<string>} 摘要文本
   */
  async getSummary(sessionId) {
    const map = this.sessions[sessionId]
    if (!map || map.size === 0) return '无存储数据'
    const lines = []
    for (const [key, entry] of map) {
      lines.push(`${key}: ${entry.summary || '(无摘要)'}`)
    }
    return lines.join('\n')
  }

  /**
   * 获取配额使用情况
   * @returns {object} { used, budget, maxEntryChars, percentage }
   */
  getQuotaUsage() {
    return {
      used: this._usedChars,
      budget: this._budget,
      maxEntryChars: this._maxEntryChars,
      percentage: this._budget > 0 ? Math.round((this._usedChars / this._budget) * 100) : 0,
    }
  }

  // ============ agent_runner 兼容 API（基于 entries 数组 + 内存数据缓存） ============

  /**
   * 存储数据并返回 entryId（agent_runner 主要调用此方法）
   * @param {string} toolName - 工具名
   * @param {*} data - 全量数据（对象/数组/字符串）
   * @param {string} summary - 数据摘要
   * @param {object} metadata - 元数据（schema, count, renderType, template_id 等）
   * @returns {Promise<string|null>} entryId（如 "p1"），失败返回 null
   */
  async add(toolName, data, summary = '', metadata = {}) {
    // 确保 data 是解析后的对象
    let storedData = data
    if (typeof storedData === 'string') {
      try { storedData = JSON.parse(storedData) } catch { /* 保留原始字符串 */ }
    }

    // 大小校验
    let dataChars = 0
    try {
      dataChars = JSON.stringify(storedData).length
    } catch (e) {
      console.warn('[PayloadStore] 数据序列化失败，拒绝写入:', e.message)
      return null
    }
    if (dataChars > this._maxEntryChars) {
      console.warn(`[PayloadStore] 数据过大 (${dataChars} > ${this._maxEntryChars})，拒绝写入: ${toolName}`)
      return null
    }

    // 配额管理：超阈值时 FIFO 淘汰最旧条目
    while (this.entries.length > 0 && (this._usedChars + dataChars > this._budget)) {
      const removed = this.entries.shift()
      if (removed) {
        this._usedChars = Math.max(0, this._usedChars - (removed._dataChars || 0))
        delete this._dataCache[removed.id]
        console.warn(`[PayloadStore] 配额预警，淘汰旧条目: ${removed.id} (${removed._dataChars}字符)`)
      }
    }

    // 最大条目数限制
    while (this.entries.length >= this._maxEntries) {
      const removed = this.entries.shift()
      if (removed) {
        this._usedChars = Math.max(0, this._usedChars - (removed._dataChars || 0))
        delete this._dataCache[removed.id]
      }
    }

    // 生成单调递增 ID
    this._idCounter++
    const entryId = `p${this._idCounter}`

    // 写入数据缓存
    this._dataCache[entryId] = storedData
    this._usedChars += dataChars

    // 创建内存索引
    const entry = {
      id: entryId,
      sessionId: this._sessionId,
      toolName,
      timestamp: Date.now(),
      summary,
      metadata: metadata || {},
      _dataChars: dataChars,
    }
    this.entries.push(entry)
    console.log(`[PayloadStore] add ${entryId} (${toolName}, ${dataChars}字符)`)
    return entryId
  }

  /**
   * 获取单个条目的全量数据
   * @param {string} entryId - 条目 ID
   * @returns {Promise<*>} 数据值，不存在返回 null
   */
  async getData(entryId) {
    return this._dataCache[entryId] ?? null
  }

  /**
   * 批量获取多个条目的全量数据
   * @param {string[]} entryIds - 条目ID数组
   * @returns {Promise<object>} { p1: data1, p2: data2, ... }
   */
  async getDataByIds(entryIds) {
    const result = {}
    for (const id of entryIds) {
      if (this._dataCache[id] !== undefined) {
        result[id] = this._dataCache[id]
      }
    }
    return result
  }

  /**
   * 获取汇总（用于 finish_task，默认只返回当前 session）
   * @param {object} options - { crossSession?: boolean }
   * @returns {object|null} { count, items: [{id, toolName, summary, schema, sample, count}] }
   */
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
        count: e.metadata?.count || 1,
      })),
    }
  }

  // ============ 内部辅助 ============

  /**
   * 是否还有任何条目（用于配额淘汰循环判断）
   */
  _hasAnyEntry() {
    for (const sessionId of Object.keys(this.sessions)) {
      if (this.sessions[sessionId].size > 0) return true
    }
    return false
  }

  /**
   * 淘汰全局最旧的条目（FIFO，按 timestamp 最小值）
   * 遍历所有会话找到 timestamp 最小的条目并移除
   */
  _evictOldest() {
    let targetSession = null
    let targetKey = null
    let oldestTs = Infinity
    for (const sessionId of Object.keys(this.sessions)) {
      for (const [key, entry] of this.sessions[sessionId]) {
        if (entry.timestamp < oldestTs) {
          oldestTs = entry.timestamp
          targetSession = sessionId
          targetKey = key
        }
      }
    }
    if (targetSession && targetKey) {
      const map = this.sessions[targetSession]
      const entry = map.get(targetKey)
      this._usedChars = Math.max(0, this._usedChars - (entry.size || 0))
      map.delete(targetKey)
      console.warn(`[PayloadStore] 配额预警，淘汰旧条目: ${targetSession}/${targetKey}`)
      // 清理空会话，避免空 Map 残留
      if (map.size === 0) delete this.sessions[targetSession]
    }
  }
}

module.exports = PayloadStore
