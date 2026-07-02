// ============ Network Capture — 页面 XHR/Fetch 拦截 ============
// 在 document_start 阶段注入，拦截所有 JS 发起的网络请求
// 注意：不拦截浏览器自身的导航/资源加载（需要 webRequest 权限，且 MV3 无法读响应体）

;(function() {
  'use strict'
  if (location.protocol === 'chrome-extension:') return

  const MAX_BODY = 8000       // 单次响应截断上限
  const MAX_REQUESTS = 200   // 总请求缓存上限
  const FLUSH_INTERVAL = 500  // 批量上报间隔（毫秒）
  const MAX_STREAM_READ = 16384  // 流式读取上限，避免大文件占用内存

  // captured 数组保存在闭包中，不暴露到 window 全局，防止页面脚本读取/篡改
  // （MV3 content script 默认在 isolated world，window 不与页面共享，
  //   但防御性闭包可避免未来 world 配置变更后的回归风险）
  const captured = []
  let pendingBatch = []  // 待批量上报的条目
  let flushTimer = null

  // 兼容扩展重载场景：若旧版本已暴露到 window，迁移后删除
  if (window.__aiBrowserCapturedData && Array.isArray(window.__aiBrowserCapturedData)) {
    try {
      const old = window.__aiBrowserCapturedData
      for (const item of old.slice(-MAX_REQUESTS)) captured.push(item)
    } catch {}
    try { delete window.__aiBrowserCapturedData } catch {}
  }

  // 仅暴露查询接口（受控访问，不直接暴露原始数组）
  // Agent 通过 chrome.scripting.executeScript 调用此函数查询
  window.__aiBrowserGetCaptured = function(filter) {
    let results = captured.slice()
    if (filter?.url) {
      const f = String(filter.url).toLowerCase()
      results = results.filter(r => String(r.url || '').toLowerCase().includes(f))
    }
    if (filter?.method) {
      results = results.filter(r => r.method === String(filter.method).toUpperCase())
    }
    if (filter?.status) {
      if (filter.status === 'ok') results = results.filter(r => r.status >= 200 && r.status < 300)
      else if (filter.status === 'error') results = results.filter(r => r.status === 0 || r.status >= 400)
    }
    if (filter?.limit) {
      const n = parseInt(filter.limit, 10) || 0
      if (n > 0) results = results.slice(-n)
    }
    return results
  }

  // 防重复注入（只对拦截器生效，查询接口始终可用）
  if (window.__aiBrowserNetworkCapture) return
  window.__aiBrowserNetworkCapture = true

  function safeSend(msg) {
    try {
      if (chrome.runtime?.id) chrome.runtime.sendMessage(msg).catch(() => {})
    } catch {}
  }

  // 批量 flush：合并多条请求为一次 sendMessage，降低 IPC 开销
  function scheduleFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      if (pendingBatch.length === 0) return
      safeSend({ type: 'network_capture_batch', entries: pendingBatch.splice(0, pendingBatch.length) })
    }, FLUSH_INTERVAL)
  }

  function addCapture(entry) {
    if (captured.length >= MAX_REQUESTS) captured.shift()
    captured.push(entry)
    pendingBatch.push(entry)
    // 批量上报，避免每条请求都触发一次 sendMessage
    if (pendingBatch.length >= 10) {
      // 满 10 条立即 flush
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      safeSend({ type: 'network_capture_batch', entries: pendingBatch.splice(0, pendingBatch.length) })
    } else {
      scheduleFlush()
    }
  }

  // 流式读取响应体，最多读取 MAX_STREAM_READ 字节后取消，避免大文件占用内存
  async function readBodyStream(response) {
    try {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let text = ''
      let totalLen = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        totalLen += chunk.length
        if (text.length < MAX_BODY) {
          text += chunk.slice(0, MAX_BODY - text.length)
        }
        if (totalLen >= MAX_STREAM_READ) {
          try { reader.cancel() } catch {}
          break
        }
      }
      return { preview: text, size: totalLen }
    } catch (e) {
      // 流式读取失败时回退到 .text()（仍限制读取量）
      try {
        const text = await response.clone().text()
        return { preview: text.slice(0, MAX_BODY), size: text.length }
      } catch {
        return { preview: '', size: 0 }
      }
    }
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
      // 异步流式读取响应体（不阻塞返回），并自动截断
      readBodyStream(response).then(({ preview, size }) => {
        addCapture({
          url, method,
          status: response.status,
          duration,
          bodyPreview: preview,
          bodySize: size,
          reqHeaders: init?.headers ? safeJsonStringify(init.headers) : '',
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
      const text = xhr.responseText || ''
      addCapture({
        url: xhr.__captureUrl,
        method: xhr.__captureMethod,
        status: xhr.status,
        duration: Date.now() - start,
        bodyPreview: text.slice(0, MAX_BODY),
        bodySize: text.length,
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

  // 简单 JSON 序列化（处理 headers 可能是 Headers 对象的情况）
  function safeJsonStringify(obj) {
    try {
      if (obj && typeof obj === 'object' && typeof obj.entries === 'function') {
        // Headers 对象
        const result = {}
        for (const [k, v] of obj.entries()) result[k] = v
        return JSON.stringify(result)
      }
      return JSON.stringify(obj)
    } catch {
      return String(obj)
    }
  }

})()
