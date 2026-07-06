// ============ 报告模板管理 ============
let currentTemplatePage = 1;

// 轻量级模板渲染（与 chrome-extension/template-engine.js 兼容）
function renderTpl(template, context) {
  if (typeof template !== 'string') return '';
  const ast = _tplParse(template);
  return _tplRender(ast, context);
}

function _tplParse(template) {
  const tokens = [];
  let i = 0;
  while (i < template.length) {
    const openIdx = template.indexOf('{{', i);
    if (openIdx === -1) { tokens.push({ type: 'text', value: template.slice(i) }); break; }
    if (openIdx > i) tokens.push({ type: 'text', value: template.slice(i, openIdx) });
    const closeIdx = template.indexOf('}}', openIdx + 2);
    if (closeIdx === -1) { tokens.push({ type: 'text', value: template.slice(openIdx) }); break; }
    const expr = template.slice(openIdx + 2, closeIdx).trim();
    tokens.push(_tplParseExpr(expr));
    i = closeIdx + 2;
  }
  return _tplBuildTree(tokens);
}

function _tplParseExpr(expr) {
  if (expr.startsWith('!--') || expr.startsWith('!')) return { type: 'comment' };
  if (expr.startsWith('#')) {
    const spaceIdx = expr.indexOf(' ');
    if (spaceIdx === -1) return { type: 'block_open', name: expr.slice(1), arg: '' };
    const name = expr.slice(1, spaceIdx);
    const arg = expr.slice(spaceIdx + 1).trim();
    return { type: 'block_open', name, arg };
  }
  if (expr.startsWith('/')) return { type: 'block_close', name: expr.slice(1).trim() };
  if (expr === 'else') return { type: 'else' };
  const unescaped = expr.startsWith('{') && expr.endsWith('}');
  const varName = unescaped ? expr.slice(1, -1).trim() : expr;
  return { type: 'var', name: varName, escape: !unescaped };
}

function _tplBuildTree(tokens) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  for (const token of tokens) {
    const current = stack[stack.length - 1];
    if (token.type === 'text') current.children.push({ type: 'text', value: token.value });
    else if (token.type === 'var') current.children.push(token);
    else if (token.type === 'block_open') {
      const node = { type: 'block', name: token.name, arg: token.arg, children: [], elseChildren: null };
      current.children.push(node);
      stack.push(node);
    } else if (token.type === 'else') {
      const top = stack[stack.length - 1];
      if (top.type === 'block') top.elseChildren = [];
    } else if (token.type === 'block_close') stack.pop();
  }
  return root;
}

function _tplRender(node, context) {
  if (node.type === 'root') return (node.children || []).map(c => _tplRender(c, context)).join('');
  if (node.type === 'text') return node.value;
  if (node.type === 'var') {
    const val = _tplResolve(node.name, context);
    if (val === null || val === undefined) return '';
    const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
    return node.escape ? _tplEsc(str) : str;
  }
  if (node.type === 'block') {
    if (node.name === 'each') {
      const arr = _tplResolve(node.arg, context);
      if (!Array.isArray(arr) || arr.length === 0) {
        return node.elseChildren ? node.elseChildren.map(c => _tplRender(c, context)).join('') : '';
      }
      return arr.map((item, index) => {
        const childCtx = Object.assign({}, context, { this: item, '@index': index, '@key': index });
        if (item && typeof item === 'object' && !Array.isArray(item)) Object.assign(childCtx, item);
        return node.children.map(c => _tplRender(c, childCtx)).join('');
      }).join('');
    }
    if (node.name === 'if') {
      const cond = _tplResolve(node.arg, context);
      const truthy = !!cond && !(Array.isArray(cond) && cond.length === 0);
      return (truthy ? node.children : (node.elseChildren || [])).map(c => _tplRender(c, context)).join('');
    }
  }
  return '';
}

function _tplResolve(path, context) {
  if (!path) return undefined;
  if (path === 'this') return context.this;
  if (path === '@index') return context['@index'];
  if (path === '@key') return context['@key'];
  const parts = path.split('.');
  let val = context;
  for (const p of parts) { if (val === null || val === undefined) return undefined; val = val[p]; }
  return val;
}

