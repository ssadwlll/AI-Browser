const router = require('express').Router()
const ctrl = require('../controllers/collectPageController')

router.post('/', ctrl.collect)

module.exports = router
