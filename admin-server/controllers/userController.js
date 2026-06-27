const bcrypt = require('bcryptjs')
const pool = require('../config/db')
const { success, error, paginated } = require('../utils/response')

// 获取用户列表
exports.list = async (req, res) => {
  try {
    const { page = 1, pageSize = 20, keyword } = req.query
    const offset = (parseInt(page) - 1) * parseInt(pageSize)

    let where = 'WHERE 1=1'
    const params = []

    if (keyword) {
      where += ' AND (username LIKE ? OR role LIKE ?)'
      params.push(`%${keyword}%`, `%${keyword}%`)
    }

    const [rows] = await pool.query(
      `SELECT id, username, role, status, created_at, updated_at FROM users ${where} ORDER BY id ASC LIMIT ? OFFSET ?`,
      [...params, parseInt(pageSize), offset],
    )

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM users ${where}`,
      params,
    )

    res.json(paginated(rows, parseInt(page), parseInt(pageSize), total))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 创建用户
exports.create = async (req, res) => {
  try {
    const { username, password, role } = req.body
    if (!username || !password) {
      return res.status(400).json(error('用户名和密码不能为空', 400))
    }

    const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [username])
    if (existing.length > 0) {
      return res.status(400).json(error('用户名已存在', 400))
    }

    const hashedPassword = await bcrypt.hash(password, 10)
    const [result] = await pool.query(
      'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
      [username, hashedPassword, role || 'editor'],
    )

    res.json(success({ id: result.insertId, username, role: role || 'editor' }, '用户创建成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 更新用户
exports.update = async (req, res) => {
  try {
    const { username, password, role, status } = req.body
    const fields = []
    const params = []

    if (username) { fields.push('username = ?'); params.push(username) }
    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10)
      fields.push('password = ?'); params.push(hashedPassword)
    }
    if (role) { fields.push('role = ?'); params.push(role) }
    if (status !== undefined) { fields.push('status = ?'); params.push(parseInt(status)) }

    if (fields.length === 0) {
      return res.status(400).json(error('没有需要更新的字段', 400))
    }

    params.push(req.params.id)
    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params)

    res.json(success(null, '更新成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 删除用户
exports.remove = async (req, res) => {
  try {
    const userId = parseInt(req.params.id)
    if (userId === 1) {
      return res.status(400).json(error('不能删除超级管理员', 400))
    }

    const [rows] = await pool.query('SELECT id FROM users WHERE id = ?', [userId])
    if (rows.length === 0) {
      return res.status(404).json(error('用户不存在', 404))
    }

    // 将该用户的脚本作者设为 NULL
    await pool.query('UPDATE scripts SET author_id = NULL WHERE author_id = ?', [userId])
    await pool.query('DELETE FROM usage_stats WHERE user_id = ?', [userId])
    await pool.query('DELETE FROM users WHERE id = ?', [userId])

    res.json(success(null, '删除成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}