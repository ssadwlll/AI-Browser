import React, { useState, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'

export default function AnalysisPanel({ config }) {
  const [prompt, setPrompt] = useState('请综合分析这个网页的技术栈、API接口和关键JS逻辑。')
  const [requests, setRequests] = useState([])
  const [analysis, setAnalysis] = useState('')
  const [streaming, setStreaming] = useState(false)  // 是否正在流式输出
  const [loading, setLoading] = useState(false)
  const [analysisHistory, setAnalysisHistory] = useState([])
  const [selectedHistory, setSelectedHistory] = useState(null)
  const [showHistory, setShowHistory] = useState(false)

  const refreshRequests = async () => {
    const reqs = await window.api.analysis.getRequests()
    setRequests(reqs)
  }

  const loadHistory = async () => {
    const h = await window.api.analysis.getHistory()
    setAnalysisHistory(h)
  }

  useEffect(() => {
    const interval = setInterval(refreshRequests, 2000)
    loadHistory()
    return () => clearInterval(interval)
  }, [])

  // 流式事件监听
  const handleStreamChunk = useCallback((data) => {
    if (data.source !== 'analysis') return
    setStreaming(true)
    setAnalysis(prev => prev + data.chunk)
  }, [])

  const handleStreamDone = useCallback((data) => {
    if (data.source !== 'analysis') return
    setStreaming(false)
    setLoading(false)
    loadHistory()
  }, [])

  useEffect(() => {
    window.api.ai.onStreamChunk(handleStreamChunk)
    window.api.ai.onStreamDone(handleStreamDone)
  }, [handleStreamChunk, handleStreamDone])

  const runAnalysis = async () => {
    setLoading(true)
    setAnalysis('')
    setStreaming(false)
    setSelectedHistory(null)

    if (config.streaming) {
      // 流式输出
      await window.api.analysis.runStream(prompt, config)
    } else {
      // 非流式输出
      const result = await window.api.analysis.run(prompt, config)
      if (result.success) {
        setAnalysis(result.reply)
      } else {
        setAnalysis(`分析失败: ${result.error}`)
      }
      setLoading(false)
      loadHistory()
    }
  }

  // 查看历史记录
  const handleViewHistory = (item) => {
    setSelectedHistory(item)
    setAnalysis(item.reply)
    setPrompt(item.prompt)
    setShowHistory(false)
  }

  // 清空历史
  const handleClearHistory = async () => {
    await window.api.analysis.clearHistory()
    setAnalysisHistory([])
    setSelectedHistory(null)
  }

  const getStatusClass = (status) => {
    if (!status) return ''
    if (status < 300) return 'success'
    if (status < 400) return 'redirect'
    return 'error'
  }

  const formatTime = (ts) => {
    if (!ts) return ''
    return new Date(ts).toLocaleString()
  }

  return (
    <div className="analysis-panel">
      <div className="section-title">分析提示词</div>
      <textarea
        className="analysis-textarea"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="输入你想分析的内容，如：分析这个网站的登录接口加密逻辑..."
      />
      <button
        className="send-btn"
        style={{ width: '100%', marginTop: 8 }}
        onClick={runAnalysis}
        disabled={loading}
      >
        {loading ? (streaming ? '分析中(流式)...' : '分析中...') : '开始逆向分析'}
      </button>

      {analysis && (
        <>
          <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>分析结果{streaming ? ' (输出中...)' : ''}</span>
            {selectedHistory && (
              <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                历史记录 · {formatTime(selectedHistory.timestamp)}
              </span>
            )}
          </div>
          <div className="message assistant" style={{ maxWidth: '100%' }}>
            <ReactMarkdown>{analysis}</ReactMarkdown>
          </div>
        </>
      )}

      {/* 分析历史 */}
      <div className="section-title" style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span
          style={{ cursor: 'pointer' }}
          onClick={() => setShowHistory(!showHistory)}
        >
          分析历史 ({analysisHistory.length}) {showHistory ? '▲' : '▼'}
        </span>
        {analysisHistory.length > 0 && (
          <button className="code-btn" onClick={handleClearHistory}>清空</button>
        )}
      </div>
      {showHistory && (
        <div className="history-list">
          {analysisHistory.length === 0 && (
            <div style={{ color: 'var(--text-secondary)', fontSize: 12, padding: 8 }}>
              执行分析后历史会显示在这里
            </div>
          )}
          {analysisHistory.slice().reverse().map((item, i) => (
            <div
              key={i}
              className={`history-item ${selectedHistory?.timestamp === item.timestamp ? 'active' : ''}`}
              onClick={() => handleViewHistory(item)}
            >
              <div className="history-status" style={{ color: 'var(--accent)' }}>🔍</div>
              <div className="history-content">
                <div className="history-instruction">{item.prompt}</div>
                <div className="history-meta">
                  {formatTime(item.timestamp)}
                  {item.title ? ` · ${item.title}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="section-title" style={{ marginTop: 16 }}>
        捕获的请求 ({requests.length})
        <button
          onClick={refreshRequests}
          style={{ float: 'right', background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }}
        >
          刷新
        </button>
      </div>
      <div className="request-list">
        {requests.length === 0 && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 12, padding: 8 }}>
            浏览网页后请求会显示在这里
          </div>
        )}
        {requests.slice(-50).reverse().map((req, i) => (
          <div key={i} className="request-item">
            <span className={`method-badge ${req.method}`}>{req.method}</span>
            <span className={`status-code ${getStatusClass(req.response?.statusCode)}`}>
              {req.response?.statusCode || '...'}
            </span>
            <span className="request-url" title={req.url}>{req.url}</span>
            <span style={{ color: 'var(--text-secondary)', fontSize: 10 }}>{req.resourceType}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
