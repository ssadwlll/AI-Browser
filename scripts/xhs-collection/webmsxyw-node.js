/**
 * webmsxyw-node.js — 小红书 _webmsxyw 签名 Node.js 独立运行模块
 *
 * 原理：
 *   _webmsxyw 由 sign.js 定义，依赖 ds.js 运行时
 *   返回 XYW_ 格式签名（标准 Base64 编码的 JSON）
 *   包含 { X-s, X-t }，不包含 X-s-common
 *
 * XYW_ 格式结构：
 *   XYW_ + Base64({"signSvn":"56","signType":"x2","appId":"xhs-pc-web","signVersion":"1","payload":"<hex>"})
 *
 * 签名特性：
 *   - 绑定 API 路径（不同路径产生不同签名）
 *   - 绑定请求体（不同 body 产生不同签名）— 与旧 XYS_ 格式不同！
 *   - 含随机因子（非幂等，每次调用结果不同）
 *   - payload 为 208 字节数据的 hex 编码（前 192 字节确定，后 16 字节随机）
 *
 * 使用方法：
 *   const { init, sign, generateHeaders } = require('./webmsxyw-node');
 *   await init();
 *   const headers = generateHeaders('/api/sns/web/v1/search/notes', JSON.stringify(body));
 *   // → { 'X-s': 'XYW_eyJ...', 'X-t': '1783595...' }
 *
 * 脚本来源：
 *   ds.js:   https://as.xiaohongshu.com/api/sec/v1/ds?appId=xhs-pc-web
 *   sign.js: https://fe-static.xhscdn.com/as/v1/f218/a15/public/04b29480233f4def5c875875b6bdc3b1.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const SCRIPTS_DIR = __dirname;
const DS_FILE = path.join(SCRIPTS_DIR, 'ds.js');
const SIGN_FILE = path.join(SCRIPTS_DIR, 'sign.js');

const DS_URL = 'https://as.xiaohongshu.com/api/sec/v1/ds?appId=xhs-pc-web';
const SIGN_URL = 'https://fe-static.xhscdn.com/as/v1/f218/a15/public/04b29480233f4def5c875875b6bdc3b1.js';

let _initialized = false;

// ======================= 浏览器环境模拟 =======================

function setupBrowserEnv(cookieStr) {
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.xsecappid = 'xhs-pc-web';
  globalThis.xsecplatform = 'PC';

  const cookie = cookieStr || 'a1=; web_session=; xsecappid=xhs-pc-web';

  globalThis.document = {
    cookie,
    createElement: (tag) => ({
      tagName: (tag || 'div').toUpperCase(),
      style: {}, setAttribute() {}, getAttribute: () => null,
      appendChild() {}, removeChild() {}, addEventListener() {},
      getContext: () => null, innerHTML: '', textContent: '',
    }),
    getElementsByTagName: () => [],
    getElementById: () => null,
    head: { appendChild() {}, removeChild() {} },
    body: { appendChild() {}, removeChild() {} },
    documentElement: { style: {}, getAttribute: () => null, clientWidth: 1920, clientHeight: 1080 },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    createEvent: () => ({ initEvent() {} }),
    hidden: false, visibilityState: 'visible',
    referrer: '', title: '', URL: 'https://www.xiaohongshu.com/explore',
    domain: 'www.xiaohongshu.com', readyState: 'complete',
  };

  const navMock = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    platform: 'Win32', language: 'zh-CN', languages: ['zh-CN', 'zh'],
    cookieEnabled: true, hardwareConcurrency: 8, maxTouchPoints: 0,
    vendor: 'Google Inc.', webdriver: false,
    plugins: [], mimeTypes: [],
    appName: 'Netscape', appVersion: '5.0',
    onLine: true, javaEnabled: () => false,
    sendBeacon: () => true,
  };
  try {
    globalThis.navigator = navMock;
  } catch {
    // Node.js 21+ 中 navigator 是只读属性，用 defineProperty 覆盖
    try {
      Object.defineProperty(globalThis, 'navigator', { value: navMock, writable: true, configurable: true });
    } catch {
      // 如果无法覆盖，合并到现有 navigator
      if (globalThis.navigator) {
        Object.assign(globalThis.navigator, navMock);
      }
    }
  }

  globalThis.location = {
    href: 'https://www.xiaohongshu.com/explore',
    protocol: 'https:', host: 'www.xiaohongshu.com',
    hostname: 'www.xiaohongshu.com', port: '',
    pathname: '/explore', search: '', hash: '',
    origin: 'https://www.xiaohongshu.com',
    reload() {}, replace() {},
  };

  const startTime = Date.now();
  const perfMock = {
    now: () => Date.now() - startTime,
    timing: { navigationStart: startTime - 100 },
    getEntriesByType: () => [], getEntries: () => [],
    mark() {}, measure() {},
  };
  try { globalThis.performance = perfMock; } catch {
    try { Object.defineProperty(globalThis, 'performance', { value: perfMock, writable: true, configurable: true }); } catch {}
  }

  // signSvn 配置（从 localStorage.sdt_source_storage_key 读取）
  const _store = new Map();
  _store.set('sdt_source_storage_key', JSON.stringify({
    signUrl: SIGN_URL,
    signVersion: '1', signType: 'x2', signSvn: '56',
    commonPatch: [
      '/fe_api/burdock/v2/note/post',
      '/api/sns/web/v1/comment/post',
      '/api/sns/web/v1/note/like',
      '/api/sns/web/v1/note/collect',
      '/api/sns/web/v1/user/follow',
      '/api/sns/web/v1/feed',
      '/api/sns/web/v1/login/activate',
      '/api/sns/web/v1/note/metrics_report',
      '/api/redcaptcha',
      '/api/store/jpd/main',
      '/phoenix/api/strategy/getAppStrategy',
      '/web_api/sns/v2/note',
    ],
    extraInfo: {
      dsUrl: 'https://fe-static.xhscdn.com/as/v2/ds/6545c70e73d7e06896b3c574a70b5438.js',
      kbconf: null, fpMatchUrls: null,
    },
    url: 'https://fe-static.xhscdn.com/as/v2/fp/643f48183a62c46e6c924b3f0456767a.js',
    xhsTokenUrl: 'https://fe-static.xhscdn.com/as/v1/3e44/public/bf7d4e32677698655a5cadc581fd09b3.js',
    reportUrl: '/api/sec/v1/shield/webprofile',
    desVersion: '2', validate: true,
  }));

  const storageMock = {
    getItem: (k) => _store.get(String(k)) ?? null,
    setItem: (k, v) => { _store.set(String(k), String(v)); },
    removeItem: (k) => { _store.delete(String(k)); },
    clear: () => { _store.clear(); },
    get length() { return _store.size; },
    key: (i) => [..._store.keys()][i] || null,
  };
  globalThis.localStorage = storageMock;
  globalThis.sessionStorage = { ...storageMock };

  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.dispatchEvent = () => true;
  globalThis.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 };
  globalThis.history = { pushState() {}, replaceState() {}, back() {}, forward() {}, go() {}, length: 1 };
  globalThis.CSS = { escape: (v) => v, supports: () => false };
  globalThis.matchMedia = (q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

  if (!globalThis.atob) globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  if (!globalThis.btoa) globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  if (!globalThis.TextEncoder) globalThis.TextEncoder = require('util').TextEncoder;
  if (!globalThis.TextDecoder) globalThis.TextDecoder = require('util').TextDecoder;

  globalThis.XMLHttpRequest = function() {
    this.open = () => {}; this.send = () => {};
    this.setRequestHeader = () => {}; this.getAllResponseHeaders = () => '';
    this.readyState = 4; this.status = 200;
    this.response = ''; this.responseText = '';
    this.addEventListener = () => {}; this.removeEventListener = () => {};
  };
  const fetchMock = () => Promise.resolve({
    ok: true, json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  });
  try { globalThis.fetch = fetchMock; } catch { /* read-only */ }
  try { globalThis.crypto = globalThis.crypto || require('crypto').webcrypto; } catch { /* read-only */ }
  globalThis.MessageChannel = function() {
    this.port1 = { postMessage() {}, onmessage: null };
    this.port2 = { postMessage() {}, onmessage: null };
  };
  globalThis.postMessage = () => {};
  globalThis.WebSocket = function() {
    this.send = () => {}; this.close = () => {};
    this.addEventListener = () => {};
  };
}

