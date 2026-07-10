/**
 * anti-bot-demo/public/app.js
 *
 * 客户端逻辑：签名生成 + 测试模拟 + 实时仪表盘
 */

'use strict';

const SIGN_SECRET = 'anti-bot-demo-secret-2026';
const API_URL = '/api/data';
const STATS_URL = '/api/stats';
const RESET_URL = '/api/reset';

// ======================= 签名工具 =======================

async function hmacSha256(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomNonce() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
}

function generateDeviceId() {
  return 'dev-' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 6);
}

function generateFingerprint() {
  // 模拟浏览器指纹（Canvas + UA + 屏幕）
  const ua = navigator.userAgent.substring(0, 20);
  const screen = `${screen_width()}x${screen_height()}`;
  return btoa(ua + screen + Math.random().toString(36).substring(2, 8));
}
function screen_width() { return window.screen?.width || 1920; }
function screen_height() { return window.screen?.height || 1080; }

// ======================= 测试状态 =======================

let testRunning = false;
let testAbort = false;
const deviceId = generateDeviceId();
const fingerprint = generateFingerprint();
let sigCount = Math.floor(Math.random() * 5) + 1;
let replayNonce = null; // 用于重放攻击测试

// ======================= 请求构建 =======================

async function buildRequest(mode, index) {
  const body = JSON.stringify({ action: 'query', index, timestamp: Date.now() });
  const ts = String(Date.now());

  // 根据测试模式生成不同的请求特征
  let nonce = randomNonce();
  let signature;
  let sigCountVal;
  let headers;

  switch (mode) {
    case 'human':
      // 正常用户：随机 sigCount（波动），完整头，唯一 nonce
      sigCount += Math.floor(Math.random() * 3) + 1;
      if (sigCount > 30) sigCount = Math.floor(Math.random() * 5) + 1;
      sigCountVal = sigCount;
      nonce = randomNonce();
      signature = await hmacSha256('/api/data' + body + ts + nonce, SIGN_SECRET);
      headers = fullHeaders(ts, nonce, signature, sigCountVal);
      break;

    case 'bot-rapid':
      // 高频请求：sigCount 随机但间隔极短
      sigCountVal = Math.floor(Math.random() * 30) + 1;
      nonce = randomNonce();
      signature = await hmacSha256('/api/data' + body + ts + nonce, SIGN_SECRET);
      headers = fullHeaders(ts, nonce, signature, sigCountVal);
      break;

    case 'bot-linear':
      // sigCount 线性递增：1, 2, 3, 4...
      sigCountVal = index + 1;
      nonce = randomNonce();
      signature = await hmacSha256('/api/data' + body + ts + nonce, SIGN_SECRET);
      headers = fullHeaders(ts, nonce, signature, sigCountVal);
      break;

    case 'bot-constant':
      // sigCount 恒定不变
      sigCountVal = 5;
      nonce = randomNonce();
      signature = await hmacSha256('/api/data' + body + ts + nonce, SIGN_SECRET);
      headers = fullHeaders(ts, nonce, signature, sigCountVal);
      break;

    case 'bot-replay':
      // 重放攻击：复用同一个 nonce
      if (!replayNonce) replayNonce = randomNonce();
      nonce = replayNonce;
      signature = await hmacSha256('/api/data' + body + ts + nonce, SIGN_SECRET);
      headers = fullHeaders(ts, nonce, signature, 5);
      break;

    case 'bot-noheader':
      // 缺失请求头
      sigCountVal = Math.floor(Math.random() * 20) + 1;
      nonce = randomNonce();
      signature = await hmacSha256('/api/data' + body + ts + nonce, SIGN_SECRET);
      headers = minimalHeaders(ts, nonce, signature, sigCountVal);
      break;

    case 'bot-badsig':
      // 伪造签名
      sigCountVal = Math.floor(Math.random() * 20) + 1;
      nonce = randomNonce();
      signature = 'a'.repeat(64); // 假签名
      headers = fullHeaders(ts, nonce, signature, sigCountVal);
      break;

    default:
      sigCountVal = 1;
      nonce = randomNonce();
      signature = await hmacSha256('/api/data' + body + ts + nonce, SIGN_SECRET);
      headers = fullHeaders(ts, nonce, signature, sigCountVal);
  }

  return { body, headers };
}

function fullHeaders(ts, nonce, signature, sigCountVal) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'x-signature': signature,
    'x-timestamp': ts,
    'x-nonce': nonce,
    'x-device-id': deviceId,
    'x-fingerprint': fingerprint,
    'x-sig-count': String(sigCountVal),
  };
}

function minimalHeaders(ts, nonce, signature, sigCountVal) {
  // 只带最小头，缺失浏览器特征头
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'node-fetch/1.0',
    'x-signature': signature,
    'x-timestamp': ts,
    'x-nonce': nonce,
    'x-device-id': deviceId,
    'x-fingerprint': fingerprint,
    'x-sig-count': String(sigCountVal),
  };
}

// ======================= 发送请求 =======================

async function sendRequest(mode, index) {
  const { body, headers } = await buildRequest(mode, index);
  try {
    const resp = await fetch(API_URL, { method: 'POST', headers, body });
    const data = await resp.json();
    return { status: resp.status, data, mode, index };
  } catch (e) {
    return { status: 0, data: { code: -1, msg: e.message }, mode, index };
  }
}

// ======================= 测试执行 =======================

