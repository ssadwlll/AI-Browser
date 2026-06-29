const router = require('express').Router()
const ctrl = require('../controllers/aiModelController')
const auth = require('../middleware/auth')
const appAuth = require('../middleware/appAuth')

// 客户端可用模型列表：不需要 JWT，需要 appKey 签名认证
// 必须放在参数化路由之前
router.get('/available', appAuth, ctrl.available)

// 以下接口需要 JWT 认证
router.get('/providers', auth, ctrl.listProviders)
router.post('/providers', auth, ctrl.createProvider)
router.put('/providers/:id', auth, ctrl.updateProvider)
router.delete('/providers/:id', auth, ctrl.deleteProvider)

router.get('/', auth, ctrl.listModels)
router.post('/', auth, ctrl.createModel)
router.put('/:id', auth, ctrl.updateModel)
router.delete('/:id', auth, ctrl.deleteModel)

module.exports = router
