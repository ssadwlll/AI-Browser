// ============ 数据报告独立窗口（BrowserWindow） ============
// Agent 完成任务后自动弹出，展示结构化数据报告
// 通过 IPC report:data 接收数据，加载时也可主动获取缓存数据
//
// 渲染分流（参考 chrome-extension/sidepanel.js 的 renderDataReport）：
//   renderType='html'      → sandboxed iframe 渲染 AI 生成的 HTML
//   renderType='template'  → 模板引擎渲染，显示模板切换栏，用户可切换模板
//   无 renderType          → 数组→表格，对象→字段卡片网格

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { renderTemplate } from '../shared/template-engine.js'
import { getMergedTemplates, getTemplateById, loadRemoteTemplates, BUILTIN_TEMPLATES } from '../shared/report-templates.js'

// ============ 工具函数 ============

// 从对象按点分路径取值，如 _resolveDataPath({attrs:{href:'x'}}, 'attrs.href') → 'x'
// 不含点时直接按整字符串作为 key 取（兼容旧用法）
function _resolveDataPath(obj, path) {
  if (!obj || typeof obj !== 'object' || typeof path !== 'string') return undefined
  if (!path.includes('.')) return obj[path]
  const parts = path.split('.')
  let val = obj
  for (const p of parts) {
    if (val === null || val === undefined) return undefined
    val = val[p]
  }
  return val
}

// 应用字段映射：fieldMapping 格式 { template_field: data_field }
// data_field 支持嵌套路径，如 "attrs.href"
// 把每条数据的 data_field 改名为 template_field（保留原始字段）
function applyFieldMapping(data, fieldMapping) {
  if (!fieldMapping || typeof fieldMapping !== 'object') return data
  const arr = Array.isArray(data) ? data : []
  return arr.map(item => {
    if (!item || typeof item !== 'object') return item
    const mapped = { ...item }
    for (const [tmplField, dataField] of Object.entries(fieldMapping)) {
      if (dataField === tmplField) continue
      const val = _resolveDataPath(item, dataField)
      if (val !== undefined) mapped[tmplField] = val
    }
    return mapped
  })
}

// 构造模板上下文：data_table 特殊处理（提取 headers/rows），其余用 { items }
function buildTemplateContext(template, mappedData) {
  if (template.id === 'data_table') {
    if (!Array.isArray(mappedData) || mappedData.length === 0) {
      return { headers: [], rows: [] }
    }
    const headers = Object.keys(mappedData[0])
    const rows = mappedData.map(rowItem =>
      headers.map(h => {
        const val = rowItem?.[h]
        if (val === null || val === undefined) return ''
        if (typeof val === 'object') return JSON.stringify(val)
        return String(val).slice(0, 500) // 单元格内容截断到 500 字符
      })
    )
    return { headers, rows }
  }
  return { items: Array.isArray(mappedData) ? mappedData : [mappedData] }
}

