/**
 * 签名桥接 HTTP 服务
 *
 * 在 Electron 主进程中启动一个本地 HTTP 服务，暴露浏览器签名能力。
 * 采集脚本（xhs-feed-collect.js）通过 HTTP 调用获取动态 XYW_ 签名。
 *
 * 原理：
 *   1. Electron BrowserView 加载 xiaohongshu.com（真实浏览器环境）
 *   2. 页面中 window._webmsxyw(apiPath, body) 生成 XYW_ 格式签名
 *   3. 本服务通过 webContents.executeJavaScript() 调用该函数
 *   4. 返回 { X-s, X-t, X-s-common } 给采集脚本
 *
 * API：
 *   GET  /health        — 检查浏览器环境是否就绪
 *   POST /sign          — 生成签名 { apiPath, body } → { X-s, X-t, X-s-common }
 *   GET  /cookies       — 获取当前浏览器 cookies
 *   GET  /user-agent    — 获取浏览器 User-Agent
 *
 * 使用：
 *   const signServer = new SignServer(tabManager)
 *   signServer.start(3721)  // 启动在 localhost:3721
 */

'use strict'

const http = require('http')

// 签名注入脚本（在 BrowserView 页面上下文中执行）
// _webmsxyw(apiPath, bodyObj) — 方式 A 已验证可用
const SIGN_SCRIPT = `
(function(apiPath, bodyStr) {
  if (typeof window._webmsxyw !== 'function') {
    return { error: 'window._webmsxyw 不可用' }
  }
  try {
    var params = undefined;
    if (bodyStr) { try { params = JSON.parse(bodyStr); } catch(e) {} }
    var result = window._webmsxyw(apiPath, params);
    if (result && result['X-s']) {
      return {
        'X-s': result['X-s'],
        'X-t': result['X-t'] || String(Date.now()),
        'X-s-common': result['X-s-common'] || ''
      }
    }
    return { error: '_webmsxyw 返回异常' }
  } catch(e) {
    return { error: '_webmsxyw 执行失败: ' + e.message }
  }
})(__API_PATH__, __BODY_STR__)
`

class SignServer {
  constructor(tabManager) {
    this.tabManager = tabManager
    this.server = null
    this.port = null
  }

  /**
   * 获取活动的 BrowserView
   */
  getBrowserView() {
    return this.tabManager ? this.tabManager.getActiveBrowserView() : null
  }

  /**
   * 启动 HTTP 服务
   */
  start(port = 3721) {
    this.server = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }

      const url = new URL(req.url, `http://localhost:${port}`)

