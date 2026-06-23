import React, { useState, useEffect, useRef } from 'react'
import ChatPanel from './components/ChatPanel.jsx'
import AnalysisPanel from './components/AnalysisPanel.jsx'
import SettingsPanel from './components/SettingsPanel.jsx'

const STORAGE_KEY = 'ai-browser-config'

export default function App() {
  const [url, setUrl] = useState('')
  const [activeTab, setActiveTab] = useState('chat')
  const [sidebarRatio, setSidebarRatio] = useState(0.35)
  const [dragging, setDragging] = useState(false)
  const [config, setConfig] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? JSON.parse(saved) : defaultConfig()
  })

  function defaultConfig() {
    return {
      provider: 'openai',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    }
  }

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  }, [config])

  // 监听浏览器URL变化
  useEffect(() => {
    window.api.browser.getUrl().then(u => { if (u) setUrl(u) })
    const interval = setInterval(async () => {
      const currentUrl = await window.api.browser.getUrl()
      if (currentUrl && currentUrl !== url) setUrl(currentUrl)
    }, 1000)
    return () => clearInterval(interval)
  }, [url])

  const handleNavigate = async (e) => {
    e.preventDefault()
    if (url) {
      await window.api.browser.navigate(url)
    }
  }

  const handleBack = () => window.api.browser.back()
  const handleForward = () => window.api.browser.forward()

  // 拖动分隔条调整侧边栏宽度
  const handleMouseDown = (e) => {
    e.preventDefault()
    setDragging(true)
  }

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
      // 通知主进程调整BrowserView大小
      window.api.browser.resize(1 - sidebarRatio)
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragging, sidebarRatio])

  return (
    <>
      {/* 导航栏 */}
      <div className="navbar">
        <button className="nav-btn" onClick={handleBack} title="后退">←</button>
        <button className="nav-btn" onClick={handleForward} title="前进">→</button>
        <form onSubmit={handleNavigate} style={{ flex: '0 0 50%' }}>
          <input
            className="url-bar"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="输入网址并按 Enter..."
            style={{ width: '100%' }}
          />
        </form>
        <div className="nav-actions">
          <button className="nav-btn" onClick={() => setActiveTab('chat')} title="AI对话">💬</button>
          <button className="nav-btn" onClick={() => setActiveTab('analysis')} title="逆向分析">🔍</button>
          <button className="nav-btn" onClick={() => setActiveTab('settings')} title="设置">⚙️</button>
        </div>
      </div>

      {/* 主布局 */}
      <div className="main-layout">
        <div className="browser-container" style={{ flex: `0 0 ${((1 - sidebarRatio) * 100).toFixed(2)}%` }} />
        <div
          className={`sidebar-resizer ${dragging ? 'dragging' : ''}`}
          onMouseDown={handleMouseDown}
        />
        <div className="sidebar" style={{ flex: `0 0 ${(sidebarRatio * 100).toFixed(2)}%` }}>
          <div className="sidebar-tabs">
            <div className={`tab ${activeTab === 'chat' ? 'active' : ''}`} onClick={() => setActiveTab('chat')}>AI 对话</div>
            <div className={`tab ${activeTab === 'analysis' ? 'active' : ''}`} onClick={() => setActiveTab('analysis')}>逆向分析</div>
            <div className={`tab ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>设置</div>
          </div>

          {/* 用 display:none 代替条件渲染，保留组件状态 */}
          <div style={{ display: activeTab === 'chat' ? 'flex' : 'none', flex: 1, flexDirection: 'column', overflow: 'hidden' }}>
            <ChatPanel config={config} />
          </div>
          <div style={{ display: activeTab === 'analysis' ? 'flex' : 'none', flex: 1, flexDirection: 'column', overflow: 'hidden' }}>
            <AnalysisPanel config={config} />
          </div>
          <div style={{ display: activeTab === 'settings' ? 'flex' : 'none', flex: 1, flexDirection: 'column', overflow: 'hidden' }}>
            <SettingsPanel config={config} setConfig={setConfig} />
          </div>
        </div>
      </div>
    </>
  )
}
