const { app, BrowserWindow, BrowserView, ipcMain, session, shell, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const https = require('https')
const { fetchWithTimeout } = require('./services/utils')
const LLMProvider = require('./ai/llm_provider')
const Analyzer = require('./ai/analyzer')
const ActionExecutor = require('./ai/action_executor')
const AgentLoop = require('./ai/agent_loop')
const TOOL_DEFINITIONS = require('./ai/tool_definitions')
const ToolExecutor = require('./ai/tool_executor')
const TabManager = require('./tab_manager')
const serviceManager = require('./service_manager')

let mainWindow
let tray = null
let tabManager
let llmProvider = new LLMProvider()
let analyzer = new Analyzer()
let actionExecutor = new ActionExecutor()
let agentLoop = new AgentLoop()
let toolExecutor = new ToolExecutor()

// 面板位置: 'right' | 'left' | 'bottom'
let panelPosition = 'right'
let panelRatio = 0.35
let panelVisible = true

const isDev = process.env.NODE_ENV === 'development'

// ============ 安全检查辅助 ============

function isWindowValid() {
  return mainWindow && !mainWindow.isDestroyed()
}

function safeSend(channel, data) {
  // 发送到主窗口
  if (isWindowValid() && !mainWindow.webContents.isDestroyed()) {
    try { mainWindow.webContents.send(channel, data) } catch { /* 忽略 */ }
  }
  // 广播到所有其他窗口（侧边栏分离窗口、全景对话窗口等）
  try {
    const { BrowserWindow } = require('electron')
    BrowserWindow.getAllWindows().forEach(win => {
      if (win.webContents && !win.isDestroyed() && !win.webContents.isDestroyed() && win !== mainWindow) {
        try { win.webContents.send(channel, data) } catch { /* 忽略 */ }
      }
    })
  } catch { /* 忽略 */ }
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
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon)
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus() } } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit() } },
  ])
  tray.setToolTip('AI Browser')
  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus() } })
}

