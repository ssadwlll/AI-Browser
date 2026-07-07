// ============ ToolRecordingService（Electron 主进程版） ============
// 工具调用录制与回放服务
// 迁移自 chrome-extension/background/services/tool-recording-service.js
// 用 DBService（JSON 文件）替代 IndexedDB，store 名为 tool_recordings
// 用于调试、复现、自动化测试

const DBService = require('./db_service')
const { safeJsonStringify } = require('./utils')

// 数据库 store 名（已在 db_service.js 的 STORES 中定义）
const STORE = 'tool_recordings'

class ToolRecordingService {
  constructor() {
    this._currentSession = null // { sessionId, startedAt, entries: [] }
    this._isRecording = false
  }

  /**
   * 开始录制会话
   * @param {string} userMessage - 触发本次任务的用户消息
   * @returns {string} 会话 ID
   */
  startSession(userMessage = '') {
    this._currentSession = {
      sessionId: DBService.genId(),
      startedAt: Date.now(),
      userMessage,
      entries: [],
    }
    this._isRecording = true
    console.log('[ToolRecording] 开始录制会话:', this._currentSession.sessionId)
    return this._currentSession.sessionId
  }

  /**
   * 记录一次工具调用
   * @param {string} toolName - 工具名称
   * @param {object} args - 调用参数
   * @param {*} result - 执行结果
   * @param {number} durationMs - 耗时（毫秒）
   */
  record(toolName, args, result, durationMs = 0) {
    if (!this._isRecording || !this._currentSession) return
    const entry = {
      id: DBService.genId(),
      sessionId: this._currentSession.sessionId,
      toolName,
      args: this._safeClone(args),
      result: this._safeClone(result),
      durationMs,
      timestamp: Date.now(),
    }
    this._currentSession.entries.push(entry)
    // 异步持久化到 DBService（JSON 文件）
    DBService.put(STORE, entry).catch((e) => {
      console.warn('[ToolRecording] 持久化失败:', e)
    })
  }

  /**
   * 停止录制并返回会话摘要
   * @returns {Promise<object|null>} 会话摘要
   */
  async stopSession() {
    if (!this._currentSession) return null
    this._isRecording = false
    const session = this._currentSession
    this._currentSession = null
    const summary = {
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      endedAt: Date.now(),
      userMessage: session.userMessage,
      totalCalls: session.entries.length,
      toolStats: this._getToolStats(session.entries),
    }
    console.log('[ToolRecording] 录制结束:', summary)
    return summary
  }

  /**
   * 获取会话的所有录制记录（按 timestamp 正序）
   * @param {string} sessionId - 会话 ID
   * @returns {Promise<object[]>}
   */
  async getSession(sessionId) {
    return DBService.queryByIndex(STORE, 'sessionId', sessionId, 500)
  }

  /**
   * 列出最近的录制会话（按最后时间倒序）
   * @param {number} limit - 最多返回条数
   * @returns {Promise<object[]>}
   */
  async listSessions(limit = 20) {
    const all = await DBService.getAll(STORE)
    // 按 sessionId 分组聚合
    const sessions = new Map()
    for (const entry of all) {
      if (!sessions.has(entry.sessionId)) {
        sessions.set(entry.sessionId, {
          sessionId: entry.sessionId,
          firstTimestamp: entry.timestamp,
          lastTimestamp: entry.timestamp,
          count: 0,
          tools: new Set(),
        })
      }
      const s = sessions.get(entry.sessionId)
      s.count++
      s.lastTimestamp = Math.max(s.lastTimestamp, entry.timestamp)
      s.firstTimestamp = Math.min(s.firstTimestamp, entry.timestamp)
      s.tools.add(entry.toolName)
    }
    return Array.from(sessions.values())
      .map((s) => ({ ...s, tools: Array.from(s.tools) }))
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
      .slice(0, limit)
  }

