// ============ EmbeddingService ============
// 纯 Node.js 推理，使用 @xenova/transformers + all-MiniLM-L6-v2 (384维)
// 模型文件位于 models/all-MiniLM-L6-v2/
// 向量存储在 scripts.vector 字段中（JSON格式）

const path = require('path')
const pool = require('../config/db')

// 模型本地路径
const MODEL_PATH = path.join(__dirname, '..', 'models', 'all-MiniLM-L6-v2')

class EmbeddingService {
  constructor() {
    this.ready = false
    this.embeddingDim = 384
    this.initPromise = null
    this.pipeline = null
  }

  async init() {
    if (this.initPromise) return this.initPromise
    this.initPromise = this._doInit()
    return this.initPromise
  }

  async _doInit() {
    try {
      console.log('[Embedding] 加载本地模型: all-MiniLM-L6-v2 (纯 Node.js)')
      const { pipeline, env } = await import('@xenova/transformers')
      
      // 设置本地模型目录，指向 models/ 父目录
      env.localModelPath = path.join(__dirname, '..', 'models')
      env.allowRemoteModels = false
      
      // 通过 local_files_only 强制从本地加载
      this.pipeline = await pipeline(
        'feature-extraction',
        'all-MiniLM-L6-v2',
        { local_files_only: true }
      )
      
      console.log(`[Embedding] 模型就绪, 维度: ${this.embeddingDim}`)
      
      // 扫描并补全缺失向量
      await this.buildMissingVectors()
      this.ready = true
    } catch (e) {
      console.warn('[Embedding] 初始化失败，将回退到 LIKE 搜索:', e.message)
      this.ready = false
    }
  }

  /**
   * 扫描数据库中缺少向量的已发布脚本，批量生成向量
   */
  async buildMissingVectors() {
    try {
      const [rows] = await pool.query(
        `SELECT id, name, description, metadata FROM scripts
         WHERE status = 'published' AND vector IS NULL
         ORDER BY id`
      )
      if (rows.length === 0) {
        console.log('[Embedding] 所有脚本向量已就绪')
        return
      }
      console.log(`[Embedding] 发现有 ${rows.length} 个脚本缺少向量，开始生成...`)
      const texts = rows.map(r => {
        let metaTriggers = ''
        try {
          const m = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {})
          if (m.triggers && Array.isArray(m.triggers)) metaTriggers = m.triggers.join(' ')
        } catch {}
        return `${r.name} ${r.description || ''} ${metaTriggers}`.trim()
      })
      const vectors = await this._batchEmbed(texts)

      for (let i = 0; i < rows.length; i++) {
        await pool.query(
          'UPDATE scripts SET vector = ?, vector_updated_at = NOW() WHERE id = ?',
          [JSON.stringify(vectors[i]), rows[i].id]
        )
      }
      console.log(`[Embedding] 已完成 ${rows.length} 个脚本的向量生成`)
    } catch (e) {
      console.warn('[Embedding] 批量向量生成失败:', e.message)
    }
  }

  /**
   * 为单个脚本生成向量
   */
  async generateVector(scriptId) {
    if (!this.ready) return
    try {
      const [rows] = await pool.query(
        'SELECT id, name, description, metadata FROM scripts WHERE id = ?',
        [scriptId]
      )
      if (rows.length === 0) return
      const metaTriggers = (() => {
        try {
          const m = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : (rows[0].metadata || {})
          if (m.triggers && Array.isArray(m.triggers)) return m.triggers.join(' ')
        } catch {}
        return ''
      })()
      const text = `${rows[0].name} ${rows[0].description || ''} ${metaTriggers}`.trim()
      if (!text) return

      const vector = await this.embed(text)
      await pool.query(
        'UPDATE scripts SET vector = ?, vector_updated_at = NOW() WHERE id = ?',
        [JSON.stringify(vector), scriptId]
      )
    } catch (e) {
      console.warn(`[Embedding] 脚本 ${scriptId} 向量生成失败:`, e.message)
    }
  }

  async _batchEmbed(texts) {
    // all-MiniLM-L6-v2 的 pipeline 返回 [batch, seq, dim] tensor
    // 我们做 mean pooling 取平均
    const outputs = await this.pipeline(texts, {
      pooling: 'mean',
      normalize: true,
    })
    // outputs 是 Tensor 数组，每个是 [seq_len, dim]
    return Array.from(outputs).map(t => Array.from(t.data))
  }

  async embed(text) {
    const result = await this._batchEmbed([text])
    return result[0]
  }

  cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    if (normA === 0 || normB === 0) return 0
    return dot / (Math.sqrt(normA) * Math.sqrt(normB))
  }

  _keywordScore(query, name, description, metadata) {
    const q = query.toLowerCase()
    const n = (name || '').toLowerCase()
    const d = (description || '').toLowerCase()
    // 拆分为多个关键词，支持空格/逗号分隔
    const words = q.split(/[\s,，、]+/).filter(w => w.length > 0)
    if (words.length === 0) return 0

    let score = 0
    for (const w of words) {
      // 精确匹配 name
      if (n === w) { score += 1.0; continue }
      if (n.includes(w)) { score += 0.6; continue }
      if (d.includes(w)) { score += 0.3; continue }
      // metadata.triggers 关键词
      if (metadata && metadata.triggers && Array.isArray(metadata.triggers)) {
        let matched = false
        for (const t of metadata.triggers) {
          if (typeof t === 'string' && t.toLowerCase().includes(w)) { score += 0.5; matched = true; break }
        }
        if (matched) continue
        for (const t of metadata.triggers) {
          if (typeof t === 'string' && w.includes(t.toLowerCase())) { score += 0.45; matched = true; break }
        }
        if (matched) continue
      }
    }
    // 归一化：每个词最多1.0分，取平均
    return words.length > 0 ? score / words.length : 0
  }

  /**
   * 混合搜索：向量相似度 70% + 关键词匹配 30%（含 triggers 加权）
   */
  async search(query, topK = 5) {
    if (!this.ready) return null

    try {
      const [rows] = await pool.query(
        `SELECT id, name, description, vector, metadata FROM scripts
         WHERE status = 'published'`
      )
      if (rows.length === 0) return null

      // 对有向量的脚本生成查询向量
      const hasVectorRows = rows.filter(r => r.vector)
      let queryVector = null
      if (hasVectorRows.length > 0) {
        try {
          queryVector = await this.embed(query)
        } catch (e) {
          console.warn('[Embedding] 查询向量生成失败:', e.message)
        }
      }

      const scored = rows.map(row => {
        let vectorScore = 0
        if (queryVector && row.vector) {
          try {
            const vec = JSON.parse(row.vector)
            vectorScore = this.cosineSimilarity(queryVector, vec)
          } catch { vectorScore = 0 }
        }
        let metaParsed = null
        try { metaParsed = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata } catch {}
        const kwScore = this._keywordScore(query, row.name, row.description, metaParsed)
        // 有向量：混合评分(70%向量+30%关键词)；无向量：纯关键词评分(按50%权重)
        const finalScore = row.vector
          ? vectorScore * 0.7 + kwScore * 0.3
          : kwScore * 0.5
        return { id: row.id, name: row.name, description: row.description, score: finalScore }
      })

      scored.sort((a, b) => b.score - a.score)
      return scored.filter(s => s.score >= 0.15).slice(0, topK)
    } catch (e) {
      console.warn('[Embedding] 搜索失败:', e.message)
      return null
    }
  }
}

module.exports = new EmbeddingService()
