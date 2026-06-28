// AI Browser Chrome Extension - 工具函数

export function esc(str) {
  const d = document.createElement('div')
  d.textContent = str || ''
  return d.innerHTML
}

export function formatTime(date) {
  if (!date) return ''
  const d = new Date(date)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function formatDate(date) {
  if (!date) return ''
  const d = new Date(date)
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function truncate(str, maxLen = 100) {
  if (!str) return ''
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str
}

export function extractPageContent() {
  // 提取页面正文内容
  const article = document.querySelector('article')
  if (article) return article.innerText.slice(0, 8000)

  // 回退：提取 main 或 body
  const main = document.querySelector('main')
  if (main) return main.innerText.slice(0, 8000)

  // 最终回退：提取所有段落
  const paragraphs = document.querySelectorAll('p')
  if (paragraphs.length > 0) {
    return [...paragraphs].map(p => p.innerText.trim()).filter(Boolean).join('\n').slice(0, 8000)
  }

  return document.body.innerText.slice(0, 8000)
}

export function getPageMetadata() {
  return {
    title: document.title || '',
    url: location.href,
    description: document.querySelector('meta[name="description"]')?.content || '',
    keywords: document.querySelector('meta[name="keywords"]')?.content || '',
  }
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export function matchUrl(urlPattern, url) {
  if (!urlPattern || urlPattern === '*') return true
  const patterns = urlPattern.split(',').map(p => p.trim()).filter(Boolean)
  return patterns.some(pattern => {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    try {
      return new RegExp('^' + regexStr + '$').test(url)
    } catch {
      return false
    }
  })
}

export function debounce(fn, delay = 300) {
  let timer
  return function (...args) {
    clearTimeout(timer)
    timer = setTimeout(() => fn.apply(this, args), delay)
  }
}

export function callService(service, method, ...args) {
  return chrome.runtime.sendMessage({
    type: 'callService',
    service,
    method,
    args,
  })
}

export function createStreamConnection(onChunk, onDone, onError) {
  const port = chrome.runtime.connect({ name: 'ai-stream' })
  port.onMessage.addListener(msg => {
    if (msg.type === 'streamChunk') onChunk(msg.content)
    else if (msg.type === 'streamDone') onDone()
    else if (msg.type === 'streamError') onError(msg.error)
  })
  port.onDisconnect.addListener(() => {
    if (onDone) onDone()
  })
  return port
}
