// ============ ContextCompressor ============
// LLM 驱动的上下文压缩
// 职责：
//   1. 替代规则驱动的 S/A/B/C 分级截断，用 LLM 生成语义摘要
//   2. 使用与主任务相同的模型（小 temperature），额外消耗 1 次 LLM 调用

import { fetchWithTimeout } from '../../shared/utils.js'

// LLM 压缩的提示词
const COMPRESSION_SYSTEM_PROMPT = `你是上下文压缩器。你的任务是将一段 AI Agent 的对话历史压缩为结构化摘要，保留对后续执行有用的信息。

输出格式（严格遵守）：
## 关键发现
- [列出所有已获取的重要数据发现，包含具体数量和位置]

## 已做决策
- [列出 AI 已做出的重要选择和原因]

## 排除方案
- [列出已尝试但失败的方案，说明失败原因]

## 数据引用
- [列出已收集数据的存储ID、条目数、摘要]

## 当前状态
- [页面URL（仅URL，不要输出页面正文内容）、待办进度、未完成事项]

规则：
1. 保留所有具体数据（数量、选择器、URL、ID），不要泛化
2. 丢弃纯过程性消息（如"思考中"、"等待"等）
3. 保留失败信息，避免重复尝试
4. 不要输出页面正文内容（已在用户消息中）
5. 摘要总长度控制在 800 字符以内`

export class ContextCompressor {
  constructor(configService) {
    this.configService = configService
    this._compressionCount = 0  // 压缩次数统计
  }

  /**
   * 用 LLM 压缩早期消息（替代规则驱动的 S/A/B/C 分级）
   * @param {Array} messages - 完整消息数组
   * @param {number} cutOff - 需要压缩的消息截止索引
   * @param {string} userMessage - 原始用户消息
   * @param {object} workingMemory - WorkingMemory 实例（提供额外结构化信息）
   * @returns {object} 压缩后的 system 消息，替代 cutOff 之前的所有消息
   */
  async compress(messages, cutOff, userMessage, workingMemory = null) {
    // 收集需要压缩的消息文本
    const messagesToCompress = messages.slice(1, cutOff)  // 跳过 system prompt (index 0)
    if (messagesToCompress.length === 0) return null

    // 构建压缩输入：将消息流转换为可读文本
    const inputText = this._messagesToText(messagesToCompress)

    // 如果输入已经很短，不需要 LLM 压缩，直接用规则压缩
    if (inputText.length < 1500) {
      return this._ruleBasedFallback(messagesToCompress, userMessage)
    }

    // 如果有 WorkingMemory，将其结构化信息作为补充输入
    let memoryContext = ''
    if (workingMemory) {
      memoryContext = `\n\n=== 工作记忆（结构化参考） ===\n${workingMemory.toContext({ includeErrors: false, maxLen: 800 })}`
    }

    try {
      const config = await this.configService.getAIConfig()
      const url = await this.configService.getAIProxyUrl()
      const auth = await this.configService.getAppAuth()
      const headers = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)

      const compressMessages = [
        { role: 'system', content: COMPRESSION_SYSTEM_PROMPT },
        { role: 'user', content: `请压缩以下对话历史：\n\n${inputText.slice(0, 6000)}${memoryContext}\n\n原始用户需求: ${userMessage.slice(0, 200)}` }
      ]

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000)

