const pool = require('../config/db')
const { success, error } = require('../utils/response')

/**
 * 选择器反馈控制器
 * 接收 Chrome 扩展上报的选择器使用结果，按 host+selector 聚合
 * RAG 检索时关联此表，过滤失效选择器
 */

const FAIL_THRESHOLD = 3        // 累计失败 3 次以上视为失效
const STALE_DAYS = 30          // 30 天内的失败记录才视为"近期失效"

/**
 * POST /api/selector-feedback/report
 * Chrome 扩展调用（appKey 鉴权）
 * Body: { host, selector, toolName?, taskId?, resultStatus, itemCount? }
 *   - resultStatus: 'success' | 'failure'
 *   - itemCount: 成功时返回的元素数量
 */
exports.report = async (req, res) => {
  try {
    const {
      host, selector, toolName, taskId,
      resultStatus, itemCount = 0,
    } = req.body || {}

    // 基础校验
    if (!host || typeof host !== 'string') return res.status(400).json(error('缺少 host'))
    if (!selector || typeof selector !== 'string') return res.status(400).json(error('缺少 selector'))
    if (!['success', 'failure'].includes(resultStatus)) {
      return res.status(400).json(error('resultStatus 必须为 success 或 failure'))
    }

    // host 截断到 128 字符；selector 截断到 255 字符
    const safeHost = host.slice(0, 128)
    const safeSelector = selector.slice(0, 255)

    // 累计计数器：UPSERT（不存在则初始化，存在则累加）
    // 注意：使用 INSERT ... ON DUPLICATE KEY UPDATE 避免并发问题
    if (resultStatus === 'success') {
      await pool.query(
        `INSERT INTO selector_feedback
          (host, selector, tool_name, task_id, result_status, item_count, fail_count, success_count, last_success_at)
         VALUES (?, ?, ?, ?, 'success', ?, 0, 1, NOW())
         ON DUPLICATE KEY UPDATE
          success_count = success_count + 1,
          last_success_at = NOW(),
          item_count = VALUES(item_count),
          task_id = VALUES(task_id)`,
        [safeHost, safeSelector, toolName || null, taskId || null, parseInt(itemCount) || 0]
      )
    } else {
      // failure：每次都插入一条新记录（保留失败历史），同时累加 fail_count
      // 注意：失败记录不更新 success_count，避免污染成功信号
      await pool.query(
        `INSERT INTO selector_feedback
          (host, selector, tool_name, task_id, result_status, item_count, fail_count, success_count, last_failure_at)
         VALUES (?, ?, ?, ?, 'failure', 0, 1, 0, NOW())
         ON DUPLICATE KEY UPDATE
          fail_count = fail_count + 1,
          last_failure_at = NOW(),
          task_id = VALUES(task_id)`,
        [safeHost, safeSelector, toolName || null, taskId || null]
      )
    }

    return res.json(success({ host: safeHost, selector: safeSelector, resultStatus }))
  } catch (e) {
    console.error('[SelectorFeedback] 上报失败:', e.message)
    return res.status(500).json(error('上报失败: ' + e.message))
  }
}

/**
 * 查询指定 host 下所有选择器的最新状态（供 RAG 内部调用）
 * 返回 Map: { selector: { failCount, successCount, lastSuccessAt, lastFailureAt, isStale } }
 */
exports.queryByHost = async (host) => {
  if (!host) return new Map()
  try {
    const [rows] = await pool.query(
      `SELECT selector,
              MAX(fail_count) as fail_count,
              MAX(success_count) as success_count,
              MAX(last_success_at) as last_success_at,
              MAX(last_failure_at) as last_failure_at
       FROM selector_feedback
       WHERE host = ?
       GROUP BY selector`,
      [host.slice(0, 128)]
    )
    const map = new Map()
    const now = Date.now()
    for (const r of rows) {
      const lastFailAt = r.last_failure_at ? new Date(r.last_failure_at).getTime() : 0
      const daysSinceFail = (now - lastFailAt) / (24 * 3600 * 1000)
      // 失效定义：累计失败 >= 阈值 AND 最近 30 天内有失败记录
      // 注意：如果之后又有成功，则视为已恢复
      const isStale = Number(r.fail_count) >= FAIL_THRESHOLD
        && daysSinceFail < STALE_DAYS
        && (!r.last_success_at || new Date(r.last_success_at).getTime() < lastFailAt)
      map.set(r.selector, {
        failCount: Number(r.fail_count) || 0,
        successCount: Number(r.success_count) || 0,
        lastSuccessAt: r.last_success_at,
        lastFailureAt: r.last_failure_at,
        isStale,
      })
    }
    return map
  } catch (e) {
    console.warn('[SelectorFeedback] 查询失败（非致命）:', e.message)
    return new Map()
  }
}

/**
 * GET /api/selector-feedback/stats
 * 后台管理页面查询统计（JWT 鉴权）
 */
exports.stats = async (req, res) => {
  try {
    const [[totals]] = await pool.query(
      `SELECT
         COUNT(*) as totalRecords,
         COUNT(DISTINCT CONCAT(host, '|', selector)) as uniqueSelectors,
         SUM(CASE WHEN result_status = 'success' THEN 1 ELSE 0 END) as successReports,
         SUM(CASE WHEN result_status = 'failure' THEN 1 ELSE 0 END) as failureReports
       FROM selector_feedback`
    )
    // 失效选择器列表（fail_count >= 3 且最近 30 天内失败过）
    const [staleRows] = await pool.query(
      `SELECT host, selector, fail_count, success_count, last_success_at, last_failure_at
       FROM selector_feedback
       WHERE fail_count >= ?
         AND last_failure_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       ORDER BY last_failure_at DESC
       LIMIT 100`,
      [FAIL_THRESHOLD, STALE_DAYS]
    )
    return res.json(success({
      totals: {
        totalRecords: Number(totals.totalRecords) || 0,
        uniqueSelectors: Number(totals.uniqueSelectors) || 0,
        successReports: Number(totals.successReports) || 0,
        failureReports: Number(totals.failureReports) || 0,
      },
      failThreshold: FAIL_THRESHOLD,
      staleDays: STALE_DAYS,
      staleSelectors: staleRows,
    }))
  } catch (e) {
    console.error('[SelectorFeedback] 统计失败:', e.message)
    return res.status(500).json(error('统计失败: ' + e.message))
  }
}
