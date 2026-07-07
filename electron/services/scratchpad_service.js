// ============ ScratchpadService（中间推理持久化服务）============
// 类似 Devin 的 scratchpad 文件：每轮结束后持久化 WorkingMemory.state
// 功能：
//   1. 每轮结束后持久化 WorkingMemory.state 到 JSON 文件
//   2. 任务启动时恢复 scratchpad（支持断点续传）
//   3. 提供导出功能：导出为 JSON 文件（返回文件路径）
//
// 迁移自 chrome-extension/background/services/scratchpad-service.js
// 改动：
//   - ES Module → CommonJS
//   - IndexedDB → JSON 文件（path.join(app.getPath('userData'), 'scratchpad.json')）
//   - Blob URL → 文件路径（Electron 主进程直接写文件）
//
// 持久化数据结构：
//   {
//     sessionId, timestamp, taskGoal,
//     state: { WorkingMemory.state },      // 完整工作记忆状态
//     lastRound: { round, stage, aiResponse, toolCalls, toolResults },  // 本轮摘要
//     totalRounds
//   }

const fs = require('fs')
const path = require('path')

class ScratchpadService {
  constructor() {
    this._store = new Map()       // 内存缓存 Map<sessionId, scratchpad>
    this._currentSessionId = null
    this._initialized = false
    this._storagePath = null      // 延迟到运行时初始化
  }

  /**
   * 获取存储文件路径（延迟 require electron，确保 app 已就绪）
   */
  _getStoragePath() {
    if (this._storagePath) return this._storagePath
    const { app } = require('electron')
    this._storagePath = path.join(app.getPath('userData'), 'scratchpad.json')
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
        console.log(`[ScratchpadService] 已加载 ${this._store.size} 条 scratchpad`)
      }
    } catch (e) {
      console.warn('[ScratchpadService] 加载 scratchpad 文件失败，使用空状态:', e.message)
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
      console.error('[ScratchpadService] 持久化失败:', e.message)
    }
  }

  /**
   * 设置当前会话 ID
   */
  setSessionId(sessionId) {
    this._currentSessionId = sessionId
  }

  /**
   * 保存本轮中间推理到 scratchpad（put 语义：同 sessionId 覆盖）
   * @param {string} sessionId - 会话 ID
   * @param {object} workingMemoryState - WorkingMemory.state
   * @param {object} roundSummary - 本轮摘要 { round, stage, aiResponse, toolCalls, toolResults }
   * @returns {Promise<object>} 保存的 scratchpad 对象
   */
  async save(sessionId, workingMemoryState, roundSummary) {
    await this.init()

    const scratchpad = {
      sessionId,
      timestamp: Date.now(),
      taskGoal: workingMemoryState?.taskGoal || '',
      state: workingMemoryState,
      lastRound: roundSummary,
      totalRounds: roundSummary?.round || 0,
    }

    // put 语义：Map.set 同 key 覆盖
    this._store.set(sessionId, scratchpad)
    this._persist()

    console.log(`[ScratchpadService] 保存成功: sessionId=${sessionId}, round=${roundSummary?.round}`)
    return scratchpad
  }

  /**
   * 加载指定会话的 scratchpad（用于断点续传）
   * @returns {Promise<object|null>}
   */
  async load(sessionId) {
    await this.init()
    const scratchpad = this._store.get(sessionId) || null
    if (scratchpad) {
      console.log(`[ScratchpadService] 加载成功: sessionId=${sessionId}, rounds=${scratchpad.totalRounds}`)
    }
    return scratchpad
  }

  /**
   * 获取所有 scratchpad 列表（按时间倒序）
   * @param {number} limit - 返回条数上限，默认 20
   * @returns {Promise<Array>}
   */
  async list(limit = 20) {
    await this.init()
    const arr = Array.from(this._store.values())
    // 按 timestamp 倒序
    arr.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    return arr.slice(0, limit)
  }

  /**
   * 删除指定会话的 scratchpad
   */
  async delete(sessionId) {
    await this.init()
    this._store.delete(sessionId)
    this._persist()
    console.log(`[ScratchpadService] 删除成功: sessionId=${sessionId}`)
  }

  /**
   * 导出指定会话的 scratchpad 为 JSON 文件
   * @returns {Promise<{filePath:string, filename:string, content:object}|null>}
   */
  async export(sessionId) {
    const scratchpad = await this.load(sessionId)
    if (!scratchpad) return null

    const exportDir = this._getExportDir()
    const filePath = path.join(exportDir, `scratchpad_${sessionId}.json`)
    fs.writeFileSync(filePath, JSON.stringify(scratchpad, null, 2), 'utf-8')

    return {
      filePath,
      filename: `scratchpad_${sessionId}.json`,
      content: scratchpad,
    }
  }

  /**
   * 导出所有 scratchpad 为 JSON 文件
   * @returns {Promise<{filePath:string, filename:string, content:object}>}
   */
  async exportAll() {
    const list = await this.list(100)
    const exportData = {
      version: '1.0',
      exportedAt: Date.now(),
      scratchpads: list,
    }

    const exportDir = this._getExportDir()
    const filePath = path.join(exportDir, `scratchpads_all_${Date.now()}.json`)
    fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2), 'utf-8')

    return {
      filePath,
      filename: `scratchpads_all_${Date.now()}.json`,
      content: exportData,
    }
  }

  /**
   * 清空所有 scratchpad
   */
  async clear() {
    await this.init()
    this._store.clear()
    this._persist()
    console.log('[ScratchpadService] 已清空所有 scratchpad')
  }
}

module.exports = ScratchpadService
