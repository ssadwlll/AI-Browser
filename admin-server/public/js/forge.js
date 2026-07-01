// ============ P5: Skill Forge — 智能脚本生成 ============

async function loadForgePage() {
  // 加载分类选择框
  try {
    const res = await api('GET', '/api/stats/categories')
    const sel = document.getElementById('forgeCategory')
    if (res.success && res.data) {
      sel.innerHTML = res.data.map(c => `<option value="${c.id}">${c.name}</option>`).join('')
    }
  } catch (e) { console.error(e) }
}

async function analyzePageForForge() {
  const url = document.getElementById('forgeUrl').value.trim()
  const resultArea = document.getElementById('forgeResult')
  const codeArea = document.getElementById('forgeCode')
  const saveBtn = document.getElementById('forgeSaveBtn')
  const metaPreview = document.getElementById('forgeMetaPreview')
  const errorEl = document.getElementById('forgeError')
  const analyzeBtn = document.getElementById('forgeAnalyzeBtn')

  if (!url) {
    errorEl.textContent = '请输入目标页面URL'
    errorEl.style.display = 'block'
    return
  }
  errorEl.style.display = 'none'
  resultArea.classList.add('hidden')
  analyzeBtn.disabled = true
  analyzeBtn.textContent = '分析中...'

  try {
    const res = await api('POST', '/api/forge/analyze', { url })
    if (!res.success) {
      errorEl.textContent = res.message || res.error || '分析失败'
      errorEl.style.display = 'block'
      return
    }

    const data = res.data
    // 显示分析结果
    document.getElementById('forgePageTitle').textContent = data.analysis.title || '页面分析'
    document.getElementById('forgeSelectors').innerHTML = data.analysis.selectors.map(s => `<code style="background:var(--bg);padding:2px 6px;border-radius:3px;margin:2px;display:inline-block;font-size:11px">.${esc(s).slice(0,30)}</code>`).join(' ') || '<span style="color:var(--text2)">未检测到</span>'
    document.getElementById('forgeLinks').innerHTML = data.analysis.links.map(l => `<div style="font-size:11px;color:var(--text2);word-break:break-all">${esc(l)}</div>`).join('') || '<span style="color:var(--text2)">无</span>'
    document.getElementById('forgeItems').innerHTML = data.analysis.listItems.map(it => `<div style="font-size:11px;margin-bottom:2px">• ${esc(it).slice(0,80)}</div>`).join('') || '<span style="color:var(--text2)">无</span>'

    // 显示生成的代码
    codeArea.textContent = data.result.scriptCode
    // 显示元数据建议
    const meta = data.result.suggestedMeta
    metaPreview.innerHTML = `
      <div style="margin-bottom:4px"><strong>建议名称:</strong> <code>${esc(data.result.suggestedName)}</code></div>
      <div style="margin-bottom:4px"><strong>触发词:</strong> <span style="color:var(--primary)">${(meta.triggers||[]).join(', ') || '-'}</span></div>
      <div style="margin-bottom:4px"><strong>平台:</strong> ${(meta.platforms||[]).join(', ') || '-'}</div>
      <div style="margin-bottom:4px"><strong>分页:</strong> ${(meta.pagination||{}).strategy||'无'} (上限${(meta.pagination||{}).maxPages||0}次)</div>
      <div style="margin-bottom:4px"><strong>成功标准:</strong> ${esc(meta.success_criteria||'')}</div>
      <div style="margin-bottom:4px"><strong>生成方式:</strong> ${data.result.usedAI ? 'AI 智能生成' : '模板生成 (AI不可用)'}</div>
    `

    resultArea.classList.remove('hidden')
    // 缓存建议元数据用于保存
    codeArea.__suggestedMeta = meta
    codeArea.__suggestedName = data.result.suggestedName
    saveBtn.style.display = ''
    toast('页面分析完成' + (data.result.usedAI ? ' (AI生成)' : ' (模板)'), 'success')
  } catch (e) {
    errorEl.textContent = '网络错误: ' + e.message
    errorEl.style.display = 'block'
  } finally {
    analyzeBtn.disabled = false
    analyzeBtn.textContent = '分析并生成脚本'
  }
}

async function saveForgedScript() {
  const code = document.getElementById('forgeCode').textContent
  const meta = document.getElementById('forgeCode').__suggestedMeta || {}
  const suggestedName = document.getElementById('forgeCode').__suggestedName || 'generated-script'
  const url = document.getElementById('forgeUrl').value.trim()

  if (!code) { toast('没有代码可保存', 'error'); return }

  // 弹出一个快速配置框
  const name = prompt('脚本名称:', suggestedName) || suggestedName
  const catSelect = document.getElementById('forgeCategory')
  const category_id = catSelect?.value
  if (!category_id) { toast('请先选择分类', 'error'); return }

  try {
    // 创建 Blob 并上传
    const blob = new Blob([code], { type: 'application/javascript' })
    const formData = new FormData()
    formData.append('name', name)
    formData.append('description', `自动生成的页面采集脚本\n目标URL: ${url}\n生成时间: ${new Date().toLocaleString()}`)
    formData.append('category_id', category_id)
    formData.append('version', '1.0.0')
    formData.append('url_pattern', new URL(url).hostname + '/*')
    formData.append('tool_type', 'js')
    formData.append('metadata', JSON.stringify(meta))
    formData.append('script', blob, name + '.js')

    const res = await api('POST', '/api/scripts', formData, true)
    if (res.success) {
      toast('脚本「' + name + '」已保存到工具库', 'success')
      document.getElementById('forgeResult').classList.add('hidden')
      document.getElementById('forgeSaveBtn').style.display = 'none'
    } else {
      toast('保存失败: ' + (res.message || res.error), 'error')
    }
  } catch (e) {
    toast('保存异常: ' + e.message, 'error')
  }
}
