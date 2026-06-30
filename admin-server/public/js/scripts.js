// ============ 全局状态 ============
let currentScriptPage = 1;
// 当前查看代码的脚本数据缓存
let currentCodeScript = null;
let isCodeEditing = false;
let currentParamsSchema = [];
let currentParamsData = {};
let currentModules = [];

// ============ 脚本管理 ============
async function loadScripts(page) {
  currentScriptPage = page || 1;
  const keyword = document.getElementById('scriptSearch').value.trim();
  const category = document.getElementById('scriptCategory').value;
  let params = `page=${currentScriptPage}&pageSize=15`;
  if (keyword) params += '&keyword=' + encodeURIComponent(keyword);
  if (category) params += '&category=' + encodeURIComponent(category);
  try {
    const res = await api('GET', '/api/scripts?' + params);
    const tbody = document.getElementById('scriptTable');
    if (res.success && res.data && res.data.length > 0) {
      tbody.innerHTML = res.data.map(s => `
        <tr>
          <td>${s.id}</td>
          <td>${esc(s.name)}</td>
          <td>${esc(s.category_name||'-')}</td>
          <td>${s.version}</td>
          <td>${esc(s.author_name||'-')}</td>
          <td>${s.download_count||0}</td>
          <td><span class="badge badge-${s.status==='published'?'published':'draft'}">${s.status}</span></td>
          <td>${fmtDate(s.updated_at)}</td>
          <td>
            <button class="btn-icon" onclick="viewScriptCode(${s.id})" title="查看代码">📄</button>
            <button class="btn-icon" onclick="editScriptMeta(${s.id})" title="编辑代码和元数据" style="color:var(--primary)">✏️</button>
            <button class="btn-icon" onclick="previewScript(${s.id})" title="预览">👁</button>
            <button class="btn-icon" onclick="installToTampermonkey(${s.id})" title="安装到油猴" style="color:#76b900">🧩</button>
            <button class="btn-icon" onclick="downloadScript(${s.id})" title="下载">⬇</button>
            <button class="btn-icon danger" onclick="deleteScript(${s.id},'${esc(s.name)}')" title="删除">🗑</button>
          </td>
        </tr>`).join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state">暂无脚本</td></tr>';
    }
    const pag = res.pagination || {};
    document.getElementById('scriptPagination').innerHTML = `
      <button ${pag.page<=1?'disabled':''} onclick="loadScripts(${pag.page-1})">上一页</button>
      <span>第 ${pag.page||1} / ${pag.totalPages||1} 页 (共 ${pag.total||0} 条)</span>
      <button ${pag.page>=pag.totalPages?'disabled':''} onclick="loadScripts(${pag.page+1})">下一页</button>`;
  } catch(e) { console.error(e); }
}

async function loadCategoriesForSelect() {
  try {
    const res = await api('GET', '/api/stats/categories');
    const sel = document.getElementById('scriptCategory');
    const sel2 = document.getElementById('uploadCategory');
    if (res.success) {
      const opts = res.data.map(c => `<option value="${c.slug}">${c.name}</option>`).join('');
      sel.innerHTML = '<option value="">全部分类</option>' + opts;
      sel2.innerHTML = '<option value="">请选择</option>' + res.data.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    }
  } catch(e) { console.error(e); }
}

function showUploadModal() {
  document.getElementById('uploadModal').classList.remove('hidden');
  document.getElementById('uploadError').style.display = 'none';
  document.getElementById('uploadName').value = '';
  document.getElementById('uploadDesc').value = '';
  document.getElementById('uploadVersion').value = '1.0.0';
  document.getElementById('uploadUrlPattern').value = '*';
  document.getElementById('uploadFile').value = '';
}

function closeUploadModal() { document.getElementById('uploadModal').classList.add('hidden'); }

