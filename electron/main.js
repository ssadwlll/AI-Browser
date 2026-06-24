const { app, BrowserWindow, BrowserView, ipcMain, session, shell, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const LLMProvider = require('./ai/llm_provider')
const Analyzer = require('./ai/analyzer')
const ActionExecutor = require('./ai/action_executor')
const AgentLoop = require('./ai/agent_loop')
const TOOL_DEFINITIONS = require('./ai/tool_definitions')
const ToolExecutor = require('./ai/tool_executor')

let mainWindow
let tray = null
let llmProvider = new LLMProvider()
let analyzer = new Analyzer()
let actionExecutor = new ActionExecutor()
let agentLoop = new AgentLoop()
let toolExecutor = new ToolExecutor()

// ============ 多标签管理 ============
const tabs = new Map() // id -> { id, browserView, url, title, loading, favicon }
let activeTabId = null
let tabIdCounter = 0

// 面板位置: 'right' | 'left' | 'bottom'
let panelPosition = 'right'
// 面板占比
let panelRatio = 0.35
let panelVisible = true

const isDev = process.env.NODE_ENV === 'development'

// ============ 辅助函数 ============

function getActiveTab() {
  if (activeTabId === null) return null
  return tabs.get(activeTabId) || null
}

function getActiveBrowserView() {
  const tab = getActiveTab()
  return tab ? tab.browserView : null
}

function generateTabId() {
  return ++tabIdCounter
}

function getTabInfo(tab) {
  if (!tab) return null
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    loading: tab.loading,
    favicon: tab.favicon,
    active: tab.id === activeTabId,
  }
}

// 为 BrowserView 的 webContents 绑定标签事件
function attachTabEvents(tab) {
  const wc = tab.browserView.webContents

  wc.on('did-navigate', (event, url) => {
    tab.url = url
    tab.loading = false
    sendTabUpdated(tab)
  })

  wc.on('did-navigate-in-page', (event, url) => {
    tab.url = url
    sendTabUpdated(tab)
  })

  wc.on('page-title-updated', (event, title) => {
    tab.title = title
    sendTabUpdated(tab)
  })

  wc.on('did-start-loading', () => {
    tab.loading = true
    sendTabUpdated(tab)
  })

  wc.on('did-stop-loading', () => {
    tab.loading = false
    sendTabUpdated(tab)
  })

  wc.on('page-favicon-updated', (event, favicons) => {
    if (favicons && favicons.length > 0) {
      tab.favicon = favicons[0]
      sendTabUpdated(tab)
    }
  })

  // 新窗口链接改为新标签页打开
  wc.setWindowOpenHandler(({ url }) => {
    createTab(url)
    return { action: 'deny' } // 阻止默认新窗口，由createTab处理
  })
}

function sendTabUpdated(tab) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tabs:updated', getTabInfo(tab))
  }
}

// ============ 窗口与视图 ============

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'AI Browser',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // 最小化到托盘而非关闭
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createTray() {
  // 创建一个简单的托盘图标
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon)
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { mainWindow.show(); mainWindow.focus() } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit() } },
  ])
  tray.setToolTip('AI Browser')
  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus() })
}

function attachBrowserView(url) {
  // 保持原有函数签名，但现在创建一个新标签
  createTab(url || 'about:blank')
}

function createTab(url) {
  const id = generateTabId()
  const bv = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload_browser.js'),
    },
  })

  const tab = {
    id,
    browserView: bv,
    url: url || 'about:blank',
    title: '',
    loading: false,
    favicon: null,
  }

  tabs.set(id, tab)

  // 绑定标签事件
  attachTabEvents(tab)

  // 隐藏当前活跃标签的 BrowserView
  if (activeTabId !== null) {
    const prevTab = tabs.get(activeTabId)
    if (prevTab && mainWindow) {
      mainWindow.removeBrowserView(prevTab.browserView)
    }
  }

  // 添加新 BrowserView 并设为活跃
  if (mainWindow) {
    mainWindow.addBrowserView(bv)
  }
  activeTabId = id

  // 导航到指定 URL
  if (url && url !== 'about:blank') {
    const navUrl = url.startsWith('http') ? url : 'https://' + url
    bv.webContents.loadURL(navUrl)
  }

  resizeBrowserView()
  return getTabInfo(tab)
}

