const router = require('express').Router()
const ctrl = require('../controllers/conversationArchiveController')
const auth = require('../middleware/auth')
const appAuth = require('../middleware/appAuth')

// 上传：由 Chrome 扩展调用，使用 appKey 鉴权
router.post('/', appAuth, ctrl.upload)

// RAG 检索：由 Chrome 扩展调用，使用 appKey 鉴权
router.post('/rag', appAuth, ctrl.ragRetrieve)

// 后台查询、详情、统计、删除：JWT 鉴权
router.get('/', auth, ctrl.list)
router.get('/stats/summary', auth, ctrl.stats)
router.get('/:taskId', auth, ctrl.detail)
router.delete('/:taskId', auth, ctrl.remove)

module.exports = router
