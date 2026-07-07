// ============ 全景对话窗口（独立 BrowserWindow） ============
// 参考 Chrome 扩展 sidepanel/conversation-viewer.js 实现
//
// 主界面：轮次列表（紧凑卡片），显示轮次编号 / 工具调用数 / 结果数 / 存储数据数
// 点击轮次 → 弹出详情弹窗，分四个区块展示：
//   📤 发送给AI的内容（request.messages，含 role/content/tool_calls）
//   📥 AI响应（response，含 content 和 tool_calls）
//   ⚡ 工具执行结果（toolResults 数组）
//   💾 已存储数据（storedData 数组，卡片列表，点击查看 JSON 详情）
//
// 通过 window.api.agent2.onEvent(callback) 监听：
//   conversationRound    -> 新增一轮（payload 含 round/request/response/toolResults/storedData）
//   conversationClear    -> 清空所有轮次
//   conversationTaskDone -> 标记最后一轮完成
// callback 收到 (channel, data) 参数

import { useState, useEffect, useRef, useCallback } from 'react'

// ---------- 样式（自包含，使用项目 CSS 变量并带回退值） ----------
const CSS_TEXT = `
.cv-window-root{
  --cv-bg-primary:var(--bg-primary,#1a1a2e);
  --cv-bg-secondary:var(--bg-secondary,#252542);
  --cv-bg-tertiary:var(--bg-tertiary,#2a2a4a);
  --cv-border:var(--border,#3a3a5c);
  --cv-text-primary:var(--text-primary,#e0e0f0);
  --cv-text-secondary:var(--text-secondary,#9090b0);
  --cv-accent:var(--accent,#6841ea);
  display:flex;flex-direction:column;height:100vh;
  background:var(--cv-bg-primary);color:var(--cv-text-primary);
  overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
  font-size:13px;
}
.cv-window-titlebar{
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 14px;background:var(--cv-bg-secondary);
  border-bottom:1px solid var(--cv-border);
  -webkit-app-region:drag;flex-shrink:0;user-select:none;
}
.cv-window-title{font-size:13px;font-weight:700;color:var(--cv-text-primary);}
.cv-window-actions{display:flex;gap:6px;align-items:center;-webkit-app-region:no-drag;}
.cv-window-btn{
  background:transparent;border:1px solid var(--cv-border);
  color:var(--cv-text-secondary);font-size:11px;padding:4px 10px;
  border-radius:6px;cursor:pointer;transition:all .15s;white-space:nowrap;
}
.cv-window-btn:hover{background:var(--cv-bg-tertiary);color:var(--cv-text-primary);border-color:var(--cv-accent);}
.cv-window-close{
  background:none;border:none;cursor:pointer;color:var(--cv-text-secondary);
  width:26px;height:26px;border-radius:6px;
  display:flex;align-items:center;justify-content:center;
  font-size:13px;transition:all .15s;
}
.cv-window-close:hover{background:#ea3639;color:#fff;}
.cv-statusbar{padding:6px 14px;background:var(--cv-bg-tertiary);border-bottom:1px solid var(--cv-border);flex-shrink:0;}
.cv-status{font-size:11px;color:var(--cv-text-secondary);}
.cv-content{flex:1;overflow-y:auto;padding:10px 14px;}
.cv-empty{text-align:center;padding:60px 16px;color:var(--cv-text-secondary);font-size:12px;line-height:1.8;}
.cv-round-list{display:flex;flex-direction:column;gap:8px;}
.cv-round-item{
  background:var(--cv-bg-secondary);border-radius:8px;
  border:1px solid rgba(104,65,234,.15);padding:10px 14px;
  cursor:pointer;transition:background .15s,border-color .15s;
  display:flex;justify-content:space-between;align-items:center;
}
.cv-round-item:hover{background:rgba(104,65,234,.12);border-color:rgba(104,65,234,.35);}
.cv-round-item.done{border-left:3px solid #00aa5b;}
.cv-round-item.finish{border-left:3px solid #f0a040;background:rgba(240,160,64,.06);}
.cv-round-title{font-size:13px;font-weight:600;color:var(--cv-accent);}
.cv-round-title.done-text{color:#00aa5b;}
.cv-round-title.finish-text{color:#f0a040;}
.cv-round-meta{font-size:12px;color:var(--cv-text-secondary);white-space:nowrap;margin-left:12px;}
.cv-modal-overlay{
  position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:1000;
  display:flex;justify-content:center;align-items:center;
}
.cv-data-overlay{z-index:1100;}
.cv-modal-content{
  background:var(--cv-bg-secondary);border:1px solid var(--cv-border);
  border-radius:12px;width:92%;max-width:1000px;height:86vh;
  overflow:hidden;display:flex;flex-direction:column;
  box-shadow:0 12px 40px rgba(0,0,0,.5);
}
.cv-data-modal{max-width:900px;height:82vh;}
.cv-modal-header{
  display:flex;justify-content:space-between;align-items:center;
  padding:14px 18px;background:rgba(104,65,234,.1);
  border-bottom:1px solid rgba(104,65,234,.2);flex-shrink:0;
}
.cv-modal-title{font-size:14px;font-weight:600;color:var(--cv-accent);}
.cv-modal-actions{display:flex;gap:8px;align-items:center;}
.cv-modal-close{
  background:none;border:none;cursor:pointer;color:var(--cv-text-secondary);
  font-size:16px;padding:4px 8px;border-radius:6px;transition:all .15s;
}
.cv-modal-close:hover{color:#ea3639;background:rgba(234,54,57,.12);}
.cv-modal-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:16px;}
.cv-detail-section{background:var(--cv-bg-primary);border-radius:8px;padding:12px;border:1px solid rgba(64,160,240,.15);}
.cv-detail-section-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.cv-detail-section-title{font-size:13px;font-weight:600;color:#40a0f0;}
.cv-detail-copy{
  font-size:11px;padding:4px 10px;border:1px solid rgba(104,65,234,.3);
  border-radius:4px;background:rgba(104,65,234,.1);color:var(--cv-accent);
  cursor:pointer;transition:background .15s;white-space:nowrap;
}
.cv-detail-copy:hover{background:rgba(104,65,234,.25);}
.cv-json-tree{font-family:'Consolas','Monaco','Courier New',monospace;font-size:12px;line-height:1.6;overflow-x:auto;}
.cv-json-inline{cursor:pointer;display:inline;}
.cv-json-inline:hover{background:rgba(156,220,254,.1);}
.cv-json-toggle{display:inline-block;width:12px;color:var(--cv-text-secondary);font-size:9px;text-align:center;}
.cv-json-toggle.expanded::before{content:'▼';}
.cv-json-toggle.collapsed::before{content:'▶';}
.cv-json-bracket{color:#ffd700;}
.cv-json-bracket-close{color:#ffd700;}
.cv-json-count{color:var(--cv-text-secondary);font-size:11px;margin:0 4px;}
.cv-json-children{margin-left:16px;}
.cv-json-entry{display:block;}
.cv-json-key{color:#9cdcfe;}
.cv-json-colon{color:var(--cv-text-secondary);margin:0 2px;}
.cv-json-value{color:#ce9178;word-break:break-all;}
.cv-json-value.string{color:#ce9178;}
.cv-json-value.number{color:#b5cea8;}
.cv-json-value.boolean{color:#569cd6;}
.cv-json-value.null{color:#569cd6;font-style:italic;}
.cv-json-longstr{cursor:pointer;}
.cv-json-longstr:hover{text-decoration:underline;}
.cv-data-item{
  background:rgba(104,65,234,.08);border-radius:6px;padding:8px 12px;
  border:1px solid rgba(104,65,234,.2);cursor:pointer;margin:6px 0;
  transition:background .15s;
}
.cv-data-item:hover{background:rgba(104,65,234,.18);}
.cv-data-item-id{font-size:12px;font-weight:600;color:var(--cv-accent);font-family:'Consolas',monospace;word-break:break-all;}
.cv-data-item-meta{font-size:11px;color:var(--cv-text-secondary);margin-top:2px;word-break:break-all;}
.cv-toast{
  position:fixed;top:14px;right:14px;background:#40a0f0;color:#fff;
  padding:8px 16px;border-radius:6px;font-size:12px;z-index:9999;
  box-shadow:0 2px 8px rgba(0,0,0,.4);
}
`

