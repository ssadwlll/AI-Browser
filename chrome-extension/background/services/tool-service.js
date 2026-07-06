// ============ ToolService ============
import { fetchWithTimeout, AppError, ERROR_CODES, LRUCache } from '../../shared/utils.js'

/**
 * 规范化脚本返回值为统一信封格式
 * 标准信封：{ ok, data, count, hint?, panelSelector?, panelInfo?, fields?, error? }
 *
 * 兼容三种历史格式：
 *  1) 裸数组：[{...}, {...}]                 → {ok:true, data:arr, count:arr.length}
 *  2) 旧包装：{ok, data, total}              → {ok, data, count:total}
 *  3) 无返回（DOM 注入型返回 undefined/'执行成功'）→ {ok:true, data:[], count:0}
 *
 * 已是新格式（含 ok + data 字段）则原样返回。
 * @param {*} raw - 脚本 return 的原始值
 * @param {string} toolName - 工具名（用于错误提示）
 * @returns {object} 标准信封
 */
function normalizeScriptResult(raw, toolName) {
  // 已是标准信封：含 ok 字段 + (data 字段 或 panelSelector 字段)
  if (raw && typeof raw === 'object' && !Array.isArray(raw) &&
      typeof raw.ok === 'boolean' &&
      (Array.isArray(raw.data) || raw.panelSelector || raw.error)) {
    return raw
  }

  // 裸数组 → 包装
  if (Array.isArray(raw)) {
    return {
      ok: true,
      data: raw,
      count: raw.length,
      hint: raw.length > 0
        ? `已获取 ${raw.length} 条数据（来自 ${toolName}），可直接使用或通过 finish_task 输出`
        : '数据为空，可能页面结构不匹配。可用 detect_page_template 重新检测',
    }
  }

  // 旧包装：{ok, data, total}
  if (raw && typeof raw === 'object' && raw.data !== undefined && raw.total !== undefined) {
    return {
      ok: raw.ok !== false,
      data: Array.isArray(raw.data) ? raw.data : [raw.data],
      count: raw.total || (Array.isArray(raw.data) ? raw.data.length : 1),
      hint: raw.ok === false
        ? `执行失败: ${raw.error || '未知错误'}`
        : `已获取 ${raw.total} 条数据（来自 ${toolName}）`,
      error: raw.ok === false ? raw.error : undefined,
    }
  }

  // 旧包装：{ok, data}（无 total）
  if (raw && typeof raw === 'object' && raw.data !== undefined && raw.ok !== undefined) {
    return {
      ok: raw.ok !== false,
      data: Array.isArray(raw.data) ? raw.data : [raw.data],
      count: Array.isArray(raw.data) ? raw.data.length : 1,
      hint: raw.ok === false
        ? `执行失败: ${raw.error || '未知错误'}`
        : `已获取数据（来自 ${toolName}）`,
      error: raw.ok === false ? raw.error : undefined,
    }
  }

  // 无返回值（DOM 注入型，靠副作用）
  if (raw === undefined || raw === null || raw === '执行成功') {
    return {
      ok: true,
      data: [],
      count: 0,
      hint: `${toolName} 已执行（DOM 注入型，无数据返回）。若面板已注入页面，可用 extract_content 提取面板内容`,
    }
  }

  // 单对象 → 包装为单元素数组
  if (raw && typeof raw === 'object') {
    return {
      ok: true,
      data: [raw],
      count: 1,
      hint: `已获取 1 条数据（来自 ${toolName}）`,
    }
  }

  // 原始类型（string/number/boolean）
  return {
    ok: true,
    data: [{ value: raw }],
    count: 1,
    hint: `已获取原始值（来自 ${toolName}）`,
  }
}

export class ToolService {
  constructor(configService) {
    this.configService = configService
    // Feature 3: 脚本执行结果 LRU 缓存，避免相同参数重复执行
    this._resultCache = new LRUCache(30)
  }

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
        15000, 0
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

