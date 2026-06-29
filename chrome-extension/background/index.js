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
const agentService = new AgentService(configService, toolService, pageService)

const services = {
  configService,
  storageService,
  aiService,
  scriptService,
  sidebarService,
  pageService,
  toolService,
  agentService,
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

  if (msg.type === 'openSidebar') {
    const tabId = sender.tab?.id
    if (tabId) {
      sidebarService.open(tabId)
    }
    sendResponse({ ok: true })
    return false
  }

  // 浮动按钮 toggle 原生 sidePanel：弹出/关闭，而非新建/销毁
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
      const key = `sidePanelOpen_${tabId}`
      const result = await chrome.storage.local.get(key)
      const isOpen = result[key]
      console.log('[Background] toggleSidebar: 当前状态 isOpen=', isOpen)
      if (isOpen) {
        // 当前已打开 → 关闭
        await sidebarService.close(tabId)
        await chrome.storage.local.set({ [key]: false })
        console.log('[Background] toggleSidebar: 已关闭')
        sendResponse({ ok: true, opened: false })
      } else {
        // 当前已关闭 → 打开
        const success = await sidebarService.open(tabId)
        console.log('[Background] toggleSidebar: open 结果=', success)
        if (success) {
          await chrome.storage.local.set({ [key]: true })
          // 传递 action 给 sidepanel，让它启动后切换到对应视图
          if (action) {
            await chrome.storage.local.set({ floatingToolAction: action })
          }
          sendResponse({ ok: true, opened: true })
        } else {
          sendResponse({ ok: false, error: '打开侧边栏失败（手势丢失），请用浏览器工具栏的扩展图标打开' })
        }
      }
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

  // 智能表单填充：背景用 AI 生成字段值
  if (msg.type === 'formFillRequest') {
    handleFormFill(msg, sender).then(sendResponse)
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
    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'agentStart') {
        // Plan B: 不传 port 给 run，而是通过 startAgent 管理
        await agentService.startAgent(port, msg.userMessage, msg.chatHistory)
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

  // 右键菜单
  chrome.contextMenus.create({ id: 'ai-browser-summarize', title: 'AI 总结此页面', contexts: ['page'] })
  chrome.contextMenus.create({ id: 'ai-browser-translate', title: '翻译此页面', contexts: ['page'] })
  chrome.contextMenus.create({ id: 'ai-browser-explain', title: 'AI 解释选中文字', contexts: ['selection'] })
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync-scripts') {
    scriptService.syncScripts()
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

console.log('[AI Browser] Background Service Worker started')
