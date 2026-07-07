// ============ ServiceManager - 新增服务集中管理与 IPC 注册 ============
// 将 chrome-extension 迁移的所有服务统一初始化、注册 IPC 通道
// 在 main.js 的 app.whenReady() 中调用 init()，在 before-quit 中调用 cleanup()

const { ipcMain } = require('electron')

// 基础服务
const ConfigService = require('./services/config_service')
const StorageService = require('./services/storage_service')  // 导出为对象，直接使用
const DBService = require('./services/db_service')            // 导出为对象，直接使用
const { fetchWithTimeout, safeJsonStringify, safeJsonParse } = require('./services/utils')

// 上下文管理
const WorkingMemory = require('./services/working_memory')
const ContextCompressor = require('./services/context_compressor')
const ScratchpadService = require('./services/scratchpad_service')

// Agent 核心
const AgentService = require('./services/agent_service')
const AgentResumeService = require('./services/agent_resume_service')
const { runJudge, saveToChatHistoryStorage, recordMemory } = require('./services/agent_judge')
const { buildTools } = require('./services/tool_builder')

// 调度与管理
const TodoScheduler = require('./services/todo_scheduler')
const ToolRecordingService = require('./services/tool_recording_service')
const GlobalDataStore = require('./services/global_data_store')
const PayloadStore = require('./services/payload_store')

// 高级功能
const OutputService = require('./services/output_service')
const HumanInterventionService = require('./services/human_intervention_service')
const ScheduledTaskService = require('./services/scheduled_task_service')
const TaskTemplateService = require('./services/task_template_service')
const TaskArchiveService = require('./services/task_archive_service')

// ============================================================
// ServiceManager 单例
// ============================================================

class ServiceManager {
  constructor() {
    this.initialized = false
    this.services = {}
  }

  /**
   * 初始化所有服务（在 app.whenReady 后调用）
   * @param {object} deps - 依赖项 { tabManager, actionExecutor, toolExecutor }
   */
  async init(deps = {}) {
    if (this.initialized) return
    const { tabManager, actionExecutor, toolExecutor } = deps

    // ---- 基础服务 ----
    // StorageService/DBService/ConfigService 导出为对象，直接使用，不需要 new
    const configService = ConfigService

    // ---- 上下文管理 ----
    const contextCompressor = new ContextCompressor(configService)
    const scratchpadService = new ScratchpadService()
    await scratchpadService.init()

    // ---- 调度与管理 ----
    const globalDataStore = new GlobalDataStore()
    const todoScheduler = new TodoScheduler(globalDataStore)
    const payloadStore = new PayloadStore()
    await payloadStore.init()
    const toolRecordingService = new ToolRecordingService()

    // ---- 断点续传 ----
    const agentResumeService = new AgentResumeService()

    // ---- 高级功能 ----
    const outputService = new OutputService()
    await outputService.init()
    const humanInterventionService = new HumanInterventionService()
    await humanInterventionService.init()
    const scheduledTaskService = new ScheduledTaskService(configService)
    await scheduledTaskService.init()
    const taskTemplateService = new TaskTemplateService()
    await taskTemplateService.init()
    const taskArchiveService = new TaskArchiveService(scratchpadService, outputService)

    // ---- Agent 核心 ----
    // toolService 和 pageService 暂传 null，后续可接入 admin-server
    // 共享 PayloadStore/GlobalDataStore/TodoScheduler 实例，确保 IPC 和 Agent 使用同一份状态
    const agentService = new AgentService(
      configService, null, null, null,
      toolRecordingService, agentResumeService,
      tabManager, actionExecutor,
      { payloadStore, globalDataStore, todoScheduler }
    )

    // 保存引用
    this.services = {
      storageService: StorageService,  // 导出为对象，直接引用
      configService,
      contextCompressor,
      scratchpadService,
      globalDataStore,
      todoScheduler,
      payloadStore,
      toolRecordingService,
      agentResumeService,
      outputService,
      humanInterventionService,
      scheduledTaskService,
      taskTemplateService,
      taskArchiveService,
      agentService,
      tabManager,
      actionExecutor,
      toolExecutor,
    }

    // 注册 IPC 通道
    this._registerIpcHandlers()

    this.initialized = true
    console.log('[ServiceManager] 所有服务初始化完成')
  }

