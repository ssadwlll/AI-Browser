// ============ WorkingMemory（工作记忆层）============
// 三层记忆架构的工作记忆层：独立于对话流，AI 可主动读写
// 职责：
//   1. 记录关键发现、决策、排除方案（避免 AI 在长任务中重复操作或遗忘先验）
//   2. 完整继承，不做清空（解决 messages.length=0 导致的上下文失忆）
//   3. 自动生成结构化上下文注入，替代分散的 _injections 机制
//   4. 支持 AI 通过 update_memory / read_memory 工具主动更新
//
// 迁移自 chrome-extension/background/services/working-memory.js
// 改动：ES Module → CommonJS

class WorkingMemory {
  constructor() {
    this.sessionId = ''  // 绑定任务会话 ID
    this.state = this._emptyState()
  }

  /**
   * 空状态工厂
   * 各数组字段均带容量上限（FIFO 淘汰），避免长任务无限膨胀
   */
  _emptyState() {
    return {
      taskGoal: '',           // 任务目标（从 userMessage 提取，截 200 字符）
      currentPage: {          // 当前页面状态
        url: '',
        title: '',
        summary: '',          // 页面内容摘要（截 300 字符）
      },
      discoveries: [],        // 关键发现（最多 20 条）
      decisions: [],          // 已做决策（最多 15 条）
      excluded: [],           // 排除方案（最多 10 条）
      dataRefs: [],           // 数据引用 [{ key, storeId, count, summary }]（最多 15 条）
      pendingActions: [],     // 待执行操作（最多 10 条）
      errors: [],             // 错误记录 [{ tool, error, round }]（最多 10 条，error 截 100 字符）
    }
  }

  /**
   * 初始化新任务
   * @param {string} sessionId - 会话 ID
   * @param {string} userMessage - 用户原始消息（提取为任务目标）
   * @param {object|null} pageContent - 初始页面内容 { url, title, content }
   */
  init(sessionId, userMessage, pageContent = null) {
    this.sessionId = sessionId
    this.state = this._emptyState()
    this.state.taskGoal = String(userMessage || '').slice(0, 200)
    if (pageContent) {
      this.state.currentPage = {
        url: pageContent.url || '',
        title: pageContent.title || '',
        summary: String(pageContent.content || '').slice(0, 300),
      }
    }
  }

  /**
   * 更新页面状态（navigate_to / go_back / go_forward 等导航操作后调用）
   */
  updatePage(url, title, summary = '') {
    if (!this.state) return
    this.state.currentPage = {
      url: String(url || ''),
      title: String(title || ''),
      summary: String(summary || '').slice(0, 300),
    }
  }

  /**
   * 记录关键发现（includes 去重，FIFO 淘汰）
   */
  addDiscovery(text) {
    if (!text || this.state.discoveries.includes(text)) return
    this.state.discoveries.push(text)
    if (this.state.discoveries.length > 20) this.state.discoveries.shift()
  }

  /**
   * 记录决策（includes 去重，FIFO 淘汰）
   */
  addDecision(text) {
    if (!text || this.state.decisions.includes(text)) return
    this.state.decisions.push(text)
    if (this.state.decisions.length > 15) this.state.decisions.shift()
  }

  /**
   * 记录排除方案（includes 去重，FIFO 淘汰）
   */
  addExcluded(text) {
    if (!text || this.state.excluded.includes(text)) return
    this.state.excluded.push(text)
    if (this.state.excluded.length > 10) this.state.excluded.shift()
  }

  /**
   * 记录数据引用（同 key 更新，不同 key 新增）
   */
  addDataRef(key, storeId, count, summary) {
    const existing = this.state.dataRefs.findIndex(d => d.key === key)
    const entry = { key, storeId, count, summary: String(summary || '').slice(0, 80) }
    if (existing >= 0) {
      this.state.dataRefs[existing] = entry
    } else {
      this.state.dataRefs.push(entry)
    }
    if (this.state.dataRefs.length > 15) this.state.dataRefs.shift()
  }

  /**
   * 记录错误
   */
  addError(tool, error, round) {
    if (!this.state) return
    // error 可能是 Error 对象或非字符串，统一转为字符串再截断
    const errorMsg = String(error?.message || error || '').slice(0, 100)
    this.state.errors.push({ tool, error: errorMsg, round })
    if (this.state.errors.length > 10) this.state.errors.shift()
  }

  /**
   * AI 通过 update_memory 工具更新（结构化字段）
   */
  applyUpdate(update) {
    if (!update) return
    if (update.discovery) this.addDiscovery(update.discovery)
    if (update.decision) this.addDecision(update.decision)
    if (update.excluded) this.addExcluded(update.excluded)
    if (update.pendingAction) {
      this.state.pendingActions.push(update.pendingAction)
      if (this.state.pendingActions.length > 10) this.state.pendingActions.shift()
    }
  }

