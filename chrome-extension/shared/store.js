// AI Browser Chrome Extension - 轻量状态管理

class Store {
  constructor() {
    this._state = {}
    this._listeners = {}
  }

  get(key) {
    return this._state[key]
  }

  set(key, value) {
    this._state[key] = value
    this._emit(key, value)
  }

  update(key, updater) {
    const current = this._state[key]
    this.set(key, updater(current))
  }

  on(key, callback) {
    if (!this._listeners[key]) this._listeners[key] = []
    this._listeners[key].push(callback)
    // 立即回调当前值
    if (this._state[key] !== undefined) callback(this._state[key])
    return () => this.off(key, callback)
  }

  off(key, callback) {
    if (!this._listeners[key]) return
    this._listeners[key] = this._listeners[key].filter(cb => cb !== callback)
  }

  _emit(key, value) {
    if (!this._listeners[key]) return
    this._listeners[key].forEach(cb => {
      try { cb(value) } catch (e) { console.error('[Store] listener error:', e) }
    })
  }
}

// 全局单例
export const store = new Store()

// 初始化：从 chrome.storage 加载状态
export async function initStore() {
  const data = await chrome.storage.local.get([
    'aiConfig', 'syncConfig', 'scripts', 'chatHistory', 'lastSync', 'sidebarMode', 'selectionToolsEnabled'
  ])
  if (data.aiConfig) store.set('aiConfig', data.aiConfig)
  if (data.syncConfig) store.set('syncConfig', data.syncConfig)
  if (data.scripts) store.set('scripts', data.scripts)
  if (data.chatHistory) store.set('chatHistory', data.chatHistory)
  if (data.lastSync) store.set('lastSync', data.lastSync)
  if (data.sidebarMode) store.set('sidebarMode', data.sidebarMode)
  if (data.selectionToolsEnabled !== undefined) store.set('selectionToolsEnabled', data.selectionToolsEnabled)
}

// 持久化：store 变更时自动保存
export function enablePersistence() {
  const keys = ['aiConfig', 'syncConfig', 'scripts', 'chatHistory', 'sidebarMode', 'selectionToolsEnabled']
  keys.forEach(key => {
    store.on(key, (value) => {
      chrome.storage.local.set({ [key]: value }).catch(e => {
        console.error('[Store] persist error:', key, e)
      })
    })
  })
}
