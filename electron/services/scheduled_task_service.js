// ============ ScheduledTaskService（定时任务调度服务）============
// 管理周期性定时任务（URL 导航 / 脚本执行 / Agent 任务）
//
// 迁移自 chrome-extension/background/services/scheduled-task-service.js
// 改动：
//   - ES Module → CommonJS
//   - chrome.alarms → setInterval（全局心跳，每分钟检查一次到期任务）
//   - IndexedDB → DBService（store=scheduled_tasks）
//   - MV3 SW 生命周期 → 简化（Electron 主进程持久运行，无需复杂重启恢复）
//   - 调度类型扩展为 once | interval | cron
//   - 动作类型扩展为 agent_task | script_execution | url_navigation
//
// 任务数据结构：
//   {
//     id, name, description,
//     schedule: { type: 'once'|'interval'|'cron', datetime|intervalMs|cronExpr },
//     action: { type: 'agent_task'|'script_execution'|'url_navigation', params },
//     enabled: true,
//     lastRun, nextRun,
//     createdAt, updatedAt
//   }

const DBService = require('./db_service')

// 定时任务存储仓名（已在 db_service.js 的 STORES 中定义）
const TASK_STORE = 'scheduled_tasks'
// 心跳检查间隔（毫秒）：每分钟检查一次到期任务
const CHECK_INTERVAL_MS = 60 * 1000
// 合法的调度类型
const VALID_SCHEDULE_TYPES = ['once', 'interval', 'cron']
// 合法的动作类型
const VALID_ACTION_TYPES = ['agent_task', 'script_execution', 'url_navigation']

class ScheduledTaskService {
  /**
   * @param {object} configService - ConfigService 实例，用于获取执行配置
   * @param {object} [executor] - 执行器，提供具体动作实现（可选）
   *   - navigate(url): 导航到指定 URL
   *   - executeScript(scriptId, params): 执行脚本
   *   - sendAgentTask(message, params): 发送 Agent 任务
   */
  constructor(configService, executor = {}) {
    this.configService = configService || null
    this.executor = executor || {}
    this._heartbeatTimer = null // 心跳定时器
    this._running = false
  }

  /**
   * 初始化：启动心跳定时器
   */
  async init() {
    if (this._running) return
    this.start()
    console.log('[ScheduledTaskService] 定时任务服务已初始化')
  }

  // ============ 任务 CRUD ============

  /**
   * 创建定时任务
   * @param {object} task - 任务配置
   *   必填: name, schedule, action
   * @returns {Promise<object>} 创建的任务对象
   */
  async create(task) {
    if (!task || typeof task !== 'object') {
      throw new Error('task 必须为对象')
    }
    if (!task.name || typeof task.name !== 'string') {
      throw new Error('缺少必填字段: name')
    }
    if (!task.schedule || !VALID_SCHEDULE_TYPES.includes(task.schedule.type)) {
      throw new Error(`非法 schedule.type，应为: ${VALID_SCHEDULE_TYPES.join('/')}`)
    }
    if (!task.action || !VALID_ACTION_TYPES.includes(task.action.type)) {
      throw new Error(`非法 action.type，应为: ${VALID_ACTION_TYPES.join('/')}`)
    }

    // 校验调度参数
    this._validateSchedule(task.schedule)

    const now = Date.now()
    const newTask = {
      id: DBService.genId(),
      name: task.name,
      description: task.description || '',
      schedule: task.schedule,
      action: task.action,
      enabled: task.enabled !== false,
      lastRun: null,
      lastResult: null,
      nextRun: this._computeNextRun(task.schedule, now),
      createdAt: now,
      updatedAt: now,
    }

    await DBService.put(TASK_STORE, newTask)
    console.log(`[ScheduledTaskService] 任务已创建: ${newTask.id} (${newTask.name})`)
    return newTask
  }

