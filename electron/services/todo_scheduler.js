// ============ TodoScheduler（Electron 主进程版） ============
// 扁平待办调度引擎
// 迁移自 chrome-extension/background/services/todo-scheduler.js
// 职责：
//   1. 提供扁平待办模板，AI 填充后系统校验
//   2. 客观统计整体待办进度，到达阈值自动下发收敛提示
//   3. 内置硬性规则：5轮无进展强制 finish_task、3次脚本失败强制 finish_task
// 依赖 GlobalDataStore（通过构造函数注入），CommonJS 模块

// ===== 硬性规则常量 =====
const HARD_RULES = {
  FAIL_THRESHOLD: 5, // 连续5次无进展 → 强制 finish_task
  SCRIPT_FAIL_THRESHOLD: 3, // 连续3次脚本失败 → 强制 finish_task
  CONVERGENCE_70: 0.7,
  CONVERGENCE_85: 0.85,
}

/**
 * 容错恢复：当 AI 生成的待办 JSON 因 description 含未转义引号而解析失败时，
 * 用正则逐项提取字段。支持字段：id, action, description, url, selector 等。
 * 核心思路：按 }, { 分割每个待办项，对每个字符串字段，
 * 值结束于下一个字段匹配位置之前的最后一个 "
 * @param {string} str - 原始待办字符串
 * @returns {object[]|null} 恢复出的待办项数组，失败返回 null
 */
function _recoverTodoItemsFromString(str) {
  if (typeof str !== 'string') return null
  const trimmed = str.trim().replace(/^\[/, '').replace(/\]$/, '').trim()
  if (!trimmed) return null

  // 按 }, { 分割成单独的项（容忍换行和空格）
  const itemStrs = trimmed.split(/\}\s*,\s*\{/).map((s, i, arr) => {
    if (i === 0) return s.replace(/^\s*\{/, '')
    if (i === arr.length - 1) return s.replace(/\}\s*$/, '')
    return s
  })

  const items = []
  for (const itemStr of itemStrs) {
    const item = {}
    // 匹配所有 "字段": " 的位置（字符串字段）
    const fieldPattern = /"(\w+)"\s*:\s*"/g
    const matches = []
    let m
    while ((m = fieldPattern.exec(itemStr)) !== null) {
      matches.push({ key: m[1], valueStart: m.index + m[0].length, matchIndex: m.index })
    }
    // 对每个字符串字段，值结束于：下一个字段 matchIndex 之前的最后一个 "，或行尾
    for (let i = 0; i < matches.length; i++) {
      const { key, valueStart, matchIndex } = matches[i]
      let valueEnd
      if (i + 1 < matches.length) {
        const nextMatchIndex = matches[i + 1].matchIndex
        const segment = itemStr.slice(valueStart, nextMatchIndex)
        const lastQ = segment.lastIndexOf('"')
        valueEnd = lastQ >= 0 ? valueStart + lastQ : nextMatchIndex
      } else {
        const rest = itemStr.slice(valueStart)
        const lastQ = rest.lastIndexOf('"')
        valueEnd = lastQ >= 0 ? valueStart + lastQ : itemStr.length
      }
      let value = itemStr.slice(valueStart, valueEnd)
      // 反转义常见转义序列
      value = value
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\')
      item[key] = value
    }
    // 非字符串字段（数字、布尔）
    const nonStrPattern = /"(\w+)"\s*:\s*(true|false|\d+\.?\d*)/g
    while ((m = nonStrPattern.exec(itemStr)) !== null) {
      if (!(m[1] in item)) {
        item[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2])
      }
    }
    if (Object.keys(item).length > 0) items.push(item)
  }
  return items.length > 0 ? items : null
}

class TodoScheduler {
  /**
   * @param {object} globalDataStore - GlobalDataStore 实例（用于存储待办输出数据）
   */
  constructor(globalDataStore) {
    this.parentTodo = null // { items: [{id, action, description, _status}] }
    this.currentTodoIndex = 0
    this.failCount = 0 // 连续无进展计数
    this.scriptFailCount = 0 // 脚本失败计数
    this.totalCompleted = 0
    this.totalTodos = 0
    // 注入 GlobalDataStore 实例
    this.globalDataStore = globalDataStore
    this.cache = new Map()
    this._convergence70Fired = false
    this._convergence85Fired = false
  }

