// ============ HumanInterventionService（人工介入服务）============
// 允许 AI Agent 在关键决策点暂停执行，请求人工输入/批准，待人工响应后继续执行
//
// 迁移自 chrome-extension/background/services/human-intervention-service.js
// 改动：
//   - ES Module → CommonJS
//   - chrome.storage.session → StorageService（JSON 文件持久化）
//   - MV3 Service Worker 重启恢复逻辑 → 简化
//     （Electron 主进程持久运行，不会像 SW 那样被随时终止；
//      但仍保留持久化以支持应用重启后恢复 UI 展示）
//   - tabs.onRemoved 监听 → 由调用方通过 cancel 主动清理
//
// 持久化设计：
//   - _pending Map 中的 resolve/reject/timer 为运行时引用，无法序列化
//   - 仅持久化请求对象本身，应用重启后恢复 UI 展示
//   - 重启后 Promise 回调已失效，respond 仅更新存储状态
//
// 数据结构（request）：
//   {
//     requestId, tabId, message, options, timestamp,
//     status: 'pending' | 'responded' | 'cancelled' | 'expired',
//     response, respondedAt
//   }

const StorageService = require('./storage_service')

// 持久化存储 key
const STORAGE_KEY = 'humanInterventionPending'
// 默认超时时间（毫秒）
const DEFAULT_TIMEOUT_MS = 120000

class HumanInterventionService {
  /**
   * @param {(request: object) => void} onRequest - 新请求创建时的回调，用于转发到渲染进程 UI
   */
  constructor(onRequest) {
    // onRequest 回调：新请求创建时调用，用于转发到渲染进程展示
    this._onRequest = typeof onRequest === 'function' ? onRequest : () => {}
    // _pending: Map<requestId, { request, resolve, reject, timer }>
    this._pending = new Map()
    this._initialized = false
  }

  /**
   * 初始化：加载持久化的待处理请求
   * 应用重启后恢复 UI 展示（Promise 回调已失效，仅更新状态）
   */
  async init() {
    if (this._initialized) return

    try {
      const persisted = await StorageService.get(STORAGE_KEY)
      if (Array.isArray(persisted) && persisted.length > 0) {
        const now = Date.now()
        let restored = 0
        for (const req of persisted) {
          if (req.status !== 'pending') continue
          // 过滤已超时的请求
          const timeoutMs = req.options?.timeoutMs || DEFAULT_TIMEOUT_MS
          if (now - req.timestamp > timeoutMs) {
            req.status = 'expired'
            continue
          }
          // 重新触发回调，渲染进程可重新展示
          try {
            this._onRequest({ ...req, _restored: true })
            restored++
          } catch (e) {
            console.warn('[HumanIntervention] 重播请求回调失败:', req.requestId, e.message)
          }
        }
        if (restored > 0) {
          console.log(`[HumanIntervention] 恢复了 ${restored} 个待处理请求（Promise 已失效，仅 UI 展示）`)
        }
      }
    } catch (e) {
      console.warn('[HumanIntervention] 加载持久化请求失败:', e.message)
    }

    this._initialized = true
  }

  /**
   * 持久化当前 _pending 中的请求到 StorageService
   * 仅存储请求对象本身（不含 resolve/reject/timer 等运行时引用）
   */
  async _persistPending() {
    try {
      const requests = []
      for (const { request } of this._pending.values()) {
        requests.push(request)
      }
      await StorageService.set(STORAGE_KEY, requests)
    } catch (e) {
      console.warn('[HumanIntervention] 持久化失败:', e.message)
    }
  }

