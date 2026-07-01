// AI Browser Chrome Extension - Content Script 入口
// 负责初始化所有页面注入模块

;(async function() {
  'use strict'

  // 避免在扩展自身页面（sidepanel/popup/options等）注入
  if (location.protocol === 'chrome-extension:') return

  // 避免重复注入
  if (window.__aiBrowserContentLoaded) return
  window.__aiBrowserContentLoaded = true

  console.log('[AI Browser] content script v5 已加载, URL:', location.href)

  // 安全的 chrome.runtime.sendMessage 封装
  function safeSendMessage(msg) {
    if (!chrome.runtime?.id) return
    try {
      chrome.runtime.sendMessage(msg).catch(() => {})
    } catch (e) {}
  }

  let config = { selectionToolsEnabled: true }
  try {
    config = await chrome.storage.local.get([
      'aiConfig', 'syncConfig', 'selectionToolsEnabled'
    ])
  } catch (e) {
    console.warn('[AI Browser] 读取 storage 配置失败:', e.message)
  }

  // 初始化页面助手浮动按钮
  initPageAssistant()

  // 初始化划词工具栏
  if (config.selectionToolsEnabled !== false) {
    initSelectionToolbar()
  }

  // 初始化智能表单填充
  initFormFill()

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'extractPageContent') {
      const content = extractPageContent()
      sendResponse({ ok: true, data: content })
      return true
    }

    // 右键菜单动作（AI 总结/翻译/解释）
    if (msg.type === 'selectionAction') {
      handleSelectionAction(msg.action, msg.text || '')
      sendResponse({ ok: true })
      return true
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
          .toolbar{position:fixed;z-index:10000;background:#fff;border:1px solid rgba(79,89,102,0.10);border-radius:10px;padding:6px;display:flex;gap:2px;box-shadow:0 4px 16px rgba(0,0,0,0.10),0 2px 8px rgba(0,0,0,0.04);font-family:'Inter','SF Pro Display',-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;animation:toolbarIn .2s cubic-bezier(.4,0,.2,1)}
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
    // 避免重复注入
    if (document.getElementById('ai-browser-assistant-host')) return

    const host = document.createElement('div')
    host.id = 'ai-browser-assistant-host'
    const shadow = host.attachShadow({ mode: 'closed' })

    const btns = [
      { id: 'toolbox', label: '工具箱', pill: true, svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>' },
      { id: 'tools', label: '工具', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>' },
      { id: 'todo', label: '待办', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>' },
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
        .fab-group{position:fixed;bottom:60px;right:0;z-index:2147483646;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;display:flex;flex-direction:column;gap:6px;align-items:flex-end;pointer-events:none}
        .fab-pill,.fab-icon{display:flex;flex-direction:row;align-items:center;cursor:pointer;gap:6px;height:36px;background:#fff;border:1px solid rgba(79,89,102,0.12);box-shadow:0 2px 12px rgba(0,0,0,0.08);border-radius:18px 0 0 18px;border-right:none;transition:background-color .2s,width .3s ease,padding .3s ease,transform .15s ease;pointer-events:auto}
        .fab-pill{padding:0 12px 0 8px}
        .fab-icon{width:36px;padding:0 0 0 8px;justify-content:flex-start;overflow:hidden;white-space:nowrap}
        .fab-icon:hover{width:auto;padding:0 12px 0 8px}
        .fab-pill:hover,.fab-icon:hover{background:rgba(104,65,234,0.06)}
        .fab-pill:active,.fab-icon:active{background:rgba(104,65,234,0.12);transform:scale(.96)}
        .fab-brand{background:linear-gradient(135deg,#b059f8,#6841ea);border:none;box-shadow:0 2px 16px rgba(104,65,234,0.3)}
        .fab-brand:hover{background:linear-gradient(135deg,#c070ff,#7b52f0)}
        .fab-brand .label{color:#fff}
        .fab-brand .icon{color:#fff}
        .icon{width:20px;height:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#6841ea}
        .label{font-size:13px;font-weight:500;color:#262626;white-space:nowrap}
        .fab-pill:hover .label{color:#6841ea}
        .fab-icon .label{opacity:0;transition:opacity .2s}
        .fab-icon:hover .label{opacity:1;color:#6841ea}
        .fab-toast{position:fixed;bottom:110px;right:16px;z-index:2147483646;background:#333;color:#fff;font-size:12px;padding:6px 14px;border-radius:6px;pointer-events:none;opacity:0;transition:opacity .3s ease;white-space:nowrap;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
        .fab-toast.show{opacity:1}
      </style>
      <div class="fab-group">
        ${btnsHTML}
      </div>
      <div class="fab-toast"></div>
    `

    const toast = shadow.querySelector('.fab-toast')
    let toastTimer = null

    function showToast(text, duration = 2500) {
      toast.textContent = text
      toast.classList.add('show')
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => toast.classList.remove('show'), duration)
    }

    let contextInvalidated = false

    shadow.querySelectorAll('[data-action]').forEach(el => {
      el.addEventListener('click', () => {
        if (contextInvalidated) {
          showToast('扩展已更新，请刷新页面后使用')
          return
        }
        try {
          const action = el.dataset.action
          // AI 按钮预留功能点
          if (action === 'ai') {
            showToast('AI 功能开发中，敬请期待')
            return
          }

          // 视觉反馈：短暂缩放
          el.style.transform = 'scale(0.92)'
          setTimeout(() => { el.style.transform = '' }, 150)

          // 先存储 action，确保即使 sidePanel 打开失败也能在手动打开时读取
          chrome.storage.local.set({ floatingToolAction: action }).catch(() => {})

          // 请求后台打开 sidePanel
          chrome.runtime.sendMessage({ type: 'toggleSidebar', action }).then(resp => {
            if (!resp?.ok) {
              showToast('请点击浏览器工具栏的扩展图标打开面板')
            }
          }).catch(() => {
            // 扩展上下文可能失效，action 已存储，用户可手动打开
          })
        } catch (e) {
          if (e.message?.includes('Extension context invalidated') || e.message?.includes('context invalidated')) {
            contextInvalidated = true
            showToast('扩展已更新，请刷新页面后使用', 4000)
          }
          console.warn('[AI Browser] 浮动按钮点击异常:', e.message)
        }
      })
    })

    document.body.appendChild(host)

    // DOM 守护：如果 host 被页面脚本意外移除，重新注入
    const guardian = new MutationObserver(() => {
      if (!document.getElementById('ai-browser-assistant-host') && document.body) {
        guardian.disconnect()
        console.log('[AI Browser] 浮动按钮被移除，重新注入')
        initPageAssistant()
      }
    })
    guardian.observe(document.body, { childList: true })
  }

  // ---- 划词/右键动作处理（通过原生 sidePanel）----
  function handleSelectionAction(action, text) {
    // 页面级提示（右键菜单 summarize/translate，无选中文本，sidepanel 自动注入页面内容）
    const pagePrompts = {
      summarize: '总结当前页面内容',
      translate: '翻译当前页面为中文',
    }
    // 划词级提示（有选中文本，提示词 + 文本内容）
    const selectionPrompts = {
      explain: '请解释以下内容：\n\n',
      translate: '请将以下内容翻译为中文：\n\n',
      rewrite: '请改写以下内容：\n\n',
      summarize: '请总结以下内容要点：\n\n',
    }

    let fullMessage
    if (!text && pagePrompts[action]) {
      // 页面级：短提示，sidepanel 的 sendMessage 会自动检测关键词并注入页面内容
      fullMessage = pagePrompts[action]
    } else {
      // 划词级：提示词 + 选中文本
      const prompt = selectionPrompts[action] || '请分析以下内容：\n\n'
      fullMessage = prompt + text
    }

    // 存储待发送消息，并打开原生 sidePanel
    chrome.storage.local.set({ pendingMessage: fullMessage }).catch(() => {})
    safeSendMessage({ type: 'toggleSidebar', action })
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

    const metaDesc = document.querySelector('meta[name="description"]')
    if (metaDesc) result.description = metaDesc.content || ''

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

    if (!mainEl) mainEl = document.body

    result.content = cleanTextContent(mainEl)
    result.wordCount = result.content.length

    const MAX_LENGTH = 12000
    if (result.content.length > MAX_LENGTH) {
      result.content = result.content.slice(0, MAX_LENGTH) + '\n\n[...内容已截断，共' + result.wordCount + '字]'
    }

    return result
  }

  function cleanTextContent(el) {
    const clone = el.cloneNode(true)

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

    return blocks.join(' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/  +/g, ' ')
      .trim()
  }

  // ============ 智能表单填充 ============

  function initFormFill() {
    const formButtons = new WeakMap()

    function scanForms() {
      const forms = document.querySelectorAll('form')
      forms.forEach(form => {
        if (formButtons.has(form)) return
        const inputs = form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), select, textarea')
        if (inputs.length < 2) return
        const searchTypes = ['search', 'q', 'query', 'keyword']
        if (inputs.length <= 2 &&
            [...inputs].every(el => searchTypes.includes(el.name?.toLowerCase()) || searchTypes.includes(el.id?.toLowerCase()))) {
          return
        }
        injectFormButton(form)
      })
    }

    function injectFormButton(form) {
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

      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]')
      if (submitBtn) {
        submitBtn.insertAdjacentElement('beforebegin', host)
      } else {
        form.appendChild(host)
      }

      formButtons.set(form, true)
    }

    scanForms()

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
    const inputs = form.querySelectorAll('input:not([type="submit"]):not([type="button"]):not([type="image"]):not([type="hidden"]), select, textarea')
    inputs.forEach((el, idx) => {
      const field = {
        index: idx,
        name: el.name || '',
        type: el.type || el.tagName.toLowerCase(),
        placeholder: el.placeholder || '',
        required: el.required || false,
      }
      if (el.id) {
        const label = document.querySelector(`label[for="${el.id}"]`)
        if (label) field.label = label.textContent.trim()
      }
      if (!field.label) {
        const prevText = findAdjacentLabel(el)
        if (prevText) field.label = prevText
      }
      if (el.tagName === 'SELECT') {
        field.options = [...el.options].map(o => o.textContent.trim()).filter(o => o)
      }
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
    let prev = el.previousElementSibling
    let count = 0
    while (prev && count < 3) {
      if (prev.tagName === 'LABEL') return prev.textContent.trim()
      const text = prev.textContent?.trim()
      if (text && text.length < 50) return text
      prev = prev.previousElementSibling
      count++
    }
    const parent = el.parentElement
    if (parent?.tagName === 'LABEL') return parent.textContent.trim()
    return null
  }

  function fillFormFields(form, fields, mapping) {
    for (const [key, value] of Object.entries(mapping)) {
      const idx = parseInt(key)
      if (isNaN(idx) || idx >= fields.length) continue
      const el = form.querySelectorAll('input:not([type="submit"]):not([type="button"]):not([type="image"]):not([type="hidden"]), select, textarea')[idx]
      if (!el) continue
      try {
        if (el.tagName === 'SELECT') {
          // 在 option 列表中查找匹配项（文本包含 value），取其 option.value 赋值
          const optionEls = [...el.options]
          const matchOpt = optionEls.find(o => o.textContent.trim().includes(value)) ||
                           (el.value === '' ? optionEls[Math.min(idx, optionEls.length - 1)] : null)
          if (matchOpt) el.value = matchOpt.value
        } else if (el.type === 'radio') {
          const radio = form.querySelector(`input[name="${el.name}"][value="${value}"]`) ||
                        form.querySelector(`input[name="$${el.name}"][value="${value}"]`)
          if (radio) radio.checked = true
        } else if (el.type === 'checkbox') {
          el.checked = ['true', 'yes', '是', '1'].includes(String(value).toLowerCase())
        } else {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          const nativeTextareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
          if (el.tagName === 'TEXTAREA' && nativeTextareaSetter) {
            nativeTextareaSetter.call(el, value)
          } else if (nativeInputValueSetter) {
            nativeInputValueSetter.call(el, value)
          } else {
            el.value = value
          }
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
