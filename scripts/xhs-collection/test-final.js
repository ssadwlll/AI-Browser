/**
 * 完整测试 - 避免网络请求
 */

'use strict';

const fs = require('fs');
const path = require('path');

console.log('=== 小红书 mnsv2 Node.js 测试 ===\n');

// 1. 设置浏览器环境（禁用 fetch）
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
  // 禁用 fetch，避免网络请求
  defineGlobal('fetch', () => Promise.resolve(new Response('{}')));
};
setupBrowserEnv();
console.log('[Step 1] 浏览器环境设置完成\n');

// 2. 加载并执行 ds.js
const dsCode = fs.readFileSync(path.join(__dirname, 'ds.js'), 'utf8');
(0, eval)(dsCode);
console.log('[Step 2] ds.js 执行完成\n');

const glb = globalThis.glb;

// 3. 分析 glb 对象结构
console.log('[Step 3] 分析 glb 对象...');
console.log('  glb 类型:', typeof glb);
console.log('  glb 的自有属性:', Object.getOwnPropertyNames(glb).slice(0, 30));

// 检查是否有隐藏的属性（使用 Object.getOwnPropertyNames）
const allProps = Object.getOwnPropertyNames(glb);
console.log('\n  所有属性（包括不可枚举）:', allProps.length);

// 找出所有函数
const funcs = allProps.filter(k => typeof glb[k] === 'function');
console.log('  函数列表:', funcs);

// 4. 详细检查每个函数的 toString
console.log('\n[Step 4] 检查函数签名...');
for (const name of funcs) {
  const fn = glb[name];
  const str = fn.toString();
  
  // 跳过内置函数
  if (str.includes('[native') || str.length < 20) continue;
  
  // 检查是否包含签名相关关键词
  if (str.includes('mns') || str.includes('sign') || str.includes('xhs') || 
      str.includes(' Ι') || str.includes('ΙI') || str.includes('IIΙ')) {
    console.log(`\n  可疑函数: ${name}`);
    console.log(`    签名片段: ${str.substring(0, 100)}...`);
  }
}

// 5. 检查 _BHjFmfUMEtxhI 的返回值
console.log('\n[Step 5] 检查 _BHjFmfUMEtxhI...');
if (glb._BHjFmfUMEtxhI && glb.__$c) {
  try {
    const result = glb._BHjFmfUMEtxhI(glb.__$c, [undefined, undefined, Uint8Array, glb.getdss]);
    console.log('  返回值类型:', typeof result);
    if (result) {
      if (typeof result === 'function') {
        console.log('  返回的是函数！');
        globalThis.mnsv2 = result;
        console.log('  测试调用:', result('/api/sns/web/v1/search/notes')?.substring?.(0, 100));
      } else if (typeof result === 'object') {
        console.log('  返回对象的键:', Object.keys(result));
        // 检查对象上的函数
        for (const key of Object.keys(result)) {
          if (typeof result[key] === 'function') {
            console.log(`  对象上的函数: ${key}`);
            try {
              const r = result[key]('/api/sns/web/v1/search/notes');
              if (typeof r === 'string' && r.length > 50) {
                console.log(`    ✓ 找到签名函数: ${key}`);
                console.log(`    结果: ${r.substring(0, 100)}`);
                globalThis.mnsv2 = result[key];
              }
            } catch {}
          }
        }
      }
    }
  } catch (err) {
    console.log('  调用失败:', err.message);
  }
}

// 6. 最终检查
console.log('\n[Step 6] 最终结果...');
if (globalThis.mnsv2) {
  console.log('✓✓✓ mnsv2 已就绪 ✓✓✓');
  console.log('测试签名:', globalThis.mnsv2('/api/sns/web/v1/search/notes'));
} else {
  console.log('✗ mnsv2 未找到');
  console.log('\n建议:');
  console.log('  1. 检查 ds.js 是否是最新版本');
  console.log('  2. 可能需要 vm.js 补充数据');
  console.log('  3. mnsv2 可能使用了特殊的属性名（希腊字母）');
}