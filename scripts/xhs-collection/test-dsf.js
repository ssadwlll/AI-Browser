/**
 * 检查 _dsf 函数的内部结构
 */

'use strict';

const fs = require('fs');
const path = require('path');

console.log('=== 检查 _dsf 函数结构 ===\n');

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

// 获取 _dsf 函数
const _dsf = globalThis._dsf || globalThis._BHjFmfUMEtxhI;

console.log('[Step 1] 检查 _dsf 函数...');
console.log('  typeof _dsf:', typeof _dsf);

// 列出 _dsf 的所有属性
console.log('\n[Step 2] _dsf 的自有属性:');
const props = Object.getOwnPropertyNames(_dsf);
console.log('  ', props);

// 尝试不同的希腊字母属性名
console.log('\n[Step 3] 检查希腊字母属性名:');
const greekLetters = {
  'ΙΙΙ': '\u0399\u0399\u0399',      // 三个希腊 Iota
  'ΙIΙ': '\u0399\u0049\u0399',      // 希腊I + 普通I + 希腊I
  'ΙII': '\u0399\u0049\u0049',      // 希腊I + 两个普通I
  'IIΙ': '\u0049\u0049\u0399',      // 两个普通I + 希腊I
  'IΙΙ': '\u0049\u0399\u0399',      // 普通I + 两个希腊I
  'III': 'III',                      // 三个普通I
  '螜II': '螜II',                    // 特殊字符
};

for (const [name, code] of Object.entries(greekLetters)) {
  try {
    const val = _dsf[code];
    if (val !== undefined) {
      console.log(`  ${name} (${code}): ${typeof val}`);
      if (typeof val === 'function') {
        console.log(`    尝试调用...`);
        try {
          const result = val('/api/sns/web/v1/search/notes');
          if (typeof result === 'string' && result.length > 50) {
            console.log(`    ✓ 成功! 结果: ${result.substring(0, 100)}`);
            globalThis.mnsv2 = val;
          }
        } catch (e) {
          console.log(`    调用失败: ${e.message}`);
        }
      }
    }
  } catch {}
}

// 检查 _dsf 是否有其他特殊属性
console.log('\n[Step 4] 检查 _dsf 的所有属性值类型:');
for (const prop of props) {
  const val = _dsf[prop];
  const type = typeof val;
  const info = type === 'function' ? `function (${val.length} args)` :
               type === 'object' ? `object (${Array.isArray(val) ? 'array' : 'object'})` :
               type === 'string' ? `string (${val.length} chars)` :
               type === 'number' ? `number (${val})` :
               type;
  console.log(`  ${prop}: ${info}`);
  
  // 如果是对象，深入检查
  if (type === 'object' && val !== null) {
    const subProps = Object.keys(val).slice(0, 5);
    if (subProps.length > 0) {
      console.log(`    子属性: ${subProps.join(', ')}`);
    }
  }
}

// 尝试直接调用 _dsf
console.log('\n[Step 5] 直接调用 _dsf...');
try {
  const result = _dsf('/api/sns/web/v1/search/notes');
  console.log('  返回类型:', typeof result);
  if (result) {
    console.log('  返回值:', result);
    if (typeof result === 'object') {
      console.log('  对象键:', Object.keys(result));
    }
  }
} catch (e) {
  console.log('  调用失败:', e.message);
}

// 检查全局对象上是否有 mnsv2
console.log('\n[Step 6] 在全局对象上搜索签名函数...');
for (const key of Object.keys(globalThis)) {
  if (key.toLowerCase().includes('mns') || key.toLowerCase().includes('sign')) {
    console.log(`  找到: ${key} = ${typeof globalThis[key]}`);
  }
}

console.log('\n=== 测试完成 ===');
if (globalThis.mnsv2) {
  console.log('✓ mnsv2 已就绪');
} else {
  console.log('✗ mnsv2 未找到，可能需要 vm.js 补充');
}