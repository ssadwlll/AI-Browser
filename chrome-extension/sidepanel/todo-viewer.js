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

function getStatusIcon(status) {
  if (status === 'done') return '✅'
  if (status === 'failed') return '❌'
  if (status === 'running') return '⏳'
  return '⬜'
}

function createSpan(className, text) {
  const span = document.createElement('span')
  span.className = className
  span.textContent = text == null ? '' : String(text)
  return span
}

function renderTodo(data) {
  if (!data || !data.items || data.items.length === 0) return

  lastData = data
  overview.style.display = 'flex'
  todoBody.innerHTML = ''

  // Update overview
  const progress = data.progress || {}
  const currentTodo = progress.currentTodo
  const currentLabel = currentTodo ? `${currentTodo.id}: ${currentTodo.description || currentTodo.action}` : '无'
  ovStage.textContent = currentLabel
  ovStage.className = 'val'
  const pct = progress.percentage || 0
  ovProgressFill.style.width = pct + '%'
  ovProgress.textContent = pct + '%'
  ovDone.textContent = progress.completed || 0
  ovTotal.textContent = progress.total || 0
  if (data.lastTool) {
    const statusEmoji = data.lastProgress ? '✅' : '❌'
    ovLastTool.textContent = statusEmoji + ' ' + data.lastTool
  }

  // Find current todo id
  const currentTodoId = currentTodo?.id || null
  const currentAction = currentTodo?.action || null
  const isExecutingCurrentTodo = data.lastTool && currentAction && (
    data.lastTool === currentAction ||
    (currentAction.startsWith('inject_script_') && data.lastTool.startsWith('inject_script_'))
  )

  // Render flat list
  const list = document.createElement('ul')
  list.className = 'todo-list'

  for (const todo of data.items) {
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
    content.appendChild(createSpan('todo-id', todo.id))
    content.appendChild(createSpan('todo-action', todo.action))
    content.appendChild(createSpan('todo-desc', todo.description || ''))

    li.appendChild(content)
    list.appendChild(li)
  }

  todoBody.appendChild(list)
}

function copyAll() {
  if (!lastData || !lastData.items) {
    showToast('没有待办列表')
    return
  }
  let text = ''
  for (const todo of lastData.items) {
    const status = todo._status || (todo.id === lastData.progress?.currentTodo?.id ? 'running' : 'pending')
    text += `${getStatusIcon(status)} [${todo.id}] ${todo.action}: ${todo.description || ''}\n`
  }
  navigator.clipboard.writeText(text)
    .then(() => showToast('已复制到剪贴板'))
    .catch(() => showToast('复制失败'))
}

function clearAll() {
  lastData = null
  overview.style.display = 'none'
  todoBody.innerHTML = '<div class="empty-state">已清空，等待新任务…</div>'
  showToast('已清空')
}

// BroadcastChannel
const todoChannel = new BroadcastChannel('ai-browser-todo')
todoChannel.addEventListener('message', (e) => {
  const data = e.data
  if (!data) return
  if (data.type === 'agentTodoClear') {
    renderTodo({ items: [], progress: { total: 0, completed: 0 } })
    setTimeout(() => { window.close() }, 1000)
    return
  }
  if (data.type === 'agentTodoUpdate') {
    renderTodo(data.data)
  }
})

const readyChannel = new BroadcastChannel('ai-browser-todo-ready')
readyChannel.postMessage({ type: 'todoViewerReady' })
readyChannel.close()
