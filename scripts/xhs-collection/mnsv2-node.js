/**
 * 小红书 mnsv2 签名函数 - Node.js 独立运行脚本
 *
 * 使用方法:
 *   1. 从浏览器 Network 面板复制两个脚本:
 *      - ds 脚本: https://as.xiaohongshu.com/api/sec/v1/ds?appId=xhs-pc-web
 *      - VM 脚本: https://fe-static.xhscdn.com/as/v1/3e44/public/a9ef723c54cfdb63556bffe75cf06ae7.js
 *   2. 保存为 ds.js 和 vm.js（放在同目录下）
 *   3. 运行: node mnsv2-node.js
 *   4. 作为模块使用: const { mnsv2 } = require('./mnsv2-node');
 */

'use strict';

// ======================= 浏览器环境模拟 =======================
(function setupBrowserEnv() {
  // Node.js v24+ 中 globalThis 的某些属性是只读的，需要用 defineProperty
  const defineGlobal = (key, value, writable = false) => {
    try {
      globalThis[key] = value;
    } catch {
      Object.defineProperty(globalThis, key, { value, writable, configurable: true });
    }
  };

  if (typeof globalThis.window === 'undefined') {
    defineGlobal('window', globalThis);
  }
  defineGlobal('self', globalThis);

  defineGlobal('document', {
    cookie: '',
    createElement: () => ({}),
    getElementsByTagName: () => [],
    head: { appendChild() {}, removeChild() {} },
    body: { appendChild() {}, removeChild() {} },
    documentElement: { style: {}, getAttribute: () => '' },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    createEvent: () => ({ initEvent() {} }),
    hidden: false, visibilityState: 'visible',
    referrer: '', title: '', URL: 'https://www.xiaohongshu.com/',
  });

  defineGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    platform: 'Win32', language: 'zh-CN', languages: ['zh-CN', 'zh'],
    cookieEnabled: true, hardwareConcurrency: 8, maxTouchPoints: 0,
    vendor: 'Google Inc.', webdriver: false,
    appName: 'Netscape', product: 'Gecko', appVersion: '5.0',
  });

  defineGlobal('location', {
    href: 'https://www.xiaohongshu.com/explore',
    protocol: 'https:', host: 'www.xiaohongshu.com',
    hostname: 'www.xiaohongshu.com', port: '',
    pathname: '/explore', search: '', hash: '',
    origin: 'https://www.xiaohongshu.com', ancestorOrigins: [],
  });

  const startTime = Date.now();
  defineGlobal('performance', {
    now: () => Date.now() - startTime,
    timing: { navigationStart: startTime - 100 },
    getEntriesByType: () => [], mark: () => {}, measure: () => {},
  });

  const _store = new Map();
  const storageMock = {
    getItem: (k) => _store.get(String(k)) ?? null,
    setItem: (k, v) => { _store.set(String(k), String(v)); },
    removeItem: (k) => { _store.delete(String(k)); },
    clear: () => { _store.clear(); },
    get length() { return _store.size; },
    key: (i) => [..._store.keys()][i] || null,
  };
  defineGlobal('localStorage', storageMock);
  defineGlobal('sessionStorage', { ...storageMock, _store: new Map() });

  defineGlobal('addEventListener', () => {});
  defineGlobal('removeEventListener', () => {});
  defineGlobal('dispatchEvent', () => true);

  defineGlobal('screen', { width: 1920, height: 1080, colorDepth: 24 });
  defineGlobal('history', { pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} });
  if (!globalThis.CSS) defineGlobal('CSS', { escape: (v) => v, supports: () => false });
  defineGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));

  // 确保 Reflect 存在（Node.js 原生支持，但确保兼容性）
  if (typeof globalThis.Reflect === 'undefined') {
    defineGlobal('Reflect', {
      apply: Function.prototype.apply.bind,
      construct: function(target, args) { return new target(...args); },
      get: function(obj, key) { return obj[key]; },
      set: function(obj, key, val) { obj[key] = val; return true; },
      has: function(obj, key) { return key in obj; },
      ownKeys: function(obj) { return Object.getOwnPropertyNames(obj); },
    });
  }
})();

// ======================= 加载脚本 =======================
const fs = require('fs');
const path = require('path');

