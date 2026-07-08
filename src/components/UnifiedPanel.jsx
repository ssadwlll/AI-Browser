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
  click_element: '点击元素',
  wait_for_element: '等待元素',
  wait_for_navigation: '等待导航',
  open_new_tab: '打开新标签',
  close_current_tab: '关闭标签',
  extract_images: '提取图片',
  extract_links: '提取链接',
  scroll_to_element: '滚动到元素',
  hover_element: '悬停元素',
  scroll_page: '滚动页面',
  select_option: '选择下拉选项',
  upload_file: '上传文件',
  get_element_text: '获取元素文本',
  get_element_attribute: '获取元素属性',
  drag_and_drop: '拖拽',
}

// ============ Agent v2 工具名中文映射（迁移自 chrome-extension 的 TOOL_META） ============
const AGENT_TOOL_LABELS = {
  search_tools: '搜索工具',
  read_page_content: '读取页面',
  click_element: '点击元素',
  fill_input: '填写输入',
  wait_for_element: '等待元素',
  get_interactive_elements: '获取可交互元素',
  detect_page_template: '检测页面模板',
  find_text_on_page: '查找文本',
  get_element_info: '获取元素信息',
  extract_content: '提取内容',
  scroll_page: '滚动页面',
  hover_element: '悬停元素',
  select_dropdown: '选择下拉',
  press_key: '按键',
  screenshot_visible: '截图',
  navigate_to: '导航',
  go_back: '后退',
  go_forward: '前进',
  inject_script: '注入脚本',
  generate_script: '生成脚本',
  fetch_url: '请求URL',
  create_todo: '创建待办',
  render_report: '渲染报告',
  finish_task: '完成任务',
}

// Agent v2 工具图标映射
const AGENT_TOOL_ICONS = {
  search_tools: '🔍',
  read_page_content: '⚡',
  click_element: '⚡',
  fill_input: '⚡',
  wait_for_element: '⚡',
  finish_task: '✅',
  navigate_to: '🧭',
  screenshot_visible: '📸',
  extract_content: '📄',
  generate_script: '🚀',
  inject_script: '🚀',
}

// ============ Agent v2 工具参数格式化（迁移自 chrome-extension formatToolArgs） ============
function formatAgentToolArgs(toolName, toolArgs) {
  const a = toolArgs || {}
  switch (toolName) {
    case 'search_tools':
      return `搜索关键词：${a.query || ''}`
    case 'read_page_content':
      return '读取当前页面的标题和正文'
    case 'extract_content':
      return `提取元素：${a.selector || ''}${a.multiple ? '（提取所有）' : ''}${Array.isArray(a.attributes) && a.attributes.length ? ' [属性:' + a.attributes.join(',') + ']' : ''}`
    case 'click_element':
      return `点击元素：${a.selector || ''}`
    case 'fill_input':
      return `填写内容：${a.selector || ''} = "${a.value || ''}"${a.submit ? '（回车提交）' : ''}`
    case 'wait_for_element':
      return `等待元素出现：${a.selector || ''}`
    case 'navigate_to':
      return `导航到：${a.url || ''}`
    case 'go_back':
      return '返回上一页'
    case 'go_forward':
      return '前进到下一页'
    case 'scroll_page':
      return a.direction ? `滚动方向：${a.direction}` : '滚动页面'
    case 'hover_element':
      return `悬停元素：${a.selector || ''}`
    case 'select_dropdown':
      return `选择下拉：${a.selector || ''} = "${a.value || ''}"`
    case 'press_key':
      return `按键：${a.key || ''}`
    case 'screenshot_visible':
      return '截取当前页面可见区域'
    case 'find_text_on_page':
      return `查找文本：${a.text || ''}`
    case 'finish_task':
      return a.summary || '任务完成'
    case 'create_todo':
      return '创建待办执行计划'
    case 'render_report':
      return a.template ? `渲染报告（模板：${a.template}）` : '渲染数据报告'
    case 'generate_script':
      return a.description ? `生成脚本：${a.description}` : '生成并执行自定义脚本'
    default:
      // inject_script_xxx 等动态工具
      if (toolName && toolName.startsWith('inject_script')) {
        return `执行脚本：${a.scriptName || '工具库脚本'}`
      }
      // 其他工具：用简洁的键值对展示
      const entries = Object.entries(a).filter(([, v]) => v !== undefined && v !== '')
      return entries.length > 0 ? entries.map(([k, v]) => `${k}: ${v}`).join('，') : ''
  }
}

// 判断工具结果是否失败（前端兜底解析，配合后端 success 字段）
function isAgentToolResultFailed(rawResult) {
  if (!rawResult) return false
  try {
    const parsed = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult
    if (parsed?.ok === false || parsed?.error || parsed?.skipped) return true
    return false
  } catch { return false }
}

// 将工具执行结果转为可读摘要（迁移自 chrome-extension summarizeToolResult）
function summarizeAgentToolResult(toolName, rawResult) {
  let parsed = null
  try { parsed = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult } catch {}

  switch (toolName) {
    case 'read_page_content':
      if (parsed?.title) return `已读取页面「${parsed.title}」，正文 ${(parsed.content || '').length} 字`
      return '已读取当前页面内容'
    case 'extract_content': {
      if (!parsed) return '已提取页面数据'
      const items = parsed.result || parsed
      if (Array.isArray(items)) return `已提取 ${items.length} 条数据`
      if (typeof items === 'string') return items.length > 100 ? items.slice(0, 100) + '...' : items
      return '已提取页面数据'
    }
    case 'get_interactive_elements':
      if (Array.isArray(parsed)) return `已发现 ${parsed.length} 个可交互元素`
      return '已获取页面可交互元素'
    case 'click_element':
      return '已点击目标元素'
    case 'fill_input':
      return '已填写输入框内容'
    case 'navigate_to':
      if (parsed?.url) return `已导航到 ${parsed.url}`
      return '已完成页面导航'
    case 'go_back':
      return '已返回上一页'
    case 'go_forward':
      return '已前进到下一页'
    case 'scroll_page':
      return '已滚动页面'
    case 'hover_element':
      return '已悬停目标元素'
    case 'select_dropdown':
      return '已选择下拉选项'
    case 'press_key':
      return '已执行按键操作'
    case 'find_text_on_page':
      if (parsed?.count !== undefined) return `已找到 ${parsed.count} 处匹配文本`
      return '文本搜索完成'
    case 'wait_for_element':
      return '目标元素已出现'
    case 'create_todo':
      if (parsed?.ok && parsed.totalTodos) return `已创建待办计划（${parsed.totalTodos} 个步骤）`
      return '待办计划已创建'
    case 'screenshot_visible':
      return '已截取当前页面截图'
    case 'generate_script': {
      if (parsed?.ok === false) return '代码执行未返回有效结果'
      if (parsed?.storeId && parsed.count !== undefined) return `已处理 ${parsed.count} 条数据并存储（ID: ${parsed.storeId}）`
      if (parsed?.message) return parsed.message
      if (typeof rawResult === 'string' && !rawResult.startsWith('{')) {
        return rawResult.length > 200 ? rawResult.slice(0, 200) + '...' : rawResult
      }
      return '自定义脚本已执行完成'
    }
    case 'render_report': {
      if (parsed?.ok && parsed.storeId) {
        return `已准备报告（模板: ${parsed.template || '未知'}，数据: ${parsed.count || 0} 条）`
      }
      if (parsed?.message) return parsed.message
      return '报告数据已准备完成'
    }
    case 'finish_task':
      return (typeof parsed === 'string' ? parsed : parsed?.summary) || '任务已完成'
    default:
      if (toolName && toolName.startsWith('inject_script')) {
        if (parsed) {
          if (Array.isArray(parsed)) return `脚本执行完成，返回 ${parsed.length} 条结果`
          if (parsed.result) {
            if (Array.isArray(parsed.result)) return `脚本执行完成，处理了 ${parsed.result.length} 条数据`
            if (typeof parsed.result === 'string') return parsed.result.length > 100 ? parsed.result.slice(0, 100) + '...' : parsed.result
          }
          if (parsed.count !== undefined) return `脚本执行完成，处理了 ${parsed.count} 条数据`
        }
        return '脚本执行完成'
      }
      // 兜底：提取关键信息，避免显示原始JSON
      if (parsed && typeof parsed === 'object') {
        if (parsed.count !== undefined) return `执行完成，处理了 ${parsed.count} 条数据`
        if (parsed.result) {
          if (Array.isArray(parsed.result)) return `执行完成，返回 ${parsed.result.length} 条结果`
          if (typeof parsed.result === 'string') return parsed.result.length > 100 ? parsed.result.slice(0, 100) + '...' : parsed.result
        }
        if (parsed.message) return parsed.message
      }
      if (typeof rawResult === 'string' && rawResult.length > 120) return rawResult.slice(0, 120) + '...'
      return '执行完成'
  }
}

