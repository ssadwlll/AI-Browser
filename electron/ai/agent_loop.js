/**
 * 智能体循环 (Agent Loop)
 * 核心流程: 用户任务 → AI分析页面 → 生成JS执行 → 结果反馈AI → 循环直到完成
 *
 * 每轮循环:
 * 1. 收集当前页面上下文
 * 2. 将上下文+任务+历史结果发送给AI
 * 3. AI返回分析+JS代码(或完成标记)
 * 4. 提取并执行JS代码
 * 5. 将执行结果加入下一轮对话
 * 6. 判断任务是否完成
 */

class AgentLoop {
  constructor() {
    this.running = false
    this.abortFlag = false
    this.messages = []       // 完整对话上下文
    this.maxRounds = 15      // 最大循环轮次
    this.maxMessages = 30    // 上下文消息上限
    this.history = []        // 执行历史记录
    this.maxHistory = 50
    this.currentRound = 0
    this.taskDescription = ''
    this.onProgress = null   // 进度回调 (round, phase, data)
  }

  /**
   * 启动智能体循环
   * @param {object} browserView - Electron BrowserView
   * @param {string} task - 用户任务描述
   * @param {object} llmProvider - LLM提供者实例
   * @param {object} actionExecutor - ActionExecutor实例
   * @param {function} sendEvent - 向渲染进程发送事件
   */
  async run(browserView, task, llmProvider, actionExecutor, sendEvent) {
    if (this.running) {
      throw new Error('智能体正在运行中')
    }
    if (!browserView) {
      throw new Error('没有打开的页面，请先导航到一个网页')
    }

    this.running = true
    this.abortFlag = false
    this.currentRound = 0
    this.taskDescription = task
    this.messages = []

    try {
      // 初始系统提示
      const systemPrompt = this._buildSystemPrompt()

      // 收集初始页面上下文
      const pageContext = await actionExecutor.collectPageContext(browserView)
      if (!pageContext) {
        throw new Error('无法获取页面上下文')
      }

      this.messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: this._buildInitialUserMessage(task, pageContext) },
      ]

      // 发送开始事件
      sendEvent('agent:start', { task, maxRounds: this.maxRounds })

