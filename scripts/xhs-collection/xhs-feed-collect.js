/**
 * 小红书笔记详情批量采集脚本 - Node.js（按关键词逐个采集）
 *
 * 原理（已实测验证 2026-07-10）：
 * - x-s-common 通过 xs-common-node.js 动态生成（从 vendor-dynamic.8cd1891c.js 逆向）
 * - x-s 通过 xys-sign-node.js 动态生成（mnsv2 VM 纯 Node.js 运行），静态 XYS_ 作为回退
 * - XYW_ 动态签名触发 300015 环境检测，不可用
 * - 防风控：随机延迟 + sigCount 循环 + 单次会话限制 + 300015/300011 自动停止
 *
 * 流程（每关键词独立）：
 *   1. 搜索关键词获取笔记列表（含 xsec_token）
 *   2. 逐条采集笔记详情（动态 x-s + 动态 x-s-common）
 *   3. 保存到独立 JSON 文件并输出结果
 *   4. 进入下一关键词
 *
 * 使用方法：
 *   node xhs-feed-collect.js
 *   set START_INDEX=5 && node xhs-feed-collect.js  （断点续采）
 */

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { generateXsCommon } = require('./xs-common-node');
const { init: initXysSign, generateHeaders } = require('./xys-sign-node');

// ======================= 签名服务配置 =======================

const SIGN_SERVER_URL = 'http://127.0.0.1:3721';
let signServerAvailable = false;  // 运行时检测
let xysSignReady = false;         // XYS_ 动态签名是否就绪

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
 * 通过签名服务获取浏览器 cookies（签名服务可用时覆盖硬编码值）
 */
function getBrowserCookies() {
  return new Promise((resolve) => {
    const req = http.get(`${SIGN_SERVER_URL}/cookies`, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result.cookies || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * 通过签名服务在浏览器内发起 API 请求
 * XYS_ 签名由 Node.js 生成（不触发 300015），请求通过浏览器 fetch 发出（真实 Chrome TLS）
 */
function browserFetch(apiPath, bodyObj, xsc, rapParam, xs, xt) {
  return new Promise((resolve) => {
    const bodyData = JSON.stringify({ apiPath, body: bodyObj, method: 'POST', xsc, rapParam, xs, xt });
    const req = http.request(`${SIGN_SERVER_URL}/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyData) },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ ok: false, error: '解析失败: ' + e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '超时' }); });
    req.write(bodyData);
    req.end();
  });
}

/**
 * 通过签名服务生成动态 XYW_ 签名
 */
function getDynamicSign(apiPath, bodyStr) {
  return new Promise((resolve) => {
    const bodyData = JSON.stringify({ apiPath, body: bodyStr });
    const req = http.request(`${SIGN_SERVER_URL}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyData) },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result['X-s']) {
            resolve({ ok: true, sign: result });
          } else {
            resolve({ ok: false, error: result.error || '签名服务返回异常' });
          }
        } catch (e) {
          resolve({ ok: false, error: '解析失败: ' + e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '超时' }); });
    req.write(bodyData);
    req.end();
  });
}

/**
 * 导航浏览器到笔记详情页（产生真实行为事件：collect/metrics_report/history）
 */
function browserNavigate(url, waitMs = 3000) {
  return new Promise((resolve) => {
    const bodyData = JSON.stringify({ url, waitMs });
    const req = http.request(`${SIGN_SERVER_URL}/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyData) },
      timeout: 30000,  // 导航可能较慢，给 30s
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
 * 模拟页面滚动（产生 collect 行为事件）
 */
function browserScroll() {
  return new Promise((resolve) => {
    const req = http.request(`${SIGN_SERVER_URL}/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); } });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.end();
  });
}

/**
 * 模拟人类行为：导航到笔记详情页 + 滚动 + 停留
 * 每采集 N 条详情后执行一次，让浏览器产生真实行为事件
 */
