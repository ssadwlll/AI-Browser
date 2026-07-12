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
 *   1010: 缺少会话标识 (x-session-id)
 *   1011: 会话已过期或无效（挑战盐过期）
 *   1012: IP 地址不一致（会话/IP 绑定校验失败）  v5
 *   1013: 风险评分过高（综合行为风险拦截）      v5
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { vmSign, generateObfuscatedClientVM } = require('./vm-sign');

const app = express();
const PORT = 3210;

// ======================= Node.js v24+ 全局 navigator 兼容 =======================
// Node.js v24+ 引入了全局 navigator 但 userAgent 为空字符串
// 解码器桩检查 navigator.userAgent.indexOf("Mozilla") >= 0 会失败
// 这里 polyfill userAgent 让服务端也能正确解密 VM 代码
if (typeof navigator !== 'undefined' && (!navigator.userAgent || navigator.userAgent.indexOf('Mozilla') < 0)) {
  try {
    Object.defineProperty(navigator, 'userAgent', {
      get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      configurable: true,
    });
  } catch (e) {
    // 如果无法修改，忽略（createDeps 中已有 fallback）
  }
}

// ======================= 破解测试模式 =======================
// 默认开启：隐藏所有敏感信息，防止通过查看源码了解防护思路
// 启动参数：node server.js --no-breach 可关闭（仅本地调试用）
const BREACH_MODE = !process.argv.includes('--no-breach');

// 移除 HTML 中 <!-- BEGIN SENSITIVE -->...<!-- END SENSITIVE --> 标记的区块
function stripSensitive(html) {
  return html.replace(/<!--\s*BEGIN SENSITIVE\s*-->[\s\S]*?<!--\s*END SENSITIVE\s*-->/g, '');
}

// ======================= 配置 =======================
// 密钥不再明文存放 — 由 vm-sign.js 的 VM 字节码在运行时动态解码
// 攻击者无法通过搜索 "secret" 找到密钥，需要逆向 VM 指令集
const TIMESTAMP_WINDOW = 5 * 60 * 1000;  // 签名时间窗口 5 分钟
const BURST_LIMIT = 8;                    // 突发限制：5 秒内最多 8 次
const BURST_WINDOW = 5 * 1000;
const SUSTAINED_LIMIT = 60;               // 持续限制：每分钟最多 60 次
const SUSTAINED_WINDOW = 60 * 1000;
const DAILY_LIMIT = 500;                  // 每日限制
const NONCE_CACHE_SIZE = 10000;           // nonce 缓存上限
const SALT_TTL = 5 * 60 * 1000;           // 挑战盐有效期 5 分钟
const CHALLENGE_RATE_LIMIT = 30;          // 每分钟最多获取 30 次挑战令牌

// v6: 行为分析增强配置
const ENTROPY_MIN_SAMPLES = 12;            // 熵值检测最少样本数
const ENTROPY_THRESHOLD = 2.5;             // 人类熵值通常 > 3.0，机器人 < 2.5
const HEAVY_TAIL_THRESHOLD = 0.15;        // 长尾占比（>10s 间隔）阈值
const PATH_TRANSITION_MIN = 8;            // 路径转移检测最少样本
const API_RATIO_MIN = 15;                 // API 比例检测最少请求
const API_READ_ONLY_RATIO = 0.95;         // 只读不交互的阈值
const POW_DIFFICULTY = 3;                 // PoW 难度：要求 hash 前 3 位为 0
const POW_TTL = 2 * 60 * 1000;           // PoW 挑战有效期 2 分钟

// ======================= 内存存储 =======================

const devices = new Map();      // deviceId -> device info
const usedNonces = new Set();   // 已使用的 nonce（防重放）
const sessionSalts = new Map(); // sessionId -> { salt, createdAt, ip }
const challengeLog = new Map(); // IP -> [timestamps] 挑战令牌获取频率
const requestLog = [];          // 最近 200 条请求日志
const powChallenges = new Map(); // powId -> { challenge, nonce, createdAt, deviceId }
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

// VM 签名验证：服务端用 VM 字节码 + 动态盐重新计算签名
function verifySignature(path, body, ts, nonce, salt) {
  return vmSign(path, body, ts, nonce, salt);
}

// 清理过期的挑战盐
function cleanExpiredSalts() {
  const now = Date.now();
  for (const [id, data] of sessionSalts) {
    if (now - data.createdAt > SALT_TTL) {
      sessionSalts.delete(id);
    }
  }
}

