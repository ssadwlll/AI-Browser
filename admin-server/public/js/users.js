let currentUserPage = 1;

// ============ 用户管理 ============
async function loadUsers(page) {
  currentUserPage = page || 1;
  const keyword = document.getElementById('userSearch').value.trim();
  let params = `page=${currentUserPage}&pageSize=15`;
  if (keyword) params += '&keyword=' + encodeURIComponent(keyword);
  try {
    const res = await api('GET', '/api/users?' + params);
    const tbody = document.getElementById('userTable');
    if (res.success && res.data && res.data.length > 0) {
      tbody.innerHTML = res.data.map(u => `
        <tr>
          <td>${u.id}</td>
          <td>${esc(u.username)}</td>
          <td><span class="badge badge-${u.role}">${u.role}</span></td>
          <td><span class="badge badge-${u.status===1?'active':'disabled'}">${u.status===1?'启用':'禁用'}</span></td>
          <td>${fmtDate(u.created_at)}</td>
          <td>
            <button class="btn-icon" onclick="editUser(${u.id},'${esc(u.username)}','${u.role}',${u.status})" title="编辑">✏</button>
            ${u.id!==1 ? `<button class="btn-icon danger" onclick="deleteUser(${u.id},'${esc(u.username)}')" title="删除">🗑</button>` : ''}
          </td>
        </tr>`).join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">暂无用户</td></tr>';
    }
    const pag = res.pagination || {};
    document.getElementById('userPagination').innerHTML = `
      <button ${pag.page<=1?'disabled':''} onclick="loadUsers(${pag.page-1})">上一页</button>
      <span>第 ${pag.page||1} / ${pag.totalPages||1} 页 (共 ${pag.total||0} 条)</span>
      <button ${pag.page>=pag.totalPages?'disabled':''} onclick="loadUsers(${pag.page+1})">下一页</button>`;
  } catch(e) { console.error(e); }
}

function showUserModal(user) {
  document.getElementById('userModal').classList.remove('hidden');
  document.getElementById('userModalError').style.display = 'none';
  if (user) {
    document.getElementById('userModalTitle').textContent = '编辑用户';
    document.getElementById('editUserId').value = user.id;
    document.getElementById('editUserName').value = user.username;
    document.getElementById('editUserPass').value = '';
    document.getElementById('pwdHint').textContent = '(留空不修改)';
    document.getElementById('editUserRole').value = user.role;
    document.getElementById('editUserStatus').value = user.status;
  } else {
    document.getElementById('userModalTitle').textContent = '添加用户';
    document.getElementById('editUserId').value = '';
    document.getElementById('editUserName').value = '';
    document.getElementById('editUserPass').value = '';
    document.getElementById('pwdHint').textContent = '*';
    document.getElementById('editUserRole').value = 'editor';
    document.getElementById('editUserStatus').value = '1';
  }
}

function closeUserModal() { document.getElementById('userModal').classList.add('hidden'); }

async function editUser(id, username, role, status) {
  showUserModal({ id, username, role, status });
}

async function saveUser() {
  const id = document.getElementById('editUserId').value;
  const username = document.getElementById('editUserName').value.trim();
  const password = document.getElementById('editUserPass').value;
  const role = document.getElementById('editUserRole').value;
  const status = parseInt(document.getElementById('editUserStatus').value);
  const errEl = document.getElementById('userModalError');
  if (!username) { errEl.textContent = '用户名不能为空'; errEl.style.display = 'block'; return; }
  if (!id && !password) { errEl.textContent = '密码不能为空'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none';
  const body = { username, role, status };
  if (password) body.password = password;
  try {
    const res = await api(id ? 'PUT' : 'POST', id ? '/api/users/' + id : '/api/users', body);
    if (res.success) { closeUserModal(); loadUsers(currentUserPage); toast(id ? '更新成功' : '创建成功', 'success'); }
    else { errEl.textContent = res.message || res.error || '操作失败'; errEl.style.display = 'block'; }
  } catch(e) { errEl.textContent = '网络错误'; errEl.style.display = 'block'; }
}

async function deleteUser(id, name) {
  if (!confirm('确定删除用户 "' + name + '" 吗？\n该用户的所有脚本和统计数据将被清空。')) return;
  try {
    const res = await api('DELETE', '/api/users/' + id);
    if (res.success) { loadUsers(currentUserPage); toast('删除成功', 'success'); }
    else { toast('删除失败: ' + (res.message||res.error), 'error'); }
  } catch(e) { toast('网络错误', 'error'); }
}
