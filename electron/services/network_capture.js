// ============ CDP 网络捕获器 ============
// 基于 Electron webContents.debugger（内置 CDP 客户端）实现
// 捕获请求体 + 响应体，供逆向分析使用
// 符合项目硬约束：使用 Electron 内置 API（非外部 CDP 库）

const MAX_BODY_CHARS = 500 * 1024 // 单条响应体上限 500KB，超出截断

class NetworkCapture {
  constructor() {
    this.attached = new Map() // webContentsId -> { requests: Map, responses: Map, order: [] }
  }

  /**
   * 开始捕获指定 webContents 的网络请求
   */
  async start(webContents) {
    const wcId = webContents.id
    if (this.attached.has(wcId)) {
      return { success: true, message: '已正在捕获', wcId }
    }

    const state = {
      webContents,
      requests: new Map(),   // requestId -> 请求信息（含 postData）
      responses: new Map(),  // requestId -> 响应元信息
      bodies: new Map(),     // requestId -> 响应体（含 base64Encoded 标记）
      order: [],             // 请求顺序（requestId 数组）
      finishedIds: new Set(), // 已完成的 requestId
      onMessage: null,       // 保存事件回调引用，便于 removeListener
    }
    this.attached.set(wcId, state)

    try {
      webContents.debugger.attach('1.3')
      await webContents.debugger.sendCommand('Network.enable')
      await webContents.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true })

      // 用闭包绑定 state，避免在回调里查找（event 参数不是 ipcMain 的 Event，没有 sender）
      state.onMessage = (_event, method, params) => {
        this._handleMessage(state, method, params)
      }
      webContents.debugger.on('message', state.onMessage)

