const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { URL } = require('url')
const pool = require('../config/db')
const { error } = require('../utils/response')

/**
 * 根据 model_id 查找模型及其 provider
 */
async function findModelWithProvider(modelId) {
  const [rows] = await pool.query(
    `SELECT m.id, m.model_id, m.display_name, m.supports_stream, m.supports_tools,
            p.id AS provider_id, p.name AS provider_name, p.base_url, p.api_key, p.status AS provider_status
     FROM ai_models m
     JOIN ai_providers p ON m.provider_id = p.id
     WHERE m.model_id = ? AND m.status = 1 AND p.status = 1
     LIMIT 1`,
    [modelId],
  )
  return rows[0] || null
}

/**
 * POST /api/ai-proxy/chat
 * 请求体: { model, messages, temperature?, max_tokens?, stream?, tools?, tool_choice? }
 */
exports.chat = async (req, res) => {
  // ============ 调用日志上下文（在 try 之外声明，确保 catch 也能记录） ============
  const startTime = Date.now()
  let logged = false
  const logCtx = {
    appKeyId: req.appKeyInfo && req.appKeyInfo.id ? req.appKeyInfo.id : null,
    providerId: null,
    model: null,
    wantStream: false,
  }
  const logCall = ({ statusCode = null, success = true, errorMsg = null, usage = null }) => {
    if (logged) return
    logged = true
    const durationMs = Date.now() - startTime
    // fire-and-forget，日志失败不影响主流程
    pool.query(
      `INSERT INTO ai_call_logs
       (app_key_id, provider_id, model, stream, prompt_tokens, completion_tokens, total_tokens, duration_ms, status_code, success, error_msg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        logCtx.appKeyId,
        logCtx.providerId,
        logCtx.model,
        logCtx.wantStream ? 1 : 0,
        usage && usage.prompt_tokens != null ? usage.prompt_tokens : null,
        usage && usage.completion_tokens != null ? usage.completion_tokens : null,
        usage && usage.total_tokens != null ? usage.total_tokens : null,
        durationMs,
        statusCode,
        success ? 1 : 0,
        errorMsg,
      ],
    ).catch(() => { /* noop */ })
  }
  // 从文本中提取最后一个 "usage":{...} 对象（用于流式响应的 token 统计）
  // 用花括号配平解析，兼容 usage 内含嵌套对象（如 prompt_tokens_details）
  const extractUsage = (text) => {
    if (!text) return null
    const key = '"usage"'
    let last = null
    let searchFrom = 0
    while (true) {
      const pos = text.indexOf(key, searchFrom)
      if (pos === -1) break
      let i = pos + key.length
      while (i < text.length && /[\s:]/.test(text[i])) i++
      if (text[i] !== '{') { searchFrom = pos + 1; continue }
      let depth = 0, inStr = false, esc = false, end = -1
      for (; i < text.length; i++) {
        const ch = text[i]
        if (esc) { esc = false; continue }
        if (ch === '\\') { esc = true; continue }
        if (ch === '"') { inStr = !inStr; continue }
        if (inStr) continue
        if (ch === '{') depth++
        else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break } }
      }
      if (end > 0) {
        try { last = JSON.parse(text.slice(pos + key.length, end).replace(/^[\s:]+/, '')) } catch (_) { /* keep prev */ }
        searchFrom = end
      } else {
        searchFrom = pos + 1
      }
    }
    return last
  }

  try {
    const { model, messages, temperature, max_tokens, stream, tools, tool_choice } = req.body || {}
    logCtx.model = model || null

    if (!model || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json(error('model 和 messages 必填', 400))
    }

    const modelInfo = await findModelWithProvider(model)
    if (!modelInfo) {
      return res.status(404).json(error(`模型 "${model}" 不存在或未启用`, 404))
    }
    logCtx.providerId = modelInfo.provider_id
    if (!modelInfo.base_url) {
      return res.status(400).json(error(`供应商 "${modelInfo.provider_name}" 未配置 base_url`, 400))
    }
    if (!modelInfo.api_key) {
      return res.status(400).json(error(`供应商 "${modelInfo.provider_name}" 未配置 api_key`, 400))
    }

    // 构造上游请求体
    const payload = { model, messages }
    if (temperature !== undefined && temperature !== null) payload.temperature = parseFloat(temperature)
    if (max_tokens !== undefined && max_tokens !== null) payload.max_tokens = parseInt(max_tokens)

    const wantStream = stream === true || stream === 'true'
    payload.stream = !!wantStream
    logCtx.wantStream = wantStream
    // 流式时显式请求 usage，上游会在最后一个 chunk 返回 token 统计
    if (wantStream) payload.stream_options = { include_usage: true }

    if (Array.isArray(tools) && tools.length > 0 && modelInfo.supports_tools) {
      payload.tools = tools
      if (tool_choice !== undefined) payload.tool_choice = tool_choice
    }

    // 解析上游 URL：{base_url}/chat/completions
    let targetUrl
    try {
      const base = modelInfo.base_url.replace(/\/+$/, '')
      targetUrl = new URL(base + '/chat/completions')
    } catch (e) {
      return res.status(500).json(error(`base_url 格式错误: ${modelInfo.base_url}`, 500))
    }

    const bodyStr = JSON.stringify(payload)
    const isHttps = targetUrl.protocol === 'https:'
    const client = isHttps ? https : http

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${modelInfo.api_key}`,
        'Accept': wantStream ? 'text/event-stream' : 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }

    const proxyReq = client.request(options, (proxyRes) => {
      // 上游返回非 2xx 时，收集响应并作为错误返回
      const upstreamStatus = proxyRes.statusCode || 502
      if (upstreamStatus >= 400) {
        const chunks = []
        proxyRes.on('data', (c) => chunks.push(c))
        proxyRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let errMsg = raw
          try {
            const j = JSON.parse(raw)
            errMsg = j.error?.message || j.message || raw
          } catch (_) { /* keep raw */ }
          logCall({ statusCode: upstreamStatus, success: false, errorMsg: `上游 API 错误 (${upstreamStatus}): ${errMsg}` })
          return res.status(upstreamStatus).json({
            success: false,
            error: `上游 API 错误 (${upstreamStatus}): ${errMsg}`,
            upstream_status: upstreamStatus,
          })
        })
        return
      }

      if (wantStream) {
        // SSE 流式转发：边写边收集尾部，结束后从尾部解析 usage
        let tailBuf = ''
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')
        res.writeHead(200)
        let clientAborted = false
        proxyRes.on('data', (c) => {
          try { res.write(c) } catch (_) { /* noop */ }
          // 仅保留尾部以限制内存，usage 通常在最后一块
          tailBuf += c.toString('utf8')
          if (tailBuf.length > 8192) tailBuf = tailBuf.slice(-4096)
        })
        proxyRes.on('end', () => {
          try { res.end() } catch (_) { /* noop */ }
          if (clientAborted) return
          logCall({ statusCode: 200, success: true, usage: extractUsage(tailBuf) })
        })
        // 客户端断开时主动结束上游连接
        req.on('close', () => {
          clientAborted = true
          try { proxyReq.destroy() } catch (_) { /* noop */ }
        })
      } else {
        // 非流式：缓冲完整响应后透传，并解析 usage
        const chunks = []
        proxyRes.on('data', (c) => { chunks.push(c) })
        proxyRes.on('end', () => {
          const buf = Buffer.concat(chunks)
          try { res.writeHead(upstreamStatus) } catch (_) { /* noop */ }
          try { res.end(buf) } catch (_) { /* noop */ }
          let usage = null
          try {
            const j = JSON.parse(buf.toString('utf8'))
            usage = j.usage || null
          } catch (_) { /* keep null */ }
          logCall({ statusCode: upstreamStatus, success: true, usage })
        })
      }
    })

    proxyReq.on('error', (e) => {
      logCall({ statusCode: 502, success: false, errorMsg: `上游请求失败: ${e.message}` })
      if (!res.headersSent) {
        return res.status(502).json({ success: false, error: `上游请求失败: ${e.message}` })
      }
      try { res.end() } catch (_) { /* noop */ }
    })

    proxyReq.setTimeout(300000, () => {
      proxyReq.destroy()
      logCall({ statusCode: 504, success: false, errorMsg: '上游请求超时' })
      if (!res.headersSent) {
        return res.status(504).json({ success: false, error: '上游请求超时' })
      }
      try { res.end() } catch (_) { /* noop */ }
    })

    proxyReq.write(bodyStr)
    proxyReq.end()
  } catch (err) {
    logCall({ statusCode: 500, success: false, errorMsg: err.message })
    if (!res.headersSent) {
      return res.status(500).json(error(err.message))
    }
  }
}