// ---------- 类型判断 ----------
function getType(v) {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'object') return 'object'
  return typeof v
}

// ---------- JSON 树形展示 ----------
// 递归构建可折叠的 JSON 树；长字符串（>100 字符）自动折叠为预览，点击展开
function JsonValue({ value }) {
  const type = getType(value)
  if (type === 'object' || type === 'array') {
    return <JsonObjectNode value={value} />
  }
  return <JsonPrimitive value={value} type={type} />
}

function JsonObjectNode({ value }) {
  const [collapsed, setCollapsed] = useState(false)
  const isArray = Array.isArray(value)
  const entries = isArray
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value).map(([k, v]) => [String(k), v])
  const open = isArray ? '[' : '{'
  const close = isArray ? ']' : '}'
  return (
    <>
      <span
        className="cv-json-inline"
        onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c) }}
        title={collapsed ? '展开' : '折叠'}
      >
        <span className={`cv-json-toggle ${collapsed ? 'collapsed' : 'expanded'}`} />
        <span className="cv-json-bracket">{open}</span>
        <span className="cv-json-count">{entries.length} {isArray ? '项' : '个属性'}</span>
        {collapsed && <span className="cv-json-bracket">{close}</span>}
      </span>
      {!collapsed && (
        <>
          <div className="cv-json-children">
            {entries.map(([k, v]) => (
              <div className="cv-json-entry" key={k}>
                <span className="cv-json-key">{k}</span>
                <span className="cv-json-colon">:</span>
                <JsonValue value={v} />
              </div>
            ))}
          </div>
          <div className="cv-json-bracket-close">{close}</div>
        </>
      )}
    </>
  )
}

