const pool = require('../config/db')
const { success, error, paginated } = require('../utils/response')

const safeParse = v => {
  if (v === null || v === undefined) return v === 0 || v === false ? v : null
  return typeof v === 'string' ? JSON.parse(v) : v
}

/**
 * 将数据库行转换为前端期望的模板格式
 * 前端格式（与 BUILTIN_TEMPLATES 一致）：
 *   { id, name, description, fields, dataKind, template, css }
 */
function rowToTemplate(row) {
  return {
    id: row.template_id,
    name: row.name,
    description: row.description || '',
    fields: safeParse(row.fields),
    dataKind: row.data_kind || 'array',
    template: row.template,
    css: row.css || '',
  }
}

// ============ 扩展端接口（AppKey 鉴权）============

/**
 * 扩展端拉取所有已发布模板
 * GET /api/report-templates
 * 返回格式与前端 BUILTIN_TEMPLATES 一致，便于无缝合并
 */
exports.listForAgent = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT template_id, name, description, fields, data_kind, template, css
       FROM report_templates
       WHERE status = 'published'
       ORDER BY sort_order ASC, id ASC`
    )
    const templates = rows.map(rowToTemplate)
    res.json(success(templates))
  } catch (err) {
    // 表可能尚未创建（未执行迁移），返回空数组而非报错
    if (err.code === 'ER_NO_SUCH_TABLE') {
      console.warn('[ReportTemplates] 表不存在，返回空数组。请先执行 migrate_report_templates.sql')
      return res.json(success([]))
    }
    res.status(500).json(error(err.message))
  }
}

// ============ 管理后台接口（JWT 鉴权）============

/**
 * 管理后台 - 模板列表（分页）
 * GET /api/report-templates/admin?page=1&pageSize=20&keyword=&status=
 */
exports.list = async (req, res) => {
  try {
    const { page = 1, pageSize = 20, keyword, status } = req.query
    const offset = (parseInt(page) - 1) * parseInt(pageSize)

    let where = 'WHERE 1=1'
    const params = []

    if (keyword) {
      where += ' AND (name LIKE ? OR description LIKE ? OR template_id LIKE ?)'
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
    }
    if (status) {
      where += ' AND status = ?'
      params.push(status)
    }

    const [rows] = await pool.query(
      `SELECT id, template_id, name, description, fields, data_kind, template, css,
              sort_order, status, created_at, updated_at
       FROM report_templates
       ${where}
       ORDER BY sort_order ASC, id ASC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(pageSize), offset]
    )

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM report_templates ${where}`,
      params
    )

    for (const row of rows) {
      row.fields = safeParse(row.fields)
    }

    res.json(paginated(rows, parseInt(page), parseInt(pageSize), total))
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json(paginated([], 1, 20, 0))
    }
    res.status(500).json(error(err.message))
  }
}

/**
 * 管理后台 - 模板详情
 * GET /api/report-templates/admin/:id
 */
exports.detail = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM report_templates WHERE id = ?`,
      [req.params.id]
    )
    if (rows.length === 0) {
      return res.status(404).json(error('模板不存在', 404))
    }
    const row = rows[0]
    row.fields = safeParse(row.fields)
    res.json(success(row))
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.status(404).json(error('模板表不存在，请先执行迁移', 404))
    }
    res.status(500).json(error(err.message))
  }
}

/**
 * 管理后台 - 创建模板
 * POST /api/report-templates/admin
 */
exports.create = async (req, res) => {
  try {
    const { template_id, name, description, fields, data_kind, template, css, sort_order, status } = req.body

    if (!template_id || !name || !template) {
      return res.status(400).json(error('template_id、name、template 为必填项', 400))
    }

    // 检查 template_id 是否已存在
    const [existing] = await pool.query(
      'SELECT id FROM report_templates WHERE template_id = ?',
      [template_id]
    )
    if (existing.length > 0) {
      return res.status(400).json(error(`模板ID "${template_id}" 已存在`, 400))
    }

    const [result] = await pool.query(
      `INSERT INTO report_templates (template_id, name, description, fields, data_kind, template, css, sort_order, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        template_id,
        name,
        description || '',
        fields ? JSON.stringify(fields) : null,
        data_kind || 'array',
        template,
        css || '',
        sort_order || 0,
        status || 'published',
      ]
    )

    res.json(success({ id: result.insertId, template_id }, '模板创建成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

/**
 * 管理后台 - 更新模板
 * PUT /api/report-templates/admin/:id
 */
exports.update = async (req, res) => {
  try {
    const { template_id, name, description, fields, data_kind, template, css, sort_order, status } = req.body
    const fields_list = []
    const params = []

    if (template_id) { fields_list.push('template_id = ?'); params.push(template_id) }
    if (name) { fields_list.push('name = ?'); params.push(name) }
    if (description !== undefined) { fields_list.push('description = ?'); params.push(description) }
    if (fields !== undefined) { fields_list.push('fields = ?'); params.push(fields ? JSON.stringify(fields) : null) }
    if (data_kind) { fields_list.push('data_kind = ?'); params.push(data_kind) }
    if (template) { fields_list.push('template = ?'); params.push(template) }
    if (css !== undefined) { fields_list.push('css = ?'); params.push(css || '') }
    if (sort_order !== undefined) { fields_list.push('sort_order = ?'); params.push(sort_order) }
    if (status) { fields_list.push('status = ?'); params.push(status) }

    if (fields_list.length === 0) {
      return res.status(400).json(error('没有需要更新的字段', 400))
    }

    // 如果更新了 template_id，检查唯一性
    if (template_id) {
      const [conflict] = await pool.query(
        'SELECT id FROM report_templates WHERE template_id = ? AND id != ?',
        [template_id, req.params.id]
      )
      if (conflict.length > 0) {
        return res.status(400).json(error(`模板ID "${template_id}" 已被其他模板占用`, 400))
      }
    }

    params.push(req.params.id)
    await pool.query(`UPDATE report_templates SET ${fields_list.join(', ')} WHERE id = ?`, params)

    res.json(success(null, '模板更新成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

/**
 * 管理后台 - 删除模板
 * DELETE /api/report-templates/admin/:id
 */
exports.remove = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id FROM report_templates WHERE id = ?', [req.params.id])
    if (rows.length === 0) {
      return res.status(404).json(error('模板不存在', 404))
    }
    await pool.query('DELETE FROM report_templates WHERE id = ?', [req.params.id])
    res.json(success(null, '模板删除成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}
