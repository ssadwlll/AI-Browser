/**
 * 小红书批量采集脚本 - 简化版（使用静态签名）
 *
 * 不依赖 mnsv2-node.js，直接使用从浏览器抓取的签名
 *
 * 使用方法：
 *   node xhs-simple-collect.js
 *
 * 输出：
 *   xhs-result-{timestamp}.json
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ======================= 配置 =======================

// 从 err.json 提取的完整 Cookie
const COOKIE_STR = `a1=19c8eaa1ff3spyelsj2p2752b30l5wnu5a2iv9kfb50000150045; web_session=040069b8c68c0d98c544fd1e7a384ba32e8a77; websectiga=3fff3a6f9f07284b62c0f2ebf91a3b10193175c06e4f71492b60e056edcdebb2; sec_poison_id=c2041106-952d-40f3-97d1-db878b2d78ed; xsecappid=xhs-pc-web; id_token=VjEAALHVKw2uDAUtEobauiEEOOd91R1IOD975NtDb47ll2HQQpXo6Rud6LmXt3IKD3lSYcYH0HGldA92lOjwzRiW19quWzVyE+Yp7whj2vxyrNoQmAO8umsCH2viCrfN6KqUAAxD; acw_tc=0ad621c117835890362815992e2db785c076b3b4c48f5bd8b087772d74d03c; gid=yjSYd00qJq2yyjSYd00yi0jTiqMUvd1MVJUJJiDW2JDq832812EI7h888y288428JSSiSYD8; webId=fb35f55f1a09fd1a36a79d8c81422ae8; abRequestId=51b7063a-c933-567e-ab79-0b722391e05d; loadts=1783589035633`;

// 从 err.json 提取的签名
const X_S_SEARCH = 'XYS_2UQhPsHCH0c1PUh7HjIj2erjwjQhyoPTqBPT49pjHjIj2eHjwjQgynEDJ74AHjIj2ePjwjQTJdPIPAZlg94aGLTlLn8x+oQGzSm+noSb4emk8rc6498tPd+awepn4jRx2bSxqLDUy0bP+7iF8riI2fSdwo8FJ9TrLgSI+rl/znRhGFRS4B4O408E4LYD8rzH20Qh4Bzl2bq9cL+jJL8ycAbnzeQYP0mwGdqI8BWF8AmmPrkHaMY/admPzp49PsT+c9EIqMQCLDkcpnbLP9II2rT/Jd4nnfl0yLLIaSQQyAmOarEaLSz+qD8TaMzmaozb/A+jcLl1+SYc2bDUzaHVHdWFH0ijJ9Qx8n+FHdF=';

const X_S_COMMON = '2UQAPsHC+aIjqArjwjHjNsQhPsHCH0rjNsQhPaHCH0c1PUh7HjIj2eHjwjQgynEDJ74AHjIj2ePjwjQhyoPTqBPT49pjHjIj2ecjwjH9N0PIN0ZjNsQh+aHCH0rEGAYSGnrl8fGAq7mE8nlAy0QIP0qMPfHAPBIM49EM+nrUygGEy98j+/ZIPeZl+/ZI+eLjNsQh+jHCHjHVHdW7H0ijHjIj2eWjwjQQPAYUaBzdq9k6qB4Q4fpA8b878FSet9RQzLlTcSiM8/+n4MYP8F8LagY/P9Ql4FpUzfpS2BcI8nT1GFbC/L88JdbFyrSiafprwLMra7pFLDDAa7+8J7QgabmFz7Qjp0mcwp4fanD68p40+fp8qgzELLbILrDA+9p3JpH9LLI3+LSk+d+DJfRSL98lnLYl49IUqgcMc0mrJFShtMmozBD6qM8FyFSh8o+h4g4U+obFyLSi4nbQz/+SPFlnPrDApSzQcA4SPopFJeQmzBMA/o8Szb+NqM+c4ApQzg8Ayp8FaDRl4AYs4g4fLomD8pzBpFRQ2ezLanSM+Skc47Qc4gcMag8VGLlj87PAqgzhagYSqAbn4FYQy7pTanTQ2npx87+8NM4L89L78p+l4BL6ze4AzB+IygmS8Bp8qDzFaLP98Lzn4AQQzLEAL7bFJBEVL7pwyS8Fag868nTl4e+0n04ApfuF8FSbL7SQyrpt/f40pLShJpmO2fM6anS0nBpc4F8Q4fS9PDQmqFzC+7+hpdzDagG98nc7+9p8ydpnaLpmq9S82f87pd4QanW98nSYPoP9qf4Apob7/7Qd4d+g4gzeagYkqDlY89LIqgzm/eS6qM4n4FRQ2Blda/+ILFQc4FRCLo41cfknPDk+Po+xPrRA+dpF8FSb+fprp/8A2oml4DS9+np3y0pS8dka2LSea7PI4g4Tag8V2g4c4Flwpdc9a/+O8nSM4BzQy/4ApS8FnLSiN7+8qgz/z7b72g+n4FzQ4DS3ag88J74p/L8t20+SPgp7yrSi4n+QyAmS8op7JMkyy7zspg8AyDbzzrS3wsTwqg4PGM8FLDS9J7+84gq34rS6qAb/4fp3qD4waLptqM8f/9LAqgzI/b87qLS94fpfpd4aanS68nTAqDlQPA4SzeSN8p4n4bQQPA4A2op7p/zSLLEQzLW3agG7q7Y++dPlpAFRHjIj2eDjwjFUP/cIPeHF+ArMNsQhP/Zjw0ZVHdWlPaHCHfE6qfMYJsHVHdWlPjHCH0r7wePMweDIPALEP0DvP/qhPeLF+eGE+/rFPjQR';

// 搜索关键词（先测试 3 个）
const KEYWORDS = ['美食', '旅游', '穿搭'];

// 每个关键词采集 1 页（先测试）
const PAGES_PER_KEYWORD = 1;

// API 端点
const API_HOST = 'so.xiaohongshu.com';  // 使用 so 域名（v2 接口）
const SEARCH_PATH = '/api/sns/web/v2/search/notes';

// ======================= 工具函数 =======================

function randomId(length = 21) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function generateSearchBody(keyword, page) {
  return {
    keyword,
    page,
    page_size: 20,
    search_id: randomId(21),
    sort: 'general',
    note_type: 0,
    ext_flags: [],
    filters: [
      { tags: ['general'], type: 'sort_type' },
      { tags: ['不限'], type: 'filter_note_type' },
      { tags: ['不限'], type: 'filter_note_time' },
      { tags: ['不限'], type: 'filter_note_range' },
      { tags: ['不限'], type: 'filter_pos_distance' }
    ],
    geo: '',
    image_formats: ['jpg', 'webp', 'avif'],
    session_id: randomId(36)
  };
}

// ======================= HTTP 请求 =======================

function fetchApi(body) {
  const bodyStr = JSON.stringify(body);
  const timestamp = Date.now().toString();

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Content-Type': 'application/json;charset=UTF-8',
    'Cookie': COOKIE_STR,
    'Origin': 'https://www.xiaohongshu.com',
    'Referer': 'https://www.xiaohongshu.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'X-s': X_S_SEARCH,
    'X-s-common': X_S_COMMON,
    'X-t': timestamp,
    'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'x-b3-traceid': randomId(16),
    'x-xray-traceid': randomId(32),
  };

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: API_HOST,
      port: 443,
      path: SEARCH_PATH,
      method: 'POST',
      headers,
    }, (res) => {
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        
        if (encoding === 'gzip' || encoding === 'deflate' || encoding === 'br') {
          zlib.unzip(buffer, (err, decoded) => {
            if (err) {
              reject(err);
              return;
            }
            try {
              const json = JSON.parse(decoded.toString());
              resolve(json);
            } catch (e) {
              reject(new Error('JSON parse error'));
            }
          });
        } else {
          try {
            const json = JSON.parse(buffer.toString());
            resolve(json);
          } catch (e) {
            reject(new Error('JSON parse error'));
          }
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.write(bodyStr);
    req.end();
  });
}

// ======================= 主采集流程 =======================

async function collectAll() {
  console.log('=== 小红书批量采集 ===');
  console.log(`关键词: ${KEYWORDS.join(', ')}`);
  console.log(`每个关键词: ${PAGES_PER_KEYWORD} 页\n`);

  const results = {
    meta: {
      startTime: new Date().toISOString(),
      keywords: KEYWORDS,
      pagesPerKeyword: PAGES_PER_KEYWORD,
    },
    searches: [],
    errors: [],
  };

  for (const keyword of KEYWORDS) {
    console.log(`\n[采集] 关键词: ${keyword}`);
    const keywordResult = { keyword, pages: [], noteIds: [] };

    for (let page = 1; page <= PAGES_PER_KEYWORD; page++) {
      console.log(`  页码 ${page}...`);

      try {
        const body = generateSearchBody(keyword, page);
        const apiResult = await fetchApi(body);

        console.log(`  响应: code=${apiResult.code || apiResult.success}`);

        if (apiResult.code === 0 || apiResult.success) {
          const items = apiResult.data?.items || [];
          console.log(`  获取 ${items.length} 条结果`);

          keywordResult.pages.push({
            page,
            count: items.length,
            items: items.slice(0, 5).map(item => ({
              id: item.id || item.note_id,
              title: item.note_card?.display_title || '',
              user: item.note_card?.user?.nickname || '',
            })),
          });

          items.forEach(item => {
            const noteId = item.id || item.note_id;
            if (noteId) keywordResult.noteIds.push(noteId);
          });
        } else {
          console.log(`  错误: ${apiResult.msg || '未知错误'}`);
          results.errors.push({
            keyword, page,
            code: apiResult.code,
            msg: apiResult.msg,
          });
        }

        // 间隔 1 秒
        await new Promise(r => setTimeout(r, 1000));

      } catch (err) {
        console.error(`  请求失败: ${err.message}`);
        results.errors.push({ keyword, page, error: err.message });
      }
    }

    results.searches.push(keywordResult);
  }

  // 保存结果
  results.meta.endTime = new Date().toISOString();
  results.meta.totalNotes = results.searches.reduce((sum, r) => sum + r.noteIds.length, 0);

  const outputPath = path.join(__dirname, `xhs-result-${Date.now()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n保存到: ${outputPath}`);
  console.log(`总计: ${results.meta.totalNotes} 条笔记`);
  console.log(`错误: ${results.errors.length} 条`);

  return results;
}

// ======================= 入口 =======================

async function main() {
  try {
    await collectAll();
    console.log('\n=== 采集完成 ===');
  } catch (err) {
    console.error('\n[错误]', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();