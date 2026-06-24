import React, { useState, useRef, useEffect, useCallback } from 'react'

// 预设操作模板
const PRESETS = [
  { label: '自动填表', instruction: '自动填写页面上所有表单字段，使用合理的测试数据' },
  { label: '提取数据', instruction: '提取页面中的所有数据（表格、列表等），整理为JSON格式并显示' },
  { label: '去除广告', instruction: '移除页面上的所有广告、弹窗、悬浮元素，让页面更干净' },
  { label: '高亮关键词', instruction: '在页面上高亮显示所有重要关键词' },
  { label: '自动翻页', instruction: '实现自动滚动翻页，加载更多内容' },
  { label: '截图标注', instruction: '给页面上的主要元素添加边框和标签标注，展示页面结构' },
  { label: '暗黑模式', instruction: '将当前页面切换为暗黑模式/夜间模式' },
  { label: '批量下载', instruction: '找出页面上所有可下载的图片/文件链接，列出清单' },
]

export default function SmartAction({ config }) {
  const [instruction, setInstruction] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [jsCode, setJsCode] = useState('')
  const [showCode, setShowCode] = useState(false)
  const [history, setHistory] = useState([])
  const [sessionLength, setSessionLength] = useState(0)
  const [streamingText, setStreamingText] = useState('')  // 流式输出文本
  const [isStreaming, setIsStreaming] = useState(false)
  const [mode, setMode] = useState('run') // 'run' | 'preview'
  const codeRef = useRef(null)

  useEffect(() => {
    loadHistory()
    loadSessionInfo()
  }, [])

  // 流式事件监听
  const handleStreamChunk = useCallback((data) => {
    if (data.source !== 'action') return
    setIsStreaming(true)
    setStreamingText(prev => prev + data.chunk)
  }, [])

  const handleStreamDone = useCallback((data) => {
    if (data.source !== 'action') return
    setIsStreaming(false)
  }, [])

  useEffect(() => {
    const unsub1 = window.api.ai.onStreamChunk(handleStreamChunk)
    const unsub2 = window.api.ai.onStreamDone(handleStreamDone)
    return () => {
      unsub1()
      unsub2()
    }
  }, [handleStreamChunk, handleStreamDone])

  const loadHistory = async () => {
    const h = await window.api.action.getHistory()
    setHistory(h)
  }

  const loadSessionInfo = async () => {
    const session = await window.api.action.getSession()
    setSessionLength(session.length)
  }

  // 新建会话
  const handleNewSession = async () => {
    await window.api.action.clearSession()
    setSessionLength(0)
    setResult(null)
    setJsCode('')
    setShowCode(false)
    setStreamingText('')
    setIsStreaming(false)
  }

  // 执行智能操作
  const handleRun = async () => {
    if (!instruction.trim() || loading) return
    setLoading(true)
    setResult(null)
    setJsCode('')
    setStreamingText('')
    setIsStreaming(false)

    if (config.streaming) {
      // 流式输出
      const apiCall = mode === 'preview'
        ? window.api.action.previewStream(instruction, config)
        : window.api.action.runStream(instruction, config)

      const res = await apiCall

      // 流式结束后，从流式文本中提取代码
      if (res.success) {
        const extractedCode = res.jsCode || ''
        if (extractedCode) {
          setJsCode(extractedCode)
        }
        if (res.result) {
          setResult(res.result)
        } else if (mode === 'preview') {
          setResult({ success: true, message: '代码已生成' })
        }
      } else {
        setResult({ success: false, message: res.error || '操作失败' })
      }
    } else {
      // 非流式输出
      const apiCall = mode === 'preview'
        ? window.api.action.preview(instruction, config)
        : window.api.action.run(instruction, config)

      const res = await apiCall

      if (res.success) {
        setResult(res.result || { success: true, message: '代码已生成' })
        if (res.jsCode) {
          setJsCode(res.jsCode)
        }
      } else {
        setResult({ success: false, message: res.error || '操作失败' })
      }
    }

    setLoading(false)
    loadHistory()
    loadSessionInfo()
  }

  // 手动执行JS代码
  const handleExecuteJs = async () => {
    if (!jsCode.trim()) return
    setLoading(true)
    const res = await window.api.action.executeJs(jsCode)
    setResult(res.result || { success: res.success, message: res.error || '执行完成' })
    setLoading(false)
  }

  // 复制代码
  const handleCopyCode = () => {
    if (jsCode) {
      navigator.clipboard.writeText(jsCode)
    }
  }

  // 清空历史
  const handleClearHistory = async () => {
    await window.api.action.clearHistory()
    setHistory([])
  }

  // 重新执行历史操作
  const handleReRun = async (item) => {
    if (item.jsCode) {
      setInstruction(item.instruction)
      setJsCode(item.jsCode)
      setShowCode(true)
    } else if (item.instruction) {
      setInstruction(item.instruction)
    }
  }

  const formatTime = (ts) => {
    if (!ts) return ''
    return new Date(ts).toLocaleTimeString()
  }

  return (
    <div className="smart-action">
      {/* 会话状态栏 */}
      <div className="session-bar">
        <span className="session-info">
          会话轮次: {Math.floor(sessionLength / 2)}
        </span>
        <button className="code-btn" onClick={handleNewSession} title="清空会话上下文，开始新对话">
          新会话
        </button>
      </div>

      {/* 操作输入区 */}
      <div className="action-input-section">
        <div className="section-title">描述你想要的功能</div>
        <textarea
          className="action-textarea"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="例如：自动填写登录表单、提取页面所有链接、移除广告、高亮关键词..."
          rows={3}
        />

        {/* 快捷模板 */}
        <div className="preset-tags">
          {PRESETS.map((p, i) => (
            <button
              key={i}
              className="preset-tag"
              onClick={() => setInstruction(p.instruction)}
              title={p.instruction}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* 执行按钮 */}
        <div className="action-buttons">
          <button
            className="send-btn"
            style={{ flex: 1 }}
            onClick={() => { setMode('run'); handleRun() }}
            disabled={loading || !instruction.trim()}
          >
            {loading && mode === 'run' ? (isStreaming ? '生成中(流式)...' : '执行中...') : '生成并执行'}
          </button>
          <button
            className="send-btn preview-btn"
            onClick={() => { setMode('preview'); handleRun() }}
            disabled={loading || !instruction.trim()}
          >
            {loading && mode === 'preview' ? (isStreaming ? '生成中(流式)...' : '生成中...') : '仅预览代码'}
          </button>
        </div>
      </div>

      {/* 流式输出预览 */}
      {isStreaming && streamingText && (
        <div className="streaming-preview">
          <div className="section-title">实时输出{isStreaming ? '...' : ''}</div>
          <div className="message assistant streaming-msg" style={{ maxWidth: '100%', fontSize: 12 }}>
            {streamingText}
          </div>
        </div>
      )}

      {/* 执行结果 */}
      {result && (
        <div className={`action-result ${result.success ? 'success' : 'error'}`}>
          <div className="result-header">
            <span className="result-icon">{result.success ? '✓' : '✗'}</span>
            <span>{result.message || (result.success ? '执行成功' : '执行失败')}</span>
          </div>
        </div>
      )}

      {/* 生成的代码 */}
      {jsCode && (
        <div className="code-section">
          <div className="code-header">
            <span className="section-title" style={{ margin: 0 }}>生成的代码</span>
            <div className="code-actions">
              <button className="code-btn" onClick={handleCopyCode}>复制</button>
              <button className="code-btn" onClick={() => setShowCode(!showCode)}>
                {showCode ? '收起' : '展开'}
              </button>
              <button className="code-btn run" onClick={handleExecuteJs} disabled={loading}>
                重新执行
              </button>
            </div>
          </div>
          {showCode && (
            <pre className="code-preview" ref={codeRef}>{jsCode}</pre>
          )}
        </div>
      )}

      {/* 操作历史 */}
      <div className="history-section">
        <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>操作历史 ({history.length})</span>
          {history.length > 0 && (
            <button className="code-btn" onClick={handleClearHistory}>清空</button>
          )}
        </div>
        <div className="history-list">
          {history.length === 0 && (
            <div style={{ color: 'var(--text-secondary)', fontSize: 12, padding: 8 }}>
              执行操作后历史会显示在这里
            </div>
          )}
          {history.slice().reverse().map((item, i) => (
            <div key={i} className={`history-item ${item.status}`} onClick={() => handleReRun(item)}>
              <div className="history-status">
                {item.status === 'success' ? '✓' : item.status === 'error' ? '✗' : '○'}
              </div>
              <div className="history-content">
                <div className="history-instruction">{item.instruction}</div>
                <div className="history-meta">
                  {formatTime(item.timestamp)}
                  {item.result?.message && ` · ${item.result.message}`}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