  // 拉取完整脚本索引（id + name + description + urlPattern）
  // 用于 Agent 首轮注入"全脚本索引"，让 AI 全局可见所有可用脚本
  // 缓存 5 分钟，避免每次任务都请求后端
  async fetchAgentIndex() {
    const CACHE_KEY = '_agentIndexCache'
    const CACHE_TTL = 5 * 60 * 1000
    if (this[CACHE_KEY] && Date.now() - this[CACHE_KEY]._ts < CACHE_TTL) {
      return this[CACHE_KEY].data
    }
    const config = await this.configService.getSyncConfig()
    if (!config.serverUrl) return []
    try {
      const auth = await this.configService.getAppAuth()
      const authHeaders = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)
      const baseUrl = config.serverUrl.replace(/\/+$/, '')
      const res = await fetchWithTimeout(`${baseUrl}/api/scripts/agent-index`, {
        headers: authHeaders,
      }, 10000, 0)
      if (!res.ok) {
        console.warn('[ToolService] fetchAgentIndex HTTP', res.status)
        return []
      }
      const data = await res.json()
      if (data.success && Array.isArray(data.data)) {
        this[CACHE_KEY] = { data: data.data, _ts: Date.now() }
        return data.data
      }
    } catch (e) {
      console.warn('[ToolService] fetchAgentIndex error:', e.message)
    }
    return []
  }

  async fetchInjectData(scriptId) {
    const config = await this.configService.getSyncConfig()
    if (!config.serverUrl) return null
    try {
      const auth = await this.configService.getAppAuth()
      const authHeaders = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)
      const baseUrl = config.serverUrl.replace(/\/+$/, '')
      const res = await fetchWithTimeout(`${baseUrl}/api/scripts/${scriptId}/inject`, {
        headers: authHeaders,
      }, 15000, 0)
      if (!res.ok) {
        console.warn('[ToolService] fetchInjectData HTTP', res.status)
        return null
      }
      const data = await res.json()
      if (data.success && data.data) return data.data
    } catch (e) {
      console.warn('[ToolService] fetchInjectData error:', e.message)
    }
    return null
  }

  // 拉取后端报告模板列表（供 render_report 工具使用）
  // 返回与 BUILTIN_TEMPLATES 同格式的模板数组，失败时返回空数组
  async fetchReportTemplates() {
    const config = await this.configService.getSyncConfig()
    if (!config.serverUrl) return []
    try {
      const auth = await this.configService.getAppAuth()
      const authHeaders = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)
      const baseUrl = config.serverUrl.replace(/\/+$/, '')
      const res = await fetchWithTimeout(`${baseUrl}/api/report-templates`, {
        headers: authHeaders,
      }, 10000, 0)
      if (!res.ok) {
        console.warn('[ToolService] fetchReportTemplates HTTP', res.status)
        return []
      }
      const data = await res.json()
      if (data.success && Array.isArray(data.data)) {
        return data.data
      }
    } catch (e) {
      console.warn('[ToolService] fetchReportTemplates error:', e.message)
    }
    return []
  }

  async executeTool(tool, tabId, funcArgs) {
    console.log('[ToolService] executeTool:', tool.id, tool.name, 'type:', tool.toolType)
    const injectData = await this.fetchInjectData(tool.id)
    // 区分 JS 类型 / API 类型分别校验：
    // - JS 类型：必须有 code（注入页面执行的脚本代码）
    // - API 类型：必须有 tool_config.apiEndpoint（无需 code，由后端代理 HTTP 调用）
    const toolConfig = injectData?.tool_config || tool.toolConfig || {}
    const toolType = injectData?.tool_type || tool.toolType || 'js'
    const hasApiEndpoint = !!(toolConfig.apiEndpoint && typeof toolConfig.apiEndpoint === 'string')
    if (toolType === 'api') {
      if (!hasApiEndpoint) {
        console.warn('[ToolService] API 类型脚本缺少 apiEndpoint:', tool.id)
        return { ok: false, error: `脚本配置错误: API 类型脚本未配置 apiEndpoint (ID: ${tool.id})` }
      }
      // API 类型无需 code 字段，继续走 executeAPITool 路径
    } else {
      // JS 类型必须有可执行代码
      if (!injectData?.code) {
        console.warn('[ToolService] JS 类型脚本缺少 code:', tool.id)
        return { ok: false, error: `无法获取脚本代码 (ID: ${tool.id})` }
      }
    }
    console.log('[ToolService] 获取到代码，tool_type:', toolType, 'hasApiEndpoint:', hasApiEndpoint)

    // Feature 3: 结果缓存 — toolConfig.cacheable 为 true 时缓存结果
    // 缓存键：toolId + 参数摘要，避免相同参数重复执行
    // 改用局部变量，避免实例级 _pendingCacheKey 在并发调用时竞态（A 的结果被写到 B 的缓存键）
    let cacheKey = null
    if (toolConfig.cacheable === true) {
      cacheKey = `${tool.id}|${JSON.stringify(funcArgs || {})}`
      const cached = this._resultCache.get(cacheKey)
      if (cached) {
        console.log('[ToolService] 命中结果缓存:', tool.id)
        return cached
      }
    }

    let result
    if (toolType === 'api' && hasApiEndpoint) {
      console.log('[ToolService] API调用:', toolConfig.apiEndpoint, toolConfig.apiMethod || 'GET')
      result = await this.executeAPITool(toolConfig, tool.name, funcArgs)
    } else {
      result = await this.executeJSTool(injectData.code, toolConfig, tabId, tool.name, funcArgs)
    }

    // 执行成功后写入缓存
    if (cacheKey && result?.ok) {
      this._resultCache.set(cacheKey, result)
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
            // 检测脚本是否为 IIFE 包装形式：剥离头部注释行后以 (function 开头
            // 若是，则在前面加 return，让 IIFE 表达式语句的值成为 fn 的返回值
            // 否则 new Function 的函数体是表达式语句，IIFE 的 return 值会被丢弃，fn() 返回 undefined
            const lines = scriptCode.split('\n')
            let firstNonComment = 0
            while (firstNonComment < lines.length && /^\s*\/\//.test(lines[firstNonComment])) firstNonComment++
            const body = lines.slice(firstNonComment).join('\n').trim()
            const isIIFE = /^\(?\s*function\s*\(/.test(body)
            const wrappedCode = isIIFE
              ? lines.slice(0, firstNonComment).join('\n') + '\nreturn ' + body
              : scriptCode
            const fn = new Function('config', wrappedCode)
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
      // ===== 返回值规范化：统一为标准信封 {ok, data, count, hint, ...} =====
      // 兼容三种旧格式：1) 裸数组 [{...}] 2) {ok, data, total} 3) 无返回值（DOM 注入型）
      const raw = result.result
      const normalized = normalizeScriptResult(raw, toolName)
      return { ok: true, result: normalized }
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
