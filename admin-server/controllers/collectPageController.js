const http = require('http')
const https = require('https')
const iconv = require('iconv-lite')
const { success, error } = require('../utils/response')

function extractContent(html) {
  // 提取 title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : ''

  // 提取 body 内容
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const raw = bodyMatch ? bodyMatch[1] : html

  // 移除 script/style/nav/footer/header/aside/noscript 标签
  let text = raw.replace(/<(script|style|nav|footer|header|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '')
  // 移除所有 HTML 标签
  text = text.replace(/<[^>]+>/g, ' ')
  // 解码常见 HTML 实体
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  // 合并空白
  text = text.replace(/\s+/g, ' ').trim()

  return { title, content: text }
}

function fetchPage(targetUrl) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(targetUrl)
      const isHttps = parsedUrl.protocol === 'https:'
      const client = isHttps ? https : http
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
          // 检测编码：优先从 Content-Type 头提取，其次从 HTML meta 标签提取
          let charset = 'utf-8'
          const ctHeader = proxyRes.headers['content-type'] || ''
          const ctMatch = ctHeader.match(/charset=["']?([\w-]+)/i)
          if (ctMatch) {
            charset = ctMatch[1].toLowerCase().replace('gb2312', 'gbk')
          } else {
            // 从 HTML meta 标签检测编码
            const headStr = raw.slice(0, 1024).toString('ascii')
            const metaMatch = headStr.match(/charset=["']?([\w-]+)/i)
            if (metaMatch) charset = metaMatch[1].toLowerCase().replace('gb2312', 'gbk')
          }
          let html = ''
          if (charset === 'utf-8' || charset === 'utf8') {
            html = raw.toString('utf-8')
          } else {
            html = iconv.decode(raw, charset)
          }
          resolve(html)
        })
      })
      proxyReq.on('error', (e) => {
        reject(new Error(`请求失败: ${e.message}`))
      })
      proxyReq.setTimeout(10000, () => {
        proxyReq.destroy()
        reject(new Error('请求超时'))
      })
      proxyReq.end()
    } catch (e) {
      reject(new Error(`URL 格式错误: ${e.message}`))
    }
  })
}

async function collect(req, res) {
  const { urls, maxPages } = req.body

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json(error('urls 必须是非空数组', 400))
  }

  const limit = Math.min(Math.max(1, maxPages || 10), 20)
  const targetUrls = urls.slice(0, limit)

  const results = await Promise.allSettled(
    targetUrls.map(async (url) => {
      const html = await fetchPage(url)
      const { title, content } = extractContent(html)
      const truncated = content.length > 3000 ? content.slice(0, 3000) + '...' : content
      return { url, title, content: truncated }
    })
  )

  const pages = results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value
    }
    return { url: targetUrls[index], title: '', content: '', error: result.reason?.message || '未知错误' }
  })

  const successCount = pages.filter(p => !p.error).length

  res.json(success({ pages, total: pages.length, successCount }))
}

module.exports = { collect }
