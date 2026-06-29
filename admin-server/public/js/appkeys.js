// ============ AppKey 管理 ============
let editingAppKeyId = null;

async function loadAppKeys() {
  try {
    const res = await api('GET', '/api/app-keys');
    if (res.success) {
      const tbody = document.getElementById('appKeyList');
      if (!res.data.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-state">暂无数据</td></tr>'; return; }
      tbody.innerHTML = res.data.map(k => `
        <tr>
          <td style="font-family:monospace;font-size:12px">${k.app_key}</td>
          <td style="font-family:monospace;font-size:12px">${k.app_secret_masked || '****'}</td>
          <td>${k.name || '-'}</td>
          <td>${k.daily_limit || '不限'}</td>
          <td><span class="badge ${k.status ? 'badge-active' : 'badge-disabled'}">${k.status ? '启用' : '禁用'}</span></td>
          <td>${new Date(k.created_at).toLocaleString()}</td>
          <td>
            <button class="btn-icon" onclick="editAppKey(${k.id})">✏️</button>
            <button class="btn-icon danger" onclick="deleteAppKey(${k.id}, '${k.name}')">🗑️</button>
          </td>
        </tr>`).join('');
    }
  } catch (e) { toast('加载失败: ' + e.message, 'error'); }
}

function showAppKeyModal(data) {
  editingAppKeyId = data?.id || null;
  document.getElementById('appKeyModalTitle').textContent = data ? '编辑 AppKey' : '新建 AppKey';
  document.getElementById('appKeyName').value = data?.name || '';
  document.getElementById('appKeyDailyLimit').value = data?.daily_limit ?? 200;
  document.getElementById('appKeyStatus').value = data?.status ?? 1;
  document.getElementById('appKeyModal').classList.remove('hidden');
}
function closeAppKeyModal() { document.getElementById('appKeyModal').classList.add('hidden'); }

function editAppKey(id) {
  api('GET', '/api/app-keys').then(res => {
    if (res.success) {
      const k = res.data.find(x => x.id === id);
      if (k) showAppKeyModal(k);
    }
  });
}

async function saveAppKey() {
  const body = {
    name: document.getElementById('appKeyName').value,
    daily_limit: parseInt(document.getElementById('appKeyDailyLimit').value) || 0,
    status: parseInt(document.getElementById('appKeyStatus').value),
  };
  try {
    const res = editingAppKeyId
      ? await api('PUT', '/api/app-keys/' + editingAppKeyId, body)
      : await api('POST', '/api/app-keys', body);
    if (res.success) {
      if (!editingAppKeyId && res.data.app_secret) {
        closeAppKeyModal();
        showAppKeyResult(res.data.app_key, res.data.app_secret);
      } else {
        toast('更新成功', 'success');
        closeAppKeyModal();
        loadAppKeys();
      }
    } else { toast(res.error || '操作失败', 'error'); }
  } catch (e) { toast('操作失败: ' + e.message, 'error'); }
}

async function deleteAppKey(id, name) {
  if (!confirm('确定删除 AppKey「' + (name || id) + '」？')) return;
  try {
    const res = await api('DELETE', '/api/app-keys/' + id);
    if (res.success) { toast('删除成功', 'success'); loadAppKeys(); }
    else toast(res.error || '删除失败', 'error');
  } catch (e) { toast('删除失败: ' + e.message, 'error'); }
}

function showAppKeyResult(appKey, appSecret) {
  document.getElementById('resultAppKey').value = appKey;
  document.getElementById('resultAppSecret').value = appSecret;
  document.getElementById('appKeyResultModal').classList.remove('hidden');
  loadAppKeys();
}
function closeAppKeyResult() {
  document.getElementById('appKeyResultModal').classList.add('hidden');
}
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('已复制', 'success')).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    toast('已复制', 'success');
  });
}
