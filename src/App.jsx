import React, { useState, useEffect, useRef, useCallback } from 'react'
import UnifiedPanel from './components/UnifiedPanel.jsx'
import SettingsPanel from './components/SettingsPanel.jsx'

const STORAGE_KEY = 'ai-browser-config'
const BOOKMARKS_KEY = 'ai-browser-bookmarks'

export default function App() {
  const [url, setUrl] = useState('')
  const [pageTitle, setPageTitle] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('assistant')
  const [sidebarRatio, setSidebarRatio] = useState(0.35)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [dragging, setDragging] = useState(false)

  // 标签页状态
  const [tabs, setTabs] = useState([])
  const [activeTabId, setActiveTabId] = useState(null)
  const [dragTabId, setDragTabId] = useState(null)
  const [dragOverTabId, setDragOverTabId] = useState(null)

  // 查找状态
  const [showFind, setShowFind] = useState(false)
  const [findText, setFindText] = useState('')
  const [findResult, setFindResult] = useState(null) // {matches, currentMatch}

  // 书签
  const [bookmarks, setBookmarks] = useState(() => {
    try {
      const saved = localStorage.getItem(BOOKMARKS_KEY)
      return saved ? JSON.parse(saved) : []
    } catch { return [] }
  })
  const [showBookmarks, setShowBookmarks] = useState(false)

  const [config, setConfig] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? JSON.parse(saved) : defaultConfig()
  })

  function defaultConfig() {
    return { provider: 'openai', apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', streaming: false }
  }

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)) }, [config])
  useEffect(() => { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks)) }, [bookmarks])

  // ============ 标签页管理 ============

  // 监听标签页更新事件
  useEffect(() => {
    const unsub = window.api.tabs.onUpdated((data) => {
      setTabs(prev => prev.map(t => t.id === data.id ? { ...t, ...data } : t))
      // 如果是活跃标签，同步URL和标题
      if (data.id === activeTabId) {
        if (data.url) setUrl(data.url)
        if (data.title !== undefined) setPageTitle(data.title)
        if (data.loading !== undefined) setIsLoading(data.loading)
      }
    })
    return unsub
  }, [activeTabId])

  // 初始化加载标签列表
  useEffect(() => {
    window.api.tabs.list().then(list => {
      setTabs(list)
      const active = list.find(t => t.active)
      if (active) {
        setActiveTabId(active.id)
        setUrl(active.url || '')
        setPageTitle(active.title || '')
      }
    })
  }, [])

  // 定期同步活跃标签状态
  const urlRef = useRef(url)
  urlRef.current = url
  const isUrlFocusedRef = useRef(false)

  useEffect(() => {
    const interval = setInterval(async () => {
      if (isUrlFocusedRef.current) return
      const currentUrl = await window.api.browser.getUrl()
      if (currentUrl && currentUrl !== urlRef.current) setUrl(currentUrl)
      const title = await window.api.browser.getTitle()
      if (title) setPageTitle(title)
      const loading = await window.api.browser.isLoading()
      setIsLoading(loading)
    }, 800)
    return () => clearInterval(interval)
  }, [])

  const handleNewTab = async () => {
    const tab = await window.api.tabs.create('')
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
    setUrl('')
    setPageTitle('')
  }

  const handleCloseTab = async (tabId, e) => {
    e.stopPropagation()
    if (tabs.length <= 1) return // 不关闭最后一个
    const result = await window.api.tabs.close(tabId)
    setTabs(prev => prev.filter(t => t.id !== tabId))
    if (tabId === activeTabId && result.newActiveId) {
      setActiveTabId(result.newActiveId)
      const newTab = tabs.find(t => t.id === result.newActiveId)
      if (newTab) { setUrl(newTab.url || ''); setPageTitle(newTab.title || '') }
    }
  }

  const handleSwitchTab = async (tabId) => {
    await window.api.tabs.switch(tabId)
    setActiveTabId(tabId)
    const tab = tabs.find(t => t.id === tabId)
    if (tab) { setUrl(tab.url || ''); setPageTitle(tab.title || '') }
  }

  // 标签拖拽排序
  const handleTabDragStart = (tabId) => { setDragTabId(tabId) }
  const handleTabDragOver = (e, tabId) => { e.preventDefault(); setDragOverTabId(tabId) }
  const handleTabDragEnd = async () => {
    if (dragTabId && dragOverTabId && dragTabId !== dragOverTabId) {
      const newTabs = [...tabs]
      const fromIdx = newTabs.findIndex(t => t.id === dragTabId)
      const toIdx = newTabs.findIndex(t => t.id === dragOverTabId)
      const [moved] = newTabs.splice(fromIdx, 1)
      newTabs.splice(toIdx, 0, moved)
      setTabs(newTabs)
      await window.api.tabs.reorder(newTabs.map(t => t.id))
    }
    setDragTabId(null)
    setDragOverTabId(null)
  }

  // ============ 导航 ============

  const handleNavigate = async (e) => {
    e.preventDefault()
    if (url) {
      await window.api.browser.navigate(url)
      isUrlFocusedRef.current = false
    }
  }

  const handleBack = () => window.api.browser.back()
  const handleForward = () => window.api.browser.forward()
  const handleReload = () => window.api.browser.reload()
  const handleStop = () => window.api.browser.stop()

  // ============ 收藏 ============

  const isBookmarked = bookmarks.some(b => b.url === url)

  const handleToggleBookmark = () => {
    if (isBookmarked) {
      setBookmarks(prev => prev.filter(b => b.url !== url))
    } else {
      setBookmarks(prev => [...prev, { url, title: pageTitle || url, addedAt: Date.now() }])
    }
  }

  const handleBookmarkClick = (bookmark) => {
    setUrl(bookmark.url)
    window.api.browser.navigate(bookmark.url)
    setShowBookmarks(false)
  }

  const handleDeleteBookmark = (bookmarkUrl, e) => {
    e.stopPropagation()
    setBookmarks(prev => prev.filter(b => b.url !== bookmarkUrl))
  }

  const handleOpenExternal = () => { if (url) window.api.browser.openExternal(url) }

  const handleUrlFocus = (e) => { isUrlFocusedRef.current = true; e.target.select() }

  // ============ 页面查找 ============

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setShowFind(true)
      }
      if (e.key === 'Escape' && showFind) {
        setShowFind(false)
        window.api.find.stop()
        setFindResult(null)
        setFindText('')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showFind])

  const handleFindInput = async (text) => {
    setFindText(text)
    if (text.trim()) {
      const result = await window.api.find.start(text)
      setFindResult(result)
    } else {
      await window.api.find.stop()
      setFindResult(null)
    }
  }

  const handleFindNext = async () => {
    if (findText) {
      const result = await window.api.find.next()
      setFindResult(result)
    }
  }

  const handleFindPrev = async () => {
    if (findText) {
      const result = await window.api.find.previous()
      setFindResult(result)
    }
  }

  const handleCloseFind = () => {
    setShowFind(false)
    window.api.find.stop()
    setFindResult(null)
    setFindText('')
  }

  // ============ 侧边栏 ============

  const handleToggleSidebar = () => {
    const newVisible = !sidebarVisible
    setSidebarVisible(newVisible)
    window.api.browser.togglePanel(newVisible)
  }

  // 拖动分隔条
  const handleMouseDown = (e) => { e.preventDefault(); setDragging(true) }

  useEffect(() => {
    if (!dragging) return
    const handleMouseMove = (e) => {
      const windowWidth = window.innerWidth
      const sidebarWidth = windowWidth - e.clientX
      const ratio = Math.max(0.2, Math.min(0.6, sidebarWidth / windowWidth))
      setSidebarRatio(ratio)
    }
    const handleMouseUp = () => {
      setDragging(false)
      window.api.browser.resize(1 - sidebarRatio)
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragging, sidebarRatio])

  // 从URL提取域名作为标签标题简写
  const getTabLabel = (tab) => {
    if (tab.title && tab.title !== 'about:blank') {
      return tab.title.length > 12 ? tab.title.substring(0, 12) + '...' : tab.title
    }
    if (tab.url && tab.url !== 'about:blank') {
      try { return new URL(tab.url).hostname } catch { return tab.url.substring(0, 12) }
    }
    return '新标签页'
  }

  return (
    <>
      {/* 导航栏 */}
      <div className="navbar">
        <div className="nav-nav-btns">
          <button className="nav-btn" onClick={handleBack} title="后退">←</button>
          <button className="nav-btn" onClick={handleForward} title="前进">→</button>
          <button className="nav-btn" onClick={isLoading ? handleStop : handleReload} title={isLoading ? '停止' : '刷新'}>
            {isLoading ? '✕' : '↻'}
          </button>
        </div>

        <div className="url-bar-wrapper">
          <div className="url-bar-inner">
            <span className="url-security-icon" title={url.startsWith('https') ? '安全连接' : '不安全连接'}>
              {url.startsWith('https') ? '🔒' : 'ℹ'}
            </span>
            <form onSubmit={handleNavigate} style={{ flex: 1, display: 'flex' }}>
              <input
                className="url-bar"
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onFocus={handleUrlFocus}
                onBlur={() => { isUrlFocusedRef.current = false }}
                placeholder="输入网址或搜索..."
              />
            </form>
            <button className={`nav-btn-icon ${isBookmarked ? 'bookmarked' : ''}`} onClick={handleToggleBookmark} title={isBookmarked ? '取消收藏' : '收藏此页'}>
              {isBookmarked ? '★' : '☆'}
            </button>
            <button className="nav-btn-icon" onClick={() => setShowBookmarks(!showBookmarks)} title="书签列表">⑂</button>
            <button className="nav-btn-icon" onClick={handleOpenExternal} title="在默认浏览器中打开">↗</button>
          </div>
          {isLoading && <div className="url-loading-bar" />}
        </div>

        <div className="nav-actions">
          <button className="nav-btn-icon" onClick={() => setShowFind(true)} title="页面内查找 (Ctrl+F)">🔍</button>
          <button className={`nav-btn ${sidebarVisible ? 'nav-btn-active' : ''}`} onClick={handleToggleSidebar} title="AI助手面板">✦</button>
          <button className={`nav-btn ${activeTab === 'settings' ? 'nav-btn-active' : ''}`} onClick={() => setActiveTab(activeTab === 'settings' ? 'assistant' : 'settings')} title="设置">⚙</button>
        </div>
      </div>

      {/* 标签栏 */}
      <div className="tab-bar">
        <div className="tab-bar-scroll">
          {tabs.map(tab => (
            <div
              key={tab.id}
              className={`tab-item ${tab.id === activeTabId ? 'active' : ''} ${dragOverTabId === tab.id ? 'drag-over' : ''}`}
              onClick={() => handleSwitchTab(tab.id)}
              draggable
              onDragStart={() => handleTabDragStart(tab.id)}
              onDragOver={(e) => handleTabDragOver(e, tab.id)}
              onDragEnd={handleTabDragEnd}
            >
              <span className="tab-item-label">{getTabLabel(tab)}</span>
              {tab.loading && <span className="tab-loading-dot" />}
              {tabs.length > 1 && (
                <button className="tab-close-btn" onClick={(e) => handleCloseTab(tab.id, e)}>✕</button>
              )}
            </div>
          ))}
        </div>
        <button className="tab-new-btn" onClick={handleNewTab} title="新建标签页">+</button>
      </div>

      {/* 书签下拉 */}
      {showBookmarks && (
        <div className="bookmarks-dropdown">
          {bookmarks.length === 0 && <div className="bookmarks-empty">暂无书签，点击地址栏旁 ☆ 收藏页面</div>}
          {bookmarks.map((b, i) => (
            <div key={i} className="bookmark-item" onClick={() => handleBookmarkClick(b)}>
              <span className="bookmark-title">{b.title}</span>
              <span className="bookmark-url">{b.url}</span>
              <button className="bookmark-delete" onClick={(e) => handleDeleteBookmark(b.url, e)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {/* 页面内查找栏 */}
      {showFind && (
        <div className="find-bar">
          <input
            className="find-input"
            type="text"
            value={findText}
            onChange={(e) => handleFindInput(e.target.value)}
            placeholder="查找..."
            autoFocus
          />
          <span className="find-result">
            {findResult ? `${findResult.activeMatchOrdinal || 0}/${findResult.matches || 0}` : ''}
          </span>
          <button className="find-btn" onClick={handleFindPrev} title="上一个">↑</button>
          <button className="find-btn" onClick={handleFindNext} title="下一个">↓</button>
          <button className="find-btn find-close-btn" onClick={handleCloseFind} title="关闭">✕</button>
        </div>
      )}

      {/* 主布局 */}
      <div className="main-layout">
        <div className="browser-container" style={{ flex: sidebarVisible ? `0 0 ${((1 - sidebarRatio) * 100).toFixed(2)}%` : '1 1 100%' }} />
        {sidebarVisible && (
          <>
            <div className={`sidebar-resizer ${dragging ? 'dragging' : ''}`} onMouseDown={handleMouseDown} />
            <div className="sidebar" style={{ flex: `0 0 ${(sidebarRatio * 100).toFixed(2)}%` }}>
              <div className="sidebar-tabs">
                <div className={`tab ${activeTab === 'assistant' ? 'active' : ''}`} onClick={() => setActiveTab('assistant')}>AI 助手</div>
                <div className={`tab ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>设置</div>
              </div>
              <div style={{ display: activeTab === 'assistant' ? 'flex' : 'none', flex: 1, flexDirection: 'column', overflow: 'hidden' }}>
                <UnifiedPanel config={config} />
              </div>
              <div style={{ display: activeTab === 'settings' ? 'flex' : 'none', flex: 1, flexDirection: 'column', overflow: 'hidden' }}>
                <SettingsPanel config={config} setConfig={setConfig} />
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}
