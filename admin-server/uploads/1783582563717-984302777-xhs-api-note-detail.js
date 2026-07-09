// @name: 小红书API笔记详情(Headless模式)
// @description: 通过API直连获取笔记完整详情，包含正文、图片、视频、标签、互动数据等。比SSR提取更完整可靠，是Headless浏览器方案的单条详情采集脚本
// @version: 1.0.0
// @category: data-collection
// @urlPattern: *xiaohongshu.com/*
// @author: ai-browser

(async function () {
  'use strict'

  var args = window.__SCRIPT_ARGS__ || {}
  var noteId = args.noteId || ''

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

  // 如果没有传入 noteId，尝试从当前页面 URL 提取
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

  // 调用 API 获取详情
  var result = await window.api.xhs.getNote({ noteId: noteId })

  if (!result.ok) {
    return {
      ok: false,
      error: 'API获取失败: ' + result.error,
      hint: '如果提示签名失败，请刷新小红书页面后重试；如果提示未登录，请先在小红书页面登录'
    }
  }

  return {
    ok: true,
    data: result.data,
    count: result.count,
    hint: result.hint,
    fields: ['noteId', 'title', 'desc', 'user.nickname', 'interactInfo.likedCount', 'interactInfo.collectedCount', 'interactInfo.commentCount', 'imageList', 'tagList', 'time', 'ipLocation']
  }
})()