function logRequest(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > 200) requestLog.pop();
}

function recordBlock(code, msg) {
  stats.blocked++;
  stats.blockReasons[code] = (stats.blockReasons[code] || 0) + 1;
}

// ======================= v6: 行为分析增强工具 =======================

/**
 * 计算 Shannon 熵 — 衡量间隔分布的随机性
 * 人类熵值 > 3.0（间隔分布广，有长尾有突发）
 * 机器人熵值 < 2.5（间隔集中在窄范围）
 */
function computeEntropy(intervals) {
  if (!intervals || intervals.length === 0) return 0;
  // 分桶：0-1s, 1-2s, ..., 29-30s, 30s+
  const buckets = new Array(31).fill(0);
  for (const t of intervals) {
    const idx = Math.min(Math.floor(t / 1000), 30);
    buckets[idx]++;
  }
  const total = intervals.length;
  let h = 0;
  for (const c of buckets) {
    if (c > 0) {
      const p = c / total;
      h -= p * Math.log2(p);
    }
  }
  return h;
}

/**
 * 检测重尾分布 — 人类会有 >10s 的"发呆"间隔
 * 机器人即使随机，也很少超过 10 秒
 */
function computeHeavyTailRatio(intervals) {
  if (!intervals || intervals.length === 0) return 0;
  const longCount = intervals.filter(t => t > 10000).length;
  return longCount / intervals.length;
}

/**
 * 检测突发请求 — 人类会偶尔 <1s 快速连点
 */
function computeBurstRatio(intervals) {
  if (!intervals || intervals.length === 0) return 0;
  const fastCount = intervals.filter(t => t < 1000).length;
  return fastCount / intervals.length;
}

/**
 * 路径转移概率 — 人类浏览有回溯、搜索、跳转
 * 机器人往往是线性遍历：笔记1→笔记2→笔记3→笔记4
 * 检测"同路径连续"比例：P(笔记→笔记) 人类 ~0.3，机器人 ~0.9
 */
function computePathTransitionRatio(pathHistory) {
  if (!pathHistory || pathHistory.length < PATH_TRANSITION_MIN) return null;
  const transitions = [];
  for (let i = 1; i < pathHistory.length; i++) {
    transitions.push({
      from: pathHistory[i - 1],
      to: pathHistory[i],
      same: pathHistory[i - 1] === pathHistory[i],
    });
  }
  // 同路径连续占比（机器人特征）
  const samePathCount = transitions.filter(t => t.same).length;
  return samePathCount / transitions.length;
}

/**
 * API 调用比例 — 人类会点赞、评论、收藏
 * 机器人只读不交互：GET /api/data 占比 > 95%
 */
function computeApiRatio(apiHistory) {
  if (!apiHistory || apiHistory.length < API_RATIO_MIN) return null;
  const readCount = apiHistory.filter(a => a.method === 'GET' || a.isReadOnly).length;
  return readCount / apiHistory.length;
}

/**
 * PoW 挑战生成 — 服务端下发 challenge，客户端需计算 hash
 * difficulty=3 表示 hash 前 3 位为 0，约需 ~4000 次尝试（~50ms）
 */
function generatePowChallenge(deviceId) {
  const powId = crypto.randomBytes(16).toString('hex');
  const challenge = crypto.randomBytes(16).toString('hex');
  powChallenges.set(powId, {
    challenge,
    deviceId,
    createdAt: Date.now(),
    solved: false,
  });
  return { powId, challenge, difficulty: POW_DIFFICULTY };
}

/**
 * PoW 验证 — 检查 hash(challenge + nonce) 前 N 位是否为 0
 */
function verifyPow(powId, nonce, deviceId) {
  const pow = powChallenges.get(powId);
  if (!pow) return { valid: false, reason: 'pow_not_found' };
  if (pow.solved) return { valid: false, reason: 'pow_already_solved' };
  if (Date.now() - pow.createdAt > POW_TTL) {
    powChallenges.delete(powId);
    return { valid: false, reason: 'pow_expired' };
  }
  if (pow.deviceId && pow.deviceId !== deviceId) {
    return { valid: false, reason: 'pow_device_mismatch' };
  }
  // 验证 hash
  const hash = crypto.createHash('sha256').update(pow.challenge + nonce).digest('hex');
  const prefix = '0'.repeat(POW_DIFFICULTY);
  if (!hash.startsWith(prefix)) {
    return { valid: false, reason: 'pow_invalid', hash };
  }
  pow.solved = true;
  pow.nonce = nonce;
  powChallenges.delete(powId); // 一次性使用
  return { valid: true };
}

