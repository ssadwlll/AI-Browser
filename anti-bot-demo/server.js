/**
 * anti-bot-demo/server.js
 *
 * API 防刷防采集四层防御体系演示服务器
 *
 * 借鉴小红书反爬体系设计的轻量级防刷架构：
 *   第一层：HTTP 请求头指纹检测 — 识别非浏览器客户端
 *   第二层：请求签名验证 — HMAC 绑定路径+请求体+时间戳+nonce，防篡改防重放
 *   第三层：设备指纹追踪 — 设备 ID + 指纹一致性校验
 *   第四层：行为分析引擎 — 频率限制 + 间隔规律性检测 + sigCount 模式检测
 *
 * 错误码设计（借鉴小红书 3000xx 系列）：
 *   1001: 缺少签名参数
 *   1002: 签名验证失败
 *   1003: 签名已过期（时间戳超出窗口）
 *   1004: 重复请求（nonce 重放）
 *   1005: 设备指纹不一致
 *   1006: 请求频率超限
 *   1007: 检测到自动化行为模式
 *   1008: 缺少必要请求头
 *   1009: 可疑 User-Agent
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = 3210;

// ======================= 配置 =======================

const SIGN_SECRET = 'anti-bot-demo-secret-2026';
const TIMESTAMP_WINDOW = 5 * 60 * 1000;  // 签名时间窗口 5 分钟
const BURST_LIMIT = 8;                    // 突发限制：5 秒内最多 8 次
const BURST_WINDOW = 5 * 1000;
const SUSTAINED_LIMIT = 60;               // 持续限制：每分钟最多 60 次
const SUSTAINED_WINDOW = 60 * 1000;
const DAILY_LIMIT = 500;                  // 每日限制
const NONCE_CACHE_SIZE = 10000;           // nonce 缓存上限

// ======================= 内存存储 =======================

const devices = new Map();      // deviceId -> device info
const usedNonces = new Set();   // 已使用的 nonce（防重放）
const requestLog = [];          // 最近 200 条请求日志
const stats = {
  totalRequests: 0,
  allowed: 0,
  blocked: 0,
  blockReasons: {},   // code -> count
};

// ======================= 工具函数 =======================

function hmacSha256(data, secret) {
  return crypto.createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

function logRequest(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > 200) requestLog.pop();
}

function recordBlock(code, msg) {
  stats.blocked++;
  stats.blockReasons[code] = (stats.blockReasons[code] || 0) + 1;
}

// ======================= 中间件：原始请求体捕获 =======================

app.use((req, res, next) => {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks).toString('utf8');
    next();
  });
});

// ======================= 第一层：HTTP 请求头指纹 =======================

function headerFingerprintCheck(req, res, next) {
  const ua = req.headers['user-agent'] || '';
  const accept = req.headers['accept'] || '';
  const acceptLanguage = req.headers['accept-language'] || '';
  const secChUa = req.headers['sec-ch-ua'] || '';
  const secFetchMode = req.headers['sec-fetch-mode'] || '';
  const secFetchDest = req.headers['sec-fetch-dest'] || '';

  const missing = [];
  if (!accept) missing.push('Accept');
  if (!acceptLanguage) missing.push('Accept-Language');
  if (!secChUa) missing.push('sec-ch-ua');
  if (!secFetchMode) missing.push('sec-fetch-mode');
  if (!secFetchDest) missing.push('sec-fetch-dest');

  // 缺少 3 个以上浏览器特征头 → 非浏览器客户端
  if (missing.length >= 3) {
    recordBlock(1008, `缺少必要请求头: ${missing.join(', ')}`);
    return res.status(403).json({ code: 1008, msg: `缺少必要请求头: ${missing.join(', ')}`, layer: 'header_fingerprint' });
  }

  // 检查已知自动化工具 UA
  if (/bot|crawler|spider|headless|puppeteer|selenium|phantomjs|axios|node-fetch|python-requests|curl/i.test(ua)) {
    recordBlock(1009, '可疑的 User-Agent');
    return res.status(403).json({ code: 1009, msg: '可疑的 User-Agent', layer: 'header_fingerprint' });
  }

  // UA 一致性检查：Chrome UA 必须带 sec-ch-ua
  if (ua.includes('Chrome') && !secChUa) {
    recordBlock(1008, 'UA 与 sec-ch-ua 不一致');
    return res.status(403).json({ code: 1008, msg: 'UA 与 sec-ch-ua 不一致（疑似伪造）', layer: 'header_fingerprint' });
  }

  req.defenseLayer = { header: 'pass' };
  next();
}

// ======================= 第二层：请求签名验证 =======================

function signatureVerify(req, res, next) {
  const sig = req.headers['x-signature'];
  const ts = req.headers['x-timestamp'];
  const nonce = req.headers['x-nonce'];

  if (!sig || !ts || !nonce) {
    recordBlock(1001, '缺少签名参数');
    return res.status(403).json({ code: 1001, msg: '缺少签名参数 (x-signature / x-timestamp / x-nonce)', layer: 'signature' });
  }

  // 时间戳窗口校验
  const now = Date.now();
  const clientTs = parseInt(ts);
  if (isNaN(clientTs) || Math.abs(now - clientTs) > TIMESTAMP_WINDOW) {
    recordBlock(1003, '签名已过期');
    return res.status(403).json({ code: 1003, msg: '签名已过期（时间戳超出 5 分钟窗口）', layer: 'signature' });
  }

  // nonce 防重放
  if (usedNonces.has(nonce)) {
    recordBlock(1004, '重复请求');
    return res.status(403).json({ code: 1004, msg: '重复请求（nonce 已使用）', layer: 'signature' });
  }
  usedNonces.add(nonce);
  if (usedNonces.size > NONCE_CACHE_SIZE) {
    // 简单清理：清空一半（生产中应用 LRU）
    const keep = [...usedNonces].slice(-NONCE_CACHE_SIZE / 2);
    usedNonces.clear();
    keep.forEach(n => usedNonces.add(n));
  }

  // HMAC 验证：签名 = HMAC-SHA256(path + body + timestamp + nonce, secret)
  const expectedSig = hmacSha256(req.path + req.rawBody + ts + nonce, SIGN_SECRET);
  if (sig !== expectedSig) {
    recordBlock(1002, '签名验证失败');
    return res.status(403).json({ code: 1002, msg: '签名验证失败（HMAC 不匹配）', layer: 'signature' });
  }

  req.defenseLayer.signature = 'pass';
  next();
}

// ======================= 第三层：设备指纹追踪 =======================

function deviceTrack(req, res, next) {
  const deviceId = req.headers['x-device-id'];
  const fingerprint = req.headers['x-fingerprint'] || '';

  if (!deviceId) {
    recordBlock(1005, '缺少设备标识');
    return res.status(403).json({ code: 1005, msg: '缺少设备标识 (x-device-id)', layer: 'device' });
  }

  let device = devices.get(deviceId);
  if (!device) {
    device = {
      id: deviceId,
      fingerprint,
      firstSeen: Date.now(),
      requestCount: 0,
      sigCountHistory: [],
      lastRequest: 0,
      intervals: [],
      burstCount: 0,
      burstWindowStart: 0,
      recentRequests: [],  // 时间戳数组，用于持续频率计算
      blocked: false,
    };
    devices.set(deviceId, device);
  }

  // 指纹一致性校验（同一设备 ID 不应切换指纹）
  if (device.fingerprint && fingerprint && device.fingerprint !== fingerprint) {
    recordBlock(1005, '设备指纹不一致');
    return res.status(403).json({ code: 1005, msg: '设备指纹不一致（疑似设备 ID 劫持）', layer: 'device' });
  }

  // 更新设备信息
  const now = Date.now();
  if (device.lastRequest > 0) {
    device.intervals.push(now - device.lastRequest);
    if (device.intervals.length > 100) device.intervals.shift();
  }
  device.lastRequest = now;
  device.requestCount++;
  device.recentRequests.push(now);
  // 清理 1 分钟前的记录
  const oneMinAgo = now - SUSTAINED_WINDOW;
  device.recentRequests = device.recentRequests.filter(t => t > oneMinAgo);

  req.device = device;
  req.defenseLayer.device = 'pass';
  next();
}

// ======================= 第四层：行为分析引擎 =======================

function behaviorAnalyze(req, res, next) {
  const device = req.device;
  const sigCount = parseInt(req.headers['x-sig-count'] || '0');

  // 记录 sigCount
  device.sigCountHistory.push(sigCount);
  if (device.sigCountHistory.length > 50) device.sigCountHistory.shift();

  const now = Date.now();

  // 4a. 突发频率限制（5 秒内最多 BURST_LIMIT 次）
  if (now - device.burstWindowStart > BURST_WINDOW) {
    device.burstWindowStart = now;
    device.burstCount = 1;
  } else {
    device.burstCount++;
    if (device.burstCount > BURST_LIMIT) {
      recordBlock(1006, '突发频率超限');
      return res.status(429).json({ code: 1006, msg: `请求频率过高（5 秒内超过 ${BURST_LIMIT} 次）`, layer: 'behavior' });
    }
  }

  // 4b. 持续频率限制（1 分钟内最多 SUSTAINED_LIMIT 次）
  if (device.recentRequests.length > SUSTAINED_LIMIT) {
    recordBlock(1006, '持续频率超限');
    return res.status(429).json({ code: 1006, msg: `请求频率过高（1 分钟内超过 ${SUSTAINED_LIMIT} 次）`, layer: 'behavior' });
  }

  // 4c. 每日限制
  if (device.requestCount > DAILY_LIMIT) {
    recordBlock(1006, '每日限额超限');
    return res.status(429).json({ code: 1006, msg: `每日请求限额已用尽（${DAILY_LIMIT} 次）`, layer: 'behavior' });
  }

  // 4d. 间隔规律性检测（至少 10 个样本）
  if (device.intervals.length >= 10) {
    const intervals = device.intervals.slice(-20);
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / intervals.length;
    const stdDev = Math.sqrt(variance);
    const cv = avg > 0 ? stdDev / avg : 0;  // 变异系数

    // 人类请求间隔变异系数 > 0.3（高度随机）
    // 机器人间隔变异系数 < 0.15（高度规律）
    if (cv < 0.15 && avg < 10000) {
      recordBlock(1007, '间隔过于规律');
      return res.status(403).json({
        code: 1007,
        msg: `检测到自动化请求模式（间隔变异系数 ${cv.toFixed(3)}，平均间隔 ${avg.toFixed(0)}ms）`,
        layer: 'behavior',
        detail: { cv: cv.toFixed(3), avg: avg.toFixed(0), samples: intervals.length }
      });
    }
  }

  // 4e. sigCount 模式检测
  if (device.sigCountHistory.length >= 8) {
    const recent = device.sigCountHistory.slice(-8);
    // 线性递增：1, 2, 3, 4, 5, 6, 7, 8
    const isLinear = recent.every((v, i) => i === 0 || v === recent[i - 1] + 1);
    // 恒定不变：5, 5, 5, 5, 5, 5, 5, 5
    const isConstant = recent.every(v => v === recent[0]);

    if (isLinear || isConstant) {
      recordBlock(1007, 'sigCount 模式异常');
      return res.status(403).json({
        code: 1007,
        msg: `检测到自动化签名模式（sigCount ${isLinear ? '线性递增' : '恒定不变'}）`,
        layer: 'behavior',
        detail: { pattern: isLinear ? 'linear' : 'constant', recent }
      });
    }
  }

  req.defenseLayer.behavior = 'pass';
  next();
}

// ======================= 路由 =======================

// 受保护的 API
app.post('/api/data', headerFingerprintCheck, signatureVerify, deviceTrack, behaviorAnalyze, (req, res) => {
  stats.totalRequests++;
  stats.allowed++;

  const device = req.device;
  logRequest({
    time: new Date().toISOString(),
    deviceId: device.id.substring(0, 12),
    result: 'allowed',
    code: 0,
    sigCount: parseInt(req.headers['x-sig-count'] || '0'),
    layers: req.defenseLayer,
  });

  res.json({
    code: 0,
    msg: 'success',
    data: {
      message: '请求通过所有防御层',
      deviceId: device.id.substring(0, 12),
      requestCount: device.requestCount,
      timestamp: Date.now(),
      payload: { items: [{ id: 1, name: 'demo-data-' + Date.now() }] },
    }
  });
});

// 统计面板 API
app.get('/api/stats', (req, res) => {
  const blockRate = stats.totalRequests > 0
    ? (stats.blocked / (stats.allowed + stats.blocked) * 100).toFixed(1)
    : '0.0';

  res.json({
    stats: {
      ...stats,
      blockRate: parseFloat(blockRate),
      activeDevices: devices.size,
    },
    layers: {
      header_fingerprint: { name: 'HTTP 请求头指纹', description: '检测非浏览器客户端、伪造 UA、缺失特征头' },
      signature: { name: '请求签名验证', description: 'HMAC 绑定路径+请求体+时间戳+nonce，防篡改防重放' },
      device: { name: '设备指纹追踪', description: '设备 ID 一致性校验、设备劫持检测' },
      behavior: { name: '行为分析引擎', description: '频率限制 + 间隔规律性 + sigCount 模式检测' },
    },
    devices: [...devices.values()].map(d => ({
      id: d.id.substring(0, 12),
      requestCount: d.requestCount,
      firstSeen: d.firstSeen,
      avgInterval: d.intervals.length > 0
        ? Math.round(d.intervals.reduce((a, b) => a + b, 0) / d.intervals.length)
        : 0,
      intervalCV: d.intervals.length >= 5
        ? (() => {
            const avg = d.intervals.reduce((a, b) => a + b, 0) / d.intervals.length;
            const variance = d.intervals.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / d.intervals.length;
            return avg > 0 ? (Math.sqrt(variance) / avg).toFixed(3) : 'N/A';
          })()
        : 'N/A',
      sigCountPattern: d.sigCountHistory.length >= 5
        ? d.sigCountHistory.slice(-5).join(',')
        : 'N/A',
    })),
    recentLogs: requestLog.slice(0, 50),
  });
});

// 重置
app.post('/api/reset', (req, res) => {
  devices.clear();
  usedNonces.clear();
  requestLog.length = 0;
  stats.totalRequests = 0;
  stats.allowed = 0;
  stats.blocked = 0;
  stats.blockReasons = {};
  res.json({ code: 0, msg: '已重置所有数据' });
});

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

// ======================= 启动 =======================

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  API 防刷防采集四层防御体系演示`);
  console.log(`========================================`);
  console.log(`  服务地址: http://localhost:${PORT}`);
  console.log(`  保护 API: POST /api/data`);
  console.log(`  统计面板: GET  /api/stats`);
  console.log(`  签名密钥: ${SIGN_SECRET}`);
  console.log(`----------------------------------------`);
  console.log(`  防御层级:`);
  console.log(`    L1 HTTP 请求头指纹 — 缺头检测 + UA 一致性`);
  console.log(`    L2 请求签名验证     — HMAC + 时间戳 + nonce`);
  console.log(`    L3 设备指纹追踪     — 设备 ID + 指纹一致性`);
  console.log(`    L4 行为分析引擎     — 频率 + 规律性 + 模式`);
  console.log(`----------------------------------------`);
  console.log(`  限制配置:`);
  console.log(`    突发: ${BURST_LIMIT} 次 / ${BURST_WINDOW / 1000}s`);
  console.log(`    持续: ${SUSTAINED_LIMIT} 次 / ${SUSTAINED_WINDOW / 1000}s`);
  console.log(`    每日: ${DAILY_LIMIT} 次`);
  console.log(`========================================\n`);
});
