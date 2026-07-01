// AI Browser Chrome Extension - SidePanel Logic

const MSG_TYPES = {
  CALL_SERVICE: 'callService',
  STREAM_CHUNK: 'streamChunk',
  STREAM_DONE: 'streamDone',
  STREAM_ERROR: 'streamError',
}

let chatHistory = []
let isStreaming = false
let currentPort = null
let recentlyStreamedContent = '' // 防止 storage.onChanged 重复添加 streaming 内容
let agentMode = false      // Agent 自主决策模式
let agentStepCards = []    // Agent 步骤卡片
let currentModelInfo = null     // 当前选中模型的能力信息
let currentSelectedModelId = null  // 当前选中模型 ID（与配置同步）
let attachedImage = null        // 已附加的图片 base64 data URL
let attachedPdf = null          // 已附加的 PDF { name, text, chars, pages }

// 附件预览：注册已发送气泡内的 PDF 数据（供点击预览时取回文本）
const pdfPreviewRegistry = new Map()
let pdfPreviewIdCounter = 0
// 附件持久化 key（关闭重开侧边栏后恢复未发送的附件）
// 参考 Monica：使用 localStorage 同步存取，简单可靠，避免 chrome.storage.local
// 异步时序、配额限制和 service worker 冷启动卡住的问题。
// localStorage 在扩展 origin（chrome-extension://<id>）下持久化，关闭重开 sidepanel/iframe 都能恢复。
const ATTACHMENTS_STORAGE_KEY = 'aiBrowser_sidepanelAttachments'

// 同步持久化当前未发送附件（parsing 中的 PDF 不持久化）
function persistAttachments() {
  const pdfToSave = attachedPdf && !attachedPdf.parsing ? attachedPdf : null
  const payload = {
    attachedImage: attachedImage || null,
    attachedPdf: pdfToSave,
  }
  try {
    localStorage.setItem(ATTACHMENTS_STORAGE_KEY, JSON.stringify(payload))
  } catch (e) {
    // 配额不足时降级：仅保存 PDF 文本（体积小），丢弃图片
    if (pdfToSave) {
      try {
        localStorage.setItem(ATTACHMENTS_STORAGE_KEY, JSON.stringify({
          attachedImage: null,
          attachedPdf: pdfToSave,
        }))
        console.warn('[ATTACH] 降级保存：仅 PDF（图片因配额超限被丢弃）')
      } catch (e2) {
        console.error('[ATTACH] 降级保存仍失败:', e2)
      }
    } else {
      console.error('[ATTACH] persistAttachments 失败:', e)
    }
  }
}

// 同步从 localStorage 恢复未发送附件
function loadAttachmentsFromStorage() {
  try {
    const raw = localStorage.getItem(ATTACHMENTS_STORAGE_KEY)
    if (!raw) {
      renderAttachmentPreview()
      return
    }
    const saved = JSON.parse(raw)
    attachedPdf = saved.attachedPdf || null
    attachedImage = saved.attachedImage || null
    console.log('[ATTACH] 恢复附件: image=%s pdf=%s',
      attachedImage ? `${attachedImage.length}字符` : '无',
      attachedPdf ? `${attachedPdf.name}(${attachedPdf.chars || 0}字符)` : '无')
    renderAttachmentPreview()
    const restored = []
    if (attachedPdf) restored.push(`PDF: ${attachedPdf.name}`)
    if (attachedImage) restored.push('图片')
    if (restored.length && typeof showUploadToast === 'function') {
      showUploadToast(`已恢复附件: ${restored.join('、')}`)
    }
  } catch (e) {
    console.error('[ATTACH] loadAttachmentsFromStorage 失败:', e)
  }
}

// ============ RPC 调用 ============
async function callService(service, method, ...args) {
  // 扩展被重载/更新后，sidepanel 的连接会失效
  if (!chrome.runtime?.id) {
    console.warn('[RPC] Extension context invalidated, cannot call', service, method)
    throw new Error('扩展上下文已失效，请关闭侧边栏后重新打开')
  }
  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG_TYPES.CALL_SERVICE,
      service, method, args,
    })
    if (res?.error) throw new Error(res.error)
    return res?.data
  } catch (e) {
    if (e.message?.includes('Extension context invalidated') || e.message?.includes('Could not establish connection')) {
      console.warn('[RPC] 扩展已重载，请重新打开侧边栏')
      throw new Error('扩展已重载，请关闭侧边栏后重新打开')
    }
    throw e
  }
}

// ============ 视图切换 ============
function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'))
  const target = document.getElementById(viewId)
  if (target) target.classList.add('active')

  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === viewId)
  })

  const tp = document.getElementById('toolboxPanel')
  if (tp) { tp.classList.remove('show'); tp.style.display = 'none' }
}

// 导航栏点击
document.querySelectorAll('.nav-item').forEach(btn => {
  if (btn.id === 'agentNavBtn') return  // Agent 按钮单独处理
  btn.addEventListener('click', () => showView(btn.dataset.view))
})

// Agent 导航栏按钮
document.getElementById('agentNavBtn').addEventListener('click', toggleAgentMode)

// 返回按钮
document.getElementById('backToChatBtn').addEventListener('click', () => showView('chatView'))
document.getElementById('backFromScriptsBtn').addEventListener('click', () => showView('chatView'))
document.getElementById('backFromDrawBtn').addEventListener('click', () => showView('chatView'))
document.getElementById('backFromVideoBtn').addEventListener('click', () => showView('chatView'))

// 新建对话（输入区按钮）
document.getElementById('newChatBtn').addEventListener('click', startNewChat)

// 总结页面
document.getElementById('summarizeFloatBtn').addEventListener('click', () => {
  sendMessage('总结当前页面内容')
})

// 智能工具箱
function openToolbox() {
  const panel = document.getElementById('toolboxPanel')
  panel.style.display = ''  // 清除内联样式，交给CSS类控制
  panel.classList.add('show')
}
function closeToolbox() {
  const panel = document.getElementById('toolboxPanel')
  panel.classList.remove('show')
  panel.style.display = 'none'
}
function toggleToolbox() {
  const panel = document.getElementById('toolboxPanel')
  if (panel.classList.contains('show')) {
    closeToolbox()
  } else {
    openToolbox()
  }
}

document.getElementById('toolboxFloatBtn').addEventListener('click', async () => {
  toggleToolbox()
  if (document.getElementById('toolboxPanel').classList.contains('show')) {
    await loadToolboxScripts()
  }
})

document.getElementById('toolboxCloseBtn').addEventListener('click', (e) => {
  e.preventDefault()
  e.stopPropagation()
  closeToolbox()
})

// ============ 左侧浮动工具按钮 ============

async function loadToolboxScripts() {
  const scripts = await callService('scriptService', 'getScripts')
  const container = document.getElementById('toolboxScripts')

  if (!scripts || scripts.length === 0) {
    container.innerHTML = '<div class="toolbox-empty">暂无脚本<br>请先在脚本管理中同步</div>'
    return
  }

  const enabledScripts = scripts.filter(s => s.enabled)
  if (enabledScripts.length === 0) {
    container.innerHTML = '<div class="toolbox-empty">暂无启用的脚本</div>'
    return
  }

  const icons = ['📊', '⚡', '🔧', '🎯', '💡', '📌', '🔍', '📝']
  container.innerHTML = enabledScripts.map((s, i) => `
    <div class="toolbox-script" data-id="${s.id}" data-name="${escapeHtml(s.name)}">
      <div class="toolbox-script-icon">${icons[i % icons.length]}</div>
      <div class="toolbox-script-info">
        <div class="toolbox-script-name">${escapeHtml(s.name)}</div>
        <div class="toolbox-script-desc">${escapeHtml(s.description || s.category || '脚本工具')}</div>
      </div>
    </div>
  `).join('')

  // 点击直接注入
  container.querySelectorAll('.toolbox-script').forEach(row => {
    row.addEventListener('click', () => {
      const scriptId = parseInt(row.dataset.id)
      closeToolbox()
      callService('pageService', 'injectToolboxScript', scriptId).catch(e => {
        console.warn('[工具箱] 注入异常:', e.message)
      })
    })
  })
}

// ============ JS注入功能 ============

// 关闭JS注入面板
document.getElementById('jsInjectorCloseBtn').addEventListener('click', () => {
  document.getElementById('jsInjectorPanel').classList.remove('show')
})

// 快捷键 Ctrl+Enter 执行注入
document.getElementById('jsCodeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    executeJSInjection()
  }
})

// 注入执行按钮
document.getElementById('jsInjectRunBtn').addEventListener('click', executeJSInjection)

