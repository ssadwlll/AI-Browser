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
// 尝试多种 _webmsxyw 调用方式，返回所有结果用于调试
const SIGN_SCRIPT = `
(function(apiPath, bodyStr) {
  if (typeof window._webmsxyw !== 'function') {
    return { error: 'window._webmsxyw 不可用，页面未加载完成或 signSvn 未初始化' }
  }

  // 内置 MD5
  function md5(str) {
    function rh(n) { var s = '', j; for (j = 0; j <= 3; j++) { s += ((n >> (j * 8 + 4)) & 0x0F).toString(16) + ((n >> (j * 8)) & 0x0F).toString(16); } return s; }
    function ad(x, y) { var l = (x & 0xFFFF) + (y & 0xFFFF); var m = (x >> 16) + (y >> 16) + (l >> 16); return (m << 16) | (l & 0xFFFF); }
    function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
    function cm(q, a, b, x, s, t) { return ad(rl(ad(ad(a, q), ad(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cm((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cm((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cm(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cm(c ^ (b | ~d), a, b, x, s, t); }
    function cv(s) {
      var u = unescape(encodeURIComponent(s));
      var n = ((u.length + 8) >> 6) + 1;
      var b = new Array(n * 16).fill(0);
      for (var i = 0; i < u.length; i++) b[i >> 2] |= u.charCodeAt(i) << ((i % 4) * 8);
      b[u.length >> 2] |= 0x80 << ((u.length % 4) * 8);
      b[n * 16 - 2] = u.length * 8;
      return b;
    }
    var x = cv(str);
    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (var i = 0; i < x.length; i += 16) {
      var oa = a, ob = b, oc = c, od = d;
      a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i+1], 12, -389564586); c = ff(c, d, a, b, x[i+2], 17, 606105819); b = ff(b, c, d, a, x[i+3], 22, -1044525330);
      a = ff(a, b, c, d, x[i+4], 7, -176418897); d = ff(d, a, b, c, x[i+5], 12, 1200080427); c = ff(c, d, a, b, x[i+6], 17, -1473231341); b = ff(b, c, d, a, x[i+7], 22, -45705983);
      a = ff(a, b, c, d, x[i+8], 7, 1770035416); d = ff(d, a, b, c, x[i+9], 12, -1958414417); c = ff(c, d, a, b, x[i+10], 17, -42063); b = ff(b, c, d, a, x[i+11], 22, -1990404162);
      a = ff(a, b, c, d, x[i+12], 7, 1804603682); d = ff(d, a, b, c, x[i+13], 12, -40341101); c = ff(c, d, a, b, x[i+14], 17, -1502002290); b = ff(b, c, d, a, x[i+15], 22, 1236535329);
      a = gg(a, b, c, d, x[i+1], 5, -165796510); d = gg(d, a, b, c, x[i+6], 9, -1069501632); c = gg(c, d, a, b, x[i+11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
      a = gg(a, b, c, d, x[i+5], 5, -701558691); d = gg(d, a, b, c, x[i+10], 9, 38016083); c = gg(c, d, a, b, x[i+15], 14, -660478335); b = gg(b, c, d, a, x[i+4], 20, -405537848);
      a = gg(a, b, c, d, x[i+9], 5, 568446438); d = gg(d, a, b, c, x[i+14], 9, -1019803690); c = gg(c, d, a, b, x[i+3], 14, -187363961); b = gg(b, c, d, a, x[i+8], 20, 1163531501);
      a = gg(a, b, c, d, x[i+13], 5, -1444681467); d = gg(d, a, b, c, x[i+2], 9, -51403784); c = gg(c, d, a, b, x[i+7], 14, 1735328473); b = gg(b, c, d, a, x[i+12], 20, -1926607734);
      a = hh(a, b, c, d, x[i+5], 4, -378558); d = hh(d, a, b, c, x[i+8], 11, -2022574463); c = hh(c, d, a, b, x[i+11], 16, 1839030562); b = hh(b, c, d, a, x[i+14], 23, -35309556);
      a = hh(a, b, c, d, x[i+1], 4, -1530992060); d = hh(d, a, b, c, x[i+4], 11, 1272893353); c = hh(c, d, a, b, x[i+7], 16, -155497632); b = hh(b, c, d, a, x[i+10], 23, -1094730640);
      a = hh(a, b, c, d, x[i+13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222); c = hh(c, d, a, b, x[i+3], 16, -722521979); b = hh(b, c, d, a, x[i+6], 23, 76029189);
      a = hh(a, b, c, d, x[i+9], 4, -640364487); d = hh(d, a, b, c, x[i+12], 11, -421815835); c = hh(c, d, a, b, x[i+15], 16, 530742520); b = hh(b, c, d, a, x[i+2], 23, -995338651);
      a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i+7], 10, 1126891415); c = ii(c, d, a, b, x[i+14], 15, -1416354905); b = ii(b, c, d, a, x[i+5], 21, -57434055);
      a = ii(a, b, c, d, x[i+12], 6, 1700485571); d = ii(d, a, b, c, x[i+3], 10, -1894986606); c = ii(c, d, a, b, x[i+10], 15, -1051523); b = ii(b, c, d, a, x[i+1], 21, -2054922799);
      a = ii(a, b, c, d, x[i+8], 6, 1873313359); d = ii(d, a, b, c, x[i+15], 10, -30611744); c = ii(c, d, a, b, x[i+6], 15, -1560198380); b = ii(b, c, d, a, x[i+13], 21, 1309151649);
      a = ii(a, b, c, d, x[i+4], 6, -145523070); d = ii(d, a, b, c, x[i+11], 10, -1120210379); c = ii(c, d, a, b, x[i+2], 15, 718787259); b = ii(b, c, d, a, x[i+9], 21, -343485551);
      a = ad(a, oa); b = ad(b, ob); c = ad(c, oc); d = ad(d, od);
    }
    return rh(a) + rh(b) + rh(c) + rh(d);
  }

  var results = { tests: [] };

  // 解码 XYW_ 签名
  function decodeXYW(xs) {
    if (!xs || !xs.startsWith('XYW_')) return null;
    try { return JSON.parse(atob(xs.substring(4))); } catch(e) { return null; }
  }

  // 测试多种调用方式
  var u = apiPath + (bodyStr || '');
  var m = md5(u);
  var w = md5(apiPath);
  var bodyObj = undefined;
  if (bodyStr) { try { bodyObj = JSON.parse(bodyStr); } catch(e) {} }

  // 方式 A: 2参数 (apiPath, bodyObj) — webmsxyw-node.js 方式
  try {
    var rA = window._webmsxyw(apiPath, bodyObj);
    results.tests.push({
      name: 'A: (apiPath, bodyObj)',
      ok: !!(rA && rA['X-s']),
      xs: rA && rA['X-s'] ? rA['X-s'].substring(0, 30) : null,
      decoded: rA && rA['X-s'] ? decodeXYW(rA['X-s']) : null,
      hasCommon: !!(rA && rA['X-s-common']),
    });
    if (rA && rA['X-s']) results.best = rA;
  } catch(e) { results.tests.push({ name: 'A', error: e.message }); }

  // 方式 B: 3参数 (u, m, w) — xhs_sign_service.js 方式
  try {
    var rB = window._webmsxyw(u, m, w);
    results.tests.push({
      name: 'B: (path+body, md5(u), md5(path))',
      ok: !!(rB && rB['X-s']),
      xs: rB && rB['X-s'] ? rB['X-s'].substring(0, 30) : null,
      decoded: rB && rB['X-s'] ? decodeXYW(rB['X-s']) : null,
      hasCommon: !!(rB && rB['X-s-common']),
    });
    if (rB && rB['X-s'] && !results.best) results.best = rB;
  } catch(e) { results.tests.push({ name: 'B', error: e.message }); }

  // 方式 C: 1参数 (u) — 只传 path+body
  try {
    var rC = window._webmsxyw(u);
    results.tests.push({
      name: 'C: (path+body)',
      ok: !!(rC && rC['X-s']),
      xs: rC && rC['X-s'] ? rC['X-s'].substring(0, 30) : null,
      decoded: rC && rC['X-s'] ? decodeXYW(rC['X-s']) : null,
      hasCommon: !!(rC && rC['X-s-common']),
    });
    if (rC && rC['X-s'] && !results.best) results.best = rC;
  } catch(e) { results.tests.push({ name: 'C', error: e.message }); }

  // 方式 D: 2参数 (apiPath, bodyStr) — 传字符串而非对象
  try {
    var rD = window._webmsxyw(apiPath, bodyStr);
    results.tests.push({
      name: 'D: (apiPath, bodyStr)',
      ok: !!(rD && rD['X-s']),
      xs: rD && rD['X-s'] ? rD['X-s'].substring(0, 30) : null,
      decoded: rD && rD['X-s'] ? decodeXYW(rD['X-s']) : null,
      hasCommon: !!(rD && rD['X-s-common']),
    });
    if (rD && rD['X-s'] && !results.best) results.best = rD;
  } catch(e) { results.tests.push({ name: 'D', error: e.message }); }

  if (results.best) {
    return {
      'X-s': results.best['X-s'],
      'X-t': results.best['X-t'] || String(Date.now()),
      'X-s-common': results.best['X-s-common'] || '',
      _debug: results.tests,
    }
  }

  return { error: '所有调用方式均失败', _debug: results.tests }
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
