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
            const beforeUrl = bv.webContents.getURL()

            // 方案1: 优先用 executeJavaScript 设置 location.href（最可靠）
            // 这会触发浏览器原生导航 + 小红书前端路由 + 所有行为上报
            await bv.webContents.executeJavaScript(`window.location.href = ${JSON.stringify(navUrl)};`, true)

            // 等待页面开始导航（location.href 设置后浏览器异步加载）
            await new Promise(r => setTimeout(r, 2000))

            // 等待页面加载完成（did-finish-load 或超时）
            const waitFinish = new Promise((resolve) => {
              const timer = setTimeout(() => {
                bv.webContents.removeListener('did-finish-load', handler)
                resolve('timeout')
              }, (waitMs || 3000) + 5000)
              const handler = () => {
                clearTimeout(timer)
                resolve('loaded')
              }
              bv.webContents.once('did-finish-load', handler)
            })
            await waitFinish

            // 额外等待页面 JS 执行（行为上报需要时间）
            await new Promise(r => setTimeout(r, 2000))

            const finalUrl = bv.webContents.getURL()
            const navigated = finalUrl !== beforeUrl
            console.log(`[SignServer] 导航结果: before=${beforeUrl?.substring(0, 60)} final=${finalUrl?.substring(0, 60)} navigated=${navigated}`)

            if (navigated) {
              res.writeHead(200)
              res.end(JSON.stringify({ ok: true, url: finalUrl }))
            } else {
              // URL 没变，尝试 loadURL 兜底
              try {
                await bv.webContents.loadURL(navUrl)
                await new Promise(r => setTimeout(r, waitMs || 3000))
                const finalUrl2 = bv.webContents.getURL()
                res.writeHead(200)
                res.end(JSON.stringify({ ok: finalUrl2 !== beforeUrl, url: finalUrl2 }))
              } catch (e2) {
                res.writeHead(200)
                res.end(JSON.stringify({ ok: false, error: '导航未生效: ' + e2.message }))
              }
            }
          } catch (e) {
            console.error('[SignServer] 导航失败:', e.message)
            res.writeHead(200)
            res.end(JSON.stringify({ ok: false, error: e.message }))
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
            res.writeHead(200)
            res.end(JSON.stringify({ error: e.message }))
          }
          return
        }

        // POST /simulate — 完整行为模拟（参考验证过的采集脚本）
        // 贝塞尔曲线鼠标移动 + 分步滚动 + 微移动
        if (req.method === 'POST' && url.pathname === '/simulate') {
          const bv = this.getBrowserView()
          if (!bv) {
            res.writeHead(200)
            res.end(JSON.stringify({ ok: false, error: '无活动标签页' }))
            return
          }
          try {
            await bv.webContents.executeJavaScript(`
              (async function() {
                function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

                // 1. 贝塞尔曲线人类化鼠标移动
                async function humanMouseMove(tx, ty) {
                  var sx = window.innerWidth * (0.15 + Math.random() * 0.7);
                  var sy = window.innerHeight * (0.15 + Math.random() * 0.7);
                  var steps = 6 + Math.floor(Math.random() * 8);
                  for (var i = 0; i <= steps; i++) {
                    var t = i / steps;
                    var ease = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
                    var cx = sx + (tx - sx) * ease + (Math.random()-0.5) * 25;
                    var cy = sy + (ty - sy) * ease + (Math.random()-0.5) * 25;
                    document.dispatchEvent(new MouseEvent('mousemove', {
                      clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window
                    }));
                    await sleep(12 + Math.random() * 30);
                  }
                }

                // 2. 人类化滚动（分步 + 抖动）
                async function humanScroll(px) {
                  var jitter = (Math.random() - 0.5) * 80;
                  var amount = px + jitter;
                  var steps = 3 + Math.floor(Math.random() * 5);
                  var perStep = amount / steps;
                  for (var i = 0; i < steps; i++) {
                    window.scrollBy({ top: perStep + (Math.random()-0.5)*40, behavior: 'smooth' });
                    await sleep(60 + Math.random() * 130);
                  }
                }

                // 3. 微移动（模拟活人）
                async function microMovement() {
                  var dx = (Math.random() - 0.5) * 30;
                  var dy = (Math.random() - 0.5) * 30;
                  document.dispatchEvent(new MouseEvent('mousemove', {
                    clientX: window.innerWidth/2 + dx,
                    clientY: window.innerHeight/2 + dy,
                    bubbles: true, view: window
                  }));
                }

                // 执行：鼠标移动到随机位置 → 滚动 → 微移动 → 再滚动
                var tx = 200 + Math.random() * 800;
                var ty = 200 + Math.random() * 400;
                await humanMouseMove(tx, ty);
                await sleep(150 + Math.random() * 250);
                await humanScroll(300 + Math.random() * 400);
                await sleep(200 + Math.random() * 300);
                await microMovement();
                await sleep(100 + Math.random() * 200);
                await humanScroll(200 + Math.random() * 300);
                await sleep(150 + Math.random() * 200);
                await microMovement();

                return true;
              })()
            `, true)
            await new Promise(r => setTimeout(r, 3000))
            res.writeHead(200)
            res.end(JSON.stringify({ ok: true }))
          } catch (e) {
            res.writeHead(200)
            res.end(JSON.stringify({ ok: false, error: e.message }))
          }
          return
        }

        // POST /scrape-note — DOM采集单条笔记（点击卡片→SSR提取→关闭弹窗）
        // 请求体: { index }  笔记在搜索列表中的索引
        if (req.method === 'POST' && url.pathname === '/scrape-note') {
          const body = await this._readBody(req)
          const { index } = JSON.parse(body)

          const bv = this.getBrowserView()
          if (!bv) {
            res.writeHead(200)
            res.end(JSON.stringify({ ok: false, error: '无活动标签页' }))
            return
          }

          const scrapeScript = `
(function(targetIndex) {
  return (async function() {
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function safeStr(v) { return (v === null || v === undefined) ? '' : String(v); }
    function safeNum(v) { if (v === null || v === undefined) return 0; var n = Number(v); return isNaN(n) ? 0 : n; }

    function getNoteElements() {
      var els = document.querySelectorAll('section.note-item, [class*="note-item"]');
      if (els.length === 0) {
        els = document.querySelectorAll('.feeds-page .note-item, .feeds-container section');
      }
      return Array.from(els).filter(function(el) {
        return !el.querySelector('.query-note-wrapper, .query-note-item');
      });
    }

    function getNoteId(el) {
      var link = el.querySelector('a[href*="/search_result/"], a[href*="/explore/"], a.cover');
      if (link) {
        var match = link.href.match(/\\/(?:search_result|explore)\\/([a-zA-Z0-9]+)/);
        if (match) return match[1];
      }
      return el.getAttribute('data-index') || 'unknown-' + Date.now();
    }

    async function humanMouseMove(targetEl) {
      var rect = targetEl.getBoundingClientRect();
      var tx = rect.left + rect.width * (0.25 + Math.random() * 0.5);
      var ty = rect.top + rect.height * (0.25 + Math.random() * 0.5);
      var sx = window.innerWidth * (0.15 + Math.random() * 0.7);
      var sy = window.innerHeight * (0.15 + Math.random() * 0.7);
      var steps = 6 + Math.floor(Math.random() * 8);
      for (var i = 0; i <= steps; i++) {
        var t = i / steps;
        var ease = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
        var cx = sx + (tx - sx) * ease + (Math.random()-0.5) * 25;
        var cy = sy + (ty - sy) * ease + (Math.random()-0.5) * 25;
        document.dispatchEvent(new MouseEvent('mousemove', {
          clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window
        }));
        await sleep(12 + Math.random() * 30);
      }
    }

    async function waitForDetailOpen(timeout) {
      timeout = timeout || 10000;
      var start = Date.now();
      while (Date.now() - start < timeout) {
        var mask = document.querySelector('.close-mask-dark, .mask, [class*="overlay"]');
        var detail = document.querySelector('[class*="note-detail"], .note-scroller, #detail-desc, #detail-title');
        if (mask || detail) {
          await sleep(500 + Math.random() * 300);
          return true;
        }
        await sleep(250);
      }
      return false;
    }

    async function closeDetail() {
      var closeBtn = document.querySelector('.close-mask-dark, .close-circle, [class*="close-mask"]');
      if (closeBtn) {
        closeBtn.click();
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true
        }));
        await sleep(200);
        var altClose = document.querySelector('[class*="close-modal"], [class*="close-btn"]');
        if (altClose) altClose.click();
      }
      var start = Date.now();
      while (Date.now() - start < 6000) {
        if (!document.querySelector('.close-mask-dark, [class*="note-detail"]')) {
          await sleep(200);
          break;
        }
        await sleep(200);
      }
      await sleep(300 + Math.random() * 200);
    }

    function extractFromSSR(noteId) {
      var state = window.__INITIAL_STATE__;
      if (!state || !state.note || !state.note.noteDetailMap) return null;
      var detailMap = state.note.noteDetailMap;
      var noteData = null;
      if (noteId && detailMap[noteId]) {
        noteData = detailMap[noteId];
      } else {
        var keys = Object.keys(detailMap);
        if (keys.length === 0) return null;
        noteData = detailMap[keys[keys.length - 1]];
        noteId = keys[keys.length - 1];
      }
      if (!noteData) return null;
      var note = noteData.note || noteData;
      if (!note) return null;

      var result = {
        noteId: noteId,
        title: safeStr(note.title || ''),
        desc: safeStr(note.desc || ''),
        type: safeStr(note.type || ''),
        user: {
          userId: safeStr(note.user && note.user.userId || ''),
          nickname: safeStr(note.user && note.user.nickname || ''),
          avatar: safeStr(note.user && note.user.avatar || '')
        },
        interactInfo: {
          likedCount: safeStr(note.interactInfo && note.interactInfo.likedCount || '0'),
          collectedCount: safeStr(note.interactInfo && note.interactInfo.collectedCount || '0'),
          commentCount: safeStr(note.interactInfo && note.interactInfo.commentCount || '0'),
          shareCount: safeStr(note.interactInfo && note.interactInfo.shareCount || '0')
        },
        imageList: [],
        video: null,
        tagList: [],
        time: safeStr(note.time || ''),
        lastUpdateTime: safeStr(note.lastUpdateTime || ''),
        ipLocation: safeStr(note.ipLocation || ''),
        _extractMethod: 'ssr'
      };
      if (note.imageList && note.imageList.length) {
        for (var i = 0; i < note.imageList.length; i++) {
          var img = note.imageList[i];
          if (img) result.imageList.push({
            url: safeStr(img.urlDefault || img.url || ''),
            width: safeNum(img.width), height: safeNum(img.height)
          });
        }
      }
      if (note.video) {
        result.video = {
          url: safeStr(note.video.media && note.video.media.url || ''),
          firstFrame: safeStr(note.video.firstFrame || ''),
          duration: safeNum(note.video.cap && note.video.cap.duration || 0)
        };
      }
      if (note.tagList && note.tagList.length) {
        for (var j = 0; j < note.tagList.length; j++) {
          var tag = note.tagList[j];
          if (tag) result.tagList.push({
            id: safeStr(tag.id || ''), name: safeStr(tag.name || ''), type: safeStr(tag.type || '')
          });
        }
      }
      return result;
    }

    function extractFromDOM() {
      var data = {
        noteId: '', title: '', desc: '', type: 'image',
        user: { userId: '', nickname: '', avatar: '' },
        interactInfo: { likedCount: '0', collectedCount: '0', commentCount: '0', shareCount: '0' },
        imageList: [], tagList: [], time: '', _extractMethod: 'dom'
      };
      var titleEl = document.querySelector('#detail-title, .note-title, h1[class*="title"]');
      data.title = titleEl ? titleEl.textContent.trim() : '';
      var descEl = document.querySelector('#detail-desc, .note-text, [class*="note-text"], .desc');
      data.desc = descEl ? descEl.textContent.trim() : '';
      var authorEl = document.querySelector('.author-wrapper .name, .username, [class*="author"] [class*="name"]');
      data.user.nickname = authorEl ? authorEl.textContent.trim() : '';
      var likeEl = document.querySelector('[class*="like-wrapper"] [class*="count"], .like-count');
      data.interactInfo.likedCount = likeEl ? likeEl.textContent.trim() : '0';
      var collectEl = document.querySelector('[class*="collect-wrapper"] [class*="count"], .collect-count');
      data.interactInfo.collectedCount = collectEl ? collectEl.textContent.trim() : '0';
      var commentEl = document.querySelector('[class*="comment-wrapper"] [class*="count"], .comment-count');
      data.interactInfo.commentCount = commentEl ? commentEl.textContent.trim() : '0';
      var imgs = document.querySelectorAll('.note-scroller img, [class*="swiper"] img');
      imgs.forEach(function(img) {
        if (img.src && img.src.indexOf('xhscdn') >= 0) {
          data.imageList.push({ url: img.src, width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
        }
      });
      return data;
    }

    try {
      var notes = getNoteElements();
      var noteCount = notes.length;
      if (targetIndex >= notes.length) {
        return { ok: false, error: '索引超出范围(' + targetIndex + '>=' + notes.length + ')', noteCount: noteCount };
      }
      var noteEl = notes[targetIndex];
      var noteId = getNoteId(noteEl);
      noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(500 + Math.random() * 400);
      var coverLink = noteEl.querySelector('a.cover') || noteEl.querySelector('a.title, a[href*="/search_result/"]') || noteEl.querySelector('a');
      if (!coverLink) return { ok: false, error: '找不到笔记链接', noteCount: noteCount };
      await humanMouseMove(coverLink);
      await sleep(150 + Math.random() * 250);
      coverLink.click();
      var opened = await waitForDetailOpen(10000);
      if (!opened) {
        return { ok: false, error: '详情弹窗未打开(超时)', noteId: noteId, noteCount: noteCount };
      }
      await sleep(800 + Math.random() * 500);
      var data = extractFromSSR(noteId);
      if (!data) { data = extractFromDOM(); }
      await closeDetail();
      return { ok: true, data: data, noteId: noteId, noteCount: noteCount };
    } catch(e) {
      try { await closeDetail(); } catch(ee) {}
      return { ok: false, error: e.message, noteCount: getNoteElements().length };
    }
  })();
})(${index})
`
          try {
            const result = await bv.webContents.executeJavaScript(scrapeScript, true)
            res.writeHead(200)
            res.end(JSON.stringify(result))
          } catch (e) {
            res.writeHead(200)
            res.end(JSON.stringify({ ok: false, error: e.message }))
          }
          return
        }

        // POST /scroll-search — 搜索页滚动加载更多
        if (req.method === 'POST' && url.pathname === '/scroll-search') {
          const bv = this.getBrowserView()
          if (!bv) {
            res.writeHead(200)
            res.end(JSON.stringify({ ok: false, noteCount: 0 }))
            return
          }
          try {
            const body = await this._readBody(req)
            const { amount, waitMs } = body ? JSON.parse(body) : {}
            const scrollScript = `
(async function() {
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  var px = __AMOUNT__;
  var jitter = (Math.random() - 0.5) * 80;
  var steps = 3 + Math.floor(Math.random() * 4);
  var perStep = (px + jitter) / steps;
  for (var i = 0; i < steps; i++) {
    window.scrollBy({ top: perStep + (Math.random()-0.5)*40, behavior: 'smooth' });
    await sleep(60 + Math.random() * 100);
  }
  await sleep(__WAIT_MS__);
  var els = document.querySelectorAll('section.note-item, [class*="note-item"]');
  return { ok: true, noteCount: els.length };
})()`
            const script = scrollScript
              .replace('__AMOUNT__', String(amount || (400 + Math.floor(Math.random() * 300))))
              .replace('__WAIT_MS__', String(waitMs || 2500))
            const result = await bv.webContents.executeJavaScript(script, true)
            res.writeHead(200)
            res.end(JSON.stringify(result))
          } catch (e) {
            res.writeHead(200)
            res.end(JSON.stringify({ ok: false, error: e.message }))
          }
          return
        }

        // GET /note-count — 获取当前搜索页笔记数量
        if (req.method === 'GET' && url.pathname === '/note-count') {
          const bv = this.getBrowserView()
          if (!bv) {
            res.writeHead(200)
            res.end(JSON.stringify({ ok: false, noteCount: 0 }))
            return
          }
          try {
            const count = await bv.webContents.executeJavaScript(
              'document.querySelectorAll(\'section.note-item, [class*="note-item"]\').length', true
            )
            res.writeHead(200)
            res.end(JSON.stringify({ ok: true, noteCount: count }))
          } catch (e) {
            res.writeHead(200)
            res.end(JSON.stringify({ ok: false, error: e.message }))
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
