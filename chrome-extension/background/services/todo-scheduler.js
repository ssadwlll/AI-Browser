// ============ TodoScheduler ============
// 分阶段AI待办调度引擎
// 职责：
//   1. 提供三阶段父待办模板，AI填充后系统校验合规与数据依赖
//   2. 客观统计整体待办进度，到达阈值自动下发收敛提示
//   3. 内置全部硬性规则：4轮无进展切阶段、3次脚本失败终止、Stage1屏蔽inject
//   4. 阶段切换时清空阶段临时缓存，保留全局持久存储

import { GlobalDataStore } from './global-data-store.js'

// ===== 阶段定义 =====
export const STAGE = {
  DOM: 1,       // 本地DOM工具
  SCRIPT: 2,    // 远程脚本
  SUMMARY: 3,   // 数据汇总输出
}

// ===== 硬性规则常量 =====
const HARD_RULES = {
  STAGE1_FAIL_THRESHOLD: 4,   // 阶段1连续4次无进展 → 切阶段2
  STAGE2_FAIL_THRESHOLD: 3,   // 阶段2连续3次脚本失败 → 阶段3
  CONVERGENCE_70: 0.7,        // 70%预算 → 软收敛
  CONVERGENCE_85: 0.85,       // 85%预算 → 紧急收敛
}

// ===== Stage1 允许的DOM工具白名单 =====
const STAGE1_TOOLS = new Set([
  'read_page_content', 'extract_content', 'click_element', 'fill_input',
  'wait_for_element', 'navigate_to', 'go_back', 'go_forward',
  'find_text_on_page', 'get_element_info', 'get_interactive_elements',
  'scroll_page', 'hover_element', 'select_dropdown', 'press_key',
  'screenshot_visible', 'recall_data', 'search_tools', 'create_todo',
  'finish_task',
])

// ===== Stage2 允许的工具白名单 =====
const STAGE2_TOOLS = new Set([
  'search_tools', 'inject_script_', 'recall_data', 'read_page_content',
  'finish_task',  // 前缀匹配 inject_script_
])

// ===== Stage3 允许的工具白名单 =====
const STAGE3_TOOLS = new Set([
  'recall_data', 'finish_task',
])

export class TodoScheduler {
  constructor() {
    this.parentTodo = null           // { stages: [{ stage, name, subTodos: [...] }] }
    this.currentStage = STAGE.DOM
    this.currentTodoIndex = 0        // 当前阶段内的 todo 索引
    this.stageFailCount = 0          // 当前阶段连续无进展计数
    this.stage2ScriptFailCount = 0   // 阶段2脚本失败计数
    this.totalCompleted = 0          // 全部已完成待办数
    this.totalTodos = 0              // 全部待办数
    this.globalDataStore = new GlobalDataStore()  // 跨阶段持久存储
    this.stageCache = new Map()      // 阶段临时缓存（切换阶段时清空）
    this._convergence70Fired = false
    this._convergence85Fired = false
  }

  // ============ 模板与校验 ============

  /**
   * 获取父待办模板（发给AI填充）
   */
  getTemplate(userMessage, pageContent, searchResults) {
    const scriptHint = searchResults?.length > 0
      ? `\n  可用脚本: ${searchResults.slice(0, 5).map(s => `inject_script_${s.id}(${s.name})`).join(', ')}`
      : '\n  (暂无匹配脚本，Stage2可为空数组)'

    return `请根据用户需求创建分阶段待办列表。

=== 三阶段说明 ===
Stage 1（页面探索）：用DOM工具在页面上操作（提取信息、点击、导航等）
Stage 2（脚本处理）：用服务端脚本批量处理数据。脚本调用格式为 inject_script_N，其中 N 是脚本ID数字
Stage 3（结果汇总）：输出最终结果

=== 待办格式 ===
每个 subTodo 必须包含:
- id: 唯一标识（如 "s1-1", "s2-1"）
- action: 工具名称。Stage1用DOM工具名；Stage2用 inject_script_N（N为脚本ID）；Stage3用 finish_task
- description: 简要描述此步骤做什么
- dataDependKeys: 依赖的数据key列表（引用之前待办的 dataOutputKey，无依赖为 []）
- dataOutputKey: 输出数据的语义key（供后续待办引用，无输出设为 null）

=== 正确示例 ===
Stage 1:
  { id: "s1-1", action: "read_page_content", description: "读取页面内容", dataDependKeys: [], dataOutputKey: "page_data" }
  { id: "s1-2", action: "extract_content", description: "提取条目列表", dataDependKeys: [], dataOutputKey: "item_list" }
Stage 2:
  { id: "s2-1", action: "inject_script_10", description: "批量处理详情页", dataDependKeys: ["item_list"], dataOutputKey: "detail_data" }${scriptHint}
Stage 3:
  { id: "s3-1", action: "finish_task", description: "汇总所有数据", dataDependKeys: ["item_list", "detail_data"], dataOutputKey: null }

=== 常见错误 ===
❌ Stage2 action 写成脚本中文名（如 "批量采集页面"）→ 应写为 inject_script_N 格式
❌ Stage2 action 写成 DOM 工具名（如 "navigate_to"）→ Stage2 只能用 inject_script_* 或 search_tools
❌ dataDependKeys 引用了不存在的 key → 必须引用之前待办的 dataOutputKey

用户需求: ${userMessage}`
  }