// 用 Web Crypto API 生成 AppKey 签名鉴权头（HMAC-SHA256）
// 算法与 electron/services/config_service.js generateAuthHeaders 一致：
//   message = appKey + timestamp; sign = HMAC-SHA256(appSecret, message) → hex
async function _generateAuthHeaders(appKey, appSecret) {
  const headers = { 'Content-Type': 'application/json' }
  if (!appKey || !appSecret) return headers
  const timestamp = Date.now().toString()
  const message = appKey + timestamp
  try {
    const enc = new TextEncoder()
    const cryptoKey = await crypto.subtle.importKey(
      'raw', enc.encode(appSecret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    )
    const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message))
    const sigHex = Array.from(new Uint8Array(sigBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('')
    headers['X-App-Key'] = appKey
    headers['X-Timestamp'] = timestamp
    headers['X-Sign'] = sigHex
  } catch { /* Web Crypto 不可用时降级为无签名请求 */ }
  return headers
}

// 远程报告模板加载器（供 loadRemoteTemplates 使用）
// 通过 window.api.config.getSync() 获取服务器地址与 AppKey，再 fetch 拉取已发布模板
// 任何环节失败返回空数组，由 loadRemoteTemplates → getMergedTemplates 自动降级为内置模板
async function fetchRemoteReportTemplates() {
  const api = window.api
  if (!api?.config?.getSync) return []
  let syncConfig
  try {
    const res = await api.config.getSync()
    syncConfig = res?.success ? res.data : res
  } catch { return [] }
  if (!syncConfig || !syncConfig.serverUrl) return []
  const baseUrl = String(syncConfig.serverUrl).replace(/\/+$/, '')
  const headers = await _generateAuthHeaders(syncConfig.appKey, syncConfig.appSecret)
  // 10s 超时
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const resp = await fetch(`${baseUrl}/api/report-templates`, { headers, signal: controller.signal })
    clearTimeout(timer)
    if (!resp.ok) return []
    const json = await resp.json()
    if (json && json.success && Array.isArray(json.data)) return json.data
    if (Array.isArray(json)) return json
    return []
  } catch { clearTimeout(timer); return [] }
}

// ============ 通用渲染组件：数组表格 / 对象字段网格 ============

