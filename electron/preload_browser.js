const { ipcRenderer } = require('electron')

// ============ 浏览器指纹伪装（在页面主世界 JS 执行前注入） ============
// contextIsolation: false 让此脚本在主世界运行
// 小红书 ACE 引擎在主世界检测指纹，必须在页面 JS 执行前伪装
;(function injectFingerprintSpoof() {
  try {
    // 伪装 navigator.webdriver = false
    try {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
        configurable: true,
      })
    } catch (e) {}

    // 补全 window.chrome 对象（Electron 的 chrome 对象是空的）
    // 真实 Chrome 浏览器的 window.chrome 有 runtime、loadTimes、csi 等
    try {
      if (!window.chrome || Object.keys(window.chrome).length === 0) {
        window.chrome = {
          runtime: {
            id: undefined,
            connect: () => ({}),
            sendMessage: () => ({}),
            onMessage: { addListener: () => {}, removeListener: () => {} },
          },
          loadTimes: () => ({
            requestTime: Date.now() / 1000,
            startLoadTime: Date.now() / 1000 - 0.5,
            commitLoadTime: Date.now() / 1000 - 0.3,
            finishDocumentLoadTime: Date.now() / 1000 - 0.1,
            finishLoadTime: Date.now() / 1000,
            firstPaintTime: Date.now() / 1000 - 0.05,
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other',
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
          }),
          csi: () => ({
            onloadT: Date.now(),
            startE: Date.now() - 1000,
            pageT: 500,
            tran: 15,
          }),
          app: {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
            getDetails: () => null,
            getIsInstalled: () => false,
          },
        }
      }
    } catch (e) {}

    // 伪装 permissions API
    try {
      const origQuery = window.navigator.permissions.query
      window.navigator.permissions.query = function (parameters) {
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission, onchange: null })
        }
        return origQuery.call(this, parameters)
      }
    } catch (e) {}

    // 伪装 plugins（Electron 的 navigator.plugins 可能为空或长度异常）
    try {
      const fakePlugins = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      ]
      Object.defineProperty(navigator, 'plugins', {
        get: () => fakePlugins,
        configurable: true,
      })
      Object.defineProperty(navigator.plugins, 'length', {
        get: () => fakePlugins.length,
        configurable: true,
      })
    } catch (e) {}

    // 伪装 languages
    try {
      Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en-US', 'en'],
        configurable: true,
      })
    } catch (e) {}

    // 伪装 platform
    try {
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Win32',
        configurable: true,
      })
    } catch (e) {}

    // 伪装 hardwareConcurrency
    try {
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8,
        configurable: true,
      })
    } catch (e) {}

    // 伪装 deviceMemory
    try {
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8,
        configurable: true,
      })
    } catch (e) {}

    // 移除 Electron 相关的全局变量
    try {
      delete window.process
    } catch (e) {}
  } catch (e) {
    console.warn('[Preload] 指纹伪装注入失败:', e.message)
  }
})()

// ============ 暴露 BrowserAPI 给页面（contextIsolation: false，直接挂 window） ============
window.browserAPI = {
  onContextMenu: (callback) => {
    const handler = (e, data) => callback(data)
    ipcRenderer.on('browser:context-menu', handler)
    return () => ipcRenderer.removeListener('browser:context-menu', handler)
  },
  selectionAction: (action, text) => ipcRenderer.send('browser:selection-action', { action, text }),
  getSelectionToolsEnabled: () => ipcRenderer.invoke('browser:get-selection-tools'),
}

// ============ 小红书 API 桥接（方案 A：Headless 浏览器） ============
// 注入脚本可通过 window.xhsApi 调用主进程的 XHS API 服务
// 主进程会在页面上下文中调用 window.mnsv2 生成签名，然后用 Node.js 发起 API 请求
window.xhsApi = {
  checkEnv: () => ipcRenderer.invoke('xhs:check-env'),
  search: (opts) => ipcRenderer.invoke('xhs:search', opts || {}),
  getNote: (opts) => ipcRenderer.invoke('xhs:get-note', opts || {}),
  batchGetNotes: (opts) => ipcRenderer.invoke('xhs:batch-get-notes', opts || {}),
  getComments: (opts) => ipcRenderer.invoke('xhs:get-comments', opts || {}),
  getUser: (opts) => ipcRenderer.invoke('xhs:get-user', opts || {}),
  getUserNotes: (opts) => ipcRenderer.invoke('xhs:get-user-notes', opts || {}),
  resetSession: () => ipcRenderer.invoke('xhs:reset-session'),
}
