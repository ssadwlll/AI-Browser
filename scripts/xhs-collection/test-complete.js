/**
 * 完整测试 - 遍历所有函数查找签名
 */

'use strict';

const fs = require('fs');
const path = require('path');

console.log('=== 小红书 mnsv2 Node.js 测试 ===\n');

// 1. 设置浏览器环境
const setupBrowserEnv = () => {
  const defineGlobal = (key, value) => {
    try { globalThis[key] = value; }
    catch { Object.defineProperty(globalThis, key, { value, writable: true, configurable: true }); }
  };
  defineGlobal('window', globalThis);
  defineGlobal('self', globalThis);
  defineGlobal('document', { cookie: '', createElement: () => ({}), getElementsByTagName: () => [], head: {}, body: {}, documentElement: {}, addEventListener() {}, removeEventListener() {}, hidden: false });
  defineGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', platform: 'Win32', language: 'zh-CN' });
  defineGlobal('location', { href: 'https://www.xiaohongshu.com/', origin: 'https://www.xiaohongshu.com' });
  defineGlobal('performance', { now: () => Date.now() });
  defineGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  defineGlobal('addEventListener', () => {});
  defineGlobal('removeEventListener', () => {});
};
setupBrowserEnv();
console.log('[Step 1] 浏览器环境设置完成\n');

// 2. 加载并执行 ds.js
const dsCode = fs.readFileSync(path.join(__dirname, 'ds.js'), 'utf8');
(0, eval)(dsCode);
console.log('[Step 2] ds.js 执行完成\n');

const glb = globalThis.glb;

// 3. 遍历所有函数，尝试调用并检查返回值
console.log('[Step 3] 遍历所有函数查找签名...');
const testInput = '/api/sns/web/v1/search/notes';
let foundSignFunc = null;

for (const key of Object.keys(glb)) {
  const val = glb[key];
  if (typeof val !== 'function') continue;
  
  // 跳过明显的工具函数
  if (['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch', 'addEventListener', 'removeEventListener', 'queueMicrotask'].includes(key)) continue;
  
  try {
    // 尝试调用
    const result = val(testInput);
    
    // 检查返回值
    if (typeof result === 'string' && result.length > 100 && result.includes('mns')) {
      console.log(`\n  ✓✓✓ 找到签名函数: ${key}`);
      console.log(`    返回值: ${result.substring(0, 100)}`);
      foundSignFunc = val;
      globalThis.mnsv2 = val;
      break;
    }
    
    // 如果返回对象，检查对象上是否有函数
    if (typeof result === 'object' && result !== null) {
      for (const subKey of Object.keys(result)) {
        const subVal = result[subKey];
        if (typeof subVal === 'function') {
          try {
            const subResult = subVal(testInput);
            if (typeof subResult === 'string' && subResult.length > 100) {
              console.log(`\n  ✓✓✓ 找到签名函数: ${key}.${subKey}`);
              console.log(`    返回值: ${subResult.substring(0, 100)}`);
              foundSignFunc = subVal;
              globalThis.mnsv2 = subVal;
              break;
            }
          } catch {}
        }
      }
      if (foundSignFunc) break;
    }
  } catch {}
}

// 4. 检查希腊字母属性名
if (!foundSignFunc) {
  console.log('\n[Step 4] 检查特殊希腊字母属性名...');
  
  // 尝试不同的希腊字母组合
  const greekPatterns = [
    '\u0399\u0049\u0399',  // ΙIΙ (希腊I + 普通I + 希腊I)
    '\u0399\u0399\u0399',  // ΙΙΙ (三个希腊I)
    'III',                  // 三个普通I
    '\u0049\u0399\u0399',  // IΙΙ
    '\u0399\u0049\u0049',  // ΙII
  ];
  
  for (const pattern of greekPatterns) {
    if (glb[pattern]) {
      console.log(`  找到属性 "${pattern}":`, typeof glb[pattern]);
      if (typeof glb[pattern] === 'function') {
        try {
          const result = glb[pattern](testInput);
          if (typeof result === 'string' && result.length > 50) {
            console.log(`  ✓ 调用成功:`, result.substring(0, 100));
            foundSignFunc = glb[pattern];
            globalThis.mnsv2 = glb[pattern];
            break;
          }
        } catch (err) {
          console.log(`  ✗ 调用失败:`, err.message);
        }
      }
    }
  }
}

// 5. 最终检查
console.log('\n[Step 5] 最终结果...');
if (globalThis.mnsv2) {
  console.log('✓✓✓ mnsv2 已就绪 ✓✓✓');
  const result = globalThis.mnsv2('/api/sns/web/v1/search/notes');
  console.log('测试签名:', result);
} else {
  console.log('✗ mnsv2 未找到');
  console.log('\n分析: ds.js 执行后没有创建 mnsv2 函数');
  console.log('可能原因:');
  console.log('  1. ds.js 版本不完整或已过期');
  console.log('  2. 需要从浏览器实时抓取最新版本');
  console.log('  3. mnsv2 函数可能在其他脚本中定义');
}