async function executeJSInjection() {
  const code = document.getElementById('jsCodeInput').value.trim()
  const resultEl = document.getElementById('jsInjectorResult')
  
  if (!code) {
    resultEl.textContent = '请输入 JavaScript 代码'
    resultEl.className = 'js-injector-result error show'
    return
  }

  resultEl.textContent = '正在注入...'
  resultEl.className = 'js-injector-result show'

  try {
    const res = await callService('pageService', 'executeScript', code)
    if (res && res.ok) {
      const output = res.result !== undefined ? JSON.stringify(res.result, null, 2) : '执行成功（无返回值）'
      resultEl.textContent = '✅ ' + output
      resultEl.className = 'js-injector-result show'
    } else {
      resultEl.textContent = '❌ ' + (res?.error || '执行失败')
      resultEl.className = 'js-injector-result error show'
    }
  } catch (e) {
    resultEl.textContent = '❌ ' + e.message
    resultEl.className = 'js-injector-result error show'
  }
}

// ============ 聊天功能 ============
const chatMessages = document.getElementById('chatMessages')
const chatInput = document.getElementById('chatInput')
const sendBtn = document.getElementById('sendBtn')

// ===== Debug Log 面板 =====
let _debugLogWindow = null
let _debugLogReady = false     // 外部窗口就绪标志
let _debugLogQueue = []        // 就绪前的消息队列
let _debugLogFlushTimer = null // 定时刷新队列

function appendDebugLog(label, detail, level) {
  // 转发到外部 Log 窗口
  if (_debugLogWindow && !_debugLogWindow.closed) {
    const msg = { type: 'agentDebug', label, detail }
    if (_debugLogReady) {
      try { _debugLogWindow.postMessage(msg, '*') } catch {}
    } else {
      _debugLogQueue.push(msg)
      // 每 500ms 重试发送（等待窗口加载完成）
      if (!_debugLogFlushTimer) {
        _debugLogFlushTimer = setInterval(() => {
          if (_debugLogReady && _debugLogQueue.length > 0) {
            for (const m of _debugLogQueue) {
              try { _debugLogWindow.postMessage(m, '*') } catch {}
            }
            _debugLogQueue = []
            clearInterval(_debugLogFlushTimer)
            _debugLogFlushTimer = null
          }
        }, 500)
      }
    }
  }
}
// 打开外部 Log 窗口
function openDebugLogWindow() {
  // 仅调试模式开启时才弹出
  const debugToggle = document.getElementById('agentDebugToggle')
  if (!debugToggle || !debugToggle.classList.contains('on')) return
  if (_debugLogWindow && !_debugLogWindow.closed) {
    _debugLogWindow.focus()
    return
  }
  _debugLogReady = false
  _debugLogQueue = []
  _debugLogWindow = window.open(
    chrome.runtime.getURL('sidepanel/debug-log-viewer.html'),
    'debugLogPopup',
    'width=800,height=700,left=100,top=50,menubar=no,toolbar=no,location=no,status=no'
  )
}

// 转发 agentTodoUpdate 消息到 content script（注入到页面的待办面板）
async function forwardTodoUpdate(data) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id) {
      chrome.runtime.sendMessage({
        type: 'todoUpdate',
        tabId: tab.id,
        data: data
      }).catch(() => {})
    }
  } catch (e) {
    console.warn('[Sidepanel] forwardTodoUpdate failed:', e)
  }
}

// 接收外部窗口的就绪信号
window.addEventListener('message', (e) => {
  if (e.data?.type === 'debugLogReady') {
    _debugLogReady = true
    // 立即刷新队列
    if (_debugLogQueue.length > 0) {
      for (const m of _debugLogQueue) {
        try { _debugLogWindow.postMessage(m, '*') } catch {}
      }
      _debugLogQueue = []
    }
    if (_debugLogFlushTimer) {
      clearInterval(_debugLogFlushTimer)
      _debugLogFlushTimer = null
    }
  }
})


function renderMarkdown(text) {
  if (!text) return ''

  // 转义 HTML，防止 XSS
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // 代码块 ```lang\ncode\n```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code class="lang-${lang || 'plaintext'}">${code.trim()}</code></pre>`
  )

  // 行内代码 `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  // 粗体 **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

  // 标题
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>')
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')

  // 链接 [text](url) — 过滤 javascript: 等危险协议防 XSS
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const safeUrl = url.trim().toLowerCase()
    if (safeUrl.startsWith('javascript:') || safeUrl.startsWith('data:') || safeUrl.startsWith('vbscript:')) {
      return text
    }
    return `<a href="${url}" target="_blank" rel="noopener">${text}</a>`
  })

  // 无序列表（合并连续的 <li>）
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>')
  html = html.replace(/((?:<li>.*?<\/li>\s*)+)/g, '<ul>$1</ul>')

  // 有序列表
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>')

  // 水平线
  html = html.replace(/^---$/gm, '<hr>')

  // 段落：双换行分隔
  const paras = html.split(/\n\n+/)
  html = paras.map(p => {
    p = p.trim()
    if (!p) return ''
    // 已经是块级元素的不再包 <p>
    if (/^<(h[1-4]|pre|ul|ol|hr|li|blockquote)/.test(p)) return p
    return `<p>${p.replace(/\n/g, '<br>')}</p>`
  }).join('\n')

  return html
}

function addMessage(role, content, attachments) {
  const welcome = chatMessages.querySelector('.welcome')
  if (welcome) welcome.remove()

  const isUser = role === 'user'
  const div = document.createElement('div')
  div.className = `message ${isUser ? 'user-msg' : 'ai-msg'}`

  const userAvatarSVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
  const aiAvatarSVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="16" r="2"/><path d="M12 11V5"/><path d="M8 5L4 2"/><path d="M16 5l4-3"/><circle cx="4" cy="2" r="1"/><circle cx="20" cy="2" r="1"/></svg>'

  // 构建气泡内容：用户消息且存在附件时，在文本前渲染缩略图/PDF 标签
  let bubbleContent
  if (isUser && attachments && (attachments.image || (attachments.pdf && attachments.pdf.name))) {
    const items = []
    if (attachments.image) {
      items.push(`<div class="attachment-item" title="点击放大预览"><img src="${attachments.image}" alt="附件图片"></div>`)
    }
    if (attachments.pdf && attachments.pdf.name) {
      const pid = ++pdfPreviewIdCounter
      pdfPreviewRegistry.set(String(pid), attachments.pdf)
      const pages = attachments.pdf.pages
      const pagesInfo = pages ? ` · ${Array.isArray(pages) ? pages.length : pages}页` : ''
      items.push(`<div class="attachment-item pdf" data-pdf-preview-id="${pid}" title="点击预览 PDF 内容"><span class="pdf-icon">📄</span><span class="pdf-name">${escapeHtml(attachments.pdf.name)}${pagesInfo}</span></div>`)
    }
    bubbleContent = `<div class="msg-attachments">${items.join('')}</div><div class="msg-text">${escapeHtml(content)}</div>`
  } else {
    bubbleContent = isUser ? escapeHtml(content) : renderMarkdown(content)
  }

  div.innerHTML = `
    <div class="msg-avatar">${isUser ? userAvatarSVG : aiAvatarSVG}</div>
    <div class="msg-body">
      <div class="msg-name">${isUser ? '你' : 'AI Assistant'}</div>
      <div class="msg-bubble${isUser ? '' : ' msg-markdown'}">${bubbleContent}</div>
    </div>
  `
  chatMessages.appendChild(div)
  chatMessages.scrollTop = chatMessages.scrollHeight
  return div
}

function addStreamingMessage() {
  const welcome = chatMessages.querySelector('.welcome')
  if (welcome) welcome.remove()

  const aiAvatarSVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="16" r="2"/><path d="M12 11V5"/><path d="M8 5L4 2"/><path d="M16 5l4-3"/><circle cx="4" cy="2" r="1"/><circle cx="20" cy="2" r="1"/></svg>'

  const div = document.createElement('div')
  div.className = 'message ai-msg'
  div.innerHTML = `
    <div class="msg-avatar">${aiAvatarSVG}</div>
    <div class="msg-body">
      <div class="msg-name">AI Assistant</div>
      <div class="msg-bubble msg-markdown"><span class="typing-indicator"><span></span><span></span><span></span></span></div>
    </div>
  `
  chatMessages.appendChild(div)
  chatMessages.scrollTop = chatMessages.scrollHeight
  return div
}

function updateStreamingMessage(div, content) {
  const bubble = div.querySelector('.msg-bubble')
  bubble.innerHTML = renderMarkdown(content)
  chatMessages.scrollTop = chatMessages.scrollHeight
}

function escapeHtml(str) {
  const d = document.createElement('div')
  d.textContent = str
  return d.innerHTML
}

