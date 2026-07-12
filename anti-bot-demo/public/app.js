/**
 * anti-bot-demo/public/app.js
 *
 * 客户端逻辑：签名生成 + 测试模拟 + 实时仪表盘
 */

'use strict';

// VM 签名引擎 — 由服务端内嵌在 HTML 页面中 (window.__VM_ENGINE__)
// 防护机制：
//   1. 代码经 XOR + SBOX 加密，解码器桩有环境检查（window.chrome/document/navigator/performance）
//   2. 反调试：debugger 陷阱 + 窗口尺寸检测 + 执行耗时检测
//   3. DevTools 打开时签名被 XOR 0x5 破坏
//   4. 动态挑战盐 5 分钟过期，会话绑定 IP
// 签名还需要动态挑战盐 (sessionSalt)，由 /api/challenge 下发，5 分钟过期

let sessionSalt = null;
let sessionId = null;

async function fetchChallenge() {
  const resp = await fetch('/api/challenge');
  const data = await resp.json();
  sessionId = data.sessionId;
  sessionSalt = data.salt;
  return data;
}

const API_URL = '/api/data';
const STATS_URL = '/api/stats';
const RESET_URL = '/api/reset';

// ======================= 签名工具 =======================

async function vmSign(path, body, timestamp, nonce) {
  if (!sessionSalt) await fetchChallenge();
  return window.__VM_ENGINE__(path, body, timestamp, nonce, sessionSalt);
}

function randomNonce() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
}

function generateDeviceId() {
  return 'dev-' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 6);
}

function generateFingerprint() {
  // v5: 真实浏览器指纹（Canvas + WebGL + UA + 屏幕）
  const parts = [];

  // Canvas 指纹
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 280;
    canvas.height = 60;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('Browser fingerprint test 🔒', 2, 2);
    const dataUrl = canvas.toDataURL();
    parts.push(dataUrl.slice(-32));
  } catch (e) {
    parts.push('no-canvas');
  }

  // WebGL 指纹
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '';
        parts.push(renderer.substring(0, 20));
      }
    }
  } catch (e) {
    parts.push('no-webgl');
  }

  // UA + 屏幕
  const ua = navigator.userAgent.substring(0, 20);
  const screenInfo = `${window.screen?.width || 1920}x${window.screen?.height || 1080}`;
  parts.push(ua);
  parts.push(screenInfo);
  parts.push(String(Date.now()).substring(0, 6));

  return btoa(parts.join('|'));
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
      signature = await vmSign("/api/data", body, ts, nonce);
      headers = fullHeaders(ts, nonce, signature, sigCountVal);
      break;

    case 'bot-rapid':
      // 高频请求：sigCount 随机但间隔极短
      sigCountVal = Math.floor(Math.random() * 30) + 1;
      nonce = randomNonce();
      signature = await vmSign("/api/data", body, ts, nonce);
      headers = fullHeaders(ts, nonce, signature, sigCountVal);
      break;

    case 'bot-linear':
      // sigCount 线性递增：1, 2, 3, 4...
      sigCountVal = index + 1;
      nonce = randomNonce();
      signature = await vmSign("/api/data", body, ts, nonce);
      headers = fullHeaders(ts, nonce, signature, sigCountVal);
      break;

    case 'bot-constant':
      // sigCount 恒定不变
      sigCountVal = 5;
      nonce = randomNonce();
      signature = await vmSign("/api/data", body, ts, nonce);
      headers = fullHeaders(ts, nonce, signature, sigCountVal);
      break;

    case 'bot-replay':
      // 重放攻击：复用同一个 nonce
      if (!replayNonce) replayNonce = randomNonce();
      nonce = replayNonce;
      signature = await vmSign("/api/data", body, ts, nonce);
      headers = fullHeaders(ts, nonce, signature, 5);
      break;

    case 'bot-noheader':
      // 缺失请求头
      sigCountVal = Math.floor(Math.random() * 20) + 1;
      nonce = randomNonce();
      signature = await vmSign("/api/data", body, ts, nonce);
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
      signature = await vmSign("/api/data", body, ts, nonce);
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
    'x-session-id': sessionId || '',
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
    'x-session-id': sessionId || '',
    'x-device-id': deviceId,
    'x-fingerprint': fingerprint,
    'x-sig-count': String(sigCountVal),
  };
}

// ======================= PoW 工作量证明 =======================

/**
 * 求解 PoW 挑战 — 找到 nonce 使 hash(challenge + nonce) 前 N 位为 0
 * 难度 3 约需 ~4000 次尝试（~50ms），对用户无感知
 * 使用纯 JS SHA-256 同步实现，避免 SubtleCrypto 异步开销
 */
