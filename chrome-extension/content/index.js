// AI Browser Chrome Extension - Content Script 入口
// 负责初始化所有页面注入模块

;(async function() {
  'use strict'

  // 避免重复注入
  if (window.__aiBrowserContentLoaded) return
  window.__aiBrowserContentLoaded = true

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
        const selection = window.getSelection()
        const text = selection?.toString().trim()
        if (!text || text.length < 3) {
          removeToolbar()
          return
        }
        const range = selection.getRangeAt(0)
        const rect = range.getBoundingClientRect()
        showToolbar(rect, text)
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

  // ---- 页面助手浮动按钮 ----
  function initPageAssistant() {
    const host = document.createElement('div')
    host.id = 'ai-browser-assistant-host'
    const shadow = host.attachShadow({ mode: 'closed' })

    shadow.innerHTML = `
      <style>
        .fab-wrapper{position:fixed;bottom:100px;right:0;z-index:2147483599;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
        .fab{display:flex;flex-direction:row;justify-content:flex-start;align-items:center;cursor:pointer;gap:6px;height:36px;padding:0 8px;border:1px solid rgba(255,255,255,0.1);background:#fff;border-radius:32px 0 0 32px;box-shadow:0 3.2px 12px 0 rgba(0,0,0,0.08),0 5px 25px 0 rgba(0,0,0,0.04);transition:right .3s ease,background-color .2s ease-in-out;right:-26px}
        .fab:hover{right:0;background:rgba(104,65,234,0.08)}
        .fab:active{background:rgba(104,65,234,0.12)}
        .fab .icon{width:20px;height:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
        .fab .label{font-size:13px;font-weight:500;color:#262626;white-space:nowrap}
        .fab:hover .label{color:#6841ea}
      </style>
      <div class="fab-wrapper">
        <div class="fab" title="AI Browser 助手">
          <span class="icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6841ea" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
          </span>
          <span class="label">AI</span>
        </div>
      </div>
    `

    shadow.querySelector('.fab').addEventListener('click', () => {
      // 打开 Chrome 原生 sidePanel
      chrome.runtime.sendMessage({ type: 'openSidebar' })
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
    chrome.storage.local.set({ pendingMessage: fullMessage })
    // 通过 background 打开 Chrome 原生 sidePanel
    chrome.runtime.sendMessage({ type: 'openSidebar' })
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