      // 主循环
      while (this.currentRound < this.maxRounds && !this.abortFlag) {
        this.currentRound++

        // 阶段1: 调用AI分析
        sendEvent('agent:round', {
          round: this.currentRound,
          phase: 'thinking',
          message: `第 ${this.currentRound} 轮: AI正在分析...`,
        })

        let aiReply = ''
        try {
          // 使用流式输出，逐块发送给前端
          const stream = await llmProvider.chatStream(this.messages)
          let fullReply = ''
          for await (const chunk of stream) {
            fullReply += chunk
            sendEvent('agent:stream', { round: this.currentRound, chunk })
          }
          aiReply = fullReply
        } catch (e) {
          // 流式失败，尝试非流式
          try {
            aiReply = await llmProvider.chat(this.messages)
          } catch (e2) {
            throw new Error(`AI调用失败: ${e2.message}`)
          }
        }

        // 将AI回复加入上下文
        this.messages.push({ role: 'assistant', content: aiReply })

        // 阶段2: 检查任务是否完成
        const taskStatus = this._checkTaskStatus(aiReply)
        if (taskStatus.completed) {
          // 任务完成
          this._addHistory(this.currentRound, 'completed', aiReply, null, taskStatus.summary)
          sendEvent('agent:round', {
            round: this.currentRound,
            phase: 'completed',
            message: taskStatus.summary || '任务已完成',
            reply: aiReply,
          })
          sendEvent('agent:done', {
            success: true,
            rounds: this.currentRound,
            summary: taskStatus.summary || '任务已完成',
            finalReply: aiReply,
          })
          return { success: true, rounds: this.currentRound, summary: taskStatus.summary }
        }

        // 阶段3: 提取JS代码
        const jsCode = actionExecutor.extractJsCode(aiReply)

        if (!jsCode) {
          // AI没有返回代码，可能是纯分析回复，将结果反馈继续循环
          this._addHistory(this.currentRound, 'no_code', aiReply, null, 'AI未返回可执行代码')
          sendEvent('agent:round', {
            round: this.currentRound,
            phase: 'no_code',
            message: 'AI未返回可执行代码，继续分析...',
            reply: aiReply,
          })

          // 追加用户消息，引导AI继续
          this.messages.push({
            role: 'user',
            content: '你没有返回可执行的JavaScript代码。请根据当前任务需求，生成JavaScript代码来操作页面。如果任务已经完成，请回复 [TASK_COMPLETE]。',
          })
          this._trimMessages()
          continue
        }

        // 阶段4: 执行JS代码
        sendEvent('agent:round', {
          round: this.currentRound,
          phase: 'executing',
          message: `第 ${this.currentRound} 轮: 正在执行代码...`,
          jsCode,
        })

        const result = await actionExecutor.executeInPage(browserView, jsCode)

        // 阶段5: 记录结果并反馈给AI
        const resultStr = JSON.stringify(result, null, 2)
        this._addHistory(this.currentRound, result.success ? 'success' : 'error', aiReply, jsCode, resultStr)

        sendEvent('agent:round', {
          round: this.currentRound,
          phase: result.success ? 'executed' : 'error',
          message: result.success
            ? result.navigated
              ? `第 ${this.currentRound} 轮: 代码执行成功，页面已导航到 ${result.newUrl || '新页面'}`
              : `第 ${this.currentRound} 轮: 代码执行成功`
            : `第 ${this.currentRound} 轮: 代码执行失败 - ${result.error || result.message}`,
          jsCode,
          result,
        })

        // 如果发生了导航，等待新页面加载并重新收集完整上下文
        let contextUpdate = ''
        if (result.navigated) {
          await actionExecutor.waitForPageLoad(browserView)
          const newPageContext = await actionExecutor.collectPageContext(browserView)
          if (newPageContext) {
            contextUpdate = `\n\n⚠️ 页面发生了导航！新页面信息：\nURL: ${newPageContext.url}\n页面标题: ${newPageContext.title}\n\n新页面DOM结构摘要：\n${JSON.stringify(newPageContext.domSummary || [], null, 2)}`
          } else {
            contextUpdate = `\n\n⚠️ 页面发生了导航！新URL: ${result.newUrl || '未知'}`
          }
        } else {
          // 没有导航，只更新URL和标题
          const newPageContext = await actionExecutor.collectPageContext(browserView)
          contextUpdate = newPageContext
            ? `\n\n当前页面URL: ${newPageContext.url}\n页面标题: ${newPageContext.title}`
            : ''
        }

        // 将执行结果反馈给AI，让AI决定下一步
        this.messages.push({
          role: 'user',
          content: `代码执行结果:\n${resultStr}${contextUpdate}\n\n请根据执行结果判断任务进度。如果页面发生了导航，请基于新页面的DOM结构继续操作。如果任务已完成，请回复 [TASK_COMPLETE] 并给出总结。如果需要继续操作，请生成下一步的JavaScript代码。`,
        })

        this._trimMessages()
      }

      // 循环结束（达到最大轮次或被中止）
      if (this.abortFlag) {
        sendEvent('agent:done', {
          success: false,
          rounds: this.currentRound,
          summary: '任务已被用户中止',
        })
        return { success: false, rounds: this.currentRound, summary: '任务已被用户中止' }
      }

