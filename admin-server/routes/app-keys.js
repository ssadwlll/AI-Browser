const router = require('express').Router()
const ctrl = require('../controllers/appKeyController')
const auth = require('../middleware/auth')

// 所有接口需要 JWT 认证
router.get('/', auth, ctrl.list)
router.post('/', auth, ctrl.create)
router.put('/:id', auth, ctrl.update)
router.delete('/:id', auth, ctrl.remove)
router.post('/verify', auth, ctrl.verify)

module.exports = router
