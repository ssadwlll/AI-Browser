const appAuth = require('./appAuth')
const jwtAuth = require('./auth')

// 先尝试 JWT，失败再尝试 appKey 签名
module.exports = (req, res, next) => {
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return jwtAuth(req, res, next)
  }
  // 没有 JWT，尝试 appKey 签名
  if (req.headers['x-app-key']) {
    return appAuth(req, res, next)
  }
  return res.status(401).json({ success: false, error: '未提供认证信息' })
}
