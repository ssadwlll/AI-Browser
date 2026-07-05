import { PayloadStore } from './payload-store.js'
import { DomainPolicy } from './domain-policy.js'
import { TodoScheduler } from './todo-scheduler.js'
import { runAgent } from './agent-runner.js'
import { isSystemUrl } from '../../shared/utils.js'

// ============ AgentService ============
export class AgentService {
  constructor(configService, toolService, pageService, scriptService, toolRecordingService, agentResumeService) {
    this.configService = configService
    this.toolService = toolService
    this.pageService = pageService
    this.scriptService = scriptService
    this.toolRecordingService = toolRecordingService || null
    this.agentResumeService = agentResumeService || null
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
  async startAgent(port, userMessage, chatHistory, modelInfo) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const tabId = tab?.id
    if (!tabId) {
      try { port.postMessage({ type: 'agentError', error: '无法获取标签页' }) } catch {}
      return
    }

    const existingState = this.agentStates.get(tabId)
    if (existingState?.running) {
      // 中止旧 Agent，允许新任务启动
      existingState.aborted = true
      existingState.running = false
      console.log(`[AgentService] 中止旧 Agent (tabId=${tabId})，启动新任务`)
      // 等待一小段时间让旧循环退出
      await new Promise(r => setTimeout(r, 300))
    }
    this.agentStates.delete(tabId)

    // 立即清除待办调度器，避免旧任务待办残留
    // PayloadStore: 继承上一轮数据供复用（如"导出csv给我"场景）
    this.todoScheduler.clear()
    this._pageReadCache.clear()
    // 设置新 sessionId 并继承上一轮数据
    const newSessionId = `s_${tabId}_${Date.now()}`
    this.payloadStore.setSessionId(newSessionId)
    this.payloadStore.inheritFromLastSession(newSessionId, 300000)  // 5分钟内的数据可继承

    // 通知待办查看器窗口和 content script 清除旧数据
    try {
      const bc = new BroadcastChannel('ai-browser-todo')
      bc.postMessage({ type: 'agentTodoClear' })
      bc.close()
    } catch {}
    try {
      chrome.tabs.sendMessage(tabId, { type: 'todoUpdate', data: { stages: [], progress: { total: 0, completed: 0 } } }).catch(() => {})
    } catch {}

    // 对话全景：清空旧数据并根据设置自动打开窗口
    try {
      const bcConv = new BroadcastChannel('ai-browser-conversation')
      bcConv.postMessage({ type: 'conversationClear' })
      bcConv.close()
    } catch {}
    try {
      const agentCfg = await this.configService.getAgentConfig()
      if (agentCfg?.conversationViewer === true) {
        chrome.windows.create({
          url: chrome.runtime.getURL('sidepanel/conversation-viewer.html'),
          type: 'popup',
          width: 900,
          height: 700,
          focused: false  // 不抢占焦点
        })
      }
    } catch (e) { console.warn('[ConversationViewer] 打开失败:', e.message) }

    const tabUrl = tab?.url || ''
    if (isSystemUrl(tabUrl)) {
      try { port.postMessage({ type: 'agentError', error: 'Agent 无法在系统页面上运行，请在普通网页上使用。' }) } catch {}
      return
    }

    const state = { port, messages: [], running: true, tabId, tabUrl }
    this.agentStates.set(tabId, state)

    // Feature 4: 启动工具调用录制会话
    if (this.toolRecordingService) {
      try { this.toolRecordingService.startSession(userMessage) } catch (e) { console.warn('[ToolRecording] startSession 失败:', e.message) }
    }
    // Feature 6: 启动 Agent 断点续传快照（stateProvider 返回当前状态快照）
    if (this.agentResumeService) {
      try {
        this.agentResumeService.startPeriodicSnapshot(tabId, () => ({
          userMessage,
          tabUrl,
          isFinished: false,
          todoState: {
            currentTodoIndex: this.todoScheduler.currentTodoIndex || 0,
            totalCompleted: this.todoScheduler.getProgress()?.completed || 0,
            totalTodos: this.todoScheduler.getProgress()?.total || 0,
          },
        }))
      } catch (e) { console.warn('[AgentResume] startPeriodicSnapshot 失败:', e.message) }
    }

    try {
      await this.run(tabId, userMessage, chatHistory, modelInfo)
    } finally {
      const state = this.agentStates.get(tabId)
      if (state) state.running = false
      // 注意：不清除 payloadStore，保留上轮结果供后续 generate_script(data_refs=...) 复用
      // （避免用户说"导出结果"时 agent 无法访问上轮数据而重新执行）
      // 清理本次运行缓存的页面内容，防止跨任务累积内存占用
      this._pageReadCache.clear()
      // domainMismatchLogged 限制大小，防止跨大量域名累积
      if (this._domainMismatchLogged.size > 100) this._domainMismatchLogged.clear()
      // Feature 4: 停止工具调用录制会话
      if (this.toolRecordingService) {
        try { this.toolRecordingService.stopSession(tabId) } catch (e) { console.warn('[ToolRecording] stopSession 失败:', e.message) }
      }
      // Feature 6: 停止快照并标记任务已结束
      if (this.agentResumeService) {
        try {
          this.agentResumeService.stopPeriodicSnapshot(tabId)
          this.agentResumeService.markFinished(tabId)
        } catch (e) { console.warn('[AgentResume] cleanup 失败:', e.message) }
      }
      // 延迟清理状态以便 sidepanel 重连查看结果；但若期间有新 Agent 启动则不删除
      setTimeout(() => {
        const cur = this.agentStates.get(tabId)
        // 仅当当前状态非运行中时才清理，避免误删新启动的 Agent
        if (cur && !cur.running) {
          this.agentStates.delete(tabId)
        }
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
      // 只清除已成功发送的消息，未发送的保留以便下次重连重试
      let sentCount = 0
      for (const msg of state.messages) {
        try { port.postMessage(msg); sentCount++ } catch { break }
      }
      state.messages = state.messages.slice(sentCount)
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

  /**
   * 检查 port 是否仍然连接（用于在每轮循环开始时检测 UI 是否已关闭）
   * 返回 true 表示连接正常，false 表示断开
   */
  checkPortConnected(tabId) {
    const state = this.agentStates.get(tabId)
    if (!state) return false
    if (!state.port) return false
    // 尝试发送一条心跳消息，失败则标记为断开
    try {
      state.port.postMessage({ type: 'heartbeat' })
      return true
    } catch {
      state.port = null
      console.log('[AgentService] Port 已断开，任务将被终止')
      return false
    }
  }

  async _yieldUI() {
    await new Promise(r => setTimeout(r, 0))
  }

  // 主运行循环 — 委托给 agent-runner.js
  async run(tabId, userMessage, chatHistory, modelInfo) {
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
      checkPortConnected: this.checkPortConnected.bind(this),
      tabId,
      userMessage,
      chatHistory,
      // 模型单独配置（temperature / context_window / max_tokens），覆盖全局 aiConfig
      // 用于 Agent 模式按模型读取后端配置
      modelInfo: modelInfo || null,
      toolRecordingService: this.toolRecordingService, // Feature 4
    })
  }
}
