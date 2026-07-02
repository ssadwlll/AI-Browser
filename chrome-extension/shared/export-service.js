// ============ 结果导出服务 ============
// Feature 21: 支持 JSON / CSV / Markdown / HTML 多种导出格式

import { escapeHtml, safeJsonStringify } from './utils.js'

export const ExportService = {
  /**
   * 导出数据为指定格式并触发下载
   * @param {object[]|object} data - 要导出的数据
   * @param {object} options - { format: 'json'|'csv'|'markdown'|'html', filename, title, columns }
   */
  async export(data, options = {}) {
    const { format = 'json', filename, title = '导出数据', columns } = options
    const ext = this._getExtension(format)
    const name = filename || `${title.replace(/\s+/g, '_')}_${this._dateStr()}.${ext}`
    let content, mime

    switch (format) {
      case 'json':
        content = safeJsonStringify(data, null, 2)
        mime = 'application/json'
        break
      case 'csv':
        content = this._toCSV(data, columns)
        mime = 'text/csv'
        break
      case 'markdown':
      case 'md':
        content = this._toMarkdown(data, title, columns)
        mime = 'text/markdown'
        break
      case 'html':
        content = this._toHTML(data, title, columns)
        mime = 'text/html'
        break
      case 'txt':
        content = this._toText(data)
        mime = 'text/plain'
        break
      default:
        return { ok: false, error: `不支持的格式: ${format}` }
    }

    this._download(content, name, mime)
    return { ok: true, filename: name, size: content.length }
  },

  /**
   * 导出为 CSV 格式
   */
  _toCSV(data, columns) {
    const arr = Array.isArray(data) ? data : [data]
    if (arr.length === 0) return ''
    // 确定列
    const cols = columns || Object.keys(arr[0])
    const escape = (val) => {
      if (val == null) return ''
      const s = typeof val === 'object' ? safeJsonStringify(val) : String(val)
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`
      }
      return s
    }
    const header = cols.map(escape).join(',')
    const rows = arr.map(row => cols.map(c => escape(row[c])).join(','))
    return [header, ...rows].join('\n')
  },

  /**
   * 导出为 Markdown 表格
   */
  _toMarkdown(data, title, columns) {
    const arr = Array.isArray(data) ? data : [data]
    let md = `# ${title}\n\n`
    md += `> 导出时间: ${new Date().toLocaleString('zh-CN')}\n`
    md += `> 数据条数: ${arr.length}\n\n`

    if (arr.length === 0) {
      md += '*无数据*\n'
      return md
    }

    const cols = columns || Object.keys(arr[0])
    // 表头
    md += `| ${cols.join(' | ')} |\n`
    md += `| ${cols.map(() => '---').join(' | ')} |\n`
    // 数据行
    for (const row of arr) {
      const cells = cols.map(c => {
        const v = row[c]
        if (v == null) return ''
        if (typeof v === 'object') return safeJsonStringify(v).slice(0, 50)
        return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')
      })
      md += `| ${cells.join(' | ')} |\n`
    }
    return md
  },

  /**
   * 导出为 HTML 表格
   */
  _toHTML(data, title, columns) {
    const arr = Array.isArray(data) ? data : [data]
    const cols = columns || (arr[0] ? Object.keys(arr[0]) : [])
    let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: -apple-system, 'Segoe UI', 'PingFang SC', sans-serif; margin: 24px; color: #1a1a2e; }
h1 { font-size: 20px; }
table { border-collapse: collapse; width: 100%; margin-top: 16px; }
th, td { border: 1px solid #e0e0e0; padding: 8px 12px; text-align: left; }
th { background: #f5f5f7; font-weight: 600; font-size: 13px; }
td { font-size: 13px; }
tr:hover { background: #fafafa; }
.meta { color: #888; font-size: 12px; margin-top: 4px; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">导出时间: ${new Date().toLocaleString('zh-CN')} | 数据条数: ${arr.length}</div>
`
    if (arr.length === 0) {
      html += '<p>无数据</p>\n'
    } else {
      html += '<table>\n<thead><tr>'
      for (const c of cols) html += `<th>${escapeHtml(c)}</th>`
      html += '</tr></thead>\n<tbody>\n'
      for (const row of arr) {
        html += '<tr>'
        for (const c of cols) {
          const v = row[c]
          const display = v == null ? '' : (typeof v === 'object' ? escapeHtml(safeJsonStringify(v)) : escapeHtml(String(v)))
          html += `<td>${display}</td>`
        }
        html += '</tr>\n'
      }
      html += '</tbody>\n</table>\n'
    }
    html += '</body>\n</html>'
    return html
  },

  /**
   * 导出为纯文本
   */
  _toText(data) {
    if (typeof data === 'string') return data
    return safeJsonStringify(data, null, 2)
  },

  /**
   * 触发浏览器下载
   */
  _download(content, filename, mime) {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    setTimeout(() => {
      URL.revokeObjectURL(url)
      a.remove()
    }, 100)
  },

  _getExtension(format) {
    const map = { json: 'json', csv: 'csv', markdown: 'md', md: 'md', html: 'html', txt: 'txt' }
    return map[format] || 'txt'
  },

  _dateStr() {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`
  },

  /**
   * 获取支持的格式列表（供 UI 下拉选择）
   */
  getSupportedFormats() {
    return [
      { value: 'json', label: 'JSON' },
      { value: 'csv', label: 'CSV 表格' },
      { value: 'markdown', label: 'Markdown' },
      { value: 'html', label: 'HTML 网页' },
      { value: 'txt', label: '纯文本' },
    ]
  },
}

console.log('[ExportService] 结果导出服务已加载')
