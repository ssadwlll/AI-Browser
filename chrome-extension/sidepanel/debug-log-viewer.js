const logBody = document.getElementById('logBody')
const toast = document.getElementById('toast')
const copyBtn = document.getElementById('copyBtn')
const clearBtn = document.getElementById('clearBtn')

// 按钮事件
copyBtn.addEventListener('click', copyAll)
clearBtn.addEventListener('click', clearAll)

function showToast(msg) {
  toast.textContent = msg
  toast.classList.add('show')
  setTimeout(() => toast.classList.remove('show'), 2000)
}

function appendLog(label, detail, level) {
  if (logBody.querySelector('.empty-state')) logBody.innerHTML = ''

  const entry = document.createElement('div')
  entry.className = 'log-entry ' + (level || '')

  const labelDiv = document.createElement('div')
  labelDiv.className = 'log-label ' + (level || 'default')
  labelDiv.textContent = label
  entry.appendChild(labelDiv)

  const detailDiv = document.createElement('div')
  detailDiv.className = 'log-detail'
  detailDiv.textContent = detail || ''
  entry.appendChild(detailDiv)

  logBody.appendChild(entry)
  logBody.scrollTop = logBody.scrollHeight
}

function copyAll() {
  const entries = logBody.querySelectorAll('.log-entry')
  if (entries.length === 0) { showToast('没有可复制的日志'); return }
  let text = ''
  entries.forEach(e => {
    const label = e.querySelector('.log-label')?.textContent || ''
    const detail = e.querySelector('.log-detail')?.textContent || ''
    text += '[' + label + ']\n' + detail + '\n\n'
  })
  navigator.clipboard.writeText(text).then(() => showToast('已复制 ' + entries.length + ' 条日志')).catch(() => showToast('复制失败'))
}

function clearAll() {
  logBody.innerHTML = '<div class="empty-state">日志已清空，等待 Agent 任务启动…</div>'
  showToast('日志已清空')
}

// 接收来自 sidepanel 的日志消息
window.addEventListener('message', (e) => {
  if (e.data?.type === 'agentDebug') {
    const level = String(e.data.label || '').includes('触发') ? 'warn'
      : String(e.data.label || '').includes('终止') ? 'error'
      : String(e.data.label || '').includes('发送LLM') || String(e.data.label || '').includes('LLM响应') ? 'info'
      : String(e.data.label || '').includes('工具') ? 'info'
      : 'default'
    appendLog(e.data.label || 'debug', e.data.detail || '', level)
  }
})

// 页面加载时告知 opener 已就绪
if (window.opener) {
  window.opener.postMessage({ type: 'debugLogReady' }, '*')
}
