const crypto = require('crypto')
const pool = require('../config/db')
const { success, error } = require('../utils/response')
const { generateSignature } = require('../middleware/appAuth')

// 生成 appKey：16 位 hex
function genAppKey() {
  return crypto.randomBytes(8).toString('hex')
}

// 生成 appSecret：32 位 hex
function genAppSecret() {
  return crypto.randomBytes(16).toString('hex')
}

// 对 appSecret 做脱敏：保留前 8 位 + ****
function maskSecret(secret) {
  if (!secret) return ''
  const s = String(secret)
  if (s.length <= 8) return s + '****'
  return s.slice(0, 8) + '****'
}

// 列表（不返回 appSecret，只返回前 8 位 + ****）
exports.list = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, app_key, app_secret, name, daily_limit, status, created_at, updated_at FROM app_keys ORDER BY id DESC',
    )
    const data = rows.map((r) => ({ ...r, app_secret: maskSecret(r.app_secret) }))
    res.json(success(data))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 创建（自动生成 appKey=16位hex, appSecret=32位hex）
exports.create = async (req, res) => {
  try {
    const { name, daily_limit, status } = req.body
    const appKey = genAppKey()
    const appSecret = genAppSecret()

    const [result] = await pool.query(
      'INSERT INTO app_keys (app_key, app_secret, name, daily_limit, status) VALUES (?, ?, ?, ?, ?)',
      [appKey, appSecret, name || '', parseInt(daily_limit) || 0, status === undefined ? 1 : parseInt(status)],
    )

    // 创建时返回完整 appSecret 一次，便于记录
    res.json(
      success(
        {
          id: result.insertId,
          app_key: appKey,
          app_secret: appSecret,
          name: name || '',
          daily_limit: parseInt(daily_limit) || 0,
          status: status === undefined ? 1 : parseInt(status),
          secret_shown_once: true,
        },
        'AppKey 创建成功（请妥善保存 appSecret，之后将不再显示完整密钥）',
      ),
    )
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 更新 name/daily_limit/status
exports.update = async (req, res) => {
  try {
    const { name, daily_limit, status } = req.body
    const fields = []
    const params = []

    if (name !== undefined) { fields.push('name = ?'); params.push(name) }
    if (daily_limit !== undefined) { fields.push('daily_limit = ?'); params.push(parseInt(daily_limit)) }
    if (status !== undefined) { fields.push('status = ?'); params.push(parseInt(status)) }

    if (fields.length === 0) {
      return res.status(400).json(error('没有需要更新的字段', 400))
    }

    const [rows] = await pool.query('SELECT id FROM app_keys WHERE id = ?', [req.params.id])
    if (rows.length === 0) {
      return res.status(404).json(error('AppKey 不存在', 404))
    }

    params.push(req.params.id)
    await pool.query(`UPDATE app_keys SET ${fields.join(', ')} WHERE id = ?`, params)

    res.json(success(null, 'AppKey 更新成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 删除
exports.remove = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id FROM app_keys WHERE id = ?', [req.params.id])
    if (rows.length === 0) {
      return res.status(404).json(error('AppKey 不存在', 404))
    }
    await pool.query('DELETE FROM app_keys WHERE id = ?', [req.params.id])
    res.json(success(null, 'AppKey 删除成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 验证 appKey + appSecret + 签名（内部使用）
// 请求体：{ appKey, appSecret, timestamp?, sign? }
// 不传 timestamp/sign 时只做 appKey+appSecret 校验
exports.verify = async (req, res) => {
  try {
    const { appKey, appSecret, timestamp, sign } = req.body || {}
    if (!appKey || !appSecret) {
      return res.status(400).json(error('appKey 和 appSecret 不能为空', 400))
    }

    const [rows] = await pool.query(
      'SELECT id, app_key, app_secret, name, daily_limit, status FROM app_keys WHERE app_key = ?',
      [appKey],
    )
    if (rows.length === 0 || rows[0].app_secret !== appSecret) {
      return res.status(401).json(error('appKey 或 appSecret 错误', 401))
    }
    if (rows[0].status !== 1) {
      return res.status(403).json(error('AppKey 已被禁用', 403))
    }

    // 如果传了 timestamp + sign，额外校验签名
    if (timestamp && sign) {
      const expected = generateSignature(appKey, appSecret, timestamp)
      const signBuf = Buffer.from(String(sign).toLowerCase(), 'utf8')
      const expectedBuf = Buffer.from(expected, 'utf8')
      if (signBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(signBuf, expectedBuf)) {
        return res.status(401).json(error('签名验证失败', 401))
      }
    }

    const credential = rows[0]
    res.json(
      success(
        {
          id: credential.id,
          app_key: credential.app_key,
          name: credential.name,
          daily_limit: credential.daily_limit,
          status: credential.status,
        },
        '验证通过',
      ),
    )
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}
