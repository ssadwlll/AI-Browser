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
  // 内置工具浮动窗口
  toolWindow: {
    open: () => ipcRenderer.invoke('tool-window:open'),
    close: () => ipcRenderer.invoke('tool-window:close'),
  },
  // 全景对话窗口
  conversationWindow: {
    open: () => ipcRenderer.invoke('conversation-window:open'),
    close: () => ipcRenderer.invoke('conversation-window:close'),
  },
  // 数据报告窗口
  reportWindow: {
    show: (data) => ipcRenderer.invoke('report-window:show', data),
    getData: () => ipcRenderer.invoke('report-window:get-data'),
    close: () => ipcRenderer.invoke('report-window:close'),
    onData: (callback) => {
      const handler = (_event, data) => callback(data)
      ipcRenderer.on('report:data', handler)
      return () => ipcRenderer.removeListener('report:data', handler)
    },
  },
  // 备用关闭方法（直接调用 IPC）
  closeReportWindow: () => ipcRenderer.invoke('report-window:close'),
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
  // ============ 迁移自 chrome-extension 的新增 API ============
  // Agent v2 自主决策（完整迁移版：8阶段主循环 + 15层防死循环 + 工作记忆 + 上下文压缩）
  agent2: {
    start: ({ tabId, userMessage, chatHistory, modelInfo }) =>
      ipcRenderer.invoke('agent:v2-start', { tabId, userMessage, chatHistory, modelInfo }),
    abort: (tabId) => ipcRenderer.invoke('agent:v2-abort', { tabId }),
    getStatus: (tabId) => ipcRenderer.invoke('agent:v2-status', { tabId }),
    getRunning: () => ipcRenderer.invoke('agent:v2-running'),
    judge: ({ userMessage, agentSummary, executedTools }) =>
      ipcRenderer.invoke('agent:v2-judge', { userMessage, agentSummary, executedTools }),
    recordMemory: ({ scriptId, success, durationMs, errorMessage, resultSummary }) =>
      ipcRenderer.invoke('agent:v2-record-memory', { scriptId, success, durationMs, errorMessage, resultSummary }),
    // 事件监听（统一事件通道 agent:v2-event）
    onEvent: (callback) => {
      const handler = (e, { channel, data }) => callback(channel, data)
      ipcRenderer.on('agent:v2-event', handler)
      return () => ipcRenderer.removeListener('agent:v2-event', handler)
    },
    onDone: (callback) => {
      const handler = (e, data) => callback(data)
      ipcRenderer.on('agent:v2-done', handler)
      return () => ipcRenderer.removeListener('agent:v2-done', handler)
    },
  },
  // 配置管理
  config: {
    getAI: () => ipcRenderer.invoke('config:get-ai'),
    saveAI: (config) => ipcRenderer.invoke('config:save-ai', { config }),
    getSync: () => ipcRenderer.invoke('config:get-sync'),
    saveSync: (config) => ipcRenderer.invoke('config:save-sync', { config }),
    getAgent: () => ipcRenderer.invoke('config:get-agent'),
    saveAgent: (config) => ipcRenderer.invoke('config:save-agent', { config }),
    getAppSettings: () => ipcRenderer.invoke('config:get-app-settings'),
    getAvailableModels: () => ipcRenderer.invoke('config:get-available-models'),
    getSelectionTools: () => ipcRenderer.invoke('config:get-selection-tools'),
    saveSelectionTools: (enabled) => ipcRenderer.invoke('config:save-selection-tools', { enabled }),
  },
  // 待办调度
  todo: {
    getTemplate: ({ userMessage, pageContent, searchResults }) =>
      ipcRenderer.invoke('todo:get-template', { userMessage, pageContent, searchResults }),
    submit: (items) => ipcRenderer.invoke('todo:submit', { items }),
    getCurrent: () => ipcRenderer.invoke('todo:get-current'),
    getProgress: () => ipcRenderer.invoke('todo:get-progress'),
    getContext: () => ipcRenderer.invoke('todo:get-context'),
    clear: () => ipcRenderer.invoke('todo:clear'),
  },
  // 定时任务
  scheduledTask: {
    list: () => ipcRenderer.invoke('scheduled-task:list'),
    create: (task) => ipcRenderer.invoke('scheduled-task:create', { task }),
    update: (taskId, updates) => ipcRenderer.invoke('scheduled-task:update', { taskId, updates }),
    delete: (taskId) => ipcRenderer.invoke('scheduled-task:delete', { taskId }),
    get: (taskId) => ipcRenderer.invoke('scheduled-task:get', { taskId }),
    enable: (taskId) => ipcRenderer.invoke('scheduled-task:enable', { taskId }),
    disable: (taskId) => ipcRenderer.invoke('scheduled-task:disable', { taskId }),
  },
  // 任务模板
  taskTemplate: {
    list: (category) => ipcRenderer.invoke('task-template:list', { category }),
    get: (templateId) => ipcRenderer.invoke('task-template:get', { templateId }),
    create: (template) => ipcRenderer.invoke('task-template:create', { template }),
    update: (templateId, updates) => ipcRenderer.invoke('task-template:update', { templateId, updates }),
    delete: (templateId) => ipcRenderer.invoke('task-template:delete', { templateId }),
    instantiate: (templateId, variables) => ipcRenderer.invoke('task-template:instantiate', { templateId, variables }),
    export: (templateId) => ipcRenderer.invoke('task-template:export', { templateId }),
    import: (jsonStr) => ipcRenderer.invoke('task-template:import', { jsonStr }),
  },
  // 工具录制
  toolRecording: {
    list: (limit) => ipcRenderer.invoke('tool-recording:list', { limit }),
    get: (sessionId) => ipcRenderer.invoke('tool-recording:get', { sessionId }),
    delete: (sessionId) => ipcRenderer.invoke('tool-recording:delete', { sessionId }),
    export: (sessionId) => ipcRenderer.invoke('tool-recording:export', { sessionId }),
    import: (jsonStr) => ipcRenderer.invoke('tool-recording:import', { jsonStr }),
  },
  // 中间推理 (Scratchpad)
  scratchpad: {
    list: (limit) => ipcRenderer.invoke('scratchpad:list', { limit }),
    load: (sessionId) => ipcRenderer.invoke('scratchpad:load', { sessionId }),
    delete: (sessionId) => ipcRenderer.invoke('scratchpad:delete', { sessionId }),
    clear: () => ipcRenderer.invoke('scratchpad:clear'),
    export: (sessionId) => ipcRenderer.invoke('scratchpad:export', { sessionId }),
    exportAll: () => ipcRenderer.invoke('scratchpad:export-all'),
  },
  // 人工介入
  humanIntervention: {
    getPending: () => ipcRenderer.invoke('human-intervention:get-pending'),
    respond: (requestId, response) => ipcRenderer.invoke('human-intervention:respond', { requestId, response }),
    cancel: (requestId) => ipcRenderer.invoke('human-intervention:cancel', { requestId }),
    clearExpired: (maxAgeMs) => ipcRenderer.invoke('human-intervention:clear-expired', { maxAgeMs }),
  },
  // 结果输出
  output: {
    list: (limit) => ipcRenderer.invoke('output:list', { limit }),
    get: (sessionId) => ipcRenderer.invoke('output:get', { sessionId }),
    delete: (sessionId) => ipcRenderer.invoke('output:delete', { sessionId }),
    clear: () => ipcRenderer.invoke('output:clear'),
    export: (sessionId) => ipcRenderer.invoke('output:export', { sessionId }),
  },
  // 任务归档
  taskArchive: {
    list: (limit) => ipcRenderer.invoke('task-archive:list', { limit }),
    get: (archiveId) => ipcRenderer.invoke('task-archive:get', { archiveId }),
    delete: (archiveId) => ipcRenderer.invoke('task-archive:delete', { archiveId }),
    clear: () => ipcRenderer.invoke('task-archive:clear'),
    search: (query) => ipcRenderer.invoke('task-archive:search', { query }),
    findSimilar: (archiveId) => ipcRenderer.invoke('task-archive:find-similar', { archiveId }),
  },
  // 外部消息监听（划词/右键AI操作）
  onExternalMessage: (callback) => {
    const handler = (e, data) => callback(data)
    ipcRenderer.on('panel:external-message', handler)
    return () => ipcRenderer.removeListener('panel:external-message', handler)
  },
})