const SESSIONS_KEY = 'ai-browser-sessions'
const SAVED_SCRIPTS_KEY = 'ai-browser-scripts'

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

// 已保存的脚本管理
function loadSavedScripts() {
  try {
    const data = localStorage.getItem(SAVED_SCRIPTS_KEY)
    return data ? JSON.parse(data) : []
  } catch { return [] }
}

function saveSavedScripts(scripts) {
  localStorage.setItem(SAVED_SCRIPTS_KEY, JSON.stringify(scripts))
}

// ============ Agent v2 数据报告渲染组件（迁移自 chrome-extension renderDataReport） ============
// 单个数据区块：可折叠，支持 array(表格) / object(字段卡片) / html(sandbox iframe) / template(表格) 四种渲染
function DataReportSection({ item, defaultExpanded }) {
  const { id, toolName, schema, data, renderType } = item
  const count = Array.isArray(data) ? data.length : (data && typeof data === 'object' ? Object.keys(data).length : 1)
  const [expanded, setExpanded] = useState(!!defaultExpanded)
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    try {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
    } catch { /* 忽略剪贴板异常 */ }
  }

  return (
    <div className="data-report-section">
      <div className="data-section-header" onClick={() => setExpanded(e => !e)}>
        <span className="data-section-toggle">{expanded ? '▼' : '▶'}</span>
        <span className="data-section-id">{id}</span>
        <span className="data-section-meta">{AGENT_TOOL_LABELS[toolName] || toolName || '数据'} · {count} 条</span>
      </div>
      {expanded && (
        <div className="data-section-body">
          {/* 截断提示 */}
          {data && data._truncated && (
            <div className="data-truncated-warn">⚠ 数据量过大，已截断显示前部分</div>
          )}
          <DataReportContent item={item} />
          {/* 操作按钮：复制 JSON */}
          <div className="data-section-actions">
            <button className="data-copy-btn" onClick={handleCopy}>
              {copied ? '已复制' : '复制 JSON'}
            </button>
          </div>
        </div>
      )}

      {/* 历史会话管理已迁移为独立窗口（window.api.historyWindow.open()） */}
      {/* 脚本中心已迁移为独立窗口（window.api.scriptCenterWindow.open()） */}
    </div>
  )
}

// 数据区块内容渲染：根据 renderType / 数据类型选择渲染方式
function DataReportContent({ item }) {
  const { data, renderType, schema } = item

  // renderType='html': AI 生成的 HTML 报告，用 sandboxed iframe 渲染（仅 allow-same-origin，无 allow-scripts）
  if (renderType === 'html' && typeof data === 'string') {
    return <HtmlReportIframe htmlContent={data} />
  }

  // renderType='template': 简化处理为表格（提取 data 数组）
  if (renderType === 'template') {
    const arr = Array.isArray(data) ? data : (data?.result && Array.isArray(data.result) ? data.result : [])
    if (arr.length > 0) return <DataTable arr={arr} schema={schema} />
    return <div className="data-empty">(模板报告无表格数据)</div>
  }

  // 数组 → 表格
  if (Array.isArray(data)) {
    return <DataTable arr={data} schema={schema} />
  }

  // 对象 → 字段卡片网格
  if (data && typeof data === 'object') {
    return <DataFieldGrid obj={data} />
  }

  // 基本类型
  return <div className="data-primitive">{String(data)}</div>
}

