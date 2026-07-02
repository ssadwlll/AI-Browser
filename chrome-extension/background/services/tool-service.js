// ============ ToolService ============
import { fetchWithTimeout, AppError, ERROR_CODES, LRUCache } from '../../shared/utils.js'

export class ToolService {
  constructor(configService) {
    this.configService = configService
    // Feature 3: 脚本执行结果 LRU 缓存，避免相同参数重复执行
    this._resultCache = new LRUCache(30)
  }

  async searchScripts(query) {
    console.log('[ToolService] searchScripts query:', query)
    const config = await this.configService.getSyncConfig()
    console.log('[ToolService] serverUrl:', config.serverUrl, 'hasToken:', !!config.token)
    if (!config.serverUrl) return []
    try {
      const auth = await this.configService.getAppAuth()
      const authHeaders = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)
      const res = await fetchWithTimeout(
        `${config.serverUrl}/api/scripts/search?q=${encodeURIComponent(query)}&limit=5`,
        { headers: authHeaders },
        15000, 0
      )
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

  async fetchInjectData(scriptId) {
    const config = await this.configService.getSyncConfig()
    if (!config.serverUrl) return null
    try {
      const auth = await this.configService.getAppAuth()
      const authHeaders = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)
      const res = await fetchWithTimeout(`${config.serverUrl}/api/scripts/${scriptId}/inject`, {
        headers: authHeaders,
      }, 15000, 0)
      const data = await res.json()
      if (data.success && data.data) return data.data
    } catch (e) {
      console.warn('[ToolService] fetchInjectData error:', e.message)
    }
    return null
  }

  async executeTool(tool, tabId, funcArgs) {
    console.log('[ToolService] executeTool:', tool.id, tool.name, 'type:', tool.toolType)
    const injectData = await this.fetchInjectData(tool.id)
    if (!injectData?.code) {
      console.warn('[ToolService] 无法获取脚本代码:', tool.id)
      return { ok: false, error: `无法获取脚本代码 (ID: ${tool.id})` }
    }
    console.log('[ToolService] 获取到代码，tool_type:', injectData.tool_type, 'hasApiEndpoint:', !!injectData.tool_config?.apiEndpoint)

    const toolConfig = injectData.tool_config || tool.toolConfig || {}
    const toolType = injectData.tool_type || tool.toolType || 'js'

    // Feature 3: 结果缓存 — toolConfig.cacheable 为 true 时缓存结果
    // 缓存键：toolId + 参数摘要，避免相同参数重复执行
    if (toolConfig.cacheable === true) {
      const cacheKey = `${tool.id}|${JSON.stringify(funcArgs || {})}`
      const cached = this._resultCache.get(cacheKey)
      if (cached) {
        console.log('[ToolService] 命中结果缓存:', tool.id)
        return cached
      }
      // 暂存 cacheKey 供执行后写入
      this._pendingCacheKey = cacheKey
    } else {
      this._pendingCacheKey = null
    }

    let result
    if (toolType === 'api' && toolConfig.apiEndpoint) {
      console.log('[ToolService] API调用:', toolConfig.apiEndpoint, toolConfig.apiMethod || 'GET')
      result = await this.executeAPITool(toolConfig, tool.name, funcArgs)
    } else {
      result = await this.executeJSTool(injectData.code, toolConfig, tabId, tool.name, funcArgs)
    }

    // 执行成功后写入缓存
    if (this._pendingCacheKey && result?.ok) {
      this._resultCache.set(this._pendingCacheKey, result)
      this._pendingCacheKey = null
    }

    return result
  }

  /**
   * 清空结果缓存（任务结束时调用）
   */
  clearCache() {
    this._resultCache.clear()
  }

  async executeJSTool(code, toolConfig, tabId, toolName) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (scriptCode, config) => {
          // 使用 finally 确保 __TOOL_CONFIG__ 总是被清理，避免异常时残留污染下一工具
          try {
            window.__TOOL_CONFIG__ = config || {}
            const fn = new Function('config', scriptCode)
            const result = fn(config || {})
            return { ok: true, result: result !== undefined ? result : '执行成功' }
          } catch (e) {
            return { ok: false, error: e.message }
          } finally {
            // 无论如何都清理全局配置，防止异常时残留
            try { delete window.__TOOL_CONFIG__ } catch {}
          }
        },
        args: [code, toolConfig],
        world: 'MAIN',
      })
      // 防御空结果（tab 已关闭、frame 未匹配等场景）
      const result = results?.[0]?.result
      if (!result) {
        return { ok: false, error: '脚本执行无返回结果（目标标签页可能已关闭或正在导航中）' }
      }
      if (result.ok === false) {
        return { ok: false, error: result.error || '脚本执行失败' }
      }
      return { ok: true, result: result.result }
    } catch (e) {
      if (e.message?.includes('Cannot access a chrome:// URL') || e.message?.includes('Cannot access contents of url')) {
        return { ok: false, error: '当前页面为系统页面，无法注入脚本。请用finish_task告知用户：请在普通网页上执行此操作。' }
      }
      return { ok: false, error: e.message }
    }
  }

  async executeAPITool(toolConfig, toolName, funcArgs) {
    let { apiEndpoint, apiMethod = 'GET', apiHeaders = {}, apiBody, requireAuth } = toolConfig
    try {
      if (apiEndpoint && (apiEndpoint.startsWith('/') || !apiEndpoint.startsWith('http'))) {
        const config = await this.configService.getSyncConfig()
        if (config.serverUrl) {
          const base = config.serverUrl.replace(/\/+$/, '')
          // 规范化拼接：base + apiEndpoint（确保恰好一个 / 分隔）
          apiEndpoint = base + '/' + apiEndpoint.replace(/^\/+/, '')
        }
        // 相对路径自动签名认证
        if (requireAuth !== false) {
          const auth = await this.configService.getAppAuth()
          if (auth.appKey && auth.appSecret) {
            const authHeaders = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)
            apiHeaders = { ...apiHeaders, ...authHeaders }
          }
        }
      }
      // 动态参数合并：funcArgs 合并到 apiBody
      let finalBody = apiBody || {}
      if (typeof finalBody === 'string') {
        try { finalBody = JSON.parse(finalBody) } catch { finalBody = {} }
      }
      if (funcArgs && typeof funcArgs === 'object') {
        finalBody = { ...finalBody, ...funcArgs }
      }
      const fetchOptions = {
        method: apiMethod,
        headers: { 'Content-Type': 'application/json', ...apiHeaders },
      }
      if (apiMethod !== 'GET' && Object.keys(finalBody).length > 0) {
        fetchOptions.body = JSON.stringify(finalBody)
      }
      const res = await fetchWithTimeout(apiEndpoint, fetchOptions, 30000, 0)
      console.log('[ToolService] API响应状态:', res.status, res.statusText)
      const data = await res.json()
      console.log('[ToolService] API返回数据类型:', typeof data, 'keys:', Object.keys(data || {}).join(','))

      const extractor = toolConfig.resultExtractor
      let result = data
      if (extractor && typeof extractor === 'string') {
        result = extractor.split('.').reduce((obj, key) => obj?.[key], data)
      }
      // 用 ?? 替代 ||，避免 0/false/'' 等合法 falsy 值被误判为"未提取到"而回退到原始 data
      const finalResult = (result === undefined || result === null) ? data : result
      console.log('[ToolService] 最终结果长度:', JSON.stringify(finalResult).length)
      return { ok: true, result: finalResult }
    } catch (e) {
      console.error('[ToolService] API调用失败:', e.message)
      return { ok: false, error: e.message }
    }
  }
}
