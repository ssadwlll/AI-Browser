const router = require('express').Router()
const ctrl = require('../controllers/appSettingController')
const auth = require('../middleware/auth')
const appAuth = require('../middleware/appAuth')

// 客户端读取公开设置：不需要 JWT，需要 appKey 签名认证
// 必须放在参数化路由之前，避免被 /:key 匹配
router.get('/client', appAuth, ctrl.clientSettings)

// 以下接口需要 JWT 认证（管理后台）
router.get('/', auth, ctrl.list)
router.put('/:key', auth, ctrl.update)
router.delete('/:key', auth, ctrl.remove)

module.exports = router
