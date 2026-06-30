// ============ ForgeController — 智能脚本生成 ============
// 分析网页结构，AI 生成采集脚本草稿
const { success, error } = require('../utils/response')

const SCRIPT_GENERATION_PROMPT = `你是一个浏览器脚本生成专家。根据以下页面结构信息，生成一个用于浏览器插件注入的数据采集JS脚本。

生成的脚本必须：
1. 自包含，不依赖外部库
2. 使用 document.querySelectorAll 提取数据
3. 返回 { ok: true, data: [...] } 格式
4. 包含错误处理（try-catch）
5. 提取常见字段：标题(title)、链接(url)、图片(img)、价格(price)、时间(time)等
6. 适当分页（如有分页按钮/滚动加载，实现基础分页）

页面信息：
URL: {url}
标题: {title}
主要元素选择器: {selectors}
页面包含的列表项: {listItems}

请只输出 JS 代码，不要包含任何解释或markdown标记。`

// 分析页面 HTML 结构，提取关键信息
function analyzePage(html, url) {
  const title = (html.match(/<title[^>]*>(.*?)<\/title>/i) || [])[1] || ''

  // 提取常见选择器模式
  const selectors = []
  const patterns = [
    // 文章/卡片列表
    /class\s*=\s*["']([^"']*(?:article|post|card|item|list|product|news|feed|entry|result)[^"']*)["']/gi,
    // 链接
    /<a[^>]*href\s*=\s*["']([^"']*)["'][^>]*>/gi,
  ]

  let match
  while ((match = patterns[0].exec(html)) !== null) {
    if (!selectors.includes(match[1])) selectors.push(match[1])
  }
  patterns[0].lastIndex = 0

  // 提取链接样本
  const links = []
  while ((match = patterns[1].exec(html)) !== null) {
    const href = match[1]
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      links.push(href)
      if (links.length >= 10) break
    }
  }

  // 提取文本列表样本
  const listItems = []
  const liRegex = /<(?:li|dd|p|h\d|span|a)[^>]*>(.*?)<\/(?:li|dd|p|h\d|span|a)>/gi
  while ((match = liRegex.exec(html)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, '').trim()
    if (text.length > 5 && text.length < 200) {
      if (!listItems.includes(text)) listItems.push(text)
      if (listItems.length >= 20) break
    }
  }

  return { title, selectors: selectors.slice(0, 10), listItems, links }
}

// 生成默认脚本（当AI不可用时）
function generateFallbackScript(analysis, url) {
  const title = analysis.title || '未命名页面'
  const selHint = analysis.selectors[0] || '.item'

  return `// 自动生成的「${title}」页面采集脚本
// 目标: ${url}
// 生成时间: ${new Date().toISOString()}

;(function() {
  try {
    const items = document.querySelectorAll('${selHint}')
    const data = []

    for (let i = 0; i < items.length; i++) {
      const el = items[i]
      const link = el.querySelector('a')
      const img = el.querySelector('img')
      const text = el.textContent.trim().slice(0, 200)

      data.push({
        title: (link ? link.textContent.trim() : text).slice(0, 100),
        url: link ? (link.href || '') : '',
        image: img ? (img.src || img.getAttribute('data-src') || '') : '',
        text: text,
      })

      if (data.length >= 50) break
    }

    return { ok: true, data, total: items.length }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})()`
}

exports.analyze = async (req, res) => {
  try {
    const { url } = req.body
    if (!url) return res.status(400).json(error('缺少 url 参数'))

    // 抓取页面 HTML
    let html = ''
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      })
      html = await resp.text()
    } catch (e) {
      return res.status(400).json(error(`无法访问页面: ${e.message}`))
    }

    const analysis = analyzePage(html, url)

    // 尝试用AI生成脚本
    let scriptCode = ''
    let usedAI = false
    try {
      const configService = require('../services/configService')
      const config = await configService.getAIConfig()
      const auth = await configService.getAppAuth()
      if (config?.model) {
        const headers = await configService.generateAuthHeaders(auth.appKey, auth.appSecret)
        const prompt = SCRIPT_GENERATION_PROMPT
          .replace('{url}', url)
          .replace('{title}', analysis.title)
          .replace('{selectors}', JSON.stringify(analysis.selectors).slice(0, 500))
          .replace('{listItems}', JSON.stringify(analysis.listItems).slice(0, 500))

        const resp = await fetch(config.proxyUrl || 'http://localhost:3001/api/ai-proxy/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: 'system', content: '你只输出JS代码，不输出任何markdown或解释。' },
              { role: 'user', content: prompt },
            ],
            temperature: 0.2,
            max_tokens: 2048,
          }),
        })

        if (resp.ok) {
          const data = await resp.json()
          const content = data.choices?.[0]?.message?.content || ''
          // 去除 markdown 包裹
          scriptCode = content.replace(/^```\w*\n?/gm, '').replace(/```$/gm, '').trim()
          if (scriptCode) usedAI = true
        }
      }
    } catch (e) {
      console.warn('[Forge] AI生成失败，使用模板脚本:', e.message)
    }

    if (!scriptCode) {
      scriptCode = generateFallbackScript(analysis, url)
    }

    // 根据页面分析结果生成元数据建议
    const suggestedMeta = {
      triggers: analysis.title ? [analysis.title.slice(0, 6)] : [],
      platforms: [new URL(url).hostname],
      requires_login: false,
      success_criteria: '采集到数据',
      known_limits: '自动分析生成，可能需要调整选择器',
      pagination: { strategy: 'scroll', maxPages: 20 },
    }

    // 分析页面是否是新闻/商品/列表类型
    if (analysis.title.includes('新闻') || analysis.listItems.some(it => it.includes('新闻'))) {
      suggestedMeta.triggers = ['新闻', '热点', '头条']
      suggestedMeta.success_criteria = '采集10条以上新闻'
    } else if (analysis.title.includes('商城') || analysis.title.includes('商品') || analysis.selectors.some(s => s.includes('product'))) {
      suggestedMeta.triggers = ['商品', '价格', '优惠']
      suggestedMeta.success_criteria = '采集商品列表及价格'
    } else if (analysis.title.includes('视频') || analysis.selectors.some(s => s.includes('video'))) {
      suggestedMeta.triggers = ['视频', '列表', '播放']
      suggestedMeta.success_criteria = '采集视频列表信息'
    }

    // 建议的脚本名称
    const hostname = new URL(url).hostname.replace('www.', '')
    const suggestedName = hostname.split('.')[0] + '-collector'

    res.json(success({
      url,
      analysis: {
        title: analysis.title,
        selectors: analysis.selectors,
        links: analysis.links.slice(0, 5),
        listItems: analysis.listItems.slice(0, 10),
      },
      result: {
        scriptCode,
        usedAI,
        suggestedName,
        suggestedMeta,
      },
    }))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}
