// ============ AgentService - Agent 服务管理（Electron 主进程版） ============
// 迁移自 chrome-extension/background/services/agent-service.js
//
// 关键适配：
//   - Port 管理 → 基于 tabId 的状态管理（agentStates Map）
//   - startAgent(port, ...) → startAgent(tabId, userMessage, chatHistory, modelInfo, sendEvent)
//   - attachPort/detachPort → 不需要（Electron 用 IPC，不需要 Port 管理）
//   - postToUI(tabId, msg) → sendEvent(channel, msg) 直接发送
//   - checkPortConnected → isAborted() 检查
//   - 保留：agentStates Map 管理、sessionId 生成、PayloadStore/TodoScheduler 初始化、录制/续传启动

const { runAgent, PayloadStoreAdapter } = require('./agent_runner')
const PayloadStore = require('./payload_store')
const TodoScheduler = require('./todo_scheduler')
const GlobalDataStore = require('./global_data_store')

// ============================================================
// DomainPolicy - 域名安全策略（内联简化版）
// 从 agentConfig 读取允许的域名列表，拦截不在白名单中的导航
// ============================================================
class DomainPolicy {
  constructor(configService, scriptService) {
    this.configService = configService
    this.scriptService = scriptService
    this._allowedDomains = new Set()
    this._loaded = false
  }

  /** 加载域名策略（幂等，仅首次执行） */
  async load() {
    if (this._loaded) return
    try {
      const agentConfig = await this.configService.getAgentConfig()
      const domains = agentConfig?.allowedDomains || agentConfig?.allowed_domains || []
      if (Array.isArray(domains)) {
        this._allowedDomains = new Set(domains.map(d => String(d).toLowerCase()))
      }
      this._loaded = true
      console.log('[DomainPolicy] 已加载域名策略，允许域名:', [...this._allowedDomains])
    } catch (e) {
      console.warn('[DomainPolicy] 加载失败，默认全部允许:', e.message)
      this._loaded = true
    }
  }

  /** 检查 URL 是否在允许的域名范围内 */
  isUrlAllowed(url) {
    // 未配置域名白名单时，默认全部允许
    if (this._allowedDomains.size === 0) return true
    if (!url || typeof url !== 'string') return true
    // 非标准 URL（about:, chrome:, file: 等）默认允许
    if (!url.startsWith('http://') && !url.startsWith('https://')) return true
    try {
      const host = new URL(url).hostname.toLowerCase()
      for (const domain of this._allowedDomains) {
        const d = domain.toLowerCase()
        if (host === d || host.endsWith('.' + d)) return true
      }
      return false
    } catch {
      return true
    }
  }
}

// ============================================================
// AgentService - Agent 服务管理
// ============================================================
class AgentService {
  /**
   * @param {object} configService - ConfigService 实例
   * @param {object} toolService - 工具/脚本服务（searchScripts/fetchAgentIndex/executeTool/fetchReportTemplates）
   * @param {object} pageService - 页面服务
   * @param {object} scriptService - 脚本匹配服务（matchUrl 等）
   * @param {object} toolRecordingService - ToolRecordingService 实例
   * @param {object} agentResumeService - AgentResumeService 实例
   * @param {object} tabManager - TabManager 实例（替代 chrome.tabs）
   * @param {object} actionExecutor - ActionExecutor 实例（用于 collectPageContext 等）
   */
  constructor(configService, toolService, pageService, scriptService, toolRecordingService, agentResumeService, tabManager, actionExecutor, sharedDeps = {}) {
    this.configService = configService
    this.toolService = toolService
    this.pageService = pageService
    this.scriptService = scriptService
    this.toolRecordingService = toolRecordingService
    this.agentResumeService = agentResumeService
    this.tabManager = tabManager
    this.actionExecutor = actionExecutor

    // ===== 状态管理：tabId → agentState =====
    this.agentStates = new Map()

    // ===== 域名安全策略 =====
    this.domainPolicy = new DomainPolicy(configService, scriptService)

    // ===== PayloadStore（优先使用外部传入的共享实例） =====
    this.payloadStore = sharedDeps.payloadStore || new PayloadStore()
    this.payloadStoreAdapter = new PayloadStoreAdapter(this.payloadStore)
    this._payloadStoreReady = !!sharedDeps.payloadStore // 外部传入的已初始化

    // ===== 全局数据存储 + 待办调度器（优先使用外部传入的共享实例） =====
    this.globalDataStore = sharedDeps.globalDataStore || new GlobalDataStore()
    this.todoScheduler = sharedDeps.todoScheduler || new TodoScheduler(this.globalDataStore)

    // ===== 缓存 =====
    this.filteredScriptsCache = new Map()   // tabId → filteredScripts[]
    this.domainMismatchLogged = new Set()   // 已记录域名不匹配的 tabId
    this.pageReadCache = new Map()          // pageUrl → 读取结果

    // ===== 上限常量 =====
    this.MAX_AI_REQUESTS = 30       // 最大 AI 请求轮次
    this.TIMEOUT_MS = 600000        // 全局超时 10 分钟
    this.ACTION_TIMEOUT_MS = 30000  // 单个工具操作超时 30 秒

    // 初始化 PayloadStore（异步，不阻塞构造函数）
    this._initPayloadStore()
  }