function closeTab(id) {
  const tab = tabs.get(id)
  if (!tab) return null

  // 从主窗口移除 BrowserView
  if (mainWindow) {
    mainWindow.removeBrowserView(tab.browserView)
  }

  // 销毁 BrowserView
  tab.browserView.webContents.close()
  tabs.delete(id)

  // 如果关闭的是活跃标签，切换到相邻标签
  if (activeTabId === id) {
    const remainingIds = Array.from(tabs.keys())
    if (remainingIds.length > 0) {
      // 切换到相邻标签（优先前一个，否则后一个）
      const closedIndex = [...tabs.keys()].indexOf(id) // 已删除，用剩余的
      const newIndex = Math.min(0, remainingIds.length - 1)
      switchTab(remainingIds[newIndex])
    } else {
      activeTabId = null
    }
  }

  return { success: true }
}

function switchTab(id) {
  const tab = tabs.get(id)
  if (!tab) return null

  // 隐藏当前活跃标签
  if (activeTabId !== null) {
    const prevTab = tabs.get(activeTabId)
    if (prevTab && mainWindow) {
      mainWindow.removeBrowserView(prevTab.browserView)
    }
  }

  // 显示新标签
  activeTabId = id
  if (mainWindow) {
    mainWindow.addBrowserView(tab.browserView)
  }
  resizeBrowserView()

  return getTabInfo(tab)
}

function resizeBrowserView() {
  const bv = getActiveBrowserView()
  if (!mainWindow || !bv) return
  const [width, height] = mainWindow.getContentSize()
  const navbarHeight = 72 // 40 navbar + 32 tab bar

  // 面板隐藏时，浏览器占满全宽
  const effectiveRatio = panelVisible ? panelRatio : 0

  if (panelPosition === 'right') {
    const browserWidth = Math.floor(width * (1 - effectiveRatio))
    bv.setBounds({ x: 0, y: navbarHeight, width: browserWidth, height: height - navbarHeight })
  } else if (panelPosition === 'left') {
    const panelWidth = Math.floor(width * effectiveRatio)
    bv.setBounds({ x: panelWidth, y: navbarHeight, width: width - panelWidth, height: height - navbarHeight })
  } else if (panelPosition === 'bottom') {
    const panelHeight = Math.floor(height * effectiveRatio)
    bv.setBounds({ x: 0, y: navbarHeight, width: width, height: height - navbarHeight - panelHeight })
  }
}

// ============ IPC 处理 ============

// ============ 标签 IPC ============

ipcMain.handle('tabs:create', async (event, { url } = {}) => {
  const tabInfo = createTab(url)
  return tabInfo
})

ipcMain.handle('tabs:close', async (event, { id }) => {
  return closeTab(id)
})

ipcMain.handle('tabs:switch', async (event, { id }) => {
  return switchTab(id)
})

ipcMain.handle('tabs:list', async () => {
  const list = []
  for (const tab of tabs.values()) {
    list.push(getTabInfo(tab))
  }
  return list
})

ipcMain.handle('tabs:reorder', async (event, { ids }) => {
  // 重建 Map 顺序
  const newTabs = new Map()
  for (const id of ids) {
    const tab = tabs.get(id)
    if (tab) newTabs.set(id, tab)
  }
  // 保留不在 ids 中的标签
  for (const [id, tab] of tabs) {
    if (!newTabs.has(id)) newTabs.set(id, tab)
  }
  tabs.clear()
  for (const [id, tab] of newTabs) {
    tabs.set(id, tab)
  }
  return { success: true }
})

ipcMain.handle('tabs:update', async (event, { id, url, title, loading }) => {
  const tab = tabs.get(id)
  if (!tab) return { success: false }
  if (url !== undefined) tab.url = url
  if (title !== undefined) tab.title = title
  if (loading !== undefined) tab.loading = loading
  sendTabUpdated(tab)
  return { success: true }
})

// ============ 页面查找 IPC ============

