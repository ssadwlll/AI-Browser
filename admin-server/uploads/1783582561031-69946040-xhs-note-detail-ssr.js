// @name: 小红书笔记详情SSR采集
// @description: 从页面__INITIAL_STATE__中提取笔记完整详情数据，包括标题、正文、图片、视频、标签、作者信息、互动数据等。基于SSR提取方案，不触发API风控，是报告推荐的最可靠采集方式
// @version: 1.0.0
// @category: data-collection
// @urlPattern: *xiaohongshu.com/explore/*,*xiaohongshu.com/discovery/item/*,*xiaohongshu.com/search_result/*
// @author: ai-browser

(async function () {
  'use strict'

  // ========== 参数读取 ==========
  var args = window.__SCRIPT_ARGS__ || {}
  var noteId = args.noteId || ''

  // ========== 工具函数 ==========
  function safeStr(v) {
    if (v === null || v === undefined) return ''
    return String(v)
  }

  function safeNum(v) {
    if (v === null || v === undefined) return 0
    var n = Number(v)
    return isNaN(n) ? 0 : n
  }

  // ========== 从 __INITIAL_STATE__ 提取笔记数据 ==========
  // 报告关键发现：Vue3 循环引用问题，不能直接 JSON.stringify(__INITIAL_STATE__)
  // 解决方案：用 String() 手动逐字段提取
  function extractFromInitialState(targetNoteId) {
    var state = window.__INITIAL_STATE__
    if (!state || !state.note || !state.note.noteDetailMap) {
      return null
    }

    var detailMap = state.note.noteDetailMap
    var noteData = null

    if (targetNoteId && detailMap[targetNoteId]) {
      noteData = detailMap[targetNoteId]
    } else {
      // 取第一个可用的笔记
      var keys = Object.keys(detailMap)
      if (keys.length === 0) return null
      noteData = detailMap[keys[0]]
      targetNoteId = keys[0]
    }

    if (!noteData) return null

    // noteData 结构: { note: {...},... }
    var note = noteData.note || noteData
    if (!note) return null

    // 手动逐字段提取，避免循环引用
    var result = {
      noteId: targetNoteId,
      title: safeStr(note.title || ''),
      desc: safeStr(note.desc || ''),
      type: safeStr(note.type || ''),
      wordNum: safeNum(note.wordNum),

      // 作者信息
      user: {
        userId: safeStr(note.user && note.user.userId || ''),
        nickname: safeStr(note.user && note.user.nickname || ''),
        avatar: safeStr(note.user && note.user.avatar || ''),
        xsecToken: safeStr(note.user && note.user.xsecToken || '')
      },

      // 互动数据
      interactInfo: {
        likedCount: safeStr(note.interactInfo && note.interactInfo.likedCount || '0'),
        collectedCount: safeStr(note.interactInfo && note.interactInfo.collectedCount || '0'),
        commentCount: safeStr(note.interactInfo && note.interactInfo.commentCount || '0'),
        shareCount: safeStr(note.interactInfo && note.interactInfo.shareCount || '0')
      },

      // 图片列表
      imageList: [],
      // 视频信息
      video: null,
      // 标签
      tagList: [],
      // 话题
      atsList: [],

      time: safeStr(note.time || ''),
      lastUpdateTime: safeStr(note.lastUpdateTime || ''),
      ipLocation: safeStr(note.ipLocation || ''),
      noteCard: safeStr(note.noteCard || ''),

      // 原始链接
      pageUrl: window.location.href,
      scrapedAt: new Date().toISOString()
    }

    // 提取图片列表
    if (note.imageList && note.imageList.length) {
      for (var i = 0; i < note.imageList.length; i++) {
        var img = note.imageList[i]
        if (img) {
          result.imageList.push({
            url: safeStr(img.urlDefault || img.url || ''),
            width: safeNum(img.width),
            height: safeNum(img.height),
            traceId: safeStr(img.traceId || '')
          })
        }
      }
    }

    // 提取视频信息
    if (note.video) {
      result.video = {
        media: {
          stream: safeStr(note.video.media && note.video.media.stream || ''),
          url: safeStr(note.video.media && note.video.media.url || '')
        },
        capa: safeNum(note.video.capa),
        firstFrame: safeStr(note.video.firstFrame || ''),
        duration: safeNum(note.video.cap && note.video.cap.duration || 0)
      }
    }

    // 提取标签
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

    // 提取@用户
    if (note.atsList && note.atsList.length) {
      for (var k = 0; k < note.atsList.length; k++) {
        var at = note.atsList[k]
        if (at) {
          result.atsList.push({
            userId: safeStr(at.userId || at.userInfo && at.userInfo.userId || ''),
            nickname: safeStr(at.nickname || at.userInfo && at.userInfo.nickname || ''),
            desc: safeStr(at.desc || '')
          })
        }
      }
    }

    return result
  }

  // ========== 从 DOM 提取详情（备选方案） ==========
  function extractFromDOM() {
    var data = {
      noteId: '',
      title: '',
      desc: '',
      user: { userId: '', nickname: '', avatar: '' },
      interactInfo: { likedCount: '0', collectedCount: '0', commentCount: '0', shareCount: '0' },
      imageList: [],
      tagList: [],
      pageUrl: window.location.href,
      scrapedAt: new Date().toISOString()
    }

    // 从URL提取noteId
    var urlMatch = window.location.href.match(/\/(?:explore|discovery\/item|search_result)\/([a-zA-Z0-9]+)/)
    data.noteId = urlMatch ? urlMatch[1] : ''

    // 标题
    var titleEl = document.querySelector('#detail-title, .note-title, h1[class*="title"], [class*="note-content"] .title')
    data.title = titleEl ? titleEl.textContent.trim() : ''

    // 正文
    var descEl = document.querySelector('#detail-desc, .note-text, [class*="note-text"], .desc, [class*="desc"]')
    data.desc = descEl ? descEl.textContent.trim() : ''

    // 作者
    var authorEl = document.querySelector('.author-wrapper .name, .username, [class*="author"] [class*="name"]')
    data.user.nickname = authorEl ? authorEl.textContent.trim() : ''
    var authorLink = document.querySelector('a[href*="/user/profile/"]')
    if (authorLink) {
      var authorMatch = authorLink.href.match(/\/user\/profile\/([a-zA-Z0-9]+)/)
      data.user.userId = authorMatch ? authorMatch[1] : ''
    }
    var avatarEl = document.querySelector('.author-avatar img, .avatar img')
    data.user.avatar = avatarEl ? (avatarEl.src || '') : ''

    // 互动数据
    var likeEl = document.querySelector('[class*="like-wrapper"] [class*="count"], .like-count')
    data.interactInfo.likedCount = likeEl ? likeEl.textContent.trim() : '0'
    var collectEl = document.querySelector('[class*="collect-wrapper"] [class*="count"], .collect-count')
    data.interactInfo.collectedCount = collectEl ? collectEl.textContent.trim() : '0'
    var commentEl = document.querySelector('[class*="comment-wrapper"] [class*="count"], .comment-count')
    data.interactInfo.commentCount = commentEl ? commentEl.textContent.trim() : '0'
    var shareEl = document.querySelector('[class*="share-wrapper"] [class*="count"], .share-count')
    data.interactInfo.shareCount = shareEl ? shareEl.textContent.trim() : '0'

    // 图片
    var imgs = document.querySelectorAll('.note-scroller img, [class*="swiper"] img, .slide img, .media-container img')
    imgs.forEach(function (img) {
      var src = img.src || ''
      if (src && src.indexOf('xhscdn') >= 0) {
        data.imageList.push({ url: src, width: img.naturalWidth || 0, height: img.naturalHeight || 0 })
      }
    })

    // 标签
    var tags = document.querySelectorAll('.tag, a[href*="/tag/"], a[href*="/search_result?keyword="]')
    tags.forEach(function (tag) {
      var name = tag.textContent.trim().replace(/^#/, '')
      if (name) data.tagList.push({ id: '', name: name, type: 'tag' })
    })

    return data
  }

  // ========== 主流程 ==========
  try {
    // 优先使用 SSR 提取（报告推荐方案）
    var result = extractFromInitialState(noteId)

    if (!result) {
      // SSR 提取失败，降级到 DOM 提取
      await new Promise(function (r) { setTimeout(r, 1000) }) // 等待1秒
      result = extractFromDOM()

      if (!result.title && !result.desc) {
        return {
          ok: false,
          error: '无法提取笔记详情，__INITIAL_STATE__ 不存在且 DOM 提取失败',
          hint: '请确认已打开笔记详情页（如 https://www.xiaohongshu.com/explore/xxx），或通过点击模式打开详情弹窗后调用'
        }
      }

      result._extractMethod = 'dom'
    } else {
      result._extractMethod = 'ssr'
    }

    return {
      ok: true,
      data: [result],
      count: 1,
      hint: '成功通过' + (result._extractMethod === 'ssr' ? 'SSR' : 'DOM') + '提取笔记详情: ' + (result.title || result.desc.slice(0, 30) || '未命名'),
      fields: ['noteId', 'title', 'desc', 'user.nickname', 'interactInfo.likedCount', 'imageList', 'tagList']
    }
  } catch (e) {
    return {
      ok: false,
      error: '笔记详情采集失败: ' + e.message,
      hint: '请确认页面已完全加载，或尝试使用 xhs-batch-collect-click 脚本通过点击模式采集'
    }
  }
})()