// 清理过期 PoW 挑战
function cleanExpiredPow() {
  const now = Date.now();
  for (const [id, pow] of powChallenges) {
    if (now - pow.createdAt > POW_TTL) powChallenges.delete(id);
  }
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
  const sessionId = req.headers['x-session-id'];

  if (!sig || !ts || !nonce) {
    recordBlock(1001, '缺少签名参数');
    return res.status(403).json({ code: 1001, msg: '缺少签名参数 (x-signature / x-timestamp / x-nonce)', layer: 'signature' });
  }

  // 会话标识校验 — 必须携带 x-session-id
  if (!sessionId) {
    recordBlock(1010, '缺少会话标识');
    return res.status(403).json({ code: 1010, msg: '缺少会话标识 (x-session-id)，请先获取挑战令牌', layer: 'signature' });
  }

  // 查找挑战盐
  const sessionData = sessionSalts.get(sessionId);
  if (!sessionData) {
    recordBlock(1011, '会话无效');
    return res.status(403).json({ code: 1011, msg: '会话无效或已过期，请重新获取挑战令牌', layer: 'signature' });
  }

  // v5: IP 一致性校验 — 会话绑定 IP，防止跨 IP 重放
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  if (sessionData.ip && sessionData.ip !== clientIp) {
    recordBlock(1012, 'IP 不一致');
    return res.status(403).json({
      code: 1012,
      msg: '会话 IP 不一致（签名与请求来源绑定）',
      layer: 'signature',
      detail: { sessionIp: sessionData.ip, requestIp: clientIp }
    });
  }

  // 检查盐是否过期
  if (Date.now() - sessionData.createdAt > SALT_TTL) {
    sessionSalts.delete(sessionId);
    recordBlock(1011, '会话已过期');
    return res.status(403).json({ code: 1011, msg: '会话已过期，请重新获取挑战令牌', layer: 'signature' });
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
    const keep = [...usedNonces].slice(-NONCE_CACHE_SIZE / 2);
    usedNonces.clear();
    keep.forEach(n => usedNonces.add(n));
  }

  // HMAC 验证：VM 字节码 + 动态盐重新计算签名
  const expectedSig = verifySignature(req.path, req.rawBody, ts, nonce, sessionData.salt);
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
      challengeCount: 0,   // v5: 挑战令牌获取次数
      riskFactors: [],      // v5: 最近的风险因子
      // v6: 行为分析增强
      pathHistory: [],      // 请求路径序列
      apiHistory: [],       // API 调用历史 { method, path, isReadOnly, time }
      powSolved: 0,         // PoW 挑战解决次数
      powRequired: false,   // 是否需要 PoW 挑战（风险触发）
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

  // v6: 记录路径和 API 调用历史
  device.pathHistory.push(req.path);
  if (device.pathHistory.length > 50) device.pathHistory.shift();
  device.apiHistory.push({
    method: req.method,
    path: req.path,
    isReadOnly: req.method === 'GET',
    time: now,
  });
  if (device.apiHistory.length > 50) device.apiHistory.shift();

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

  // ======================= v6: 行为分析增强 =======================

  // 4g. 请求时序熵值检测（至少 12 个样本）
  if (device.intervals.length >= ENTROPY_MIN_SAMPLES) {
    const intervals = device.intervals.slice(-30);
    const entropy = computeEntropy(intervals);
    const heavyTailRatio = computeHeavyTailRatio(intervals);
    const burstRatio = computeBurstRatio(intervals);

    // 熵值低于阈值且没有长尾 → 机器人特征
    if (entropy < ENTROPY_THRESHOLD && heavyTailRatio < HEAVY_TAIL_THRESHOLD) {
      recordBlock(1007, '时序熵值异常');
      return res.status(403).json({
        code: 1007,
        msg: `检测到自动化请求模式（时序熵值 ${entropy.toFixed(2)}，低于阈值 ${ENTROPY_THRESHOLD}）`,
        layer: 'behavior',
        detail: {
          entropy: entropy.toFixed(3),
          threshold: ENTROPY_THRESHOLD,
          heavyTailRatio: heavyTailRatio.toFixed(3),
          burstRatio: burstRatio.toFixed(3),
          samples: intervals.length,
        }
      });
    }
  }

  // 4h. 请求路径转移检测（至少 8 个样本）
  // 注意：单接口场景下同路径占比天然为 100%，此检测主要针对多接口场景
  // 只有当存在多个不同路径时才检测，否则跳过
  if (device.pathHistory.length >= PATH_TRANSITION_MIN) {
    const uniquePaths = new Set(device.pathHistory).size;
    if (uniquePaths > 1) {
      const samePathRatio = computePathTransitionRatio(device.pathHistory);
      if (samePathRatio !== null && samePathRatio > 0.9) {
        recordBlock(1007, '路径模式异常');
        return res.status(403).json({
          code: 1007,
          msg: `检测到自动化采集模式（同路径连续占比 ${(samePathRatio * 100).toFixed(0)}%，阈值 90%）`,
          layer: 'behavior',
          detail: {
            samePathRatio: samePathRatio.toFixed(3),
            pathSamples: device.pathHistory.length,
            uniquePaths,
          }
        });
      }
    }
  }

  // 4i. API 调用比例检测（至少 15 个请求）
  // 注意：单接口场景下只读占比天然为 100%（POST 也被视为只读）
  // 只有当存在多个不同 API 端点时才检测
  if (device.apiHistory.length >= API_RATIO_MIN) {
    const uniqueApis = new Set(device.apiHistory.map(a => a.path)).size;
    if (uniqueApis > 1) {
      const readOnlyRatio = computeApiRatio(device.apiHistory);
      if (readOnlyRatio !== null && readOnlyRatio > API_READ_ONLY_RATIO) {
        recordBlock(1007, 'API 调用比例异常');
        return res.status(403).json({
          code: 1007,
          msg: `检测到只读采集行为（只读请求占比 ${(readOnlyRatio * 100).toFixed(0)}%，阈值 ${API_READ_ONLY_RATIO * 100}%）`,
          layer: 'behavior',
          detail: {
            readOnlyRatio: readOnlyRatio.toFixed(3),
            apiSamples: device.apiHistory.length,
            uniqueApis,
          }
        });
      }
    }
  }

  // 4j. v6: PoW 挑战 — 风险评分超阈值时触发
  // 不直接拦截，而是要求客户端完成 PoW 挑战
  // 这样正常用户无感知，攻击者需付出计算成本
  const preRiskScore = computeRiskScore(device);
  if (preRiskScore >= 0.4 && !device.powRequired) {
    device.powRequired = true;
  }
  if (device.powRequired) {
    const powId = req.headers['x-pow-id'];
    const powNonce = req.headers['x-pow-nonce'];
    if (!powId || !powNonce) {
      // 下发 PoW 挑战，不拦截，要求客户端下次携带
      cleanExpiredPow();
      const challenge = generatePowChallenge(device.id);
      recordBlock(1014, '需要 PoW 挑战');
      return res.status(403).json({
        code: 1014,
        msg: '需要完成工作量证明挑战',
        layer: 'behavior',
        pow: challenge,
        detail: { reason: 'risk_score_triggered', score: preRiskScore.toFixed(3) }
      });
    }
    // 验证 PoW
    const powResult = verifyPow(powId, powNonce, device.id);
    if (!powResult.valid) {
      recordBlock(1014, 'PoW 验证失败');
      return res.status(403).json({
        code: 1014,
        msg: `工作量证明验证失败（${powResult.reason}）`,
        layer: 'behavior',
        detail: powResult,
      });
    }
    device.powSolved++;
    // PoW 通过后，降低风险标记（但不完全清除，持续监控）
    if (device.powSolved >= 3) {
      device.powRequired = false;
      device.powSolved = 0;
    }
  }

  // 4f. v5: 综合风险评分 — 多维度行为特征加权评分
  const riskScore = computeRiskScore(device);
  if (riskScore >= 0.7) {
    recordBlock(1013, '风险评分过高');
    return res.status(403).json({
      code: 1013,
      msg: `综合风险评分过高（${(riskScore * 100).toFixed(0)}%，阈值 70%）`,
      layer: 'behavior',
      detail: { score: riskScore.toFixed(3), factors: device._riskFactors || [] }
    });
  }

  req.defenseLayer.behavior = 'pass';
  next();
}

