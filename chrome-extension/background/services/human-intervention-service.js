// ============ 人工介入服务 ============
// Feature 9: 允许 AI Agent 在关键决策点暂停执行，请求人工输入/批准，待人工响应后继续执行
// MV3 Service Worker 模块，使用 ES modules
//
// 持久化设计：MV3 SW 可能被随时终止，导致 _pending Map 和 setTimeout 丢失。
// 将待处理请求同步到 chrome.storage.session，SW 重启后重新触发 _onRequest 回调，
// sidepanel 仍能展示这些请求。注意：Promise 回调无法跨 SW 重启恢复，
// 因此 respond 对已失效（仅存在于持久化存储中）的请求仅更新状态，不再 resolve Promise。

const DEFAULT_TIMEOUT_MS = 120000  // 默认超时 120 秒
const STORAGE_KEY = 'human_intervention_pending'  // chrome.storage.session key

export class HumanInterventionService {
  /**
   * @param {(request: object) => void} onRequest - 新请求创建时的回调，用于转发到 sidepanel UI
   */
  constructor(onRequest) {
    // onRequest 回调：新请求创建时调用，用于转发到 sidepanel UI
    this._onRequest = typeof onRequest === 'function' ? onRequest : () => {}
    // _pending: Map<requestId, { request, resolve, reject, timer }>
    this._pending = new Map()

    // 监听标签页关闭事件，自动清理该标签页下的所有待处理请求
    // 使用命名引用 + hasListener 守卫，避免 SW 重启后重复注册监听器
    this._tabRemovedHandler = (tabId) => { this._cleanupTab(tabId) }
    try {
      if (!chrome.tabs.onRemoved.hasListener(this._tabRemovedHandler)) {
        chrome.tabs.onRemoved.addListener(this._tabRemovedHandler)
      }
    } catch (e) {
      console.warn('[HumanIntervention] 注册 tabs.onRemoved 监听失败:', e.message)
    }

    // SW 启动时加载持久化的待处理请求，重新触发 _onRequest 回调让 sidepanel 重新展示
    // （Promise 回调已失效无法恢复，但 UI 仍需展示请求并允许用户关闭/响应）
    this._restorePersistedPending().catch(e => {
      console.warn('[HumanIntervention] 恢复持久化请求失败:', e.message)
    })
  }

  /**
   * 持久化当前 _pending 中的请求到 chrome.storage.session
   * 仅存储请求对象本身（不含 resolve/reject/timer 等运行时引用）
   */
  async _persistPending() {
    try {
      const requests = []
      for (const { request } of this._pending.values()) {
        requests.push(request)
      }
      await chrome.storage.session.set({ [STORAGE_KEY]: requests })
    } catch (e) {
      console.warn('[HumanIntervention] 持久化失败:', e.message)
    }
  }

  /**
   * SW 启动时从 chrome.storage.session 加载持久化的待处理请求
   * 过滤掉已超时的请求，对仍 pending 的请求重新触发 _onRequest 回调
   *
   * 竞态修复：恢复流程不能简单覆盖 storage，否则会丢失恢复期间新写入的请求。
   * 改为：仅触发回调（只读操作），存储状态以内存 _pending 为准（在 _persistPending 中合并写入）。
   * 即使恢复期间调用了 request() 写入新请求，也不会被覆盖。
   */
  async _restorePersistedPending() {
    let data
    try {
      data = await chrome.storage.session.get(STORAGE_KEY)
    } catch (e) {
      console.warn('[HumanIntervention] 读取持久化请求失败:', e.message)
      return
    }
    const requests = data[STORAGE_KEY] || []
    if (requests.length === 0) return

    const now = Date.now()
    const stillPending = []
    let cleanedExpired = 0

    // 收集内存中已存在的 id，避免重复处理
    const inMemoryIds = new Set()
    for (const { request } of this._pending.values()) {
      inMemoryIds.add(request.id)
    }

    for (const req of requests) {
      if (req.status !== 'pending') {
        cleanedExpired++
        continue
      }
      // 已超时的请求直接丢弃（原 SW 已终止无法 reject Promise，这里仅清理存储）
      if (now - req.createdAt > (req.timeoutMs || DEFAULT_TIMEOUT_MS)) {
        cleanedExpired++
        continue
      }
      stillPending.push(req)
      // 重新触发回调，sidepanel 可重新展示（仅 SW 重启后的恢复场景）
      if (!inMemoryIds.has(req.id)) {
        try {
          this._onRequest({ ...req, _restored: true })
        } catch (e) {
          console.warn('[HumanIntervention] 重播请求回调失败:', req.id, e.message)
        }
      }
    }

    // 重新合并写入：内存中已有的请求 + 持久化中仍 pending 的请求
    // 避免 request() 在恢复期间新写入的请求被覆盖
    if (cleanedExpired > 0 || stillPending.length !== requests.length) {
      const inMemoryRequests = []
      for (const { request } of this._pending.values()) {
        inMemoryRequests.push(request)
      }
      // 合并：内存中的所有请求 + 持久化中仍 pending 但不在内存中的请求
      const inMemoryIdSet = new Set(inMemoryRequests.map(r => r.id))
      const merged = [...inMemoryRequests, ...stillPending.filter(r => !inMemoryIdSet.has(r.id))]
      await chrome.storage.session.set({ [STORAGE_KEY]: merged })
    }
    if (stillPending.length > 0) {
      console.log('[HumanIntervention] 恢复了', stillPending.length, '个待处理请求（Promise 已失效，仅 UI 展示）')
    }
  }

