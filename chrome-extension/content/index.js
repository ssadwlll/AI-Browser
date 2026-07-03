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

  // 待办追踪面板变量声明（必须在 initTodoTracker 调用之前）
  let _todoHost = null
  let _todoShadow = null
  let _todoVisible = false
  let _todoLastData = null
  let _todoSwitchLogs = []
  const STAGE_NAMES = { 1: 'Stage 1 DOM工具', 2: 'Stage 2 远程脚本', 3: 'Stage 3 数据汇总' }

  // 初始化待办追踪面板
  initTodoTracker()

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

    // 待办更新消息
    if (msg.type === 'todoUpdate') {
      updateTodoPanel(msg.data)
      sendResponse({ ok: true })
      return true
    }

    sendResponse({ ok: true })
  })

  // 监听注入脚本的回调（inject_js 通过 window.postMessage 反馈）
  // 为防止页面脚本伪造回调消息，使用 nonce 验证机制：
  // 1. 内容脚本生成随机 nonce 并暴露到 window（非枚举，MAIN world 可读）
  // 2. 注入脚本回调时携带 nonce: window.__AI_BROWSER_CB_NONCE__
  // 3. 内容脚本校验 nonce 匹配
  // 注意：旧版注入脚本不携带 nonce，会被拒绝（建议更新脚本以包含 nonce）
  const _callbackNonce = Math.random().toString(36).slice(2) + Date.now().toString(36)
  try {
    Object.defineProperty(window, '__AI_BROWSER_CB_NONCE__', {
      value: _callbackNonce,
      writable: false,
      configurable: false,
      enumerable: false,  // 隐藏，防止页面枚举
    })
  } catch (e) {
    console.warn('[AI Browser] 无法设置回调 nonce，回调验证将降级')
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    if (event.data?.type === 'AI_BROWSER_CALLBACK') {
      // 校验 nonce：防止页面脚本伪造回调消息注入后台
      const msgNonce = event.data.nonce
      if (!msgNonce) {
        // 旧版脚本不携带 nonce，记录警告但拒绝（防止伪造）
        console.warn('[AI Browser] 收到无 nonce 的回调消息，已拒绝。请更新注入脚本以包含 nonce: window.__AI_BROWSER_CB_NONCE__')
        return
      }
      if (_callbackNonce && msgNonce !== _callbackNonce) {
        console.warn('[AI Browser] 回调 nonce 不匹配，已拒绝')
        return
      }
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

          // 待办按钮：直接切换待办面板显示，不打开sidebar
          if (action === 'todo') {
            toggleTodoPanel()
            return
          }

          // 其他按钮：打开sidebar
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

  // ---- 待办追踪面板（注入到页面 DOM，紧贴 sidebar 左侧）----
  function initTodoTracker() {
    if (document.getElementById('ai-browser-todo-host')) return

    _todoHost = document.createElement('div')
    _todoHost.id = 'ai-browser-todo-host'
    _todoShadow = _todoHost.attachShadow({ mode: 'closed' })

    _todoShadow.innerHTML = `
      <style>
        :host{position:fixed;top:60px;right:0;z-index:2147483645;font-family:'Segoe UI',Consolas,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;pointer-events:none}
        .todo-panel{pointer-events:auto;width:340px;max-height:calc(100vh - 120px);background:#fff;border:1px solid rgba(79,89,102,0.12);border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,0.12),0 0 1px rgba(0,0,0,0.08);display:none;flex-direction:column;overflow:hidden;animation:todoIn .25s ease-out}
        .todo-panel.show{display:flex}
        @keyframes todoIn{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:translateX(0)}}
        .todo-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid rgba(79,89,102,0.08);flex-shrink:0;cursor:move;user-select:none}
        .todo-header-title{font-size:14px;font-weight:700;color:#262626;display:flex;align-items:center;gap:6px}
        .todo-header-actions{display:flex;gap:4px}
        .todo-header-btn{background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:6px;font-size:12px;color:#8c8c8c;transition:all .2s}
        .todo-header-btn:hover{background:rgba(79,89,102,0.06);color:#404040}
        .todo-header-btn.copy{color:#3bbfff}
        .todo-header-btn.copy:hover{background:rgba(59,191,255,0.08)}
        .todo-header-btn.clear{color:#ea3639}
        .todo-header-btn.clear:hover{background:rgba(234,54,57,0.08)}
        .todo-close{background:none;border:none;cursor:pointer;color:#8c8c8c;padding:4px;border-radius:6px;display:flex;align-items:center;justify-content:center;transition:all .2s}
        .todo-close:hover{background:rgba(79,89,102,0.06);color:#404040}
        .todo-overview{display:flex;gap:10px;padding:8px 16px;background:#fafafa;border-bottom:1px solid rgba(79,89,102,0.06);flex-shrink:0;flex-wrap:wrap;align-items:center;font-size:12px}
        .todo-overview-item{display:flex;align-items:center;gap:4px;color:#8c8c8c}
        .todo-overview-item .val{font-weight:700;font-size:12px}
        .todo-overview-item .val.stage1{color:#3bbfff}
        .todo-overview-item .val.stage2{color:#ffab00}
        .todo-overview-item .val.stage3{color:#00aa5b}
        .todo-progress-bar{width:80px;height:6px;background:#ececee;border-radius:3px;overflow:hidden;display:inline-block;vertical-align:middle}
        .todo-progress-fill{height:100%;background:#00aa5b;border-radius:3px;transition:width 0.4s ease;width:0%}
        .todo-last-tool{font-size:11px;color:#8c8c8c;margin-left:auto;font-style:italic}
        .todo-body{flex:1;overflow-y:auto;padding:10px 14px;max-height:400px}
        .stage-group{margin-bottom:12px}
        .stage-header{display:flex;align-items:center;gap:6px;padding:6px 10px;background:#fafafa;border-radius:8px 8px 0 0;border-left:3px solid #bdbdbd;font-size:12px;font-weight:700;color:#8c8c8c}
        .stage-header.active{border-left-color:#00aa5b;color:#00aa5b;background:rgba(0,170,91,0.04)}
        .stage-header.done{border-left-color:#3bbfff;color:#3bbfff}
        .stage-header .badge{font-size:10px;padding:1px 6px;border-radius:8px;background:#ececee;color:#8c8c8c;margin-left:auto}
        .stage-header.active .badge{background:rgba(0,170,91,0.1);color:#00aa5b}
        .stage-header.done .badge{background:rgba(59,191,255,0.1);color:#3bbfff}
        .todo-list{list-style:none;margin:0;padding:0}
        .todo-item{display:flex;align-items:flex-start;gap:6px;padding:8px 10px;border-bottom:1px solid rgba(79,89,102,0.06);font-size:12px;line-height:1.4;transition:background 0.2s}
        .todo-item:last-child{border-bottom:none}
        .todo-item.running{background:rgba(59,191,255,0.04);border-left:2px solid #3bbfff}
        .todo-item.done{background:rgba(0,170,91,0.04);border-left:2px solid #00aa5b}
        .todo-item.failed{background:rgba(234,54,57,0.04);border-left:2px solid #ea3639}
        .todo-item.pending{border-left:2px solid transparent}
        .todo-icon{flex-shrink:0;width:16px;text-align:center;font-size:12px;line-height:1.4}
        .todo-content{flex:1;min-width:0}
        .todo-id{font-size:10px;color:#8c8c8c;font-family:Consolas,monospace;margin-right:4px}
        .todo-action{font-size:11px;color:#3bbfff;font-family:Consolas,monospace;background:rgba(59,191,255,0.06);padding:1px 4px;border-radius:3px;margin-right:4px}
        .todo-desc{color:#404040;font-size:12px}
        .todo-keys{margin-top:3px;font-size:10px;color:#8c8c8c}
        .todo-keys .key{display:inline-block;background:#ececee;padding:1px 4px;border-radius:3px;margin-right:3px;color:#595959;font-family:Consolas,monospace}
        .stage-switch-log{padding:6px 10px;background:rgba(255,171,0,0.06);border-left:2px solid #ffab00;border-radius:4px;margin:6px 0;font-size:11px;color:#ffab00}
        .empty-state{text-align:center;color:#8c8c8c;padding:40px 20px;font-size:12px;line-height:1.6}
        .toast{position:absolute;top:12px;right:12px;background:#00aa5b;color:#fff;padding:6px 12px;border-radius:6px;font-size:12px;opacity:0;transition:opacity 0.3s;pointer-events:none;z-index:10}
        .toast.show{opacity:1}
      </style>
      <div class="todo-panel" id="todoPanel">
        <div class="todo-header">
          <span class="todo-header-title">📋 待办追踪</span>
          <div class="todo-header-actions">
            <button class="todo-header-btn copy" id="copyBtn" title="复制全部">📋</button>
            <button class="todo-header-btn clear" id="clearBtn" title="清空">✕</button>
            <button class="todo-close" id="closeBtn" title="关闭">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
        <div class="todo-overview" id="overview" style="display:none">
          <div class="todo-overview-item">阶段: <span class="val" id="ovStage">-</span></div>
          <div class="todo-overview-item">进度:
            <div class="todo-progress-bar"><div class="todo-progress-fill" id="ovProgressFill"></div></div>
            <span class="val" id="ovProgress">0%</span>
          </div>
          <div class="todo-overview-item">已完成: <span class="val" id="ovDone">0</span>/<span id="ovTotal">0</span></div>
          <div class="todo-last-tool" id="ovLastTool"></div>
        </div>
        <div class="todo-body" id="todoBody">
          <div class="empty-state">等待 Agent 任务启动…待办列表将自动显示在这里</div>
        </div>
        <div class="toast" id="toast"></div>
      </div>
    `

    document.body.appendChild(_todoHost)

    // 事件绑定
    _todoShadow.getElementById('closeBtn').addEventListener('click', () => {
      _todoShadow.getElementById('todoPanel').classList.remove('show')
      _todoVisible = false
    })
    _todoShadow.getElementById('copyBtn').addEventListener('click', () => {
      copyAllTodos()
    })
    _todoShadow.getElementById('clearBtn').addEventListener('click', () => {
      _todoLastData = null
      _todoSwitchLogs = []
      _todoShadow.getElementById('overview').style.display = 'none'
      _todoShadow.getElementById('todoBody').innerHTML = '<div class="empty-state">已清空，等待新任务…</div>'
      showTodoToast('已清空')
    })

    // 拖动功能
    const header = _todoShadow.getElementById('todoPanel').querySelector('.todo-header')
    const panel = _todoShadow.getElementById('todoPanel')
    let isDragging = false
    let startX, startY, initialLeft, initialTop

    header.addEventListener('mousedown', (e) => {
      // 忽略按钮点击
      if (e.target.closest('button')) return
      
      isDragging = true
      const rect = panel.getBoundingClientRect()
      startX = e.clientX
      startY = e.clientY
      initialLeft = rect.left
      initialTop = rect.top
      
      // 切换到绝对定位以便拖动
      _todoHost.style.position = 'fixed'
      _todoHost.style.top = initialTop + 'px'
      _todoHost.style.left = initialLeft + 'px'
      _todoHost.style.right = 'auto'
      
      e.preventDefault()
    })

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return
      
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      _todoHost.style.left = (initialLeft + dx) + 'px'
      _todoHost.style.top = (initialTop + dy) + 'px'
    })

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false
      }
    })

    // DOM 守护
    const guardian = new MutationObserver(() => {
      if (!document.getElementById('ai-browser-todo-host') && document.body) {
        guardian.disconnect()
        console.log('[AI Browser] 待办面板被移除，重新注入')
        _todoHost = null
        _todoShadow = null
        initTodoTracker()
        // 恢复数据
        if (_todoLastData) updateTodoPanel(_todoLastData)
      }
    })
    guardian.observe(document.body, { childList: true })
  }

  function showTodoToast(msg) {
    if (!_todoShadow) return
    const toast = _todoShadow.getElementById('toast')
    toast.textContent = msg
    toast.classList.add('show')
    setTimeout(() => toast.classList.remove('show'), 2000)
  }

  function copyAllTodos() {
    if (!_todoLastData || !_todoLastData.stages) {
      showTodoToast('没有待办列表')
      return
    }
    let text = ''
    for (const stage of _todoLastData.stages) {
      text += `[${STAGE_NAMES[stage.stage] || 'Stage ' + stage.stage}] ${stage.name || ''}\n`
      for (const todo of stage.subTodos || []) {
        const status = todo._status || 'pending'
        const icon = status === 'done' ? '✅' : status === 'failed' ? '❌' : status === 'running' ? '⏳' : '⬜'
        text += `  ${icon} [${todo.id}] ${todo.action}: ${todo.description || ''}\n`
        if (todo.dataOutputKey) text += `       out: ${todo.dataOutputKey}\n`
        if (todo.dataDependKeys?.length) text += `       dep: ${todo.dataDependKeys.join(', ')}\n`
      }
      text += '\n'
    }
    navigator.clipboard.writeText(text)
      .then(() => showTodoToast('已复制到剪贴板'))
      .catch(() => showTodoToast('复制失败'))
  }

  function updateTodoPanel(data) {
    if (!data || !data.stages || data.stages.length === 0) {
      // 任务完成时自动隐藏待办面板
      if (data && data._taskDone && _todoVisible) {
        _todoLastData = null
        _todoSwitchLogs = []
        _todoShadow.getElementById('overview').style.display = 'none'
        _todoShadow.getElementById('todoBody').innerHTML = '<div class="empty-state">任务已完成，等待新任务…</div>'
        setTimeout(() => {
          _todoShadow.getElementById('todoPanel').classList.remove('show')
          _todoVisible = false
        }, 1000)
      }
      return
    }

    _todoLastData = data

    // 记录阶段切换日志（限制最大数量，防止长任务累积导致内存膨胀）
    if (data.stageSwitch) {
      _todoSwitchLogs.push(`${data.stageSwitch.reason} → ${STAGE_NAMES[data.stageSwitch.to] || 'Stage ' + data.stageSwitch.to}`)
      if (_todoSwitchLogs.length > 50) {
        _todoSwitchLogs.splice(0, _todoSwitchLogs.length - 50)
      }
    }

    // 自动显示
    if (!_todoVisible) {
      _todoShadow.getElementById('todoPanel').classList.add('show')
      _todoVisible = true
    }

    const overview = _todoShadow.getElementById('overview')
    const todoBody = _todoShadow.getElementById('todoBody')

    overview.style.display = 'flex'
    todoBody.innerHTML = ''

    // Update overview
    const progress = data.progress || {}
    const currentStage = data.currentStage || 1
    const stageName = STAGE_NAMES[currentStage] || `Stage ${currentStage}`
    const stageCls = currentStage === 1 ? 'stage1' : currentStage === 2 ? 'stage2' : 'stage3'
    _todoShadow.getElementById('ovStage').textContent = stageName
    _todoShadow.getElementById('ovStage').className = 'val ' + stageCls
    const pct = progress.percentage || 0
    _todoShadow.getElementById('ovProgressFill').style.width = pct + '%'
    _todoShadow.getElementById('ovProgress').textContent = pct + '%'
    _todoShadow.getElementById('ovDone').textContent = progress.completed || 0
    _todoShadow.getElementById('ovTotal').textContent = progress.total || 0
    if (data.lastTool) {
      const statusEmoji = data.lastProgress ? '✅' : '❌'
      _todoShadow.getElementById('ovLastTool').textContent = statusEmoji + ' ' + data.lastTool
    }

    // Find current todo id to mark as running
    const currentTodoId = progress.currentTodo?.id || null
    const currentAction = progress.currentTodo?.action || null
    const isExecutingCurrentTodo = data.lastTool && currentAction && (
      data.lastTool === currentAction ||
      (currentAction.startsWith('inject_script_') && data.lastTool.startsWith('inject_script_'))
    )

    // Render stages
    for (const stage of data.stages) {
      const stageNum = stage.stage
      const isActive = stageNum === currentStage
      const isDone = stageNum < currentStage || (stageNum === currentStage && !currentTodoId && progress.completed > 0)

      const group = document.createElement('div')
      group.className = 'stage-group'

      const header = document.createElement('div')
      header.className = 'stage-header' + (isActive ? ' active' : '') + (isDone ? ' done' : '')
      const headerText = STAGE_NAMES[stageNum] || `Stage ${stageNum}`
      const subTodos = stage.subTodos || []
      const completedCount = subTodos.filter(t => t._status === 'done').length
      // 用 DOM API 构建，避免 innerHTML（headerText 来自常量，但保持一致性）
      const headerLabel = document.createElement('span')
      headerLabel.textContent = headerText
      const headerBadge = document.createElement('span')
      headerBadge.className = 'badge'
      headerBadge.textContent = `${completedCount}/${subTodos.length}`
      header.appendChild(headerLabel)
      header.appendChild(headerBadge)
      group.appendChild(header)

      const list = document.createElement('ul')
      list.className = 'todo-list'

      for (const todo of subTodos) {
        const li = document.createElement('li')
        let status = todo._status || 'pending'
        if (todo.id === currentTodoId && !todo._status && isExecutingCurrentTodo) status = 'running'
        li.className = 'todo-item ' + status

        const icon = document.createElement('span')
        icon.className = 'todo-icon'
        const statusIcons = { done: '✅', failed: '❌', running: '⏳', pending: '⬜' }
        icon.textContent = statusIcons[status] || '⬜'
        li.appendChild(icon)

        const content = document.createElement('div')
        content.className = 'todo-content'
        // 使用 DOM API + textContent 避免 LLM 输出注入 HTML（XSS 防护）
        const todoId = document.createElement('span')
        todoId.className = 'todo-id'
        todoId.textContent = todo.id == null ? '' : String(todo.id)
        const todoAction = document.createElement('span')
        todoAction.className = 'todo-action'
        todoAction.textContent = todo.action == null ? '' : String(todo.action)
        const todoDesc = document.createElement('span')
        todoDesc.className = 'todo-desc'
        todoDesc.textContent = todo.description == null ? '' : String(todo.description)
        content.appendChild(todoId)
        content.appendChild(todoAction)
        content.appendChild(todoDesc)

        const keysDiv = document.createElement('div')
        keysDiv.className = 'todo-keys'
        if (todo.dataOutputKey) {
          const outKey = document.createElement('span')
          outKey.className = 'key'
          outKey.textContent = `out: ${todo.dataOutputKey}`
          keysDiv.appendChild(outKey)
        }
        if (Array.isArray(todo.dataDependKeys) && todo.dataDependKeys.length > 0) {
          const depKey = document.createElement('span')
          depKey.className = 'key'
          depKey.textContent = `dep: ${todo.dataDependKeys.join(', ')}`
          keysDiv.appendChild(depKey)
        }
        if (keysDiv.children.length > 0) content.appendChild(keysDiv)

        li.appendChild(content)
        list.appendChild(li)
      }

      group.appendChild(list)
      todoBody.appendChild(group)
    }

    // Append stage switch logs
    for (const log of _todoSwitchLogs) {
      const div = document.createElement('div')
      div.className = 'stage-switch-log'
      div.textContent = `🔄 ${log}`
      todoBody.appendChild(div)
    }
  }

  function toggleTodoPanel() {
    if (!_todoHost) return
    const panel = _todoShadow.getElementById('todoPanel')
    if (_todoVisible) {
      panel.classList.remove('show')
      _todoVisible = false
    } else {
      panel.classList.add('show')
      _todoVisible = true
    }
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
