// @name: 小红书搜索列表采集
// @description: 采集小红书搜索结果页的笔记列表数据。支持自动滚动加载更多，提取笔记标题、作者、封面、点赞数、链接等信息。基于DOM提取方案，不触发API风控
// @version: 1.0.0
// @category: data-collection
// @urlPattern: *xiaohongshu.com/search_result*
// @author: ai-browser

(async function () {
  'use strict'

  // ========== 参数读取 ==========
  var args = window.__SCRIPT_ARGS__ || {}
  var maxScrolls = parseInt(args.maxScrolls) || 5
  var scrollDelay = parseInt(args.scrollDelay) || 2000
  var extractImages = args.extractImages !== false

  // ========== 工具函数 ==========
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms) })
  }

  function randomDelay(min, max) {
    return min + Math.random() * (max - min)
  }

  function cleanText(s) {
    return (s || '').replace(/\s+/g, ' ').trim()
  }

  function parseCount(s) {
    if (!s) return 0
    s = cleanText(s)
    if (s.indexOf('万') >= 0) return Math.round(parseFloat(s) * 10000)
    if (s.indexOf('亿') >= 0) return Math.round(parseFloat(s) * 100000000)
    return parseInt(s.replace(/[^0-9]/g, '')) || 0
  }

  // ========== 提取单条笔记卡片 ==========
  function extractNoteItem(el) {
    var data = {}

    // 笔记ID - 从链接中提取
    var link = el.querySelector('a[href*="/search_result/"], a[href*="/explore/"], a.cover, a.title')
    if (link) {
      var href = link.href || ''
      var match = href.match(/\/(?:search_result|explore)\/([a-zA-Z0-9]+)/)
      data.noteId = match ? match[1] : ''
      data.link = href
    }

    // 标题
    var titleEl = el.querySelector('.title, a.title, .note-title, [class*="title"]')
    data.title = titleEl ? cleanText(titleEl.textContent) : ''

    // 作者
    var authorEl = el.querySelector('.author .name, .author-wrapper .name, [class*="author"] [class*="name"], .user-name')
    data.author = authorEl ? cleanText(authorEl.textContent) : ''

    // 作者ID
    var authorLink = el.querySelector('a[href*="/user/profile/"]')
    if (authorLink) {
      var authorMatch = authorLink.href.match(/\/user\/profile\/([a-zA-Z0-9]+)/)
      data.authorId = authorMatch ? authorMatch[1] : ''
    }

    // 封面图
    if (extractImages) {
      var imgEl = el.querySelector('img.cover, .cover img, img[src*="xhscdn"]')
      data.cover = imgEl ? (imgEl.src || imgEl.getAttribute('data-src') || '') : ''
    }

    // 点赞数
    var likeEl = el.querySelector('.like-wrapper span, .like-count, [class*="like"] [class*="count"], .count')
    data.likes = likeEl ? parseCount(likeEl.textContent) : 0

    // 笔记类型 (视频/图文)
    var videoIcon = el.querySelector('.video-icon, [class*="video"], .play-icon')
    data.type = videoIcon ? 'video' : 'image'

    // 是否广告
    var adFlag = el.querySelector('.query-note-wrapper, .query-note-item, [class*="ad"]')
    data.isAd = !!adFlag

    data.scrapedAt = new Date().toISOString()
    return data
  }

  // ========== 获取所有笔记元素 ==========
  function getNoteElements() {
    // 多选择器兼容：section.note-item 或 [class*="note-item"]
    var els = document.querySelectorAll('section.note-item, [class*="note-item"]')
    if (els.length === 0) {
      // 备选：feeds 容器下的 article
      els = document.querySelectorAll('.feeds-page .note-item, .feeds-container section, [class*="note"] > a')
    }
    return Array.from(els)
  }

  // ========== 滚动加载更多 ==========
  async function scrollAndCollect() {
    var allData = []
    var seenIds = new Set()
    var scrollCount = 0
    var lastCount = 0
    var stableCount = 0

    while (scrollCount < maxScrolls) {
      // 提取当前页面所有笔记
      var els = getNoteElements()

      for (var i = 0; i < els.length; i++) {
        var data = extractNoteItem(els[i])
        if (data.isAd) continue

        var key = data.noteId || data.title + '_' + data.author
        if (seenIds.has(key)) continue

        seenIds.add(key)
        allData.push(data)
      }

      // 检查是否还有新数据
      if (allData.length === lastCount) {
        stableCount++
        if (stableCount >= 2) break // 连续2次无新数据，停止
      } else {
        stableCount = 0
      }
      lastCount = allData.length

      // 模拟人类滚动
      var scrollAmount = 600 + Math.random() * 400
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' })
      await sleep(scrollDelay + randomDelay(0, 1000))

      scrollCount++
    }

    return allData
  }

  // ========== 主流程 ==========
  try {
    // 检测页面是否加载完成
    var initialEls = getNoteElements()
    if (initialEls.length === 0) {
      // 等待页面加载
      await sleep(3000)
      initialEls = getNoteElements()
    }

    if (initialEls.length === 0) {
      return {
        ok: false,
        error: '当前页面未检测到笔记列表，请确认已打开小红书搜索结果页',
        hint: '请先 navigate_to 到 https://www.xiaohongshu.com/search_result?keyword=关键词 后再调用此脚本'
      }
    }

    // 执行滚动采集
    var results = await scrollAndCollect()

    return {
      ok: true,
      data: results,
      count: results.length,
      hint: results.length > 0
        ? '成功采集 ' + results.length + ' 条搜索结果。可用 finish_task 输出报告，或调用 xhs-note-detail-ssr 获取详情'
        : '采集结果为空，可能页面未完全加载或需要登录',
      fields: ['noteId', 'title', 'author', 'authorId', 'cover', 'likes', 'type', 'link']
    }
  } catch (e) {
    return {
      ok: false,
      error: '搜索列表采集失败: ' + e.message,
      hint: '请确认页面已完全加载，或尝试减少 maxScrolls 参数'
    }
  }
})()