// v5+v6: 综合风险评分 — 9 个维度加权
function computeRiskScore(device) {
  const factors = [];
  let score = 0;

  // 1. 频率风险（5分钟内请求越多越危险）
  if (device.recentRequests.length > 40) {
    score += 0.3;
    factors.push('high_frequency');
  } else if (device.recentRequests.length > 20) {
    score += 0.15;
    factors.push('medium_frequency');
  }

  // 2. 间隔规律性风险
  if (device.intervals.length >= 10) {
    const intervals = device.intervals.slice(-20);
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (avg > 0) {
      const variance = intervals.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / intervals.length;
      const cv = Math.sqrt(variance) / avg;
      if (cv < 0.1) { score += 0.25; factors.push('very_regular'); }
      else if (cv < 0.2) { score += 0.1; factors.push('regular'); }
    }
  }

  // 3. sigCount 单调性风险
  if (device.sigCountHistory.length >= 5) {
    const recent = device.sigCountHistory.slice(-5);
    const monotonic = recent.every((v, i) => i === 0 || v >= recent[i - 1]);
    if (monotonic && recent[recent.length - 1] - recent[0] >= 4) {
      score += 0.15;
      factors.push('monotonic_sigcount');
    }
  }

  // 4. 夜间活动风险（0-5 点）
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 5 && device.requestCount > 5) {
    score += 0.1;
    factors.push('night_activity');
  }

  // 5. 请求体相似性（简化检测：连续请求 index 相同）
  if (device.requestCount > 10) {
    score += 0.05;
    factors.push('high_volume');
  }

  // 6. 短时间内多次获取挑战令牌
  if (device.challengeCount > 5) {
    score += 0.15;
    factors.push('frequent_challenge');
  }

  // ===== v6 新增维度 =====

  // 7. 时序熵值风险
  if (device.intervals.length >= ENTROPY_MIN_SAMPLES) {
    const entropy = computeEntropy(device.intervals.slice(-30));
    if (entropy < 2.0) { score += 0.2; factors.push('low_entropy'); }
    else if (entropy < 2.5) { score += 0.1; factors.push('medium_entropy'); }
  }

  // 8. 路径模式风险（仅多接口场景检测）
  if (device.pathHistory.length >= PATH_TRANSITION_MIN) {
    const uniquePaths = new Set(device.pathHistory).size;
    if (uniquePaths > 1) {
      const samePathRatio = computePathTransitionRatio(device.pathHistory);
      if (samePathRatio !== null) {
        if (samePathRatio > 0.9) { score += 0.2; factors.push('linear_path'); }
        else if (samePathRatio > 0.7) { score += 0.08; factors.push('mostly_linear_path'); }
      }
    }
  }

  // 9. API 调用比例风险（仅多端点场景检测）
  if (device.apiHistory.length >= API_RATIO_MIN) {
    const uniqueApis = new Set(device.apiHistory.map(a => a.path)).size;
    if (uniqueApis > 1) {
      const readOnlyRatio = computeApiRatio(device.apiHistory);
      if (readOnlyRatio !== null && readOnlyRatio > API_READ_ONLY_RATIO) {
        score += 0.15;
        factors.push('read_only_api');
      }
    }
  }

  device._riskFactors = factors;
  return Math.min(1, score);
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
      signature: { name: '请求签名验证', description: 'HMAC + 动态盐 + 时间戳 + nonce，防篡改防重放，密钥由 VM 字节码保护' },
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
      riskScore: d._riskFactors ? (d._riskFactors.length / 6).toFixed(2) : '0.00',
      riskFactors: d._riskFactors || [],
      challengeCount: d.challengeCount || 0,
    })),
    recentLogs: requestLog.slice(0, 50),
  });
});

