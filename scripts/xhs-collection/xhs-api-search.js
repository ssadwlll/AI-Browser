// @name: 小红书API搜索采集(Headless模式)
// @description: 优先通过API直连搜索采集（快10倍），API风控时自动降级到DOM采集。自动从页面提取搜索关键词。需要当前BrowserView在小红书页面且已登录
// @version: 1.1.0
// @category: data-collection
// @urlPattern: *xiaohongshu.com/*
// @author: ai-browser

(async function () {
  'use strict'

  var args = window.__SCRIPT_ARGS__ || {}
  var keyword = args.keyword || args.query || ''
  var maxPages = parseInt(args.maxPages) || 1
  var pageSize = parseInt(args.pageSize) || 20
  var sort = args.sort || 'general'
  var fetchDetail = args.fetchDetail !== false

  // ========== 自动提取关键词 ==========
  if (!keyword) {
    var urlMatch = window.location.href.match(/[?&]keyword=([^&]+)/)
    if (urlMatch) keyword = decodeURIComponent(urlMatch[1])
    if (!keyword) {
      var searchInput = document.querySelector('input.search-input, #search-input')
      if (searchInput && searchInput.value) keyword = searchInput.value.trim()
    }
    if (!keyword) {
      var titleMatch = document.title.match(/^(.+?)\s*[-–—]\s*小红书/)
      if (titleMatch) keyword = titleMatch[1].trim()
    }
  }

  // ========== 工具函数 ==========
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  function cleanText(s) { return (s || '').replace(/\s+/g, ' ').trim() }
  function parseCount(s) {
    if (!s) return 0
    s = cleanText(s)
    if (s.indexOf('万') >= 0) return Math.round(parseFloat(s) * 10000)
    return parseInt(s.replace(/[^0-9]/g, '')) || 0
  }

  // ========== DOM 降级采集器 ==========
  function getNoteElements() {
    var els = document.querySelectorAll('section.note-item, [class*="note-item"]')
    if (els.length === 0) els = document.querySelectorAll('.feeds-page .note-item, .feeds-container section')
    return Array.from(els).filter(function (el) {
      return !el.querySelector('.query-note-wrapper, .query-note-item')
    })
  }

  function extractNoteFromDOM(el) {
    var data = {}
    var link = el.querySelector('a[href*="/search_result/"], a[href*="/explore/"], a.cover')
    if (link) {
      var match = link.href.match(/\/(?:search_result|explore)\/([a-zA-Z0-9]+)/)
      data.noteId = match ? match[1] : ''
      data.link = link.href
    }
    var titleEl = el.querySelector('.title, a.title, .note-title, [class*="title"]')
    data.title = titleEl ? cleanText(titleEl.textContent) : ''
    var authorEl = el.querySelector('.author .name, .author-wrapper .name, [class*="author"] [class*="name"]')
    data.user = { nickname: authorEl ? cleanText(authorEl.textContent) : '', userId: '' }
    var imgEl = el.querySelector('img.cover, .cover img, img[src*="xhscdn"]')
    data.cover = imgEl ? (imgEl.src || '') : ''
    var likeEl = el.querySelector('.like-wrapper span, .like-count, [class*="like"] [class*="count"]')
    data.interactInfo = { likedCount: likeEl ? cleanText(likeEl.textContent) : '0' }
    var videoIcon = el.querySelector('.video-icon, [class*="video"], .play-icon')
    data.type = videoIcon ? 'video' : 'image'
    data.scrapedAt = new Date().toISOString()
    return data
  }

  async function domFallbackCollect(maxScrolls) {
    var allData = []
    var seenIds = new Set()
    var scrollCount = 0
    var lastCount = 0
    var stableCount = 0

    while (scrollCount < maxScrolls) {
      var els = getNoteElements()
      for (var i = 0; i < els.length; i++) {
        var data = extractNoteFromDOM(els[i])
        var key = data.noteId || data.title + '_' + data.user.nickname
        if (seenIds.has(key)) continue
        seenIds.add(key)
        allData.push(data)
      }
      if (allData.length === lastCount) {
        stableCount++
        if (stableCount >= 2) break
      } else { stableCount = 0 }
      lastCount = allData.length
      window.scrollBy({ top: 600 + Math.random() * 400, behavior: 'smooth' })
      await sleep(2000 + Math.random() * 1000)
      scrollCount++
    }
    return allData
  }

  // ========== SSR 详情提取（降级时使用）==========
  function extractNoteFromSSR(noteId) {
    var state = window.__INITIAL_STATE__
    if (!state || !state.note || !state.note.noteDetailMap) return null
    var detailMap = state.note.noteDetailMap
    var noteData = null
    if (noteId && detailMap[noteId]) {
      noteData = detailMap[noteId]
    } else {
      var keys = Object.keys(detailMap)
      if (keys.length === 0) return null
      noteData = detailMap[keys[keys.length - 1]]
      noteId = keys[keys.length - 1]
    }
    var note = noteData.note || noteData
    if (!note) return null

    function safeStr(v) { return v === null || v === undefined ? '' : String(v) }
    function safeNum(v) { var n = Number(v); return isNaN(n) ? 0 : n }

    return {
      noteId: noteId,
      title: safeStr(note.title || ''),
      desc: safeStr(note.desc || ''),
      type: safeStr(note.type || ''),
      user: {
        userId: safeStr(note.user && note.user.userId || ''),
        nickname: safeStr(note.user && note.user.nickname || ''),
        avatar: safeStr(note.user && note.user.avatar || '')
      },
      interactInfo: {
        likedCount: safeStr(note.interactInfo && note.interactInfo.likedCount || '0'),
        collectedCount: safeStr(note.interactInfo && note.interactInfo.collectedCount || '0'),
        commentCount: safeStr(note.interactInfo && note.interactInfo.commentCount || '0'),
        shareCount: safeStr(note.interactInfo && note.interactInfo.shareCount || '0')
      },
      imageList: (note.imageList || []).map(function (img) {
        return { url: safeStr(img.urlDefault || img.url || ''), width: safeNum(img.width), height: safeNum(img.height) }
      }),
      tagList: (note.tagList || []).map(function (tag) {
        return { id: safeStr(tag.id || ''), name: safeStr(tag.name || ''), type: safeStr(tag.type || '') }
      }),
      time: safeStr(note.time || ''),
      ipLocation: safeStr(note.ipLocation || ''),
      _source: 'ssr_fallback',
      scrapedAt: new Date().toISOString()
    }
  }

  // ========== 点击笔记获取详情（降级时使用）==========
  async function clickAndExtractDetail(noteEl) {
    var coverLink = noteEl.querySelector('a.cover')
    var titleLink = noteEl.querySelector('a.title, a[href*="/search_result/"]')
    var target = coverLink || titleLink || noteEl.querySelector('a')
    if (!target) return null

    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    await sleep(500)
    target.click()

    // 等待弹窗
    var opened = false
    for (var w = 0; w < 20; w++) {
      if (document.querySelector('.close-mask-dark, [class*="note-detail"], #detail-desc')) { opened = true; break }
      await sleep(250)
    }
    if (!opened) return null

    await sleep(800)

    // 从 SSR 提取
    var noteId = ''
    var link = noteEl.querySelector('a[href*="/search_result/"], a[href*="/explore/"]')
    if (link) {
      var match = link.href.match(/\/(?:search_result|explore)\/([a-zA-Z0-9]+)/)
      if (match) noteId = match[1]
    }
    var data = extractNoteFromSSR(noteId)

    // 关闭弹窗
    var closeBtn = document.querySelector('.close-mask-dark, .close-circle, [class*="close-mask"]')
    if (closeBtn) closeBtn.click()
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }))
    await sleep(500)

    return data
  }

  // ========== 主流程 ==========
  // 检查 API 桥接
  if (!window.xhsApi) {
    return {
      ok: false,
      error: 'window.xhsApi 不可用，请重启应用以加载 preload_browser.js 更新',
      hint: '此脚本需要 Electron 主进程的 xhs_api_service 支持'
    }
  }

  // 环境检查
  var envCheck = await window.xhsApi.checkEnv()
  if (!envCheck.ok) {
    return {
      ok: false,
      error: envCheck.error,
      hint: '请先导航到小红书页面（如 https://www.xiaohongshu.com/explore）并确保已登录'
    }
  }

  if (!keyword) {
    return {
      ok: false,
      error: '缺少搜索关键词，且无法从当前页面自动提取',
      hint: '请传入 keyword 参数，或先在小红书搜索框输入关键词并提交'
    }
  }

  // ===== 尝试 API 模式 =====
  var apiFailed = false
  var apiError = ''

  try {
    var searchResult = await window.xhsApi.search({
      keyword: keyword, page: 1, pageSize: pageSize, sort: sort
    })

    if (searchResult.ok) {
      var apiNotes = searchResult.data

      // 批量获取详情
      if (fetchDetail && apiNotes.length > 0) {
        var noteIds = apiNotes.map(function (n) { return n.noteId })
        var detailedNotes = []
        for (var i = 0; i < noteIds.length; i += 20) {
          var batch = noteIds.slice(i, i + 20)
          var detailResult = await window.xhsApi.batchGetNotes({ noteIds: batch })
          if (detailResult.ok) detailedNotes = detailedNotes.concat(detailResult.data)
          await sleep(1000)
        }
        if (detailedNotes.length > 0) {
          return {
            ok: true, data: detailedNotes, count: detailedNotes.length,
            hint: 'API模式采集完成: 搜索"' + keyword + '"共' + apiNotes.length + '条，获取' + detailedNotes.length + '条详情',
            fields: ['noteId', 'title', 'desc', 'user.nickname', 'interactInfo.likedCount', 'imageList', 'tagList', 'time', 'ipLocation']
          }
        }
      }

      return {
        ok: true, data: apiNotes, count: apiNotes.length,
        hint: 'API搜索"' + keyword + '"返回' + apiNotes.length + '条结果',
        fields: ['noteId', 'title', 'type', 'user.nickname', 'likedCount', 'cover']
      }
    }

    // API 失败
    apiFailed = true
    apiError = searchResult.error || '未知API错误'
  } catch (e) {
    apiFailed = true
    apiError = e.message
  }

  // ===== 降级到 DOM 模式 =====
  if (apiFailed) {
    // 如果是 300011 风控，提示用户可以重置会话
    var isRiskControl = apiError.indexOf('账号异常') >= 0 || apiError.indexOf('频繁调用') >= 0 || apiError.indexOf('风控') >= 0
    var fallbackHint = isRiskControl
      ? 'API被风控(a1标记)，已自动降级到DOM采集。可调用 xhsApi.resetSession() 清除Cookie重置a1后重试API模式'
      : 'API调用失败(' + apiError + ')，已自动降级到DOM采集'

    // 检查是否在搜索结果页
    var isSearchPage = window.location.href.indexOf('search_result') >= 0
    if (!isSearchPage) {
      // 需要先导航到搜索页
      var searchUrl = 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(keyword) + '&source=web_search_result_notes'
      window.location.href = searchUrl
      return {
        ok: false,
        error: '正在跳转到搜索结果页，请等待页面加载后重新执行此脚本',
        hint: fallbackHint + '。页面正在跳转到搜索结果页'
      }
    }

    // 等待页面加载
    await sleep(2000)

    // DOM 采集
    var domNotes = await domFallbackCollect(maxPages * 3)

    if (domNotes.length === 0) {
      return {
        ok: false,
        error: 'API和DOM两种模式均未采集到数据。API错误: ' + apiError,
        hint: fallbackHint + '。请确认页面已加载搜索结果'
      }
    }

    // 可选：点击模式获取详情
    if (fetchDetail && domNotes.length > 0 && domNotes.length <= 15) {
      var detailedDomNotes = []
      var noteEls = getNoteElements()
      for (var j = 0; j < noteEls.length && j < domNotes.length; j++) {
        try {
          var detail = await clickAndExtractDetail(noteEls[j])
          if (detail) {
            detailedDomNotes.push(detail)
          } else {
            detailedDomNotes.push(domNotes[j])
          }
          await sleep(2000 + Math.random() * 2000)
        } catch (e) {
          detailedDomNotes.push(domNotes[j])
          try {
            var closeBtn = document.querySelector('.close-mask-dark, .close-circle')
            if (closeBtn) closeBtn.click()
            await sleep(500)
          } catch (e2) {}
        }
      }

      return {
        ok: true,
        data: detailedDomNotes,
        count: detailedDomNotes.length,
        hint: 'API风控已自动降级到DOM+点击模式: 搜索"' + keyword + '"采集' + detailedDomNotes.length + '条(含详情)。' + (isRiskControl ? 'API错误: ' + apiError : ''),
        fields: ['noteId', 'title', 'desc', 'user.nickname', 'interactInfo.likedCount', 'interactInfo.collectedCount', 'imageList', 'tagList', 'time', 'ipLocation']
      }
    }

    return {
      ok: true,
      data: domNotes,
      count: domNotes.length,
      hint: 'API风控已自动降级到DOM模式: 搜索"' + keyword + '"采集' + domNotes.length + '条。' + (isRiskControl ? '可调用resetSession重置a1后重试API' : ''),
      fields: ['noteId', 'title', 'user.nickname', 'interactInfo.likedCount', 'type', 'cover']
    }
  }
})()
