const router = require('express').Router()
const ctrl = require('../controllers/aiCallLogController')
const auth = require('../middleware/auth')

// 所有接口需 JWT 认证（后台管理用）
router.get('/', auth, ctrl.list)
router.get('/daily-stats', auth, ctrl.dailyStats)
router.get('/filters', auth, ctrl.filters)

module.exports = router
