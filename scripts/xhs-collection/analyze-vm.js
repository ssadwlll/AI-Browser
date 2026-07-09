/**
 * 分析 vm.js 的开头和结尾结构
 */

'use strict';

const fs = require('path');

const vmCode = require('fs').readFileSync(require('path').join(__dirname, 'vm.js'), 'utf8');

// 提取开头 500 字符
console.log('=== VM.JS 开头 (500 chars) ===');
console.log(vmCode.substring(0, 500));

// 提取结尾 500 字符
console.log('\n=== VM.JS 结尾 (500 chars) ===');
console.log(vmCode.substring(vmCode.length - 500));

// 查找 IIFE 模式的参数
const iifeMatch = vmCode.match(/^\(function\(([^)]*)\)/);
if (iifeMatch) {
  console.log('\n=== IIFE 参数 ===');
  console.log('参数列表:', iifeMatch[1]);
  const params = iifeMatch[1].split(',').map(p => p.trim());
  console.log('参数数量:', params.length);
  console.log('参数:', params);
}

// 查找 IIFE 的调用参数
const callMatch = vmCode.match(/\)\(([^)]+)\)\s*$/);
if (callMatch) {
  console.log('\n=== IIFE 调用参数 ===');
  console.log('调用参数:', callMatch[1].substring(0, 200));
}

// 查找所有的全局变量赋值
const globalAssigns = vmCode.match(/window\[[^\]]+\]\s*=/g);
console.log('\n=== window 赋值 ===');
console.log(globalAssigns?.slice(0, 10) || 'none');