async function uploadScript() {
  const name = document.getElementById('uploadName').value.trim();
  const desc = document.getElementById('uploadDesc').value.trim();
  const catId = document.getElementById('uploadCategory').value;
  const version = document.getElementById('uploadVersion').value.trim();
  const urlPattern = document.getElementById('uploadUrlPattern').value.trim();
  const fileInput = document.getElementById('uploadFile');
  const files = fileInput.files;
  const errEl = document.getElementById('uploadError');

  if (!name || !catId || files.length === 0) {
    errEl.textContent = '请填写脚本名称、分类并选择脚本文件';
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';

  try {
    // Read all files
    const fileContents = [];
    for (let i = 0; i < files.length; i++) {
      const content = await files[i].text();
      fileContents.push({ name: files[i].name, code: content });
    }
    // Sort by filename
    fileContents.sort((a, b) => a.name.localeCompare(b.name));

    if (files.length === 1) {
      // Single file - use the existing multipart upload
      const formData = new FormData();
      formData.append('name', name);
      formData.append('description', desc);
      formData.append('category_id', catId);
      formData.append('version', version || '1.0.0');
      formData.append('url_pattern', urlPattern || '*');
      // 工具类型和配置
      const toolType = document.getElementById('uploadToolType').value;
      formData.append('tool_type', toolType);
      const toolConfig = document.getElementById('uploadToolConfig').value.trim();
      if (toolConfig) formData.append('tool_config', toolConfig);
      formData.append('script', files[0]);
      const res = await api('POST', '/api/scripts', formData, true);
      if (res.success) { closeUploadModal(); loadScripts(currentScriptPage); toast('脚本上传成功', 'success'); }
      else { errEl.textContent = res.message || res.error || '上传失败'; errEl.style.display = 'block'; }
    } else {
      // Multiple files - first file as main, rest as modules
      const modules = fileContents.map((f, i) => ({ name: f.name, code: f.code, load_order: i }));

      const formData = new FormData();
      formData.append('name', name);
      formData.append('description', desc);
      formData.append('category_id', catId);
      formData.append('version', version || '1.0.0');
      formData.append('url_pattern', urlPattern || '*');
      // 工具类型和配置
      const toolType2 = document.getElementById('uploadToolType').value;
      formData.append('tool_type', toolType2);
      const toolConfig2 = document.getElementById('uploadToolConfig').value.trim();
      if (toolConfig2) formData.append('tool_config', toolConfig2);
      formData.append('script', files[0]);
      // Add modules as JSON
      formData.append('modules', JSON.stringify(modules));

      const res = await api('POST', '/api/scripts', formData, true);
      if (res.success) { closeUploadModal(); loadScripts(currentScriptPage); toast('脚本上传成功（含 ' + modules.length + ' 个模块）', 'success'); }
      else { errEl.textContent = res.message || res.error || '上传失败'; errEl.style.display = 'block'; }
    }
  } catch(e) { errEl.textContent = '错误: ' + e.message; errEl.style.display = 'block'; }
}

async function downloadScript(id) { window.open('/api/scripts/' + id + '/download?t=' + Date.now() + '&token=' + encodeURIComponent(token)); }

function installToTampermonkey(id) {
  // 打开 .user.js 链接，浏览器安装了油猴后会自动弹出安装提示
  window.open('/api/scripts/' + id + '/userjs', '_blank');
}

async function deleteScript(id, name) {
  if (!confirm('确定删除脚本 "' + name + '" 吗？')) return;
  try {
    const res = await api('DELETE', '/api/scripts/' + id);
    if (res.success) { loadScripts(currentScriptPage); toast('删除成功', 'success'); }
    else { toast('删除失败: ' + (res.message||res.error), 'error'); }
  } catch(e) { toast('网络错误', 'error'); }
}

// ============ 查看脚本代码 ============
async function viewScriptCode(id) {
  try {
    const res = await api('GET', '/api/scripts/' + id);
    if (!res.success) { toast('获取脚本详情失败', 'error'); return; }
    currentCodeScript = res.data;
    isCodeEditing = false;

    document.getElementById('codeModalTitle').textContent = '脚本代码 - ' + currentCodeScript.name;
    document.getElementById('codeModalError').style.display = 'none';

    // 显示代码内容
    document.getElementById('codeView').textContent = currentCodeScript.code || '// 此脚本文件为空';
    document.getElementById('codeViewWrap').classList.remove('hidden');
    document.getElementById('codeEditWrap').classList.add('hidden');
    document.getElementById('codeMetaFields').classList.add('hidden');
    document.getElementById('codeEditBtn').classList.remove('hidden');
    document.getElementById('codeSaveBtn').classList.add('hidden');
    document.getElementById('codeCancelBtn').classList.add('hidden');
    document.getElementById('saveParamsBtn').classList.remove('hidden');

    document.getElementById('codeModal').classList.remove('hidden');

    // 初始化参数和模块
    currentParamsSchema = currentCodeScript.params_schema || [];
    currentParamsData = currentCodeScript.params_data || {};
    currentModules = currentCodeScript.modules || [];

    // 显示参数和模块区域
    document.getElementById('paramsSection').style.display = 'block';
    document.getElementById('modulesSection').style.display = 'block';
    renderParamsSection(currentParamsSchema, currentParamsData);
    renderModulesSection(currentModules);
  } catch(e) {
    toast('网络错误: ' + e.message, 'error');
  }
}

// ============ 一键编辑（直接进入编辑模式，含元数据） ============
async function editScriptMeta(id) {
  // 先加载脚本详情
  try {
    const res = await api('GET', '/api/scripts/' + id);
    if (!res.success) { toast('获取脚本详情失败', 'error'); return; }
    currentCodeScript = res.data;
    isCodeEditing = false;

    document.getElementById('codeModalTitle').textContent = '编辑脚本 - ' + currentCodeScript.name;
    document.getElementById('codeModalError').style.display = 'none';
    document.getElementById('codeView').textContent = currentCodeScript.code || '// 此脚本文件为空';

    // 初始化参数和模块
    currentParamsSchema = currentCodeScript.params_schema || [];
    currentParamsData = currentCodeScript.params_data || {};
    currentModules = currentCodeScript.modules || [];
    document.getElementById('paramsSection').style.display = 'block';
    document.getElementById('modulesSection').style.display = 'block';
    renderParamsSection(currentParamsSchema, currentParamsData);
    renderModulesSection(currentModules);

    document.getElementById('codeModal').classList.remove('hidden');

    // 直接切到编辑模式
    toggleCodeEdit();
  } catch(e) {
    toast('网络错误: ' + e.message, 'error');
  }
}

// ============ 切换代码编辑模式 ============
function toggleCodeEdit() {
  isCodeEditing = true;
  // 填充编辑区域
  document.getElementById('codeEditArea').value = currentCodeScript.code || '';
  document.getElementById('codeEditName').value = currentCodeScript.name || '';
  document.getElementById('codeEditDesc').value = currentCodeScript.description || '';
  document.getElementById('codeEditUrlPattern').value = currentCodeScript.url_pattern || '*';
  document.getElementById('codeEditVersion').value = currentCodeScript.version || '1.0.0';
  // 工具类型
  document.getElementById('codeEditToolType').value = currentCodeScript.tool_type || 'js';
  const config = currentCodeScript.tool_config;
  if (config && typeof config === 'object') {
    document.getElementById('codeEditToolConfig').value = JSON.stringify(config, null, 2);
    document.getElementById('codeEditToolConfigGroup').style.display = (currentCodeScript.tool_type === 'api') ? '' : 'none';
  }

  // P0: 填充结构化元数据
  const meta = currentCodeScript.metadata || {};
  document.getElementById('codeEditTriggers').value = (meta.triggers || []).join(', ');
  document.getElementById('codeEditPlatforms').value = (meta.platforms || []).join(', ');
  document.getElementById('codeEditRequiresLogin').value = meta.requires_login ? 'true' : 'false';
  document.getElementById('codeEditSuccessCriteria').value = meta.success_criteria || '';
  document.getElementById('codeEditKnownLimits').value = meta.known_limits || '';
  const pag = meta.pagination || {};
  document.getElementById('codeEditPaginationStrategy').value = pag.strategy || 'scroll';
  document.getElementById('codeEditMaxPages').value = pag.maxPages || 20;
  // P1: 执行前检查
  document.getElementById('codeEditPrecheck').value = currentCodeScript.precheck || '';

  // 切换显示
  document.getElementById('codeViewWrap').classList.add('hidden');
  document.getElementById('codeEditWrap').classList.remove('hidden');
  document.getElementById('codeMetaFields').classList.remove('hidden');
  document.getElementById('codeEditBtn').classList.add('hidden');
  document.getElementById('codeSaveBtn').classList.remove('hidden');
  document.getElementById('codeCancelBtn').classList.remove('hidden');
  document.getElementById('saveParamsBtn').classList.add('hidden');
}

function cancelCodeEdit() {
  isCodeEditing = false;
  document.getElementById('codeViewWrap').classList.remove('hidden');
  document.getElementById('codeEditWrap').classList.add('hidden');
  document.getElementById('codeMetaFields').classList.add('hidden');
  document.getElementById('codeEditBtn').classList.remove('hidden');
  document.getElementById('codeSaveBtn').classList.add('hidden');
  document.getElementById('codeCancelBtn').classList.add('hidden');
  document.getElementById('saveParamsBtn').classList.remove('hidden');
}

// ============ 保存脚本代码 ============
async function saveScriptCode() {
  if (!currentCodeScript) return;
  const errEl = document.getElementById('codeModalError');
  const code = document.getElementById('codeEditArea').value;
  const name = document.getElementById('codeEditName').value.trim();
  const description = document.getElementById('codeEditDesc').value.trim();
  const url_pattern = document.getElementById('codeEditUrlPattern').value.trim() || '*';
  const version = document.getElementById('codeEditVersion').value.trim() || '1.0.0';
  const tool_type = document.getElementById('codeEditToolType').value;
  let tool_config = null;
  try {
    const raw = document.getElementById('codeEditToolConfig').value.trim();
    if (raw) tool_config = JSON.parse(raw);
  } catch {}

  if (!name) { errEl.textContent = '脚本名称不能为空'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none';

  try {
    // P0: 收集结构化元数据
    const metadata = {
      triggers: document.getElementById('codeEditTriggers').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      platforms: document.getElementById('codeEditPlatforms').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      requires_login: document.getElementById('codeEditRequiresLogin').value === 'true',
      success_criteria: document.getElementById('codeEditSuccessCriteria').value.trim(),
      known_limits: document.getElementById('codeEditKnownLimits').value.trim(),
      pagination: {
        strategy: document.getElementById('codeEditPaginationStrategy').value,
        maxPages: parseInt(document.getElementById('codeEditMaxPages').value) || 20,
      },
    };
    const precheck = document.getElementById('codeEditPrecheck').value.trim();

    const body = {
      code,
      name,
      description,
      url_pattern,
      version,
      params_schema: JSON.stringify(currentParamsSchema),
      params_data: JSON.stringify(currentParamsData),
      tool_type,
      tool_config: tool_config ? JSON.stringify(tool_config) : null,
      modules: currentModules.map(m => ({ name: m.name, code: m.code, load_order: m.load_order })),
      metadata: JSON.stringify(metadata),
      precheck: precheck || null,
    };
    const res = await api('PUT', '/api/scripts/' + currentCodeScript.id, body);
    if (res.success) {
      // 更新缓存
      currentCodeScript.code = code;
      currentCodeScript.name = name;
      currentCodeScript.description = description;
      currentCodeScript.url_pattern = url_pattern;
      currentCodeScript.version = version;
      // 切回查看模式
      document.getElementById('codeView').textContent = code || '// 此脚本文件为空';
      cancelCodeEdit();
      document.getElementById('codeModalTitle').textContent = '脚本代码 - ' + name;
      toast('脚本保存成功', 'success');
      // 刷新脚本列表
      loadScripts(currentScriptPage);
    } else {
      errEl.textContent = res.message || res.error || '保存失败';
      errEl.style.display = 'block';
    }
  } catch(e) {
    errEl.textContent = '网络错误: ' + e.message;
    errEl.style.display = 'block';
  }
}

function closeCodeModal() {
  document.getElementById('codeModal').classList.add('hidden');
  document.getElementById('paramsSection').style.display = 'none';
  document.getElementById('modulesSection').style.display = 'none';
  currentCodeScript = null;
  isCodeEditing = false;
}

function closeCodeModalWithConfirm() {
  // 如果正在编辑代码模式，提示确认
  if (isCodeEditing) {
    if (!confirm('有未保存的更改，确定关闭吗？')) return;
  }
  closeCodeModal();
}

// ============ 参数配置渲染 ============
let addingParam = false;

function renderParamsSection(schema, data) {
  const container = document.getElementById('paramsSection');
  if (!container) return;

  let html = '<div style="margin-bottom:12px;display:flex;align-items:center;gap:8px"><strong>脚本参数</strong> <button class="btn btn-sm" onclick="showAddParamForm()" style="font-size:11px;padding:2px 8px">+ 添加参数</button></div>';

  if (!schema || schema.length === 0) {
    html += '<div style="color:var(--text2);font-size:13px;padding:8px 0">暂无参数配置</div>';
  } else {
    html += '<table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr style="background:var(--bg)"><th style="padding:6px 8px;text-align:left">参数键</th><th style="padding:6px 8px;text-align:left">标签</th><th style="padding:6px 8px;text-align:left">类型</th><th style="padding:6px 8px;text-align:left">选项值</th><th style="padding:6px 8px;text-align:left">默认值</th><th style="padding:6px 8px;text-align:left">当前值</th><th style="padding:6px 8px">操作</th></tr></thead><tbody>';
    schema.forEach((p, i) => {
      const currentVal = data[p.key] !== undefined ? data[p.key] : p.default || '';
      html += '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:6px 8px"><code>' + esc(p.key) + '</code></td>' +
        '<td style="padding:6px 8px">' + esc(p.label) + '</td>' +
        '<td style="padding:6px 8px">' + esc(p.type) + '</td>' +
        '<td style="padding:6px 8px">' + esc((p.options||[]).join(', ')) + '</td>' +
        '<td style="padding:6px 8px">' + esc(String(p.default || '')) + '</td>' +
        '<td style="padding:6px 8px">' + renderParamValueInput(p, currentVal, i) + '</td>' +
        '<td style="padding:6px 8px"><button class="btn-icon danger" onclick="removeParam(' + i + ')" title="删除">🗑</button></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
  }

  // 内联添加参数表单
  html += '<div id="addParamForm" style="display:none;margin-top:12px;padding:12px;background:var(--bg);border-radius:var(--radius);border:1px solid var(--border)">' +
    '<div style="font-weight:600;margin-bottom:10px">添加新参数</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
      '<div class="form-group" style="margin:0"><label style="font-size:12px">参数键名 *</label><input type="text" id="newParamKey" placeholder="如 providerMode" style="font-size:12px"></div>' +
      '<div class="form-group" style="margin:0"><label style="font-size:12px">标签 *</label><input type="text" id="newParamLabel" placeholder="如 AI来源" style="font-size:12px"></div>' +
      '<div class="form-group" style="margin:0"><label style="font-size:12px">类型</label><select id="newParamType" onchange="toggleParamOptions()" style="font-size:12px"><option value="text">文本(text)</option><option value="select">选择(select)</option><option value="number">数字(number)</option><option value="boolean">布尔(boolean)</option></select></div>' +
      '<div class="form-group" style="margin:0"><label style="font-size:12px">默认值</label><input type="text" id="newParamDefault" placeholder="默认值" style="font-size:12px"></div>' +
      '<div class="form-group" style="margin:0;grid-column:span 2" id="newParamOptionsGroup"><label style="font-size:12px">选项值 <span style="font-weight:400;color:var(--text2)">（逗号分隔，如 mock,coze,dmx）</span></label><input type="text" id="newParamOptions" placeholder="mock,coze,dmx" style="font-size:12px"></div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">' +
      '<button class="btn btn-sm" onclick="hideAddParamForm()" style="background:var(--bg-card);color:var(--text);border:1px solid var(--border)">取消</button>' +
      '<button class="btn btn-primary btn-sm" onclick="confirmAddParam()">确认添加</button>' +
    '</div>' +
  '</div>';

  container.innerHTML = html;
  // 根据类型显示/隐藏选项值字段
  toggleParamOptions();
  // 如果正在添加，恢复显示
  if (addingParam) {
    document.getElementById('addParamForm').style.display = 'block';
  }
}

function renderParamValueInput(param, value, index) {
  const escVal = esc(String(value));
  if (param.type === 'select' && param.options && param.options.length > 0) {
    let html = '<select onchange="updateParamValue(' + index + ',this.value)" style="font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:4px">';
    param.options.forEach(opt => {
      html += '<option value="' + esc(opt) + '"' + (opt === value ? ' selected' : '') + '>' + esc(opt) + '</option>';
    });
    html += '</select>';
    return html;
  } else if (param.type === 'boolean') {
    return '<input type="checkbox"' + (value === true || value === 'true' ? ' checked' : '') + ' onchange="updateParamValue(' + index + ',this.checked)">';
  } else if (param.type === 'number') {
    return '<input type="number" value="' + escVal + '" onchange="updateParamValue(' + index + ',Number(this.value))" style="font-size:12px;padding:4px 6px;width:100px;border:1px solid var(--border);border-radius:4px">';
  } else {
    return '<input type="text" value="' + escVal + '" onchange="updateParamValue(' + index + ',this.value)" style="font-size:12px;padding:4px 6px;width:120px;border:1px solid var(--border);border-radius:4px">';
  }
}

function toggleParamOptions() {
  const typeEl = document.getElementById('newParamType');
  const group = document.getElementById('newParamOptionsGroup');
  if (!typeEl || !group) return;
  group.style.display = typeEl.value === 'select' ? '' : 'none';
}

function showAddParamForm() {
  addingParam = true;
  const form = document.getElementById('addParamForm');
  if (form) {
    form.style.display = 'block';
    document.getElementById('newParamKey').focus();
  } else {
    // 表单还没渲染，先触发渲染
    renderParamsSection(currentParamsSchema, currentParamsData);
  }
}

function hideAddParamForm() {
  addingParam = false;
  const form = document.getElementById('addParamForm');
  if (form) form.style.display = 'none';
}

function confirmAddParam() {
  const key = document.getElementById('newParamKey').value.trim();
  const label = document.getElementById('newParamLabel').value.trim();
  const type = document.getElementById('newParamType').value;
  const defaultVal = document.getElementById('newParamDefault').value.trim();
  let options = [];
  if (type === 'select') {
    const opts = document.getElementById('newParamOptions').value.trim();
    if (opts) options = opts.split(',').map(o => o.trim()).filter(Boolean);
  }

  if (!key) {
    toast('参数键名不能为空', 'error');
    return;
  }
  // 检查重复
  if (currentParamsSchema.some(p => p.key === key)) {
    toast('参数键名 "' + key + '" 已存在', 'error');
    return;
  }

  currentParamsSchema.push({ key, label: label || key, type, options, default: defaultVal });
  // 如果有默认值，同时设置到 paramsData
  if (defaultVal && currentParamsData[key] === undefined) {
    currentParamsData[key] = type === 'number' ? Number(defaultVal) : defaultVal;
  }
  addingParam = false;
  renderParamsSection(currentParamsSchema, currentParamsData);
  toast('参数 "' + key + '" 已添加', 'success');
  // 添加参数后自动保存
  saveParamsOnly();
}

function removeParam(index) {
  const removedKey = currentParamsSchema[index].key;
  currentParamsSchema.splice(index, 1);
  delete currentParamsData[removedKey];
  renderParamsSection(currentParamsSchema, currentParamsData);
  toast('参数已删除', 'success');
  // 删除参数后自动保存
  saveParamsOnly();
}

function updateParamValue(index, value) {
  const key = currentParamsSchema[index].key;
  currentParamsData[key] = value;
  // 值变更后自动保存（防抖）
  clearTimeout(updateParamValue._timer);
  updateParamValue._timer = setTimeout(() => saveParamsOnly(), 1000);
}

// 仅保存参数（轻量，不含模块代码）
async function saveParamsOnly() {
  if (!currentCodeScript) return;
  try {
    const body = {
      params_schema: JSON.stringify(currentParamsSchema),
      params_data: JSON.stringify(currentParamsData)
    };
    const res = await api('PUT', '/api/scripts/' + currentCodeScript.id, body);
    if (!res.success) {
      toast('参数保存失败: ' + (res.message || res.error), 'error');
    }
  } catch(e) {
    toast('参数保存异常: ' + e.message, 'error');
  }
}

// 保存参数和模块（重量级，含模块代码）
async function saveParamsAndModules() {
  if (!currentCodeScript) return;
  try {
    const body = {
      params_schema: JSON.stringify(currentParamsSchema),
      params_data: JSON.stringify(currentParamsData),
      modules: currentModules.map(m => ({ name: m.name, code: m.code, load_order: m.load_order }))
    };
    const res = await api('PUT', '/api/scripts/' + currentCodeScript.id, body);
    if (res.success) {
      toast('参数和模块保存成功', 'success');
    } else {
      toast('保存失败: ' + (res.message || res.error), 'error');
    }
  } catch(e) {
    toast('网络错误: ' + e.message, 'error');
  }
}

// ============ 模块管理渲染 ============
function renderModulesSection(modules) {
  const container = document.getElementById('modulesSection');
  if (!container) return;

  let html = '<div style="margin-bottom:12px"><strong>脚本模块</strong> <button class="btn btn-sm" onclick="addModule()" style="font-size:11px;padding:2px 8px;margin-left:8px">+ 添加模块</button></div>';

  if (!modules || modules.length === 0) {
    html += '<div style="color:var(--text2);font-size:13px;padding:8px 0">暂无模块（脚本代码作为主文件）</div>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:8px">';
    modules.forEach((mod, i) => {
      html += '<div style="border:1px solid var(--border);border-radius:6px;padding:10px;display:flex;align-items:center;gap:12px">' +
        '<span style="font-size:12px;color:var(--text2);min-width:30px">#' + mod.load_order + '</span>' +
        '<span style="font-size:13px;font-weight:500;flex:1">' + esc(mod.name) + '</span>' +
        '<span style="font-size:11px;color:var(--text2)">' + (mod.code ? mod.code.length + ' 字符' : '') + '</span>' +
        '<button class="btn-icon" onclick="viewModuleCode(' + i + ')" title="查看代码">📄</button>' +
        '<button class="btn-icon" onclick="editModuleCode(' + i + ')" title="编辑">✏</button>' +
        '<button class="btn-icon danger" onclick="removeModule(' + i + ')" title="删除">🗑</button>' +
        '</div>';
    });
    html += '</div>';
  }
  container.innerHTML = html;
}

function addModule() {
  // 直接添加一个空模块并打开编辑器
  const newModule = { name: 'new-module.js', code: '', load_order: currentModules.length, isNew: true };
  currentModules.push(newModule);
  renderModulesSection(currentModules);
  // 打开编辑器
  editModuleCode(currentModules.length - 1);
}

function removeModule(index) {
  if (!confirm('确定删除模块 "' + currentModules[index].name + '"？')) return;
  currentModules.splice(index, 1);
  renderModulesSection(currentModules);
}

function viewModuleCode(index) {
  const mod = currentModules[index];
  const win = window.open('', '_blank', 'width=800,height=600');
  win.document.write('<pre style="font-family:monospace;font-size:13px;padding:16px;white-space:pre-wrap">' + esc(mod.code) + '</pre>');
  win.document.title = mod.name;
}

function editModuleCode(index) {
  const mod = currentModules[index];
  document.getElementById('moduleEditIndex').value = index;
  document.getElementById('moduleEditName').value = mod.name;
  document.getElementById('moduleEditOrder').value = mod.load_order;
  document.getElementById('moduleEditArea').value = mod.code || '';
  document.getElementById('moduleEditModal').classList.remove('hidden');
}

function closeModuleEditModal() {
  document.getElementById('moduleEditModal').classList.add('hidden');
}

function saveModuleEdit() {
  const index = parseInt(document.getElementById('moduleEditIndex').value);
  const name = document.getElementById('moduleEditName').value.trim();
  const loadOrder = parseInt(document.getElementById('moduleEditOrder').value) || 0;
  const code = document.getElementById('moduleEditArea').value;

  if (index >= 0 && index < currentModules.length) {
    currentModules[index].name = name;
    currentModules[index].load_order = loadOrder;
    currentModules[index].code = code;
  }
  closeModuleEditModal();
  renderModulesSection(currentModules);
}

// ============ JS 注入预览 ============
async function previewScript(id) {
  try {
    const res = await api('GET', '/api/scripts/' + id);
    if (!res.success) { toast('获取脚本详情失败', 'error'); return; }
    const script = res.data;
    document.getElementById('previewCode').textContent = script.code || '// 此脚本文件为空';
    document.getElementById('previewUrl').value = 'https://example.com';
    // 重置 iframe
    document.getElementById('previewFrame').src = 'about:blank';
    document.getElementById('previewModal').classList.remove('hidden');
  } catch(e) {
    toast('网络错误: ' + e.message, 'error');
  }
}

async function executePreview() {
  const url = document.getElementById('previewUrl').value.trim();
  const code = document.getElementById('previewCode').textContent;
  if (!url) { toast('请输入预览 URL', 'error'); return; }

  // 复制脚本代码到剪贴板
  try {
    await navigator.clipboard.writeText(code);
  } catch { /* 剪贴板失败不影响主流程 */ }

  // 新标签页打开目标网址
  window.open(url, '_blank');

  // 在预览区域显示操作提示
  const wrap = document.getElementById('previewFrameWrap');
  wrap.innerHTML = '<div style="padding:32px;text-align:center">' +
    '<div style="font-size:48px;margin-bottom:16px">&#10003;</div>' +
    '<div style="font-size:16px;font-weight:600;margin-bottom:12px">脚本代码已复制到剪贴板</div>' +
    '<div style="font-size:14px;color:var(--text2);line-height:2">' +
    '1. 在刚打开的目标页面中按 <kbd style="background:#f0f0f0;padding:2px 8px;border-radius:4px;border:1px solid #ddd;font-family:monospace">F12</kbd> 打开开发者工具<br>' +
    '2. 切换到 <kbd style="background:#f0f0f0;padding:2px 8px;border-radius:4px;border:1px solid #ddd;font-family:monospace">Console</kbd> 面板<br>' +
    '3. 按 <kbd style="background:#f0f0f0;padding:2px 8px;border-radius:4px;border:1px solid #ddd;font-family:monospace">Ctrl+V</kbd> 粘贴脚本代码，按回车执行</div>' +
    '<div style="margin-top:20px">' +
    '<button class="btn btn-primary btn-sm" onclick="copyScriptCode()" style="margin-right:8px">重新复制代码</button>' +
    '<button class="btn btn-sm" onclick="retryIframePreview()" style="background:var(--bg);color:var(--text)">尝试 iframe 预览</button>' +
    '</div></div>';
  toast('脚本已复制，目标页面已在新标签打开', 'success');
}

function copyScriptCode() {
  const code = document.getElementById('previewCode').textContent;
  navigator.clipboard.writeText(code).then(() => toast('代码已复制到剪贴板', 'success'));
}

function retryIframePreview() {
  // 恢复 iframe 并用 srcdoc 方式尝试（部分网站可用）
  const wrap = document.getElementById('previewFrameWrap');
  wrap.innerHTML = '<iframe id="previewFrame" class="preview-iframe" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" src="about:blank"></iframe>';
  const url = document.getElementById('previewUrl').value.trim();
  const code = document.getElementById('previewCode').textContent;
  if (!url) return;
  toast('正在获取页面...', 'success');
  fetch('/api/proxy-preview?url=' + encodeURIComponent(url))
    .then(r => r.json())
    .then(data => {
      if (!data.success) { toast('获取页面失败: ' + (data.error || '未知错误'), 'error'); return; }
      let html = data.html;
      const baseTag = '<base href="' + esc(url) + '">';
      if (html.includes('<head>')) html = html.replace('<head>', '<head>' + baseTag);
      else if (html.includes('<html>')) html = html.replace('<html>', '<html><head>' + baseTag + '</head>');
      else html = baseTag + html;
      const inject = '\n<script>\ntry {\n' + code + '\n} catch(e) { console.error("脚本注入错误:", e); }\n<\/script>\n';
      if (html.includes('</body>')) html = html.replace('</body>', inject + '</body>');
      else html += inject;
      document.getElementById('previewFrame').srcdoc = html;
    })
    .catch(e => toast('预览失败: ' + e.message, 'error'));
}

function closePreviewModal() {
  document.getElementById('previewFrame').src = 'about:blank';
  document.getElementById('previewModal').classList.add('hidden');
}
