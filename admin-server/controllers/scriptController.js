const pool = require('../config/db')
const fs = require('fs')
const path = require('path')
const { success, error, paginated } = require('../utils/response')

// 获取脚本列表
exports.list = async (req, res) => {
  try {
    const { page = 1, pageSize = 20, category, keyword, status } = req.query
    const offset = (parseInt(page) - 1) * parseInt(pageSize)

    let where = "WHERE s.status = 'published'"
    const params = []

    if (category) {
      where += ' AND c.slug = ?'
      params.push(category)
    }
    if (keyword) {
      where += ' AND (s.name LIKE ? OR s.description LIKE ?)'
      params.push(`%${keyword}%`, `%${keyword}%`)
    }
    // 管理员可查看所有状态
    if (req.user.role === 'admin' && status) {
      where = where.replace("s.status = 'published'", 's.status = ?')
      params[0] = status
    }

    const [rows] = await pool.query(
      `SELECT s.id, s.name, s.description, s.version, s.icon, s.url_pattern,
              s.download_count, s.status, s.updated_at,
              c.name as category_name, c.slug as category_slug,
              u.username as author_name
       FROM scripts s
       LEFT JOIN categories c ON s.category_id = c.id
       LEFT JOIN users u ON s.author_id = u.id
       ${where}
       ORDER BY s.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(pageSize), offset],
    )

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM scripts s LEFT JOIN categories c ON s.category_id = c.id ${where}`,
      params,
    )

    res.json(paginated(rows, parseInt(page), parseInt(pageSize), total))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 获取脚本详情
exports.detail = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.*, c.name as category_name, u.username as author_name
       FROM scripts s
       LEFT JOIN categories c ON s.category_id = c.id
       LEFT JOIN users u ON s.author_id = u.id
       WHERE s.id = ?`,
      [req.params.id],
    )
    if (rows.length === 0) {
      return res.status(404).json(error('脚本不存在', 404))
    }
    const script = rows[0]
    // 读取脚本文件内容，作为 code 字段返回
    if (script.file_path && fs.existsSync(script.file_path)) {
      script.code = fs.readFileSync(script.file_path, 'utf-8')
    } else {
      script.code = ''
    }
    // Fetch modules - with fallback if table doesn't exist yet
    try {
      const [modules] = await pool.query(
        'SELECT id, name, load_order FROM script_modules WHERE script_id = ? ORDER BY load_order',
        [script.id]
      )
      // Read each module's code from the script_modules table
      for (const mod of modules) {
        const [modRows] = await pool.query('SELECT code FROM script_modules WHERE id = ?', [mod.id])
        mod.code = modRows[0]?.code || ''
      }
      script.modules = modules
    } catch (e) {
      // Table may not exist yet (before migration)
      script.modules = []
    }
    // Parse params_schema and params_data
    // mysql2 对 JSON 列自动解析，需判断是否已是对象
    const safeParse = v => {
      if (!v) return v === 0 || v === false ? v : undefined
      return typeof v === 'string' ? JSON.parse(v) : v
    }
    try {
      script.params_schema = safeParse(script.params_schema) || []
      script.params_data = safeParse(script.params_data) || {}
    } catch (e) {
      script.params_schema = []
      script.params_data = {}
    }
    res.json(success(script))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 上传脚本
exports.create = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json(error('请上传脚本文件', 400))
    }

    const { name, description, category_id, version, url_pattern, icon, params_schema, params_data, modules } = req.body
    if (!name || !category_id) {
      // 删除已上传的文件
      fs.unlinkSync(req.file.path)
      return res.status(400).json(error('脚本名称和分类不能为空', 400))
    }

    // 解析脚本元数据
    const fileContent = fs.readFileSync(req.file.path, 'utf-8')
    const meta = parseScriptMeta(fileContent)
    const scriptName = name || meta.name || req.file.originalname.replace('.js', '')

    const [result] = await pool.query(
      `INSERT INTO scripts (name, description, category_id, version, author_id, file_path, file_size, icon, url_pattern, params_schema, params_data, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')`,
      [
        scriptName,
        description || meta.description || '',
        parseInt(category_id),
        version || meta.version || '1.0.0',
        req.user.id,
        req.file.path,
        req.file.size,
        icon || 'code',
        url_pattern || meta.urlPattern || '*',
        params_schema ? JSON.stringify(typeof params_schema === 'string' ? JSON.parse(params_schema) : params_schema) : null,
        params_data ? JSON.stringify(typeof params_data === 'string' ? JSON.parse(params_data) : params_data) : null,
      ],
    )

    // Insert modules if provided
    const scriptId = result.insertId
    if (modules) {
      const parsedModules = typeof modules === 'string' ? JSON.parse(modules) : modules
      if (Array.isArray(parsedModules)) {
        for (const mod of parsedModules) {
          await pool.query(
            'INSERT INTO script_modules (script_id, name, code, load_order) VALUES (?, ?, ?, ?)',
            [scriptId, mod.name, mod.code, mod.load_order || 0]
          )
        }
      }
    }

    // If no modules provided but file was uploaded, create a single module from the file
    if (!modules && req.file) {
      await pool.query(
        'INSERT INTO script_modules (script_id, name, code, load_order) VALUES (?, ?, ?, ?)',
        [scriptId, scriptName, fileContent, 0]
      )
    }

    res.json(success({ id: scriptId, name: scriptName }, '脚本上传成功'))
  } catch (err) {
    // 清理文件
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path)
    }
    res.status(500).json(error(err.message))
  }
}

