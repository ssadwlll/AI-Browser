const { app, BrowserWindow, BrowserView, ipcMain, session, shell } = require('electron')
const path = require('path')
const LLMProvider = require('./ai/llm_provider')
const Analyzer = require('./ai/analyzer')

let mainWindow
let browserView
let llmProvider = new LLMProvider()
let analyzer = new Analyzer()

const isDev = process.env.NODE_ENV === 'development'

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

  mainWindow.on('closed', () => {
    mainWindow = null
    browserView = null
  })
}

function attachBrowserView() {
  browserView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload_browser.js'),
    },
  })
  mainWindow.addBrowserView(browserView)
  resizeBrowserView()
}

function resizeBrowserView() {
  if (!mainWindow || !browserView) return
  const [width, height] = mainWindow.getContentSize()
  // 浏览器视图占左侧 65%，右侧留给 AI 侧边栏
  const browserWidth = Math.floor(width * 0.65)
  browserView.setBounds({ x: 0, y: 40, width: browserWidth, height: height - 40 })
}

// ============ IPC 处理 ============

// 导航
ipcMain.handle('browser:navigate', async (event, url) => {
  if (!browserView) attachBrowserView()
  if (!url.startsWith('http')) {
    url = 'https://' + url
  }
  analyzer.reset()
  browserView.webContents.loadURL(url)
  return { success: true, url }
})

// 后退
ipcMain.handle('browser:back', async () => {
  if (browserView && browserView.webContents.navigationHistory.canGoBack()) {
    browserView.webContents.navigationHistory.goBack()
    return { success: true }
  }
  return { success: false }
})

// 前进
ipcMain.handle('browser:forward', async () => {
  if (browserView && browserView.webContents.navigationHistory.canGoForward()) {
    browserView.webContents.navigationHistory.goForward()
    return { success: true }
  }
  return { success: false }
})

// 获取当前URL
ipcMain.handle('browser:get-url', async () => {
  if (browserView) {
    return browserView.webContents.getURL()
  }
  return ''
})

// 获取页面HTML
ipcMain.handle('browser:get-html', async () => {
  if (!browserView) return ''
  try {
    const html = await browserView.webContents.executeJavaScript('document.documentElement.outerHTML')
    return html
  } catch (e) {
    return ''
  }
})

// 获取页面标题
ipcMain.handle('browser:get-title', async () => {
  if (!browserView) return ''
  return browserView.webContents.getTitle()
})

// 调整浏览器视图大小
ipcMain.on('browser:resize', (event, { browserRatio }) => {
  if (!mainWindow || !browserView) return
  const [width, height] = mainWindow.getContentSize()
  const browserWidth = Math.floor(width * browserRatio)
  browserView.setBounds({ x: 0, y: 40, width: browserWidth, height: height - 40 })
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
    for await (const chunk of stream) {
      mainWindow.webContents.send('ai:stream-chunk', chunk)
    }
    mainWindow.webContents.send('ai:stream-done')
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ============ 逆向分析功能 ============

// 获取所有捕获的请求
ipcMain.handle('analysis:get-requests', async () => {
  return analyzer.getRequests()
})

// 综合分析：将页面信息+请求列表交给AI分析
ipcMain.handle('analysis:run', async (event, { prompt, config }) => {
  try {
    const pageData = await analyzer.collectPageData(browserView)
    const analysisContext = analyzer.buildAnalysisContext(prompt, pageData)
    llmProvider.setConfig(config)
    const reply = await llmProvider.chat(analysisContext)
    return { success: true, reply, context: analysisContext }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// 提取JS代码
ipcMain.handle('analysis:extract-js', async () => {
  if (!browserView) return { scripts: [] }
  try {
    const scripts = await browserView.webContents.executeJavaScript(`
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

// ============ 应用生命周期 ============

app.whenReady().then(() => {
  createMainWindow()
  attachBrowserView()
  setupRequestInterception()

  mainWindow.on('resize', resizeBrowserView)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
})
