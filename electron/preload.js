const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // 浏览器控制
  browser: {
    navigate: (url) => ipcRenderer.invoke('browser:navigate', url),
    back: () => ipcRenderer.invoke('browser:back'),
    forward: () => ipcRenderer.invoke('browser:forward'),
    reload: () => ipcRenderer.invoke('browser:reload'),
    reloadIgnoreCache: () => ipcRenderer.invoke('browser:reload-ignore-cache'),
    stop: () => ipcRenderer.invoke('browser:stop'),
    getUrl: () => ipcRenderer.invoke('browser:get-url'),
    getTitle: () => ipcRenderer.invoke('browser:get-title'),
    getHtml: () => ipcRenderer.invoke('browser:get-html'),
    isLoading: () => ipcRenderer.invoke('browser:is-loading'),
    canGoBack: () => ipcRenderer.invoke('browser:can-go-back'),
    canGoForward: () => ipcRenderer.invoke('browser:can-go-forward'),
    openExternal: (url) => ipcRenderer.invoke('browser:open-external', url),
    installTampermonkey: ({ name, description, code, urlPattern }) => ipcRenderer.invoke('browser:install-tampermonkey', { name, description, code, urlPattern }),
    resize: (ratio) => ipcRenderer.send('browser:resize', { browserRatio: ratio }),
    togglePanel: (visible) => ipcRenderer.invoke('panel:toggle', { visible }),
    onNavState: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('browser:nav-state', handler)
      return () => ipcRenderer.removeListener('browser:nav-state', handler)
    },
  },
  // 面板控制
  panel: {
    setPosition: ({ position, ratio }) => ipcRenderer.invoke('panel:set-position', { position, ratio }),
    getPosition: () => ipcRenderer.invoke('panel:get-position'),
  },
  // 标签页管理
  tabs: {
    create: (url) => ipcRenderer.invoke('tabs:create', { url }),
    close: (id) => ipcRenderer.invoke('tabs:close', { id }),
    switch: (id) => ipcRenderer.invoke('tabs:switch', { id }),
    list: () => ipcRenderer.invoke('tabs:list'),
    reorder: (ids) => ipcRenderer.invoke('tabs:reorder', { ids }),
    onUpdated: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('tabs:updated', handler)
      return () => ipcRenderer.removeListener('tabs:updated', handler)
    },
  },
  // 页面内查找
  find: {
    start: (text) => ipcRenderer.invoke('find:start', { text }),
    next: () => ipcRenderer.invoke('find:next'),
    previous: () => ipcRenderer.invoke('find:previous'),
    stop: () => ipcRenderer.invoke('find:stop'),
  },
  // AI对话
  ai: {
    chat: (messages, config) => ipcRenderer.invoke('ai:chat', { messages, config }),
    chatStream: (messages, config) => ipcRenderer.invoke('ai:chat-stream', { messages, config }),
    onStreamChunk: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('stream:chunk', handler)
      return () => ipcRenderer.removeListener('stream:chunk', handler)
    },
    onStreamDone: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('stream:done', handler)
      return () => ipcRenderer.removeListener('stream:done', handler)
    },
  },
  // 逆向分析
  analysis: {
    getRequests: () => ipcRenderer.invoke('analysis:get-requests'),
    run: (prompt, config) => ipcRenderer.invoke('analysis:run', { prompt, config }),
    runStream: (prompt, config) => ipcRenderer.invoke('analysis:run-stream', { prompt, config }),
    extractJs: () => ipcRenderer.invoke('analysis:extract-js'),
    reset: () => ipcRenderer.invoke('analysis:reset'),
    getHistory: () => ipcRenderer.invoke('analysis:history'),
    clearHistory: () => ipcRenderer.invoke('analysis:clear-history'),
  },
  // 智能操作
  action: {
    run: (instruction, config) => ipcRenderer.invoke('action:run', { instruction, config }),
    runStream: (instruction, config) => ipcRenderer.invoke('action:run-stream', { instruction, config }),
    preview: (instruction, config) => ipcRenderer.invoke('action:preview', { instruction, config }),
    previewStream: (instruction, config) => ipcRenderer.invoke('action:preview-stream', { instruction, config }),
    executeJs: (jsCode) => ipcRenderer.invoke('action:execute-js', { jsCode }),
    getHistory: () => ipcRenderer.invoke('action:history'),
    clearHistory: () => ipcRenderer.invoke('action:clear-history'),
    getContext: () => ipcRenderer.invoke('action:get-context'),
    clearSession: () => ipcRenderer.invoke('action:clear-session'),
    getSession: () => ipcRenderer.invoke('action:get-session'),
    // 自动注入脚本管理
    addAutoInject: (name, code, urlPattern) => ipcRenderer.invoke('action:add-auto-inject', { name, code, urlPattern }),
    removeAutoInject: (scriptId) => ipcRenderer.invoke('action:remove-auto-inject', { scriptId }),
    toggleAutoInject: (scriptId) => ipcRenderer.invoke('action:toggle-auto-inject', { scriptId }),
    getAutoInjectScripts: () => ipcRenderer.invoke('action:get-auto-inject-scripts'),
    runAutoInject: () => ipcRenderer.invoke('action:run-auto-inject'),
    onAutoInjectExecuted: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('auto-inject:executed', handler)
      return () => ipcRenderer.removeListener('auto-inject:executed', handler)
    },
  },
  // 统一AI工具调用（核心：AI决策，客户端执行）
  unified: {
    chat: (messages, config, maxToolRounds) => ipcRenderer.invoke('ai:unified-chat', { messages, config, maxToolRounds }),
    chatStream: (messages, config, maxToolRounds) => ipcRenderer.invoke('ai:unified-chat-stream', { messages, config, maxToolRounds }),
    abort: () => ipcRenderer.invoke('ai:unified-abort'),
    onStart: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('unified:start', handler)
      return () => ipcRenderer.removeListener('unified:start', handler)
    },
    onThinking: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('unified:thinking', handler)
      return () => ipcRenderer.removeListener('unified:thinking', handler)
    },
    onStreamChunk: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('unified:stream-chunk', handler)
      return () => ipcRenderer.removeListener('unified:stream-chunk', handler)
    },
    onToolCall: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('unified:tool-call', handler)
      return () => ipcRenderer.removeListener('unified:tool-call', handler)
    },
    onToolResult: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('unified:tool-result', handler)
      return () => ipcRenderer.removeListener('unified:tool-result', handler)
    },
    onFinalReply: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('unified:final-reply', handler)
      return () => ipcRenderer.removeListener('unified:final-reply', handler)
    },
    onDone: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('unified:done', handler)
      return () => ipcRenderer.removeListener('unified:done', handler)
    },
  },
  // 管理后台 API
  admin: {
    uploadScript: ({ serverUrl, token, name, code, description, categoryId }) =>
      ipcRenderer.invoke('admin:upload-script', { serverUrl, token, name, code, description, categoryId }),
    getScripts: ({ serverUrl, token, page, keyword, category }) =>
      ipcRenderer.invoke('admin:get-scripts', { serverUrl, token, page, keyword, category }),
    getScriptDetail: ({ serverUrl, token, id }) =>
      ipcRenderer.invoke('admin:get-script-detail', { serverUrl, token, id }),
    getCategories: ({ serverUrl, token }) =>
      ipcRenderer.invoke('admin:get-categories', { serverUrl, token }),
    login: ({ serverUrl, username, password }) =>
      ipcRenderer.invoke('admin:login', { serverUrl, username, password }),
  },
  // 智能体
  agent: {
    run: (task, config, maxRounds) => ipcRenderer.invoke('agent:run', { task, config, maxRounds }),
    abort: () => ipcRenderer.invoke('agent:abort'),
    getStatus: () => ipcRenderer.invoke('agent:status'),
    getHistory: () => ipcRenderer.invoke('agent:history'),
    getMessages: () => ipcRenderer.invoke('agent:messages'),
    clearHistory: () => ipcRenderer.invoke('agent:clear-history'),
    reset: () => ipcRenderer.invoke('agent:reset'),
    setMaxRounds: (maxRounds) => ipcRenderer.invoke('agent:set-max-rounds', { maxRounds }),
    onAgentStart: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('agent:start', handler)
      return () => ipcRenderer.removeListener('agent:start', handler)
    },
    onAgentRound: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('agent:round', handler)
      return () => ipcRenderer.removeListener('agent:round', handler)
    },
    onAgentStream: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('agent:stream', handler)
      return () => ipcRenderer.removeListener('agent:stream', handler)
    },
    onAgentDone: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('agent:done', handler)
      return () => ipcRenderer.removeListener('agent:done', handler)
    },
  },
})
