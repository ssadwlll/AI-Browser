const mysql = require('mysql2/promise')

;(async () => {
  const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'aibrowser',
    port: 3306
  })
  const sql = "SELECT id, name, file_path, tool_type, status FROM scripts WHERE name LIKE '%B站%' OR name LIKE '%bilibili%' OR id = 12"
  const [rows] = await pool.query(sql)
  console.log(JSON.stringify(rows, null, 2))
  await pool.end()
})().catch(e => {
  console.error('ERR:', e.message)
  process.exit(1)
})
