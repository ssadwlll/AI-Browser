// @name: 网页长截图
// @description: 自动滚动截取整个网页，拼合为长图下载。支持自定义滚动步长和等待时间
// @version: 1.0.0
// @urlPattern: *

(function () {
  'use strict'
  if (document.getElementById('full-screenshot-panel')) return

  var style = document.createElement('style')
  style.textContent = '#full-screenshot-panel{position:fixed;bottom:20px;left:20px;width:360px;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.2);z-index:99997;font:12px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden;transition:transform .3s}' +
    '#full-screenshot-panel.collapsed{transform:translateY(calc(100% - 44px))}' +
    '#full-screenshot-panel .hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:linear-gradient(135deg,#0ea5e9,#0284c7);color:#fff;flex-shrink:0;cursor:pointer}' +
    '#full-screenshot-panel .hdr h3{margin:0;font-size:14px;font-weight:600}' +
    '#full-screenshot-panel .hdr button{background:rgba(255,255,255,.25);border:none;color:#fff;padding:4px 12px;border-radius:14px;cursor:pointer;font-size:11px}' +
    '#full-screenshot-panel .hdr button:hover{background:rgba(255,255,255,.4)}' +
    '#full-screenshot-panel .body{padding:12px 16px}' +
    '#full-screenshot-panel .row{display:flex;align-items:center;gap:8px;margin-bottom:10px}' +
    '#full-screenshot-panel .row label{width:70px;font-size:12px;color:#666;flex-shrink:0;text-align:right}' +
    '#full-screenshot-panel .row input,#full-screenshot-panel .row select{flex:1;border:1px solid #ddd;border-radius:6px;padding:6px 10px;font-size:12px;outline:none}' +
    '#full-screenshot-panel .row input:focus,#full-screenshot-panel .row select:focus{border-color:#0ea5e9}' +
    '#full-screenshot-panel .btn-row{display:flex;gap:8px;margin-top:12px}' +
    '#full-screenshot-panel .btn-row button{flex:1;padding:8px 0;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}' +
    '#full-screenshot-panel .btn-primary{background:linear-gradient(135deg,#0ea5e9,#0284c7);color:#fff}' +
    '#full-screenshot-panel .btn-primary:disabled{opacity:.5;cursor:not-allowed}' +
    '#full-screenshot-panel .btn-secondary{background:#f1f5f9;color:#475569}' +
    '#full-screenshot-panel .btn-secondary:hover{background:#e2e8f0}' +
    '#full-screenshot-panel .progress-wrap{display:none;margin-top:10px}' +
    '#full-screenshot-panel .progress-wrap.show{display:block}' +
    '#full-screenshot-panel .progress-bar{height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden}' +
    '#full-screenshot-panel .progress-fill{height:100%;background:linear-gradient(90deg,#0ea5e9,#6366f1);border-radius:3px;transition:width .3s;width:0}' +
    '#full-screenshot-panel .progress-text{font-size:11px;color:#999;margin-top:4px;text-align:center}' +
    '#full-screenshot-panel .preview{margin-top:10px;max-height:200px;overflow:auto;border:1px solid #e5e7eb;border-radius:8px;display:none}' +
    '#full-screenshot-panel .preview.show{display:block}' +
    '#full-screenshot-panel .preview img{width:100%;display:block}'
  document.head.appendChild(style)

  var panel = document.createElement('div')
  panel.id = 'full-screenshot-panel'
  panel.innerHTML = '<div class="hdr" id="fs-toggle"><h3>网页长截图</h3><button id="fs-mini">_</button></div><div class="body"><div class="row"><label>滚动步长</label><input id="fs-step" type="number" value="400" min="100" max="2000" /><span style="font-size:11px;color:#999">px</span></div><div class="row"><label>等待时间</label><input id="fs-delay" type="number" value="300" min="100" max="3000" /><span style="font-size:11px;color:#999">ms</span></div><div class="row"><label>格式</label><select id="fs-format"><option value="image/png">PNG</option><option value="image/jpeg">JPEG</option><option value="image/webp">WebP</option></select></div><div class="row"><label>JPEG质量</label><input id="fs-quality" type="number" value="90" min="10" max="100" /><span style="font-size:11px;color:#999">%</span></div><div class="btn-row"><button class="btn-primary" id="fs-start">开始截图</button><button class="btn-secondary" id="fs-stop" disabled>停止</button></div><div class="progress-wrap" id="fs-progress"><div class="progress-bar"><div class="progress-fill" id="fs-fill"></div></div><div class="progress-text" id="fs-text">准备中...</div></div><div class="preview" id="fs-preview"></div></div>'
  document.body.appendChild(panel)

  var isCapturing = false
  var abortCapture = false

  function resetUI() {
    isCapturing = false
    document.getElementById('fs-start').disabled = false
    document.getElementById('fs-stop').disabled = true
  }

  async function startCapture() {
    if (isCapturing) return
    isCapturing = true
    abortCapture = false

    var step = parseInt(document.getElementById('fs-step').value) || 400
    var delay = parseInt(document.getElementById('fs-delay').value) || 300
    var format = document.getElementById('fs-format').value
    var quality = parseInt(document.getElementById('fs-quality').value) / 100

    document.getElementById('fs-start').disabled = true
    document.getElementById('fs-stop').disabled = false
    document.getElementById('fs-progress').classList.add('show')
    document.getElementById('fs-preview').classList.remove('show')

    var totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
    var vw = window.innerWidth
    var vh = window.innerHeight

    // 创建全尺寸 canvas
    var canvas = document.createElement('canvas')
    canvas.width = vw
    canvas.height = totalHeight
    var ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, vw, totalHeight)

    // 回顶部
    window.scrollTo(0, 0)
    await new Promise(function(r) { setTimeout(r, 500) })

    var currentY = 0
    var segments = []

    while (currentY < totalHeight && !abortCapture) {
      window.scrollTo(0, currentY)
      await new Promise(function(r) { setTimeout(r, delay) })

      var segH = Math.min(vh, totalHeight - currentY)
      var segCanvas = document.createElement('canvas')
      segCanvas.width = vw
      segCanvas.height = segH
      var segCtx = segCanvas.getContext('2d')
      segCtx.fillStyle = '#ffffff'
      segCtx.fillRect(0, 0, vw, segH)

      // 逐元素绘制到 canvas
      drawPageToCanvas(segCtx, vw, segH)
      segments.push({ canvas: segCanvas, y: currentY })

      currentY += step
      var progress = Math.min(100, Math.round((currentY / totalHeight) * 100))
      document.getElementById('fs-fill').style.width = progress + '%'
      document.getElementById('fs-text').textContent = '截取中... ' + progress + '%'
    }

    if (abortCapture) { document.getElementById('fs-text').textContent = '已取消'; resetUI(); return }

    // 拼合
    for (var i = 0; i < segments.length; i++) {
      ctx.drawImage(segments[i].canvas, 0, segments[i].y)
    }

    document.getElementById('fs-fill').style.width = '100%'
    document.getElementById('fs-text').textContent = '截图完成！' + vw + 'x' + totalHeight + 'px'

    // 预览 + 下载
    var dataUrl = canvas.toDataURL(format, quality)
    var preview = document.getElementById('fs-preview')
    preview.classList.add('show')
    preview.innerHTML = '<img src="' + dataUrl + '" />'

    var pageTitle = (document.title || 'screenshot').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 40)
    var ext = format.split('/')[1]
    var a = document.createElement('a')
    a.href = dataUrl
    a.download = pageTitle + '-full.' + ext
    a.click()

    resetUI()
  }

  function drawPageToCanvas(ctx, w, h) {
    try {
      // 绘制背景
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)

      // 遍历 DOM 元素绘制
      var els = document.querySelectorAll('body *')
      for (var i = 0; i < els.length; i++) {
        var el = els[i]
        var rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        if (rect.bottom < 0 || rect.top > h) continue

        var x = rect.left
        var y = rect.top

        // 背景色
        var bg = getComputedStyle(el).backgroundColor
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          ctx.fillStyle = bg
          ctx.fillRect(x, y, rect.width, rect.height)
        }

        // 文本
        if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
          var txt = el.textContent.trim()
          if (txt && txt.length < 500) {
            var cs = getComputedStyle(el)
            ctx.fillStyle = cs.color || '#000'
            ctx.font = (cs.fontWeight || 'normal') + ' ' + cs.fontSize + ' ' + (cs.fontFamily || 'sans-serif').split(',')[0].replace(/"/g, '')
            ctx.textBaseline = 'top'
            var paddingTop = parseFloat(cs.paddingTop) || 0
            var paddingLeft = parseFloat(cs.paddingLeft) || 0
            var paddingRight = parseFloat(cs.paddingRight) || 0
            var maxWidth = rect.width - paddingLeft - paddingRight
            if (maxWidth <= 0) maxWidth = rect.width
            var lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4
            var lines = wrapText(ctx, txt, maxWidth)
            for (var j = 0; j < lines.length && j < 20; j++) {
              ctx.fillText(lines[j], x + paddingLeft, y + paddingTop + j * lineH)
            }
          }
        }
      }

      // 绘制图片
      var imgs = document.querySelectorAll('img')
      for (var k = 0; k < imgs.length; k++) {
        var img = imgs[k]
        var ir = img.getBoundingClientRect()
        if (ir.width <= 0 || ir.height <= 0) continue
        if (ir.bottom < 0 || ir.top > h) continue
        if (img.complete && img.naturalWidth > 0) {
          try { ctx.drawImage(img, ir.left, ir.top, ir.width, ir.height) } catch (ex) {}
        }
      }
    } catch (e) {}
  }

  function wrapText(ctx, text, maxWidth) {
    var words = []
    var current = ''
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i)
      var test = current + ch
      if (ch === '\n') { if (current) words.push(current); words.push(''); current = '' }
      else if (ctx.measureText(test).width > maxWidth && current.length > 0) { words.push(current); current = ch }
      else { current = test }
    }
    if (current) words.push(current)
    return words
  }

  function stopCapture() { abortCapture = true; isCapturing = false; resetUI() }

  document.getElementById('fs-toggle').addEventListener('click', function() { panel.classList.toggle('collapsed') })
  document.getElementById('fs-mini').addEventListener('click', function(e) { e.stopPropagation(); panel.classList.toggle('collapsed') })
  document.getElementById('fs-start').addEventListener('click', startCapture)
  document.getElementById('fs-stop').addEventListener('click', stopCapture)
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && isCapturing) stopCapture() })
})()
