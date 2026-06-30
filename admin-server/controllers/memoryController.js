// ============ MemoryController — 脚本执行经验记忆 ============
const pool = require('../config/db')
const { success, error } = require('../utils/response')

exports.record = async (req, res) => {
  try {
    const { scriptId, sessionId, ok, durationMs, errorMessage, resultSummary } = req.body
    if (!scriptId) return res.status(400).json(error('缺少 scriptId'))
    await pool.query(
      `INSERT INTO script_memories (script_id, session_id, success, duration_ms, error_message, result_summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [scriptId, sessionId || null, ok ? 1 : 0, durationMs || 0, errorMessage || null, (resultSummary || '').slice(0, 200)]
    )
    res.json(success(null, '已记录'))
  } catch (e) {
    res.status(500).json(error(e.message))
  }
}

exports.list = async (req, res) => {
  try {
    const scriptId = req.params.scriptId
    const [rows] = await pool.query(
      'SELECT id, success, duration_ms, error_message, result_summary, executed_at FROM script_memories WHERE script_id = ? ORDER BY executed_at DESC LIMIT 20',
      [scriptId]
    )
    res.json(success(rows))
  } catch (e) {
    res.status(500).json(error(e.message))
  }
}
