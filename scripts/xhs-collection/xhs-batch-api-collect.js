/**
 * 小红书批量采集脚本 - Node.js v2 API 静态签名复用方式
 *
 * 原理（已实测验证 2026-07-10）：
 * - 必须使用 so.xiaohongshu.com + v2 API（v1/edith 会导致 cookie 被标记）
 * - 必须包含全部浏览器请求头（x-b3-traceid, x-rap-param, x-xray-traceid 等）
 * - body 必须包含 message_id 字段
 * - x-s 和 x-s-common 不与请求体绑定，可跨关键词/页码复用
 * - x-s 仅与 API 路径绑定（search 签名不能用于 feed）
 * - x-t 时间戳不严格校验
 *
 * 使用方法：
 *   node xhs-batch-api-collect.js
 *
 * 输出：
 *   xhs_1_美食.json ~ xhs_20_理财.json  （每关键词独立文件）
 *   xhs_all_summary.json                （汇总）
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// ======================= 配置 =======================

const OUTPUT_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Cookie（从浏览器抓包 - 2026-07-10 最新，err.json）
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
  websectiga: '82e85efc5500b609ac1166aaf086ff8aa4261153a448ef0be5b17417e4512f28',
  sec_poison_id: '2a778af3-b0cf-4fda-ae8a-b64e5632a210',
  loadts: '1783596658374',
  unread: '{%22ub%22:%226a25ff08000000001603c717%22%2C%22ue%22:%226a2e042c000000002101795c%22%2C%22uc%22:23}',
  web_session: '040069b8c68c0d98c544b4ce7a384b60d5f34d',
  id_token: 'VjEAAJ/XA6IgW/1nQzMiQ6iM9towpAVlj7W7tNXxjZw/LBodGKpnjWQahRzpUoWD+1wQMEknql4we9GRIbCy1FF0s+7smW1Yl7xJBoHm5cQ3XArPclGWhuAmhAJ+5e8CIj5JnOuB',
};

// acw_tc 是 host 专用的
const SEARCH_ACW_TC = '0a4a655417835962396674538eb4db668fe11c1e5aa279bbf9b55311639da4'; // so.xiaohongshu.com

// 从浏览器抓包的 search v2 API 签名（可复用 - 2026-07-10 err.json）
const SEARCH_X_S = 'XYS_2UQhPsHCH0c1PUh7HjIj2erjwjQhyoPTqBPT49pjHjIj2eHjwjQgynEDJ74AHjIj2ePjwjQTJdPIPAZlg94aGLTl87pI4nzNp0mQN7Sb4emk8epYPnpcPd+awepn4e4x2bSxzFDUyfE0+7iF8e+PpB4YPAYH4pi7LgSI+rl/znRhGFRS4B4O408E4LYD8rzH20Qh4Bzl2bq9cL+jJL8ycAbnzeQYP0mwGdqI8BWF8AmmPrkHaMY/admPzp49PsT+c9EIqMQCLDkcpnbLP9lb8LT/Jd4nnfl0yLLIaSQQyAmOarEaLSz+GUTCyDpNGASB/e4NL9GIq7YEaFrlajHVHdWFH0ijJ9Qx8n+FHdF=';
const SEARCH_X_S_COMMON = '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';

// x-rap-param（从 err.json 抓包，search 请求）
const SEARCH_RAP_PARAM = 'ByQBBAAAAAEAAAAUAAACNEpO834AACg9AAAAYAAAAAAAAAAAd2duMMTW3yXmOPhj6PBWqFJl2LgAAAAQ6XL/zSJ6qPHlI4WZNLr1O4MooJen1ZALSrFQReMiCsf83alH5prlvL0qQgnFpSNQJGwNMJ3GXPtHTm1v/Mq+yEN/cu7l3wbspc4lvAf1CdUqG242eLZMSEMtNqLtn2XZhel7Ps0eyonsjZ4bcUarP5VRFFoMgca5Yq0YOFFe0yMmUmURyCkRrYunpjt6GlHeTiwIgfhdXO7LBMexo1QNNXA8p29afgsWP+mlhbcbZvCkoroAS01HGon18JUZ5XFYuQzfCi5yS3Xq3wdefb697HOx+tSALHxGMNkYOnnTg1M3Vd0nS8MHIGZVb1V9RQH81zx4CGmJSeX3o9SVLEt61K2hxeZUEZ8PYzLekmTxTUbqBm6wNykkmCBOApMgXP69P3Fry9UXKGbtESyP7bDm5JKRiklyYpD1TbGg5UDoAFooRfENuSHHoXbOzAnlkLwB0jliOf1HKC91yMXgewgLL3qWNYEvy79T9toyOP1yUL5Brf7yVp23tFL547Zu6dsaxJY+l4BgUKlqxvMbvOFGK5bWOR8pDLgwDWd+vKN5a2b7+J5DyJiFCF266MTBmAPHwA45zFiradMYeTxgVqJ9peGLCzIDagkPb4f1PKtufRP8W3RKLuR8c+F28gC12t5evt2aye9qzInxLzcHmNA8rXgBfM82BFPbXBIntTF4KVEOSgIb4YjhI7VvDQo/9cznJP/kKij+Pq/47yRbkEVJKu/W+GyUILBkfEFWPbocPfQAAAIi';

// 20 个关键词
const KEYWORDS = [
  '美食', '旅游', '穿搭', '护肤', '健身',
  '家居', '数码', '摄影', '读书', '电影',
  '音乐', '游戏', '职场', '考研', '留学',
  '宠物', '育儿', '婚礼', '装修', '理财',
];

const PAGES_PER_KEYWORD = 3;
const PAGE_SIZE = 20;
const DELAY_MS = 800;
const SEARCH_HOST = 'so.xiaohongshu.com';
const SEARCH_PATH = '/api/sns/web/v2/search/notes';

// ======================= 工具函数 =======================

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomHex(len) {
  return crypto.randomBytes(len).toString('hex');
}

function buildCookieHeader(acwTc) {
  const all = { ...COMMON_COOKIES, acw_tc: acwTc };
  return Object.entries(all).map(([k, v]) => `${k}=${v}`).join('; ');
}

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

function buildSearchBody(keyword, page) {
  return {
    keyword,
    page,
    page_size: PAGE_SIZE,
    search_id: randomId(21),
    sort: 'general',
    note_type: 0,
    ext_flags: [],
    geo: '',
    image_formats: ['jpg', 'webp', 'avif'],
    message_id: 'sending',
    session_id: genSessionId(),
  };
}

// ======================= HTTP 请求 =======================

function fetchSearch(keyword, page) {
  const body = buildSearchBody(keyword, page);
  const bodyStr = JSON.stringify(body);

  const headers = {
    'accept': 'application/json, text/plain, */*',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json;charset=UTF-8',
    'cookie': buildCookieHeader(SEARCH_ACW_TC),
    'origin': 'https://www.xiaohongshu.com',
    'priority': 'u=1, i',
    'referer': 'https://www.xiaohongshu.com/',
    'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'x-b3-traceid': randomHex(8),
    'x-rap-param': SEARCH_RAP_PARAM,
    'x-s': SEARCH_X_S,
    'x-s-common': SEARCH_X_S_COMMON,
    'x-t': String(Date.now()),
    'x-xray-traceid': randomHex(16),
  };

  return new Promise((resolve) => {
    const req = https.request({
      hostname: SEARCH_HOST,
      port: 443,
      path: SEARCH_PATH,
      method: 'POST',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        try {
          let text;
          if (encoding === 'gzip') {
            text = zlib.gunzipSync(buf).toString();
          } else if (encoding === 'br') {
            text = zlib.brotliDecompressSync(buf).toString();
          } else if (encoding === 'deflate') {
            text = zlib.inflateSync(buf).toString();
          } else {
            text = buf.toString();
          }
          const json = JSON.parse(text);
          resolve(json);
        } catch (e) {
          resolve({ code: -999, msg: 'parse error: ' + e.message, raw: buf.toString().substring(0, 200) });
        }
      });
    });

    req.on('error', e => resolve({ code: -998, msg: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ code: -997, msg: 'timeout' }); });
    req.setTimeout(20000);
    req.write(bodyStr);
    req.end();
  });
}

