// ============ 配置管理服务（Electron 主进程版） ============
// 迁移自 chrome-extension/background/services/config-service.js
// 依赖 StorageService 进行持久化，使用 Node.js crypto 替代纯 JS HMAC
// 保存操作使用串行化锁（_saveChain），防止并发读-改-写导致后写覆盖前写

const crypto = require('crypto')
const { fetchWithTimeout, AppError, ERROR_CODES } = require('./utils')
const StorageService = require('./storage_service')

// ============ 默认配置 ============

const DEFAULT_AI_CONFIG = {
  model: 'deepseek-v4-pro',
  temperature: 0.7,
  maxTokens: 4096,
  systemPrompt: '你是 AI Browser 助手，可以帮助用户分析网页内容、回答问题、编写代码和执行操作。',
}

const DEFAULT_SYNC_CONFIG = {
  serverUrl: 'http://localhost:3001',
  appKey: '',
  appSecret: '',
  syncInterval: 30,
  enabled: false, // 默认关闭同步，避免未配置 appKey/appSecret 时持续发起失败请求
}

const DEFAULT_AGENT_CONFIG = {
  maxRounds: 15,
  maxConsecutiveFails: 5,
  maxLowValue: 3,
  maxIdleText: 2,
  explorationLimit: 5,
  enableJudge: true,
  enablePlanning: true,
  debug: false,
  fullDataMode: false,
}

// ============ ConfigService 对象 ============

