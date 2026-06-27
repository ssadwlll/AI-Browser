const router = require('express').Router()
const ctrl = require('../controllers/statController')
const auth = require('../middleware/auth')

router.get('/overview', auth, ctrl.overview)
router.get('/categories', auth, ctrl.categories)

module.exports = router