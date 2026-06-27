const pool = require('../config/db')
const { success, error, paginated } = require('../utils/response')

// 获取分类列表
exports.list = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, COUNT(s.id) as script_count
       FROM categories c
       LEFT JOIN scripts s ON c.id = s.category_id
       GROUP BY c.id
       ORDER BY c.sort_order`,
    )
    res.json(success(rows))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 获取分类详情
exports.detail = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM categories WHERE id = ?', [req.params.id])
    if (rows.length === 0) {
      return res.status(404).json(error('分类不存在', 404))
    }
    res.json(success(rows[0]))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 创建分类
exports.create = async (req, res) => {
  try {
    const { name, slug, description, sort_order } = req.body
    if (!name || !slug) {
      return res.status(400).json(error('分类名称和Slug不能为空', 400))
    }

    // 检查 slug 是否重复
    const [existing] = await pool.query('SELECT id FROM categories WHERE slug = ?', [slug])
    if (existing.length > 0) {
      return res.status(400).json(error('Slug 已存在，请使用其他标识', 400))
    }

    const [result] = await pool.query(
      'INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)',
      [name, slug, description || '', sort_order || 0],
    )

    res.json(success({ id: result.insertId, name, slug }, '分类创建成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 更新分类
exports.update = async (req, res) => {
  try {
    const { name, slug, description, sort_order } = req.body
    const fields = []
    const params = []

    if (name) { fields.push('name = ?'); params.push(name) }
    if (slug) { fields.push('slug = ?'); params.push(slug) }
    if (description !== undefined) { fields.push('description = ?'); params.push(description) }
    if (sort_order !== undefined) { fields.push('sort_order = ?'); params.push(parseInt(sort_order)) }

    if (fields.length === 0) {
      return res.status(400).json(error('没有需要更新的字段', 400))
    }

    // 检查分类是否存在
    const [cat] = await pool.query('SELECT id FROM categories WHERE id = ?', [req.params.id])
    if (cat.length === 0) {
      return res.status(404).json(error('分类不存在', 404))
    }

    // 如果更新 slug，检查是否重复
    if (slug) {
      const [existing] = await pool.query('SELECT id FROM categories WHERE slug = ? AND id != ?', [slug, req.params.id])
      if (existing.length > 0) {
        return res.status(400).json(error('Slug 已被其他分类使用', 400))
      }
    }

    params.push(req.params.id)
    await pool.query(`UPDATE categories SET ${fields.join(', ')} WHERE id = ?`, params)

    res.json(success(null, '分类更新成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 删除分类
exports.remove = async (req, res) => {
  try {
    const [cat] = await pool.query('SELECT id FROM categories WHERE id = ?', [req.params.id])
    if (cat.length === 0) {
      return res.status(404).json(error('分类不存在', 404))
    }

    // 将该分类下的脚本 category_id 置空
    await pool.query('UPDATE scripts SET category_id = NULL WHERE category_id = ?', [req.params.id])
    // 删除分类
    await pool.query('DELETE FROM categories WHERE id = ?', [req.params.id])

    res.json(success(null, '分类删除成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}
