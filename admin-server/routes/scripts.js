const router = require('express').Router()
const ctrl = require('../controllers/scriptController')
const auth = require('../middleware/auth')
const upload = require('../middleware/upload')

router.get('/', auth, ctrl.list)
router.post('/generate-userjs', ctrl.generateUserjs)  // 生成本地脚本的油猴格式
router.get('/inject-list', ctrl.injectList)  // 公开：列出已发布脚本及其 url_pattern
router.get('/:id/userjs', ctrl.userjs)   // 油猴脚本格式（无需登录，方便油猴识别）
router.get('/:id/inject', ctrl.injectData)   // 公开：获取拼接代码+参数用于注入
router.get('/:id', auth, ctrl.detail)
router.post('/', auth, upload.single('script'), ctrl.create)
router.put('/:id', auth, ctrl.update)
router.delete('/:id', auth, ctrl.remove)
router.get('/:id/download', auth, ctrl.download)
router.post('/:id/stats', auth, ctrl.reportStats)

module.exports = router