// @name: 小红书批量采集(点击模式)
// @description: 在搜索结果页自动点击每条笔记卡片打开详情弹窗，从__INITIAL_STATE__提取完整笔记数据后关闭弹窗，不离开搜索页。这是逆向报告推荐的最佳采集方案，不触发API风控和行为检测
// @version: 1.0.0
// @category: data-collection
// @urlPattern: *xiaohongshu.com/search_result*
// @author: ai-browser

(async function () {
  'use strict'

  // ========== 参数读取 ==========
  var args = window.__SCRIPT_ARGS__ || {}
  var maxNotes = parseInt(args.maxNotes) || 20
  var maxScrolls = parseInt(args.maxScrolls) || 5
  var delayMin = parseFloat(args.delayMin) || 2.0
  var delayMax = parseFloat(args.delayMax) || 4.0
  var scrollDelay = parseInt(args.scrollDelay) || 2500
  var batchPauseEvery = parseInt(args.batchPauseEvery) || 8
  var batchPauseDuration = parseInt(args.batchPauseDuration) || 8000

  // ========== 工具函数 ==========
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms) })
  }

  function randomDelay() {
    return (delayMin + Math.random() * (delayMax - delayMin)) * 1000
  }

  function safeStr(v) {
    if (v === null || v === undefined) return ''
    return String(v)
  }

  function safeNum(v) {
    if (v === null || v === undefined) return 0
    var n = Number(v)
    return isNaN(n) ? 0 : n
  }

  // ========== 获取笔记元素 ==========
  function getNoteElements() {
    var els = document.querySelectorAll('section.note-item, [class*="note-item"]')
    if (els.length === 0) {
      els = document.querySelectorAll('.feeds-page .note-item, .feeds-container section')
    }
    return Array.from(els).filter(function (el) {
      // 过滤广告
      return !el.querySelector('.query-note-wrapper, .query-note-item')
    })
  }

  // ========== 获取笔记ID ==========
  function getNoteId(el) {
    var link = el.querySelector('a[href*="/search_result/"], a[href*="/explore/"], a.cover')
    if (link) {
      var match = link.href.match(/\/(?:search_result|explore)\/([a-zA-Z0-9]+)/)
      if (match) return match[1]
    }
    return el.getAttribute('data-index') || 'unknown-' + Date.now()
  }

  // ========== 点击笔记打开详情弹窗 ==========
  async function openNoteDetail(noteEl) {
    var coverLink = noteEl.querySelector('a.cover')
    var titleLink = noteEl.querySelector('a.title, a[href*="/search_result/"]')
    var target = coverLink || titleLink || noteEl.querySelector('a')
    if (!target) throw new Error('找不到笔记链接')

    // 滚动到可见
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    await sleep(500 + Math.random() * 300)

    // 使用原生 click（报告指出 dispatchEvent 缺乏硬件特征会被检测）
    target.click()

    // 等待详情弹窗打开
    var opened = await waitForDetailOpen()
    if (!opened) throw new Error('详情弹窗未打开（超时）')
  }

  // ========== 等待详情弹窗打开 ==========
  async function waitForDetailOpen(timeout) {
    timeout = timeout || 10000
    var start = Date.now()
    while (Date.now() - start < timeout) {
      // 检测弹窗遮罩层或详情容器
      var mask = document.querySelector('.close-mask-dark, .mask, [class*="overlay"]')
      var detail = document.querySelector('[class*="note-detail"], .note-scroller, #detail-desc, #detail-title')
      if (mask || detail) {
        await sleep(500 + Math.random() * 300) // 等待内容渲染
        return true
      }
      await sleep(250)
    }
    return false
  }

  // ========== 关闭详情弹窗 ==========
  async function closeDetail() {
    // 首选点击遮罩层关闭
    var closeBtn = document.querySelector('.close-mask-dark, .close-circle, [class*="close-mask"]')
    if (closeBtn) {
      closeBtn.click()
    } else {
      // 备选：按 Escape
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true
      }))
      await sleep(200)
      // 再尝试其他关闭按钮
      var altClose = document.querySelector('[class*="close-modal"], [class*="close-btn"], button[aria-label*="close"]')
      if (altClose) altClose.click()
    }

    // 等待弹窗关闭
    await waitForDetailClose()
    await sleep(300 + Math.random() * 200)
  }

  async function waitForDetailClose(timeout) {
    timeout = timeout || 6000
    var start = Date.now()
    while (Date.now() - start < timeout) {
      if (!document.querySelector('.close-mask-dark, [class*="note-detail"]')) {
        await sleep(200)
        return true
      }
      await sleep(200)
    }
    return false
  }

  // ========== 从 __INITIAL_STATE__ 提取笔记详情 ==========
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
      // 取最新的（通常是最后一个）
      noteData = detailMap[keys[keys.length - 1]]
      noteId = keys[keys.length - 1]
    }

    if (!noteData) return null

    var note = noteData.note || noteData
    if (!note) return null

    // 手动逐字段提取（避免 Vue3 循环引用）
    var result = {
      noteId: noteId,
      title: safeStr(note.title || ''),
      desc: safeStr(note.desc || ''),
      type: safeStr(note.type || ''),
      wordNum: safeNum(note.wordNum),
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
      imageList: [],
      video: null,
      tagList: [],
      time: safeStr(note.time || ''),
      ipLocation: safeStr(note.ipLocation || ''),
      pageUrl: window.location.href,
      scrapedAt: new Date().toISOString()
    }

    // 图片
    if (note.imageList && note.imageList.length) {
      for (var i = 0; i < note.imageList.length; i++) {
        var img = note.imageList[i]
        if (img) {
          result.imageList.push({
            url: safeStr(img.urlDefault || img.url || ''),
            width: safeNum(img.width),
            height: safeNum(img.height)
          })
        }
      }
    }

    // 视频
    if (note.video) {
      result.video = {
        url: safeStr(note.video.media && note.video.media.url || ''),
        firstFrame: safeStr(note.video.firstFrame || ''),
        duration: safeNum(note.video.cap && note.video.cap.duration || 0)
      }
    }

    // 标签
    if (note.tagList && note.tagList.length) {
      for (var j = 0; j < note.tagList.length; j++) {
        var tag = note.tagList[j]
        if (tag) {
          result.tagList.push({
            id: safeStr(tag.id || ''),
            name: safeStr(tag.name || ''),
            type: safeStr(tag.type || '')
          })
        }
      }
    }

    return result
  }

  // ========== 从 DOM 提取详情（备选方案） ==========
  function extractNoteFromDOM() {
    var data = {
      noteId: '',
      title: '',
      desc: '',
      type: 'image',
      user: { userId: '', nickname: '', avatar: '' },
      interactInfo: { likedCount: '0', collectedCount: '0', commentCount: '0', shareCount: '0' },
      imageList: [],
      tagList: [],
      time: '',
      ipLocation: '',
      pageUrl: window.location.href,
      scrapedAt: new Date().toISOString()
    }

    var titleEl = document.querySelector('#detail-title, .note-title, h1[class*="title"]')
    data.title = titleEl ? titleEl.textContent.trim() : ''

    var descEl = document.querySelector('#detail-desc, .note-text, [class*="note-text"], .desc')
    data.desc = descEl ? descEl.textContent.trim() : ''

    var authorEl = document.querySelector('.author-wrapper .name, .username, [class*="author"] [class*="name"]')
    data.user.nickname = authorEl ? authorEl.textContent.trim() : ''

    var likeEl = document.querySelector('[class*="like-wrapper"] [class*="count"], .like-count')
    data.interactInfo.likedCount = likeEl ? likeEl.textContent.trim() : '0'
    var collectEl = document.querySelector('[class*="collect-wrapper"] [class*="count"], .collect-count')
    data.interactInfo.collectedCount = collectEl ? collectEl.textContent.trim() : '0'
    var commentEl = document.querySelector('[class*="comment-wrapper"] [class*="count"], .comment-count')
    data.interactInfo.commentCount = commentEl ? commentEl.textContent.trim() : '0'

    var timeEl = document.querySelector('.date, .publish-date, [class*="date"]')
    data.time = timeEl ? timeEl.textContent.trim() : ''

    var tags = document.querySelectorAll('.tag, a[href*="/tag/"]')
    tags.forEach(function (tag) {
      var name = tag.textContent.trim().replace(/^#/, '')
      if (name) data.tagList.push({ id: '', name: name, type: 'tag' })
    })

    var imgs = document.querySelectorAll('.note-scroller img, [class*="swiper"] img')
    imgs.forEach(function (img) {
      if (img.src && img.src.indexOf('xhscdn') >= 0) {
        data.imageList.push({ url: img.src, width: img.naturalWidth || 0, height: img.naturalHeight || 0 })
      }
    })

    return data
  }

  // ========== 单条笔记采集 ==========
  async function scrapeOneNote(noteEl, index) {
    var noteId = getNoteId(noteEl)

    // 滚动到笔记位置
    noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
    await sleep(500 + Math.random() * 400)

    // 点击打开详情
    await openNoteDetail(noteEl)

    // 等待内容渲染
    await sleep(800 + Math.random() * 500)

    // 优先从 SSR 提取
    var data = extractNoteFromSSR(noteId)

    if (!data) {
      // 降级到 DOM 提取
      data = extractNoteFromDOM()
      data._extractMethod = 'dom'
    } else {
      data._extractMethod = 'ssr'
    }

    data._index = index

    // 关闭详情弹窗
    await closeDetail()

    return data
  }

  // ========== 人类化滚动 ==========
  async function humanScroll(px) {
    var jitter = (Math.random() - 0.5) * 80
    var steps = 3 + Math.floor(Math.random() * 4)
    var perStep = (px + jitter) / steps
    for (var i = 0; i < steps; i++) {
      window.scrollBy({ top: perStep + (Math.random() - 0.5) * 40, behavior: 'smooth' })
      await sleep(60 + Math.random() * 100)
    }
  }

  // ========== 主流程 ==========
  try {
    var collected = []
    var collectedIds = new Set()
    var errorCount = 0
    var scrollCount = 0

    // 检测页面
    var initialEls = getNoteElements()
    if (initialEls.length === 0) {
      await sleep(3000)
      initialEls = getNoteElements()
    }

    if (initialEls.length === 0) {
      return {
        ok: false,
        error: '当前页面未检测到笔记列表',
        hint: '请先导航到小红书搜索结果页: https://www.xiaohongshu.com/search_result?keyword=关键词'
      }
    }

    var currentIndex = 0

    while (collected.length < maxNotes) {
      var notes = getNoteElements()

      // 滚动加载更多
      if (currentIndex >= notes.length - 3 && scrollCount < maxScrolls) {
        scrollCount++
        await humanScroll(400 + Math.random() * 300)
        await sleep(scrollDelay)
        notes = getNoteElements()
      }

      if (currentIndex >= notes.length) break

      // 反爬节奏：批量休息
      if (collected.length > 0 && collected.length % batchPauseEvery === 0) {
        await sleep(batchPauseDuration)
      }

      var noteEl = notes[currentIndex]
      var noteId = getNoteId(noteEl)

      if (collectedIds.has(noteId)) {
        currentIndex++
        continue
      }

      try {
        var data = await scrapeOneNote(noteEl, collected.length)
        collectedIds.add(noteId)
        collected.push(data)
      } catch (err) {
        errorCount++
        // 尝试关闭可能残留的弹窗
        try { await closeDetail() } catch (e) {}
      }

      currentIndex++

      // 随机延迟
      if (collected.length < maxNotes) {
        await sleep(randomDelay())
      }
    }

    return {
      ok: true,
      data: collected,
      count: collected.length,
      hint: collected.length > 0
        ? '批量采集完成: 成功 ' + collected.length + ' 条, 失败 ' + errorCount + ' 条。数据包含完整笔记详情(标题/正文/图片/标签/互动数据)'
        : '采集结果为空，可能页面未加载或需要登录',
      fields: ['noteId', 'title', 'desc', 'user.nickname', 'interactInfo.likedCount', 'interactInfo.collectedCount', 'interactInfo.commentCount', 'imageList', 'tagList', 'time', 'ipLocation']
    }
  } catch (e) {
    return {
      ok: false,
      error: '批量采集失败: ' + e.message,
      hint: '请确认页面已完全加载，或尝试减少 maxNotes 和 maxScrolls 参数'
    }
  }
})()