async function runTest() {
  const mode = document.getElementById('test-mode').value;
  const count = parseInt(document.getElementById('test-count').value);
  const baseInterval = parseInt(document.getElementById('test-interval').value);

  testRunning = true;
  testAbort = false;
  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-stop').disabled = false;
  replayNonce = null; // 重置重放 nonce

  // 人类模式使用随机间隔（大幅波动）
  // 机器人模式使用固定间隔（高度规律）
  for (let i = 0; i < count; i++) {
    if (testAbort) break;

    // 更新进度条
    const progress = ((i / count) * 100).toFixed(0);
    document.getElementById('progress-bar').style.width = progress + '%';

    // 发送请求
    const result = await sendRequest(mode, i);

    // 实时更新日志
    addLogEntry(result);

    // 等待间隔
    let delay;
    if (mode === 'human') {
      // 人类行为：2-8 秒随机间隔
      delay = Math.floor(2000 + Math.random() * 6000);
    } else if (mode === 'bot-rapid') {
      // 高频：固定 500ms
      delay = 500;
    } else {
      // 其他机器人：用户设定的固定间隔
      delay = baseInterval;
    }

    if (i < count - 1 && !testAbort) {
      await sleep(delay);
    }
  }

  document.getElementById('progress-bar').style.width = '100%';
  testRunning = false;
  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-stop').disabled = true;

  // 最终刷新统计
  await refreshStats();
}

function stopTest() {
  testAbort = true;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ======================= UI 更新 =======================

function addLogEntry(result) {
  const logList = document.getElementById('log-list');
  if (logList.querySelector('.empty')) logList.innerHTML = '';

  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const isPass = result.data.code === 0;
  const layer = result.data.layer || '-';
  const msg = result.data.msg || 'success';

  entry.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-result ${isPass ? 'pass' : 'block'}">${isPass ? 'PASS' : 'BLOCK'}</span>
    <span class="log-layer">[${layer}]</span>
    <span class="log-detail">${msg}</span>
  `;

  logList.insertBefore(entry, logList.firstChild);
  if (logList.children.length > 100) logList.removeChild(logList.lastChild);

  // 更新日志计数
  const badge = document.getElementById('log-count');
  badge.textContent = parseInt(badge.textContent) + 1;

  // 触发防御层高亮
  if (!isPass && layer !== '-') {
    highlightLayer(layer, true);
  }
}

function highlightLayer(layer, triggered) {
  const map = {
    'header_fingerprint': 'layer-1',
    'signature': 'layer-2',
    'device': 'layer-3',
    'behavior': 'layer-4',
  };
  const el = document.getElementById(map[layer]);
  if (el) {
    el.classList.add('triggered');
    setTimeout(() => el.classList.remove('triggered'), 2000);
  }
}

async function refreshStats() {
  try {
    const resp = await fetch(STATS_URL);
    const data = await resp.json();

    // 更新统计数字
    document.getElementById('stat-total').textContent = data.stats.allowed + data.stats.blocked;
    document.getElementById('stat-allowed').textContent = data.stats.allowed;
    document.getElementById('stat-blocked').textContent = data.stats.blocked;
    document.getElementById('stat-rate').textContent = data.stats.blockRate + '%';
    document.getElementById('stat-devices').textContent = data.stats.activeDevices;

    // 更新设备列表
    const tbody = document.getElementById('devices-tbody');
    if (data.devices.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无设备</td></tr>';
    } else {
      tbody.innerHTML = data.devices.map(d => `
        <tr>
          <td>${d.id}</td>
          <td>${d.requestCount}</td>
          <td>${d.avgInterval}ms</td>
          <td style="color: ${parseFloat(d.intervalCV) < 0.15 ? '#f85149' : '#3fb950'}">${d.intervalCV}</td>
          <td>${d.sigCountPattern}</td>
        </tr>
      `).join('');
    }

    // 更新拦截原因
    const reasonsList = document.getElementById('reasons-list');
    const reasons = Object.entries(data.stats.blockReasons || {});
    if (reasons.length === 0) {
      reasonsList.innerHTML = '<div class="empty">暂无拦截记录</div>';
    } else {
      const codeMap = {
        1001: '缺少签名参数',
        1002: '签名验证失败',
        1003: '签名已过期',
        1004: '重复请求（重放）',
        1005: '设备指纹不一致',
        1006: '请求频率超限',
        1007: '自动化行为模式',
        1008: '缺少必要请求头',
        1009: '可疑 User-Agent',
      };
      reasonsList.innerHTML = reasons
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => `
          <div class="reason-item">
            <span class="reason-code">${code}</span>
            <span class="reason-msg">${codeMap[code] || '未知错误'}</span>
            <span class="reason-count">${count}</span>
          </div>
        `).join('');
    }
  } catch (e) {
    console.error('刷新统计失败:', e);
  }
}

async function resetData() {
  try {
    await fetch(RESET_URL, { method: 'POST' });
    document.getElementById('log-list').innerHTML = '<div class="empty">暂无请求</div>';
    document.getElementById('log-count').textContent = '0';
    document.getElementById('progress-bar').style.width = '0%';
    await refreshStats();
  } catch (e) {
    console.error('重置失败:', e);
  }
}

// ======================= 事件绑定 =======================

document.getElementById('btn-start').addEventListener('click', runTest);
document.getElementById('btn-stop').addEventListener('click', stopTest);
document.getElementById('btn-reset').addEventListener('click', resetData);

// 定时刷新统计
setInterval(() => { if (testRunning) refreshStats(); }, 2000);

// 初始加载
refreshStats();
