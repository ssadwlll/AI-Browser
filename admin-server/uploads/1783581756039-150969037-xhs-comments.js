// @name: 小红书评论采集
// @description: 采集小红书笔记详情页的评论数据。提取评论内容、评论者、点赞数、回复列表等。支持自动滚动加载更多评论。基于DOM提取，不触发API风控
// @version: 1.0.0
// @category: data-collection
// @urlPattern: *xiaohongshu.com/explore/*,*xiaohongshu.com/discovery/item/*,*xiaohongshu.com/search_result/*
// @author: ai-browser

(async function () {
  'use strict'

  // ========== 参数读取 ==========
  var args = window.__SCRIPT_ARGS__ || {}
  var maxScrolls = parseInt(args.maxScrolls) || 3
  var scrollDelay = parseInt(args.scrollDelay) || 1500
  var extractReplies = args.extractReplies !== false

  // ========== 工具函数 ==========
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms) })
  }

  function cleanText(s) {
    return (s || '').replace(/\s+/g, ' ').trim()
  }

  function parseCount(s) {
    if (!s) return 0
    s = cleanText(s)
    if (s.indexOf('万') >= 0) return Math.round(parseFloat(s) * 10000)
    return parseInt(s.replace(/[^0-9]/g, '')) || 0
  }

  function safeStr(v) {
    if (v === null || v === undefined) return ''
    return String(v)
  }

  // ========== 从 __INITIAL_STATE__ 提取评论 ==========
  function extractCommentsFromSSR() {
    var state = window.__INITIAL_STATE__
    if (!state || !state.note || !state.note.commentResult) return null

    var commentResult = state.note.commentResult
    var comments = commentResult.comments || []
    var result = []

    for (var i = 0; i < comments.length; i++) {
      var c = comments[i]
      if (!c) continue

      var commentData = {
        id: safeStr(c.id || ''),
        content: safeStr(c.content || ''),
        time: safeStr(c.time || ''),
        likeCount: safeStr(c.likeCount || '0'),
        user: {
          userId: safeStr(c.user && c.user.userId || ''),
          nickname: safeStr(c.user && c.user.nickname || ''),
          avatar: safeStr(c.user && c.user.avatar || '')
        },
        ipLocation: safeStr(c.ipLocation || ''),
        replies: []
      }

      // 提取子评论
      if (extractReplies && c.subComments && c.subComments.length) {
        for (var j = 0; j < c.subComments.length; j++) {
          var sub = c.subComments[j]
          if (sub) {
            commentData.replies.push({
              id: safeStr(sub.id || ''),
              content: safeStr(sub.content || ''),
              time: safeStr(sub.time || ''),
              likeCount: safeStr(sub.likeCount || '0'),
              user: {
                userId: safeStr(sub.user && sub.user.userId || ''),
                nickname: safeStr(sub.user && sub.user.nickname || '')
              },
              targetUser: safeStr(sub.targetUser && sub.targetUser.nickname || '')
            })
          }
        }
      }

      result.push(commentData)
    }

    return result
  }

  // ========== 从 DOM 提取评论 ==========
  function extractCommentsFromDOM() {
    var comments = []

    // 评论容器选择器（多版本兼容）
    var commentEls = document.querySelectorAll(
      '.comment-item, .comments-container .comment, [class*="comment-item"], .parent-comment'
    )

    commentEls.forEach(function (el, i) {
      var data = {
        id: el.getAttribute('data-id') || 'dom-' + i,
        content: '',
        time: '',
        likeCount: '0',
        user: { userId: '', nickname: '', avatar: '' },
        ipLocation: '',
        replies: []
      }

      // 评论内容
      var contentEl = el.querySelector('.content, .note-text, .comment-content, [class*="content"]')
      data.content = contentEl ? cleanText(contentEl.textContent) : ''

      // 评论者
      var nameEl = el.querySelector('.name, .user-name, [class*="author"] [class*="name"], .comment-author')
      data.user.nickname = nameEl ? cleanText(nameEl.textContent) : ''

      // 头像
      var avatarEl = el.querySelector('img.avatar, .user-avatar img')
      data.user.avatar = avatarEl ? (avatarEl.src || '') : ''

      // 点赞数
      var likeEl = el.querySelector('.like-wrapper span, .like-count, [class*="like"] [class*="count"]')
      data.likeCount = likeEl ? cleanText(likeEl.textContent) : '0'

      // 时间
      var timeEl = el.querySelector('.date, .time, [class*="date"], [class*="time"]')
      data.time = timeEl ? cleanText(timeEl.textContent) : ''

      // IP属地
      var ipEl = el.querySelector('.ip-location, [class*="ip-location"]')
      data.ipLocation = ipEl ? cleanText(ipEl.textContent).replace(/IP属地[:\s]*/, '') : ''

      // 子评论
      if (extractReplies) {
        var replyEls = el.querySelectorAll('.sub-comment-item, .reply-item, [class*="sub-comment"]')
        replyEls.forEach(function (replyEl) {
          var replyContent = replyEl.querySelector('.content, .reply-content')
          var replyName = replyEl.querySelector('.name, .user-name')
          data.replies.push({
            id: '',
            content: replyContent ? cleanText(replyContent.textContent) : '',
            user: {
              userId: '',
              nickname: replyName ? cleanText(replyName.textContent) : ''
            }
          })
        })
      }

      if (data.content) comments.push(data)
    })

    return comments
  }

  // ========== 滚动评论区域加载更多 ==========
  async function scrollComments() {
    // 尝试找到评论滚动容器
    var scrollContainer = document.querySelector(
      '.comments-container, .note-scroller, [class*="comment-list"], [class*="comments"]'
    )

    var target = scrollContainer || document.documentElement
    var scrollCount = 0
    var lastCount = 0
    var stableCount = 0

    while (scrollCount < maxScrolls) {
      var currentComments = extractCommentsFromDOM()
      if (currentComments.length === lastCount) {
        stableCount++
        if (stableCount >= 2) break
      } else {
        stableCount = 0
      }
      lastCount = currentComments.length

      // 滚动
      if (scrollContainer) {
        scrollContainer.scrollBy({ top: 500, behavior: 'smooth' })
      } else {
        window.scrollBy({ top: 500, behavior: 'smooth' })
      }
      await sleep(scrollDelay + Math.random() * 500)
      scrollCount++
    }
  }

  // ========== 展开"更多回复" ==========
  async function expandMoreReplies() {
    var expandBtns = document.querySelectorAll(
      '.show-more-btn, [class*="show-more"], [class*="expand"], .more-reply'
    )
    for (var i = 0; i < expandBtns.length && i < 10; i++) {
      try {
        expandBtns[i].click()
        await sleep(500 + Math.random() * 300)
      } catch (e) {}
    }
  }

  // ========== 主流程 ==========
  try {
    // 等待评论加载
    await sleep(1500)

    // 展开"更多回复"
    await expandMoreReplies()

    // 滚动加载更多评论
    await scrollComments()

    // 再次展开回复
    await expandMoreReplies()

    // 优先从 SSR 提取
    var comments = extractCommentsFromSSR()
    var extractMethod = 'ssr'

    if (!comments || comments.length === 0) {
      // 降级到 DOM 提取
      comments = extractCommentsFromDOM()
      extractMethod = 'dom'
    }

    if (!comments || comments.length === 0) {
      return {
        ok: false,
        error: '未检测到评论数据',
        hint: '请确认已打开笔记详情页且评论已加载。部分笔记可能没有评论或评论需要手动展开'
      }
    }

    // 统计回复数
    var totalReplies = 0
    comments.forEach(function (c) {
      totalReplies += (c.replies || []).length
    })

    return {
      ok: true,
      data: comments,
      count: comments.length,
      hint: '成功通过' + extractMethod + '采集 ' + comments.length + ' 条评论，其中包含 ' + totalReplies + ' 条回复',
      fields: ['id', 'content', 'user.nickname', 'likeCount', 'time', 'ipLocation', 'replies']
    }
  } catch (e) {
    return {
      ok: false,
      error: '评论采集失败: ' + e.message,
      hint: '请确认已打开笔记详情页，评论区域已加载'
    }
  }
})()
