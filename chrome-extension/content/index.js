// AI Browser Chrome Extension - Content Script 入口
// 负责初始化所有页面注入模块

;(async function() {
  'use strict'

  // 避免重复注入
  if (window.__aiBrowserContentLoaded) return
  window.__aiBrowserContentLoaded = true

  // 安全的 chrome.runtime.sendMessage 封装，防止扩展重载后报错
  function safeSendMessage(msg) {
    if (!chrome.runtime?.id) return // 扩展已被卸载/重载
    try {
      chrome.runtime.sendMessage(msg).catch(() => {})
    } catch (e) {
      // 忽略 "Extension context invalidated" 等错误
    }
  }

  const config = await chrome.storage.local.get([
    'aiConfig', 'syncConfig', 'selectionToolsEnabled'
  ])

  // 初始化划词工具栏
  if (config.selectionToolsEnabled !== false) {
    initSelectionToolbar()
  }

  // 初始化页面助手浮动按钮
  initPageAssistant()

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
        .fab-group{position:fixed;bottom:60px;right:0;z-index:2147483599;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;display:flex;flex-direction:column;gap:6px;align-items:flex-end}
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
        const action = el.dataset.action
        if (action === 'ai') {
          safeSendMessage({ type: 'openSidebar' })
        } else {
          chrome.storage.local.set({ floatingToolAction: action }).catch(() => {})
          safeSendMessage({ type: 'openSidebar' })
        }
      })
    })

    document.body.appendChild(host)
  }

  // ---- 浮动侧边栏 ----
  let floatingSidebar = null

  function toggleFloatingSidebar() {
    if (floatingSidebar) {
      floatingSidebar.remove()
      floatingSidebar = null
      return
    }

    const host = document.createElement('div')
    host.id = 'ai-browser-sidebar-host'
    const shadow = host.attachShadow({ mode: 'closed' })

    shadow.innerHTML = `
      <style>
        .sidebar{position:fixed;top:0;right:0;width:380px;height:100vh;z-index:2147483599;background:#fff;border-left:1px solid #e2e8f0;box-shadow:-4px 0 12px rgba(0,0,0,0.1);display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
        .sidebar-header{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:12px 16px;display:flex;align-items:center;justify-content:space-between}
        .sidebar-header h3{font-size:14px;font-weight:700}
        .close-btn{background:rgba(255,255,255,0.2);border:none;color:#fff;width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:16px}
        .sidebar-body{flex:1;overflow-y:auto}
        .sidebar-body iframe{width:100%;height:100%;border:none}
      </style>
      <div class="sidebar">
        <div class="sidebar-header">
          <h3>🤖 AI Browser</h3>
          <button class="close-btn" id="closeSidebar">✕</button>
        </div>
        <div class="sidebar-body">
          <iframe src="${chrome.runtime.getURL('sidepanel/sidepanel.html')}" allow="clipboard-write"></iframe>
        </div>
      </div>
    `

    shadow.querySelector('#closeSidebar').addEventListener('click', () => {
      host.remove()
      floatingSidebar = null
    })

    document.body.appendChild(host)
    floatingSidebar = host
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
    // 保存待发送消息到 storage，sidepanel 会自动检测并发送
    chrome.storage.local.set({ pendingMessage: fullMessage }).catch(() => {})
    // 通过 background 打开 Chrome 原生 sidePanel
    safeSendMessage({ type: 'openSidebar' })
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
})()
