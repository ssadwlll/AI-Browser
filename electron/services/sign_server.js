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

        // POST /click-explore-note — 在首页点击推荐笔记（用于异常恢复）
        // 流程：找到第一个笔记 → 鼠标移动 → 点击 → 等待详情打开 → 滚动 → 关闭 → 返回首页
        if (req.method === 'POST' && url.pathname === '/click-explore-note') {
          const bv = this.getBrowserView()
          if (!bv) {
            res.writeHead(200)
            res.end(JSON.stringify({ ok: false, error: '无活动标签页' }))
            return
          }
          try {
            const result = await bv.webContents.executeJavaScript(`
              (async function() {
                function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

                // 等待笔记元素出现
                var noteEl = null;
                for (var i = 0; i < 10; i++) {
                  noteEl = document.querySelector('section.note-item a.cover, section.note-item a[href*="/explore/"], a[href*="/explore/"]');
                  if (noteEl) break;
                  await sleep(500);
                }
                if (!noteEl) return { ok: false, error: '未找到推荐笔记' };

                // 滚动到可见
                noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await sleep(500 + Math.random() * 300);

                // 获取目标位置
                var rect = noteEl.getBoundingClientRect();
                var tx = rect.left + rect.width * (0.3 + Math.random() * 0.4);
                var ty = rect.top + rect.height * (0.3 + Math.random() * 0.4);

                // 贝塞尔曲线鼠标移动
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

                await sleep(150 + Math.random() * 250);

                // 点击笔记
                noteEl.dispatchEvent(new MouseEvent('mousedown', {
                  clientX: tx, clientY: ty, bubbles: true, cancelable: true, view: window
                }));
                await sleep(40 + Math.random() * 80);
                noteEl.dispatchEvent(new MouseEvent('mouseup', {
                  clientX: tx, clientY: ty, bubbles: true, cancelable: true, view: window
                }));
                await sleep(20 + Math.random() * 40);
                noteEl.dispatchEvent(new MouseEvent('click', {
                  clientX: tx, clientY: ty, bubbles: true, cancelable: true, view: window
                }));
                try { noteEl.click(); } catch(e) {}

                // 等待详情页打开
                var opened = false;
                for (var i = 0; i < 20; i++) {
                  var mask = document.querySelector('.close-mask-dark');
                  var detail = document.querySelector('[class*="note-detail"], .note-scroller, #detail-desc');
                  if (mask || detail) { opened = true; break; }
                  await sleep(300);
                }

                if (opened) {
                  // 在详情页停留+滚动（模拟阅读）
                  await sleep(1000 + Math.random() * 1000);
                  for (var i = 0; i < 3; i++) {
                    window.scrollBy({ top: 200 + Math.random() * 300, behavior: 'smooth' });
                    await sleep(500 + Math.random() * 500);
                  }
                  await sleep(800 + Math.random() * 600);

                  // 关闭详情
                  var closeBtn = document.querySelector('.close-mask-dark');
                  if (closeBtn) {
                    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    try { closeBtn.click(); } catch(e) {}
                  } else {
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
                  }
                  await sleep(500);
                }

                return { ok: true, opened: opened };
              })()
            `, true)

            await new Promise(r => setTimeout(r, 1000))
            console.log(`[SignServer] 点击推荐笔记: ok=${result.ok} opened=${result.opened}`)
            res.writeHead(200)
            res.end(JSON.stringify(result))
          } catch (e) {
            res.writeHead(200)
            res.end(JSON.stringify({ ok: false, error: e.message }))
          }
          return
        }

        // POST /click-search — 点击首页搜索框（用于异常恢复）
        // 流程：找到搜索框 → 鼠标移动 → 点击 → 输入随机关键词 → 点击搜索按钮
        if (req.method === 'POST' && url.pathname === '/click-search') {
          const bv = this.getBrowserView()
          if (!bv) {
            res.writeHead(200)
            res.end(JSON.stringify({ ok: false, error: '无活动标签页' }))
            return
          }
          try {
            const result = await bv.webContents.executeJavaScript(`
              (async function() {
                function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

                // 等待搜索框出现（textarea#search-input）
                var searchInput = null;
                for (var i = 0; i < 10; i++) {
                  searchInput = document.querySelector('textarea#search-input');
                  if (searchInput) break;
                  await sleep(500);
                }
                if (!searchInput) return { ok: false, error: '未找到搜索框 textarea#search-input' };

                // 滚动到可见
                searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await sleep(500 + Math.random() * 300);

                // 获取目标位置
                var rect = searchInput.getBoundingClientRect();
                var tx = rect.left + rect.width * (0.3 + Math.random() * 0.4);
                var ty = rect.top + rect.height * (0.3 + Math.random() * 0.4);

                // 贝塞尔曲线鼠标移动
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

                await sleep(150 + Math.random() * 250);

                // 点击搜索框
                searchInput.dispatchEvent(new MouseEvent('mousedown', {
                  clientX: tx, clientY: ty, bubbles: true, cancelable: true, view: window
                }));
                await sleep(40 + Math.random() * 80);
                searchInput.dispatchEvent(new MouseEvent('mouseup', {
                  clientX: tx, clientY: ty, bubbles: true, cancelable: true, view: window
                }));
                await sleep(20 + Math.random() * 40);
                searchInput.dispatchEvent(new MouseEvent('click', {
                  clientX: tx, clientY: ty, bubbles: true, cancelable: true, view: window
                }));
                try { searchInput.focus(); } catch(e) {}
                await sleep(300 + Math.random() * 200);

                // 输入随机关键词（从常见词池选）
                var keywords = ['美食', '穿搭', '护肤', '旅行', '家居', '健身', '美妆', '读书', '电影', '音乐'];
                var keyword = keywords[Math.floor(Math.random() * keywords.length)];
                searchInput.value = keyword;
                searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                await sleep(500 + Math.random() * 300); // 等待弹窗完全打开

                // 等待搜索弹窗出现，查找搜索按钮（svg.submit-button）
                var searchBtn = null;
                var searchBtnInfo = '';
                for (var retry = 0; retry < 5; retry++) {
                  // 优先查找 .submit-button（SVG 图标）
                  searchBtn = document.querySelector('.submit-button');
                  if (searchBtn) {
                    searchBtnInfo = '找到 .submit-button';
                    break;
                  }
                  await sleep(300);
                }

                if (searchBtn) {
                  var btnRect = searchBtn.getBoundingClientRect();
                  var bx = btnRect.left + btnRect.width * (0.3 + Math.random() * 0.4);
                  var by = btnRect.top + btnRect.height * (0.3 + Math.random() * 0.4);

                  // 贝塞尔曲线移动到按钮
                  var sx2 = window.innerWidth * (0.15 + Math.random() * 0.7);
                  var sy2 = window.innerHeight * (0.15 + Math.random() * 0.7);
                  var steps2 = 5 + Math.floor(Math.random() * 5);
                  for (var i = 0; i <= steps2; i++) {
                    var t = i / steps2;
                    var ease = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
                    var cx2 = sx2 + (bx - sx2) * ease + (Math.random()-0.5) * 15;
                    var cy2 = sy2 + (by - sy2) * ease + (Math.random()-0.5) * 15;
                    document.dispatchEvent(new MouseEvent('mousemove', {
                      clientX: cx2, clientY: cy2, bubbles: true, cancelable: true, view: window
                    }));
                    await sleep(10 + Math.random() * 20);
                  }

                  await sleep(100 + Math.random() * 150);

                  // 点击按钮
                  searchBtn.dispatchEvent(new MouseEvent('mousedown', {
                    clientX: bx, clientY: by, bubbles: true, cancelable: true, view: window
                  }));
                  await sleep(40 + Math.random() * 60);
                  searchBtn.dispatchEvent(new MouseEvent('mouseup', {
                    clientX: bx, clientY: by, bubbles: true, cancelable: true, view: window
                  }));
                  await sleep(20 + Math.random() * 30);
                  searchBtn.dispatchEvent(new MouseEvent('click', {
                    clientX: bx, clientY: by, bubbles: true, cancelable: true, view: window
                  }));
                  try { searchBtn.click(); } catch(e) {}

                  return { ok: true, keyword: keyword, btnClicked: true, btnInfo: searchBtnInfo };
                } else {
                  return { ok: true, keyword: keyword, btnClicked: false, btnInfo: '未找到搜索按钮 div.bottom-box-right' };
                }
              })()
            `, true)

            await new Promise(r => setTimeout(r, 1500))
            console.log(`[SignServer] 点击搜索: ok=${result.ok} keyword=${result.keyword}`)
            res.writeHead(200)
            res.end(JSON.stringify(result))
          } catch (e) {
            console.error('[SignServer] 点击推荐笔记失败:', e.message)
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
      console.log(`[SignServer]   POST /navigate     — 导航到指定 URL`)
      console.log(`[SignServer]   POST /scroll       — 页面滚动`)
      console.log(`[SignServer]   POST /simulate     — 行为模拟（鼠标+滚动）`)
      console.log(`[SignServer]   POST /click-explore-note — 首页点击推荐笔记（异常恢复）`)
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