ipcMain.handle('find:start', async (event, { text, options }) => {
  const bv = getActiveBrowserView()
  if (!bv) return { success: false, error: '没有活跃标签' }
  return new Promise((resolve) => {
    bv.webContents.findInPage(text, options || {})
    const handler = (event, result) => {
      bv.webContents.removeListener('found-in-page', handler)
      resolve({ success: true, matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal })
    }
    bv.webContents.on('found-in-page', handler)
  })
})

ipcMain.handle('find:next', async () => {
  const bv = getActiveBrowserView()
  if (!bv) return { success: false }
  return new Promise((resolve) => {
    bv.webContents.findInPage('', { findNext: true })
    const handler = (event, result) => {
      bv.webContents.removeListener('found-in-page', handler)
      resolve({ success: true, matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal })
    }
    bv.webContents.on('found-in-page', handler)
  })
})

ipcMain.handle('find:previous', async () => {
  const bv = getActiveBrowserView()
  if (!bv) return { success: false }
  return new Promise((resolve) => {
    bv.webContents.findInPage('', { findNext: true, forward: false })
    const handler = (event, result) => {
      bv.webContents.removeListener('found-in-page', handler)
      resolve({ success: true, matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal })
    }
    bv.webContents.on('found-in-page', handler)
  })
})

ipcMain.handle('find:stop', async () => {
  const bv = getActiveBrowserView()
  if (!bv) return { success: false }
  bv.webContents.stopFindInPage('clearSelection')
  return { success: true }
})

// ============ 浏览器导航 IPC ============

// 导航
ipcMain.handle('browser:navigate', async (event, url) => {
  let bv = getActiveBrowserView()
  if (!bv) {
    attachBrowserView()
    bv = getActiveBrowserView()
  }
  if (!url.startsWith('http')) {
    url = 'https://' + url
  }
  analyzer.reset()
  bv.webContents.loadURL(url)
  return { success: true, url }
})

// 后退
ipcMain.handle('browser:back', async () => {
  const bv = getActiveBrowserView()
  if (bv && bv.webContents.navigationHistory.canGoBack()) {
    bv.webContents.navigationHistory.goBack()
    return { success: true }
  }
  return { success: false }
})

// 前进
ipcMain.handle('browser:forward', async () => {
  const bv = getActiveBrowserView()
  if (bv && bv.webContents.navigationHistory.canGoForward()) {
    bv.webContents.navigationHistory.goForward()
    return { success: true }
  }
  return { success: false }
})

// 获取当前URL
ipcMain.handle('browser:get-url', async () => {
  const bv = getActiveBrowserView()
  if (bv) {
    return bv.webContents.getURL()
  }
  return ''
})

// 获取页面HTML
ipcMain.handle('browser:get-html', async () => {
  const bv = getActiveBrowserView()
  if (!bv) return ''
  try {
    const html = await bv.webContents.executeJavaScript('document.documentElement.outerHTML')
    return html
  } catch (e) {
    return ''
  }
})

// 获取页面标题
ipcMain.handle('browser:get-title', async () => {
  const bv = getActiveBrowserView()
  if (!bv) return ''
  return bv.webContents.getTitle()
})

// 刷新页面
ipcMain.handle('browser:reload', async () => {
  const bv = getActiveBrowserView()
  if (bv) {
    bv.webContents.reload()
    return { success: true }
  }
  return { success: false }
})

// 强制刷新（忽略缓存）
ipcMain.handle('browser:reload-ignore-cache', async () => {
  const bv = getActiveBrowserView()
  if (bv) {
    bv.webContents.reloadIgnoringCache()
    return { success: true }
  }
  return { success: false }
})

// 停止加载
ipcMain.handle('browser:stop', async () => {
  const bv = getActiveBrowserView()
  if (bv) {
    bv.webContents.stop()
    return { success: true }
  }
  return { success: false }
})

// 获取加载状态
ipcMain.handle('browser:is-loading', async () => {
  const bv = getActiveBrowserView()
  if (bv) {
    return bv.webContents.isLoading()
  }
  return false
})

// 在默认浏览器中打开
ipcMain.handle('browser:open-external', async (event, url) => {
  if (url) {
    await shell.openExternal(url)
    return { success: true }
  }
  return { success: false }
})

