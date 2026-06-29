// ============ AI 模型配置 ============
let editingProviderId = null;
let editingModelId = null;
let providersCache = [];

async function loadAIModels() {
  await loadProviders();
  await loadModels();
}

async function loadProviders() {
  try {
    const res = await api('GET', '/api/ai-models/providers');
    if (res.success) {
      providersCache = res.data;
      const tbody = document.getElementById('providerList');
      if (!res.data.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty-state">暂无数据</td></tr>'; return; }
      tbody.innerHTML = res.data.map(p => `
        <tr>
          <td>${p.display_name} <span style="color:var(--text2);font-size:11px">(${p.name})</span></td>
          <td style="font-family:monospace;font-size:12px">${p.base_url}</td>
          <td>${p.api_key ? '✅ 已配置' : '<span style="color:var(--danger)">❌ 未配置</span>'}</td>
          <td><span class="badge ${p.status ? 'badge-active' : 'badge-disabled'}">${p.status ? '启用' : '禁用'}</span></td>
          <td>${p.sort_order}</td>
          <td>
            <button class="btn-icon" onclick="editProvider(${p.id})">✏️</button>
            <button class="btn-icon danger" onclick="deleteProvider(${p.id}, '${p.display_name}')">🗑️</button>
          </td>
        </tr>`).join('');
    }
  } catch (e) { toast('加载服务商失败: ' + e.message, 'error'); }
}

async function loadModels() {
  try {
    const res = await api('GET', '/api/ai-models');
    if (res.success) {
      const tbody = document.getElementById('modelList');
      if (!res.data.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty-state">暂无数据</td></tr>'; return; }
      tbody.innerHTML = res.data.map(m => {
        const provider = providersCache.find(p => p.id === m.provider_id);
        const caps = [];
        if (m.supports_vision) caps.push('<span class="badge badge-active">图片</span>');
        if (m.supports_tools) caps.push('<span class="badge badge-admin">工具</span>');
        if (m.supports_stream) caps.push('<span class="badge badge-developer">流式</span>');
        return `
        <tr>
          <td style="font-family:monospace;font-size:12px">${m.model_id}</td>
          <td>${m.display_name}</td>
          <td>${provider ? provider.display_name : '-'}</td>
          <td>${m.context_window}</td>
          <td>${m.max_tokens}</td>
          <td>${m.temperature}</td>
          <td>${caps.join(' ') || '-'}</td>
          <td><span class="badge ${m.status ? 'badge-active' : 'badge-disabled'}">${m.status ? '启用' : '禁用'}</span></td>
          <td>
            <button class="btn-icon" onclick="editModel(${m.id})">✏️</button>
            <button class="btn-icon danger" onclick="deleteModel(${m.id}, '${m.display_name}')">🗑️</button>
          </td>
        </tr>`;
      }).join('');
    }
  } catch (e) { toast('加载模型失败: ' + e.message, 'error'); }
}

function showProviderModal(data) {
  editingProviderId = data?.id || null;
  document.getElementById('providerModalTitle').textContent = data ? '编辑服务商' : '添加服务商';
  document.getElementById('providerName').value = data?.name || '';
  document.getElementById('providerDisplayName').value = data?.display_name || '';
  document.getElementById('providerBaseUrl').value = data?.base_url || '';
  document.getElementById('providerApiKey').value = data?.api_key || '';
  document.getElementById('providerSort').value = data?.sort_order ?? 0;
  document.getElementById('providerModal').classList.remove('hidden');
}
function closeProviderModal() { document.getElementById('providerModal').classList.add('hidden'); }

function editProvider(id) {
  const p = providersCache.find(x => x.id === id);
  if (p) showProviderModal(p);
}

async function saveProvider() {
  const body = {
    name: document.getElementById('providerName').value,
    display_name: document.getElementById('providerDisplayName').value,
    base_url: document.getElementById('providerBaseUrl').value,
    api_key: document.getElementById('providerApiKey').value,
    sort_order: parseInt(document.getElementById('providerSort').value) || 0,
  };
  try {
    const res = editingProviderId
      ? await api('PUT', '/api/ai-models/providers/' + editingProviderId, body)
      : await api('POST', '/api/ai-models/providers', body);
    if (res.success) { toast('保存成功', 'success'); closeProviderModal(); loadAIModels(); }
    else toast(res.error || '操作失败', 'error');
  } catch (e) { toast('操作失败: ' + e.message, 'error'); }
}

async function deleteProvider(id, name) {
  if (!confirm('确定删除服务商「' + name + '」？关联的模型也会被删除。')) return;
  try {
    const res = await api('DELETE', '/api/ai-models/providers/' + id);
    if (res.success) { toast('删除成功', 'success'); loadAIModels(); }
    else toast(res.error || '删除失败', 'error');
  } catch (e) { toast('删除失败: ' + e.message, 'error'); }
}

function showModelModal(data) {
  editingModelId = data?.id || null;
  document.getElementById('modelModalTitle').textContent = data ? '编辑模型' : '添加模型';
  const sel = document.getElementById('modelProviderId');
  sel.innerHTML = providersCache.map(p => `<option value="${p.id}">${p.display_name}</option>`).join('');
  document.getElementById('modelModelId').value = data?.model_id || '';
  document.getElementById('modelDisplayName').value = data?.display_name || '';
  document.getElementById('modelContextWindow').value = data?.context_window ?? 8192;
  document.getElementById('modelMaxTokens').value = data?.max_tokens ?? 4096;
  document.getElementById('modelTemperature').value = data?.temperature ?? 0.7;
  document.getElementById('modelSupportsVision').checked = !!data?.supports_vision;
  document.getElementById('modelSupportsTools').checked = !!data?.supports_tools;
  document.getElementById('modelSupportsStream').checked = data?.supports_stream !== 0;
  document.getElementById('modelDescription').value = data?.description || '';
  if (data?.provider_id) sel.value = data.provider_id;
  document.getElementById('modelModal').classList.remove('hidden');
}
function closeModelModal() { document.getElementById('modelModal').classList.add('hidden'); }

function editModel(id) {
  api('GET', '/api/ai-models').then(res => {
    if (res.success) {
      const m = res.data.find(x => x.id === id);
      if (m) showModelModal(m);
    }
  });
}

async function saveModel() {
  const body = {
    provider_id: parseInt(document.getElementById('modelProviderId').value),
    model_id: document.getElementById('modelModelId').value,
    display_name: document.getElementById('modelDisplayName').value,
    context_window: parseInt(document.getElementById('modelContextWindow').value) || 8192,
    max_tokens: parseInt(document.getElementById('modelMaxTokens').value) || 4096,
    temperature: parseFloat(document.getElementById('modelTemperature').value) || 0.7,
    supports_vision: document.getElementById('modelSupportsVision').checked ? 1 : 0,
    supports_tools: document.getElementById('modelSupportsTools').checked ? 1 : 0,
    supports_stream: document.getElementById('modelSupportsStream').checked ? 1 : 0,
    description: document.getElementById('modelDescription').value,
  };
  try {
    const res = editingModelId
      ? await api('PUT', '/api/ai-models/' + editingModelId, body)
      : await api('POST', '/api/ai-models', body);
    if (res.success) { toast('保存成功', 'success'); closeModelModal(); loadModels(); }
    else toast(res.error || '操作失败', 'error');
  } catch (e) { toast('操作失败: ' + e.message, 'error'); }
}

async function deleteModel(id, name) {
  if (!confirm('确定删除模型「' + name + '」？')) return;
  try {
    const res = await api('DELETE', '/api/ai-models/' + id);
    if (res.success) { toast('删除成功', 'success'); loadModels(); }
    else toast(res.error || '删除失败', 'error');
  } catch (e) { toast('删除失败: ' + e.message, 'error'); }
}
