const router = require('express').Router()
const ctrl = require('../controllers/selectorFeedbackController')
const auth = require('../middleware/auth')
const appAuth = require('../middleware/appAuth')

// 上报选择器使用结果：Chrome 扩展调用，appKey 鉴权
router.post('/report', appAuth, ctrl.report)

// 后台统计查询：JWT 鉴权
router.get('/stats', auth, ctrl.stats)

module.exports = router
