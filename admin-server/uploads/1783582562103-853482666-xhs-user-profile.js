// @name: 小红书用户主页采集
// @description: 采集小红书用户主页的个人信息和笔记列表。提取用户昵称、简介、粉丝数、笔记数等资料，以及用户发布的所有笔记列表数据。基于DOM+SSR提取，不触发API风控
// @version: 1.0.0
// @category: data-collection
// @urlPattern: *xiaohongshu.com/user/profile/*
// @author: ai-browser

(async function () {
  'use strict'

  // ========== 参数读取 ==========
  var args = window.__SCRIPT_ARGS__ || {}
  var maxScrolls = parseInt(args.maxScrolls) || 5
  var scrollDelay = parseInt(args.scrollDelay) || 2000

  // ========== 工具函数 ==========
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms) })
  }

  function safeStr(v) {
    if (v === null || v === undefined) return ''
    return String(v)
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

  // ========== 从 __INITIAL_STATE__ 提取用户信息 ==========
  function extractUserFromSSR() {
    var state = window.__INITIAL_STATE__
    if (!state || !state.user) return null

    var userPageData = state.user.userPageData || state.user
    var userInfo = (userPageData && userPageData.userInfo) || userPageData || {}

    return {
      userId: safeStr(userInfo.userId || userInfo.id || ''),
      nickname: safeStr(userInfo.nickname || ''),
      redId: safeStr(userInfo.redId || ''),
      desc: safeStr(userInfo.desc || ''),
      gender: safeStr(userInfo.gender || ''),
      ipLocation: safeStr(userInfo.ipLocation || ''),
      avatar: safeStr(userInfo.imageb || userInfo.image || ''),
      fans: safeStr(userInfo.fans || '0'),
      follows: safeStr(userInfo.follows || '0'),
      interaction: safeStr(userInfo.interaction || '0'),
      collected: safeStr(userInfo.collected || ''),
      liked: safeStr(userInfo.liked || ''),
      tag: safeStr(userInfo.tag || ''),
      level: safeStr(userInfo.level || '')
    }
  }

  // ========== 从 DOM 提取用户信息 ==========
  function extractUserFromDOM() {
    var data = {
      userId: '',
      nickname: '',
      redId: '',
      desc: '',
      gender: '',
      ipLocation: '',
      avatar: '',
      fans: '0',
      follows: '0',
      interaction: '0'
    }

    // 从URL提取userId
    var urlMatch = window.location.href.match(/\/user\/profile\/([a-zA-Z0-9]+)/)
    data.userId = urlMatch ? urlMatch[1] : ''

    // 昵称
    var nameEl = document.querySelector('.user-name, .nickname, [class*="user-nickname"], .info-part .name')
    data.nickname = nameEl ? cleanText(nameEl.textContent) : ''

    // 简介
    var descEl = document.querySelector('.user-desc, .desc, [class*="user-desc"]')
    data.desc = descEl ? cleanText(descEl.textContent) : ''

    // 红薯号
    var redIdEl = document.querySelector('.red-id, [class*="redid"], [class*="red-id"]')
    data.redId = redIdEl ? cleanText(redIdEl.textContent).replace(/红薯号[:\s]*/, '') : ''

    // 头像
    var avatarEl = document.querySelector('.user-avatar img, .avatar img, [class*="avatar"] img')
    data.avatar = avatarEl ? (avatarEl.src || '') : ''

    // 粉丝/关注/获赞与收藏
    var statEls = document.querySelectorAll('.user-interact .count, .fans-group .count, [class*="count"]')
    if (statEls.length >= 3) {
      data.follows = cleanText(statEls[0].textContent)
      data.fans = cleanText(statEls[1].textContent)
      data.interaction = cleanText(statEls[2].textContent)
    }

    // IP属地
    var ipEl = document.querySelector('.ip-location, [class*="ip-location"], .location')
    data.ipLocation = ipEl ? cleanText(ipEl.textContent).replace(/IP属地[:\s]*/, '') : ''

    return data
  }

  // ========== 提取用户笔记列表 ==========
  function extractUserNotes() {
    var notes = []
    var els = document.querySelectorAll('section.note-item, [class*="note-item"]')

    els.forEach(function (el, i) {
      // 过滤广告
      if (el.querySelector('.query-note-wrapper, .query-note-item')) return

      var noteData = {}

      // 笔记ID
      var link = el.querySelector('a[href*="/search_result/"], a[href*="/explore/"], a.cover')
      if (link) {
        var match = link.href.match(/\/(?:search_result|explore)\/([a-zA-Z0-9]+)/)
        noteData.noteId = match ? match[1] : ''
        noteData.link = link.href
      }

      // 标题
      var titleEl = el.querySelector('.title, a.title, .note-title')
      noteData.title = titleEl ? cleanText(titleEl.textContent) : ''

      // 封面
      var imgEl = el.querySelector('img.cover, .cover img, img[src*="xhscdn"]')
      noteData.cover = imgEl ? (imgEl.src || '') : ''

      // 点赞
      var likeEl = el.querySelector('.like-wrapper span, .like-count, [class*="like"] [class*="count"]')
      noteData.likes = likeEl ? parseCount(likeEl.textContent) : 0

      // 类型
      var videoIcon = el.querySelector('.video-icon, [class*="video"], .play-icon')
      noteData.type = videoIcon ? 'video' : 'image'

      noteData.scrapedAt = new Date().toISOString()
      notes.push(noteData)
    })

    return notes
  }

  // ========== 滚动加载更多笔记 ==========
  async function scrollAndCollectNotes() {
    var allNotes = []
    var seenIds = new Set()
    var scrollCount = 0
    var lastCount = 0
    var stableCount = 0

    while (scrollCount < maxScrolls) {
      var notes = extractUserNotes()

      for (var i = 0; i < notes.length; i++) {
        var key = notes[i].noteId || notes[i].title
        if (seenIds.has(key)) continue
        seenIds.add(key)
        allNotes.push(notes[i])
      }

      if (allNotes.length === lastCount) {
        stableCount++
        if (stableCount >= 2) break
      } else {
        stableCount = 0
      }
      lastCount = allNotes.length

      window.scrollBy({ top: 600 + Math.random() * 300, behavior: 'smooth' })
      await sleep(scrollDelay + Math.random() * 1000)
      scrollCount++
    }

    return allNotes
  }

  // ========== 主流程 ==========
  try {
    // 等待页面加载
    await sleep(2000)

    // 提取用户信息（优先SSR）
    var userInfo = extractUserFromSSR()
    if (!userInfo || !userInfo.userId) {
      userInfo = extractUserFromDOM()
      userInfo._extractMethod = 'dom'
    } else {
      userInfo._extractMethod = 'ssr'
    }

    // 滚动采集笔记列表
    var notes = await scrollAndCollectNotes()

    var result = {
      user: userInfo,
      notes: notes,
      noteCount: notes.length,
      pageUrl: window.location.href,
      scrapedAt: new Date().toISOString()
    }

    return {
      ok: true,
      data: [result],
      count: 1,
      hint: '成功采集用户 ' + (userInfo.nickname || '未知') + ' 的主页信息，共 ' + notes.length + ' 条笔记',
      fields: ['user.nickname', 'user.fans', 'user.follows', 'user.desc', 'noteCount', 'notes']
    }
  } catch (e) {
    return {
      ok: false,
      error: '用户主页采集失败: ' + e.message,
      hint: '请确认已打开用户主页（如 https://www.xiaohongshu.com/user/profile/xxx）'
    }
  }
})()