function loadScripts(dsPath, vmPath) {
  const dsScript = fs.readFileSync(dsPath, 'utf8');
  const vmScript = fs.readFileSync(vmPath, 'utf8');

  console.log('[mnsv2] Loading ds script: ' + dsScript.length + ' chars');
  console.log('[mnsv2] Loading vm script: ' + vmScript.length + ' chars');

  try {
    // 使用 new Function 在隔离作用域中执行，避免污染全局
    const runScript = (code, name) => {
      try {
        // 直接在当前上下文执行
        eval(code);
      } catch (err) {
        console.error(`[mnsv2] Error in ${name}:`, err.message);
        console.error('[mnsv2] Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
        throw err;
      }
    };

    runScript(dsScript, 'ds.js');
    runScript(vmScript, 'vm.js');

  } catch (err) {
    console.error('[mnsv2] Script execution failed:', err.message);
    throw err;
  }

  // 检查 mnsv2 是否注册成功
  if (typeof globalThis.mnsv2 !== 'function') {
    // 尝试查找 mnsv2 的其他可能位置
    const possibleLocations = [
      'window.mnsv2',
      'global.mnsv2',
      'globalThis.mnsv2',
      'self.mnsv2',
    ];
    for (const loc of possibleLocations) {
      try {
        const fn = eval(loc);
        if (typeof fn === 'function') {
          globalThis.mnsv2 = fn;
          console.log('[mnsv2] Found at:', loc);
          break;
        }
      } catch (e) {}
    }
  }

  if (typeof globalThis.mnsv2 !== 'function') {
    throw new Error('[mnsv2] Failed: mnsv2 not found after loading scripts. Check if ds.js and vm.js are correct.');
  }

  console.log('[mnsv2] Successfully initialized');
  return globalThis.mnsv2;
}

// ======================= CDN 动态加载（备选） =======================
async function loadFromCDN() {
  const https = require('https');
  const dsUrl = 'https://as.xiaohongshu.com/api/sec/v1/ds?appId=xhs-pc-web';
  const vmUrl = 'https://fe-static.xhscdn.com/as/v1/3e44/public/a9ef723c54cfdb63556bffe75cf06ae7.js';

  function fetchUrl(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': navigator.userAgent } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          https.get(res.headers.location, (r2) => {
            let data = '';
            r2.on('data', c => data += c);
            r2.on('end', () => resolve(data));
          }).on('error', reject);
          return;
        }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }

  const [dsScript, vmScript] = await Promise.all([fetchUrl(dsUrl), fetchUrl(vmUrl)]);

  // 保存到本地缓存
  try {
    fs.writeFileSync(path.join(__dirname, 'ds.js'), dsScript, 'utf8');
    fs.writeFileSync(path.join(__dirname, 'vm.js'), vmScript, 'utf8');
    console.log('[mnsv2] Scripts cached to local files');
  } catch (e) {
    console.warn('[mnsv2] Failed to cache scripts:', e.message);
  }

  eval(dsScript);
  eval(vmScript);
  return globalThis.mnsv2;
}

// ======================= 入口 =======================
let _mnsv2Ready = null;

Object.defineProperty(module.exports, 'mnsv2', {
  get() {
    if (_mnsv2Ready) return _mnsv2Ready;
    if (typeof globalThis.mnsv2 === 'function') {
      _mnsv2Ready = globalThis.mnsv2;
      return _mnsv2Ready;
    }
    throw new Error('mnsv2 not loaded. Call init() first.');
  },
  enumerable: true,
});

module.exports.init = async function init(options = {}) {
  const dsPath = options.dsPath || path.join(__dirname, 'ds.js');
  const vmPath = options.vmPath || path.join(__dirname, 'vm.js');

  if (fs.existsSync(dsPath) && fs.existsSync(vmPath)) {
    _mnsv2Ready = loadScripts(dsPath, vmPath);
  } else {
    console.log('[mnsv2] Local scripts not found, fetching from CDN...');
    _mnsv2Ready = await loadFromCDN();
  }
  return _mnsv2Ready;
};

// ======================= 完整签名生成（X-s + X-t） =======================
module.exports.generateXs = function generateXs(apiPath, bodyStr) {
  if (!_mnsv2Ready) throw new Error('mnsv2 not loaded. Call init() first.');

  // 自定义 Base64 字母表
  const CUSTOM_B64 = 'ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5';
  const STD_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const encodeMap = {};
  for (let i = 0; i < 64; i++) encodeMap[STD_B64[i]] = CUSTOM_B64[i];

  // 调用 mnsv2 生成签名核心
  // 注意：mnsv2 只接受 API 路径字符串，不是 (u, m, w) 三参数
  const fullPath = bodyStr ? apiPath : apiPath;
  const C = _mnsv2Ready(fullPath);

  // 构建 Payload
  const payload = JSON.stringify({
    x0: '4.3.7',
    x1: 'xhs-pc-web',
    x2: 'PC',
    x3: C,
    x4: bodyStr ? 'string' : '',
  });

  // UTF8 编码 → 标准 Base64 → 自定义 Base64
  const utf8bytes = new TextEncoder().encode(payload);
  const stdB64 = Buffer.from(utf8bytes).toString('base64');
  const customB64 = stdB64.split('').map(c => encodeMap[c] || c).join('');

  return {
    'X-s': 'XYS_' + customB64,
    'X-t': String(Date.now()),
  };
};

// 直接运行时自动初始化
if (require.main === module) {
  (async () => {
    try {
      const initFn = module.exports.init;
      const fn = await initFn({});
      const testInput = '/api/sns/web/v1/search/notes?keyword=test&page=1';
      const sig = fn(testInput);
      console.log('\n[mnsv2] Test OK:');
      console.log('  Input:  ' + testInput);
      console.log('  Output: ' + sig);
      console.log('  Length: ' + sig.length);

      // 测试完整签名生成
      const bodyStr = JSON.stringify({ keyword: '美食', page: 1, page_size: 20 });
      const xs = module.exports.generateXs('/api/sns/web/v1/search/notes', bodyStr);
      console.log('\n[generateXs] X-s:', xs['X-s'].substring(0, 80) + '...');
      console.log('[generateXs] X-t:', xs['X-t']);
    } catch (err) {
      console.error('[mnsv2] Error:', err.message);
      process.exit(1);
    }
  })();
}
