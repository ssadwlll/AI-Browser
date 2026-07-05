// @name: 表格数据导出
// @description: 自动检测页面中的表格，一键导出为CSV或JSON文件。支持多表格选择
// @version: 1.0.0
// @urlPattern: *

(function () {
  'use strict'
  if (document.getElementById('table-export-panel')) {
    return {
      ok: true,
      data: [],
      count: 0,
      hint: '表格导出面板已存在。用 extract_content 提取表格数据',
      panelSelector: '#table-export-panel .tbl-item'
    }
  }

  var style = document.createElement('style')
  style.textContent = '#table-export-panel{position:fixed;bottom:20px;left:20px;width:380px;max-height:70vh;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.18);z-index:99998;font:12px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden;display:flex;flex-direction:column;transition:transform .3s}' +
    '#table-export-panel.collapsed{transform:translateY(calc(100% - 44px))}' +
    '#table-export-panel .hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;flex-shrink:0;cursor:pointer}' +
    '#table-export-panel .hdr h3{margin:0;font-size:14px;font-weight:600}' +
    '#table-export-panel .hdr .badge{background:rgba(255,255,255,.3);padding:1px 8px;border-radius:10px;font-size:11px}' +
    '#table-export-panel .hdr button{background:rgba(255,255,255,.25);border:none;color:#fff;padding:4px 10px;border-radius:14px;cursor:pointer;font-size:11px}' +
    '#table-export-panel .hdr button:hover{background:rgba(255,255,255,.4)}' +
    '#table-export-panel .content{overflow-y:auto;flex:1;padding:8px 0}' +
    '#table-export-panel .tbl-item{display:flex;align-items:center;gap:10px;padding:8px 16px;cursor:pointer;border-bottom:1px solid #f5f5f5}' +
    '#table-export-panel .tbl-item:hover{background:#f0f0ff}' +
    '#table-export-panel .tbl-item .index{width:24px;height:24px;border-radius:50%;background:#eef2ff;color:#6366f1;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}' +
    '#table-export-panel .tbl-item .info{flex:1;min-width:0}' +
    '#table-export-panel .tbl-item .name{font-size:13px;color:#333;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#table-export-panel .tbl-item .meta{font-size:11px;color:#999}' +
    '#table-export-panel .tbl-item .actions{display:flex;gap:4px;flex-shrink:0}' +
    '#table-export-panel .tbl-item .actions button{background:#f5f5f5;border:none;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:10px;color:#666}' +
    '#table-export-panel .tbl-item .actions button:hover{background:#6366f1;color:#fff}' +
    '#table-export-panel .empty{text-align:center;padding:40px 16px;color:#999}' +
    '#table-export-panel .preview-wrap{max-height:200px;overflow:auto;margin:8px 16px;border:1px solid #e5e7eb;border-radius:8px;display:none}' +
    '#table-export-panel .preview-wrap.show{display:block}' +
    '#table-export-panel .preview-wrap table{width:100%;border-collapse:collapse;font-size:11px}' +
    '#table-export-panel .preview-wrap th,#table-export-panel .preview-wrap td{padding:4px 8px;border:1px solid #e5e7eb;text-align:left;white-space:nowrap}' +
    '#table-export-panel .preview-wrap th{background:#f9fafb;font-weight:600;position:sticky;top:0}'
  document.head.appendChild(style)

  var panel = document.createElement('div')
  panel.id = 'table-export-panel'
  panel.innerHTML = '<div class="hdr" id="te-toggle"><h3>表格导出 <span class="badge" id="te-count">0</span></h3><div style="display:flex;gap:6px" onclick="event.stopPropagation()"><button id="te-refresh">刷新</button><button id="te-export-all">全部导出</button></div></div><div class="content" id="te-list"><div class="empty">正在扫描表格...</div></div><div class="preview-wrap" id="te-preview"></div>'
  document.body.appendChild(panel)

  var tables = []

  function escapeHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML }

  function detectTables() {
    var detected = []
    var allTables = document.querySelectorAll('table')
    for (var i = 0; i < allTables.length; i++) {
      var tbl = allTables[i]
      if (tbl.closest('#table-export-panel')) continue
      var rows = tbl.querySelectorAll('tr')
      if (rows.length < 2) continue
      var headerRow = rows[0]
      var headers = []
      var cells = headerRow.querySelectorAll('th,td')
      for (var j = 0; j < cells.length; j++) {
        headers.push((cells[j].textContent || '').trim() || ('列' + (j + 1)))
      }
      if (headers.length === 0) continue
      var title = ''
      var prevEl = tbl.previousElementSibling
      if (prevEl && ['H1','H2','H3','H4','H5','H6','P','DIV'].indexOf(prevEl.tagName) >= 0) {
        title = (prevEl.textContent || '').trim().slice(0, 50)
      }
      if (!title) title = '表格 ' + (i + 1)
      detected.push({ index: i, title: title, element: tbl, headers: headers, rows: rows.length - 1, cols: headers.length })
    }
    return detected
  }

  function extractData(tblInfo) {
    var data = []
    var rows = tblInfo.element.querySelectorAll('tr')
    for (var i = 1; i < rows.length; i++) {
      var row = []
      var cells = rows[i].querySelectorAll('th,td')
      for (var j = 0; j < cells.length; j++) {
        row.push((cells[j].textContent || '').trim())
      }
      var hasContent = false
      for (var k = 0; k < row.length; k++) { if (row[k]) { hasContent = true; break } }
      if (hasContent) data.push(row)
    }
    return data
  }

  function renderTableList() {
    tables = detectTables()
    var listEl = document.getElementById('te-list')
    document.getElementById('te-count').textContent = tables.length

    if (tables.length === 0) {
      listEl.innerHTML = '<div class="empty">当前页面没有检测到表格</div>'
      return
    }

    var html = ''
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i]
      html += '<div class="tbl-item" data-idx="' + i + '"><span class="index">' + (i + 1) + '</span><div class="info"><div class="name">' + escapeHtml(t.title) + '</div><div class="meta">' + t.cols + ' 列 x ' + t.rows + ' 行</div></div><div class="actions"><button class="te-preview" data-idx="' + i + '">预览</button><button class="te-csv" data-idx="' + i + '">CSV</button><button class="te-json" data-idx="' + i + '">JSON</button></div></div>'
    }
    listEl.innerHTML = html

    // 点击高亮
    var items = listEl.querySelectorAll('.tbl-item')
    items.forEach(function(el) {
      el.addEventListener('click', function(e) {
        if (e.target.closest('button')) return
        items.forEach(function(x) { x.classList.remove('active') })
        this.classList.add('active')
        var idx = parseInt(this.dataset.idx)
        var tbl = tables[idx]
        if (tbl) {
          tbl.element.scrollIntoView({ behavior: 'smooth', block: 'center' })
          tbl.element.style.outline = '3px solid #6366f1'
          setTimeout(function() { tbl.element.style.outline = '' }, 2000)
        }
      })
    })

    listEl.querySelectorAll('.te-csv').forEach(function(btn) {
      btn.addEventListener('click', function(e) { e.stopPropagation(); exportCSV(tables[parseInt(btn.dataset.idx)]) })
    })
    listEl.querySelectorAll('.te-json').forEach(function(btn) {
      btn.addEventListener('click', function(e) { e.stopPropagation(); exportJSON(tables[parseInt(btn.dataset.idx)]) })
    })
    listEl.querySelectorAll('.te-preview').forEach(function(btn) {
      btn.addEventListener('click', function(e) { e.stopPropagation(); previewTable(tables[parseInt(btn.dataset.idx)]) })
    })
  }

  function previewTable(tblInfo) {
    var data = extractData(tblInfo)
    var preview = document.getElementById('te-preview')
    preview.classList.add('show')
    var html = '<table><thead><tr>'
    for (var i = 0; i < tblInfo.headers.length; i++) { html += '<th>' + escapeHtml(tblInfo.headers[i]) + '</th>' }
    html += '</tr></thead><tbody>'
    var limit = Math.min(10, data.length)
    for (var j = 0; j < limit; j++) {
      html += '<tr>'
      for (var k = 0; k < data[j].length; k++) { html += '<td>' + escapeHtml(data[j][k]) + '</td>' }
      html += '</tr>'
    }
    html += '</tbody></table>'
    if (data.length > 10) html += '<div style="padding:6px 8px;font-size:11px;color:#999;text-align:center">仅显示前10行，共' + data.length + '行</div>'
    preview.innerHTML = html
  }

  function downloadBlob(blob, filename) { var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click() }

  function exportCSV(tblInfo) {
    var data = extractData(tblInfo)
    if (data.length === 0) return
    var header = tblInfo.headers.map(function(h) { return '"' + h.replace(/"/g, '""') + '"' }).join(',')
    var rows = data.map(function(row) { return row.map(function(c) { return '"' + (c || '').replace(/"/g, '""') + '"' }).join(',') })
    var blob = new Blob(['\uFEFF' + header + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' })
    downloadBlob(blob, (tblInfo.title || 'table').replace(/[\/:*?"<>|]/g, '_').slice(0, 50) + '.csv')
  }

  function exportJSON(tblInfo) {
    var data = extractData(tblInfo)
    if (data.length === 0) return
    var json = data.map(function(row) { var obj = {}; for (var i = 0; i < tblInfo.headers.length; i++) obj[tblInfo.headers[i]] = row[i] || ''; return obj })
    var blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
    downloadBlob(blob, (tblInfo.title || 'table').replace(/[\/:*?"<>|]/g, '_').slice(0, 50) + '.json')
  }

  function exportAllCSV() {
    if (tables.length === 0) return
    var all = '\uFEFF'
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i]
      var data = extractData(t)
      if (data.length === 0) continue
      all += '\n=== ' + t.title + ' ===\n'
      all += t.headers.map(function(h) { return '"' + h.replace(/"/g, '""') + '"' }).join(',') + '\n'
      all += data.map(function(row) { return row.map(function(c) { return '"' + (c || '').replace(/"/g, '""') + '"' }).join(',') }).join('\n') + '\n'
    }
    var blob = new Blob([all], { type: 'text/csv;charset=utf-8' })
    downloadBlob(blob, 'all-tables-' + new Date().toISOString().slice(0, 10) + '.csv')
  }

  document.getElementById('te-toggle').addEventListener('click', function() { panel.classList.toggle('collapsed') })
  document.getElementById('te-refresh').addEventListener('click', renderTableList)
  document.getElementById('te-export-all').addEventListener('click', exportAllCSV)

  renderTableList()

  var observer = new MutationObserver(function() { var nt = detectTables(); if (nt.length !== tables.length) renderTableList() })
  observer.observe(document.body, { childList: true, subtree: true })

  // ===== 返回标准化信封（供 AI 下一轮调用使用） =====
  return {
    ok: true,
    data: [],
    count: tables.length,
    hint: '表格导出面板已注入页面，扫描到 ' + tables.length + ' 个表格。可用 extract_content 提取表格数据',
    panelSelector: '#table-export-panel .tbl-item',
    panelInfo: '面板支持：单表导出 CSV、全部导出、表格预览。每个 tbl-item 对应一个表格'
  }
})()