function JsonPrimitive({ value, type }) {
  if (type === 'string' && value.length > 100) {
    return <JsonLongString value={value} />
  }
  let text
  if (type === 'string') text = `"${value}"`
  else if (type === 'null') text = 'null'
  else text = String(value)
  return <span className={`cv-json-value ${type}`}>{text}</span>
}

function JsonLongString({ value }) {
  const [expanded, setExpanded] = useState(false)
  const text = expanded ? `"${value}"` : `"${value.slice(0, 80)}..."`
  return (
    <span
      className="cv-json-value string cv-json-longstr"
      onClick={(e) => { e.stopPropagation(); setExpanded((x) => !x) }}
      title={expanded ? '点击折叠' : '点击展开完整内容'}
    >
      {text}
    </span>
  )
}

// ---------- 详情区块 ----------
function DetailSection({ title, data, onCopy }) {
  return (
    <div className="cv-detail-section">
      <div className="cv-detail-section-header">
        <span className="cv-detail-section-title">{title}</span>
        <button className="cv-detail-copy" onClick={() => onCopy(data)}>📋 复制</button>
      </div>
      <div className="cv-json-tree">
        <JsonValue value={data} />
      </div>
    </div>
  )
}

function StoredDataSection({ storedData, onCopy, onShowData }) {
  return (
    <div className="cv-detail-section">
      <div className="cv-detail-section-header">
        <span className="cv-detail-section-title">💾 已存储数据 ({storedData.length}条)</span>
        <button className="cv-detail-copy" onClick={() => onCopy(storedData)}>📋 复制全部</button>
      </div>
      {storedData.map((sd, i) => (
        <div className="cv-data-item" key={sd.id ?? i} onClick={() => onShowData(sd)}>
          <div className="cv-data-item-id">{sd.id}</div>
          <div className="cv-data-item-meta">{sd.toolName}{sd.preview ? ' | ' + sd.preview : ''}</div>
        </div>
      ))}
    </div>
  )
}

