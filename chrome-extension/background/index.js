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
const agentService = new AgentService(configService, toolService)

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
  if (port.name === 'agent-stream') {
    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'agentStart') {
        await agentService.run(port, msg.userMessage, msg.chatHistory)
      }
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

// 定时同步
async function setupAlarm() {
  const config = await configService.getSyncConfig()
  chrome.alarms.clear('sync-scripts', () => {
    chrome.alarms.create('sync-scripts', { periodInMinutes: config.syncInterval })
  })
}
setupAlarm()

console.log('[AI Browser] Background Service Worker started')