  /** 异步初始化 PayloadStore */
  async _initPayloadStore() {
    try {
      await this.payloadStore.init()
      this._payloadStoreReady = true
      console.log('[AgentService] PayloadStore 初始化完成')
    } catch (e) {
      console.warn('[AgentService] PayloadStore 初始化失败:', e.message)
      this._payloadStoreReady = true // 即使失败也标记为已尝试，避免重复初始化
    }
  }

  /** 确保 PayloadStore 已初始化 */
  async _ensurePayloadStore() {
    if (!this._payloadStoreReady) {
      await this._initPayloadStore()
    }
  }

  /**
   * 启动 Agent（入口方法）
   * 初始化状态、启动录制/续传、委托 runAgent 执行
   * @param {number} tabId - 标签页 ID
   * @param {string} userMessage - 用户任务描述
   * @param {Array} chatHistory - 聊天历史
   * @param {object} modelInfo - 模型信息（temperature, maxTokens, contextWindow 等）
   * @param {function} sendEvent - 事件发送函数 (channel, data) => void
   */
  async startAgent(tabId, userMessage, chatHistory, modelInfo, sendEvent) {
    // 检查是否已有 Agent 在运行
    if (this.isRunning(tabId)) {
      console.warn(`[AgentService] 标签页 ${tabId} 已有 Agent 在运行，拒绝重复启动`)
      sendEvent('agentError', { error: '该标签页已有 Agent 在运行，请等待完成或先中止' })
      return
    }

    // 确保 PayloadStore 已初始化
    await this._ensurePayloadStore()

    // 生成 sessionId
    const sessionId = `s_${tabId}_${Date.now()}`

    // 初始化 Agent 状态
    const state = {
      tabId,
      sessionId,
      userMessage,
      chatHistory: chatHistory || [],
      modelInfo: modelInfo || {},
      sendEvent,
      running: true,
      aborted: false,
      startTime: Date.now(),
      totalRounds: 0,
      totalToolCalls: 0,
    }
    this.agentStates.set(tabId, state)

    console.log(`[AgentService] 启动 Agent: tabId=${tabId}, sessionId=${sessionId}, 任务="${userMessage?.slice(0, 50)}..."`)

    // 初始化 PayloadStore 会话
    this.payloadStoreAdapter.setSessionId(sessionId)

    // 清理上一轮的全局数据存储（保留 PayloadStore 数据供跨对话引用）
    this.globalDataStore.clear()
    this.payloadStoreAdapter.clearSessionData()

    // 启动工具录制
    if (this.toolRecordingService) {
      try {
        this.toolRecordingService.startSession(userMessage)
        console.log('[AgentService] 工具录制已启动')
      } catch (e) {
        console.warn('[AgentService] 工具录制启动失败（非致命）:', e.message)
      }
    }

    // 启动续传快照
    if (this.agentResumeService) {
      try {
        this.agentResumeService.startPeriodicSnapshot(tabId, () => {
          const s = this.agentStates.get(tabId)
          return {
            tabId,
            sessionId,
            userMessage,
            startTime: s?.startTime || Date.now(),
            running: s?.running || false,
          }
        })
        console.log(`[AgentService] 续传快照已启动: tabId=${tabId}`)
      } catch (e) {
        console.warn('[AgentService] 续传快照启动失败（非致命）:', e.message)
      }
    }

    // 委托给 run 方法
    try {
      await this.run(tabId, userMessage, chatHistory, modelInfo, sendEvent)
    } finally {
      // ===== 清理状态 =====
      const finalState = this.agentStates.get(tabId)
      if (finalState) {
        finalState.running = false
      }

      // 停止工具录制
      if (this.toolRecordingService) {
        try {
          await this.toolRecordingService.stopSession()
          console.log('[AgentService] 工具录制已停止')
        } catch (e) {
          console.warn('[AgentService] 工具录制停止失败（非致命）:', e.message)
        }
      }

      // 停止续传快照并标记完成
      if (this.agentResumeService) {
        try {
          this.agentResumeService.stopPeriodicSnapshot(tabId)
          await this.agentResumeService.markFinished(tabId)
          console.log(`[AgentService] 续传快照已停止: tabId=${tabId}`)
        } catch (e) {
          console.warn('[AgentService] 续传快照停止失败（非致命）:', e.message)
        }
      }

      // 刷盘 PayloadStore 残留脏数据
      try { await this.payloadStore.flush() } catch (e) { /* 非致命 */ }

      console.log(`[AgentService] Agent 结束: tabId=${tabId}, 总轮次=${finalState?.totalRounds || 0}, 总工具调用=${finalState?.totalToolCalls || 0}`)
    }
  }

