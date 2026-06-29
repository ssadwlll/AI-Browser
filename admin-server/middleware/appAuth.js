const crypto = require('crypto')
const pool = require('../config/db')

// 时间戳有效窗口（秒），与 coze-proxy.php 保持一致（5分钟）
const TIMESTAMP_TOLERANCE = 300

/**
 * 生成签名：HMAC-SHA256(appKey + timestamp, appSecret)
 * 返回小写 hex 字符串，与 PHP hash_hmac('sha256', ..., ...) 输出一致
 */
function generateSignature(appKey, appSecret, timestamp) {
  const message = `${appKey}${timestamp}`
  return crypto.createHmac('sha256', appSecret).update(message, 'utf8').digest('hex')
}

/**
 * AppKey 签名认证中间件
 * 校验请求头：X-App-Key / X-Timestamp / X-Sign
 * 通过后将 appKey 信息挂到 req.appKeyInfo
 */
module.exports = async (req, res, next) => {
  try {
    const appKey = req.headers['x-app-key'] || ''
    const timestamp = req.headers['x-timestamp'] || ''
    const sign = req.headers['x-sign'] || ''

    if (!appKey || !timestamp || !sign) {
      return res.status(401).json({ success: false, error: '缺少认证信息（appKey/timestamp/sign）' })
    }

    // 时间戳5分钟内有效
    const now = Math.floor(Date.now() / 1000)
    const ts = parseInt(timestamp, 10)
    if (isNaN(ts) || Math.abs(now - ts) > TIMESTAMP_TOLERANCE) {
      return res.status(401).json({ success: false, error: '签名已过期' })
    }

    // 查询 appKey
    const [rows] = await pool.query(
      'SELECT id, app_key, app_secret, name, daily_limit, status FROM app_keys WHERE app_key = ? AND status = 1',
      [appKey],
    )
    if (rows.length === 0) {
      return res.status(401).json({ success: false, error: '无效的AppKey' })
    }

    const credential = rows[0]
    const expectedSign = generateSignature(appKey, credential.app_secret, timestamp)

    // 时序安全的字符串比较
    const signBuf = Buffer.from(String(sign).toLowerCase(), 'utf8')
    const expectedBuf = Buffer.from(expectedSign, 'utf8')
    if (signBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(signBuf, expectedBuf)) {
      return res.status(401).json({ success: false, error: '签名验证失败' })
    }

    req.appKeyInfo = credential
    next()
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message })
  }
}

module.exports.generateSignature = generateSignature
