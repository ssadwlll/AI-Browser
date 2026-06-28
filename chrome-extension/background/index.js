// ============================================================
// AI Browser Chrome Extension - Background Service Worker
// ============================================================

// ============ 常量 ============
const MSG_TYPES = {
  CALL_SERVICE: 'callService',
  STREAM_START: 'streamStart',
  STREAM_CHUNK: 'streamChunk',
  STREAM_DONE: 'streamDone',
  STREAM_ERROR: 'streamError',
  OPEN_SIDEBAR: 'openSidebar',
  CLOSE_SIDEBAR: 'closeSidebar',
  TOGGLE_SIDEBAR: 'toggleSidebar',
  SELECTION_ACTION: 'selectionAction',
  PAGE_SUMMARY: 'pageSummary',
  EXECUTE_SCRIPT: 'executeScript',
  SYNC_SCRIPTS: 'syncScripts',
}

const DEFAULT_AI_CONFIG = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: 'qwen2.5:7b',
  temperature: 0.7,
  maxTokens: 4096,
  systemPrompt: '你是 AI Browser 助手，可以帮助用户分析网页内容、回答问题、编写代码和执行操作。',
}

const DEFAULT_SYNC_CONFIG = {
  serverUrl: 'http://localhost:3001',
  token: '',
  syncInterval: 30,
  enabled: true,
}

// ============ ConfigService ============
class ConfigService {
  async getAIConfig() {
    const data = await chrome.storage.local.get('aiConfig')
    return { ...DEFAULT_AI_CONFIG, ...(data.aiConfig || {}) }
  }

  async saveAIConfig(config) {
    const merged = { ...DEFAULT_AI_CONFIG, ...config }
    await chrome.storage.local.set({ aiConfig: merged })
    return merged
  }

  async getSyncConfig() {
    const data = await chrome.storage.local.get('syncConfig')
    return { ...DEFAULT_SYNC_CONFIG, ...(data.syncConfig || {}) }
  }

  async saveSyncConfig(config) {
    const merged = { ...DEFAULT_SYNC_CONFIG, ...config }
    await chrome.storage.local.set({ syncConfig: merged })
    return merged
  }

  async getSidebarMode() {
    const data = await chrome.storage.local.get('sidebarMode')
    return data.sidebarMode || 'sidepanel' // sidepanel | floating
  }

  async saveSidebarMode(mode) {
    await chrome.storage.local.set({ sidebarMode: mode })
  }

  async getSelectionToolsEnabled() {
    const data = await chrome.storage.local.get('selectionToolsEnabled')
    return data.selectionToolsEnabled !== false
  }

  async saveSelectionToolsEnabled(enabled) {
    await chrome.storage.local.set({ selectionToolsEnabled: enabled })
  }
}

// ============ StorageService ============
class StorageService {
  async get(key) {
    const data = await chrome.storage.local.get(key)
    return data[key]
  }

  async set(key, value) {
    await chrome.storage.local.set({ [key]: value })
  }

  async getChatHistory() {
    const data = await chrome.storage.local.get('chatHistory')
    return data.chatHistory || []
  }

  async saveChatHistory(history) {
    // 只保留最近 50 条
    const trimmed = history.slice(-50)
    await chrome.storage.local.set({ chatHistory: trimmed })
  }

  async appendChatMessage(message) {
    const history = await this.getChatHistory()
    history.push(message)
    await this.saveChatHistory(history)
    return history
  }

  async clearChatHistory() {
    await chrome.storage.local.set({ chatHistory: [] })
  }
}

