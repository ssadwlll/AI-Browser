// @name: 图片批量下载
// @description: 提取页面所有图片，支持按最小分辨率筛选，预览勾选后批量下载为ZIP
// @version: 1.0.0
// @urlPattern: *

(function () {
  'use strict'

  // 防止重复注入
  if (document.getElementById('img-batch-panel')) return

  // ==================== 最小ZIP实现（STORE方式，无压缩） ====================
  function createZip(files) {
    // files: [{name: string, data: Uint8Array}]
    var localHeaders = []
    var centralHeaders = []
    var offset = 0

    for (var i = 0; i < files.length; i++) {
      var fname = encodeUtf8(files[i].name)
      var fdata = files[i].data
      var fnameBytes = new Uint8Array(fname.length)
      for (var j = 0; j < fname.length; j++) fnameBytes[j] = fname.charCodeAt(j)

      var crc = crc32(fdata)
      var size = fdata.length

      // Local file header (30 + fname + data)
      var local = new Uint8Array(30 + fnameBytes.length + size)
      var lv = new DataView(local.buffer)
      lv.setUint32(0, 0x04034b50, true)   // signature
      lv.setUint16(4, 20, true)            // version needed
      lv.setUint16(6, 0, true)             // flags
      lv.setUint16(8, 0, true)             // compression: STORE
      lv.setUint16(10, 0, true)            // mod time
      lv.setUint16(12, 0, true)            // mod date
      lv.setUint32(14, crc, true)          // crc32
      lv.setUint32(18, size, true)         // compressed size
      lv.setUint32(22, size, true)         // uncompressed size
      lv.setUint16(26, fnameBytes.length, true) // filename length
      lv.setUint16(28, 0, true)            // extra field length
      local.set(fnameBytes, 30)
      local.set(fdata, 30 + fnameBytes.length)
      localHeaders.push(local)

      // Central directory header
      var central = new Uint8Array(46 + fnameBytes.length)
      var cv = new DataView(central.buffer)
      cv.setUint32(0, 0x02014b50, true)    // signature
      cv.setUint16(4, 20, true)            // version made by
      cv.setUint16(6, 20, true)            // version needed
      cv.setUint16(8, 0, true)             // flags
      cv.setUint16(10, 0, true)            // compression: STORE
      cv.setUint16(12, 0, true)            // mod time
      cv.setUint16(14, 0, true)            // mod date
      cv.setUint32(16, crc, true)          // crc32
      cv.setUint32(20, size, true)         // compressed size
      cv.setUint32(24, size, true)         // uncompressed size
      cv.setUint16(28, fnameBytes.length, true) // filename length
      cv.setUint16(30, 0, true)            // extra field length
      cv.setUint16(32, 0, true)            // comment length
      cv.setUint16(34, 0, true)            // disk number start
      cv.setUint16(36, 0, true)            // internal attrs
      cv.setUint32(38, 0, true)            // external attrs
      cv.setUint32(42, offset, true)       // local header offset
      central.set(fnameBytes, 46)
      centralHeaders.push(central)

      offset += local.length
    }

    var centralOffset = offset
    var centralSize = 0
    for (var k = 0; k < centralHeaders.length; k++) centralSize += centralHeaders[k].length

    // End of central directory
    var eocd = new Uint8Array(22)
    var ev = new DataView(eocd.buffer)
    ev.setUint32(0, 0x06054b50, true)      // signature
    ev.setUint16(4, 0, true)               // disk number
    ev.setUint16(6, 0, true)               // disk with central dir
    ev.setUint16(8, files.length, true)     // entries on this disk
    ev.setUint16(10, files.length, true)    // total entries
    ev.setUint32(12, centralSize, true)     // central dir size
    ev.setUint32(16, centralOffset, true)   // central dir offset
    ev.setUint16(20, 0, true)              // comment length

    var totalSize = offset + centralSize + 22
    var result = new Uint8Array(totalSize)
    var pos = 0
    for (var m = 0; m < localHeaders.length; m++) {
      result.set(localHeaders[m], pos)
      pos += localHeaders[m].length
    }
    for (var n = 0; n < centralHeaders.length; n++) {
      result.set(centralHeaders[n], pos)
      pos += centralHeaders[n].length
    }
    result.set(eocd, pos)

    return result
  }

  function encodeUtf8(str) {
    return unescape(encodeURIComponent(str))
  }

  function crc32(data) {
    var table = crc32.table
    if (!table) {
      table = new Uint32Array(256)
      for (var i = 0; i < 256; i++) {
        var c = i
        for (var j = 0; j < 8; j++) {
          c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
        }
        table[i] = c
      }
      crc32.table = table
    }
    var crc = 0xFFFFFFFF
    for (var k = 0; k < data.length; k++) {
      crc = table[(crc ^ data[k]) & 0xFF] ^ (crc >>> 8)
    }
    return (crc ^ 0xFFFFFFFF) >>> 0
  }

  // ==================== 辅助函数 ====================
  function formatSize(bytes) {
    if (bytes < 0) return '-'
    if (bytes < 1024) return bytes + 'B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
    return (bytes / 1024 / 1024).toFixed(1) + 'MB'
  }

  function getFilenameFromUrl(url) {
    try {
      var pathname = new URL(url, location.href).pathname
      var parts = pathname.split('/')
      var name = parts[parts.length - 1]
      if (name && name.length > 0 && name.length < 200) {
        // 去除查询参数可能残留
        name = name.split('?')[0].split('#')[0]
        if (name.length > 0) return decodeURIComponent(name)
      }
    } catch (e) {}
    return 'image_' + Date.now() + '.jpg'
  }

  function resolveUrl(src) {
    if (!src) return null
    try {
      return new URL(src, location.href).href
    } catch (e) {
      return null
    }
  }

  // ==================== 扫描图片 ====================
  function scanImages() {
    var map = {}  // src -> info
    var filterMin = getFilterMin()

    // 扫描 <img> 元素
    var imgs = document.querySelectorAll('img')
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i]
      var src = resolveUrl(img.src || img.getAttribute('data-src') || img.getAttribute('data-original'))
      if (!src || src.startsWith('data:')) continue
      if (map[src]) continue
      var w = img.naturalWidth || img.width || 0
      var h = img.naturalHeight || img.height || 0
      if (filterMin > 0 && (w < filterMin || h < filterMin)) continue
      map[src] = {
        src: src,
        width: w,
        height: h,
        alt: img.alt || '',
        fileSize: -1
      }
    }

    // 扫描背景图
    var allElems = document.querySelectorAll('*')
    for (var j = 0; j < allElems.length; j++) {
      var el = allElems[j]
      var bgStyle = getComputedStyle(el).backgroundImage
      if (!bgStyle || bgStyle === 'none') continue
      var matches = bgStyle.match(/url\(["']?(.*?)["']?\)/g)
      if (!matches) continue
      for (var m = 0; m < matches.length; m++) {
        var rawUrl = matches[m].replace(/url\(["']?/, '').replace(/["']?\)/, '')
        var resolvedSrc = resolveUrl(rawUrl)
        if (!resolvedSrc || resolvedSrc.startsWith('data:')) continue
        if (map[resolvedSrc]) continue
        map[resolvedSrc] = {
          src: resolvedSrc,
          width: 0,
          height: 0,
          alt: '',
          fileSize: -1
        }
      }
    }

    var list = []
    for (var key in map) {
      list.push(map[key])
    }

    // 对未获取到尺寸的图片，尝试加载获取
    var needLoad = list.filter(function (item) { return item.width === 0 || item.height === 0 })
    var loaded = 0
    var total = needLoad.length
    if (total > 0) {
      for (var n = 0; n < needLoad.length; n++) {
        (function (item) {
          var tmpImg = new Image()
          tmpImg.onload = function () {
            item.width = tmpImg.naturalWidth
            item.height = tmpImg.naturalHeight
            loaded++
            if (loaded === total) {
              // 重新应用过滤器并刷新
              applyFilterAndRender()
            }
          }
          tmpImg.onerror = function () {
            loaded++
            if (loaded === total) applyFilterAndRender()
          }
          tmpImg.src = item.src
        })(needLoad[n])
      }
    }

    return list
  }

  // ==================== 状态 ====================
  var allImages = []
  var filteredImages = []
  var selectedMap = {}  // src -> true
  var filterMinPx = 0

  function getFilterMin() {
    return filterMinPx
  }

  function applyFilterAndRender() {
    var minPx = filterMinPx
    filteredImages = allImages.filter(function (item) {
      if (minPx === 0) return true
      return item.width >= minPx && item.height >= minPx
    })
    // 去除不在过滤结果中的选中项
    var filteredSrcs = {}
    for (var i = 0; i < filteredImages.length; i++) filteredSrcs[filteredImages[i].src] = true
    for (var key in selectedMap) {
      if (!filteredSrcs[key]) delete selectedMap[key]
    }
    renderGrid()
    updateSummary()
  }

  // ==================== 注入样式 ====================
  var style = document.createElement('style')
  style.textContent =
    '#img-batch-panel{position:fixed;top:80px;right:20px;width:420px;max-height:600px;background:#1a1a2e;color:#eee;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.4);z-index:999999;font:12px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden;display:flex;flex-direction:column;animation:imgPanelIn .3s ease}' +
    '@keyframes imgPanelIn{from{opacity:0;transform:translateY(-20px)}to{opacity:1;transform:translateY(0)}}' +
    '#img-batch-panel .panel-hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;cursor:move;flex-shrink:0;user-select:none}' +
    '#img-batch-panel .panel-hdr h3{margin:0;font-size:14px;font-weight:600}' +
    '#img-batch-panel .panel-hdr .close-btn{background:rgba(255,255,255,.25);border:none;color:#fff;width:24px;height:24px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;line-height:1}' +
    '#img-batch-panel .panel-hdr .close-btn:hover{background:rgba(255,255,255,.4)}' +
    '#img-batch-panel .panel-toolbar{display:flex;align-items:center;gap:8px;padding:8px 16px;background:#16213e;flex-shrink:0}' +
    '#img-batch-panel .panel-toolbar select{background:#0f3460;color:#eee;border:1px solid #4f46e5;border-radius:6px;padding:4px 8px;font-size:12px;outline:none;cursor:pointer}' +
    '#img-batch-panel .panel-toolbar select:focus{border-color:#818cf8}' +
    '#img-batch-panel .panel-toolbar .summary{flex:1;text-align:right;font-size:12px;color:#aaa}' +
    '#img-batch-panel .panel-body{overflow-y:auto;flex:1;padding:8px;min-height:0}' +
    '#img-batch-panel .img-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}' +
    '#img-batch-panel .img-cell{background:#16213e;border-radius:8px;padding:4px;cursor:pointer;transition:background .2s;position:relative}' +
    '#img-batch-panel .img-cell:hover{background:#0f3460}' +
    '#img-batch-panel .img-cell.selected{background:#0f3460;outline:2px solid #818cf8;outline-offset:-2px}' +
    '#img-batch-panel .img-cell .cell-cb{position:absolute;top:6px;left:6px;width:16px;height:16px;accent-color:#818cf8;cursor:pointer;z-index:1}' +
    '#img-batch-panel .img-cell .cell-thumb{display:block;width:100%;max-width:80px;max-height:80px;object-fit:contain;margin:0 auto;border-radius:4px;background:#0a0a1a}' +
    '#img-batch-panel .img-cell .cell-info{text-align:center;font-size:10px;color:#888;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#img-batch-panel .panel-footer{display:flex;align-items:center;gap:8px;padding:8px 16px;background:#16213e;flex-shrink:0}' +
    '#img-batch-panel .panel-footer button{border:none;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;transition:background .2s,color .2s}' +
    '#img-batch-panel .panel-footer .btn-sel{background:#0f3460;color:#eee}' +
    '#img-batch-panel .panel-footer .btn-sel:hover{background:#1a3a6a}' +
    '#img-batch-panel .panel-footer .btn-dl{background:#4f46e5;color:#fff;flex:1}' +
    '#img-batch-panel .panel-footer .btn-dl:hover{background:#6366f1}' +
    '#img-batch-panel .panel-footer .btn-dl:disabled{background:#333;color:#888;cursor:not-allowed}' +
    '#img-batch-panel .empty-msg{text-align:center;padding:40px 16px;color:#666}' +
    '#img-batch-panel .img-cell .cell-size{font-size:9px;color:#555}'
  document.head.appendChild(style)

  // ==================== 创建面板 ====================
  var panel = document.createElement('div')
  panel.id = 'img-batch-panel'
  panel.innerHTML =
    '<div class="panel-hdr" id="img-panel-hdr">' +
      '<h3>图片批量下载</h3>' +
      '<button class="close-btn" id="img-panel-close" title="关闭">\u00d7</button>' +
    '</div>' +
    '<div class="panel-toolbar">' +
      '<select id="img-filter-sel">' +
        '<option value="0">全部</option>' +
        '<option value="100">\u2265100px</option>' +
        '<option value="200">\u2265200px</option>' +
        '<option value="500">\u2265500px</option>' +
        '<option value="800">\u2265800px</option>' +
      '</select>' +
      '<span class="summary" id="img-summary">共 0 张，已选 0 张</span>' +
    '</div>' +
    '<div class="panel-body" id="img-panel-body">' +
      '<div class="empty-msg">正在扫描图片...</div>' +
    '</div>' +
    '<div class="panel-footer">' +
      '<button class="btn-sel" id="img-sel-all">全选</button>' +
      '<button class="btn-sel" id="img-sel-none">取消全选</button>' +
      '<button class="btn-dl" id="img-dl-btn" disabled>下载选中</button>' +
    '</div>'
  document.body.appendChild(panel)

  // ==================== 拖拽 ====================
  var hdr = document.getElementById('img-panel-hdr')
  var isDragging = false
  var dragStartX, dragStartY, panelStartX, panelStartY

  hdr.addEventListener('mousedown', function (e) {
    if (e.target.id === 'img-panel-close') return
    isDragging = true
    dragStartX = e.clientX
    dragStartY = e.clientY
    var rect = panel.getBoundingClientRect()
    panelStartX = rect.left
    panelStartY = rect.top
    e.preventDefault()
  })

  document.addEventListener('mousemove', function (e) {
    if (!isDragging) return
    var dx = e.clientX - dragStartX
    var dy = e.clientY - dragStartY
    panel.style.left = (panelStartX + dx) + 'px'
    panel.style.top = (panelStartY + dy) + 'px'
    panel.style.right = 'auto'
  })

  document.addEventListener('mouseup', function () {
    isDragging = false
  })

  // ==================== 关闭面板 ====================
  document.getElementById('img-panel-close').addEventListener('click', function () {
    panel.remove()
    style.remove()
  })

  // ==================== 渲染网格 ====================
  function renderGrid() {
    var body = document.getElementById('img-panel-body')
    if (filteredImages.length === 0) {
      body.innerHTML = '<div class="empty-msg">未找到符合条件的图片</div>'
      return
    }

    var html = '<div class="img-grid">'
    for (var i = 0; i < filteredImages.length; i++) {
      var item = filteredImages[i]
      var isSelected = selectedMap[item.src]
      var selClass = isSelected ? ' selected' : ''
      var checkedAttr = isSelected ? ' checked' : ''
      var sizeText = (item.width && item.height) ? (item.width + 'x' + item.height) : '-'
      var fileSizeText = item.fileSize >= 0 ? formatSize(item.fileSize) : '-'

      html += '<div class="img-cell' + selClass + '" data-src="' + escapeAttr(item.src) + '" data-idx="' + i + '">' +
        '<input type="checkbox" class="cell-cb"' + checkedAttr + ' data-idx="' + i + '">' +
        '<img class="cell-thumb" src="' + escapeAttr(item.src) + '" loading="lazy" onerror="this.style.display=\'none\'">' +
        '<div class="cell-info">' + sizeText + '</div>' +
        '<div class="cell-size">' + fileSizeText + '</div>' +
      '</div>'
    }
    html += '</div>'
    body.innerHTML = html

    // 绑定事件
    var cells = body.querySelectorAll('.img-cell')
    for (var j = 0; j < cells.length; j++) {
      (function (cell) {
        var idx = parseInt(cell.getAttribute('data-idx'))
        var src = filteredImages[idx].src
        var cb = cell.querySelector('.cell-cb')

        cb.addEventListener('click', function (e) {
          e.stopPropagation()
          toggleSelect(src, idx)
        })

        cell.addEventListener('click', function () {
          toggleSelect(src, idx)
        })
      })(cells[j])
    }

    // 尝试获取文件大小（异步，不阻塞渲染）
    fetchFileSizes()
  }

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function toggleSelect(src, idx) {
    if (selectedMap[src]) {
      delete selectedMap[src]
    } else {
      selectedMap[src] = true
    }
    var cell = document.querySelector('.img-cell[data-idx="' + idx + '"]')
    if (cell) {
      var cb = cell.querySelector('.cell-cb')
      if (selectedMap[src]) {
        cell.classList.add('selected')
        cb.checked = true
      } else {
        cell.classList.remove('selected')
        cb.checked = false
      }
    }
    updateSummary()
  }

  function updateSummary() {
    var total = filteredImages.length
    var selCount = 0
    for (var key in selectedMap) {
      if (selectedMap[key]) selCount++
    }
    document.getElementById('img-summary').textContent = '共 ' + total + ' 张，已选 ' + selCount + ' 张'
    document.getElementById('img-dl-btn').disabled = selCount === 0
  }

  // ==================== 异步获取文件大小 ====================
  var fileSizeFetched = {}
  function fetchFileSizes() {
    for (var i = 0; i < filteredImages.length; i++) {
      (function (item) {
        if (fileSizeFetched[item.src] || item.fileSize >= 0) return
        fileSizeFetched[item.src] = true
        var xhr = new XMLHttpRequest()
        xhr.open('HEAD', item.src, true)
        xhr.onreadystatechange = function () {
          if (xhr.readyState === 4) {
            if (xhr.status === 200) {
              var contentLength = xhr.getResponseHeader('Content-Length')
              if (contentLength) {
                item.fileSize = parseInt(contentLength, 10)
                // 更新DOM中对应的大小显示
                var cell = document.querySelector('.img-cell[data-src="' + CSSescape(item.src) + '"]')
                if (cell) {
                  var sizeEl = cell.querySelector('.cell-size')
                  if (sizeEl) sizeEl.textContent = formatSize(item.fileSize)
                }
              }
            }
          }
        }
        xhr.send()
      })(filteredImages[i])
    }
  }

  function CSSescape(str) {
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }

  // ==================== 过滤器 ====================
  document.getElementById('img-filter-sel').addEventListener('change', function () {
    filterMinPx = parseInt(this.value, 10) || 0
    selectedMap = {}
    applyFilterAndRender()
  })

  // ==================== 全选 / 取消全选 ====================
  document.getElementById('img-sel-all').addEventListener('click', function () {
    for (var i = 0; i < filteredImages.length; i++) {
      selectedMap[filteredImages[i].src] = true
    }
    renderGrid()
    updateSummary()
  })

  document.getElementById('img-sel-none').addEventListener('click', function () {
    selectedMap = {}
    renderGrid()
    updateSummary()
  })

  // ==================== 下载 ====================
  document.getElementById('img-dl-btn').addEventListener('click', function () {
    var btn = document.getElementById('img-dl-btn')
    var selected = []
    for (var key in selectedMap) {
      if (selectedMap[key]) {
        for (var i = 0; i < filteredImages.length; i++) {
          if (filteredImages[i].src === key) {
            selected.push(filteredImages[i])
            break
          }
        }
      }
    }
    if (selected.length === 0) return

    btn.disabled = true
    var downloaded = 0
    var failed = 0
    var total = selected.length
    var blobs = []

    for (var j = 0; j < selected.length; j++) {
      (function (item, idx) {
        fetch(item.src, { mode: 'cors', credentials: 'omit' })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status)
            return res.blob()
          })
          .then(function (blob) {
            blobs[idx] = { item: item, blob: blob }
          })
          .catch(function () {
            // CORS或其他错误，尝试no-cors
            return fetch(item.src, { mode: 'no-cors' })
              .then(function (res) { return res.blob() })
              .then(function (blob) {
                blobs[idx] = { item: item, blob: blob }
              })
              .catch(function () {
                blobs[idx] = { item: item, blob: null, failed: true }
                failed++
              })
          })
          .then(function () {
            downloaded++
            btn.textContent = '下载中 ' + downloaded + '/' + total
            if (downloaded === total) {
              finishDownload(blobs, total, failed)
            }
          })
      })(selected[j], j)
    }
  })

  function finishDownload(blobs, total, failed) {
    var btn = document.getElementById('img-dl-btn')
    var successBlobs = blobs.filter(function (b) { return b && !b.failed && b.blob })

    if (successBlobs.length === 0) {
      btn.textContent = '全部下载失败'
      btn.disabled = false
      setTimeout(function () { btn.textContent = '下载选中' }, 2000)
      return
    }

    if (successBlobs.length === 1 && failed === 0) {
      // 单张直接下载
      var b = successBlobs[0]
      var filename = getFilenameFromUrl(b.item.src)
      downloadBlob(b.blob, filename)
      btn.textContent = '下载完成'
      btn.disabled = false
      setTimeout(function () { btn.textContent = '下载选中' }, 2000)
      return
    }

    // 多张打包ZIP
    var usedNames = {}
    var zipFiles = []
    for (var i = 0; i < successBlobs.length; i++) {
      var entry = successBlobs[i]
      var name = getFilenameFromUrl(entry.item.src)
      // 避免重名
      if (usedNames[name]) {
        var dotIdx = name.lastIndexOf('.')
        var base = dotIdx > 0 ? name.substring(0, dotIdx) : name
        var ext = dotIdx > 0 ? name.substring(dotIdx) : ''
        var counter = usedNames[name]
        name = base + '_' + counter + ext
        usedNames[getFilenameFromUrl(entry.item.src)]++
      } else {
        usedNames[name] = 1
      }
      // 将blob转为Uint8Array
      var reader = new FileReaderSync ? null : null  // 不可用，用异步方式
      zipFiles.push({ name: name, blob: entry.blob })
    }

    // 逐个读取blob为ArrayBuffer后生成ZIP
    var buffers = []
    var readCount = 0
    for (var j = 0; j < zipFiles.length; j++) {
      (function (idx) {
        var reader = new FileReader()
        reader.onload = function () {
          buffers[idx] = new Uint8Array(reader.result)
          readCount++
          if (readCount === zipFiles.length) {
            buildAndDownloadZip()
          }
        }
        reader.onerror = function () {
          buffers[idx] = new Uint8Array(0)
          readCount++
          if (readCount === zipFiles.length) {
            buildAndDownloadZip()
          }
        }
        reader.readAsArrayBuffer(zipFiles[idx].blob)
      })(j)
    }

    function buildAndDownloadZip() {
      var filesForZip = []
      for (var k = 0; k < zipFiles.length; k++) {
        filesForZip.push({ name: zipFiles[k].name, data: buffers[k] || new Uint8Array(0) })
      }
      var zipData = createZip(filesForZip)
      var zipBlob = new Blob([zipData], { type: 'application/zip' })
      var hostname = location.hostname || 'images'
      var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)
      var zipName = hostname + '-' + timestamp + '.zip'
      downloadBlob(zipBlob, zipName)

      if (failed > 0) {
        btn.textContent = '完成（' + failed + '张失败）'
      } else {
        btn.textContent = '下载完成'
      }
      btn.disabled = false
      setTimeout(function () { btn.textContent = '下载选中' }, 3000)
    }
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob)
    var a = document.createElement('a')
    a.href = url
    a.download = filename
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    setTimeout(function () {
      URL.revokeObjectURL(url)
      a.remove()
    }, 100)
  }

  // ==================== 初始化扫描 ====================
  allImages = scanImages()
  filteredImages = allImages.slice()
  renderGrid()
  updateSummary()

})()
