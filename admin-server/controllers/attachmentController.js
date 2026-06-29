const db = require('../config/db')
const path = require('path')
const fs = require('fs')

// POST /api/attachments/upload — 上传附件
exports.upload = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: '请选择要上传的文件' })
    }
    const file = req.file
    const [result] = await db.query(
      'INSERT INTO attachments (filename, original_name, file_size, mime_type, file_path, purpose) VALUES (?, ?, ?, ?, ?, ?)',
      [file.filename, file.originalname, file.size, file.mimetype, 'uploads/' + file.filename, 'attachment']
    )
    res.json({
      success: true,
      data: {
        id: result.insertId,
        filename: file.filename,
        original_name: file.originalname,
        file_size: file.size,
        mime_type: file.mimetype,
        url: '/uploads/' + file.filename,
        created_at: new Date().toISOString()
      }
    })
  } catch (err) {
    console.error('[AttachmentController] upload 失败:', err)
    res.status(500).json({ success: false, message: '上传失败: ' + err.message })
  }
}

// GET /api/attachments — 列表（带分页）
exports.list = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = Math.min(parseInt(req.query.limit) || 20, 100)
    const offset = (page - 1) * limit
    const type = req.query.type // image, pdf, all

    let where = ''
    const params = []
    if (type === 'image') {
      where = " WHERE mime_type LIKE 'image/%'"
    } else if (type === 'pdf') {
      where = " WHERE mime_type LIKE '%pdf%' OR mime_type LIKE '%PDF%'"
    }

    const [[{ total }]] = await db.query('SELECT COUNT(*) AS total FROM attachments' + where, params)
    const [rows] = await db.query(
      'SELECT id, filename, original_name, file_size, mime_type, file_path, purpose, created_at FROM attachments' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [...params, limit, offset]
    )

    res.json({
      success: true,
      data: rows.map(r => ({
        ...r,
        url: '/' + r.file_path
      })),
      pagination: {
        page, limit, total, totalPages: Math.ceil(total / limit)
      }
    })
  } catch (err) {
    console.error('[AttachmentController] list 失败:', err)
    res.status(500).json({ success: false, message: '查询失败: ' + err.message })
  }
}

// DELETE /api/attachments/:id — 删除附件
exports.remove = async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const [rows] = await db.query('SELECT * FROM attachments WHERE id = ?', [id])
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '附件不存在' })
    }

    const attachment = rows[0]
    const filePath = path.join(__dirname, '..', attachment.file_path)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }

    await db.query('DELETE FROM attachments WHERE id = ?', [id])
    res.json({ success: true, message: '已删除' })
  } catch (err) {
    console.error('[AttachmentController] remove 失败:', err)
    res.status(500).json({ success: false, message: '删除失败: ' + err.message })
  }
}
