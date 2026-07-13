// ============================================================
// AI Browser Chrome Extension - Background Service Worker
// 入口文件：服务实例化、消息路由、端口连接、事件监听
// ============================================================

import { ConfigService, StorageService } from './services/config-service.js'
import { AIService } from './services/ai-service.js'
import { ScriptService } from './services/script-service.js'
import { SidebarService, PageService } from './services/sidebar-page-service.js'
import { ToolService } from './services/tool-service.js'
import { AgentService } from './services/agent-service.js'
import { DBService } from './services/db-service.js'
import { TaskTemplateService } from './services/task-template-service.js'
import { ToolRecordingService } from './services/tool-recording-service.js'
import { ScheduledTaskService } from './services/scheduled-task-service.js'
import { AgentResumeService } from './services/agent-resume-service.js'
import { HumanInterventionService } from './services/human-intervention-service.js'
import { TaskArchiveService } from './services/task-archive-service.js'
import { OutputService } from './services/output-service.js'
import { ScratchpadService } from './services/scratchpad-service.js'
import { CaptchaService } from './services/captcha-service.js'
import { LocalScriptService } from './services/local-script-service.js'

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

// ============ 服务实例（依赖注入） ============
const configService = new ConfigService()
const storageService = new StorageService()
const aiService = new AIService(configService)
const scriptService = new ScriptService(configService)
const sidebarService = new SidebarService()
const pageService = new PageService(scriptService)
const toolService = new ToolService(configService)

// Feature 1/4/6/7/9/23/24: 新增服务（需先于 agentService 实例化，以便注入）
const toolRecordingService = new ToolRecordingService()
const agentResumeService = new AgentResumeService()
const agentService = new AgentService(configService, toolService, pageService, scriptService, toolRecordingService, agentResumeService)
const taskTemplateService = new TaskTemplateService()
const scratchpadService = new ScratchpadService()  // Feature: 中间推理持久化
const outputService = new OutputService()          // Feature: 任务结果输出
const captchaService = new CaptchaService(aiService, configService)  // 验证码自动识别
const localScriptService = new LocalScriptService()                   // 本地脚本管理
const taskArchiveService = new TaskArchiveService()  // Feature: 任务追溯复盘（内部会创建自己的实例，但这里单独注册供 callService）
const humanInterventionService = new HumanInterventionService((request) => {
  // 人工介入请求回调：转发到 sidepanel
  try {
    chrome.runtime.sendMessage({ type: 'humanInterventionRequest', data: request }).catch(() => {})
  } catch {}
})
const scheduledTaskService = new ScheduledTaskService({
  navigate: async (url) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id) await chrome.tabs.update(tab.id, { url })
    else await chrome.tabs.create({ url })
  },
  injectScript: async (scriptId) => {
    return await scriptService.injectScriptsForTab(
      (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
      (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url
    )
  },
  sendAgentMessage: async (message) => {
    chrome.runtime.sendMessage({ type: 'scheduledAgentMessage', data: message }).catch(() => {})
  },
})

const services = {
  configService,
  storageService,
  aiService,
  scriptService,
  sidebarService,
  pageService,
  toolService,
  agentService,
  toolRecordingService,
  taskTemplateService,
  agentResumeService,
  humanInterventionService,
  scheduledTaskService,
  scratchpadService,   // Feature: 中间推理持久化
  outputService,       // Feature: 任务结果输出
  taskArchiveService,  // Feature: 任务追溯复盘
  captchaService,      // 验证码自动识别
  dbService: DBService,
}