  // ============ 模板与校验 ============

  /**
   * 生成待办模板提示词
   * @param {string} userMessage - 用户需求
   * @param {string} pageContent - 当前页面内容（预留）
   * @param {object[]} searchResults - 匹配的脚本列表
   * @returns {string} 提示词文本
   */
  getTemplate(userMessage, pageContent, searchResults) {
    const scriptHint =
      searchResults && searchResults.length > 0
        ? `\n  可用脚本: ${searchResults
            .slice(0, 5)
            .map((s) => `inject_script_${s.id}(${s.name})`)
            .join(', ')}`
        : '\n  (暂无匹配脚本，可使用DOM工具或generate_script动态生成代码)'

    return `请根据用户需求创建待办列表。

=== 待办格式 ===
每个 item 必须包含:
- id: 唯一标识（如 "t1", "t2"）
- action: 工具名称，可用值：
  · extract_content / click_element / navigate_to / read_page_content（DOM工具）
  · inject_script_N（脚本库脚本，N为ID）
  · fetch_url（后台代理 fetch，突破 CORS 限制，获取跨域 HTML/JSON）
  · generate_script（动态代码执行，可 DOM 操作/数据处理等。返回 HTML 字符串可渲染为可视化报告。注意：受页面 CSP 限制，跨域 fetch 用 fetch_url）
  · render_report（用预设模板渲染数据报告，比 generate_script 写 HTML 更稳定。模板：news_card_list/data_table/timeline/product_grid）
  · finish_task（完成并输出结果，必须是最后一步）
- description: 简要描述此步骤做什么

=== 工作流程 ===
1. 了解页面结构（detect_page_template / get_interactive_elements）
2. 根据需要选择工具执行：extract_content 提取元素 / inject_script_N 调用脚本 / navigate_to 导航 / click_element 点击 / read_page_content 读取页面内容
3. 跨域 fetch 用 fetch_url；同源 fetch / DOM 操作 / 数据处理用 generate_script
4. 汇总结果（finish_task）

=== 正确示例 ===
[
  { id: "t1", action: "extract_content", description: "提取目标元素数据" },
  { id: "t2", action: "inject_script_9", description: "调用脚本处理数据" },
  { id: "t3", action: "generate_script", description: "整合多份数据并加工" },
  { id: "t4", action: "finish_task", description: "汇总输出结果" }
]

=== generate_script 代码执行示例 ===
[
  { id: "t1", action: "extract_content", description: "提取数据" },
  { id: "t2", action: "generate_script", description: "批量处理或代码执行（fetch/DOM操作等）" },
  { id: "t3", action: "finish_task", description: "输出结果" }
]${scriptHint}

=== 常见错误 ===
× action 写成中文名 → 应写为工具名称（如 extract_content, inject_script_N）
× 缺少 finish_task → 最后一步必须是 finish_task
× search_tools / get_interactive_elements 作为待办action → 这些是辅助工具，不推进进度

用户需求: ${userMessage}`
  }

