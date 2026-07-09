/**
 * 简化测试脚本 - 诊断 mnsv2 加载问题
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 设置浏览器环境模拟
const setupBrowserEnv = () => {
  const defineGlobal = (key, value) => {
    try {
      globalThis[key] = value;
    } catch {
      Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    }
  };

  defineGlobal('window', globalThis);
  defineGlobal('self', globalThis);
  defineGlobal('document', {
    cookie: '',
    createElement: () => ({}),
    getElementsByTagName: () => [],
    head: {},
    body: {},
    documentElement: {},
    addEventListener() {},
    removeEventListener() {},
    hidden: false,
    visibilityState: 'visible',
  });
  defineGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    platform: 'Win32',
    language: 'zh-CN',
    cookieEnabled: true,
    hardwareConcurrency: 8,
  });
  defineGlobal('location', {
    href: 'https://www.xiaohongshu.com/',
    origin: 'https://www.xiaohongshu.com',
  });
  defineGlobal('performance', {
    now: () => Date.now(),
  });
  defineGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  defineGlobal('addEventListener', () => {});
  defineGlobal('removeEventListener', () => {});
};

console.log('[Test] Setting up browser env...');
setupBrowserEnv();

// 检查全局对象
console.log('[Test] Checking global objects...');
console.log('  window:', typeof window);
console.log('  document:', typeof document);
console.log('  navigator:', typeof navigator);
console.log('  Uint8Array:', typeof Uint8Array);
console.log('  Reflect:', typeof Reflect);
console.log('  Reflect.apply:', typeof Reflect?.apply);

// 加载 ds.js
console.log('\n[Test] Loading ds.js...');
const dsPath = path.join(__dirname, 'ds.js');
const dsCode = fs.readFileSync(dsPath, 'utf8');
console.log('  ds.js size:', dsCode.length);

// 使用 new Function 在全局作用域执行
const globalEval = new Function('return this')();
const originalKeys = new Set(Object.keys(globalEval));

try {
  // 使用间接 eval 在全局作用域执行
  (0, eval)(dsCode);
  console.log('[Test] ds.js loaded successfully');
} catch (err) {
  console.error('[Test] ds.js error:', err.message);
  console.error(err.stack);
  process.exit(1);
}

// 检查新增的全局变量
const newKeys = Object.keys(globalEval).filter(k => !originalKeys.has(k));
console.log('\n[Test] New globals after ds.js:', newKeys);

// 检查 mnsv2 是否已创建
console.log('\n[Test] Checking mnsv2 after ds.js...');
console.log('  globalThis.mnsv2:', typeof globalThis.mnsv2);
console.log('  globalThis.glb:', typeof globalThis.glb);
if (globalThis.glb) {
  console.log('  glb keys:', Object.keys(globalThis.glb).slice(0, 20));
  if (globalThis.glb.mnsv2) {
    globalThis.mnsv2 = globalThis.glb.mnsv2;
    console.log('  mnsv2 copied to globalThis!');
  }
}

// 测试 mnsv2 函数
if (typeof globalThis.mnsv2 === 'function') {
  console.log('\n[Test] Testing mnsv2 function...');
  try {
    const result = globalThis.mnsv2('/api/sns/web/v1/search/notes');
    console.log('  result:', result?.substring?.(0, 100));
    console.log('  result length:', result?.length);
  } catch (err) {
    console.error('[Test] mnsv2 call error:', err.message);
    console.error(err.stack?.substring(0, 500));
  }
} else if (typeof globalThis.glb?.mnsv2 === 'function') {
  console.log('\n[Test] Testing glb.mnsv2 function...');
  try {
    const result = globalThis.glb.mnsv2('/api/sns/web/v1/search/notes');
    console.log('  result:', result?.substring?.(0, 100));
    console.log('  result length:', result?.length);
    globalThis.mnsv2 = globalThis.glb.mnsv2;
  } catch (err) {
    console.error('[Test] mnsv2 call error:', err.message);
    console.error(err.stack?.substring(0, 500));
  }
} else {
  console.log('\n[Test] mnsv2 not found, checking other possible locations...');
  // 检查 _dsf, _dsn, _dsl 等变量
  ['_dsf', '_dsn', '_dsl', '_BHjFmfUMEtxhI', '__bc'].forEach(key => {
    const val = globalThis[key];
    console.log(`  ${key}:`, typeof val, val?.constructor?.name || '');
  });
}

// 尝试加载 vm.js
console.log('\n[Test] Loading vm.js...');
const vmPath = path.join(__dirname, 'vm.js');
if (fs.existsSync(vmPath)) {
  const vmCode = fs.readFileSync(vmPath, 'utf8');
  console.log('  vm.js size:', vmCode.length);

  // 合并 ds.js 和 vm.js 后一起执行
  console.log('\n[Test] Trying combined execution...');
  try {
    // 创建一个合并的脚本，确保 vm.js 能访问 ds.js 的运行时
    const combinedCode = `
      // ds.js
      ${dsCode}
      
      // vm.js - 使用相同的全局作用域
      ${vmCode}
    `;
    (0, eval)(combinedCode);
    console.log('[Test] Combined execution successful');
  } catch (err) {
    console.error('[Test] Combined execution error:', err.message);
    console.error(err.stack?.substring(0, 500));
  }

  // 再次检查 mnsv2
  console.log('\n[Test] Checking after vm.js...');
  console.log('  globalThis.mnsv2:', typeof globalThis.mnsv2);
  console.log('  globalThis.glb:', typeof globalThis.glb);
  if (globalThis.glb) {
    console.log('  glb.mnsv2:', typeof globalThis.glb.mnsv2);
    if (globalThis.glb.mnsv2) {
      globalThis.mnsv2 = globalThis.glb.mnsv2;
      console.log('  mnsv2 copied to globalThis!');
    }
  }
} else {
  console.log('  vm.js not found, skipping');
}

console.log('\n[Test] Done');