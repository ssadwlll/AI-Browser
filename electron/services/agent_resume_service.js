// ============ Agent 断点续传服务（Electron 主进程版） ============
// 迁移自 chrome-extension/background/services/agent-resume-service.js
// 持久化 Agent 运行状态，支持主进程重启后恢复
//
// 改动：
//   - ES Module → CommonJS (module.exports = AgentResumeService)
//   - IndexedDB → DBService（JSON 文件持久化，store=agent_snapshots）
//   - chrome.alarms 兜底闹钟 → 移除（Electron 主进程不会被随机终止，
//     setInterval 已足够可靠，无需双保险）
//   - queryByIndex 在 Electron 中仅按索引字段排序，同 tabId 下顺序不稳定，
//     故额外按 createdAt 降序排序，确保获取"最新"快照
//
// 常量：
//   SNAPSHOT_INTERVAL_MS = 10000  （10秒快照间隔）
//   MAX_SNAPSHOTS_PER_TAB = 3     （每标签页最多保留3个快照）

const DBService = require('./db_service')
const { safeJsonStringify } = require('./utils')

const STORE = 'agent_snapshots'
const SNAPSHOT_INTERVAL_MS = 10000  // 每 10 秒快照一次
const MAX_SNAPSHOTS_PER_TAB = 3     // 每个标签页最多保留 3 个快照

class AgentResumeService {
  constructor() {
    this._snapshotTimers = new Map()  // tabId -> timer
    this._activeSnapshots = new Map() // tabId -> latest snapshot id
    this._stateProviders = new Map()  // tabId -> stateProvider（供定时器回调用）
  }

  /**
   * 开始为指定标签页定期快照
   * @param {number} tabId - 标签页 ID
   * @param {function} stateProvider - 返回当前状态的函数 () => stateObject
   */
  startPeriodicSnapshot(tabId, stateProvider) {
    // 清除旧定时器
    this.stopPeriodicSnapshot(tabId)

    // 保存 stateProvider 供定时器回调使用
    this._stateProviders.set(tabId, stateProvider)

    const timer = setInterval(async () => {
      try {
        const state = stateProvider()
        if (state) {
          await this.saveSnapshot(tabId, state)
        }
      } catch (e) {
        console.warn('[AgentResume] 快照失败:', e.message)
      }
    }, SNAPSHOT_INTERVAL_MS)

    this._snapshotTimers.set(tabId, timer)
    console.log('[AgentResume] 开始定期快照, tabId:', tabId)
  }

  /**
   * 停止定期快照并清理
   * @param {number} tabId - 标签页 ID
   */
  stopPeriodicSnapshot(tabId) {
    const timer = this._snapshotTimers.get(tabId)
    if (timer) {
      clearInterval(timer)
      this._snapshotTimers.delete(tabId)
    }
    this._stateProviders.delete(tabId)
  }

  /**
   * 保存一个状态快照
   * @param {number} tabId - 标签页 ID
   * @param {object} state - 要保存的状态（messages, todoState, currentRound 等）
   * @returns {Promise<string>} 快照 ID
   */
  async saveSnapshot(tabId, state) {
    const snapshot = {
      id: DBService.genId(),
      tabId,
      createdAt: Date.now(),
      state: safeJsonStringify(state),  // 序列化以避免循环引用
      // 提取关键字段用于快速检索
      userMessage: String(state.userMessage || '').slice(0, 200),
      currentRound: state.currentRound || 0,
      totalRounds: state.totalRounds || 0,
      currentTodoIndex: state.todoState?.currentTodoIndex || 0,
      totalCompleted: state.todoState?.totalCompleted || 0,
      totalTodos: state.todoState?.totalTodos || 0,
    }
    await DBService.put(STORE, snapshot)
    this._activeSnapshots.set(tabId, snapshot.id)

    // 清理旧快照（保留最近 MAX_SNAPSHOTS_PER_TAB 个）
    await this._cleanupOldSnapshots(tabId)
    return snapshot.id
  }

  /**
   * 获取标签页的最新快照
   * @param {number} tabId - 标签页 ID
   * @returns {Promise<object|null>} 快照对象（含解析后的 state 和 ageSeconds）
   */
  async getLatestSnapshot(tabId) {
    const snapshots = await this._getSnapshotsByTabDesc(tabId, MAX_SNAPSHOTS_PER_TAB)
    if (snapshots.length === 0) return null

    const snapshot = snapshots[0]
    try {
      const state = JSON.parse(snapshot.state)
      return {
        ...snapshot,
        state,
        ageSeconds: Math.round((Date.now() - snapshot.createdAt) / 1000),
      }
    } catch (e) {
      console.warn('[AgentResume] 快照解析失败:', e.message)
      return null
    }
  }

  /**
   * 检查是否有可恢复的快照
   * @param {number} tabId - 标签页 ID
   * @param {number} maxAgeMs - 最大有效期（毫秒），默认 300000（5分钟）
   * @returns {Promise<boolean>}
   */
  async hasResumableSnapshot(tabId, maxAgeMs = 300000) {
    const snapshot = await this.getLatestSnapshot(tabId)
    if (!snapshot) return false
    // 超过 maxAgeMs 的快照不可恢复
    if (Date.now() - snapshot.createdAt > maxAgeMs) return false
    // 已完成的任务不可恢复
    if (snapshot.state.isFinished) return false
    return true
  }

