import React, { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'

export default function AnalysisPanel({ config }) {
  const [prompt, setPrompt] = useState('请综合分析这个网页的技术栈、API接口和关键JS逻辑。')
  const [requests, setRequests] = useState([])
  const [analysis, setAnalysis] = useState('')
  const [loading, setLoading] = useState(false)

  const refreshRequests = async () => {
    const reqs = await window.api.analysis.getRequests()
    setRequests(reqs)
  }

  useEffect(() => {
    const interval = setInterval(refreshRequests, 2000)
    return () => clearInterval(interval)
  }, [])

  const runAnalysis = async () => {
    setLoading(true)
    setAnalysis('')
    const result = await window.api.analysis.run(prompt, config)
    if (result.success) {
      setAnalysis(result.reply)
    } else {
      setAnalysis(`分析失败: ${result.error}`)
    }
    setLoading(false)
  }

  const getStatusClass = (status) => {
    if (!status) return ''
    if (status < 300) return 'success'
    if (status < 400) return 'redirect'
    return 'error'
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
        {loading ? '分析中...' : '开始逆向分析'}
      </button>

      {analysis && (
        <>
          <div className="section-title">分析结果</div>
          <div className="message assistant" style={{ maxWidth: '100%' }}>
            <ReactMarkdown>{analysis}</ReactMarkdown>
          </div>
        </>
      )}

      <div className="section-title" style={{ marginTop: 24 }}>
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
