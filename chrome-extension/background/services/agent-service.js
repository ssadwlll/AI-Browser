import { PayloadStore } from './payload-store.js'
import { DomainPolicy } from './domain-policy.js'
import { TodoScheduler } from './todo-scheduler.js'
import { runAgent } from './agent-runner.js'

// ============ AgentService ============
export class AgentService {
  constructor(configService, toolService, pageService, scriptService) {
    this.configService = configService
    this.toolService = toolService
    this.pageService = pageService
    this.scriptService = scriptService
    this.MAX_AI_REQUESTS = 15
    this.MAX_TOOL_CALLS = 30
    this.TIMEOUT_MS = 600000
    this.ACTION_TIMEOUT_MS = 60000
    this.agentStates = new Map()
    this.domainPolicy = new DomainPolicy(configService, scriptService)
    this._filteredScriptsCache = new Map()
    this._domainMismatchLogged = new Set()
    this._pageReadCache = new Map()
    this.payloadStore = new PayloadStore()
    this.todoScheduler = new TodoScheduler()
  }

  // Plan B: 入口方法，管理 Port 绑定
  async startAgent(port, userMessage, chatHistory) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const tabId = tab?.id
    if (!tabId) {
      try { port.postMessage({ type: 'agentError', error: '无法获取标签页' }) } catch {}
      return
    }

    const existingState = this.agentStates.get(tabId)
    if (existingState?.running) {
      this.attachPort(tabId, port)
      return
    }
    if (existingState) {
      this.agentStates.delete(tabId)
    }

    const tabUrl = tab?.url || ''
    if (tabUrl.startsWith('chrome://') || tabUrl.startsWith('chrome-extension://') || tabUrl.startsWith('edge://') || tabUrl.startsWith('about:')) {
      try { port.postMessage({ type: 'agentError', error: 'Agent 无法在系统页面上运行，请在普通网页上使用。' }) } catch {}
      return
    }

    const state = { port, messages: [], running: true, tabId, tabUrl }
    this.agentStates.set(tabId, state)

    try {
      await this.run(tabId, userMessage, chatHistory)
    } finally {
      const state = this.agentStates.get(tabId)
      if (state) state.running = false
      this.payloadStore.clear()
      setTimeout(() => {
        this.agentStates.delete(tabId)
      }, 30000)
    }
  }

  isRunning(tabId) {
    const state = this.agentStates.get(tabId)
    return !!(state?.running)
  }

  attachPort(tabId, port) {
    const state = this.agentStates.get(tabId)
    if (!state) return
    state.port = port
    if (state.messages.length > 0) {
      console.log('[Agent] Port 重连，回放', state.messages.length, '条消息')
      for (const msg of state.messages) {
        try { port.postMessage(msg) } catch { break }
      }
      state.messages = []
    }
  }

  detachPortByPort(port) {
    for (const [tabId, state] of this.agentStates) {
      if (state.port === port) {
        console.log('[Agent] Port 断开，Agent 继续运行 (tabId:', tabId, ')')
        state.port = null
        return
      }
    }
  }

  postToUI(tabId, msg) {
    const state = this.agentStates.get(tabId)
    if (!state) return
    if (state.port) {
      try {
        state.port.postMessage(msg)
      } catch {
        state.port = null
        state.messages.push(msg)
      }
    } else {
      state.messages.push(msg)
    }
  }

  async _yieldUI() {
    await new Promise(r => setTimeout(r, 0))
  }

  // 主运行循环 — 委托给 agent-runner.js
  async run(tabId, userMessage, chatHistory) {
    await runAgent({
      configService: this.configService,
      toolService: this.toolService,
      scriptService: this.scriptService,
      agentStates: this.agentStates,
      domainPolicy: this.domainPolicy,
      payloadStore: this.payloadStore,
      todoScheduler: this.todoScheduler,
      filteredScriptsCache: this._filteredScriptsCache,
      domainMismatchLogged: this._domainMismatchLogged,
      pageReadCache: this._pageReadCache,
      MAX_AI_REQUESTS: this.MAX_AI_REQUESTS,
      TIMEOUT_MS: this.TIMEOUT_MS,
      ACTION_TIMEOUT_MS: this.ACTION_TIMEOUT_MS,
      postToUI: this.postToUI.bind(this),
      yieldUI: this._yieldUI,
      tabId,
      userMessage,
      chatHistory,
    })
  }
}