async function sendMessage(text) {
  if (!text.trim() || isStreaming) return

  // 检测是否需要页面内容
  const pageKeywords = ['总结', '翻译', '提取', '分析', '页面', '当前', '网页', '本文', '这篇文章']
  const needPageContent = pageKeywords.some(kw => text.includes(kw))

  let pageContext = ''
  if (needPageContent) {
    try {
      const pageData = await callService('pageService', 'getContent')
      if (pageData && pageData.content) {
        pageContext = `\n\n--- 当前页面信息 ---\n标题：${pageData.title || ''}\nURL：${pageData.url || ''}\n${pageData.description ? '描述：' + pageData.description + '\n' : ''}正文内容：\n${pageData.content}\n--- 结束 ---`
      }
    } catch (e) {
      console.warn('获取页面内容失败:', e)
    }
  }

  // 在清空附件前，捕获快照用于在聊天记录里展示
  const sentImage = attachedImage
  const sentPdf = attachedPdf ? { ...attachedPdf } : null

  // 历史记录存 attachments（图片 base64 / PDF 元数据），关闭重开后能恢复显示
  // 参考 Monica：Monica 把图片上传 CDN 后在历史里存 URL；本项目暂用 base64 内联存储
  chatHistory.push({ role: 'user', content: text, attachments: { image: sentImage, pdf: sentPdf } })
  addMessage('user', text, { image: sentImage, pdf: sentPdf })
  // 立即持久化，防止导航导致未保存消息丢失
  callService('storageService', 'saveChatHistory', chatHistory)
  chatInput.value = ''
  chatInput.style.height = 'auto'
  sendBtn.classList.remove('active')

  isStreaming = true
  sendBtn.disabled = true

  if (agentMode) {
    await runAgent(text, pageContext)
    return
  }

  // 普通流式模式 — 发送时把页面内容拼到末条消息
  const streamDiv = addStreamingMessage()
  let fullContent = ''

  try {
    // 构建发送给 AI 的消息列表：处理页面上下文、PDF 文本与附加图片
    let lastUserContent = text + (pageContext || '')
    // 若已附加 PDF，把解析出的文本拼到用户问题之前
    if (attachedPdf && attachedPdf.text) {
      const pagesInfo = attachedPdf.pages ? `（共 ${Array.isArray(attachedPdf.pages) ? attachedPdf.pages.length : attachedPdf.pages} 页）` : ''
      lastUserContent = `【PDF 文档：${attachedPdf.name}${pagesInfo}】\n${attachedPdf.text}\n\n【以上为 PDF 内容，请据此回答以下问题】\n${lastUserContent}`
    }
    let messagesForAI
    if (attachedImage) {
      // AI 服务端在公网，无法访问本地 admin-server 的图片 URL，需转 base64 data URL
      // 聊天历史仍存 URL（体积小），仅发送给 AI 时临时转换
      let imageUrlForAI = attachedImage
      if (attachedImage.startsWith('http')) {
        try {
          const resp = await fetch(attachedImage)
          const blob = await resp.blob()
          imageUrlForAI = await new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result)
            reader.onerror = reject
            reader.readAsDataURL(blob)
          })
        } catch (e) {
          console.warn('[SidePanel] 图片转 base64 失败，使用原 URL:', e.message)
        }
      }
      // OpenAI vision 格式：content 为数组，包含文本和图片
      messagesForAI = [...chatHistory.slice(0, -1), {
        role: 'user',
        content: [
          { type: 'text', text: lastUserContent },
          { type: 'image_url', image_url: { url: imageUrlForAI } },
        ],
      }]
      attachedImage = null
      attachedPdf = null
      renderAttachmentPreview()
    } else if (attachedPdf) {
      // 仅 PDF 无图片：用纯文本消息（已拼入 lastUserContent）
      messagesForAI = [...chatHistory.slice(0, -1), { role: 'user', content: lastUserContent }]
      attachedPdf = null
      renderAttachmentPreview()
    } else if (pageContext) {
      messagesForAI = [...chatHistory.slice(0, -1), { role: 'user', content: lastUserContent }]
    } else {
      messagesForAI = chatHistory
    }

    if (!chrome.runtime?.id) { finishStreaming('扩展已重载，请重新打开侧边栏'); return }
    currentPort = chrome.runtime.connect({ name: 'ai-stream' })
    currentPort.postMessage({
      type: 'streamStart',
      messages: messagesForAI,
      options: {},
    })

    currentPort.onMessage.addListener((msg) => {
      if (msg.type === 'streamChunk') {
        fullContent += msg.content
        updateStreamingMessage(streamDiv, fullContent)
      } else if (msg.type === 'streamDone') {
        // 检测拒绝类回复：如果是拒绝语，不存入历史，提示用户
        const isRefusal = /无法给到|无法提供|不能提供|无法回答|无法帮助|cannot provide/i.test(fullContent)
        if (isRefusal && chatHistory.filter(m => m.role === 'assistant').length === 0) {
          // 首次对话就拒绝，提示配置问题
          updateStreamingMessage(streamDiv, fullContent + '\n\n---\n> 收到拒绝回复，请检查 AI 配置（服务商/API地址/模型）是否正确。随后点击「新建对话」重试。')
          isStreaming = false
          sendBtn.disabled = false
          currentPort = null
          return
        }
        chatHistory.push({ role: 'assistant', content: fullContent })
        recentlyStreamedContent = fullContent
        setTimeout(() => { recentlyStreamedContent = '' }, 1000)
        callService('storageService', 'saveChatHistory', chatHistory)
        isStreaming = false
        sendBtn.disabled = false
        currentPort = null
      } else if (msg.type === 'streamError') {
        updateStreamingMessage(streamDiv, '❌ ' + msg.error)
        isStreaming = false
        sendBtn.disabled = false
        currentPort = null
      }
    })

    currentPort.onDisconnect.addListener(() => {
      console.log('[SidePanel] Agent port 断开')
      if (fullContent) recentlyStreamedContent = fullContent
      setTimeout(() => { recentlyStreamedContent = '' }, 1000)
      isStreaming = false
      sendBtn.disabled = false
      currentPort = null
    })
  } catch (e) {
    updateStreamingMessage(streamDiv, '❌ ' + e.message)
    isStreaming = false
    sendBtn.disabled = false
  }
}

// ============ Agent 自主决策模式 ============

function toggleAgentMode() {
  agentMode = !agentMode
  const btn = document.getElementById('agentNavBtn')
  if (btn) btn.classList.toggle('active', agentMode)
  // Agent模式不持久化，页面刷新后恢复为关闭状态
  if (!agentMode) {
    chrome.storage.local.remove('agentMode')
    // 关闭时重置流式状态，防止卡住的Agent阻塞后续发送
    if (isStreaming) {
      isStreaming = false
      sendBtn.disabled = false
      if (currentPort) {
        try { currentPort.disconnect() } catch {}
        currentPort = null
      }
    }
  } else if (currentModelInfo && !currentModelInfo.supportsTools) {
    // 当前模型不支持工具调用时给出提示
    addMessage('ai', '⚠️ 当前模型不支持工具调用，Agent 模式可能无法正常工作。建议在对话框上方切换到支持工具调用的模型（带“工具”标签）。')
  }
}

async function loadAgentMode() {
  agentMode = false
  const btn = document.getElementById('agentNavBtn')
  if (btn) btn.classList.remove('active')

  // 关闭后重连：检查 SW 中是否有正在运行的 Agent
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const resp = await chrome.runtime.sendMessage({ type: 'checkAgentStatus', tabId: tab?.id })
    if (resp?.agentRunning) {
      console.log('[SidePanel] 检测到运行中的 Agent，自动重连')
      agentMode = true
      if (btn) btn.classList.add('active')
      chrome.storage.local.set({ agentMode: true })

      currentPort = chrome.runtime.connect({ name: 'agent-stream' })

      // 先注册消息监听器，再发送 agentAttach（避免回放消息比监听器先到达）
      const card = addAgentStepCard()
      card.querySelector('.agent-step-title').textContent = 'Agent 重连中...'
      let streamDiv = null
      let fullContent = ''
      let toolResults = []
      currentPort.onMessage.addListener((msg) => {
        if (msg.type === 'agentTodoUpdate') { forwardTodoUpdate(msg.data); return }
        if (msg.type === 'agentStart') {
          card.querySelector('.agent-step-title').textContent = 'Agent 已启动，分析需求中...'
          openDebugLogWindow()
        } else if (msg.type === 'agentStatus') {
          card.querySelector('.agent-step-title').textContent = msg.text || '处理中...'
        } else if (msg.type === 'agentStep') {
          updateAgentStepCard(card, msg.step, msg.toolName, msg.toolArgs, msg.status || 'running')
        } else if (msg.type === 'agentSearchResult') {
          const results = msg.results || []
          const body = card.querySelector('.agent-step-body')
          body.innerHTML = results.length > 0
            ? '找到 ' + results.length + ' 个工具：<br>' + results.map(r => '  - ' + r.name + ': ' + (r.description || '')).join('<br>')
            : '未找到匹配的工具'
          chatMessages.scrollTop = chatMessages.scrollHeight
        } else if (msg.type === 'agentStepResult') {
          if (msg.toolName === 'search_tools') return
          const body = card.querySelector('.agent-step-body')
          let displayResult = summarizeToolResult(msg.toolName, msg.result || '')
          body.textContent = displayResult
          const title = card.querySelector('.agent-step-title')
          if (title) title.innerHTML = title.innerHTML.replace('\u23F3', '\u2705')
          chatMessages.scrollTop = chatMessages.scrollHeight
        } else if (msg.type === 'agentDebug') {
          const level = String(msg.label || '').includes('触发') ? 'warn' : String(msg.label || '').includes('终止') ? 'error' : 'info'
          appendDebugLog(msg.label || 'debug', msg.detail || '', level)
        } else if (msg.type === 'streamChunk') {
          if (!streamDiv) { streamDiv = addStreamingMessage(); fullContent = '' }
          fullContent += msg.content
          updateStreamingMessage(streamDiv, fullContent)
          chatMessages.scrollTop = chatMessages.scrollHeight
        } else if (msg.type === 'streamDone') {
          if (streamDiv) {
            agentMode = false
            if (btn) btn.classList.remove('active')
            chrome.storage.local.remove('agentMode')
          }
        } else if (msg.type === 'agentError') {
          card.querySelector('.agent-step-title').textContent = '错误'
          card.querySelector('.agent-step-body').textContent = msg.error
          agentMode = false
          if (btn) btn.classList.remove('active')
          chrome.storage.local.remove('agentMode')
        }
      })

      // 监听器已就位，现在发送 agentAttach（后台会回放缓冲消息）
      currentPort.postMessage({ type: 'agentAttach' })
    }
  } catch (e) {
    console.log('[SidePanel] Agent 状态查询失败（可能 SW 未就绪）')
  }
}

