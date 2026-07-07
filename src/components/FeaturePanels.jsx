// ============ 内置工具浮动面板（对齐 chrome-extension feature-panels.js） ============
// 5个标签页：任务模板 / 工具录制 / 定时任务 / 资源监控 / 调试日志
// 通过 window.api 调用主进程已暴露的 IPC 接口

import { useState, useEffect, useRef, useCallback } from 'react'

// ============================================================
// 任务模板面板
// ============================================================
function TaskTemplatePanel() {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await window.api.taskTemplate.list()
      const data = res?.data || res || []
      setTemplates(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleUse = async (template) => {
    try {
      const res = await window.api.taskTemplate.instantiate(template.id, {})
      const data = res?.data || res
      // 将实例化的消息填入聊天输入框（通过自定义事件通知 UnifiedPanel）
      const msg = data?.userMessage || `按模板"${template.name}"执行任务`
      window.dispatchEvent(new CustomEvent('feature-panel-action', { detail: { type: 'fillInput', value: msg } }))
    } catch (e) {
      console.warn('[TaskTemplate] 使用失败:', e.message)
    }
  }

  if (loading) return <div className="fp-empty">加载中...</div>
  if (error) return <div className="fp-empty">加载失败: {error}</div>
  if (templates.length === 0) return <div className="fp-empty">暂无模板</div>

  return (
    <div className="fp-list">
      {templates.map(t => (
        <div key={t.id} className="fp-list-row">
          <span className="fp-list-name" title={t.description || ''}>{t.name || t.id}</span>
          <button className="fp-btn fp-btn-primary" onClick={() => handleUse(t)}>使用</button>
        </div>
      ))}
    </div>
  )
}

// ============================================================
// 工具录制面板
// ============================================================
function ToolRecordingPanel() {
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const [entries, setEntries] = useState([])
  const [loadingDetail, setLoadingDetail] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await window.api.toolRecording.list(20)
      const data = res?.data || res || []
      setSessions(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleViewDetail = async (sessionId) => {
    if (expandedId === sessionId) {
      setExpandedId(null)
      return
    }
    setExpandedId(sessionId)
    setLoadingDetail(true)
    try {
      const res = await window.api.toolRecording.get(sessionId)
      const data = res?.data || res || []
      setEntries(Array.isArray(data) ? data : [])
    } catch (e) {
      setEntries([])
    } finally {
      setLoadingDetail(false)
    }
  }

  if (loading) return <div className="fp-empty">加载中...</div>
  if (error) return <div className="fp-empty">加载失败: {error}</div>
  if (sessions.length === 0) return <div className="fp-empty">暂无录制记录（Agent 执行时自动录制）</div>

  return (
    <div className="fp-list">
      {sessions.map(s => (
        <div key={s.sessionId}>
          <div className="fp-list-row">
            <span className="fp-list-name" title={'工具: ' + (s.tools || []).join(', ')}>
              {s.count || s.toolCount || '?'}次调用 | {s.lastTimestamp ? new Date(s.lastTimestamp).toLocaleString('zh-CN') : ''}
            </span>
            <button className="fp-btn fp-btn-primary" onClick={() => handleViewDetail(s.sessionId)}>详情</button>
          </div>
          {expandedId === s.sessionId && (
            <div className="fp-detail">
              {loadingDetail ? <div className="fp-empty">加载中...</div> : (
                entries.length === 0 ? <div className="fp-empty">无数据</div> : (
                  entries.map((e, i) => (
                    <div key={i} className="fp-detail-entry">
                      <span className="fp-detail-idx">{i + 1}.</span>
                      <span className="fp-detail-tool">{e.toolName}</span>
                      <span className="fp-detail-args">{JSON.stringify(e.args || {}).slice(0, 80)}</span>
                      <span className="fp-detail-result">{String(e.result || '').slice(0, 100)}</span>
                      <span className="fp-detail-time">[{e.durationMs || 0}ms]</span>
                    </div>
                  ))
                )
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ============================================================
// 定时任务面板
// ============================================================
function ScheduledTaskPanel() {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [newTask, setNewTask] = useState({ name: '', interval: 60, actionType: 'navigate', payload: '' })

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await window.api.scheduledTask.list()
      const data = res?.data || res || []
      setTasks(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleAdd = async () => {
    const { name, interval, actionType, payload } = newTask
    if (!payload.trim()) { alert('请填写 URL/脚本ID/消息内容'); return }
    let actionParams
    if (actionType === 'inject_script') actionParams = { scriptId: parseInt(payload) }
    else if (actionType === 'navigate') actionParams = { url: payload }
    else actionParams = { message: payload }
    try {
      await window.api.scheduledTask.create({
        name: name || '未命名任务',
        schedule: { type: 'interval', intervalMs: (parseInt(interval) || 60) * 60000 },
        action: { type: actionType, params: actionParams },
        enabled: true,
      })
      setNewTask({ name: '', interval: 60, actionType: 'navigate', payload: '' })
      load()
    } catch (e) { alert('创建失败: ' + e.message) }
  }

  const handleDelete = async (taskId) => {
    try {
      await window.api.scheduledTask.delete(taskId)
      load()
    } catch (e) { alert('删除失败: ' + e.message) }
  }

  const handleToggle = async (task) => {
    try {
      if (task.enabled) await window.api.scheduledTask.disable(task.id)
      else await window.api.scheduledTask.enable(task.id)
      load()
    } catch (e) { alert('操作失败: ' + e.message) }
  }

  const typeLabels = { navigate: '打开网页', inject_script: '执行脚本', agent_message: '发送消息' }

  return (
    <div>
      {/* 添加表单 */}
      <div className="fp-add-row">
        <input className="fp-input" placeholder="任务名称" value={newTask.name}
          onChange={e => setNewTask({ ...newTask, name: e.target.value })} style={{ minWidth: '100px' }} />
        <input className="fp-input" type="number" min="1" value={newTask.interval}
          onChange={e => setNewTask({ ...newTask, interval: e.target.value })} style={{ width: '70px' }} />
        <select className="fp-input" value={newTask.actionType}
          onChange={e => setNewTask({ ...newTask, actionType: e.target.value })} style={{ width: 'auto' }}>
          <option value="navigate">打开网页</option>
          <option value="inject_script">执行脚本</option>
          <option value="agent_message">发送消息</option>
        </select>
        <input className="fp-input" placeholder="URL / 脚本ID / 消息内容" value={newTask.payload}
          onChange={e => setNewTask({ ...newTask, payload: e.target.value })} style={{ minWidth: '120px' }} />
        <button className="fp-btn fp-btn-primary" onClick={handleAdd}>添加</button>
      </div>
      {/* 任务列表 */}
      {loading ? <div className="fp-empty">加载中...</div> :
       error ? <div className="fp-empty">加载失败: {error}</div> :
       tasks.length === 0 ? <div className="fp-empty">暂无定时任务</div> : (
        <div className="fp-list">
          {tasks.map(t => {
            const intervalMin = t.schedule?.intervalMs ? Math.round(t.schedule.intervalMs / 60000) : '?'
            const aType = t.action?.type || t.actionType || ''
            return (
              <div key={t.id} className="fp-list-row">
                <span className="fp-list-name" title={'参数: ' + JSON.stringify(t.action?.params || {})}>
                  {t.name || t.id} | 每{intervalMin}分钟 | {typeLabels[aType] || aType}
                </span>
                <div className="fp-list-actions">
                  <button className={`fp-btn ${t.enabled ? 'fp-btn-primary' : ''}`} onClick={() => handleToggle(t)}>
                    {t.enabled ? '已启用' : '已禁用'}
                  </button>
                  <button className="fp-btn fp-btn-danger" onClick={() => handleDelete(t.id)}>删除</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ============================================================
// 资源监控面板
// ============================================================
function ResourceMonitorPanel() {
  const [stats, setStats] = useState({ storage: 'N/A', agentCount: 'N/A', heapUsed: 'N/A', dbCounts: [] })
  const agentTimerRef = useRef(null)

  const refresh = useCallback(async () => {
    try {
      // 存储使用量（Electron 端无 navigator.storage.estimate，用 performance.memory 代替）
      const memInfo = process?.getProcessMemoryInfo?.() || {}
      if (memInfo.workingSetSize) {
        setStats(s => ({ ...s, storage: formatBytes(memInfo.workingSetSize * 1024) }))
      }
    } catch (e) {}

    try {
      // 活跃 Agent 数
      const res = await window.api.agent2.getRunning()
      const running = res?.data || res || []
      setStats(s => ({ ...s, agentCount: Array.isArray(running) ? running.length + ' 个' : 'N/A' }))
    } catch (e) {
      setStats(s => ({ ...s, agentCount: 'N/A' }))
    }

    try {
      // JS 堆内存
      if (performance?.memory) {
        setStats(s => ({ ...s, heapUsed: formatBytes(performance.memory.usedJSHeapSize) }))
      } else {
        setStats(s => ({ ...s, heapUsed: 'N/A' }))
      }
    } catch (e) {}

    try {
      // DB 记录统计
      const stores = ['task_templates', 'tool_recordings', 'agent_snapshots', 'scheduled_tasks']
      const counts = await Promise.all(stores.map(async (storeName) => {
        try {
          // 通过 taskTemplate.list / toolRecording.list / scheduledTask.list 间接获取数量
          if (storeName === 'task_templates') {
            const r = await window.api.taskTemplate.list()
            const d = r?.data || r || []
            return { storeName, count: Array.isArray(d) ? d.length : 0 }
          } else if (storeName === 'tool_recordings') {
            const r = await window.api.toolRecording.list()
            const d = r?.data || r || []
            return { storeName, count: Array.isArray(d) ? d.length : 0 }
          } else if (storeName === 'scheduled_tasks') {
            const r = await window.api.scheduledTask.list()
            const d = r?.data || r || []
            return { storeName, count: Array.isArray(d) ? d.length : 0 }
          } else {
            return { storeName, count: 0 }
          }
        } catch (e) {
          return { storeName, count: -1 }
        }
      }))
      setStats(s => ({ ...s, dbCounts: counts }))
    } catch (e) {}
  }, [])

  useEffect(() => {
    refresh()
    agentTimerRef.current = setInterval(refresh, 5000)
    return () => { if (agentTimerRef.current) clearInterval(agentTimerRef.current) }
  }, [refresh])

  return (
    <div>
      <div className="fp-stats-grid">
        <div className="fp-stat-card">
          <div className="fp-stat-label">存储使用量</div>
          <div className="fp-stat-value">{stats.storage}</div>
          <div className="fp-stat-sub">进程工作集内存</div>
        </div>
        <div className="fp-stat-card">
          <div className="fp-stat-label">活跃 Agent</div>
          <div className="fp-stat-value">{stats.agentCount}</div>
        </div>
        <div className="fp-stat-card">
          <div className="fp-stat-label">JS 堆内存</div>
          <div className="fp-stat-value">{stats.heapUsed}</div>
        </div>
      </div>
      {stats.dbCounts.length > 0 && (
        <>
          <div className="fp-stat-label" style={{ marginTop: '12px' }}>数据存储记录统计</div>
          <div className="fp-list">
            {stats.dbCounts.map(({ storeName, count }) => (
              <div key={storeName} className="fp-list-row">
                <span className="fp-list-name">{storeName}</span>
                <span className="fp-list-count">{count >= 0 ? count + ' 条' : 'N/A'}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ============================================================
// 调试日志面板
// ============================================================
function DebugLogPanel({ debugLogs }) {
  const logEndRef = useRef(null)

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [debugLogs])

  const handleCopy = () => {
    const text = debugLogs.map(e => `[${e.label}]\n${e.detail || ''}\n`).join('\n')
    navigator.clipboard.writeText(text).then(() => {
      // 简单提示
    }).catch(() => {})
  }

  return (
    <div className="fp-debug-log">
      <div className="fp-debug-header">
        <span className="fp-debug-title">🐛 Debug Log</span>
        <div className="fp-debug-actions">
          <button className="fp-debug-btn" onClick={handleCopy}>📋 复制</button>
        </div>
      </div>
      <div className="fp-debug-body">
        {debugLogs.length === 0 ? (
          <div className="fp-debug-empty">等待 Agent 任务启动…<br/>日志将自动显示在这里</div>
        ) : (
          debugLogs.map((entry, i) => (
            <div key={i} className={`fp-debug-entry ${entry.level || ''}`}>
              <div className="fp-debug-label">{entry.label}</div>
              {entry.detail && <div className="fp-debug-detail">{entry.detail}</div>}
            </div>
          ))
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  )
}

// ============================================================
// 辅助函数
// ============================================================
function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return 'N/A'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

// ============================================================
// 主组件：浮动面板
// ============================================================
const TABS = [
  { id: 'templates', label: '📋 任务模板' },
  { id: 'recording', label: '🎬 工具录制' },
  { id: 'scheduled', label: '⏰ 定时任务' },
  { id: 'monitor', label: '📈 资源监控' },
  { id: 'debuglog', label: '🐛 调试日志' },
]

export default function FeaturePanels({ onClose, debugLogs }) {
  const [activeTab, setActiveTab] = useState('templates')

  // 不使用 Portal 全屏 overlay——Electron 中 BrowserView 原生视图会拦截其区域内所有点击事件。
  // 改为 absolute 定位在父容器（settings-panel）内部，面板只在 sidebar 区域显示，不与 BrowserView 重叠。
  return (
    <div className="fp-overlay" onClick={onClose}>
      <div className="fp-panel" onClick={e => e.stopPropagation()}>
        {/* 头部 */}
        <div className="fp-header">
          <span className="fp-header-title">内置工具</span>
          <div className="fp-header-actions">
            <button className="fp-header-btn" onClick={onClose}>✕</button>
          </div>
        </div>
        {/* 标签栏 */}
        <div className="fp-tab-bar">
          {TABS.map(tab => (
            <button
              key={tab.id}
              className={`fp-tab-btn ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {/* 内容区 */}
        <div className="fp-tab-panels">
          {activeTab === 'templates' && <TaskTemplatePanel />}
          {activeTab === 'recording' && <ToolRecordingPanel />}
          {activeTab === 'scheduled' && <ScheduledTaskPanel />}
          {activeTab === 'monitor' && <ResourceMonitorPanel />}
          {activeTab === 'debuglog' && <DebugLogPanel debugLogs={debugLogs || []} />}
        </div>
      </div>
    </div>
  )
}

// ============================================================
// 独立窗口模式：全屏无边框，标题栏可拖拽移动窗口
// ============================================================
export function FeaturePanelsWindow() {
  const [activeTab, setActiveTab] = useState('templates')
  const [debugLogs, setDebugLogs] = useState([])

  const handleClose = () => {
    window.api?.toolWindow?.close()
  }

  // 订阅 agentDebug 事件，实时更新调试日志
  useEffect(() => {
    // 通过 agent2.onEvent 监听所有 agent 事件，筛选 agentDebug
    if (!window.api?.agent2?.onEvent) return
    const unsubscribe = window.api.agent2.onEvent((channel, data) => {
      if (channel === 'agentDebug') {
        setDebugLogs(prev => {
          const newLogs = [...prev, { label: data?.label || '', detail: data?.detail || '', level: '', timestamp: Date.now() }]
          // 最多保留 500 条
          return newLogs.length > 500 ? newLogs.slice(-500) : newLogs
        })
      }
    })
    return () => { if (typeof unsubscribe === 'function') unsubscribe() }
  }, [])

  return (
    <div className="fp-window-root">
      {/* 可拖拽标题栏（-webkit-app-region: drag 实现窗口拖动） */}
      <div className="fp-window-titlebar">
        <span className="fp-window-title">内置工具</span>
        <div className="fp-window-actions">
          <button className="fp-window-close" onClick={handleClose}>✕</button>
        </div>
      </div>
      {/* 标签栏 */}
      <div className="fp-tab-bar">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`fp-tab-btn ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {/* 内容区 */}
      <div className="fp-tab-panels">
        {activeTab === 'templates' && <TaskTemplatePanel />}
        {activeTab === 'recording' && <ToolRecordingPanel />}
        {activeTab === 'scheduled' && <ScheduledTaskPanel />}
        {activeTab === 'monitor' && <ResourceMonitorPanel />}
        {activeTab === 'debuglog' && <DebugLogPanel debugLogs={debugLogs} />}
      </div>
    </div>
  )
}
