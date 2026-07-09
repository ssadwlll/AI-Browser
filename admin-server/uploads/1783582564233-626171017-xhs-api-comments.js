// @name: 小红书API评论采集(Headless模式)
// @description: 通过API直连采集笔记评论，支持翻页加载全部评论。比DOM采集更完整可靠，包含子评论、IP属地等信息
// @version: 1.0.0
// @category: data-collection
// @urlPattern: *xiaohongshu.com/*
// @author: ai-browser

(async function () {
  'use strict'

  var args = window.__SCRIPT_ARGS__ || {}
  var noteId = args.noteId || ''
  var maxPages = parseInt(args.maxPages) || 3

  if (!window.api || !window.api.xhs) {
    return {
      ok: false,
      error: 'window.api.xhs 不可用',
      hint: '此脚本需要 Electron 主进程的 xhs_api_service 支持'
    }
  }

  // 环境检查
  var envCheck = await window.api.xhs.checkEnv()
  if (!envCheck.ok) {
    return {
      ok: false,
      error: envCheck.error,
      hint: '请先导航到小红书页面并确保已登录'
    }
  }

  // 从 URL 提取 noteId
  if (!noteId) {
    var urlMatch = window.location.href.match(/\/(?:explore|discovery\/item|search_result)\/([a-zA-Z0-9]+)/)
    if (urlMatch) {
      noteId = urlMatch[1]
    } else {
      return {
        ok: false,
        error: '缺少 noteId 参数',
        hint: '请传入 noteId 参数，或在小红书笔记详情页执行此脚本'
      }
    }
  }

  // 翻页采集评论
  var allComments = []
  var cursor = ''

  for (var page = 1; page <= maxPages; page++) {
    var result = await window.api.xhs.getComments({ noteId: noteId, cursor: cursor })

    if (!result.ok) {
      if (page === 1) {
        return {
          ok: false,
          error: '评论采集失败: ' + result.error,
          hint: '如果提示签名失败，请刷新小红书页面后重试'
        }
      }
      break
    }

    allComments = allComments.concat(result.data)

    if (!result.hasMore) break

    cursor = result.cursor

    // 翻页延迟
    if (page < maxPages) {
      await new Promise(function (r) { setTimeout(r, 1000 + Math.random() * 500) })
    }
  }

  // 统计子评论
  var totalReplies = 0
  allComments.forEach(function (c) {
    totalReplies += (c.subComments || []).length
  })

  return {
    ok: true,
    data: allComments,
    count: allComments.length,
    hint: 'API采集 ' + allComments.length + ' 条评论，包含 ' + totalReplies + ' 条子评论',
    fields: ['id', 'content', 'user.nickname', 'likeCount', 'time', 'ipLocation', 'subComments']
  }
})()
