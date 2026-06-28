const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/hotspotController')

// GET /api/hotspot — 获取热点聚合
router.get('/', ctrl.fetch)

module.exports = router
