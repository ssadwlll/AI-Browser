/**
 * 小红书笔记详情批量采集脚本 - Node.js（DOM 采集模式）
 *
 * 原理：
 * - 不再调用 feed API，而是通过 sign_server 的 /scrape-note 端点在浏览器中点击笔记卡片
 * - 页面自行请求 feed API → __INITIAL_STATE__ 自动更新 → 从中提取数据
 * - 点击本身就是行为事件，无需额外行为模拟
 * - 每条耗时 ~5-6s（对比 API 模式 ~15s）
 *
 * 流程（每关键词独立）：
 *   1. 导航浏览器到搜索结果页
 *   2. 逐条点击笔记卡片，从 __INITIAL_STATE__ 提取详情
 *   3. 保存到独立 JSON 文件
 *   4. 进入下一关键词
 *
 * 使用方法：
 *   node xhs-feed-collect.js
 *   set START_INDEX=5 && node xhs-feed-collect.js  （断点续采）
 *
 * 前置条件：
 *   - Electron 应用运行中，浏览器已打开小红书并登录
 *   - sign_server.js 运行在 127.0.0.1:3721
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// ======================= 签名服务配置 =======================

const SIGN_SERVER_URL = 'http://127.0.0.1:3721';
let signServerAvailable = false;

/**
 * 检测签名服务是否可用
 */
async function checkSignServer() {
  return new Promise((resolve) => {
    const req = http.get(`${SIGN_SERVER_URL}/health`, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          resolve(info.ok === true);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * 导航浏览器到指定 URL
 */
function browserNavigate(url, waitMs = 5000) {
  return new Promise((resolve) => {
    const bodyData = JSON.stringify({ url, waitMs });
    const req = http.request(`${SIGN_SERVER_URL}/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyData) },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '超时' }); });
    req.write(bodyData);
    req.end();
  });
}

/**
 * 调 /scrape-note 端点采集单条笔记（点击卡片 → SSR提取 → 关闭弹窗）
 */
function browserScrapeNote(index) {
  return new Promise((resolve) => {
    const bodyData = JSON.stringify({ index });
    const req = http.request(`${SIGN_SERVER_URL}/scrape-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyData) },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, error: '解析失败' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '超时' }); });
    req.write(bodyData);
    req.end();
  });
}

/**
 * 调 /scroll-search 端点滚动搜索页加载更多
 */