function solvePow(challenge, difficulty) {
  const prefix = '0'.repeat(difficulty);
  for (let nonce = 0; ; nonce++) {
    const hash = sha256Hex(challenge + nonce);
    if (hash.startsWith(prefix)) {
      return String(nonce);
    }
  }
}

// 纯 JS SHA-256 实现（同步，无依赖）
// 来源：公开标准 FIPS 180-4 实现
function sha256Hex(message) {
  // 优先使用浏览器原生 crypto.subtle（如果可用且同步调用场景不适用）
  // 这里使用纯 JS 实现保证同步性
  return _sha256Sync(message);
}

// SHA-256 同步实现
var _sha256Sync = (function() {
  function rrot(n, x) { return (x >>> n) | (x << (32 - n)); }
  var K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  function toBytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 128) bytes.push(c);
      else if (c < 2048) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return bytes;
  }
  return function(str) {
    var bytes = toBytes(str);
    var l = bytes.length;
    var padLen = (((l + 9) >> 6) + 1) << 6;
    var padded = new Uint8Array(padLen);
    padded.set(bytes);
    padded[l] = 0x80;
    // 64-bit big-endian length
    var bitLen = l * 8;
    padded[padLen - 4] = (bitLen >>> 24) & 0xff;
    padded[padLen - 3] = (bitLen >>> 16) & 0xff;
    padded[padLen - 2] = (bitLen >>> 8) & 0xff;
    padded[padLen - 1] = bitLen & 0xff;

    var H = new Uint32Array([
      0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19,
    ]);
    var W = new Uint32Array(64);

    for (var off = 0; off < padLen; off += 64) {
      for (var i = 0; i < 16; i++) {
        W[i] = (padded[off + i*4] << 24) | (padded[off + i*4+1] << 16) | (padded[off + i*4+2] << 8) | padded[off + i*4+3];
      }
      for (var i = 16; i < 64; i++) {
        var s0 = rrot(7, W[i-15]) ^ rrot(18, W[i-15]) ^ (W[i-15] >>> 3);
        var s1 = rrot(17, W[i-2]) ^ rrot(19, W[i-2]) ^ (W[i-2] >>> 10);
        W[i] = (W[i-16] + s0 + W[i-7] + s1) | 0;
      }
      var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
      for (var i = 0; i < 64; i++) {
        var S1 = rrot(6, e) ^ rrot(11, e) ^ rrot(25, e);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + W[i]) | 0;
        var S0 = rrot(2, a) ^ rrot(13, a) ^ rrot(22, a);
        var mj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + mj) | 0;
        h=g; g=f; f=e; e=(d + t1)|0; d=c; c=b; b=a; a=(t1 + t2)|0;
      }
      H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
      H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
    }
    var hex = '';
    for (var i = 0; i < 8; i++) {
      hex += (H[i] >>> 0).toString(16).padStart(8, '0');
    }
    return hex;
  };
})();

// ======================= 发送请求 =======================

async function sendRequest(mode, index) {
  const { body, headers } = await buildRequest(mode, index);
  try {
    const resp = await fetch(API_URL, { method: 'POST', headers, body });
    const data = await resp.json();
    // 盐过期自动刷新并重试一次
    if (data.code === 1011 && index === 0) {
      await fetchChallenge();
      const { body: body2, headers: headers2 } = await buildRequest(mode, index);
      const resp2 = await fetch(API_URL, { method: 'POST', headers: headers2, body: body2 });
      const data2 = await resp2.json();
      return { status: resp2.status, data: data2, mode, index };
    }
    // v6: PoW 挑战 — 收到 1014 时计算工作量证明并重试
    if (data.code === 1014 && data.pow) {
      const { powId, challenge, difficulty } = data.pow;
      const powNonce = solvePow(challenge, difficulty);
      const { body: body3, headers: headers3 } = await buildRequest(mode, index);
      headers3['x-pow-id'] = powId;
      headers3['x-pow-nonce'] = powNonce;
      const resp3 = await fetch(API_URL, { method: 'POST', headers: headers3, body: body3 });
      const data3 = await resp3.json();
      return { status: resp3.status, data: data3, mode, index };
    }
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
    if (!tbody) return;
    if (data.devices.length === 0) {
      const thCount = document.querySelectorAll('.data-table thead th').length || 2;
      tbody.innerHTML = `<tr><td colspan="${thCount}" class="empty">暂无设备</td></tr>`;
    } else {
      tbody.innerHTML = data.devices.map(d => {
        // 检测哪些列存在（breach 模式下只保留 设备ID + 请求数）
        const hasAvg = document.querySelector('.data-table thead th:nth-child(3)');
        const extra = hasAvg ? `
          <td>${d.avgInterval}ms</td>
          <td style="color: ${parseFloat(d.intervalCV) < 0.15 ? '#f85149' : '#3fb950'}">${d.intervalCV}</td>
          <td>${d.sigCountPattern}</td>
          <td style="color: ${parseFloat(d.riskScore) > 0.5 ? '#f85149' : '#3fb950'}">${d.riskScore}</td>
          <td>${d.riskFactors && d.riskFactors.length > 0 ? d.riskFactors.join('<br>') : '-'}</td>` : '';
        return `<tr><td>${d.id}</td><td>${d.requestCount}</td>${extra}</tr>`;
      }).join('');
    }

    // 更新拦截原因
    const reasonsList = document.getElementById('reasons-list');
    if (!reasonsList) return;
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
        1010: '缺少会话标识',
        1011: '会话已过期',
        1012: 'IP 不一致（v5）',
        1013: '风险评分过高（v5）',
        1014: '需要 PoW 挑战（v6）',
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
    const logList = document.getElementById('log-list');
    if (logList) logList.innerHTML = '<div class="empty">暂无请求</div>';
    const logCount = document.getElementById('log-count');
    if (logCount) logCount.textContent = '0';
    const progressBar = document.getElementById('progress-bar');
    if (progressBar) progressBar.style.width = '0%';
    await refreshStats();
  } catch (e) {
    console.error('重置失败:', e);
  }
}