  /**
   * 导出录制为 JSON 字符串
   * @param {string} sessionId - 会话 ID
   * @returns {Promise<string|null>}
   */
  async exportSession(sessionId) {
    const entries = await this.getSession(sessionId)
    if (entries.length === 0) return null
    return safeJsonStringify(
      {
        sessionId,
        exportedAt: Date.now(),
        entryCount: entries.length,
        entries: entries.map((e) => ({
          toolName: e.toolName,
          args: e.args,
          result: e.result,
          durationMs: e.durationMs,
          timestamp: e.timestamp,
        })),
      },
      null,
      2
    )
  }

  /**
   * 导入录制（从 JSON 字符串）
   * @param {string} jsonStr - 导出的 JSON 字符串
   * @returns {Promise<object>} { ok, sessionId?, count?, error? }
   */
  async importSession(jsonStr) {
    try {
      const data = JSON.parse(jsonStr)
      if (!data.entries || !Array.isArray(data.entries)) {
        return { ok: false, error: '无效的录制格式' }
      }
      const sessionId = data.sessionId || DBService.genId()
      const records = data.entries.map((e, i) => ({
        id: DBService.genId(),
        sessionId,
        toolName: e.toolName,
        args: e.args,
        result: e.result,
        durationMs: e.durationMs || 0,
        timestamp: e.timestamp || Date.now() + i,
      }))
      await DBService.putBatch(STORE, records)
      return { ok: true, sessionId, count: records.length }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  /**
   * 删除整个会话的录制
   * @param {string} sessionId - 会话 ID
   * @returns {Promise<object>} { ok, deleted }
   */
  async deleteSession(sessionId) {
    const entries = await this.getSession(sessionId)
    for (const entry of entries) {
      await DBService.del(STORE, entry.id)
    }
    return { ok: true, deleted: entries.length }
  }

  /**
   * 回放录制：按 timestamp 顺序重新执行工具调用，并比对结果一致性
   * @param {string} sessionId - 会话 ID
   * @param {function} executor - 执行函数 (toolName, args) => result
   * @param {function|null} onProgress - 进度回调 (current, total, entry)
   * @returns {Promise<object>} { ok, totalCalls, successCount, failCount, results }
   */
  async playback(sessionId, executor, onProgress = null) {
    const entries = await this.getSession(sessionId)
    if (entries.length === 0) {
      return { ok: false, error: '未找到录制记录' }
    }

    const results = []
    let successCount = 0
    let failCount = 0

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (onProgress) {
        try {
          onProgress(i + 1, entries.length, entry)
        } catch {
          /* 忽略回调异常 */
        }
      }
      try {
        const result = await executor(entry.toolName, entry.args)
        results.push({
          toolName: entry.toolName,
          ok: true,
          result: this._safeClone(result),
          originalResult: entry.result,
          matched: this._resultsMatch(result, entry.result),
        })
        successCount++
      } catch (e) {
        results.push({
          toolName: entry.toolName,
          ok: false,
          error: e.message,
        })
        failCount++
      }
    }

    return {
      ok: true,
      totalCalls: entries.length,
      successCount,
      failCount,
      results,
    }
  }

  /**
   * 是否正在录制
   */
  isRecording() {
    return this._isRecording
  }

  /**
   * 获取当前录制会话 ID
   */
  getCurrentSessionId() {
    return this._currentSession ? this._currentSession.sessionId : null
  }

  // ============ 内部辅助 ============

  /**
   * 安全克隆对象（处理循环引用）
   */
  _safeClone(obj) {
    try {
      return JSON.parse(JSON.stringify(obj))
    } catch {
      return String(obj)
    }
  }

  /**
   * 统计工具调用情况
   */
  _getToolStats(entries) {
    const stats = {}
    let totalDuration = 0
    for (const e of entries) {
      if (!stats[e.toolName]) {
        stats[e.toolName] = { count: 0, totalMs: 0 }
      }
      stats[e.toolName].count++
      stats[e.toolName].totalMs += e.durationMs || 0
      totalDuration += e.durationMs || 0
    }
    return { byTool: stats, totalDuration }
  }

  /**
   * 比对两次执行结果是否一致
   */
  _resultsMatch(r1, r2) {
    try {
      return JSON.stringify(r1) === JSON.stringify(r2)
    } catch {
      return false
    }
  }
}

module.exports = ToolRecordingService
