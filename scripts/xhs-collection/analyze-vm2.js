/**
 * 分析 vm.js 的完整结构
 */

'use strict';

const fs = require('fs');
const path = require('path');

const vmCode = fs.readFileSync(path.join(__dirname, 'vm.js'), 'utf8');

// 检查开头是否有括号
console.log('=== 开头 10 字符 ===');
console.log(JSON.stringify(vmCode.substring(0, 10)));

// 检查是否是 (function...) 或 !function... 格式
const firstChars = vmCode.substring(0, 100);
console.log('\n=== 开头 100 字符 ===');
console.log(firstChars);

// 查找第一个完整函数
const funcMatch = vmCode.match(/^(\(function\s*\w*\s*\()/);
if (funcMatch) {
  console.log('\n=== IIFE 开头匹配 ===');
  console.log(funcMatch[0]);
}

// 检查 vm.js 的整体结构
console.log('\n=== 文件结构分析 ===');
console.log('总长度:', vmCode.length);
console.log('开头字符:', vmCode[0]);
console.log('结尾字符:', vmCode[vmCode.length - 1]);

// 查找所有顶级函数定义
const funcDefs = [];
let depth = 0;
let start = -1;
for (let i = 0; i < Math.min(vmCode.length, 5000); i++) {
  if (vmCode[i] === '{') {
    if (depth === 0 && start === -1) {
      // 找到函数体开始
    }
    depth++;
  } else if (vmCode[i] === '}') {
    depth--;
  }
}

// 检查是否有括号包装
if (vmCode[0] === '(' || vmCode[0] === '!') {
  console.log('可能是 IIFE 包装');
} else if (vmCode.startsWith('function')) {
  console.log('普通函数定义开头');
  
  // 查找 IIFE 结尾
  const iifeEnd = vmCode.lastIndexOf('}())');
  if (iifeEnd > 0) {
    console.log('找到 IIFE 结尾位置:', iifeEnd);
    // 检查结尾后的内容
    console.log('结尾后内容:', vmCode.substring(iifeEnd, iifeEnd + 50));
  }
}

// 查找错误位置附近的代码
const errorPos = 232185;
console.log('\n=== 错误位置附近代码 ===');
console.log('位置:', errorPos);
console.log('代码片段:', vmCode.substring(errorPos - 50, errorPos + 100));

// 查找 apply 调用
const applyPos = vmCode.indexOf('apply', errorPos - 100);
if (applyPos > 0) {
  console.log('\n=== apply 调用位置 ===');
  console.log('位置:', applyPos);
  console.log('上下文:', vmCode.substring(applyPos - 50, applyPos + 50));
}