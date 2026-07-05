const pool = require('../config/db')
const { success, error } = require('../utils/response')

// 暴露给客户端（appKey 认证）的设置 key 白名单
const PUBLIC_KEYS = new Set([
  'agent_max_rounds',
  'agent_system_prompt',
  'pdf_max_size',
  'image_max_size',
])

// 数值类设置自动转换为 number 类型返回
const NUMERIC_KEYS = new Set(['agent_max_rounds', 'pdf_max_size', 'image_max_size'])

// GET /api/app-settings - admin: 列出所有设置
exports.list = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT setting_key, setting_value, description, updated_at FROM app_settings ORDER BY setting_key',
    )
    res.json(success(rows))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// PUT /api/app-settings/:key - admin: 更新或新增一条设置
exports.update = async (req, res) => {
  try {
    const { key } = req.params
    const { value, description } = req.body

    if (value === undefined) {
      return res.status(400).json(error('value 不能为空', 400))
    }
    if (!key) {
      return res.status(400).json(error('key 不能为空', 400))
    }

    await pool.query(
      `INSERT INTO app_settings (setting_key, setting_value, description)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
       description = COALESCE(NULLIF(VALUES(description), ''), app_settings.description)`,
      [key, String(value), description ?? null],
    )

    res.json(success(null, '设置已更新'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// DELETE /api/app-settings/:key - admin: 删除一条设置
exports.remove = async (req, res) => {
  try {
    const { key } = req.params
    await pool.query('DELETE FROM app_settings WHERE setting_key = ?', [key])
    res.json(success(null, '设置已删除'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// GET /api/app-settings/client - 客户端（appKey 认证）：返回公开设置对象
// 仅返回白名单内的 key，数值自动转换
exports.clientSettings = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT setting_key, setting_value FROM app_settings',
    )
    const result = {}
    for (const row of rows) {
      if (!PUBLIC_KEYS.has(row.setting_key)) continue
      if (NUMERIC_KEYS.has(row.setting_key)) {
        const n = parseInt(row.setting_value, 10)
        result[row.setting_key] = isNaN(n) ? 0 : n
      } else {
        result[row.setting_key] = row.setting_value
      }
    }
    res.json(success(result))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}
