/**
 * 小红书笔记详情批量采集脚本 - Node.js（按关键词逐个采集）
 *
 * 原理（已实测验证 2026-07-10）：
 * - x-s-common 通过 xs-common-node.js 动态生成（从 vendor-dynamic.8cd1891c.js 逆向）
 * - x-s 使用静态 XYS_ 签名复用（XYW_ 动态签名触发 300015 环境检测，不可用）
 * - 搜索 API 使用静态 XYS_ 签名（请求量低，3次/关键词）
 * - 防风控：随机延迟 + sigCount 循环 + 单次会话限制 + 300015/300011 自动停止
 *
 * 流程（每关键词独立）：
 *   1. 搜索关键词获取笔记列表（含 xsec_token）
 *   2. 逐条采集笔记详情（静态 x-s + 动态 x-s-common）
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

// ======================= 签名服务配置 =======================

const SIGN_SERVER_URL = 'http://127.0.0.1:3721';
let signServerAvailable = false;  // 运行时检测

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

// ======================= 配置 =======================

const OUTPUT_DIR = path.join(__dirname, 'data');
const FEED_DIR = path.join(OUTPUT_DIR, 'feed');
if (!fs.existsSync(FEED_DIR)) fs.mkdirSync(FEED_DIR, { recursive: true });

// Cookie（用户最新提供 2026-07-10）
const COMMON_COOKIES = {
  abRequestId: '51b7063a-c933-567e-ab79-0b722391e05d',
  a1: '19c8eaa1ff3spyelsj2p2752b30l5wnu5a2iv9kfb50000150045',
  webId: 'fb35f55f1a09fd1a36a79d8c81422ae8',
  gid: 'yjSYd00qJq2yyjSYd00yi0jTiqMUvd1MVJUJJiDW2JDq832812EI7h888y288428JSSiSYD8',
  xsecappid: 'xhs-pc-web',
  ets: '1782266352362',
  'x-rednote-datactry': 'CN',
  'x-rednote-holderctry': 'CN',
  webBuild: '6.31.2',
  websectiga: '2845367ec3848418062e761c09db7caf0e8b79d132ccdd1a4f8e64a11d0cac0d',
  sec_poison_id: 'c3b96c51-a0e6-4950-a37f-9ea86486e9a1',
  loadts: '1783600265006',
  unread: '{%22ub%22:%2263f6bb200000000027010748%22%2C%22ue%22:%22640745c5000000001303ed88%22%2C%22uc%22:13}',
  web_session: '040069b8c68c0d98c54467f67a384bbf7553bd',
  id_token: 'VjEAANhwLOxSoDzPXeRVDhHelhhunlYN+dguETDo8/MplQYvOS6o8+ARuz+oPXhk1++ArPEHn0mTGMJj+yDDSu0yXVZUpELj22z+HblhCgKsW0eCHjLP/81oXGXkkst/Qf7BZIav',
};

let SEARCH_ACW_TC = '0ad6226c17836108952176343e3ad47211aef67a8af1abf13f3b33afdd42ac';
let FEED_ACW_TC = '0ad526c017835991173548419e19e9286dd6f92597046eff63a01078089887';

// Search v2 API 签名（用户最新提供，静态复用，请求量低 3次/关键词）
const SEARCH_X_S = 'XYS_2UQhPsHCH0c1PUh7HjIj2erjwjQhyoPTqBPT49pjHjIj2eHjwjQgynEDJ74AHjIj2ePjwjQTJdPIPAZlg94aGLTlGMS1JBp0nLVFPokb4emk8rQ/4BktPd+awepnGDVA2bSxGFDUy0by+7iF8o+8aobsJsTBcLpGLgSI+rl/znRhGFRS4B4O408E4LYD8rzH20Qh4Bzl2bq9cL+jJL8ycAbnzeQYP0mwGdqI8BWF8AmmPrkHaMY/admPzp49PsT+c9EIqMQCLDkcpnbLP9lt/LT/Jd4nnSk0yLLIaSQQyAmOarEaLSz+G9TNP0mPGSSO/LlizFuIqBknpAmOPaHVHdWFH0ijJ9Qx8n+FHdF=';
const SEARCH_X_S_COMMON = '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';
const SEARCH_RAP_PARAM = 'ByQBBgAAAAEAAAAUAAADBA7uh+kAACg9AAAAgQAAAAAAAAAAbGRtMHVm5gMEVov0bE2bhYIUoxcvswAAABDyKyKT8gzcsIEgeUuuY+mLJM3hRAR2zwWLFnZaozYrRNMADvYhVlZ51inm+dSfGW1hgAl2Q2pSmO/DJEDC54YwffgGkMMDZZfS62iXlc21Z3dr/8aBEU0hTjLjDgSTaS/fq5+e28qVfzfiT5r00Lktsg0VgbajLO2janG9WdgEjjnY49JF1hsbtJuUCJoE3FVPfMDGYPO+k5GSAR0nIuBeSnLOhelKZmzBuQ+HIWSDQfM+CmDsTkcfcv7zpPqA1t0vFX13BER/BN/4CHrC11l5cZOe3N5FveNVRBBI3sTBSdwVV3KGke7XN3PtwY3TU3iRd96OVQPDlD7sIUNzL9JBJjCDOyzGjWESctHmyLbPXDoZ4sIO0QNyv57ZDxeDWaJcL39mt5R6djFVw4G5SmJhWkVL75EEdeAVDn/146q+qvVUiQB1sN0+jxZlQLNeTvLLwbM/Dw8sUgWi6FO9mJEoLbaK0bgF+IjDyNcTELccJSbs9GoM8DunTs4CQAWFDTn9GAvTeYYohTcUUch9wyVtT90Z4IZW+H/kSTfFQ3pttBQ7U38XwylGtsiMruBpHHgLFM/2FNyZOIEmr7SviDPJ+ceUGKU9GGYJSE0YoovwW0O4MhtMHyVHkmBhKmTzjaILOs2OV+sGBX5o9AHgbTsotRldy1Nocpmn9s5S0YrknsdKQKK7q+Vbf4rI0DXKUAVzqzXKupOQzMBPndBwwKDiZA5zf8KeTH+FhPtsWdQn1AZ+Ql7NT9AP3E1hBaKYL9k9uZCKUogpxa8NCV5gTnwTo1wTM7s5Rnatb5Jw3g6xGHqUjDKzjQ88X4Ga4je0iL/e5ZKhC2k4VSeblyNT8YE6WTX/lwv+NBB6uq+l+SCcZU9PQg68qbdSaJdh+BWb4wno61FuJvUKGrgLg4ylFwF1iTBvpLS+HB4EFh0FbSI8eu9XpcPmHYrrRz1ida+ZZwwojEk44wRvRqltZrc3fYdVi+F4GJ2EaSv9K7YRdrRzlDsO1bbd8zBEh7hd/q4lTpoAAAL8';

// Feed API 签名（静态 XYS_ 复用，XYW_ 动态签名触发 300015 环境检测不可用）
// x-s-common 动态生成（xs-common-node.js），x-s 静态复用
const FEED_X_S = 'XYS_2UQhPsHCH0c1PUh7HjIj2erjwjQhyoPTqBPT49pjHjIj2eHjwjQgynEDJ74AHjIj2ePjwjQTJdPIPAZlg94aGLTlLnkyq0SNafzrPoSb4emk8rQ/4BktPd+awepnLsRx2bSxGFDUy0bA+FDF8eYB4043P74LJ0G6LgSI+rl/znRhGFRS4B4O408E4LYD8rzH20Qh4Bzl2bq9cL+jJL8ycAbnzeQYP0mwGdqI8BWF8AmmPrkHaMY/admPzp49PsT+c9EIqMQCLDkcpnbLP9II4DT/Jd4nnSk0yLLIaSQQyAmOarEaLSz+G0Y+PgzF2/47qn4HN7PFzfTSPgkNLsHVHdWFH0ijJ9Qx8n+FHdF=';
const FEED_RAP_PARAM = 'ByQBBAAAAAEAAAAUAAACBOsMpU8AACg9AAAAWQAAAAAAAAAAcml4MyvJPwHgP2jn0gq16EBy9aIAAAAQDEEmGkLCeWXD8u+orGeQxznZqvBugRo6CpWDktlqsJ5Ebl19XyGrFRx8qMk7Xwlu7fZQbYkNppIdK/JwugOheNA/2jN8OJq9q+6fLH6CwNeTC8qF3pHkq+0AjPX7Pi30dNRN2rtiQ/V9ziwKZnG/ZC3Ttm8WkHW1XbwhIvBvFbTCZbGUD8aP5EEM9L6dLKZhUgpoE0sf3e5Vbkjz3IM+6USLr17NqJo8bfYdaHWU80zbPD6Dymw2ao6MvYqxiH56mtO5ROhzp9d1niWexlJiOnbVUkxPkhjazKrZP+1f+NOaO0VBtsDTj8ztlPAzEfwaH+RTr1sFpIOvTNE/LWCm/xUS4UI1ZSyhbWMo8e1pCR5AThFIAgNSOqfRzi9tzHQa9zOyyio8iHWQWthlGYq89tVTjvkENmWjJC8EIjCCZ98Y630t+l/uAHXG42Qxi0yBKUeEBLMoW7IcAbKgZjJVJvkWP2dO+8O9NgqvW9bRaoBB+RgeujtI90uBhmdQ+AOS0jNoApEg9CmOOh4g9v8yFsIidbu+i/gwshsfRhBmm3PpROlRFy3Mj9EkSCdYeGkuzElWafMdPuR2kw7L0cy3gVPVxRryjmtQI5GXyyoHSBIdavEdDnP4tUK2XOecbtTzQoGr1rgPZfU7d8Qf2NG8vn2P15XeKp+pAkj4/gQMqDMAAAIA';

const KEYWORDS = [
  '美食', '旅游', '穿搭', '护肤', '健身',
  '家居', '数码', '摄影', '读书', '电影',
  '音乐', '游戏', '职场', '考研', '留学',
  '宠物', '育儿', '婚礼', '装修', '理财',
];

// 从第几个关键词开始采集（用于断点续采）
const START_FROM_INDEX = process.env.START_INDEX ? parseInt(process.env.START_INDEX) : 0;

const PAGES_PER_KEYWORD = 3;
const PAGE_SIZE = 20;
const SEARCH_DELAY = 1000;
const FEED_DELAY_MIN = 4000;      // 详情采集最小间隔
const FEED_DELAY_MAX = 7000;      // 详情采集最大间隔（随机抖动）
const FEED_RETRY_DELAY = 10000;   // 限流重试等待
const KEYWORD_PAUSE_MIN = 15000;  // 关键词间最小暂停
const KEYWORD_PAUSE_MAX = 30000;  // 关键词间最大暂停（随机抖动）
const MAX_KEYWORDS_PER_SESSION = 5; // 单次最多采集关键词数（防风控）

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

function fetchSearch(keyword, page) {
  const body = {
    keyword, page, page_size: PAGE_SIZE,
    search_id: randomId(21), sort: 'general', note_type: 0,
    ext_flags: [], geo: '', image_formats: ['jpg', 'webp', 'avif'],
    message_id: 'sending', session_id: genSessionId(),
  };
  return httpPost('so.xiaohongshu.com', '/api/sns/web/v2/search/notes', {
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
    'x-s': SEARCH_X_S, 'x-s-common': SEARCH_X_S_COMMON,
    'x-t': String(Date.now()), 'x-xray-traceid': randomHex(16),
  }, JSON.stringify(body));
}

// ======================= Feed 详情 API =======================

// sigCount 模拟真实浏览器的签名计数（保持在低值，避免被风控检测）
let feedSigCount = Math.floor(Math.random() * 5) + 1; // 起始 1-5

function fetchFeed(noteId, xsecToken) {
  const body = {
    source_note_id: noteId,
    image_formats: ['jpg', 'webp', 'avif'],
    extra: { need_body_topic: '1' },
    xsec_source: 'pc_search',
    xsec_token: xsecToken,
  };

  const bodyStr = JSON.stringify(body);

  // sigCount 递增但不无限增长（模拟真实浏览器，偶尔重置）
  feedSigCount++;
  if (feedSigCount > 30) feedSigCount = Math.floor(Math.random() * 5) + 1; // 到30后重置

  // 动态生成 x-s-common（纯 Node.js 算法，每次请求唯一）
  const dynamicXsc = generateXsCommon({
    platform: 'PC',
    url: '/api/sns/web/v1/feed',
    cookieA1: COMMON_COOKIES.a1,
    fingerprint: '',
    version: '4.3.7',
    dsl: '',
    sigCount: feedSigCount,
  });

  // 优先使用签名服务生成动态 XYW_ 签名（真实浏览器环境，不会触发 300015）
  // 回退到静态 XYS_ 签名（签名服务不可用时）
  return (async () => {
    let xS = FEED_X_S;
    let xT = String(Date.now());
    let xSc = dynamicXsc;

    if (signServerAvailable) {
      try {
        const dynSign = await getDynamicSign('/api/sns/web/v1/feed', bodyStr);
        if (dynSign.ok) {
          xS = dynSign.sign['X-s'];
          xT = dynSign.sign['X-t'] || xT;
          // 签名服务可能也返回 x-s-common，优先使用
          if (dynSign.sign['X-s-common']) {
            xSc = dynSign.sign['X-s-common'];
          }
        } else {
          log(`  [签名] 动态签名失败，回退静态: ${dynSign.error}`);
        }
      } catch (e) {
        log(`  [签名] 签名服务异常，回退静态: ${e.message}`);
      }
    }

    return httpPost('edith.xiaohongshu.com', '/api/sns/web/v1/feed', {
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
      'x-s-common': xSc,
      'x-t': xT, 'x-xray-traceid': randomHex(16),
      'xy-direction': '18',
    }, bodyStr);
  })();
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
      if (resp.code === -100) { log(`  ⛔ Cookie被标记！`); return { notes: [], details: [], stopped: true }; }
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
      log(`  [详情] ${i + 1}/${notes.length} 限流，等待 ${FEED_RETRY_DELAY}ms 重试...`);
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
          log(`  [详情] 连续 ${consecutiveFail} 次失败，暂停 15s`);
          await sleep(15000);
          consecutiveFail = 0;
        }
      }
    } else if (resp.code === -100) {
      log(`  ⛔ Cookie被标记！停止采集`);
      return { notes, details, failures, stopped: true };
    } else if (resp.code === 300011 && resp.msg && resp.msg.includes('账号异常')) {
      // 300011 + "账号异常" = 账号被风控，必须停止
      log(`  ⛔ 账号被风控（账号异常）！停止采集`);
      return { notes, details, failures, stopped: true };
    } else if (resp.code === 300015) {
      // 300015 = 环境检测，必须停止
      log(`  ⛔ 触发环境检测（300015）！停止采集`);
      return { notes, details, failures, stopped: true };
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
  log(`搜索API: so.xiaohongshu.com v2 (静态 XYS_ 签名)`);
  if (signServerAvailable) {
    log(`详情API: edith.xiaohongshu.com feed (动态 XYW_ 签名 via 签名服务)`);
    log(`  签名服务: ${SIGN_SERVER_URL} ✅ 已连接`);

    // 从浏览器获取最新 cookies，覆盖硬编码值（确保签名与 cookie 匹配）
    const browserCookies = await getBrowserCookies();
    if (browserCookies && browserCookies.a1) {
      Object.assign(COMMON_COOKIES, browserCookies);
      log(`  浏览器 cookies 已同步 (a1: ${COMMON_COOKIES.a1.substring(0, 15)}...)`);

      // 同时更新 acw_tc（浏览器中可能有不同的值）
      if (browserCookies.acw_tc) {
        SEARCH_ACW_TC = browserCookies.acw_tc;
        FEED_ACW_TC = browserCookies.acw_tc;
        log(`  acw_tc 已同步: ${browserCookies.acw_tc.substring(0, 20)}...`);
      }
    } else {
      log(`  ⚠️ 无法获取浏览器 cookies，使用硬编码值（可能导致签名不匹配）`);
    }
  } else {
    log(`详情API: edith.xiaohongshu.com feed (静态 XYS_ x-s + 动态 x-s-common)`);
    log(`  签名服务: ${SIGN_SERVER_URL} ❌ 未连接（回退静态签名）`);
  }
  log(`详情间隔: ${FEED_DELAY_MIN}-${FEED_DELAY_MAX}ms (随机) | 关键词间: ${KEYWORD_PAUSE_MIN}-${KEYWORD_PAUSE_MAX}ms (随机)`);
  log(`单次最多: ${MAX_KEYWORDS_PER_SESSION} 个关键词`);
  if (START_FROM_INDEX > 0) {
    log(`从第 ${START_FROM_INDEX + 1} 个关键词继续采集: "${KEYWORDS[START_FROM_INDEX]}"`);
  }
  log('====================================');

  const summary = [];
  let sessionCount = 0;

  for (let i = START_FROM_INDEX; i < KEYWORDS.length; i++) {
    if (sessionCount >= MAX_KEYWORDS_PER_SESSION) {
      log(`\n⚠️ 已达到单次最多 ${MAX_KEYWORDS_PER_SESSION} 个关键词限制，停止采集`);
      log(`   下次运行: set START_INDEX=${i} && node xhs-feed-collect.js`);
      break;
    }

    const result = await collectKeyword(KEYWORDS[i], i);
    sessionCount++;
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

    if (i < KEYWORDS.length - 1 && sessionCount < MAX_KEYWORDS_PER_SESSION) {
      const pauseMs = randomDelay(KEYWORD_PAUSE_MIN, KEYWORD_PAUSE_MAX);
      log(`\n  关键词间暂停 ${pauseMs}ms...`);
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
