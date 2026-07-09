/**
 * 分析 vm.js 的结构
 */

'use strict';

const fs = require('fs');
const path = require('path');

const vmCode = fs.readFileSync(path.join(__dirname, 'vm.js'), 'utf8');
console.log('vm.js size:', vmCode.length);

// vm.js 是一个压缩的单行文件，尝试解析它的结构
// 找到所有的全局变量引用

// 查找常见的全局对象引用
const globalRefs = [
  'window', 'document', 'navigator', 'location', 'performance',
  'localStorage', 'sessionStorage', 'screen', 'history',
  'addEventListener', 'removeEventListener', 'dispatchEvent',
  'XMLHttpRequest', 'fetch', 'WebSocket',
  'atob', 'btoa', 'crypto',
  'Uint8Array', 'ArrayBuffer', 'DataView',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'Promise', 'Symbol', 'Proxy', 'Reflect',
  'mnsv2', 'glb', '_BHjFmfUMEtxhI'
];

console.log('\n[Analysis] Checking global references in vm.js...');
globalRefs.forEach(ref => {
  const count = (vmCode.match(new RegExp(`\\b${ref}\\b`, 'g')) || []).length;
  if (count > 0) {
    console.log(`  ${ref}: ${count} references`);
  }
});

// 查找可能的 apply 调用
const applyMatches = vmCode.match(/\['apply'\]|\["apply"\]|\.apply\(/g);
console.log('\n[Analysis] apply references:', applyMatches?.length || 0);

// 尝试找到错误发生的位置 (around position 232179)
const errorPos = 232179;
const contextStart = Math.max(0, errorPos - 100);
const contextEnd = Math.min(vmCode.length, errorPos + 100);
console.log(`\n[Analysis] Context around error position (${errorPos}):`);
console.log(vmCode.substring(contextStart, contextEnd));

// 查找可能的函数定义
const functionDefs = vmCode.match(/function\s+\w+\s*\(/g);
console.log('\n[Analysis] Function definitions:', functionDefs?.slice(0, 10));

// 查找 IIFE 模式
const iifeMatch = vmCode.match(/\(function\s*\(/);
console.log('\n[Analysis] IIFE pattern:', iifeMatch ? 'found' : 'not found');

// 查找 module.exports 或 exports
const exportMatch = vmCode.match(/module\.exports|exports\[/);
console.log('[Analysis] CommonJS export:', exportMatch ? 'found' : 'not found');