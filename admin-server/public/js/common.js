// ============ 工具函数 ============
function toast(msg, type) {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

async function api(method, path, body, isFormData) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (!isFormData) headers['Content-Type'] = 'application/json';
  const opts = { method, headers };
  if (body) opts.body = isFormData ? body : JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (res.status === 401) { logout(); throw new Error('登录已过期'); }
  return data;
}

// ============ 辅助函数 ============
function esc(str) { return (str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function fmtDate(d) { if(!d) return '-'; return new Date(d).toLocaleString('zh-CN'); }

function fmtSize(bytes) {
  if (!bytes) return '-'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}