  /**
   * 恢复 Agent 状态
   * 返回恢复的状态对象，由调用方注入到 AgentService
   * 超过 300 秒或已完成的快照会被拒绝
   * @param {number} tabId - 标签页 ID
   * @returns {Promise<{ok:boolean, state?:object, snapshotId?:string, ageSeconds?:number, error?:string}>}
   */
  async resume(tabId) {
    const snapshot = await this.getLatestSnapshot(tabId)
    if (!snapshot) {
      return { ok: false, error: '无可恢复的快照' }
    }
    if (snapshot.ageSeconds > 300) {
      return { ok: false, error: `快照已过期（${snapshot.ageSeconds}秒前）` }
    }
    if (snapshot.state.isFinished) {
      return { ok: false, error: '任务已完成，无需恢复' }
    }
    console.log('[AgentResume] 恢复快照:', snapshot.id, 'age:', snapshot.ageSeconds + 's')
    return {
      ok: true,
      state: snapshot.state,
      snapshotId: snapshot.id,
      ageSeconds: snapshot.ageSeconds,
    }
  }

  /**
   * 标记任务完成，停止快照并清理
   * @param {number} tabId - 标签页 ID
   */
  async markFinished(tabId) {
    this.stopPeriodicSnapshot(tabId)
    // 删除该标签页的所有快照
    const snapshots = await this._getSnapshotsByTabDesc(tabId, 100)
    for (const s of snapshots) {
      await DBService.del(STORE, s.id)
    }
    this._activeSnapshots.delete(tabId)
    console.log('[AgentResume] 任务完成，清理快照, tabId:', tabId)
  }

  /**
   * 获取所有可恢复的任务列表
   * @returns {Promise<Array>} 可恢复任务列表（按时间倒序）
   */
  async listResumableTasks() {
    const all = await DBService.getAll(STORE)
    const now = Date.now()
    const resumable = []
    const seen = new Set()

    for (const s of all) {
      if (seen.has(s.tabId)) continue
      seen.add(s.tabId)
      // 只返回 5 分钟内的快照
      if (now - s.createdAt > 300000) continue
      let state
      try { state = JSON.parse(s.state) } catch { continue }
      if (state.isFinished) continue
      resumable.push({
        tabId: s.tabId,
        snapshotId: s.id,
        createdAt: s.createdAt,
        ageSeconds: Math.round((now - s.createdAt) / 1000),
        userMessage: s.userMessage,
        currentRound: s.currentRound,
        totalRounds: s.totalRounds,
        currentTodoIndex: s.currentTodoIndex,
        progress: s.totalTodos > 0 ? `${s.totalCompleted}/${s.totalTodos}` : '0/0',
      })
    }
    return resumable.sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 清理旧快照，只保留最近的 MAX_SNAPSHOTS_PER_TAB 个
   * @param {number} tabId - 标签页 ID
   * @private
   */
  async _cleanupOldSnapshots(tabId) {
    const snapshots = await this._getSnapshotsByTabDesc(tabId, 100)
    if (snapshots.length <= MAX_SNAPSHOTS_PER_TAB) return
    // 删除多余的旧快照（已按 createdAt 降序，保留前 N 个）
    for (let i = MAX_SNAPSHOTS_PER_TAB; i < snapshots.length; i++) {
      await DBService.del(STORE, snapshots[i].id)
    }
  }

  /**
   * 按 tabId 查询快照并按 createdAt 降序排列
   * Electron 的 DBService.queryByIndex 仅按索引字段(tabId)排序，
   * 同 tabId 下返回 0（保持插入顺序，即旧→新），且 limit 在排序前生效，
   * 故此处需先全量取出再排序，确保：
   *   1. 不会因 limit 截断丢失最新快照
   *   2. 同 createdAt（同毫秒）时，后插入的（更新）排在前面
   * @param {number} tabId - 标签页 ID
   * @param {number} limit - 返回条数上限
   * @returns {Promise<object[]>}
   * @private
   */
  async _getSnapshotsByTabDesc(tabId, limit = 100) {
    // 全量查询（避免 limit 在排序前截断丢失最新快照）
    const all = await DBService.queryByIndex(STORE, 'tabId', tabId, 1000, 'prev')
    // 带 originalIndex 做次级排序：同 createdAt 时后插入的（index 更大=更新）排前面
    const indexed = all.map((s, i) => ({ s, i }))
    indexed.sort((a, b) => {
      const cmp = (b.s.createdAt || 0) - (a.s.createdAt || 0)
      if (cmp !== 0) return cmp
      // 同毫秒：按插入顺序倒序（后插入 = 更新 = 排前）
      return b.i - a.i
    })
    return indexed.map(x => x.s).slice(0, limit)
  }

  /**
   * 清理所有过期快照（可定期调用）
   * @param {number} maxAgeMs - 最大有效期（毫秒），默认 1800000（30分钟）
   * @returns {Promise<number>} 清理的快照数量
   */
  async cleanupExpired(maxAgeMs = 1800000) {
    const all = await DBService.getAll(STORE)
    const now = Date.now()
    let cleaned = 0
    for (const s of all) {
      if (now - s.createdAt > maxAgeMs) {
        await DBService.del(STORE, s.id)
        cleaned++
      }
    }
    if (cleaned > 0) {
      console.log('[AgentResume] 清理过期快照:', cleaned, '个')
    }
    return cleaned
  }
}

console.log('[AgentResume] 断点续传服务已加载')

module.exports = AgentResumeService
