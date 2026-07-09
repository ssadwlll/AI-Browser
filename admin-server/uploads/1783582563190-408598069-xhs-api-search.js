// @name: 小红书API搜索采集(Headless模式)
// @description: 通过API直连方式搜索采集小红书笔记，比DOM采集快10倍。在页面内调用mnsv2生成签名，Node.js主进程直接调用XHS API。需要当前BrowserView在小红书页面且已登录。这是逆向报告推荐的方案A实现
// @version: 1.0.0
// @category: data-collection
// @urlPattern: *xiaohongshu.com/*
// @author: ai-browser

(async function () {
  'use strict'

  var args = window.__SCRIPT_ARGS__ || {}
  var keyword = args.keyword || args.query || ''
  var maxPages = parseInt(args.maxPages) || 1
  var pageSize = parseInt(args.pageSize) || 20
  var sort = args.sort || 'general' // general | popularity | time
  var fetchDetail = args.fetchDetail !== false // 是否获取每条笔记的详情

  // 检查 IPC 是否可用
  if (!window.api || !window.api.xhs) {
    return {
      ok: false,
      error: 'window.api.xhs 不可用，请确认应用已更新到支持 Headless 模式的版本',
      hint: '此脚本需要 Electron 主进程的 xhs_api_service 支持'
    }
  }

  // 1. 环境检查
  var envCheck = await window.api.xhs.checkEnv()
  if (!envCheck.ok) {
    return {
      ok: false,
      error: envCheck.error,
      hint: '请先导航到小红书页面（如 https://www.xiaohongshu.com/explore）并确保已登录，页面完全加载后重试'
    }
  }

  if (!keyword) {
    return {
      ok: false,
      error: '缺少搜索关键词',
      hint: '请通过参数传入 keyword，如: { keyword: "美食推荐" }'
    }
  }

  // 2. 搜索采集
  var allResults = []
  var allNoteIds = []

  for (var page = 1; page <= maxPages; page++) {
    var searchResult = await window.api.xhs.search({
      keyword: keyword,
      page: page,
      pageSize: pageSize,
      sort: sort
    })

    if (!searchResult.ok) {
      if (page === 1) {
        return {
          ok: false,
          error: '搜索失败: ' + searchResult.error,
          hint: '如果提示账号异常或签名失败，请刷新小红书页面后重试'
        }
      }
      break // 后续页失败，停止
    }

    allResults = allResults.concat(searchResult.data)
    allNoteIds = allNoteIds.concat(searchResult.data.map(function (n) { return n.noteId }))

    if (!searchResult.hasMore) break

    // 翻页延迟
    if (page < maxPages) {
      await new Promise(function (r) { setTimeout(r, 1500 + Math.random() * 1000) })
    }
  }

  // 3. 可选：批量获取详情
  if (fetchDetail && allNoteIds.length > 0) {
    var detailedNotes = []

    // 分批获取（每次最多20个）
    for (var i = 0; i < allNoteIds.length; i += 20) {
      var batch = allNoteIds.slice(i, i + 20)
      var detailResult = await window.api.xhs.batchGetNotes({ noteIds: batch })

      if (detailResult.ok) {
        detailedNotes = detailedNotes.concat(detailResult.data)
      }

      // 批次间延迟
      if (i + 20 < allNoteIds.length) {
        await new Promise(function (r) { setTimeout(r, 1000 + Math.random() * 500) })
      }
    }

    if (detailedNotes.length > 0) {
      return {
        ok: true,
        data: detailedNotes,
        count: detailedNotes.length,
        hint: 'Headless API 模式采集完成: 搜索"' + keyword + '"共 ' + allResults.length + ' 条，成功获取 ' + detailedNotes.length + ' 条详情（含完整正文/图片/标签/互动数据）',
        fields: ['noteId', 'title', 'desc', 'user.nickname', 'interactInfo.likedCount', 'interactInfo.collectedCount', 'imageList', 'tagList', 'time', 'ipLocation']
      }
    }
  }

  // 仅返回搜索结果
  return {
    ok: true,
    data: allResults,
    count: allResults.length,
    hint: 'Headless API 搜索"' + keyword + '"返回 ' + allResults.length + ' 条结果（' + maxPages + '页）。设置 fetchDetail=true 可获取完整详情',
    fields: ['noteId', 'title', 'type', 'user.nickname', 'likedCount', 'cover']
  }
})()