// ============ 消息路由 ============
// CALL_SERVICE 安全校验：该通道暴露所有 service 方法（含 dbService.getAll、
// configService.saveAIConfig 等敏感操作），仅允许扩展自身页面（sidepanel/popup/options）调用。
// 判定依据：sender.tab 存在表示来自 content script（运行在页面上下文，可能被页面注入脚本利用）；
// sender.url 以 'chrome-extension://' 开头表示扩展页面。content script 一律拒绝。
function _isExtensionSender(sender) {
  // 扩展页面（sidepanel/popup/options）：无 tab，url 以 chrome-extension:// 开头
  if (sender.tab) return false
  const url = sender.url || ''
  return url.startsWith('chrome-extension://')
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === MSG_TYPES.CALL_SERVICE) {
    // 安全校验：拒绝来自 content script / 页面上下文的 CALL_SERVICE 调用
    if (!_isExtensionSender(sender)) {
      console.warn('[Background] 拒绝非扩展来源的 CALL_SERVICE 调用:', sender.url || sender.origin)
      sendResponse({ error: '权限不足：CALL_SERVICE 仅允许扩展页面调用', data: null })
      return true
    }
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
    // 使用 Promise.resolve 包装，兼容同步和异步方法返回值
    Promise.resolve(svc[method](...(args || [])))
      .then(data => sendResponse({ error: null, data }))
      .catch(err => sendResponse({ error: err?.message || String(err), data: null }))
    return true
  }

  if (msg.type === 'openSidebar') {
    const tabId = sender.tab?.id
    if (tabId) {
      sidebarService.open(tabId)
    }
    sendResponse({ ok: true })
    return false
  }

  // 浮动按钮点击：始终尝试打开原生 sidePanel（不追踪 isOpen 状态，因为用户可能通过原生 X 关闭导致状态不同步）
  if (msg.type === 'toggleSidebar') {
    const tabId = sender.tab?.id
    const action = msg.action
    console.log('[Background] toggleSidebar 收到, tabId:', tabId, 'action:', action)
    if (!tabId) {
      console.warn('[Background] toggleSidebar: 无 tabId')
      sendResponse({ ok: false, error: 'No tab id' })
      return false
    }
    ;(async () => {
      // 必须先打开 sidePanel（需要用户手势），再异步存储 action
      // await storage.set 会消耗用户手势，导致 sidePanel.open 失败
      const success = await sidebarService.open(tabId)
      console.log('[Background] toggleSidebar: open 结果=', success)
      // 异步存储 action（sidepanel 通过 storage.onChanged 或 checkFloatingAction 读取）
      if (action) {
        chrome.storage.local.set({ floatingToolAction: action }).catch(() => {})
      }
      sendResponse({ ok: success, opened: success })
    })()
    return true  // 异步响应
  }

  // 接收 inject_js 注入脚本的回调反馈
  if (msg.type === 'injectCallback') {
    const callbackData = msg.data || {}
    const tabUrl = msg.tabUrl || ''
    console.log('[AI Browser] 收到注入脚本回调:', callbackData, 'from:', tabUrl)
    // 保存到 storage，sidepanel 可读取并展示
    chrome.storage.local.get('injectCallbacks', (result) => {
      const callbacks = result.injectCallbacks || []
      callbacks.push({
        ...callbackData,
        tabUrl,
        timestamp: Date.now(),
      })
      // 只保留最近20条
      if (callbacks.length > 20) callbacks.splice(0, callbacks.length - 20)
      chrome.storage.local.set({ injectCallbacks: callbacks })
    })
    // 通过 sidepanel 端口通知（如果有活跃连接）
    chrome.runtime.sendMessage({
      type: 'injectCallbackNotification',
      data: callbackData,
      tabUrl,
    }).catch(() => {})  // 忽略没有接收者的错误
    sendResponse({ ok: true })
    return false
  }

  // 待办更新：转发给 content script（注入到页面的待办面板）
  if (msg.type === 'todoUpdate') {
    const tabId = msg.tabId
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'todoUpdate', data: msg.data }).catch(() => {})
    }
    sendResponse({ ok: true })
    return false
  }

  // 智能表单填充：背景用 AI 生成字段值
  if (msg.type === 'formFillRequest') {
    handleFormFill(msg, sender).then(sendResponse)
    return true
  }

  // Agent 导航后，content script / sidePanel 查询是否有活跃 Agent
  if (msg.type === 'checkAgentStatus') {
    const tabId = msg.tabId || sender.tab?.id
    const running = tabId ? agentService.isRunning(tabId) : false
    sendResponse({ agentRunning: running })
    return false
  }

  // Feature 9: 人工介入响应
  if (msg.type === 'humanInterventionRespond') {
    humanInterventionService.respond(msg.requestId, msg.answer).then(() => {
      sendResponse({ ok: true })
    }).catch(e => {
      sendResponse({ ok: false, error: e.message })
    })
    return true
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
    port.onDisconnect.addListener(() => {
      console.log('[Background] ai-stream port 已断开')
    })
  }
  if (port.name === 'agent-stream') {
    let attached = false
    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'agentStart') {
        attached = true
        await agentService.startAgent(port, msg.userMessage, msg.chatHistory, msg.modelInfo)
      }
      if (msg.type === 'agentAttach') {
        attached = true
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
        const tabId = tabs[0]?.id
        if (tabId && agentService.isRunning(tabId)) {
          agentService.attachPort(tabId, port)
          console.log('[Background] Agent 重连成功, tabId:', tabId)
        }
      }
    })
    port.onDisconnect.addListener(() => {
      // Plan B: Port 断开不终止 Agent，只解除绑定
      agentService.detachPortByPort(port)
      console.log('[Background] agent-stream port 已断开（Agent 继续运行）')
    })
  }
})