  /**
   * 执行 Agent 主循环（委托给 runAgent）
   * 可直接调用以跳过 startAgent 的初始化逻辑（如恢复执行）
   * @param {number} tabId - 标签页 ID
   * @param {string} userMessage - 用户任务描述
   * @param {Array} chatHistory - 聊天历史
   * @param {object} modelInfo - 模型信息
   * @param {function} sendEvent - 事件发送函数 (channel, data) => void
   */
  async run(tabId, userMessage, chatHistory, modelInfo, sendEvent) {
    // isAborted：检查是否被中止（替代 checkPortConnected）
    const isAborted = () => {
      const s = this.agentStates.get(tabId)
      return !s || s.aborted
    }

    // yieldUI：让出事件循环，避免阻塞 Electron 主进程
    const yieldUI = () => new Promise(resolve => setImmediate(resolve))

    // 构建运行上下文
    const ctx = {
      // 服务实例
      configService: this.configService,
      toolService: this.toolService,
      scriptService: this.scriptService,
      tabManager: this.tabManager,
      toolExecutor: this.actionExecutor,
      actionExecutor: this.actionExecutor,

      // 状态与策略
      agentStates: this.agentStates,
      domainPolicy: this.domainPolicy,
      payloadStore: this.payloadStoreAdapter,
      todoScheduler: this.todoScheduler,

      // 缓存
      filteredScriptsCache: this.filteredScriptsCache,
      domainMismatchLogged: this.domainMismatchLogged,
      pageReadCache: this.pageReadCache,

      // 上限常量
      MAX_AI_REQUESTS: this.MAX_AI_REQUESTS,
      TIMEOUT_MS: this.TIMEOUT_MS,
      ACTION_TIMEOUT_MS: this.ACTION_TIMEOUT_MS,

      // 回调函数
      sendEvent,
      isAborted,
      yieldUI,

      // 任务参数
      tabId,
      userMessage,
      chatHistory: chatHistory || [],
      modelInfo: modelInfo || {},

      // 辅助服务
      toolRecordingService: this.toolRecordingService,
      agentResumeService: this.agentResumeService,
    }

    // 委托给 runAgent
    await runAgent(ctx)
  }

  /**
   * 检查指定标签页的 Agent 是否正在运行
   * @param {number} tabId - 标签页 ID
   * @returns {boolean}
   */
  isRunning(tabId) {
    const state = this.agentStates.get(tabId)
    return state?.running === true && !state?.aborted
  }

  /**
   * 中止指定标签页的 Agent
   * @param {number} tabId - 标签页 ID
   */
  abort(tabId) {
    const state = this.agentStates.get(tabId)
    if (state) {
      state.aborted = true
      state.running = false
      console.log(`[AgentService] 中止 Agent: tabId=${tabId}`)
    } else {
      console.warn(`[AgentService] 中止失败：标签页 ${tabId} 无运行中的 Agent`)
    }
  }

  /**
   * 获取指定标签页的 Agent 状态
   * @param {number} tabId - 标签页 ID
   * @returns {object} 状态信息
   */
  getStatus(tabId) {
    const state = this.agentStates.get(tabId)
    if (!state) {
      return { running: false, aborted: false }
    }
    return {
      running: state.running && !state.aborted,
      aborted: state.aborted,
      startTime: state.startTime,
      sessionId: state.sessionId,
      userMessage: state.userMessage,
      totalRounds: state.totalRounds || 0,
      totalToolCalls: state.totalToolCalls || 0,
    }
  }

  /**
   * 清理指定标签页的状态（在标签页关闭时调用）
   * @param {number} tabId - 标签页 ID
   */
  cleanup(tabId) {
    this.abort(tabId)
    this.agentStates.delete(tabId)
    this.filteredScriptsCache.delete(tabId)
    this.domainMismatchLogged.delete(tabId)
    console.log(`[AgentService] 清理标签页状态: tabId=${tabId}`)
  }

  /**
   * 获取所有正在运行的 Agent
   * @returns {Array} 运行中的 Agent 列表
   */
  getRunningAgents() {
    const running = []
    for (const [tabId, state] of this.agentStates) {
      if (state.running && !state.aborted) {
        running.push({
          tabId,
          sessionId: state.sessionId,
          userMessage: state.userMessage,
          startTime: state.startTime,
        })
      }
    }
    return running
  }
}

module.exports = AgentService
