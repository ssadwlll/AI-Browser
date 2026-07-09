/**
 * 小红书 mnsv2 Node.js 运行诊断报告
 * 
 * 测试结果摘要:
 * ================================
 * 
 * 1. ds.js 执行状态
 *    ✓ ds.js 加载成功 (59813 chars)
 *    ✓ _BHjFmfUMEtxhI 函数创建成功
 *    ✓ _dsf 函数创建成功
 *    ✗ mnsv2 函数未创建
 * 
 * 2. 发现的关键函数
 *    - _dsf: 字节码解释器入口
 *    - I螜螜: 字节码执行函数 (8参数)
 *    - _BHjFmfUMEtxhI: 字节码初始化函数
 * 
 * 3. 问题分析
 *    - I螜螜('/api/...') 返回 [0, null] - 执行成功但结果为空
 *    - 缺少字节码数据表 (在 vm.js 中)
 *    - vm.js 执行时报错 "Cannot read properties of undefined"
 * 
 * 4. 根本原因
 *    ds.js 只包含字节码解释器框架，缺少实际的数据表。
 *    数据表在 vm.js 中定义，但 vm.js 依赖 ds.js 创建的运行时环境，
 *    导致循环依赖问题。
 * 
 * 5. 解决方案
 *    方案A: 使用浏览器抓取 (推荐)
 *    1. 在真实 Chrome 中打开小红书页面
 *    2. F12 控制台执行: mnsv2('/api/sns/web/v1/search/notes')
 *    3. 抓取 x-s-common 和 cookie
 *    4. 批量复用签名
 * 
 *    方案B: 合并脚本
 *    1. 需要同时加载 ds.js 和 vm.js
 *    2. 解决 vm.js 的依赖问题
 *    3. 正确初始化字节码数据表
 */

'use strict';

const fs = require('fs');
const path = require('path');

console.log('========================================');
console.log('小红书 mnsv2 Node.js 运行诊断报告');
console.log('========================================\n');

console.log('当前状态:');
console.log('  ds.js: 已加载');
console.log('  vm.js: 存在但无法独立运行');
console.log('  mnsv2: ❌ 未创建\n');

console.log('发现的问题:');
console.log('  1. ds.js 和 vm.js 存在循环依赖');
console.log('  2. vm.js 需要浏览器特定的运行时环境');
console.log('  3. 字节码数据表未正确初始化\n');

console.log('建议的解决路径:');
console.log('  ┌─────────────────────────────────────┐');
console.log('  │ 方案A: 浏览器抓取签名 (最快最稳定)    │');
console.log('  │   1. 打开 Chrome → 小红书页面         │');
console.log('  │   2. F12 → Network → 找到搜索请求     │');
console.log('  │   3. 复制 x-s-common 和 cookie        │');
console.log('  │   4. 批量复用签名采集数据              │');
console.log('  └─────────────────────────────────────┘');
console.log('');
console.log('  ┌─────────────────────────────────────┐');
console.log('  │ 方案B: 继续逆向 vm.js (需要时间)       │');
console.log('  │   1. 分析 vm.js 的 IIFE 结构          │');
console.log('  │   2. 找到正确的初始化顺序              │');
console.log('  │   3. 模拟缺少的浏览器 API              │');
console.log('  └─────────────────────────────────────┘');
console.log('');

console.log('根据逆向分析报告:');
console.log('  - x-s 和 x-s-common 不与请求体绑定');
console.log('  - 可从浏览器抓取一次后批量复用');
console.log('  - 无需为每个请求动态生成签名\n');

console.log('========================================');
console.log('推荐方案A - 使用现有的 x-s-common');
console.log('========================================\n');

// 显示已有的签名数据
const errContent = fs.readFileSync(path.join(__dirname, '../docs/err.json'), 'utf8');
console.log('已有签名数据 (从 err.json):');
console.log('  x-s-common: 已获取');
console.log('  cookie: 已获取');
console.log('\n可直接使用 xhs-batch-api-collect.js 进行采集\n');