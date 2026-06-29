const router = require('express').Router()
const multer = require('multer')
const path = require('path')
const ctrl = require('../controllers/aiProxyController')
const appAuth = require('../middleware/appAuth')

// 文件上传的 multer 配置（图片 + PDF）
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', 'uploads'),
    filename: (_req, file, cb) => {
      const suffix = Date.now() + '-' + Math.round(Math.random() * 1e9)
      cb(null, suffix + path.extname(file.originalname))
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
})

// 所有接口需要 appKey 签名认证
router.post('/chat', appAuth, ctrl.chat)
router.post('/upload-image', appAuth, upload.single('file'), ctrl.uploadImage)
router.post('/parse-pdf', appAuth, upload.single('file'), ctrl.parsePdf)

module.exports = router
