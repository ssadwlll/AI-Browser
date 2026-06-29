// ============ 附件管理 ============
let attPage = 1

async function loadAttachments(page) {
  attPage = page || 1
  const type = document.getElementById('attFilter').value
  let url = '/api/attachments?page=' + attPage + '&limit=15'
  if (type) url += '&type=' + type
  try {
    const res = await api('GET', url)
    const tbody = document.getElementById('attTable')
    if (res.success && res.data && res.data.length > 0) {
      tbody.innerHTML = res.data.map(a => {
        const isImage = a.mime_type && a.mime_type.startsWith('image/')
        const preview = isImage
          ? '<img src="' + esc(a.url) + '" style="width:48px;height:48px;object-fit:cover;border-radius:4px;border:1px solid var(--border)" alt="">'
          : '<span style="font-size:24px">' + (a.mime_type && a.mime_type.includes('pdf') ? '📄' : '📎') + '</span>'
        var delClick = "deleteAttachment(" + a.id + ",'" + esc(a.original_name) + "')"
        return '<tr>' +
          '<td>' + a.id + '</td>' +
          '<td>' + preview + '</td>' +
          '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(a.original_name) + '">' + esc(a.original_name) + '</td>' +
          '<td>' + fmtSize(a.file_size) + '</td>' +
          '<td style="font-size:11px;color:var(--text2)">' + esc(a.mime_type || '-') + '</td>' +
          '<td>' + fmtDate(a.created_at) + '</td>' +
          '<td>' +
            '<a href="' + esc(a.url) + '" target="_blank" class="btn-icon" title="下载" style="text-decoration:none">⬇</a>' +
            '<button class="btn-icon danger" onclick="' + delClick + '" title="删除">🗑</button>' +
          '</td>' +
        '</tr>'
      }).join('')
    } else {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">暂无附件</td></tr>'
    }
    const pag = res.pagination || {}
    document.getElementById('attPagination').innerHTML =
      '<button ' + (pag.page <= 1 ? 'disabled' : '') + ' onclick="loadAttachments(' + (pag.page - 1) + ')">上一页</button>' +
      '<span>第 ' + (pag.page || 1) + ' / ' + (pag.totalPages || 1) + ' 页 (共 ' + (pag.total || 0) + ' 条)</span>' +
      '<button ' + (pag.page >= pag.totalPages ? 'disabled' : '') + ' onclick="loadAttachments(' + (pag.page + 1) + ')">下一页</button>'
  } catch(e) {
    document.getElementById('attTable').innerHTML = '<tr><td colspan="7" class="empty-state">加载失败: ' + e.message + '</td></tr>'
  }
}

async function uploadAttachments(files) {
  if (!files || files.length === 0) return
  const progress = document.getElementById('attUploadProgress')
  progress.style.display = 'block'
  let success = 0, fail = 0

  for (const file of files) {
    progress.textContent = '上传中: ' + file.name + '...'
    const form = new FormData()
    form.append('file', file)
    try {
      const res = await api('POST', '/api/attachments/upload', form, true)
      if (res.success) success++
      else { fail++; toast(file.name + ': ' + (res.message || '失败'), 'error') }
    } catch(e) {
      fail++
      toast(file.name + ': 网络错误', 'error')
    }
  }
  progress.style.display = 'none'
  document.getElementById('attFileInput').value = ''
  if (success > 0) toast('成功上传 ' + success + ' 个文件', 'success')
  if (fail > 0) toast(fail + ' 个文件上传失败', 'error')
  loadAttachments(attPage)
}

async function deleteAttachment(id, name) {
  if (!confirm('确定删除附件 "' + name + '" 吗？')) return
  try {
    const res = await api('DELETE', '/api/attachments/' + id)
    if (res.success) {
      toast('附件已删除', 'success')
      loadAttachments(attPage)
    } else {
      toast('删除失败: ' + (res.message || res.error), 'error')
    }
  } catch(e) {
    toast('网络错误', 'error')
  }
}