// ============ AIService ============
class AIService {
  async chat(messages, options = {}) {
    const config = await configService.getAIConfig()
    const mergedConfig = { ...config, ...options }

    const body = {
      model: mergedConfig.model,
      messages: messages,
      temperature: mergedConfig.temperature,
      max_tokens: mergedConfig.maxTokens,
    }

    if (mergedConfig.systemPrompt && messages[0]?.role !== 'system') {
      body.messages = [{ role: 'system', content: mergedConfig.systemPrompt }, ...messages]
    }

    const headers = {
      'Content-Type': 'application/json',
    }
    if (mergedConfig.apiKey) {
      headers['Authorization'] = `Bearer ${mergedConfig.apiKey}`
    }

    try {
      // 智能处理 baseUrl：如果已包含 /chat/completions 则不再拼接
      let url = mergedConfig.baseUrl
      if (url.endsWith('/chat/completions')) {
        // 用户填了完整路径，直接用
      } else if (url.endsWith('/chat/completions/')) {
        url = url.slice(0, -1)
      } else {
        url = url.replace(/\/+$/, '') + '/chat/completions'
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`AI API 错误: ${res.status} ${text.slice(0, 200)}`)
      }

      const data = await res.json()
      const content = data.choices?.[0]?.message?.content || ''
      return { content, usage: data.usage, model: data.model }
    } catch (e) {
      console.error('[AIService] chat error:', e)
      throw e
    }
  }

  // 流式对话 - 通过 Port 长连接传输
  async chatStream(port, messages, options = {}) {
    const config = await configService.getAIConfig()
    const mergedConfig = { ...config, ...options }

    const body = {
      model: mergedConfig.model,
      messages: messages,
      temperature: mergedConfig.temperature,
      max_tokens: mergedConfig.maxTokens,
      stream: true,
    }

    if (mergedConfig.systemPrompt && messages[0]?.role !== 'system') {
      body.messages = [{ role: 'system', content: mergedConfig.systemPrompt }, ...messages]
    }

    const headers = {
      'Content-Type': 'application/json',
    }
    if (mergedConfig.apiKey) {
      headers['Authorization'] = `Bearer ${mergedConfig.apiKey}`
    }

    try {
      // 智能处理 baseUrl
      let url = mergedConfig.baseUrl
      if (url.endsWith('/chat/completions')) {
        // 用户填了完整路径，直接用
      } else if (url.endsWith('/chat/completions/')) {
        url = url.slice(0, -1)
      } else {
        url = url.replace(/\/+$/, '') + '/chat/completions'
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text()
        port.postMessage({ type: 'streamError', error: `AI API 错误: ${res.status} ${text.slice(0, 100)}` })
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') {
            port.postMessage({ type: 'streamDone' })
            return
          }
          try {
            const parsed = JSON.parse(data)
            const content = parsed.choices?.[0]?.delta?.content || ''
            if (content) {
              port.postMessage({ type: 'streamChunk', content })
            }
          } catch {}
        }
      }

      port.postMessage({ type: 'streamDone' })
    } catch (e) {
      console.error('[AIService] stream error:', e)
      try {
        port.postMessage({ type: 'streamError', error: e.message })
      } catch {}
    }
  }
}

// ============ ScriptService ============
class ScriptService {
  async getScripts() {
    const data = await chrome.storage.local.get('scripts')
    return data.scripts || []
  }

  async saveScripts(scripts) {
    await chrome.storage.local.set({ scripts, lastSync: Date.now() })
  }

