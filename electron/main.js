const { app, BrowserWindow, BrowserView, ipcMain, session, shell, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const https = require('https')
const LLMProvider = require('./ai/llm_provider')
const Analyzer = require('./ai/analyzer')
const ActionExecutor = require('./ai/action_executor')
const AgentLoop = require('./ai/agent_loop')
const TOOL_DEFINITIONS = require('./ai/tool_definitions')
const ToolExecutor = require('./ai/tool_executor')
const TabManager = require('./tab_manager')

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
  if (isWindowValid()) {
    mainWindow.webContents.send(channel, data)
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

  // --- AI 对话 ---
  ipcMain.handle('ai:chat', async (event, { messages, config }) => {
    try {
      llmProvider.setConfig(config)
      const reply = await llmProvider.chat(messages)
      return { success: true, reply }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('ai:chat-stream', async (event, { messages, config }) => {
    try {
      llmProvider.setConfig(config)
      const stream = await llmProvider.chatStream(messages)
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

  // --- 统一 AI 工具调用 ---
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

      safeSend('unified:start', {})

      for (let round = 0; round < maxRounds; round++) {
        if (unifiedAbortFlag) {
          safeSend('unified:done', { success: false, summary: '已中止' })
          return { success: false, summary: '已中止' }
        }

        const aiMessage = await llmProvider.chat(currentMessages, { tools: TOOL_DEFINITIONS })

        if (!aiMessage.tool_calls || aiMessage.tool_calls.length === 0) {
          const content = aiMessage.content || ''
          safeSend('unified:final-reply', { content })
          safeSend('unified:done', { success: true, summary: content.substring(0, 200) })
          return { success: true, content }
        }

        currentMessages.push(aiMessage)

        for (const toolCall of aiMessage.tool_calls) {
          if (unifiedAbortFlag) break

          const toolName = toolCall.function.name
          let toolArgs = {}
          try { toolArgs = JSON.parse(toolCall.function.arguments || '{}') } catch (e) {}

          safeSend('unified:tool-call', { round: round + 1, toolName, toolArgs, callId: toolCall.id })

          const toolResult = await toolExecutor.execute(toolName, toolArgs, {
            browserView: tabManager.getActiveBrowserView(),
            analyzer,
            actionExecutor,
            tabManager: {
              createTab: (url) => tabManager.createTab(url),
              closeTab: (id) => tabManager.closeTab(id),
              getActiveTabId: () => tabManager.activeTabId,
            },
          })

          safeSend('unified:tool-result', {
            round: round + 1, toolName, success: toolResult.success,
            result: toolResult.result, error: toolResult.error,
            description: toolResult.description, callId: toolCall.id,
            loopWarning: toolResult.loopWarning || undefined,
          })

          // 将工具结果反馈给AI，包含循环检测警告
          const toolContent = toolResult.success
            ? JSON.stringify(toolResult.result)
            : JSON.stringify({ error: toolResult.error })

          currentMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult.loopWarning
              ? toolContent + '\n\n' + toolResult.loopWarning
              : toolContent,
          })
        }
      }

      safeSend('unified:done', { success: false, summary: `已达到最大工具调用轮次 (${maxRounds})` })
      return { success: false, summary: '达到最大轮次' }
    } catch (e) {
      safeSend('unified:done', { success: false, summary: e.message, error: e.message })
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('ai:unified-chat-stream', async (event, { messages, config, maxToolRounds }) => {
    try {
      llmProvider.setConfig(config)
      unifiedAbortFlag = false
      const maxRounds = maxToolRounds || 20
      let currentMessages = [
        { role: 'system', content: SYSTEM_PROMPT_UNIFIED },
        ...messages,
      ]

      safeSend('unified:start', {})

      for (let round = 0; round < maxRounds; round++) {
        if (unifiedAbortFlag) {
          safeSend('unified:done', { success: false, summary: '已中止' })
          return { success: false, summary: '已中止' }
        }

        let fullContent = ''
        let toolCallsAccum = {}
        let hasToolCalls = false

        safeSend('unified:thinking', { round: round + 1 })

        // 添加超时保护
        const streamPromise = (async () => {
          const stream = llmProvider.chatStream(currentMessages, { tools: TOOL_DEFINITIONS })
          for await (const item of stream) {
            if (unifiedAbortFlag) break
            if (item.type === 'content') {
              fullContent += item.content
              safeSend('unified:stream-chunk', { chunk: item.content })
            } else if (item.type === 'tool_calls' || item.type === 'tool_call') {
              hasToolCalls = true
              const calls = item.tool_calls || [item.tool_call]
              for (const tc of calls) {
                const idx = tc.index ?? 0
                toolCallsAccum[idx] = tc
              }
            }
          }
        })()

        // 设置单轮超时（5分钟）
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('AI响应超时（5分钟），请检查网络连接或API配置')), 300000)
        })

        try {
          await Promise.race([streamPromise, timeoutPromise])
        } catch (err) {
          throw err
        }

        if (unifiedAbortFlag) {
          safeSend('unified:done', { success: false, summary: '已中止' })
          return { success: false, summary: '已中止' }
        }

        if (!hasToolCalls || Object.keys(toolCallsAccum).length === 0) {
          safeSend('unified:final-reply', { content: fullContent })
          safeSend('unified:done', { success: true, summary: fullContent.substring(0, 200) })
          return { success: true, content: fullContent }
        }

        const assistantMsg = {
          role: 'assistant',
          content: fullContent || null,
          tool_calls: Object.values(toolCallsAccum).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
        }
        currentMessages.push(assistantMsg)

        for (const toolCall of assistantMsg.tool_calls) {
          if (unifiedAbortFlag) break

          const toolName = toolCall.function.name
          let toolArgs = {}
          try { toolArgs = JSON.parse(toolCall.function.arguments || '{}') } catch (e) {}

          safeSend('unified:tool-call', { round: round + 1, toolName, toolArgs, callId: toolCall.id })

          const toolResult = await toolExecutor.execute(toolName, toolArgs, {
            browserView: tabManager.getActiveBrowserView(),
            analyzer,
            actionExecutor,
          })

          safeSend('unified:tool-result', {
            round: round + 1, toolName, success: toolResult.success,
            result: toolResult.result, error: toolResult.error,
            description: toolResult.description, callId: toolCall.id,
            loopWarning: toolResult.loopWarning || undefined,
          })

          // 将工具结果反馈给AI，包含循环检测警告
          const toolContent = toolResult.success
            ? JSON.stringify(toolResult.result)
            : JSON.stringify({ error: toolResult.error })

          currentMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult.loopWarning
              ? toolContent + '\n\n' + toolResult.loopWarning
              : toolContent,
          })
        }
      }

      safeSend('unified:done', { success: false, summary: `已达到最大工具调用轮次 (${maxRounds})` })
      return { success: false, summary: '达到最大轮次' }
    } catch (e) {
      console.error('AI调用错误:', e)
      safeSend('unified:done', { success: false, summary: e.message, error: e.message })
      return { success: false, error: e.message }
    }
  })

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
  function multipartUpload(serverUrl, apiPath, token, filePath, fields = {}) {
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
  ipcMain.handle('admin:upload-script', async (event, { serverUrl, token, name, code, description, categoryId }) => {
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
        const result = await multipartUpload(serverUrl, '/api/scripts', token, tmpFile, {
          name: name || safeName,
          description: description || '',
          category_id: String(categoryId || 1),
          version: '1.0.0',
          url_pattern: '*',
        })
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

  registerIpcHandlers()
  tabManager.createTab('about:blank')
  // 关键：创建标签后立即设置 BrowserView 的 bounds，否则页面空白
  resizeBrowserView()
  setupRequestInterception()
  mainWindow.on('resize', resizeBrowserView)
})

app.on('window-all-closed', () => {})

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