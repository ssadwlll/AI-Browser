// ============ 共享工具库 ============
// 统一的 fetch 超时、HTML 转义、错误码、URL 校验等通用函数
// 避免各文件各自实现导致的不一致

// ===== 错误码体系 =====
export const ERROR_CODES = {
  // 网络类 (1xxx)
  NETWORK_TIMEOUT: { code: 1001, label: 'NETWORK_TIMEOUT' },
  NETWORK_ERROR: { code: 1002, label: 'NETWORK_ERROR' },
  NETWORK_ABORTED: { code: 1003, label: 'NETWORK_ABORTED' },

  // 认证类 (2xxx)
  AUTH_MISSING: { code: 2001, label: 'AUTH_MISSING' },
  AUTH_INVALID: { code: 2002, label: 'AUTH_INVALID' },
  AUTH_FORBIDDEN: { code: 2003, label: 'AUTH_FORBIDDEN' },

  // 工具执行类 (3xxx)
  TOOL_NOT_FOUND: { code: 3001, label: 'TOOL_NOT_FOUND' },
  TOOL_EXECUTION_FAILED: { code: 3002, label: 'TOOL_EXECUTION_FAILED' },
  TOOL_TIMEOUT: { code: 3003, label: 'TOOL_TIMEOUT' },
  TOOL_INVALID_ARGS: { code: 3004, label: 'TOOL_INVALID_ARGS' },

  // 数据类 (4xxx)
  DATA_NOT_FOUND: { code: 4001, label: 'DATA_NOT_FOUND' },
  DATA_CORRUPTED: { code: 4002, label: 'DATA_CORRUPTED' },
  DATA_QUOTA_EXCEEDED: { code: 4003, label: 'DATA_QUOTA_EXCEEDED' },

  // 系统/页面类 (5xxx)
  PAGE_SYSTEM_URL: { code: 5001, label: 'PAGE_SYSTEM_URL' },
  PAGE_NAVIGATION_BLOCKED: { code: 5002, label: 'PAGE_NAVIGATION_BLOCKED' },
  SW_UNAVAILABLE: { code: 5003, label: 'SW_UNAVAILABLE' },

  // 通用 (9xxx)
  UNKNOWN: { code: 9999, label: 'UNKNOWN' },
}

/**
 * 统一的应用错误类
 * 携带 code、label、message、detail、cause
 */
export class AppError extends Error {
  constructor(errorCode, message, detail = null, cause = null) {
    super(message || errorCode.label)
    this.name = 'AppError'
    this.code = errorCode.code
    this.label = errorCode.label
    this.detail = detail
    this.cause = cause
  }

  toJSON() {
    return {
      ok: false,
      error: {
        code: this.code,
        label: this.label,
        message: this.message,
        detail: this.detail,
      }
    }
  }

  static fromError(e, errorCode = ERROR_CODES.UNKNOWN) {
    if (e instanceof AppError) return e
    return new AppError(errorCode, e.message, null, e)
  }
}

/**
 * 带超时与重试的 fetch
 * @param {string} url - 请求 URL
 * @param {object} options - fetch options
 * @param {number} timeoutMs - 超时毫秒，默认 30000
 * @param {number} retries - 失败重试次数（仅对网络错误/5xx 重试），默认 0
 * @param {number[]} retryOnStatus - 需要重试的 HTTP 状态码
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 30000, retries = 0, retryOnStatus = [429, 500, 502, 503, 504]) {
  // 兼容外部传入的 signal：将外部 signal 状态同步到内部 controller
  // 之前版本直接用内部 controller 覆盖 options.signal，导致调用方的 abort 失效
  const externalSignal = options.signal
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    // 若外部 signal 已 abort，立即中止
    if (externalSignal && externalSignal.aborted) {
      controller.abort()
    } else if (externalSignal) {
      // 监听外部 signal，触发时同步 abort 内部 controller（once 避免重复）
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...options, signal: controller.signal })
      clearTimeout(timeoutId)
      // 仅在指定状态码且仍有重试机会时重试
      if (retryOnStatus.includes(res.status) && attempt < retries) {
        const waitMs = (attempt + 1) * 1000
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }
      return res
    } catch (e) {
      clearTimeout(timeoutId)
      lastError = e
      const isAbort = e.name === 'AbortError'
      // 区分超时 abort 与外部 signal abort
      const isExternalAbort = externalSignal && externalSignal.aborted
      if (isAbort) {
        if (isExternalAbort) {
          // 外部主动 abort（如端口断开）：原样抛 AbortError，调用方可识别为正常中止
          const err = new Error('Aborted by caller')
          err.name = 'AbortError'
          throw err
        }
        // 否则视为超时
        lastError = new AppError(ERROR_CODES.NETWORK_TIMEOUT, `请求超时 (${timeoutMs}ms): ${url}`, { url, timeoutMs })
      }
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 1000))
        continue
      }
      throw isAbort ? lastError : new AppError(ERROR_CODES.NETWORK_ERROR, e.message, { url }, e)
    }
  }
  throw lastError || new AppError(ERROR_CODES.UNKNOWN, 'fetchWithTimeout: 未知错误')
}

/**
 * HTML 转义：用于安全插入 textContent 之外的场景
 */