  /**
   * 发起人工介入请求
   * @param {number|string} tabId - 标签页 ID（Electron 中为 webContentsId 或自定义标识）
   * @param {string} message - 请求消息（展示给用户的问题/说明）
   * @param {object} options - 请求选项 { type, options, context, timeoutMs, defaultValue }
   *   - type: 'approval' | 'input' | 'choice'，默认 'approval'
   *   - options: choice 类型的可选项
   *   - context: 上下文信息（供 UI 展示）
   *   - timeoutMs: 超时毫秒，默认 120000
   *   - defaultValue: 超时时的默认响应
   * @returns {Promise<*>} 人工响应后 resolve(response)，超时则 reject('timeout')
   */
  async request(tabId, message, options = {}) {
    await this.init()

    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS

    // 生成唯一请求 ID
    const requestId = `hi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    // 构建请求对象
    const request = {
      requestId,
      tabId,
      message: message || '',
      options: {
        type: options.type || 'approval',
        options: options.options || [],
        context: options.context || {},
        timeoutMs,
        defaultValue: options.defaultValue,
      },
      timestamp: Date.now(),
      status: 'pending', // pending | responded | cancelled | expired
      response: null,
      respondedAt: null,
    }

    // 返回 Promise，存入 pending Map 等待人工响应
    return new Promise((resolve, reject) => {
      // 设置超时定时器，超时自动拒绝
      const timer = setTimeout(() => {
        const entry = this._pending.get(requestId)
        if (entry) {
          entry.request.status = 'expired'
          // 超时若有默认值则使用默认值响应
          if (entry.request.options.defaultValue !== undefined) {
            entry.request.response = entry.request.options.defaultValue
          }
          this._pending.delete(requestId)
          this._persistPending().catch(() => {})
          console.warn('[HumanIntervention] 请求超时:', requestId)
          reject(new Error('timeout'))
        }
      }, timeoutMs)

      // 存储 resolve/reject 回调与超时定时器
      this._pending.set(requestId, { request, resolve, reject, timer })

      // 持久化到 StorageService（应用重启后仍可展示）
      this._persistPending().catch(() => {})

      // 通知 UI（通过回调转发到渲染进程）
      try {
        this._onRequest(request)
      } catch (e) {
        console.warn('[HumanIntervention] onRequest 回调异常:', e.message)
      }

      console.log('[HumanIntervention] 新请求已创建:', requestId, 'tabId:', tabId)
    })
  }

  /**
   * 响应人工介入请求，解决挂起的 Promise
   * 若请求仅在持久化存储中（应用重启后 Promise 已失效），则仅更新存储状态
   * @param {string} requestId - 请求 ID
   * @param {*} response - 人工响应
   * @returns {Promise<{ok:boolean, status?:string, error?:string}>}
   */
  async respond(requestId, response) {
    await this.init()

    try {
      const entry = this._pending.get(requestId)

      // 路径1：请求在内存 _pending 中（正常运行流程），resolve Promise
      if (entry) {
        clearTimeout(entry.timer)
        entry.request.status = 'responded'
        entry.request.response = response
        entry.request.respondedAt = Date.now()
        this._pending.delete(requestId)
        this._persistPending().catch(() => {})

        // 解决 Promise（返回人工响应给调用方）
        entry.resolve(response)

        console.log('[HumanIntervention] 请求已响应:', requestId)
        return { ok: true, status: 'responded' }
      }

      // 路径2：请求不在内存中（应用重启后 Promise 已失效），从持久化存储中查找并更新状态
      const persisted = (await StorageService.get(STORAGE_KEY)) || []
      const idx = persisted.findIndex((r) => r.requestId === requestId)
      if (idx === -1) {
        console.warn('[HumanIntervention] 未找到请求:', requestId)
        return { ok: false, error: '请求不存在或已处理' }
      }

      const req = persisted[idx]
      req.status = 'responded'
      req.response = response
      req.respondedAt = Date.now()
      // 从持久化存储中移除已响应的请求
      persisted.splice(idx, 1)
      await StorageService.set(STORAGE_KEY, persisted)

      console.log('[HumanIntervention] 持久化请求已响应（Promise 已失效）:', requestId)
      return { ok: true, status: 'responded', restored: true }
    } catch (e) {
      console.error('[HumanIntervention] 响应请求失败:', e.message)
      return { ok: false, error: e.message }
    }
  }

  /**
   * 取消人工介入请求（拒绝挂起的 Promise）
   * @param {string} requestId - 请求 ID
   * @returns {Promise<boolean>} 是否取消成功
   */
  async cancel(requestId) {
    await this.init()

    try {
      const entry = this._pending.get(requestId)
      if (entry) {
        // 路径1：请求在内存中（正常运行流程）
        clearTimeout(entry.timer)
        entry.request.status = 'cancelled'
        this._pending.delete(requestId)
        this._persistPending().catch(() => {})

        // 拒绝挂起的 Promise（调用方应捕获 cancelled 错误）
        entry.reject(new Error('cancelled'))

        console.log('[HumanIntervention] 请求已取消:', requestId)
        return true
      }

      // 路径2：请求不在内存中（应用重启后 Promise 已失效），从持久化存储中清理
      const persisted = (await StorageService.get(STORAGE_KEY)) || []
      const idx = persisted.findIndex((r) => r.requestId === requestId)
      if (idx === -1) {
        console.warn('[HumanIntervention] 取消失败，未找到请求:', requestId)
        return false
      }
      persisted[idx].status = 'cancelled'
      persisted.splice(idx, 1)
      await StorageService.set(STORAGE_KEY, persisted)
      console.log('[HumanIntervention] 持久化请求已取消:', requestId)
      return true
    } catch (e) {
      console.error('[HumanIntervention] 取消请求失败:', e.message)
      return false
    }
  }

  /**
   * 获取所有待处理请求
   * @returns {Promise<object[]>} 待处理请求数组
   */
  async getPendingRequests() {
    await this.init()
    const list = []
    for (const { request } of this._pending.values()) {
      list.push(request)
    }
    return list
  }

  /**
   * 检查是否存在待处理请求
   * @param {number|string} [tabId] - 可选标签页 ID，传入则只检查该标签页
   * @returns {Promise<boolean>}
   */
  async hasPending(tabId) {
    await this.init()
    for (const { request } of this._pending.values()) {
      if (tabId === undefined || request.tabId === tabId) {
        return true
      }
    }
    return false
  }

  /**
   * 清理过期请求
   * @param {number} maxAgeMs - 最大存活时间（毫秒），默认 300000（5 分钟）
   * @returns {Promise<number>} 清理的请求数量
   */
  async clearExpired(maxAgeMs = 300000) {
    await this.init()

    const now = Date.now()
    const expiredIds = []

    for (const [id, entry] of this._pending) {
      if (now - entry.request.timestamp > maxAgeMs) {
        clearTimeout(entry.timer)
        entry.request.status = 'expired'
        // 拒绝挂起的 Promise
        try {
          entry.reject(new Error('expired'))
        } catch (e) {
          // Promise 已被处理则忽略
        }
        expiredIds.push(id)
      }
    }

    for (const id of expiredIds) {
      this._pending.delete(id)
    }

    if (expiredIds.length > 0) {
      await this._persistPending()
      console.log(`[HumanIntervention] 已清理 ${expiredIds.length} 个过期请求`)
    }

    return expiredIds.length
  }

  /**
   * 清空所有待处理请求
   */
  async clearAll() {
    await this.init()

    for (const { timer, reject } of this._pending.values()) {
      clearTimeout(timer)
      try {
        reject(new Error('cleared'))
      } catch (e) {
        // Promise 已被处理则忽略
      }
    }
    this._pending.clear()
    await StorageService.remove(STORAGE_KEY)

    console.log('[HumanIntervention] 已清空所有待处理请求')
  }
}

module.exports = HumanInterventionService