  async syncScripts() {
    const config = await configService.getSyncConfig()
    if (!config.serverUrl || !config.token) {
      console.warn('[ScriptService] 未配置服务器地址或Token')
      await chrome.storage.local.set({ syncError: '未配置服务器地址或Token' })
      return { ok: false, error: '未配置' }
    }

    try {
      const res = await fetch(`${config.serverUrl}/api/scripts?pageSize=100`, {
        headers: { Authorization: `Bearer ${config.token}` },
      })
      if (!res.ok) {
        const text = await res.text()
        await chrome.storage.local.set({ syncError: `HTTP ${res.status}` })
        return { ok: false, error: `HTTP ${res.status}` }
      }
      const data = await res.json()
      if (data.success && Array.isArray(data.data)) {
        const oldScripts = await this.getScripts()
        const oldMap = {}
        for (const s of oldScripts) oldMap[s.id] = s.enabled

        const scripts = data.data.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description || '',
          version: s.version || '1.0.0',
          urlPattern: s.url_pattern || '*',
          category: s.category_name || '',
          downloadCount: s.download_count || 0,
          enabled: oldMap[s.id] !== undefined ? oldMap[s.id] : true,
          code: null,
          hasModules: s.module_count > 0,
        }))
        await this.saveScripts(scripts)
        await chrome.storage.local.set({ syncError: null })
        console.log('[ScriptService] 同步成功，', scripts.length, '个脚本')
        return { ok: true, count: scripts.length }
      }
      const errMsg = data.error || data.message || '同步失败'
      await chrome.storage.local.set({ syncError: errMsg })
      return { ok: false, error: errMsg }
    } catch (e) {
      console.error('[ScriptService] 同步异常:', e)
      await chrome.storage.local.set({ syncError: e.message })
      return { ok: false, error: e.message }
    }
  }

  async fetchInjectData(scriptId) {
    const config = await configService.getSyncConfig()
    if (!config.serverUrl || !config.token) return null
    try {
      const res = await fetch(`${config.serverUrl}/api/scripts/${scriptId}/inject`, {
        headers: { Authorization: `Bearer ${config.token}` },
      })
      const data = await res.json()
      if (data.success && data.data) return data.data
    } catch (e) {
      console.error('[ScriptService] fetchInjectData error:', e)
    }
    return null
  }

  matchUrl(urlPattern, url) {
    if (!urlPattern || urlPattern === '*') return true
    const patterns = urlPattern.split(',').map(p => p.trim()).filter(Boolean)
    return patterns.some(pattern => {
      const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
      try { return new RegExp('^' + regexStr + '$').test(url) } catch { return false }
    })
  }

  async injectScriptsForTab(tabId, url) {
    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return
    const config = await configService.getSyncConfig()
    if (!config.enabled) return

    const scripts = await this.getScripts()
    const matched = scripts.filter(s => s.enabled && this.matchUrl(s.urlPattern, url))

    for (const script of matched) {
      const injectData = await this.fetchInjectData(script.id)
      if (!injectData?.code) continue

      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (scriptCode) => {
            try {
              const el = document.createElement('script')
              el.textContent = scriptCode
              ;(document.head || document.documentElement).appendChild(el)
              el.remove()
            } catch (e) {
              console.error('[AI Browser 脚本中心] 注入错误:', e)
            }
          },
          args: [injectData.code],
          world: 'MAIN',
        })
        console.log('[ScriptService] 注入成功:', injectData.name)
      } catch (e) {
        console.warn('[ScriptService] 注入失败:', e.message)
      }
    }
  }

  async toggleScript(scriptId, enabled) {
    const scripts = await this.getScripts()
    const idx = scripts.findIndex(s => s.id === scriptId)
    if (idx >= 0) {
      scripts[idx].enabled = enabled
      await this.saveScripts(scripts)
      return true
    }
    return false
  }

  async deleteScript(scriptId) {
    const scripts = await this.getScripts()
    const filtered = scripts.filter(s => s.id !== scriptId)
    await this.saveScripts(filtered)
    return true
  }
}

// ============ SidebarService ============
class SidebarService {
  async open(tabId) {
    try {
      await chrome.sidePanel.open({ tabId })
    } catch (e) {
      console.warn('[SidebarService] open error:', e.message)
    }
  }

  async close(tabId) {
    try {
      await chrome.sidePanel.setOptions({ tabId, enabled: false })
      setTimeout(() => chrome.sidePanel.setOptions({ tabId, enabled: true }), 100)
    } catch (e) {
      console.warn('[SidebarService] close error:', e.message)
    }
  }

  async setMode(mode) {
    await chrome.storage.local.set({ sidebarMode: mode })
  }

  setupPanelBehavior() {
    try {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    } catch (e) {
      console.warn('[SidebarService] setPanelBehavior error:', e.message)
    }
  }
}

