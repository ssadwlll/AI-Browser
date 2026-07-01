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

copyBtn.addEventListener('click', copyAll)
clearBtn.addEventListener('click', clearAll)

function showToast(msg) {
  toast.textContent = msg
  toast.classList.add('show')
  setTimeout(() => toast.classList.remove('show'), 2000)
}

const STAGE_NAMES = { 1: 'Stage 1 DOM工具', 2: 'Stage 2 远程脚本', 3: 'Stage 3 数据汇总' }
const STAGE_CLASS = { 1: 'stage1', 2: 'stage2', 3: 'stage3' }

function getStatusIcon(status) {
  if (status === 'done') return '✅'
  if (status === 'failed') return '❌'
  if (status === 'running') return '⏳'
  return '⬜'
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
  // 只有当 lastTool 匹配当前待办的 action 时才显示⏳
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
    header.innerHTML = `<span>${headerText}</span><span class="badge">${completedCount}/${subTodos.length}</span>`
    group.appendChild(header)

    const list = document.createElement('ul')
    list.className = 'todo-list'

    for (const todo of subTodos) {
      const li = document.createElement('li')
      let status = todo._status || 'pending'
      // 只有真正在执行当前待办时才显示⏳ running
      if (todo.id === currentTodoId && !todo._status && isExecutingCurrentTodo) status = 'running'
      li.className = 'todo-item ' + status

      const icon = document.createElement('span')
      icon.className = 'todo-icon'
      icon.textContent = getStatusIcon(status)
      li.appendChild(icon)

      const content = document.createElement('div')
      content.className = 'todo-content'
      content.innerHTML =
        `<span class="todo-id">${todo.id}</span>` +
        `<span class="todo-action">${todo.action}</span>` +
        `<span class="todo-desc">${todo.description || ''}</span>`

      // Show dataOutputKey / dataDependKeys
      const keysDiv = document.createElement('div')
      keysDiv.className = 'todo-keys'
      if (todo.dataOutputKey) {
        keysDiv.innerHTML += `<span class="key">out: ${todo.dataOutputKey}</span>`
      }
      if (Array.isArray(todo.dataDependKeys) && todo.dataDependKeys.length > 0) {
        keysDiv.innerHTML += `<span class="key">dep: ${todo.dataDependKeys.join(', ')}</span>`
      }
      if (keysDiv.innerHTML) content.appendChild(keysDiv)

      li.appendChild(content)
      list.appendChild(li)
    }

    group.appendChild(list)
    todoBody.appendChild(group)
  }

  // Append stage switch logs
  for (const log of switchLogs) {
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
  if (data.type === 'agentTodoUpdate') {
    if (data.data?.stageSwitch) {
      switchLogs.push(`${data.data.stageSwitch.reason} → ${STAGE_NAMES[data.data.stageSwitch.to] || 'Stage ' + data.data.stageSwitch.to}`)
    }
    renderTodo(data.data)
  }
})

// 通过 BroadcastChannel 告知 sidepanel 本窗口已就绪
const readyChannel = new BroadcastChannel('ai-browser-todo-ready')
readyChannel.postMessage({ type: 'todoViewerReady' })
readyChannel.close()
