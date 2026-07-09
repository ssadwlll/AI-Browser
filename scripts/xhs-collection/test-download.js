/**
 * 从 CDN 下载最新 ds.js 并测试
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

console.log('=== 从 CDN 下载最新 ds.js ===\n');

// 下载函数
const download = (url) => {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
};

// 设置浏览器环境
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

(async () => {
  try {
    // 1. 下载 ds.js
    console.log('[Step 1] 下载 ds.js...');
    const dsUrl = 'https://as.xiaohongshu.com/api/sec/v1/ds?appId=xhs-pc-web';
    const dsCode = await download(dsUrl);
    console.log(`  ✓ 下载完成 (${dsCode.length} chars)\n`);
    
    // 保存到文件
    fs.writeFileSync(path.join(__dirname, 'ds-latest.js'), dsCode);
    console.log('  ✓ 已保存到 ds-latest.js\n');
    
    // 2. 设置环境
    console.log('[Step 2] 设置浏览器环境...');
    setupBrowserEnv();
    console.log('  ✓ 完成\n');
    
    // 3. 执行 ds.js
    console.log('[Step 3] 执行 ds.js...');
    (0, eval)(dsCode);
    console.log('  ✓ 执行成功\n');
    
    // 4. 检查结果
    console.log('[Step 4] 检查签名函数...');
    const glb = globalThis.glb;
    
    if (!glb) {
      console.log('  ✗ glb 对象不存在');
      process.exit(1);
    }
    
    // 列出所有函数
    const functions = Object.keys(glb).filter(k => typeof glb[k] === 'function');
    console.log('  glb 上的函数:', functions);
    
    // 检查是否有 mnsv2
    if (glb.mnsv2) {
      console.log('\n  ✓✓✓ 找到 mnsv2!');
      const result = glb.mnsv2('/api/sns/web/v1/search/notes');
      console.log('  测试结果:', result?.substring?.(0, 100));
    } else {
      console.log('\n  ✗ mnsv2 未创建');
      console.log('  检查是否有其他签名函数...');
      
      // 尝试调用每个函数
      for (const funcName of functions) {
        try {
          const result = glb[funcName]('/api/sns/web/v1/search/notes');
          if (typeof result === 'string' && result.length > 50 && result.includes('mns')) {
            console.log(`\n  ✓ 找到签名函数: ${funcName}`);
            console.log(`  结果: ${result.substring(0, 100)}`);
            globalThis.mnsv2 = glb[funcName];
            break;
          }
        } catch {}
      }
    }
    
    // 5. 下载 vm.js
    console.log('\n[Step 5] 下载 vm.js...');
    try {
      // vm.js URL 可能在 ds.js 中定义，尝试常见的 URL
      const vmUrls = [
        'https://fe-static.xhscdn.com/as/v1/3e44/public/a9ef723c54cfdb63556bffe75cf06ae7.js'
      ];
      
      for (const vmUrl of vmUrls) {
        try {
          const vmCode = await download(vmUrl);
          console.log(`  ✓ vm.js 下载完成 (${vmCode.length} chars)\n`);
          fs.writeFileSync(path.join(__dirname, 'vm-latest.js'), vmCode);
          
          // 尝试合并执行
          console.log('[Step 6] 合并执行 ds.js + vm.js...');
          try {
            (0, eval)(dsCode + '\n' + vmCode);
            console.log('  ✓ 执行成功');
            
            // 再次检查 mnsv2
            if (glb.mnsv2) {
              console.log('\n  ✓✓✓ mnsv2 已就绪!');
              const result = glb.mnsv2('/api/sns/web/v1/search/notes');
              console.log('  测试结果:', result);
            }
          } catch (err) {
            console.log('  ✗ 合并执行失败:', err.message);
          }
          break;
        } catch (err) {
          console.log(`  ✗ 下载失败: ${vmUrl}`);
        }
      }
    } catch (err) {
      console.log('  ✗ vm.js 下载失败:', err.message);
    }
    
  } catch (err) {
    console.error('错误:', err.message);
    process.exit(1);
  }
})();