  /**
   * 更新任务配置
   * @param {string} taskId - 任务 ID
   * @param {object} updates - 更新字段
   * @returns {Promise<object>} 更新后的任务对象
   */
  async update(taskId, updates) {
    if (!taskId) throw new Error('缺少 taskId')
    if (!updates || typeof updates !== 'object') throw new Error('updates 必须为对象')

    const existing = await this.get(taskId)
    if (!existing) throw new Error(`任务不存在: ${taskId}`)

    // 校验更新字段
    if (updates.schedule) {
      if (!VALID_SCHEDULE_TYPES.includes(updates.schedule.type)) {
        throw new Error(`非法 schedule.type: ${updates.schedule.type}`)
      }
      this._validateSchedule(updates.schedule)
    }
    if (updates.action && !VALID_ACTION_TYPES.includes(updates.action.type)) {
      throw new Error(`非法 action.type: ${updates.action.type}`)
    }

    const merged = { ...existing, ...updates, id: existing.id, createdAt: existing.createdAt }

    // 修改调度配置时重新计算下次执行时间
    if (updates.schedule) {
      merged.nextRun = this._computeNextRun(merged.schedule, Date.now())
    }

    merged.updatedAt = Date.now()
    await DBService.put(TASK_STORE, merged)

    console.log(`[ScheduledTaskService] 任务已更新: ${taskId}`)
    return merged
  }

  /**
   * 删除任务
   * @param {string} taskId - 任务 ID
   * @returns {Promise<boolean>}
   */
  async delete(taskId) {
    if (!taskId) throw new Error('缺少 taskId')
    await DBService.del(TASK_STORE, taskId)
    console.log(`[ScheduledTaskService] 任务已删除: ${taskId}`)
    return true
  }

  /**
   * 获取单个任务
   * @returns {Promise<object|null>}
   */
  async get(taskId) {
    if (!taskId) return null
    return (await DBService.get(TASK_STORE, taskId)) || null
  }

  /**
   * 列出所有任务
   * @returns {Promise<object[]>}
   */
  async list() {
    const tasks = await DBService.getAll(TASK_STORE)
    return tasks || []
  }

  /**
   * 启用任务
   * @param {string} taskId - 任务 ID
   * @returns {Promise<object>} 更新后的任务对象
   */
  async enable(taskId) {
    const task = await this.get(taskId)
    if (!task) throw new Error(`任务不存在: ${taskId}`)

    task.enabled = true
    // 启用时若已过期则重新计算下次执行时间
    if (!task.nextRun || task.nextRun <= Date.now()) {
      task.nextRun = this._computeNextRun(task.schedule, Date.now())
    }
    task.updatedAt = Date.now()
    await DBService.put(TASK_STORE, task)

    console.log(`[ScheduledTaskService] 任务已启用: ${taskId}`)
    return task
  }

  /**
   * 禁用任务
   * @param {string} taskId - 任务 ID
   * @returns {Promise<object>} 更新后的任务对象
   */
  async disable(taskId) {
    const task = await this.get(taskId)
    if (!task) throw new Error(`任务不存在: ${taskId}`)

    task.enabled = false
    task.updatedAt = Date.now()
    await DBService.put(TASK_STORE, task)

    console.log(`[ScheduledTaskService] 任务已禁用: ${taskId}`)
    return task
  }

  // ============ 调度执行 ============

  /**
   * 检查并执行到期任务（由心跳定时器每分钟触发）
   * 遍历所有启用任务，执行 nextRun <= now 的任务并更新下次执行时间
   * @returns {Promise<{ran:number, results:object[]}>}
   */
  async checkAndRunDueTasks() {
    const now = Date.now()
    const all = await DBService.getAll(TASK_STORE)
    const due = (all || []).filter((t) => t.enabled && t.nextRun && t.nextRun <= now)

    if (due.length === 0) return { ran: 0, results: [] }

    console.log(`[ScheduledTaskService] 发现 ${due.length} 个到期任务`)
    const results = []

    for (const task of due) {
      // 单任务执行失败不影响其他任务
      const res = await this._runTask(task)
      results.push({ id: task.id, name: task.name, ok: res.ok, error: res.error || null })

      // 更新执行结果与下次执行时间
      task.lastRun = now
      task.lastResult = { ok: res.ok, error: res.error || null, at: now }

      if (task.schedule.type === 'once') {
        // 一次性任务执行后自动禁用
        task.enabled = false
        task.nextRun = null
      } else {
        // 周期性任务计算下次执行时间
        task.nextRun = this._computeNextRun(task.schedule, now)
      }

      try {
        await DBService.put(TASK_STORE, task)
      } catch (e) {
        console.error(`[ScheduledTaskService] 更新任务状态失败 ${task.id}:`, e.message)
      }
    }

    return { ran: due.length, results }
  }

