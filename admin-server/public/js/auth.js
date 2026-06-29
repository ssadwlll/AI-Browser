// ============ 全局状态 ============
let token = '';
let currentUser = null;

// ============ 登录/登出 ============
async function login() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value.trim();
  const errEl = document.getElementById('loginError');
  if (!username || !password) { errEl.textContent = '请输入用户名和密码'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!data.success) { errEl.textContent = data.message || data.error || '登录失败'; errEl.style.display = 'block'; return; }
    token = data.data.token;
    currentUser = data.data.user;
    // 保存到 localStorage，刷新页面不需要重新登录
    localStorage.setItem('admin_token', token);
    localStorage.setItem('admin_user', JSON.stringify(currentUser));
    document.getElementById('loginPage').classList.add('hidden');
    document.getElementById('mainPage').classList.remove('hidden');
    document.getElementById('sidebarUser').textContent = username + ' (' + currentUser.role + ')';
    document.getElementById('tokenDisplay').textContent = token;
    switchPage('dashboard');
    toast('登录成功', 'success');
  } catch(e) { errEl.textContent = '网络错误: ' + e.message; errEl.style.display = 'block'; }
}

function logout() {
  token = ''; currentUser = null;
  localStorage.removeItem('admin_token');
  localStorage.removeItem('admin_user');
  document.getElementById('loginPage').classList.remove('hidden');
  document.getElementById('mainPage').classList.add('hidden');
}

// ============ Token 管理 ============
function copyToken() {
  if (token) {
    navigator.clipboard.writeText(token).then(() => toast('Token 已复制到剪贴板', 'success'));
  }
}

function refreshToken() {
  document.getElementById('loginPage').classList.remove('hidden');
  document.getElementById('mainPage').classList.add('hidden');
  token = '';
  document.getElementById('loginUser').value = 'admin';
  document.getElementById('loginPass').value = 'admin123';
  toast('请重新登录获取新 Token', 'success');
}

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', () => {
  // 工具类型切换 - 上传表单
  document.getElementById('uploadToolType').addEventListener('change', function() {
    document.getElementById('uploadToolConfigGroup').style.display = this.value === 'api' ? '' : 'none';
  });
  // 工具类型切换 - 编辑表单
  document.getElementById('codeEditToolType').addEventListener('change', function() {
    document.getElementById('codeEditToolConfigGroup').style.display = this.value === 'api' ? '' : 'none';
  });

  // 优先从 localStorage 恢复登录状态
  const savedToken = localStorage.getItem('admin_token');
  const savedUser = localStorage.getItem('admin_user');
  if (savedToken) {
    token = savedToken;
    try { currentUser = JSON.parse(savedUser); } catch { currentUser = null; }
    document.getElementById('loginPage').classList.add('hidden');
    document.getElementById('mainPage').classList.remove('hidden');
    if (currentUser) document.getElementById('sidebarUser').textContent = currentUser.username + ' (' + currentUser.role + ')';
    document.getElementById('tokenDisplay').textContent = token;
    switchPage('dashboard');
    loadCategoriesForSelect();
  } else {
    // 检查 URL hash 中的 token
    const hash = window.location.hash;
    if (hash.startsWith('#token=')) {
      token = hash.substring(7);
      localStorage.setItem('admin_token', token);
      document.getElementById('loginPage').classList.add('hidden');
      document.getElementById('mainPage').classList.remove('hidden');
      document.getElementById('tokenDisplay').textContent = token;
      switchPage('dashboard');
      loadCategoriesForSelect();
    }
  }
  // 回车键自动登录
  document.getElementById('loginPass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
  });
  // 附件上传区域事件
  const uploadZone = document.getElementById('attUploadZone')
  const fileInput = document.getElementById('attFileInput')
  if (uploadZone && fileInput) {
    uploadZone.addEventListener('click', () => fileInput.click())
    uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.style.borderColor = 'var(--primary)'; })
    uploadZone.addEventListener('dragleave', () => { uploadZone.style.borderColor = 'var(--border)'; })
    uploadZone.addEventListener('drop', (e) => {
      e.preventDefault()
      uploadZone.style.borderColor = 'var(--border)'
      uploadAttachments(e.dataTransfer.files)
    })
  }
});