  /**
   * 创建一个人工介入请求
   * @param {number} tabId - 标签页 ID
   * @param {object} config - 请求配置 { type, question, options, context, timeoutMs }
   * @returns {Promise} 人工响应后 resolve(answer)，超时则 reject('timeout')
   */
  async request(tabId, config) {
    try {
      const {
        type = 'approval',          // 'approval' | 'input' | 'choice'
        question = '',
        options = [],                // choice 类型时提供的可选项
        context = {},                 // 上下文信息（供 UI 展示）
        timeoutMs = DEFAULT_TIMEOUT_MS,
      } = config || {}

      // 生成唯一 ID
      const id = `hi-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

      // 构建请求对象
      const request = {
        id,
        type,
        question,
        options,
        context,
        createdAt: Date.now(),
        status: 'pending',            // 'pending' | 'approved' | 'rejected' | 'answered'
        answer: null,
        tabId,
        timeoutMs,
      }

      // 返回 Promise，存入 pending Map 等待人工响应
      return await new Promise((resolve, reject) => {
        // 设置超时定时器，超时自动拒绝
        const timer = setTimeout(() => {
          const entry = this._pending.get(id)
          if (entry) {
            entry.request.status = 'rejected'
            entry.request.answer = 'timeout'
            this._pending.delete(id)
            // 同步清理持久化存储
            this._persistPending().catch(() => {})
            console.warn('[HumanIntervention] 请求超时, id:', id)
            reject(new Error('timeout'))
          }
        }, timeoutMs)

        // 存储 resolve/reject 回调与超时定时器
        this._pending.set(id, { request, resolve, reject, timer })

        // 持久化到 chrome.storage.session（SW 重启后仍可展示给用户）
        this._persistPending().catch(() => {})

        // 通知 UI（通过回调转发到 sidepanel）
        try {
          this._onRequest(request)
        } catch (e) {
          console.warn('[HumanIntervention] onRequest 回调异常:', e.message)
        }

        console.log('[HumanIntervention] 新请求已创建, id:', id, 'type:', type, 'tabId:', tabId)
      })
    } catch (e) {
      console.error('[HumanIntervention] 创建请求失败:', e.message)
      throw e
    }
  }

  /**
   * 人工响应请求，解决挂起的 Promise
   * 若请求仅在持久化存储中（SW 重启后 Promise 已失效），则仅更新存储状态
   * @param {string} requestId - 请求 ID
   * @param {*} answer - 人工答案
   * @returns {Promise<{ok: boolean, status?: string, error?: string}>}
   */
  async respond(requestId, answer) {
    try {
      const entry = this._pending.get(requestId)

      // 路径1：请求在内存 _pending 中（正常运行流程），resolve Promise
      if (entry) {
        const { request, resolve, timer } = entry
        clearTimeout(timer)
        this._pending.delete(requestId)

        // 根据类型和答案设置状态
        if (request.type === 'approval') {
          // 审批类：布尔答案决定 approved / rejected
          request.status = (answer === true || answer === 'approved') ? 'approved' : 'rejected'
        } else {
          // input / choice 类：已回答
          request.status = 'answered'
        }
        request.answer = answer

        // 同步持久化（移除已响应的请求）
        this._persistPending().catch(() => {})

        // 解决 Promise（返回人工答案给调用方）
        resolve(answer)

        console.log('[HumanIntervention] 请求已响应, id:', requestId, 'status:', request.status)
        return { ok: true, status: request.status }
      }

      // 路径2：请求不在内存中（SW 重启后 Promise 已失效），从持久化存储中查找并更新状态
      const data = await chrome.storage.session.get(STORAGE_KEY)
      const persisted = data[STORAGE_KEY] || []
      const idx = persisted.findIndex(r => r.id === requestId)
      if (idx === -1) {
        console.warn('[HumanIntervention] 未找到请求:', requestId)
        return { ok: false, error: '请求不存在或已处理' }
      }

      const req = persisted[idx]
      if (req.type === 'approval') {
        req.status = (answer === true || answer === 'approved') ? 'approved' : 'rejected'
      } else {
        req.status = 'answered'
      }
      req.answer = answer

      // 从持久化存储中移除已响应的请求
      persisted.splice(idx, 1)
      await chrome.storage.session.set({ [STORAGE_KEY]: persisted })

      console.log('[HumanIntervention] 持久化请求已响应（Promise 已失效）, id:', requestId, 'status:', req.status)
      // 注意：原 Agent 任务可能已因 SW 重启而中断，此处仅更新 UI 状态
      return { ok: true, status: req.status, restored: true }
    } catch (e) {
      console.error('[HumanIntervention] 响应请求失败:', e.message)
      return { ok: false, error: e.message }
    }
  }

  /**
   * 获取指定标签页的所有待处理请求
   * @param {number} tabId - 标签页 ID
   * @returns {object[]} 待处理请求数组
   */
  getPending(tabId) {
    try {
      const list = []
      for (const { request } of this._pending.values()) {
        if (request.tabId === tabId) {
          list.push(request)
        }
      }
      return list
    } catch (e) {
      console.error('[HumanIntervention] 获取待处理请求失败:', e.message)
      return []
    }
  }

  /**
   * 取消待处理请求（拒绝挂起的 Promise）
   * 若请求仅在持久化存储中（SW 重启后 Promise 已失效），仍需从存储中清理
   * @param {string} requestId - 请求 ID
   * @returns {Promise<boolean>} 是否取消成功
   */
  async cancel(requestId) {
    try {
      const entry = this._pending.get(requestId)
      if (entry) {
        // 路径1：请求在内存中（正常运行流程）
        const { request, reject, timer } = entry
        clearTimeout(timer)
        this._pending.delete(requestId)

        request.status = 'rejected'
        request.answer = 'cancelled'

        // 同步持久化
        await this._persistPending()

        // 拒绝挂起的 Promise（调用方应捕获 cancelled 错误）
        reject(new Error('cancelled'))

        console.log('[HumanIntervention] 请求已取消, id:', requestId)
        return true
      }

      // 路径2：请求不在内存中（SW 重启后 Promise 已失效），从持久化存储中清理
      const data = await chrome.storage.session.get(STORAGE_KEY)
      const persisted = data[STORAGE_KEY] || []
      const idx = persisted.findIndex(r => r.id === requestId)
      if (idx === -1) {
        console.warn('[HumanIntervention] 取消失败，未找到请求:', requestId)
        return false
      }
      const req = persisted[idx]
      req.status = 'rejected'
      req.answer = 'cancelled'
      persisted.splice(idx, 1)
      await chrome.storage.session.set({ [STORAGE_KEY]: persisted })
      console.log('[HumanIntervention] 持久化请求已取消（Promise 已失效）, id:', requestId)
      return true
    } catch (e) {
      console.error('[HumanIntervention] 取消请求失败:', e.message)
      return false
    }
  }

  /**
   * 检查指定标签页是否存在待处理请求
   * @param {number} tabId - 标签页 ID
   * @returns {boolean}
   */
  hasPending(tabId) {
    try {
      for (const { request } of this._pending.values()) {
        if (request.tabId === tabId) {
          return true
        }
      }
      return false
    } catch (e) {
      console.error('[HumanIntervention] 检查待处理请求失败:', e.message)
      return false
    }
  }

  /**
   * 标签页关闭时自动清理该标签页下的所有待处理请求
   * @param {number} tabId - 标签页 ID
   * @private
   */
  _cleanupTab(tabId) {
    try {
      const ids = []
      for (const [id, entry] of this._pending) {
        if (entry.request.tabId === tabId) {
          ids.push(id)
        }
      }

      for (const id of ids) {
        const entry = this._pending.get(id)
        if (entry) {
          clearTimeout(entry.timer)
          entry.request.status = 'rejected'
          entry.request.answer = 'tab_closed'
          entry.reject(new Error('tab_closed'))
          this._pending.delete(id)
        }
      }

      // 同步持久化
      if (ids.length > 0) {
        this._persistPending().catch(() => {})
        console.log('[HumanIntervention] 标签页关闭清理请求:', ids.length, '个, tabId:', tabId)
      }
    } catch (e) {
      console.error('[HumanIntervention] 清理标签页请求失败:', e.message)
    }
  }
}

console.log('[HumanIntervention] 人工介入服务已加载')
