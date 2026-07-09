/**
 * 小红书采集监控程序 - 实时统计采集情况
 *
 * 功能：
 *   - 实时监控 feed 目录下的 JSON 文件
 *   - 统计成功/失败数量和失败原因
 *   - 显示当前采集进度和预计剩余时间
 *
 * 使用方法：
 *   node monitor.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FEED_DIR = path.join(__dirname, 'data', 'feed');
const PROGRESS_FILE = path.join(FEED_DIR, 'feed_progress.json');

// ANSI 颜色代码
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
};

// 清屏并移动光标到顶部
function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

// 格式化时间
function formatTime(date) {
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

// 格式化持续时间（秒 → 时:分:秒）
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// 读取所有 feed 文件
function readAllFeedFiles() {
  const files = fs.readdirSync(FEED_DIR).filter(f => f.startsWith('feed_') && f.endsWith('.json') && f !== 'feed_progress.json');
  const results = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(FEED_DIR, file), 'utf8');
      const data = JSON.parse(content);
      results.push({ file, ...data });
    } catch (e) {
      // 忽略解析错误
    }
  }

  // 按关键词序号排序
  results.sort((a, b) => {
    const numA = parseInt(a.file.match(/feed_(\d+)/)?.[1] || '0');
    const numB = parseInt(b.file.match(/feed_(\d+)/)?.[1] || '0');
    return numA - numB;
  });

  return results;
}

// 错误码映射
const ERROR_CODES = {
  '-100': '⛔ Cookie被标记',
  '-998': '❌ 网络请求失败',
  '-997': '⏱️ 请求超时',
  '-999': '❌ JSON解析错误',
  '300011': '🔐 签名校验失败',
  '300012': '⏰ 签名已过期',
  '300013': '🚦 请求频率限制',
  '300031': '📄 笔记不存在',
  '-510000': '📄 笔记已下架',
};

// 统计失败原因
function analyzeFailures(feedData) {
  const failures = {};

  for (const data of feedData) {
    // 从 details 中检查是否有失败的笔记（通过对比 totalNotes 和 successCount）
    const failCount = (data.totalNotes || 0) - (data.successCount || 0);
    if (failCount > 0) {
      // 统计该关键词的失败数
      const key = `关键词 "${data.keyword}"`;
      if (!failures[key]) {
        failures[key] = { count: 0, codes: {} };
      }
      failures[key].count += failCount;
    }
  }

  return failures;
}

// 主监控循环
let lastFileCount = 0;
let startTime = Date.now();

function monitor() {
  clearScreen();

  console.log(`${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║          小红书采集监控 - ${formatTime(new Date())}                   ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════════════╝${C.reset}`);
  console.log();

  // 读取所有文件
  const feedData = readAllFeedFiles();
  const fileCount = feedData.length;

  // 计算总体统计
  let totalNotes = 0;
  let totalSuccess = 0;
  let totalFail = 0;
  let stoppedCount = 0;

  for (const data of feedData) {
    totalNotes += data.totalNotes || 0;
    totalSuccess += data.successCount || 0;
    totalFail += (data.totalNotes || 0) - (data.successCount || 0);
    if (data.stopped) stoppedCount++;
  }

  // 显示总体进度
  const successRate = totalNotes > 0 ? ((totalSuccess / totalNotes) * 100).toFixed(1) : '0.0';
  const runningTime = Math.floor((Date.now() - startTime) / 1000);

  console.log(`${C.bold}【总体进度】${C.reset}`);
  console.log(`  已完成关键词: ${C.green}${fileCount}${C.reset} 个`);
  console.log(`  搜索笔记总数: ${C.blue}${totalNotes}${C.reset} 条`);
  console.log(`  详情成功数量: ${C.green}${totalSuccess}${C.reset} 条`);
  console.log(`  详情失败数量: ${C.red}${totalFail}${C.reset} 条`);
  console.log(`  成功率:       ${successRate >= 95 ? C.green : successRate >= 80 ? C.yellow : C.red}${successRate}%${C.reset}`);
  console.log(`  运行时间:     ${C.magenta}${formatDuration(runningTime)}${C.reset}`);

  // 计算预计剩余时间
  if (fileCount > 0 && fileCount !== lastFileCount) {
    lastFileCount = fileCount;
  }

  console.log();

  // 显示最近 5 个关键词的详情
  console.log(`${C.bold}【最近完成的关键词】${C.reset}`);
  const recent = feedData.slice(-5).reverse();
  for (const data of recent) {
    const status = data.stopped ? `${C.bgRed} 中断 ` : `${C.bgGreen} 完成 `;
    const keyword = (data.keyword || '未知').padEnd(6);
    const successCount = data.successCount || 0;
    const failCount = (data.totalNotes || 0) - successCount;
    const rate = data.totalNotes > 0 ? ((successCount / data.totalNotes) * 100).toFixed(0) : '0';
    const rateColor = rate >= 95 ? C.green : rate >= 80 ? C.yellow : C.red;

    console.log(`  ${status}${C.reset} ${keyword} | 笔记 ${String(data.totalNotes || 0).padStart(2)} | 成功 ${C.green}${String(successCount).padStart(2)}${C.reset} | 失败 ${failCount > 0 ? C.red : ''}${String(failCount).padStart(2)}${C.reset} | 成功率 ${rateColor}${rate}%${C.reset}`);
  }

  // 读取进度文件获取当前正在处理的关键词
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      if (progress.currentKeyword) {
        console.log();
        console.log(`${C.bold}${C.yellow}【当前处理中】${C.reset}`);
        console.log(`  关键词: ${progress.currentKeyword}`);
        console.log(`  已处理: ${progress.processed || 0} / ${progress.total || 0}`);
        if (progress.lastError) {
          console.log(`  最近错误: ${C.red}${progress.lastError}${C.reset}`);
        }
      }
    } catch (e) {
      // 忽略
    }
  }

  // 显示错误统计
  if (totalFail > 0) {
    console.log();
    console.log(`${C.bold}${C.red}【失败详情】${C.reset}`);

    // 按关键词分组显示失败情况和具体原因
    for (const data of feedData) {
      const failCount = (data.totalNotes || 0) - (data.successCount || 0);
      if (failCount > 0) {
        console.log(`  ${C.yellow}关键词 "${data.keyword || '未知'}":${C.reset} 失败 ${failCount} 条`);

        // 显示具体失败原因（如果有 failures 数组）
        if (data.failures && data.failures.length > 0) {
          const errorCount = {};
          for (const f of data.failures) {
            const key = `${f.code}: ${f.msg}`;
            errorCount[key] = (errorCount[key] || 0) + 1;
          }
          const errors = Object.entries(errorCount).slice(0, 3);
          for (const [key, count] of errors) {
            console.log(`      - ${key}: ${count} 条`);
          }
          if (Object.keys(errorCount).length > 3) {
            console.log(`      - ... 其他 ${Object.keys(errorCount).length - 3} 种错误`);
          }
        }
      }
    }

    // 显示错误码说明
    console.log();
    console.log(`${C.bold}【错误码说明】${C.reset}`);
    console.log(`  -100   : Cookie被标记（需要更新）`);
    console.log(`  300011 : 签名校验失败（需要更新签名）`);
    console.log(`  300013 : 请求频率限制（等待后重试）`);
    console.log(`  300031 : 笔记不存在或已下架`);
    console.log(`  -510000: 笔记已下架`);
    console.log(`  -998   : 网络请求失败`);
    console.log(`  -997   : 请求超时`);
  }

  // 底部提示
  console.log();
  console.log(`${C.cyan}────────────────────────────────────────────────────────────────${C.reset}`);
  console.log(`  按 Ctrl+C 退出监控 | 每 3 秒自动刷新`);
}

// 启动监控
console.log(`${C.cyan}启动采集监控...${C.reset}`);
console.log(`监控目录: ${FEED_DIR}`);
console.log(`按 Ctrl+C 退出\n`);

// 首次显示
monitor();

// 每 3 秒刷新
setInterval(monitor, 3000);

// 处理退出
process.on('SIGINT', () => {
  console.log(`\n${C.cyan}监控已停止${C.reset}`);
  process.exit(0);
});