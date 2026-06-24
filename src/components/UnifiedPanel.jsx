import React, { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'

// 工具名称映射为中文
const TOOL_LABELS = {
  collect_page_context: '收集页面信息',
  execute_js: '执行JS代码',
  get_network_requests: '获取网络请求',
  navigate_to: '导航页面',
  extract_page_scripts: '提取页面脚本',
  get_page_html: '获取页面HTML',
  screenshot: '页面截图',
}

const SESSIONS_KEY = 'ai-browser-sessions'

// 会话管理
function loadSessions() {
  try {
    const data = localStorage.getItem(SESSIONS_KEY)
    return data ? JSON.parse(data) : []
  } catch { return [] }
}

function saveSessions(sessions) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
}

function createSessionId() {
  return 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8)
}

export default function UnifiedPanel({ config }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessions, setSessions] = useState(() => loadSessions())
  const [activeSessionId, setActiveSessionId] = useState(null)
  const [showSessionList, setShowSessionList] = useState(false)
  const messagesEndRef = useRef(null)
  const nextIdRef = useRef(1)
  const chatHistoryRef = useRef([]) // 发送给AI的对话历史
  const currentStreamMsgIdRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // 添加消息
  const addMessage = useCallback((msg) => {
    const id = nextIdRef.current++
    setMessages(prev => [...prev, { id, timestamp: Date.now(), ...msg }])
    return id
  }, [])

  // 更新消息
  const updateMessage = useCallback((id, updates) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...updates } : m))
  }, [])

  // ============ 会话管理 ============

  // 保存当前会话
  const saveCurrentSession = useCallback(() => {
    if (!activeSessionId || messages.length === 0) return

    setSessions(prev => {
      const idx = prev.findIndex(s => s.id === activeSessionId)

      // 从消息中重建对话历史（用于发送给AI）
      const chatHistory = []
      for (const m of messages) {
        if (m.role === 'user') {
          chatHistory.push({ role: 'user', content: m.content })
        } else if (m.role === 'assistant' && m.type === 'reply' && m.content) {
          chatHistory.push({ role: 'assistant', content: m.content })
        }
      }

      const sessionData = {
        id: activeSessionId,
        title: messages.find(m => m.role === 'user')?.content?.substring(0, 40) || '新会话',
        messages: messages.map(({ role, type, content, jsCode, toolName, success, error, result, description }) =>
          ({ role, type, content, jsCode, toolName, success, error, result, description })
        ),
        chatHistory,
        updatedAt: Date.now(),
        messageCount: messages.length,
      }

      let newSessions
      if (idx >= 0) {
        newSessions = [...prev]
        newSessions[idx] = sessionData
      } else {
        newSessions = [sessionData, ...prev]
      }
      saveSessions(newSessions)
      return newSessions
    })
  }, [activeSessionId, messages])

  // 自动保存
  useEffect(() => {
    if (activeSessionId && messages.length > 0) {
      saveCurrentSession()
    }
  }, [messages, activeSessionId, saveCurrentSession])

  // 新建会话
  const handleNewSession = useCallback(() => {
    // 先保存当前会话
    if (activeSessionId) saveCurrentSession()

    const newId = createSessionId()
    setMessages([])
    chatHistoryRef.current = []
    nextIdRef.current = 1
    setActiveSessionId(newId)
    setShowSessionList(false)
  }, [activeSessionId, saveCurrentSession])

  // 切换会话
  const handleSwitchSession = useCallback((session) => {
    if (activeSessionId) saveCurrentSession()

    setActiveSessionId(session.id)
    setMessages(session.messages || [])
    chatHistoryRef.current = session.chatHistory || []
    nextIdRef.current = (session.messages || []).length + 1
    setShowSessionList(false)
  }, [activeSessionId, saveCurrentSession])

  // 删除会话
  const handleDeleteSession = useCallback((sessionId, e) => {
    e.stopPropagation()
    setSessions(prev => {
      const newSessions = prev.filter(s => s.id !== sessionId)
      saveSessions(newSessions)
      return newSessions
    })
    if (sessionId === activeSessionId) {
      handleNewSession()
    }
  }, [activeSessionId, handleNewSession])

  // ============ 统一AI事件监听 ============

  const handleThinking = useCallback((data) => {
    addMessage({
      role: 'system', type: 'thinking',
      content: `AI正在思考... (第 ${data.round} 轮)`,
    })
  }, [addMessage])

  const handleStreamChunk = useCallback((data) => {
    const msgId = currentStreamMsgIdRef.current
    if (!msgId) return
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId) return m
      return { ...m, content: m.content + data.chunk }
    }))
  }, [])

  const handleToolCall = useCallback((data) => {
    addMessage({
      role: 'system', type: 'tool_call',
      content: `调用工具: ${TOOL_LABELS[data.toolName] || data.toolName}`,
      toolName: data.toolName,
      toolArgs: data.toolArgs,
      round: data.round,
    })
  }, [addMessage])

  const handleToolResult = useCallback((data) => {
    const label = TOOL_LABELS[data.toolName] || data.toolName
    if (data.toolName === 'execute_js' && data.toolArgs?.code) {
      addMessage({
        role: 'assistant', type: 'tool_execute',
        content: data.success ? `${label}成功` : `${label}失败`,
        jsCode: data.toolArgs.code,
        result: data.result,
        error: data.error,
        description: data.description,
        round: data.round,
      })
    } else {
      addMessage({
        role: 'system', type: 'tool_result',
        content: data.success
          ? `${label}完成${data.result?.url ? ` - ${data.result.url}` : ''}${data.result?.title ? ` (${data.result.title})` : ''}`
          : `${label}失败: ${data.error || '未知错误'}`,
        toolName: data.toolName,
        success: data.success,
        result: data.result,
        round: data.round,
      })
    }
  }, [addMessage])

  const handleFinalReply = useCallback((data) => {
    const msgId = addMessage({
      role: 'assistant', type: 'reply',
      content: data.content || '',
    })
    currentStreamMsgIdRef.current = msgId
    // 将AI实际回复加入对话历史
    if (data.content) {
      chatHistoryRef.current.push({ role: 'assistant', content: data.content })
    }
  }, [addMessage])

  const handleDone = useCallback((data) => {
    setLoading(false)
    currentStreamMsgIdRef.current = null
    if (!data.success && data.error) {
      addMessage({
        role: 'assistant', type: 'error',
        content: `任务失败: ${data.error}`,
      })
    }
  }, [addMessage])

  useEffect(() => {
    const unsub1 = window.api.unified.onThinking(handleThinking)
    const unsub2 = window.api.unified.onStreamChunk(handleStreamChunk)
    const unsub3 = window.api.unified.onToolCall(handleToolCall)
    const unsub4 = window.api.unified.onToolResult(handleToolResult)
    const unsub5 = window.api.unified.onFinalReply(handleFinalReply)
    const unsub6 = window.api.unified.onDone(handleDone)
    return () => {
      unsub1()
      unsub2()
      unsub3()
      unsub4()
      unsub5()
      unsub6()
    }
  }, [handleThinking, handleStreamChunk, handleToolCall, handleToolResult, handleFinalReply, handleDone])

  // ============ 发送消息 ============

  const handleSend = async () => {
    const userMsg = input.trim()
    if (!userMsg || loading) return

    // 如果没有活跃会话，自动创建
    if (!activeSessionId) {
      setActiveSessionId(createSessionId())
    }

    setInput('')
    addMessage({ role: 'user', content: userMsg })
    setLoading(true)

    chatHistoryRef.current.push({ role: 'user', content: userMsg })

    try {
      await window.api.unified.chatStream(
        chatHistoryRef.current,
        config,
        20,
      )
      // 不再添加 [completed] 占位符
      // AI的实际回复内容通过 handleFinalReply 事件获取
      // chatHistoryRef 会在 saveCurrentSession 时从 messages 重建
    } catch (e) {
      addMessage({ role: 'assistant', type: 'error', content: `错误: ${e.message}` })
      setLoading(false)
    }
  }

  // 重新执行JS代码
  const handleReExecute = async (jsCode) => {
    if (!jsCode.trim() || loading) return

    setLoading(true)
    addMessage({ role: 'system', type: 'tool_call', content: '重新执行JS代码' })

    try {
      const result = await window.api.action.executeJs(jsCode)
      addMessage({
        role: 'assistant', type: 'tool_execute',
        content: result.success ? '代码重新执行成功' : '代码重新执行失败',
        jsCode,
        result: result.result,
        error: result.success ? null : result.error,
      })
    } catch (e) {
      addMessage({
        role: 'assistant', type: 'error',
        content: `代码执行异常: ${e.message}`,
      })
    } finally {
      setLoading(false)
    }
  }

  // 中止
  const handleAbort = async () => {
    await window.api.unified.abort()
  }

  // 清空当前会话消息
  const handleClear = () => {
    setMessages([])
    chatHistoryRef.current = []
    nextIdRef.current = 1
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ============ 渲染消息 ============

  const renderMessage = (msg) => {
    if (msg.role === 'system') {
      if (msg.type === 'thinking') {
        return (
          <div key={msg.id} className="msg-system thinking-msg">
            <span className="thinking-dot" />
            <span>{msg.content}</span>
          </div>
        )
      }
      if (msg.type === 'tool_call') {
        return (
          <div key={msg.id} className="msg-system tool-call-msg">
            <span className="tool-icon">⚡</span>
            <span>{msg.content}</span>
          </div>
        )
      }
      if (msg.type === 'tool_result') {
        if (msg.toolName === 'collect_page_context' && msg.success) {
          return (
            <div key={msg.id} className="msg-system tool-result-msg">
              <span className="tool-icon">📄</span>
              <span>{msg.content}</span>
              {msg.result?.domSummary && (
                <details className="context-details">
                  <summary>查看页面结构 ({msg.result.domSummary.length} 个元素)</summary>
                  <pre className="code-preview">{JSON.stringify(msg.result.domSummary.slice(0, 30), null, 2)}</pre>
                </details>
              )}
            </div>
          )
        }
        if (msg.toolName === 'get_network_requests' && msg.success) {
          return (
            <div key={msg.id} className="msg-system tool-result-msg">
              <span className="tool-icon">🌐</span>
              <span>{msg.content}</span>
              {msg.result?.requests && msg.result.requests.length > 0 && (
                <details className="context-details">
                  <summary>查看请求列表 ({msg.result.requests.length} 条)</summary>
                  <pre className="code-preview">{JSON.stringify(msg.result.requests.slice(0, 10), null, 2)}</pre>
                </details>
              )}
            </div>
          )
        }
        return (
          <div key={msg.id} className="msg-system tool-result-msg">
            <span className="tool-icon">{msg.success ? '✓' : '✗'}</span>
            <span>{msg.content}</span>
          </div>
        )
      }
      return (
        <div key={msg.id} className="msg-system">
          <span className="msg-system-icon">ℹ</span>
          <span>{msg.content}</span>
        </div>
      )
    }

    if (msg.role === 'user') {
      return (
        <div key={msg.id} className="msg-user">
          <div className="msg-content">{msg.content}</div>
        </div>
      )
    }

    if (msg.type === 'error') {
      return (
        <div key={msg.id} className="msg-error">
          <span className="msg-error-icon">✗</span>
          <span>{msg.content}</span>
        </div>
      )
    }

    if (msg.type === 'tool_execute') {
      return (
        <div key={msg.id} className="msg-action">
          <div className={`round-result-inline ${msg.error ? 'error' : 'success'}`}>
            <span>{msg.error ? '✗' : '✓'}</span>
            <span>{msg.error || msg.result?.message || msg.content}</span>
          </div>
          {msg.jsCode && (
            <div className="code-block-with-replay">
              <div className="code-block-header">
                <span className="code-block-label">执行的代码</span>
                <button
                  className="code-replay-btn"
                  onClick={() => handleReExecute(msg.jsCode)}
                  disabled={loading}
                  title="重新执行这段代码"
                >
                  重新执行
                </button>
              </div>
              <pre className="code-preview">{msg.jsCode}</pre>
            </div>
          )}
          {msg.result?.data && (
            <details className="data-details">
              <summary>查看返回数据</summary>
              <pre>{JSON.stringify(msg.result.data, null, 2)}</pre>
            </details>
          )}
        </div>
      )
    }

    if (msg.type === 'reply') {
      return (
        <div key={msg.id} className="msg-assistant">
          <div className="msg-markdown">
            <ReactMarkdown>{msg.content}</ReactMarkdown>
          </div>
        </div>
      )
    }

    return (
      <div key={msg.id} className="msg-assistant">
        <div className="msg-markdown">
          <ReactMarkdown>{msg.content || ''}</ReactMarkdown>
        </div>
      </div>
    )
  }

  return (
    <div className="unified-panel">
      {/* 工具栏 */}
      <div className="unified-toolbar">
        <div className="toolbar-left">
          <button className="toolbar-btn" onClick={handleNewSession} title="新建会话">
            + 新会话
          </button>
          <button className="toolbar-btn" onClick={() => setShowSessionList(!showSessionList)} title="历史会话">
            历史 ({sessions.length})
          </button>
          {loading && (
            <button className="toolbar-btn stop-btn" onClick={handleAbort}>
              停止
            </button>
          )}
        </div>
        <div className="toolbar-right">
          <button className="toolbar-btn" onClick={handleClear} title="清空当前对话">
            清空
          </button>
        </div>
      </div>

      {/* 会话列表 */}
      {showSessionList && (
        <div className="session-list">
          {sessions.length === 0 && (
            <div className="session-empty">暂无历史会话</div>
          )}
          {sessions.map(s => (
            <div
              key={s.id}
              className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
              onClick={() => handleSwitchSession(s)}
            >
              <div className="session-item-title">{s.title}</div>
              <div className="session-item-meta">
                <span>{new Date(s.updatedAt).toLocaleString()}</span>
                <span>{s.messageCount || 0} 条消息</span>
              </div>
              <button
                className="session-delete-btn"
                onClick={(e) => handleDeleteSession(s.id, e)}
                title="删除会话"
              >
                ✗
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 消息区 */}
      <div className="unified-messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <div style={{ fontSize: 28, marginBottom: 8 }}>✦</div>
            <div>AI 浏览器助手</div>
            <div style={{ fontSize: 11, marginTop: 4, color: 'var(--text-secondary)' }}>
              AI自主决策 · 工具调用 · 对话即操作
            </div>
            <div className="empty-hints">
              <div className="hint-item" onClick={() => { setInput('分析当前页面的技术栈和API接口') }}>
                🔍 分析页面技术栈
              </div>
              <div className="hint-item" onClick={() => { setInput('抓取页面上所有数据，整理为JSON格式') }}>
                🤖 抓取页面数据
              </div>
              <div className="hint-item" onClick={() => { setInput('移除页面上的广告和弹窗') }}>
                ⚡ 去除广告弹窗
              </div>
              <div className="hint-item" onClick={() => { setInput('帮我看看这个页面有什么内容') }}>
                💬 了解页面内容
              </div>
            </div>
          </div>
        )}
        {messages.map(renderMessage)}
        {loading && messages.length > 0 && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="msg-assistant">
            <div className="loading-spinner" />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 输入区 */}
      <div className="unified-input-area">
        <div className="input-row">
          <textarea
            className="unified-input"
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px'
            }}
            onKeyDown={handleKeyDown}
            placeholder="输入问题或任务，AI自主决策调用工具..."
            rows={1}
            disabled={loading}
          />
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={loading || !input.trim()}
          >
            {loading ? '运行中' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}