  /**
   * 执行单个任务
   * @param {object} task - 任务对象
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async _runTask(task) {
    try {
      if (!task || !task.action || !task.action.type) {
        return { ok: false, error: '任务缺少 action.type' }
      }

      const params = task.action.params || {}
      const ex = this.executor || {}

      switch (task.action.type) {
        case 'url_navigation': {
          const url = params.url
          if (!url) return { ok: false, error: 'url_navigation 缺少 params.url' }
          if (typeof ex.navigate === 'function') {
            await ex.navigate(url)
          } else {
            console.warn('[ScheduledTaskService] url_navigation 需要外部 executor.navigate')
            return { ok: false, error: '未提供 executor.navigate' }
          }
          return { ok: true }
        }

        case 'script_execution': {
          const scriptId = params.scriptId
          if (scriptId == null) return { ok: false, error: 'script_execution 缺少 params.scriptId' }
          if (typeof ex.executeScript === 'function') {
            await ex.executeScript(scriptId, params)
            return { ok: true }
          }
          console.warn('[ScheduledTaskService] script_execution 需要外部 executor.executeScript')
          return { ok: false, error: '未提供 executor.executeScript' }
        }

        case 'agent_task': {
          const message = params.message
          if (message == null) return { ok: false, error: 'agent_task 缺少 params.message' }
          if (typeof ex.sendAgentTask === 'function') {
            await ex.sendAgentTask(message, params)
            return { ok: true }
          }
          console.warn('[ScheduledTaskService] agent_task 需要外部 executor.sendAgentTask')
          return { ok: false, error: '未提供 executor.sendAgentTask' }
        }

        default:
          return { ok: false, error: `未知 action.type: ${task.action.type}` }
      }
    } catch (e) {
      console.error(`[ScheduledTaskService] 执行任务失败 ${task && task.id}:`, e.message)
      return { ok: false, error: e.message || String(e) }
    }
  }

  /**
   * 设置执行器（可在构造后注入）
   * @param {object} executor - 执行器对象
   */
  setExecutor(executor) {
    this.executor = executor || {}
  }

  // ============ 心跳定时器管理 ============

  /**
   * 启动心跳定时器（每分钟检查一次到期任务）
   */
  start() {
    if (this._running) return
    this._running = true

    // 立即检查一次（启动时可能有积压的到期任务）
    this.checkAndRunDueTasks().catch((e) => {
      console.error('[ScheduledTaskService] 启动检查失败:', e.message)
    })

    this._heartbeatTimer = setInterval(() => {
      this.checkAndRunDueTasks().catch((e) => {
        console.error('[ScheduledTaskService] 心跳检查失败:', e.message)
      })
    }, CHECK_INTERVAL_MS)

    console.log(`[ScheduledTaskService] 心跳定时器已启动（间隔 ${CHECK_INTERVAL_MS}ms）`)
  }

