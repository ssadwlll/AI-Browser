/**
 * 签名桥接服务（方法化版本，仅供 PluginManager 调用）
 *
 * 改造说明：
 *   原为 HTTP 服务（127.0.0.1:3721），现改为方法化类。
 *   - 主程序不再启动 HTTP 服务
 *   - PluginManager 在小红书插件启用时创建 SignServer 实例
 *   - 通过 host.signServer.* IPC 调用方法
 *
 * 原理：
 *   1. Electron BrowserView 加载 xiaohongshu.com（真实浏览器环境）
 *   2. 页面中 window._webmsxyw(apiPath, body) 生成 XYW_ 格式签名
 *   3. 本服务通过 webContents.executeJavaScript() 调用该函数
 *   4. 返回 { X-s, X-t, X-s-common } 给采集脚本
 *
 * 方法清单：
 *   healthCheck()                    — 检查浏览器环境
 *   sign(apiPath, body)              — 生成签名
 *   browserFetch(apiPath, body, xsc, rapParam, xs, xt, host?) — 浏览器内 fetch
 *   callMnsv2(c, u, p)               — 调用浏览器 mnsv2（XYS_ 签名）
 *   getBrowserCookies()              — 获取浏览器 cookies
 *   getBrowserUA()                   — 获取浏览器 UA
 *   browserNavigate(url, waitMs)     — 导航
 *   browserScroll()                  — 滚动
 *   browserSimulate()                — 行为模拟
 *   clickExploreNote()               — 点击推荐笔记
 *   browserClickSearch(keyword)      — 搜索框输入+点击搜索
 *   executeScript(script)            — 执行自定义 JS
 *   injectRapInterceptor()           — 注入 x-rap-param 拦截器
 *   getRapParam()                    — 获取最新 x-rap-param
 */

'use strict'

class SignServer {
  constructor(tabManager) {
    this.tabManager = tabManager
  }

  /**
   * 获取活动的 BrowserView
   */
  getBrowserView() {
    return this.tabManager ? this.tabManager.getActiveBrowserView() : null
  }

  // ============================================================
  // 签名相关
  // ============================================================