function addAgentStepCard() {
  const card = document.createElement('div')
  card.className = 'agent-step-card'
  card.innerHTML = `
    <div class="agent-step-header">
      <span class="agent-step-icon">&#x2699;</span>
      <span class="agent-step-title">Agent 工作中...</span>
    </div>
    <div class="agent-step-body"></div>
  `
  chatMessages.appendChild(card)
  chatMessages.scrollTop = chatMessages.scrollHeight
  return card
}

function formatToolArgs(toolName, toolArgs) {
  const a = toolArgs || {}
  switch (toolName) {
    case 'search_tools':
      return `搜索关键词：${a.query || ''}`
    case 'read_page_content':
      return '读取当前页面的标题和正文'
    case 'extract_content':
      return `提取元素：${a.selector || ''}${a.multiple ? '（提取所有）' : ''}${Array.isArray(a.attributes) && a.attributes.length ? ' [属性:' + a.attributes.join(',') + ']' : ''}`
    case 'click_element':
      return `点击元素：${a.selector || ''}`
    case 'fill_input':
      return `填写内容：${a.selector || ''} = "${a.value || ''}"${a.submit ? '（回车提交）' : ''}`
    case 'wait_for_element':
      return `等待元素出现：${a.selector || ''}`
    case 'save_as_file':
      return `保存为文件：${a.filename || ''}${a.mimeType ? ' (' + a.mimeType + ')' : ''}`
    case 'navigate_to':
      return `导航到：${a.url || ''}`
    case 'go_back':
      return '返回上一页'
    case 'finish_task':
      return a.summary || '任务完成'
    default:
      if (toolName.startsWith('inject_script_')) {
        return `执行脚本：${a.scriptName || '工具库脚本'}`
      }
      // 其他工具，用简洁的键值对展示
      const entries = Object.entries(a).filter(([_, v]) => v !== undefined && v !== '')
      return entries.length > 0 ? entries.map(([k, v]) => `${k}: ${v}`).join('，') : ''
  }
}

// 将工具执行结果转为可读摘要，避免显示原始JSON
function summarizeToolResult(toolName, rawResult) {
  let parsed = null
  try { parsed = JSON.parse(rawResult) } catch {}

  // 执行失败
  if (parsed && parsed.ok === false && parsed.error) {
    return '失败：' + parsed.error
  }

  // 按工具类型生成摘要
  switch (toolName) {
    case 'read_page_content':
      if (parsed?.title) return `已读取页面「${parsed.title}」(${(parsed.content || '').length}字)`
      return '已读取当前页面内容'
    case 'extract_content': {
      if (!parsed) return '提取完成'
      const items = parsed.result || parsed
      if (Array.isArray(items)) return `已提取 ${items.length} 条数据`
      if (typeof items === 'string') return items.length > 100 ? items.slice(0, 100) + '...' : items
      return '提取完成'
    }
    case 'get_interactive_elements':
      if (Array.isArray(parsed)) return `发现 ${parsed.length} 个可交互元素`
      return '已获取可交互元素'
    case 'get_element_info':
      return '已获取元素详细信息'
    case 'click_element':
      return '已点击目标元素'
    case 'fill_input':
      return '已填写输入框'
    case 'navigate_to':
      if (parsed?.url) return `已导航到 ${parsed.url}`
      return '页面导航完成'
    case 'go_back':
      return '已返回上一页'
    case 'go_forward':
      return '已前进到下一页'
    case 'scroll_page':
      return '已滚动页面'
    case 'hover_element':
      return '已悬停目标元素'
    case 'select_dropdown':
      return '已选择下拉选项'
    case 'press_key':
      return '已执行按键操作'
    case 'find_text_on_page':
      if (parsed?.count !== undefined) return `找到 ${parsed.count} 处匹配`
      return '文本搜索完成'
    case 'wait_for_element':
      return '目标元素已出现'
    case 'recall_data':
      if (parsed) {
        if (Array.isArray(parsed)) return `查询到 ${parsed.length} 条记录`
        if (typeof parsed === 'string') return parsed.length > 100 ? parsed.slice(0, 100) + '...' : parsed
        if (parsed.result) {
          if (Array.isArray(parsed.result)) return `查询到 ${parsed.result.length} 条记录`
          if (typeof parsed.result === 'string') return parsed.result.length > 100 ? parsed.result.slice(0, 100) + '...' : parsed.result
        }
      }
      return '已查询存储数据'
    case 'create_todo':
      if (parsed?.ok && parsed.totalTodos) return `已创建待办列表（${parsed.totalTodos}个待办）`
      if (parsed?.errors) return '待办创建失败：' + parsed.errors.slice(0, 2).join('；')
      return '待办列表操作完成'
    case 'screenshot_visible':
      return '已截取当前页面'
    case 'finish_task':
      return parsed || '任务完成'
    default:
      if (toolName.startsWith('inject_script_')) {
        if (parsed) {
          if (parsed.ok === false) return '脚本执行失败：' + (parsed.error || '未知错误')
          if (Array.isArray(parsed)) return `脚本执行完成，返回 ${parsed.length} 条结果`
          if (parsed.result) {
            if (Array.isArray(parsed.result)) return `脚本执行完成，处理了 ${parsed.result.length} 条数据`
            if (typeof parsed.result === 'string') return parsed.result.length > 100 ? parsed.result.slice(0, 100) + '...' : parsed.result
          }
          if (parsed.count !== undefined) return `脚本执行完成，处理了 ${parsed.count} 条`
        }
        return '脚本执行完成'
      }
      // 兜底：尝试简短展示
      if (typeof rawResult === 'string' && rawResult.length > 150) return rawResult.slice(0, 150) + '...'
      return rawResult || '执行完成'
  }
}

// 工具元数据：统一管理名称和图标
const TOOL_META = {
  search_tools:    { name: '搜索工具', icon: '\uD83D\uDD0D' },
  read_page_content: { name: '读取页面', icon: '\u26A1' },
  click_element:   { name: '点击元素', icon: '\u26A1' },
  fill_input:      { name: '填写输入', icon: '\u26A1' },
  wait_for_element:{ name: '等待加载', icon: '\u26A1' },
  finish_task:     { name: '任务完成', icon: '\u2705' },
}

function updateAgentStepCard(card, step, toolName, toolArgs, status) {
  const meta = TOOL_META[toolName]
  let icon = meta?.icon || '\u26A1'
  let displayName = meta?.name || '执行工具'
  if (toolName.startsWith('inject_script_')) {
    icon = '\uD83D\uDE80'
    displayName = toolArgs?.scriptName || '执行脚本'
  }

  const statusIcon = status === 'running' ? '\u23F3' : status === 'searching' ? '\uD83D\uDD0D' : ''

  card.querySelector('.agent-step-icon').textContent = icon
  card.querySelector('.agent-step-title').innerHTML = statusIcon + ' 步骤' + step + ': ' + displayName
  card.querySelector('.agent-step-body').textContent = formatToolArgs(toolName, toolArgs)
  chatMessages.scrollTop = chatMessages.scrollHeight
}

