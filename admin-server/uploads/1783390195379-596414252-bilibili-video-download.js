// @name: B站视频下载助手
// @description: 在B站视频/番剧页面添加下载面板，支持获取视频下载链接并下载，显示视频信息、画质选择和下载进度
// @version: 1.0.0
// @urlPattern: *bilibili.com/video/*, *bilibili.com/bangumi/play/*

(function () {
  'use strict'

  // 避免重复注入：已存在面板时返回提示，让 AI 直接去提取
  if (document.getElementById('bili-dl-panel')) {
    return {
      ok: true,
      data: [],
      count: 0,
      hint: 'B站下载面板已存在（之前已注入）。直接用 extract_content 提取下载链接',
      panelSelector: '#bili-dl-panel a[href*="bilivideo"]',
      panelInfo: '面板包含视频信息、画质按钮和下载链接'
    }
  }

  // ========== BV号解码 ==========
  const BV_TABLE = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF'
  const BV_MAP = {}
  for (let i = 0; i < BV_TABLE.length; i++) BV_MAP[BV_TABLE[i]] = i
  const BV_BITS = [11, 10, 3, 8, 4, 6]
  const BV_XOR = 177451812
  const BV_ADD = 8728348608

  function decodeBV(bvid) {
    let sum = 0
    for (let i = 0; i < 6; i++) {
      sum += BV_MAP[bvid[BV_BITS[i]]] * Math.pow(58, i)
    }
    return (sum - BV_ADD) ^ BV_XOR
  }

  // ========== URL参数拼接 ==========
  function buildUrl(baseUrl, params) {
    const parts = []
    for (const k in params) {
      if (params[k] !== undefined && params[k] !== null) {
        parts.push(k + '=' + params[k])
      }
    }
    return baseUrl + (baseUrl.includes('?') ? '&' : '?') + parts.join('&')
  }

  // ========== 解析URL查询参数 ==========
  function parseQuery(url) {
    const obj = {}
    const reg = /([^=&\s]+)[=\s]*([^&\s]*)/g
    while (reg.exec(url)) {
      obj[RegExp.$1] = RegExp.$2
    }
    return obj
  }

  // ========== 获取SESSDATA ==========
  function getSessdata() {
    try {
      const match = document.cookie.match(/SESSDATA=([^;]+)/)
      return match ? match[1] : ''
    } catch (e) {
      return ''
    }
  }

  // ========== 获取视频信息 ==========
  function getVideoInfo() {
    const url = location.href
    const isBangumi = url.includes('bilibili.com/bangumi/play/')
    const isVideo = url.includes('bilibili.com/video/')
    if (!isVideo && !isBangumi) return null

    let aid = ''
    let bvid = ''
    let cid = ''

    if (isVideo) {
      const pathParts = url.split('/')
      const bvPart = pathParts.find(p => p.startsWith('BV'))
      if (bvPart) {
        bvid = bvPart.substring(0, 12)
        aid = decodeBV(bvid)
      } else {
        const avMatch = url.match(/\/av(\d+)/)
        if (avMatch) aid = avMatch[1]
      }
    }

    // 从页面__NEXT_DATA__或window获取cid
    try {
      if (isBangumi) {
        const nextData = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}')
        const episodes = nextData?.props?.pageProps?.dehydratedState?.queries?.[0]?.state?.data?.mediaInfo?.episodes
        if (episodes && episodes.length > 0) {
          cid = episodes[0].cid || ''
        }
      }
      if (!cid) {
        // 从playerObject获取
        if (window.player) {
          cid = window.player.getConfig?.()?.cid || ''
        }
      }
    } catch (e) {}

    // 获取视频标题
    let title = ''
    const titleEl = document.querySelector('.video-info-container .video-title') ||
      document.querySelector('#viewbox_report .video-title') ||
      document.querySelector('#player-title') ||
      document.querySelector('h1.video-title') ||
      document.querySelector('.bilibili-player-video-title')
    if (titleEl) title = titleEl.textContent?.trim() || titleEl.title || ''

    return { aid, bvid, cid, isBangumi, isVideo, title }
  }

  // ========== 获取视频播放URL ==========
  async function fetchVideoUrl(info, quality) {
    const sessdata = getSessdata()
    const headers = {
      'Cookie': 'SESSDATA=' + sessdata + ';',
      'User-Agent': navigator.userAgent,
      'Referer': location.href
    }

    if (info.isVideo) {
      // 普通视频
      const params = {
        avid: info.aid,
        cid: info.cid || '',
        qn: quality || 80,
        bvid: info.bvid,
        otype: 'json'
      }
      const apiUrl = buildUrl('https://api.bilibili.com/x/player/playurl', params)
      const resp = await fetch(apiUrl, { method: 'GET', credentials: 'include', headers })
      const data = await resp.json()
      return data
    } else if (info.isBangumi) {
      // 番剧
      let epId = ''
      try {
        const nextData = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}')
        const episodes = nextData?.props?.pageProps?.dehydratedState?.queries?.[0]?.state?.data?.mediaInfo?.episodes
        if (episodes && episodes.length > 0) {
          epId = episodes[0].ep_id || ''
        }
      } catch (e) {}
      if (!epId) {
        const epMatch = location.href.match(/ep(\d+)/)
        if (epMatch) epId = epMatch[1]
      }
      const params = {
        ep_id: epId,
        qn: quality || 64
      }
      const apiUrl = buildUrl('https://api.bilibili.com/pgc/player/web/playurl/', params)
      const resp = await fetch(apiUrl, { method: 'GET', credentials: 'include', headers })
      const data = await resp.json()
      return data
    }
  }

  // ========== 监听XHR获取cid ==========
  let currentCid = ''
  let currentAid = ''

  function hookXHR() {
    const origOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function () {
      this.addEventListener('load', function () {
        try {
          if (this.responseURL?.includes('bvc.bilivideo.com/pbp/data') &&
              this.responseURL?.includes('cid=') &&
              (location.href.includes('bilibili.com/video') || location.href.includes('bilibili.com/bangumi/play'))) {
            const q = parseQuery(this.responseURL)
            if (q.cid) currentCid = q.cid
            if (q.aid) currentAid = q.aid
          }
        } catch (e) {}
      })
      origOpen.apply(this, arguments)
    }
  }

  hookXHR()

  // ========== 画质选项 ==========
  const QUALITY_MAP = {
    16: '流畅 360P',
    32: '清晰 480P',
    64: '高清 720P',
    80: '高清 1080P',
    112: '高清 1080P+',
    116: '高清 1080P60',
    120: '超清 4K'
  }

  // ========== UI构建 ==========
  const style = document.createElement('style')
  style.textContent = `
    #bili-dl-panel{position:fixed;bottom:20px;right:20px;width:340px;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.18);z-index:99999;font:12px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden;display:flex;flex-direction:column;transition:all .3s}
    #bili-dl-panel .hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:linear-gradient(135deg,#00a1d6,#0086b3);color:#fff;flex-shrink:0;cursor:move}
    #bili-dl-panel .hdr h3{margin:0;font-size:14px;font-weight:600}
    #bili-dl-panel .hdr .btns{display:flex;gap:6px}
    #bili-dl-panel .hdr button{background:rgba(255,255,255,.25);border:none;color:#fff;padding:3px 8px;border-radius:12px;cursor:pointer;font-size:11px}
    #bili-dl-panel .hdr button:hover{background:rgba(255,255,255,.4)}
    #bili-dl-panel .body{padding:12px 16px;overflow-y:auto;max-height:300px}
    #bili-dl-panel .info-row{display:flex;justify-content:space-between;padding:4px 0;font-size:12px}
    #bili-dl-panel .info-row .label{color:#999}
    #bili-dl-panel .info-row .value{color:#333;font-weight:500;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #bili-dl-panel .quality-row{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
    #bili-dl-panel .quality-btn{padding:4px 10px;border:1px solid #ddd;border-radius:6px;background:#f8f8f8;cursor:pointer;font-size:11px;transition:all .2s}
    #bili-dl-panel .quality-btn:hover{border-color:#00a1d6;color:#00a1d6}
    #bili-dl-panel .quality-btn.active{background:#00a1d6;color:#fff;border-color:#00a1d6}
    #bili-dl-panel .dl-btn{width:100%;padding:8px;border:none;border-radius:8px;background:linear-gradient(135deg,#00a1d6,#0086b3);color:#fff;font-size:13px;font-weight:600;cursor:pointer;margin-top:8px;transition:opacity .2s}
    #bili-dl-panel .dl-btn:hover{opacity:.85}
    #bili-dl-panel .dl-btn:disabled{background:#ccc;cursor:not-allowed}
    #bili-dl-panel .progress{margin-top:8px;height:4px;background:#eee;border-radius:2px;overflow:hidden}
    #bili-dl-panel .progress-bar{height:100%;background:linear-gradient(90deg,#00a1d6,#0086b3);width:0;transition:width .3s}
    #bili-dl-panel .status{text-align:center;padding:8px;color:#999;font-size:11px}
    #bili-dl-panel .url-list{margin-top:8px;max-height:120px;overflow-y:auto}
    #bili-dl-panel .url-item{display:flex;align-items:center;gap:6px;padding:4px 0;font-size:11px;border-bottom:1px solid #f5f5f5}
    #bili-dl-panel .url-item a{color:#00a1d6;text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #bili-dl-panel .url-item a:hover{text-decoration:underline}
    #bili-dl-panel .url-item .copy-btn{background:#f0f0f0;border:none;padding:2px 6px;border-radius:4px;cursor:pointer;font-size:10px}
    #bili-dl-panel .url-item .copy-btn:hover{background:#e0e0e0}
    #bili-dl-panel.mini .body{display:none}
    #bili-dl-panel .drag-hint{font-size:10px;color:rgba(255,255,255,.6)}
  `
  document.head.appendChild(style)

  const panel = document.createElement('div')
  panel.id = 'bili-dl-panel'
  panel.innerHTML = `
    <div class="hdr">
      <h3>B站视频下载</h3>
      <div class="btns">
        <button id="bili-dl-refresh">刷新</button>
        <button id="bili-dl-mini">_</button>
      </div>
    </div>
    <div class="body">
      <div class="status" id="bili-dl-status">正在检测页面...</div>
    </div>
  `
  document.body.appendChild(panel)

  // ========== 拖动功能 ==========
  const hdr = panel.querySelector('.hdr')
  let isDragging = false, dragOffsetX = 0, dragOffsetY = 0
  hdr.addEventListener('mousedown', function (e) {
    if (e.target.tagName === 'BUTTON') return
    isDragging = true
    dragOffsetX = e.clientX - panel.offsetLeft
    dragOffsetY = e.clientY - panel.offsetTop
    e.preventDefault()
  })
  document.addEventListener('mousemove', function (e) {
    if (!isDragging) return
    let x = e.clientX - dragOffsetX
    let y = e.clientY - dragOffsetY
    x = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, x))
    y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, y))
    panel.style.left = x + 'px'
    panel.style.top = y + 'px'
    panel.style.right = 'auto'
    panel.style.bottom = 'auto'
  })
  document.addEventListener('mouseup', function () { isDragging = false })

  // ========== 面板操作 ==========
  let selectedQuality = 80
  let videoInfo = null

  document.getElementById('bili-dl-mini').addEventListener('click', function () {
    panel.classList.toggle('mini')
    this.textContent = panel.classList.contains('mini') ? '□' : '_'
  })

  document.getElementById('bili-dl-refresh').addEventListener('click', function () {
    initPanel()
  })

  function setStatus(text) {
    const el = document.getElementById('bili-dl-status')
    if (el) el.textContent = text
  }

  function renderPanel(info, playData) {
    const body = panel.querySelector('.body')
    const isBangumi = info.isBangumi
    const resultKey = isBangumi ? 'result' : 'data'
    const durl = playData?.[resultKey]?.durl || []
    const acceptQuality = playData?.[resultKey]?.accept_quality || [80, 64, 32, 16]
    const videoCodecid = playData?.[resultKey]?.video_codecid
    const quality = playData?.[resultKey]?.quality

    let qualityHtml = '<div class="quality-row">'
    acceptQuality.forEach(q => {
      const label = QUALITY_MAP[q] || (q + 'P')
      const active = q === (quality || selectedQuality) ? ' active' : ''
      qualityHtml += `<div class="quality-btn${active}" data-q="${q}">${label}</div>`
    })
    qualityHtml += '</div>'

    let urlHtml = '<div class="url-list">'
    durl.forEach((d, i) => {
      const sizeMB = (d.size / 1024 / 1024).toFixed(1)
      urlHtml += `<div class="url-item"><span>分段${i + 1}(${sizeMB}MB)</span><a href="${d.url}" target="_blank" title="${d.url}">下载链接</a><button class="copy-btn" data-url="${d.url}">复制</button></div>`
    })
    urlHtml += '</div>'

    const totalSize = durl.reduce((s, d) => s + d.size, 0)
    const totalSizeMB = (totalSize / 1024 / 1024).toFixed(1)

    body.innerHTML = `
      <div class="info-row"><span class="label">标题</span><span class="value" title="${info.title}">${info.title || '未知'}</span></div>
      <div class="info-row"><span class="label">AID</span><span class="value">${info.aid || '-'}</span></div>
      <div class="info-row"><span class="label">CID</span><span class="value">${info.cid || currentCid || '-'}</span></div>
      <div class="info-row"><span class="label">大小</span><span class="value">${totalSizeMB} MB</span></div>
      ${qualityHtml}
      ${urlHtml}
      <button class="dl-btn" id="bili-dl-download">下载视频</button>
      <div class="progress" id="bili-dl-progress" style="display:none"><div class="progress-bar" id="bili-dl-progress-bar"></div></div>
    `

    // 画质选择
    body.querySelectorAll('.quality-btn').forEach(btn => {
      btn.addEventListener('click', async function () {
        body.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'))
        this.classList.add('active')
        selectedQuality = parseInt(this.dataset.q)
        setStatus('正在获取播放地址...')
        try {
          const newInfo = getVideoInfo()
          if (currentCid) { newInfo.cid = currentCid }
          if (currentAid) { newInfo.aid = currentAid }
          const newData = await fetchVideoUrl(newInfo, selectedQuality)
          renderPanel(newInfo, newData)
        } catch (e) {
          setStatus('获取失败: ' + e.message)
        }
      })
    })

    // 复制链接
    body.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', function () {
        const url = this.dataset.url
        navigator.clipboard.writeText(url).then(() => {
          this.textContent = '已复制'
          setTimeout(() => { this.textContent = '复制' }, 1500)
        }).catch(() => {
          // fallback
          const ta = document.createElement('textarea')
          ta.value = url
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          document.body.removeChild(ta)
          this.textContent = '已复制'
          setTimeout(() => { this.textContent = '复制' }, 1500)
        })
      })
    })

    // 下载按钮
    document.getElementById('bili-dl-download')?.addEventListener('click', function () {
      downloadVideo(durl, info.title)
    })
  }

  // ========== 下载视频 ==========
  function downloadVideo(durl, title) {
    if (!durl || durl.length === 0) {
      alert('未获取到下载链接，请先刷新')
      return
    }

    const progressEl = document.getElementById('bili-dl-progress')
    const progressBar = document.getElementById('bili-dl-progress-bar')
    const dlBtn = document.getElementById('bili-dl-download')

    if (progressEl) progressEl.style.display = 'block'
    if (dlBtn) dlBtn.disabled = true

    if (durl.length === 1) {
      // 单分段直接下载
      downloadSegment(durl[0].url, (title || 'video') + '.mp4', function (progress) {
        if (progressBar) progressBar.style.width = progress + '%'
      }, function () {
        if (dlBtn) dlBtn.disabled = false
      })
    } else {
      // 多分段依次下载
      let completed = 0
      const total = durl.length
      function nextSegment() {
        if (completed >= total) {
          if (dlBtn) dlBtn.disabled = false
          return
        }
        const seg = durl[completed]
        const segTitle = (title || 'video') + '_part' + (completed + 1) + '.mp4'
        downloadSegment(seg.url, segTitle, function (progress) {
          const overall = ((completed + progress / 100) / total * 100)
          if (progressBar) progressBar.style.width = overall + '%'
        }, function () {
          completed++
          nextSegment()
        })
      }
      nextSegment()
    }
  }

  function downloadSegment(url, filename, onProgress, onComplete) {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url, true)
    xhr.responseType = 'blob'

    xhr.onprogress = function (e) {
      if (e.lengthComputable) {
        onProgress && onProgress(e.loaded / e.total * 100)
      }
    }

    xhr.onreadystatechange = function () {
      if (xhr.readyState === XMLHttpRequest.DONE) {
        const blob = new Blob([xhr.response])
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(a.href)
        onComplete && onComplete()
      }
    }

    xhr.send()
  }

  // ========== 初始化面板 ==========
  async function initPanel() {
    setStatus('正在检测页面...')

    // 等待页面加载
    await new Promise(r => setTimeout(r, 1500))

    videoInfo = getVideoInfo()
    if (!videoInfo) {
      // 可能不在视频页面，仅显示提示
      panel.querySelector('.body').innerHTML = '<div class="status">当前页面不是B站视频页面</div>'
      return
    }

    // 如果没有cid，等待XHR拦截获取
    if (!videoInfo.cid) {
      setStatus('等待获取视频CID，请播放视频...')
      await new Promise(r => setTimeout(r, 3000))
      if (currentCid) {
        videoInfo.cid = currentCid
      }
      // 尝试从页面获取
      if (!videoInfo.cid) {
        try {
          const cidMatch = document.querySelector('[cid]')?.getAttribute('cid')
          if (cidMatch) videoInfo.cid = cidMatch
        } catch (e) {}
      }
      if (!videoInfo.cid) {
        // 尝试通过API获取
        try {
          if (videoInfo.aid || videoInfo.bvid) {
            const apiUrl = videoInfo.bvid
              ? `https://api.bilibili.com/x/web-interface/view?bvid=${videoInfo.bvid}`
              : `https://api.bilibili.com/x/web-interface/view?aid=${videoInfo.aid}`
            const resp = await fetch(apiUrl, { credentials: 'include' })
            const data = await resp.json()
            if (data.data?.cid) {
              videoInfo.cid = data.data.cid
              if (!videoInfo.aid && data.data.aid) videoInfo.aid = data.data.aid
              if (!videoInfo.bvid && data.data.bvid) videoInfo.bvid = data.data.bvid
              if (!videoInfo.title && data.data.title) videoInfo.title = data.data.title
            }
          }
        } catch (e) {
          console.warn('[B站下载] 获取CID失败:', e)
        }
      }
    }

    if (currentAid) videoInfo.aid = currentAid
    if (currentCid) videoInfo.cid = currentCid

    if (!videoInfo.cid) {
      panel.querySelector('.body').innerHTML = '<div class="status">无法获取视频CID，请确保视频正在播放</div>'
      return
    }

    setStatus('正在获取播放地址...')
    try {
      const playData = await fetchVideoUrl(videoInfo, selectedQuality)
      if (playData.code !== 0) {
        panel.querySelector('.body').innerHTML = `<div class="status">获取失败: ${playData.message || '未知错误'}（可能需要登录或大会员）</div>`
        return
      }
      renderPanel(videoInfo, playData)
    } catch (e) {
      panel.querySelector('.body').innerHTML = `<div class="status">获取失败: ${e.message}</div>`
    }
  }

  // 延迟初始化，等待页面加载
  setTimeout(initPanel, 1000)

  // ===== 返回标准化信封（供 AI 下一轮调用使用） =====
  // 旧版仅靠副作用注入面板 DOM，AI 不知道面板结构要盲目搜索（err.json 中浪费 9 轮）
  // 现在返回结构化提示，让 AI 直接知道下一步操作
  return {
    ok: true,
    data: [],
    count: 0,
    hint: 'B站下载面板已注入页面。视频信息已在 videoInfo 字段返回（aid/bvid/cid/title），无需再 extract_content。面板中的"下载链接"是 B 站 API 返回的直链，受 Referer 限制 + 时效签名，直接点击无法下载；必须由用户点击面板里的"下载视频"按钮（#bili-dl-download），通过 XHR+Blob 绕过限制触发真实下载。AI 应直接 finish_task 提示用户：在页面右下角面板中点击"下载视频"按钮开始下载',
    panelSelector: '#bili-dl-panel',
    panelInfo: '面板位于页面右下角，包含：视频标题、AID/CID、画质选择按钮、下载视频按钮。下载视频按钮（#bili-dl-download）通过 XHR+Blob 触发真实下载，绕过 Referer 和时效签名限制',
    videoInfo: (function () {
      try {
        const info = getVideoInfo()
        return info ? { aid: info.aid, bvid: info.bvid, cid: info.cid, title: info.title } : null
      } catch { return null }
    })()
  }
})()
