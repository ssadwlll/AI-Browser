// @name: 公众号文章列表采集
// @description: 采集微信公众号文章列表，提取标题/时间/封面，支持分页滚动采集和JSON/CSV导出
// @version: 1.0.0
// @urlPattern: *mp.weixin.qq.com*, *weixin.qq.com*

(function () {
  'use strict'
  if (document.getElementById('wx-article-panel')) return

  var style = document.createElement('style')
  style.textContent = '#wx-article-panel{position:fixed;top:20px;left:20px;width:380px;max-height:85vh;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.18);z-index:99999;font:12px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden;display:flex;flex-direction:column}' +
    '#wx-article-panel .hdr{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:linear-gradient(135deg,#07c160,#06ad56);color:#fff;flex-shrink:0}' +
    '#wx-article-panel .hdr h3{margin:0;font-size:15px;font-weight:600}' +
    '#wx-article-panel .hdr button{background:rgba(255,255,255,.25);border:none;color:#fff;padding:4px 10px;border-radius:14px;cursor:pointer;font-size:11px}' +
    '#wx-article-panel .hdr button:hover{background:rgba(255,255,255,.4)}' +
    '#wx-article-panel .toolbar{display:flex;align-items:center;gap:6px;padding:8px 16px;border-bottom:1px solid #f0f0f0;flex-shrink:0}' +
    '#wx-article-panel .toolbar input{flex:1;border:1px solid #ddd;border-radius:6px;padding:5px 10px;font-size:12px;outline:none}' +
    '#wx-article-panel .toolbar input:focus{border-color:#07c160}' +
    '#wx-article-panel .toolbar button{background:#f5f5f5;border:none;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:11px}' +
    '#wx-article-panel .toolbar button:hover{background:#e8f5e9;color:#07c160}' +
    '#wx-article-panel .list{overflow-y:auto;flex:1;padding:4px 0}' +
    '#wx-article-panel .item{display:flex;gap:10px;padding:10px 16px;border-bottom:1px solid #f5f5f5;cursor:pointer}' +
    '#wx-article-panel .item:hover{background:#f0faf3}' +
    '#wx-article-panel .item .thumb{width:60px;height:60px;border-radius:6px;object-fit:cover;flex-shrink:0;background:#f0f0f0}' +
    '#wx-article-panel .item .info{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:space-between}' +
    '#wx-article-panel .item .title{font-size:13px;color:#333;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.5;font-weight:500}' +
    '#wx-article-panel .item .meta{font-size:11px;color:#999;display:flex;justify-content:space-between}' +
    '#wx-article-panel .empty{text-align:center;padding:40px 16px;color:#999}' +
    '#wx-article-panel .stats{padding:8px 16px;font-size:11px;color:#999;border-top:1px solid #f0f0f0;flex-shrink:0}' +
    '#wx-article-panel.mini .toolbar,#wx-article-panel.mini .list,#wx-article-panel.mini .stats{display:none}'
  document.head.appendChild(style)

  var panel = document.createElement('div')
  panel.id = 'wx-article-panel'
  panel.innerHTML = '<div class="hdr"><h3>公众号文章采集</h3><div style="display:flex;gap:6px"><button id="wx-auto-scroll">自动滚动</button><button id="wx-export-json">JSON</button><button id="wx-export-csv">CSV</button><button id="wx-mini">_</button></div></div><div class="toolbar"><input id="wx-filter" placeholder="输入关键词过滤" /><button id="wx-filter-btn">筛选</button><button id="wx-clear-filter">清除</button></div><div class="list" id="wx-list"><div class="empty">正在扫描...</div></div><div class="stats" id="wx-stats"></div>'
  document.body.appendChild(panel)

  var articles = []
  var filterKeyword = ''
  var isScrolling = false
  var seenUrls = {}

  function escapeHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML }

  function scrapeArticles() {
    var items = []
    var seen = {}

    function addIfValid(title, url, time, cover) {
      if (!title || title.length < 3 || title.length > 200) return
      if (url && seen[url]) return
      if (url) seen[url] = true
      items.push({ title: title, url: url || '', time: time || '', cover: cover || '' })
    }

    // 策略1：微信公众号文章卡片
    var cards = document.querySelectorAll('.weui_media_box, .wx-rb, [class*="card"], [class*="article"], [class*="post"]')
    for (var i = 0; i < cards.length; i++) {
      var el = cards[i]
      var link = el.querySelector('a[href*="mp.weixin.qq.com"]')
      var img = el.querySelector('img')
      var titleEl = el.querySelector('h4, h3, [class*="title"], .weui_media_title, strong')
      var timeEl = el.querySelector('[class*="time"], [class*="date"], .weui_media_extra_info')
      var title = (titleEl ? titleEl.textContent : el.textContent || '').trim()
      addIfValid(title, link ? link.href : '', timeEl ? timeEl.textContent.trim() : '', img ? (img.src || img.dataset.src || '') : '')
    }

    // 策略2：通用文章列表
    if (items.length === 0) {
      var articles2 = document.querySelectorAll('article, [class*="list-item"], [class*="feed"]')
      for (var j = 0; j < articles2.length; j++) {
        var el2 = articles2[j]
        var link2 = el2.querySelector('a[href]')
        var img2 = el2.querySelector('img')
        var tEl = el2.querySelector('h1,h2,h3,h4,h5,[class*="title"],[class*="headline"]')
        var timeEl2 = el2.querySelector('time,[class*="date"],[class*="time"]')
        var t2 = (tEl ? tEl.textContent : el2.textContent || '').trim()
        if (!t2 || t2.length < 5 || t2.length > 300) continue
        var u2 = link2 ? link2.href : ''
        if (u2 && seenUrls[u2]) continue
        if (u2) seenUrls[u2] = true
        items.push({ title: t2, url: u2, time: timeEl2 ? timeEl2.textContent.trim() : '', cover: img2 ? (img2.src || img2.dataset.src || '') : '' })
      }
    }
    return items
  }

  function mergeArticles(newItems) {
    var added = 0
    for (var i = 0; i < newItems.length; i++) {
      var item = newItems[i]
      if (!item.url || seenUrls[item.url]) continue
      seenUrls[item.url] = true
      articles.push(item)
      added++
    }
    return added
  }

  function renderList() {
    var listEl = document.getElementById('wx-list')
    var filtered = articles
    if (filterKeyword) {
      var kw = filterKeyword.toLowerCase()
      filtered = articles.filter(function(a) { return a.title.toLowerCase().indexOf(kw) >= 0 })
    }
    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="empty">' + (articles.length === 0 ? '点击自动滚动开始采集' : '无匹配结果') + '</div>'
    } else {
      var html = ''
      for (var i = 0; i < filtered.length; i++) {
        var a = filtered[i]
        var coverHtml = a.cover ? '<img class="thumb" src="' + a.cover.replace(/"/g, '&quot;') + '" onerror="this.style.display=\'none\'" />' : '<div class="thumb" style="display:flex;align-items:center;justify-content:center;color:#ccc;font-size:20px">-</div>'
        html += '<div class="item" onclick="window.open(\'' + a.url.replace(/'/g, "\\'") + '\',\'_blank\')">' + coverHtml + '<div class="info"><span class="title">' + escapeHtml(a.title) + '</span><span class="meta"><span>' + (a.time || '-') + '</span><span>#' + (i + 1) + '</span></span></div></div>'
      }
      listEl.innerHTML = html
    }
    document.getElementById('wx-stats').textContent = '已采集 ' + articles.length + ' 篇 | ' + new Date().toLocaleTimeString()
  }

  async function autoScroll() {
    if (isScrolling) return
    isScrolling = true
    var btn = document.getElementById('wx-auto-scroll')
    btn.textContent = '停止'
    btn.style.background = '#e74c3c'
    var startCount = articles.length
    var noNewCount = 0

    while (isScrolling && noNewCount < 5) {
      var newItems = scrapeArticles()
      var added = mergeArticles(newItems)
      renderList()
      if (added === 0) { noNewCount++ } else { noNewCount = 0 }
      window.scrollBy(0, window.innerHeight)
      await new Promise(function(r) { setTimeout(r, 1500) })
    }

    isScrolling = false
    btn.textContent = '自动滚动'
    btn.style.background = ''
    document.getElementById('wx-stats').textContent = '采集完成！共 ' + articles.length + ' 篇（新增 ' + (articles.length - startCount) + ' 篇）'
  }

  function toggleScroll() {
    if (isScrolling) { isScrolling = false; document.getElementById('wx-auto-scroll').textContent = '自动滚动'; document.getElementById('wx-auto-scroll').style.background = '' }
    else autoScroll()
  }

  function downloadBlob(blob, filename) {
    var a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
  }

  function exportJSON() {
    if (articles.length === 0) return
    var blob = new Blob([JSON.stringify(articles, null, 2)], { type: 'application/json' })
    downloadBlob(blob, 'articles-' + new Date().toISOString().slice(0, 10) + '.json')
  }

  function exportCSV() {
    if (articles.length === 0) return
    var header = '\uFEFF标题,链接,时间\n'
    var rows = articles.map(function(a) { return '"' + (a.title || '').replace(/"/g, '""') + '","' + (a.url || '') + '","' + (a.time || '') + '"' }).join('\n')
    var blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8' })
    downloadBlob(blob, 'articles-' + new Date().toISOString().slice(0, 10) + '.csv')
  }

  document.getElementById('wx-auto-scroll').addEventListener('click', toggleScroll)
  document.getElementById('wx-export-json').addEventListener('click', exportJSON)
  document.getElementById('wx-export-csv').addEventListener('click', exportCSV)
  document.getElementById('wx-mini').addEventListener('click', function() { panel.classList.toggle('mini'); this.textContent = panel.classList.contains('mini') ? '+' : '_' })
  document.getElementById('wx-filter-btn').addEventListener('click', function() { filterKeyword = document.getElementById('wx-filter').value.trim(); renderList() })
  document.getElementById('wx-clear-filter').addEventListener('click', function() { filterKeyword = ''; document.getElementById('wx-filter').value = ''; renderList() })
  document.getElementById('wx-filter').addEventListener('keydown', function(e) { if (e.key === 'Enter') { filterKeyword = e.target.value.trim(); renderList() } })

  var initItems = scrapeArticles()
  mergeArticles(initItems)
  renderList()
})()
