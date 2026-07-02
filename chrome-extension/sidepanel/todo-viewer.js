// ============ Todo Viewer ============
// 独立窗口形式的待办面板
// 所有来自 LLM 的字段均使用 textContent 渲染，避免 XSS

const todoBody = document.getElementById('todoBody')
const overview = document.getElementById('overview')
const toast = document.getElementById('toast')
const copyBtn = document.getElementById('copyBtn')
const clearBtn = document.getElementById('clearBtn')

// Overview elements
const ovStage = document.getElementById('ovStage')
const ovProgressFill = document.getElementById('ovProgressFill')
const ovProgress = document.getElementById('ovProgress')
const ovDone = document.getElementById('ovDone')
const ovTotal = document.getElementById('ovTotal')
const ovLastTool = document.getElementById('ovLastTool')

// State
let lastData = null
let switchLogs = []
const MAX_SWITCH_LOGS = 50  // 防止日志无限增长导致内存膨胀

// showToast 的 timer 引用，连续调用时清理上一个
let toastTimer = null

copyBtn.addEventListener('click', copyAll)
clearBtn.addEventListener('click', clearAll)

function showToast(msg) {
  toast.textContent = msg
  toast.classList.add('show')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.classList.remove('show')
    toastTimer = null
  }, 2000)
}

const STAGE_NAMES = { 1: 'Stage 1 DOM工具', 2: 'Stage 2 远程脚本', 3: 'Stage 3 数据汇总' }
const STAGE_CLASS = { 1: 'stage1', 2: 'stage2', 3: 'stage3' }

function getStatusIcon(status) {
  if (status === 'done') return '✅'
  if (status === 'failed') return '❌'
  if (status === 'running') return '⏳'
  return '⬜'
}

// 创建带文本内容的 span（避免 innerHTML 注入）
function createSpan(className, text) {
  const span = document.createElement('span')
  span.className = className
  span.textContent = text == null ? '' : String(text)
  return span
}

function renderTodo(data) {
  if (!data || !data.stages || data.stages.length === 0) return

  lastData = data
  overview.style.display = 'flex'
  todoBody.innerHTML = ''

  // Update overview
  const progress = data.progress || {}
  const currentStage = data.currentStage || 1
  const stageName = STAGE_NAMES[currentStage] || `Stage ${currentStage}`
  ovStage.textContent = stageName
  ovStage.className = 'val ' + (STAGE_CLASS[currentStage] || '')
  const pct = progress.percentage || 0
  ovProgressFill.style.width = pct + '%'
  ovProgress.textContent = pct + '%'
  ovDone.textContent = progress.completed || 0
  ovTotal.textContent = progress.total || 0
  if (data.lastTool) {
    const statusEmoji = data.lastProgress ? '✅' : '❌'
    ovLastTool.textContent = statusEmoji + ' ' + data.lastTool
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
    // 使用 textContent 而非 innerHTML 拼接，避免 XSS
    const headerLabel = createSpan('', headerText)
    const headerBadge = createSpan('badge', `${completedCount}/${subTodos.length}`)
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
      icon.textContent = getStatusIcon(status)
      li.appendChild(icon)

      const content = document.createElement('div')
      content.className = 'todo-content'
      // 所有字段使用 textContent，避免 LLM 输出注入 HTML
      content.appendChild(createSpan('todo-id', todo.id))
      content.appendChild(createSpan('todo-action', todo.action))
      content.appendChild(createSpan('todo-desc', todo.description || ''))

      // Show dataOutputKey / dataDependKeys
      const keysDiv = document.createElement('div')
      keysDiv.className = 'todo-keys'
      if (todo.dataOutputKey) {
        const outKey = createSpan('key', `out: ${todo.dataOutputKey}`)
        keysDiv.appendChild(outKey)
      }
      if (Array.isArray(todo.dataDependKeys) && todo.dataDependKeys.length > 0) {
        const depKey = createSpan('key', `dep: ${todo.dataDependKeys.join(', ')}`)
        keysDiv.appendChild(depKey)
      }
      if (keysDiv.children.length > 0) content.appendChild(keysDiv)

      li.appendChild(content)
      list.appendChild(li)
    }

    group.appendChild(list)
    todoBody.appendChild(group)
  }

  // Append stage switch logs（限制最大数量）
  for (const log of switchLogs.slice(-MAX_SWITCH_LOGS)) {
    const div = document.createElement('div')
    div.className = 'stage-switch-log'
    div.textContent = `🔄 ${log}`
    todoBody.appendChild(div)
  }
}

function copyAll() {
  if (!lastData || !lastData.stages) {
    showToast('没有待办列表');
    return
  }
  let text = ''
  for (const stage of lastData.stages) {
    text += `[${STAGE_NAMES[stage.stage] || 'Stage ' + stage.stage}] ${stage.name || ''}\n`
    for (const todo of stage.subTodos || []) {
      const status = todo._status || (todo.id === lastData.progress?.currentTodo?.id ? 'running' : 'pending')
      text += `  ${getStatusIcon(status)} [${todo.id}] ${todo.action}: ${todo.description || ''}\n`
      if (todo.dataOutputKey) text += `       out: ${todo.dataOutputKey}\n`
      if (todo.dataDependKeys?.length) text += `       dep: ${todo.dataDependKeys.join(', ')}\n`
    }
    text += '\n'
  }
  navigator.clipboard.writeText(text)
    .then(() => showToast('已复制到剪贴板'))
    .catch(() => showToast('复制失败'))
}

function clearAll() {
  lastData = null
  switchLogs = []
  overview.style.display = 'none'
  todoBody.innerHTML = '<div class="empty-state">已清空，等待新任务…</div>'
  showToast('已清空')
}

// 使用 BroadcastChannel 接收来自 sidepanel 的待办更新（同源通信，不依赖 window.opener）
const todoChannel = new BroadcastChannel('ai-browser-todo')
todoChannel.addEventListener('message', (e) => {
  const data = e.data
  if (!data) return
  if (data.type === 'agentTodoClear') {
    // 新任务启动时清除旧待办数据
    renderTodo({ stages: [], progress: { total: 0, completed: 0 }, currentStage: 1 })
    return
  }
  if (data.type === 'agentTodoUpdate') {
    if (data.data?.stageSwitch) {
      const reason = data.data.stageSwitch.reason || ''
      const toStage = data.data.stageSwitch.to
      const stageLabel = STAGE_NAMES[toStage] || ('Stage ' + toStage)
      switchLogs.push(`${reason} → ${stageLabel}`)
      // 限制日志数量，超出时丢弃最旧的
      if (switchLogs.length > MAX_SWITCH_LOGS) {
        switchLogs.splice(0, switchLogs.length - MAX_SWITCH_LOGS)
      }
    }
    renderTodo(data.data)
  }
})

// 通过 BroadcastChannel 告知 sidepanel 本窗口已就绪
const readyChannel = new BroadcastChannel('ai-browser-todo-ready')
readyChannel.postMessage({ type: 'todoViewerReady' })
readyChannel.close()
