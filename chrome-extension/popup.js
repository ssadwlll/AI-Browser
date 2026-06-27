// AI Browser 脚本中心 - Popup 逻辑

let currentConfig = {}

// ============ Tab 切换 ============
function switchTab(page) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
  document.querySelector(`[data-page="${page}"]`).classList.add('active')
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.getElementById('page-' + page).classList.add('active')
  if (page === 'settings') loadConfig()
  if (page === 'scripts') loadScripts()
}

document.getElementById('tabScripts').addEventListener('click', () => switchTab('scripts'))
document.getElementById('tabSettings').addEventListener('click', () => switchTab('settings'))

// ============ 脚本列表 ============
async function loadScripts() {
  const scripts = await chrome.runtime.sendMessage({ action: 'getScripts' })
  const status = await chrome.runtime.sendMessage({ action: 'getStatus' })
  const container = document.getElementById('scriptList')

  if (!scripts || scripts.length === 0) {
    container.innerHTML = '<div class="empty"><div class="empty-icon">📜</div>暂无脚本<br><span style="font-size:11px">点击「同步」从管理后台获取</span></div>'
    updateStatus(status)
    return
  }

  container.innerHTML = '<div class="script-list">' + scripts.map(s => `
    <div class="script-item ${s.enabled ? '' : 'disabled'}" data-id="${s.id}">
      <div class="script-name">
        <span>${esc(s.name)}</span>
        <div class="toggle ${s.enabled ? 'on' : ''} action-toggle" data-id="${s.id}" data-enabled="${s.enabled}"></div>
      </div>
      ${s.description ? `<div class="script-desc">${esc(s.description)}</div>` : ''}
      <div class="script-meta">
        <span>${s.category || '未分类'}</span>
        <span>v${s.version}</span>
        <span>匹配: ${esc(s.urlPattern || '*')}</span>
      </div>
      <div class="script-actions">
        <button class="btn btn-danger action-delete" data-id="${s.id}">删除</button>
      </div>
    </div>
  `).join('') + '</div>'

  // 事件委托：开关切换
  container.querySelectorAll('.action-toggle').forEach(el => {
    el.addEventListener('click', async (e) => {
      const id = parseInt(el.dataset.id)
      const enabled = el.dataset.enabled !== 'true'
      await chrome.runtime.sendMessage({ action: 'toggleScript', scriptId: id, enabled })
      loadScripts()
    })
  })

  // 事件委托：删除
  container.querySelectorAll('.action-delete').forEach(el => {
    el.addEventListener('click', async () => {
      const id = parseInt(el.dataset.id)
      if (!confirm('确定删除此脚本？')) return
      await chrome.runtime.sendMessage({ action: 'deleteScript', scriptId: id })
      loadScripts()
    })
  })

  updateStatus(status)
}

// ============ 设置 ============
async function loadConfig() {
  currentConfig = await chrome.runtime.sendMessage({ action: 'getConfig' })
  document.getElementById('serverUrl').value = currentConfig.serverUrl || 'http://localhost:3001'
  document.getElementById('token').value = currentConfig.token || ''
  document.getElementById('syncInterval').value = currentConfig.syncInterval || 30
  const toggle = document.getElementById('globalToggle')
  toggle.classList.toggle('on', currentConfig.enabled !== false)
}

async function saveConfig() {
  const config = {
    serverUrl: document.getElementById('serverUrl').value.trim(),
    token: document.getElementById('token').value.trim(),
    syncInterval: parseInt(document.getElementById('syncInterval').value) || 30,
    enabled: document.getElementById('globalToggle').classList.contains('on'),
  }
  await chrome.runtime.sendMessage({ action: 'saveConfig', config })
  updateStatusText('已保存，正在同步...')
  setTimeout(() => {
    loadScripts()
    switchTab('scripts')
  }, 1000)
}

document.getElementById('globalToggle').addEventListener('click', () => {
  document.getElementById('globalToggle').classList.toggle('on')
})

document.getElementById('saveConfigBtn').addEventListener('click', saveConfig)

// ============ 同步 & 注入 ============
document.getElementById('syncBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncBtn')
  btn.innerHTML = '<span class="sync-spin">&#8635;</span> 同步中'
  btn.disabled = true
  await chrome.runtime.sendMessage({ action: 'sync' })
  btn.textContent = '同步'
  btn.disabled = false
  loadScripts()
})

document.getElementById('injectBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'injectNow' })
  updateStatusText('已注入到当前页面')
})

// ============ 状态栏 ============
function updateStatus(status) {
  if (!status) return
  const bar = document.getElementById('statusBar')
  if (status.syncError) {
    bar.className = 'status-bar error'
    bar.textContent = '同步失败: ' + status.syncError
  } else if (status.lastSync) {
    bar.className = 'status-bar'
    const time = new Date(status.lastSync).toLocaleTimeString()
    bar.textContent = '上次同步: ' + time
  } else {
    bar.className = 'status-bar'
    bar.textContent = '就绪'
  }
}

function updateStatusText(text) {
  document.getElementById('statusBar').textContent = text
}

// ============ 工具函数 ============
function esc(str) {
  const d = document.createElement('div')
  d.textContent = str || ''
  return d.innerHTML
}

// ============ 初始化 ============
loadScripts()