// 调整浏览器视图大小
ipcMain.on('browser:resize', (event, { browserRatio, position, ratio }) => {
  if (!mainWindow) return
  if (position) panelPosition = position
  if (ratio !== undefined && ratio !== null) panelRatio = ratio
  if (browserRatio !== undefined && browserRatio !== null) panelRatio = 1 - browserRatio
  resizeBrowserView()
})

// 切换面板可见性
ipcMain.handle('panel:toggle', async (event, { visible }) => {
  if (visible !== undefined) panelVisible = visible
  resizeBrowserView()
  return { success: true, visible: panelVisible }
})

// 设置面板位置
ipcMain.handle('panel:set-position', async (event, { position, ratio }) => {
  if (position) panelPosition = position
  if (ratio !== undefined) panelRatio = ratio
  resizeBrowserView()
  return { success: true, position: panelPosition, ratio: panelRatio }
})

// 获取面板位置
ipcMain.handle('panel:get-position', async () => {
  return { position: panelPosition, ratio: panelRatio }
})

// ============ 请求拦截 - 逆向分析核心 ============

// 在 default session 上拦截请求
function setupRequestInterception() {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    // 记录所有请求
    analyzer.recordRequest(details)
    callback({})
  })

  session.defaultSession.webRequest.onCompleted((details) => {
    analyzer.recordResponse(details)
  })

  session.defaultSession.webRequest.onErrorOccurred((details) => {
    analyzer.recordError(details)
  })
}

// ============ AI 模型调用 ============

ipcMain.handle('ai:chat', async (event, { messages, config }) => {
  try {
    llmProvider.setConfig(config)
    const reply = await llmProvider.chat(messages)
    return { success: true, reply }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// 流式响应
ipcMain.handle('ai:chat-stream', async (event, { messages, config }) => {
  try {
    llmProvider.setConfig(config)
    const stream = await llmProvider.chatStream(messages)
    for await (const item of stream) {
      if (item.type === 'content') {
        mainWindow.webContents.send('stream:chunk', { source: 'chat', chunk: item.content })
      }
    }
    mainWindow.webContents.send('stream:done', { source: 'chat' })
    return { success: true }
  } catch (e) {
    mainWindow.webContents.send('stream:done', { source: 'chat' })
    return { success: false, error: e.message }
  }
})

// ============ 统一 AI 工具调用循环 ============
// AI决策 → 客户端执行工具 → 结果返回AI → 循环直到AI给出最终回复

const SYSTEM_PROMPT_UNIFIED = `你是一个强大的AI浏览器助手。你可以通过调用工具来与浏览器页面交互，帮助用户完成各种任务。

## 可用工具
- collect_page_context: 收集当前页面的URL、标题、DOM结构
- execute_js: 在页面中执行JavaScript代码（操作DOM、提取数据、注入脚本等）
- get_network_requests: 获取页面捕获的网络请求数据
- navigate_to: 导航浏览器到指定URL
- extract_page_scripts: 提取页面加载的JavaScript脚本信息
- get_page_html: 获取页面HTML源代码
- screenshot: 对当前页面截图

## 工作原则
1. 根据用户需求自主决定调用哪些工具，可以连续多次调用
2. 需要了解页面时，先调用 collect_page_context
3. 需要操作页面或提取数据时，调用 execute_js
4. 需要分析API接口时，调用 get_network_requests
5. 每次执行JS后，根据结果决定是否需要继续操作
6. 如果代码导致页面导航，系统会自动等待新页面加载
7. 操作完成后给出清晰的总结
8. 如果用户只是普通对话，不需要调用工具，直接回复即可`

let unifiedAbortFlag = false

ipcMain.handle('ai:unified-chat', async (event, { messages, config, maxToolRounds }) => {
  try {
    llmProvider.setConfig(config)
    unifiedAbortFlag = false

    const maxRounds = maxToolRounds || 20
    let currentMessages = [
      { role: 'system', content: SYSTEM_PROMPT_UNIFIED },
      ...messages,
    ]

    // 发送开始事件
    mainWindow.webContents.send('unified:start', {})

    for (let round = 0; round < maxRounds; round++) {
      if (unifiedAbortFlag) {
        mainWindow.webContents.send('unified:done', { success: false, summary: '已中止' })
        return { success: false, summary: '已中止' }
      }

      // 调用AI（非流式，获取完整回复包括tool_calls）
      const aiMessage = await llmProvider.chat(currentMessages, { tools: TOOL_DEFINITIONS })

      // 如果AI没有调用工具，说明是最终回复
      if (!aiMessage.tool_calls || aiMessage.tool_calls.length === 0) {
        // 将AI的文本回复发送给前端
        const content = aiMessage.content || ''
        mainWindow.webContents.send('unified:final-reply', { content })
        mainWindow.webContents.send('unified:done', { success: true, summary: content.substring(0, 200) })
        return { success: true, content }
      }

      // AI调用了工具，将AI消息加入上下文
      currentMessages.push(aiMessage)

      // 逐个执行工具调用
      for (const toolCall of aiMessage.tool_calls) {
        if (unifiedAbortFlag) break

        const toolName = toolCall.function.name
        let toolArgs = {}
        try {
          toolArgs = JSON.parse(toolCall.function.arguments || '{}')
        } catch (e) {
          toolArgs = {}
        }

        // 通知前端：正在执行工具
        mainWindow.webContents.send('unified:tool-call', {
          round: round + 1,
          toolName,
          toolArgs,
          callId: toolCall.id,
        })

        // 执行工具
        const toolResult = await toolExecutor.execute(toolName, toolArgs, {
          browserView: getActiveBrowserView(),
          analyzer,
          actionExecutor,
        })

        // 通知前端：工具执行结果
        mainWindow.webContents.send('unified:tool-result', {
          round: round + 1,
          toolName,
          success: toolResult.success,
          result: toolResult.result,
          error: toolResult.error,
          description: toolResult.description,
          callId: toolCall.id,
        })

        // 将工具结果加入上下文
        currentMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult.success ? toolResult.result : { error: toolResult.error }),
        })
      }
    }

    // 达到最大轮次
    mainWindow.webContents.send('unified:done', { success: false, summary: `已达到最大工具调用轮次 (${maxRounds})` })
    return { success: false, summary: '达到最大轮次' }

  } catch (e) {
    mainWindow.webContents.send('unified:done', { success: false, summary: e.message, error: e.message })
    return { success: false, error: e.message }
  }
})