  /**
   * 停止心跳定时器
   */
  stop() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
    this._running = false
    console.log('[ScheduledTaskService] 心跳定时器已停止')
  }

  // ============ 调度计算 ============

  /**
   * 校验调度参数完整性
   * @param {object} schedule - 调度配置
   */
  _validateSchedule(schedule) {
    switch (schedule.type) {
      case 'once':
        if (!schedule.datetime) {
          throw new Error("schedule.type='once' 需要 schedule.datetime")
        }
        break
      case 'interval':
        if (!schedule.intervalMs || schedule.intervalMs < 1000) {
          throw new Error("schedule.type='interval' 需要 schedule.intervalMs（≥1000ms）")
        }
        break
      case 'cron':
        if (!schedule.cronExpr || typeof schedule.cronExpr !== 'string') {
          throw new Error("schedule.type='cron' 需要 schedule.cronExpr")
        }
        break
      default:
        throw new Error(`非法 schedule.type: ${schedule.type}`)
    }
  }

  /**
   * 计算下次执行时间
   * @param {object} schedule - 调度配置
   * @param {number} from - 基准时间戳，默认当前时间
   * @returns {number|null} 下次执行时间戳，一次性任务已过期则返回 null
   */
  _computeNextRun(schedule, from = Date.now()) {
    switch (schedule.type) {
      case 'once': {
        const dt = new Date(schedule.datetime).getTime()
        // 若指定时间已过，返回 null（不再执行）
        return dt > from ? dt : null
      }
      case 'interval': {
        // 从基准时间开始加上间隔
        return from + schedule.intervalMs
      }
      case 'cron': {
        return this._computeCronNextRun(schedule.cronExpr, new Date(from + 1000))
      }
      default:
        return null
    }
  }

  /**
   * 解析 cron 字段为合法值集合
   * 支持: * / , - 语法
   * @param {string} field - cron 字段
   * @param {number} min - 最小值
   * @param {number} max - 最大值
   * @returns {Set<number>}
   */
  _parseCronField(field, min, max) {
    const result = new Set()
    for (const part of field.split(',')) {
      const trimmed = part.trim()
      if (trimmed === '*') {
        for (let i = min; i <= max; i++) result.add(i)
      } else if (trimmed.includes('/')) {
        const [base, stepStr] = trimmed.split('/')
        const step = parseInt(stepStr, 10)
        if (step <= 0) continue
        if (base === '*') {
          for (let i = min; i <= max; i += step) result.add(i)
        } else if (base.includes('-')) {
          const [s, e] = base.split('-').map((n) => parseInt(n, 10))
          for (let i = s; i <= e; i += step) result.add(i)
        } else {
          const start = parseInt(base, 10)
          for (let i = start; i <= max; i += step) result.add(i)
        }
      } else if (trimmed.includes('-')) {
        const [s, e] = trimmed.split('-').map((n) => parseInt(n, 10))
        for (let i = s; i <= e; i++) result.add(i)
      } else {
        const val = parseInt(trimmed, 10)
        if (!isNaN(val)) result.add(val)
      }
    }
    return result
  }

  /**
   * 计算 cron 表达式的下次执行时间
   * 标准 5 字段格式：分 时 日 月 周
   * @param {string} cronExpr - cron 表达式
   * @param {Date} from - 起始时间
   * @returns {number|null} 下次执行时间戳
   */
  _computeCronNextRun(cronExpr, from = new Date()) {
    const parts = cronExpr.trim().split(/\s+/)
    if (parts.length !== 5) {
      console.warn('[ScheduledTaskService] cron 表达式格式错误（应为 5 字段）:', cronExpr)
      return null
    }

    const minutes = this._parseCronField(parts[0], 0, 59)
    const hours = this._parseCronField(parts[1], 0, 23)
    const doms = this._parseCronField(parts[2], 1, 31)
    const months = this._parseCronField(parts[3], 1, 12)
    const dows = this._parseCronField(parts[4], 0, 6) // 0=Sunday

    // 从下一分钟开始逐分钟搜索，最多搜索一年
    const start = new Date(from.getTime())
    start.setSeconds(0, 0)
    start.setMinutes(start.getMinutes() + 1)

    const limit = new Date(from.getTime() + 365 * 24 * 60 * 60 * 1000)
    let cur = new Date(start)

    while (cur <= limit) {
      const m = cur.getMinutes()
      const h = cur.getHours()
      const dom = cur.getDate()
      const mon = cur.getMonth() + 1
      const dow = cur.getDay()

      if (minutes.has(m) && hours.has(h) && months.has(mon) && doms.has(dom) && dows.has(dow)) {
        return cur.getTime()
      }
      // 逐分钟递增
      cur = new Date(cur.getTime() + 60000)
    }

    console.warn('[ScheduledTaskService] cron 表达式一年内无匹配时间:', cronExpr)
    return null
  }
}

module.exports = ScheduledTaskService
