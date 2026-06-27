const pool = require('../config/db')
const { success, error } = require('../utils/response')

// 使用统计概览
exports.overview = async (req, res) => {
  try {
    const [[{ totalScripts }]] = await pool.query('SELECT COUNT(*) as totalScripts FROM scripts WHERE status = "published"')
    const [[{ totalUsers }]] = await pool.query('SELECT COUNT(*) as totalUsers FROM users WHERE status = 1')
    const [[{ totalRuns }]] = await pool.query("SELECT COUNT(*) as totalRuns FROM usage_stats WHERE action = 'run'")

    // 今日统计
    const [[{ todayRuns }]] = await pool.query(
      "SELECT COUNT(*) as todayRuns FROM usage_stats WHERE action = 'run' AND DATE(created_at) = CURDATE()",
    )

    // 热门脚本 Top 10
    const [topScripts] = await pool.query(
      `SELECT s.id, s.name, COUNT(us.id) as run_count
       FROM scripts s
       LEFT JOIN usage_stats us ON s.id = us.script_id AND us.action = 'run'
       WHERE s.status = 'published'
       GROUP BY s.id
       ORDER BY run_count DESC
       LIMIT 10`,
    )

    res.json(success({
      totalScripts,
      totalUsers,
      totalRuns,
      todayRuns,
      topScripts,
    }))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 获取分类列表
exports.categories = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, COUNT(s.id) as script_count
       FROM categories c
       LEFT JOIN scripts s ON c.id = s.category_id AND s.status = 'published'
       GROUP BY c.id
       ORDER BY c.sort_order`,
    )
    res.json(success(rows))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}