  // ============================================================
  // IPC 通道注册
  // ============================================================

  _registerIpcHandlers() {
    this._registerAgentIpc()
    this._registerConfigIpc()
    this._registerTodoIpc()
    this._registerScheduledTaskIpc()
    this._registerTaskTemplateIpc()
    this._registerToolRecordingIpc()
    this._registerScratchpadIpc()
    this._registerHumanInterventionIpc()
    this._registerOutputIpc()
    this._registerTaskArchiveIpc()
  }

  // ---- Agent 自主决策 (v2) ----
  _registerAgentIpc() {
    const { agentService, tabManager } = this.services

    // 启动 Agent
    ipcMain.handle('agent:v2-start', async (event, { tabId, userMessage, chatHistory, modelInfo }) => {
      try {
        // 默认使用活跃标签页
        const tid = tabId || tabManager?.activeTabId || tabManager?.tabs?.keys?.().next()?.value
        if (!tid) {
          return { success: false, error: '没有可用的标签页' }
        }

        const sendEvent = (channel, data) => {
          // 拦截 agentDataReport：直接弹出独立报告窗口
          if (channel === 'agentDataReport' && data?.items?.length > 0) {
            try {
              const { BrowserWindow } = require('electron')
              const path = require('path')
              const items = data.items
              const summary = data.summary || ''
              console.log(`[ServiceManager] agentDataReport 拦截，准备创建报告窗口: ${items.length} 份数据`)

              // 查找现有的报告窗口
              const existingWins = BrowserWindow.getAllWindows().filter(w => {
                try { return w.getTitle() === '数据报告' && !w.isDestroyed() } catch { return false }
              })

              if (existingWins.length > 0) {
                // 窗口已存在，发送新数据
                const win = existingWins[0]
                if (win.isMinimized()) win.restore()
                win.focus()
                win.webContents.send('report:data', { items, summary, timestamp: Date.now() })
                console.log('[ServiceManager] 报告窗口已存在，已发送新数据')
              } else {
                // 创建新窗口
                const parentWin = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
                const [pW, pH] = parentWin ? parentWin.getContentSize() : [800, 600]
                const [pX, pY] = parentWin ? parentWin.getPosition() : [0, 0]
                const wW = 720, wH = 560

                const reportWin = new BrowserWindow({
                  width: wW, height: wH,
                  x: pX + Math.floor((pW - wW) / 2),
                  y: pY + Math.floor((pH - wH) / 2),
                  parent: parentWin || undefined,
                  frame: false,
                  resizable: true,
                  minimizable: false,
                  maximizable: false,
                  fullscreenable: false,
                  skipTaskbar: true,
                  alwaysOnTop: true,
                  backgroundColor: '#1a1a2e',
                  title: '数据报告',
                  webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: path.join(__dirname, 'preload.js'),
                  },
                })

                // 先缓存数据到全局变量，窗口加载后通过 IPC 获取
                global._lastReportData = { items, summary, timestamp: Date.now() }

                if (process.env.NODE_ENV === 'development') {
                  reportWin.loadURL('http://localhost:5173/?window=report')
                } else {
                  reportWin.loadFile(path.join(__dirname, '../dist/index.html'), { query: { window: 'report' } })
                }

                reportWin.webContents.once('did-finish-load', () => {
                  if (global._lastReportData) {
                    reportWin.webContents.send('report:data', global._lastReportData)
                  }
                })

                console.log('[ServiceManager] 报告窗口已创建')
              }
            } catch (e) {
              console.warn('[ServiceManager] 报告窗口创建失败:', e.message, e.stack)
            }
          }

          // 发送到主窗口
          if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send(`agent:v2-event`, { channel, data })
          }
          // 广播到所有其他窗口（如内置工具窗口、全景对话窗口）
          try {
            const { BrowserWindow } = require('electron')
            BrowserWindow.getAllWindows().forEach(win => {
              if (win.webContents && !win.webContents.isDestroyed() && win.webContents !== event.sender) {
                win.webContents.send(`agent:v2-event`, { channel, data })
              }
            })
          } catch (e) { /* 忽略广播异常 */ }
        }

        // 异步启动，不等待完成
        agentService.startAgent(tid, userMessage, chatHistory || [], modelInfo || {}, sendEvent)
          .then(result => {
            if (event.sender && !event.sender.isDestroyed()) {
              event.sender.send('agent:v2-done', { tabId: tid, success: true, result })
            }
          })
          .catch(err => {
            console.error('[Agent v2] 运行失败:', err)
            if (event.sender && !event.sender.isDestroyed()) {
              event.sender.send('agent:v2-done', { tabId: tid, success: false, error: err.message })
            }
          })

        return { success: true, message: 'Agent 已启动', tabId: tid }
      } catch (e) {
        console.error('[Agent v2] 启动失败:', e)
        return { success: false, error: e.message }
      }
    })

    // 中止 Agent
    ipcMain.handle('agent:v2-abort', async (event, { tabId }) => {
      const tid = tabId || tabManager?.activeTabId
      agentService.abort(tid)
      return { success: true }
    })

    // 获取状态
    ipcMain.handle('agent:v2-status', async (event, { tabId }) => {
      const tid = tabId || tabManager?.activeTabId
      return agentService.getStatus(tid)
    })

    // 获取所有运行中的 Agent
    ipcMain.handle('agent:v2-running', async () => {
      return agentService.getRunningAgents()
    })

    // 事后自评（手动触发）
    ipcMain.handle('agent:v2-judge', async (event, { userMessage, agentSummary, executedTools }) => {
      try {
        const result = await runJudge(this.services.configService, userMessage, agentSummary, executedTools)
        return { success: true, data: result }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })

    // 上报脚本经验
    ipcMain.handle('agent:v2-record-memory', async (event, { scriptId, success, durationMs, errorMessage, resultSummary }) => {
      try {
        await recordMemory(this.services.configService, scriptId, success, durationMs, errorMessage, resultSummary)
        return { success: true }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
  }

  // ---- 配置管理 ----
  _registerConfigIpc() {
    const { configService } = this.services

    ipcMain.handle('config:get-ai', async () => {
      return { success: true, data: await configService.getAIConfig() }
    })
    ipcMain.handle('config:save-ai', async (event, { config }) => {
      return { success: true, data: await configService.saveAIConfig(config) }
    })
    ipcMain.handle('config:get-sync', async () => {
      return { success: true, data: await configService.getSyncConfig() }
    })
    ipcMain.handle('config:save-sync', async (event, { config }) => {
      return { success: true, data: await configService.saveSyncConfig(config) }
    })
    ipcMain.handle('config:get-agent', async () => {
      return { success: true, data: await configService.getAgentConfig() }
    })
    ipcMain.handle('config:save-agent', async (event, { config }) => {
      return { success: true, data: await configService.saveAgentConfig(config) }
    })
    ipcMain.handle('config:get-app-settings', async () => {
      return { success: true, data: await configService.getAppSettings() }
    })
    ipcMain.handle('config:get-available-models', async () => {
      try {
        return { success: true, data: await configService.getAvailableModels() }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
    ipcMain.handle('config:get-selection-tools', async () => {
      return { success: true, data: { enabled: await configService.getSelectionToolsEnabled() } }
    })
    ipcMain.handle('config:save-selection-tools', async (event, { enabled }) => {
      await configService.saveSelectionToolsEnabled(enabled)
      return { success: true }
    })
  }

  // ---- 待办调度 ----
  _registerTodoIpc() {
    const { todoScheduler } = this.services

    ipcMain.handle('todo:get-template', async (event, { userMessage, pageContent, searchResults }) => {
      return { success: true, data: todoScheduler.getTemplate(userMessage, pageContent, searchResults) }
    })
    ipcMain.handle('todo:submit', async (event, { items }) => {
      try {
        todoScheduler.submitTodo(items)
        return { success: true, data: { currentTodo: todoScheduler.getCurrentTodo(), progress: todoScheduler.getProgress() } }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
    ipcMain.handle('todo:get-current', async () => {
      return { success: true, data: todoScheduler.getCurrentTodo() }
    })
    ipcMain.handle('todo:get-progress', async () => {
      return { success: true, data: todoScheduler.getProgress() }
    })
    ipcMain.handle('todo:get-context', async () => {
      return { success: true, data: todoScheduler.getProgressContext() }
    })
    ipcMain.handle('todo:clear', async () => {
      todoScheduler.clear()
      return { success: true }
    })
  }

  // ---- 定时任务 ----
  _registerScheduledTaskIpc() {
    const { scheduledTaskService } = this.services

    ipcMain.handle('scheduled-task:list', async () => {
      return { success: true, data: await scheduledTaskService.list() }
    })
    ipcMain.handle('scheduled-task:create', async (event, { task }) => {
      try {
        const created = await scheduledTaskService.create(task)
        return { success: true, data: created }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
    ipcMain.handle('scheduled-task:update', async (event, { taskId, updates }) => {
      try {
        const updated = await scheduledTaskService.update(taskId, updates)
        return { success: true, data: updated }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
    ipcMain.handle('scheduled-task:delete', async (event, { taskId }) => {
      await scheduledTaskService.delete(taskId)
      return { success: true }
    })
    ipcMain.handle('scheduled-task:get', async (event, { taskId }) => {
      return { success: true, data: await scheduledTaskService.get(taskId) }
    })
    ipcMain.handle('scheduled-task:enable', async (event, { taskId }) => {
      await scheduledTaskService.enable(taskId)
      return { success: true }
    })
    ipcMain.handle('scheduled-task:disable', async (event, { taskId }) => {
      await scheduledTaskService.disable(taskId)
      return { success: true }
    })
  }

  // ---- 任务模板 ----
  _registerTaskTemplateIpc() {
    const { taskTemplateService } = this.services

    ipcMain.handle('task-template:list', async (event, { category } = {}) => {
      return { success: true, data: await taskTemplateService.list(category) }
    })
    ipcMain.handle('task-template:get', async (event, { templateId }) => {
      return { success: true, data: await taskTemplateService.get(templateId) }
    })
    ipcMain.handle('task-template:create', async (event, { template }) => {
      try {
        const created = await taskTemplateService.create(template)
        return { success: true, data: created }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
    ipcMain.handle('task-template:update', async (event, { templateId, updates }) => {
      try {
        const updated = await taskTemplateService.update(templateId, updates)
        return { success: true, data: updated }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
    ipcMain.handle('task-template:delete', async (event, { templateId }) => {
      await taskTemplateService.delete(templateId)
      return { success: true }
    })
    ipcMain.handle('task-template:instantiate', async (event, { templateId, variables }) => {
      try {
        const result = await taskTemplateService.instantiate(templateId, variables)
        return { success: true, data: result }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
    ipcMain.handle('task-template:export', async (event, { templateId }) => {
      try {
        const result = await taskTemplateService.exportTemplate(templateId)
        return { success: true, data: result }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
    ipcMain.handle('task-template:import', async (event, { jsonStr }) => {
      try {
        const result = await taskTemplateService.importTemplate(jsonStr)
        return { success: true, data: result }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
  }

  // ---- 工具录制 ----
  _registerToolRecordingIpc() {
    const { toolRecordingService } = this.services

    ipcMain.handle('tool-recording:list', async (event, { limit } = {}) => {
      return { success: true, data: await toolRecordingService.listSessions(limit) }
    })
    ipcMain.handle('tool-recording:get', async (event, { sessionId }) => {
      return { success: true, data: await toolRecordingService.getSession(sessionId) }
    })
    ipcMain.handle('tool-recording:delete', async (event, { sessionId }) => {
      await toolRecordingService.deleteSession(sessionId)
      return { success: true }
    })
    ipcMain.handle('tool-recording:export', async (event, { sessionId }) => {
      try {
        const result = await toolRecordingService.exportSession(sessionId)
        return { success: true, data: result }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
    ipcMain.handle('tool-recording:import', async (event, { jsonStr }) => {
      try {
        const result = await toolRecordingService.importSession(jsonStr)
        return { success: true, data: result }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
  }

  // ---- 中间推理 (Scratchpad) ----
  _registerScratchpadIpc() {
    const { scratchpadService } = this.services

    ipcMain.handle('scratchpad:list', async (event, { limit } = {}) => {
      return { success: true, data: await scratchpadService.list(limit) }
    })
    ipcMain.handle('scratchpad:load', async (event, { sessionId }) => {
      return { success: true, data: await scratchpadService.load(sessionId) }
    })
    ipcMain.handle('scratchpad:delete', async (event, { sessionId }) => {
      await scratchpadService.delete(sessionId)
      return { success: true }
    })
    ipcMain.handle('scratchpad:clear', async () => {
      await scratchpadService.clear()
      return { success: true }
    })
    ipcMain.handle('scratchpad:export', async (event, { sessionId }) => {
      try {
        const result = await scratchpadService.export(sessionId)
        return { success: true, data: result }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
    ipcMain.handle('scratchpad:export-all', async () => {
      try {
        const result = await scratchpadService.exportAll()
        return { success: true, data: result }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
  }

  // ---- 人工介入 ----
  _registerHumanInterventionIpc() {
    const { humanInterventionService } = this.services

    ipcMain.handle('human-intervention:get-pending', async () => {
      return { success: true, data: await humanInterventionService.getPendingRequests() }
    })
    ipcMain.handle('human-intervention:respond', async (event, { requestId, response }) => {
      try {
        await humanInterventionService.respond(requestId, response)
        return { success: true }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
    ipcMain.handle('human-intervention:cancel', async (event, { requestId }) => {
      try {
        await humanInterventionService.cancel(requestId)
        return { success: true }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
    ipcMain.handle('human-intervention:clear-expired', async (event, { maxAgeMs } = {}) => {
      await humanInterventionService.clearExpired(maxAgeMs)
      return { success: true }
    })
  }

  // ---- 结果输出 ----
  _registerOutputIpc() {
    const { outputService } = this.services

    ipcMain.handle('output:list', async (event, { limit } = {}) => {
      return { success: true, data: await outputService.listSessions(limit) }
    })
    ipcMain.handle('output:get', async (event, { sessionId }) => {
      return { success: true, data: await outputService.getSession(sessionId) }
    })
    ipcMain.handle('output:delete', async (event, { sessionId }) => {
      await outputService.deleteSession(sessionId)
      return { success: true }
    })
    ipcMain.handle('output:clear', async () => {
      await outputService.clearAll()
      return { success: true }
    })
    ipcMain.handle('output:export', async (event, { sessionId }) => {
      try {
        const result = await outputService.exportSession(sessionId)
        return { success: true, data: result }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
  }

  // ---- 任务归档 ----
  _registerTaskArchiveIpc() {
    const { taskArchiveService } = this.services

    ipcMain.handle('task-archive:list', async (event, { limit } = {}) => {
      return { success: true, data: await taskArchiveService.list(limit) }
    })
    ipcMain.handle('task-archive:get', async (event, { archiveId }) => {
      return { success: true, data: await taskArchiveService.get(archiveId) }
    })
    ipcMain.handle('task-archive:delete', async (event, { archiveId }) => {
      await taskArchiveService.delete(archiveId)
      return { success: true }
    })
    ipcMain.handle('task-archive:clear', async () => {
      await taskArchiveService.clearAll()
      return { success: true }
    })
    ipcMain.handle('task-archive:search', async (event, { query }) => {
      return { success: true, data: await taskArchiveService.search(query) }
    })
    ipcMain.handle('task-archive:find-similar', async (event, { archiveId }) => {
      try {
        return { success: true, data: await taskArchiveService.findSimilar(archiveId) }
      } catch (e) {
        return { success: false, error: e.message }
      }
    })
  }

  // ============================================================
  // 清理资源
  // ============================================================
  async cleanup() {
    try {
      const { scheduledTaskService, agentResumeService, storageService } = this.services

      // 停止定时任务心跳
      if (scheduledTaskService) scheduledTaskService.stop()

      // 清理所有 Agent 快照定时器
      if (agentResumeService) {
        for (const tabId of agentResumeService._timers?.keys?.() || []) {
          agentResumeService.stopPeriodicSnapshot(tabId)
        }
      }

      // 刷新存储（确保数据落盘）
      if (storageService?.flush) storageService.flush()

      // 清理过期数据
      if (agentResumeService) await agentResumeService.cleanupExpired()

      console.log('[ServiceManager] 资源清理完成')
    } catch (e) {
      console.warn('[ServiceManager] 清理时出错:', e.message)
    }
  }

  /**
   * 获取服务实例
   */
  get(name) {
    return this.services[name]
  }
}

// 导出单例
const serviceManager = new ServiceManager()
module.exports = serviceManager
