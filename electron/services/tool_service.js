// ============ ToolService（Electron 主进程版） ============
// 迁移自 chrome-extension/background/services/tool-service.js
// 通过后端 admin-server API 搜索和执行脚本
// 关键适配：fetchWithTimeout 从 utils 导入，configService 注入

const { fetchWithTimeout } = require('./utils')

class ToolService {
  constructor(configService) {
    this.configService = configService
    // 全脚本索引缓存（5分钟TTL）
    this._agentIndexCache = null
    this._agentIndexTs = 0
    this._agentIndexTTL = 5 * 60 * 1000
  }

  /**
   * 搜索脚本库
   * @param {string} query - 搜索关键词
   * @returns {Promise<Array>} 匹配的脚本列表
   */
  async searchScripts(query) {
    console.log('[ToolService] searchScripts query:', query)
    const config = await this.configService.getSyncConfig()
    if (!config.serverUrl) {
      console.warn('[ToolService] serverUrl 未配置，searchScripts 返回空')
      return []
    }
    try {
      const auth = await this.configService.getAppAuth()
      const authHeaders = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)
      const baseUrl = config.serverUrl.replace(/\/+$/, '')
      const res = await fetchWithTimeout(
        `${baseUrl}/api/scripts/search?q=${encodeURIComponent(query)}&limit=5`,
        { headers: authHeaders },
        15000
      )
      if (!res.ok) {
        console.warn('[ToolService] searchScripts HTTP', res.status)
        return []
      }
      const data = await res.json()
      if (data.success && Array.isArray(data.data)) {
        return data.data.map(t => ({
          id: t.id,
          name: t.name,
          description: t.description,
          toolType: t.toolType || 'js',
          toolConfig: t.toolConfig || {},
          urlPattern: t.urlPattern,
          metadata: t.metadata || {},
          precheck: t.precheck || '',
          memorySuccess: t.memorySuccess,
          memoryTotal: t.memoryTotal,
        }))
      }
    } catch (e) {
      console.warn('[ToolService] searchScripts error:', e.message)
    }
    return []
  }

  /**
   * 拉取完整脚本索引（id + name + description + urlPattern）
   * 缓存 5 分钟，避免每次任务都请求后端
   */
  async fetchAgentIndex() {
    if (this._agentIndexCache && Date.now() - this._agentIndexTs < this._agentIndexTTL) {
      return this._agentIndexCache
    }
    const config = await this.configService.getSyncConfig()
    if (!config.serverUrl) return []
    try {
      const auth = await this.configService.getAppAuth()
      const authHeaders = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)
      const baseUrl = config.serverUrl.replace(/\/+$/, '')
      const res = await fetchWithTimeout(
        `${baseUrl}/api/scripts/agent-index`,
        { headers: authHeaders },
        15000
      )
      if (!res.ok) return []
      const data = await res.json()
      if (data.success && Array.isArray(data.data)) {
        this._agentIndexCache = data.data
        this._agentIndexTs = Date.now()
        return this._agentIndexCache
      }
    } catch (e) {
      console.warn('[ToolService] fetchAgentIndex error:', e.message)
    }
    return []
  }

  /**
   * 执行指定脚本（JS 类型：在 BrowserView 中执行；API 类型：调用远程端点）
   * @param {object} tool - 脚本对象
   * @param {number} tabId - 标签页 ID
   * @param {object} funcArgs - 工具参数
   * @returns {Promise<object>} 执行结果
   */
  async executeTool(tool, tabId, funcArgs) {
    const scriptId = tool.id
    const scriptName = tool.name || `script#${scriptId}`

    // API 类型脚本：调用远程端点
    if (tool.toolType === 'api' || tool.toolConfig?.apiEndpoint) {
      return await this._executeApiScript(tool, funcArgs)
    }

    // JS 类型脚本：在 BrowserView 中执行
    return await this._executeJsScript(tool, tabId, funcArgs)
  }

  /**
   * 执行 API 类型脚本
   */
  async _executeApiScript(tool, funcArgs) {
    const apiEndpoint = tool.toolConfig?.apiEndpoint
    if (!apiEndpoint) {
      return { ok: false, error: `脚本 ${tool.name} 未配置 apiEndpoint` }
    }
    try {
      const config = await this.configService.getSyncConfig()
      const baseUrl = config.serverUrl ? config.serverUrl.replace(/\/+$/, '') : ''
      const url = apiEndpoint.startsWith('http') ? apiEndpoint : `${baseUrl}${apiEndpoint}`
      const auth = await this.configService.getAppAuth()
      const authHeaders = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)
      authHeaders['Content-Type'] = 'application/json'
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(funcArgs),
      }, 30000)
      const data = await res.json()
      if (data.success) {
        return { ok: true, result: data.data }
      }
      return { ok: false, error: data.error || 'API 执行失败' }
    } catch (e) {
      return { ok: false, error: `API 脚本执行失败: ${e.message}` }
    }
  }

  /**
   * 获取脚本注入数据（包含代码）
   * @param {number} scriptId - 脚本 ID
   * @returns {Promise<object|null>} 脚本注入数据（id, name, code, tool_type, tool_config等）
   */
  async getInjectData(scriptId) {
    const config = await this.configService.getSyncConfig()
    if (!config.serverUrl) return null
    try {
      const auth = await this.configService.getAppAuth()
      const authHeaders = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)
      const baseUrl = config.serverUrl.replace(/\/+$/, '')
      const res = await fetchWithTimeout(
        `${baseUrl}/api/scripts/${scriptId}/inject`,
        { headers: authHeaders },
        10000
      )
      if (!res.ok) return null
      const data = await res.json()
      if (data.success && data.data) {
        return data.data // { id, name, code, tool_type, tool_config, params, params_schema }
      }
    } catch (e) {
      console.warn('[ToolService] getInjectData error:', e.message)
    }
    return null
  }

  /**
   * 执行 JS 类型脚本：在 BrowserView 中通过 executeJavaScript 执行
   * 注意：此方法现在返回错误，因为 agent_runner 应该直接调用 getInjectData 获取代码后执行
   */
  async _executeJsScript(tool, tabId, funcArgs) {
    // 此方法已废弃，agent_runner 应使用 getInjectData 获取代码后直接执行
    return { ok: false, error: '请使用 getInjectData 获取脚本代码后在 agent_runner 中直接执行' }
  }

  /**
   * 获取报告模板列表
   */
  async fetchReportTemplates() {
    const config = await this.configService.getSyncConfig()
    if (!config.serverUrl) return []
    try {
      const auth = await this.configService.getAppAuth()
      const authHeaders = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)
      const baseUrl = config.serverUrl.replace(/\/+$/, '')
      const res = await fetchWithTimeout(
        `${baseUrl}/api/report-templates`,
        { headers: authHeaders },
        10000
      )
      if (!res.ok) return []
      const data = await res.json()
      if (data.success && Array.isArray(data.data)) return data.data
    } catch (e) {
      console.warn('[ToolService] fetchReportTemplates error:', e.message)
    }
    return []
  }

  /**
   * URL 匹配：判断 urlPattern 是否匹配当前页面 URL
   * 支持逗号分隔的多模式匹配（如 "*bilibili.com/video/*, *bilibili.com/bangumi/play/*"）
   * @param {string} urlPattern - URL 匹配模式（支持通配符 *、逗号分隔多模式）
   * @param {string} currentPageUrl - 当前页面 URL
   * @returns {boolean} 是否匹配
   */
  matchUrl(urlPattern, currentPageUrl) {
    if (!urlPattern || !currentPageUrl) return false
    if (urlPattern === '*') return true

    // 支持逗号分隔的多模式：任一模式匹配即返回 true
    const patterns = urlPattern.split(',').map(p => p.trim()).filter(p => p)
    if (patterns.length === 0) return false
    if (patterns.length === 1) return this._matchSingleUrlPattern(patterns[0], currentPageUrl)
    return patterns.some(p => this._matchSingleUrlPattern(p, currentPageUrl))
  }

  /**
   * 单个模式匹配（内部方法）
   */
  _matchSingleUrlPattern(urlPattern, currentPageUrl) {
    if (urlPattern === '*') return true
    if (!urlPattern || !currentPageUrl) return false

    // 简单通配符匹配
    if (urlPattern.includes('*')) {
      const regexPattern = urlPattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // 转义特殊字符
        .replace(/\*/g, '.*') // * → .* 通配符
      try {
        const regex = new RegExp(`^${regexPattern}$`, 'i')
        return regex.test(currentPageUrl)
      } catch (e) {
        return false
      }
    }

    // 精确匹配（忽略协议差异 http/https）
    try {
      const patternUrl = new URL(urlPattern.replace(/^https?/, 'http'))
      const currentUrl = new URL(currentPageUrl.replace(/^https?/, 'http'))
      return patternUrl.hostname === currentUrl.hostname &&
        patternUrl.pathname === currentUrl.pathname
    } catch (e) {
      // 如果 URL 解析失败，尝试简单的字符串匹配
      return currentPageUrl.includes(urlPattern)
    }
  }
}

module.exports = ToolService
