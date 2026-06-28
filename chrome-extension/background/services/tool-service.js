// ============ ToolService ============
export class ToolService {
  constructor(configService) {
    this.configService = configService
  }

  async searchScripts(query) {
    console.log('[ToolService] searchScripts query:', query)
    const config = await this.configService.getSyncConfig()
    console.log('[ToolService] serverUrl:', config.serverUrl, 'hasToken:', !!config.token)
    if (!config.serverUrl) return []
    try {
      const res = await fetch(
        `${config.serverUrl}/api/scripts/search?q=${encodeURIComponent(query)}&limit=5`,
        config.token ? { headers: { Authorization: `Bearer ${config.token}` } } : {}
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
      const res = await fetch(`${config.serverUrl}/api/scripts/${scriptId}/inject`, {
        headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
      })
      const data = await res.json()
      if (data.success && data.data) return data.data
    } catch (e) {
      console.warn('[ToolService] fetchInjectData error:', e.message)
    }
    return null
  }

  async getPageContent() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) return null
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'extractPageContent',
      })
      return response?.data || null
    } catch (e) {
      console.warn('[ToolService] getPageContent error:', e.message)
      return null
    }
  }

  async executeTool(tool, tabId) {
    console.log('[ToolService] executeTool:', tool.id, tool.name, 'type:', tool.toolType)
    const injectData = await this.fetchInjectData(tool.id)
    if (!injectData?.code) {
      console.warn('[ToolService] 无法获取脚本代码:', tool.id)
      return { ok: false, error: `无法获取脚本代码 (ID: ${tool.id})` }
    }
    console.log('[ToolService] 获取到代码，tool_type:', injectData.tool_type, 'hasApiEndpoint:', !!injectData.tool_config?.apiEndpoint)

    const toolConfig = injectData.tool_config || tool.toolConfig || {}
    const toolType = injectData.tool_type || tool.toolType || 'js'

    if (toolType === 'api' && toolConfig.apiEndpoint) {
      console.log('[ToolService] API调用:', toolConfig.apiEndpoint, toolConfig.apiMethod || 'GET')
      return await this.executeAPITool(toolConfig, tool.name)
    }

    return await this.executeJSTool(injectData.code, toolConfig, tabId, tool.name)
  }

  async executeJSTool(code, toolConfig, tabId, toolName) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (scriptCode, config) => {
          try {
            window.__TOOL_CONFIG__ = config || {}
            const fn = new Function('config', scriptCode)
            const result = fn(config || {})
            delete window.__TOOL_CONFIG__
            return { ok: true, result: result !== undefined ? result : '执行成功' }
          } catch (e) {
            return { ok: false, error: e.message }
          }
        },
        args: [code, toolConfig],
        world: 'MAIN',
      })
      const result = results[0]?.result
      if (!result.ok) {
        return { ok: false, error: result.error }
      }
      return { ok: true, result: result.result }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  async executeAPITool(toolConfig, toolName) {
    let { apiEndpoint, apiMethod = 'GET', apiHeaders = {}, apiBody } = toolConfig
    try {
      if (apiEndpoint && (apiEndpoint.startsWith('/') || !apiEndpoint.startsWith('http'))) {
        const config = await this.configService.getSyncConfig()
        if (config.serverUrl) {
          const base = config.serverUrl.replace(/\/+$/, '')
          apiEndpoint = base + (apiEndpoint.startsWith('/') ? '' : '/') + apiEndpoint
        }
      }
      const fetchOptions = {
        method: apiMethod,
        headers: { 'Content-Type': 'application/json', ...apiHeaders },
      }
      if (apiMethod !== 'GET' && apiBody) {
        fetchOptions.body = typeof apiBody === 'string' ? apiBody : JSON.stringify(apiBody)
      }
      const res = await fetch(apiEndpoint, fetchOptions)
      console.log('[ToolService] API响应状态:', res.status, res.statusText)
      const data = await res.json()
      console.log('[ToolService] API返回数据类型:', typeof data, 'keys:', Object.keys(data || {}).join(','))

      const extractor = toolConfig.resultExtractor
      let result = data
      if (extractor && typeof extractor === 'string') {
        result = extractor.split('.').reduce((obj, key) => obj?.[key], data)
      }
      const finalResult = result || data
      console.log('[ToolService] 最终结果长度:', JSON.stringify(finalResult).length)
      return { ok: true, result: finalResult }
    } catch (e) {
      console.error('[ToolService] API调用失败:', e.message)
      return { ok: false, error: e.message }
    }
  }
}