      console.log(`[NetworkCapture] 已附加 CDP，wcId=${wcId}`)
      return { success: true, wcId }
    } catch (e) {
      this.attached.delete(wcId)
      console.error('[NetworkCapture] CDP 附加失败:', e.message)
      return { success: false, error: e.message }
    }
  }

  /**
   * 停止捕获
   */
  async stop(webContents) {
    const wcId = webContents.id
    const state = this.attached.get(wcId)
    if (!state) return { success: false, error: '未在捕获状态' }
    try {
      if (state.onMessage) {
        webContents.debugger.removeListener('message', state.onMessage)
      }
      if (webContents.debugger.isAttached()) {
        webContents.debugger.detach()
      }
    } catch (e) {
      console.warn('[NetworkCapture] 分离 CDP 失败:', e.message)
    }
    this.attached.delete(wcId)
    console.log(`[NetworkCapture] 已停止捕获，wcId=${wcId}`)
    return { success: true }
  }

  /**
   * 重置捕获数据（不停止捕获）
   */
  reset(webContents) {
    const wcId = webContents.id
    const state = this.attached.get(wcId)
    if (!state) return { success: false, error: '未在捕获状态' }
    state.requests.clear()
    state.responses.clear()
    state.bodies.clear()
    state.order = []
    state.finishedIds.clear()
    return { success: true }
  }

  /**
   * 判断是否正在捕获
   */
  isCapturing(webContents) {
    return this.attached.has(webContents?.id)
  }

  /**
   * CDP 消息处理（由闭包回调直接传入 state，不再需要查找）
   */
  _handleMessage(state, method, params) {
    try {
      switch (method) {
        case 'Network.requestWillBeSent':
          this._handleRequest(params, state)
          break
        case 'Network.responseReceived':
          this._handleResponseMeta(params, state)
          break
        case 'Network.loadingFinished':
          this._handleLoadingFinished(params, state)
          break
        case 'Network.loadingFailed':
          state.finishedIds.add(params.requestId)
          break
      }
    } catch (e) {
      console.warn('[NetworkCapture] 消息处理失败:', method, e.message)
    }
  }

  _handleRequest(params, state) {
    const { requestId, request, type, timestamp } = params
    // 跳过 favicon、data:URL、静态资源（除非是 js/xhr/fetch）
    const resourceType = type || request?.type
    const url = request?.url || ''
    if (url.includes('favicon.ico') || url.startsWith('data:')) return

    console.log(`[NetworkCapture] 请求: ${request?.method || 'GET'} ${url.substring(0, 80)}`)

    state.requests.set(requestId, {
      requestId,
      url,
      method: request?.method || 'GET',
      headers: request?.headers || {},
      postData: request?.postData || null,  // ★ CDP 提供请求体
      postDataEntries: request?.postDataEntries || null,
      resourceType: resourceType,
      timestamp,
      wallTime: params.wallTime,
      hasPostData: request?.hasPostData || !!request?.postData,
      initiator: params.initiator ? {
        type: params.initiator.type,
        url: params.initiator.url || '',
        lineNumber: params.initiator.lineNumber,
      } : null,
    })
    state.order.push(requestId)
  }

  _handleResponseMeta(params, state) {
    const { requestId, response, type } = params
    if (!response) return
    state.responses.set(requestId, {
      requestId,
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers || {},
      mimeType: response.mimeType,
      charset: response.charset,
      resourceType: type,
      remoteIP: response.remoteIPAddress,
      remotePort: response.remotePort,
      timing: response.timing ? {
        sendStart: response.timing.sendStart,
        receiveHeadersEnd: response.timing.receiveHeadersEnd,
        waitTime: response.timing.waitTime,
      } : null,
      protocol: response.protocol,
    })
  }

  async _handleLoadingFinished(params, state) {
    const { requestId, encodedDataLength, timestamp } = params
    state.finishedIds.add(requestId)
    // 异步获取响应体
    try {
      const result = await state.webContents.debugger.sendCommand('Network.getResponseBody', { requestId })
      const body = result.body || ''
      const isBase64 = result.base64Encoded
      const bodyStr = isBase64 ? `<base64:${body.length}字符>` : body
      state.bodies.set(requestId, {
        body: bodyStr.length > MAX_BODY_CHARS ? bodyStr.slice(0, MAX_BODY_CHARS) + '\n...[截断]' : bodyStr,
        base64Encoded: isBase64,
        truncated: bodyStr.length > MAX_BODY_CHARS,
        actualLength: bodyStr.length,
        encodedDataLength,
      })
    } catch (e) {
      // 某些请求（如 304、被取消）无法获取响应体，静默跳过
      state.bodies.set(requestId, { body: null, error: e.message })
    }
  }

  /**
   * 获取已捕获的请求列表（合并请求+响应+响应体）
   * @param {object} options - 过滤选项
   * @param {string} options.urlFilter - URL 关键词过滤
   * @param {string} options.method - HTTP 方法过滤
   * @param {string} options.resourceType - 资源类型过滤（XHR/Fetch/Script 等）
   * @param {boolean} options.includeBody - 是否包含请求体/响应体（默认 true）
   * @param {number} options.limit - 最多返回多少条（默认 100）
   */
  getRequests(webContents, options = {}) {
    const wcId = webContents.id
    const state = this.attached.get(wcId)
    if (!state) return { success: false, error: '未在捕获状态', requests: [] }

    const { urlFilter = '', method = '', resourceType = '', includeBody = true, limit = 100 } = options

    // 资源类型筛选：逆向分析默认只看 XHR/Fetch，但支持传 '' 看全部
    const typeFilter = resourceType || ''
    // 如果没指定 resourceType，默认过滤出 XHR/Fetch/Script（逆向主要看这三类）
    const defaultTypes = ['XHR', 'Fetch', 'Script']

    const result = []
    // 按捕获顺序倒序（最新优先）
    const order = [...state.order].reverse()
    for (const reqId of order) {
      const req = state.requests.get(reqId)
      if (!req) continue
      const resp = state.responses.get(reqId)
      const body = state.bodies.get(reqId)

      // URL 过滤
      if (urlFilter && !req.url.toLowerCase().includes(urlFilter.toLowerCase())) continue
      // 方法过滤
      if (method && req.method.toUpperCase() !== method.toUpperCase()) continue
      // 资源类型过滤
      const rType = resp?.resourceType || req.resourceType
      if (typeFilter) {
        if (rType !== typeFilter) continue
      } else {
        // 默认过滤：只看 XHR/Fetch/Script
        if (!defaultTypes.includes(rType)) continue
      }

      const item = {
        requestId: req.requestId,
        url: req.url,
        method: req.method,
        resourceType: rType,
        status: resp?.status || null,
        statusText: resp?.statusText || '',
        mimeType: resp?.mimeType || '',
        timestamp: req.wallTime || req.timestamp,
        initiator: req.initiator,
        requestHeaders: req.headers,
        // 请求体（CDP 已提供）
        postData: includeBody ? (req.postData || null) : null,
        hasPostData: req.hasPostData,
        // 响应头
        responseHeaders: resp?.headers || {},
        // 响应体
        responseBody: includeBody ? (body?.body || null) : null,
        responseBodyTruncated: body?.truncated || false,
        responseBodyLength: body?.actualLength || 0,
        responseBase64: body?.base64Encoded || false,
        // 网络信息
        remoteIP: resp?.remoteIP || '',
        remotePort: resp?.remotePort || '',
        timing: resp?.timing || null,
        protocol: resp?.protocol || '',
        finished: state.finishedIds.has(reqId),
      }
      result.push(item)
      if (result.length >= limit) break
    }

    return {
      success: true,
      count: result.length,
      total: state.order.length,
      requests: result,
    }
  }

  /**
   * 获取单条请求详情
   */
  getRequestDetail(webContents, requestId) {
    const wcId = webContents.id
    const state = this.attached.get(wcId)
    if (!state) return { success: false, error: '未在捕获状态' }
    const req = state.requests.get(requestId)
    if (!req) return { success: false, error: '请求不存在' }
    const resp = state.responses.get(requestId)
    const body = state.bodies.get(requestId)
    return {
      success: true,
      request: {
        ...req,
        response: resp,
        body,
        finished: state.finishedIds.has(requestId),
      },
    }
  }
}

// 单例
const networkCapture = new NetworkCapture()
module.exports = networkCapture
