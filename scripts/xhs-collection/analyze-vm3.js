/**
 * 查找 vm.js 的 IIFE 结尾调用参数
 */

'use strict';

const fs = require('fs');
const path = require('path');

const vmCode = fs.readFileSync(path.join(__dirname, 'vm.js'), 'utf8');

// vm.js 结尾是 }());
// 我们需要找到 IIFE 的开始和参数

// 查找最后的 }()) 部分
const lastPart = vmCode.substring(vmCode.length - 1000);
console.log('=== 结尾 1000 字符 ===');
console.log(lastPart);

// 查找 IIFE 的函数签名
// vm.js 开头是 function i(){...}，所以我们需要找到它的调用

// 尝试查找整个 IIFE 结构
// 可能是 function i(){...}() 格式

// 查找 function i( 的参数列表
const funcStart = vmCode.indexOf('function i(');
if (funcStart >= 0) {
  // 提取参数列表
  let depth = 0;
  let start = vmCode.indexOf('(', funcStart);
  let i = start;
  while (i < vmCode.length) {
    if (vmCode[i] === '(') depth++;
    else if (vmCode[i] === ')') {
      depth--;
      if (depth === 0) {
        console.log('\n=== function i 参数列表 ===');
        console.log(vmCode.substring(start, i + 1));
        break;
      }
    }
    i++;
  }
}

// 查找 IIFE 调用的参数 - 应该在结尾的 () 中
// 格式: }());
// 我们需要找到最后一个 } 后面的 ()

// 从结尾往前找
let pos = vmCode.length - 1;
while (pos > 0 && vmCode[pos] !== '(') pos--;
if (pos > 0) {
  // 找到了最后一个 (
  // 现在往前找匹配的 )
  let depth = 1;
  let endPos = pos + 1;
  while (endPos < vmCode.length && depth > 0) {
    if (vmCode[endPos] === '(') depth++;
    else if (vmCode[endPos] === ')') depth--;
    endPos++;
  }
  
  console.log('\n=== IIFE 调用参数 ===');
  console.log('位置:', pos, '-', endPos);
  console.log('内容:', vmCode.substring(pos, Math.min(endPos + 1, vmCode.length)));
}

// 检查整个文件是否是有效的 JavaScript
console.log('\n=== 尝试执行 vm.js ===');
try {
  // 使用 new Function 包装
  const wrapped = `(function(){ ${vmCode} })()`;
  console.log('包装后长度:', wrapped.length);
} catch (e) {
  console.error('语法错误:', e.message);
}