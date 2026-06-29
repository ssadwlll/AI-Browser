const pool = require('../config/db')
const { success, error } = require('../utils/response')

// ============ Provider ============

// GET /api/ai-models/providers
exports.listProviders = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, display_name, base_url, api_key, status, sort_order, created_at FROM ai_providers ORDER BY sort_order, id',
    )
    res.json(success(rows))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// POST /api/ai-models/providers
exports.createProvider = async (req, res) => {
  try {
    const { name, display_name, base_url, api_key, status, sort_order } = req.body
    if (!name || !display_name) {
      return res.status(400).json(error('name 和 display_name 不能为空', 400))
    }

    const [existing] = await pool.query('SELECT id FROM ai_providers WHERE name = ?', [name])
    if (existing.length > 0) {
      return res.status(400).json(error('name 已存在', 400))
    }

    const [result] = await pool.query(
      'INSERT INTO ai_providers (name, display_name, base_url, api_key, status, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [
        name,
        display_name,
        base_url || '',
        api_key || '',
        status === undefined ? 1 : parseInt(status),
        parseInt(sort_order) || 0,
      ],
    )

    res.json(success({ id: result.insertId }, 'Provider 创建成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// PUT /api/ai-models/providers/:id
exports.updateProvider = async (req, res) => {
  try {
    const { display_name, base_url, api_key, status, sort_order } = req.body
    const fields = []
    const params = []

    if (display_name !== undefined) { fields.push('display_name = ?'); params.push(display_name) }
    if (base_url !== undefined) { fields.push('base_url = ?'); params.push(base_url) }
    if (api_key !== undefined) { fields.push('api_key = ?'); params.push(api_key) }
    if (status !== undefined) { fields.push('status = ?'); params.push(parseInt(status)) }
    if (sort_order !== undefined) { fields.push('sort_order = ?'); params.push(parseInt(sort_order)) }

    if (fields.length === 0) {
      return res.status(400).json(error('没有需要更新的字段', 400))
    }

    const [rows] = await pool.query('SELECT id FROM ai_providers WHERE id = ?', [req.params.id])
    if (rows.length === 0) {
      return res.status(404).json(error('Provider 不存在', 404))
    }

    params.push(req.params.id)
    await pool.query(`UPDATE ai_providers SET ${fields.join(', ')} WHERE id = ?`, params)

    res.json(success(null, 'Provider 更新成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// DELETE /api/ai-models/providers/:id
exports.deleteProvider = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id FROM ai_providers WHERE id = ?', [req.params.id])
    if (rows.length === 0) {
      return res.status(404).json(error('Provider 不存在', 404))
    }
    // ON DELETE CASCADE 会自动删除关联的 models
    await pool.query('DELETE FROM ai_providers WHERE id = ?', [req.params.id])
    res.json(success(null, 'Provider 删除成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// ============ Model ============

// GET /api/ai-models
exports.listModels = async (req, res) => {
  try {
    const { provider_id } = req.query
    let sql = `
      SELECT m.*, p.name AS provider_name, p.display_name AS provider_display_name
      FROM ai_models m
      LEFT JOIN ai_providers p ON m.provider_id = p.id
    `
    const params = []
    if (provider_id) {
      sql += ' WHERE m.provider_id = ?'
      params.push(provider_id)
    }
    sql += ' ORDER BY m.provider_id, m.sort_order, m.id'
    const [rows] = await pool.query(sql, params)
    res.json(success(rows))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// POST /api/ai-models
exports.createModel = async (req, res) => {
  try {
    const {
      provider_id,
      model_id,
      display_name,
      context_window,
      max_tokens,
      temperature,
      supports_vision,
      supports_tools,
      supports_stream,
      description,
      status,
      sort_order,
    } = req.body

    if (!provider_id || !model_id || !display_name) {
      return res.status(400).json(error('provider_id、model_id、display_name 不能为空', 400))
    }

    const [prov] = await pool.query('SELECT id FROM ai_providers WHERE id = ?', [provider_id])
    if (prov.length === 0) {
      return res.status(400).json(error('指定的 provider 不存在', 400))
    }

    const [result] = await pool.query(
      `INSERT INTO ai_models
        (provider_id, model_id, display_name, context_window, max_tokens, temperature,
         supports_vision, supports_tools, supports_stream, description, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parseInt(provider_id),
        model_id,
        display_name,
        parseInt(context_window) || 8192,
        parseInt(max_tokens) || 4096,
        temperature === undefined ? 0.7 : parseFloat(temperature),
        supports_vision ? 1 : 0,
        supports_tools ? 1 : 0,
        supports_stream === undefined ? 1 : supports_stream ? 1 : 0,
        description || null,
        status === undefined ? 1 : parseInt(status),
        parseInt(sort_order) || 0,
      ],
    )

    res.json(success({ id: result.insertId }, 'Model 创建成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// PUT /api/ai-models/:id
exports.updateModel = async (req, res) => {
  try {
    const {
      provider_id,
      model_id,
      display_name,
      context_window,
      max_tokens,
      temperature,
      supports_vision,
      supports_tools,
      supports_stream,
      description,
      status,
      sort_order,
    } = req.body

    const fields = []
    const params = []

    if (provider_id !== undefined) { fields.push('provider_id = ?'); params.push(parseInt(provider_id)) }
    if (model_id !== undefined) { fields.push('model_id = ?'); params.push(model_id) }
    if (display_name !== undefined) { fields.push('display_name = ?'); params.push(display_name) }
    if (context_window !== undefined) { fields.push('context_window = ?'); params.push(parseInt(context_window)) }
    if (max_tokens !== undefined) { fields.push('max_tokens = ?'); params.push(parseInt(max_tokens)) }
    if (temperature !== undefined) { fields.push('temperature = ?'); params.push(parseFloat(temperature)) }
    if (supports_vision !== undefined) { fields.push('supports_vision = ?'); params.push(supports_vision ? 1 : 0) }
    if (supports_tools !== undefined) { fields.push('supports_tools = ?'); params.push(supports_tools ? 1 : 0) }
    if (supports_stream !== undefined) { fields.push('supports_stream = ?'); params.push(supports_stream ? 1 : 0) }
    if (description !== undefined) { fields.push('description = ?'); params.push(description) }
    if (status !== undefined) { fields.push('status = ?'); params.push(parseInt(status)) }
    if (sort_order !== undefined) { fields.push('sort_order = ?'); params.push(parseInt(sort_order)) }

    if (fields.length === 0) {
      return res.status(400).json(error('没有需要更新的字段', 400))
    }

    const [rows] = await pool.query('SELECT id FROM ai_models WHERE id = ?', [req.params.id])
    if (rows.length === 0) {
      return res.status(404).json(error('Model 不存在', 404))
    }

    params.push(req.params.id)
    await pool.query(`UPDATE ai_models SET ${fields.join(', ')} WHERE id = ?`, params)

    res.json(success(null, 'Model 更新成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// DELETE /api/ai-models/:id
exports.deleteModel = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id FROM ai_models WHERE id = ?', [req.params.id])
    if (rows.length === 0) {
      return res.status(404).json(error('Model 不存在', 404))
    }
    await pool.query('DELETE FROM ai_models WHERE id = ?', [req.params.id])
    res.json(success(null, 'Model 删除成功'))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}

// ============ 客户端可用模型列表（不需要 JWT，需要 appKey 认证） ============
// GET /api/ai-models/available - 返回所有启用的 providers + models（不返回 api_key）
exports.available = async (req, res) => {
  try {
    const [providers] = await pool.query(
      'SELECT id, name, display_name, base_url, status, sort_order FROM ai_providers WHERE status = 1 ORDER BY sort_order, id',
    )
    const [models] = await pool.query(
      `SELECT id, provider_id, model_id, display_name, context_window, max_tokens, temperature,
              supports_vision, supports_tools, supports_stream, description, status, sort_order
       FROM ai_models
       WHERE status = 1
       ORDER BY provider_id, sort_order, id`,
    )
    res.json(success({ providers, models }))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}
