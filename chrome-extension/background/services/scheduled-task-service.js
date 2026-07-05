// ============ 定时任务调度服务 ============
// Feature 23: 定时任务调度（Scheduled Task Scheduling）
// 职责：
//   1. 管理周期性定时任务（URL导航 / 脚本注入 / Agent消息）
//   2. 基于 chrome.alarms 的全局心跳（每分钟检查一次到期任务）
//   3. 任务持久化到 IndexedDB（scheduled_tasks store）
//   4. 支持启用/禁用、增删改查、到期自动执行
// 说明：
//   - 采用单一全局心跳闹钟（ALARM_NAME）轮询所有任务的 nextRun 字段，
//     而非为每个任务创建独立闹钟，便于统一管控与状态恢复。

import { DBService } from './db-service.js'

// 全局心跳闹钟名：每分钟触发一次 checkAndRunDueTasks
const ALARM_NAME = 'scheduled-task-check'
// 心跳周期（分钟）
const CHECK_INTERVAL_MINUTES = 1
// 定时任务存储仓名
const TASK_STORE = 'scheduled_tasks'
// 合法的动作类型
const VALID_ACTION_TYPES = ['navigate', 'inject_script', 'agent_message']

export class ScheduledTaskService {
  /**
   * @param {object} executor - 执行器，提供具体动作实现（可选）
   *   - navigate(url): 导航到指定URL
   *   - injectScript(scriptId): 注入服务端脚本（需外部 scriptService 获取脚本代码）
   *   - sendAgentMessage(message): 向sidepanel发送Agent消息
   */
  constructor(executor = {}) {
    this.executor = executor || {}
    this.alarmListener = null
  }

  // ============ 任务 CRUD ============