async function runAgent(userText, pageContext) {
  agentStepCards = []
  const card = addAgentStepCard()

  const streamDiv = addStreamingMessage()
  let fullContent = ''
  const toolResults = [] // 收集工具执行结果，streamDone时一并存入历史

  try {
    if (!chrome.runtime?.id) { finishStreaming('扩展已重载，请重新打开侧边栏'); return }
    currentPort = chrome.runtime.connect({ name: 'agent-stream' })

    // 先注册消息监听器，再发送 agentStart（避免响应比监听器先到达）
    currentPort.onMessage.addListener((msg) => {
      if (msg.type === 'agentTodoUpdate') { forwardTodoUpdate(msg.data); return }
      if (msg.type === 'agentStart') {
        card.querySelector('.agent-step-title').textContent = 'Agent 已启动，分析需求中...'
        openDebugLogWindow()
      } else if (msg.type === 'agentStatus') {
        card.querySelector('.agent-step-title').textContent = msg.text || '处理中...'
      } else if (msg.type === 'agentStep') {
        updateAgentStepCard(card, msg.step, msg.toolName, msg.toolArgs, msg.status || 'running')
      } else if (msg.type === 'agentSearchResult') {
        const results = msg.results || []
        const body = card.querySelector('.agent-step-body')
        body.innerHTML = results.length > 0
          ? '找到 ' + results.length + ' 个工具：<br>' + results.map(r => '  - ' + r.name + ': ' + (r.description || '')).join('<br>')
          : '未找到匹配的工具'
        chatMessages.scrollTop = chatMessages.scrollHeight
      } else if (msg.type === 'agentStepResult') {
        if (msg.toolName === 'search_tools') return
        const body = card.querySelector('.agent-step-body')
        let displayResult = summarizeToolResult(msg.toolName, msg.result || '')
        body.textContent = displayResult
        const title = card.querySelector('.agent-step-title')
        if (title) title.innerHTML = title.innerHTML.replace('\u23F3', '\u2705')
        chatMessages.scrollTop = chatMessages.scrollHeight

        if (msg.toolName && msg.toolName !== 'finish_task') {
          toolResults.push({ name: msg.toolName, result: displayResult })
        }

        if (msg.done) {
          card.querySelector('.agent-step-icon').textContent = '\u2705'
          card.querySelector('.agent-step-title').textContent = '任务完成'
        }
      } else if (msg.type === 'agentDebug') {
        const level = String(msg.label || '').includes('触发') ? 'warn' : String(msg.label || '').includes('终止') ? 'error' : 'info'
        appendDebugLog(msg.label || 'debug', msg.detail || '', level)
      } else if (msg.type === 'streamChunk') {
        fullContent += msg.content
        updateStreamingMessage(streamDiv, fullContent)
      } else if (msg.type === 'streamDone') {
        const agentRecord = { role: 'assistant', content: fullContent }
        if (toolResults.length > 0) {
          agentRecord.toolCalls = toolResults.map(t => ({ name: t.name, summary: String(t.result).slice(0, 200) }))
        }
        chatHistory.push(agentRecord)
        recentlyStreamedContent = fullContent
        setTimeout(() => { recentlyStreamedContent = '' }, 1000)
        isStreaming = false
        sendBtn.disabled = false
        currentPort = null
      } else if (msg.type === 'agentError') {
        updateStreamingMessage(streamDiv, '\u274C ' + msg.error)
        card.querySelector('.agent-step-icon').textContent = '\u274C'
        card.querySelector('.agent-step-title').textContent = 'Agent 异常: ' + msg.error
        isStreaming = false
        sendBtn.disabled = false
        currentPort = null
      }
    })

    currentPort.onDisconnect.addListener(() => {
      console.log('[SidePanel] Agent port 断开')
      isStreaming = false
      sendBtn.disabled = false
      currentPort = null
    })

    // Agent 模式 PDF 附件处理
    let agentUserMessage = pageContext ? userText + pageContext : userText
    if (attachedPdf && attachedPdf.text) {
      const pagesInfo = attachedPdf.pages ? `（共 ${Array.isArray(attachedPdf.pages) ? attachedPdf.pages.length : attachedPdf.pages} 页）` : ''
      agentUserMessage = `【PDF 文档：${attachedPdf.name}${pagesInfo}】\n${attachedPdf.text}\n\n【以上为 PDF 内容，请据此回答以下问题】\n${agentUserMessage}`
    }
    // 发送后清除附件（包括图片和 PDF）
    if (attachedPdf || attachedImage) {
      attachedPdf = null
      attachedImage = null
      renderAttachmentPreview()
    }

    // 监听器已就位，现在发送 agentStart
    currentPort.postMessage({
      type: 'agentStart',
      userMessage: agentUserMessage,
      chatHistory,
    })
  } catch (e) {
    updateStreamingMessage(streamDiv, '\u274C ' + e.message)
    isStreaming = false
    sendBtn.disabled = false
  }
}

// 发送按钮
sendBtn.addEventListener('click', () => sendMessage(chatInput.value))
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage(chatInput.value)
  }
})

// 自动调整高度 + 发送按钮状态
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto'
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px'
  sendBtn.classList.toggle('active', chatInput.value.trim().length > 0)
})

// 快捷操作
document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => sendMessage(btn.dataset.prompt))
})