  /**
   * 提交并校验待办列表
   * 支持 JSON 字符串或数组输入，JSON 解析失败时用正则容错恢复
   * 校验：id/action/description 必填、id 唯一、禁止辅助工具作为 action
   * @param {string|object[]} items - 待办列表
   * @returns {object} { ok, totalTodos?, error?, errors? }
   */
  submitTodo(items) {
    const errors = []

    // 字符串输入：尝试 JSON 解析，失败时容错恢复
    if (typeof items === 'string') {
      try {
        const parsed = JSON.parse(items.trim())
        if (Array.isArray(parsed)) items = parsed
        else return { ok: false, error: 'items 必须是数组类型' }
      } catch (e) {
        // 容错：AI 生成的 JSON 可能因 description 含未转义引号而解析失败
        const recovered = _recoverTodoItemsFromString(items)
        if (recovered && recovered.length > 0) {
          console.warn(
            '[TodoScheduler] JSON 解析失败，已通过容错恢复:',
            e.message,
            '恢复',
            recovered.length,
            '项'
          )
          items = recovered
        } else {
          return {
            ok: false,
            error: `items 解析失败: ${e.message}\n提示：description 中如有引号请用中文引号或转义`,
          }
        }
      }
    }

    if (!Array.isArray(items) || items.length === 0) {
      return { ok: false, error: 'items 必须是非空数组' }
    }

    const usedIds = new Set()
    // 辅助工具不能作为待办 action（它们不推进待办进度，会导致任务卡住）
    // 注意：generate_script 可作为数据整合类待办的 action，不应拦截
    // 注意：read_page_content 会产出并存储数据，在采集内页场景下是必要步骤，允许作为待办
    const AUXILIARY_ACTIONS = [
      'search_tools',
      'detect_page_template',
      'get_interactive_elements',
      'find_text_on_page',
    ]
    for (const item of items) {
      if (!item.id) errors.push('有待办缺少 id')
      if (!item.action) errors.push('有待办缺少 action')
      if (!item.description) errors.push('有待办缺少 description')
      if (item.id && usedIds.has(item.id)) errors.push(`id "${item.id}" 重复`)
      if (item.id) usedIds.add(item.id)
      if (item.action && AUXILIARY_ACTIONS.includes(item.action)) {
        errors.push(
          `待办 "${item.id}" 的 action "${item.action}" 是辅助工具，不能作为主待办。请用 extract_content / inject_script_N / click_element / navigate_to / generate_script / finish_task 等`
        )
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors }
    }

    // 校验通过，重置状态
    this.parentTodo = { items }
    this.totalTodos = items.length
    this.currentTodoIndex = 0
    this.totalCompleted = 0
    this.failCount = 0
    this.scriptFailCount = 0
    this.cache.clear()
    this.globalDataStore.clear()
    this._convergence70Fired = false
    this._convergence85Fired = false
    console.log(`[TodoScheduler] 待办列表已校验通过: ${items.length} 个待办`)

    return { ok: true, totalTodos: items.length }
  }

  // ============ 进度追踪 ============

  /**
   * 获取当前待办项
   * @returns {object|null}
   */
  getCurrentTodo() {
    if (!this.parentTodo) return null
    return this.parentTodo.items[this.currentTodoIndex] || null
  }

  /**
   * 标记当前待办结果
   * done 时将输出数据存入 globalDataStore 并推进 index
   * @param {string} status - 'done' | 'failed'
   * @param {*} outputData - 工具输出数据（done 时存储）
   */
  markTodoResult(status, outputData = null) {
    const todo = this.getCurrentTodo()
    if (!todo) return

    if (status === 'done') {
      todo._status = 'done'
      this.totalCompleted++
      // 存储输出数据（供 generate_script(data_refs=...) 注入到页面访问）
      if (outputData != null) {
        this.globalDataStore.set(todo.id, outputData)
      }
      this.currentTodoIndex++
    } else if (status === 'failed') {
      todo._status = 'failed'
      console.log(`[TodoScheduler] todo ${todo.id} failed (action: ${todo.action})`)
    }

    console.log(
      `[TodoScheduler] todo ${todo.id} ${status} | 进度: ${this.totalCompleted}/${this.totalTodos} | 失败${this.failCount}`
    )
  }

  /**
   * 记录有进展：重置连续失败计数
   */
  recordProgress() {
    this.failCount = 0
    // 连续脚本失败计数：仅当发生连续失败时累积，有进展即重置
    this.scriptFailCount = 0
  }

  /**
   * 记录无进展：累计失败计数
   * @param {string} funcName - 触发无进展的工具名
   */
  recordNoProgress(funcName) {
    this.failCount++
    if (funcName && funcName.startsWith('inject_script_')) {
      this.scriptFailCount++
    }
    console.log(
      `[TodoScheduler] 无进展: ${funcName} | 连续失败${this.failCount} 连续脚本失败${this.scriptFailCount}`
    )
  }

  /**
   * 获取进度信息
   * @returns {object} { total, completed, remaining, currentTodo, percentage }
   */
  getProgress() {
    const percentage =
      this.totalTodos > 0 ? Math.round((this.totalCompleted / this.totalTodos) * 100) : 0
    return {
      total: this.totalTodos,
      completed: this.totalCompleted,
      remaining: this.totalTodos - this.totalCompleted,
      currentTodo: this.getCurrentTodo(),
      percentage,
    }
  }

