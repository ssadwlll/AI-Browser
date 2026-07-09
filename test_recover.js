// 测试 _recoverTodoItemsFromString
function _recoverTodoItemsFromString(str) {
  if (typeof str !== 'string') return null
  const trimmed = str.trim().replace(/^\[/, '').replace(/\]$/, '').trim()
  if (!trimmed) return null
  const itemStrs = trimmed.split(/\}\s*,\s*\{/).map((s, i) => {
    if (i === 0) return s.replace(/^\s*\{/, '')
    if (i === trimmed.split(/\}\s*,\s*\{/).length - 1) return s.replace(/\}\s*$/, '')
    return s
  })
  const items = []
  for (const itemStr of itemStrs) {
    const item = {}
    const fieldPattern = /"(\w+)"\s*:\s*"/g
    const matches = []
    let m
    while ((m = fieldPattern.exec(itemStr)) !== null) {
      matches.push({ key: m[1], valueStart: m.index + m[0].length })
    }
    matches.sort((a, b) => a.valueStart - b.valueStart)
    for (let i = 0; i < matches.length; i++) {
      const { key, valueStart } = matches[i]
      const nextFieldStart = i + 1 < matches.length ? matches[i + 1].valueStart : itemStr.length
      const segment = itemStr.slice(valueStart, nextFieldStart)
      const lastQuote = segment.lastIndexOf('"')
      let value = lastQuote >= 0 ? segment.slice(0, lastQuote) : segment
      value = value.replace(/,\s*$/, '').trim()
      value = value.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\')
      item[key] = value
    }
    const nonStrPattern = /"(\w+)"\s*:\s*(true|false|\d+\.?\d*)/g
    while ((m = nonStrPattern.exec(itemStr)) !== null) {
      if (!(m[1] in item)) {
        item[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2])
      }
    }
    if (Object.keys(item).length > 0) items.push(item)
  }
  return items.length > 0 ? items : null
}

// err.json 里的实际数据（含未转义引号 "送"）
const items = `\n[{"action": "inject_script_9", "description": "采集第1篇新闻详情：多家温企回购股份"送"员工", "id": "t1", "url": "https://news.66wz.com/system/2026/07/01/105796374.shtml"}, {"action": "inject_script_9", "description": "采集第2篇新闻详情：温企北交所扩容", "id": "t2", "url": "https://news.66wz.com/system/2026/07/01/105796373.shtml"}, {"action": "generate_script", "description": "整合所有新闻数据", "id": "t11"}]\n`

console.log('原始 JSON.parse 结果:')
try { JSON.parse(items) } catch (e) { console.log('  失败:', e.message) }

console.log('\n容错恢复结果:')
const result = _recoverTodoItemsFromString(items)
console.log(JSON.stringify(result, null, 2))
