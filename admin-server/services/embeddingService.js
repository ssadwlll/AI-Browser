// ============ EmbeddingService ============
// 调用本地 Python embedding 服务 (Qwen3-Embedding-0.6B)
// Python 服务需先启动：python services/embedding_server.py --port 9091
// 维度 1024，lasttoken pooling，CPU 推理
// 向量存储在 scripts.vector 字段中（JSON格式）

const pool = require('../config/db')

const EMBEDDING_URL = process.env.EMBEDDING_URL || 'http://127.0.0.1:9091'

class EmbeddingService {
  constructor() {
    this.ready = false
    this.embeddingDim = 1024
    this.initPromise = null
  }

  async init() {
    if (this.initPromise) return this.initPromise
    this.initPromise = this._doInit()
    return this.initPromise
  }

  async _doInit() {
    try {
      console.log('[Embedding] 等待 Python embedding 服务就绪...')
      for (let i = 0; i < 60; i++) {
        try {
          const res = await fetch(`${EMBEDDING_URL}/health`)
          if (res.ok) {
            const data = await res.json()
            console.log(`[Embedding] 服务已就绪: ${data.model}`)
            // 扫描并补全缺失向量
            await this.buildMissingVectors()
            this.ready = true
            return
          }
        } catch { /* 服务还没启动 */ }
        await new Promise(r => setTimeout(r, 1000))
      }
      console.warn('[Embedding] 等待超时，将回退到 LIKE 搜索')
      this.ready = false
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
        `SELECT id, name, description FROM scripts
         WHERE status = 'published' AND vector IS NULL
         ORDER BY id`
      )
      if (rows.length === 0) {
        console.log('[Embedding] 所有脚本向量已就绪')
        return
      }
      console.log(`[Embedding] 发现有 ${rows.length} 个脚本缺少向量，开始生成...`)
      const texts = rows.map(r => `${r.name} ${r.description || ''}`.trim())
      const vectors = await this._batchEmbed(texts)

      // 逐条更新
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
   * 为单个脚本生成向量（用于新增/更新后异步调用）
   */
  async generateVector(scriptId) {
    if (!this.ready) return
    try {
      const [rows] = await pool.query(
        'SELECT id, name, description FROM scripts WHERE id = ?',
        [scriptId]
      )
      if (rows.length === 0) return
      const text = `${rows[0].name} ${rows[0].description || ''}`.trim()
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
    try {
      const res = await fetch(`${EMBEDDING_URL}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      return data.embeddings
    } catch (e) {
      throw new Error(`Embedding API 调用失败: ${e.message}`)
    }
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

  /**
   * 关键词匹配分（精确匹配 boost）
   * 弥补向量搜索对精确名称/别名匹配的盲区
   */
  _keywordScore(query, name, description) {
    const q = query.toLowerCase()
    const n = (name || '').toLowerCase()
    const d = (description || '').toLowerCase()

    if (n === q) return 1.0          // 完全匹配名称
    if (n.includes(q)) return 0.6    // 名称包含搜索词
    if (d.includes(q)) return 0.3    // 描述包含搜索词
    return 0
  }

  /**
   * 混合搜索：向量相似度 70% + 关键词匹配 30%
   */
  async search(query, topK = 5) {
    if (!this.ready) return null

    try {
      // 从数据库加载所有已发布且有向量的脚本
      const [rows] = await pool.query(
        `SELECT id, name, description, vector FROM scripts
         WHERE status = 'published' AND vector IS NOT NULL`
      )
      if (rows.length === 0) return null

      const queryVector = await this.embed(query)
      const scored = rows.map(row => {
        let vec
        try {
          vec = JSON.parse(row.vector)
        } catch {
          return { id: row.id, name: row.name, description: row.description, score: 0 }
        }
        const vectorScore = this.cosineSimilarity(queryVector, vec)
        const kwScore = this._keywordScore(query, row.name, row.description)
        // 混合：向量 0.7 + 关键词 0.3
        const finalScore = vectorScore * 0.7 + kwScore * 0.3
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          score: finalScore,
        }
      })

      scored.sort((a, b) => b.score - a.score)
      // 过滤阈值：最终分 ≥ 0.2（原来纯向量的 0.3 × 0.7 ≈ 0.21）
      return scored.filter(s => s.score >= 0.2).slice(0, topK)
    } catch (e) {
      console.warn('[Embedding] 搜索失败:', e.message)
      return null
    }
  }
}

// 单例
module.exports = new EmbeddingService()
