/**
 * 标签页管理器
 * 负责多标签页的创建、切换、关闭、事件绑定、上下文菜单
 */
const { BrowserView, Menu, clipboard, shell } = require('electron')
const path = require('path')

class TabManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow
    this.tabs = new Map()       // id -> { id, browserView, url, title, loading, favicon, _eventHandlers }
    this.activeTabId = null
    this.tabIdCounter = 0
  }

  // ============ 访问器 ============

  getActiveTab() {
    if (this.activeTabId === null) return null
    return this.tabs.get(this.activeTabId) || null
  }

  getActiveBrowserView() {
    const tab = this.getActiveTab()
    return tab ? tab.browserView : null
  }

  getTabInfo(tab) {
    if (!tab) return null
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      favicon: tab.favicon,
      active: tab.id === this.activeTabId,
    }
  }

  getTabList() {
    const list = []
    for (const tab of this.tabs.values()) {
      list.push(this.getTabInfo(tab))
    }
    return list
  }

  // ============ 通知 ============

  _sendTabUpdated(tab) {
    const win = this.mainWindow
    if (win && !win.isDestroyed()) {
      win.webContents.send('tabs:updated', this.getTabInfo(tab))
    }
  }

  _sendNavStateUpdated(tab) {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return
    const wc = tab.browserView.webContents
    if (wc && !wc.isDestroyed()) {
      win.webContents.send('browser:nav-state', {
        tabId: tab.id,
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward(),
      })
    }
  }

  // ============ 上下文菜单 ============

  buildContextMenu(tab, params) {
    const wc = tab.browserView.webContents
    const menuItems = []
    const hasSelection = params.selectionText && params.selectionText.length > 0
    const isLink = params.linkURL && params.linkURL.length > 0
    const isImage = params.mediaType === 'image'
    const isInput = params.isEditable || ['input', 'textarea'].includes(params.tagName?.toLowerCase())

    if (isLink) {
      menuItems.push({ label: '在新标签页中打开链接', click: () => this.createTab(params.linkURL) })
      menuItems.push({ label: '在新窗口中打开链接', click: () => shell.openExternal(params.linkURL) })
      menuItems.push({ label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) })
      menuItems.push({ type: 'separator' })
    }

    if (isImage) {
      menuItems.push({ label: '在新标签页中打开图片', click: () => this.createTab(params.srcURL) })
      menuItems.push({ label: '复制图片', click: () => wc.copyImageAt(params.x, params.y) })
      menuItems.push({ label: '复制图片地址', click: () => clipboard.writeText(params.srcURL) })
      menuItems.push({ label: '图片另存为...', click: () => wc.downloadURL(params.srcURL) })
      menuItems.push({ type: 'separator' })
    }

    if (hasSelection) {
      menuItems.push({ label: '复制', role: 'copy', accelerator: 'Ctrl+C' })
      menuItems.push({ type: 'separator' })
    }

    if (isInput) {
      menuItems.push({ label: '撤销', role: 'undo', accelerator: 'Ctrl+Z' })
      menuItems.push({ label: '重做', role: 'redo', accelerator: 'Ctrl+Y' })
      menuItems.push({ type: 'separator' })
      menuItems.push({ label: '剪切', role: 'cut', accelerator: 'Ctrl+X' })
      menuItems.push({ label: '复制', role: 'copy', accelerator: 'Ctrl+C' })
      menuItems.push({ label: '粘贴', role: 'paste', accelerator: 'Ctrl+V' })
      menuItems.push({ label: '全选', role: 'selectall', accelerator: 'Ctrl+A' })
      menuItems.push({ type: 'separator' })
    }

    menuItems.push({
      label: '后退', enabled: wc.canGoBack(), accelerator: 'Alt+Left', click: () => wc.goBack(),
    })
    menuItems.push({
      label: '前进', enabled: wc.canGoForward(), accelerator: 'Alt+Right', click: () => wc.goForward(),
    })
    menuItems.push({ label: '重新加载', role: 'reload', accelerator: 'Ctrl+R' })
    menuItems.push({ label: '强制重新加载', accelerator: 'Ctrl+Shift+R', click: () => wc.reloadIgnoringCache() })
    menuItems.push({ type: 'separator' })
    menuItems.push({ label: '另存为...', role: 'save', accelerator: 'Ctrl+S' })
    menuItems.push({ label: '打印...', role: 'print', accelerator: 'Ctrl+P' })
    menuItems.push({ type: 'separator' })
    menuItems.push({
      label: '查看网页源代码', accelerator: 'Ctrl+U',
      click: () => this.createTab('view-source:' + wc.getURL()),
    })
    menuItems.push({
      label: '检查', accelerator: 'Ctrl+Shift+I',
      click: () => wc.openDevTools({ mode: 'detach' }),
    })

    return Menu.buildFromTemplate(menuItems)
  }

  // ============ 事件绑定/解绑 ============

  _attachTabEvents(tab) {
    const wc = tab.browserView.webContents
    const self = this

    const handlers = {
      onNavigate: (event, url) => {
        tab.url = url
        tab.loading = false
        self._sendTabUpdated(tab)
        self._sendNavStateUpdated(tab)
      },
      onNavigateInPage: (event, url) => {
        tab.url = url
        self._sendTabUpdated(tab)
        self._sendNavStateUpdated(tab)
      },
      onPageTitleUpdated: (event, title) => {
        tab.title = title
        self._sendTabUpdated(tab)
      },
      onStartLoading: () => {
        tab.loading = true
        self._sendTabUpdated(tab)
      },
      onStopLoading: () => {
        tab.loading = false
        self._sendTabUpdated(tab)
        self._sendNavStateUpdated(tab)
      },
      onFaviconUpdated: (event, favicons) => {
        if (favicons && favicons.length > 0) {
          tab.favicon = favicons[0]
          self._sendTabUpdated(tab)
        }
      },
      onFrameNavigate: () => {
        self._sendNavStateUpdated(tab)
      },
      onContextMenu: (event, params) => {
        const menu = self.buildContextMenu(tab, params)
        menu.popup({ window: self.mainWindow })
      },
    }

    wc.on('did-navigate', handlers.onNavigate)
    wc.on('did-navigate-in-page', handlers.onNavigateInPage)
    wc.on('page-title-updated', handlers.onPageTitleUpdated)
    wc.on('did-start-loading', handlers.onStartLoading)
    wc.on('did-stop-loading', handlers.onStopLoading)
    wc.on('page-favicon-updated', handlers.onFaviconUpdated)
    wc.on('did-frame-navigate', handlers.onFrameNavigate)
    wc.on('context-menu', handlers.onContextMenu)

    wc.setWindowOpenHandler(({ url }) => {
      self.createTab(url)
      return { action: 'deny' }
    })

    tab._eventHandlers = handlers
  }

  _detachTabEvents(tab) {
    const wc = tab.browserView.webContents
    if (!wc || wc.isDestroyed()) return

    const handlers = tab._eventHandlers
    if (!handlers) return

    wc.removeListener('did-navigate', handlers.onNavigate)
    wc.removeListener('did-navigate-in-page', handlers.onNavigateInPage)
    wc.removeListener('page-title-updated', handlers.onPageTitleUpdated)
    wc.removeListener('did-start-loading', handlers.onStartLoading)
    wc.removeListener('did-stop-loading', handlers.onStopLoading)
    wc.removeListener('page-favicon-updated', handlers.onFaviconUpdated)
    wc.removeListener('did-frame-navigate', handlers.onFrameNavigate)
    wc.removeListener('context-menu', handlers.onContextMenu)

    tab._eventHandlers = null
  }

  // ============ 标签操作 ============

  createTab(url) {
    const id = this._generateTabId()
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
      _eventHandlers: null,
    }

    this.tabs.set(id, tab)
    this._attachTabEvents(tab)

    // 隐藏当前活跃标签
    if (this.activeTabId !== null) {
      const prevTab = this.tabs.get(this.activeTabId)
      if (prevTab && this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.removeBrowserView(prevTab.browserView)
      }
    }

    // 添加新 BrowserView
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.addBrowserView(bv)
    }
    this.activeTabId = id

    if (url && url !== 'about:blank') {
      const navUrl = url.startsWith('http') ? url : 'https://' + url
      bv.webContents.loadURL(navUrl)
    }

    return this.getTabInfo(tab)
  }

  closeTab(id) {
    const tab = this.tabs.get(id)
    if (!tab) return null

    if (this.tabs.size <= 1) {
      return 'last_tab'
    }

    // 从主窗口移除 BrowserView
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.removeBrowserView(tab.browserView)
    }

    // 移除事件监听器（防止内存泄漏）
    this._detachTabEvents(tab)

    // 安全关闭 webContents
    if (tab.browserView && !tab.browserView.webContents.isDestroyed()) {
      tab.browserView.webContents.close()
    }

    this.tabs.delete(id)

    // 如果关闭的是活跃标签，切换到相邻标签
    if (this.activeTabId === id) {
      const remainingIds = Array.from(this.tabs.keys())
      if (remainingIds.length > 0) {
        this.switchTab(remainingIds[0])
      } else {
        this.activeTabId = null
      }
    }

    return { success: true }
  }

  switchTab(id) {
    const tab = this.tabs.get(id)
    if (!tab) return null

    if (this.activeTabId !== null) {
      const prevTab = this.tabs.get(this.activeTabId)
      if (prevTab && this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.removeBrowserView(prevTab.browserView)
      }
    }

    this.activeTabId = id
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.addBrowserView(tab.browserView)
    }

    return this.getTabInfo(tab)
  }

  reorderTabs(ids) {
    const newTabs = new Map()
    for (const id of ids) {
      const tab = this.tabs.get(id)
      if (tab) newTabs.set(id, tab)
    }
    for (const [id, tab] of this.tabs) {
      if (!newTabs.has(id)) newTabs.set(id, tab)
    }
    this.tabs.clear()
    for (const [id, tab] of newTabs) {
      this.tabs.set(id, tab)
    }
    return { success: true }
  }

  _generateTabId() {
    return ++this.tabIdCounter
  }
}

module.exports = TabManager