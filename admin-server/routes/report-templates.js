const router = require('express').Router()
const ctrl = require('../controllers/reportTemplateController')
const auth = require('../middleware/auth')
const appAuth = require('../middleware/appAuth')

// 扩展端拉取已发布模板（AppKey 签名鉴权）
router.get('/', appAuth, ctrl.listForAgent)

// 管理后台 CRUD（JWT 鉴权）
router.get('/admin', auth, ctrl.list)
router.get('/admin/:id', auth, ctrl.detail)
router.post('/admin', auth, ctrl.create)
router.put('/admin/:id', auth, ctrl.update)
router.delete('/admin/:id', auth, ctrl.remove)

module.exports = router
