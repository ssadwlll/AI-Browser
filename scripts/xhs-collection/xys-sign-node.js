/**
 * xys-sign-node.js — 小红书 XYS_ 签名 Node.js 独立生成模块
 *
 * 完全在 Node.js 中运行，无需 Electron/浏览器/sign_server。
 *
 * 原理（来自 mnsv2 VM 逆向分析报告）：
 *   1. ds.js 定义 _AUuXfEG27Xa3x 编译器基础设施
 *   2. vendor-dynamic.8cd1891c.js 模块 #12369 包含完整编译器 + 233081 hex 字节码
 *   3. 加载后自动注册 window.mnsv2 全局函数
 *   4. seccore_signv2 算法：c=apiPath+JSON.stringify(body), u=MD5(c), p=MD5(apiPath)
 *   5. XYS_ = "XYS_" + customBase64( utf8Encode( JSON.stringify({x0,x1,x2,x3,x4}) ) )
 *
 * 自定义 Base64 字母表：ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5
 *
 * 使用方法：
 *   const { init, sign, generateHeaders } = require('./xys-sign-node');
 *   await init({ cookie: 'a1=xxx; web_session=xxx' });
 *   const headers = await generateHeaders('/api/sns/web/v1/feed', bodyObj);
 *   // → { 'X-s': 'XYS_eyJ...', 'X-t': '1783595...' }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRIPTS_DIR = __dirname;
const DS_FILE = path.join(SCRIPTS_DIR, 'ds.js');
const VENDOR_FILE = path.join(SCRIPTS_DIR, 'vendor-dynamic.js');

// vendor-dynamic.js 可能从 docs 目录复制，或从指定路径加载
const VENDOR_FILE_DOCS = path.join(SCRIPTS_DIR, '..', '..', 'docs', 'vendor-dynamic.8cd1891c.js');

const DS_URL = 'https://as.xiaohongshu.com/api/sec/v1/ds?appId=xhs-pc-web';

let _initialized = false;

// ======================= 浏览器环境模拟 =======================

function setupBrowserEnv(cookieStr) {
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.xsecappid = 'xhs-pc-web';
  globalThis.xsecplatform = 'PC';

  const cookie = cookieStr || 'a1=; web_session=; xsecappid=xhs-pc-web';

  // document mock（VM 内部可能访问 canvas 等用于指纹采集）
  globalThis.document = {
    cookie,
    createElement: (tag) => ({
      tagName: (tag || 'div').toUpperCase(),
      style: {},
      setAttribute() {}, getAttribute: () => null,
      appendChild() {}, removeChild() {}, addEventListener() {},
      getContext: (type) => {
        if (type === '2d') {
          return {
            fillRect() {}, clearRect() {}, getImageData: () => ({ data: [] }),
            fillText() {}, measureText: () => ({ width: 100 }),
            arc() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {},
          };
        }
        return null;
      },
      toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=',
      innerHTML: '', textContent: '',
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
    try {
      Object.defineProperty(globalThis, 'navigator', { value: navMock, writable: true, configurable: true });
    } catch {
      if (globalThis.navigator) Object.assign(globalThis.navigator, navMock);
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

  const { performance } = require('perf_hooks');
  try { globalThis.performance = performance; } catch {
    try { Object.defineProperty(globalThis, 'performance', { value: performance, writable: true, configurable: true }); } catch {}
  }

  // signSvn 配置
  const _store = new Map();
  _store.set('sdt_source_storage_key', JSON.stringify({
    signUrl: '',
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
  // chrome 对象（报告依赖数组索引 23，Node.js 中为 undefined）
  globalThis.chrome = undefined;
  globalThis.InstallTrigger = undefined;
  // Event 类（依赖数组索引 24）
  class Event { constructor(t) { this.type = t; } }
  globalThis.Event = Event;
}

// ======================= 脚本下载 =======================

const https = require('https');

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

async function ensureDsFile() {
  if (fs.existsSync(DS_FILE)) {
    return fs.readFileSync(DS_FILE, 'utf8');
  }
  console.log('[xys-sign] 下载 ds.js...');
  const code = await downloadFile(DS_URL);
  fs.writeFileSync(DS_FILE, code);
  console.log(`[xys-sign] ds.js 已保存 (${code.length} 字符)`);
  return code;
}

function ensureVendorFile() {
  // 优先从 scripts 目录找
  if (fs.existsSync(VENDOR_FILE)) {
    return fs.readFileSync(VENDOR_FILE, 'utf8');
  }
  // 其次从 docs 目录找
  if (fs.existsSync(VENDOR_FILE_DOCS)) {
    console.log('[xys-sign] 从 docs 目录复制 vendor-dynamic.js');
    const code = fs.readFileSync(VENDOR_FILE_DOCS, 'utf8');
    fs.writeFileSync(VENDOR_FILE, code);
    return code;
  }
  throw new Error('vendor-dynamic.js 未找到，请放在 scripts/xhs-collection/ 或 docs/ 目录');
}

// ======================= XYS_ 核心算法 =======================

const CUSTOM_B64_ALPHABET = 'ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5';
const B64_LOOKUP = new Array(256);
for (let i = 0; i < CUSTOM_B64_ALPHABET.length; i++) {
  B64_LOOKUP[i] = CUSTOM_B64_ALPHABET[i];
}

function encodeUtf8(str) {
  const encoded = encodeURIComponent(str);
  const result = [];
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded.charAt(i);
    if (ch === '%') {
      result.push(parseInt(encoded.charAt(i + 1) + encoded.charAt(i + 2), 16));
      i += 2;
    } else {
      result.push(ch.charCodeAt(0));
    }
  }
  return result;
}

function customBase64Encode(bytes) {
  const len = bytes.length;
  const remainder = len % 3;
  const result = [];
  for (let i = 0; i < len - remainder; i += 3) {
    const triplet = (bytes[i] << 16 & 0xff0000) + (bytes[i + 1] << 8 & 65280) + (255 & bytes[i + 2]);
    result.push(
      B64_LOOKUP[triplet >> 18 & 63] +
      B64_LOOKUP[triplet >> 12 & 63] +
      B64_LOOKUP[triplet >> 6 & 63] +
      B64_LOOKUP[triplet & 63]
    );
  }
  if (remainder === 1) {
    const a = bytes[len - 1];
    result.push(B64_LOOKUP[a >> 2] + B64_LOOKUP[a << 4 & 63] + '==');
  } else if (remainder === 2) {
    const a = (bytes[len - 2] << 8) + bytes[len - 1];
    result.push(B64_LOOKUP[a >> 10] + B64_LOOKUP[a >> 4 & 63] + B64_LOOKUP[a << 2 & 63] + '=');
  }
  return result.join('');
}

function md5Hex(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

/**
 * seccore_signv2 — XYS_ 签名生成
 */