function DataTable({ arr, schema }) {
  if (arr.length === 0) return <div className="rw-empty">(空数组)</div>
  const isArrayOfPrimitives = arr.every(x => typeof x !== 'object' || x === null)
  if (isArrayOfPrimitives) {
    return (
      <div className="rw-data-list">
        {arr.map((v, i) => (
          <div className="rw-data-list-item" key={i}>
            <span className="rw-data-list-idx">{i}</span>
            <span className="rw-data-list-val">{String(v)}</span>
          </div>
        ))}
      </div>
    )
  }
  const keys = schema ? Object.keys(schema) : Object.keys(arr[0] || {})
  if (keys.length === 0) return <div className="rw-empty">(无字段)</div>
  const MAX_ROWS = 200
  const displayRows = arr.length > MAX_ROWS ? arr.slice(0, MAX_ROWS) : arr

  const renderCell = (v) => {
    if (v === null || v === undefined) return <span className="rw-null">null</span>
    if (typeof v === 'object') return <span className="rw-obj-preview" title={JSON.stringify(v).slice(0, 200)}>{JSON.stringify(v).slice(0, 50)}</span>
    if (typeof v === 'string' && v.length > 80) return <span title={v}>{v.slice(0, 80)}...</span>
    return String(v)
  }

  return (
    <>
      <div className="rw-table-wrap">
        <table className="rw-table">
          <thead>
            <tr>
              <th>#</th>
              {keys.map(k => <th key={k} title={schema?.[k] || ''}>{k}<span className="rw-col-type">{schema?.[k] || ''}</span></th>)}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, i) => (
              <tr key={i}>
                <td className="rw-row-idx">{i}</td>
                {keys.map(k => <td key={k}>{renderCell(row?.[k])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {arr.length > MAX_ROWS && <div className="rw-more-rows">仅显示前 {MAX_ROWS} 行，共 {arr.length} 行</div>}
    </>
  )
}

function DataFieldGrid({ obj }) {
  const keys = Object.keys(obj)
  if (keys.length === 0) return <div className="rw-empty">(空对象)</div>
  const renderVal = (v) => {
    if (v === null || v === undefined) return <span className="rw-null">null</span>
    if (Array.isArray(v)) return <><span className="rw-type-badge">Array({v.length})</span><span className="rw-obj-preview">{JSON.stringify(v).slice(0, 80)}</span></>
    if (typeof v === 'object') return <><span className="rw-type-badge">Object</span><span className="rw-obj-preview">{JSON.stringify(v).slice(0, 80)}</span></>
    if (typeof v === 'string' && v.length > 100) return <span title={v}>{v.slice(0, 100)}...</span>
    return String(v)
  }
  return (
    <div className="rw-fields-grid">
      {keys.map(k => (
        <div className="rw-field" key={k}>
          <div className="rw-field-key">{k}</div>
          <div className="rw-field-val">{renderVal(obj[k])}</div>
        </div>
      ))}
    </div>
  )
}

// ============ HTML 报告 iframe（renderType='html'）============
// sandbox="allow-same-origin"（无 allow-scripts）：禁用 AI 写的 <script>，父窗口仍可读取高度
function HtmlReportIframe({ htmlContent }) {
  const iframeRef = useRef(null)

  const wrappedHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; padding: 12px; color: #262626; line-height: 1.6; background:#fff; }
  img { max-width: 100%; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th, td { border: 1px solid #e5e5e5; padding: 8px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  a { color: #6841ea; }
  h1 { font-size: 20px; } h2 { font-size: 16px; } h3 { font-size: 14px; }
  p { margin: 6px 0; }
  ul, ol { margin: 6px 0; padding-left: 20px; }
  .card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px; margin: 8px 0; }
  .card-title { font-weight: 600; font-size: 15px; margin-bottom: 6px; }
  .card-meta { font-size: 12px; color: #8c8c8c; margin-bottom: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  </style></head><body>${htmlContent}</body></html>`

  const adjustHeight = useCallback(() => {
    try {
      const doc = iframeRef.current?.contentDocument
      if (doc && doc.body) {
        const newHeight = doc.body.scrollHeight
        // 只增高不减低，避免内容加载过程中高度抖动
        if (newHeight > (parseInt(iframeRef.current.style.height) || 0)) {
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
        new MutationObserver(adjustHeight).observe(doc.body, { childList: true, subtree: true, attributes: true })
      }
    } catch { /* */ }
  }, [adjustHeight])

  return (
    <div className="rw-html-wrap">
      <iframe
        ref={iframeRef}
        className="rw-html-iframe"
        sandbox="allow-same-origin allow-popups allow-top-navigation"
        srcDoc={wrappedHtml}
        onLoad={handleLoad}
        title="html-report"
      />
    </div>
  )
}

// ============ 模板报告 iframe（renderType='template' 的渲染结果）============
// 把模板引擎渲染出的 HTML 包进 iframe，注入模板自带的 css，隔离样式
function TemplateReportIframe({ template, mappedData }) {
  const iframeRef = useRef(null)

  // 构造上下文 + 渲染
  const { html, error } = useMemo(() => {
    if (!template || !template.template) return { html: '', error: '模板无效' }
    try {
      const context = buildTemplateContext(template, mappedData)
      return { html: renderTemplate(template.template, context), error: '' }
    } catch (e) {
      return { html: '', error: `模板渲染失败: ${e.message}` }
    }
  }, [template, mappedData])

  if (error) return <div className="rw-empty">{error}</div>

  const wrappedHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; padding: 12px; color: #262626; line-height: 1.6; background:#fff; }
  img { max-width: 100%; }
  ${template.css || ''}
  </style></head><body>${html}</body></html>`

  const adjustHeight = () => {
    try {
      const doc = iframeRef.current?.contentDocument
      if (doc && doc.body) {
        const newHeight = doc.body.scrollHeight
        if (newHeight > (parseInt(iframeRef.current.style.height) || 0)) {
          iframeRef.current.style.height = `${newHeight + 20}px`
        }
      }
    } catch { /* */ }
  }

  const handleLoad = () => {
    adjustHeight()
    setTimeout(adjustHeight, 100)
    setTimeout(adjustHeight, 500)
    setTimeout(adjustHeight, 1500)
    try {
      const doc = iframeRef.current?.contentDocument
      if (doc && doc.body) {
        new MutationObserver(adjustHeight).observe(doc.body, { childList: true, subtree: true, attributes: true })
      }
    } catch { /* */ }
  }

  return (
    <div className="rw-html-wrap">
      <iframe
        ref={iframeRef}
        className="rw-html-iframe"
        sandbox="allow-same-origin allow-popups allow-top-navigation"
        srcDoc={wrappedHtml}
        onLoad={handleLoad}
        title="template-report"
      />
    </div>
  )
}

// ============ 模板报告内容（含切换栏）============
// 仅 renderType='template' 使用：显示所有可用模板的切换按钮，初始用 AI 选的 templateId
function TemplateReportContent({ item, templates }) {
  const { data, templateId, fieldMapping } = item

  // 应用字段映射后的数据（缓存，切换模板时复用）
  const mappedData = useMemo(() => applyFieldMapping(data, fieldMapping), [data, fieldMapping])

  // 当前选中的模板 id：初始用 AI 选的 templateId，找不到则用第一个
  const allTemplates = templates && templates.length > 0 ? templates : BUILTIN_TEMPLATES
  const initialTemplate = useMemo(
    () => getTemplateById(templateId) || allTemplates[0] || BUILTIN_TEMPLATES[0],
    [templateId, allTemplates]
  )
  const [currentId, setCurrentId] = useState(initialTemplate?.id || (allTemplates[0]?.id))

  const currentTemplate = useMemo(
    () => allTemplates.find(t => t.id === currentId) || getTemplateById(currentId) || initialTemplate,
    [currentId, allTemplates, initialTemplate]
  )

  if (allTemplates.length === 0) {
    return <div className="rw-empty">(无可用模板)</div>
  }

  return (
    <>
      {/* 模板切换栏 */}
      <div className="rw-template-switch" style={{
        display: 'flex', flexWrap: 'wrap', gap: '6px',
        padding: '8px 0', borderBottom: '1px solid var(--border)', marginBottom: '8px',
      }}>
        {allTemplates.map(t => (
          <button
            key={t.id}
            className="rw-template-switch-btn"
            onClick={() => setCurrentId(t.id)}
            title={t.description || t.name}
            style={{
              padding: '4px 10px', fontSize: '11px', cursor: 'pointer',
              borderRadius: '6px', border: '1px solid var(--border)',
              background: t.id === currentId ? 'var(--accent)' : 'var(--bg-tertiary)',
              color: t.id === currentId ? '#fff' : 'var(--text-secondary)',
              transition: 'all 0.2s',
            }}
          >
            {t.name}
          </button>
        ))}
      </div>
      {/* 渲染区域：iframe 包裹模板引擎渲染结果 */}
      <TemplateReportIframe template={currentTemplate} mappedData={mappedData} />
    </>
  )
}

// ============ 数据区块内容：按 renderType 分流 ============
function DataReportContent({ item, templates }) {
  const { data, renderType, schema } = item

  // renderType='html': AI 生成的 HTML 报告，用 sandboxed iframe 渲染
  if (renderType === 'html' && typeof data === 'string') {
    return <HtmlReportIframe htmlContent={data} />
  }

  // renderType='template': 模板引擎渲染 + 模板切换栏
  if (renderType === 'template') {
    return <TemplateReportContent item={item} templates={templates} />
  }

  // 数组 → 表格
  if (Array.isArray(data)) return <DataTable arr={data} schema={schema} />
  // 对象 → 字段卡片网格
  if (data && typeof data === 'object') return <DataFieldGrid obj={data} />
  // 基本类型
  return <div className="rw-primitive">{String(data)}</div>
}

// ============ 数据区块（可折叠）============
function DataReportSection({ item, defaultExpanded, templates }) {
  const { id, toolName, schema, data, renderType, reportTitle, count: itemCount } = item
  const count = typeof itemCount === 'number'
    ? itemCount
    : (Array.isArray(data) ? data.length : (data && typeof data === 'object' ? Object.keys(data).length : 1))
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

  const title = reportTitle || toolName || '数据'

  return (
    <div className="rw-section">
      <div className="rw-section-header" onClick={() => setExpanded(e => !e)}>
        <span className="rw-section-toggle">{expanded ? '▼' : '▶'}</span>
        <span className="rw-section-id">{id}</span>
        <span className="rw-section-meta">{title} · {count} 条</span>
        {renderType && (
          <span className="rw-section-meta" style={{ fontSize: '10px', color: 'var(--text-secondary)', flex: '0 0 auto' }}>
            [{renderType}]
          </span>
        )}
      </div>
      {expanded && (
        <div className="rw-section-body">
          {data && data._truncated && <div className="rw-truncated-warn">⚠ 数据量过大，已截断显示前部分</div>}
          <DataReportContent item={item} templates={templates} />
          <div className="rw-section-actions">
            <button className="rw-copy-btn" onClick={handleCopy}>{copied ? '已复制' : '复制 JSON'}</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ============ 主组件 ============
export default function ReportWindow() {
  const [reportData, setReportData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [templates, setTemplates] = useState(() => getMergedTemplates())

  useEffect(() => {
    let unsubData = null

    // 1. 主动获取缓存的报告数据
    window.api?.reportWindow?.getData().then(data => {
      console.log('[ReportWindow] 获取缓存数据:', data?.items?.length || 0, 'items')
      if (data && data.items && data.items.length > 0) {
        setReportData(data)
      }
      setLoading(false)
    }).catch(() => setLoading(false))

    // 2. 监听 report:data 事件（窗口已打开时收到新报告）
    const onData = window.api?.reportWindow?.onData((data) => {
      console.log('[ReportWindow] 收到 report:data 事件:', data?.items?.length || 0, 'items')
      if (data && data.items && data.items.length > 0) {
        setReportData(data)
      }
    })
    if (typeof onData === 'function') unsubData = onData

    // 3. 尝试加载后端远程报告模板（失败降级为内置 4 个模板）
    loadRemoteTemplates(fetchRemoteReportTemplates)
      .then(merged => {
        setTemplates(merged && merged.length > 0 ? merged : getMergedTemplates())
        console.log('[ReportWindow] 报告模板加载完成:', merged?.length || 0, '个模板')
      })
      .catch(() => {
        // 降级：使用内置模板
        setTemplates(getMergedTemplates())
      })

    return () => { if (unsubData) unsubData() }
  }, [])

  const handleClose = async () => {
    console.log('[ReportWindow] handleClose 被调用')

    // 多层兜底：IPC → window.close()
    try {
      if (window.api?.closeReportWindow) {
        await window.api.closeReportWindow()
      } else if (window.api?.reportWindow?.close) {
        await window.api.reportWindow.close()
      }
    } catch (e) {
      console.error('[ReportWindow] IPC 关闭失败:', e)
    }

    // IPC 仍未关闭则直接调用 window.close()
    if (!window.closed) {
      console.log('[ReportWindow] 兜底调用 window.close()')
      window.close()
    }
  }

  const items = reportData?.items || []
  const summary = reportData?.summary || ''

  return (
    <div className="rw-window-root">
      {/* 可拖拽标题栏 */}
      <div className="rw-window-titlebar">
        <span className="rw-window-title">📊 数据报告</span>
        <div className="rw-window-actions">
          <button className="rw-window-close" onClick={handleClose}>✕</button>
        </div>
      </div>
      {/* 摘要栏 */}
      {summary && (
        <div className="rw-summary-bar">
          <span className="rw-summary-text">{summary}</span>
        </div>
      )}
      {/* 内容区 */}
      <div className="rw-content">
        {loading ? (
          <div className="rw-loading">加载报告数据...</div>
        ) : items.length === 0 ? (
          <div className="rw-empty-full">暂无数据报告<br /><span style={{ fontSize: '11px', opacity: 0.6 }}>Agent 任务完成后，采集的数据将在此窗口展示</span></div>
        ) : (
          <div className="rw-report-list">
            {items.map((item, idx) => (
              <DataReportSection
                key={item.id || idx}
                item={item}
                defaultExpanded={idx === 0}
                templates={templates}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