function resizeBrowserView() {
  const bv = tabManager.getActiveBrowserView()
  if (!isWindowValid() || !bv) return
  const [width, height] = mainWindow.getContentSize()
  const navbarHeight = 72
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

// ============ IPC 处理器 ============

function registerIpcHandlers() {
  // --- 标签页管理 ---
  ipcMain.handle('tabs:create', async (event, { url } = {}) => tabManager.createTab(url))
  ipcMain.handle('tabs:close', async (event, { id }) => {
    const result = tabManager.closeTab(id)
    if (result === 'last_tab') return { success: false, error: '无法关闭最后一个标签页' }
    return result
  })
  ipcMain.handle('tabs:switch', async (event, { id }) => tabManager.switchTab(id))
  ipcMain.handle('tabs:list', async () => tabManager.getTabList())
  ipcMain.handle('tabs:reorder', async (event, { ids }) => tabManager.reorderTabs(ids))
  ipcMain.handle('tabs:update', async (event, { id, url, title, loading }) => {
    const tab = tabManager.tabs.get(id)
    if (!tab) return { success: false }
    if (url !== undefined) tab.url = url
    if (title !== undefined) tab.title = title
    if (loading !== undefined) tab.loading = loading
    // 通知渲染进程
    const info = tabManager.getTabInfo(tab)
    safeSend('tabs:updated', info)
    return { success: true }
  })

  // --- 页面查找 ---
  ipcMain.handle('find:start', async (event, { text, options }) => {
    const bv = tabManager.getActiveBrowserView()
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
    const bv = tabManager.getActiveBrowserView()
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
    const bv = tabManager.getActiveBrowserView()
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
    const bv = tabManager.getActiveBrowserView()
    if (!bv) return { success: false }
    bv.webContents.stopFindInPage('clearSelection')
    return { success: true }
  })

  // --- 浏览器导航 ---
  ipcMain.handle('browser:navigate', async (event, url) => {
    let bv = tabManager.getActiveBrowserView()
    if (!bv) {
      tabManager.createTab(url)
      bv = tabManager.getActiveBrowserView()
    }
    if (!url.startsWith('http')) url = 'https://' + url
    if (bv) {
      analyzer.reset()
      bv.webContents.loadURL(url)
    }
    return { success: true, url }
  })

  ipcMain.handle('browser:back', async () => {
    const bv = tabManager.getActiveBrowserView()
    if (bv && bv.webContents.canGoBack()) {
      bv.webContents.goBack()
      return { success: true }
    }
    return { success: false }
  })

  ipcMain.handle('browser:forward', async () => {
    const bv = tabManager.getActiveBrowserView()
    if (bv && bv.webContents.canGoForward()) {
      bv.webContents.goForward()
      return { success: true }
    }
    return { success: false }
  })

  ipcMain.handle('browser:can-go-back', async () => {
    const bv = tabManager.getActiveBrowserView()
    return bv ? bv.webContents.canGoBack() : false
  })

  ipcMain.handle('browser:can-go-forward', async () => {
    const bv = tabManager.getActiveBrowserView()
    return bv ? bv.webContents.canGoForward() : false
  })

  ipcMain.handle('browser:get-url', async () => {
    const bv = tabManager.getActiveBrowserView()
    return bv ? bv.webContents.getURL() : ''
  })

  ipcMain.handle('browser:get-html', async () => {
    const bv = tabManager.getActiveBrowserView()
    if (!bv) return ''
    try {
      return await bv.webContents.executeJavaScript('document.documentElement.outerHTML')
    } catch (e) {
      return ''
    }
  })

  ipcMain.handle('browser:get-title', async () => {
    const bv = tabManager.getActiveBrowserView()
    if (!bv) return ''
    return bv.webContents.getTitle()
  })

  ipcMain.handle('browser:reload', async () => {
    const bv = tabManager.getActiveBrowserView()
    if (bv) { bv.webContents.reload(); return { success: true } }
    return { success: false }
  })

  ipcMain.handle('browser:reload-ignore-cache', async () => {
    const bv = tabManager.getActiveBrowserView()
    if (bv) { bv.webContents.reloadIgnoringCache(); return { success: true } }
    return { success: false }
  })

  ipcMain.handle('browser:stop', async () => {
    const bv = tabManager.getActiveBrowserView()
    if (bv) { bv.webContents.stop(); return { success: true } }
    return { success: false }
  })

  ipcMain.handle('browser:is-loading', async () => {
    const bv = tabManager.getActiveBrowserView()
    return bv ? bv.webContents.isLoading() : false
  })

  ipcMain.handle('browser:open-external', async (event, url) => {
    if (url) {
      await shell.openExternal(url)
      return { success: true }
    }
    return { success: false }
  })

  ipcMain.on('browser:resize', (event, { browserRatio, position, ratio }) => {
    if (!isWindowValid()) return
    if (position) panelPosition = position
    if (ratio !== undefined && ratio !== null) panelRatio = ratio
    if (browserRatio !== undefined && browserRatio !== null) panelRatio = 1 - browserRatio
    resizeBrowserView()
  })

  // --- 面板控制 ---
  ipcMain.handle('panel:toggle', async (event, { visible }) => {
    if (visible !== undefined) panelVisible = visible
    resizeBrowserView()
    return { success: true, visible: panelVisible }
  })

  ipcMain.handle('panel:set-position', async (event, { position, ratio }) => {
    if (position) panelPosition = position
    if (ratio !== undefined) panelRatio = ratio
    resizeBrowserView()
    return { success: true, position: panelPosition, ratio: panelRatio }
  })

  ipcMain.handle('panel:get-position', async () => {
    return { position: panelPosition, ratio: panelRatio }
  })

  // --- 内置工具浮动窗口（独立 BrowserWindow，全窗口可移动，不受 BrowserView 拦截） ---
  let toolWindow = null
  ipcMain.handle('tool-window:open', async (event) => {
    // 如果窗口已存在，聚焦它
    if (toolWindow && !toolWindow.isDestroyed()) {
      if (toolWindow.isMinimized()) toolWindow.restore()
      toolWindow.focus()
      return { success: true }
    }
    const [parentW, parentH] = mainWindow.getContentSize()
    const [parentX, parentY] = mainWindow.getPosition()
    // 窗口尺寸：560×480，居中偏右
    const wWidth = 560
    const wHeight = 480
    const wX = parentX + Math.floor((parentW - wWidth) / 2) + 40
    const wY = parentY + Math.floor((parentH - wHeight) / 2) - 20

    toolWindow = new BrowserWindow({
      width: wWidth,
      height: wHeight,
      x: wX,
      y: wY,
      parent: mainWindow,
      frame: false,        // 无边框，自定义标题栏实现拖拽
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,   // 不显示在任务栏
      alwaysOnTop: true,
      backgroundColor: '#1a1a2e',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    })

    // 开发环境加载 Vite 开发服务器，生产环境加载打包文件
    // 用 query 参数 ?window=feature-panels 标识工具窗口
    if (process.env.NODE_ENV === 'development') {
      toolWindow.loadURL('http://localhost:5173/?window=feature-panels')
    } else {
      toolWindow.loadFile(path.join(__dirname, '../dist/index.html'), { query: { window: 'feature-panels' } })
    }

    toolWindow.on('closed', () => { toolWindow = null })
    return { success: true }
  })

  ipcMain.handle('tool-window:close', async () => {
    if (toolWindow && !toolWindow.isDestroyed()) {
      toolWindow.close()
      toolWindow = null
    }
    return { success: true }
  })

  // --- 全景对话窗口（独立 BrowserWindow，实时显示 Agent 对话轮次） ---
  let conversationWindow = null
  ipcMain.handle('conversation-window:open', async (event) => {
    if (conversationWindow && !conversationWindow.isDestroyed()) {
      if (conversationWindow.isMinimized()) conversationWindow.restore()
      conversationWindow.focus()
      return { success: true }
    }
    const [parentW, parentH] = mainWindow.getContentSize()
    const [parentX, parentY] = mainWindow.getPosition()
    const wWidth = 680
    const wHeight = 600
    const wX = parentX + Math.floor((parentW - wWidth) / 2) - 40
    const wY = parentY + Math.floor((parentH - wHeight) / 2) - 20

    conversationWindow = new BrowserWindow({
      width: wWidth,
      height: wHeight,
      x: wX,
      y: wY,
      parent: mainWindow,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#1a1a2e',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    })

    if (process.env.NODE_ENV === 'development') {
      conversationWindow.loadURL('http://localhost:5173/?window=conversation')
    } else {
      conversationWindow.loadFile(path.join(__dirname, '../dist/index.html'), { query: { window: 'conversation' } })
    }

    conversationWindow.on('closed', () => { conversationWindow = null })
    return { success: true }
  })

  ipcMain.handle('conversation-window:close', async () => {
    if (conversationWindow && !conversationWindow.isDestroyed()) {
      conversationWindow.close()
      conversationWindow = null
    }
    return { success: true }
  })

  // --- 侧边栏分离窗口（独立 BrowserWindow，从主窗口分离出 AI 助手侧边栏） ---
  // 打开后主窗口侧边栏隐藏、BrowserView 占满全屏；关闭后主窗口侧边栏恢复
  let sidebarWindow = null
  ipcMain.handle('sidebar-window:open', async () => {
    // 如果窗口已存在，聚焦它
    if (sidebarWindow && !sidebarWindow.isDestroyed()) {
      if (sidebarWindow.isMinimized()) sidebarWindow.restore()
      sidebarWindow.focus()
      return { success: true }
    }

    sidebarWindow = new BrowserWindow({
      width: 420,
      height: 700,
      minWidth: 320,
      parent: mainWindow,
      frame: false,          // 无边框，自定义标题栏实现拖拽
      resizable: true,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: false,    // 显示在任务栏（独立窗口）
      alwaysOnTop: false,
      backgroundColor: '#1a1a2e',
      title: 'AI 助手',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    })

    // 开发环境加载 Vite 开发服务器，生产环境加载打包文件
    // 用 query 参数 ?window=sidebar 标识侧边栏分离窗口
    if (process.env.NODE_ENV === 'development') {
      sidebarWindow.loadURL('http://localhost:5173/?window=sidebar')
    } else {
      sidebarWindow.loadFile(path.join(__dirname, '../dist/index.html'), { query: { window: 'sidebar' } })
    }

    // 隐藏主窗口侧边栏，BrowserView 占满全屏
    panelVisible = false
    resizeBrowserView()
    // 通知主窗口渲染进程隐藏侧边栏 UI
    safeSend('sidebar-window:opened', {})

    // 窗口关闭时恢复主窗口侧边栏显示
    sidebarWindow.on('closed', () => {
      sidebarWindow = null
      panelVisible = true
      resizeBrowserView()
      // 通知主窗口渲染进程恢复侧边栏 UI
      safeSend('sidebar-window:closed', {})
    })

    return { success: true }
  })

  ipcMain.handle('sidebar-window:close', async () => {
    if (sidebarWindow && !sidebarWindow.isDestroyed()) {
      sidebarWindow.close()
      // 'closed' 事件会清理 sidebarWindow 并恢复主窗口侧边栏
    }
    return { success: true }
  })

  // --- 脚本中心窗口（独立 BrowserWindow，浏览/下载/注入后台脚本） ---
  let scriptCenterWindow = null
  ipcMain.handle('script-center:open', async () => {
    // 如果窗口已存在，聚焦它
    if (scriptCenterWindow && !scriptCenterWindow.isDestroyed()) {
      if (scriptCenterWindow.isMinimized()) scriptCenterWindow.restore()
      scriptCenterWindow.focus()
      return { success: true }
    }

    scriptCenterWindow = new BrowserWindow({
      width: 800,
      height: 600,
      minWidth: 480,
      minHeight: 400,
      parent: mainWindow,
      frame: false,          // 无边框，自定义标题栏实现拖拽
      resizable: true,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: false,    // 显示在任务栏（独立窗口）
      alwaysOnTop: false,
      backgroundColor: '#1a1a2e',
      title: '脚本中心',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    })

    // 开发环境加载 Vite 开发服务器，生产环境加载打包文件
    // 用 query 参数 ?window=script-center 标识脚本中心窗口
    if (process.env.NODE_ENV === 'development') {
      scriptCenterWindow.loadURL('http://localhost:5173/?window=script-center')
    } else {
      scriptCenterWindow.loadFile(path.join(__dirname, '../dist/index.html'), { query: { window: 'script-center' } })
    }

    scriptCenterWindow.on('closed', () => { scriptCenterWindow = null })

    return { success: true }
  })

  ipcMain.handle('script-center:close', async () => {
    if (scriptCenterWindow && !scriptCenterWindow.isDestroyed()) {
      scriptCenterWindow.close()
      scriptCenterWindow = null
    }
    return { success: true }
  })

  // --- 数据报告窗口（独立 BrowserWindow，Agent 完成时自动弹出） ---
  let historyWindow = null
  ipcMain.handle('history-window:open', async () => {
    // 如果窗口已存在，聚焦它
    if (historyWindow && !historyWindow.isDestroyed()) {
      if (historyWindow.isMinimized()) historyWindow.restore()
      historyWindow.focus()
      return { success: true }
    }

    const [parentW, parentH] = mainWindow.getContentSize()
    const [parentX, parentY] = mainWindow.getPosition()
    const wWidth = 600
    const wHeight = 500
    const wX = parentX + Math.floor((parentW - wWidth) / 2)
    const wY = parentY + Math.floor((parentH - wHeight) / 2)

    historyWindow = new BrowserWindow({
      width: wWidth,
      height: wHeight,
      x: wX,
      y: wY,
      parent: mainWindow,
      frame: false,          // 无边框，自定义标题栏实现拖拽
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#1a1a2e',
      title: '历史会话管理',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    })

    // 开发环境加载 Vite 开发服务器，生产环境加载打包文件
    // 用 query 参数 ?window=history 标识历史记录管理窗口
    if (process.env.NODE_ENV === 'development') {
      historyWindow.loadURL('http://localhost:5173/?window=history')
    } else {
      historyWindow.loadFile(path.join(__dirname, '../dist/index.html'), { query: { window: 'history' } })
    }

    historyWindow.on('closed', () => { historyWindow = null })
    return { success: true }
  })

  ipcMain.handle('history-window:close', async () => {
    if (historyWindow && !historyWindow.isDestroyed()) {
      historyWindow.close()
    }
    return { success: true }
  })

  // --- 数据报告窗口（独立 BrowserWindow，Agent 完成时自动弹出） ---
  let reportWindow = null
  // 缓存最新的报告数据，供报告窗口加载时读取
  let lastReportData = null

  // agent_runner 通过 invoke 调用此接口，传递报告数据并打开窗口
  ipcMain.handle('report-window:show', async (event, { items, summary, taskId }) => {
    // 缓存报告数据
    lastReportData = { items: items || [], summary: summary || '', taskId: taskId || '', timestamp: Date.now() }

    // 如果窗口已存在，聚焦并发送新数据
    if (reportWindow && !reportWindow.isDestroyed()) {
      if (reportWindow.isMinimized()) reportWindow.restore()
      reportWindow.focus()
      // 发送最新报告数据给窗口
      reportWindow.webContents.send('report:data', lastReportData)
      return { success: true }
    }

    // 创建新窗口
    const [parentW, parentH] = mainWindow.getContentSize()
    const [parentX, parentY] = mainWindow.getPosition()
    const wWidth = 720
    const wHeight = 560
    const wX = parentX + Math.floor((parentW - wWidth) / 2)
    const wY = parentY + Math.floor((parentH - wHeight) / 2)

    reportWindow = new BrowserWindow({
      width: wWidth,
      height: wHeight,
      x: wX,
      y: wY,
      parent: mainWindow,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#1a1a2e',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    })

    if (process.env.NODE_ENV === 'development') {
      reportWindow.loadURL('http://localhost:5173/?window=report')
    } else {
      reportWindow.loadFile(path.join(__dirname, '../dist/index.html'), { query: { window: 'report' } })
    }

    // 窗口加载完成后发送报告数据
    reportWindow.webContents.once('did-finish-load', () => {
      if (lastReportData) {
        reportWindow.webContents.send('report:data', lastReportData)
      }
    })

    reportWindow.on('closed', () => { reportWindow = null })
    return { success: true }
  })

  // 报告窗口加载时主动获取缓存的报告数据
  ipcMain.handle('report-window:get-data', async () => {
    return global._lastReportData || lastReportData || null
  })

  ipcMain.handle('report-window:close', async () => {
    if (reportWindow && !reportWindow.isDestroyed()) {
      reportWindow.close()
      reportWindow = null
    }
    return { success: true }
  })

  // 监听 report:open 事件（service_manager 通过 mainWindow.webContents.send 触发）
  // 内部调用 report-window:show 的逻辑
  ipcMain.on('report:open', async (_event, data) => {
    console.log('[Main] 收到 report:open，准备显示报告窗口')
    // 复用 report-window:show 的逻辑
    if (!data || !data.items || data.items.length === 0) return

    // 缓存报告数据
    lastReportData = { items: data.items, summary: data.summary || '', taskId: data.taskId || '', timestamp: Date.now() }

    // 如果窗口已存在，聚焦并发送新数据
    if (reportWindow && !reportWindow.isDestroyed()) {
      if (reportWindow.isMinimized()) reportWindow.restore()
      reportWindow.focus()
      reportWindow.webContents.send('report:data', lastReportData)
      return
    }

    // 创建新窗口
    const [parentW, parentH] = mainWindow.getContentSize()
    const [parentX, parentY] = mainWindow.getPosition()
    const wWidth = 720
    const wHeight = 560
    const wX = parentX + Math.floor((parentW - wWidth) / 2)
    const wY = parentY + Math.floor((parentH - wHeight) / 2)

    reportWindow = new BrowserWindow({
      width: wWidth,
      height: wHeight,
      x: wX,
      y: wY,
      parent: mainWindow,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#1a1a2e',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    })

    if (process.env.NODE_ENV === 'development') {
      reportWindow.loadURL('http://localhost:5173/?window=report')
    } else {
      reportWindow.loadFile(path.join(__dirname, '../dist/index.html'), { query: { window: 'report' } })
    }

    reportWindow.webContents.once('did-finish-load', () => {
      if (lastReportData) {
        reportWindow.webContents.send('report:data', lastReportData)
      }
    })

    reportWindow.on('closed', () => { reportWindow = null })
  })
  ipcMain.handle('ai:chat', async (event, { messages, config }) => {
    try {
      const reply = await proxyChat(messages, {
        model: config?.model,
        temperature: config?.temperature,
        maxTokens: config?.maxTokens,
      })
      return { success: true, reply }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('ai:chat-stream', async (event, { messages, config }) => {
    try {
      const stream = proxyChatStream(messages, {
        model: config?.model,
        temperature: config?.temperature,
        maxTokens: config?.maxTokens,
      })
      for await (const item of stream) {
        if (item.type === 'content') safeSend('stream:chunk', { source: 'chat', chunk: item.content })
      }
      safeSend('stream:done', { source: 'chat' })
      return { success: true }
    } catch (e) {
      safeSend('stream:done', { source: 'chat' })
      return { success: false, error: e.message }
    }
  })

  // --- 普通对话模式系统提示词（与插件版一致，纯文本对话不带工具） ---
  const SYSTEM_PROMPT_CHAT = `你是一个AI浏览器助手。你可以回答用户的各种问题，包括页面内容分析、信息搜索、文本处理等。
系统会自动将当前页面的上下文信息拼接到用户消息中，你可以基于这些信息回答问题。
如果用户需要复杂的页面操作或批量数据采集，建议切换到Agent模式。
请用中文回答。`

  let unifiedAbortFlag = false

  // ============ 后端 AI 代理调用（普通聊天模式也走后端代理） ============
  // 与 Agent 模式共用 /api/ai-proxy/chat，统一模型路由和用量统计

  /**
   * 通过后端 AI 代理调用 LLM（非流式）
   * @param {Array} messages - 消息数组
   * @param {object} opts - { tools, model, temperature, maxTokens }
   * @returns {Promise<{content, tool_calls}>} AI 回复
   */
  async function proxyChat(messages, opts = {}) {
    const configService = serviceManager.get('configService')
    if (!configService) throw new Error('ConfigService 未初始化')

    const aiConfig = await configService.getAIConfig()
    const auth = await configService.getAppAuth()
    if (!auth.appKey || !auth.appSecret) {
      throw new Error('未配置 AppKey/AppSecret，请在设置 → 服务端连接中配置')
    }

    const url = await configService.getAIProxyUrl()
    const headers = await configService.generateAuthHeaders(auth.appKey, auth.appSecret)

    const body = {
      model: opts.model || aiConfig.model,
      messages,
      temperature: opts.temperature ?? aiConfig.temperature ?? 0.7,
      max_tokens: opts.maxTokens || aiConfig.maxTokens || 4096,
      stream: false,
    }
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools
      body.tool_choice = 'auto'
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 60000)

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`AI代理请求失败: ${res.status} ${text.slice(0, 300)}`)
      }

      const data = await res.json()
      if (!data.success) {
        throw new Error(data.error || data.message || 'AI代理返回错误')
      }

      // 后端返回 { success, data: { choices: [{ message }] } } 或 { success, data: { content, tool_calls } }
      const payload = data.data || data
      if (payload.choices && payload.choices[0]) {
        return payload.choices[0].message
      }
      return { content: payload.content || '', tool_calls: payload.tool_calls }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * 通过后端 AI 代理调用 LLM（流式，async generator）
   * @param {Array} messages - 消息数组
   * @param {object} opts - { tools, model, temperature, maxTokens }
   * @yields {{ type: 'content'|'tool_calls', content?: string, tool_calls?: array }}
   */
  async function* proxyChatStream(messages, opts = {}) {
    const configService = serviceManager.get('configService')
    if (!configService) throw new Error('ConfigService 未初始化')

    const aiConfig = await configService.getAIConfig()
    const auth = await configService.getAppAuth()
    if (!auth.appKey || !auth.appSecret) {
      throw new Error('未配置 AppKey/AppSecret，请在设置 → 服务端连接中配置')
    }

    const url = await configService.getAIProxyUrl()
    const headers = await configService.generateAuthHeaders(auth.appKey, auth.appSecret)

    const body = {
      model: opts.model || aiConfig.model,
      messages,
      temperature: opts.temperature ?? aiConfig.temperature ?? 0.7,
      max_tokens: opts.maxTokens || aiConfig.maxTokens || 4096,
      stream: true,
    }
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools
      body.tool_choice = 'auto'
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 300000) // 5分钟超时

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`AI代理请求失败: ${res.status} ${text.slice(0, 300)}`)
      }

      // 解析 SSE 流
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let toolCallsAccum = {}

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data:')) continue

          const dataStr = trimmed.slice(5).trim()
          if (dataStr === '[DONE]') {
            if (Object.keys(toolCallsAccum).length > 0) {
              const toolCalls = Object.values(toolCallsAccum).sort((a, b) => (a.index || 0) - (b.index || 0))
              yield { type: 'tool_calls', tool_calls: toolCalls }
            }
            return
          }

          try {
            const chunk = JSON.parse(dataStr)
            // 兼容两种格式：后端代理的 { success, data } 或原始 OpenAI SSE
            const choices = chunk.choices || (chunk.data && chunk.data.choices)
            if (!choices || !choices[0]) continue

            const delta = choices[0].delta
            if (!delta) continue

            if (delta.content) {
              yield { type: 'content', content: delta.content }
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                if (!toolCallsAccum[idx]) {
                  toolCallsAccum[idx] = {
                    index: idx,
                    id: tc.id || '',
                    type: tc.type || 'function',
                    function: { name: '', arguments: '' },
                  }
                }
                if (tc.id) toolCallsAccum[idx].id = tc.id
                if (tc.type) toolCallsAccum[idx].type = tc.type
                if (tc.function?.name) toolCallsAccum[idx].function.name += tc.function.name
                if (tc.function?.arguments) toolCallsAccum[idx].function.arguments += tc.function.arguments
              }
            }
          } catch (e) {
            // 非 JSON 行，跳过
          }
        }
      }

      // 流结束但没收到 [DONE]，检查是否有累积的 tool_calls
      if (Object.keys(toolCallsAccum).length > 0) {
        const toolCalls = Object.values(toolCallsAccum).sort((a, b) => (a.index || 0) - (b.index || 0))
        yield { type: 'tool_calls', tool_calls: toolCalls }
      }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // ============ 普通对话模式（与插件版一致：纯文本流式对话，不带工具） ============
  // 插件版普通模式：将页面上下文拼到消息中，单次 API 调用，流式输出
  // 不使用 Function Calling，如需工具操作请切换到 Agent 模式

  ipcMain.handle('ai:unified-chat', async (event, { messages, config }) => {
    try {
      unifiedAbortFlag = false

      // 自动注入当前页面上下文到最后一条用户消息
      let enrichedMessages = await _enrichWithPageContext(messages)

      const currentMessages = [
        { role: 'system', content: SYSTEM_PROMPT_CHAT },
        ...enrichedMessages,
      ]

      safeSend('unified:start', {})

      const chatOpts = {
        model: config?.model,
        temperature: config?.temperature,
        maxTokens: config?.maxTokens,
        // 普通模式不带 tools，纯文本对话
      }

      const aiMessage = await proxyChat(currentMessages, chatOpts)
      const content = aiMessage.content || ''
      safeSend('unified:final-reply', { content })
      safeSend('unified:done', { success: true, summary: content.substring(0, 200) })
      return { success: true, content }
    } catch (e) {
      safeSend('unified:done', { success: false, summary: e.message, error: e.message })
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('ai:unified-chat-stream', async (event, { messages, config }) => {
    try {
      unifiedAbortFlag = false

      // 自动注入当前页面上下文到最后一条用户消息
      let enrichedMessages = await _enrichWithPageContext(messages)

      const currentMessages = [
        { role: 'system', content: SYSTEM_PROMPT_CHAT },
        ...enrichedMessages,
      ]

      safeSend('unified:start', {})

      const chatOpts = {
        model: config?.model,
        temperature: config?.temperature,
        maxTokens: config?.maxTokens,
        // 普通模式不带 tools，纯文本对话
      }

      let fullContent = ''
      safeSend('unified:thinking', { round: 1 })

      const stream = proxyChatStream(currentMessages, chatOpts)
      for await (const item of stream) {
        if (unifiedAbortFlag) break
        if (item.type === 'content') {
          fullContent += item.content
          safeSend('unified:stream-chunk', { chunk: item.content })
        }
        // 忽略 tool_calls（普通模式不处理工具调用）
      }

      if (unifiedAbortFlag) {
        safeSend('unified:done', { success: false, summary: '已中止' })
        return { success: false, summary: '已中止' }
      }

      safeSend('unified:final-reply', { content: fullContent })
      safeSend('unified:done', { success: true, summary: fullContent.substring(0, 200) })
      return { success: true, content: fullContent }
    } catch (e) {
      console.error('AI调用错误:', e)
      safeSend('unified:done', { success: false, summary: e.message, error: e.message })
      return { success: false, error: e.message }
    }
  })

  /**
   * 将当前页面上下文拼接到最后一条用户消息中（与插件版一致）
   * 插件版做法：`lastUserContent = text + (pageContext || '')`
   */
  async function _enrichWithPageContext(messages) {
    const enriched = [...messages]
    try {
      const bv = tabManager.getActiveBrowserView()
      if (bv && bv.webContents && !bv.webContents.isDestroyed()) {
        const pageData = await bv.webContents.executeJavaScript(`(() => {
          const getText = (el) => {
            if (!el) return '';
            const parts = [];
            for (const node of el.querySelectorAll('h1,h2,h3,p,li,td,th,span,div,a,article,section')) {
              const t = (node.innerText || node.textContent || '').trim();
              if (t && t.length > 2) parts.push(t.slice(0, 200));
            }
            return parts.join(' ').slice(0, 3000);
          };
          return { title: document.title || '', url: location.href || '', content: getText(document.body) };
        })()`)
        if (pageData && pageData.content) {
          const pageContext = `\n\n[当前页面] 标题: ${pageData.title || '无标题'} | URL: ${pageData.url || ''}\n页面内容: ${pageData.content}`
          // 找到最后一条用户消息并追加页面上下文
          for (let i = enriched.length - 1; i >= 0; i--) {
            if (enriched[i].role === 'user') {
              const origContent = typeof enriched[i].content === 'string'
                ? enriched[i].content
                : Array.isArray(enriched[i].content)
                  ? enriched[i].content.find(c => c.type === 'text')?.text || ''
                  : ''
              enriched[i] = { ...enriched[i], content: origContent + pageContext }
              break
            }
          }
        }
      }
    } catch (e) {
      // 页面内容获取失败不影响对话
    }
    return enriched
  }

  ipcMain.handle('ai:unified-abort', async () => {
    unifiedAbortFlag = true
    return { success: true }
  })

  // --- 逆向分析 ---
  ipcMain.handle('analysis:get-requests', async () => analyzer.getRequests())

  ipcMain.handle('analysis:run', async (event, { prompt, config }) => {
    try {
      const pageData = await analyzer.collectPageData(tabManager.getActiveBrowserView())
      const analysisContext = analyzer.buildAnalysisContext(prompt, pageData)
      llmProvider.setConfig(config)
      const reply = await llmProvider.chat(analysisContext)
      analyzer.addAnalysisHistory({ prompt, reply, url: pageData?.url || '', title: pageData?.title || '' })
      return { success: true, reply, context: analysisContext }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('analysis:extract-js', async () => {
    const bv = tabManager.getActiveBrowserView()
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

  ipcMain.handle('analysis:reset', async () => { analyzer.reset(); return { success: true } })
  ipcMain.handle('analysis:history', async () => analyzer.getAnalysisHistory())
  ipcMain.handle('analysis:clear-history', async () => { analyzer.clearAnalysisHistory(); return { success: true } })

  ipcMain.handle('analysis:run-stream', async (event, { prompt, config }) => {
    try {
      const pageData = await analyzer.collectPageData(tabManager.getActiveBrowserView())
      const analysisContext = analyzer.buildAnalysisContext(prompt, pageData)
      llmProvider.setConfig(config)
      const stream = await llmProvider.chatStream(analysisContext)
      let fullReply = ''
      for await (const chunk of stream) {
        fullReply += chunk
        safeSend('stream:chunk', { source: 'analysis', chunk })
      }
      safeSend('stream:done', { source: 'analysis' })
      analyzer.addAnalysisHistory({ prompt, reply: fullReply, url: pageData?.url || '', title: pageData?.title || '' })
      return { success: true }
    } catch (e) {
      safeSend('stream:done', { source: 'analysis' })
      return { success: false, error: e.message }
    }
  })

  // --- 智能操作 ---
  ipcMain.handle('action:run', async (event, { instruction, config }) => {
    try {
      const pageContext = await actionExecutor.collectPageContext(tabManager.getActiveBrowserView())
      if (!pageContext) return { success: false, error: '没有打开的页面，请先导航到一个网页' }
      const messages = actionExecutor.buildActionPrompt(instruction, pageContext)
      llmProvider.setConfig(config)
      const reply = await llmProvider.chat(messages)
      actionExecutor.addAssistantReply(reply)
      const jsCode = actionExecutor.extractJsCode(reply)
      if (!jsCode) {
        actionExecutor.addHistory({ instruction, reply, jsCode: null, result: null, status: 'no_code' })
        return { success: false, reply, error: 'LLM未返回可执行的JavaScript代码' }
      }
      const result = await actionExecutor.executeInPage(tabManager.getActiveBrowserView(), jsCode)
      actionExecutor.addHistory({ instruction, reply, jsCode, result, status: result.success ? 'success' : 'error' })
      return { success: true, reply, jsCode, result }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('action:preview', async (event, { instruction, config }) => {
    try {
      const pageContext = await actionExecutor.collectPageContext(tabManager.getActiveBrowserView())
      if (!pageContext) return { success: false, error: '没有打开的页面' }
      const messages = actionExecutor.buildActionPrompt(instruction, pageContext)
      llmProvider.setConfig(config)
      const reply = await llmProvider.chat(messages)
      actionExecutor.addAssistantReply(reply)
      const jsCode = actionExecutor.extractJsCode(reply)
      return { success: true, reply, jsCode }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('action:execute-js', async (event, { jsCode }) => {
    try {
      const result = await actionExecutor.executeInPage(tabManager.getActiveBrowserView(), jsCode)
      return { success: true, result }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('action:history', async () => actionExecutor.getHistory())
  ipcMain.handle('action:clear-history', async () => { actionExecutor.clearHistory(); return { success: true } })
  ipcMain.handle('action:get-context', async () => actionExecutor.collectPageContext(tabManager.getActiveBrowserView()))
  ipcMain.handle('action:clear-session', async () => { actionExecutor.clearSession(); return { success: true } })
  ipcMain.handle('action:get-session', async () => actionExecutor.getSession())

  // ============ 自动注入脚本管理 ============
  ipcMain.handle('action:add-auto-inject', async (event, { name, code, urlPattern }) => {
    const script = actionExecutor.addAutoInjectScript(name, code, urlPattern || '*')
    return { success: true, script }
  })

  ipcMain.handle('action:remove-auto-inject', async (event, { scriptId }) => {
    const removed = actionExecutor.removeAutoInjectScript(scriptId)
    return { success: !!removed, script: removed }
  })

  ipcMain.handle('action:toggle-auto-inject', async (event, { scriptId }) => {
    const script = actionExecutor.toggleAutoInjectScript(scriptId)
    return { success: !!script, script }
  })

  ipcMain.handle('action:get-auto-inject-scripts', async () => {
    return { success: true, scripts: actionExecutor.getAutoInjectScripts() }
  })

  ipcMain.handle('action:run-auto-inject', async () => {
    const results = await actionExecutor.runAutoInjectScripts(tabManager.getActiveBrowserView())
    return { success: true, results }
  })

  ipcMain.handle('action:run-stream', async (event, { instruction, config }) => {
    try {
      const pageContext = await actionExecutor.collectPageContext(tabManager.getActiveBrowserView())
      if (!pageContext) {
        safeSend('stream:done', { source: 'action' })
        return { success: false, error: '没有打开的页面，请先导航到一个网页' }
      }
      const messages = actionExecutor.buildActionPrompt(instruction, pageContext)
      llmProvider.setConfig(config)
      const stream = await llmProvider.chatStream(messages)
      let fullReply = ''
      for await (const chunk of stream) {
        fullReply += chunk
        safeSend('stream:chunk', { source: 'action', chunk })
      }
      safeSend('stream:done', { source: 'action' })
      actionExecutor.addAssistantReply(fullReply)
      const jsCode = actionExecutor.extractJsCode(fullReply)
      let result = null
      if (jsCode) {
        result = await actionExecutor.executeInPage(tabManager.getActiveBrowserView(), jsCode)
      }
      actionExecutor.addHistory({ instruction, reply: fullReply, jsCode, result, status: jsCode ? (result?.success ? 'success' : 'error') : 'no_code' })
      return { success: true, jsCode, result }
    } catch (e) {
      safeSend('stream:done', { source: 'action' })
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('action:preview-stream', async (event, { instruction, config }) => {
    try {
      const pageContext = await actionExecutor.collectPageContext(tabManager.getActiveBrowserView())
      if (!pageContext) {
        safeSend('stream:done', { source: 'action' })
        return { success: false, error: '没有打开的页面' }
      }
      const messages = actionExecutor.buildActionPrompt(instruction, pageContext)
      llmProvider.setConfig(config)
      const stream = await llmProvider.chatStream(messages)
      let fullReply = ''
      for await (const chunk of stream) {
        fullReply += chunk
        safeSend('stream:chunk', { source: 'action', chunk })
      }
      safeSend('stream:done', { source: 'action' })
      actionExecutor.addAssistantReply(fullReply)
      const jsCode = actionExecutor.extractJsCode(fullReply)
      return { success: true, jsCode }
    } catch (e) {
      safeSend('stream:done', { source: 'action' })
      return { success: false, error: e.message }
    }
  })

  // --- 智能体 ---
  ipcMain.handle('agent:run', async (event, { task, config, maxRounds }) => {
    try {
      if (agentLoop.running) return { success: false, error: '智能体正在运行中，请先停止当前任务' }
      llmProvider.setConfig(config)
      if (maxRounds) agentLoop.setMaxRounds(maxRounds)
      const sendEvent = (eventName, data) => safeSend(eventName, data)
      const result = await agentLoop.run(tabManager.getActiveBrowserView(), task, llmProvider, actionExecutor, sendEvent)
      return result
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('agent:abort', async () => { agentLoop.abort(); return { success: true } })
  ipcMain.handle('agent:status', async () => agentLoop.getStatus())
  ipcMain.handle('agent:history', async () => agentLoop.getHistory())
  ipcMain.handle('agent:messages', async () => agentLoop.getMessages())
  ipcMain.handle('agent:clear-history', async () => { agentLoop.clearHistory(); return { success: true } })
  ipcMain.handle('agent:reset', async () => { agentLoop.reset(); return { success: true } })
  ipcMain.handle('agent:set-max-rounds', async (event, { maxRounds }) => { agentLoop.setMaxRounds(maxRounds); return { success: true } })

  // ============ 管理后台 API ============

  // 通用 HTTP 请求辅助函数
  function adminRequest(method, apiPath, token, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(apiPath, token ? 'http://placeholder' : 'http://placeholder')
      // 从 adminServerUrl 中解析
      const serverUrl = body && body._serverUrl ? body._serverUrl : ''
      delete body?._serverUrl
      const fullUrl = serverUrl + apiPath
      const parsedUrl = new URL(fullUrl)
      const isHttps = parsedUrl.protocol === 'https:'
      const client = isHttps ? https : http
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }
      const req = client.request(options, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) })
          } catch {
            resolve({ status: res.statusCode, data })
          }
        })
      })
      req.on('error', reject)
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')) })
      if (body) {
        req.write(JSON.stringify(body))
      }
      req.end()
    })
  }

  // 通用 HTTP 请求辅助函数（multipart/form-data 文件上传）
  function multipartUpload(serverUrl, apiPath, token, filePath, fields = {}, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const fullUrl = serverUrl + apiPath
      const parsedUrl = new URL(fullUrl)
      const isHttps = parsedUrl.protocol === 'https:'
      const client = isHttps ? https : http

      const boundary = '----AIBrowserUpload' + Math.random().toString(36).substring(2)
      const fileName = path.basename(filePath)
      const fileContent = fs.readFileSync(filePath)

      // 构建 multipart body
      const parts = []

      // 添加文件字段
      for (const [key, value] of Object.entries(fields)) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`, 'utf-8'))
      }

      // 添加脚本文件
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="script"; filename="${fileName}"\r\nContent-Type: application/javascript\r\n\r\n`, 'utf-8'))
      parts.push(fileContent)
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'))

      const body = Buffer.concat(parts)

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...extraHeaders,
        },
      }

      const req = client.request(options, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) })
          } catch {
            resolve({ status: res.statusCode, data })
          }
        })
      })
      req.on('error', reject)
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('上传超时')) })
      req.write(body)
      req.end()
    })
  }

  // 上传脚本到管理后台（multipart/form-data 文件上传）
  ipcMain.handle('admin:upload-script', async (event, { serverUrl, token, name, code, description, categoryId, urlPattern, toolType, toolConfig, metadata }) => {
    try {
      if (!serverUrl || !token) {
        return { success: false, error: '请先在设置中配置管理后台地址和 Token' }
      }

      // 将代码写入临时文件
      const tmpDir = os.tmpdir()
      const safeName = (name || 'script').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
      const tmpFile = path.join(tmpDir, `ai-browser-script-${Date.now()}-${safeName}.js`)
      fs.writeFileSync(tmpFile, code, 'utf-8')

      try {
        const uploadFields = {
          name: name || safeName,
          description: description || '',
          category_id: String(categoryId || 1),
          version: '1.0.0',
          url_pattern: urlPattern || '*',
          tool_type: toolType || 'js',
        }
        // 可选字段
        if (toolConfig) uploadFields.tool_config = typeof toolConfig === 'string' ? toolConfig : JSON.stringify(toolConfig)
        if (metadata) uploadFields.metadata = typeof metadata === 'string' ? metadata : JSON.stringify(metadata)

        const result = await multipartUpload(serverUrl, '/api/scripts', token, tmpFile, uploadFields)
        return { success: result.data?.success || false, data: result.data }
      } finally {
        // 清理临时文件
        try { fs.unlinkSync(tmpFile) } catch {}
      }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // 获取脚本列表
  ipcMain.handle('admin:get-scripts', async (event, { serverUrl, token, page, keyword, category }) => {
    try {
      if (!serverUrl || !token) {
        return { success: false, error: '请先配置管理后台地址和 Token' }
      }
      const params = new URLSearchParams()
      if (page) params.set('page', page)
      if (keyword) params.set('keyword', keyword)
      if (category) params.set('category', category)
      const query = params.toString() ? '?' + params.toString() : ''
      const result = await adminRequest('GET', '/api/scripts' + query, token, { _serverUrl: serverUrl })
      return { success: result.data?.success || false, data: result.data }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // 获取分类列表
  ipcMain.handle('admin:get-categories', async (event, { serverUrl, token }) => {
    try {
      if (!serverUrl || !token) {
        return { success: false, error: '请先配置管理后台地址和 Token' }
      }
      const result = await adminRequest('GET', '/api/stats/categories', token, { _serverUrl: serverUrl })
      return { success: result.data?.success || false, data: result.data }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // 获取脚本详情
  ipcMain.handle('admin:get-script-detail', async (event, { serverUrl, token, id }) => {
    try {
      if (!serverUrl || !token) {
        return { success: false, error: '请先配置管理后台地址和 Token' }
      }
      const result = await adminRequest('GET', `/api/scripts/${id}`, token, { _serverUrl: serverUrl })
      // 如果详情中没有 code 字段，尝试下载脚本文件内容
      const detail = result.data?.data || result.data
      if (detail && detail.file_path && !detail.code) {
        try {
          const code = fs.readFileSync(detail.file_path, 'utf-8')
          detail.code = code
        } catch {}
      }
      return { success: true, data: result.data }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // ===== AppKey 签名认证的脚本接口（扩展端使用，无需 JWT Token）=====

  // 生成 AppKey 签名头
  function generateAppAuthHeaders(appKey, appSecret) {
    const crypto = require('crypto')
    const timestamp = String(Math.floor(Date.now() / 1000))
    const message = appKey + timestamp
    const sign = crypto.createHmac('sha256', appSecret).update(message).digest('hex')
    return {
      'Content-Type': 'application/json',
      'X-App-Key': appKey,
      'X-Timestamp': timestamp,
      'X-Sign': sign,
    }
  }

  // 获取脚本列表（AppKey 签名，使用 agent-index 接口）
  ipcMain.handle('scripts:search', async (event, { serverUrl, appKey, appSecret, keyword }) => {
    try {
      if (!serverUrl || !appKey || !appSecret) {
        return { success: false, error: '请先在设置中配置服务器地址和 AppKey/AppSecret' }
      }
      const baseUrl = serverUrl.replace(/\/+$/, '')
      const headers = generateAppAuthHeaders(appKey, appSecret)
      // 有关键词用 search 接口，无关键词用 agent-index 接口
      const url = keyword
        ? `${baseUrl}/api/scripts/search?q=${encodeURIComponent(keyword)}`
        : `${baseUrl}/api/scripts/agent-index`
      const res = await fetchWithTimeout(url, { headers }, 15000)
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` }
      const data = await res.json()
      return { success: data.success !== false, data: data.data || data }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // 获取脚本详情（含代码，AppKey 签名，使用 inject 接口）
  ipcMain.handle('scripts:get-detail', async (event, { serverUrl, appKey, appSecret, id }) => {
    try {
      if (!serverUrl || !appKey || !appSecret) {
        return { success: false, error: '请先配置服务器地址和 AppKey/AppSecret' }
      }
      const baseUrl = serverUrl.replace(/\/+$/, '')
      const headers = generateAppAuthHeaders(appKey, appSecret)
      const res = await fetchWithTimeout(`${baseUrl}/api/scripts/${id}/inject`, { headers }, 15000)
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` }
      const data = await res.json()
      return { success: data.success !== false, data: data.data || data }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // 上传脚本（AppKey 签名，使用 /api/scripts/app-upload 接口）
  ipcMain.handle('scripts:upload', async (event, { serverUrl, appKey, appSecret, name, code, description, categoryId, urlPattern, toolType, toolConfig, metadata }) => {
    try {
      if (!serverUrl || !appKey || !appSecret) {
        return { success: false, error: '请先配置服务器地址和 AppKey/AppSecret' }
      }

      const tmpDir = os.tmpdir()
      const safeName = (name || 'script').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
      const tmpFile = path.join(tmpDir, `ai-browser-script-${Date.now()}-${safeName}.js`)
      fs.writeFileSync(tmpFile, code, 'utf-8')

      try {
        const uploadFields = {
          name: name || safeName,
          description: description || '',
          category_id: String(categoryId || 1),
          version: '1.0.0',
          url_pattern: urlPattern || '*',
          tool_type: toolType || 'js',
        }
        if (toolConfig) uploadFields.tool_config = typeof toolConfig === 'string' ? toolConfig : JSON.stringify(toolConfig)
        if (metadata) uploadFields.metadata = typeof metadata === 'string' ? metadata : JSON.stringify(metadata)

        const authHeaders = generateAppAuthHeaders(appKey, appSecret)
        const result = await multipartUpload(serverUrl, '/api/scripts/app-upload', null, tmpFile, uploadFields, authHeaders)
        return { success: result.data?.success || false, data: result.data }
      } finally {
        try { fs.unlinkSync(tmpFile) } catch {}
      }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // 登录管理后台
  ipcMain.handle('admin:login', async (event, { serverUrl, username, password }) => {
    try {
      if (!serverUrl) {
        return { success: false, error: '请先配置管理后台地址' }
      }
      const result = await adminRequest('POST', '/api/auth/login', null, { username, password, _serverUrl: serverUrl })
      return { success: result.data?.success || false, data: result.data }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })
}

// ============ 请求拦截 ============

function setupRequestInterception() {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
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

// ============ 应用生命周期 ============

app.whenReady().then(() => {
  createMainWindow()
  createTray()
  tabManager = new TabManager(mainWindow)

  // 注册页面加载完成回调 → 自动注入脚本
  tabManager.onPageLoaded(async (browserView, url) => {
    if (actionExecutor.getAutoInjectScripts().length > 0) {
      // 延迟500ms确保DOM完全加载
      await new Promise(r => setTimeout(r, 500))
      const results = await actionExecutor.runAutoInjectScripts(browserView)
      if (results.length > 0) {
        // 通知前端面板
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auto-inject:executed', { url, results })
        }
      }
    }
  })

  // 注册标签切换回调 → 重新设置BrowserView bounds
  tabManager.onTabSwitch(() => {
    resizeBrowserView()
  })

  // 划词/右键AI操作：从 BrowserView 接收操作，转发到面板
  tabManager.onSelectionAction((action, text) => {
    // 构造与 Chrome 扩展版一致的提示词
    const pagePrompts = {
      summarize: '总结当前页面内容',
      translate: '翻译当前页面为中文',
    }
    const selectionPrompts = {
      explain: '请解释以下内容：\n\n',
      translate: '请将以下内容翻译为中文：\n\n',
      rewrite: '请改写以下内容：\n\n',
      summarize: '请总结以下内容要点：\n\n',
    }
    let fullMessage
    if (!text && pagePrompts[action]) {
      fullMessage = pagePrompts[action]
    } else {
      const prompt = selectionPrompts[action] || '请分析以下内容：\n\n'
      fullMessage = prompt + text
    }
    // 发送到面板，面板监听 panel:external-message 事件后自动发送
    safeSend('panel:external-message', { message: fullMessage })
  })

  // 接收 BrowserView 中划词工具栏的操作
  ipcMain.on('browser:selection-action', (event, { action, text }) => {
    if (tabManager._onSelectionActionCb) {
      tabManager._onSelectionActionCb(action, text)
    }
  })

  registerIpcHandlers()
  tabManager.createTab('about:blank')
  // 关键：创建标签后立即设置 BrowserView 的 bounds，否则页面空白
  resizeBrowserView()
  setupRequestInterception()
  mainWindow.on('resize', resizeBrowserView)

  // 初始化迁移的服务（Agent v2、配置管理、上下文管理、定时任务等）
  serviceManager.init({ tabManager, actionExecutor, toolExecutor }).catch(err => {
    console.error('[ServiceManager] 初始化失败:', err)
  })
})

app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  app.isQuitting = true
  // 清理迁移服务的资源（定时器、存储刷新等）
  serviceManager.cleanup()
})

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show()
  } else {
    createMainWindow()
  }
})