// ======================= 脚本下载 =======================

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

async function ensureScript(filePath, url) {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  console.log(`[webmsxyw] 下载脚本: ${url}`);
  const code = await downloadFile(url);
  fs.writeFileSync(filePath, code);
  console.log(`[webmsxyw] 已保存: ${path.basename(filePath)} (${code.length} 字符)`);
  return code;
}

// ======================= 初始化 =======================

/**
 * 初始化 _webmsxyw
 * @param {Object} options
 * @param {string} options.cookie - Cookie 字符串（可选，用于 document.cookie）
 * @param {boolean} options.refreshDs - 是否重新下载 ds.js
 * @param {boolean} options.refreshSign - 是否重新下载 sign.js
 */
async function init(options = {}) {
  if (_initialized) return true;

  const { cookie, refreshDs = false, refreshSign = false } = options;

  // 设置浏览器环境
  setupBrowserEnv(cookie);

  // 下载/加载脚本
  if (refreshDs && fs.existsSync(DS_FILE)) fs.unlinkSync(DS_FILE);
  if (refreshSign && fs.existsSync(SIGN_FILE)) fs.unlinkSync(SIGN_FILE);

  const dsCode = await ensureScript(DS_FILE, DS_URL);
  const signCode = await ensureScript(SIGN_FILE, SIGN_URL);

  // 加载 ds.js（创建运行时）
  try {
    eval(dsCode);
  } catch (e) {
    throw new Error(`ds.js 加载失败: ${e.message}`);
  }

  // 加载 sign.js（定义 _webmsxyw）
  try {
    eval(signCode);
  } catch (e) {
    // sign.js 可能在初始化时抛出错误，但 _webmsxyw 仍会被注册
    if (typeof globalThis._webmsxyw !== 'function') {
      throw new Error(`sign.js 加载失败且 _webmsxyw 未注册: ${e.message}`);
    }
  }

  if (typeof globalThis._webmsxyw !== 'function') {
    throw new Error('_webmsxyw 未注册');
  }

  _initialized = true;
  console.log('[webmsxyw] 初始化成功');
  return true;
}

