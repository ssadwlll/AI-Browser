import React, { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'

// 预设任务模板
const TASK_PRESETS = [
  { label: '抓取页面数据', task: '抓取当前页面上的所有数据（表格、列表、卡片等），整理为结构化JSON格式' },
  { label: '提取所有链接', task: '提取页面中所有链接，包括链接文本和URL，分类整理' },
  { label: '自动填表', task: '自动填写页面上所有表单字段，使用合理的测试数据' },
  { label: '监控价格', task: '提取页面上所有商品的价格信息，包括商品名称和对应价格' },
  { label: '批量下载图片', task: '找出页面上所有图片的URL，列出可下载的图片清单' },
  { label: '页面摘要', task: '提取页面的主要内容，生成结构化的页面摘要，包括标题、正文、关键信息' },
  { label: '去除广告', task: '移除页面上的所有广告、弹窗、悬浮元素，让页面更干净' },
  { label: '自动翻页抓取', task: '自动翻页并抓取每一页的数据，直到没有更多页面' },
]

export default function AgentPanel({ config }) {
  const [task, setTask] = useState('')
  const [maxRounds, setMaxRounds] = useState(15)
  const [running, setRunning] = useState(false)
  const [rounds, setRounds] = useState([])         // 每轮的详细信息
  const [currentRound, setCurrentRound] = useState(0)
  const [streamingText, setStreamingText] = useState('')
  const [phase, setPhase] = useState('')            // thinking / executing / completed / error / no_code
  const [phaseMessage, setPhaseMessage] = useState('')
  const [finalResult, setFinalResult] = useState(null)
  const [history, setHistory] = useState([])
  const [showHistory, setShowHistory] = useState(false)
  const roundsEndRef = useRef(null)

  useEffect(() => {
    loadHistory()
  }, [])

  useEffect(() => {
    roundsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [rounds, streamingText])

  // 智能体事件监听
  const handleAgentStart = useCallback((data) => {
    setRunning(true)
    setRounds([])
    setCurrentRound(0)
    setStreamingText('')
    setPhase('thinking')
    setPhaseMessage('智能体启动中...')
    setFinalResult(null)
  }, [])

  const handleAgentRound = useCallback((data) => {
    setCurrentRound(data.round)
    setPhase(data.phase)
    setPhaseMessage(data.message)

    // 更新轮次信息
    setRounds(prev => {
      const existing = prev.findIndex(r => r.round === data.round)
      const roundInfo = {
        round: data.round,
        phase: data.phase,
        message: data.message,
        reply: data.reply || (existing >= 0 ? prev[existing].reply : ''),
        jsCode: data.jsCode || (existing >= 0 ? prev[existing].jsCode : ''),
        result: data.result || (existing >= 0 ? prev[existing].result : null),
        timestamp: Date.now(),
      }
      if (existing >= 0) {
        const updated = [...prev]
        updated[existing] = roundInfo
        return updated
      }
      return [...prev, roundInfo]
    })

    // 新一轮开始时清空流式文本
    if (data.phase === 'thinking') {
      setStreamingText('')
    }
  }, [])

  const handleAgentStream = useCallback((data) => {
    setStreamingText(prev => prev + data.chunk)
  }, [])

  const handleAgentDone = useCallback((data) => {
    setRunning(false)
    setPhase(data.success ? 'completed' : 'error')
    setPhaseMessage(data.summary || (data.success ? '任务完成' : '任务失败'))
    setFinalResult(data)
    loadHistory()
  }, [])

  useEffect(() => {
    const unsub1 = window.api.agent.onAgentStart(handleAgentStart)
    const unsub2 = window.api.agent.onAgentRound(handleAgentRound)
    const unsub3 = window.api.agent.onAgentStream(handleAgentStream)
    const unsub4 = window.api.agent.onAgentDone(handleAgentDone)
    return () => {
      unsub1()
      unsub2()
      unsub3()
      unsub4()
    }
  }, [handleAgentStart, handleAgentRound, handleAgentStream, handleAgentDone])

  const loadHistory = async () => {
    const h = await window.api.agent.getHistory()
    setHistory(h)
  }

  // 启动智能体
  const handleStart = async () => {
    if (!task.trim() || running) return
    setRounds([])
    setFinalResult(null)
    setStreamingText('')
    setRunning(true)

    const result = await window.api.agent.run(task, config, maxRounds)

    // 如果直接返回错误（非循环内错误）
    if (!result.success && result.error) {
      setRunning(false)
      setPhase('error')
      setPhaseMessage(result.error)
      setFinalResult(result)
    }
  }

  // 停止智能体
  const handleAbort = async () => {
    await window.api.agent.abort()
  }

  // 重置
  const handleReset = async () => {
    await window.api.agent.reset()
    setRounds([])
    setCurrentRound(0)
    setStreamingText('')
    setPhase('')
    setPhaseMessage('')
    setFinalResult(null)
    setRunning(false)
  }

  // 清空历史
  const handleClearHistory = async () => {
    await window.api.agent.clearHistory()
    setHistory([])
  }

  // 获取阶段标签
  const getPhaseLabel = (p) => {
    const map = {
      thinking: 'AI分析',
      executing: '执行代码',
      executed: '执行成功',
      no_code: '无代码',
      completed: '已完成',
      error: '执行失败',
    }
    return map[p] || p
  }

  // 获取阶段颜色
  const getPhaseColor = (p) => {
    const map = {
      thinking: '#00d4ff',
      executing: '#ff9800',
      executed: '#4caf50',
      no_code: '#ff9800',
      completed: '#4caf50',
      error: '#f44336',
    }
    return map[p] || '#a0a0b0'
  }

  const formatTime = (ts) => {
    if (!ts) return ''
    return new Date(ts).toLocaleTimeString()
  }

  return (
    <div className="agent-panel">
      {/* 任务输入区 */}
      <div className="agent-input-section">
        <div className="section-title">描述任务目标</div>
        <textarea
          className="agent-textarea"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="描述你希望智能体自动完成的任务...&#10;例如：抓取页面上所有商品的价格和名称，整理为JSON"
          rows={3}
          disabled={running}
        />

        {/* 快捷任务模板 */}
        <div className="preset-tags">
          {TASK_PRESETS.map((p, i) => (
            <button
              key={i}
              className="preset-tag"
              onClick={() => setTask(p.task)}
              disabled={running}
              title={p.task}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* 参数和操作按钮 */}
        <div className="agent-controls">
          <div className="agent-param">
            <label className="param-label">最大轮次</label>
            <input
              type="number"
              className="param-input"
              value={maxRounds}
              onChange={(e) => setMaxRounds(Math.max(1, Math.min(50, parseInt(e.target.value) || 15)))}
              min={1}
              max={50}
              disabled={running}
            />
          </div>
          <div className="agent-buttons">
            {!running ? (
              <>
                <button
                  className="send-btn agent-start-btn"
                  onClick={handleStart}
                  disabled={!task.trim()}
                >
                  启动智能体
                </button>
                {finalResult && (
                  <button className="code-btn" onClick={handleReset}>
                    重置
                  </button>
                )}
              </>
            ) : (
              <button className="send-btn agent-stop-btn" onClick={handleAbort}>
                停止
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 运行状态指示器 */}
      {running && (
        <div className="agent-status-bar">
          <div className="status-indicator">
            <div className="status-dot running" />
            <span className="status-text">
              第 {currentRound} 轮 · {getPhaseLabel(phase)}
            </span>
          </div>
          <div className="status-progress">
            <div
              className="progress-fill"
              style={{ width: `${(currentRound / maxRounds) * 100}%` }}
            />
          </div>
          {phaseMessage && (
            <div className="status-message">{phaseMessage}</div>
          )}
        </div>
      )}

      {/* 最终结果 */}
      {finalResult && !running && (
        <div className={`agent-final-result ${finalResult.success ? 'success' : 'error'}`}>
          <div className="final-header">
            <span className="final-icon">{finalResult.success ? '✓' : '✗'}</span>
            <span className="final-title">
              {finalResult.success ? '任务完成' : '任务未完成'}
            </span>
            <span className="final-rounds">共 {finalResult.rounds || currentRound} 轮</span>
          </div>
          <div className="final-summary">{finalResult.summary}</div>
        </div>
      )}

      {/* 轮次详情 */}
      {rounds.length > 0 && (
        <div className="agent-rounds">
          <div className="section-title">执行过程</div>
          {rounds.map((r, i) => (
            <div key={i} className={`round-item ${r.phase}`}>
              <div className="round-header">
                <span
                  className="round-phase-badge"
                  style={{ background: getPhaseColor(r.phase) }}
                >
                  {getPhaseLabel(r.phase)}
                </span>
                <span className="round-number">第 {r.round} 轮</span>
                <span className="round-time">{formatTime(r.timestamp)}</span>
              </div>

              {/* AI回复（当前轮正在流式输出时显示） */}
              {r.phase === 'thinking' && i === rounds.length - 1 && streamingText && (
                <div className="round-reply streaming">
                  <ReactMarkdown>{streamingText}</ReactMarkdown>
                </div>
              )}

              {/* 已完成的AI回复 */}
              {r.reply && r.phase !== 'thinking' && (
                <div className="round-reply">
                  <ReactMarkdown>{r.reply.substring(0, 800)}</ReactMarkdown>
                </div>
              )}

              {/* 执行的JS代码 */}
              {r.jsCode && (
                <details className="round-code">
                  <summary>查看执行的代码</summary>
                  <pre className="code-preview">{r.jsCode}</pre>
                </details>
              )}

              {/* 执行结果 */}
              {r.result && (
                <div className={`round-result ${r.result.success ? 'success' : 'error'}`}>
                  <span className="result-icon">{r.result.success ? '✓' : '✗'}</span>
                  <span>{r.result.message || JSON.stringify(r.result).substring(0, 200)}</span>
                  {r.result.data && (
                    <details className="result-data">
                      <summary>查看数据</summary>
                      <pre>{JSON.stringify(r.result.data, null, 2).substring(0, 1000)}</pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={roundsEndRef} />
        </div>
      )}

      {/* 历史记录 */}
      <div className="history-section">
        <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span
            className="clickable-title"
            onClick={() => setShowHistory(!showHistory)}
          >
            任务历史 ({history.length}) {showHistory ? '▲' : '▼'}
          </span>
          {history.length > 0 && (
            <button className="code-btn" onClick={handleClearHistory}>清空</button>
          )}
        </div>
        {showHistory && (
          <div className="history-list">
            {history.length === 0 && (
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, padding: 8 }}>
                执行任务后历史会显示在这里
              </div>
            )}
            {history.slice().reverse().map((item, i) => (
              <div key={i} className={`history-item ${item.status}`}>
                <div className="history-status">
                  {item.status === 'completed' ? '✓' : item.status === 'success' ? '●' : item.status === 'error' ? '✗' : '○'}
                </div>
                <div className="history-content">
                  <div className="history-instruction">
                    第{item.round}轮 · {item.status}
                  </div>
                  <div className="history-meta">
                    {formatTime(item.timestamp)}
                    {item.reply && ` · ${item.reply.substring(0, 50)}...`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
