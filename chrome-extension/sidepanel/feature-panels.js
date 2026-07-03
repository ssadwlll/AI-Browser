// ============ Feature Panels - 内置工具面板 ============
// Feature 20: 资源监控 / Feature 7: 任务模板 / Feature 4: 工具录制 / Feature 23: 定时任务
// 整合为标签页结构，所有用户输入均使用 textContent 渲染

const STYLE_ID = 'feature-panels-style'

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
#feature-panels{display:flex;flex-direction:column;height:100%}

/* 标签栏 */
.fp-tab-bar{display:flex;gap:0;border-bottom:1px solid rgba(79,89,102,0.12);overflow-x:auto;background:#fff;flex-shrink:0}
.fp-tab-btn{border:none;padding:10px 14px;font-size:13px;cursor:pointer;background:none;color:#8c8c8c;white-space:nowrap;transition:all .15s;border-bottom:2px solid transparent}
.fp-tab-btn:hover{color:#595959;background:rgba(245,245,245,0.6)}
.fp-tab-btn.active{color:#6841ea;border-bottom-color:#6841ea;font-weight:600}

/* 标签内容区 */
.fp-tab-panels{flex:1;overflow-y:auto;padding:12px}

/* 通用组件 */
.fp-btn{border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;transition:all .15s;flex-shrink:0}
.fp-btn-danger{background:rgba(234,54,57,0.08);color:#ea3639}
.fp-btn-danger:hover{background:rgba(234,54,57,0.16)}
.fp-btn-primary{background:rgba(104,65,234,0.08);color:#6841ea}
.fp-btn-primary:hover{background:rgba(104,65,234,0.16)}
.fp-input{width:100%;padding:6px 10px;border:1px solid rgba(79,89,102,0.12);border-radius:6px;font-size:13px;outline:none;transition:border-color .15s;box-sizing:border-box}
.fp-input:focus{border-color:#6841ea}
.fp-add-row{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap}
.fp-add-row .fp-input{flex:1;min-width:120px}
.fp-empty{color:#8c8c8c;font-size:13px;text-align:center;padding:12px}

/* 资源监控 */
.fp-stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.fp-stat-card{padding:10px;border-radius:8px;background:rgba(245,245,245,0.8);border:1px solid rgba(79,89,102,0.06)}
.fp-stat-label{font-size:11px;color:#8c8c8c;margin-bottom:4px}
.fp-stat-value{font-size:16px;font-weight:600;color:#262626}
.fp-stat-sub{font-size:11px;color:#595959;margin-top:2px}
.fp-stat-card .fp-btn{margin-top:6px;width:100%}
.fp-idb-list{margin-top:8px;display:flex;flex-direction:column;gap:4px}
.fp-idb-row{display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:4px 8px;border-radius:4px;background:rgba(250,250,250,0.8)}
.fp-idb-name{color:#595959;font-family:monospace;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-idb-count{font-weight:600;color:#262626}
`
  document.head.appendChild(style)
}

// ============ 资源监控 ============

const IDB_STORES = ['task_templates', 'tool_recordings', 'agent_snapshots', 'scheduled_tasks']

function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return 'N/A'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

function createStatCard(label, value, sub) {
  const card = document.createElement('div')
  card.className = 'fp-stat-card'
  const labelEl = document.createElement('div')
  labelEl.className = 'fp-stat-label'
  labelEl.textContent = label
  card.appendChild(labelEl)
  const valueEl = document.createElement('div')
  valueEl.className = 'fp-stat-value'
  valueEl.textContent = value
  card.appendChild(valueEl)
  if (sub) {
    const subEl = document.createElement('div')
    subEl.className = 'fp-stat-sub'
    subEl.textContent = sub
    card.appendChild(subEl)
  }
  return card
}

async function refreshResourceStats(callService, statsContainer) {
  statsContainer.innerHTML = ''
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate()
      const usagePct = est.quota ? ((est.usage / est.quota) * 100).toFixed(1) : '0'
      statsContainer.appendChild(createStatCard('存储使用量', formatBytes(est.usage), '配额 ' + formatBytes(est.quota) + ' (' + usagePct + '%)'))
    } else {
      statsContainer.appendChild(createStatCard('存储使用量', 'N/A', 'navigator.storage 不可用'))
    }
  } catch (e) {
    statsContainer.appendChild(createStatCard('存储使用量', 'N/A', String(e.message)))
  }
  try {
    const tabs = await chrome.tabs.query({})
    const checks = await Promise.all(tabs.map(tab => callService('agentService', 'isRunning', tab.id).catch(() => false)))
    const activeCount = checks.filter(Boolean).length
    statsContainer.appendChild(createStatCard('活跃 Agent', activeCount + ' 个', '共 ' + tabs.length + ' 个标签页'))
  } catch (e) {
    statsContainer.appendChild(createStatCard('活跃 Agent', 'N/A', String(e.message)))
  }
  try {
    if (performance.memory) {
      const mem = performance.memory
      statsContainer.appendChild(createStatCard('JS 堆内存', formatBytes(mem.usedJSHeapSize), '上限 ' + formatBytes(mem.jsHeapSizeLimit)))
    } else {
      statsContainer.appendChild(createStatCard('JS 堆内存', 'N/A', 'performance.memory 不可用'))
    }
  } catch (e) {
    statsContainer.appendChild(createStatCard('JS 堆内存', 'N/A', String(e.message)))
  }
  try {
    const cacheCard = createStatCard('工具缓存', '已启用', '结果缓存 LRU(30)')
    const clearBtn = document.createElement('button')
    clearBtn.className = 'fp-btn fp-btn-danger'
    clearBtn.textContent = '清理缓存'
    clearBtn.addEventListener('click', async () => {
      try {
        await callService('toolService', 'clearCache')
        clearBtn.textContent = '已清理 ✓'
        setTimeout(() => { clearBtn.textContent = '清理缓存' }, 1500)
      } catch (e) {
        clearBtn.textContent = '清理失败'
        setTimeout(() => { clearBtn.textContent = '清理缓存' }, 1500)
      }
    })
    cacheCard.appendChild(clearBtn)
    statsContainer.appendChild(cacheCard)
  } catch (e) {
    statsContainer.appendChild(createStatCard('工具缓存', 'N/A', String(e.message)))
  }
  try {
    const idbTitle = document.createElement('div')
    idbTitle.className = 'fp-stat-label'
    idbTitle.style.marginTop = '8px'
    idbTitle.textContent = 'IndexedDB 记录统计'
    statsContainer.appendChild(idbTitle)
    const idbList = document.createElement('div')
    idbList.className = 'fp-idb-list'
    const counts = await Promise.all(IDB_STORES.map(async (storeName) => {
      try {
        const records = await callService('dbService', 'getAll', storeName)
        return { storeName, count: Array.isArray(records) ? records.length : 0 }
      } catch (e) {
        return { storeName, count: -1 }
      }
    }))
    for (const { storeName, count } of counts) {
      const row = document.createElement('div')
      row.className = 'fp-idb-row'
      const nameEl = document.createElement('span')
      nameEl.className = 'fp-idb-name'
      nameEl.textContent = storeName
      row.appendChild(nameEl)
      const countEl = document.createElement('span')
      countEl.className = 'fp-idb-count'
      countEl.textContent = count >= 0 ? count + ' 条' : 'N/A'
      row.appendChild(countEl)
      idbList.appendChild(row)
    }
    statsContainer.appendChild(idbList)
  } catch (e) {}
}

function createResourceMonitorPanel(callService) {
  const div = document.createElement('div')
  const statsContainer = document.createElement('div')
  statsContainer.className = 'fp-stats-grid'
  statsContainer.innerHTML = '<div class="fp-empty">加载中...</div>'
  div.appendChild(statsContainer)

  let refreshTimer = null
  return {
    el: div,
    load: () => {
      refreshResourceStats(callService, statsContainer)
      if (refreshTimer) clearInterval(refreshTimer)
      refreshTimer = setInterval(() => refreshResourceStats(callService, statsContainer), 5000)
    },
    unload: () => {
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
    }
  }
}

// ============ 任务模板库 ============

function createTaskTemplatePanel(callService) {
  const div = document.createElement('div')
  const listContainer = document.createElement('div')
  listContainer.className = 'fp-idb-list'
  listContainer.innerHTML = '<div class="fp-empty">加载中...</div>'
  div.appendChild(listContainer)

  async function loadTemplates() {
    try {
      const result = await callService('taskTemplateService', 'list')
      const templates = (result && result.ok !== false && result.templates) || []
      listContainer.innerHTML = ''
      if (templates.length === 0) {
        listContainer.innerHTML = '<div class="fp-empty">' + (result?.error ? '加载失败: ' + result.error : '暂无模板') + '</div>'
        return
      }
      for (const t of templates) {
        const row = document.createElement('div')
        row.className = 'fp-idb-row'
        const nameEl = document.createElement('span')
        nameEl.className = 'fp-idb-name'
        nameEl.textContent = t.name || t.id
        nameEl.title = t.description || ''
        row.appendChild(nameEl)
        const useBtn = document.createElement('button')
        useBtn.className = 'fp-btn fp-btn-primary'
        useBtn.textContent = '使用'
        useBtn.style.marginLeft = '8px'
        useBtn.addEventListener('click', async () => {
          try {
            const res = await callService('taskTemplateService', 'instantiate', t.id)
            const stages = res?.stages || []
            const input = document.getElementById('chatInput')
            if (input && stages.length > 0) {
              const desc = stages.map(s => s.name || s.action || '步骤').join(' → ')
              input.value = `按模板"${res?.template?.name || t.name}"执行：${desc}`
              input.dispatchEvent(new Event('input'))
            }
          } catch (e) { console.warn('[TaskTemplate] 使用失败:', e.message) }
        })
        row.appendChild(useBtn)
        listContainer.appendChild(row)
      }
    } catch (e) {
      listContainer.innerHTML = '<div class="fp-empty">加载失败: ' + e.message + '</div>'
    }
  }

  return { el: div, load: loadTemplates }
}

// ============ 工具录制回放 ============

function createToolRecordingPanel(callService) {
  const div = document.createElement('div')
  const listContainer = document.createElement('div')
  listContainer.className = 'fp-idb-list'
  listContainer.innerHTML = '<div class="fp-empty">加载中...</div>'
  div.appendChild(listContainer)

  async function loadSessions() {
    try {
      const sessions = await callService('toolRecordingService', 'listSessions', 20)
      listContainer.innerHTML = ''
      if (!sessions || sessions.length === 0) {
        listContainer.innerHTML = '<div class="fp-empty">暂无录制记录（Agent 执行时自动录制）</div>'
        return
      }
      for (const s of sessions) {
        const row = document.createElement('div')
        row.className = 'fp-idb-row'
        const infoEl = document.createElement('span')
        infoEl.className = 'fp-idb-name'
        const time = new Date(s.lastTimestamp).toLocaleString('zh-CN')
        infoEl.textContent = `${s.count}次调用 | ${time}`
        infoEl.title = '工具: ' + (s.tools || []).join(', ')
        row.appendChild(infoEl)
        const viewBtn = document.createElement('button')
        viewBtn.className = 'fp-btn fp-btn-primary'
        viewBtn.textContent = '详情'
        viewBtn.style.marginLeft = '8px'
        viewBtn.addEventListener('click', async () => {
          try {
            const entries = await callService('toolRecordingService', 'getSession', s.sessionId)
            const text = (entries || []).map((e, i) =>
              `${i + 1}. ${e.toolName}(${JSON.stringify(e.args || {}).slice(0, 80)}) → ${String(e.result || '').slice(0, 100)} [${e.durationMs || 0}ms]`
            ).join('\n')
            alert(text || '无数据')
          } catch (e) { alert('查看失败: ' + e.message) }
        })
        row.appendChild(viewBtn)
        listContainer.appendChild(row)
      }
    } catch (e) {
      listContainer.innerHTML = '<div class="fp-empty">加载失败: ' + e.message + '</div>'
    }
  }

  return { el: div, load: loadSessions }
}

// ============ 定时任务调度 ============

function createScheduledTaskPanel(callService) {
  const div = document.createElement('div')

  const form = document.createElement('div')
  form.className = 'fp-add-row'

  const nameInput = document.createElement('input')
  nameInput.className = 'fp-input'
  nameInput.placeholder = '任务名称'
  nameInput.style.minWidth = '100px'
  form.appendChild(nameInput)

  const cronInput = document.createElement('input')
  cronInput.className = 'fp-input'
  cronInput.placeholder = '间隔（分钟）'
  cronInput.type = 'number'
  cronInput.min = '1'
  cronInput.value = '60'
  cronInput.style.width = '80px'
  form.appendChild(cronInput)

  const typeSelect = document.createElement('select')
  typeSelect.className = 'fp-input'
  typeSelect.style.width = 'auto'
  for (const [val, label] of [['navigate', '打开网页'], ['inject_script', '执行脚本'], ['agent_message', '发送消息']]) {
    const opt = document.createElement('option')
    opt.value = val
    opt.textContent = label
    typeSelect.appendChild(opt)
  }
  form.appendChild(typeSelect)

  const payloadInput = document.createElement('input')
  payloadInput.className = 'fp-input'
  payloadInput.placeholder = 'URL / 脚本ID / 消息内容'
  payloadInput.style.minWidth = '120px'
  form.appendChild(payloadInput)

  const addBtn = document.createElement('button')
  addBtn.className = 'fp-btn fp-btn-primary'
  addBtn.textContent = '添加'
  form.appendChild(addBtn)

  div.appendChild(form)

  const listContainer = document.createElement('div')
  listContainer.className = 'fp-idb-list'
  div.appendChild(listContainer)

  async function loadTasks() {
    try {
      const result = await callService('scheduledTaskService', 'listTasks')
      const tasks = (result && result.ok !== false && result.tasks) || []
      listContainer.innerHTML = ''
      if (tasks.length === 0) {
        listContainer.innerHTML = '<div class="fp-empty">' + (result?.error ? '加载失败: ' + result.error : '暂无定时任务') + '</div>'
        return
      }
      for (const t of tasks) {
        const row = document.createElement('div')
        row.className = 'fp-idb-row'
        const infoEl = document.createElement('span')
        infoEl.className = 'fp-idb-name'
        const typeLabels = { navigate: '打开网页', inject_script: '执行脚本', agent_message: '发送消息' }
        infoEl.textContent = `${t.name || t.id} | 每${t.intervalMinutes || '?'}分钟 | ${typeLabels[t.actionType] || t.actionType}`
        infoEl.title = '参数: ' + JSON.stringify(t.actionParams || {})
        row.appendChild(infoEl)
        const delBtn = document.createElement('button')
        delBtn.className = 'fp-btn fp-btn-danger'
        delBtn.textContent = '删除'
        delBtn.style.marginLeft = '8px'
        delBtn.addEventListener('click', async () => {
          try {
            const res = await callService('scheduledTaskService', 'deleteTask', t.id)
            if (res?.ok === false) { alert('删除失败: ' + (res.error || '未知错误')); return }
            loadTasks()
          } catch (e) { alert('删除失败: ' + e.message) }
        })
        row.appendChild(delBtn)
        listContainer.appendChild(row)
      }
    } catch (e) {
      listContainer.innerHTML = '<div class="fp-empty">加载失败: ' + e.message + '</div>'
    }
  }

  addBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim()
    const intervalMinutes = parseInt(cronInput.value) || 60
    const actionType = typeSelect.value
    const payloadStr = payloadInput.value.trim()
    if (!payloadStr) { alert('请填写 URL/脚本ID/消息内容'); return }
    let actionParams
    if (actionType === 'inject_script') actionParams = { scriptId: parseInt(payloadStr) }
    else if (actionType === 'navigate') actionParams = { url: payloadStr }
    else actionParams = { message: payloadStr }
    try {
      const res = await callService('scheduledTaskService', 'createTask', { name: name || '未命名任务', intervalMinutes, actionType, actionParams, enabled: true })
      if (res?.ok === false) { alert('创建失败: ' + (res.error || '未知错误')); return }
      nameInput.value = ''
      payloadInput.value = ''
      loadTasks()
    } catch (e) { alert('创建失败: ' + e.message) }
  })

  return { el: div, load: loadTasks }
}

// ============ 调试日志 ============

let _debugLogPanel = null
const _debugLogBuffer = [] // 日志缓存，面板未初始化时暂存，创建后回放

function createDebugLogPanel() {
  const div = document.createElement('div')
  div.style.cssText = 'display:flex;flex-direction:column;height:100%;background:#0a0a14;color:#ccc;font-family:Consolas,monospace'

  // 头部操作栏
  const header = document.createElement('div')
  header.style.cssText = 'display:flex;justify-content:space-between;padding:8px 12px;background:#111122;border-bottom:2px solid #ff6b35;flex-shrink:0'

  const title = document.createElement('div')
  title.style.cssText = 'font-size:14px;color:#ff6b35;font-weight:700'
  title.textContent = '🐛 Debug Log'
  header.appendChild(title)

  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;gap:6px'

  const copyBtn = document.createElement('button')
  copyBtn.style.cssText = 'padding:4px 12px;border:1px solid #40a0f0;border-radius:4px;background:#1a1a2e;color:#60b0f0;font-size:12px;cursor:pointer;font-family:Consolas,monospace'
  copyBtn.textContent = '📋 复制全部'
  copyBtn.addEventListener('click', () => {
    const entries = logBody.querySelectorAll('.log-entry')
    if (entries.length === 0) {
      showToast('没有可复制的日志')
      return
    }
    let text = ''
    entries.forEach(e => {
      const label = e.querySelector('.log-label')?.textContent || ''
      const detail = e.querySelector('.log-detail')?.textContent || ''
      text += '[' + label + ']\n' + detail + '\n\n'
    })
    navigator.clipboard.writeText(text).then(() => {
      showToast('已复制 ' + entries.length + ' 条日志')
    }).catch(() => showToast('复制失败'))
  })
  actions.appendChild(copyBtn)

  const clearBtn = document.createElement('button')
  clearBtn.style.cssText = 'padding:4px 12px;border:1px solid #f04040;border-radius:4px;background:#1a1a2e;color:#f05050;font-size:12px;cursor:pointer;font-family:Consolas,monospace'
  clearBtn.textContent = '✕ 清空'
  clearBtn.addEventListener('click', () => {
    logBody.innerHTML = '<div class="empty-state">日志已清空，等待 Agent 任务启动…</div>'
    showToast('日志已清空')
  })
  actions.appendChild(clearBtn)

  header.appendChild(actions)
  div.appendChild(header)

  // 日志内容区
  const logBody = document.createElement('div')
  logBody.className = 'log-body'
  logBody.style.cssText = 'flex:1;overflow-y:auto;padding:10px 14px'
  logBody.innerHTML = '<div class="empty-state">等待 Agent 任务启动…<br>日志将自动显示在这里</div>'
  div.appendChild(logBody)

  // Toast 提示
  const toast = document.createElement('div')
  toast.style.cssText = 'position:fixed;top:12px;right:12px;background:#40a0f0;color:#fff;padding:8px 16px;border-radius:6px;font-size:12px;opacity:0;transition:opacity 0.3s;pointer-events:none;z-index:9999'
  toast.textContent = ''
  div.appendChild(toast)

  function showToast(msg) {
    toast.textContent = msg
    toast.style.opacity = '1'
    setTimeout(() => { toast.style.opacity = '0' }, 2000)
  }

  function appendLog(label, detail, level) {
    if (logBody.querySelector('.empty-state')) logBody.innerHTML = ''

    const entry = document.createElement('div')
    entry.className = 'log-entry ' + (level || '')
    entry.style.cssText = 'padding:8px 12px;margin:4px 0;border-radius:4px;background:#0f0f20;border-left:3px solid #555;white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.6'

    if (level === 'warn') entry.style.borderLeftColor = '#f0a020'
    else if (level === 'error') entry.style.borderLeftColor = '#f04040'
    else if (level === 'info') entry.style.borderLeftColor = '#40a0f0'

    const labelDiv = document.createElement('div')
    labelDiv.className = 'log-label'  // 添加类名，供复制功能查询
    labelDiv.style.cssText = 'font-weight:700;font-size:12px;margin-bottom:4px'
    if (level === 'info') labelDiv.style.color = '#60b0f0'
    else if (level === 'warn') labelDiv.style.color = '#f0b030'
    else if (level === 'error') labelDiv.style.color = '#f05050'
    else labelDiv.style.color = '#aaa'
    labelDiv.textContent = label
    entry.appendChild(labelDiv)

    const detailDiv = document.createElement('div')
    detailDiv.className = 'log-detail'  // 添加类名，供复制功能查询
    detailDiv.style.cssText = 'color:#999;font-size:11px'
    detailDiv.textContent = detail || ''
    entry.appendChild(detailDiv)

    logBody.appendChild(entry)
    logBody.scrollTop = logBody.scrollHeight
  }

  // 注册全局日志接收器
  if (!_debugLogPanel) {
    _debugLogPanel = { appendLog, logBody }
    // 回放缓存的日志
    for (const entry of _debugLogBuffer) {
      appendLog(entry.label, entry.detail, entry.level)
    }
    _debugLogBuffer.length = 0
  }

  return {
    el: div,
    load: () => {},
    unload: () => {}
  }
}

// 全局日志追加函数（供 sidepanel.js 调用）
export function appendDebugLogToPanel(label, detail, level) {
  // 始终缓存日志，确保面板创建后能回放
  _debugLogBuffer.push({ label, detail, level })
  if (_debugLogPanel) {
    _debugLogPanel.appendLog(label, detail, level)
    // 已回放的日志从缓存中移除
    _debugLogBuffer.length = 0
  }
}

// ============ 主初始化函数（标签页结构） ============

/**
 * 初始化功能面板（标签页结构）
 * @param {function} callService - (serviceName, methodName, ...args) => data
 * @returns {HTMLDivElement} 容器元素
 */
export function initFeaturePanels(callService) {
  injectStyles()

  const container = document.createElement('div')
  container.id = 'feature-panels'

  // 标签栏
  const tabBar = document.createElement('div')
  tabBar.className = 'fp-tab-bar'
  container.appendChild(tabBar)

  // 标签内容区
  const panelsContainer = document.createElement('div')
  panelsContainer.className = 'fp-tab-panels'
  container.appendChild(panelsContainer)

  // 标签定义
  const tabs = [
    { id: 'templates', label: '📋 任务模板', create: () => createTaskTemplatePanel(callService) },
    { id: 'recording', label: '🎬 工具录制', create: () => createToolRecordingPanel(callService) },
    { id: 'scheduled', label: '⏰ 定时任务', create: () => createScheduledTaskPanel(callService) },
    { id: 'monitor', label: '📈 资源监控', create: () => createResourceMonitorPanel(callService) },
    { id: 'debuglog', label: '🐛 调试日志', create: () => createDebugLogPanel() },
  ]

  let activePanel = null
  const tabEntries = {}

  for (const tab of tabs) {
    const btn = document.createElement('button')
    btn.className = 'fp-tab-btn'
    btn.textContent = tab.label
    btn.addEventListener('click', () => switchTab(tab.id))
    tabBar.appendChild(btn)
    tabEntries[tab.id] = { btn, panel: null }
  }

  function switchTab(id) {
    // 卸载当前面板
    if (activePanel && activePanel.unload) activePanel.unload()

    // 更新按钮状态
    for (const tid in tabEntries) {
      tabEntries[tid].btn.classList.toggle('active', tid === id)
    }

    // 创建或复用面板
    panelsContainer.innerHTML = ''
    const entry = tabEntries[id]
    if (!entry.panel) {
      entry.panel = tabs.find(t => t.id === id).create()
    }
    panelsContainer.appendChild(entry.panel.el)
    activePanel = entry.panel

    // 触发加载
    if (entry.panel.load) entry.panel.load()
  }

  // 默认显示第一个标签
  switchTab('templates')

  return container
}

console.log('[FeaturePanels] 功能面板已加载（标签页模式）')
