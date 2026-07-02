// ============ 人工介入服务 ============
// Feature 9: 允许 AI Agent 在关键决策点暂停执行，请求人工输入/批准，待人工响应后继续执行
// MV3 Service Worker 模块，使用 ES modules

const DEFAULT_TIMEOUT_MS = 120000  // 默认超时 120 秒

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
    try {
      chrome.tabs.onRemoved.addListener((tabId) => {
        this._cleanupTab(tabId)
      })
    } catch (e) {
      console.warn('[HumanIntervention] 注册 tabs.onRemoved 监听失败:', e.message)
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
            console.warn('[HumanIntervention] 请求超时, id:', id)
            reject(new Error('timeout'))
          }
        }, timeoutMs)

        // 存储 resolve/reject 回调与超时定时器
        this._pending.set(id, { request, resolve, reject, timer })

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
   * @param {string} requestId - 请求 ID
   * @param {*} answer - 人工答案
   * @returns {Promise<{ok: boolean, status?: string, error?: string}>}
   */
  async respond(requestId, answer) {
    try {
      const entry = this._pending.get(requestId)
      if (!entry) {
        console.warn('[HumanIntervention] 未找到请求:', requestId)
        return { ok: false, error: '请求不存在或已处理' }
      }

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

      // 解决 Promise（返回人工答案给调用方）
      resolve(answer)

      console.log('[HumanIntervention] 请求已响应, id:', requestId, 'status:', request.status)
      return { ok: true, status: request.status }
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
   * @param {string} requestId - 请求 ID
   * @returns {boolean} 是否取消成功
   */
  cancel(requestId) {
    try {
      const entry = this._pending.get(requestId)
      if (!entry) {
        console.warn('[HumanIntervention] 取消失败，未找到请求:', requestId)
        return false
      }

      const { request, reject, timer } = entry
      clearTimeout(timer)
      this._pending.delete(requestId)

      request.status = 'rejected'
      request.answer = 'cancelled'

      // 拒绝挂起的 Promise（调用方应捕获 cancelled 错误）
      reject(new Error('cancelled'))

      console.log('[HumanIntervention] 请求已取消, id:', requestId)
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

      if (ids.length > 0) {
        console.log('[HumanIntervention] 标签页关闭清理请求:', ids.length, '个, tabId:', tabId)
      }
    } catch (e) {
      console.error('[HumanIntervention] 清理标签页请求失败:', e.message)
    }
  }
}

console.log('[HumanIntervention] 人工介入服务已加载')
