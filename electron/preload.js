const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // 浏览器控制
  browser: {
    navigate: (url) => ipcRenderer.invoke('browser:navigate', url),
    back: () => ipcRenderer.invoke('browser:back'),
    forward: () => ipcRenderer.invoke('browser:forward'),
    getUrl: () => ipcRenderer.invoke('browser:get-url'),
    getTitle: () => ipcRenderer.invoke('browser:get-title'),
    getHtml: () => ipcRenderer.invoke('browser:get-html'),
    resize: (ratio) => ipcRenderer.send('browser:resize', { browserRatio: ratio }),
  },
  // AI对话
  ai: {
    chat: (messages, config) => ipcRenderer.invoke('ai:chat', { messages, config }),
    chatStream: (messages, config) => ipcRenderer.invoke('ai:chat-stream', { messages, config }),
    onStreamChunk: (callback) => ipcRenderer.on('ai:stream-chunk', (e, chunk) => callback(chunk)),
    onStreamDone: (callback) => ipcRenderer.on('ai:stream-done', () => callback()),
  },
  // 逆向分析
  analysis: {
    getRequests: () => ipcRenderer.invoke('analysis:get-requests'),
    run: (prompt, config) => ipcRenderer.invoke('analysis:run', { prompt, config }),
    extractJs: () => ipcRenderer.invoke('analysis:extract-js'),
    reset: () => ipcRenderer.invoke('analysis:reset'),
  },
})