// ======================= 事件绑定 =======================
// 测试控制台按钮（破解测试模式下不存在，需安全访问）
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnReset = document.getElementById('btn-reset');
if (btnStart) btnStart.addEventListener('click', runTest);
if (btnStop) btnStop.addEventListener('click', stopTest);
if (btnReset) btnReset.addEventListener('click', resetData);

// 发送请求按钮（破解测试模式下也存在）
const btnSendHuman = document.getElementById('btn-send-human');
if (btnSendHuman) {
  btnSendHuman.addEventListener('click', async () => {
    btnSendHuman.disabled = true;
    btnSendHuman.textContent = '发送中...';
    try {
      const result = await sendHumanRequest();
      if (result.code === 0) {
        btnSendHuman.textContent = '成功';
      } else {
        btnSendHuman.textContent = '失败';
        console.log('请求结果:', result);
        if (result.code === 1002) {
          alert('签名验证失败 (1002)。请确认未打开 DevTools (F12) 后刷新页面重试。');
        }
      }
    } catch (e) {
      btnSendHuman.textContent = '错误';
      console.error('请求失败:', e);
    } finally {
      setTimeout(() => {
        btnSendHuman.disabled = false;
        btnSendHuman.textContent = '发送请求';
      }, 1500);
      refreshStats();
    }
  });
}

// 发送单次人类正常请求
async function sendHumanRequest() {
  if (!sessionSalt) await fetchChallenge();

  const timestamp = Date.now();
  const nonce = randomNonce();
  const body = JSON.stringify({ index: Math.floor(Math.random() * 1000), action: 'view' });
  const sig = await vmSign('/api/data', body, timestamp, nonce);
  // 复用全局 deviceId 和 fingerprint，保持设备一致性
  // sigCount 随机波动（模拟人类行为）
  sigCount += Math.floor(Math.random() * 3) + 1;
  if (sigCount > 30) sigCount = Math.floor(Math.random() * 5) + 1;
  let headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'X-Signature': sig,
    'X-Timestamp': timestamp.toString(),
    'X-Nonce': nonce,
    'X-Device-Id': deviceId,
    'X-Fingerprint': fingerprint,
    'X-Session-Id': sessionId || '',
    'X-Sig-Count': String(sigCount),
  };
  let resp = await fetch(API_URL, { method: 'POST', headers, body });
  let data = await resp.json();
  // v6: PoW 挑战处理
  if (data.code === 1014 && data.pow) {
    const { powId, challenge, difficulty } = data.pow;
    const powNonce = solvePow(challenge, difficulty);
    headers['x-pow-id'] = powId;
    headers['x-pow-nonce'] = powNonce;
    resp = await fetch(API_URL, { method: 'POST', headers, body });
    data = await resp.json();
  }
  // 添加到日志列表（复用 runTest 的日志渲染逻辑）
  addLogEntry({ status: resp.status, data, mode: 'human', index: -1 });
  return data;
}

// 定时刷新统计
setInterval(() => { if (testRunning) refreshStats(); }, 2000);

// 初始加载 — 先获取挑战令牌，再刷新统计
fetchChallenge().then(() => refreshStats());
