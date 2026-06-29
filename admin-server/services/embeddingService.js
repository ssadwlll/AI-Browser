// ============ EmbeddingService ============
// 使用 all-MiniLM-L6-v2 模型，纯 JS 运行，无需 GPU
// 首次启动会自动下载模型 (~80MB)，后续从缓存加载

const pool = require('../config/db')

class EmbeddingService {
  constructor() {
    this.model = null
    this.ready = false
    this.embeddings = []       // [{ id, name, description, vector }]
    this.embeddingDim = 384
    this.initPromise = null
  }

  async init() {
    if (this.initPromise) return this.initPromise
    this.initPromise = this._doInit()
    return this.initPromise
  }

  async _doInit() {
    try {
      console.log('[Embedding] 加载模型 all-MiniLM-L6-v2 ...')
      const { pipeline, env } = await import('@xenova/transformers')
      // 使用国内镜像加速下载（HF 被墙）
      env.allowLocalModels = false
      env.remoteHost = 'https://hf-mirror.com'
      env.remotePathTemplate = '{model}/resolve/{revision}/'
      this.model = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
      console.log('[Embedding] 模型加载完成')
      await this.rebuildIndex()
      this.ready = true
      console.log(`[Embedding] 索引构建完成，共 ${this.embeddings.length} 个脚本`)
    } catch (e) {
      console.warn('[Embedding] 初始化失败，将回退到 LIKE 搜索:', e.message)
      this.ready = false
    }
  }

  async rebuildIndex() {
    try {
      const [rows] = await pool.query(
        `SELECT id, name, description FROM scripts WHERE status = 'published'`
      )
      this.embeddings = []
      for (const row of rows) {
        const text = `${row.name} ${row.description || ''}`.trim()
        if (!text) continue
        const vector = await this.embed(text)
        this.embeddings.push({
          id: row.id,
          name: row.name,
          description: row.description || '',
          vector,
        })
      }
    } catch (e) {
      console.warn('[Embedding] 索引构建失败:', e.message)
      this.embeddings = []
    }
  }

  async embed(text) {
    if (!this.model) throw new Error('模型未加载')
    const result = await this.model(text, { pooling: 'mean', normalize: true })
    // result 是 1x384 的 Float32Array 嵌套在 Tensor 中
    return Array.from(result.data)
  }

  /**
   * 计算两个向量的余弦相似度
   */
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
   * 语义搜索：返回相似度最高的 N 个脚本
   */
  async search(query, topK = 5) {
    if (!this.ready || this.embeddings.length === 0) return null

    try {
      const queryVector = await this.embed(query)
      const scored = this.embeddings.map(item => ({
        ...item,
        score: this.cosineSimilarity(queryVector, item.vector),
      }))
      scored.sort((a, b) => b.score - a.score)

      // 只返回相似度 > 0.3 的结果
      return scored.filter(s => s.score > 0.3).slice(0, topK)
    } catch (e) {
      console.warn('[Embedding] 搜索失败:', e.message)
      return null
    }
  }
}

// 单例
module.exports = new EmbeddingService()
