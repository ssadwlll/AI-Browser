// @name: 微博热搜采集
// @description: 采集微博热搜榜单，支持一键导出JSON，实时显示热度排名
// @version: 1.0.0
// @urlPattern: *weibo.com*

(function () {
  'use strict'
  if (document.getElementById('wb-hot-panel')) return

  var style = document.createElement('style')
  style.textContent = '#wb-hot-panel{position:fixed;top:20px;left:20px;width:360px;max-height:80vh;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.15);z-index:99999;font:12px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden;display:flex;flex-direction:column}' +
    '#wb-hot-panel .hdr{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:linear-gradient(135deg,#ff8200,#ff3b30);color:#fff;flex-shrink:0}' +
    '#wb-hot-panel .hdr h3{margin:0;font-size:15px;font-weight:600}' +
    '#wb-hot-panel .hdr button{background:rgba(255,255,255,.25);border:none;color:#fff;padding:4px 10px;border-radius:14px;cursor:pointer;font-size:11px}' +
    '#wb-hot-panel .hdr button:hover{background:rgba(255,255,255,.4)}' +
    '#wb-hot-panel .list{overflow-y:auto;flex:1;padding:6px 0}' +
    '#wb-hot-panel .item{display:flex;align-items:center;gap:8px;padding:8px 16px;cursor:pointer;border-bottom:1px solid #f5f5f5}' +
    '#wb-hot-panel .item:hover{background:#fff3f0}' +
    '#wb-hot-panel .item .rank{width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;flex-shrink:0}' +
    '#wb-hot-panel .item .rank.top3{background:linear-gradient(135deg,#ff6b35,#ff3b30)}' +
    '#wb-hot-panel .item .rank.normal{background:#c0c0c0}' +
    '#wb-hot-panel .item .info{flex:1;min-width:0}' +
    '#wb-hot-panel .item .title{font-size:13px;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#wb-hot-panel .item .heat{font-size:11px;color:#999;margin-top:2px}' +
    '#wb-hot-panel .item .tag{display:inline-block;font-size:10px;padding:1px 4px;border-radius:3px;margin-left:4px}' +
    '#wb-hot-panel .item .tag.hot{background:#fff3f0;color:#ff3b30}' +
    '#wb-hot-panel .item .tag.new{background:#e8f5e9;color:#2e7d32}' +
    '#wb-hot-panel .empty{text-align:center;padding:40px 16px;color:#999}' +
    '#wb-hot-panel .stats{padding:8px 16px;font-size:11px;color:#999;border-top:1px solid #f0f0f0;flex-shrink:0}' +
    '#wb-hot-panel.mini .list,#wb-hot-panel.mini .stats{display:none}'
  document.head.appendChild(style)

  var panel = document.createElement('div')
  panel.id = 'wb-hot-panel'
  panel.innerHTML = '<div class="hdr"><h3>微博热搜</h3><div style="display:flex;gap:6px"><button id="wb-refresh">刷新</button><button id="wb-export">导出JSON</button><button id="wb-mini">_</button></div></div><div class="list" id="wb-list"><div class="empty">正在采集...</div></div><div class="stats" id="wb-stats"></div>'
  document.body.appendChild(panel)

  var hotData = []

  function scrapeWeiboList() {
    var items = []
    var els = document.querySelectorAll('.data-list .data, [class*="HotList"] [class*="item"], .td-02 a')
    els.forEach(function(el, i) {
      var titleEl = el.querySelector('a') || el
      var title = (titleEl.textContent || '').trim()
      var heatEl = el.querySelector('span, .hot, [class*="heat"]')
      var heat = heatEl ? (heatEl.textContent || '').trim().replace(/[^0-9]/g, '') : ''
      if (title && title.length > 1 && title.length < 100) {
        items.push({ rank: i + 1, title: title, heat: heat || '-' })
      }
    })
    if (items.length === 0) {
      document.querySelectorAll('.td-02 a[href*="weibo.com"]').forEach(function(el, i) {
        var t = el.textContent.trim()
        if (t && t.length > 1) items.push({ rank: i + 1, title: t, heat: '-' })
      })
    }
    return items
  }

  function escapeHtml(s) {
    var d = document.createElement('div')
    d.textContent = s
    return d.innerHTML
  }

  function renderList(data) {
    var listEl = document.getElementById('wb-list')
    if (!data || data.length === 0) {
      listEl.innerHTML = '<div class="empty">当前页面未检测到热搜数据</div>'
      return
    }
    listEl.innerHTML = data.map(function(item, i) {
      var tagHtml = item.tag ? '<span class="tag ' + (item.tag.indexOf('新') >= 0 ? 'new' : 'hot') + '">' + escapeHtml(item.tag) + '</span>' : ''
      return '<div class="item" data-url="https://s.weibo.com/weibo?q=' + encodeURIComponent(item.title) + '" onclick="window.open(this.dataset.url,\'_blank\')"><span class="rank ' + (i < 3 ? 'top3' : 'normal') + '">' + item.rank + '</span><div class="info"><span class="title">' + escapeHtml(item.title) + tagHtml + '</span><div class="heat">' + item.heat + '</div></div></div>'
    }).join('')
    document.getElementById('wb-stats').textContent = '共 ' + data.length + ' 条 | ' + new Date().toLocaleTimeString()
  }

  async function fetchHotFromAPI() {
    try {
      var res = await fetch('https://weibo.com/ajax/side/hotSearch')
      var data = await res.json()
      if (data.data && data.data.realtime) {
        return data.data.realtime.map(function(item, i) {
          return {
            rank: i + 1,
            title: item.word || item.note || '',
            heat: item.num ? (item.num > 10000 ? (item.num / 10000).toFixed(1) + '万' : item.num) : '-',
            tag: item.label_name || ''
          }
        })
      }
    } catch (e) {}
    return null
  }

  async function refresh() {
    hotData = scrapeWeiboList()
    if (hotData.length === 0) {
      var apiData = await fetchHotFromAPI()
      if (apiData) hotData = apiData
    }
    renderList(hotData)
  }

  document.getElementById('wb-export').addEventListener('click', function() {
    if (hotData.length === 0) return
    var json = JSON.stringify(hotData, null, 2)
    var blob = new Blob([json], { type: 'application/json' })
    var a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'weibo-hot-' + new Date().toISOString().slice(0, 10) + '.json'
    a.click()
  })
  document.getElementById('wb-refresh').addEventListener('click', refresh)
  document.getElementById('wb-mini').addEventListener('click', function() {
    panel.classList.toggle('mini')
    this.textContent = panel.classList.contains('mini') ? '+' : '_'
  })

  refresh()
})()
