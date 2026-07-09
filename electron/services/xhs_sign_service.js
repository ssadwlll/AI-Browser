/**
 * 小红书 API 签名服务
 * 
 * 核心原理（来自逆向分析报告）：
 * 1. 在页面上下文中调用 window.mnsv2() 生成签名（依赖 Sanji 虚拟机，无法脱离浏览器）
 * 2. 自定义 Base64 字母表映射
 * 3. 签名流程：url+body → MD5 → mnsv2 → Payload JSON → 自定义 Base64 → XYS_ 前缀
 * 
 * 这是"方案 A：Headless 浏览器"的实现 —— 
 * 不需要 Puppeteer/Playwright，直接用 Electron 的 BrowserView 作为浏览器环境
 */

const https = require('https')

// 自定义 Base64 字母表（报告解析得出）
const CUSTOM_B64 = 'ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5'
const STD_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// 构建映射表：标准 → 自定义
const ENCODE_MAP = {}
const DECODE_MAP = {}
for (let i = 0; i < 64; i++) {
  ENCODE_MAP[STD_B64[i]] = CUSTOM_B64[i]
  DECODE_MAP[CUSTOM_B64[i]] = STD_B64[i]
}

/**
 * 注入到页面中执行的签名生成代码
 * 这段代码在 BrowserView 的页面上下文中运行，可以直接访问 window.mnsv2
 */
const SIGN_SCRIPT_TEMPLATE = `
(function(apiPath, bodyStr) {
  // ===== 内置 MD5 实现（不依赖页面 webpack 模块）=====
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

  // ===== 自定义 Base64 编码 =====
  var CUSTOM_B64 = "ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5";
  var STD_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var encodeMap = {};
  for (var i = 0; i < 64; i++) encodeMap[STD_B64[i]] = CUSTOM_B64[i];

  // ===== 签名生成 =====
  var u = apiPath + (bodyStr || '');
  var m = md5(u);
  var w = md5(apiPath);

  // 调用页面内的 mnsv2 虚拟机
  if (typeof window.mnsv2 !== 'function') {
    return { error: 'window.mnsv2 不可用，请确保页面已加载小红书' };
  }
  var C = window.mnsv2(u, m, w);

  // 构建 Payload
  var payload = JSON.stringify({
    x0: "4.3.7",
    x1: window.xsecappid || "xhs-pc-web",
    x2: window.xsecplatform || "PC",
    x3: C,
    x4: bodyStr ? (typeof bodyStr === 'string' ? 'string' : 'object') : ""
  });

  // UTF8 编码 → 标准 Base64 → 自定义 Base64
  var utf8bytes = new TextEncoder().encode(payload);
  var stdB64 = btoa(String.fromCharCode.apply(null, utf8bytes));
  var customB64 = stdB64.split('').map(function(c) { return encodeMap[c] || c; }).join('');

  // 尝试生成 x-s-common（部分版本页面有 window._webmsxyw 函数）
  var xSCommon = '';
  if (typeof window._webmsxyw === 'function') {
    try {
      var commonResult = window._webmsxyw(u, m, w);
      if (commonResult && commonResult['X-s-common']) {
        xSCommon = commonResult['X-s-common'];
      } else if (typeof commonResult === 'string') {
        xSCommon = commonResult;
      }
    } catch(e) {}
  }

  return {
    'X-s': 'XYS_' + customB64,
    'X-t': String(Date.now()),
    'X-s-common': xSCommon
  };
})(__API_PATH__, __BODY_STR__)
`

class XhsSignService {
  /**
   * 检查 BrowserView 是否在小红书页面且 mnsv2 可用
   */
  async checkEnvironment(browserView) {
    if (!browserView) return { ok: false, error: '无活动标签页' }

    const wc = browserView.webContents
    const url = wc.getURL()

    if (!url || !url.includes('xiaohongshu.com')) {
      return { ok: false, error: '当前页面不是小红书，请先导航到 xiaohongshu.com', currentUrl: url }
    }

    try {
      const result = await wc.executeJavaScript(`
        (function() {
          return {
            hasMnsv2: typeof window.mnsv2 === 'function',
            hasXsecappid: typeof window.xsecappid !== 'undefined',
            url: window.location.href,
            title: document.title
          }
        })()
      `, true)

      if (!result.hasMnsv2) {
        return {
          ok: false,
          error: 'window.mnsv2 不可用，页面可能未完全加载。请等待页面加载完成或刷新页面',
          currentUrl: url
        }
      }

      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: '环境检查失败: ' + e.message, currentUrl: url }
    }
  }

  /**
   * 生成 API 请求签名
   * @param {BrowserView} browserView - 当前活动的 BrowserView
   * @param {string} apiPath - API 路径，如 /api/sns/web/v1/search/notes
   * @param {object|string} body - 请求体（POST body），GET 请求传 null
   * @returns {Promise<{ok: boolean, sign?: {X-s: string, X-t: string}, error?: string}>}
   */
  async generateSign(browserView, apiPath, body) {
    if (!browserView) {
      return { ok: false, error: '无活动标签页' }
    }

    const wc = browserView.webContents
    const url = wc.getURL()

    if (!url || !url.includes('xiaohongshu.com')) {
      return { ok: false, error: '当前页面不是小红书，请先导航到 xiaohongshu.com' }
    }

    // 序列化 body
    let bodyStr = ''
    if (body !== null && body !== undefined) {
      bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
    }

    // 构建注入代码
    const script = SIGN_SCRIPT_TEMPLATE
      .replace('__API_PATH__', JSON.stringify(apiPath))
      .replace('__BODY_STR__', JSON.stringify(bodyStr))

    try {
      const result = await wc.executeJavaScript(script, true)

      if (result.error) {
        return { ok: false, error: result.error }
      }

      return { ok: true, sign: result }
    } catch (e) {
      // CSP 或其他执行错误
      if (e.message && (e.message.includes('Content Security Policy') || e.message.includes('unsafe-eval'))) {
        return {
          ok: false,
          error: 'CSP 阻止了脚本执行，请尝试在页面完全加载后重试',
        }
      }
      return { ok: false, error: '签名生成失败: ' + e.message }
    }
  }

  /**
   * 从 BrowserView session 获取小红书 cookies
   */
  async getCookies(browserView) {
    if (!browserView) return ''

    const ses = browserView.webContents.session
    const cookies = await ses.cookies.get({ url: 'https://www.xiaohongshu.com' })

    return cookies.map(c => `${c.name}=${c.value}`).join('; ')
  }

  /**
   * 获取 User-Agent（从 BrowserView 获取，确保一致）
   */
  async getUserAgent(browserView) {
    if (!browserView) return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    return browserView.webContents.getUserAgent()
  }
}

module.exports = new XhsSignService()