async function seccoreSignV2(apiPath, body) {
  if (!_initialized) throw new Error('未初始化，请先调用 init()');
  if (typeof globalThis.mnsv2 !== 'function') throw new Error('window.mnsv2 不可用');

  let c = apiPath;
  if (body !== null && body !== undefined) {
    if (typeof body === 'object') c += JSON.stringify(body);
    else if (typeof body === 'string') c += body;
  }

  const u = md5Hex(c);
  const p = md5Hex(apiPath);

  const v = globalThis.mnsv2(c, u, p);
  if (!v) throw new Error('mnsv2 返回空值');

  const S = {
    x0: '4.3.7',
    x1: 'xhs-pc-web',
    x2: 'Windows',
    x3: v,
    x4: body ? typeof body : '',
  };

  const jsonStr = JSON.stringify(S);
  const utf8Bytes = encodeUtf8(jsonStr);
  const b64 = customBase64Encode(utf8Bytes);

  return {
    'X-s': 'XYS_' + b64,
    'X-t': String(Date.now()),
  };
}

// ======================= Webpack Runtime =======================

const webpackModules = {};
const webpackCache = {};

function webpackRequire(moduleId) {
  const id = String(moduleId);
  if (webpackCache[id]) return webpackCache[id].exports;
  const module = webpackCache[id] = { id, exports: {} };
  if (webpackModules[id]) {
    webpackModules[id].call(module.exports, module, module.exports, webpackRequire);
  }
  // 缺失模块（core-js polyfill 等）返回空对象，不报错
  return module.exports;
}
webpackRequire.r = function(e) {
  if (typeof Symbol !== 'undefined' && Symbol.toStringTag) Object.defineProperty(e, Symbol.toStringTag, { value: 'Module' });
  Object.defineProperty(e, '__esModule', { value: true });
};
webpackRequire.d = function(e, d) {
  for (const k in d) {
    if (Object.prototype.hasOwnProperty.call(d, k) && !Object.prototype.hasOwnProperty.call(e, k)) {
      Object.defineProperty(e, k, { enumerable: true, get: d[k] });
    }
  }
};
webpackRequire.o = function(o, p) { return Object.prototype.hasOwnProperty.call(o, p); };
webpackRequire.n = function(m) {
  const g = m && m.__esModule ? function() { return m.default; } : function() { return m; };
  webpackRequire.d(g, { a: g });
  return g;
};
webpackRequire.t = function(v, m) {
  if (m & 1) v = webpackRequire(v);
  if (m & 8) return v;
  if (m & 4 && typeof v === 'object' && v && v.__esModule) return v;
  const ns = Object.create(null);
  webpackRequire.r(ns);
  Object.defineProperty(ns, 'default', { enumerable: true, value: v });
  if (m & 2 && typeof v !== 'string') {
    for (const k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k)) {
        const d = m & 4 && Object.getOwnPropertyDescriptor(v, k);
        if (d) Object.defineProperty(ns, k, d);
        else ns[k] = v[k];
      }
    }
  }
  return ns;
};
webpackRequire.s = '9035';