function _tplEsc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============ 模板列表加载 ============
async function loadReportTemplates(page) {
  currentTemplatePage = page || 1;
  const keyword = document.getElementById('templateSearch').value.trim();
  const status = document.getElementById('templateStatusFilter').value;
  let params = `page=${currentTemplatePage}&pageSize=15`;
  if (keyword) params += '&keyword=' + encodeURIComponent(keyword);
  if (status) params += '&status=' + encodeURIComponent(status);
  try {
    const res = await api('GET', '/api/report-templates/admin?' + params);
    const tbody = document.getElementById('reportTemplateTable');
    if (res.success && res.data && res.data.length > 0) {
      tbody.innerHTML = res.data.map(t => `
        <tr>
          <td>${t.id}</td>
          <td><code style="background:#f0f0f0;padding:2px 6px;border-radius:4px;font-size:12px">${esc(t.template_id)}</code></td>
          <td>${esc(t.name)}</td>
          <td style="max-width:300px;color:var(--text2);font-size:12px">${esc(t.description||'-')}</td>
          <td>${esc(t.data_kind||'array')}</td>
          <td>${t.sort_order||0}</td>
          <td><span class="badge badge-${t.status==='published'?'published':'draft'}">${t.status}</span></td>
          <td>${fmtDate(t.updated_at)}</td>
          <td>
            <button class="btn-icon" onclick="editTemplate(${t.id})" title="编辑" style="color:var(--primary)">✏️</button>
            <button class="btn-icon" onclick="previewTemplateById(${t.id})" title="预览">👁</button>
            <button class="btn-icon danger" onclick="deleteTemplate(${t.id},'${esc(t.name)}')" title="删除">🗑</button>
          </td>
        </tr>`).join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state">暂无模板</td></tr>';
    }
    const pag = res.pagination || {};
    document.getElementById('reportTemplatePagination').innerHTML = `
      <button ${pag.page<=1?'disabled':''} onclick="loadReportTemplates(${pag.page-1})">上一页</button>
      <span>第 ${pag.page||1} / ${pag.totalPages||1} 页 (共 ${pag.total||0} 条)</span>
      <button ${pag.page>=pag.totalPages?'disabled':''} onclick="loadReportTemplates(${pag.page+1})">下一页</button>`;
  } catch(e) { console.error(e); }
}

// ============ 新建/编辑弹窗 ============
function showTemplateModal() {
  document.getElementById('templateModal').classList.remove('hidden');
  document.getElementById('templateModalTitle').textContent = '新建模板';
  document.getElementById('templateError').style.display = 'none';
  document.getElementById('tplId').value = '';
  document.getElementById('tplTemplateId').value = '';
  document.getElementById('tplTemplateId').disabled = false;
  document.getElementById('tplName').value = '';
  document.getElementById('tplDescription').value = '';
  document.getElementById('tplDataKind').value = 'array';
  document.getElementById('tplSortOrder').value = '0';
  document.getElementById('tplStatus').value = 'published';
  document.getElementById('tplFields').value = '';
  document.getElementById('tplTemplate').value = '';
  document.getElementById('tplCss').value = '';
}

function closeTemplateModal() {
  document.getElementById('templateModal').classList.add('hidden');
}

async function editTemplate(id) {
  try {
    const res = await api('GET', `/api/report-templates/admin/${id}`);
    if (!res.success) { toast('加载失败: ' + (res.error || ''), 'error'); return; }
    const t = res.data;
    document.getElementById('templateModal').classList.remove('hidden');
    document.getElementById('templateModalTitle').textContent = '编辑模板';
    document.getElementById('templateError').style.display = 'none';
    document.getElementById('tplId').value = t.id;
    document.getElementById('tplTemplateId').value = t.template_id;
    document.getElementById('tplTemplateId').disabled = false;
    document.getElementById('tplName').value = t.name;
    document.getElementById('tplDescription').value = t.description || '';
    document.getElementById('tplDataKind').value = t.data_kind || 'array';
    document.getElementById('tplSortOrder').value = t.sort_order || 0;
    document.getElementById('tplStatus').value = t.status || 'published';
    document.getElementById('tplFields').value = t.fields ? JSON.stringify(t.fields, null, 2) : '';
    document.getElementById('tplTemplate').value = t.template || '';
    document.getElementById('tplCss').value = t.css || '';
  } catch(e) { console.error(e); toast('加载失败', 'error'); }
}

