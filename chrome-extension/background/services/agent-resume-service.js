// ============ Agent 断点续传服务 ============
// Feature 6: 持久化 Agent 运行状态，支持 SW 重启后恢复
// MV3 Service Worker 可能被随时终止，此服务定期快照关键状态

import { DBService } from './db-service.js'
import { safeJsonStringify } from '../../shared/utils.js'

const STORE = 'agent_snapshots'
const SNAPSHOT_INTERVAL_MS = 10000  // 每 10 秒快照一次（内存 setInterval，SW 终止时会丢失）
const SNAPSHOT_ALARM_NAME = 'agent-snapshot-backup'  // 闹钟名（SW 重启后仍能触发，作为兜底）
const ALARM_BACKUP_INTERVAL_MIN = 1  // 闹钟最小周期 1 分钟（chrome.alarms 限制）
const MAX_SNAPSHOTS_PER_TAB = 3     // 每个标签页最多保留 3 个快照

export class AgentResumeService {
  constructor() {
    this._snapshotTimers = new Map()  // tabId -> timer
    this._activeSnapshots = new Map() // tabId -> latest snapshot id
    this._stateProviders = new Map()  // tabId -> stateProvider（供 alarm 回调用）
    this._alarmRegistered = false
  }

  /**
   * 注册兜底闹钟（仅注册一次，所有 tab 共用）
   * MV3 SW 在 30 秒不活动后会被终止，setInterval 会被销毁。
   * chrome.alarms 由浏览器持久化，SW 重启后仍能触发，作为断点续传的双保险。
   *
   * 注意：监听器只挂载一次，避免 stopPeriodicSnapshot 后再次启动时累积监听器
   */
  _ensureBackupAlarm() {
    if (this._alarmRegistered) return
    try {
      // 监听器只挂载一次：用 hasListener 守卫避免重复注册
      if (!this._alarmListenerBound) {
        const handler = (alarm) => {
          if (alarm.name === SNAPSHOT_ALARM_NAME) {
            // 闹钟触发时为所有活跃 tabId 各做一次快照
            this._backupAllActive().catch(e => {
              console.warn('[AgentResume] 闹钟兜底快照失败:', e.message)
            })
          }
        }
        // hasListener 通过引用比较，确保同一函数不会重复注册
        if (!chrome.alarms.onAlarm.hasListener(handler)) {
          chrome.alarms.onAlarm.addListener(handler)
        }
        this._alarmListener = handler
        this._alarmListenerBound = true
      }
      chrome.alarms.create(SNAPSHOT_ALARM_NAME, { periodInMinutes: ALARM_BACKUP_INTERVAL_MIN })
      this._alarmRegistered = true
      console.log('[AgentResume] 兜底闹钟已注册，周期', ALARM_BACKUP_INTERVAL_MIN, '分钟')
    } catch (e) {
      console.warn('[AgentResume] 注册兜底闹钟失败:', e.message)
    }
  }

  /**
   * 闹钟兜底：为所有活跃 tabId 各做一次快照
   */
  async _backupAllActive() {
    const entries = [...this._stateProviders.entries()]
    if (entries.length === 0) return
    for (const [tabId, provider] of entries) {
      try {
        const state = provider()
        if (state) await this.saveSnapshot(tabId, state)
      } catch (e) {
        console.warn('[AgentResume] 闹钟兜底快照 tabId=' + tabId + ' 失败:', e.message)
      }
    }
  }

  /**
   * 开始为指定标签页定期快照
   * @param {number} tabId - 标签页 ID
   * @param {function} stateProvider - 返回当前状态的函数 () => stateObject
   */
  startPeriodicSnapshot(tabId, stateProvider) {
    // 清除旧定时器
    this.stopPeriodicSnapshot(tabId)

    // 注册兜底闹钟（仅注册一次）
    this._ensureBackupAlarm()

    // 保存 stateProvider 供闹钟回调用（SW 终止后 setInterval 会丢失，但闹钟仍可触发）
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
   * 停止定期快照
   */
  stopPeriodicSnapshot(tabId) {
    const timer = this._snapshotTimers.get(tabId)
    if (timer) {
      clearInterval(timer)
      this._snapshotTimers.delete(tabId)
    }
    this._stateProviders.delete(tabId)
    // 如果没有活跃任务，可以注销兜底闹钟（保留也无害，但为节省资源可以注销）
    if (this._snapshotTimers.size === 0 && this._alarmRegistered) {
      try { chrome.alarms.clear(SNAPSHOT_ALARM_NAME) } catch {}
      this._alarmRegistered = false
    }
  }

  /**
   * 保存一个状态快照
   * @param {number} tabId
   * @param {object} state - 要保存的状态（messages, todoState, currentRound 等）
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
   */
  async getLatestSnapshot(tabId) {
    const snapshots = await DBService.queryByIndex(STORE, 'tabId', tabId, MAX_SNAPSHOTS_PER_TAB, 'prev')
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
   * 标记任务完成，清理快照
   */
  async markFinished(tabId) {
    this.stopPeriodicSnapshot(tabId)
    // 删除该标签页的所有快照
    const snapshots = await DBService.queryByIndex(STORE, 'tabId', tabId, 100)
    for (const s of snapshots) {
      await DBService.del(STORE, s.id)
    }
    this._activeSnapshots.delete(tabId)
    console.log('[AgentResume] 任务完成，清理快照, tabId:', tabId)
  }

  /**
   * 获取所有可恢复的任务列表
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
   * 清理旧快照，只保留最近的 N 个
   */
  async _cleanupOldSnapshots(tabId) {
    const snapshots = await DBService.queryByIndex(STORE, 'tabId', tabId, 100, 'prev')
    if (snapshots.length <= MAX_SNAPSHOTS_PER_TAB) return
    for (let i = MAX_SNAPSHOTS_PER_TAB; i < snapshots.length; i++) {
      await DBService.del(STORE, snapshots[i].id)
    }
  }

  /**
   * 清理所有过期快照（可定期调用）
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