// ======================= 初始化 =======================

/**
 * 初始化 XYS_ 签名环境
 *
 * 流程：
 *   1. 设置浏览器环境 mock
 *   2. 加载 ds.js（建立 _BHjFmfUMEtxhI 编译器基础）
 *   3. 加载 vendor-dynamic.js（webpack chunk，124 个模块）
 *   4. 执行模块 68316（577KB，包含 _AUuXfEG27Xa3x 编译器 + 233081 hex 字节码）
 *   5. 调用 signV2Init()（模块 68316 的导出函数 a）→ 注册 mnsv2 全局函数
 *
 * @param {Object} options
 * @param {string} options.cookie - Cookie 字符串
 */
async function init(options = {}) {
  if (_initialized) return true;

  const { cookie } = options;

  // 设置浏览器环境
  setupBrowserEnv(cookie);

  // Step 1: 加载 ds.js
  const dsCode = await ensureDsFile();
  try {
    eval(dsCode);
    console.log('[xys-sign] ds.js 加载完成');
  } catch (e) {
    console.warn(`[xys-sign] ds.js 加载警告: ${e.message}`);
  }

  // Step 2: 加载 vendor-dynamic.js（webpack chunk 格式）
  const vendorCode = ensureVendorFile();
  if (!globalThis.webpackChunkxhs_pc_web) globalThis.webpackChunkxhs_pc_web = [];
  globalThis.webpackChunkxhs_pc_web.push = function(chunk) {
    const [chunkIds, modules] = chunk;
    for (const [id, fn] of Object.entries(modules)) { webpackModules[id] = fn; }
    return chunkIds.length;
  };
  try {
    eval(vendorCode);
    console.log(`[xys-sign] vendor-dynamic.js 加载完成 (${Object.keys(webpackModules).length} 模块)`);
  } catch (e) {
    console.warn(`[xys-sign] vendor-dynamic.js 加载警告: ${e.message}`);
  }

  // Step 3: 执行模块 68316（包含 _AUuXfEG27Xa3x 编译器 + 233081 hex 字节码）
  // 该模块导出 signV2Init 函数（导出名 'a'），但不会自动调用
  let signV2Init;
  try {
    const mod = webpackRequire('68316');
    signV2Init = mod.a || mod.signV2Init || mod.default;
    console.log('[xys-sign] 模块 68316 执行完成, signV2Init:', typeof signV2Init);
  } catch (e) {
    console.warn(`[xys-sign] 模块 68316 执行警告: ${e.message}`);
  }

  // Step 4: 调用 signV2Init() 注册 mnsv2
  if (typeof signV2Init === 'function') {
    try {
      signV2Init();
      console.log('[xys-sign] signV2Init() 调用完成');
    } catch (e) {
      console.warn(`[xys-sign] signV2Init() 警告: ${e.message}`);
    }
  }

  // 验证 mnsv2
  if (typeof globalThis.mnsv2 !== 'function') {
    const fns = Object.getOwnPropertyNames(globalThis).filter(k => typeof globalThis[k] === 'function' && k.startsWith('_'));
    throw new Error(`mnsv2 不可用。已注册的 _ 函数: ${fns.join(', ') || '（无）'}`);
  }

  _initialized = true;
  console.log('[xys-sign] 初始化成功 (mnsv2 已就绪，纯 Node.js 模式)');
  return true;
}

// ======================= 对外接口 =======================

async function sign(apiPath, body) {
  return seccoreSignV2(apiPath, body);
}

async function generateHeaders(apiPath, body) {
  return sign(apiPath, body);
}

module.exports = {
  init,
  sign,
  generateHeaders,
  seccoreSignV2,
  customBase64Encode,
  encodeUtf8,
  md5Hex,
};
