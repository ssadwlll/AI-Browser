// ============ TaskArchiveService（任务归档服务）============
// 整合 ScratchpadService 和 OutputService，提供完整的任务历史管理与复盘
//
// 迁移自 chrome-extension/background/services/task-archive-service.js
// 改动：
//   - ES Module → CommonJS
//   - 组合 ScratchpadService + OutputService（依赖注入）
//   - 归档独立持久化到 JSON 文件（archives.json）
//   - calculateSimilarity 接收两个归档对象（而非纯文本）
//
// 归档数据结构：
//   {
//     archiveId, sessionId, userMessage, summary,
//     workingMemoryState, outputs, stageStats,
//     timestamp, duration
//   }

const fs = require('fs')
const path = require('path')

class TaskArchiveService {
  /**
   * @param {object} scratchpadService - ScratchpadService 实例
   * @param {object} outputService - OutputService 实例
   */
  constructor(scratchpadService, outputService) {
    this.scratchpadService = scratchpadService
    this.outputService = outputService
    this._store = new Map() // 内存缓存 Map<archiveId, archive>
    this._initialized = false
    this._storagePath = null
  }

  /**
   * 获取存储文件路径（延迟 require electron，确保 app 已就绪）
   */
  _getStoragePath() {
    if (this._storagePath) return this._storagePath
    const { app } = require('electron')
    this._storagePath = path.join(app.getPath('userData'), 'archives.json')
    return this._storagePath
  }

