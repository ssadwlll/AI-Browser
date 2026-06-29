// ============ 分类管理 ============
async function loadCategories() {
  try {
    const res = await api('GET', '/api/categories');
    const tbody = document.getElementById('categoryTable');
    if (res.success && res.data && res.data.length > 0) {
      tbody.innerHTML = res.data.map(c => `
        <tr>
          <td>${c.id}</td>
          <td>${esc(c.name)}</td>
          <td>${esc(c.slug)}</td>
          <td>${esc(c.description||'-')}</td>
          <td>${c.script_count||0}</td>
          <td>${c.sort_order||0}</td>
          <td>
            <button class="btn-icon" onclick="editCategory(${c.id},'${esc(c.name)}','${esc(c.slug)}','${esc(c.description||'')}',${c.sort_order||0})" title="编辑">✏</button>
            <button class="btn-icon danger" onclick="deleteCategory(${c.id},'${esc(c.name)}')" title="删除">🗑</button>
          </td>
        </tr>`).join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">暂无分类</td></tr>';
    }
  } catch(e) { console.error(e); }
}

function showCategoryModal(cat) {
  document.getElementById('categoryModal').classList.remove('hidden');
  document.getElementById('categoryModalError').style.display = 'none';
  if (cat) {
    document.getElementById('categoryModalTitle').textContent = '编辑分类';
    document.getElementById('editCatId').value = cat.id;
    document.getElementById('editCatName').value = cat.name;
    document.getElementById('editCatSlug').value = cat.slug;
    document.getElementById('editCatDesc').value = cat.description || '';
    document.getElementById('editCatSort').value = cat.sortOrder;
  } else {
    document.getElementById('categoryModalTitle').textContent = '添加分类';
    document.getElementById('editCatId').value = '';
    document.getElementById('editCatName').value = '';
    document.getElementById('editCatSlug').value = '';
    document.getElementById('editCatDesc').value = '';
    document.getElementById('editCatSort').value = '0';
  }
}

function closeCategoryModal() { document.getElementById('categoryModal').classList.remove('hidden'); document.getElementById('categoryModal').classList.add('hidden'); }

function editCategory(id, name, slug, desc, sort) {
  showCategoryModal({ id, name, slug, description: desc, sortOrder: sort });
}

async function saveCategory() {
  const id = document.getElementById('editCatId').value;
  const name = document.getElementById('editCatName').value.trim();
  const slug = document.getElementById('editCatSlug').value.trim();
  const description = document.getElementById('editCatDesc').value.trim();
  const sortOrder = parseInt(document.getElementById('editCatSort').value) || 0;
  const errEl = document.getElementById('categoryModalError');
  if (!name || !slug) { errEl.textContent = '名称和Slug不能为空'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none';

  try {
    const body = { name, slug, description, sort_order: sortOrder };
    const res = await api(id ? 'PUT' : 'POST', id ? '/api/categories/' + id : '/api/categories', body);
    if (res.success) {
      closeCategoryModal();
      loadCategories();
      loadCategoriesForSelect();
      toast(id ? '分类更新成功' : '分类创建成功', 'success');
    } else {
      errEl.textContent = res.message || res.error || '操作失败';
      errEl.style.display = 'block';
    }
  } catch(e) {
    errEl.textContent = '网络错误: ' + e.message;
    errEl.style.display = 'block';
  }
}

async function deleteCategory(id, name) {
  if (!confirm('确定删除分类 "' + name + '" 吗？\n该分类下的脚本将被移至未分类。')) return;
  try {
    const res = await api('DELETE', '/api/categories/' + id);
    if (res.success) {
      loadCategories();
      loadCategoriesForSelect();
      toast('分类删除成功', 'success');
    } else {
      toast('删除失败: ' + (res.message||res.error), 'error');
    }
  } catch(e) {
    toast('网络错误', 'error');
  }
}
