const multer = require('multer')
const path = require('path')

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9)
    const ext = path.extname(file.originalname)
    cb(null, uniqueSuffix + ext)
  },
})

const fileFilter = (req, file, cb) => {
  const allowed = [
    'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf',
    'text/plain', 'text/csv',
    'application/json',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document' // .docx
  ]
  if (allowed.includes(file.mimetype)) {
    cb(null, true)
  } else {
    cb(new Error('不支持的文件类型: ' + file.mimetype + '，支持: 图片/PDF/文本文档'), false)
  }
}

module.exports = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
    fieldSize: 50 * 1024 * 1024,
  },
})
