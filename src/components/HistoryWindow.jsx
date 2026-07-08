// ============ 历史记录管理独立窗口（BrowserWindow） ============
// 管理所有历史会话：查看列表、载入会话、删除单个/全部
//
// 数据来源：localStorage key 'ai-browser-sessions'
//   格式: [{ id, title, messages, chatHistory, updatedAt, messageCount }]
//
// 通信机制（与主窗口 UnifiedPanel 通过 localStorage 跨窗口通信，同 origin）：
//   - 载入会话：设置 localStorage 'ai-browser-load-session' 为会话 ID，
//     主窗口 UnifiedPanel 监听 storage 事件后切换到该会话，然后关闭本窗口
//   - 删除会话：直接修改 localStorage 'ai-browser-sessions'，
//     主窗口 UnifiedPanel 监听 storage 事件后刷新会话列表
//
// 特性：
//   - 无边框窗口，自定义标题栏可拖拽（-webkit-app-region: drag）
//   - 暗色主题（读取 localStorage 'ai-browser-theme'，默认 dark-blue）
//   - 标题"历史会话管理"
//   - 会话列表：每条显示标题、创建/更新时间、消息数；点击载入，✗ 删除
//   - 底部按钮：一键删除所有 | 关闭

import { useState, useEffect, useCallback } from 'react'

const SESSIONS_KEY = 'ai-browser-sessions'
const LOAD_SESSION_KEY = 'ai-browser-load-session'
const THEME_KEY = 'ai-browser-theme'

function loadSessions() {
  try {
    const data = localStorage.getItem(SESSIONS_KEY)
    return data ? JSON.parse(data) : []
  } catch {
    return []
  }
}

function saveSessions(sessions) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
}

// 友好的时间格式：今天显示"今天 HH:MM"，否则显示"MM-DD HH:MM"
function formatTime(ts) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    const now = new Date()
    const isSameDay = d.toDateString() === now.toDateString()
    if (isSameDay) {
      return '今天 ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export default function HistoryWindow() {
  const [sessions, setSessions] = useState(() => loadSessions())
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'dark-blue')
  const [searchKeyword, setSearchKeyword] = useState('')

  // 应用主题（暗色主题为主，跟随主窗口配置）
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // 监听 localStorage 变化：主窗口增删会话时同步刷新本窗口列表
  // 注意：storage 事件只在其他文档修改时触发，同一文档不触发
  useEffect(() => {
    const handleStorage = (e) => {
      if (e.key === SESSIONS_KEY) {
        try {
          setSessions(e.newValue ? JSON.parse(e.newValue) : [])
        } catch {
          /* 忽略解析错误 */
        }
      }
      if (e.key === THEME_KEY && e.newValue) {
        setTheme(e.newValue)
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  // 兜底：定时刷新（storage 事件在某些场景不可靠，与 SidebarWindow 一致）
  useEffect(() => {
    const interval = setInterval(() => {
      const fresh = loadSessions()
      setSessions(prev => {
        // 只在内容变化时更新，避免不必要的重渲染
        return JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh
      })
      const savedTheme = localStorage.getItem(THEME_KEY)
      if (savedTheme && savedTheme !== theme) setTheme(savedTheme)
    }, 1500)
    return () => clearInterval(interval)
  }, [theme])

  const refreshSessions = useCallback(() => {
    setSessions(loadSessions())
  }, [])

  // 载入会话：通过 localStorage 通知主窗口切换会话，然后关闭本窗口
  const handleLoadSession = useCallback((session) => {
    // 写入 load-session 标记（会话 ID），主窗口监听 storage 事件后切换到该会话
    localStorage.setItem(LOAD_SESSION_KEY, session.id)
    // 关闭本窗口（与原模态弹窗选择后关闭的交互一致）
    try {
      window.api?.historyWindow?.close()
    } catch {
      /* 忽略 IPC 异常 */
    }
    // 兜底：IPC 未关闭则直接调用 window.close()
    if (!window.closed) {
      window.close()
    }
  }, [])

  // 删除单个会话
  const handleDeleteSession = useCallback((e, sessionId) => {
    e.stopPropagation()
    setSessions(prev => {
      const next = prev.filter(s => s.id !== sessionId)
      saveSessions(next)
      return next
    })
  }, [])

  // 一键删除所有会话
  const handleDeleteAll = useCallback(() => {
    if (sessions.length === 0) return
    if (!window.confirm(`确定删除全部 ${sessions.length} 条历史会话吗？此操作不可恢复。`)) return
    saveSessions([])
    setSessions([])
  }, [sessions.length])

  // 关闭窗口
  const handleClose = useCallback(async () => {
    try {
      if (window.api?.historyWindow?.close) {
        await window.api.historyWindow.close()
      }
    } catch {
      /* 忽略 IPC 异常 */
    }
    if (!window.closed) {
      window.close()
    }
  }, [])

  // 按关键词过滤（标题）
  const keyword = searchKeyword.trim().toLowerCase()
  const filtered = keyword
    ? sessions.filter(s => (s.title || '').toLowerCase().includes(keyword))
    : sessions

  return (
    <div className="hw-window-root">
      {/* 可拖拽标题栏 */}
      <div className="hw-titlebar">
        <span className="hw-title">历史会话管理</span>
        <div className="hw-titlebar-actions">
          <button className="hw-titlebar-btn" onClick={refreshSessions} title="刷新列表">↻</button>
          <button className="hw-titlebar-btn hw-close-btn" onClick={handleClose} title="关闭">✕</button>
        </div>
      </div>

      {/* 搜索栏 */}
      <div className="hw-search-bar">
        <input
          className="hw-search-input"
          type="text"
          placeholder="搜索会话标题..."
          value={searchKeyword}
          onChange={(e) => setSearchKeyword(e.target.value)}
        />
        <span className="hw-count">{filtered.length} / {sessions.length}</span>
      </div>

      {/* 会话列表 */}
      <div className="hw-list">
        {filtered.length === 0 ? (
          <div className="hw-empty">
            {sessions.length === 0 ? '暂无历史会话' : '未找到匹配的会话'}
          </div>
        ) : (
          filtered.map(s => (
            <div
              key={s.id}
              className="hw-session-item"
              onClick={() => handleLoadSession(s)}
              title="点击载入此会话"
            >
              <div className="hw-session-main">
                <div className="hw-session-title">{s.title || '（无标题）'}</div>
                <div className="hw-session-meta">
                  <span className="hw-session-time">{formatTime(s.updatedAt)}</span>
                  <span className="hw-session-count">
                    {s.messageCount || (s.messages ? s.messages.length : 0)} 条消息
                  </span>
                </div>
              </div>
              <button
                className="hw-session-delete"
                onClick={(e) => handleDeleteSession(e, s.id)}
                title="删除此会话"
              >✗</button>
            </div>
          ))
        )}
      </div>

      {/* 底部操作栏 */}
      <div className="hw-footer">
        <button
          className="hw-footer-btn hw-btn-danger"
          onClick={handleDeleteAll}
          disabled={sessions.length === 0}
        >
          一键删除所有
        </button>
        <button className="hw-footer-btn hw-btn-close" onClick={handleClose}>
          关闭
        </button>
      </div>
    </div>
  )
}
