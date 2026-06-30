// AI Browser Chrome Extension - Popup Logic

async function callService(service, method, ...args) {
  if (!chrome.runtime?.id) {
    console.warn('[Popup] Extension context invalidated')
    throw new Error('扩展已重载，请重新打开弹窗')
  }
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'callService', service, method, args,
    })
    if (res?.error) throw new Error(res.error)
    return res?.data
  } catch (e) {
    if (e.message?.includes('Extension context invalidated') || e.message?.includes('Could not establish connection')) {
      throw new Error('扩展已重载，请重新打开弹窗')
    }
    throw e
  }
}

// Tab 切换
function switchTab(page) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
  document.querySelector(`[data-page="${page}"]`).classList.add('active')
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.getElementById('page-' + page).classList.add('active')
  if (page === 'scripts') loadScripts()
}
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => switchTab(t.dataset.page))
})

// 脚本列表
async function loadScripts() {
  const scripts = await callService('scriptService', 'getScripts')
  const status = await callService('storageService', 'get', 'lastSync')
  const syncError = await callService('storageService', 'get', 'syncError')
  const container = document.getElementById('scriptList')

  if (!scripts || scripts.length === 0) {
    container.innerHTML = '<div class="empty"><div class="empty-icon">📜</div>暂无脚本<br><span style="font-size:11px">点击「同步」从管理后台获取</span></div>'
    updateStatus(status, syncError)
    return
  }

  container.innerHTML = '<div class="script-list">' + scripts.map(s => `
    <div class="script-item ${s.enabled ? '' : 'disabled'}" data-id="${s.id}">
      <div class="script-name">
        <span>${esc(s.name)}</span>
        <div class="toggle ${s.enabled ? 'on' : ''}" data-id="${s.id}" data-enabled="${s.enabled}"></div>
      </div>
      ${s.description ? `<div class="script-desc">${esc(s.description)}</div>` : ''}
      <div class="script-meta">
        <span>${s.category || '未分类'}</span>
        <span>v${s.version}</span>
        <span>${s.urlPattern || '*'}</span>
      </div>
    </div>
  `).join('') + '</div>'

  container.querySelectorAll('.toggle').forEach(el => {
    el.addEventListener('click', async () => {
      const id = parseInt(el.dataset.id)
      const enabled = el.dataset.enabled !== 'true'
      el.dataset.enabled = enabled
      el.classList.toggle('on', enabled)
      await callService('scriptService', 'toggleScript', id, enabled)
    })
  })
  updateStatus(status, syncError)
}

function esc(str) {
  const d = document.createElement('div')
  d.textContent = str || ''
  return d.innerHTML
}

function updateStatus(lastSync, syncError) {
  const bar = document.getElementById('statusBar')
  if (syncError) {
    bar.className = 'status-bar error'
    bar.textContent = '同步失败: ' + syncError
  } else if (lastSync) {
    bar.className = 'status-bar'
    bar.textContent = '上次同步: ' + new Date(lastSync).toLocaleTimeString()
  } else {
    bar.className = 'status-bar'
    bar.textContent = '就绪'
  }
}

// 设置
async function loadSettings() {
  const aiConfig = await callService('configService', 'getAIConfig')
  const syncConfig = await callService('configService', 'getSyncConfig')
  const selEnabled = await callService('configService', 'getSelectionToolsEnabled')

  document.getElementById('serverUrl').value = syncConfig.serverUrl || ''
  document.getElementById('syncAppKey').value = syncConfig.appKey || ''
  document.getElementById('syncAppSecret').value = syncConfig.appSecret || ''
  document.getElementById('aiModel').value = aiConfig.model || ''
  document.getElementById('selectionToggle').classList.toggle('on', selEnabled !== false)
}

document.getElementById('selectionToggle').addEventListener('click', function() {
  this.classList.toggle('on')
})

document.getElementById('saveConfigBtn').addEventListener('click', async () => {
  await callService('configService', 'saveAIConfig', {
    model: document.getElementById('aiModel').value.trim(),
  })
  // 保留 syncInterval（UI 中已移除该字段，从旧配置继承）
  const oldSync = await callService('configService', 'getSyncConfig')
  await callService('configService', 'saveSyncConfig', {
    serverUrl: document.getElementById('serverUrl').value.trim(),
    appKey: document.getElementById('syncAppKey').value.trim(),
    appSecret: document.getElementById('syncAppSecret').value.trim(),
    syncInterval: oldSync.syncInterval || 30,
    enabled: true,
  })
  await callService('configService', 'saveSelectionToolsEnabled',
    document.getElementById('selectionToggle').classList.contains('on'))
  document.getElementById('statusBar').textContent = '已保存'
  setTimeout(() => switchTab('assistant'), 500)
})

// 同步
document.getElementById('syncBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncBtn')
  btn.innerHTML = '<span class="sync-spin">↻</span> 同步中'
  btn.disabled = true
  await callService('scriptService', 'syncScripts')
  btn.textContent = '↻ 同步'
  btn.disabled = false
  loadScripts()
})

// 打开侧边栏
document.getElementById('openSidebarBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id) {
    chrome.sidePanel.open({ tabId: tab.id })
  }
})

// 快速提问 → 打开侧边栏并发送
document.getElementById('quickChatBtn').addEventListener('click', async () => {
  const input = document.getElementById('quickChatInput')
  const text = input.value.trim()
  if (!text) return
  // 保存到临时存储，侧边栏打开时读取
  await chrome.storage.local.set({ pendingMessage: text })
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id) {
    chrome.sidePanel.open({ tabId: tab.id })
  }
  input.value = ''
})

document.getElementById('quickChatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('quickChatBtn').click()
})

// 快捷按钮 → 同样打开侧边栏
['summarizeBtn', 'translateBtn', 'extractBtn'].forEach(id => {
  document.getElementById(id).addEventListener('click', async () => {
    const prompts = {
      summarizeBtn: '总结当前页面内容',
      translateBtn: '翻译当前页面为中文',
      extractBtn: '提取当前页面的关键信息',
    }
    await chrome.storage.local.set({ pendingMessage: prompts[id] })
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id) chrome.sidePanel.open({ tabId: tab.id })
  })
})

// 初始化
loadScripts()
