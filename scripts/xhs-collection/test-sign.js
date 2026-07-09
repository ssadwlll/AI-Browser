/**
 * 测试 I螜螜 函数
 */

'use strict';

const fs = require('fs');
const path = require('path');

console.log('=== 测试签名函数 ===\n');

// 设置环境
const setupBrowserEnv = () => {
  const defineGlobal = (key, value) => {
    try { globalThis[key] = value; }
    catch { Object.defineProperty(globalThis, key, { value, writable: true, configurable: true }); }
  };
  defineGlobal('window', globalThis);
  defineGlobal('self', globalThis);
  defineGlobal('document', { cookie: '', createElement: () => ({}), getElementsByTagName: () => [], head: {}, body: {}, addEventListener() {}, removeEventListener() {} });
  defineGlobal('navigator', { userAgent: 'Mozilla/5.0', platform: 'Win32', language: 'zh-CN' });
  defineGlobal('location', { href: 'https://www.xiaohongshu.com/', origin: 'https://www.xiaohongshu.com' });
  defineGlobal('performance', { now: () => Date.now() });
  defineGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  defineGlobal('addEventListener', () => {});
  defineGlobal('removeEventListener', () => {});
  defineGlobal('fetch', () => Promise.resolve(new Response('{}')));
};
setupBrowserEnv();

// 执行 ds.js
const dsCode = fs.readFileSync(path.join(__dirname, 'ds.js'), 'utf8');
(0, eval)(dsCode);

const _dsf = globalThis._dsf;

// 测试 I螜螜 函数
console.log('[Step 1] 测试 I螜螜 函数...');
const signFunc = _dsf['I\u0399\u0399'];  // I螜螜
console.log('  typeof signFunc:', typeof signFunc);

if (typeof signFunc === 'function') {
  console.log('  函数签名:', signFunc.toString().substring(0, 200));
  
  // 尝试不同的调用方式
  console.log('\n[Step 2] 尝试调用...');
  
  // 方式1: 单参数
  try {
    const testInput = '/api/sns/web/v1/search/notes';
    console.log(`  方式1: signFunc("${testInput}")`);
    const result = signFunc(testInput);
    console.log('    结果类型:', typeof result);
    if (typeof result === 'string') {
      console.log('    结果:', result.substring(0, 100));
      if (result.includes('mns')) {
        console.log('    ✓✓✓ 找到签名函数!');
        globalThis.mnsv2 = signFunc;
      }
    } else if (typeof result === 'object') {
      console.log('    结果:', result);
    }
  } catch (e) {
    console.log('    失败:', e.message);
  }
  
  // 方式2: 多参数
  try {
    console.log(`  方式2: signFunc(apiPath, body, ...)`);
    const result = signFunc('/api/sns/web/v1/search/notes', '{}', '', '', '', '', '', '');
    console.log('    结果类型:', typeof result);
    if (typeof result === 'string' && result.length > 50) {
      console.log('    结果:', result.substring(0, 100));
      globalThis.mnsv2 = signFunc;
    }
  } catch (e) {
    console.log('    失败:', e.message);
  }
  
  // 方式3: 检查函数返回值是否有其他属性
  try {
    const result = signFunc('/api/sns/web/v1/search/notes');
    if (result && typeof result === 'object') {
      console.log('\n[Step 3] 检查返回对象的属性...');
      for (const key of Object.keys(result)) {
        console.log(`  ${key}: ${typeof result[key]}`);
      }
    }
  } catch {}
}

// 测试直接调用 _dsf 并传入正确参数
console.log('\n[Step 4] 测试 _dsf 不同参数...');
try {
  // mnsv2 原始签名：mnsv2(apiPath)
  const result = _dsf('/api/sns/web/v1/search/notes');
  console.log('  _dsf(apiPath) 结果类型:', typeof result);
  
  if (typeof result === 'object' && result instanceof Uint8Array) {
    console.log('  Uint8Array 长度:', result.length);
    console.log('  Uint8Array 内容:', result);
    
    // 尝试转换为字符串
    const str = String.fromCharCode.apply(null, result);
    console.log('  转换为字符串:', str.substring(0, 50));
  }
} catch (e) {
  console.log('  失败:', e.message);
}

// 检查全局对象上是否有 mns 相关
console.log('\n[Step 5] 搜索全局 mns...');
for (const key of Object.getOwnPropertyNames(globalThis)) {
  if (key.includes('mns') || key.includes('sign') || key.includes('\u0399')) {
    console.log(`  ${key}: ${typeof globalThis[key]}`);
  }
}

console.log('\n=== 测试完成 ===');
if (globalThis.mnsv2) {
  console.log('✓ mnsv2 已就绪');
  console.log('测试:', globalThis.mnsv2('/api/sns/web/v1/search/notes'));
}