// ============ 事件监听 ============

chrome.runtime.onInstalled.addListener(() => {
  scriptService.syncScripts()
  sidebarService.setupPanelBehavior()

  // 右键菜单：先清除旧菜单再创建，避免扩展重载后 ID 冲突导致菜单失效
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ai-browser-summarize', title: 'AI 总结此页面', contexts: ['page'] })
    chrome.contextMenus.create({ id: 'ai-browser-translate', title: '翻译此页面', contexts: ['page'] })
    chrome.contextMenus.create({ id: 'ai-browser-explain', title: 'AI 解释选中文字', contexts: ['selection'] })
  })

  // Feature 23: 定时任务检查（闹钟监听器已在文件顶层注册，此处不再调用 setupAlarmListener，避免重复执行）
  // Feature 6: 清理过期的 Agent 快照
  agentResumeService.cleanupExpired().catch(() => {})
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sync-scripts') {
    scriptService.syncScripts()
  }
  // Feature 23: 定时任务检查
  if (alarm.name === 'scheduled-task-check') {
    try {
      await scheduledTaskService.checkAndRunDueTasks()
    } catch (e) {
      // 捕获异常避免 unhandled rejection 导致 SW 终止，下个周期仍会被闹钟调度
      console.error('[background] scheduled-task-check 执行失败:', e)
    }
  }
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

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-sidebar') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab) sidebarService.open(tab.id)
  }
})

// ============ 智能表单填充 ============
async function handleFormFill(msg, sender) {
  try {
    const { fields, pageTitle, pageUrl } = msg
    if (!fields || fields.length === 0) {
      return { ok: false, error: '未检测到表单字段' }
    }

    // 构建字段描述
    const fieldDesc = fields.map((f, i) => {
      const label = f.label || f.name || '字段' + (i + 1)
      const type = f.type || 'text'
      const placeholder = f.placeholder ? ` (提示: "${f.placeholder}")` : ''
      const required = f.required ? ' [必填]' : ''
      const options = f.options?.length ? ` [选项: ${f.options.join(', ')}]` : ''
      return `- ${label}: type=${type}${placeholder}${required}${options}`
    }).join('\n')

    const messages = [
      {
        role: 'system',
        content: '你是一个智能表单填充助手。根据表单字段的描述，生成合理、真实、多样化的填充数据。以纯 JSON 格式返回，key 为字段索引号（字符串），value 为填充值。不要输出任何解释，只输出 JSON。'
      },
      {
        role: 'user',
        content: `页面: ${pageTitle || pageUrl || '未知页面'}
需要填充的表单字段:
${fieldDesc}

请为以上每个字段生成一个合理的填充值，返回 JSON 格式：{"0": "值1", "1": "值2", ...}`
      }
    ]

    const result = await aiService.chat(messages, { temperature: 0.7, maxTokens: 2000 })
    const text = result.content || ''

    // 提取 JSON
    let json = text.trim()
    // 移除外层的 markdown 代码块
    const jsonMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) json = jsonMatch[1].trim()
    // 提取 { } 内容
    const braceMatch = json.match(/\{[\s\S]*\}/)
    if (braceMatch) json = braceMatch[0]

    const mapping = JSON.parse(json)
    return { ok: true, mapping }
  } catch (e) {
    console.error('[Background] 表单填充失败:', e.message)
    return { ok: false, error: e.message }
  }
}

// 定时同步
async function setupAlarm() {
  const config = await configService.getSyncConfig()
  chrome.alarms.clear('sync-scripts', () => {
    chrome.alarms.create('sync-scripts', { periodInMinutes: config.syncInterval })
  })
}
setupAlarm()

// ===== Service Worker 启动检测：检查是否有未完成的任务 =====
// 如果 ScratchpadService 中有最近的任务（5分钟内），说明可能是重启导致的任务中断
scratchpadService.init().then(async () => {
  const recentScratchpads = await scratchpadService.list(5)
  const now = Date.now()
  const unfinished = recentScratchpads.filter(s => (now - s.timestamp) < 300000)  // 5分钟内
  
  if (unfinished.length > 0) {
    console.log('[AI Browser] 检测到未完成的任务:', unfinished.map(s => s.sessionId).join(', '))
    // 通知用户可以通过对话记录面板查看之前的任务进度
    // 注意：当前架构不支持自动恢复任务（messages[]未保存），用户需要重新发起任务
  }
}).catch(e => console.warn('[AI Browser] ScratchpadService