// ============ 侧边栏分离窗口（独立 BrowserWindow） ============
// 从主窗口分离出来的 AI 助手侧边栏，作为独立窗口使用
// 复用 UnifiedPanel 和 SettingsPanel 组件，通过 localStorage 共享 config（同一 origin）
//
// 特性：
//   - 无边框窗口，自定义标题栏可拖拽（-webkit-app-region: drag）
//   - 包含 AI 助手标签页和设置标签页
//   - 关闭按钮调用 window.api.sidebarWindow.close()
//   - 关闭后主窗口侧边栏自动恢复显示（由主进程 'closed' 事件处理）
//   - config / theme 通过 localStorage 与主窗口共享（同 origin）

import { useState, useEffect } from 'react'
import UnifiedPanel from './UnifiedPanel.jsx'
import SettingsPanel from './SettingsPanel.jsx'

const STORAGE_KEY = 'ai-browser-config'
const THEME_KEY = 'ai-browser-theme'

function defaultConfig() {
  return {
    provider: 'openai',
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    streaming: false,
    maxToolRounds: 20,
    adminServerUrl: 'http://localhost:3001',
    adminToken: '',
  }
}

export default function SidebarWindow() {
  const [activeTab, setActiveTab] = useState('assistant')
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'dark-blue')
  const [config, setConfig] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved ? JSON.parse(saved) : defaultConfig()
    } catch {
      return defaultConfig()
    }
  })

  // 应用主题
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // 监听 localStorage 变化（主窗口修改 config/theme 时同步）
  // 注意：storage 事件只在其他文档修改时触发，同一文档不触发
  useEffect(() => {
    const handleStorage = (e) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try { setConfig(JSON.parse(e.newValue)) } catch { /* 忽略解析错误 */ }
      }
      if (e.key === THEME_KEY && e.newValue) {
        setTheme(e.newValue)
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  // 定期同步 config（兜底：storage 事件在某些场景不可靠）
  useEffect(() => {
    const interval = setInterval(() => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY)
        if (saved) {
          const parsed = JSON.parse(saved)
          setConfig(prev => {
            // 只在内容变化时更新，避免不必要的重渲染
            if (JSON.stringify(prev) !== JSON.stringify(parsed)) return parsed
            return prev
          })
        }
        const savedTheme = localStorage.getItem(THEME_KEY)
        if (savedTheme && savedTheme !== theme) setTheme(savedTheme)
      } catch { /* 忽略 */ }
    }, 1000)
    return () => clearInterval(interval)
  }, [theme])

  // 关闭窗口：调用 IPC，主进程会触发 'closed' 事件恢复主窗口侧边栏
  const handleClose = async () => {
    try {
      if (window.api?.sidebarWindow?.close) {
        await window.api.sidebarWindow.close()
      }
    } catch (e) {
      console.error('[SidebarWindow] IPC 关闭失败:', e)
    }
    // 兜底：IPC 未关闭则直接调用 window.close()
    if (!window.closed) {
      window.close()
    }
  }

  return (
    <div className="sidebar-window-root">
      {/* 可拖拽标题栏 */}
      <div className="sidebar-window-titlebar">
        <span className="sidebar-window-title">✦ AI 助手</span>
        <div className="sidebar-window-actions">
          <button className="sidebar-window-close" onClick={handleClose} title="关闭（恢复主窗口侧边栏）">✕</button>
        </div>
      </div>

      {/* 标签栏 */}
      <div className="sidebar-tabs">
        <div className={`tab ${activeTab === 'assistant' ? 'active' : ''}`} onClick={() => setActiveTab('assistant')}>AI 助手</div>
        <div className={`tab ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>设置</div>
      </div>

      {/* AI 助手面板 */}
      <div style={{ display: activeTab === 'assistant' ? 'flex' : 'none', flex: 1, flexDirection: 'column', overflow: 'hidden' }}>
        <UnifiedPanel config={config} />
      </div>

      {/* 设置面板 */}
      <div style={{ display: activeTab === 'settings' ? 'flex' : 'none', flex: 1, flexDirection: 'column', overflow: 'hidden' }}>
        <SettingsPanel config={config} setConfig={setConfig} />
      </div>
    </div>
  )
}
