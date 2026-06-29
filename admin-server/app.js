require('dotenv').config()
const express = require('express')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const cors = require('cors')
const morgan = require('morgan')
const errorHandler = require('./middleware/errorHandler')

const authRoutes = require('./routes/auth')
const scriptRoutes = require('./routes/scripts')
const hotspotRoutes = require('./routes/hotspot')
const statRoutes = require('./routes/stats')
const userRoutes = require('./routes/users')
const categoryRoutes = require('./routes/categories')
const appKeyRoutes = require('./routes/app-keys')
const aiModelRoutes = require('./routes/ai-models')
const aiProxyRoutes = require('./routes/ai-proxy')
const aiCallLogRoutes = require('./routes/ai-call-logs')

const app = express()
const PORT = process.env.PORT || 3001

// 确保上传目录存在
const uploadDir = path.join(__dirname, 'uploads')
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

// 中间件
app.use(cors())
app.use(morgan('dev'))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// API 路由
app.use('/api/auth', authRoutes)
app.use('/api/scripts', scriptRoutes)
app.use('/api/hotspot', hotspotRoutes)
app.use('/api/stats', statRoutes)
app.use('/api/users', userRoutes)
app.use('/api/categories', categoryRoutes)
app.use('/api/app-keys', appKeyRoutes)
app.use('/api/ai-models', aiModelRoutes)
app.use('/api/ai-proxy', aiProxyRoutes)
app.use('/api/ai-call-logs', aiCallLogRoutes)
app.use('/api/attachments', require('./routes/attachments'))

// 静态文件 — 管理后台前端资源（CSS/JS）和上传的附件
app.use(express.static(path.join(__dirname, 'public')))
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// 代理预览接口 - 获取目标页面 HTML，注入脚本，返回 JSON 给前端用 srcdoc 渲染
app.get('/api/proxy-preview', (req, res) => {
  const targetUrl = req.query.url
  if (!targetUrl) {
    return res.status(400).json({ success: false, error: '缺少 url 参数' })
  }
  try {
    const parsedUrl = new URL(targetUrl)
    const isHttps = parsedUrl.protocol === 'https:'
    const client = isHttps ? https : http
    // 请求时要求非压缩响应，避免处理 gzip
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    }
    const proxyReq = client.request(options, (proxyRes) => {
      const chunks = []
      proxyRes.on('data', chunk => chunks.push(chunk))
      proxyRes.on('end', () => {
        const raw = Buffer.concat(chunks)
        let html = ''
        try { html = raw.toString('utf-8') } catch { html = raw.toString() }
        res.json({ success: true, html, url: targetUrl })
      })
    })
    proxyReq.on('error', (e) => {
      res.status(502).json({ success: false, error: `代理请求失败: ${e.message}` })
    })
    proxyReq.setTimeout(15000, () => {
      proxyReq.destroy()
      res.status(504).json({ success: false, error: '代理请求超时' })
    })
    proxyReq.end()
  } catch (e) {
    res.status(400).json({ success: false, error: `URL 格式错误: ${e.message}` })
  }
})

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'AI Browser Admin Server is running', time: new Date().toISOString() })
})

// 根路径 - 管理后台首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// 全局错误处理
app.use(errorHandler)

// ============ 启动 Python Embedding 服务 ============
const { spawn } = require('child_process')
const EMBEDDING_PORT = process.env.EMBEDDING_PORT || 9091
let embeddingProcess = null

const embeddingService = require('./services/embeddingService')

function startEmbeddingServer() {
  const pyScript = path.join(__dirname, 'services', 'embedding_server.py')
  if (!fs.existsSync(pyScript)) {
    console.warn('[Admin Server] embedding_server.py 不存在，跳过语义搜索')
    return
  }
  console.log(`[Admin Server] 启动 Python embedding 服务 (端口 ${EMBEDDING_PORT})...`)
  embeddingProcess = spawn('python', [pyScript, '--port', String(EMBEDDING_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  embeddingProcess.stdout.on('data', (data) => {
    console.log(`[Embedding/Python] ${data.toString().trim()}`)
  })
  embeddingProcess.stderr.on('data', (data) => {
    console.warn(`[Embedding/Python] ${data.toString().trim()}`)
  })
  embeddingProcess.on('close', (code) => {
    console.log(`[Embedding] Python 进程退出, 退出码: ${code}`)
    embeddingProcess = null
  })
  embeddingProcess.on('error', (err) => {
    console.warn('[Embedding] Python 进程启动失败:', err.message)
    embeddingProcess = null
  })
}

function stopEmbeddingServer() {
  if (embeddingProcess) {
    console.log('[Admin Server] 停止 Python embedding 服务...')
    embeddingProcess.kill('SIGTERM')
    embeddingProcess = null
  }
}

// ============ 启动服务器 ============
app.listen(PORT, async () => {
  console.log(`[Admin Server] 运行在 http://localhost:${PORT}`)
  console.log(`[Admin Server] 健康检查: http://localhost:${PORT}/api/health`)

  // 先启动 Python embedding 服务，再初始化 Node.js embedding 客户端
  startEmbeddingServer()
  embeddingService.init().catch(e => console.warn('[Admin Server] Embedding 初始化跳过:', e.message))
})

// 优雅退出
process.on('SIGINT', () => {
  stopEmbeddingServer()
  process.exit(0)
})
process.on('SIGTERM', () => {
  stopEmbeddingServer()
  process.exit(0)
})