// 重置
app.post('/api/reset', (req, res) => {
  devices.clear();
  usedNonces.clear();
  sessionSalts.clear();
  challengeLog.clear();
  requestLog.length = 0;
  stats.totalRequests = 0;
  stats.allowed = 0;
  stats.blocked = 0;
  stats.blockReasons = {};
  res.json({ code: 0, msg: '已重置所有数据' });
});

// 挑战令牌下发 — 每次会话生成随机盐，客户端必须携带盐值才能生成有效签名
// 盐值 5 分钟过期，即使 VM 代码被逆向，攻击者仍需持续调用此端点
app.get('/api/challenge', (req, res) => {
  cleanExpiredSalts();

  // 频率限制：防止攻击者批量获取盐值
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const log = challengeLog.get(ip) || [];
  const recent = log.filter(t => now - t < 60000);
  if (recent.length >= CHALLENGE_RATE_LIMIT) {
    return res.status(429).json({ code: 1006, msg: '获取挑战令牌过于频繁，请稍后再试' });
  }
  recent.push(now);
  challengeLog.set(ip, recent);

  const sessionId = crypto.randomBytes(16).toString('hex');
  const salt = crypto.randomBytes(16).toString('hex');
  // v5: 会话绑定 IP — 签名验证时校验 IP 一致性
  sessionSalts.set(sessionId, { salt, createdAt: now, ip });

  // v5: 记录到设备挑战计数（通过 fingerprint 关联）
  const fp = req.headers['x-fingerprint'];
  if (fp) {
    for (const dev of devices.values()) {
      if (dev.fingerprint === fp) {
        dev.challengeCount = (dev.challengeCount || 0) + 1;
        break;
      }
    }
  }

  res.json({
    sessionId,
    salt,
    expiresIn: SALT_TTL,
  });
});