  /**
   * 检查浏览器环境是否就绪
   */
  async healthCheck() {
    const bv = this.getBrowserView()
    if (!bv) return { ok: false, error: '无活动标签页' }

    const wc = bv.webContents
    const currentUrl = wc.getURL()
    if (!currentUrl || !currentUrl.includes('xiaohongshu.com')) {
      return { ok: false, error: '当前页面不是小红书', currentUrl }
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

    return {
      ok: check.hasWebmsxyw,
      hasWebmsxyw: check.hasWebmsxyw,
      hasMnsv2: check.hasMnsv2,
      url: check.url,
      title: check.title,
    }
  }

  /**
   * 生成 XYW_ 签名（通过浏览器 _webmsxyw）
   */
  async sign(apiPath, body) {
    if (!apiPath) throw new Error('缺少 apiPath')

    const bv = this.getBrowserView()
    if (!bv) throw new Error('无活动标签页')

    const wc = bv.webContents
    const currentUrl = wc.getURL()
    if (!currentUrl || !currentUrl.includes('xiaohongshu.com')) {
      throw new Error('当前页面不是小红书，请先在浏览器中打开 xiaohongshu.com')
    }

    let bodyStr = ''
    if (body !== null && body !== undefined) {
      bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
    }

    const script = `
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
})(${JSON.stringify(apiPath)}, ${JSON.stringify(bodyStr)})
`

    const result = await wc.executeJavaScript(script, true)
    if (result.error) {
      throw new Error(result.error)
    }
    return result
  }

  /**
   * 在浏览器页面内发起 API 请求（签名+请求全部在浏览器中完成）
   * @param {string} apiPath - API 路径
   * @param {string} bodyStr - 请求体字符串
   * @param {string} xsc - x-s-common（可选）
   * @param {string} rapParam - x-rap-param（可选）
   * @param {string} xs - 外部传入的 XYS_ 签名（可选，不传则用 _webmsxyw）
   * @param {string} xt - x-t
   * @param {string} host - 自定义主机（可选）
   * @returns {Promise<{ok, status, data}>}
   */
  async browserFetch(apiPath, bodyStr, xsc, rapParam, xs, xt, host) {
    if (!apiPath) throw new Error('缺少 apiPath')

    const bv = this.getBrowserView()
    if (!bv) throw new Error('无活动标签页')

    const wc = bv.webContents
    const currentUrl = wc.getURL()
    if (!currentUrl || !currentUrl.includes('xiaohongshu.com')) {
      throw new Error('当前页面不是小红书')
    }

    const fetchHost = host || (apiPath.includes('search') ? 'so.xiaohongshu.com' : 'edith.xiaohongshu.com')

    const fetchScript = `
(function(host, apiPath, bodyStr, method, xsc, rapParam, extXs, extXt) {
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

      // 2. 生成随机 traceId
      function randHex(len) {
        var s = '';
        var chars = '0123456789abcdef';
        for (var i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
        return s;
      }

      // 3. 构建请求头
      var headers = {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json;charset=UTF-8',
        'x-s': xS,
        'x-t': xT,
        'x-b3-traceid': randHex(16),
        'x-xray-traceid': randHex(32),
        'xy-direction': '18',
      }
      if (xsc) headers['x-s-common'] = xsc
      if (rapParam) headers['x-rap-param'] = rapParam

      // 4. 发起 fetch 请求（浏览器环境，TLS/HTTP2 自动正确）
      var fullUrl = 'https://' + host + apiPath;
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

      return { ok: true, status: resp.status, data: data }
    } catch(e) {
      return { ok: false, error: e.message }
    }
  })()
})(${JSON.stringify(fetchHost)}, ${JSON.stringify(apiPath)}, ${JSON.stringify(bodyStr || '')}, ${JSON.stringify('POST')}, ${JSON.stringify(xsc || '')}, ${JSON.stringify(rapParam || '')}, ${JSON.stringify(xs || '')}, ${JSON.stringify(xt || '')})
`

    const result = await wc.executeJavaScript(fetchScript, true)
    return result
  }

  /**
   * 调用浏览器 window.mnsv2(c, u, p)（XYS_ 签名生成）
   */
  async callMnsv2(c, u, p) {
    if (!c) throw new Error('缺少参数 c')

    const bv = this.getBrowserView()
    if (!bv) throw new Error('无活动标签页')

    const wc = bv.webContents
    const currentUrl = wc.getURL()
    if (!currentUrl || !currentUrl.includes('xiaohongshu.com')) {
      throw new Error('当前页面不是小红书')
    }

    const script = `
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
})(${JSON.stringify(c)}, ${JSON.stringify(u || '')}, ${JSON.stringify(p || '')})
`

    const result = await wc.executeJavaScript(script, true)
    if (result.error) throw new Error(result.error)
    return result
  }

  // ============================================================
  // 浏览器环境
  // ============================================================

  /**
   * 获取浏览器 cookies（小红书域名）
   */
  async getBrowserCookies() {
    const bv = this.getBrowserView()
    if (!bv) return { ok: false, error: '无活动标签页' }

    const ses = bv.webContents.session
    const cookies = await ses.cookies.get({ url: 'https://www.xiaohongshu.com' })
    const cookieObj = {}
    cookies.forEach(c => { cookieObj[c.name] = c.value })
    return { ok: true, cookies: cookieObj }
  }

  /**
   * 获取浏览器 UA
   */
  async getBrowserUA() {
    const bv = this.getBrowserView()
    const ua = bv ? bv.webContents.getUserAgent() : ''
    return { ok: true, userAgent: ua }
  }

  /**
   * 导航浏览器到指定 URL（产生真实行为事件）
   */
  async browserNavigate(url, waitMs = 3000) {
    if (!url) throw new Error('缺少 url')

    const bv = this.getBrowserView()
    if (!bv) throw new Error('无活动标签页')

    try {
      const beforeUrl = bv.webContents.getURL()

      // 用 executeJavaScript 设置 location.href（触发浏览器原生导航）
      await bv.webContents.executeJavaScript(`window.location.href = ${JSON.stringify(url)};`, true)

      // 等待页面开始导航
      await new Promise(r => setTimeout(r, 2000))

      // 等待页面加载完成
      const waitFinish = new Promise((resolve) => {
        const timer = setTimeout(() => {
          bv.webContents.removeListener('did-finish-load', handler)
          resolve('timeout')
        }, waitMs + 5000)
        const handler = () => {
          clearTimeout(timer)
          resolve('loaded')
        }
        bv.webContents.once('did-finish-load', handler)
      })
      await waitFinish

      // 额外等待 JS 执行
      await new Promise(r => setTimeout(r, 2000))

      const finalUrl = bv.webContents.getURL()
      const navigated = finalUrl !== beforeUrl

      if (navigated) {
        return { ok: true, url: finalUrl }
      }

      // URL 没变，尝试 loadURL 兜底
      try {
        await bv.webContents.loadURL(url)
        await new Promise(r => setTimeout(r, waitMs))
        const finalUrl2 = bv.webContents.getURL()
        return { ok: finalUrl2 !== beforeUrl, url: finalUrl2 }
      } catch (e2) {
        return { ok: false, error: '导航未生效: ' + e2.message }
      }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  /**
   * 页面滚动（产生 collect 行为事件）
   */
  async browserScroll() {
    const bv = this.getBrowserView()
    if (!bv) throw new Error('无活动标签页')

    await bv.webContents.executeJavaScript(`
      (function() {
        return document.readyState === 'complete' || document.readyState === 'interactive';
      })()
    `, true)

    const scrollAmount = Math.floor(600 + Math.random() * 600)
    await bv.webContents.executeJavaScript(`
      (function() {
        window.scrollBy(0, ${scrollAmount});
        var containers = document.querySelectorAll('.feeds-container, .channel-list, [class*="feed"], [class*="list"]');
        for (var i = 0; i < containers.length; i++) {
          var c = containers[i];
          if (c.scrollHeight > c.clientHeight + 10 && c.clientHeight > 100) {
            c.scrollBy(0, ${scrollAmount});
            break;
          }
        }
        return true;
      })()
    `, true)
    await new Promise(r => setTimeout(r, 800))
    return { ok: true, scrollAmount }
  }

  /**
   * 完整行为模拟（贝塞尔曲线鼠标移动 + 分步滚动 + 微移动）
   */
  async browserSimulate() {
    const bv = this.getBrowserView()
    if (!bv) return { ok: false, error: '无活动标签页' }

    try {
      await bv.webContents.executeJavaScript(`
        (async function() {
          function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

          async function microMovement() {
            var dx = (Math.random() - 0.5) * 30;
            var dy = (Math.random() - 0.5) * 30;
            document.dispatchEvent(new MouseEvent('mousemove', {
              clientX: window.innerWidth/2 + dx,
              clientY: window.innerHeight/2 + dy,
              bubbles: true, view: window
            }));
          }

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
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  /**
   * 点击首页推荐笔记（用于异常恢复）
   */
  async clickExploreNote() {
    const bv = this.getBrowserView()
    if (!bv) return { ok: false, error: '无活动标签页' }

    try {
      const result = await bv.webContents.executeJavaScript(`
        (async function() {
          function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

          var noteEl = null;
          for (var i = 0; i < 10; i++) {
            noteEl = document.querySelector('section.note-item a.cover, section.note-item a[href*="/explore/"], a[href*="/explore/"]');
            if (noteEl) break;
            await sleep(500);
          }
          if (!noteEl) return { ok: false, error: '未找到推荐笔记' };

          noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(500 + Math.random() * 300);

          var rect = noteEl.getBoundingClientRect();
          var tx = rect.left + rect.width * (0.3 + Math.random() * 0.4);
          var ty = rect.top + rect.height * (0.3 + Math.random() * 0.4);

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

          var opened = false;
          for (var i = 0; i < 20; i++) {
            var mask = document.querySelector('.close-mask-dark');
            var detail = document.querySelector('[class*="note-detail"], .note-scroller, #detail-desc');
            if (mask || detail) { opened = true; break; }
            await sleep(300);
          }

          if (opened) {
            await sleep(1000 + Math.random() * 1000);
            for (var i = 0; i < 3; i++) {
              window.scrollBy({ top: 200 + Math.random() * 300, behavior: 'smooth' });
              await sleep(500 + Math.random() * 500);
            }
            await sleep(800 + Math.random() * 600);

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
      return result
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  /**
   * 搜索框输入关键词 + 点击搜索按钮（深度人类行为模拟）
   * @param {string} keyword - 关键词，不传则随机选
   */
  async browserClickSearch(keyword) {
    const bv = this.getBrowserView()
    if (!bv) return { ok: false, error: '无活动标签页' }

    // 转义关键词中的特殊字符
    const safeKeyword = (keyword || '').replace(/['"\\\n\r]/g, '').substring(0, 50)

    try {
      const result = await bv.webContents.executeJavaScript(`
        (async function() {
          function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

          function dispatchMouseMove(x, y) {
            try {
              document.dispatchEvent(new MouseEvent('mousemove', {
                clientX: Math.round(x), clientY: Math.round(y),
                bubbles: true, cancelable: true, view: window
              }));
            } catch(e) {}
          }

          function clampToScreen(x, y) {
            return {
              x: Math.max(0, Math.min(window.innerWidth - 1, x)),
              y: Math.max(0, Math.min(window.innerHeight - 1, y))
            };
          }

          async function moveMouseBezier(startX, startY, endX, endY, jitter) {
            var steps = 8 + Math.floor(Math.random() * 8);
            for (var i = 0; i <= steps; i++) {
              var t = i / steps;
              var ease = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
              var p = clampToScreen(
                startX + (endX - startX) * ease + (Math.random()-0.5) * (jitter || 20),
                startY + (endY - startY) * ease + (Math.random()-0.5) * (jitter || 20)
              );
              dispatchMouseMove(p.x, p.y);
              await sleep(10 + Math.random() * 25);
            }
          }

          async function naturalHover(targetX, targetY, duration) {
            var hoverTime = duration || (400 + Math.random() * 800);
            var pointCount = 8 + Math.floor(Math.random() * 8);
            var padDelay = Math.floor(hoverTime / pointCount);
            for (var i = 0; i < pointCount; i++) {
              dispatchMouseMove(
                targetX + (Math.random() * 8 - 4),
                targetY + (Math.random() * 8 - 4)
              );
              await sleep(padDelay);
            }
          }

          async function moveMouseToRandomArea() {
            var tx = Math.floor(window.innerWidth * (0.15 + Math.random() * 0.7));
            var ty = Math.floor(window.innerHeight * (0.15 + Math.random() * 0.7));
            var sx = Math.floor(window.innerWidth * (0.2 + Math.random() * 0.6));
            var sy = Math.floor(window.innerHeight * (0.2 + Math.random() * 0.6));
            await moveMouseBezier(sx, sy, tx, ty, 15);
            await sleep(200 + Math.random() * 400);
          }

          var searchInput = null;
          for (var i = 0; i < 10; i++) {
            searchInput = document.querySelector('textarea#search-input')
              || document.querySelector('#search-input-in-feeds')
              || document.querySelector('input[type="text"][placeholder*="搜索"]');
            if (searchInput) break;
            await sleep(500);
          }
          if (!searchInput) return { ok: false, error: '未找到搜索框' };

          searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(500 + Math.random() * 300);

          if (Math.random() < 0.5) {
            await moveMouseToRandomArea();
            await sleep(300 + Math.random() * 500);
          }

          var rect = searchInput.getBoundingClientRect();
          var tx = rect.left + rect.width * (0.3 + Math.random() * 0.4);
          var ty = rect.top + rect.height * (0.3 + Math.random() * 0.4);

          var sx = window.innerWidth * (0.15 + Math.random() * 0.7);
          var sy = window.innerHeight * (0.15 + Math.random() * 0.7);
          await moveMouseBezier(sx, sy, tx, ty, 25);

          await naturalHover(tx, ty, 300 + Math.random() * 500);

          var mouseOpts = { bubbles: true, cancelable: true, view: window, clientX: Math.round(tx), clientY: Math.round(ty) };
          try {
            searchInput.dispatchEvent(new MouseEvent('mouseenter', mouseOpts));
            searchInput.dispatchEvent(new MouseEvent('mouseover', mouseOpts));
          } catch(e) {}
          await sleep(100 + Math.random() * 100);
          try { searchInput.dispatchEvent(new MouseEvent('mousedown', mouseOpts)); } catch(e) {}
          await sleep(50 + Math.random() * 50);
          try { searchInput.dispatchEvent(new MouseEvent('mouseup', mouseOpts)); } catch(e) {}
          await sleep(20 + Math.random() * 30);
          try { searchInput.focus(); } catch(e) {}
          try { if (typeof searchInput.click === 'function') searchInput.click(); } catch(e) {}
          await sleep(300 + Math.random() * 200);

          var keyword = ${JSON.stringify(safeKeyword)};
          if (!keyword) {
            var keywords = ['美食', '穿搭', '护肤', '旅行', '家居', '健身', '美妆', '读书', '电影', '音乐'];
            keyword = keywords[Math.floor(Math.random() * keywords.length)];
          }

          var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(searchInput, '');
          } else {
            searchInput.value = '';
          }
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(200 + Math.random() * 200);

          for (var i = 0; i < keyword.length; i++) {
            var ch = keyword[i];
            try {
              searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code: ch, keyCode: ch.charCodeAt(0), bubbles: true }));
            } catch(e) {}
            if (nativeSetter) {
              nativeSetter.call(searchInput, searchInput.value + ch);
            } else {
              searchInput.value += ch;
            }
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            try {
              searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: ch, code: ch, keyCode: ch.charCodeAt(0), bubbles: true }));
            } catch(e) {}
            await sleep(80 + Math.random() * 120);
          }
          searchInput.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(500 + Math.random() * 400);

          var searchBtn = null;
          var searchBtnInfo = '';
          for (var retry = 0; retry < 5; retry++) {
            searchBtn = document.querySelector('.submit-button')
              || document.querySelector('svg.submit-button')
              || document.querySelector('button[type="submit"]');
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

            var sx2 = window.innerWidth * (0.15 + Math.random() * 0.7);
            var sy2 = window.innerHeight * (0.15 + Math.random() * 0.7);
            await moveMouseBezier(sx2, sy2, bx, by, 15);

            await naturalHover(bx, by, 200 + Math.random() * 400);

            var btnOpts = { bubbles: true, cancelable: true, view: window, clientX: Math.round(bx), clientY: Math.round(by) };
            try {
              searchBtn.dispatchEvent(new MouseEvent('mouseenter', btnOpts));
              searchBtn.dispatchEvent(new MouseEvent('mouseover', btnOpts));
            } catch(e) {}
            await sleep(80 + Math.random() * 100);
            try { searchBtn.dispatchEvent(new MouseEvent('mousedown', btnOpts)); } catch(e) {}
            await sleep(40 + Math.random() * 60);
            try { searchBtn.dispatchEvent(new MouseEvent('mouseup', btnOpts)); } catch(e) {}
            await sleep(20 + Math.random() * 30);
            try { if (typeof searchBtn.click === 'function') searchBtn.click(); } catch(e) {}

            return { ok: true, keyword: keyword, btnClicked: true, btnInfo: searchBtnInfo };
          } else {
            try {
              searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
              searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            } catch(e) {}
            return { ok: true, keyword: keyword, btnClicked: false, btnInfo: '回车搜索' };
          }
        })()
      `, true)

      await new Promise(r => setTimeout(r, 1500))
      return result
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  /**
   * 在浏览器页面上下文中执行自定义 JS（用于深度交互）
   */
  async executeScript(script) {
    if (!script || typeof script !== 'string') throw new Error('缺少 script 参数')

    const bv = this.getBrowserView()
    if (!bv) throw new Error('无活动标签页')

    const currentUrl = bv.webContents.getURL()
    if (!currentUrl || !currentUrl.includes('xiaohongshu.com')) {
      throw new Error('当前页面不是小红书')
    }

    try {
      const result = await bv.webContents.executeJavaScript(script, true)
      return { ok: true, result: result === undefined ? null : result }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  // ============================================================
  // x-rap-param 拦截器
  // ============================================================

  /**
   * 注入 x-rap-param 拦截器到页面
   * 拦截 fetch/XHR 请求头中的 x-rap-param，按 URL 分类存到 window._xhsRapParams
   */
  async injectRapInterceptor() {
    const bv = this.getBrowserView()
    if (!bv) return { ok: false, error: '无活动标签页' }

    try {
      await bv.webContents.executeJavaScript(`
        (function() {
          if (window._xhsRapInterceptorInstalled) return { ok: true, already: true };
          window._xhsRapInterceptorInstalled = true;
          window._xhsRapParams = { search: '', feed: '', updatedAt: 0 };

          var originalFetch = window.fetch;
          window.fetch = function() {
            var args = arguments;
            try {
              var url = args[0];
              var options = args[1] || {};
              var headers = options.headers;
              if (headers) {
                var rapParam = null;
                if (typeof headers.get === 'function') {
                  rapParam = headers.get('x-rap-param') || headers.get('X-rap-param');
                } else if (typeof headers === 'object') {
                  rapParam = headers['x-rap-param'] || headers['X-rap-param'] || headers['x-Rap-Param'];
                }
                if (rapParam) {
                  captureRapParam(rapParam, typeof url === 'string' ? url : (url && url.url) || '');
                }
              }
            } catch(e) {}
            return originalFetch.apply(this, args);
          };

          var originalOpen = XMLHttpRequest.prototype.open;
          var originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
          XMLHttpRequest.prototype.open = function(method, url) {
            this.__xhs_url = url;
            return originalOpen.apply(this, arguments);
          };
          XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
            try {
              if (name && name.toLowerCase() === 'x-rap-param' && value) {
                captureRapParam(value, this.__xhs_url || '');
              }
            } catch(e) {}
            return originalSetHeader.apply(this, arguments);
          };

          function captureRapParam(rapParam, url) {
            var type = 'unknown';
            if (url.indexOf('search/notes') !== -1 || url.indexOf('so.xiaohongshu.com') !== -1) {
              type = 'search';
            } else if (url.indexOf('/feed') !== -1 || url.indexOf('edith.xiaohongshu.com') !== -1) {
              type = 'feed';
            }
            if (type === 'search' || type === 'feed') {
              window._xhsRapParams[type] = rapParam;
              window._xhsRapParams.updatedAt = Date.now();
            }
          }

          return { ok: true, already: false };
        })()
      `, true)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  /**
   * 获取最新捕获的 x-rap-param
   */
  async getRapParam() {
    const bv = this.getBrowserView()
    if (!bv) return { ok: false, error: '无活动标签页' }

    try {
      const params = await bv.webContents.executeJavaScript(`
        (function() {
          return window._xhsRapParams || { search: '', feed: '', updatedAt: 0 };
        })()
      `, true)
      return {
        ok: true,
        search: params.search || '',
        feed: params.feed || '',
        updatedAt: params.updatedAt || 0,
      }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }
}

module.exports = SignServer
