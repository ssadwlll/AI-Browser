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
  const { urls, maxPages, maxUrls } = req.body

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json(error('urls 必须是非空数组', 400))
  }

  const limit = Math.min(Math.max(1, maxUrls || maxPages || 20), 20)
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

/**
 * 按 id 提取元素内容（栈匹配算法处理嵌套同名标签）
 * @param {string} html 页面 HTML
 * @param {string} id 元素 id
 * @returns {string} 元素内部 HTML 文本（已清理标签）
 */
function extractById(html, id) {
  const startRegex = new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i')
  const startMatch = html.match(startRegex)
  if (!startMatch) return ''

  const tagName = startMatch[1].toLowerCase()
  const contentStart = startMatch.index + startMatch[0].length

  // 自闭合标签无内容
  if (/\/\s*>\s*$/.test(startMatch[0])) return ''

  // 栈匹配嵌套同名标签（每次从 pos 统一起点搜索，避免 lastIndex 错位）
  const openTag = new RegExp(`<${tagName}\\b[^>]*>`, 'gi')
  const closeTag = new RegExp(`</${tagName}\\s*>`, 'gi')
  let depth = 1
  let pos = contentStart

  while (depth > 0) {
    openTag.lastIndex = pos
    closeTag.lastIndex = pos
    const openM = openTag.exec(html)
    const closeM = closeTag.exec(html)
    if (!closeM) break

    if (openM && openM.index < closeM.index) {
      depth++
      pos = openM.index + openM[0].length
    } else {
      depth--
      if (depth === 0) {
        return cleanHtmlText(html.slice(contentStart, closeM.index))
      }
      pos = closeM.index + closeM[0].length
    }
  }
  return ''
}

/**
 * 清理 HTML 为纯文本（保留换行结构，便于阅读正文）
 */
function cleanHtmlText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

/**
 * 采集温州新闻网新闻详情页
 * 标题：#artibodytitle (h1)
 * 摘要：#abs (div)
 * 正文：#artibody (div)
 *
 * 返回格式符合 chrome-extension inject_script_N 工具规范：
 * {success: true, data: {pages: [{title, summary, content, url}], total, successCount}}
 * 配合 tool_config.resultExtractor='data'，客户端 normalizePayload 会剥离为 pages 数组
 */
async function wenzhouDetail(req, res) {
  const { url } = req.body || {}
  if (!url) {
    return res.status(400).json(error('缺少 url 参数', 400))
  }

  let parsedUrl
  try {
    parsedUrl = new URL(url)
  } catch {
    return res.status(400).json(error('url 格式错误', 400))
  }

  if (!parsedUrl.hostname.includes('66wz.com')) {
    return res.status(400).json(error('仅支持温州新闻网(66wz.com)页面', 400))
  }

  try {
    const html = await fetchPage(url)

    // 按 id 精准提取三段内容
    const title = extractById(html, 'artibodytitle')
    const summary = extractById(html, 'abs')
    const content = extractById(html, 'artibody')

    // 任一关键字段缺失视为采集失败
    if (!title && !content) {
      return res.json(success({
        pages: [{ url, title: '', summary: '', content: '', error: '未找到正文内容，页面结构可能已变化' }],
        total: 1,
        successCount: 0,
      }))
    }

    const page = {
      url,
      title: title || '(无标题)',
      summary: summary || '',
      content: content || '',
      contentLength: content.length,
    }

    res.json(success({
      pages: [page],
      total: 1,
      successCount: 1,
    }))
  } catch (e) {
    res.json(success({
      pages: [{ url, title: '', summary: '', content: '', error: e.message || '采集失败' }],
      total: 1,
      successCount: 0,
    }))
  }
}

module.exports = { collect, wenzhouDetail }