// 首页 — VM 引擎代码内嵌在 HTML 中（混淆 + 加密 + 反调试）
app.get('/', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const vmCode = generateObfuscatedClientVM();
  html = html.replace('{{VM_CODE}}', vmCode);
  // 破解测试模式：服务端移除所有敏感区块（查看源码也看不到）
  if (BREACH_MODE) {
    html = stripSensitive(html);
  }
  res.set('Content-Type', 'text/html');
  res.send(html);
});

// 静态文件（禁用缓存，确保调试期间加载最新代码）
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

// ======================= 启动 =======================

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  API 防刷防采集四层防御体系演示`);
  console.log(`========================================`);
  console.log(`  服务地址: http://localhost:${PORT}`);
  console.log(`  破解测试模式: ${BREACH_MODE ? '开启（敏感信息已隐藏）' : '关闭（--no-breach）'}`);
  console.log(`  保护 API: POST /api/data`);
  console.log(`  统计面板: GET  /api/stats`);
  console.log(`  签名引擎: VM 字节码 + 动态挑战盐 (无公开算法端点)`);
  console.log(`  挑战令牌: GET  /api/challenge (盐 5min 过期, 限 30 次/min)`);
  console.log(`----------------------------------------`);
  console.log(`  防御层级:`);
  console.log(`    L1 HTTP 请求头指纹 — 缺头检测 + UA 一致性`);
  console.log(`    L2 请求签名验证     — HMAC + 时间戳 + nonce + 动态盐 + IP绑定`);
  console.log(`    L3 设备指纹追踪     — 设备 ID + 指纹一致性 + 挑战计数`);
  console.log(`    L4 行为分析引擎     — 频率 + 规律性 + 模式 + 综合风险评分`);
  console.log(`  v5 加强:`);
  console.log(`    + Canvas/WebGL/Audio 环境指纹参与签名`);
  console.log(`    + 多重反调试 (窗口尺寸 + debugger 陷阱 + 执行耗时)`);
  console.log(`    + 会话 IP 一致性校验 (防跨 IP 重放)`);
  console.log(`    + 综合风险评分系统 (6 维度加权评分)`);
  console.log(`  v6 行为分析增强:`);
  console.log(`    + 时序熵值检测 (Shannon 熵, 阈值 ${ENTROPY_THRESHOLD})`);
  console.log(`    + 路径转移概率 (马尔可夫, 同路径 > 90% 拦截)`);
  console.log(`    + API 调用比例检测 (只读占比 > 95% 拦截)`);
  console.log(`    + PoW 工作量证明 (难度 ${POW_DIFFICULTY}, 风险触发)`);
  console.log(`    + 风险评分升级 (9 维度加权)`);
  console.log(`----------------------------------------`);
  console.log(`  限制配置:`);
  console.log(`    突发: ${BURST_LIMIT} 次 / ${BURST_WINDOW / 1000}s`);
  console.log(`    持续: ${SUSTAINED_LIMIT} 次 / ${SUSTAINED_WINDOW / 1000}s`);
  console.log(`    每日: ${DAILY_LIMIT} 次`);
  console.log(`========================================\n`);
});