/**
 * POST /api/ai-proxy/upload-image
 * 接收图片文件，返回公网可访问的 URL
 */
exports.uploadImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '请选择图片文件' })
    }

    const file = req.file
    const ext = path.extname(file.originalname).toLowerCase()
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']
    if (!imageExts.includes(ext)) {
      // 删除非图片文件
      fs.unlinkSync(file.path)
      return res.status(400).json({ success: false, error: `不支持的图片格式: ${ext}` })
    }

    // 构造公网 URL：优先使用 X-Forwarded 头，其次环境变量，最后 localhost
    const host = req.get('X-Forwarded-Host') || req.get('Host') || 'localhost:3000'
    const proto = req.get('X-Forwarded-Proto') || req.protocol || 'http'
    const url = `${proto}://${host}/uploads/${file.filename}`

    // 可选：写入 attachments 表
    try {
      await pool.query(
        'INSERT INTO attachments (filename, original_name, file_size, mime_type, file_path, purpose) VALUES (?, ?, ?, ?, ?, ?)',
        [file.filename, file.originalname, file.size, file.mimetype, 'uploads/' + file.filename, 'chat-image'],
      )
    } catch (_) { /* 写入失败不影响上传 */ }

    res.json({
      success: true,
      data: { url, filename: file.filename, original_name: file.originalname, size: file.size },
    })
  } catch (err) {
    console.error('[aiProxy] uploadImage 失败:', err)
    res.status(500).json({ success: false, error: err.message })
  }
}