function browserScrollSearch(amount, waitMs) {
  return new Promise((resolve) => {
    const bodyData = JSON.stringify({ amount: amount || null, waitMs: waitMs || null });
    const req = http.request(`${SIGN_SERVER_URL}/scroll-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyData) },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, noteCount: 0 }); }
      });
    });
    req.on('error', () => resolve({ ok: false, noteCount: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, noteCount: 0 }); });
    req.write(bodyData);
    req.end();
  });
}

/**
 * 调 /note-count 端点获取当前搜索页笔记数量
 */
function getNoteCount() {
  return new Promise((resolve) => {
    const req = http.get(`${SIGN_SERVER_URL}/note-count`, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result.ok ? result.noteCount : 0);
        } catch { resolve(0); }
      });
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

// ======================= 配置 =======================

const OUTPUT_DIR = path.join(__dirname, 'data');
const FEED_DIR = path.join(OUTPUT_DIR, 'feed');
if (!fs.existsSync(FEED_DIR)) fs.mkdirSync(FEED_DIR, { recursive: true });

const KEYWORDS = [
  '美食', '旅游', '穿搭', '护肤', '健身',
  '家居', '数码', '摄影', '读书', '电影',
  '音乐', '游戏', '职场', '考研', '留学',
  '宠物', '育儿', '婚礼', '装修', '理财',
  '美妆', '口红', '香水', '包包', '球鞋',
  '露营', '徒步', '滑雪', '冲浪', '潜水',
  '咖啡', '烘焙', '探店', '自驾', '民宿',
  '手账', '插画', '书法', '插花', '园艺',
  '减肥', '瑜伽', '发型', '美甲', '配饰',
  '手表', '眼镜', '帽子', '围巾', '首饰',
  '冰箱', '洗衣机', '扫地机', '空气净化器', '扫地机器人',
  '电视机', '投影仪', '耳机', '音响', '键盘',
  '手机', '平板', '笔记本', '路由器', '充电宝',
  '面膜', '精华液', '防晒霜', '粉底液', '卸妆水',
  '沙发', '床垫', '窗帘', '地毯', '台灯',
  '烤箱', '微波炉', '电饭煲', '破壁机', '咖啡机',
  '童装', '玩具', '绘本', '纸尿裤', '奶粉',
];

// 从第几个关键词开始采集（用于断点续采）
const START_FROM_INDEX = process.env.START_INDEX ? parseInt(process.env.START_INDEX) : 0;

const MAX_NOTES_PER_KEYWORD = 60;   // 每个关键词最多采集条数
const DETAIL_DELAY_MIN = 2000;      // 详情采集间隔 2-4s
const DETAIL_DELAY_MAX = 4000;
const BATCH_PAUSE_EVERY = 8;        // 每8条休息
const BATCH_PAUSE_DURATION = 8000;  // 休息8s
const MAX_SCROLLS = 5;              // 每个关键词最多滚动5次
const KEYWORD_PAUSE_MIN = 5000;     // 关键词间暂停 5-10s
const KEYWORD_PAUSE_MAX = 10000;
const NAVIGATE_WAIT_MS = 5000;      // 导航后等待笔记加载

// ======================= 工具函数 =======================

function log(msg) { console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min, max) { return Math.floor(min + Math.random() * (max - min)); }

/**
 * 适配 DOM 采集数据为统一输出格式
 * SSR 提取的数据结构来自 sign_server.js /scrape-note 的 extractFromSSR()
 */
function adaptScrapedData(scraped, keyword) {
  if (!scraped) return null;
  return {
    noteId: scraped.noteId || '',
    keyword: keyword,
    title: scraped.title || '',
    desc: scraped.desc || '',
    type: scraped.type || '',
    user: {
      userId: scraped.user?.userId || '',
      nickname: scraped.user?.nickname || '',
      avatar: scraped.user?.avatar || '',
    },
    interactInfo: {
      likedCount: scraped.interactInfo?.likedCount || '0',
      collectedCount: scraped.interactInfo?.collectedCount || '0',
      commentCount: scraped.interactInfo?.commentCount || '0',
      shareCount: scraped.interactInfo?.shareCount || '0',
    },
    imageList: scraped.imageList || [],
    video: scraped.video || null,
    tagList: scraped.tagList || [],
    time: scraped.time || '',
    lastUpdateTime: scraped.lastUpdateTime || '',
    ipLocation: scraped.ipLocation || '',
    _extractMethod: scraped._extractMethod || 'unknown',
  };
}

// ======================= 单关键词采集 =======================

async function collectKeyword(keyword, keywordIndex) {
  log(`\n---------- [${keywordIndex + 1}/${KEYWORDS.length}] 关键词: "${keyword}" ----------`);

  // Step 1: 导航到搜索结果页
  const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`;
  log(`  [导航] 打开搜索页: "${keyword}"...`);
  const navResult = await browserNavigate(searchUrl, NAVIGATE_WAIT_MS);
  if (!navResult.ok) {
    log(`  [导航] 失败: ${navResult.error || '未知'}，跳过此关键词`);
    return { details: [], failures: [{ code: -1, msg: '导航失败' }], stopped: false };
  }

  // 等待笔记加载
  await sleep(randomDelay(2000, 3000));

  let noteCount = await getNoteCount();
  log(`  [搜索] 当前笔记数: ${noteCount}`);
  if (noteCount === 0) {
    // 再等一次
    await sleep(3000);
    noteCount = await getNoteCount();
    if (noteCount === 0) {
      log(`  [搜索] 未找到笔记，跳过此关键词`);
      return { details: [], failures: [{ code: -2, msg: '无笔记' }], stopped: false };
    }
  }

  // Step 2: 逐条采集
  log(`  [采集] 开始 DOM 采集，目标 ${Math.min(MAX_NOTES_PER_KEYWORD, noteCount)} 条...`);
  const details = [];
  const failures = [];
  let success = 0, fail = 0;
  let scrollCount = 0;
  let lastNoteCount = noteCount;

  const targetCount = Math.min(MAX_NOTES_PER_KEYWORD, noteCount);

  for (let i = 0; i < MAX_NOTES_PER_KEYWORD; i++) {
    // 如果接近已加载笔记的末尾，滚动加载更多
    if (i >= noteCount - 3 && scrollCount < MAX_SCROLLS) {
      log(`  [滚动] 已采集 ${i}/${noteCount}，滚动加载更多...`);
      const scrollResult = await browserScrollSearch();
      if (scrollResult.ok) {
        if (scrollResult.noteCount > lastNoteCount) {
          noteCount = scrollResult.noteCount;
          lastNoteCount = noteCount;
          scrollCount++;
          log(`  [滚动] 笔记数: ${noteCount}（第${scrollCount}次滚动）`);
        } else {
          scrollCount++;
          log(`  [滚动] 无新笔记（第${scrollCount}次滚动）`);
          if (scrollCount >= MAX_SCROLLS) {
            log(`  [滚动] 已达最大滚动次数(${MAX_SCROLLS})，停止`);
            break;
          }
        }
      } else {
        scrollCount++;
      }
      await sleep(randomDelay(1000, 2000));
    }

    // 如果已超过加载的笔记数且无法加载更多，停止
    if (i >= noteCount) {
      log(`  [采集] 已采集全部可用笔记(${noteCount}条)`);
      break;
    }

    // 采集单条笔记
    const scrapeResult = await browserScrapeNote(i);

    if (scrapeResult.ok && scrapeResult.data) {
      const adapted = adaptScrapedData(scrapeResult.data, keyword);
      if (adapted) {
        details.push(adapted);
        success++;
        if (success % 5 === 0) {
          log(`  [采集] 进度 ${i + 1} | 成功 ${success} | 失败 ${fail} | 方法: ${adapted._extractMethod}`);
        }
      } else {
        fail++;
        failures.push({ index: i, noteId: scrapeResult.noteId, code: -3, msg: '数据适配失败' });
      }
    } else {
      fail++;
      const errMsg = scrapeResult.error || '未知错误';
      failures.push({ index: i, code: -4, msg: errMsg });
      if (fail % 5 === 0) {
        log(`  [采集] 第${i + 1}条失败: ${errMsg}`);
      }

      // 连续失败3次，可能页面有问题
      if (i >= 2) {
        const recentFailures = failures.slice(-3);
        const allRecentFailed = recentFailures.every(f => f.index >= i - 2);
        if (allRecentFailed) {
          log(`  [采集] 连续失败，可能页面异常，尝试重新导航...`);
          const reNav = await browserNavigate(searchUrl, NAVIGATE_WAIT_MS);
          if (reNav.ok) {
            await sleep(randomDelay(2000, 3000));
            noteCount = await getNoteCount();
            log(`  [采集] 重新导航后笔记数: ${noteCount}`);
          }
        }
      }
    }

    // 每8条休息
    if ((i + 1) % BATCH_PAUSE_EVERY === 0) {
      log(`  [采集] 已采集 ${i + 1} 条，休息 ${BATCH_PAUSE_DURATION / 1000}s...`);
      await sleep(BATCH_PAUSE_DURATION);
    } else {
      await sleep(randomDelay(DETAIL_DELAY_MIN, DETAIL_DELAY_MAX));
    }
  }

  // Step 3: 保存到独立文件
  const safeName = keyword.replace(/[\/\\:*?"<>|]/g, '_');
  const fileName = `feed_${String(keywordIndex + 1).padStart(2, '0')}_${safeName}.json`;
  const filePath = path.join(FEED_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify({
    keyword,
    collectedAt: new Date().toISOString(),
    totalCollected: details.length,
    successCount: success,
    failCount: fail,
    extractMethods: details.reduce((acc, d) => {
      const m = d._extractMethod || 'unknown';
      acc[m] = (acc[m] || 0) + 1;
      return acc;
    }, {}),
    details,
    failures,
  }, null, 2), 'utf8');

  // Step 4: 输出采集结果
  log(`  [结果] 关键词 "${keyword}" 采集完成:`);
  log(`         成功: ${success} 条 | 失败: ${fail} 条`);
  if (failures.length > 0) {
    log(`         失败原因统计:`);
    const errorCount = {};
    for (const f of failures) {
      const key = `${f.code}: ${f.msg}`;
      errorCount[key] = (errorCount[key] || 0) + 1;
    }
    for (const [key, count] of Object.entries(errorCount)) {
      log(`           - ${key}: ${count} 条`);
    }
  }
  log(`         保存文件: ${fileName}`);

  return { details, failures, stopped: false };
}

// ======================= 主流程 =======================

async function main() {
  // 检测签名服务（Electron 应用需运行且浏览器已打开小红书页面）
  signServerAvailable = await checkSignServer();

  log('====================================');
  log('小红书笔记详情批量采集（DOM 模式）');
  log(`采集方式: 点击卡片 → __INITIAL_STATE__ 提取`);
  if (signServerAvailable) {
    log(`  签名服务: ${SIGN_SERVER_URL} ✅ 已连接`);
  } else {
    log(`  签名服务: ${SIGN_SERVER_URL} ❌ 未连接`);
    log(`  ⛔ DOM 采集依赖签名服务，请先启动 Electron 应用并打开小红书`);
    process.exit(1);
  }

  log(`每关键词目标: ${MAX_NOTES_PER_KEYWORD} 条 | 详情间隔: ${DETAIL_DELAY_MIN}-${DETAIL_DELAY_MAX}ms`);
  log(`批次休息: 每${BATCH_PAUSE_EVERY}条休息${BATCH_PAUSE_DURATION / 1000}s | 关键词间: ${KEYWORD_PAUSE_MIN / 1000}-${KEYWORD_PAUSE_MAX / 1000}s`);
  log(`最大滚动: ${MAX_SCROLLS}次/关键词`);
  if (START_FROM_INDEX > 0) {
    log(`从第 ${START_FROM_INDEX + 1} 个关键词继续采集: "${KEYWORDS[START_FROM_INDEX]}"`);
  }
  log('====================================');

  const summary = [];

  for (let i = START_FROM_INDEX; i < KEYWORDS.length; i++) {
    const result = await collectKeyword(KEYWORDS[i], i);
    summary.push({
      keyword: KEYWORDS[i],
      details: result.details.length,
      failures: result.failures?.length || 0,
      stopped: result.stopped,
    });

    if (result.stopped) {
      log(`\n⛔ 采集被中断，已完成 ${i + 1}/${KEYWORDS.length} 个关键词`);
      log(`   下次运行: set START_INDEX=${i} && node xhs-feed-collect.js`);
      break;
    }

    if (i < KEYWORDS.length - 1) {
      const pauseMs = randomDelay(KEYWORD_PAUSE_MIN, KEYWORD_PAUSE_MAX);
      log(`\n  关键词间暂停 ${pauseMs / 1000}s...`);
      await sleep(pauseMs);
    }
  }

  // 最终汇总
  log('\n====================================');
  log('采集汇总');
  log('====================================');
  let totalDetails = 0, totalFailures = 0;
  for (const s of summary) {
    const status = s.stopped ? '⛔中断' : '✅完成';
    log(`  ${s.keyword}: 成功 ${s.details} | 失败 ${s.failures} | ${status}`);
    totalDetails += s.details;
    totalFailures += s.failures;
  }
  log('------------------------------------');
  log(`  总计: 成功 ${totalDetails} | 失败 ${totalFailures}`);
  log(`  关键词: ${summary.length}/${KEYWORDS.length}`);
  log('====================================');
}

main().catch(err => {
  log(`致命错误: ${err.message}`);
  console.error(err.stack);
});
