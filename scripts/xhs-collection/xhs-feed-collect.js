/**
 * 小红书笔记详情批量采集脚本 - Node.js（按关键词逐个采集）
 *
 * 原理（已实测验证 2026-07-10）：
 * - x-s-common 通过 xs-common-node.js 动态生成（从 vendor-dynamic.8cd1891c.js 逆向）
 * - feed API 的 x-s 可跨 note_id 静态复用（不绑定请求体）
 * - x-s-common 动态生成不绑定 note_id，可批量使用
 * - 需要从搜索结果中获取 noteId + xsec_token
 *
 * 流程（每关键词独立）：
 *   1. 搜索关键词获取笔记列表（含 xsec_token）
 *   2. 逐条采集笔记详情（动态 x-s-common）
 *   3. 保存到独立 JSON 文件并输出结果
 *   4. 进入下一关键词
 *
 * 使用方法：
 *   node xhs-feed-collect.js
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { generateXsCommon } = require('./xs-common-node');

// ======================= 配置 =======================

const OUTPUT_DIR = path.join(__dirname, 'data');
const FEED_DIR = path.join(OUTPUT_DIR, 'feed');
if (!fs.existsSync(FEED_DIR)) fs.mkdirSync(FEED_DIR, { recursive: true });

// Cookie（err.json 2026-07-10 最新更新）
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
  websectiga: 'f47eda31ec99545da40c2f731f0630efd2b0959e1dd10d5fedac3dce0bd1e04d',
  sec_poison_id: 'f39f49d3-1c96-4876-8db3-796f031a3dc0',
  loadts: '1783600265006',
  unread: '{%22ub%22:%2263f6bb200000000027010748%22%2C%22ue%22:%22640745c5000000001303ed88%22%2C%22uc%22:13}',
  web_session: '040069b8c9d7189e86b4a8dc7a384be8270a74',
  id_token: 'VjEAAHrHkdJRYgusy2J/qh4zmeQwLq6eb5OPExos3UDrNjxy90fYs+tqCrq/Bf+N8CL5be6nPGLvRKfaubZm3obtZfKBg8T4QGkP2V9DfsE51Kp8LHu/hjBYR9VMyAUnpP2nxQvX',
};

const SEARCH_ACW_TC = '0ad5824917835991233158528ecdef7e72b9deb45464b8525c7c94912e1ec4';
const FEED_ACW_TC = '0ad526c017835991173548419e19e9286dd6f92597046eff63a01078089887';

// Search v2 API 签名（err.json 最新）
const SEARCH_X_S = 'XYS_2UQhPsHCH0c1PUh7HjIj2erjwjQhyoPTqBPT49pjHjIj2eHjwjQgynEDJ74AHjIj2ePjwjQTJdPIPAZlg94aGLTl4/clG7pIq9+IPoSb4emk8rQ/4BktPd+awepnLf4x2bSxGFDUyfEl+9DF8rhhGM4zzFMFygW6LgSI+rl/znRhGFRS4B4O408E4LYD8rzH20Qh4Bzl2bq9cL+jJL8ycAbnzeQYP0mwGdqI8BWF8AmmPrkHaMY/admPzp49PsT+c9EIqMQCLDkcpnbLP9I7JFT/Jd4nnSk0yLLIaSQQyAmOarEaLSz+qDTIwr8i/0pPzFhMPBQOJni7GUVIcaHVHdWFH0ijJ9Qx8n+FHdF=';
const SEARCH_X_S_COMMON = '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';
const SEARCH_RAP_PARAM = 'ByQBBQAAAAEAAAAUAAAB9OS6Cu4AACg9AAAAWwAAAAAAAAAAYnR5YTmRgQzEEdDHolc9of5S9mocAAAAEJCtqtFAtxDyaK41SnxqryqcO/hGDxX4gvjSZ397WyctvQwOAly2WqI5TNziShRiwof7o49UoCwBjdWWgoACeaadAvVdYISz8lOaAcqj6qzGK59p5eqhfpZ3ig4pYp2itSWMK3W+Cqrfvnbm9ZXnxU/E9O4/r9+L/Wos708kU8UUSmKJbXxuFrtDuzETMh7YNeL3oK5wzFz+05wp2inrHUYH4cSwUv0FdEsAebIkya7gL4pI5PnmdYIKXR6TA4LRkNvrK6CiwpNZSRzeFlFUtCTaeq6DkLUTKGUyUvggjIuzb46JmQWyT1aA/5xlo9l/u4rz7FjTexAMdr6CNQbjOu/5HcF7KmTVfKI/cMAqHbY71ktpTGoP4srpC19T9jn4r4Zuv4lkePAh3vG+Wr3U37zXnqP3bygD7vZhj531Ap1fTQ81MvZevwBKfNY4wI7Rdez46Lgy3yDJ+uZk/bOpXVig//43Y8GMNlnvSsrrZUTXqSKr7WJIqSTRrkR6uns/0LrgFogspudb7x07nGOCuxkAo3PlaWNBbxOyXzkwpytmxiNyUjXlEv+zkRRQmrTH8UX0Fj7SMXz4YNHcqsNlA2rfmn2Aa+gMQgz62tcC6zyyojeMiHXN5LyGtTiuCwk+wOw3Bo1ozYl5UAMr7H/xIQAAAAHo';

// Feed API 签名（err.json 最新，x-s 可跨 note_id 静态复用）
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
const FEED_DELAY = 3500;          // 详情采集间隔（增大避免限流）
const FEED_RETRY_DELAY = 8000;    // 限流重试等待
const KEYWORD_PAUSE = 5000;       // 关键词间暂停

// ======================= 工具函数 =======================

function log(msg) { console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
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

let feedSigCount = 0;

function fetchFeed(noteId, xsecToken) {
  const body = {
    source_note_id: noteId,
    image_formats: ['jpg', 'webp', 'avif'],
    extra: { need_body_topic: '1' },
    xsec_source: 'pc_search',
    xsec_token: xsecToken,
  };

  feedSigCount++;
  const dynamicXsc = generateXsCommon({
    platform: 'PC',
    url: '/api/sns/web/v1/feed',
    cookieA1: COMMON_COOKIES.a1,
    fingerprint: '',
    version: '4.3.7',
    dsl: '',
    sigCount: feedSigCount,
  });

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
    'x-s': FEED_X_S,
    'x-s-common': dynamicXsc,
    'x-t': String(Date.now()), 'x-xray-traceid': randomHex(16),
    'xy-direction': '18',
  }, JSON.stringify(body));
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
      await sleep(SEARCH_DELAY * 2);
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
    await sleep(SEARCH_DELAY);
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
    } else if (resp.code === -510000 || resp.code === 300031) {
      // 笔记不存在或已下架
      fail++;
      failures.push({ noteId: note.noteId, xsecToken: note.xsecToken, code: resp.code, msg: resp.msg || (resp.code === -510000 ? '笔记不存在' : '笔记已下架') });
    } else {
      log(`  [详情] ${note.noteId}: code=${resp.code} msg=${resp.msg || ''}`);
      fail++;
      failures.push({ noteId: note.noteId, xsecToken: note.xsecToken, code: resp.code, msg: resp.msg || '未知错误' });
    }

    await sleep(FEED_DELAY);
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
  log('====================================');
  log('小红书笔记详情批量采集（按关键词）');
  log(`搜索API: so.xiaohongshu.com v2`);
  log(`详情API: edith.xiaohongshu.com feed`);
  log(`x-s-common: 动态生成 (xs-common-node.js)`);
  log(`详情间隔: ${FEED_DELAY}ms | 关键词间暂停: ${KEYWORD_PAUSE}ms`);
  log(`关键词数量: ${KEYWORDS.length}`);
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
      log(`\n⛔ 采集被中断（Cookie标记或签名失效），已完成 ${i + 1}/${KEYWORDS.length} 个关键词`);
      break;
    }

    if (i < KEYWORDS.length - 1) {
      log(`\n  关键词间暂停 ${KEYWORD_PAUSE}ms...`);
      await sleep(KEYWORD_PAUSE);
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