  /**
   * AI提交待办列表，系统校验合规与数据依赖
   */
  submitTodo(stages) {
    const errors = []

    // 容错：LLM 有时会将 stages 序列化为 JSON 字符串而非数组
    if (typeof stages === 'string') {
      try {
        const trimmed = stages.trim()
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) {
          stages = parsed
        } else {
          return { ok: false, error: 'stages 必须是数组类型，你传入了一个非数组的JSON。请直接传入数组而非字符串，例如: {"stages": [{"stage": 1, "subTodos": [...]}]}' }
        }
      } catch (e) {
        return { ok: false, error: `stages 解析失败：传入的是字符串而非数组。请直接传入JSON数组，不要用字符串包裹。错误: ${e.message}` }
      }
    }

    if (!Array.isArray(stages) || stages.length === 0) {
      return { ok: false, error: 'stages 必须是非空数组（type: array），你传入了 ' + typeof stages + ' 类型。请确保 stages 的值是 JSON 数组 [...] 而非字符串 "[...]"' }
    }

    // 收集所有 dataOutputKey（用于依赖校验）
    const availableKeys = new Set()
    let totalTodos = 0

    for (const stage of stages) {
      if (![1, 2, 3].includes(stage.stage)) {
        errors.push(`非法阶段编号: ${stage.stage}（应为1/2/3）`)
        continue
      }
      if (!Array.isArray(stage.subTodos)) {
        errors.push(`Stage ${stage.stage} 的 subTodos 不是数组`)
        continue
      }

      for (const todo of stage.subTodos) {
        totalTodos++
        // 必填字段检查
        if (!todo.id) errors.push(`Stage ${stage.stage} 有待办缺少 id`)
        if (!todo.action) errors.push(`Stage ${stage.stage} 有待办缺少 action`)
        if (!todo.description) errors.push(`Stage ${stage.stage} 有待办缺少 description`)

        // 阶段工具合规校验
        if (todo.action) {
          if (stage.stage === 1) {
            if (todo.action.startsWith('inject_script_')) {
              errors.push(`Stage 1 禁止使用 ${todo.action}。脚本属于Stage2，请将该待办移到Stage2。正确示例: Stage2 action="inject_script_N"（N为search_tools查到的脚本ID）`)
            } else if (!STAGE1_TOOLS.has(todo.action)) {
              errors.push(`Stage 1 不允许使用 ${todo.action}。Stage1只能用DOM工具（如 read_page_content, extract_content, navigate_to 等）`)
            }
          }
          if (stage.stage === 2) {
            const isAllowed = STAGE2_TOOLS.has(todo.action) ||
              todo.action.startsWith('inject_script_')
            if (!isAllowed) {
              errors.push(`Stage 2 不允许使用 ${todo.action}。Stage2只能用 inject_script_N（N为search_tools查到的脚本ID）或 search_tools。不要用中文名或DOM工具。`)
            }
          }
          if (stage.stage === 3 && !STAGE3_TOOLS.has(todo.action)) {
            errors.push(`Stage 3 不允许使用 ${todo.action}。Stage3只能用 recall_data 或 finish_task`)
          }
        }

        // 数据依赖校验：dataDependKeys 引用的 key 必须在之前待办的 dataOutputKey 中存在
        if (Array.isArray(todo.dataDependKeys)) {
          for (const depKey of todo.dataDependKeys) {
            if (!availableKeys.has(depKey)) {
              errors.push(`待办 ${todo.id} 的 dataDependKeys 引用了不存在的 key: "${depKey}"。dataDependKeys 必须引用之前待办的 dataOutputKey。当前可用的 key: ${[...availableKeys].join(', ') || '（无）'}`)
            }
          }
        }

        // 注册 dataOutputKey
        if (todo.dataOutputKey) {
          if (availableKeys.has(todo.dataOutputKey)) {
            errors.push(`待办 ${todo.id} 的 dataOutputKey "${todo.dataOutputKey}" 与之前待办重复，必须唯一`)
          }
          availableKeys.add(todo.dataOutputKey)
        }
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors }
    }