// 数组渲染为表格（sticky thead，最多 200 行）
function DataTable({ arr, schema }) {
  if (arr.length === 0) return <div className="data-empty">(空数组)</div>

  // 基本类型数组 → 列表
  const isArrayOfPrimitives = arr.every(x => typeof x !== 'object' || x === null)
  if (isArrayOfPrimitives) {
    return (
      <div className="data-list">
        {arr.map((v, i) => (
          <div className="data-list-item" key={i}>
            <span className="data-list-idx">{i}</span>
            <span className="data-list-val">{String(v)}</span>
          </div>
        ))}
      </div>
    )
  }

  const keys = schema ? Object.keys(schema) : Object.keys(arr[0] || {})
  if (keys.length === 0) return <div className="data-empty">(无字段)</div>

  const MAX_ROWS = 200
  const displayRows = arr.length > MAX_ROWS ? arr.slice(0, MAX_ROWS) : arr

  const renderCell = (v) => {
    if (v === null || v === undefined) return <span className="data-null">null</span>
    if (typeof v === 'object') {
      const preview = JSON.stringify(v).slice(0, 50)
      return <span className="data-obj-preview" title={JSON.stringify(v).slice(0, 200)}>{preview}</span>
    }
    if (typeof v === 'string' && v.length > 80) {
      return <span title={v}>{v.slice(0, 80)}...</span>
    }
    return String(v)
  }

  return (
    <>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th>
              {keys.map(k => (
                <th key={k} title={schema?.[k] || ''}>
                  {k}
                  <span className="data-col-type">{schema?.[k] || ''}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, i) => (
              <tr key={i}>
                <td className="data-row-idx">{i}</td>
                {keys.map(k => <td key={k}>{renderCell(row?.[k])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {arr.length > MAX_ROWS && (
        <div className="data-more-rows">仅显示前 {MAX_ROWS} 行，共 {arr.length} 行</div>
      )}
    </>
  )
}

// 对象渲染为字段卡片网格
function DataFieldGrid({ obj }) {
  const keys = Object.keys(obj)
  if (keys.length === 0) return <div className="data-empty">(空对象)</div>

  const renderVal = (v) => {
    if (v === null || v === undefined) return <span className="data-null">null</span>
    if (Array.isArray(v)) {
      return <><span className="data-type-badge">Array({v.length})</span><span className="data-obj-preview">{JSON.stringify(v).slice(0, 80)}</span></>
    }
    if (typeof v === 'object') {
      return <><span className="data-type-badge">Object</span><span className="data-obj-preview">{JSON.stringify(v).slice(0, 80)}</span></>
    }
    if (typeof v === 'string' && v.length > 100) {
      return <span title={v}>{v.slice(0, 100)}...</span>
    }
    return String(v)
  }

  return (
    <div className="data-fields-grid">
      {keys.map(k => (
        <div className="data-field" key={k}>
          <div className="data-field-key">{k}</div>
          <div className="data-field-val">{renderVal(obj[k])}</div>
        </div>
      ))}
    </div>
  )
}

// HTML 报告 iframe（sandbox="allow-same-origin"，无 allow-scripts，高度自适应）
function HtmlReportIframe({ htmlContent }) {
  const iframeRef = useRef(null)

  // 包裹完整 HTML 文档：仅注入基础样式重置（不注入脚本，因为 allow-scripts 被禁用）
  const wrappedHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 12px; color: #262626; line-height: 1.6; background:#fff; }
  img { max-width: 100%; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th, td { border: 1px solid #e5e5e5; padding: 8px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  a { color: #6841ea; }
  h1, h2, h3 { margin: 12px 0 8px; }
  h1 { font-size: 20px; } h2 { font-size: 16px; } h3 { font-size: 14px; }
  p { margin: 6px 0; }
  ul, ol { margin: 6px 0; padding-left: 20px; }
  .card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px; margin: 8px 0; }
  .card-title { font-weight: 600; font-size: 15px; margin-bottom: 6px; }
  .card-meta { font-size: 12px; color: #8c8c8c; margin-bottom: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
</style>
</head>
<body>
${htmlContent}
</body>
</html>`

  // iframe load 后调整高度 + 持续观察内部 DOM 变化（如图片加载完成）
  const adjustHeight = useCallback(() => {
    try {
      const doc = iframeRef.current?.contentDocument
      if (doc && doc.body) {
        const newHeight = doc.body.scrollHeight
        const currentHeight = parseInt(iframeRef.current.style.height) || 0
        if (newHeight > currentHeight) {
          iframeRef.current.style.height = `${newHeight + 20}px`
        }
      }
    } catch { /* 跨域访问失败时忽略 */ }
  }, [])

  const handleLoad = useCallback(() => {
    adjustHeight()
    // 兜底：多次调整，防止字体/图片延迟加载导致高度变化
    setTimeout(adjustHeight, 100)
    setTimeout(adjustHeight, 500)
    setTimeout(adjustHeight, 1500)
    try {
      const doc = iframeRef.current?.contentDocument
      if (doc && doc.body) {
        const mo = new MutationObserver(adjustHeight)
        mo.observe(doc.body, { childList: true, subtree: true, attributes: true })
      }
    } catch { /* ignore */ }
  }, [adjustHeight])

  return (
    <div className="data-html-report-wrap">
      <iframe
        ref={iframeRef}
        className="data-html-report-iframe"
        sandbox="allow-same-origin"
        srcDoc={wrappedHtml}
        onLoad={handleLoad}
        title="html-report"
      />
    </div>
  )
}

// 数据报告容器组件
function AgentDataReport({ items }) {
  return (
    <div className="agent-data-report">
      <div className="data-report-header">
        <span className="data-report-icon">📊</span>
        <span className="data-report-title">采集数据报告</span>
        <span className="data-report-count">{items.length} 份数据</span>
      </div>
      {items.map((item, idx) => (
        <DataReportSection key={item.id || idx} item={item} defaultExpanded={idx === 0} />
      ))}
    </div>
  )
}

// ============ Agent v2 工具步骤卡片组件 ============
// 结构：齿轮图标 ⚙ + 步骤标题 + 可展开的参数/结果
// 状态图标：running ⏳ / done ✅ / error ❌
function AgentStepCard({ msg }) {
  const { step, toolName, toolArgs, status, resultDisplay } = msg
  const [expanded, setExpanded] = useState(false)

  // 工具中文名与图标
  const isInject = toolName && toolName.startsWith('inject_script')
  const displayName = isInject
    ? (toolArgs?.scriptName || '执行脚本')
    : (AGENT_TOOL_LABELS[toolName] || toolName || '执行工具')
  const toolIcon = isInject ? '🚀' : (AGENT_TOOL_ICONS[toolName] || '⚙')

  // 状态图标与卡片状态类
  let statusIcon = '⚙'
  let statusClass = ''
  if (status === 'running') { statusIcon = '⏳'; statusClass = 'running' }
  else if (status === 'done') { statusIcon = '✅'; statusClass = 'done' }
  else if (status === 'error') { statusIcon = '❌'; statusClass = 'error' }

  // 步骤标题：有 step 编号时显示"步骤 N: 工具名"，否则显示工具名/状态文本
  const title = (step !== undefined && step !== null)
    ? `步骤 ${step}: ${displayName}`
    : (displayName || 'Agent 工作中...')

  // 参数摘要
  const argsText = toolName ? formatAgentToolArgs(toolName, toolArgs) : ''
  const hasDetail = !!(argsText || resultDisplay)

  return (
    <div key={msg.id} className={`agent-step-card ${statusClass}`}>
      <div
        className="agent-step-header"
        onClick={() => hasDetail && setExpanded(e => !e)}
        style={{ cursor: hasDetail ? 'pointer' : 'default' }}
      >
        <span className="agent-step-icon">{toolIcon}</span>
        <span className="agent-step-title">
          <span className="agent-step-status">{statusIcon}</span> {title}
        </span>
        {hasDetail && (
          <span className="agent-step-toggle">{expanded ? '▾' : '▸'}</span>
        )}
      </div>
      {hasDetail && expanded && (
        <div className="agent-step-body">
          {argsText && (
            <div className="agent-step-args">{argsText}</div>
          )}
          {resultDisplay && (
            <div className="agent-step-result">{resultDisplay}</div>
          )}
        </div>
      )}
    </div>
  )
}

export default function UnifiedPanel({ config }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessions, setSessions] = useState(() => loadSessions())
  const [activeSessionId, setActiveSessionId] = useState(null)
  const [showSessionList, setShowSessionList] = useState(false)
  const [savedScripts, setSavedScripts] = useState(() => loadSavedScripts())
  const [showSavedScripts, setShowSavedScripts] = useState(false)
  const [autoInjectScripts, setAutoInjectScripts] = useState([])
  const [showAutoInject, setShowAutoInject] = useState(false)
  const [modal, setModal] = useState(null) // {title, message, defaultValue, placeholder, resolve}
  const messagesEndRef = useRef(null)
  const nextIdRef = useRef(1)
  const chatHistoryRef = useRef([]) // 发送给AI的对话历史
  const currentStreamMsgIdRef = useRef(null)

  // ============ Agent v2 模式状态 ============
  const [agentMode, setAgentMode] = useState(false) // Agent 自主决策模式开关
  const agentStatusIdRef = useRef(null)      // Agent 状态行消息 id（单例，agentStart/agentStatus 更新它）
  const agentThinkingIdRef = useRef(null)    // AI 思考卡片消息 id（单例覆盖式，新思考覆盖旧内容）
  const agentStepIdsRef = useRef({})         // 工具步骤卡片 id 映射：{ [step]: msgId }
  const agentStreamIdRef = useRef(null)      // Agent 流式回复消息 id
  const agentUserMessageRef = useRef('')     // 当前 Agent 任务的用户消息（用于异常时回滚）

  // ============ 模型选择状态 ============
  const [modelList, setModelList] = useState([])        // 可用模型列表（扁平数组）
  const [modelProviders, setModelProviders] = useState([]) // 模型供应商列表
  const [selectedModelId, setSelectedModelId] = useState(null) // 当前选中的模型 ID
  const [currentModelInfo, setCurrentModelInfo] = useState(null) // 当前模型能力信息
  const [showModelDropdown, setShowModelDropdown] = useState(false) // 模型下拉面板开关
  const [modelLoading, setModelLoading] = useState(false)  // 模型列表加载中

  // 加载自动注入脚本
  useEffect(() => {
    window.api.action.getAutoInjectScripts().then(res => {
      if (res.success) setAutoInjectScripts(res.scripts)
    })
    // 监听自动注入执行结果
    const unsubscribe = window.api.action.onAutoInjectExecuted((data) => {
      const injected = data.results.filter(r => r.success).length
      const failed = data.results.filter(r => !r.success).length
      if (injected > 0) {
        addMessage({ role: 'system', type: 'tool_call', content: `自动注入: ${injected}个脚本执行成功${failed > 0 ? `, ${failed}个失败` : ''} (${data.url})` })
      }
    })
    return unsubscribe
  }, [])

  // ============ 加载模型列表 ============
  const loadModels = useCallback(async () => {
    setModelLoading(true)
    try {
      // 先检查同步配置是否已设置
      const syncRes = await window.api.config.getSync()
      const sync = syncRes?.data || syncRes
      if (!sync?.appKey || !sync?.appSecret) {
        setModelLoading(false)
        return
      }
      const res = await window.api.config.getAvailableModels()
      // res 结构: { success: true, data: { providers: [...], models: [...] } }
      // success 在 res 外层，不在 res.data 上
      if (!res?.success) {
        setModelLoading(false)
        return
      }
      const data = res?.data || res
      const providers = data.providers || []
      const models = data.models || []
      setModelProviders(providers)
      setModelList(models)

      // 读取当前 AI 配置中的模型 ID
      const aiRes = await window.api.config.getAI()
      const aiConfig = aiRes?.data || aiRes
      const currentModel = aiConfig?.model
      if (currentModel) {
        setSelectedModelId(currentModel)
        // 查找模型能力信息
        const model = models.find(m => m.model_id === currentModel)
        if (model) {
          setCurrentModelInfo({
            modelId: model.model_id,
            provider: model.provider_id,
            displayName: model.display_name || model.model_id,
            supportsVision: String(model.supports_vision) === '1',
            supportsTools: String(model.supports_tools) === '1',
            temperature: model.temperature != null ? model.temperature : 0.7,
            contextWindow: model.context_window || 8192,
            maxTokens: model.max_tokens || 4096,
          })
        }
      } else if (models.length > 0) {
        // 默认选中第一个模型
        handleSelectModel(models[0].model_id, models, providers)
      }
    } catch (e) {
      console.warn('加载模型列表失败:', e)
    } finally {
      setModelLoading(false)
    }
  }, [])

  // 选择模型
  const handleSelectModel = useCallback(async (modelId, models, providers) => {
    const model = (models || modelList).find(m => m.model_id === modelId)
    if (model) {
      setCurrentModelInfo({
        modelId: model.model_id,
        provider: model.provider_id,
        displayName: model.display_name || model.model_id,
        supportsVision: String(model.supports_vision) === '1',
        supportsTools: String(model.supports_tools) === '1',
        temperature: model.temperature != null ? model.temperature : 0.7,
        contextWindow: model.context_window || 8192,
        maxTokens: model.max_tokens || 4096,
      })
    }
    setSelectedModelId(modelId)
    setShowModelDropdown(false)
    // 保存到配置
    try {
      await window.api.config.saveAI({ model: modelId })
    } catch (e) {
      console.warn('保存模型选择失败:', e)
    }
  }, [modelList])

  // 组件挂载时加载模型列表
  useEffect(() => {
    loadModels()
  }, [loadModels])

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

  // 在指定消息 id 之前插入新消息（用于思考卡片插入到步骤卡片之前）
  // 若找不到目标消息，则追加到末尾。返回新消息 id。
  const insertMessageBefore = useCallback((beforeId, msg) => {
    const id = nextIdRef.current++
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === beforeId)
      const newMsg = { id, timestamp: Date.now(), ...msg }
      if (idx === -1) return [...prev, newMsg]
      const next = [...prev]
      next.splice(idx, 0, newMsg)
      return next
    })
    return id
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
        messages: messages.map(({ role, type, content, jsCode, toolName, success, error, result, description,
          // Agent v2 相关字段（持久化以便恢复）
          step, toolArgs, status, resultDisplay, items, searchResults }) =>
          ({ role, type, content, jsCode, toolName, success, error, result, description,
             step, toolArgs, status, resultDisplay, items, searchResults })),
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

  // 用 ref 保存最新的 handleSwitchSession，供 storage 事件监听器调用（避免闭包过期）
  const handleSwitchSessionRef = useRef(handleSwitchSession)
  useEffect(() => {
    handleSwitchSessionRef.current = handleSwitchSession
  }, [handleSwitchSession])

  // ============ 跨窗口会话通信（与历史记录管理窗口 HistoryWindow 协作） ============
  // 监听 localStorage 变化（同 origin 的其他窗口写入时触发）：
  //   - 'ai-browser-load-session'：历史窗口请求载入某会话 → 切换到该会话
  //   - 'ai-browser-sessions'：历史窗口删除/清空会话 → 刷新本窗口会话列表
  useEffect(() => {
    const handleStorage = (e) => {
      // 载入会话：历史窗口设置了要载入的会话 ID
      if (e.key === 'ai-browser-load-session' && e.newValue) {
        const sessionId = e.newValue
        try {
          const all = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]')
          const session = all.find(s => s.id === sessionId)
          if (session) {
            handleSwitchSessionRef.current(session)
          }
        } catch { /* 忽略解析错误 */ }
      }
      // 会话列表变更：历史窗口删除单个或全部会话 → 同步刷新
      if (e.key === SESSIONS_KEY) {
        try {
          setSessions(e.newValue ? JSON.parse(e.newValue) : [])
        } catch { /* 忽略解析错误 */ }
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

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

  // ============ Agent v2 事件监听 ============
  // 监听 window.api.agent2.onEvent 推送的事件，渲染步骤卡片/思考卡片/数据报告/流式回复
  useEffect(() => {
    // Agent 事件回调需引用最新状态，使用 ref 镜像避免闭包陈旧
    const handleAgentEvent = (channel, data) => {
      switch (channel) {
        case 'agentStart': {
          // 显示"Agent 已启动，分析需求中..."（单例状态行）
          const text = 'Agent 已启动，分析需求中...'
          if (agentStatusIdRef.current) {
            updateMessage(agentStatusIdRef.current, { content: text })
          } else {
            const id = addMessage({ role: 'system', type: 'agent_status', content: text })
            agentStatusIdRef.current = id
          }
          break
        }
        case 'agentThinking': {
          // 更新思考卡片（单例覆盖式：新思考覆盖旧内容，不堆叠）
          const content = (data?.content || '').trim()
          if (!content) break
          const displayText = content.length > 500 ? content.slice(0, 500) + '...' : content
          if (agentThinkingIdRef.current) {
            // 已有思考卡片：仅更新内容
            updateMessage(agentThinkingIdRef.current, { content: displayText })
          } else {
            // 首次创建思考卡片，插入到第一个步骤卡片之前（若无步骤卡片则追加到末尾）
            const firstStepId = Object.values(agentStepIdsRef.current)[0] || null
            const id = firstStepId
              ? insertMessageBefore(firstStepId, { role: 'system', type: 'agent_thinking', content: displayText })
              : addMessage({ role: 'system', type: 'agent_thinking', content: displayText })
            agentThinkingIdRef.current = id
          }
          break
        }
        case 'agentStatus': {
          // 更新状态文本（单例状态行）
          const text = data?.text || '处理中...'
          if (agentStatusIdRef.current) {
            updateMessage(agentStatusIdRef.current, { content: text })
          } else {
            const id = addMessage({ role: 'system', type: 'agent_status', content: text })
            agentStatusIdRef.current = id
          }
          break
        }
        case 'agentStep': {
          // 创建/更新工具步骤卡片（按 step 编号，按顺序排列）
          const step = data?.step
          const toolName = data?.toolName || ''
          const toolArgs = data?.toolArgs
          const status = data?.status || 'running'
          const existingId = agentStepIdsRef.current[step]
          if (existingId) {
            updateMessage(existingId, { step, toolName, toolArgs, status })
          } else {
            const id = addMessage({
              role: 'system', type: 'agent_step',
              step, toolName, toolArgs, status, resultDisplay: '',
            })
            agentStepIdsRef.current[step] = id
          }
          break
        }
        case 'agentSearchResult': {
          // 显示搜索到的工具列表（更新到最近的步骤卡片）
          const results = data?.results || []
          const stepIds = Object.values(agentStepIdsRef.current)
          const lastStepId = stepIds[stepIds.length - 1]
          if (lastStepId) {
            const text = results.length > 0
              ? '找到 ' + results.length + ' 个工具：\n' + results.map(r => '  - ' + r.name + ': ' + (r.description || '')).join('\n')
              : '未找到匹配的工具'
            updateMessage(lastStepId, { searchResults: results, resultDisplay: text })
          }
          break
        }
        case 'agentStepResult': {
          // 更新步骤卡片结果（search_tools 结果不显示）
          const step = data?.step
          const toolName = data?.toolName
          if (toolName === 'search_tools') break
          const success = data?.success !== false && !isAgentToolResultFailed(data?.result)
          const stepId = agentStepIdsRef.current[step]
          if (!stepId) break
          if (!success) {
            // 失败的工具结果：卡片标记为 error，保留可读摘要
            updateMessage(stepId, {
              status: 'error',
              success: false,
              resultDisplay: '执行未成功，已跳过',
            })
            break
          }
          const displayResult = summarizeAgentToolResult(toolName, data?.result || '')
          const isDone = data?.done
          updateMessage(stepId, {
            // 成功的工具结果：该步骤标记为完成（done 字段表示是否为最后一步 finish_task）
            status: 'done',
            success: true,
            result: data?.result,
            resultDisplay: displayResult,
            ...(isDone ? { finishTask: true } : {}),
          })
          break
        }
        case 'agentDataReport': {
          // 渲染结构化数据报告
          console.log('[UI] agentDataReport 事件收到:', JSON.stringify(data).slice(0, 200))
          const items = data?.items || []
          console.log('[UI] agentDataReport items 数量:', items.length)
          if (items.length > 0) {
            addMessage({ role: 'system', type: 'agent_data_report', items })
          } else {
            console.warn('[UI] agentDataReport items 为空!', data)
          }
          break
        }
        case 'agentTodoUpdate': {
          // 待办列表更新
          const todoData = data?.data || data
          const progress = todoData?.progress
          const items = todoData?.items || []
          if (items.length > 0) {
            // progress 可能是对象 { total, completed, percentage } 或数字
            const pct = typeof progress === 'object' ? progress?.percentage : progress
            const completed = typeof progress === 'object' ? progress?.completed : undefined
            const total = typeof progress === 'object' ? progress?.total : items.length
            const progressText = pct !== undefined
              ? `（进度 ${completed ?? '?'}/${total ?? items.length}，${pct}%）`
              : ''
            const text = `📋 待办计划：${items.length} 个步骤${progressText}`
            if (agentStatusIdRef.current) {
              updateMessage(agentStatusIdRef.current, { content: text })
            }
          }
          break
        }
        case 'agentDebug': {
          // 调试日志（可选，控制台输出，不渲染到 UI 避免干扰）
          // 仅在控制台记录，前端不展示
          break
        }
        case 'streamChunk': {
          // 流式追加文本（Agent v2 流式回复）
          const chunk = data?.content || ''
          if (!agentStreamIdRef.current) {
            const id = addMessage({ role: 'assistant', type: 'reply', content: chunk })
            agentStreamIdRef.current = id
            break
          }
          // ★ 关键修复：用局部变量捕获 id，避免 React 18 批处理时
          // streamDone 同步重置 agentStreamIdRef.current = null 导致更新函数找不到目标消息
          const targetId = agentStreamIdRef.current
          setMessages(prev => prev.map(m => {
            if (m.id !== targetId) return m
            return { ...m, content: (m.content || '') + chunk }
          }))
          break
        }
        case 'streamDone': {
          // 流式完成：将回复加入对话历史，重置流式引用
          if (agentStreamIdRef.current) {
            // ★ 用局部变量捕获 id，避免 React 批处理时 ref 已被重置
            const doneId = agentStreamIdRef.current
            setMessages(prev => {
              const msg = prev.find(m => m.id === doneId)
              if (msg?.content) {
                chatHistoryRef.current.push({ role: 'assistant', content: msg.content })
              }
              return prev
            })
            agentStreamIdRef.current = null
          }
          break
        }
        case 'agentError': {
          // 错误处理：显示错误，回滚最后一条未完成的用户消息
          const errMsg = data?.error || 'Agent 运行异常'
          if (agentStreamIdRef.current) {
            updateMessage(agentStreamIdRef.current, { content: '❌ ' + errMsg })
            agentStreamIdRef.current = null
          } else {
            addMessage({ role: 'assistant', type: 'error', content: `Agent 异常: ${errMsg}` })
          }
          // 标记最近步骤卡片为 error
          const stepIds = Object.values(agentStepIdsRef.current)
          const lastStepId = stepIds[stepIds.length - 1]
          if (lastStepId) updateMessage(lastStepId, { status: 'error' })
          // 回滚最后一条未完成的 user message（避免历史里残留孤儿 user 消息）
          const last = chatHistoryRef.current[chatHistoryRef.current.length - 1]
          if (last && last.role === 'user' && last.content === agentUserMessageRef.current) {
            chatHistoryRef.current.pop()
          }
          setLoading(false)
          break
        }
        default:
          break
      }
    }

    const unsubscribe = window.api.agent2.onEvent(handleAgentEvent)
    const unsubscribeDone = window.api.agent2.onDone(() => {
      // Agent 完成，重置 loading 与各引用
      setLoading(false)
      agentStreamIdRef.current = null
    })
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
      if (typeof unsubscribeDone === 'function') unsubscribeDone()
    }
  }, [addMessage, updateMessage, insertMessageBefore])

  // ============ 监听外部消息（划词/右键AI操作）============
  useEffect(() => {
    if (!window.api?.onExternalMessage) return

    const unsubscribe = window.api.onExternalMessage((data) => {
      const msg = data?.message
      if (!msg || loading) return
      // 设置输入框内容并自动发送
      setInput('')
      addMessage({ role: 'user', content: msg })
      chatHistoryRef.current.push({ role: 'user', content: msg })
      // 直接触发发送（避免 loading 状态干扰）
      handleSendExternal(msg)
    })

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [addMessage, loading])

  // 外部消息发送（不依赖 input 状态，直接使用传入的消息文本）
  const handleSendExternal = async (msg) => {
    if (!msg || loading) return

    if (!activeSessionId) {
      setActiveSessionId(createSessionId())
    }

    setLoading(true)

    if (agentMode) {
      agentStatusIdRef.current = null
      agentThinkingIdRef.current = null
      agentStepIdsRef.current = {}
      agentStreamIdRef.current = null
      agentUserMessageRef.current = msg

      try {
        const modelInfo = currentModelInfo ? {
          modelId: currentModelInfo.modelId,
          temperature: currentModelInfo.temperature,
          contextWindow: currentModelInfo.contextWindow,
          maxTokens: currentModelInfo.maxTokens,
          supportsTools: currentModelInfo.supportsTools,
          supportsVision: currentModelInfo.supportsVision,
        } : { temperature: 0.7, maxTokens: 4096 }

        const startRes = await window.api.agent2.start({
          tabId: null,
          userMessage: msg,
          chatHistory: chatHistoryRef.current,
          modelInfo,
        })
        if (startRes && startRes.success === false) {
          addMessage({
            role: 'assistant', type: 'error',
            content: `Agent 启动失败: ${startRes.error || '未知错误'}`,
          })
          if (chatHistoryRef.current[chatHistoryRef.current.length - 1]?.content === msg) {
            chatHistoryRef.current.pop()
          }
          setLoading(false)
        }
      } catch (e) {
        addMessage({ role: 'assistant', type: 'error', content: `Agent 异常: ${e.message || '请求失败'}` })
        if (chatHistoryRef.current[chatHistoryRef.current.length - 1]?.content === msg) {
          chatHistoryRef.current.pop()
        }
        setLoading(false)
      }
      return
    }

    // 普通模式
    try {
      const mergedConfig = {
        ...config,
        model: currentModelInfo?.modelId || config.model,
      }
      const result = await window.api.unified.chatStream(
        chatHistoryRef.current,
        mergedConfig,
        config.maxToolRounds || 20,
      )
      if (result && result.success === false) {
        addMessage({
          role: 'assistant',
          type: 'error',
          content: `错误: ${result.error || result.summary || '未知错误'}`
        })
      }
    } catch (e) {
      addMessage({ role: 'assistant', type: 'error', content: `错误: ${e.message || '请求失败'}` })
    } finally {
      setLoading(false)
    }
  }

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

    // ============ Agent v2 模式：走 window.api.agent2.start ============
    if (agentMode) {
      // 重置 Agent 单例引用（每次新任务重新开始）
      agentStatusIdRef.current = null
      agentThinkingIdRef.current = null
      agentStepIdsRef.current = {}
      agentStreamIdRef.current = null
      agentUserMessageRef.current = userMsg

      try {
        // 启动 Agent（tabId=null 表示使用活跃标签页）
        // 传递当前选中模型的能力信息（temperature/contextWindow/maxTokens）
        const modelInfo = currentModelInfo ? {
          modelId: currentModelInfo.modelId,
          temperature: currentModelInfo.temperature,
          contextWindow: currentModelInfo.contextWindow,
          maxTokens: currentModelInfo.maxTokens,
          supportsTools: currentModelInfo.supportsTools,
          supportsVision: currentModelInfo.supportsVision,
        } : { temperature: 0.7, maxTokens: 4096 }

        // 如果启用了对话全景，自动打开全景窗口
        try {
          const agentRes = await window.api.config.getAgent()
          if (agentRes?.success && agentRes.data?.conversationViewer) {
            window.api?.conversationWindow?.open()
          }
        } catch (e) { console.warn('[UnifiedPanel] 读取 agent 配置失败:', e.message) }

        const startRes = await window.api.agent2.start({
          tabId: null,
          userMessage: userMsg,
          chatHistory: chatHistoryRef.current,
          modelInfo,
        })
        // 启动失败兜底
        if (startRes && startRes.success === false) {
          addMessage({
            role: 'assistant', type: 'error',
            content: `Agent 启动失败: ${startRes.error || '未知错误'}`,
          })
          // 回滚刚加入的用户消息
          if (chatHistoryRef.current[chatHistoryRef.current.length - 1]?.content === userMsg) {
            chatHistoryRef.current.pop()
          }
          setLoading(false)
        }
        // 成功启动后，事件由 onEvent/onDone 推送，loading 在 onDone/streamDone/agentError 中重置
      } catch (e) {
        addMessage({ role: 'assistant', type: 'error', content: `Agent 异常: ${e.message || '请求失败'}` })
        if (chatHistoryRef.current[chatHistoryRef.current.length - 1]?.content === userMsg) {
          chatHistoryRef.current.pop()
        }
        setLoading(false)
      }
      return
    }

    // ============ 普通模式：走 window.api.unified.chatStream ============
    // 合并当前选中的模型到 config，确保用用户选的模型而非旧 localStorage 配置
    try {
      const mergedConfig = {
        ...config,
        model: currentModelInfo?.modelId || config.model,
      }
      const result = await window.api.unified.chatStream(
        chatHistoryRef.current,
        mergedConfig,
        config.maxToolRounds || 20,
      )
      
      // 检查返回结果
      if (result && result.success === false) {
        addMessage({ 
          role: 'assistant', 
          type: 'error', 
          content: `错误: ${result.error || result.summary || '未知错误'}` 
        })
      }
    } catch (e) {
      addMessage({ role: 'assistant', type: 'error', content: `错误: ${e.message || '请求失败'}` })
    } finally {
      // 确保 loading 状态被重置
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

  // 重新注入JS代码（先执行，然后将结果反馈给AI）
  const handleReInject = async (jsCode) => {
    if (!jsCode.trim() || loading) return

    setLoading(true)
    addMessage({ role: 'system', type: 'tool_call', content: '重新注入JS代码' })

    try {
      const result = await window.api.action.executeJs(jsCode)
      const resultMsg = result.success
        ? result.result?.message || '代码执行成功'
        : `执行失败: ${result.error || '未知错误'}`

      addMessage({
        role: 'assistant', type: 'tool_execute',
        content: resultMsg,
        jsCode,
        result: result.result,
        error: result.success ? null : result.error,
      })

      // 将结果反馈给AI继续对话
      chatHistoryRef.current.push({
        role: 'user',
        content: `我重新执行了以下代码:\n\`\`\`javascript\n${jsCode}\n\`\`\`\n\n执行结果: ${resultMsg}${result.result?.data ? '\n返回数据: ' + JSON.stringify(result.result.data) : ''}\n\n请根据结果继续任务。`,
      })
      addMessage({ role: 'user', content: `已重新注入代码并反馈结果给AI` })
    } catch (e) {
      addMessage({
        role: 'assistant', type: 'error',
        content: `代码执行异常: ${e.message}`,
      })
    } finally {
      setLoading(false)
    }
  }

  // 保存JS代码（弹窗输入名称和描述）
  const handleSaveScript = async (jsCode) => {
    if (!jsCode.trim()) return

    // 使用双字段弹窗，一次性输入名称和描述
    const result = await showSaveModal(jsCode.trim().substring(0, 40).replace(/\n/g, ' '))
    if (!result) return

    const newScript = {
      id: 'script_' + Date.now(),
      name: result.name || jsCode.trim().substring(0, 30).replace(/\n/g, ' '),
      description: result.description || '',
      code: jsCode,
      savedAt: Date.now(),
    }

    setSavedScripts(prev => {
      const updated = [newScript, ...prev]
      saveSavedScripts(updated)
      return updated
    })
    addMessage({ role: 'system', type: 'tool_call', content: `脚本 "${newScript.name}" 已保存到本地脚本库` })
  }

  // 删除已保存的脚本
  const handleDeleteScript = (scriptId) => {
    setSavedScripts(prev => {
      const updated = prev.filter(s => s.id !== scriptId)
      saveSavedScripts(updated)
      return updated
    })
  }

  // 自定义弹窗（替代 Electron 中不支持的 prompt()）
  const showModal = (title, message, defaultValue = '') => {
    return new Promise((resolve) => {
      setModal({ type: 'single', title, message, defaultValue, placeholder: '', value: defaultValue, resolve })
    })
  }

  // 保存脚本专用弹窗（名称+描述双字段）
  const showSaveModal = (defaultName) => {
    return new Promise((resolve) => {
      setModal({
        type: 'save',
        title: '保存脚本',
        nameValue: defaultName,
        descValue: '',
        resolve,
      })
    })
  }

  // 上传脚本专用弹窗（名称+描述双字段）
  const showUploadModal = (defaultName, defaultDesc) => {
    return new Promise((resolve) => {
      setModal({
        type: 'upload',
        title: '上传脚本到管理后台',
        nameValue: defaultName,
        descValue: defaultDesc || '',
        urlPatternValue: '*',
        toolTypeValue: 'js',
        resolve,
      })
    })
  }

  // 添加为自动注入脚本（页面加载后自动执行）
  const handleAddAutoInject = async (jsCode, scriptName) => {
    const urlPattern = await showModal('自动注入设置', '请输入URL匹配模式（* 匹配所有页面，如 *example.com* 匹配指定域名）', '*')
    if (urlPattern === null) return

    const res = await window.api.action.addAutoInject(scriptName || '自动注入脚本', jsCode, urlPattern)
    if (res.success) {
      setAutoInjectScripts(prev => [...prev, res.script])
      addMessage({ role: 'system', type: 'tool_call', content: `已添加自动注入脚本: ${res.script.name} (匹配: ${urlPattern})` })
    }
  }

  // 切换自动注入脚本启用状态
  const handleToggleAutoInject = async (scriptId) => {
    const res = await window.api.action.toggleAutoInject(scriptId)
    if (res.success) {
      setAutoInjectScripts(prev => prev.map(s => s.id === scriptId ? { ...s, enabled: res.script.enabled } : s))
    }
  }

  // 删除自动注入脚本
  const handleRemoveAutoInject = async (scriptId) => {
    const res = await window.api.action.removeAutoInject(scriptId)
    if (res.success) {
      setAutoInjectScripts(prev => prev.filter(s => s.id !== scriptId))
    }
  }

  // 立即执行所有自动注入脚本
  const handleRunAutoInjectNow = async () => {
    const res = await window.api.action.runAutoInject()
    if (res.success) {
      const ok = res.results.filter(r => r.success).length
      const fail = res.results.filter(r => !r.success).length
      addMessage({ role: 'system', type: 'tool_call', content: `手动触发自动注入: ${ok}个成功${fail > 0 ? `, ${fail}个失败` : ''}` })
    }
  }

  // 上传脚本到管理后台
  const handleUploadToServer = async (jsCode, scriptName, scriptDescription) => {
    if (!jsCode.trim() || loading) return

    const serverUrl = config.adminServerUrl || ''
    const token = config.adminToken || ''

    if (!serverUrl || !token) {
      addMessage({
        role: 'assistant', type: 'error',
        content: '请先在设置中配置管理后台地址和 Token。\n\n获取 Token 方式：\n1. 访问管理后台 ' + (serverUrl || 'http://localhost:3001') + '\n2. 登录（默认账号 admin/admin123）\n3. 获取返回的 Token 填入设置',
      })
      return
    }

    let name, description, urlPattern, toolType
    if (scriptName) {
      name = scriptName
      description = scriptDescription || ''
      urlPattern = '*'
      toolType = 'js'
    } else {
      const result = await showUploadModal(jsCode.trim().substring(0, 40).replace(/\n/g, ' '), '')
      if (!result) return
      name = result.name
      description = result.description || ''
      urlPattern = result.urlPattern || '*'
      toolType = result.toolType || 'js'
    }

    setLoading(true)
    addMessage({ role: 'system', type: 'tool_call', content: `正在上传脚本到管理后台: ${name} (类型: ${toolType}, 匹配: ${urlPattern})` })

    try {
      const result = await window.api.admin.uploadScript({
        serverUrl, token, name,
        code: jsCode,
        description: description || '从 AI Browser 客户端上传',
        categoryId: 1,
        urlPattern,
        toolType,
      })
      if (result.success) {
        addMessage({
          role: 'assistant', type: 'tool_execute',
          content: `脚本 "${name}" 已成功上传到管理后台脚本中心！\n\n- 类型: ${toolType}\n- URL匹配: ${urlPattern}\n- 描述: ${description || '无'}`,
          jsCode,
        })
      } else {
        addMessage({
          role: 'assistant', type: 'error',
          content: `上传失败: ${result.error || result.data?.error || '未知错误'}`,
        })
      }
    } catch (e) {
      addMessage({
        role: 'assistant', type: 'error',
        content: `上传异常: ${e.message}`,
      })
    } finally {
      setLoading(false)
    }
  }

  // 注入已保存的脚本
  const handleInjectSaved = async (script) => {
    if (loading) return
    setShowSavedScripts(false)

    setLoading(true)
    addMessage({ role: 'system', type: 'tool_call', content: `注入已保存脚本: ${script.name}` })

    try {
      const result = await window.api.action.executeJs(script.code)
      const resultMsg = result.success
        ? result.result?.message || '代码执行成功'
        : `执行失败: ${result.error || '未知错误'}`

      addMessage({
        role: 'assistant', type: 'tool_execute',
        content: resultMsg,
        jsCode: script.code,
        result: result.result,
        error: result.success ? null : result.error,
      })

      chatHistoryRef.current.push({
        role: 'user',
        content: `我执行了保存的脚本 "${script.name}":\n\`\`\`javascript\n${script.code}\n\`\`\`\n\n执行结果: ${resultMsg}${result.result?.data ? '\n返回数据: ' + JSON.stringify(result.result.data) : ''}\n\n请根据结果继续任务。`,
      })
      addMessage({ role: 'user', content: `已注入脚本 "${script.name}" 并反馈结果给AI` })
    } catch (e) {
      addMessage({
        role: 'assistant', type: 'error',
        content: `脚本执行异常: ${e.message}`,
      })
    } finally {
      setLoading(false)
    }
  }

  // 中止
  const handleAbort = async () => {
    if (agentMode) {
      // Agent v2 模式：中止 Agent（tabId=null 表示活跃标签页）
      try {
        await window.api.agent2.abort(null)
      } catch { /* 忽略中止异常 */ }
      setLoading(false)
      agentStreamIdRef.current = null
      return
    }
    await window.api.unified.abort()
  }

  // ============ 脚本中心已迁移为独立窗口（window.api.scriptCenterWindow.open()） ============

  // 清空当前会话消息
  const handleClear = () => {
    setMessages([])
    chatHistoryRef.current = []
    nextIdRef.current = 1
    // 重置 Agent v2 单例引用
    agentStatusIdRef.current = null
    agentThinkingIdRef.current = null
    agentStepIdsRef.current = {}
    agentStreamIdRef.current = null
    agentUserMessageRef.current = ''
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
      // ---- Agent v2 状态行（agentStart/agentStatus） ----
      if (msg.type === 'agent_status') {
        return (
          <div key={msg.id} className="msg-system agent-status-msg">
            <span className="agent-status-dot" />
            <span>{msg.content}</span>
          </div>
        )
      }
      // ---- Agent v2 思考卡片（单例覆盖式，紫蓝渐变背景） ----
      if (msg.type === 'agent_thinking') {
        return (
          <div key={msg.id} className="agent-thinking-card">
            <div className="agent-thinking-header">💭 AI 思考</div>
            <div className="agent-thinking-content">{msg.content}</div>
          </div>
        )
      }
      // ---- Agent v2 工具步骤卡片（齿轮图标 + 步骤标题 + 可展开参数/结果） ----
      if (msg.type === 'agent_step') {
        return <AgentStepCard key={msg.id} msg={msg} />
      }
      // ---- Agent v2 数据报告 ----
      if (msg.type === 'agent_data_report') {
        return <AgentDataReport key={msg.id} items={msg.items || []} />
      }
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
          <div className="msg-role-label">用户</div>
          <div className="msg-content">{msg.content}</div>
          {msg.timestamp && <div className="msg-timestamp">{new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>}
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
                <div className="code-block-actions">
                  <button
                    className="code-replay-btn"
                    onClick={() => handleReExecute(msg.jsCode)}
                    disabled={loading}
                    title="重新执行这段代码"
                  >
                    重新执行
                  </button>
                  <button
                    className="code-replay-btn code-replay-inject"
                    onClick={() => handleReInject(msg.jsCode)}
                    disabled={loading}
                    title="重新注入并反馈结果给AI继续对话"
                  >
                    重新注入
                  </button>
                  <button
                    className="code-replay-btn code-replay-save"
                    onClick={() => handleSaveScript(msg.jsCode)}
                    title="保存代码到脚本库"
                  >
                    保存代码
                  </button>
                  <button
                    className="code-replay-btn code-replay-auto"
                    onClick={() => handleAddAutoInject(msg.jsCode, msg.content?.substring(0, 30))}
                    title="设为自动注入脚本（页面刷新后自动执行）"
                  >
                    自动注入
                  </button>
                </div>
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
      const codeComponents = {
        pre({ node, children, ...props }) {
          const codeEl = children?.props?.children
          const codeText = String(codeEl).replace(/\n$/, '')
          const className = children?.props?.className || ''
          const match = /language-(\w+)/.exec(className)
          const language = match ? match[1] : ''
          const langLabel = language ? language.charAt(0).toUpperCase() + language.slice(1) : '代码'
          const isJS = language === 'javascript' || language === 'js'
          return (
            <div className="code-block-inline">
              <div className="code-block-header">
                <span className="code-block-label">{langLabel}</span>
                <div className="code-block-actions">
                  {isJS && (
                    <>
                      <button className="code-replay-btn" onClick={() => handleReExecute(codeText)} disabled={loading} title="在当前页面重新执行这段代码">重新执行</button>
                      <button className="code-replay-btn code-replay-inject" onClick={() => handleReInject(codeText)} disabled={loading} title="执行代码并将结果反馈给AI继续对话">重新注入</button>
                    </>
                  )}
                  <button className="code-replay-btn code-replay-save" onClick={() => handleSaveScript(codeText)} title="保存到本地脚本库">保存代码</button>
                  <button className="code-replay-btn code-replay-auto" onClick={() => handleAddAutoInject(codeText, codeText.substring(0, 30))} title="页面刷新后自动执行">自动注入</button>
                </div>
              </div>
              <pre className="code-preview">{codeText}</pre>
            </div>
          )
        },
        code({ node, inline, className, children, ...props }) {
          if (!inline) {
            return <code className={className} {...props}>{children}</code>
          }
          return <code className={className} {...props}>{children}</code>
        },
      }
      return (
        <div key={msg.id} className="msg-assistant">
          <div className="msg-avatar">AI</div>
          <div className="msg-markdown">
            <ReactMarkdown components={codeComponents}>{msg.content}</ReactMarkdown>
            {msg.timestamp && <div className="msg-timestamp">{new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>}
          </div>
        </div>
      )
    }

    return (
      <div key={msg.id} className="msg-assistant">
        <div className="msg-avatar">AI</div>
        <div className="msg-markdown">
          <ReactMarkdown>{msg.content || ''}</ReactMarkdown>
          {msg.timestamp && <div className="msg-timestamp">{new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>}
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
          <button className="toolbar-btn" onClick={() => window.api.historyWindow.open()} title="历史会话">
            历史 ({sessions.length})
          </button>
          <button className="toolbar-btn" onClick={() => window.api.scriptCenterWindow?.open()} title="打开脚本中心（独立窗口，浏览/下载/注入后台脚本）">
            脚本中心
          </button>
          <button className="toolbar-btn" onClick={() => window.api.reverseWindow?.open()} title="打开逆向分析工具（网络捕获/JS分析/请求重放/AI逆向）">
            逆向分析
          </button>
          {/* Agent v2 模式切换按钮（激活态品牌紫色） */}
          <button
            className={`toolbar-btn agent-mode-btn ${agentMode ? 'active' : ''}`}
            onClick={() => setAgentMode(m => !m)}
            title={agentMode ? 'Agent 自主决策模式已开启（点击关闭）' : '开启 Agent 自主决策模式（8阶段主循环 + 工具自动调用）'}
          >
            ⚡ Agent {agentMode ? '已开启' : ''}
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

      {/* 会话列表 - 已移至模态弹窗 */}

      {/* 已保存的脚本列表 */}
      {showSavedScripts && (
        <div className="session-list">
          <div className="session-list-header">
            <span>已保存的脚本 ({savedScripts.length})</span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              点击注入到页面并反馈给AI
            </span>
          </div>
          {savedScripts.length === 0 && (
            <div className="session-empty">暂无保存的脚本，在AI生成的代码块中点击"保存代码"即可保存</div>
          )}
          {savedScripts.map(script => (
            <div
              key={script.id}
              className="session-item script-item"
              onClick={() => handleInjectSaved(script)}
            >
              <div className="session-item-title">{script.name}</div>
              {script.description && (
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{script.description}</div>
              )}
              <div className="session-item-meta">
                <span>{new Date(script.savedAt).toLocaleString()}</span>
                <span>{script.code.length} 字符</span>
              </div>
              <div style={{ display: 'flex', gap: '4px', marginTop: 4 }}>
                <button
                  style={{ background: '#ec4899', color: '#fff', fontSize: 11, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer' }}
                  onClick={(e) => { e.stopPropagation(); handleUploadToServer(script.code, script.name, script.description) }}
                  title="上传到管理后台"
                >
                  上传
                </button>
                <button
                  style={{ background: '#ef4444', color: '#fff', fontSize: 11, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer' }}
                  onClick={(e) => { e.stopPropagation(); if (confirm('确定删除脚本 "' + script.name + '" 吗？')) handleDeleteScript(script.id) }}
                  title="删除脚本"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 脚本中心 - 已移至模态弹窗 */}

      {/* 自动注入脚本列表 */}
      {showAutoInject && (
        <div className="session-list">
          <div className="session-list-header">
            <span>自动注入脚本 ({autoInjectScripts.length})</span>
            <button
              className="toolbar-btn"
              style={{ fontSize: 11, padding: '2px 8px' }}
              onClick={handleRunAutoInjectNow}
              title="立即执行所有自动注入脚本"
            >
              立即执行
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '0 12px 8px' }}>
            页面刷新或导航后自动执行匹配的脚本
          </div>
          {autoInjectScripts.length === 0 && (
            <div className="session-empty">暂无自动注入脚本，在AI生成的代码块中点击"自动注入"即可添加</div>
          )}
          {autoInjectScripts.map(script => (
            <div
              key={script.id}
              className={`session-item script-item ${!script.enabled ? 'disabled' : ''}`}
            >
              <div className="session-item-title" style={{ opacity: script.enabled ? 1 : 0.5 }}>
                {script.name}
              </div>
              <div className="session-item-meta">
                <span>匹配: {script.urlPattern}</span>
                <span>已注入 {script.injectCount || 0} 次</span>
              </div>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  className="session-delete-btn"
                  style={{ background: script.enabled ? 'var(--success)' : 'var(--text-secondary)' }}
                  onClick={(e) => { e.stopPropagation(); handleToggleAutoInject(script.id) }}
                  title={script.enabled ? '点击禁用' : '点击启用'}
                >
                  {script.enabled ? '●' : '○'}
                </button>
                <button
                  className="session-delete-btn"
                  onClick={(e) => { e.stopPropagation(); handleRemoveAutoInject(script.id) }}
                  title="删除"
                >
                  ✗
                </button>
              </div>
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
        {messages.map((msg, i) => { const el = renderMessage(msg); return el.key ? el : React.cloneElement(el, { key: msg.id ?? `msg-${i}` }) })}
        {loading && messages.length > 0 && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="msg-assistant">
            <div className="loading-spinner" />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 输入区 */}
      <div className="unified-input-area">
        {/* 模型选择下拉面板 */}
        {showModelDropdown && (
          <div className="model-dropdown-panel" ref={(el) => {
            // 点击外部关闭
            if (el && !el._hasClickListener) {
              el._hasClickListener = true
              setTimeout(() => {
                const handler = (e) => {
                  if (!el.contains(e.target) && !e.target.closest('.model-pill-btn')) {
                    setShowModelDropdown(false)
                  }
                }
                document.addEventListener('click', handler)
              }, 0)
            }
          }}>
            <div className="model-dropdown-header">
              <span>选择模型</span>
              <button className="model-dropdown-close" onClick={() => setShowModelDropdown(false)}>✕</button>
            </div>
            <div className="model-dropdown-content">
              {modelLoading ? (
                <div className="model-dropdown-empty">加载中...</div>
              ) : modelList.length === 0 ? (
                <div className="model-dropdown-empty">
                  暂无可用模型<br/>
                  <span style={{ fontSize: 11 }}>请在「设置 → 服务端连接」配置 AppKey/AppSecret</span>
                </div>
              ) : (
                modelProviders.map(provider => {
                  const providerModels = modelList.filter(m => m.provider_id === provider.id)
                  if (providerModels.length === 0) return null
                  return (
                    <div key={provider.id}>
                      <div className="model-group-label">
                        {provider.display_name || provider.name || '模型'}
                      </div>
                      {providerModels.map(model => (
                        <div
                          key={model.model_id}
                          className={`model-item ${selectedModelId === model.model_id ? 'selected' : ''}`}
                          onClick={() => handleSelectModel(model.model_id, modelList, modelProviders)}
                        >
                          <span className="model-item-name">
                            {model.display_name || model.model_id}
                          </span>
                          <div className="model-item-tags">
                            {String(model.supports_vision) === '1' && (
                              <span className="model-tag vision">图片</span>
                            )}
                            {String(model.supports_tools) === '1' && (
                              <span className="model-tag">工具</span>
                            )}
                          </div>
                          {selectedModelId === model.model_id && (
                            <span className="model-item-check">✓</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )}

        {/* 输入框 */}
        <div className="input-box-wrapper">
          <textarea
            className="unified-input"
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px'
            }}
            onKeyDown={handleKeyDown}
            placeholder={agentMode ? 'Agent 模式：输入任务，AI 自主决策调用工具完成...' : '输入问题或任务，AI自主决策调用工具...'}
            rows={1}
            disabled={loading}
          />
          {/* 底部工具栏：模型选择 + 发送 */}
          <div className="sender-bar">
            <button
              className={`model-pill-btn ${showModelDropdown ? 'open' : ''}`}
              onClick={() => setShowModelDropdown(!showModelDropdown)}
              title="切换模型"
            >
              <span className="model-pill-name">
                {modelLoading ? '加载中' : (currentModelInfo?.displayName || '选择模型')}
              </span>
              <svg className="model-pill-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9" style={{ transform: showModelDropdown ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
              </svg>
            </button>
            <div className="sender-right">
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
      </div>

      {/* 自定义 Modal 弹窗（绝对定位在面板内，避免被 BrowserView 遮挡） */}
      {modal && (
        <div className="modal-overlay" onClick={() => { modal.resolve(null); setModal(null) }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{modal.title}</span>
              <button className="modal-close" onClick={() => { modal.resolve(null); setModal(null) }}>✕</button>
            </div>
            {modal.type === 'single' ? (
              <>
                <div className="modal-body">
                  <div className="modal-message">{modal.message}</div>
                  <input
                    className="modal-input"
                    type="text"
                    autoFocus
                    value={modal.value}
                    onChange={(e) => setModal({ ...modal, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { modal.resolve(modal.value); setModal(null) }
                      if (e.key === 'Escape') { modal.resolve(null); setModal(null) }
                    }}
                    placeholder={modal.placeholder}
                  />
                </div>
                <div className="modal-footer">
                  <button className="modal-btn modal-btn-cancel" onClick={() => { modal.resolve(null); setModal(null) }}>取消</button>
                  <button className="modal-btn modal-btn-confirm" onClick={() => { modal.resolve(modal.value); setModal(null) }}>确定</button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-body">
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>脚本名称</label>
                    <input
                      className="modal-input"
                      type="text"
                      autoFocus
                      value={modal.nameValue}
                      onChange={(e) => setModal({ ...modal, nameValue: e.target.value })}
                      placeholder="请输入脚本名称"
                    />
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>脚本描述（可选）</label>
                    <input
                      className="modal-input"
                      type="text"
                      value={modal.descValue}
                      onChange={(e) => setModal({ ...modal, descValue: e.target.value })}
                      placeholder="请输入脚本描述"
                    />
                  </div>
                  {modal.type === 'upload' && (
                    <>
                      <div style={{ marginBottom: 12 }}>
                        <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>URL 匹配模式</label>
                        <input
                          className="modal-input"
                          type="text"
                          value={modal.urlPatternValue || '*'}
                          onChange={(e) => setModal({ ...modal, urlPatternValue: e.target.value })}
                          placeholder="* 匹配所有页面，如 *example.com*"
                        />
                      </div>
                      <div style={{ marginBottom: 12 }}>
                        <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>工具类型</label>
                        <select
                          className="modal-input"
                          value={modal.toolTypeValue || 'js'}
                          onChange={(e) => setModal({ ...modal, toolTypeValue: e.target.value })}
                          style={{ cursor: 'pointer' }}
                        >
                          <option value="js">JS 脚本（页面注入执行）</option>
                          <option value="api">API 脚本（后端接口调用）</option>
                        </select>
                      </div>
                    </>
                  )}
                </div>
                <div className="modal-footer">
                  <button className="modal-btn modal-btn-cancel" onClick={() => { modal.resolve(null); setModal(null) }}>取消</button>
                  <button className="modal-btn modal-btn-confirm" onClick={() => {
                    if (modal.type === 'upload') {
                      modal.resolve({ name: modal.nameValue, description: modal.descValue, urlPattern: modal.urlPatternValue, toolType: modal.toolTypeValue })
                    } else {
                      modal.resolve({ name: modal.nameValue, description: modal.descValue })
                    }
                    setModal(null)
                  }}>
                    {modal.type === 'save' ? '保存' : '上传'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
