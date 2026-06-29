// AI Browser Chrome Extension - Content Script 入口
// 负责初始化所有页面注入模块

;(async function() {
  'use strict'

  // 避免在扩展自身页面（sidepanel/popup/options等）注入浮动按钮
  if (location.protocol === 'chrome-extension:') return

  // 避免重复注入
  if (window.__aiBrowserContentLoaded) return
  window.__aiBrowserContentLoaded = true

  console.log('[AI Browser] content script v4 已加载, URL:', location.href)

  // 安全通信：在扩展上下文有效时缓存 sidepanel URL
  let CACHED_SIDEPANEL_URL = null
  let ICON_URL = null
  try {
    if (chrome.runtime?.id) {
      CACHED_SIDEPANEL_URL = chrome.runtime.getURL('sidepanel/sidepanel.html')
      ICON_URL = chrome.runtime.getURL('icons/icon.png')
    }
  } catch (e) {
    CACHED_SIDEPANEL_URL = null
    ICON_URL = null
  }

  // 安全的 chrome.runtime.sendMessage 封装
  function safeSendMessage(msg) {
    if (!chrome.runtime?.id) return
    try {
      chrome.runtime.sendMessage(msg).catch(() => {})
    } catch (e) {}
  }

  let config = { selectionToolsEnabled: true }
  let fabHost = null
  let fabShadow = null
  try {
    config = await chrome.storage.local.get([
      'aiConfig', 'syncConfig', 'selectionToolsEnabled'
    ])
  } catch (e) {
    console.warn('[AI Browser] 读取 storage 配置失败:', e.message)
  }

  // 初始化划词工具栏
  if (config.selectionToolsEnabled !== false) {
    initSelectionToolbar()
  }

  // 初始化页面助手浮动按钮
  initPageAssistant()

  // 初始化智能表单填充
  initFormFill()

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'selectionAction') {
      handleSelectionAction(msg.action, msg.text)
    }
    if (msg.type === 'extractPageContent') {
      const content = extractPageContent()
      sendResponse({ ok: true, data: content })
      return true  // 保持消息通道开放以支持异步
    }
    sendResponse({ ok: true })
  })

  // 监听注入脚本的回调（inject_js 通过 window.postMessage 反馈）
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    if (event.data?.type === 'AI_BROWSER_CALLBACK') {
      safeSendMessage({
        type: 'injectCallback',
        data: event.data.data || {},
        tabUrl: location.href,
      })
    }
  })

  // ---- 划词工具栏 ----
  function initSelectionToolbar() {
    const SELECTION_TOOLS = [
      { id: 'explain', label: '💡 解释', prompt: '请解释以下内容：\n\n' },
      { id: 'translate', label: '🌐 翻译', prompt: '请将以下内容翻译为中文：\n\n' },
      { id: 'rewrite', label: '✍️ 改写', prompt: '请改写以下内容：\n\n' },
      { id: 'summarize', label: '📋 摘要', prompt: '请总结以下内容要点：\n\n' },
    ]

    let toolbar = null

    document.addEventListener('mouseup', (e) => {
      setTimeout(() => {
        try {
          const selection = window.getSelection()
          const text = selection?.toString().trim()
          if (!text || text.length < 3) {
            removeToolbar()
            return
          }
          if (selection.rangeCount === 0) {
            removeToolbar()
            return
          }
          const range = selection.getRangeAt(0)
          const rect = range.getBoundingClientRect()
          if (!rect || rect.width === 0) {
            removeToolbar()
            return
          }
          showToolbar(rect, text)
        } catch (err) {
          console.warn('[划词工具栏] 创建失败:', err.message)
          removeToolbar()
        }
      }, 100)
    })

    document.addEventListener('mousedown', (e) => {
      if (toolbar && !toolbar.contains(e.target)) {
        removeToolbar()
      }
    })

    function showToolbar(rect, text) {
      removeToolbar()
      const host = document.createElement('div')
      host.id = 'ai-browser-selection-host'
      const shadow = host.attachShadow({ mode: 'closed' })

      shadow.innerHTML = `
        <style>
          .toolbar{position:fixed;z-index:2147483600;background:#fff;border:1px solid rgba(79,89,102,0.10);border-radius:10px;padding:6px;display:flex;gap:2px;box-shadow:0 4px 16px rgba(0,0,0,0.10),0 2px 8px rgba(0,0,0,0.04);font-family:'Inter','SF Pro Display',-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;animation:toolbarIn .2s cubic-bezier(.4,0,.2,1)}
          @keyframes toolbarIn{from{opacity:0;transform:translateY(4px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
          .toolbar button{background:none;border:none;padding:7px 12px;border-radius:7px;cursor:pointer;font-size:12px;font-weight:500;color:#1a1a2e;white-space:nowrap;transition:all .2s}
          .toolbar button:hover{background:rgba(104,65,234,0.08);color:#6841ea}
          .toolbar button:active{background:rgba(104,65,234,0.16);transform:scale(.95)}
        </style>
        <div class="toolbar">
          ${SELECTION_TOOLS.map(t => `<button data-id="${t.id}">${t.label}</button>`).join('')}
        </div>
      `

      const toolbarEl = shadow.querySelector('.toolbar')
      toolbarEl.style.top = (rect.top + window.scrollY - 44) + 'px'
      toolbarEl.style.left = (rect.left + window.scrollX + rect.width / 2 - 120) + 'px'

      shadow.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault()
          const tool = SELECTION_TOOLS.find(t => t.id === btn.dataset.id)
          if (tool) {
            handleSelectionAction(tool.id, text)
          }
          removeToolbar()
        })
      })

      document.body.appendChild(host)
      toolbar = host
    }

    function removeToolbar() {
      if (toolbar) {
        toolbar.remove()
        toolbar = null
      }
    }
  }

  // ---- 页面助手浮动按钮组 ----
  function initPageAssistant() {
    const host = document.createElement('div')
    host.id = 'ai-browser-assistant-host'
    const shadow = host.attachShadow({ mode: 'closed' })

    const btns = [
      { id: 'toolbox', label: '工具箱', pill: true, svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>' },
      { id: 'tools', label: '工具', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>' },
      { id: 'agent', label: 'Agent', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2a3 3 0 00-3 3v1a3 3 0 003 3 3 3 0 003-3V5a3 3 0 00-3-3z"/><path d="M12 9v3"/><path d="M7 14a5 5 0 0010 0"/><path d="M12 19v3"/><circle cx="9" cy="14.5" r="1"/><circle cx="15" cy="14.5" r="1"/></svg>' },
      { id: 'settings', label: '设置', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>' },
      { id: 'ai', label: 'AI', pill: true, brand: true, svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>' },
    ]

    const btnsHTML = btns.map(b => {
      const cls = b.pill ? 'fab-pill' : 'fab-icon'
      const brandCls = b.brand ? ' fab-brand' : ''
      const label = b.label ? `<span class="label">${b.label}</span>` : ''
      return `<div class="${cls}${brandCls}" data-action="${b.id}" title="${b.label || b.id}">
        <span class="icon">${b.svg}</span>
        ${label}
      </div>`
    }).join('')

    shadow.innerHTML = `
      <style>
        .fab-group{position:fixed;bottom:60px;right:0;z-index:2147483601;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;display:flex;flex-direction:column;gap:6px;align-items:flex-end}
        .fab-pill,.fab-icon{display:flex;flex-direction:row;align-items:center;cursor:pointer;gap:6px;height:36px;background:#fff;border:1px solid rgba(79,89,102,0.12);box-shadow:0 2px 12px rgba(0,0,0,0.08);border-radius:18px 0 0 18px;border-right:none;transition:background-color .2s,width .3s ease,padding .3s ease}
        .fab-pill{padding:0 12px 0 8px}
        .fab-icon{width:36px;padding:0 0 0 8px;justify-content:flex-start;overflow:hidden;white-space:nowrap}
        .fab-icon:hover{width:auto;padding:0 12px 0 8px}
        .fab-pill:hover,.fab-icon:hover{background:rgba(104,65,234,0.06)}
        .fab-pill:active,.fab-icon:active{background:rgba(104,65,234,0.12)}
        .fab-brand{background:linear-gradient(135deg,#b059f8,#6841ea);border:none;box-shadow:0 2px 16px rgba(104,65,234,0.3)}
        .fab-brand:hover{background:linear-gradient(135deg,#c070ff,#7b52f0)}
        .fab-brand .label{color:#fff}
        .fab-brand .icon{color:#fff}
        .icon{width:20px;height:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#6841ea}
        .label{font-size:13px;font-weight:500;color:#262626;white-space:nowrap}
        .fab-pill:hover .label{color:#6841ea}
        .fab-icon .label{opacity:0;transition:opacity .2s}
        .fab-icon:hover .label{opacity:1;color:#6841ea}
      </style>
      <div class="fab-group">
        ${btnsHTML}
      </div>
    `

    shadow.querySelectorAll('[data-action]').forEach(el => {
      el.addEventListener('click', () => {
        try {
          const action = el.dataset.action
          if (action === 'ai') {
            // AI 按钮：切换 iframe 浮层
            if (isSidebarVisible()) {
              closeFloatingSidebar()
            } else {
              openFloatingSidebar()
            }
          } else {
            // 其它按钮：设定 action 并打开 iframe
            chrome.storage.local.set({ floatingToolAction: action }).catch(() => {})
            openFloatingSidebar()
          }
        } catch (e) {
          console.warn('[AI Browser] 浮动按钮点击异常:', e.message)
        }
      })
    })

    document.body.appendChild(host)
    // 保存引用，方便打开侧边栏时调整浮动按钮位置
    // closed shadow root 无法通过 host.shadowRoot 访问，必须直接保存引用
    fabHost = host
    fabShadow = shadow
  }

  // ---- 浮动侧边栏（iframe 叠层） ----
  let floatingSidebar = null

  function isSidebarVisible() {
    return !!(floatingSidebar
      && document.body.contains(floatingSidebar)
      && floatingSidebar.style.display !== 'none')
  }

  const SIDEBAR_MIN_WIDTH = 360
  const SIDEBAR_MAX_WIDTH = 800
  let sidebarWidth = 500

  function openFloatingSidebar() {
    // 已存在：直接显示
    if (floatingSidebar && document.body.contains(floatingSidebar)) {
      floatingSidebar.style.display = ''
      shiftFabGroup(sidebarWidth)
      return
    }
    if (floatingSidebar) floatingSidebar = null

    if (!CACHED_SIDEPANEL_URL) {
      console.warn('[AI Browser] 无法打开侧边栏：扩展上下文已失效，请刷新页面')
      return
    }

    const host = document.createElement('div')
    host.id = 'ai-browser-sidebar-host'
    const shadow = host.attachShadow({ mode: 'closed' })

    shadow.innerHTML = `
      <style>
        .sidebar{position:fixed;top:0;right:0;width:${sidebarWidth}px;height:100vh;z-index:2147483599;background:#fff;border-left:1px solid #e2e8f0;box-shadow:-4px 0 12px rgba(0,0,0,0.1);display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
        .sidebar-resize-handle{position:absolute;top:0;left:-3px;width:6px;height:100%;cursor:col-resize;z-index:10;transition:background-color .15s}
        .sidebar-resize-handle:hover,.sidebar-resize-handle:active{background:rgba(104,65,234,0.3)}
        .sidebar-header{display:flex;align-items:center;gap:8px;height:44px;padding:0 16px;background:linear-gradient(135deg,#b059f8,#fff);flex-shrink:0}
        .sidebar-header-icon{width:24px;height:24px;flex-shrink:0}
        .sidebar-header-icon img{width:24px;height:24px;display:block}
        .sidebar-header-title{font-size:14px;font-weight:600;color:#fff}
        .sidebar iframe{flex:1;width:100%;border:none}
      </style>
      <div class="sidebar" id="sidebarRoot">
        <div class="sidebar-resize-handle" id="resizeHandle"></div>
        <div class="sidebar-header">
          <span class="sidebar-header-icon">
            <img src="${ICON_URL}" alt="AI Browser" />
          </span>
          <span class="sidebar-header-title">AI Browser</span>
        </div>
        <iframe src="${CACHED_SIDEPANEL_URL}" allow="clipboard-write"></iframe>
      </div>
    `

    // 拖拽调整侧边栏宽度
    const sidebarEl = shadow.getElementById('sidebarRoot')
    const handleEl = shadow.getElementById('resizeHandle')
    let isResizing = false
    let startX = 0
    let startWidth = 0

    handleEl.addEventListener('mousedown', (e) => {
      isResizing = true
      startX = e.clientX
      startWidth = sidebarEl.offsetWidth
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      e.preventDefault()
    })

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return
      const diff = startX - e.clientX
      const newWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth + diff))
      sidebarEl.style.width = newWidth + 'px'
      sidebarWidth = newWidth
      shiftFabGroup(newWidth)
    })

    document.addEventListener('mouseup', () => {
      if (!isResizing) return
      isResizing = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    })

    document.body.appendChild(host)
    floatingSidebar = host
    shiftFabGroup(sidebarWidth)
  }

  function closeFloatingSidebar() {
    if (floatingSidebar) {
      floatingSidebar.style.display = 'none'
    }
    // 恢复浮动按钮到右侧边缘
    shiftFabGroup(0)
  }

  function shiftFabGroup(offsetRight) {
    if (!fabShadow) return
    const group = fabShadow.querySelector('.fab-group')
    if (group) {
      group.style.right = offsetRight + 'px'
    }
  }

  // ---- 划词动作处理 ----
  function handleSelectionAction(action, text) {
    const prompts = {
      explain: '请解释以下内容：\n\n',
      translate: '请将以下内容翻译为中文：\n\n',
      rewrite: '请改写以下内容：\n\n',
      summarize: '请总结以下内容要点：\n\n',
    }
    const prompt = prompts[action] || '请分析以下内容：\n\n'
    const fullMessage = prompt + text
    chrome.storage.local.set({ pendingMessage: fullMessage }).catch(() => {})
    openFloatingSidebar()
  }

  // ---- 页面内容提取 ----
  function extractPageContent() {
    const result = {
      url: location.href,
      title: document.title,
      description: '',
      content: '',
      wordCount: 0,
    }

    // 提取 meta description
    const metaDesc = document.querySelector('meta[name="description"]')
    if (metaDesc) result.description = metaDesc.content || ''

    // 尝试从主流阅读容器提取正文
    const selectors = [
      'article', 'main', '[role="main"]',
      '.article-content', '.post-content', '.entry-content',
      '.content-body', '.article-body', '.story-body',
      '#article-content', '#post-content', '#content',
      '.markdown-body', '.rich-text',
    ]

    let mainEl = null
    for (const sel of selectors) {
      mainEl = document.querySelector(sel)
      if (mainEl) break
    }

    // 如果找不到主内容区，回退到 body
    if (!mainEl) mainEl = document.body

    // 清理并提取文本
    result.content = cleanTextContent(mainEl)
    result.wordCount = result.content.length

    // 截断过长的内容（避免超出 AI token 限制）
    const MAX_LENGTH = 12000
    if (result.content.length > MAX_LENGTH) {
      result.content = result.content.slice(0, MAX_LENGTH) + '\n\n[...内容已截断，共' + result.wordCount + '字]'
    }

    return result
  }

  function cleanTextContent(el) {
    // 克隆节点避免修改原始 DOM
    const clone = el.cloneNode(true)

    // 移除不需要的元素
    const removeSelectors = [
      'script', 'style', 'noscript', 'iframe', 'svg',
      'nav', 'header', 'footer',
      '.ad', '.ads', '.advertisement',
      '.sidebar', '.comment', '.comments',
      '.social-share', '.share-btn',
      '.related', '.recommend',
      '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    ]
    removeSelectors.forEach(sel => {
      clone.querySelectorAll(sel).forEach(e => e.remove())
    })

    // 提取文本，保留段落结构
    const blocks = []
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim()
        if (text) blocks.push(text)
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      if (node.tagName === 'BR') { blocks.push('\n'); return }
      const isBlock = ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TR', 'BLOCKQUOTE', 'PRE'].includes(node.tagName)
      for (const child of node.childNodes) walk(child)
      if (isBlock) blocks.push('\n')
    }
    walk(clone)

    // 合并并清理多余空白
    return blocks.join(' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/  +/g, ' ')
      .trim()
  }

  // ============ 智能表单填充 ============

  function initFormFill() {
    // 定时扫描表单（处理 SPA / 动态加载的表单）
    const formButtons = new WeakMap()

    function scanForms() {
      const forms = document.querySelectorAll('form')
      forms.forEach(form => {
        // 已经注入过按钮则跳过
        if (formButtons.has(form)) return
        // 跳过太小的表单、搜索栏
        const inputs = form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), select, textarea')
        if (inputs.length < 2) return
        // 跳过纯搜索框
        const searchTypes = ['search', 'q', 'query', 'keyword']
        if (inputs.length <= 2 &&
            [...inputs].every(el => searchTypes.includes(el.name?.toLowerCase()) || searchTypes.includes(el.id?.toLowerCase()))) {
          return
        }
        injectFormButton(form)
      })
    }

    function injectFormButton(form) {
      // 创建按钮宿主
      const host = document.createElement('div')
      host.style.cssText = 'display:inline-block;margin-left:10px;vertical-align:middle'

      const shadow = host.attachShadow({ mode: 'closed' })
      shadow.innerHTML = `
        <style>
          .fill-btn{display:inline-flex;align-items:center;gap:4px;padding:5px 12px;font-size:12px;font-weight:500;color:#6841ea;background:rgba(104,65,234,0.06);border:1px solid rgba(104,65,234,0.2);border-radius:6px;cursor:pointer;transition:all .15s;white-space:nowrap;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
          .fill-btn:hover{background:rgba(104,65,234,0.12);border-color:rgba(104,65,234,0.35)}
          .fill-btn:active{background:rgba(104,65,234,0.2);transform:scale(.96)}
          .fill-btn:disabled{opacity:0.5;cursor:not-allowed;transform:none}
          .fill-btn .spinner{width:14px;height:14px;border:2px solid rgba(104,65,234,0.2);border-top-color:#6841ea;border-radius:50%;animation:spin .6s linear infinite;display:none}
          @keyframes spin{to{transform:rotate(360deg)}}
        </style>
        <button class="fill-btn"><span class="spinner"></span>🤖 智能填充</button>
      `

      const btn = shadow.querySelector('.fill-btn')
      const spinner = shadow.querySelector('.spinner')

      btn.addEventListener('click', async () => {
        if (btn.disabled) return
        btn.disabled = true
        spinner.style.display = 'inline-block'

        try {
          const fields = analyzeFormFields(form)

          // 发送到 background 让 AI 生成填充数据
          const response = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
              type: 'formFillRequest',
              fields,
              pageTitle: document.title,
              pageUrl: location.href
            }, resolve)
          })

          if (response?.ok && response.mapping) {
            fillFormFields(form, fields, response.mapping)
            // 成功反馈
            highlightForm(form)
          } else {
            const errMsg = response?.error || 'AI 填充失败'
            console.warn('[AI Browser] 表单填充失败:', errMsg)
            showFillTooltip(form, '❌ 填充失败: ' + errMsg)
          }
        } catch (e) {
          console.warn('[AI Browser] 表单填充异常:', e.message)
          showFillTooltip(form, '❌ 网络错误')
        } finally {
          btn.disabled = false
          spinner.style.display = 'none'
        }
      })

      // 把按钮插入 form 的 submit 按钮前（或表单末尾）
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]')
      if (submitBtn) {
        submitBtn.insertAdjacentElement('beforebegin', host)
      } else {
        form.appendChild(host)
      }

      formButtons.set(form, true)
    }

    // 初始扫描
    scanForms()

    // 使用 MutationObserver 检测新增表单
    const observer = new MutationObserver(() => {
      scanForms()
    })
    try {
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      })
    } catch (e) {
      console.warn('[AI Browser] 无法监听 DOM 变化:', e.message)
    }
  }

  function analyzeFormFields(form) {
    const fields = []
    // 收集所有输入元素
    const inputs = form.querySelectorAll('input:not([type="submit"]):not([type="button"]):not([type="image"]):not([type="hidden"]), select, textarea')
    inputs.forEach((el, idx) => {
      const field = {
        index: idx,
        name: el.name || '',
        type: el.type || el.tagName.toLowerCase(),
        placeholder: el.placeholder || '',
        required: el.required || false,
      }
      // 尝试寻找 label
      if (el.id) {
        const label = document.querySelector(`label[for="${el.id}"]`)
        if (label) field.label = label.textContent.trim()
      }
      if (!field.label) {
        // 查找最近的临近文本
        const prevText = findAdjacentLabel(el)
        if (prevText) field.label = prevText
      }
      // 提取 select 的选项
      if (el.tagName === 'SELECT') {
        field.options = [...el.options].map(o => o.textContent.trim()).filter(o => o)
      }
      // 对于 radio/checkbox，收集同组 value
      if (el.type === 'radio' || el.type === 'checkbox') {
        if (el.name) {
          const groupValues = [...form.querySelectorAll(`input[name="${el.name}"], input[name="$${el.name}"]`)].map(r => r.value).filter(v => v)
          if (groupValues.length) field.options = groupValues
        }
      }
      fields.push(field)
    })
    return fields
  }

  function findAdjacentLabel(el) {
    // 查找前一个兄弟的文本
    let prev = el.previousElementSibling
    if (prev) {
      const text = prev.textContent?.trim()
      if (text && text.length <= 50) return text
    }
    // 查找父元素内的 label
    const parent = el.closest('label, .form-group, .form-item, .field, .input-group, td, .ant-form-item, .el-form-item')
    if (parent) {
      const labelEl = parent.querySelector('label, .label, .title, .field-label')
      if (labelEl) {
        const text = labelEl.textContent?.trim()
        if (text && text.length <= 50) return text.replace(/[*:：\s]+$/, '')
      }
    }
    return null
  }

  function fillFormFields(form, fields, mapping) {
    const inputs = form.querySelectorAll('input:not([type="submit"]):not([type="button"]):not([type="image"]):not([type="hidden"]), select, textarea')
    const inputArr = [...inputs]

    for (const [idx, value] of Object.entries(mapping)) {
      const i = parseInt(idx)
      const el = inputArr[i]
      if (!el) continue

      try {
        if (el.tagName === 'SELECT') {
          // 尝试精确匹配或部分匹配
          const options = [...el.options]
          const match = options.find(o => o.textContent.trim() === value) ||
                        options.find(o => o.textContent.trim().includes(value)) ||
                        (el.value === '' ? options[Math.min(i, options.length - 1)] : null)
          if (match) el.value = match.value
        } else if (el.type === 'radio') {
          const radio = form.querySelector(`input[name="${el.name}"][value="${value}"]`) ||
                        form.querySelector(`input[name="$${el.name}"][value="${value}"]`)
          if (radio) radio.checked = true
        } else if (el.type === 'checkbox') {
          el.checked = ['true', 'yes', '是', '1'].includes(String(value).toLowerCase())
        } else {
          // 原生设置值（支持 React/Vue）
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          const nativeTextareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
          if (el.tagName === 'TEXTAREA' && nativeTextareaSetter) {
            nativeTextareaSetter.call(el, value)
          } else if (nativeInputValueSetter) {
            nativeInputValueSetter.call(el, value)
          } else {
            el.value = value
          }
          // 触发事件以通知框架
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }
      } catch (e) {
        console.warn('[AI Browser] 填入字段失败:', el.name || el.id, e.message)
      }
    }
  }

  function highlightForm(form) {
    const prevBg = form.style.transition
    form.style.transition = 'box-shadow .4s ease'
    form.style.boxShadow = '0 0 0 3px rgba(16,185,129,0.4), 0 0 20px rgba(16,185,129,0.15)'
    setTimeout(() => {
      form.style.boxShadow = ''
      form.style.transition = prevBg
    }, 2000)
  }

  function showFillTooltip(form, message) {
    const div = document.createElement('div')
    div.textContent = message
    div.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;padding:10px 16px;background:#fff;border:1px solid #ef4444;border-radius:8px;font-size:13px;color:#ef4444;box-shadow:0 4px 12px rgba(0,0,0,0.1);font-family:sans-serif'
    document.body.appendChild(div)
    setTimeout(() => div.remove(), 3000)
  }
})()
