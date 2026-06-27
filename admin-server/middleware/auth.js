const jwt = require('jsonwebtoken')

module.exports = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token
  if (!token) {
    return res.status(401).json({ success: false, error: '未登录，请先登录' })
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'ai-browser-secret')
    next()
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Token 无效或已过期' })
  }
}

/**
 * 角色权限中间件
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: '权限不足' })
    }
    next()
  }
}

module.exports.requireRole = requireRole