// 新对话
function startNewChat() {
  chatHistory = []
  callService('storageService', 'clearChatHistory')
  chatMessages.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="url(#grad1)" stroke-width="1.5"><defs><linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#b059f8"/><stop offset="100%" style="stop-color:#6841ea"/></linearGradient></defs><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
      </div>
      <div class="welcome-title">欢迎使用 AI Browser</div>
      <div class="welcome-desc">智能分析网页、高效对话、一键工具</div>
      <div class="quick-actions">
        <button class="quick-btn" data-prompt="总结当前页面内容">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span>总结页面</span>
        </button>
        <button class="quick-btn" data-prompt="翻译当前页面为中文">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
          <span>翻译页面</span>
        </button>
        <button class="quick-btn" data-prompt="提取当前页面的关键信息">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>
          <span>提取信息</span>
        </button>
        <button class="quick-btn" data-prompt="分析当前页面的代码结构">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
          <span>代码分析</span>
        </button>
      </div>
    </div>
  `
  document.querySelectorAll('.quick-btn').forEach(b => {
    b.addEventListener('click', () => sendMessage(b.dataset.prompt))
  })
}

// ============ 设置 ============
async function loadSettings() {
  const aiConfig = await callService('configService', 'getAIConfig')
  const syncConfig = await callService('configService', 'getSyncConfig')
  const selectionEnabled = await callService('configService', 'getSelectionToolsEnabled')
  const agentConfig = await callService('configService', 'getAgentConfig')

  // 服务端连接
  document.getElementById('syncServerUrl').value = syncConfig.serverUrl || ''
  document.getElementById('syncAppKey').value = syncConfig.appKey || ''
  document.getElementById('syncAppSecret').value = syncConfig.appSecret || ''

  // AI 模型配置
  document.getElementById('aiSystemPrompt').value = aiConfig.systemPrompt || ''
  document.getElementById('aiTemperature').value = aiConfig.temperature ?? 0.7
  document.getElementById('tempValue').textContent = aiConfig.temperature ?? 0.7
  document.getElementById('aiMaxTokens').value = aiConfig.maxTokens || 4096

  const toggle = document.getElementById('selectionToolsToggle')
  toggle.classList.toggle('on', selectionEnabled !== false)

  // Agent 配置
  const agentRounds = agentConfig.maxRounds || 15
  document.getElementById('agentMaxRounds').value = agentRounds
  document.getElementById('agentRoundsValue').textContent = agentRounds
  // 调试模式
  const debugToggle = document.getElementById('agentDebugToggle')
  if (debugToggle) {
    debugToggle.classList.toggle('on', agentConfig.debug === true)
    debugToggle.onclick = () => debugToggle.classList.toggle('on')
  }
}

/**
 * 从服务端拉取模型列表，填充对话框中的模型下拉面板
 * @param {string} [selectedModel] 指定选中模型（来自配置），未传时保留当前选中
 */
async function loadModelSelect(selectedModel) {
  const content = document.getElementById('modelDropdownContent')
  const pillName = document.getElementById('modelPillName')
  if (!content) return
  content.innerHTML = '<div class="model-dropdown-empty">加载中...</div>'
  pillName.textContent = '加载中'

  // 先校验 appKey/appSecret 是否已配置，未配置时直接给出可操作的提示
  let syncConfig
  try {
    syncConfig = await callService('configService', 'getSyncConfig')
  } catch (_) {
    syncConfig = {}
  }
  if (!syncConfig.appKey || !syncConfig.appSecret) {
    content.innerHTML =
      '<div class="model-dropdown-empty">未配置 AppKey/AppSecret<br>请前往「设置 → 服务端连接」填写并保存后重试</div>'
    pillName.textContent = '未配置'
    currentModelInfo = null
    const uploadBtn = document.getElementById('uploadBtn')
    if (uploadBtn) uploadBtn.style.display = ''
    return
  }

  try {
    const data = await callService('configService', 'getAvailableModels')
    content.innerHTML = ''

    const providers = (data && data.providers) || []
    const models = (data && data.models) || []
    if (providers.length === 0 || models.length === 0) {
      content.innerHTML = '<div class="model-dropdown-empty">暂无可用模型</div>'
      return
    }

    // 服务端返回的是扁平 models 数组（含 provider_id 外键），需按 provider_id 分组
    const modelsByProvider = new Map()
    for (const m of models) {
      const pid = m.provider_id
      if (!modelsByProvider.has(pid)) modelsByProvider.set(pid, [])
      modelsByProvider.get(pid).push(m)
    }

    // 解析选中模型 ID：优先使用传入值，其次沿用内部状态，最后取第一个
    let targetId = selectedModel || currentSelectedModelId
    let firstModelId = null
    for (const provider of providers) {
      const providerModels = modelsByProvider.get(provider.id) || []
      if (providerModels.length === 0) continue  // 该供应商下无可用模型，跳过分组标题
      const groupLabel = document.createElement('div')
      groupLabel.className = 'model-group-label'
      groupLabel.textContent = provider.display_name || provider.name || ''
      content.appendChild(groupLabel)

      for (const model of providerModels) {
        if (!firstModelId) firstModelId = model.model_id
        const item = document.createElement('div')
        item.className = 'model-item'
        item.dataset.modelId = model.model_id
        item.dataset.provider = provider.name || ''
        item.dataset.supportsVision = String(model.supports_vision)
        item.dataset.supportsTools = String(model.supports_tools)
        item.dataset.displayName = model.display_name || model.model_id

        const nameEl = document.createElement('span')
        nameEl.className = 'model-item-name'
        nameEl.textContent = model.display_name || model.model_id
        item.appendChild(nameEl)

        const tagsEl = document.createElement('div')
        tagsEl.className = 'model-item-tags'
        if (String(model.supports_vision) === '1') {
          const tag = document.createElement('span')
          tag.className = 'model-tag vision'
          tag.textContent = '图片'
          tagsEl.appendChild(tag)
        }
        if (String(model.supports_tools) === '1') {
          const tag = document.createElement('span')
          tag.className = 'model-tag'
          tag.textContent = '工具'
          tagsEl.appendChild(tag)
        }
        item.appendChild(tagsEl)

        const check = document.createElement('span')
        check.className = 'model-item-check'
        check.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>'
        item.appendChild(check)

        item.addEventListener('click', () => selectModel(model.model_id))
        content.appendChild(item)
      }
    }

    if (!firstModelId) {
      content.innerHTML = '<div class="model-dropdown-empty">暂无可用模型</div>'
      return
    }

    if (!targetId && firstModelId) targetId = firstModelId
    // 应用选中状态（不触发保存，仅同步 UI）
    applySelectedModel(targetId)
  } catch (e) {
    const msg = String(e.message || '')
    let hint = '加载失败：' + escapeHtml(msg)
    if (msg.includes('401') || msg.includes('认证') || msg.includes('sign')) {
      hint = '认证失败：AppKey/AppSecret 无效或已过期<br>请前往「设置 → 服务端连接」重新配置'
    }
    content.innerHTML = `<div class="model-dropdown-empty">${hint}</div>`
    pillName.textContent = '模型'
    currentModelInfo = null
    // 加载失败时默认显示上传按钮（无法判断能力）
    const uploadBtn = document.getElementById('uploadBtn')
    if (uploadBtn) uploadBtn.style.display = ''
  }
}

/**
 * 根据当前选中的模型更新 pill 文案、能力信息及 UI 可见性
 */
function updateModelInfo() {
  const content = document.getElementById('modelDropdownContent')
  const pillName = document.getElementById('modelPillName')
  const selectedItem = content && content.querySelector('.model-item.selected')
  if (!selectedItem) {
    currentModelInfo = null
    if (pillName) pillName.textContent = '选择模型'
    return
  }

  const supportsVision = String(selectedItem.dataset.supportsVision) === '1'
  const supportsTools = String(selectedItem.dataset.supportsTools) === '1'
  currentModelInfo = {
    modelId: selectedItem.dataset.modelId,
    provider: selectedItem.dataset.provider,
    supportsVision,
    supportsTools,
  }
  if (pillName) pillName.textContent = selectedItem.dataset.displayName || currentModelInfo.modelId

  // 上传按钮始终可见（PDF 任何模型都可处理）；仅图片需要视觉模型
  const uploadBtn = document.getElementById('uploadBtn')
  if (uploadBtn) {
    uploadBtn.style.display = ''
    if (!supportsVision && attachedImage) {
      attachedImage = null
      renderAttachmentPreview()
    }
  }
}

/**
 * 应用选中状态到下拉列表 UI（不保存配置），并刷新能力信息
 */
function applySelectedModel(modelId) {
  const content = document.getElementById('modelDropdownContent')
  if (!content) return
  let matched = null
  content.querySelectorAll('.model-item').forEach(el => {
    const isSel = el.dataset.modelId === modelId
    el.classList.toggle('selected', isSel)
    if (isSel) matched = el
  })
  if (matched) {
    currentSelectedModelId = modelId
  }
  updateModelInfo()
}

/**
 * 切换模型：更新 UI 并立即保存到配置
 */
async function selectModel(modelId) {
  applySelectedModel(modelId)
  closeModelDropdown()
  try {
    await callService('configService', 'saveAIConfig', { model: modelId })
  } catch (e) {
    console.error('保存模型失败:', e)
  }
}

// ============ 模型下拉面板开关 ============
function openModelDropdown() {
  document.getElementById('modelDropdownPanel').classList.add('show')
  document.getElementById('modelPillBtn').classList.add('open')
}
function closeModelDropdown() {
  document.getElementById('modelDropdownPanel').classList.remove('show')
  document.getElementById('modelPillBtn').classList.remove('open')
}
function toggleModelDropdown() {
  const isOpen = document.getElementById('modelDropdownPanel').classList.contains('show')
  if (isOpen) closeModelDropdown()
  else openModelDropdown()
}

// temperature 滑条实时显示值
document.getElementById('aiTemperature').addEventListener('input', function() {
  document.getElementById('tempValue').textContent = this.value
})

// Agent 轮次滑条实时显示值
document.getElementById('agentMaxRounds').addEventListener('input', function() {
  document.getElementById('agentRoundsValue').textContent = this.value
})

document.getElementById('selectionToolsToggle').addEventListener('click', function() {
  this.classList.toggle('on')
})

// 模型 pill 按钮：切换下拉面板
document.getElementById('modelPillBtn').addEventListener('click', (e) => {
  e.stopPropagation()
  toggleModelDropdown()
})
document.getElementById('modelDropdownCloseBtn').addEventListener('click', () => closeModelDropdown())
// 点击面板外部关闭
document.addEventListener('click', (e) => {
  const panel = document.getElementById('modelDropdownPanel')
  if (!panel.classList.contains('show')) return
  if (panel.contains(e.target) || e.target.id === 'modelPillBtn') return
  closeModelDropdown()
})

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  try {
    await callService('configService', 'saveAIConfig', {
      systemPrompt: document.getElementById('aiSystemPrompt').value.trim(),
      temperature: parseFloat(document.getElementById('aiTemperature').value) || 0.7,
      maxTokens: parseInt(document.getElementById('aiMaxTokens').value) || 4096,
    })
    // 保留 syncInterval（UI 中已移除该字段，从旧配置继承）
    const oldSync = await callService('configService', 'getSyncConfig')
    await callService('configService', 'saveSyncConfig', {
      serverUrl: document.getElementById('syncServerUrl').value.trim(),
      appKey: document.getElementById('syncAppKey').value.trim(),
      appSecret: document.getElementById('syncAppSecret').value.trim(),
      syncInterval: oldSync.syncInterval || 30,
      enabled: true,
    })
    await callService('configService', 'saveSelectionToolsEnabled',
      document.getElementById('selectionToolsToggle').classList.contains('on'))
    await callService('configService', 'saveAgentConfig', {
      maxRounds: parseInt(document.getElementById('agentMaxRounds').value) || 30,
      debug: document.getElementById('agentDebugToggle').classList.contains('on'),
    })

    // 保存后刷新模型列表（用户可能刚填好 appKey/appSecret）
    await loadModelSelect(currentSelectedModelId)

    showView('chatView')
  } catch (e) {
    alert('保存失败: ' + e.message)
  }
})

// ============ 测试连接 ============
document.getElementById('testConnectionBtn').addEventListener('click', async () => {
  const status = document.getElementById('connectionStatus')
  const serverUrl = document.getElementById('syncServerUrl').value.trim()
  const appKey = document.getElementById('syncAppKey').value.trim()
  const appSecret = document.getElementById('syncAppSecret').value.trim()

  if (!serverUrl || !appKey || !appSecret) {
    status.textContent = '请填写完整的服务端地址、AppKey 和 AppSecret'
    status.style.color = '#e74c3c'
    return
  }

  status.textContent = '正在测试连接...'
  status.style.color = ''

  try {
    const headers = await callService('configService', 'generateAuthHeaders', appKey, appSecret)
    const url = serverUrl.replace(/\/+$/, '') + '/api/ai-models/available'
    const res = await fetch(url, { method: 'GET', headers })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`${res.status} ${text.slice(0, 100)}`)
    }
    const json = await res.json()
    if (!json.success) {
      throw new Error(json.error || json.message || '返回格式异常')
    }
    status.textContent = '✓ 连接成功'
    status.style.color = '#27ae60'
    // 连接成功后顺便刷新模型列表（沿用当前选中）
    await loadModelSelect(currentSelectedModelId)
  } catch (e) {
    status.textContent = '✗ 连接失败：' + e.message
    status.style.color = '#e74c3c'
  }
})

// ============ 文件上传（图片/PDF） ============
const fileInput = document.createElement('input')
fileInput.type = 'file'
fileInput.accept = 'image/*,.pdf'
fileInput.style.display = 'none'
document.body.appendChild(fileInput)

document.getElementById('uploadBtn').addEventListener('click', () => {
  fileInput.click()
})

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0]
  if (!file) return

  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    // PDF：直接用 File 对象上传到服务端解析为纯文本（不经过 chrome.runtime.sendMessage 传 ArrayBuffer，避免内容丢失）
    attachedPdf = { name: file.name, text: '', parsing: true }
    renderAttachmentPreview()
    try {
      const { url, headers } = await callService('configService', 'getPdfUploadConfig')
      const formData = new FormData()
      formData.append('file', file, file.name)
      const res = await fetch(url, { method: 'POST', headers, body: formData })
      const text = await res.text()
      let json
      try { json = JSON.parse(text) } catch (_) {
        throw new Error(`PDF 解析响应解析失败: ${res.status}`)
      }
      if (!res.ok || !json.success) {
        throw new Error(json.error || json.message || `PDF 解析失败: ${res.status}`)
      }
      const data = json.data
      attachedPdf = {
        name: data.filename || file.name,
        text: data.text || '',
        chars: data.chars,
        pages: data.pages,
        truncated: data.truncated,
      }
      renderAttachmentPreview()
      const tip = data.truncated ? `（已截断至 ${data.chars} 字符）` : ''
      showUploadToast(`PDF 解析完成，共 ${data.chars} 字符${tip}`)
    } catch (err) {
      attachedPdf = null
      renderAttachmentPreview()
      showUploadToast('PDF 解析失败: ' + err.message)
    }
  } else {
    // 图片：仅视觉模型支持，非视觉模型禁止上传
    const supportsVision = !!(currentModelInfo && currentModelInfo.supportsVision)
    if (!supportsVision) {
      showUploadToast('当前模型不支持图片，请选择视觉模型后再上传图片')
      e.target.value = ''
      return
    }
    // 上传到 admin-server 获取 URL（参考 Monica：聊天历史存 URL 而非 base64）
    try {
      showUploadToast('正在上传图片...')
      const { url, headers } = await callService('configService', 'getImageUploadConfig')
      const formData = new FormData()
      formData.append('file', file, file.name)
      const res = await fetch(url, { method: 'POST', headers, body: formData })
      const text = await res.text()
      let json
      try { json = JSON.parse(text) } catch (_) {
        throw new Error(`图片上传响应解析失败: ${res.status}`)
      }
      if (!res.ok || !json.success) {
        throw new Error(json.error || json.message || `图片上传失败: ${res.status}`)
      }
      attachedImage = json.data.url
      renderAttachmentPreview()
      showUploadToast('图片上传完成')
    } catch (err) {
      showUploadToast('图片上传失败: ' + err.message)
    }
  }
  // 重置以便重复选择同一文件
  e.target.value = ''
})

/**
 * 渲染附件预览条（支持图片和 PDF）
 */
function renderAttachmentPreview() {
  const container = document.getElementById('attachmentPreview')
  if (!container) return
  container.innerHTML = ''
  if (!attachedImage && !attachedPdf) {
    container.classList.remove('show')
    persistAttachments()
    return
  }
  container.classList.add('show')

  // 图片附件
  if (attachedImage) {
    const item = document.createElement('div')
    item.className = 'attachment-item'
    item.title = '点击放大预览'
    const img = document.createElement('img')
    img.src = attachedImage
    img.alt = '附件'
    item.appendChild(img)

    const remove = document.createElement('button')
    remove.className = 'attachment-remove'
    remove.title = '移除图片'
    remove.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg>'
    remove.addEventListener('click', () => {
      attachedImage = null
      renderAttachmentPreview()
    })
    item.appendChild(remove)
    container.appendChild(item)
  }

  // PDF 附件
  if (attachedPdf) {
    const item = document.createElement('div')
    item.className = 'attachment-item pdf'
    if (!attachedPdf.parsing) {
      item.title = '点击预览 PDF 内容'
      const pid = ++pdfPreviewIdCounter
      pdfPreviewRegistry.set(String(pid), attachedPdf)
      item.dataset.pdfPreviewId = String(pid)
    }
    const icon = document.createElement('span')
    icon.className = 'pdf-icon'
    icon.textContent = '📄'
    item.appendChild(icon)
    const nameEl = document.createElement('span')
    nameEl.className = 'pdf-name'
    nameEl.textContent = attachedPdf.parsing ? '解析中…' : attachedPdf.name
    item.appendChild(nameEl)

    const remove = document.createElement('button')
    remove.className = 'attachment-remove'
    remove.title = '移除 PDF'
    remove.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg>'
    remove.addEventListener('click', () => {
      attachedPdf = null
      renderAttachmentPreview()
    })
    item.appendChild(remove)
    container.appendChild(item)
  }
  persistAttachments()
}

// ============ 附件预览模态框（图片放大 / PDF 文本预览） ============
function ensurePreviewModal() {
  let modal = document.getElementById('previewModal')
  if (modal) return modal
  modal = document.createElement('div')
  modal.id = 'previewModal'
  modal.className = 'preview-modal'
  modal.addEventListener('click', (e) => {
    // 点击空白背景关闭（点击内容不关闭）
    if (e.target === modal) closePreviewModal()
  })
  document.body.appendChild(modal)
  return modal
}

function closePreviewModal() {
  const modal = document.getElementById('previewModal')
  if (modal) {
    modal.classList.remove('show')
    modal.innerHTML = ''
  }
}

function openImagePreview(src) {
  const modal = ensurePreviewModal()
  const img = document.createElement('img')
  img.src = src
  img.alt = '预览图片'
  modal.innerHTML = ''
  modal.appendChild(img)
  modal.classList.add('show')
}

function openPdfPreview(pdf) {
  const modal = ensurePreviewModal()
  const name = escapeHtml(pdf.name || 'PDF')
  const charsInfo = pdf.chars ? `${pdf.chars} 字符` : ''
  const text = pdf.text ? escapeHtml(pdf.text) : ''
  modal.innerHTML = `
    <div class="pdf-preview">
      <div class="pdf-preview-header">
        <span class="pdf-preview-title">📄 ${name}${charsInfo ? ' · ' + charsInfo : ''}</span>
        <button class="pdf-preview-close" title="关闭">×</button>
      </div>
      <div class="pdf-preview-body">${text || '<div class="pdf-preview-empty">无可预览的文本内容</div>'}</div>
    </div>`
  modal.classList.add('show')
  modal.querySelector('.pdf-preview-close').addEventListener('click', closePreviewModal)
}

// 事件委托：点击附件项触发预览（未发送预览条 + 已发送气泡均支持）
document.addEventListener('click', (e) => {
  if (e.target.closest('.attachment-remove')) return
  const item = e.target.closest('.attachment-item')
  if (!item) return
  if (item.classList.contains('pdf')) {
    const id = item.dataset.pdfPreviewId
    if (id && pdfPreviewRegistry.has(id)) {
      openPdfPreview(pdfPreviewRegistry.get(id))
    } else if (attachedPdf && !attachedPdf.parsing) {
      openPdfPreview(attachedPdf)
    }
    return
  }
  const img = item.querySelector('img')
  if (img && img.src) {
    openImagePreview(img.src)
  }
})

// ESC 关闭预览
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePreviewModal()
})

function showUploadToast(text) {
  const inputArea = document.querySelector('.chat-input-area')
  if (!inputArea) return
  inputArea.style.position = 'relative'
  const toast = document.createElement('div')
  toast.textContent = text
  toast.style.cssText = 'position:absolute;bottom:60px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:6px 14px;border-radius:4px;font-size:12px;z-index:9999;opacity:0.9;white-space:nowrap;'
  inputArea.appendChild(toast)
  setTimeout(() => toast.remove(), 2000)
}

// ============ 脚本列表 ============
async function loadScripts() {
  const scripts = await callService('scriptService', 'getScripts')
  const container = document.getElementById('scriptsList')

  if (!scripts || scripts.length === 0) {
    container.innerHTML = '<div class="empty">暂无脚本<br>点击 ↻ 同步</div>'
    return
  }

  container.innerHTML = scripts.map(s => `
    <div class="script-card" data-id="${s.id}">
      <div class="script-card-header">
        <span class="script-card-name">${escapeHtml(s.name)}</span>
        <button class="script-inject-btn" data-script-id="${s.id}" title="注入到页面">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <div class="toggle ${s.enabled ? 'on' : ''}" data-script-id="${s.id}"></div>
      </div>
      ${s.description ? `<div class="script-card-desc">${escapeHtml(s.description)}</div>` : ''}
      <div class="script-card-meta">
        <span>${s.category || '未分类'}</span>
        <span>v${s.version}</span>
      </div>
    </div>
  `).join('')

  // 点击注入按钮
  container.querySelectorAll('.script-inject-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const scriptId = parseInt(btn.dataset.scriptId)
      callService('pageService', 'injectToolboxScript', scriptId).catch(e => {
        console.warn('[脚本管理] 注入异常:', e.message)
      })
    })
  })

  // 开关切换
  container.querySelectorAll('.toggle[data-script-id]').forEach(el => {
    el.addEventListener('click', async () => {
      const id = parseInt(el.dataset.scriptId)
      const enabled = !el.classList.contains('on')
      el.classList.toggle('on', enabled)
      await callService('scriptService', 'toggleScript', id, enabled)
    })
  })
}

document.getElementById('syncScriptsBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncScriptsBtn')
  btn.style.transform = 'rotate(360deg)'
  btn.style.transition = 'transform 1s'
  await callService('scriptService', 'syncScripts')
  loadScripts()
  setTimeout(() => { btn.style.transform = '' }, 1000)
})

// ============ 加载历史记录 ============
async function loadChatHistory() {
  try {
    const raw = await callService('storageService', 'getChatHistory') || []
    if (!Array.isArray(raw)) {
      console.warn('[SidePanel] chatHistory 数据损坏，已重置')
      await callService('storageService', 'clearChatHistory')
      return
    }
    // 检测"拒绝循环"：如果最近N条assistant回复都是相同的拒绝语，自动清理
    const refusalPatterns = ['无法给到', '无法提供', '不能提供', '无法回答', 'cannot provide', '无法帮助']
    const assistantMsgs = raw.filter(m => m.role === 'assistant')
    const recentAssistant = assistantMsgs.slice(-3)
    if (recentAssistant.length >= 2) {
      const allSame = recentAssistant.every(m => m.content === recentAssistant[0].content)
      const isRefusal = refusalPatterns.some(p => recentAssistant[0].content?.includes(p))
      if (allSame && isRefusal) {
        console.warn('[SidePanel] 检测到拒绝循环，自动清除聊天历史')
        await callService('storageService', 'clearChatHistory')
        return // chatHistory 保持空数组
      }
    }
    chatHistory = raw
    for (const msg of chatHistory) {
      // Agent 消息如果有 toolCalls，渲染一个已完成的步骤摘要卡片
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const card = document.createElement('div')
        card.className = 'agent-step-card history'
        const toolList = msg.toolCalls.map((t, i) =>
          `<div class="agent-history-step"><span class="step-num">${i + 1}.</span> ${escapeHtml(t.name)}</div>`
        ).join('')
        card.innerHTML = `
          <div class="agent-step-header">
            <span class="agent-step-icon">&#x2705;</span>
            <span class="agent-step-title">Agent 已执行 ${msg.toolCalls.length} 个步骤</span>
          </div>
          <div class="agent-step-body">${toolList}</div>
        `
        chatMessages.appendChild(card)
      }
      addMessage(msg.role, msg.content, msg.attachments)
    }
  } catch (e) {
    console.error('loadChatHistory error:', e)
  }
}

// ============ 初始化 ============
;(async () => {
  // 先加载聊天记录，确保用户消息在 DOM 中，再执行自动重连
  await loadChatHistory()
  await loadSettings()
  await loadAgentMode()
  // 立即恢复未发送附件
  loadAttachmentsFromStorage()
})()
// 初始化模型选择列表（读取已保存的模型并选中）；模型加载后 updateModelInfo 会按视觉能力清空图片
;(async () => {
  try {
    const aiConfig = await callService('configService', 'getAIConfig')
    await loadModelSelect(aiConfig.model)
  } catch (e) {
    console.error('init loadModelSelect error:', e)
  }
})()

// 检测来自划词操作的待发送消息
async function checkPendingMessage() {
  const data = await chrome.storage.local.get('pendingMessage')
  if (data.pendingMessage) {
    // 清除 pendingMessage 防止重复发送
    await chrome.storage.local.remove('pendingMessage')
    // 确保在聊天视图
    showView('chatView')
    // 自动发送消息
    sendMessage(data.pendingMessage)
  }
}

// 启动时检查一次
checkPendingMessage()

// 启动时检查 floatingToolAction（iframe 首次打开时 storage.onChanged 已触发，不会再触发）
async function checkFloatingAction() {
  const data = await chrome.storage.local.get('floatingToolAction')
  if (data.floatingToolAction) {
    await chrome.storage.local.remove('floatingToolAction')
    handleFloatingAction(data.floatingToolAction)
  }
}
checkFloatingAction()

// 监听 storage 变化（sidepanel 已打开时，新的划词操作会触发）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.pendingMessage?.newValue) {
      chrome.storage.local.remove('pendingMessage')
      showView('chatView')
      sendMessage(changes.pendingMessage.newValue)
    }
    if (changes.floatingToolAction?.newValue) {
      const action = changes.floatingToolAction.newValue
      chrome.storage.local.remove('floatingToolAction')
      handleFloatingAction(action)
    }
    // Agent 在后台写入 chatHistory 时，自动同步到 UI
    if (changes.chatHistory?.newValue) {
      const newHistory = changes.chatHistory.newValue
      if (newHistory.length >= chatHistory.length) {
        const newMsgs = newHistory.slice(chatHistory.length)
        if (newMsgs.length > 0) {
          console.log('[SidePanel] storage.onChanged: 检测到', newMsgs.length, '条新消息（来自 Agent）')
          chatHistory = newHistory
          // 清理 streaming 状态（端口可能已断，需先清理再决定是否补充 UI）
          if (isStreaming) {
            isStreaming = false
            sendBtn.disabled = false
            currentPort = null
          }
          // 只有当 streamDone 未通过 port 送达时（recentlyStreamedContent 为空），才补充 UI
          if (!recentlyStreamedContent) {
            // 移除残留的 streaming typing 动画 div（端口断开导致 streamChunk 未送达）
            const typingIndicators = chatMessages.querySelectorAll('.typing-indicator')
            typingIndicators.forEach(el => {
              const msgDiv = el.closest('.message')
              if (msgDiv) msgDiv.remove()
            })
            for (const msg of newMsgs) {
              if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
                const card = document.createElement('div')
                card.className = 'agent-step-card history'
                const toolList = msg.toolCalls.map((t, i) =>
                  `<div class="agent-history-step"><span class="step-num">${i + 1}.</span> ${escapeHtml(t.name)}</div>`
                ).join('')
                card.innerHTML = `
                  <div class="agent-step-header">
                    <span class="agent-step-icon">&#x2705;</span>
                    <span class="agent-step-title">Agent 已执行 ${msg.toolCalls.length} 个步骤</span>
                  </div>
                  <div class="agent-step-body">${toolList}</div>
                `
                chatMessages.appendChild(card)
              }
              addMessage(msg.role, msg.content, msg.attachments)
            }
          }
        }
      }
    }
  }
})

// 响应页面浮动按钮点击
async function handleFloatingAction(action) {
  switch (action) {
    case 'toolbox':
      showView('chatView')
      openToolbox()
      await loadToolboxScripts()
      break
    case 'tools':
      showView('scriptsView')
      loadScripts()
      break
    case 'agent':
      toggleAgentMode()
      break
    case 'todo':
      toggleTodoPanel()
      break
    case 'settings':
      showView('settingsView')
      break
  }
}

// ============ inject_js 回调通知 ============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'injectCallbackNotification') {
    const data = msg.data || {}
    const action = data.action || '未知操作'
    const message = data.message || ''
    const callbackText = `[回调通知] ${action}${message ? ': ' + message : ''}`
    // 在聊天界面插入系统通知消息
    const div = document.createElement('div')
    div.className = 'message ai-msg'
    div.innerHTML = `
      <div class="msg-avatar"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></div>
      <div class="msg-body">
        <div class="msg-name">脚本回调</div>
        <div class="msg-bubble msg-markdown">${renderMarkdown(callbackText)}</div>
      </div>
    `
    chatMessages.appendChild(div)
    chatMessages.scrollTop = chatMessages.scrollHeight
    sendResponse({ ok: true })
  }
})