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
