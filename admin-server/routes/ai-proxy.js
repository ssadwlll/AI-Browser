const router = require('express').Router()
const ctrl = require('../controllers/aiProxyController')
const appAuth = require('../middleware/appAuth')

// 所有接口需要 appKey 签名认证
router.post('/chat', appAuth, ctrl.chat)

module.exports = router
