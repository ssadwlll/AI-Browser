/**
 * 数据库初始化脚本
 * 运行: node sql/init.js
 */
require('dotenv').config()
const mysql = require('mysql2/promise')
const fs = require('fs')
const path = require('path')
const bcrypt = require('bcryptjs')

async function init() {
  // 先连接 MySQL（不指定数据库）
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  })

  console.log('[Init] 已连接到 MySQL')

  // 读取并执行初始化 SQL
  const sql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf-8')
  await conn.query(sql)
  console.log('[Init] 数据库表结构创建完成')

  // 切换到 aibrowser 数据库
  await conn.query('USE aibrowser')

  // 创建默认管理员账号
  const hashedPassword = await bcrypt.hash('admin123', 10)
  await conn.query(
    `INSERT INTO users (username, password, role) VALUES (?, ?, 'admin')
     ON DUPLICATE KEY UPDATE username = username`,
    ['admin', hashedPassword],
  )
  console.log('[Init] 默认管理员账号: admin / admin123')

  await conn.end()
  console.log('[Init] 数据库初始化完成！')
}

init().catch(err => {
  console.error('[Init] 初始化失败:', err.message)
  process.exit(1)
})