/**
 * POST /api/ai-proxy/parse-pdf
 * 接收 PDF 文件，解析文本内容后返回
 */
exports.parsePdf = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '请选择 PDF 文件' })
    }

    const file = req.file
    if (file.mimetype !== 'application/pdf' && !file.originalname.toLowerCase().endsWith('.pdf')) {
      fs.unlinkSync(file.path)
      return res.status(400).json({ success: false, error: '仅支持 PDF 文件' })
    }

    // 尝试使用 pdf-parse 解析
    let fullText = '', pages = 0, chars = 0
    try {
      const pdfParse = require('pdf-parse')
      const dataBuffer = fs.readFileSync(file.path)
      const data = await pdfParse(dataBuffer)
      fullText = data.text || ''
      // 去掉多余空行
      fullText = fullText.replace(/\n{3,}/g, '\n\n').trim()
      pages = data.numpages || 0
      chars = fullText.length
    } catch (parseErr) {
      // pdf-parse 未安装时返回提示
      return res.status(500).json({
        success: false,
        error: 'PDF 解析失败，请确认服务端已安装 pdf-parse: ' + parseErr.message,
      })
    }

    // 可选：写入 attachments 表
    try {
      await pool.query(
        'INSERT INTO attachments (filename, original_name, file_size, mime_type, file_path, purpose) VALUES (?, ?, ?, ?, ?, ?)',
        [file.filename, file.originalname, file.size, file.mimetype, 'uploads/' + file.filename, 'chat-pdf'],
      )
    } catch (_) { /* noop */ }

    res.json({
      success: true,
      data: { full_text: fullText, chars, pages, filename: file.filename },
    })
  } catch (err) {
    console.error('[aiProxy] parsePdf 失败:', err)
    res.status(500).json({ success: false, error: err.message })
  }
}
