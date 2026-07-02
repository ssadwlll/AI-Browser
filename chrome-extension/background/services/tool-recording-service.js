// ============ 工具调用录制与回放服务 ============
// Feature 4: 录制 Agent 工具调用序列，支持回放与导出
// 用于调试、复现、自动化测试

import { DBService } from './db-service.js'
import { safeJsonStringify } from '../../shared/utils.js'

const STORE = 'tool_recordings'

export class ToolRecordingService {
  constructor() {
    this._currentSession = null   // { sessionId, startedAt, entries: [] }
    this._isRecording = false
  }

  /**
   * 开始录制会话
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
    // 异步持久化到 IndexedDB
    DBService.put(STORE, entry).catch(e => {
      console.warn('[ToolRecording] 持久化失败:', e)
    })
  }

  /**
   * 停止录制并返回会话摘要
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
   * 获取会话的所有录制记录
   */
  async getSession(sessionId) {
    return DBService.queryByIndex(STORE, 'sessionId', sessionId, 500)
  }

  /**
   * 列出最近的录制会话（按时间倒序）
   */
  async listSessions(limit = 20) {
    const all = await DBService.getAll(STORE)
    // 按 sessionId 分组
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
      .map(s => ({ ...s, tools: Array.from(s.tools) }))
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
      .slice(0, limit)
  }

  /**
   * 回放录制：按顺序重新执行工具调用
   * @param {string} sessionId - 会话 ID
   * @param {function} executor - 执行函数 (toolName, args) => result
   * @param {function} onProgress - 进度回调 (current, total, entry)
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
        try { onProgress(i + 1, entries.length, entry) } catch {}
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
   * 导出录制为 JSON 字符串
   */
  async exportSession(sessionId) {
    const entries = await this.getSession(sessionId)
    if (entries.length === 0) return null
    return safeJsonStringify({
      sessionId,
      exportedAt: Date.now(),
      entryCount: entries.length,
      entries: entries.map(e => ({
        toolName: e.toolName,
        args: e.args,
        result: e.result,
        durationMs: e.durationMs,
        timestamp: e.timestamp,
      })),
    }, null, 2)
  }

  /**
   * 导入录制（从 JSON 字符串）
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
        timestamp: e.timestamp || (Date.now() + i),
      }))
      await DBService.putBatch(STORE, records)
      return { ok: true, sessionId, count: records.length }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  /**
   * 删除整个会话的录制
   */
  async deleteSession(sessionId) {
    const entries = await this.getSession(sessionId)
    for (const entry of entries) {
      await DBService.del(STORE, entry.id)
    }
    return { ok: true, deleted: entries.length }
  }

  isRecording() {
    return this._isRecording
  }

  getCurrentSessionId() {
    return this._currentSession?.sessionId || null
  }

  // ============ 内部辅助 ============

  _safeClone(obj) {
    try {
      return JSON.parse(JSON.stringify(obj))
    } catch {
      return String(obj)
    }
  }

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

  _resultsMatch(r1, r2) {
    try {
      return JSON.stringify(r1) === JSON.stringify(r2)
    } catch {
      return false
    }
  }
}

console.log('[ToolRecording] 工具录制服务已加载')