  /**
   * 工具调用与当前待办匹配
   * @param {string} funcName - 工具名
   * @returns {object|null} 匹配的待办项，不匹配返回 null
   */
  matchToolCall(funcName) {
    const todo = this.getCurrentTodo()
    if (!todo) return null

    // 精确匹配
    if (todo.action === funcName) return todo
    // inject_script_N 系列互相匹配
    if (todo.action && todo.action.startsWith('inject_script_') && funcName && funcName.startsWith('inject_script_')) {
      return todo
    }
    // search_tools 不匹配任何待办（它是辅助工具）
    if (funcName === 'search_tools') return null
    // finish_task 匹配当前待办（用于最后一步）
    if (funcName === 'finish_task') return todo

    // 宽松匹配：如果当前待办还没完成，任何其他成功工具调用都视为完成该待办
    // 这处理 AI 创建待办时 action 名与实际工具名不完全一致的情况
    if (todo._status !== 'done' && todo._status !== 'failed') {
      return todo
    }

    return null
  }

  // ============ 收敛提示 ============

  /**
   * 获取预算收敛提示（70%/85% 阈值各触发一次）
   * @param {number} currentRound - 当前轮次
   * @param {number} maxRounds - 最大轮次
   * @returns {string|null} 提示文本，无需提示返回 null
   */
  getConvergencePrompt(currentRound, maxRounds) {
    if (maxRounds <= 0) return null
    const ratio = currentRound / maxRounds
    const progress = this.getProgress()

    if (ratio >= HARD_RULES.CONVERGENCE_70 && !this._convergence70Fired) {
      this._convergence70Fired = true
      return `预算提醒：已使用 ${currentRound}/${maxRounds} 轮（${Math.round(
        ratio * 100
      )}%）。待办进度: ${progress.completed}/${progress.total}。剩余 ${
        maxRounds - currentRound
      } 轮，请加快推进核心待办。`
    }

    if (ratio >= HARD_RULES.CONVERGENCE_85 && !this._convergence85Fired) {
      this._convergence85Fired = true
      return `紧急收敛：已使用 ${currentRound}/${maxRounds} 轮（${Math.round(
        ratio * 100
      )}%）。待办进度: ${progress.completed}/${progress.total}。请立即完成剩余待办或调用 finish_task 汇总已有结果。`
    }

    return null
  }

  // ============ 硬性规则 ============

  /**
   * 检查是否应强制结束任务
   * @returns {object} { force, reason? }
   */
  shouldForceFinish() {
    if (this.failCount >= HARD_RULES.FAIL_THRESHOLD) {
      return { force: true, reason: `连续${this.failCount}次无进展` }
    }
    if (this.scriptFailCount >= HARD_RULES.SCRIPT_FAIL_THRESHOLD) {
      return { force: true, reason: `连续${this.scriptFailCount}次脚本失败` }
    }
    return { force: false }
  }

  /**
   * 是否全部完成
   */
  isAllDone() {
    return this.totalCompleted >= this.totalTodos && this.totalTodos > 0
  }

  /**
   * 生成进度上下文（注入到 AI 提示词）
   * @returns {string|null}
   */
  getProgressContext() {
    if (!this.parentTodo) return null

    const remaining = this.parentTodo.items.slice(this.currentTodoIndex)

    let context = `=== 待办进度: ${this.totalCompleted}/${this.totalTodos} (${this.getProgress().percentage}%) ===\n`

    if (remaining.length > 0) {
      const current = remaining[0]
      context += `当前待办: ${current.id} - ${current.description} (action: ${current.action})\n`
      context += `▶ 请调用 ${current.action} 完成此待办。\n`
    }

    // 全局存储数据摘要
    const dataSummary = this.globalDataStore.getSummary()
    if (dataSummary) {
      context += `\n=== 已收集数据 ===\n  ${dataSummary.split('\n').join('\n  ')}\n`
    }

    return context
  }

  /**
   * 设置缓存
   */
  setCache(key, value) {
    this.cache.set(key, value)
  }

  /**
   * 获取缓存
   */
  getCache(key) {
    return this.cache.get(key)
  }

  /**
   * 清空所有状态（任务结束时调用）
   */
  clear() {
    this.parentTodo = null
    this.currentTodoIndex = 0
    this.failCount = 0
    this.scriptFailCount = 0
    this.totalCompleted = 0
    this.totalTodos = 0
    this.globalDataStore.clear()
    this.cache.clear()
    this._convergence70Fired = false
    this._convergence85Fired = false
  }
}

module.exports = TodoScheduler