// ---------- 详情弹窗 ----------
function DetailModal({ round, onClose, onCopy, onShowData }) {
  const { round: num, request, response, toolResults, storedData } = round
  return (
    <div className="cv-modal-overlay" onClick={onClose}>
      <div className="cv-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="cv-modal-header">
          <span className="cv-modal-title">第 {num} 轮详情</span>
          <button className="cv-modal-close" onClick={onClose} title="关闭">✕</button>
        </div>
        <div className="cv-modal-body">
          {request && <DetailSection title="📤 发送给AI的内容" data={request} onCopy={onCopy} />}
          {response && <DetailSection title="📥 AI响应" data={response} onCopy={onCopy} />}
          {toolResults && toolResults.length > 0 && (
            <DetailSection title="⚡ 工具执行结果" data={toolResults} onCopy={onCopy} />
          )}
          {storedData && storedData.length > 0 && (
            <StoredDataSection storedData={storedData} onCopy={onCopy} onShowData={onShowData} />
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- 数据详情弹窗（存储数据卡片点击后） ----------
function DataModal({ data, onClose, onCopy }) {
  const id = data?.id
  const toolName = data?.toolName
  const inner =
    data && Object.prototype.hasOwnProperty.call(data, 'data') ? data.data : data
  return (
    <div className="cv-modal-overlay cv-data-overlay" onClick={onClose}>
      <div className="cv-modal-content cv-data-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cv-modal-header">
          <span className="cv-modal-title">{id} - {toolName}</span>
          <div className="cv-modal-actions">
            <button className="cv-detail-copy" onClick={() => onCopy(inner)}>📋 复制</button>
            <button className="cv-modal-close" onClick={onClose} title="关闭">✕</button>
          </div>
        </div>
        <div className="cv-modal-body">
          <div className="cv-json-tree">
            <JsonValue value={inner} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- 轮次列表项（紧凑卡片） ----------
function RoundItem({ round, onClick }) {
  const { round: num, response, toolResults, storedData, isFinishRound, done } = round
  const tc = response?.tool_calls?.length || 0
  const tr = toolResults?.length || 0
  const sd = storedData?.length || 0
  const cls = ['cv-round-item']
  if (done) cls.push('done')
  if (isFinishRound) cls.push('finish')
  const tcls = ['cv-round-title']
  if (done) tcls.push('done-text')
  if (isFinishRound) tcls.push('finish-text')
  let label = `第 ${num} 轮`
  if (isFinishRound) label += ' (完成)'
  if (done) label += ' ✓'
  return (
    <div className={cls.join(' ')} onClick={onClick}>
      <span className={tcls.join(' ')}>{label}</span>
      <span className="cv-round-meta">工具:{tc} 结果:{tr} 存储:{sd}</span>
    </div>
  )
}

// ---------- 主组件 ----------
export default function ConversationViewerWindow() {
  const [rounds, setRounds] = useState([])
  const [selectedRound, setSelectedRound] = useState(null)
  const [selectedData, setSelectedData] = useState(null)
  const [toast, setToast] = useState('')
  const scrollRef = useRef(null)
  const toastTimer = useRef(null)

  const showToast = useCallback((msg) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2000)
  }, [])

  const copyToClipboard = useCallback((data) => {
    const text = JSON.stringify(data, null, 2)
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(() => showToast('已复制'))
          .catch(() => showToast('复制失败'))
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        showToast('已复制')
      }
    } catch {
      showToast('复制失败')
    }
  }, [showToast])

  // 事件监听：conversationRound / conversationClear / conversationTaskDone
  useEffect(() => {
    if (!window.api?.agent2?.onEvent) return
    const handleEvent = (channel, data) => {
      switch (channel) {
        case 'conversationRound':
          setRounds((prev) => [...prev, data])
          break
        case 'conversationClear':
          setRounds([])
          break
        case 'conversationTaskDone':
          // 标记最后一轮完成
          setRounds((prev) => {
            if (prev.length === 0) return prev
            const last = prev[prev.length - 1]
            return [...prev.slice(0, -1), { ...last, done: true }]
          })
          break
        default:
          break
      }
    }
    const unsubscribe = window.api.agent2.onEvent(handleEvent)
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  // 自动滚动到最新轮次
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [rounds])

  // Esc 关闭弹窗（优先关闭数据弹窗，再关闭详情弹窗）
  useEffect(() => {
    if (!selectedRound && !selectedData) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (selectedData) setSelectedData(null)
        else if (selectedRound) setSelectedRound(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedRound, selectedData])

  // 卸载时清理 toast 定时器
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
  }, [])

  const handleClose = () => window.api?.conversationWindow?.close()
  const handleClear = () => {
    setRounds([])
    showToast('已清空')
  }
  const handleCopyAll = () => copyToClipboard(rounds)

  const status = rounds.length === 0
    ? '等待 Agent 任务启动…'
    : (rounds[rounds.length - 1]?.done
        ? `任务完成 · 共 ${rounds.length} 轮`
        : `进行中 · 第 ${rounds.length} 轮`)

  return (
    <div className="cv-window-root">
      <style>{CSS_TEXT}</style>

      {/* 可拖拽标题栏 */}
      <div className="cv-window-titlebar">
        <span className="cv-window-title">🔭 对话全景</span>
        <div className="cv-window-actions">
          <button className="cv-window-btn" onClick={handleCopyAll} title="复制全部轮次数据">📋 复制全部</button>
          <button className="cv-window-btn" onClick={handleClear} title="清空轮次列表">🗑 清空</button>
          <button className="cv-window-close" onClick={handleClose} title="关闭窗口">✕</button>
        </div>
      </div>

      {/* 状态栏 */}
      <div className="cv-statusbar">
        <span className="cv-status">{status}</span>
      </div>

      {/* 内容区：轮次列表 */}
      <div className="cv-content">
        {rounds.length === 0 ? (
          <div className="cv-empty">等待 Agent 任务启动…<br />点击轮次查看详情</div>
        ) : (
          <div className="cv-round-list">
            {rounds.map((r, idx) => (
              <RoundItem
                key={`${r.round}-${idx}`}
                round={r}
                onClick={() => setSelectedRound(r)}
              />
            ))}
            <div ref={scrollRef} />
          </div>
        )}
      </div>

      {/* 详情弹窗 */}
      {selectedRound && (
        <DetailModal
          round={selectedRound}
          onClose={() => setSelectedRound(null)}
          onCopy={copyToClipboard}
          onShowData={(sd) => setSelectedData(sd)}
        />
      )}

      {/* 数据详情弹窗 */}
      {selectedData && (
        <DataModal
          data={selectedData}
          onClose={() => setSelectedData(null)}
          onCopy={copyToClipboard}
        />
      )}

      {/* Toast 提示 */}
      {toast && <div className="cv-toast">{toast}</div>}
    </div>
  )
}