const ConfigService = {
  // 配置保存串行化锁：防止并发读-改-写导致后写覆盖前写
  _saveChain: Promise.resolve(),
  // getAppSettings 的 in-flight Promise（并发去重）
  _appSettingsInFlight: null,

  // ============ AI 配置 ============

  async getAIConfig() {
    const data = await StorageService.get('aiConfig')
    return { ...DEFAULT_AI_CONFIG, ...(data || {}) }
  },

  async saveAIConfig(config) {
    // 串行化读-改-写
    const run = () =>
      (async () => {
        const old = await this.getAIConfig()
        const merged = { ...DEFAULT_AI_CONFIG, ...old, ...config }
        await StorageService.set('aiConfig', merged)
        return merged
      })()
    this._saveChain = this._saveChain.then(run, run)
    return this._saveChain
  },

  // ============ 同步配置 ============

  async getSyncConfig() {
    const data = await StorageService.get('syncConfig')
    return { ...DEFAULT_SYNC_CONFIG, ...(data || {}) }
  },

  async saveSyncConfig(config) {
    // 串行化读-改-写
    const run = () =>
      (async () => {
        const old = await this.getSyncConfig()
        const merged = { ...DEFAULT_SYNC_CONFIG, ...old, ...config }
        await StorageService.set('syncConfig', merged)
        return merged
      })()
    this._saveChain = this._saveChain.then(run, run)
    return this._saveChain
  },

  // ============ Agent 配置 ============

  async getAgentConfig() {
    const data = await StorageService.get('agentConfig')
    return { ...DEFAULT_AGENT_CONFIG, ...(data || {}) }
  },

  async saveAgentConfig(config) {
    // 串行化读-改-写：防止并发保存导致后写覆盖前写
    const run = () =>
      (async () => {
        const old = await this.getAgentConfig()
        const merged = { ...old, ...config }
        await StorageService.set('agentConfig', merged)
        return merged
      })()
    this._saveChain = this._saveChain.then(run, run)
    return this._saveChain
  },

  // ============ 选中工具开关 ============

  async getSelectionToolsEnabled() {
    const data = await StorageService.get('selectionToolsEnabled')
    return data !== false
  },

  async saveSelectionToolsEnabled(enabled) {
    await StorageService.set('selectionToolsEnabled', enabled)
  },

  // ============ 应用全局设置（从后端读取，本地缓存兜底） ============

  /**
   * 获取应用全局设置（从后端读取，本地缓存兜底）
   * 包含：agent_max_rounds、agent_system_prompt、pdf_max_size、image_max_size
   * 缓存策略：成功请求后写入本地（10分钟TTL），失败时回退缓存
   * 并发去重：同一时刻多次调用共享同一个 in-flight Promise，避免重复请求
   * @returns {Promise<object>}
   */
  async getAppSettings() {
    const CACHE_KEY = 'appSettingsCache'
    const CACHE_TTL_MS = 10 * 60 * 1000 // 10 分钟

    // 1. 读本地缓存（含时间戳）
    const cachedData = await StorageService.get(CACHE_KEY)
    const now = Date.now()
    if (cachedData && cachedData._ts && now - cachedData._ts < CACHE_TTL_MS) {
      return this._normalizeAppSettings(cachedData)
    }

    // 2. 并发去重：如果已有 in-flight 请求，复用之
    if (this._appSettingsInFlight) {
      return this._appSettingsInFlight
    }

    // 3. 缓存过期或不存在，尝试从后端拉取
    this._appSettingsInFlight = (async () => {
      try {
        const syncConfig = await this.getSyncConfig()
        if (!syncConfig.serverUrl) {
          // 未配置服务器地址，返回缓存或默认值
          return this._normalizeAppSettings(cachedData || {})
        }
        if (!syncConfig.appKey || !syncConfig.appSecret) {
          // 未配置认证信息，返回缓存或默认值
          return this._normalizeAppSettings(cachedData || {})
        }
        // URL 规范化：去掉末尾斜杠后拼接路径
        const baseUrl = String(syncConfig.serverUrl).replace(/\/+$/, '')
        const url = `${baseUrl}/api/app-settings/client`
        const headers = await this.generateAuthHeaders(syncConfig.appKey, syncConfig.appSecret)
        const res = await fetchWithTimeout(url, { method: 'GET', headers }, 15000, 1)
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new AppError(
            ERROR_CODES.NETWORK_ERROR,
            `获取应用设置失败: ${res.status} ${text.slice(0, 200)}`
          )
        }
        const json = await res.json()
        if (!json.success) {
          throw new AppError(ERROR_CODES.UNKNOWN, json.error || '获取应用设置失败')
        }
        const fresh = { ...(json.data || {}), _ts: Date.now() }
        await StorageService.set(CACHE_KEY, fresh)
        return this._normalizeAppSettings(fresh)
      } catch (e) {
        // 4. 后端请求失败：回退到缓存（即使过期）或内置默认值
        console.warn('[ConfigService] getAppSettings 后端请求失败，使用缓存/默认值:', e.message)
        if (cachedData) return this._normalizeAppSettings(cachedData)
        return this._normalizeAppSettings({})
      }
    })()

    try {
      return await this._appSettingsInFlight
    } finally {
      // 无论成功失败，清除 in-flight 标记，下次调用可重新发起请求
      this._appSettingsInFlight = null
    }
  },

  /**
   * 规范化应用设置（确保字段类型正确，提供默认值）
   */
  _normalizeAppSettings(raw) {
    return {
      agent_max_rounds: parseInt(raw.agent_max_rounds, 10) || 30,
      agent_system_prompt:
        typeof raw.agent_system_prompt === 'string' && raw.agent_system_prompt.length > 0
          ? raw.agent_system_prompt
          : '',
      pdf_max_size: parseInt(raw.pdf_max_size, 10) || 10485760, // 默认 10MB
      image_max_size: parseInt(raw.image_max_size, 10) || 5242880, // 默认 5MB
    }
  },

  // ============ 认证 ============

  /**
   * 获取 AppKey/AppSecret 认证信息
   */
  async getAppAuth() {
    const syncConfig = await this.getSyncConfig()
    return { appKey: syncConfig.appKey || '', appSecret: syncConfig.appSecret || '' }
  },

  /**
   * 生成签名请求头
   * 算法：HMAC-SHA256(appKey + timestamp, appSecret)，输出小写hex
   * 使用 Node.js 原生 crypto.createHmac 替代纯 JS 实现
   * @param {string} appKey
   * @param {string} appSecret
   * @returns {Promise<object>} 包含 X-App-Key/X-Timestamp/X-Sign 的请求头
   */
  async generateAuthHeaders(appKey, appSecret) {
    const headers = { 'Content-Type': 'application/json' }
    if (appKey && appSecret) {
      const timestamp = String(Math.floor(Date.now() / 1000))
      const message = appKey + timestamp
      headers['X-App-Key'] = appKey
      headers['X-Timestamp'] = timestamp
      // 使用 Node.js 原生 crypto 模块，正确处理 UTF-8 编码
      headers['X-Sign'] = crypto.createHmac('sha256', appSecret).update(message).digest('hex')
    }
    return headers
  },

  // ============ AI 代理 ============

  /**
   * 返回 AI 代理接口 URL
   */
  async getAIProxyUrl() {
    const syncConfig = await this.getSyncConfig()
    return String(syncConfig.serverUrl).replace(/\/+$/, '') + '/api/ai-proxy/chat'
  },

  /**
   * 获取可用模型列表
   * 调用 GET {serverUrl}/api/ai-models/available（带签名认证）
   */
  async getAvailableModels() {
    const syncConfig = await this.getSyncConfig()
    const url = String(syncConfig.serverUrl).replace(/\/+$/, '') + '/api/ai-models/available'
    const headers = await this.generateAuthHeaders(syncConfig.appKey, syncConfig.appSecret)
    // 使用 fetchWithTimeout：15s 超时 + 1 次重试（对 5xx 自动重试）
    const res = await fetchWithTimeout(url, { method: 'GET', headers }, 15000, 1)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new AppError(
        ERROR_CODES.AUTH_INVALID,
        `获取模型列表失败: ${res.status} ${text.slice(0, 200)}`
      )
    }
    const json = await res.json()
    if (!json.success) {
      throw new AppError(ERROR_CODES.UNKNOWN, json.error || json.message || '获取模型列表失败')
    }
    return json.data
  },

  // ============ 上传配置 ============

  /**
   * 获取 PDF 上传所需的 URL 与签名请求头（不含二进制内容）
   * 调用方直接用 File 对象 fetch 上传
   * @returns {Promise<{url:string, headers:Object}>}
   */
  async getPdfUploadConfig() {
    const syncConfig = await this.getSyncConfig()
    const url = String(syncConfig.serverUrl).replace(/\/+$/, '') + '/api/ai-proxy/parse-pdf'
    const headers = await this.generateAuthHeaders(syncConfig.appKey, syncConfig.appSecret)
    // multipart 上传由 fetch 自动设置 Content-Type + boundary，移除默认的 JSON 头
    delete headers['Content-Type']
    return { url, headers }
  },

  /**
   * 获取图片上传所需的 URL 与签名请求头
   * @returns {Promise<{url:string, headers:Object}>}
   */
  async getImageUploadConfig() {
    const syncConfig = await this.getSyncConfig()
    const url = String(syncConfig.serverUrl).replace(/\/+$/, '') + '/api/ai-proxy/upload-image'
    const headers = await this.generateAuthHeaders(syncConfig.appKey, syncConfig.appSecret)
    delete headers['Content-Type']
    return { url, headers }
  },
}

module.exports = ConfigService
