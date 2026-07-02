const pool = require('../config/db')
const { success, error, paginated } = require('../utils/response')

// 获取本地日期字符串 YYYY-MM-DD（避免 toISOString 返回 UTC 日期）
function getLocalDateString(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * GET /api/ai-call-logs
 * 查询参数:
 *   page, pageSize          - 分页
 *   model                   - 模型 id 精确匹配
 *   provider_id             - 供应商 id
 *   app_key_id              - AppKey id
 *   success                 - 1/0 成功/失败
 *   start_date, end_date    - 日期范围 (YYYY-MM-DD)
 *   keyword                 - error_msg 模糊匹配
 */
exports.list = async (req, res) => {
  try {
    const {
      page = 1, pageSize = 20,
      model, provider_id, app_key_id, success: successFlag,
      start_date, end_date, keyword,
    } = req.query

    const pageNum = Math.max(1, parseInt(page) || 1)
    const size = Math.min(100, Math.max(1, parseInt(pageSize) || 20))
    const offset = (pageNum - 1) * size

    const where = []
    const params = []
    if (model) { where.push('l.model = ?'); params.push(model) }
    if (provider_id) { where.push('l.provider_id = ?'); params.push(parseInt(provider_id)) }
    if (app_key_id) { where.push('l.app_key_id = ?'); params.push(parseInt(app_key_id)) }
    if (successFlag === '1' || successFlag === '0') {
      where.push('l.success = ?'); params.push(parseInt(successFlag))
    }
    if (start_date) { where.push('DATE(l.created_at) >= ?'); params.push(start_date) }
    if (end_date) { where.push('DATE(l.created_at) <= ?'); params.push(end_date) }
    if (keyword) { where.push('l.error_msg LIKE ?'); params.push(`%${keyword}%`) }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''

    // 统计总数
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM ai_call_logs l ${whereSql}`,
      params,
    )

    // 分页查询，JOIN 出供应商名与 AppKey 名
    const [rows] = await pool.query(
      `SELECT l.id, l.model, l.stream, l.prompt_tokens, l.completion_tokens, l.total_tokens,
              l.duration_ms, l.status_code, l.success, l.error_msg, l.created_at,
              l.provider_id, p.display_name AS provider_name,
              l.app_key_id, k.name AS app_key_name
       FROM ai_call_logs l
       LEFT JOIN ai_providers p ON l.provider_id = p.id
       LEFT JOIN app_keys k ON l.app_key_id = k.id
       ${whereSql}
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, size, offset],
    )

    res.json(paginated(rows, pageNum, size, total))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

/**
 * GET /api/ai-call-logs/daily-stats
 * 按天聚合统计（调用次数 + token 汇总 + 成功率 + 平均耗时）
 * 查询参数:
 *   start_date, end_date    - 日期范围 (YYYY-MM-DD)，默认最近 30 天
 *   provider_id, model, app_key_id  - 可选过滤
 */
exports.dailyStats = async (req, res) => {
  try {
    let { start_date, end_date, provider_id, model, app_key_id } = req.query

    // 默认最近 30 天（使用本地日期，避免 UTC 时区偏差）
    if (!end_date) {
      end_date = getLocalDateString(new Date())
    }
    if (!start_date) {
      const d = new Date()
      d.setDate(d.getDate() - 29)
      start_date = getLocalDateString(d)
    }

    const where = ['DATE(l.created_at) BETWEEN ? AND ?']
    const params = [start_date, end_date]
    if (provider_id) { where.push('l.provider_id = ?'); params.push(parseInt(provider_id)) }
    if (model) { where.push('l.model = ?'); params.push(model) }
    if (app_key_id) { where.push('l.app_key_id = ?'); params.push(parseInt(app_key_id)) }

    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(l.created_at, '%Y-%m-%d') AS date,
              COUNT(*) AS call_count,
              SUM(CASE WHEN l.success = 1 THEN 1 ELSE 0 END) AS success_count,
              SUM(CASE WHEN l.success = 0 THEN 1 ELSE 0 END) AS fail_count,
              COALESCE(SUM(l.prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(l.completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(l.total_tokens), 0) AS total_tokens,
              ROUND(AVG(l.duration_ms), 0) AS avg_duration_ms
       FROM ai_call_logs l
       WHERE ${where.join(' AND ')}
       GROUP BY DATE_FORMAT(l.created_at, '%Y-%m-%d')
       ORDER BY date ASC`,
      params,
    )

    // 按模型维度汇总（用于饼图/排行）
    const [byModel] = await pool.query(
      `SELECT l.model, COUNT(*) AS call_count,
              COALESCE(SUM(l.total_tokens), 0) AS total_tokens
       FROM ai_call_logs l
       WHERE ${where.join(' AND ')}
       GROUP BY l.model
       ORDER BY call_count DESC`,
      params,
    )

    // 按天+模型维度汇总（用于每日分模型图表）
    const [dailyByModelRaw] = await pool.query(
      `SELECT DATE_FORMAT(l.created_at, '%Y-%m-%d') AS date, l.model,
              COUNT(*) AS call_count,
              COALESCE(SUM(l.total_tokens), 0) AS total_tokens
       FROM ai_call_logs l
       WHERE ${where.join(' AND ')}
       GROUP BY DATE_FORMAT(l.created_at, '%Y-%m-%d'), l.model
       ORDER BY date ASC, call_count DESC`,
      params,
    )

    // 概览数字
    const [overview] = await pool.query(
      `SELECT COUNT(*) AS total_calls,
              SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS total_success,
              SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS total_fail,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS total_completion_tokens,
              ROUND(AVG(duration_ms), 0) AS avg_duration_ms
       FROM ai_call_logs l
       WHERE ${where.join(' AND ')}`,
      params,
    )

    res.json(success({
      startDate: start_date,
      endDate: end_date,
      daily: rows,
      byModel,
      dailyByModel: dailyByModelRaw,
      overview: overview[0] || {},
    }))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

/**
 * GET /api/ai-call-logs/filters
 * 返回可选的 model / provider / app_key 列表，供前端筛选下拉用
 */
exports.filters = async (req, res) => {
  try {
    const [models] = await pool.query(
      `SELECT DISTINCT model FROM ai_call_logs ORDER BY model`,
    )
    const [providers] = await pool.query(
      `SELECT DISTINCT p.id, p.display_name
       FROM ai_providers p
       WHERE p.id IN (SELECT DISTINCT provider_id FROM ai_call_logs WHERE provider_id IS NOT NULL)
       ORDER BY p.display_name`,
    )
    const [appKeys] = await pool.query(
      `SELECT DISTINCT k.id, k.name
       FROM app_keys k
       WHERE k.id IN (SELECT DISTINCT app_key_id FROM ai_call_logs WHERE app_key_id IS NOT NULL)
       ORDER BY k.name`,
    )
    res.json(success({ models: models.map(r => r.model), providers, appKeys }))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}