// 统一AI - 流式版本
ipcMain.handle('ai:unified-chat-stream', async (event, { messages, config, maxToolRounds }) => {
  try {
    llmProvider.setConfig(config)
    unifiedAbortFlag = false

    const maxRounds = maxToolRounds || 20
    let currentMessages = [
      { role: 'system', content: SYSTEM_PROMPT_UNIFIED },
      ...messages,
    ]

    mainWindow.webContents.send('unified:start', {})

    for (let round = 0; round < maxRounds; round++) {
      if (unifiedAbortFlag) {
        mainWindow.webContents.send('unified:done', { success: false, summary: '已中止' })
        return { success: false, summary: '已中止' }
      }

      // 使用流式调用，同时收集tool_calls
      let fullContent = ''
      let toolCallsAccum = {}
      let hasToolCalls = false

      const stream = llmProvider.chatStream(currentMessages, { tools: TOOL_DEFINITIONS })

      // 先发送一个"正在思考"的消息
      mainWindow.webContents.send('unified:thinking', { round: round + 1 })

      for await (const item of stream) {
        if (item.type === 'content') {
          fullContent += item.content
          // 流式发送文本内容
          mainWindow.webContents.send('unified:stream-chunk', { chunk: item.content })
        } else if (item.type === 'tool_calls' || item.type === 'tool_call') {
          hasToolCalls = true
          const calls = item.tool_calls || [item.tool_call]
          for (const tc of calls) {
            const idx = tc.index ?? 0
            toolCallsAccum[idx] = tc
          }
        }
      }

      // 如果没有工具调用，这是最终回复
      if (!hasToolCalls || Object.keys(toolCallsAccum).length === 0) {
        mainWindow.webContents.send('unified:final-reply', { content: fullContent })
        mainWindow.webContents.send('unified:done', { success: true, summary: fullContent.substring(0, 200) })
        return { success: true, content: fullContent }
      }

      // 有工具调用 - 先将流式文本内容作为assistant消息
      const assistantMsg = {
        role: 'assistant',
        content: fullContent || null,
        tool_calls: Object.values(toolCallsAccum).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
      }
      currentMessages.push(assistantMsg)

      // 执行工具调用
      for (const toolCall of assistantMsg.tool_calls) {
        if (unifiedAbortFlag) break

        const toolName = toolCall.function.name
        let toolArgs = {}
        try {
          toolArgs = JSON.parse(toolCall.function.arguments || '{}')
        } catch (e) {
          toolArgs = {}
        }

        // 通知前端
        mainWindow.webContents.send('unified:tool-call', {
          round: round + 1,
          toolName,
          toolArgs,
          callId: toolCall.id,
        })

        const toolResult = await toolExecutor.execute(toolName, toolArgs, {
          browserView: getActiveBrowserView(),
          analyzer,
          actionExecutor,
        })

        mainWindow.webContents.send('unified:tool-result', {
          round: round + 1,
          toolName,
          success: toolResult.success,
          result: toolResult.result,
          error: toolResult.error,
          description: toolResult.description,
          callId: toolCall.id,
        })

        currentMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult.success ? toolResult.result : { error: toolResult.error }),
        })
      }
    }

    mainWindow.webContents.send('unified:done', { success: false, summary: `已达到最大工具调用轮次 (${maxRounds})` })
    return { success: false, summary: '达到最大轮次' }

  } catch (e) {
    mainWindow.webContents.send('unified:done', { success: false, summary: e.message, error: e.message })
    return { success: false, error: e.message }
  }
})

