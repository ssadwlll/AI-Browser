// ============ 共享工具库（Electron 主进程版） ============
// 统一的 fetch 超时、错误码、安全 JSON 序列化等通用函数
// 迁移自 chrome-extension/shared/utils.js，适配 Node.js/Electron 环境

// ===== 错误码体系 =====
const ERROR_CODES = {
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
class AppError extends Error {
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
      },
    }
  }

  static fromError(e, errorCode = ERROR_CODES.UNKNOWN) {
    if (e instanceof AppError) return e
    return new AppError(errorCode, e.message, null, e)
  }
}

/**
 * 带超时与重试的 fetch
 * 使用 Node.js 18+ / Electron 31+ 内置的全局 fetch 和 AbortController
 * @param {string} url - 请求 URL
 * @param {object} options - fetch options（method/headers/body/signal 等）
 * @param {number} timeoutMs - 超时毫秒，默认 30000
 * @param {number} retries - 失败重试次数（仅对网络错误/5xx 重试），默认 0
 * @param {number[]} retryOnStatus - 需要重试的 HTTP 状态码
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 30000,
  retries = 0,
  retryOnStatus = [429, 500, 502, 503, 504]
) {
  // 兼容外部传入的 signal：将外部 signal 状态同步到内部 controller
  const externalSignal = options.signal
  let lastError

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()

    // 若外部 signal 已 abort，立即中止
    if (externalSignal && externalSignal.aborted) {
      controller.abort()
    } else if (externalSignal) {
      // 监听外部 signal，触发时同步 abort 内部 controller
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(url, { ...options, signal: controller.signal })
      clearTimeout(timeoutId)

      // 仅在指定状态码且仍有重试机会时重试
      if (retryOnStatus.includes(res.status) && attempt < retries) {
        const waitMs = (attempt + 1) * 1000
        await new Promise((r) => setTimeout(r, waitMs))
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
          // 外部主动 abort：原样抛 AbortError，调用方可识别为正常中止
          const err = new Error('Aborted by caller')
          err.name = 'AbortError'
          throw err
        }
        // 否则视为超时
        lastError = new AppError(
          ERROR_CODES.NETWORK_TIMEOUT,
          `请求超时 (${timeoutMs}ms): ${url}`,
          { url, timeoutMs }
        )
      }

      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 1000))
        continue
      }
      throw isAbort
        ? lastError
        : new AppError(ERROR_CODES.NETWORK_ERROR, e.message, { url }, e)
    }
  }
  throw lastError || new AppError(ERROR_CODES.UNKNOWN, 'fetchWithTimeout: 未知错误')
}

/**
 * 安全 JSON 序列化：处理循环引用
 * @param {*} obj - 待序列化的对象
 * @param {function|null} replacer - 自定义替换函数
 * @param {string|number|null} space - 缩进
 * @returns {string}
 */
function safeJsonStringify(obj, replacer = null, space = null) {
  const seen = new WeakSet()
  try {
    return JSON.stringify(
      obj,
      (key, value) => {
        if (replacer) value = replacer(key, value)
        if (value != null && typeof value === 'object') {
          if (seen.has(value)) return '[Circular]'
          seen.add(value)
        }
        return value
      },
      space
    )
  } catch {
    return String(obj)
  }
}

/**
 * 安全 JSON 解析：解析失败时返回 fallback
 * @param {string} str - JSON 字符串
 * @param {*} fallback - 解析失败时的回退值
 * @returns {*}
 */
function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str)
  } catch {
    return fallback
  }
}

module.exports = {
  ERROR_CODES,
  AppError,
  fetchWithTimeout,
  safeJsonStringify,
  safeJsonParse,
}