  /**
   * 初始化：加载归档文件到内存 Map
   */
  async init() {
    if (this._initialized) return

    const storagePath = this._getStoragePath()
    try {
      if (fs.existsSync(storagePath)) {
        const raw = fs.readFileSync(storagePath, 'utf-8')
        const arr = JSON.parse(raw)
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (item && item.archiveId) {
              this._store.set(item.archiveId, item)
            }
          }
        }
        console.log(`[TaskArchiveService] 已加载 ${this._store.size} 个任务归档`)
      }
    } catch (e) {
      console.warn('[TaskArchiveService] 加载归档文件失败，使用空状态:', e.message)
      this._store = new Map()
    }

    this._initialized = true
  }

  /**
   * 将内存数据持久化到 JSON 文件
   */
  _persist() {
    try {
      const storagePath = this._getStoragePath()
      const arr = Array.from(this._store.values())
      fs.writeFileSync(storagePath, JSON.stringify(arr, null, 2), 'utf-8')
    } catch (e) {
      console.error('[TaskArchiveService] 持久化失败:', e.message)
    }
  }

  /**
   * 生成唯一归档 ID
   */
  _genArchiveId() {
    return `archive_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * 归档任务：将任务完整状态保存为归档
   * @param {string} sessionId - 会话 ID
   * @param {string} userMessage - 用户原始消息
   * @param {string} summary - 任务总结
   * @param {object} workingMemoryState - WorkingMemory 最终状态
   * @param {Array} outputs - 输出项数组
   * @returns {Promise<object>} 创建的归档对象
   */
  async archive(sessionId, userMessage, summary, workingMemoryState, outputs) {
    await this.init()

    const now = Date.now()
    const archive = {
      archiveId: this._genArchiveId(),
      sessionId: sessionId || '',
      userMessage: userMessage || '',
      summary: summary || '',
      workingMemoryState: workingMemoryState || null,
      outputs: outputs || [],
      stageStats: this._computeStageStats(workingMemoryState, outputs),
      timestamp: now,
      duration: this._computeDuration(workingMemoryState, outputs),
    }

    this._store.set(archive.archiveId, archive)
    this._persist()

    console.log(`[TaskArchiveService] 任务已归档: ${archive.archiveId} (sessionId=${sessionId})`)
    return archive
  }

  /**
   * 获取指定归档
   * @param {string} archiveId - 归档 ID
   * @returns {Promise<object|null>}
   */
  async get(archiveId) {
    await this.init()
    return this._store.get(archiveId) || null
  }

  /**
   * 列出归档（按时间倒序）
   * @param {number} limit - 返回条数上限，默认 20
   * @returns {Promise<Array>}
   */
  async list(limit = 20) {
    await this.init()
    const arr = Array.from(this._store.values())
    arr.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    return arr.slice(0, limit)
  }

  /**
   * 删除指定归档
   * @param {string} archiveId - 归档 ID
   * @returns {Promise<boolean>}
   */
  async delete(archiveId) {
    await this.init()
    const deleted = this._store.delete(archiveId)
    if (deleted) {
      this._persist()
      console.log(`[TaskArchiveService] 归档已删除: ${archiveId}`)
    }
    return deleted
  }

  /**
   * 清空所有归档
   */
  async clearAll() {
    await this.init()
    this._store.clear()
    this._persist()
    console.log('[TaskArchiveService] 已清空所有任务归档')
  }

  /**
   * 搜索归档（按 userMessage / summary 关键词匹配）
   * @param {string} query - 搜索关键词
   * @returns {Promise<Array>} 匹配的归档列表（按相似度降序）
   */
  async search(query) {
    await this.init()
    if (!query || typeof query !== 'string') return []

    const kw = query.toLowerCase()
    const results = []

    for (const archive of this._store.values()) {
      const userMessage = (archive.userMessage || '').toLowerCase()
      const summary = (archive.summary || '').toLowerCase()

      if (userMessage.includes(kw) || summary.includes(kw)) {
        results.push(archive)
      }
    }

    // 按时间倒序
    results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    return results
  }

  /**
   * 计算两个归档的相似度（基于 userMessage 和 summary 的关键词 Jaccard 相似度）
   * @param {object} archive1 - 归档对象 1
   * @param {object} archive2 - 归档对象 2
   * @returns {number} 相似度 [0, 1]
   */
  calculateSimilarity(archive1, archive2) {
    if (!archive1 || !archive2) return 0

    // 提取关键词（中英文混合，长度 > 1 的词）
    const text1 = `${archive1.userMessage || ''} ${archive1.summary || ''}`
    const text2 = `${archive2.userMessage || ''} ${archive2.summary || ''}`

    const words1 = this._extractKeywords(text1)
    const words2 = this._extractKeywords(text2)

    if (words1.size === 0 && words2.size === 0) return 0

    // Jaccard 相似度：交集大小 / 并集大小
    let intersection = 0
    for (const w of words1) {
      if (words2.has(w)) intersection++
    }
    const union = words1.size + words2.size - intersection

    return union === 0 ? 0 : intersection / union
  }

  /**
   * 查找与指定归档最相似的其他归档
   * @param {string} archiveId - 基准归档 ID
   * @param {number} limit - 返回条数上限，默认 5
   * @returns {Promise<Array>} 相似归档列表（按相似度降序）
   */
  async findSimilar(archiveId, limit = 5) {
    await this.init()
    const base = this._store.get(archiveId)
    if (!base) return []

    const similar = []
    for (const [id, archive] of this._store) {
      if (id === archiveId) continue
      const similarity = this.calculateSimilarity(base, archive)
      if (similarity > 0) {
        similar.push({ archiveId: id, similarity, archive })
      }
    }

    similar.sort((a, b) => b.similarity - a.similarity)
    return similar.slice(0, limit)
  }

  // ============ 内部辅助 ============

  /**
   * 从文本中提取关键词（用于相似度计算）
   * 同时处理中英文：英文按空格分词，中文按字符切分（bigram）
   * @param {string} text
   * @returns {Set<string>}
   */
  _extractKeywords(text) {
    const words = new Set()
    if (!text) return words

    const lower = text.toLowerCase()

    // 英文单词（长度 > 2）
    const enWords = lower.match(/[a-z]{3,}/g) || []
    for (const w of enWords) {
      words.add(w)
    }

    // 中文 bigram（连续两个中文字符）
    const cnChars = lower.match(/[\u4e00-\u9fa5]/g) || []
    for (let i = 0; i < cnChars.length - 1; i++) {
      words.add(cnChars[i] + cnChars[i + 1])
    }

    return words
  }

  /**
   * 计算阶段统计（从 workingMemoryState 和 outputs 提取）
   * @param {object} workingMemoryState - WorkingMemory 状态
   * @param {Array} outputs - 输出项数组
   * @returns {object} 阶段统计 { totalOutputs, toolStats, stageStats }
   */
  _computeStageStats(workingMemoryState, outputs) {
    const stats = {
      totalOutputs: 0,
      toolStats: {}, // { toolName: count }
      stageRounds: {}, // { stageN: rounds }
    }

    // 从 outputs 统计工具调用
    if (Array.isArray(outputs)) {
      stats.totalOutputs = outputs.length
      for (const out of outputs) {
        const toolName = out.toolName || out.type || 'unknown'
        if (!stats.toolStats[toolName]) stats.toolStats[toolName] = 0
        stats.toolStats[toolName]++
      }
    }

    // 从 workingMemoryState 提取阶段统计
    if (workingMemoryState) {
      // 阶段切换记录
      if (Array.isArray(workingMemoryState.stageHistory)) {
        for (const entry of workingMemoryState.stageHistory) {
          const stage = entry.stage || entry || 1
          const key = `stage${stage}`
          if (!stats.stageRounds[key]) stats.stageRounds[key] = 0
          stats.stageRounds[key]++
        }
      }
      // 当前阶段
      if (workingMemoryState.currentStage) {
        stats.currentStage = workingMemoryState.currentStage
      }
      // 总轮次
      if (workingMemoryState.round) {
        stats.totalRounds = workingMemoryState.round
      }
    }

    return stats
  }

  /**
   * 计算任务耗时（毫秒）
   * 优先从 workingMemoryState 的起止时间计算，否则从 outputs 时间戳推算
   * @param {object} workingMemoryState
   * @param {Array} outputs
   * @returns {number} 耗时毫秒
   */
  _computeDuration(workingMemoryState, outputs) {
    // 优先从 workingMemoryState 提取
    if (workingMemoryState) {
      if (workingMemoryState.startTime && workingMemoryState.endTime) {
        return workingMemoryState.endTime - workingMemoryState.startTime
      }
    }

    // 从 outputs 时间戳推算
    if (Array.isArray(outputs) && outputs.length > 0) {
      const timestamps = outputs
        .map((o) => o.timestamp)
        .filter((t) => typeof t === 'number')
        .sort((a, b) => a - b)
      if (timestamps.length >= 2) {
        return timestamps[timestamps.length - 1] - timestamps[0]
      }
    }

    return 0
  }

  /**
   * 导出指定归档为 JSON 文件
   * @param {string} archiveId - 归档 ID
   * @returns {Promise<{filePath:string, filename:string, content:object}|null>}
   */
  async exportArchive(archiveId) {
    const archive = await this.get(archiveId)
    if (!archive) return null

    const { app } = require('electron')
    const exportDir = path.join(app.getPath('userData'), 'exports')
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true })
    }

    const filePath = path.join(exportDir, `archive_${archiveId}.json`)
    fs.writeFileSync(filePath, JSON.stringify(archive, null, 2), 'utf-8')

    console.log(`[TaskArchiveService] 归档已导出: ${filePath}`)
    return {
      filePath,
      filename: `archive_${archiveId}.json`,
      content: archive,
    }
  }
}

module.exports = TaskArchiveService
