const router = require('express').Router()
const ctrl = require('../controllers/forgeController')
const auth = require('../middleware/auth')

router.post('/analyze', auth, ctrl.analyze)

module.exports = router