    // 校验通过，存储
    this.parentTodo = { stages }
    this.totalTodos = totalTodos
    this.currentStage = STAGE.DOM
    this.currentTodoIndex = 0
    this.totalCompleted = 0
    this.stageFailCount = 0
    this.stage2ScriptFailCount = 0
    this.stageCache.clear()
    this.globalDataStore.clear()
    // 重置收敛提示标志：避免新任务复用旧任务的已触发状态
    this._convergence70Fired = false
    this._convergence85Fired = false
    console.log(`[TodoScheduler] 待办列表已校验通过: ${totalTodos} 个待办, ${availableKeys.size} 个数据key`)

    return { ok: true, totalTodos }
  }

  // ============ 进度追踪 ============

  /**
   * 获取当前待执行的待办
   */
  getCurrentTodo() {
    if (!this.parentTodo) return null
    const stageData = this.parentTodo.stages.find(s => s.stage === this.currentStage)
    if (!stageData) return null
    return stageData.subTodos[this.currentTodoIndex] || null
  }

  /**
   * 标记当前待办完成/失败，记录输出数据
   */
  markTodoResult(status, outputData = null) {
    const todo = this.getCurrentTodo()
    if (!todo) return

    if (status === 'done') {
      // 设置待办状态标记（用于UI渲染）
      todo._status = 'done'
      this.totalCompleted++
      // 失败计数由 recordProgress() 统一管理，此处不重复

      // 存储输出数据到全局存储（null 和 undefined 都跳过）
      if (todo.dataOutputKey && outputData != null) {
        this.globalDataStore.set(todo.dataOutputKey, outputData, todo.id)
      }

      // 推进到下一个待办
      this.currentTodoIndex++

      // 检查当前阶段是否完成
      const stageData = this.parentTodo.stages.find(s => s.stage === this.currentStage)
      if (stageData && this.currentTodoIndex >= stageData.subTodos.length) {
        // 当前阶段所有待办完成
        if (this.currentStage < STAGE.SUMMARY) {
          this._switchToNextStage()
        }
      }
    } else if (status === 'failed') {
      todo._status = 'failed'
      // 失败计数由 recordNoProgress() 统一管理，此处仅记录日志
      console.log(`[TodoScheduler] todo ${todo.id} failed (action: ${todo.action})`)
    }

    console.log(`[TodoScheduler] todo ${todo.id} ${status} | 进度: ${this.totalCompleted}/${this.totalTodos} | 阶段${this.currentStage} 失败${this.stageFailCount}`)
  }

  /**
   * 记录有进展（由引擎在每次工具调用有进展时调用）
   * 重置连续失败计数，但不清零阶段2脚本失败累计
   */
  recordProgress() {
    this.stageFailCount = 0
  }

  /**
   * 记录无进展（由引擎在每次工具调用无进展时调用）
   * 统一管理所有失败计数，包括未匹配待办的工具调用
   */
  recordNoProgress(funcName) {
    this.stageFailCount++
    // 阶段2：脚本执行失败单独累计（不随 stageFailCount 重置）
    // 仅用 startsWith('inject_script_') 精确匹配，避免 includes 匹配过宽
    if (this.currentStage === STAGE.SCRIPT && funcName &&
        funcName.startsWith('inject_script_')) {
      this.stage2ScriptFailCount++
    }
    console.log(`[TodoScheduler] 无进展: ${funcName} | 阶段${this.currentStage} 连续失败${this.stageFailCount} 脚本失败${this.stage2ScriptFailCount}`)
  }

  /**
   * 获取进度概要
   */
  getProgress() {
    const percentage = this.totalTodos > 0
      ? Math.round((this.totalCompleted / this.totalTodos) * 100)
      : 0
    return {
      total: this.totalTodos,
      completed: this.totalCompleted,
      remaining: this.totalTodos - this.totalCompleted,
      currentStage: this.currentStage,
      currentTodo: this.getCurrentTodo(),
      percentage,
    }
  }

  /**
   * 匹配工具调用到当前待办（宽松匹配：工具名匹配action）
   */
  matchToolCall(funcName) {
    const todo = this.getCurrentTodo()
    if (!todo) return null

    // 精确匹配
    if (todo.action === funcName) return todo

    // inject_script_ 前缀匹配
    if (todo.action?.startsWith('inject_script_') && funcName?.startsWith('inject_script_')) return todo

    // search_tools / recall_data 是辅助工具，不应匹配到业务待办
    // 它们可以自由调用，但不影响待办进度
    if (funcName === 'search_tools' || funcName === 'recall_data') return null

    // finish_task 可以在任何阶段被调用
    if (funcName === 'finish_task') return todo

    // 不匹配当前待办，但不报错（AI可能需要辅助操作）
    return null
  }

  // ============ 收敛提示（系统驱动，非AI自主判断） ============

  /**
   * 根据预算使用率生成收敛提示
   */
  getConvergencePrompt(currentRound, maxRounds) {
    if (maxRounds <= 0) return null
    const ratio = currentRound / maxRounds
    const progress = this.getProgress()

    // 70% 软收敛
    if (ratio >= HARD_RULES.CONVERGENCE_70 && !this._convergence70Fired) {
      this._convergence70Fired = true
      return `⏱️ 预算提醒：已使用 ${currentRound}/${maxRounds} 轮（${Math.round(ratio * 100)}%）。待办进度: ${progress.completed}/${progress.total}。剩余 ${maxRounds - currentRound} 轮，请加快推进核心待办。`
    }

    // 85% 紧急收敛
    if (ratio >= HARD_RULES.CONVERGENCE_85 && !this._convergence85Fired) {
      this._convergence85Fired = true
      return `⚠️ 紧急收敛：已使用 ${currentRound}/${maxRounds} 轮（${Math.round(ratio * 100)}%）。待办进度: ${progress.completed}/${progress.total}。请立即完成剩余待办或调用 finish_task 汇总已有结果。`
    }

    return null
  }

  // ============ 硬性规则 ============

  /**
   * 硬性规则：是否应该切换阶段
   * Stage1: 连续4次无进展 → Stage2
   * Stage2: 连续3次脚本失败 → Stage3
   */
  shouldSwitchStage() {
    if (this.currentStage === STAGE.DOM && this.stageFailCount >= HARD_RULES.STAGE1_FAIL_THRESHOLD) {
      return { switch: true, from: STAGE.DOM, to: STAGE.SCRIPT, reason: `Stage1连续${this.stageFailCount}次无进展` }
    }
    if (this.currentStage === STAGE.SCRIPT && this.stage2ScriptFailCount >= HARD_RULES.STAGE2_FAIL_THRESHOLD) {
      return { switch: true, from: STAGE.SCRIPT, to: STAGE.SUMMARY, reason: `Stage2连续${this.stage2ScriptFailCount}次脚本失败` }
    }
    return { switch: false }
  }

  /**
   * 执行阶段切换
   */
  _switchToNextStage() {
    const nextStage = this.currentStage + 1
    if (nextStage > STAGE.SUMMARY) return

    this.currentStage = nextStage
    this.currentTodoIndex = 0
    this.stageFailCount = 0
    this.stage2ScriptFailCount = 0
    // 清空阶段临时缓存
    this.stageCache.clear()
    console.log(`[TodoScheduler] 阶段切换 → Stage ${this.currentStage}`)
  }

  /**
   * 强制切换到指定阶段（用于硬性规则触发）
   */
  forceSwitchToStage(stage) {
    // 边界校验：仅允许 1/2/3
    if (![1, 2, 3].includes(stage)) {
      console.warn(`[TodoScheduler] forceSwitchToStage 非法阶段: ${stage}，忽略`)
      return
    }
    this.currentStage = stage
    this.currentTodoIndex = 0
    this.stageFailCount = 0
    this.stage2ScriptFailCount = 0
    this.stageCache.clear()
    console.log(`[TodoScheduler] 强制切换 → Stage ${this.currentStage}`)
  }

  /**
   * 是否所有待办都已完成
   */
  isAllDone() {
    return this.totalCompleted >= this.totalTodos && this.totalTodos > 0
  }

  /**
   * 获取阶段上下文（用于注入AI消息）
   */
  getStageContext() {
    const stageData = this.parentTodo?.stages.find(s => s.stage === this.currentStage)
    if (!stageData) return null

    const remaining = stageData.subTodos.slice(this.currentTodoIndex)

    let context = `=== 当前阶段: Stage ${this.currentStage} (${stageData.name || '未命名阶段'}) ===\n`
    context += `待办进度: ${this.totalCompleted}/${this.totalTodos} (${this.getProgress().percentage}%)\n`

    if (remaining.length > 0) {
      const current = remaining[0]
      context += `当前待办: ${current.id} - ${current.description} (action: ${current.action})\n`
      // 强制引导 LLM 执行当前待办的 action
      context += `▶ 请调用 ${current.action} 完成此待办。不要调用其他工具。\n`
      if (current.dataDependKeys?.length > 0) {
        const satisfied = current.dataDependKeys.every(k => this.globalDataStore.has(k))
        context += `数据依赖: ${current.dataDependKeys.join(', ')} ${satisfied ? '✓已满足' : '✗未满足'}\n`
        // 自动注入依赖的数据内容，避免AI主动recall_data浪费轮次
        if (satisfied) {
          const depDataParts = []
          for (const depKey of current.dataDependKeys) {
            const value = this.globalDataStore.get(depKey)
            const summary = this.globalDataStore.getSummary(depKey)
            if (value !== null) {
              // 紧凑格式化：限制每条数据最大2000字符
              let dataStr = typeof value === 'string' ? value : JSON.stringify(value)
              if (dataStr.length > 2000) {
                // 大数据：保留摘要+样本前5条+总数
                try {
                  const obj = typeof value === 'string' ? JSON.parse(value) : value
                  if (Array.isArray(obj)) {
                    dataStr = JSON.stringify({ total: obj.length, items: obj.slice(0, 5), _note: `共${obj.length}条，以下为前5条样本` })
                  } else {
                    dataStr = dataStr.slice(0, 2000) + `\n...(共${dataStr.length}字符，已截断)`
                  }
                } catch {
                  dataStr = dataStr.slice(0, 2000) + `\n...(共${dataStr.length}字符，已截断)`
                }
              }
              depDataParts.push(`[${depKey}]: ${dataStr}`)
            }
          }
          if (depDataParts.length > 0) {
            context += `\n=== 依赖数据（直接使用，无需recall_data） ===\n${depDataParts.join('\n')}\n`
          }
        }
      }
    }

    // 全局存储数据仅在 Stage 3 注入（Stage 1/2 由 WorkingMemory/交接摘要提供）
    // 这样避免每轮重复注入相同的数据摘要
    if (this.currentStage === 3) {
      const dataSummaries = this.globalDataStore.getAllSummaries()
      if (dataSummaries.length > 0) {
        context += `\n=== 全局存储数据 ===\n  ${dataSummaries.join('\n  ')}\n`
      }
    }

    return context
  }

  /**
   * 阶段临时缓存操作
   */
  setCache(key, value) {
    this.stageCache.set(key, value)
  }

  getCache(key) {
    return this.stageCache.get(key)
  }

  /**
   * 清空所有状态（任务结束时调用）
   */
  clear() {
    this.parentTodo = null
    this.currentStage = STAGE.DOM
    this.currentTodoIndex = 0
    this.stageFailCount = 0
    this.stage2ScriptFailCount = 0
    this.totalCompleted = 0
    this.totalTodos = 0
    this.globalDataStore.clear()
    this.stageCache.clear()
    this._convergence70Fired = false
    this._convergence85Fired = false
  }
}