// ======================= 单关键词采集 =======================

async function collectKeyword(keyword, index) {
  log(`[${index + 1}/${KEYWORDS.length}] 开始采集: "${keyword}"`);

  const result = {
    keyword,
    index: index + 1,
    collectedAt: new Date().toISOString(),
    pages: [],
    noteIds: [],
    notes: [],
    errors: [],
  };

  for (let page = 1; page <= PAGES_PER_KEYWORD; page++) {
    log(`  第 ${page} 页...`);

    const resp = await fetchSearch(keyword, page);

    if (resp.code !== 0) {
      log(`  ❌ 错误: code=${resp.code} msg=${resp.msg || resp.message || ''}`);
      result.errors.push({ page, code: resp.code, msg: resp.msg || resp.message });

      // 300011 = 签名失效，停止该关键词
      if (resp.code === 300011) {
        log(`  ⛔ 签名失效，停止采集`);
        break;
      }
      await sleep(DELAY_MS * 2);
      continue;
    }

    const items = resp.data?.items || [];
    log(`  ✅ 获取 ${items.length} 条`);

    const pageNotes = items.map(item => {
      const nc = item.note_card || {};
      const noteId = item.id || nc.note_id;
      if (noteId && !result.noteIds.includes(noteId)) {
        result.noteIds.push(noteId);
      }
      return {
        noteId,
        title: nc.display_title || '',
        type: nc.type || '',
        cover: nc.cover?.url || '',
        user: {
          userId: nc.user?.user_id || '',
          nickname: nc.user?.nickname || '',
          avatar: nc.user?.avatar || '',
        },
        likedCount: nc.interact_info?.liked_count || '0',
        xsecToken: item.xsec_token || nc.xsec_token || '',
      };
    });

    result.pages.push({ page, count: items.length, hasMore: resp.data?.has_more });
    result.notes.push(...pageNotes);

    await sleep(DELAY_MS);
  }

  result.totalNotes = result.notes.length;
  result.totalPages = result.pages.length;

  // 立即保存到独立文件
  const safeName = keyword.replace(/[\/\\:*?"<>|]/g, '_');
  const filePath = path.join(OUTPUT_DIR, `xhs_${index + 1}_${safeName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf8');
  log(`  💾 已保存: ${filePath} (${result.totalNotes} 条笔记)`);

  return result;
}

// ======================= 主流程 =======================

async function main() {
  log('====================================');
  log('小红书批量采集 - v2 API 静态签名复用');
  log(`API: ${SEARCH_HOST}${SEARCH_PATH}`);
  log(`关键词: ${KEYWORDS.length} 个 × ${PAGES_PER_KEYWORD} 页`);
  log(`输出目录: ${OUTPUT_DIR}`);
  log('====================================\n');

  // 先测试签名是否有效
  log('测试签名有效性...');
  const testResp = await fetchSearch(KEYWORDS[0], 1);
  if (testResp.code !== 0) {
    log(`❌ 签名无效! code=${testResp.code} msg=${testResp.msg || ''}`);
    log('请重新从浏览器抓包获取 x-s 和 x-s-common');
    process.exit(1);
  }
  log(`✅ 签名有效，测试返回 ${testResp.data?.items?.length || 0} 条结果\n`);

  // 采集所有关键词
  const summary = {
    startTime: new Date().toISOString(),
    keywords: [],
    totalNotes: 0,
    totalErrors: 0,
  };

  for (let i = 0; i < KEYWORDS.length; i++) {
    const safeName = KEYWORDS[i].replace(/[\/\\:*?"<>|]/g, '_');
    const filePath = path.join(OUTPUT_DIR, `xhs_${i + 1}_${safeName}.json`);

    // 断点续传：跳过已完成的
    if (fs.existsSync(filePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (existing.totalNotes > 0) {
          log(`[${i + 1}/${KEYWORDS.length}] 跳过已完成: "${KEYWORDS[i]}" (${existing.totalNotes} 条)`);
          summary.keywords.push({
            index: i + 1,
            keyword: KEYWORDS[i],
            totalNotes: existing.totalNotes,
            totalPages: existing.totalPages,
            errorCount: existing.errors?.length || 0,
            file: `xhs_${i + 1}_${safeName}.json`,
            skipped: true,
          });
          summary.totalNotes += existing.totalNotes;
          summary.totalErrors += existing.errors?.length || 0;
          continue;
        }
      } catch (e) { /* 文件损坏，重新采集 */ }
    }

    const result = await collectKeyword(KEYWORDS[i], i);

    summary.keywords.push({
      index: i + 1,
      keyword: KEYWORDS[i],
      totalNotes: result.totalNotes,
      totalPages: result.totalPages,
      errorCount: result.errors.length,
      file: `xhs_${i + 1}_${safeName}.json`,
    });
    summary.totalNotes += result.totalNotes;
    summary.totalErrors += result.errors.length;

    // 关键词间间隔
    if (i < KEYWORDS.length - 1) {
      await sleep(DELAY_MS * 2);
    }
  }

  summary.endTime = new Date().toISOString();

  // 保存汇总
  const summaryPath = path.join(OUTPUT_DIR, 'xhs_all_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  log('\n====================================');
  log(`采集完成!`);
  log(`总笔记数: ${summary.totalNotes}`);
  log(`总错误数: ${summary.totalErrors}`);
  log(`汇总文件: ${summaryPath}`);
  log(`数据目录: ${OUTPUT_DIR}`);
  log('====================================');
}

main().catch(err => {
  log(`致命错误: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