      try {
        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: config.model,
            messages: compressMessages,
            temperature: 0.1,  // 低温度确保一致性
            max_tokens: 1024,
          }),
          signal: controller.signal,
        }, 15000)

        if (!res.ok) {
          console.warn('[ContextCompressor] LLM压缩失败，回退到规则压缩:', res.status)
          return this._ruleBasedFallback(messagesToCompress, userMessage)
        }

        const data = await res.json()
        const summary = data.choices?.[0]?.message?.content?.trim()

        if (!summary || summary.length < 50) {
          console.warn('[ContextCompressor] LLM摘要过短，回退到规则压缩')
          return this._ruleBasedFallback(messagesToCompress, userMessage)
        }

        this._compressionCount++
        console.log(`[ContextCompressor] LLM压缩成功 (第${this._compressionCount}次), 输入${inputText.length}字符 → 输出${summary.length}字符`)

        return {
          role: 'system',
          content: `[上下文摘要] 以下为早期操作的语义压缩摘要：\n${summary}\n---\n原始用户需求: ${userMessage.slice(0, 200)}`
        }
      } finally {
        // 无论成功/失败/异常，都清理定时器避免悬挂
        clearTimeout(timeoutId)
      }
    } catch (e) {
      console.warn('[ContextCompressor] LLM压缩异常，回退到规则压缩:', e.message)
      return this._ruleBasedFallback(messagesToCompress, userMessage)
    }
  }

  /**
   * 将消息数组转换为可读文本（用于 LLM 输入）
   */
  _messagesToText(messages) {
    const parts = []
    const toolNameMap = new Map()

    // 先扫描 assistant 消息建立 tool_call_id → tool_name 映射
    for (const m of messages) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) {
          toolNameMap.set(tc.id, tc.function.name)
        }
      }
    }

    for (const m of messages) {
      if (m.role === 'assistant') {
        if (m.content) {
          parts.push(`[AI]: ${m.content.slice(0, 300)}`)
        }
        if (m.tool_calls) {
          const callDescs = m.tool_calls.map(tc =>
            `${tc.function.name}(${this._truncateArgs(tc.function.arguments)})`
          )
          parts.push(`[AI调用工具]: ${callDescs.join(', ')}`)
        }
      } else if (m.role === 'tool') {
        const toolName = toolNameMap.get(m.tool_call_id) || '未知工具'
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
        // 限制每条工具结果的表示长度，避免上下文压缩后仍过大
        const maxLen = 300
        parts.push(`[工具结果:${toolName}]: ${content.slice(0, maxLen)}${content.length > maxLen ? '...(截断)' : ''}`)
      } else if (m.role === 'system') {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
        // 系统消息只保留前150字符（大部分是进度/提示，不重要）
        if (content.length > 20) {  // 跳过空/极短消息
          parts.push(`[系统]: ${content.slice(0, 150)}`)
        }
      } else if (m.role === 'user') {
        parts.push(`[用户]: ${(m.content || '').slice(0, 200)}`)
      }
    }

    return parts.join('\n')
  }

  /**
   * 截断工具参数
   */
  _truncateArgs(argsStr) {
    if (!argsStr) return ''
    try {
      const args = JSON.parse(argsStr)
      const entries = Object.entries(args).map(([k, v]) => {
        const val = typeof v === 'string' ? v.slice(0, 50) : JSON.stringify(v).slice(0, 50)
        return `${k}="${val}"`
      })
      return entries.join(', ')
    } catch {
      return argsStr.slice(0, 80)
    }
  }

  /**
   * 规则驱动的回退压缩（当 LLM 压缩失败时使用）
   * 保留原有 S/A/B/C 分级逻辑但做简化
   */
  _ruleBasedFallback(messagesToCompress, userMessage) {
    const toolNameMap = new Map()
    for (const m of messagesToCompress) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) toolNameMap.set(tc.id, tc.function.name)
      }
    }

    const parts = []
    for (const m of messagesToCompress) {
      if (m.role === 'tool' && m.content) {
        const toolName = toolNameMap.get(m.tool_call_id) || ''
        try {
          const parsed = JSON.parse(m.content)
          // 关键数据：extract_content 含链接 / inject_script 结果
          if (toolName === 'extract_content' && parsed?.ok && Array.isArray(parsed.result)) {
            const links = parsed.result.filter(item => item?.attrs?.href && item?.text)
              .map(item => `${item.attrs.href} | ${item.text.slice(0, 30)}`)
            if (links.length > 0) {
              parts.push(`[链接列表(${links.length}条)]\n${links.slice(0, 15).join('\n')}`)
              continue
            }
          }
          if (toolName.startsWith('inject_script_') && parsed?.ok && parsed?.result) {
            const resultStr = typeof parsed.result === 'string'
              ? parsed.result.slice(0, 300)
              : JSON.stringify(parsed.result).slice(0, 300)
            parts.push(`[脚本${toolName}结果] ${resultStr}`)
            continue
          }
          // 其他结果：简要摘要
          if (parsed?.ok && parsed?.result) {
            const resultStr = typeof parsed.result === 'string'
              ? parsed.result.slice(0, 80)
              : JSON.stringify(parsed.result).slice(0, 80)
            parts.push(`[${toolName}] ${resultStr}`)
          } else if (parsed?.error) {
            parts.push(`[${toolName}] 错误: ${String(parsed.error).slice(0, 50)}`)
          }
        } catch {
          parts.push(`[工具结果] ${m.content.slice(0, 60)}`)
        }
      } else if (m.role === 'system' && m.content) {
        // 系统消息只保留非重复的
        const content = m.content.slice(0, 80)
        if (!content.includes('没有变化') && !content.includes('无变化')) {
          parts.push(content)
        }
      }
    }

    // 截取最后部分（最重要的）
    const summary = parts.slice(-10).join('\n')
    return {
      role: 'system',
      content: `[上下文摘要] 以下为早期操作摘要：\n${summary}\n---\n原始用户需求: ${userMessage.slice(0, 200)}`
    }
  }
}