// ============ PageService ============
class PageService {
  async getContent() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) return null

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'extractPageContent',
      })
      return response?.data || null
    } catch (e) {
      console.warn('[PageService] getContent error:', e.message)
      return null
    }
  }

  async executeScript(code) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) throw new Error('No active tab')

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (scriptCode) => {
          try {
            // 用 new Function 执行，绕过页面CSP（因为 func 本身不受CSP限制）
            new Function(scriptCode)()
            return undefined
          } catch (e) {
            return { __error: e.message }
          }
        },
        args: [code],
        world: 'MAIN',
      })
      const result = results[0]?.result
      if (result?.__error) {
        return { ok: false, error: result.__error }
      }
      return { ok: true, result }
    } catch (e) {
      console.warn('[PageService] executeScript error:', e.message)
      return { ok: false, error: e.message }
    }
  }

  // 一站式注入：从服务器拉代码 + 注入到页面
  async injectToolboxScript(scriptId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return { ok: false, error: 'No active tab' }

    // 从服务器获取脚本代码
    const injectData = await scriptService.fetchInjectData(scriptId)
    if (!injectData?.code) return { ok: false, error: '无法获取脚本代码' }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (scriptCode) => {
          try {
            new Function(scriptCode)()
            return undefined
          } catch (e) {
            return { __error: e.message }
          }
        },
        args: [injectData.code],
        world: 'MAIN',
      })
      const result = results[0]?.result
      if (result?.__error) {
        return { ok: false, error: result.__error }
      }
      return { ok: true }
    } catch (e) {
      console.warn('[PageService] injectToolboxScript error:', e.message)
      return { ok: false, error: e.message }
    }
  }
}

// ============ 服务实例 ============
const configService = new ConfigService()
const storageService = new StorageService()
const aiService = new AIService()
const scriptService = new ScriptService()
const sidebarService = new SidebarService()
const pageService = new PageService()

const services = {
  configService,
  storageService,
  aiService,
  scriptService,
  sidebarService,
  pageService,
}

// ============ 消息路由 ============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === MSG_TYPES.CALL_SERVICE) {
    const { service, method, args } = msg
    const svc = services[service]
    if (!svc) {
      sendResponse({ error: `Service not found: ${service}`, data: null })
      return true
    }
    if (!svc[method]) {
      sendResponse({ error: `Method not found: ${service}.${method}`, data: null })
      return true
    }
    svc[method](...(args || []))
      .then(data => sendResponse({ error: null, data }))
      .catch(err => sendResponse({ error: err.message, data: null }))
    return true
  }

  // 打开侧边栏（来自 content script 的划词操作等）
  if (msg.type === 'openSidebar') {
    const tabId = sender.tab?.id
    if (tabId) {
      sidebarService.open(tabId)
    }
    sendResponse({ ok: true })
    return false
  }

  return false
})

// ============ Port 流式连接 ============
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'ai-stream') {
    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'streamStart') {
        await aiService.chatStream(port, msg.messages, msg.options || {})
      }
    })
  }
})

// ============ 事件监听 ============

// 扩展安装/启动时同步脚本
chrome.runtime.onInstalled.addListener(() => {
  scriptService.syncScripts()
  sidebarService.setupPanelBehavior()
})

// 定时同步
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync-scripts') {
    scriptService.syncScripts()
  }
})

async function setupAlarm() {
  const config = await configService.getSyncConfig()
  chrome.alarms.clear('sync-scripts', () => {
    chrome.alarms.create('sync-scripts', { periodInMinutes: config.syncInterval })
  })
}
setupAlarm()

// 右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'ai-browser-summarize',
    title: 'AI 总结此页面',
    contexts: ['page'],
  })
  chrome.contextMenus.create({
    id: 'ai-browser-translate',
    title: '翻译此页面',
    contexts: ['page'],
  })
  chrome.contextMenus.create({
    id: 'ai-browser-explain',
    title: 'AI 解释选中文字',
    contexts: ['selection'],
  })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (tab?.id) {
    const action = info.menuItemId.replace('ai-browser-', '')
    chrome.tabs.sendMessage(tab.id, {
      type: MSG_TYPES.SELECTION_ACTION,
      action,
      text: info.selectionText || '',
    })
  }
})

// 快捷键
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-sidebar') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab) sidebarService.open(tab.id)
  }
})

console.log('[AI Browser] Background Service Worker started')