// 中止统一AI调用
ipcMain.handle('ai:unified-abort', async () => {
  unifiedAbortFlag = true
  return { success: true }
})

// ============ 逆向分析功能 ============

// 获取所有捕获的请求
ipcMain.handle('analysis:get-requests', async () => {
  return analyzer.getRequests()
})

// 综合分析：将页面信息+请求列表交给AI分析
ipcMain.handle('analysis:run', async (event, { prompt, config }) => {
  try {
    const pageData = await analyzer.collectPageData(getActiveBrowserView())
    const analysisContext = analyzer.buildAnalysisContext(prompt, pageData)
    llmProvider.setConfig(config)
    const reply = await llmProvider.chat(analysisContext)
    // 记录分析历史
    analyzer.addAnalysisHistory({
      prompt,
      reply,
      url: pageData?.url || '',
      title: pageData?.title || '',
    })
    return { success: true, reply, context: analysisContext }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// 提取JS代码
ipcMain.handle('analysis:extract-js', async () => {
  const bv = getActiveBrowserView()
  if (!bv) return { scripts: [] }
  try {
    const scripts = await bv.webContents.executeJavaScript(`
      Array.from(document.querySelectorAll('script')).map(s => ({
        src: s.src || '(inline)',
        type: s.type || 'text/javascript',
        content: s.src ? null : s.textContent.substring(0, 5000),
      }))
    `)
    return { scripts }
  } catch (e) {
    return { scripts: [], error: e.message }
  }
})

// 清空分析数据
ipcMain.handle('analysis:reset', async () => {
  analyzer.reset()
  return { success: true }
})

// 获取分析历史
ipcMain.handle('analysis:history', async () => {
  return analyzer.getAnalysisHistory()
})

// 清空分析历史
ipcMain.handle('analysis:clear-history', async () => {
  analyzer.clearAnalysisHistory()
  return { success: true }
})

// 逆向分析 - 流式
ipcMain.handle('analysis:run-stream', async (event, { prompt, config }) => {
  try {
    const pageData = await analyzer.collectPageData(getActiveBrowserView())
    const analysisContext = analyzer.buildAnalysisContext(prompt, pageData)
    llmProvider.setConfig(config)
    const stream = await llmProvider.chatStream(analysisContext)
    let fullReply = ''
    for await (const chunk of stream) {
      fullReply += chunk
      mainWindow.webContents.send('stream:chunk', { source: 'analysis', chunk })
    }
    mainWindow.webContents.send('stream:done', { source: 'analysis' })
    // 记录分析历史
    analyzer.addAnalysisHistory({
      prompt,
      reply: fullReply,
      url: pageData?.url || '',
      title: pageData?.title || '',
    })
    return { success: true }
  } catch (e) {
    mainWindow.webContents.send('stream:done', { source: 'analysis' })
    return { success: false, error: e.message }
  }
})

// ============ 智能操作 - LLM读取页面源码生成JS注入执行 ============

// 智能操作：读取页面上下文 → 调用LLM生成JS → 注入执行
ipcMain.handle('action:run', async (event, { instruction, config }) => {
  try {
    // 1. 收集页面上下文
    const pageContext = await actionExecutor.collectPageContext(getActiveBrowserView())
    if (!pageContext) {
      return { success: false, error: '没有打开的页面，请先导航到一个网页' }
    }

    // 2. 构建prompt（含会话上下文）
    const messages = actionExecutor.buildActionPrompt(instruction, pageContext)

    // 3. 调用LLM
    llmProvider.setConfig(config)
    const reply = await llmProvider.chat(messages)

    // 4. 将助手回复加入会话上下文
    actionExecutor.addAssistantReply(reply)

    // 5. 提取JS代码
    const jsCode = actionExecutor.extractJsCode(reply)

    if (!jsCode) {
      actionExecutor.addHistory({
        instruction,
        reply,
        jsCode: null,
        result: null,
        status: 'no_code',
      })
      return { success: false, reply, error: 'LLM未返回可执行的JavaScript代码' }
    }

    // 6. 注入执行
    const result = await actionExecutor.executeInPage(getActiveBrowserView(), jsCode)

    // 7. 记录历史
    actionExecutor.addHistory({
      instruction,
      reply,
      jsCode,
      result,
      status: result.success ? 'success' : 'error',
    })

    return { success: true, reply, jsCode, result }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// 只生成代码不执行（预览）
ipcMain.handle('action:preview', async (event, { instruction, config }) => {
  try {
    const pageContext = await actionExecutor.collectPageContext(getActiveBrowserView())
    if (!pageContext) {
      return { success: false, error: '没有打开的页面' }
    }

    const messages = actionExecutor.buildActionPrompt(instruction, pageContext)
    llmProvider.setConfig(config)
    const reply = await llmProvider.chat(messages)

    // 将助手回复加入会话上下文
    actionExecutor.addAssistantReply(reply)

    const jsCode = actionExecutor.extractJsCode(reply)
    return { success: true, reply, jsCode }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// 手动执行JS代码
ipcMain.handle('action:execute-js', async (event, { jsCode }) => {
  try {
    const result = await actionExecutor.executeInPage(getActiveBrowserView(), jsCode)
    return { success: true, result }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// 获取操作历史
ipcMain.handle('action:history', async () => {
  return actionExecutor.getHistory()
})

// 清空操作历史
ipcMain.handle('action:clear-history', async () => {
  actionExecutor.clearHistory()
  return { success: true }
})

// 获取页面DOM上下文（供前端预览）
ipcMain.handle('action:get-context', async () => {
  const context = await actionExecutor.collectPageContext(getActiveBrowserView())
  return context
})

// 清空智能操作会话上下文（新会话）
ipcMain.handle('action:clear-session', async () => {
  actionExecutor.clearSession()
  return { success: true }
})

// 获取当前会话上下文
ipcMain.handle('action:get-session', async () => {
  return actionExecutor.getSession()
})

// 智能操作 - 流式（生成并执行）
ipcMain.handle('action:run-stream', async (event, { instruction, config }) => {
  try {
    const pageContext = await actionExecutor.collectPageContext(getActiveBrowserView())
    if (!pageContext) {
      mainWindow.webContents.send('stream:done', { source: 'action' })
      return { success: false, error: '没有打开的页面，请先导航到一个网页' }
    }

    const messages = actionExecutor.buildActionPrompt(instruction, pageContext)
    llmProvider.setConfig(config)
    const stream = await llmProvider.chatStream(messages)
    let fullReply = ''
    for await (const chunk of stream) {
      fullReply += chunk
      mainWindow.webContents.send('stream:chunk', { source: 'action', chunk })
    }
    mainWindow.webContents.send('stream:done', { source: 'action' })

    // 将助手回复加入会话上下文
    actionExecutor.addAssistantReply(fullReply)

    // 提取JS代码并执行
    const jsCode = actionExecutor.extractJsCode(fullReply)
    let result = null
    if (jsCode) {
      result = await actionExecutor.executeInPage(getActiveBrowserView(), jsCode)
    }

    // 记录历史
    actionExecutor.addHistory({
      instruction,
      reply: fullReply,
      jsCode,
      result,
      status: jsCode ? (result?.success ? 'success' : 'error') : 'no_code',
    })

    return { success: true, jsCode, result }
  } catch (e) {
    mainWindow.webContents.send('stream:done', { source: 'action' })
    return { success: false, error: e.message }
  }
})

// 智能操作 - 流式（仅预览代码）
ipcMain.handle('action:preview-stream', async (event, { instruction, config }) => {
  try {
    const pageContext = await actionExecutor.collectPageContext(getActiveBrowserView())
    if (!pageContext) {
      mainWindow.webContents.send('stream:done', { source: 'action' })
      return { success: false, error: '没有打开的页面' }
    }

    const messages = actionExecutor.buildActionPrompt(instruction, pageContext)
    llmProvider.setConfig(config)
    const stream = await llmProvider.chatStream(messages)
    let fullReply = ''
    for await (const chunk of stream) {
      fullReply += chunk
      mainWindow.webContents.send('stream:chunk', { source: 'action', chunk })
    }
    mainWindow.webContents.send('stream:done', { source: 'action' })

    actionExecutor.addAssistantReply(fullReply)
    const jsCode = actionExecutor.extractJsCode(fullReply)

    return { success: true, jsCode }
  } catch (e) {
    mainWindow.webContents.send('stream:done', { source: 'action' })
    return { success: false, error: e.message }
  }
})

// ============ 智能体 - 自主多轮循环 ============

// 启动智能体任务
ipcMain.handle('agent:run', async (event, { task, config, maxRounds }) => {
  try {
    if (agentLoop.running) {
      return { success: false, error: '智能体正在运行中，请先停止当前任务' }
    }

    llmProvider.setConfig(config)
    if (maxRounds) agentLoop.setMaxRounds(maxRounds)

    // 发送事件给渲染进程的辅助函数
    const sendEvent = (eventName, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(eventName, data)
      }
    }

    const result = await agentLoop.run(getActiveBrowserView(), task, llmProvider, actionExecutor, sendEvent)
    return result
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// 中止智能体任务
ipcMain.handle('agent:abort', async () => {
  agentLoop.abort()
  return { success: true }
})

// 获取智能体状态
ipcMain.handle('agent:status', async () => {
  return agentLoop.getStatus()
})

// 获取智能体执行历史
ipcMain.handle('agent:history', async () => {
  return agentLoop.getHistory()
})

// 获取智能体对话上下文
ipcMain.handle('agent:messages', async () => {
  return agentLoop.getMessages()
})

// 清空智能体历史
ipcMain.handle('agent:clear-history', async () => {
  agentLoop.clearHistory()
  return { success: true }
})

// 重置智能体状态
ipcMain.handle('agent:reset', async () => {
  agentLoop.reset()
  return { success: true }
})

// 设置最大轮次
ipcMain.handle('agent:set-max-rounds', async (event, { maxRounds }) => {
  agentLoop.setMaxRounds(maxRounds)
  return { success: true }
})

// ============ 应用生命周期 ============

app.whenReady().then(() => {
  createMainWindow()
  createTray()
  attachBrowserView('about:blank')
  setupRequestInterception()

  mainWindow.on('resize', resizeBrowserView)
})

app.on('window-all-closed', () => {
  // 不退出，托盘保持运行
})

app.on('before-quit', () => {
  app.isQuitting = true
})

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show()
  } else {
    createMainWindow()
  }
})