async function saveTemplate() {
  const id = document.getElementById('tplId').value;
  const templateId = document.getElementById('tplTemplateId').value.trim();
  const name = document.getElementById('tplName').value.trim();
  const description = document.getElementById('tplDescription').value.trim();
  const dataKind = document.getElementById('tplDataKind').value;
  const sortOrder = parseInt(document.getElementById('tplSortOrder').value) || 0;
  const status = document.getElementById('tplStatus').value;
  const template = document.getElementById('tplTemplate').value;
  const css = document.getElementById('tplCss').value;
  const fieldsRaw = document.getElementById('tplFields').value.trim();
  const errEl = document.getElementById('templateError');

  if (!templateId || !name || !template) {
    errEl.textContent = '模板ID、名称、HTML模板为必填项';
    errEl.style.display = 'block';
    return;
  }

  let fields = null;
  if (fieldsRaw) {
    try { fields = JSON.parse(fieldsRaw); }
    catch(e) {
      errEl.textContent = '字段定义 JSON 格式错误: ' + e.message;
      errEl.style.display = 'block';
      return;
    }
  }

  errEl.style.display = 'none';
  const body = { template_id: templateId, name, description, data_kind: dataKind, sort_order: sortOrder, status, template, css, fields };

  try {
    if (id) {
      const res = await api('PUT', `/api/report-templates/admin/${id}`, body);
      if (res.success) { closeTemplateModal(); loadReportTemplates(currentTemplatePage); toast('模板更新成功', 'success'); }
      else { errEl.textContent = res.error || '更新失败'; errEl.style.display = 'block'; }
    } else {
      const res = await api('POST', '/api/report-templates/admin', body);
      if (res.success) { closeTemplateModal(); loadReportTemplates(1); toast('模板创建成功', 'success'); }
      else { errEl.textContent = res.error || '创建失败'; errEl.style.display = 'block'; }
    }
  } catch(e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
}

async function deleteTemplate(id, name) {
  if (!confirm(`确定删除模板「${name}」吗？`)) return;
  try {
    const res = await api('DELETE', `/api/report-templates/admin/${id}`);
    if (res.success) { loadReportTemplates(currentTemplatePage); toast('模板已删除', 'success'); }
    else { toast('删除失败: ' + (res.error || ''), 'error'); }
  } catch(e) { toast('删除失败: ' + e.message, 'error'); }
}

// ============ 模板预览 ============
function closeTemplatePreviewModal() {
  document.getElementById('templatePreviewModal').classList.add('hidden');
}

// 生成示例数据用于预览
function _generatePreviewData(fields, dataKind) {
  if (dataKind === 'object') {
    const obj = {};
    (fields || []).forEach(f => { obj[f.key] = `示例${f.label}`; });
    return obj;
  }
  // array
  if (!fields || fields.length === 0) {
    // data_table 风格：自动生成
    return [
      { 标题: '示例数据A', 数值: '100', 状态: '正常' },
      { 标题: '示例数据B', 数值: '200', 状态: '异常' },
      { 标题: '示例数据C', 数值: '300', 状态: '正常' },
    ];
  }
  const samples = [];
  const templates = [
    { title: '示例标题一', url: 'https://example.com/1', summary: '这是示例摘要内容，用于展示模板效果。', source: '来源A', date: '2026-07-06', description: '描述内容一', image: '', price: '99.00', label: '访问量', value: '12,345', unit: '次', trend: 'up', change: '+15%' },
    { title: '示例标题二', url: 'https://example.com/2', summary: '第二条示例摘要，展示列表渲染效果。', source: '来源B', date: '2026-07-05', description: '描述内容二', image: '', price: '199.00', label: '转化率', value: '3.2', unit: '%', trend: 'down', change: '-2%' },
    { title: '示例标题三', url: 'https://example.com/3', summary: '第三条示例摘要内容。', source: '来源C', date: '2026-07-04', description: '描述内容三', image: '', price: '299.00', label: '收入', value: '8,920', unit: '元', trend: 'flat', change: '0%' },
  ];
  for (const tmpl of templates) {
    const item = {};
    for (const f of fields) { item[f.key] = tmpl[f.key] !== undefined ? tmpl[f.key] : `示例${f.label}`; }
    samples.push(item);
  }
  return samples;
}

function previewTemplate() {
  const template = document.getElementById('tplTemplate').value;
  const css = document.getElementById('tplCss').value;
  const dataKind = document.getElementById('tplDataKind').value;
  let fields = null;
  const fieldsRaw = document.getElementById('tplFields').value.trim();
  if (fieldsRaw) { try { fields = JSON.parse(fieldsRaw); } catch(e) {} }

  if (!template) { toast('请先填写模板内容', 'error'); return; }

  const data = _generatePreviewData(fields, dataKind);
  let context;
  if (dataKind === 'object') {
    context = data;
  } else {
    // data_table 特殊处理
    if (Array.isArray(data) && data.length > 0 && !fields) {
      const headers = Object.keys(data[0]);
      const rows = data.map(row => headers.map(h => String(row[h] || '')));
      context = { headers, rows };
    } else {
      context = { items: data };
    }
  }

  let html;
  try { html = renderTpl(template, context); }
  catch(e) { toast('模板渲染失败: ' + e.message, 'error'); return; }

  const wrappedHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; padding: 12px; color: #262626; line-height: 1.6; }
    ${css || ''}
  </style></head><body>${html}</body></html>`;

  const area = document.getElementById('templatePreviewArea');
  area.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.style.width = '100%';
  iframe.style.height = '400px';
  iframe.style.border = 'none';
  iframe.sandbox = 'allow-same-origin';
  iframe.srcdoc = wrappedHtml;
  area.appendChild(iframe);

  document.getElementById('templatePreviewModal').classList.remove('hidden');
}

async function previewTemplateById(id) {
  try {
    const res = await api('GET', `/api/report-templates/admin/${id}`);
    if (!res.success) { toast('加载失败', 'error'); return; }
    const t = res.data;
    // 填充到编辑弹窗的隐藏字段，然后调用 previewTemplate
    document.getElementById('tplTemplate').value = t.template || '';
    document.getElementById('tplCss').value = t.css || '';
    document.getElementById('tplDataKind').value = t.data_kind || 'array';
    document.getElementById('tplFields').value = t.fields ? JSON.stringify(t.fields) : '';
    previewTemplate();
  } catch(e) { toast('预览失败: ' + e.message, 'error'); }
}
