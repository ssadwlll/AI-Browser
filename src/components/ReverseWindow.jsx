import React, { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'

// ============ 样式（自包含，使用项目 CSS 变量并带回退） ============
const CSS_TEXT = `
.rw-window {
  width: 100vw; height: 100vh;
  display: flex; flex-direction: column;
  background: var(--bg-primary, #1a1a2e);
  color: var(--text-primary, #e0e0e0);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  overflow: hidden;
}
.rw-titlebar {
  height: 32px; display: flex; align-items: center; padding: 0 12px;
  background: var(--bg-secondary, #16213e);
  border-bottom: 1px solid var(--border, #2a2a4a);
  -webkit-app-region: drag; user-select: none;
}
.rw-title { flex: 1; font-weight: 600; font-size: 13px; }
.rw-title-actions { display: flex; gap: 8px; -webkit-app-region: no-drag; }
.rw-btn {
  padding: 4px 10px; border: 1px solid var(--border, #2a2a4a);
  background: var(--bg-tertiary, #0f3460); color: var(--text-primary, #e0e0e0);
  border-radius: 4px; cursor: pointer; font-size: 12px;
  transition: all 0.15s;
}
.rw-btn:hover { background: var(--accent, #00d4ff); color: #000; }
.rw-btn.primary { background: var(--accent, #00d4ff); color: #000; border-color: var(--accent, #00d4ff); }
.rw-btn.danger { color: var(--error, #f44336); }
.rw-btn.danger:hover { background: var(--error, #f44336); color: #fff; }
.rw-btn.close { padding: 4px 8px; min-width: 28px; }

.rw-toolbar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; background: var(--bg-secondary, #16213e);
  border-bottom: 1px solid var(--border, #2a2a4a); flex-wrap: wrap;
}
.rw-tabs { display: flex; gap: 2px; }
.rw-tab {
  padding: 6px 14px; cursor: pointer; border-radius: 4px 4px 0 0;
  border: 1px solid transparent; color: var(--text-secondary, #a0a0b0);
  font-size: 12px;
}
.rw-tab.active {
  background: var(--bg-primary, #1a1a2e); color: var(--accent, #00d4ff);
  border-color: var(--border, #2a2a4a); border-bottom-color: var(--bg-primary, #1a1a2e);
}
.rw-input {
  padding: 4px 8px; background: var(--bg-input, #1e1e3f);
  border: 1px solid var(--border, #2a2a4a); color: var(--text-primary, #e0e0e0);
  border-radius: 3px; font-size: 12px; min-width: 160px;
}
.rw-select {
  padding: 4px 8px; background: var(--bg-input, #1e1e3f);
  border: 1px solid var(--border, #2a2a4a); color: var(--text-primary, #e0e0e0);
  border-radius: 3px; font-size: 12px;
}
.rw-status {
  margin-left: auto; font-size: 11px; color: var(--text-secondary, #a0a0b0);
}
.rw-status.active { color: var(--success, #4caf50); }

.rw-main {
  flex: 1; display: flex; overflow: hidden;
}
.rw-split { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

/* 网络面板 */
.rw-net-list {
  width: 360px; border-right: 1px solid var(--border, #2a2a4a);
  overflow-y: auto; flex-shrink: 0;
}
.rw-net-item {
  padding: 6px 10px; border-bottom: 1px solid var(--border, #2a2a4a);
  cursor: pointer; font-size: 11px;
  display: flex; align-items: center; gap: 6px;
}
.rw-net-item:hover { background: var(--bg-secondary, #16213e); }
.rw-net-item.active { background: var(--bg-tertiary, #0f3460); border-left: 3px solid var(--accent, #00d4ff); }
.rw-net-method {
  font-size: 10px; padding: 1px 4px; border-radius: 2px; font-weight: 600;
  min-width: 36px; text-align: center;
}
.rw-net-method.GET { background: rgba(76,175,80,0.2); color: #4caf50; }
.rw-net-method.POST { background: rgba(255,152,0,0.2); color: #ff9800; }
.rw-net-method.PUT { background: rgba(33,150,243,0.2); color: #2196f3; }
.rw-net-method.DELETE { background: rgba(244,67,54,0.2); color: #f44336; }
.rw-net-url { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary, #e0e0e0); }
.rw-net-status { font-size: 10px; min-width: 28px; }
.rw-net-status.s2 { color: var(--success, #4caf50); }
.rw-net-status.s3, .rw-net-status.s4, .rw-net-status.s5 { color: var(--error, #f44336); }

.rw-detail {
  flex: 1; overflow-y: auto; padding: 12px;
}
.rw-detail-section {
  margin-bottom: 16px; border: 1px solid var(--border, #2a2a4a); border-radius: 4px;
}
.rw-detail-header {
  padding: 6px 10px; background: var(--bg-secondary, #16213e);
  font-weight: 600; font-size: 12px; cursor: pointer;
  display: flex; align-items: center; gap: 6px;
}
.rw-detail-body { padding: 8px 10px; font-family: 'Consolas', 'Monaco', monospace; font-size: 11px; }
.rw-detail-body pre {
  margin: 0; white-space: pre-wrap; word-break: break-all;
  max-height: 300px; overflow-y: auto;
}
.rw-key-val {
  display: flex; gap: 8px; padding: 2px 0;
  border-bottom: 1px solid var(--border, #2a2a4a);
}
.rw-key { color: var(--text-secondary, #a0a0b0); min-width: 120px; }
.rw-val { color: var(--text-primary, #e0e0e0); flex: 1; word-break: break-all; }

/* AI 分析面板 */
.rw-ai-panel { display: flex; flex-direction: column; height: 100%; }
.rw-ai-input {
  padding: 8px 12px; border-bottom: 1px solid var(--border, #2a2a4a);
  display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap;
}
.rw-ai-options {
  flex-basis: 100%; width: 100%; display: flex; gap: 12px; align-items: center;
  margin-bottom: 2px; font-size: 11px; color: var(--text-secondary, #a0a0b0);
}
.rw-ai-option { display: inline-flex; align-items: center; gap: 4px; }
.rw-ai-option input[type="number"] {
  width: 64px; padding: 2px 4px; background: var(--bg-input, #1e1e3f);
  border: 1px solid var(--border, #2a2a4a); color: var(--text-primary, #e0e0e0);
  border-radius: 3px; font-size: 11px; font-family: inherit;
}
.rw-ai-running-badge {
  color: var(--accent, #00d4ff); font-size: 11px;
  animation: rw-blink 1.5s infinite;
}
.rw-ai-textarea {
  flex: 1; min-height: 40px; max-height: 120px; resize: vertical;
  padding: 6px 8px; background: var(--bg-input, #1e1e3f);
  border: 1px solid var(--border, #2a2a4a); color: var(--text-primary, #e0e0e0);
  border-radius: 3px; font-size: 12px; font-family: inherit;
}
.rw-ai-messages { flex: 1; overflow-y: auto; padding: 8px 12px; }

/* 时间线容器 */
.rw-timeline { position: relative; }

/* 时间线项 */
.rw-tl-item {
  position: relative; padding-left: 28px; margin-bottom: 10px;
}
/* 左侧竖线 */
.rw-timeline::before {
  content: ''; position: absolute; left: 11px; top: 4px; bottom: 4px;
  width: 2px; background: var(--border, #2a2a4a);
}
/* 时间点圆点 */
.rw-tl-dot {
  position: absolute; left: 0; top: 2px;
  width: 24px; height: 24px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; z-index: 1;
  border: 2px solid var(--bg-primary, #1a1a2e);
}
.rw-tl-dot.user { background: #4caf50; }
.rw-tl-dot.thinking { background: #9c27b0; }
.rw-tl-dot.tool { background: #2196f3; }
.rw-tl-dot.tool.running { background: #ff9800; animation: rw-pulse 1.2s infinite; }
.rw-tl-dot.reply { background: #00bcd4; }
.rw-tl-dot.error { background: #f44336; }
.rw-tl-dot.status {
  background: transparent; border: none; color: var(--text-secondary, #a0a0b0);
  font-size: 20px; width: 24px; height: 16px;
}

/* 卡片 */
.rw-tl-card {
  background: var(--bg-secondary, #16213e);
  border: 1px solid var(--border, #2a2a4a);
  border-radius: 6px; overflow: hidden;
}
.rw-tl-header {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px; font-size: 11px;
  border-bottom: 1px solid var(--border, #2a2a4a);
  background: rgba(255,255,255,0.02);
}
.rw-tl-tag {
  padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600;
}
.rw-tl-tag.user { background: #4caf50; color: #fff; }
.rw-tl-tag.thinking { background: #9c27b0; color: #fff; }
.rw-tl-tag.tool { background: #2196f3; color: #fff; }
.rw-tl-tag.tool.running { background: #ff9800; color: #fff; }
.rw-tl-tag.reply { background: #00bcd4; color: #fff; }
.rw-tl-tag.error { background: #f44336; color: #fff; }
.rw-tl-toolname { font-weight: 600; color: var(--text-primary, #e0e0e0); }
.rw-tl-round { margin-left: auto; color: var(--text-secondary, #a0a0b0); font-size: 10px; }

/* 卡片内容 */
.rw-tl-body { padding: 6px 8px; font-size: 12px; }
.rw-tl-body.user {
  background: rgba(76, 175, 80, 0.08); color: var(--text-primary, #e0e0e0);
}
.rw-tl-body.thinking {
  background: rgba(156, 39, 176, 0.08); color: var(--text-primary, #e0e0e0);
}
.rw-tl-body.thinking p { margin: 4px 0; }
.rw-tl-body.tool {
  background: rgba(33, 150, 243, 0.06); font-family: monospace; font-size: 11px;
}
.rw-tl-body.reply {
  background: rgba(0, 188, 212, 0.08); color: var(--text-primary, #e0e0e0);
}
.rw-tl-body.reply p { margin: 6px 0; }
.rw-tl-body.reply pre {
  background: var(--bg-tertiary, #0f3460); padding: 8px; border-radius: 4px;
  overflow-x: auto; font-size: 11px;
}
.rw-tl-body.reply code {
  background: var(--bg-tertiary, #0f3460); padding: 1px 4px; border-radius: 2px;
  font-size: 11px;
}
.rw-tl-body.error {
  background: rgba(244, 67, 54, 0.1); color: #ff6b6b;
}

/* 思考展开按钮 */
.rw-tl-expand-btn {
  background: none; border: 1px solid var(--border, #2a2a4a);
  color: var(--accent, #00d4ff); padding: 2px 8px;
  border-radius: 3px; cursor: pointer; font-size: 10px;
  margin-top: 4px;
}
.rw-tl-expand-btn:hover { background: var(--accent, #00d4ff); color: #000; }

/* 工具参数/结果折叠区 */
.rw-tl-section {
  display: flex; align-items: flex-start; gap: 4px;
  padding: 2px 0; cursor: pointer;
}
.rw-tl-section:hover { background: rgba(255,255,255,0.03); }
.rw-tl-section-toggle {
  color: var(--text-secondary, #a0a0b0); font-size: 10px;
  margin-top: 2px; user-select: none;
}
.rw-tl-section-label {
  color: var(--text-secondary, #a0a0b0); font-size: 10px;
  min-width: 32px; margin-top: 2px;
}
.rw-tl-pre {
  flex: 1; margin: 0; white-space: pre-wrap; word-break: break-all;
  color: var(--text-primary, #e0e0e0); font-size: 11px;
  max-height: 300px; overflow-y: auto;
}
.rw-tl-pre.collapsed {
  max-height: 36px; overflow: hidden; text-overflow: ellipsis;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.rw-tl-running-hint {
  color: var(--accent, #00d4ff); font-size: 11px;
  padding: 2px 0; animation: rw-blink 1s infinite;
}

/* 状态提示（非卡片） */
.rw-tl-status {
  display: flex; align-items: center; gap: 6px;
  padding-left: 28px; margin-bottom: 6px;
}
.rw-tl-status-text {
  font-size: 11px; color: var(--text-secondary, #a0a0b0);
  font-style: italic;
}

.rw-ai-streaming {
  display: inline-block; width: 8px; height: 14px;
  background: var(--accent, #00d4ff); margin-left: 2px;
  animation: rw-blink 1s infinite;
}
@keyframes rw-blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
@keyframes rw-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 152, 0, 0.6); }
  50% { box-shadow: 0 0 0 6px rgba(255, 152, 0, 0); }
}

/* 脚本面板 */
.rw-script-item {
  padding: 6px 10px; border-bottom: 1px solid var(--border, #2a2a4a);
  cursor: pointer; font-size: 11px;
}
.rw-script-item:hover { background: var(--bg-secondary, #16213e); }
.rw-script-src { color: var(--accent, #00d4ff); word-break: break-all; }
.rw-script-code {
  font-family: monospace; font-size: 11px; white-space: pre-wrap;
  word-break: break-all; padding: 8px; max-height: 500px; overflow-y: auto;
  background: var(--bg-input, #1e1e3f);
}

/* 重放面板 */
.rw-replay-form { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.rw-replay-row { display: flex; gap: 8px; align-items: center; }
.rw-replay-label { min-width: 60px; font-size: 12px; color: var(--text-secondary, #a0a0b0); }
.rw-replay-input {
  flex: 1; padding: 4px 8px; background: var(--bg-input, #1e1e3f);
  border: 1px solid var(--border, #2a2a4a); color: var(--text-primary, #e0e0e0);
  border-radius: 3px; font-size: 12px;
}
.rw-replay-textarea {
  width: 100%; min-height: 60px; padding: 4px 8px;
  background: var(--bg-input, #1e1e3f); border: 1px solid var(--border, #2a2a4a);
  color: var(--text-primary, #e0e0e0); border-radius: 3px; font-size: 12px;
  font-family: monospace; resize: vertical;
}

/* Toast */
.rw-toast {
  position: fixed; bottom: 20px; right: 20px;
  padding: 8px 16px; background: var(--bg-tertiary, #0f3460);
  border: 1px solid var(--accent, #00d4ff); border-radius: 4px;
  font-size: 12px; z-index: 1000; animation: rw-fade-in 0.2s;
}
@keyframes rw-fade-in { from { opacity: 0; } to { opacity: 1; } }

/* 空状态 */
.rw-empty {
  display: flex; align-items: center; justify-content: center;
  height: 100%; color: var(--text-secondary, #a0a0b0); font-size: 12px;
}

/* 滚动条 */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: var(--scrollbar-track, #1a1a2e); }
::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb, #2a2a4a); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--accent, #00d4ff); }
`

// ============ 主组件 ============
export default function ReverseWindow() {
  const [activeTab, setActiveTab] = useState('network') // network | scripts | replay | ai
  const [capturing, setCapturing] = useState(false)
  const [requests, setRequests] = useState([])
  const [selectedReqId, setSelectedReqId] = useState(null)
  const [filter, setFilter] = useState({ urlFilter: '', method: '', resourceType: '' })
  const [scripts, setScripts] = useState([])
  const [selectedScript, setSelectedScript] = useState(null)
  const [scriptCode, setScriptCode] = useState('')
  const [replayForm, setReplayForm] = useState({ url: '', method: 'GET', headers: '{}', body: '' })
  const [replayResult, setReplayResult] = useState(null)
  const [aiMessages, setAiMessages] = useState([])
  const [aiInput, setAiInput] = useState('')
  const [aiRunning, setAiRunning] = useState(false)
  const [maxRounds, setMaxRounds] = useState(20) // 逆向分析最大轮次
  const [toast, setToast] = useState('')
  const aiStreamRef = useRef(null) // 当前流式回复的消息 id
  const messagesEndRef = useRef(null)

  // Toast 辅助
  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(''), 2000)
  }, [])

  // 监听 Agent 事件（用于 AI 分析）
  useEffect(() => {
    if (!window.api?.reverse?.onEvent) return
    const unsubscribe = window.api.reverse.onEvent((channel, data) => {
      switch (channel) {
        case 'agentStart':
          setAiRunning(true)
          setAiMessages([])
          aiStreamRef.current = null
          break
        case 'agentStatus':
          // 显示状态提示（如"第N轮分析中..."）
          if (data?.text) {
            setAiMessages(prev => [...prev, {
              id: 'status_' + Date.now() + Math.random(),
              type: 'status',
              content: data.text,
            }])
          }
          break
        case 'agentThinking':
          // AI 每轮的思考内容
          if (data?.content) {
            setAiMessages(prev => [...prev, {
              id: 'think_' + Date.now() + Math.random(),
              type: 'thinking',
              round: data.round,
              content: data.content,
            }])
          }
          break
        case 'streamChunk': {
          // 最终回复的流式输出
          const chunk = data?.content || ''
          if (!aiStreamRef.current) {
            const id = 'reply_' + Date.now()
            setAiMessages(prev => [...prev, { id, type: 'reply', content: chunk, streaming: true }])
            aiStreamRef.current = id
          } else {
            const targetId = aiStreamRef.current
            setAiMessages(prev => prev.map(m => {
              if (m.id !== targetId) return m
              return { ...m, content: (m.content || '') + chunk }
            }))
          }
          break
        }
        case 'streamDone':
          if (aiStreamRef.current) {
            const doneId = aiStreamRef.current
            setAiMessages(prev => prev.map(m => m.id === doneId ? { ...m, streaming: false } : m))
            aiStreamRef.current = null
          }
          break
        case 'agentStep': {
          // 工具调用：running 时创建，done 时更新同一条
          const step = data?.step
          const round = data?.round
          const toolName = data?.toolName
          if (!toolName || toolName === 'finish_task' || toolName === '回复') break
          const toolKey = `tool_${step}_${round}_${toolName}`
          if (data.status === 'running') {
            setAiMessages(prev => [...prev, {
              id: toolKey,
              type: 'tool',
              step, round, toolName,
              status: 'running',
              args: data.args || {},
              result: null,
            }])
          } else {
            // done：更新对应工具消息
            setAiMessages(prev => prev.map(m => {
              if (m.id !== toolKey) return m
              return { ...m, status: 'done', result: data.result || '' }
            }))
          }
          break
        }
        case 'agentDataReport':
          // 数据报告可选处理
          break
        case 'agentError':
          setAiMessages(prev => [...prev, {
            id: 'err_' + Date.now(),
            type: 'error',
            content: data?.error || '错误',
          }])
          break
        case 'agentDone':
          setAiRunning(false)
          break
      }
    })
    return unsubscribe
  }, [])

  // 自动滚动
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [aiMessages])

  // ===== 网络面板操作 =====
  const refreshRequests = useCallback(async () => {
    const res = await window.api.reverse.getRequests(filter)
    if (res?.success) {
      setRequests(res.requests || [])
    }
  }, [filter])

  const toggleCapture = useCallback(async () => {
    if (capturing) {
      await window.api.reverse.stopCapture()
      setCapturing(false)
      showToast('已停止捕获')
    } else {
      const res = await window.api.reverse.startCapture()
      if (res?.success) {
        setCapturing(true)
        showToast('已开始捕获')
        // 自动刷新
        setTimeout(refreshRequests, 1000)
      } else {
        showToast('捕获失败: ' + (res?.error || ''))
      }
    }
  }, [capturing, refreshRequests, showToast])

  const clearRequests = useCallback(async () => {
    await window.api.reverse.clearRequests()
    setRequests([])
    setSelectedReqId(null)
    showToast('已清空')
  }, [showToast])

  // 选中请求
  const selectRequest = useCallback((req) => {
    setSelectedReqId(req.requestId)
    // 如果是 POST/PUT，填充重放表单
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      setReplayForm({
        url: req.url,
        method: req.method,
        headers: JSON.stringify(req.requestHeaders || {}, null, 2),
        body: req.postData || '',
      })
    } else {
      setReplayForm({ url: req.url, method: req.method, headers: '{}', body: '' })
    }
  }, [])

  // ===== 脚本面板 =====
  const extractScripts = useCallback(async () => {
    const res = await window.api.reverse.extractScripts()
    if (res?.success) {
      setScripts(res.scripts || [])
    }
  }, [])

  const fetchScriptSource = useCallback(async (url) => {
    setSelectedScript(url)
    const res = await window.api.reverse.fetchScriptSource(url)
    if (res?.success) {
      setScriptCode(res.code || res.preview || '(空)')
    } else {
      setScriptCode('拉取失败: ' + (res?.error || ''))
    }
  }, [])

  // ===== 重放面板 =====
  const doReplay = useCallback(async () => {
    let headers = {}
    try { headers = JSON.parse(replayForm.headers || '{}') } catch { showToast('headers JSON 格式错误'); return }
    setReplayResult(null)
    const res = await window.api.reverse.replayRequest({
      url: replayForm.url,
      method: replayForm.method,
      headers,
      body: replayForm.body || undefined,
    })
    setReplayResult(res)
  }, [replayForm, showToast])

  // ===== AI 分析 =====
  const startAiAnalysis = useCallback(async () => {
    if (!aiInput.trim() || aiRunning) return
    const userMsg = aiInput
    setAiMessages(prev => [...prev, { id: 'user_' + Date.now(), type: 'user', content: userMsg }])
    setAiInput('')
    aiStreamRef.current = null
    await window.api.reverse.startAnalysis({ userMessage: userMsg, maxRounds })
  }, [aiInput, aiRunning, maxRounds])

  const abortAi = useCallback(async () => {
    await window.api.reverse.abortAnalysis()
    setAiRunning(false)
  }, [])

  // 关闭窗口
  const handleClose = useCallback(() => {
    window.api.reverseWindow?.close()
  }, [])

  // Tab 切换时自动加载
  useEffect(() => {
    if (activeTab === 'network' && capturing) refreshRequests()
    if (activeTab === 'scripts' && scripts.length === 0) extractScripts()
  }, [activeTab])

  const selectedReq = requests.find(r => r.requestId === selectedReqId)

  return (
    <div className="rw-window">
      <style>{CSS_TEXT}</style>
      {/* 标题栏 */}
      <div className="rw-titlebar">
        <span className="rw-title">🔍 逆向分析工具</span>
        <div className="rw-title-actions">
          <button className={`rw-btn ${capturing ? 'danger' : 'primary'}`} onClick={toggleCapture}>
            {capturing ? '⏹ 停止捕获' : '▶ 开始捕获'}
          </button>
          <button className="rw-btn close" onClick={handleClose} title="关闭">✕</button>
        </div>
      </div>

      {/* 工具栏 */}
      <div className="rw-toolbar">
        <div className="rw-tabs">
          <div className={`rw-tab ${activeTab === 'network' ? 'active' : ''}`} onClick={() => setActiveTab('network')}>网络</div>
          <div className={`rw-tab ${activeTab === 'scripts' ? 'active' : ''}`} onClick={() => setActiveTab('scripts')}>脚本</div>
          <div className={`rw-tab ${activeTab === 'replay' ? 'active' : ''}`} onClick={() => setActiveTab('replay')}>重放</div>
          <div className={`rw-tab ${activeTab === 'ai' ? 'active' : ''}`} onClick={() => setActiveTab('ai')}>AI 分析</div>
        </div>
        <span className={`rw-status ${capturing ? 'active' : ''}`}>
          {capturing ? '● 捕获中' : '○ 未捕获'} · {requests.length} 条请求
        </span>
      </div>

      {/* 主区域 */}
      <div className="rw-main">
        {activeTab === 'network' && (
          <div className="rw-split" style={{ flexDirection: 'row' }}>
            {/* 请求列表 */}
            <div className="rw-net-list">
              <div style={{ padding: 8, display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
                <input
                  className="rw-input"
                  placeholder="URL 过滤"
                  value={filter.urlFilter}
                  onChange={e => setFilter({ ...filter, urlFilter: e.target.value })}
                  onKeyDown={e => e.key === 'Enter' && refreshRequests()}
                  style={{ minWidth: 100 }}
                />
                <select className="rw-select" value={filter.method} onChange={e => setFilter({ ...filter, method: e.target.value })}>
                  <option value="">全部方法</option>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="DELETE">DELETE</option>
                </select>
                <button className="rw-btn" onClick={refreshRequests} style={{ padding: '4px 8px' }}>刷新</button>
                <button className="rw-btn" onClick={clearRequests} style={{ padding: '4px 8px' }}>清空</button>
              </div>
              {requests.length === 0 ? (
                <div className="rw-empty">暂无请求<br/>{capturing ? '请触发目标操作' : '请先开始捕获'}</div>
              ) : (
                requests.map(req => (
                  <div
                    key={req.requestId}
                    className={`rw-net-item ${selectedReqId === req.requestId ? 'active' : ''}`}
                    onClick={() => selectRequest(req)}
                  >
                    <span className={`rw-net-method ${req.method}`}>{req.method}</span>
                    <span className="rw-net-url" title={req.url}>{req.url}</span>
                    <span className={`rw-net-status s${Math.floor((req.status || 0) / 100)}`}>{req.status || '...'}</span>
                  </div>
                ))
              )}
            </div>
            {/* 请求详情 */}
            <div className="rw-detail">
              {!selectedReq ? (
                <div className="rw-empty">选择左侧请求查看详情</div>
              ) : (
                <RequestDetail req={selectedReq} onReplay={() => { setReplayForm({ url: selectedReq.url, method: selectedReq.method, headers: JSON.stringify(selectedReq.requestHeaders || {}, null, 2), body: selectedReq.postData || '' }); setActiveTab('replay') }} onAiAnalyze={() => { setAiInput(`分析这个请求的加密参数:\nURL: ${selectedReq.url}\n方法: ${selectedReq.method}\n请求体: ${selectedReq.postData || '(无)'}\n响应: ${(selectedReq.responseBody || '').slice(0, 500)}`); setActiveTab('ai') }} />
              )}
            </div>
          </div>
        )}

        {activeTab === 'scripts' && (
          <div className="rw-split" style={{ flexDirection: 'row' }}>
            <div className="rw-net-list">
              <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
                <button className="rw-btn" onClick={extractScripts} style={{ width: '100%' }}>提取页面脚本</button>
              </div>
              {scripts.length === 0 ? (
                <div className="rw-empty">点击上方按钮提取脚本</div>
              ) : (
                scripts.map((s, i) => (
                  <div key={i} className="rw-script-item" onClick={() => s.src && s.src !== '(inline)' && fetchScriptSource(s.src)}>
                    <div className="rw-script-src">{s.src || '(inline)'}</div>
                    {s.type && <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{s.type}</div>}
                  </div>
                ))
              )}
            </div>
            <div className="rw-detail">
              {!selectedScript ? (
                <div className="rw-empty">点击脚本查看源码</div>
              ) : (
                <div>
                  <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--text-secondary)' }}>{selectedScript}</div>
                  <pre className="rw-script-code">{scriptCode}</pre>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'replay' && (
          <div className="rw-split">
            <div className="rw-replay-form">
              <div className="rw-replay-row">
                <span className="rw-replay-label">方法</span>
                <select className="rw-select" value={replayForm.method} onChange={e => setReplayForm({ ...replayForm, method: e.target.value })} style={{ minWidth: 100 }}>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="DELETE">DELETE</option>
                  <option value="PATCH">PATCH</option>
                </select>
                <span className="rw-replay-label">URL</span>
                <input className="rw-replay-input" value={replayForm.url} onChange={e => setReplayForm({ ...replayForm, url: e.target.value })} placeholder="https://..." />
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>请求头 (JSON)</div>
                <textarea className="rw-replay-textarea" value={replayForm.headers} onChange={e => setReplayForm({ ...replayForm, headers: e.target.value })} placeholder='{"Content-Type":"application/json"}' />
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>请求体</div>
                <textarea className="rw-replay-textarea" value={replayForm.body} onChange={e => setReplayForm({ ...replayForm, body: e.target.value })} placeholder="请求体内容" />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="rw-btn primary" onClick={doReplay} disabled={aiRunning}>发送请求</button>
                <button className="rw-btn" onClick={() => setReplayResult(null)}>清空结果</button>
              </div>
            </div>
            {replayResult && (
              <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
                <div style={{ fontSize: 12, marginBottom: 8 }}>
                  响应状态: <strong style={{ color: replayResult.ok ? 'var(--success)' : 'var(--error)' }}>{replayResult.status || replayResult.error}</strong>
                  {replayResult.bodyLength && ` · ${replayResult.bodyLength} 字符`}
                </div>
                {replayResult.respHeaders && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>响应头:</div>
                    <pre className="rw-script-code" style={{ maxHeight: 150 }}>{JSON.stringify(replayResult.respHeaders, null, 2)}</pre>
                  </div>
                )}
                {replayResult.body && (
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>响应体:</div>
                    <pre className="rw-script-code">{replayResult.body}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'ai' && (
          <div className="rw-split rw-ai-panel">
            <div className="rw-ai-input">
              <div className="rw-ai-options">
                <label className="rw-ai-option" title="设置 AI 逆向分析的最大轮次（1-100），超过后自动终止并生成总结">
                  最大轮次：
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={maxRounds}
                    onChange={e => setMaxRounds(Math.max(1, Math.min(100, Number(e.target.value) || 20)))}
                    disabled={aiRunning}
                    style={{ width: 64 }}
                  />
                </label>
                {aiRunning && <span className="rw-ai-running-badge">● 分析中</span>}
              </div>
              <textarea
                className="rw-ai-textarea"
                placeholder="描述你要分析的逆向任务... 例如：分析这个请求的签名算法"
                value={aiInput}
                onChange={e => setAiInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startAiAnalysis() } }}
              />
              {aiRunning ? (
                <button className="rw-btn danger" onClick={abortAi}>中止</button>
              ) : (
                <button className="rw-btn primary" onClick={startAiAnalysis} disabled={!aiInput.trim()}>开始分析</button>
              )}
            </div>
            <div className="rw-ai-messages rw-timeline">
              {aiMessages.length === 0 ? (
                <div className="rw-empty">
                  AI 逆向分析引擎<br/>
                  输入任务描述开始分析<br/><br/>
                  示例：<br/>
                  · 分析登录接口的签名算法<br/>
                  · 提取页面加密函数并验证<br/>
                  · 对比原始请求和重放请求的差异
                </div>
              ) : (
                aiMessages.map(msg => <AiMessageItem key={msg.id} msg={msg} />)
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}
      </div>

      {toast && <div className="rw-toast">{toast}</div>}
    </div>
  )
}

// ============ AI 消息项组件（时间线样式） ============
// 工具名中文映射
const REVERSE_TOOL_LABELS = {
  get_captured_requests: '获取捕获请求',
  fetch_script_source: '拉取脚本源码',
  replay_request: '重放请求',
  execute_js: '执行JS',
  read_page_content: '读取页面内容',
  get_page_html: '获取页面HTML',
  finish_task: '完成任务',
}

function AiMessageItem({ msg }) {
  const [expanded, setExpanded] = useState(false)

  // 用户消息
  if (msg.type === 'user') {
    return (
      <div className="rw-tl-item rw-tl-user">
        <div className="rw-tl-dot user">👤</div>
        <div className="rw-tl-card">
          <div className="rw-tl-header"><span className="rw-tl-tag user">用户</span></div>
          <div className="rw-tl-body user">{msg.content}</div>
        </div>
      </div>
    )
  }

  // 状态提示（如"第N轮分析中..."）
  if (msg.type === 'status') {
    return (
      <div className="rw-tl-item rw-tl-status">
        <div className="rw-tl-dot status">·</div>
        <div className="rw-tl-status-text">{msg.content}</div>
      </div>
    )
  }

  // AI 思考内容
  if (msg.type === 'thinking') {
    const preview = (msg.content || '').slice(0, 120)
    const isLong = (msg.content || '').length > 120
    return (
      <div className="rw-tl-item rw-tl-thinking">
        <div className="rw-tl-dot thinking">🧠</div>
        <div className="rw-tl-card">
          <div className="rw-tl-header">
            <span className="rw-tl-tag thinking">思考</span>
            {msg.round && <span className="rw-tl-round">第{msg.round}轮</span>}
          </div>
          <div className="rw-tl-body thinking">
            {expanded || !isLong ? (
              <ReactMarkdown>{msg.content}</ReactMarkdown>
            ) : (
              <>
                <ReactMarkdown>{preview + '...'}</ReactMarkdown>
                <button className="rw-tl-expand-btn" onClick={() => setExpanded(true)}>展开全部</button>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  // 工具调用
  if (msg.type === 'tool') {
    const label = REVERSE_TOOL_LABELS[msg.toolName] || msg.toolName
    const argsStr = msg.args && Object.keys(msg.args).length > 0 ? JSON.stringify(msg.args, null, 2) : '(无参数)'
    const resultStr = msg.result || ''
    const isRunning = msg.status === 'running'
    return (
      <div className="rw-tl-item rw-tl-tool">
        <div className={`rw-tl-dot tool ${isRunning ? 'running' : 'done'}`}>
          {isRunning ? '⏳' : '🔧'}
        </div>
        <div className="rw-tl-card">
          <div className="rw-tl-header">
            <span className={`rw-tl-tag tool ${isRunning ? 'running' : 'done'}`}>
              {isRunning ? '执行中' : '已完成'}
            </span>
            <span className="rw-tl-toolname">{label}</span>
            {msg.round && <span className="rw-tl-round">第{msg.round}轮 · 步骤{msg.step}</span>}
          </div>
          <div className="rw-tl-body tool">
            <div className="rw-tl-section" onClick={() => setExpanded(e => !e)}>
              <span className="rw-tl-section-toggle">{expanded ? '▼' : '▶'}</span>
              <span className="rw-tl-section-label">参数</span>
              <pre className={`rw-tl-pre ${expanded ? '' : 'collapsed'}`}>{argsStr}</pre>
            </div>
            {!isRunning && resultStr && (
              <div className="rw-tl-section" onClick={() => setExpanded(e => !e)}>
                <span className="rw-tl-section-toggle">{expanded ? '▼' : '▶'}</span>
                <span className="rw-tl-section-label">结果</span>
                <pre className={`rw-tl-pre ${expanded ? '' : 'collapsed'}`}>{resultStr}</pre>
              </div>
            )}
            {isRunning && <div className="rw-tl-running-hint">正在执行...</div>}
          </div>
        </div>
      </div>
    )
  }

  // 最终回复
  if (msg.type === 'reply') {
    return (
      <div className="rw-tl-item rw-tl-reply">
        <div className="rw-tl-dot reply">💬</div>
        <div className="rw-tl-card">
          <div className="rw-tl-header">
            <span className="rw-tl-tag reply">最终回复</span>
          </div>
          <div className="rw-tl-body reply">
            <ReactMarkdown>{msg.content || ''}</ReactMarkdown>
            {msg.streaming && <span className="rw-ai-streaming" />}
          </div>
        </div>
      </div>
    )
  }

  // 错误
  if (msg.type === 'error') {
    return (
      <div className="rw-tl-item rw-tl-error">
        <div className="rw-tl-dot error">⚠️</div>
        <div className="rw-tl-card">
          <div className="rw-tl-header"><span className="rw-tl-tag error">错误</span></div>
          <div className="rw-tl-body error">{msg.content}</div>
        </div>
      </div>
    )
  }

  return null
}

// ============ 请求详情组件 ============
function RequestDetail({ req, onReplay, onAiAnalyze }) {
  const [expanded, setExpanded] = useState({ headers: true, requestHeaders: false, requestBody: true, responseBody: true })
  const toggle = (k) => setExpanded({ ...expanded, [k]: !expanded[k] })

  return (
    <div>
      <div className="rw-detail-section">
        <div className="rw-detail-header" onClick={() => toggle('headers')}>
          <span>{expanded.headers ? '▼' : '▶'}</span> 概览
        </div>
        {expanded.headers && (
          <div className="rw-detail-body">
            <div className="rw-key-val"><span className="rw-key">URL</span><span className="rw-val">{req.url}</span></div>
            <div className="rw-key-val"><span className="rw-key">方法</span><span className="rw-val">{req.method}</span></div>
            <div className="rw-key-val"><span className="rw-key">状态</span><span className="rw-val">{req.status} {req.statusText}</span></div>
            <div className="rw-key-val"><span className="rw-key">类型</span><span className="rw-val">{req.resourceType}</span></div>
            <div className="rw-key-val"><span className="rw-key">MIME</span><span className="rw-val">{req.mimeType}</span></div>
            {req.remoteIP && <div className="rw-key-val"><span className="rw-key">远程地址</span><span className="rw-val">{req.remoteIP}:{req.remotePort}</span></div>}
            {req.initiator && <div className="rw-key-val"><span className="rw-key">发起者</span><span className="rw-val">{req.initiator.type}: {req.initiator.url}</span></div>}
          </div>
        )}
      </div>

      {req.requestHeaders && Object.keys(req.requestHeaders).length > 0 && (
        <div className="rw-detail-section">
          <div className="rw-detail-header" onClick={() => toggle('requestHeaders')}>
            <span>{expanded.requestHeaders ? '▼' : '▶'}</span> 请求头
          </div>
          {expanded.requestHeaders && (
            <div className="rw-detail-body">
              {Object.entries(req.requestHeaders).map(([k, v]) => (
                <div key={k} className="rw-key-val"><span className="rw-key">{k}</span><span className="rw-val">{v}</span></div>
              ))}
            </div>
          )}
        </div>
      )}

      {req.postData && (
        <div className="rw-detail-section">
          <div className="rw-detail-header" onClick={() => toggle('requestBody')}>
            <span>{expanded.requestBody ? '▼' : '▶'}</span> 请求体 {req.hasPostData && '★'}
          </div>
          {expanded.requestBody && (
            <div className="rw-detail-body"><pre>{req.postData}</pre></div>
          )}
        </div>
      )}

      {req.responseBody && (
        <div className="rw-detail-section">
          <div className="rw-detail-header" onClick={() => toggle('responseBody')}>
            <span>{expanded.responseBody ? '▼' : '▶'}</span> 响应体 {req.responseBodyTruncated && '(已截断)'}
          </div>
          {expanded.responseBody && (
            <div className="rw-detail-body"><pre>{req.responseBody}</pre></div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="rw-btn primary" onClick={onReplay}>🔄 重放此请求</button>
        <button className="rw-btn" onClick={onAiAnalyze}>🔍 AI 分析此请求</button>
      </div>
    </div>
  )
}
