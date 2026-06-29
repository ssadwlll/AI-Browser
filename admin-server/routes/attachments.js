const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const upload = require('../middleware/attachmentUpload')
const ctrl = require('../controllers/attachmentController')

router.post('/upload', auth, upload.single('file'), ctrl.upload)
router.get('/', auth, ctrl.list)
router.delete('/:id', auth, ctrl.remove)

module.exports = router
