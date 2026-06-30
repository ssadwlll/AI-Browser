// ============ Network Capture — 页面 XHR/Fetch 拦截 ============
// 在 document_start 阶段注入，拦截所有 JS 发起的网络请求
// 注意：不拦截浏览器自身的导航/资源加载（需要 webRequest 权限，且 MV3 无法读响应体）

;(function() {
  'use strict'
  if (location.protocol === 'chrome-extension:') return
  if (window.__aiBrowserNetworkCapture) return
  window.__aiBrowserNetworkCapture = true

  const MAX_BODY = 8000     // 单次响应截断上限
  const MAX_REQUESTS = 200  // 总请求缓存上限
  const captured = []

  function safeSend(msg) {
    try {
      if (chrome.runtime?.id) chrome.runtime.sendMessage(msg).catch(() => {})
    } catch {}
  }

  function addCapture(entry) {
    if (captured.length >= MAX_REQUESTS) captured.shift()
    captured.push(entry)
    safeSend({ type: 'network_capture', entry })
  }

  // ===== 拦截 fetch =====
  const origFetch = window.fetch
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input?.url || '')
    const method = (init?.method || 'GET').toUpperCase()
    const start = Date.now()

    try {
      const response = await origFetch.apply(this, arguments)
      const duration = Date.now() - start
      // 异步读取（不阻塞返回）
      const clone = response.clone()
      clone.text().then(body => {
        addCapture({
          url, method,
          status: response.status,
          duration,
          bodyPreview: body.slice(0, MAX_BODY),
          bodySize: body.length,
          reqHeaders: init?.headers ? JSON.stringify(init.headers) : '',
          type: 'fetch',
          timestamp: Date.now(),
        })
      }).catch(() => {})
      return response
    } catch (err) {
      addCapture({
        url, method,
        status: 0,
        duration: Date.now() - start,
        error: err.message,
        type: 'fetch',
        timestamp: Date.now(),
      })
      throw err
    }
  }

  // ===== 拦截 XMLHttpRequest =====
  const OrigXHR = window.XMLHttpRequest
  const origOpen = OrigXHR.prototype.open
  const origSend = OrigXHR.prototype.send

  OrigXHR.prototype.open = function(method, url) {
    this.__captureUrl = url
    this.__captureMethod = (method || 'GET').toUpperCase()
    return origOpen.apply(this, arguments)
  }

  OrigXHR.prototype.send = function() {
    const xhr = this
    const start = Date.now()
    xhr.addEventListener('load', () => {
      addCapture({
        url: xhr.__captureUrl,
        method: xhr.__captureMethod,
        status: xhr.status,
        duration: Date.now() - start,
        bodyPreview: (xhr.responseText || '').slice(0, MAX_BODY),
        bodySize: (xhr.responseText || '').length,
        type: 'xhr',
        timestamp: Date.now(),
      })
    })
    xhr.addEventListener('error', () => {
      addCapture({
        url: xhr.__captureUrl,
        method: xhr.__captureMethod,
        status: 0,
        duration: Date.now() - start,
        error: 'XHR error',
        type: 'xhr',
        timestamp: Date.now(),
      })
    })
    return origSend.apply(this, arguments)
  }

  // ===== 暴露给 Agent 的接口 =====
  window.__aiBrowserGetCaptured = function(filter) {
    let results = captured.slice()
    if (filter?.url) {
      const f = filter.url.toLowerCase()
      results = results.filter(r => r.url.toLowerCase().includes(f))
    }
    if (filter?.method) {
      results = results.filter(r => r.method === filter.method.toUpperCase())
    }
    if (filter?.status) {
      if (filter.status === 'ok') results = results.filter(r => r.status >= 200 && r.status < 300)
      else if (filter.status === 'error') results = results.filter(r => r.status === 0 || r.status >= 400)
    }
    if (filter?.limit) results = results.slice(-filter.limit)
    return results
  }
})()