  /**
   * 生成结构化上下文注入（替代 _injections 中的多处拼接）
   * 返回可直接作为 system 消息内容的文本
   * @param {object} options - { includeErrors, includePage, maxLen }
   */
  toContext(options = {}) {
    if (!this.state) return ''
    const { includeErrors = true, includePage = true, maxLen = 2000 } = options
    const parts = []

    // 任务目标
    if (this.state.taskGoal) {
      parts.push(`任务目标: ${this.state.taskGoal.slice(0, 200)}`)
    }

    // 当前页面
    if (includePage && this.state.currentPage.url) {
      const pg = this.state.currentPage
      parts.push(`当前页面: ${pg.title || '无标题'} | ${pg.url}`)
      if (pg.summary) parts.push(`页面摘要: ${pg.summary}`)
    }

    // 关键发现
    if (this.state.discoveries.length > 0) {
      parts.push(`关键发现:\n${this.state.discoveries.map(d => `  - ${d}`).join('\n')}`)
    }

    // 已做决策
    if (this.state.decisions.length > 0) {
      parts.push(`已做决策:\n${this.state.decisions.map(d => `  - ${d}`).join('\n')}`)
    }

    // 排除方案
    if (this.state.excluded.length > 0) {
      parts.push(`已排除: ${this.state.excluded.join('; ')}`)
    }

    // 数据引用
    if (this.state.dataRefs.length > 0) {
      parts.push(`已收集数据:\n${this.state.dataRefs.map(d => `  - ${d.key}: ${d.count}条 (${d.summary}) [ID:${d.storeId}]`).join('\n')}`)
    }

    // 错误记录（仅展示最近 5 条）
    if (includeErrors && this.state.errors.length > 0) {
      const recentErrors = this.state.errors.slice(-5)
      parts.push(`近期错误:\n${recentErrors.map(e => `  - 轮次${e.round} ${e.tool}: ${e.error}`).join('\n')}`)
    }

    let result = parts.join('\n\n')
    if (result.length > maxLen) {
      result = result.slice(0, maxLen) + '\n...(工作记忆已截断)'
    }
    return result
  }

  /**
   * 从工具调用结果自动提取关键信息到工作记忆
   * 在 agent-loop 的工具执行后调用，提取规则：
   *   - 导航类工具(navigate_to/go_back/go_forward) → 记录决策
   *   - extract_content 成功 → 记录发现（含数据条数/是否有链接/选择器）
   *   - 工具失败 → 记录排除 + 错误
   *   - inject_script_* → 记录脚本返回数据量
   *   - read_page_content → 更新页面信息
   *   - create_todo → 记录决策
   *   - search_tools → 记录发现
   */
  autoExtractFromToolResult(funcName, funcArgs, toolResult, round) {
    try {
      const parsed = typeof toolResult === 'string' ? JSON.parse(toolResult) : toolResult
      if (!parsed) return

      // 导航类工具 → 记录决策（页面状态由后续 read_page_content 更新）
      if (['navigate_to', 'go_back', 'go_forward'].includes(funcName) && parsed.ok) {
        this.addDecision(`导航到: ${funcArgs.url || '上一页/下一页'} (轮次${round})`)
      }

      // extract_content 成功 → 记录数据发现
      if (funcName === 'extract_content' && parsed.ok && Array.isArray(parsed.result)) {
        const count = parsed.result.length
        const hasLinks = parsed.result.some(item => item?.attrs?.href)
        this.addDiscovery(`extract_content 获取${count}条数据${hasLinks ? '（含链接）' : ''}，选择器: ${funcArgs.selector || '未知'}`)
      }

      // 工具失败 → 记录排除/错误
      if (parsed.ok === false && parsed.error) {
        if (funcName === 'extract_content' || funcName === 'get_element_info') {
          this.addExcluded(`${funcArgs.selector || '未知选择器'}: ${String(parsed.error).slice(0, 60)}`)
        }
        this.addError(funcName, parsed.error, round)
      }

      // inject_script 成功 → 记录关键结果
      if (funcName.startsWith('inject_script_') && parsed.ok) {
        const innerResult = parsed.result
        if (typeof innerResult === 'object' && innerResult !== null) {
          if (Array.isArray(innerResult.data)) {
            this.addDiscovery(`脚本${funcName}返回${innerResult.data.length}条数据`)
          } else if (typeof innerResult.total === 'number') {
            this.addDiscovery(`脚本${funcName}处理${innerResult.total}条记录`)
          }
        }
      }

      // inject_script 失败 → 记录错误
      if (funcName.startsWith('inject_script_') && parsed.ok === false) {
        this.addError(funcName, parsed.error || '脚本执行失败', round)
      }

      // read_page_content → 更新页面信息
      if (funcName === 'read_page_content' && parsed.ok) {
        this.updatePage(parsed.url || '', parsed.title || '', parsed.content || '')
      }

      // create_todo 成功 → 记录决策
      if (funcName === 'create_todo' && parsed.ok) {
        this.addDecision(`已创建待办列表: ${parsed.result || '待办已就绪'}`)
      }

      // search_tools → 记录发现
      if (funcName === 'search_tools' && Array.isArray(parsed)) {
        this.addDiscovery(`搜索到${parsed.length}个可用脚本`)
      }

    } catch (e) {
      // 自动提取失败不影响主流程
    }
  }

  /**
   * 清空（任务结束时调用）
   */
  clear() {
    this.sessionId = ''
    this.state = this._emptyState()
  }

  /**
   * 序列化（用于快照）
   */
  toJSON() {
    return { sessionId: this.sessionId, state: this.state }
  }

  /**
   * 反序列化（用于恢复，与 _emptyState 合并以兼容字段增减）
   */
  fromJSON(data) {
    if (data?.state) {
      this.sessionId = data.sessionId || ''
      this.state = { ...this._emptyState(), ...data.state }
    }
  }
}

module.exports = WorkingMemory