// 更新脚本
exports.update = async (req, res) => {
  try {
    const { name, description, category_id, version, url_pattern, icon, status, code, params_schema, params_data, modules } = req.body
    const fields = []
    const params = []

    if (name) { fields.push('name = ?'); params.push(name) }
    if (description !== undefined) { fields.push('description = ?'); params.push(description) }
    if (category_id) { fields.push('category_id = ?'); params.push(parseInt(category_id)) }
    if (version) { fields.push('version = ?'); params.push(version) }
    if (url_pattern) { fields.push('url_pattern = ?'); params.push(url_pattern) }
    if (icon) { fields.push('icon = ?'); params.push(icon) }
    if (status) { fields.push('status = ?'); params.push(status) }
    if (params_schema !== undefined) { fields.push('params_schema = ?'); params.push(JSON.stringify(typeof params_schema === 'string' ? JSON.parse(params_schema) : params_schema)) }
    if (params_data !== undefined) { fields.push('params_data = ?'); params.push(JSON.stringify(typeof params_data === 'string' ? JSON.parse(params_data) : params_data)) }

    // 检查权限
    const [script] = await pool.query('SELECT author_id, file_path FROM scripts WHERE id = ?', [req.params.id])
    if (script.length === 0) {
      return res.status(404).json(error('脚本不存在', 404))
    }
    if (req.user.role !== 'admin' && script[0].author_id !== req.user.id) {
      return res.status(403).json(error('只能修改自己上传的脚本', 403))
    }

    // 如果提供了 code，写入脚本文件
    if (code !== undefined && script[0].file_path) {
      fs.writeFileSync(script[0].file_path, code, 'utf-8')
      // 更新文件大小
      const stat = fs.statSync(script[0].file_path)
      fields.push('file_size = ?')
      params.push(stat.size)
      // Update/insert the first module for backward compatibility
      const [existingModules] = await pool.query('SELECT id FROM script_modules WHERE script_id = ? ORDER BY load_order LIMIT 1', [req.params.id])
      if (existingModules.length > 0) {
        await pool.query('UPDATE script_modules SET code = ? WHERE id = ?', [code, existingModules[0].id])
      } else {
        await pool.query(
          'INSERT INTO script_modules (script_id, name, code, load_order) VALUES (?, ?, ?, ?)',
          [req.params.id, name || 'main', code, 0]
        )
      }
    }

    // If modules is provided, replace all existing modules
    if (modules !== undefined) {
      const parsedModules = typeof modules === 'string' ? JSON.parse(modules) : modules
      if (Array.isArray(parsedModules)) {
        // Delete old modules
        await pool.query('DELETE FROM script_modules WHERE script_id = ?', [req.params.id])
        // Insert new modules
        for (const mod of parsedModules) {
          await pool.query(
            'INSERT INTO script_modules (script_id, name, code, load_order) VALUES (?, ?, ?, ?)',
            [req.params.id, mod.name, mod.code, mod.load_order || 0]
          )
        }
      }
    }

    if (fields.length === 0 && modules === undefined && code === undefined) {
      return res.status(400).json(error('没有需要更新的字段', 400))
    }

    if (fields.length > 0) {
      params.push(req.params.id)
      await pool.query(`UPDATE scripts SET ${fields.join(', ')} WHERE id = ?`, params)
    }

    res.json(success(null, '更新成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 删除脚本
exports.remove = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT file_path, author_id FROM scripts WHERE id = ?', [req.params.id])
    if (rows.length === 0) {
      return res.status(404).json(error('脚本不存在', 404))
    }

    // 删除文件
    if (fs.existsSync(rows[0].file_path)) {
      fs.unlinkSync(rows[0].file_path)
    }

    await pool.query('DELETE FROM usage_stats WHERE script_id = ?', [req.params.id])
    await pool.query('DELETE FROM scripts WHERE id = ?', [req.params.id])

    res.json(success(null, '删除成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 生成本地脚本的油猴格式（接受代码参数，无需数据库记录）
exports.generateUserjs = async (req, res) => {
  try {
    const { name, description, code, url_pattern } = req.body
    if (!code) {
      return res.status(400).json(error('缺少 code 参数', 400))
    }

    // 如果代码已包含 ==UserScript== 块，直接输出
    if (code.includes('==UserScript==')) {
      res.type('text/javascript').send(code)
      return
    }

    const urlPattern = url_pattern || '*'
    const matchRules = urlPattern.split(',').map(p => p.trim()).filter(Boolean)
    const matchLines = matchRules.map(r => `// @match        ${r}`).join('\n')

    const header = `// ==UserScript==
// @name         ${name || '未命名脚本'}
// @namespace    ai-browser-scripts
// @version      1.0.0
// @description  ${description || ''}
// @author       AI Browser
${matchLines}
// @grant        none
// @run-at       document-idle
// ==/UserScript==

`
    res.type('text/javascript').send(header + code)
  } catch (err) {
    res.status(500).type('text/plain').send('// 服务器错误: ' + err.message)
  }
}

// 输出油猴 (Tampermonkey) userscript 格式
exports.userjs = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.*, c.name as category_name, u.username as author_name
       FROM scripts s
       LEFT JOIN categories c ON s.category_id = c.id
       LEFT JOIN users u ON s.author_id = u.id
       WHERE s.id = ? AND s.status = 'published'`,
      [req.params.id],
    )
    if (rows.length === 0) {
      return res.status(404).type('text/plain').send('// 脚本不存在或未发布')
    }
    const script = rows[0]

    // 读取脚本代码
    let code = ''
    if (script.file_path && fs.existsSync(script.file_path)) {
      code = fs.readFileSync(script.file_path, 'utf-8')
    }

    // 如果代码已包含 ==UserScript== 块，直接输出
    if (code.includes('==UserScript==')) {
      res.type('text/javascript').send(code)
      return
    }

    // 否则自动生成 userscript 头部
    const urlPattern = script.url_pattern || '*'
    // 将通配符模式转为油猴 @match 格式
    const matchRules = urlPattern.split(',').map(p => p.trim()).filter(Boolean)
    const matchLines = matchRules.map(r => `// @match        ${r}`).join('\n')

    const header = `// ==UserScript==
// @name         ${script.name}
// @namespace    ai-browser-scripts
// @version      ${script.version || '1.0.0'}
// @description  ${script.description || ''}
// @author       ${script.author_name || 'AI Browser'}
${matchLines}
// @grant        none
// @run-at       document-idle
// ==/UserScript==

`
    // 更新下载计数
    await pool.query('UPDATE scripts SET download_count = download_count + 1 WHERE id = ?', [script.id])
    res.type('text/javascript').send(header + code)
  } catch (err) {
    res.status(500).type('text/plain').send('// 服务器错误: ' + err.message)
  }
}

// 下载脚本文件
exports.download = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT file_path, name, id FROM scripts WHERE id = ?', [req.params.id])
    if (rows.length === 0) {
      return res.status(404).json(error('脚本不存在', 404))
    }

    const script = rows[0]
    if (!fs.existsSync(script.file_path)) {
      return res.status(404).json(error('脚本文件不存在', 404))
    }

    // 更新下载次数
    await pool.query('UPDATE scripts SET download_count = download_count + 1 WHERE id = ?', [script.id])

    res.download(script.file_path, `${script.name}.js`)
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 上报使用统计
exports.reportStats = async (req, res) => {
  try {
    const { action, duration_ms, success: isSuccess, error_msg } = req.body
    if (!action) {
      return res.status(400).json(error('缺少 action 参数', 400))
    }

    await pool.query(
      `INSERT INTO usage_stats (script_id, user_id, action, duration_ms, success, error_msg)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, req.user.id, action, duration_ms || 0, isSuccess ? 1 : 0, error_msg || null],
    )

    res.json(success(null, '统计上报成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// 获取脚本注入数据（拼接代码 + 参数，供 Chrome 扩展 / Electron 使用）
exports.injectData = async (req, res) => {
  try {
    // Try with new columns first, fall back to basic query
    const safeParse = v => {
      if (!v) return v === 0 || v === false ? v : undefined
      return typeof v === 'string' ? JSON.parse(v) : v
    }
    let script, paramsSchema, paramsData;
    try {
      const [rows] = await pool.query(
        'SELECT id, name, url_pattern, params_schema, params_data FROM scripts WHERE id = ? AND status = ?',
        [req.params.id, 'published']
      );
      if (rows.length === 0) return res.status(404).json(error('脚本不存在', 404));
      script = rows[0];
      paramsSchema = safeParse(script.params_schema) || [];
      paramsData = safeParse(script.params_data) || {};
    } catch (e) {
      // Fallback: columns may not exist yet (before migration)
      const [rows] = await pool.query(
        'SELECT id, name, url_pattern FROM scripts WHERE id = ? AND status = ?',
        [req.params.id, 'published']
      );
      if (rows.length === 0) return res.status(404).json(error('脚本不存在', 404));
      script = rows[0];
      paramsSchema = [];
      paramsData = {};
    }

    // Merge defaults
    const finalParams = {};
    for (const p of paramsSchema) {
      finalParams[p.key] = paramsData[p.key] !== undefined ? paramsData[p.key] : p.default;
    }

    // Fetch modules - also with fallback
    let modules = [];
    try {
      const [modRows] = await pool.query(
        'SELECT name, code, load_order FROM script_modules WHERE script_id = ? ORDER BY load_order',
        [script.id]
      );
      modules = modRows;
    } catch (e) {
      // Table may not exist yet
    }

    // If no modules, try file_path
    let code = '';
    if (modules.length > 0) {
      code = modules.map(m => m.code).join('\n\n');
    } else {
      const [fullRows] = await pool.query('SELECT file_path FROM scripts WHERE id = ?', [script.id]);
      if (fullRows[0]?.file_path && fs.existsSync(fullRows[0].file_path)) {
        code = fs.readFileSync(fullRows[0].file_path, 'utf-8');
      }
    }

    // Build params injection code
    let paramsCode = '';
    if (Object.keys(finalParams).length > 0) {
      paramsCode = `window.__SCRIPT_PARAMS__ = ${JSON.stringify(finalParams)};\n`;
    }

    res.json(success({
      id: script.id,
      name: script.name,
      url_pattern: script.url_pattern,
      params: finalParams,
      params_schema: paramsSchema,
      code: paramsCode + code
    }));

    // Update download count
    await pool.query('UPDATE scripts SET download_count = download_count + 1 WHERE id = ?', [script.id]);
  } catch (err) {
    res.status(500).json(error(err.message));
  }
}

// 获取已发布脚本列表（供 Chrome 扩展查询需注入的脚本）
exports.injectList = async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, url_pattern FROM scripts WHERE status = 'published' ORDER BY updated_at DESC"
    )
    // Try to enrich with module counts, but fallback gracefully
    try {
      for (const script of rows) {
        const [modRows] = await pool.query(
          'SELECT COUNT(*) as cnt FROM script_modules WHERE script_id = ?',
          [script.id]
        )
        script.module_count = modRows[0]?.cnt || 0
      }
    } catch (e) {
      // script_modules table may not exist yet
    }
    res.json(success(rows))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

/**
 * 解析脚本文件中的元数据注释
 * 格式: // @name: 脚本名称
 */
function parseScriptMeta(content) {
  const meta = {}
  const lines = content.split('\n')
  for (const line of lines) {
    const match = line.match(/^\/\/\s*@(\w+):\s*(.+)/)
    if (match) {
      meta[match[1]] = match[2].trim()
    }
  }
  return meta
}