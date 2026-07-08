const router = require('express').Router()
const ctrl = require('../controllers/scriptController')
const memCtrl = require('../controllers/memoryController')
const auth = require('../middleware/auth')
const appAuth = require('../middleware/appAuth')
const upload = require('../middleware/upload')

router.get('/', auth, ctrl.list)
router.get('/search', appAuth, ctrl.search)  // AppKey签名：扩展端搜索工具
router.get('/agent-index', appAuth, ctrl.indexForAgent)  // AppKey签名：扩展端拉取全脚本索引
router.post('/generate-userjs', ctrl.generateUserjs)  // 生成本地脚本的油猴格式
router.get('/inject-list', ctrl.injectList)  // 公开：列出已发布脚本及其 url_pattern
router.get('/:id/userjs', ctrl.userjs)   // 油猴脚本格式（无需登录，方便油猴识别）
router.get('/:id/inject', appAuth, ctrl.injectData)   // AppKey签名：扩展端注入脚本
router.get('/:id', auth, ctrl.detail)
router.post('/', auth, upload.single('script'), ctrl.create)
router.post('/app-upload', appAuth, upload.single('script'), ctrl.create)  // AppKey签名：扩展端上传脚本
router.put('/:id', auth, ctrl.update)
router.delete('/:id', auth, ctrl.remove)
router.get('/:id/download', auth, ctrl.download)
router.post('/:id/stats', auth, ctrl.reportStats)
// P3: 经验记忆
router.post('/:id/memories', appAuth, memCtrl.record)  // AppKey签名：扩展端记录记忆
router.get('/:id/memories', auth, memCtrl.list)

module.exports = router