  /**
   * 创建定时任务
   * @param {object} config - 任务配置
   *   必填: name, actionType, intervalMinutes
   *   可选: actionParams, enabled, nextRun
   * @returns {Promise<{ok:boolean, task?:object, error?:string}>}
   */
  async createTask(config) {
    try {
      // 参数校验
      if (!config || !config.name || !config.actionType || !config.intervalMinutes) {
        return { ok: false, error: '缺少必填字段: name / actionType / intervalMinutes' }
      }
      if (!VALID_ACTION_TYPES.includes(config.actionType)) {
        return { ok: false, error: `非法 actionType: ${config.actionType}` }
      }
      if (config.intervalMinutes < 1) {
        return { ok: false, error: 'intervalMinutes 不能小于 1' }
      }

      const now = Date.now()
      const task = {
        id: DBService.genId(),
        name: config.name,
        actionType: config.actionType,
        actionParams: config.actionParams || {},
        intervalMinutes: config.intervalMinutes,
        enabled: config.enabled !== false,
        nextRun: config.nextRun || now,
        lastRun: null,
        lastResult: null,
        createdAt: now,
      }

      await DBService.put(TASK_STORE, task)
      // 注册全局心跳闹钟（确保心跳存在）
      await this._registerAlarm(task)
      console.log(`[ScheduledTaskService] 任务已创建: ${task.id} (${task.name})`)
      return { ok: true, task }
    } catch (e) {
      console.error('[ScheduledTaskService] createTask 失败:', e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  /**
   * 更新任务配置
   */
  async updateTask(id, updates) {
    try {
      if (!id) return { ok: false, error: '缺少 id' }
      if (!updates || typeof updates !== 'object') return { ok: false, error: 'updates 必须为对象' }

      const existing = await this._findTask(id)
      if (!existing) return { ok: false, error: `任务不存在: ${id}` }

      // 动作类型校验
      if (updates.actionType && !VALID_ACTION_TYPES.includes(updates.actionType)) {
        return { ok: false, error: `非法 actionType: ${updates.actionType}` }
      }
      // 间隔校验
      if (updates.intervalMinutes !== undefined && updates.intervalMinutes < 1) {
        return { ok: false, error: 'intervalMinutes 不能小于 1' }
      }

      const merged = { ...existing, ...updates, id: existing.id }
      // 修改间隔或显式指定 nextRun 时重新计算下次执行时间
      if (updates.intervalMinutes !== undefined && updates.nextRun === undefined) {
        merged.nextRun = Date.now()
      }
      await DBService.put(TASK_STORE, merged)

      // 任务处于启用态时确保心跳存在
      if (merged.enabled) await this._registerAlarm(merged)
      console.log(`[ScheduledTaskService] 任务已更新: ${id}`)
      return { ok: true, task: merged }
    } catch (e) {
      console.error('[ScheduledTaskService] updateTask 失败:', e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  /**
   * 删除任务
   */
  async deleteTask(id) {
    try {
      if (!id) return { ok: false, error: '缺少 id' }
      await DBService.del(TASK_STORE, id)
      // 删除后若无其他启用任务，则清除心跳闹钟
      await this._unregisterAlarm(id)
      console.log(`[ScheduledTaskService] 任务已删除: ${id}`)
      return { ok: true }
    } catch (e) {
      console.error('[ScheduledTaskService] deleteTask 失败:', e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  /**
   * 列出全部任务
   */
  async listTasks() {
    try {
      const tasks = await DBService.getAll(TASK_STORE)
      return { ok: true, tasks: tasks || [] }
    } catch (e) {
      console.error('[ScheduledTaskService] listTasks 失败:', e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  /**
   * 启用/禁用任务
   */
  async toggleTask(id, enabled) {
    try {
      if (!id) return { ok: false, error: '缺少 id' }
      const existing = await this._findTask(id)
      if (!existing) return { ok: false, error: `任务不存在: ${id}` }

      existing.enabled = !!enabled
      // 启用时若已过期则立即安排执行
      if (existing.enabled && (!existing.nextRun || existing.nextRun <= Date.now())) {
        existing.nextRun = Date.now()
      }
      await DBService.put(TASK_STORE, existing)

      if (existing.enabled) {
        await this._registerAlarm(existing)
      } else {
        // 禁用后若无其他启用任务，则清除心跳
        await this._unregisterAlarm(id)
      }
      console.log(`[ScheduledTaskService] 任务 ${id} enabled=${existing.enabled}`)
      return { ok: true, task: existing }
    } catch (e) {
      console.error('[ScheduledTaskService] toggleTask 失败:', e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  // ============ 调度执行 ============

  /**
   * 检查并执行到期任务（由全局心跳闹钟触发）
   * 遍历所有启用任务，执行 nextRun <= now 的任务并更新下次执行时间
   */
  async checkAndRunDueTasks() {
    try {
      const now = Date.now()
      const all = await DBService.getAll(TASK_STORE)
      const due = (all || []).filter(t => t.enabled && t.nextRun && t.nextRun <= now)
      if (due.length === 0) return { ok: true, ran: 0 }

      console.log(`[ScheduledTaskService] 发现 ${due.length} 个到期任务`)
      const results = []
      for (const task of due) {
        // 单任务执行失败不影响其他任务
        const res = await this.runTask(task)
        results.push({ id: task.id, ok: res.ok, error: res.error || null })

        // 更新执行结果与下次执行时间
        task.lastRun = now
        task.lastResult = { ok: res.ok, error: res.error || null, at: now }
        task.nextRun = now + task.intervalMinutes * 60 * 1000
        try {
          await DBService.put(TASK_STORE, task)
        } catch (e) {
          console.error(`[ScheduledTaskService] 更新任务状态失败 ${task.id}:`, e)
        }
      }
      return { ok: true, ran: due.length, results }
    } catch (e) {
      console.error('[ScheduledTaskService] checkAndRunDueTasks 失败:', e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  /**
   * 执行单个任务
   * @param {object} task - 任务对象
   * 支持三种动作类型：
   *   - navigate: chrome.tabs.update 导航到指定URL
   *   - inject_script: 调用 executor.injectScript 注入服务端脚本
   *   - agent_message: 通过 chrome.runtime.sendMessage 向 sidepanel 发送消息
   */
  async runTask(task) {
    try {
      if (!task || !task.actionType) return { ok: false, error: '任务缺少 actionType' }
      const params = task.actionParams || {}
      const ex = this.executor || {}

      switch (task.actionType) {
        case 'navigate': {
          const url = params.url
          if (!url) return { ok: false, error: 'navigate 缺少 actionParams.url' }
          if (typeof ex.navigate === 'function') {
            await ex.navigate(url)
          } else {
            // 默认实现：在当前激活标签页导航；无激活标签则新建标签
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
            if (tabs && tabs.length > 0 && tabs[0].id != null) {
              await chrome.tabs.update(tabs[0].id, { url })
            } else {
              await chrome.tabs.create({ url })
            }
          }
          return { ok: true }
        }

        case 'inject_script': {
          const scriptId = params.scriptId
          if (scriptId == null) return { ok: false, error: 'inject_script 缺少 actionParams.scriptId' }
          // 脚本代码需由外部 scriptService 获取，此处通过 executor 回调执行
          if (typeof ex.injectScript === 'function') {
            await ex.injectScript(scriptId)
            return { ok: true }
          }
          console.warn('[ScheduledTaskService] inject_script 需要外部 executor.injectScript')
          return { ok: false, error: '未提供 executor.injectScript，无法注入脚本' }
        }

        case 'agent_message': {
          const message = params.message
          if (message == null) return { ok: false, error: 'agent_message 缺少 actionParams.message' }
          if (typeof ex.sendAgentMessage === 'function') {
            await ex.sendAgentMessage(message)
            return { ok: true }
          }
          // 默认实现：向 sidepanel 发送 Agent 消息
          await chrome.runtime.sendMessage({ type: 'agent_message', message })
          return { ok: true }
        }

        default:
          return { ok: false, error: `未知 actionType: ${task.actionType}` }
      }
    } catch (e) {
      console.error(`[ScheduledTaskService] runTask 失败 ${task && task.id}:`, e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  // ============ 闹钟管理 ============

  /**
   * 注册全局心跳闹钟（幂等）
   * 每分钟触发一次 checkAndRunDueTasks
   * @param {object} task - 触发注册的任务（仅用于日志上下文）
   */
  async _registerAlarm(task) {
    try {
      await chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MINUTES })
      console.log(`[ScheduledTaskService] 心跳闹钟已注册 (task=${task && task.id || '-'})`)
    } catch (e) {
      console.error('[ScheduledTaskService] _registerAlarm 失败:', e)
    }
  }

  /**
   * 注销心跳闹钟
   * 仅当无任何启用的任务时才清除，避免误删其他任务的调度
   * @param {string} taskId - 被删除/禁用的任务ID（仅用于日志）
   */
  async _unregisterAlarm(taskId) {
    try {
      const all = await DBService.getAll(TASK_STORE)
      const hasEnabled = (all || []).some(t => t.enabled)
      if (!hasEnabled) {
        await chrome.alarms.clear(ALARM_NAME)
        console.log(`[ScheduledTaskService] 无启用任务，心跳闹钟已清除 (taskId=${taskId || '-'})`)
      }
    } catch (e) {
      console.error('[ScheduledTaskService] _unregisterAlarm 失败:', e)
    }
  }

  // ============ 内部辅助 ============

  /**
   * 按 id 查询单个任务
   */
  async _findTask(id) {
    const all = await DBService.getAll(TASK_STORE)
    return (all || []).find(t => t.id === id) || null
  }
}

console.log('[ScheduledTaskService] 定时任务服务已加载')