export function escapeHtml(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 安全 URL 校验：仅允许 http/https
 * 阻止 javascript:、data:、vbscript:、file:、blob: 等危险协议
 */
export function isSafeUrl(url) {
  if (!url || typeof url !== 'string') return false
  const trimmed = url.trim().toLowerCase()
  // 危议黑名单
  if (/^\s*(javascript|data|vbscript|file|blob|view-source|devtools|chrome-search|ftp)\s*:/i.test(trimmed)) {
    return false
  }
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 判断字符串是否为 IP 地址（IPv4 或 IPv6）
 */
export function isIPAddress(hostname) {
  if (!hostname) return false
  // IPv6：含冒号或被方括号包裹
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true
  if (hostname.includes(':')) return true
  // IPv4：四段数字
  const v4 = /^(\d{1,3}\.){3}\d{1,3}$/
  if (v4.test(hostname)) {
    return hostname.split('.').every(part => {
      const n = parseInt(part, 10)
      return n >= 0 && n <= 255
    })
  }
  return false
}

/**
 * 判断 URL 是否为系统页面（chrome://、edge://、about:、chrome-extension://）
 */
export function isSystemUrl(url) {
  if (!url || typeof url !== 'string') return true
  return /^(chrome|edge|about|chrome-extension|view-source|devtools|chrome-search):/i.test(url)
}

/**
 * 安全 JSON 序列化：处理循环引用
 */
export function safeJsonStringify(obj, replacer = null, space = null) {
  const seen = new WeakSet()
  try {
    return JSON.stringify(obj, (key, value) => {
      if (replacer) value = replacer(key, value)
      if (value != null && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]'
        seen.add(value)
      }
      return value
    }, space)
  } catch {
    return String(obj)
  }
}

/**
 * glob 转 RegExp（防 ReDoS：压缩连续 *）
 */
export function globToRegex(pattern) {
  if (!pattern || typeof pattern !== 'string') return null
  try {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*+/g, '*')  // 压缩连续 *
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    return new RegExp('^' + escaped + '$')
  } catch {
    return null
  }
}

/**
 * chrome.runtime.sendMessage 包装：带超时与错误处理
 * @param {object} message - 消息体
 * @param {number} timeoutMs - 超时毫秒，默认 30000
 * @returns {Promise<{error: string|null, data: any}>}
 */
export function callServiceWithTimeout(message, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ error: `调用超时 (${timeoutMs}ms)`, data: null, code: ERROR_CODES.NETWORK_TIMEOUT.code })
    }, timeoutMs)

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message, data: null, code: ERROR_CODES.SW_UNAVAILABLE.code })
        } else {
          resolve(response || { error: '无响应', data: null, code: ERROR_CODES.UNKNOWN.code })
        }
      })
    } catch (e) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ error: e.message, data: null, code: ERROR_CODES.SW_UNAVAILABLE.code })
    }
  })
}

/**
 * 简单 LRU 缓存
 */
export class LRUCache {
  constructor(maxSize = 50) {
    this.maxSize = maxSize
    this.cache = new Map()
  }

  get(key) {
    if (!this.cache.has(key)) return undefined
    const value = this.cache.get(key)
    this.cache.delete(key)
    this.cache.set(key, value)
    return value
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key)
    else if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value
      this.cache.delete(oldestKey)
    }
    this.cache.set(key, value)
  }

  has(key) {
    return this.cache.has(key)
  }

  clear() {
    this.cache.clear()
  }

  get size() {
    return this.cache.size
  }
}

console.log('[Shared/utils] 共享工具库已加载')