      sendEvent('agent:done', {
        success: false,
        rounds: this.currentRound,
        summary: `已达到最大轮次 (${this.maxRounds})，任务可能未完全完成`,
      })
      return { success: false, rounds: this.currentRound, summary: '达到最大轮次限制' }

    } catch (e) {
      sendEvent('agent:done', {
        success: false,
        rounds: this.currentRound,
        summary: `任务执行出错: ${e.message}`,
        error: e.message,
      })
      return { success: false, rounds: this.currentRound, summary: e.message, error: e.message }
    } finally {
      this.running = false
    }
  }

  /**
   * 中止智能体循环
   */
  abort() {
    this.abortFlag = true
  }

  /**
   * 构建系统提示
   */
  _buildSystemPrompt() {
    return `你是一个自主网页操作智能体。你的任务是自动完成用户指定的网页操作目标。

## 工作方式
你将在一个循环中工作，每轮你需要：
1. 分析当前页面状态和之前的操作结果
2. 决定下一步操作
3. 生成JavaScript代码来执行操作
4. 代码执行后，系统会将结果反馈给你，你根据结果决定是否继续

## 代码规则
1. 返回的JavaScript代码必须用 \`\`\`javascript 和 \`\`\` 包裹
2. 代码必须自包含、可直接在浏览器控制台运行
3. 操作完成后通过 window.__actionResult = { success: true/false, message: '...', data: ... } 返回结果
4. 如果需要提取数据，将数据放在 __actionResult.data 中
5. 不要使用alert/prompt/confirm
6. 做好null检查和异常处理

## 任务完成标记
当任务已经完成时，在回复中包含 [TASK_COMPLETE] 标记，并给出任务总结。
例如: "[TASK_COMPLETE] 已成功提取页面所有商品数据，共获取25条记录。"

## 重要原则
- 每轮只做一步操作，不要试图一次完成所有步骤
- 如果上一步执行失败，分析原因并调整策略
- 如果页面需要等待加载，使用setTimeout或MutationObserver
- 提取大量数据时，分批提取避免超时
- 始终检查元素是否存在再操作
- 如果代码导致页面导航（点击链接、提交表单等），系统会自动等待新页面加载并反馈新页面DOM结构，你可以基于新结构继续操作
- 导航后页面JS环境会重置，之前注入的变量和函数都会丢失，需要重新注入`
  }

  /**
   * 构建初始用户消息
   */
  _buildInitialUserMessage(task, pageContext) {
    return `## 任务目标
${task}

## 当前页面信息
URL: ${pageContext?.url || '未知'}
标题: ${pageContext?.title || '未知'}

## 页面DOM结构摘要
${JSON.stringify(pageContext?.domSummary || [], null, 2)}

请分析当前页面并开始执行任务。第一步应该做什么？`
  }

  /**
   * 检查AI回复中是否包含任务完成标记
   */
  _checkTaskStatus(reply) {
    const completed = /\[TASK_COMPLETE\]/i.test(reply)
    let summary = ''
    if (completed) {
      // 提取完成标记后的总结
      const match = reply.match(/\[TASK_COMPLETE\]\s*(.*)/i)
      summary = match ? match[1].trim() : '任务已完成'
      // 如果总结太长，截取第一句
      if (summary.length > 200) {
        summary = summary.substring(0, 200) + '...'
      }
    }
    return { completed, summary }
  }

  /**
   * 裁剪对话上下文，保留system + 最近的对话
   */
  _trimMessages() {
    if (this.messages.length <= this.maxMessages) return
    const system = this.messages[0]
    const rest = this.messages.slice(1)
    const keep = rest.slice(-(this.maxMessages - 1))
    this.messages = [system, ...keep]
  }

  /**
   * 记录执行历史
   */
  _addHistory(round, status, reply, jsCode, result) {
    this.history.push({
      round,
      status,
      reply,
      jsCode,
      result,
      timestamp: Date.now(),
    })
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory)
    }
  }

  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      running: this.running,
      currentRound: this.currentRound,
      maxRounds: this.maxRounds,
      taskDescription: this.taskDescription,
      messageCount: this.messages.length,
    }
  }

  /**
   * 获取执行历史
   */
  getHistory() {
    return this.history
  }

  /**
   * 获取完整对话上下文
   */
  getMessages() {
    return this.messages
  }

  /**
   * 重置状态
   */
  reset() {
    this.running = false
    this.abortFlag = false
    this.messages = []
    this.currentRound = 0
    this.taskDescription = ''
  }

  /**
   * 清空历史
   */
  clearHistory() {
    this.history = []
  }

  /**
   * 设置最大轮次
   */
  setMaxRounds(max) {
    this.maxRounds = Math.max(1, Math.min(50, max))
  }
}

module.exports = AgentLoop
