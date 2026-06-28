const https = require('https')
const { success, error } = require('../utils/response')

// 抓取 ptopweb.com 热点
exports.fetch = async (req, res) => {
  try {
    const html = await fetchPage('https://www.ptopweb.com/')
    const hotspots = parseHotspots(html)
    res.json(success({
      updatedAt: extractUpdateTime(html),
      count: hotspots.reduce((sum, s) => sum + s.items.length, 0),
      sources: hotspots,
    }))
  } catch (err) {
    res.status(500).json(error('抓取热点失败: ' + err.message))
  }
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (resp) => {
      let data = ''
      resp.on('data', chunk => data += chunk)
      resp.on('end', () => resolve(data))
    }).on('error', reject)
  })
}

function extractUpdateTime(html) {
  const m = html.match(/最后更新[：:]\s*([\d\-:\s]+)/)
  return m ? m[1].trim() : ''
}

function parseHotspots(html) {
  const sources = []

  // 按 h2 标签分割各大板块
  // 匹配模式: <h2>...网站名...</h2> 后面的内容直到下一个 h2
  const sectionRegex = /<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2[^>]*>|$)/gi
  let match

  while ((match = sectionRegex.exec(html)) !== null) {
    const titleRaw = match[1].replace(/<[^>]+>/g, '').trim()
    const body = match[2]

    // 提取网站名：去掉 emoji 和多余字符
    const name = titleRaw.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{2300}-\u{23FF}]|[\u{2500}-\u{257F}]|[\u{2580}-\u{259F}]|[\u{25A0}-\u{25FF}]|[\u{FE00}-\u{FEFF}]|[\u{200D}]/gu, '').trim()

    // 提取官网链接
    const linkMatch = body.match(/href="(https?:\/\/[^"]+)"/)
    const sourceUrl = linkMatch ? linkMatch[1] : ''

    // 提取列表项
    const items = []
    const liRegex = /<li[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/li>/gi
    let liMatch

    while ((liMatch = liRegex.exec(body)) !== null) {
      const link = liMatch[1]
      let title = liMatch[2].replace(/<[^>]+>/g, '').trim()

      // 提取热度数字（括号中的数字，如 "2682.3万"）
      let heat = ''
      const heatMatch = title.match(/\(([\d.]+万?)\)/)
      if (heatMatch) {
        heat = heatMatch[1]
        title = title.replace(heatMatch[0], '').trim()
      }

      // 去掉序号前缀 "1", "2", ...
      title = title.replace(/^\d+/, '').trim()

      if (title || link) {
        items.push({
          title,
          heat,
          link: link.startsWith('http') ? link : '',
        })
      }
    }

    // 如果 li 没匹配到（可能是别的格式），尝试用 a 标签直接提取
    if (items.length === 0 && body.includes('<a ')) {
      const aRegex = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
      let aMatch
      while ((aMatch = aRegex.exec(body)) !== null) {
        const link = aMatch[1]
        let title = aMatch[2].replace(/<[^>]+>/g, '').trim()
        title = title.replace(/^\d+/, '').trim()
        if (title && link && !title.includes('访问官网') && !title.includes('更多')) {
          items.push({ title, heat: '', link: link.startsWith('http') ? link : '' })
        }
      }
    }

    if (name) {
      sources.push({ name, url: sourceUrl, items: items.slice(0, 10) })
    }
  }

  return sources
}