async function simulateHumanBehavior(notes) {
  if (!signServerAvailable || notes.length === 0) return;

  // 随机选一条笔记导航过去（产生 page_view + metrics_report + collect 事件）
  const note = notes[Math.floor(Math.random() * notes.length)];
  const noteUrl = `https://www.xiaohongshu.com/explore/${note.noteId}?xsec_token=${note.xsecToken}&xsec_source=pc_search`;
  log(`  [行为] 模拟浏览笔记: ${note.noteId}`);

  const navResult = await browserNavigate(noteUrl, randomDelay(3000, 6000));
  if (!navResult.ok) {
    log(`  [行为] 导航失败: ${navResult.error || '未知'}，尝试直接滚动当前页面`);
    // 导航失败时，直接在当前页面滚动也能产生 collect 事件
    await browserScroll();
    await sleep(randomDelay(500, 1000));
    await browserScroll();
    return;
  }

  // 模拟滚动 2-3 次（产生 scroll 事件）
  await sleep(randomDelay(1000, 2000));
  await browserScroll();
  await sleep(randomDelay(800, 1500));
  await browserScroll();

  // 导航回搜索页（产生 page_leave + history/report_web 事件）
  await sleep(randomDelay(1000, 2000));
  const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(note.keyword)}&source=web_explore_feed`;
  const backResult = await browserNavigate(searchUrl, randomDelay(2000, 4000));
  if (!backResult.ok) {
    log(`  [行为] 返回搜索页失败: ${backResult.error || '未知'}（不影响采集）`);
  }

  log(`  [行为] 行为模拟完成`);
}

// ======================= 配置 =======================

const OUTPUT_DIR = path.join(__dirname, 'data');
const FEED_DIR = path.join(OUTPUT_DIR, 'feed');
if (!fs.existsSync(FEED_DIR)) fs.mkdirSync(FEED_DIR, { recursive: true });

// Cookie（用户最新提供 2026-07-10）
const COMMON_COOKIES = {
  abRequestId: '9c5c9773-603f-5e18-adce-9ab89adfd542',
  a1: '19efa15e690sc7wu6do9lqimzccd66czcvd461dqa50000156674',
  webId: '49b740c76dea2573a6fbca39210c668d',
  gid: 'yjdi0yKyjWSdyjdi0y2dKhyfj8MSWE7Kflj1fA0A36uSS428fKKSuK888y2KKW48SdJD4y08',
  xsecappid: 'xhs-pc-web',
  ets: '1782312199568',
  'x-rednote-datactry': 'CN',
  'x-rednote-holderctry': 'CN',
  webBuild: '6.31.3',
  websectiga: '8886be45f388a1ee7bf611a69f3e174cae48f1ea02c0f8ec3256031b8be9c7ee',
  sec_poison_id: '055e33ea-dd9c-45d6-841f-f8e3bc58015c',
  loadts: '1783636157793',
  unread: '{%22ub%22:%226a36484a000000000f02953c%22%2C%22ue%22:%226a49eafb000000000f0175d2%22%2C%22uc%22:27}',
  web_session: '040069bb246144698856506b65384b0dc16455',
  id_token: 'VjEAAC/2epP81qI41FSqdcEJ4p0LhyrkdY8qJvM9x6XA18d6I8A3JKuN0EoVXPf2ilAkRZt4sqowb90yHQWq70sZ91SaKxq4XhMSgUs0cjKXWUr6M1M2hGDXV5Fskof2gRYEQOat',
};

let SEARCH_ACW_TC = '0ad6226c17836367948908578e3ad8469793aa0d382af573f2c733df72e90f';
let FEED_ACW_TC = '0a50889217836379856315327e077033f9aab2808285072f0ecdec55f9d78a';

// Search v2 API 签名（动态生成优先，静态值作为回退）
const SEARCH_X_S = 'XYS_2UQhPsHCH0c1PUh7HjIj2erjwjQhyoPTqBPT49pjHjIj2eHjwjQgynEDJ74AHjIj2ePjwjQTJdPIPAZlg94aGLTlqgkcyAb6PBSmLB+b4emk8rL6JURG/d+awepn8e4x2bSonLDUy0bl+FDF8oYt4dSGL9H7znQGLgSI+sTtzM+i+9zpzeLIJA8ayFG3/SmaGMmVn/G7LFYNpnE0/LTyJAmp4r83aBzVcDIIqLI3NFkmPrkHaMY/admnzUTTPbz+c9EIqMQCLDkcpnbLP9lrzDT/Jfznnfl0yLLIaSQQyAmOarEaLSz+qSclp0zMz9p/G0+98dki/L8PJdQLzaHVHdWFH0ijJ9Qx8n+FHdF=';
const SEARCH_X_S_COMMON = '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';
const SEARCH_RAP_PARAM = 'ByQBBgAAAAEAAAAUAAACZOSXHp4AACg9AAAAVQAAAAAAAAAAN2RybDJyyqJ5yRR0ytvyVO8fHtnVCAAAABDvgy/FcTbVE7BYynasnU+6HuKdCHOJ/IQ35xx9/ZgDfQj4OqApfuYz/mtQDaug8BY4D+Ux1wJe1tqbyTAawGFH9GVlT1ISWXtUeped8jAq52F6cCrOdZtVPVW0L1q3SufR7kUOC134N5uGYx1fH1686cMCfJJ2hVPViqHGuJYOlykZ6Fl9cX/bWaK+J6LaZ4FUUvbQs5MQueCtdL7boqvtPzHb0LadmhbxezuFZnAVFqqQUeqwkR8BoMHiybKyAwXL9m5H9Ik0dkZY1mB8lCGrTDuRsfHDUFP/ATuj5qr/iLjMymDr3HFnnq0UEVwfu4DIwHwUAlbeHOJDWFHkq6dtNG9tgIOLCjqGVQ1Lrhu1u0+R2bWnlRqXc5GuX6hAbhwm0VkVZwrLwbAtBJ3/QAAn02o3P4a+PDgbpfb5Q+5CDjG4yHNYxCfr2IGx0wrszX21nqXHNOkMLOR4rIHs8rQWWU6RJXqs97tEWM2lvxinhByfKm9HVgPxJzdWrCzlKmepEzUEdmrg3aIcflRKrjKANvMq2Pr7f77U5/YjRKy7DpcJtx58DYH/ELaXFfdoPUI2RG4D/t4xMa5Ll0Ogh2TnhWl5UtYLXXG/QcYXNaDY5ofBY47x2eb7DiGdP+tzLonBX2dK5hhn5uzLH+sz1FTXgZkUcWkwchCMqu1AtYHWtZ+2x7u6gxh072YkfwrjYJ11M2pwMs4eGSOphjTd5Y3tNeMAmBSzCbaYg2zzBilHMXZybINSywhHjLupeRFmx8DHBN+ylJCvKhubYbtqf0xdhHA25MOPxGNn8bfYTcaujAAAAlI=';

// Feed API 签名（动态生成优先，静态值作为回退）
// x-s: xys-sign-node.js 动态生成，x-s-common: xs-common-node.js 动态生成
const FEED_X_S = 'XYS_2UQhPsHCH0c1PUh7HjIj2erjwjQhyoPTqBPT49pjHjIj2eHjwjQgynEDJ74AHjIj2ePjwjQTJdPIPAZlg94aGLTlq/YDGDpOtUTN89+b4emk8rL6JURG/d+awepnzf4x2bSonLDUy0bA+FDF8bb3qBSH8LGI+bP7LgSI+sTtzM+i+9zpzeLIJA8ayFG3/SmaGMmVn/G7LFYNpnE0/LTyJAmp4r83aBzVcDIIqLI3NFkmPrkHaMY/admnzUTTPbz+c9EIqMQCLDkcpnbLP9lrzDT/Jfznnfl0yLLIaSQQyAmOarEaLSz+G7YoP/+SnbbswbSSz0qhLoGU+LDF4sHVHdWFH0ijJ9Qx8n+FHdF=';
const FEED_RAP_PARAM = 'ByQBBAAAAAEAAAAUAAACBNb3h1oAACg9AAAAXAAAAAAAAAAAdnRveRJMVMSEolCwPm4YMbqwG60AAAAQKGHZOeuHtLz+8YuKVRyh/F07DXwWT8hvbd13+tJV/ziTFp9xryY9XijRNP17PntjG94rhB94ZICYaiOnSoBQYvntlOQe2KgUFy55LMNPYGpuLVQpjjQmUcdTzYeKe/2b+FEGeGHmstJ4oZQic8Q2NtykH56uchNqXF8hYFeOKC8YvoAu7OjEWplzP87vE+ooIfTgGFahCH7HO6ecif0A4SHSh+SzaQOIZ428twJ5D5usCFLtlAaqQJK27XiRCioMV6Dm8VzIRjchn2RcJk0sp+SBzY0c8spii+7Mt7GxKZ5DEMa4op+8G6Kpi5vCypk3mREgmYy5hlzvoJughmxXJeXyTRbrEbOw4dlLZG9HQJdM7fp9mOmoKUK4zjgFTrE/6WmjknF0P9tLTCqAwfAbOj8j3aCi+rqyUcYRmTrS6QEJEfAD6CFT/qvBGZq9QUknHpkLoLp35pJXcMsiM0T36bz0sl2ylOcCT6fdJyh0BoqgI5VGDTv0a5VImjzeltP/1wtUiPx+neCKXC5q1fL6E/Sz4Mnfqh5eYiHUxmY1HNR8d5A22jZU97TiIpLDe+vfFGEYdehz977fSUOtQoJL6WxPXr9YCxAUcMeya5AAYxWx5XLL6LjqiMWWz6hiiqG0TXtZQGnQWje+/6sbgtsdZlwhh8dqoT7kXAg6tSBt/UMAAAIA';

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
];

// 从第几个关键词开始采集（用于断点续采）
const START_FROM_INDEX = process.env.START_INDEX ? parseInt(process.env.START_INDEX) : 0;

const PAGES_PER_KEYWORD = 3;
const PAGE_SIZE = 20;
const SEARCH_DELAY = 800;
const FEED_DELAY_MIN = 2000;      // 详情采集间隔 2-5s
const FEED_DELAY_MAX = 5000;
const FEED_RETRY_DELAY = 30000;   // 限流重试等待 30s
const CONSECUTIVE_FAIL_PAUSE = 60000; // 连续3次失败暂停 60s
const BATCH_SIZE = 100;
const BATCH_PAUSE_MIN = 30000;    // 批次暂停 30-60s
const BATCH_PAUSE_MAX = 60000;
const KEYWORD_PAUSE_MIN = 10000;  // 关键词间暂停 10-20s
const KEYWORD_PAUSE_MAX = 20000;

// ======================= 工具函数 =======================

function log(msg) { console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min, max) { return Math.floor(min + Math.random() * (max - min)); }
function randomHex(len) { return crypto.randomBytes(len).toString('hex'); }
function randomId(len = 21) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function genSessionId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
function buildCookieString(acwTc) {
  const all = { ...COMMON_COOKIES, acw_tc: acwTc };
  return Object.entries(all).map(([k, v]) => `${k}=${v}`).join('; ');
}

function httpPost(host, apiPath, headers, bodyStr) {
  return new Promise((resolve) => {
    const req = https.request({ hostname: host, port: 443, path: apiPath, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        try {
          let text;
          if (encoding === 'gzip') text = zlib.gunzipSync(buf).toString();
          else if (encoding === 'br') text = zlib.brotliDecompressSync(buf).toString();
          else if (encoding === 'deflate') text = zlib.inflateSync(buf).toString();
          else text = buf.toString();
          resolve(JSON.parse(text));
        } catch (e) {
          resolve({ code: -999, msg: 'parse error: ' + e.message });
        }
      });
    });
    req.on('error', e => resolve({ code: -998, msg: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ code: -997, msg: 'timeout' }); });
    req.write(bodyStr);
    req.end();
  });
}

// ======================= 搜索 API =======================

async function fetchSearch(keyword, page) {
  const body = {
    keyword, page, page_size: PAGE_SIZE,
    search_id: randomId(21), sort: 'general', note_type: 0,
    ext_flags: [], geo: '', image_formats: ['jpg', 'webp', 'avif'],
    message_id: 'sending', session_id: genSessionId(),
  };
  const bodyStr = JSON.stringify(body);
  const apiPath = '/api/sns/web/v2/search/notes';

  // 动态生成 x-s（优先），回退静态
  let xS = SEARCH_X_S;
  let xT = String(Date.now());
  if (xysSignReady) {
    try {
      const sign = await generateHeaders(apiPath, bodyStr);
      xS = sign['X-s'];
      xT = sign['X-t'];
    } catch (e) {
      log(`  [搜索] 动态 x-s 失败，回退静态: ${e.message}`);
    }
  }

  // 动态生成 x-s-common（与 Feed 一致，避免静态复用被检测）
  searchSigCount++;
  if (searchSigCount > 20) searchSigCount = Math.floor(Math.random() * 3) + 1;
  const dynamicSearchXsc = generateXsCommon({
    platform: 'PC',
    url: apiPath,
    cookieA1: COMMON_COOKIES.a1,
    fingerprint: '',
    version: '4.3.7',
    dsl: '',
    sigCount: searchSigCount,
  });

  return httpPost('so.xiaohongshu.com', apiPath, {
    'accept': 'application/json, text/plain, */*',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json;charset=UTF-8',
    'cookie': buildCookieString(SEARCH_ACW_TC),
    'origin': 'https://www.xiaohongshu.com',
    'priority': 'u=1, i',
    'referer': 'https://www.xiaohongshu.com/',
    'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'x-b3-traceid': randomHex(8), 'x-rap-param': SEARCH_RAP_PARAM,
    'x-s': xS, 'x-s-common': dynamicSearchXsc,
    'x-t': xT, 'x-xray-traceid': randomHex(16),
  }, bodyStr);
}

// ======================= Feed 详情 API =======================

// sigCount 模拟真实浏览器的签名计数（保持在低值，避免被风控检测）
let feedSigCount = Math.floor(Math.random() * 5) + 1; // 起始 1-5
let searchSigCount = Math.floor(Math.random() * 3) + 1; // 搜索签名计数

// 全局详情采集计数（跨关键词，用于触发批次暂停）
let totalDetailsCollected = 0;

async function fetchFeed(noteId, xsecToken) {
  const body = {
    source_note_id: noteId,
    image_formats: ['jpg', 'webp', 'avif'],
    extra: { need_body_topic: '1' },
    xsec_source: 'pc_search',
    xsec_token: xsecToken,
  };

  const bodyStr = JSON.stringify(body);
  const apiPath = '/api/sns/web/v1/feed';

  // sigCount 递增但不无限增长（模拟真实浏览器，偶尔重置）
  feedSigCount++;
  if (feedSigCount > 30) feedSigCount = Math.floor(Math.random() * 5) + 1;

  // 动态生成 x-s-common（传入浏览器 fetch 使用）
  const dynamicXsc = generateXsCommon({
    platform: 'PC',
    url: apiPath,
    cookieA1: COMMON_COOKIES.a1,
    fingerprint: '',
    version: '4.3.7',
    dsl: '',
    sigCount: feedSigCount,
  });

  // 动态生成 XYS_ x-s（xys-sign-node.js，不触发 300015）
  let dynamicXs = null;
  let dynamicXt = null;
  if (xysSignReady) {
    try {
      const sign = await generateHeaders(apiPath, bodyStr);
      dynamicXs = sign['X-s'];
      dynamicXt = sign['X-t'];
    } catch (e) {
      log(`  [详情] 动态 x-s 失败: ${e.message}`);
    }
  }

  // === 采集策略（2026-07-10 修复 v3）===
  // XYS_ 签名（Node.js 生成）+ 浏览器 fetch（真实 Chrome TLS）
  //   关键：XYS_ 不触发 300015，浏览器 fetch TLS 不被聚类检测
  //   禁止回退 Node.js（Node.js TLS 必触发 300015）
  //
  // 路径选择：
  //   A) signServer可用 + XYS_签名就绪 → browserFetch（最优）
  //   B) signServer可用 + XYS_签名失败 → browserFetch 让 /fetch 回退 _webmsxyw（可能 300015）
  //   C) signServer不可用 → Node.js 直接请求（~300条后 TLS 聚类风控）
  if (signServerAvailable && dynamicXs) {
    // 路径 A：XYS_ + 浏览器 fetch
    const result = await browserFetch(apiPath, body, dynamicXsc, FEED_RAP_PARAM, dynamicXs, dynamicXt);
    if (result.ok) {
      return result.data;
    }
    // browserFetch 失败（超时/网络错误），跳过此笔记，不回退 Node.js
    log(`  [详情] BrowserView fetch 失败: ${result.error || '未知'}，跳过`);
    return { code: -996, msg: 'browserFetch失败: ' + (result.error || '未知') };
  }

  if (signServerAvailable && !dynamicXs) {
    // XYS_ 签名生成失败，不能用 browserFetch（会回退 _webmsxyw → XYW_ → 300015）
    log(`  [详情] XYS_ 签名未就绪，使用 Node.js 直接请求`);
  }

  // 路径 C：Node.js 直接请求（回退，可能触发 TLS 风控）
  return fetchFeedFallback(noteId, xsecToken, bodyStr);
}

/**
 * 采集方案：动态 x-s + 动态 x-s-common（Node.js 直接请求）
 */
async function fetchFeedFallback(noteId, xsecToken, bodyStr) {
  const apiPath = '/api/sns/web/v1/feed';

  // 动态生成 x-s-common（纯 Node.js 算法，每次请求唯一）
  const dynamicXsc = generateXsCommon({
    platform: 'PC',
    url: apiPath,
    cookieA1: COMMON_COOKIES.a1,
    fingerprint: '',
    version: '4.3.7',
    dsl: '',
    sigCount: feedSigCount,
  });

  // 动态生成 x-s（优先），回退静态
  let xS = FEED_X_S;
  let xT = String(Date.now());
  if (xysSignReady) {
    try {
      const sign = await generateHeaders(apiPath, bodyStr);
      xS = sign['X-s'];
      xT = sign['X-t'];
    } catch (e) {
      log(`  [详情] 动态 x-s 失败，回退静态: ${e.message}`);
    }
  }

  return httpPost('edith.xiaohongshu.com', apiPath, {
    'accept': 'application/json, text/plain, */*',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json;charset=UTF-8',
    'cookie': buildCookieString(FEED_ACW_TC),
    'origin': 'https://www.xiaohongshu.com',
    'priority': 'u=1, i',
    'referer': 'https://www.xiaohongshu.com/',
    'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'x-b3-traceid': randomHex(8), 'x-rap-param': FEED_RAP_PARAM,
    'x-s': xS,
    'x-s-common': dynamicXsc,
    'x-t': xT, 'x-xray-traceid': randomHex(16),
    'xy-direction': '18',
  }, bodyStr);
}

// ======================= 详情提取 =======================

function extractDetail(resp, note) {
  const nc = resp.data?.items?.[0]?.note_card || {};
  return {
    noteId: note.noteId,
    keyword: note.keyword,
    xsecToken: note.xsecToken,
    title: nc.title || '',
    desc: nc.desc || '',
    type: nc.type || '',
    tagList: nc.tag_list || [],
    user: {
      userId: nc.user?.user_id || '',
      nickname: nc.user?.nickname || '',
      avatar: nc.user?.avatar || '',
    },
    interactInfo: {
      likedCount: nc.interact_info?.liked_count || '0',
      collectedCount: nc.interact_info?.collected_count || '0',
      commentCount: nc.interact_info?.comment_count || '0',
      shareCount: nc.interact_info?.share_count || '0',
    },
    imageList: (nc.image_list || []).map(img => ({
      url: img.url || '',
      width: img.width || 0,
      height: img.height || 0,
    })),
    time: nc.time || '',
    lastUpdateTime: nc.last_update_time || '',
    shareInfo: nc.share_info || {},
  };
}

// ======================= 单关键词采集 =======================

async function collectKeyword(keyword, keywordIndex) {
  log(`\n---------- [${keywordIndex + 1}/${KEYWORDS.length}] 关键词: "${keyword}" ----------`);

  // Step 1: 搜索获取笔记列表
  log(`  [搜索] 开始搜索 "${keyword}"...`);
  const notes = [];
  for (let page = 1; page <= PAGES_PER_KEYWORD; page++) {
    const resp = await fetchSearch(keyword, page);
    if (resp.code !== 0) {
      log(`  [搜索] page ${page} 错误: code=${resp.code} msg=${resp.msg || ''}`);
      if (resp.code === -100) {
        log(`  [搜索] 登录已过期(-100)，尝试刷新 cookies...`);
        if (signServerAvailable) {
          const freshCookies = await getBrowserCookies();
          if (freshCookies && freshCookies.a1) {
            Object.assign(COMMON_COOKIES, freshCookies);
            if (freshCookies.acw_tc) { SEARCH_ACW_TC = freshCookies.acw_tc; FEED_ACW_TC = freshCookies.acw_tc; }
            log(`  [搜索] cookies 已刷新，重试 page ${page}`);
            const retryResp = await fetchSearch(keyword, page);
            if (retryResp.code === 0) {
              const retryItems = retryResp.data?.items || [];
              for (const item of retryItems) {
                const nc = item.note_card || {};
                const noteId = item.id || nc.note_id;
                const xsecToken = item.xsec_token || nc.xsec_token || '';
                if (noteId && xsecToken && noteId.length < 30) {
                  notes.push({ noteId, xsecToken, keyword, title: nc.display_title || '', type: nc.type || '' });
                }
              }
              log(`  [搜索] page ${page} 重试成功: ${retryItems.length} 条`);
              await sleep(randomDelay(1000, 2000));
              continue;
            }
          }
        }
        log(`  ⛔ 登录已过期且无法刷新，停止采集`);
        return { notes, details: [], stopped: true };
      }
      await sleep(randomDelay(2000, 4000));
      continue;
    }
    const items = resp.data?.items || [];
    for (const item of items) {
      const nc = item.note_card || {};
      const noteId = item.id || nc.note_id;
      const xsecToken = item.xsec_token || nc.xsec_token || '';
      if (noteId && xsecToken && noteId.length < 30) {
        notes.push({ noteId, xsecToken, keyword, title: nc.display_title || '', type: nc.type || '' });
      }
    }
    log(`  [搜索] page ${page}: ${items.length} 条，有效 ${notes.length} 条`);
    await sleep(randomDelay(1000, 2000));
  }
  log(`  [搜索] 完成，共 ${notes.length} 条有效笔记`);

  // Step 2: 逐条采集详情
  log(`  [详情] 开始采集 ${notes.length} 条笔记详情...`);
  const details = [];
  const failures = [];  // 记录失败详情
  let success = 0, fail = 0;
  let consecutiveFail = 0;

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const resp = await fetchFeed(note.noteId, note.xsecToken);

    if (resp.code === 0) {
      details.push(extractDetail(resp, note));
      success++;
      consecutiveFail = 0;
      if (success % 10 === 0) {
        log(`  [详情] 进度 ${i + 1}/${notes.length} | 成功 ${success} | 失败 ${fail}`);
      }
    } else if (resp.code === 300013) {
      // 限流：等待后重试一次
      log(`  [详情] ${i + 1}/${notes.length} 限流，等待 ${FEED_RETRY_DELAY / 1000}s 重试...`);
      await sleep(FEED_RETRY_DELAY);
      const retry = await fetchFeed(note.noteId, note.xsecToken);
      if (retry.code === 0) {
        details.push(extractDetail(retry, note));
        success++;
        consecutiveFail = 0;
      } else {
        fail++;
        consecutiveFail++;
        failures.push({ noteId: note.noteId, xsecToken: note.xsecToken, code: retry.code, msg: retry.msg || '重试失败' });
        log(`  [详情] 重试仍失败: code=${retry.code} msg=${retry.msg || ''}`);
        if (consecutiveFail >= 3) {
          log(`  [详情] 连续 ${consecutiveFail} 次失败，暂停 ${CONSECUTIVE_FAIL_PAUSE / 1000}s`);
          await sleep(CONSECUTIVE_FAIL_PAUSE);
          consecutiveFail = 0;
        }
      }
    } else if (resp.code === -100) {
      log(`  [详情] 登录已过期(-100)，尝试刷新 cookies...`);
      if (signServerAvailable) {
        const freshCookies = await getBrowserCookies();
        if (freshCookies && freshCookies.a1) {
          Object.assign(COMMON_COOKIES, freshCookies);
          if (freshCookies.acw_tc) { SEARCH_ACW_TC = freshCookies.acw_tc; FEED_ACW_TC = freshCookies.acw_tc; }
          log(`  [详情] cookies 已刷新，重试 ${note.noteId}`);
          const retry = await fetchFeed(note.noteId, note.xsecToken);
          if (retry.code === 0) {
            details.push(extractDetail(retry, note));
            success++;
            consecutiveFail = 0;
            await sleep(randomDelay(FEED_DELAY_MIN, FEED_DELAY_MAX));
            continue;
          }
        }
      }
      log(`  ⛔ 登录已过期且无法刷新，停止采集`);
      return { notes, details, failures, stopped: true };
    } else if (resp.code === 300011 && resp.msg && resp.msg.includes('账号异常')) {
      // 300011 + "账号异常" = 账号被风控，必须停止
      log(`  ⛔ 账号被风控（账号异常）！停止采集`);
      return { notes, details, failures, stopped: true };
    } else if (resp.code === 300015) {
      // 300015 = 环境检测，等待后重试一次
      log(`  ⚠️ 触发环境检测（300015），等待30s后重试...`);
      await sleep(30000);
      // 刷新 cookies 后重试
      if (signServerAvailable) {
        const freshCookies = await getBrowserCookies();
        if (freshCookies && freshCookies.a1) {
          Object.assign(COMMON_COOKIES, freshCookies);
          if (freshCookies.acw_tc) { SEARCH_ACW_TC = freshCookies.acw_tc; FEED_ACW_TC = freshCookies.acw_tc; }
        }
      }
      const retry = await fetchFeed(note.noteId, note.xsecToken);
      if (retry.code === 0) {
        details.push(extractDetail(retry, note));
        success++;
        consecutiveFail = 0;
        log(`  [详情] 300015 重试成功`);
        await sleep(randomDelay(FEED_DELAY_MIN, FEED_DELAY_MAX));
        continue;
      }
      if (retry.code === 300015) {
        log(`  ⛔ 300015 重试仍失败，停止采集`);
        log(`  提示: 请确认已重启 Electron 应用加载最新 sign_server.js`);
        return { notes, details, failures, stopped: true };
      }
      // 重试返回其他错误，按正常流程处理
      resp = retry;
      if (resp.code === 0) {
        details.push(extractDetail(resp, note));
        success++;
        consecutiveFail = 0;
        await sleep(randomDelay(FEED_DELAY_MIN, FEED_DELAY_MAX));
        continue;
      }
      fail++;
      failures.push({ noteId: note.noteId, xsecToken: note.xsecToken, code: resp.code, msg: resp.msg || '300015重试后失败' });
    } else if (resp.code === -510000 || resp.code === 300031) {
      // 笔记不存在或已下架
      fail++;
      failures.push({ noteId: note.noteId, xsecToken: note.xsecToken, code: resp.code, msg: resp.msg || (resp.code === -510000 ? '笔记不存在' : '笔记已下架') });
    } else {
      log(`  [详情] ${note.noteId}: code=${resp.code} msg=${resp.msg || ''}`);
      fail++;
      failures.push({ noteId: note.noteId, xsecToken: note.xsecToken, code: resp.code, msg: resp.msg || '未知错误' });
    }

    await sleep(randomDelay(FEED_DELAY_MIN, FEED_DELAY_MAX));

    // 每 50 条模拟一次人类行为（导航笔记页+滚动+返回搜索页）
    totalDetailsCollected++;
    if (totalDetailsCollected % 50 === 0) {
      log(`  [详情] 已采集 ${totalDetailsCollected} 条，模拟人类行为...`);
      await simulateHumanBehavior(notes);
    }

    // 每 BATCH_SIZE 条详情，随机长暂停（防风控）
    if (totalDetailsCollected % BATCH_SIZE === 0) {
      const batchPause = randomDelay(BATCH_PAUSE_MIN, BATCH_PAUSE_MAX);
      log(`  [详情] 已采集 ${totalDetailsCollected} 条，批次暂停 ${batchPause / 1000}s...`);
      await sleep(batchPause);
    }
  }

  // Step 3: 保存到独立文件
  const safeName = keyword.replace(/[\/\\:*?"<>|]/g, '_');
  const fileName = `feed_${String(keywordIndex + 1).padStart(2, '0')}_${safeName}.json`;
  const filePath = path.join(FEED_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify({
    keyword,
    collectedAt: new Date().toISOString(),
    totalNotes: notes.length,
    successCount: success,
    failCount: fail,
    details,
    failures,  // 添加失败详情
  }, null, 2), 'utf8');

  // Step 4: 输出采集结果
  log(`  [结果] 关键词 "${keyword}" 采集完成:`);
  log(`         搜索笔记: ${notes.length} 条`);
  log(`         详情成功: ${success} 条`);
  log(`         详情失败: ${fail} 条`);
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

  return { notes, details, failures, stopped: false };
}

// ======================= 主流程 =======================

async function main() {
  // 检测签名服务（Electron 应用需运行且浏览器已打开小红书页面）
  signServerAvailable = await checkSignServer();

  log('====================================');
  log('小红书笔记详情批量采集（按关键词）');
  log(`搜索API: so.xiaohongshu.com v2 (动态 XYS_ x-s + 动态 x-s-common)`);
  log(`详情API: edith.xiaohongshu.com feed (BrowserView fetch + 动态 x-s-common)`);
  if (signServerAvailable) {
    log(`  签名服务: ${SIGN_SERVER_URL} ✅ 已连接（cookie同步 + BrowserView fetch）`);
    let cookieSynced = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const browserCookies = await getBrowserCookies();
      if (browserCookies && browserCookies.a1 && browserCookies.web_session) {
        Object.assign(COMMON_COOKIES, browserCookies);
        if (browserCookies.acw_tc) {
          SEARCH_ACW_TC = browserCookies.acw_tc;
          FEED_ACW_TC = browserCookies.acw_tc;
        }
        log(`  Cookie同步成功 (第${attempt}次, a1: ${COMMON_COOKIES.a1.substring(0, 15)}...)`);
        cookieSynced = true;
        break;
      }
      log(`  Cookie同步第${attempt}次: cookies不完整，3s后重试...`);
      await sleep(3000);
    }
    if (!cookieSynced) {
      log(`  ⚠️ Cookie同步失败，使用硬编码值（可能导致 -100 错误）`);
    }
  } else {
    log(`  签名服务: ${SIGN_SERVER_URL} ❌ 未连接（使用硬编码 cookies）`);
  }

  // 初始化 XYS_ 动态签名环境（纯 Node.js mnsv2 VM）
  try {
    const cookieStr = buildCookieString(SEARCH_ACW_TC);
    await initXysSign({ cookie: cookieStr });
    xysSignReady = true;
    log(`  XYS_ 动态签名: ✅ 已初始化（mnsv2 VM 纯 Node.js）`);
  } catch (e) {
    xysSignReady = false;
    log(`  XYS_ 动态签名: ⚠️ 初始化失败 (${e.message})，回退静态 XYS_`);
  }

  log(`详情间隔: ${FEED_DELAY_MIN}-${FEED_DELAY_MAX}ms (随机) | 关键词间: ${KEYWORD_PAUSE_MIN}-${KEYWORD_PAUSE_MAX}ms (随机)`);
  log(`批次暂停: 每 ${BATCH_SIZE} 条暂停 ${BATCH_PAUSE_MIN / 1000}-${BATCH_PAUSE_MAX / 1000}s | 限流重试: ${FEED_RETRY_DELAY / 1000}s | 连续失败暂停: ${CONSECUTIVE_FAIL_PAUSE / 1000}s`);
  if (START_FROM_INDEX > 0) {
    log(`从第 ${START_FROM_INDEX + 1} 个关键词继续采集: "${KEYWORDS[START_FROM_INDEX]}"`);
  }
  log('====================================');

  const summary = [];

  for (let i = START_FROM_INDEX; i < KEYWORDS.length; i++) {
    const result = await collectKeyword(KEYWORDS[i], i);
    summary.push({
      keyword: KEYWORDS[i],
      notes: result.notes.length,
      details: result.details.length,
      failures: result.failures?.length || 0,
      stopped: result.stopped,
    });

    if (result.stopped) {
      log(`\n⛔ 采集被中断，已完成 ${i + 1}/${KEYWORDS.length} 个关键词`);
      log(`   下次运行（换新cookie后）: set START_INDEX=${i} && node xhs-feed-collect.js`);
      break;
    }

    // 每5个关键词刷新一次 cookies（防止长时间采集后 cookie 过期）
    if (signServerAvailable && (i + 1) % 5 === 0 && i < KEYWORDS.length - 1) {
      const freshCookies = await getBrowserCookies();
      if (freshCookies && freshCookies.a1) {
        Object.assign(COMMON_COOKIES, freshCookies);
        if (freshCookies.acw_tc) { SEARCH_ACW_TC = freshCookies.acw_tc; FEED_ACW_TC = freshCookies.acw_tc; }
        log(`  [维护] cookies 已刷新 (每5关键词)`);
      }
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
  let totalNotes = 0, totalDetails = 0, totalFailures = 0;
  for (const s of summary) {
    const status = s.stopped ? '⛔中断' : '✅完成';
    log(`  ${s.keyword}: 笔记 ${s.notes} | 成功 ${s.details} | 失败 ${s.failures} | ${status}`);
    totalNotes += s.notes;
    totalDetails += s.details;
    totalFailures += s.failures;
  }
  log('------------------------------------');
  log(`  总计: 笔记 ${totalNotes} | 成功 ${totalDetails} | 失败 ${totalFailures}`);
  log(`  关键词: ${summary.length}/${KEYWORDS.length}`);
  log('====================================');
}

main().catch(err => {
  log(`致命错误: ${err.message}`);
  console.error(err.stack);
});
