const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const pool = require('../config/db')
const { success, error } = require('../utils/response')

exports.login = async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      return res.status(400).json(error('用户名和密码不能为空', 400))
    }

    const [rows] = await pool.query('SELECT * FROM users WHERE username = ? AND status = 1', [username])
    if (rows.length === 0) {
      return res.status(401).json(error('用户名或密码错误', 401))
    }

    const user = rows[0]
    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      return res.status(401).json(error('用户名或密码错误', 401))
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET || 'ai-browser-secret',
      { expiresIn: '7d' },
    )

    res.json(success({
      token,
      user: { id: user.id, username: user.username, role: user.role },
    }, '登录成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

exports.register = async (req, res) => {
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

    res.json(success({ id: result.insertId, username }, '注册成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

exports.me = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, username, role, created_at FROM users WHERE id = ?', [req.user.id])
    if (rows.length === 0) {
      return res.status(404).json(error('用户不存在', 404))
    }
    res.json(success(rows[0]))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}