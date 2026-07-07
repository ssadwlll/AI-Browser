// ============ OutputService（任务结果输出服务）============
// 类似 Devin 的 outputs 文件：任务执行过程中持续收集输出项，完成后持久化
//
// 迁移自 chrome-extension/background/services/output-service.js
// 改动：
//   - ES Module → CommonJS
//   - IndexedDB → JSON 文件（path.join(app.getPath('userData'), 'outputs.json')）
//   - 采用会话制 API：startSession / addOutput / finishSession
//   - Blob URL → 文件路径（Electron 主进程直接写文件）
//
// 数据结构（session）：
//   {
//     sessionId, userMessage, startTime, endTime, status, summary,
//     outputs: [{ id, type, toolName, data, schema, renderType, timestamp }],
//     stats: { totalOutputs, toolStats }
//   }

const fs = require('fs')
const path = require('path')

class OutputService {
  constructor() {
    this._store = new Map() // 内存缓存 Map<sessionId, session>
    this._initialized = false
    this._storagePath = null // 延迟到运行时初始化
  }

  /**
   * 获取存储文件路径（延迟 require electron，确保 app 已就绪）
   */
  _getStoragePath() {
    if (this._storagePath) return this._storagePath
    const { app } = require('electron')
    this._storagePath = path.join(app.getPath('userData'), 'outputs.json')
    return this._storagePath
  }

  /**
   * 获取导出目录路径（不存在则创建）
   */
  _getExportDir() {
    const { app } = require('electron')
    const exportDir = path.join(app.getPath('userData'), 'exports')
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true })
    }
    return exportDir
  }

  /**
   * 初始化：加载 JSON 文件到内存 Map
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
            if (item && item.sessionId) {
              this._store.set(item.sessionId, item)
            }
          }
        }
        console.log(`[OutputService] 已加载 ${this._store.size} 个输出会话`)
      }
    } catch (e) {
      console.warn('[OutputService] 加载 outputs 文件失败，使用空状态:', e.message)
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
      console.error('[OutputService] 持久化失败:', e.message)
    }
  }

  /**
   * 生成唯一输出项 ID
   */
  _genOutputId() {
    return `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * 开始输出会话
   * @param {string} sessionId - 会话 ID
   * @param {string} userMessage - 用户原始消息
   * @returns {Promise<object>} 创建的会话对象
   */
  async startSession(sessionId, userMessage) {
    await this.init()

    const session = {
      sessionId,
      userMessage: userMessage || '',
      startTime: Date.now(),
      endTime: null,
      status: 'running', // running | success | partial | failure
      summary: '',
      outputs: [],
      stats: {
        totalOutputs: 0,
        toolStats: {}, // { toolName: count }
      },
    }

    this._store.set(sessionId, session)
    this._persist()

    console.log(`[OutputService] 会话已开始: sessionId=${sessionId}`)
    return session
  }

  /**
   * 添加输出项到会话
   * @param {string} sessionId - 会话 ID
   * @param {object} output - 输出项 { type, toolName, data, schema, renderType }
   * @returns {Promise<object>} 添加的输出项（含 id 与 timestamp）
   */
  async addOutput(sessionId, output) {
    await this.init()

    const session = this._store.get(sessionId)
    if (!session) {
      throw new Error(`输出会话不存在: ${sessionId}`)
    }

    const item = {
      id: this._genOutputId(),
      type: output.type || 'data', // data | tool_result | file | text | error
      toolName: output.toolName || '',
      data: output.data,
      schema: output.schema || null,
      renderType: output.renderType || 'json', // json | table | markdown | html | text | image
      timestamp: Date.now(),
    }

    session.outputs.push(item)
    session.stats.totalOutputs = session.outputs.length

    // 更新工具统计
    if (item.toolName) {
      if (!session.stats.toolStats[item.toolName]) {
        session.stats.toolStats[item.toolName] = 0
      }
      session.stats.toolStats[item.toolName]++
    }

    this._persist()
    return item
  }

  /**
   * 完成输出会话
   * @param {string} sessionId - 会话 ID
   * @param {string} status - 最终状态 success | partial | failure
   * @param {string} summary - 任务总结
   * @returns {Promise<object>} 更新后的会话对象
   */
  async finishSession(sessionId, status, summary) {
    await this.init()

    const session = this._store.get(sessionId)
    if (!session) {
      throw new Error(`输出会话不存在: ${sessionId}`)
    }

    session.endTime = Date.now()
    session.status = status || 'success'
    session.summary = summary || ''

    this._persist()

    console.log(
      `[OutputService] 会话已完成: sessionId=${sessionId}, status=${session.status}, outputs=${session.stats.totalOutputs}`
    )
    return session
  }

  /**
   * 获取指定会话
   * @returns {Promise<object|null>}
   */
  async getSession(sessionId) {
    await this.init()
    return this._store.get(sessionId) || null
  }

  /**
   * 列出输出会话（按开始时间倒序）
   * @param {number} limit - 返回条数上限，默认 20
   * @returns {Promise<Array>}
   */
  async listSessions(limit = 20) {
    await this.init()
    const arr = Array.from(this._store.values())
    arr.sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
    return arr.slice(0, limit)
  }

  /**
   * 删除指定会话
   * @returns {Promise<boolean>} 是否删除成功
   */
  async deleteSession(sessionId) {
    await this.init()
    const deleted = this._store.delete(sessionId)
    if (deleted) {
      this._persist()
      console.log(`[OutputService] 会话已删除: sessionId=${sessionId}`)
    }
    return deleted
  }

  /**
   * 清空所有输出会话
   */
  async clearAll() {
    await this.init()
    this._store.clear()
    this._persist()
    console.log('[OutputService] 已清空所有输出会话')
  }

  /**
   * 导出指定会话为 JSON 文件
   * @returns {Promise<{filePath:string, filename:string, content:object}|null>}
   */
  async exportSession(sessionId) {
    const session = await this.getSession(sessionId)
    if (!session) return null

    const exportDir = this._getExportDir()
    const filePath = path.join(exportDir, `output_${sessionId}.json`)
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8')

    console.log(`[OutputService] 会话已导出: ${filePath}`)
    return {
      filePath,
      filename: `output_${sessionId}.json`,
      content: session,
    }
  }

  /**
   * 获取输出统计信息
   * @returns {Promise<object>}
   */
  async getStats() {
    await this.init()
    const list = Array.from(this._store.values())
    return {
      total: list.length,
      success: list.filter((s) => s.status === 'success').length,
      partial: list.filter((s) => s.status === 'partial').length,
      failure: list.filter((s) => s.status === 'failure').length,
      running: list.filter((s) => s.status === 'running').length,
      totalOutputs: list.reduce((sum, s) => sum + (s.stats?.totalOutputs || 0), 0),
    }
  }
}

module.exports = OutputService
