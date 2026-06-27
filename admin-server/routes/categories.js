const router = require('express').Router()
const ctrl = require('../controllers/categoryController')
const auth = require('../middleware/auth')

// 分类 CRUD 路由
router.get('/', auth, ctrl.list)
router.get('/:id', auth, ctrl.detail)
router.post('/', auth, ctrl.create)
router.put('/:id', auth, ctrl.update)
router.delete('/:id', auth, ctrl.remove)

module.exports = router
