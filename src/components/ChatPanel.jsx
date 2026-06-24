import React, { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'

export default function ChatPanel({ config }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // 统一的流式事件监听
  const handleStreamChunk = useCallback((data) => {
    if (data.source !== 'chat') return
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last && last.role === 'assistant' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, content: last.content + data.chunk }]
      }
      return [...prev, { role: 'assistant', content: data.chunk, streaming: true }]
    })
  }, [])

  const handleStreamDone = useCallback((data) => {
    if (data.source !== 'chat') return
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last && last.streaming) {
        return [...prev.slice(0, -1), { ...last, streaming: false }]
      }
      return prev
    })
    setLoading(false)
  }, [])

  useEffect(() => {
    const unsub1 = window.api.ai.onStreamChunk(handleStreamChunk)
    const unsub2 = window.api.ai.onStreamDone(handleStreamDone)
    return () => {
      unsub1()
      unsub2()
    }
  }, [handleStreamChunk, handleStreamDone])

  const send = async () => {
    if (!input.trim() || loading) return
    const userMsg = input.trim()
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: userMsg }])
    setLoading(true)

    const apiMessages = [
      { role: 'system', content: '你是一个专业的AI助手，帮助用户分析网页和回答问题。' },
      ...messages.filter(m => !m.streaming).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMsg },
    ]

    if (config.streaming) {
      // 流式输出
      await window.api.ai.chatStream(apiMessages, config)
    } else {
      // 非流式输出
      const result = await window.api.ai.chat(apiMessages, config)
      if (!result.success) {
        setMessages(prev => [...prev, { role: 'assistant', content: `错误: ${result.error}` }])
      } else if (result.reply) {
        setMessages(prev => [...prev, { role: 'assistant', content: result.reply }])
      }
      setLoading(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <div>在这里与AI对话</div>
            <div style={{ fontSize: 11 }}>可以询问当前网页相关的问题</div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            {msg.role === 'assistant' ? (
              <ReactMarkdown>{msg.content}</ReactMarkdown>
            ) : (
              msg.content
            )}
          </div>
        ))}
        {loading && (messages.length === 0 || messages[messages.length - 1]?.role !== 'assistant') && (
          <div className="message assistant">
            <div className="loading-spinner" />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input-area">
        <input
          className="chat-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入问题..."
          disabled={loading}
        />
        <button className="send-btn" onClick={send} disabled={loading || !input.trim()}>
          发送
        </button>
      </div>
    </div>
  )
}
