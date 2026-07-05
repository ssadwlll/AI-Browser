const router = require('express').Router()
const ctrl = require('../controllers/collectPageController')

router.post('/', ctrl.collect)
router.post('/wenzhou-detail', ctrl.wenzhouDetail)

module.exports = router