      try {
        // GET /health — 检查浏览器环境
        if (req.method === 'GET' && url.pathname === '/health') {
          const bv = this.getBrowserView()
          if (!bv) {
            res.writeHead(200)
            res.end(JSON.stringify({ ok: false, error: '无活动标签页' }))
            return
          }

          const wc = bv.webContents
          const currentUrl = wc.getURL()
          if (!currentUrl || !currentUrl.includes('xiaohongshu.com')) {
            res.writeHead(200)
            res.end(JSON.stringify({ ok: false, error: '当前页面不是小红书', currentUrl }))
            return
          }

          const check = await wc.executeJavaScript(`
            (function() {
              return {
                hasWebmsxyw: typeof window._webmsxyw === 'function',
                hasMnsv2: typeof window.mnsv2 === 'function',
                url: window.location.href,
                title: document.title
              }
            })()
          `, true)

          res.writeHead(200)
          res.end(JSON.stringify({
            ok: check.hasWebmsxyw,
            hasWebmsxyw: check.hasWebmsxyw,
            hasMnsv2: check.hasMnsv2,
            url: check.url,
            title: check.title,
            signServerPort: port,
          }))
          return
        }

        // POST /sign — 生成签名
        if (req.method === 'POST' && url.pathname === '/sign') {
          const body = await this._readBody(req)
          const { apiPath, body: reqBody } = JSON.parse(body)

          if (!apiPath) {
            res.writeHead(400)
            res.end(JSON.stringify({ error: '缺少 apiPath' }))
            return
          }

          const bv = this.getBrowserView()
          if (!bv) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: '无活动标签页' }))
            return
          }

          const wc = bv.webContents
          const currentUrl = wc.getURL()
          if (!currentUrl || !currentUrl.includes('xiaohongshu.com')) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: '当前页面不是小红书，请先在浏览器中打开 xiaohongshu.com' }))
            return
          }

          // 序列化请求体
          let bodyStr = ''
          if (reqBody !== null && reqBody !== undefined) {
            bodyStr = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody)
          }

          // 构建注入脚本
          const script = SIGN_SCRIPT
            .replace('__API_PATH__', JSON.stringify(apiPath))
            .replace('__BODY_STR__', JSON.stringify(bodyStr))

          const result = await wc.executeJavaScript(script, true)

          if (result.error) {
            console.error('[SignServer] 签名失败:', result.error)
            res.writeHead(500)
            res.end(JSON.stringify({ error: result.error }))
          } else {
            console.log(`[SignServer] 签名成功: ${apiPath} → ${result['X-s'].substring(0, 20)}...`)
            res.writeHead(200)
            res.end(JSON.stringify(result))
          }
          return
        }

        // POST /fetch — 在浏览器页面内发起 API 请求（签名+请求全部在浏览器中完成）
        // 请求体: { apiPath, body, method }
        // 返回: { ok, status, data }
        if (req.method === 'POST' && url.pathname === '/fetch') {
          const body = await this._readBody(req)
          const { apiPath, body: reqBody, method, xsc, rapParam, xs, xt } = JSON.parse(body)

          if (!apiPath) {
            res.writeHead(400)
            res.end(JSON.stringify({ error: '缺少 apiPath' }))
            return
          }

          const bv = this.getBrowserView()
          if (!bv) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: '无活动标签页' }))
            return
          }

          const wc = bv.webContents
          const currentUrl = wc.getURL()
          if (!currentUrl || !currentUrl.includes('xiaohongshu.com')) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: '当前页面不是小红书' }))
            return
          }

          // 在浏览器页面内执行：签名 → fetch 请求 → 返回结果
          // xs/xt: 外部传入的 XYS_ 签名（xys-sign-node.js 生成，不触发 300015）
          // xsc: x-s-common（由调用方通过 xs-common-node.js 生成）
          // rapParam: x-rap-param（由调用方传入）
          // 若未传入 xs，则回退 _webmsxyw 生成 XYW_（可能触发 300015）
          const fetchScript = `
(function(apiPath, bodyStr, method, xsc, rapParam, extXs, extXt) {
  return (async function() {
    try {
      // 1. 签名：优先用外部传入的 XYS_，否则回退 _webmsxyw
      var xS, xT;
      if (extXs) {
        xS = extXs;
        xT = extXt || String(Date.now());
      } else {
        if (typeof window._webmsxyw !== 'function') {
          return { ok: false, error: '_webmsxyw 不可用且未传入 xs' }
        }
        var params = undefined;
        if (bodyStr) { try { params = JSON.parse(bodyStr); } catch(e) {} }
        var signResult = window._webmsxyw(apiPath, params);
        if (!signResult || !signResult['X-s']) {
          return { ok: false, error: '签名生成失败' }
        }
        xS = signResult['X-s'];
        xT = signResult['X-t'] || String(Date.now());
      }

      // 2. 生成随机 traceId（与真实浏览器一致）
      function randHex(len) {
        var s = '';
        var chars = '0123456789abcdef';
        for (var i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
        return s;
      }

      // 3. 构建请求头（与真实浏览器完全一致）
      var headers = {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json;charset=UTF-8',
        'x-s': xS,
        'x-t': xT,
        'x-b3-traceid': randHex(16),
        'x-xray-traceid': randHex(32),
        'xy-direction': '18',
      }
      if (xsc) {
        headers['x-s-common'] = xsc
      }
      if (rapParam) {
        headers['x-rap-param'] = rapParam
      }

      // 4. 发起 fetch 请求（在浏览器环境中，TLS/HTTP2 自动正确）
      var fullUrl = 'https://edith.xiaohongshu.com' + apiPath;
      var fetchOpts = {
        method: method || 'POST',
        headers: headers,
        credentials: 'include',
      }
      if (bodyStr && (method || 'POST') !== 'GET') {
        fetchOpts.body = bodyStr
      }

      var resp = await fetch(fullUrl, fetchOpts);
      var text = await resp.text();
      var data;
      try { data = JSON.parse(text); } catch(e) { data = text }

      return {
        ok: true,
        status: resp.status,
        data: data
      }
    } catch(e) {
      return { ok: false, error: e.message }
    }
  })()
})(__API_PATH__, __BODY_STR__, __METHOD__, __XSC__, __RAP_PARAM__, __EXT_XS__, __EXT_XT__)
`

          const script = fetchScript
            .replace('__API_PATH__', JSON.stringify(apiPath))
            .replace('__BODY_STR__', JSON.stringify(reqBody ? (typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody)) : ''))
            .replace('__METHOD__', JSON.stringify(method || 'POST'))
            .replace('__XSC__', JSON.stringify(xsc || ''))
            .replace('__RAP_PARAM__', JSON.stringify(rapParam || ''))
            .replace('__EXT_XS__', JSON.stringify(xs || ''))
            .replace('__EXT_XT__', JSON.stringify(xt || ''))

          console.log(`[SignServer] 浏览器内 fetch: ${method || 'POST'} ${apiPath}`)
          const result = await wc.executeJavaScript(script, true)

          if (result.ok) {
            console.log(`[SignServer] fetch 成功: status=${result.status}`)
            res.writeHead(200)
            res.end(JSON.stringify(result))
          } else {
            console.error('[SignServer] fetch 失败:', result.error)
            res.writeHead(500)
            res.end(JSON.stringify(result))
          }
          return
        }

        // POST /mnsv2 — 在浏览器中调用 window.mnsv2(c, u, p)
        // 请求体: { c, u, p } → { result: "mns0301_..." }
        // 用于 XYS_ 签名生成（Node.js 侧构建 payload + Base64）
        if (req.method === 'POST' && url.pathname === '/mnsv2') {
          const body = await this._readBody(req)
          const { c, u, p } = JSON.parse(body)

          if (!c) {
            res.writeHead(400)
            res.end(JSON.stringify({ error: '缺少参数 c' }))
            return
          }

          const bv = this.getBrowserView()
          if (!bv) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: '无活动标签页' }))
            return
          }

          const wc = bv.webContents
          const currentUrl = wc.getURL()
          if (!currentUrl || !currentUrl.includes('xiaohongshu.com')) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: '当前页面不是小红书' }))
            return
          }

          // 在浏览器中调用 mnsv2
          const mnsv2Script = `
(function(c, u, p) {
  if (typeof window.mnsv2 !== 'function') {
    return { error: 'window.mnsv2 不可用' }
  }
  try {
    var result = window.mnsv2(c, u, p);
    if (!result) return { error: 'mnsv2 返回空值' }
    return { result: result }
  } catch(e) {
    return { error: 'mnsv2 执行失败: ' + e.message }
  }
})(__C__, __U__, __P__)
`

          const script = mnsv2Script
            .replace('__C__', JSON.stringify(c))
            .replace('__U__', JSON.stringify(u || ''))
            .replace('__P__', JSON.stringify(p || ''))

          console.log(`[SignServer] mnsv2 调用: c=${c.substring(0, 30)}...`)
          const result = await wc.executeJavaScript(script, true)

          if (result.error) {
            console.error('[SignServer] mnsv2 失败:', result.error)
            res.writeHead(500)
            res.end(JSON.stringify({ error: result.error }))
          } else {
            console.log(`[SignServer] mnsv2 成功: ${result.result.substring(0, 30)}...`)
            res.writeHead(200)
            res.end(JSON.stringify(result))
          }
          return
        }

        // GET /cookies — 获取浏览器 cookies
        if (req.method === 'GET' && url.pathname === '/cookies') {
          const bv = this.getBrowserView()
          if (!bv) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: '无活动标签页' }))
            return
          }

          const ses = bv.webContents.session
          const cookies = await ses.cookies.get({ url: 'https://www.xiaohongshu.com' })
          const cookieObj = {}
          cookies.forEach(c => { cookieObj[c.name] = c.value })

          res.writeHead(200)
          res.end(JSON.stringify({ cookies: cookieObj }))
          return
        }

        // GET /user-agent — 获取浏览器 UA
        if (req.method === 'GET' && url.pathname === '/user-agent') {
          const bv = this.getBrowserView()
          const ua = bv ? bv.webContents.getUserAgent() : ''
          res.writeHead(200)
          res.end(JSON.stringify({ userAgent: ua }))
          return
        }

        // POST /navigate — 导航浏览器到指定 URL（产生真实行为事件）
        // 请求体: { url, waitMs }
        if (req.method === 'POST' && url.pathname === '/navigate') {
          const body = await this._readBody(req)
          const { url: navUrl, waitMs } = JSON.parse(body)

          if (!navUrl) {
            res.writeHead(400)
            res.end(JSON.stringify({ error: '缺少 url' }))
            return
          }

          const bv = this.getBrowserView()
          if (!bv) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: '无活动标签页' }))
            return
          }

          try {
            console.log(`[SignServer] 导航: ${navUrl}`)
            await bv.webContents.loadURL(navUrl, { userAgent: bv.webContents.getUserAgent() })
            // 等待页面加载 + 产生行为事件
            await new Promise(r => setTimeout(r, waitMs || 3000))
            res.writeHead(200)
            res.end(JSON.stringify({ ok: true, url: bv.webContents.getURL() }))
          } catch (e) {
            console.error('[SignServer] 导航失败:', e.message)
            res.writeHead(500)
            res.end(JSON.stringify({ error: e.message }))
          }
          return
        }

        // POST /scroll — 在当前页面模拟滚动（产生 collect 行为事件）
        if (req.method === 'POST' && url.pathname === '/scroll') {
          const bv = this.getBrowserView()
          if (!bv) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: '无活动标签页' }))
            return
          }
          try {
            await bv.webContents.executeJavaScript(`
              window.scrollBy(0, ${Math.floor(200 + Math.random() * 600)});
              true
            `, true)
            await new Promise(r => setTimeout(r, 500))
            res.writeHead(200)
            res.end(JSON.stringify({ ok: true }))
          } catch (e) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: e.message }))
          }
          return
        }

        // 未知路由
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'Unknown route: ' + req.method + ' ' + url.pathname }))

      } catch (e) {
        console.error('[SignServer] Error:', e.message)
        res.writeHead(500)
        res.end(JSON.stringify({ error: e.message }))
      }
    })

    this.server.listen(port, '127.0.0.1', () => {
      this.port = port
      console.log(`[SignServer] 签名服务已启动: http://127.0.0.1:${port}`)
      console.log(`[SignServer]   GET  /health       — 检查浏览器环境`)
      console.log(`[SignServer]   POST /sign         — 生成 XYW_ 签名`)
      console.log(`[SignServer]   POST /fetch         — 浏览器内 fetch（签名+请求全在浏览器中）`)
      console.log(`[SignServer]   POST /mnsv2         — 调用浏览器 mnsv2（用于 XYS_ 动态签名）`)
      console.log(`[SignServer]   GET  /cookies      — 获取浏览器 cookies`)
      console.log(`[SignServer]   GET  /user-agent   — 获取浏览器 UA`)
    })

    this.server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.warn(`[SignServer] 端口 ${port} 已被占用，签名服务未启动`)
      } else {
        console.error('[SignServer] 启动失败:', e.message)
      }
    })
  }

  /**
   * 停止服务
   */
  stop() {
    if (this.server) {
      this.server.close()
      this.server = null
      this.port = null
      console.log('[SignServer] 签名服务已停止')
    }
  }

  /**
   * 读取请求体
   */
  _readBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', chunk => { data += chunk })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
  }
}

module.exports = SignServer