// ======================= 签名生成 =======================

/**
 * 生成签名
 * @param {string} apiPath - API 路径，如 '/api/sns/web/v1/search/notes'
 * @param {Object|string} body - 请求体（对象或 JSON 字符串，可选）
 * @returns {{ 'X-s': string, 'X-t': string }}
 */
function sign(apiPath, body) {
  if (!_initialized) throw new Error('未初始化，请先调用 init()');
  if (typeof globalThis._webmsxyw !== 'function') throw new Error('_webmsxyw 不可用');

  // _webmsxyw 接受 (url, params) 两参数
  // params 可以是对象或 undefined
  let params = body;
  if (typeof body === 'string') {
    try { params = JSON.parse(body); } catch { params = body; }
  }

  const result = globalThis._webmsxyw(apiPath, params);

  if (!result || !result['X-s']) {
    throw new Error('_webmsxyw 返回无效结果');
  }

  return {
    'X-s': result['X-s'],
    'X-t': String(result['X-t']),
  };
}

/**
 * 生成请求头
 * @param {string} apiPath - API 路径
 * @param {Object|string} body - 请求体
 * @returns {{ 'X-s': string, 'X-t': string }}
 */
function generateHeaders(apiPath, body) {
  return sign(apiPath, body);
}

/**
 * 解码 XYW_ 签名，查看内部结构
 * @param {string} xs - XYW_ 格式的 X-s 值
 * @returns {Object} 解码后的 JSON
 */
function decodeXYW(xs) {
  if (!xs || !xs.startsWith('XYW_')) {
    throw new Error('不是 XYW_ 格式');
  }
  const b64 = xs.substring(4);
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

/**
 * 检查 API 路径是否在 commonPatch 列表中（需要 x-s-common）
 * @param {string} apiPath
 * @returns {boolean}
 */
function needsCommon(apiPath) {
  const commonPatch = [
    '/fe_api/burdock/v2/note/post',
    '/api/sns/web/v1/comment/post',
    '/api/sns/web/v1/note/like',
    '/api/sns/web/v1/note/collect',
    '/api/sns/web/v1/user/follow',
    '/api/sns/web/v1/feed',
    '/api/sns/web/v1/login/activate',
    '/api/sns/web/v1/note/metrics_report',
    '/api/redcaptcha',
    '/api/store/jpd/main',
    '/phoenix/api/strategy/getAppStrategy',
    '/web_api/sns/v2/note',
  ];
  return commonPatch.some(p => apiPath.startsWith(p));
}

// ======================= 导出 =======================

module.exports = {
  init,
  sign,
  generateHeaders,
  decodeXYW,
  needsCommon,
  get isReady() { return _initialized; },
};
