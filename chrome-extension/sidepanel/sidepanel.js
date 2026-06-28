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

// ============ RPC 调用 ============
async function callService(service, method, ...args) {
  const res = await chrome.runtime.sendMessage({
    type: MSG_TYPES.CALL_SERVICE,
    service, method, args,
  })
  if (res?.error) throw new Error(res.error)
  return res?.data
}

// ============ 视图切换 ============
function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'))
  const target = document.getElementById(viewId)
  if (target) target.classList.add('active')

  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === viewId)
  })

  document.getElementById('toolboxPanel')?.classList.remove('show')
}

// 导航栏点击
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view))
})

// 设置按钮
document.getElementById('settingsBtn').addEventListener('click', () => showView('settingsView'))
document.getElementById('backToChatBtn').addEventListener('click', () => showView('chatView'))
document.getElementById('backFromScriptsBtn').addEventListener('click', () => showView('chatView'))

// ============ 工具栏按钮 ============

// 新建对话（header按钮）
document.getElementById('newChatHeaderBtn').addEventListener('click', startNewChat)

// 总结页面
document.getElementById('summarizeFloatBtn').addEventListener('click', () => {
  sendMessage('总结当前页面内容')
})

// 智能工具箱
document.getElementById('toolboxFloatBtn').addEventListener('click', async () => {
  const panel = document.getElementById('toolboxPanel')
  panel.classList.toggle('show')
  if (panel.classList.contains('show')) {
    await loadToolboxScripts()
  }
})

document.getElementById('toolboxCloseBtn').addEventListener('click', () => {
  document.getElementById('toolboxPanel').classList.remove('show')
})

// ============ 左侧浮动工具按钮 ============

// 浮动工具箱按钮 - 切换工具箱面板
document.getElementById('floatToolboxBtn').addEventListener('click', async () => {
  const panel = document.getElementById('toolboxPanel')
  panel.classList.toggle('show')
  if (panel.classList.contains('show')) {
    await loadToolboxScripts()
  }
})

// 浮动工具按钮 - 跳转脚本管理
document.getElementById('floatToolsBtn').addEventListener('click', () => {
  showView('scriptsView')
  loadScripts()
})

// 浮动Agent按钮 - 跳转画图视图（占位）
document.getElementById('floatAgentBtn').addEventListener('click', () => {
  showView('drawView')
})

// 浮动设置按钮 - 跳转设置视图
document.getElementById('floatSettingsBtn').addEventListener('click', () => {
  showView('settingsView')
})

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
      document.getElementById('toolboxPanel').classList.remove('show')
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

  // 链接 [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>')

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

function addMessage(role, content) {
  const welcome = chatMessages.querySelector('.welcome')
  if (welcome) welcome.remove()

  const isUser = role === 'user'
  const div = document.createElement('div')
  div.className = `message ${isUser ? 'user-msg' : 'ai-msg'}`

  const userAvatarSVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
  const aiAvatarSVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="16" r="2"/><path d="M12 11V5"/><path d="M8 5L4 2"/><path d="M16 5l4-3"/><circle cx="4" cy="2" r="1"/><circle cx="20" cy="2" r="1"/></svg>'

  div.innerHTML = `
    <div class="msg-avatar">${isUser ? userAvatarSVG : aiAvatarSVG}</div>
    <div class="msg-body">
      <div class="msg-name">${isUser ? '你' : 'AI Assistant'}</div>
      <div class="msg-bubble${isUser ? '' : ' msg-markdown'}">${isUser ? escapeHtml(content) : renderMarkdown(content)}</div>
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

  const userContent = pageContext ? text + pageContext : text
  chatHistory.push({ role: 'user', content: userContent })
  addMessage('user', text)
  chatInput.value = ''
  chatInput.style.height = 'auto'
  sendBtn.classList.remove('active')

  isStreaming = true
  sendBtn.disabled = true

  const streamDiv = addStreamingMessage()
  let fullContent = ''

  try {
    currentPort = chrome.runtime.connect({ name: 'ai-stream' })
    currentPort.postMessage({
      type: 'streamStart',
      messages: chatHistory,
      options: {},
    })

    currentPort.onMessage.addListener((msg) => {
      if (msg.type === 'streamChunk') {
        fullContent += msg.content
        updateStreamingMessage(streamDiv, fullContent)
      } else if (msg.type === 'streamDone') {
        chatHistory.push({ role: 'assistant', content: fullContent })
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
  } catch (e) {
    updateStreamingMessage(streamDiv, '❌ ' + e.message)
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

  document.getElementById('aiProvider').value = aiConfig.provider || 'ollama'
  document.getElementById('aiBaseUrl').value = aiConfig.baseUrl || ''
  document.getElementById('aiApiKey').value = aiConfig.apiKey || ''
  document.getElementById('aiModel').value = aiConfig.model || ''
  document.getElementById('aiSystemPrompt').value = aiConfig.systemPrompt || ''
  document.getElementById('syncServerUrl').value = syncConfig.serverUrl || ''
  document.getElementById('syncToken').value = syncConfig.token || ''
  document.getElementById('syncInterval').value = syncConfig.syncInterval || 30

  const toggle = document.getElementById('selectionToolsToggle')
  toggle.classList.toggle('on', selectionEnabled !== false)
}

document.getElementById('selectionToolsToggle').addEventListener('click', function() {
  this.classList.toggle('on')
})

document.getElementById('aiProvider').addEventListener('change', function() {
  const defaults = {
    ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    custom: { baseUrl: '', model: '' },
  }
  const d = defaults[this.value] || defaults.custom
  document.getElementById('aiBaseUrl').value = d.baseUrl
  document.getElementById('aiModel').value = d.model
})

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  try {
    await callService('configService', 'saveAIConfig', {
      provider: document.getElementById('aiProvider').value,
      baseUrl: document.getElementById('aiBaseUrl').value.trim(),
      apiKey: document.getElementById('aiApiKey').value.trim(),
      model: document.getElementById('aiModel').value.trim(),
      systemPrompt: document.getElementById('aiSystemPrompt').value.trim(),
    })
    await callService('configService', 'saveSyncConfig', {
      serverUrl: document.getElementById('syncServerUrl').value.trim(),
      token: document.getElementById('syncToken').value.trim(),
      syncInterval: parseInt(document.getElementById('syncInterval').value) || 30,
      enabled: true,
    })
    await callService('configService', 'saveSelectionToolsEnabled',
      document.getElementById('selectionToolsToggle').classList.contains('on'))

    showView('chatView')
  } catch (e) {
    alert('保存失败: ' + e.message)
  }
})

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
    chatHistory = await callService('storageService', 'getChatHistory') || []
    for (const msg of chatHistory) {
      addMessage(msg.role, msg.content)
    }
  } catch (e) {
    console.error('loadChatHistory error:', e)
  }
}

// ============ 初始化 ============
loadChatHistory()
loadSettings()

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
  }
})

// 响应页面浮动按钮点击
async function handleFloatingAction(action) {
  switch (action) {
    case 'toolbox':
      showView('chatView')
      const panel = document.getElementById('toolboxPanel')
      panel.classList.add('show')
      await loadToolboxScripts()
      break
    case 'tools':
      showView('scriptsView')
      loadScripts()
      break
    case 'agent':
      showView('drawView')
      break
    case 'settings':
      showView('settingsView')
      break
  }
}