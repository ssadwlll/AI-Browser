// ============ ContextCompressor（上下文压缩器）============
// LLM 驱动压缩 + 规则回退的双轨设计（S/A/B/C 分级已废弃）
// 职责：
//   1. 用 LLM 生成语义摘要，替代规则驱动的 S/A/B/C 分级截断
//   2. 使用与主任务相同的模型（低 temperature），额外消耗 1 次 LLM 调用
//   3. LLM 失败/摘要过短时自动回退到规则压缩
//
// 迁移自 chrome-extension/background/services/context-compressor.js
// 改动：
//   - ES Module → CommonJS
//   - fetchWithTimeout → Node.js 原生 http/https 模块
//   - 依赖 ConfigService（Phase 1 基础服务）获取代理 URL 与签名头

const http = require('http')
const https = require('https')

// LLM 压缩的提示词：输出结构化摘要，保留具体数据、丢弃过程性消息
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

class ContextCompressor {
  /**
   * @param {object} configService - Phase 1 的 ConfigService 实例
   *   需提供：getAIConfig() / getAIProxyUrl() / getAppAuth() / generateAuthHeaders()
   */
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
   * @returns {Promise<object|null>} 压缩后的 system 消息，替代 cutOff 之前的所有消息
   */
  async compress(messages, cutOff, userMessage, workingMemory = null) {
    // 收集需要压缩的消息（跳过 index 0 的 system prompt）
    const messagesToCompress = messages.slice(1, cutOff)
    if (messagesToCompress.length === 0) return null

    // 构建压缩输入：将消息流转换为可读文本
    const inputText = this._messagesToText(messagesToCompress)

    // 短路：输入已经很短，不需要 LLM 压缩，直接走规则回退
    if (inputText.length < 1500) {
      return this._ruleBasedFallback(messagesToCompress, userMessage)
    }

    // 如果有 WorkingMemory，将其结构化信息作为补充参考
    let memoryContext = ''
    if (workingMemory) {
      memoryContext = `\n\n=== 工作记忆（结构化参考） ===\n${workingMemory.toContext({ includeErrors: false, maxLen: 800 })}`
    }

    try {
      // 通过 ConfigService 获取模型配置、代理 URL 与签名头
      const config = await this.configService.getAIConfig()
      const url = await this.configService.getAIProxyUrl()
      const auth = await this.configService.getAppAuth()
      const headers = await this.configService.generateAuthHeaders(auth.appKey, auth.appSecret)

      const compressMessages = [
        { role: 'system', content: COMPRESSION_SYSTEM_PROMPT },
        { role: 'user', content: `请压缩以下对话历史：\n\n${inputText.slice(0, 6000)}${memoryContext}\n\n原始用户需求: ${String(userMessage || '').slice(0, 200)}` }
      ]

      // 构建 OpenAI 兼容请求体
      const requestBody = {
        model: config.model,
        messages: compressMessages,
        temperature: 0.1,  // 低温度确保一致性
        max_tokens: 1024,
      }

      // 调用 LLM（15s 超时）
      const result = await this._postJson(url, headers, requestBody, 15000)

      if (!result.ok) {
        console.warn('[ContextCompressor] LLM压缩失败，回退到规则压缩: HTTP', result.status)
        return this._ruleBasedFallback(messagesToCompress, userMessage)
      }

      // 解析 LLM 响应
      let data
      try {
        data = JSON.parse(result.data)
      } catch (e) {
        console.warn('[ContextCompressor] LLM响应解析失败，回退到规则压缩:', e.message)
        return this._ruleBasedFallback(messagesToCompress, userMessage)
      }

      const summary = data.choices?.[0]?.message?.content?.trim()

      // 摘要过短（<50字符）视为无效，回退规则压缩
      if (!summary || summary.length < 50) {
        console.warn('[ContextCompressor] LLM摘要过短，回退到规则压缩')
        return this._ruleBasedFallback(messagesToCompress, userMessage)
      }

      this._compressionCount++
      console.log(`[ContextCompressor] LLM压缩成功 (第${this._compressionCount}次), 输入${inputText.length}字符 → 输出${summary.length}字符`)

      return {
        role: 'system',
        content: `[上下文摘要] 以下为早期操作的语义压缩摘要：\n${summary}\n---\n原始用户需求: ${String(userMessage || '').slice(0, 200)}`
      }
    } catch (e) {
      console.warn('[ContextCompressor] LLM压缩异常，回退到规则压缩:', e.message)
      return this._ruleBasedFallback(messagesToCompress, userMessage)
    }
  }

  /**
   * 将消息数组转换为可读文本（用于 LLM 输入）
   * 先扫描建立 tool_call_id → tool_name 映射，再逐条转换
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
          parts.push(`[AI]: ${String(m.content).slice(0, 300)}`)
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
        // 限制每条工具结果的表示长度，避免压缩后仍过大
        const maxLen = 300
        parts.push(`[工具结果:${toolName}]: ${content.slice(0, maxLen)}${content.length > maxLen ? '...(截断)' : ''}`)
      } else if (m.role === 'system') {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
        // 系统消息只保留前 150 字符（大部分是进度/提示，不重要）
        if (content.length > 20) {  // 跳过空/极短消息
          parts.push(`[系统]: ${content.slice(0, 150)}`)
        }
      } else if (m.role === 'user') {
        parts.push(`[用户]: ${String(m.content || '').slice(0, 200)}`)
      }
    }

    return parts.join('\n')
  }

  /**
   * 截断工具参数（解析失败时退化为原始字符串截断）
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
      return String(argsStr).slice(0, 80)
    }
  }

  /**
   * 规则驱动的回退压缩（当 LLM 压缩失败或输入过短时使用）
   * 保留关键数据（链接列表/脚本结果），丢弃过程性消息
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
          // 关键数据：extract_content 含链接 → 提取 href + text（最多 15 条）
          if (toolName === 'extract_content' && parsed?.ok && Array.isArray(parsed.result)) {
            const links = parsed.result.filter(item => item?.attrs?.href && item?.text)
              .map(item => `${item.attrs.href} | ${String(item.text).slice(0, 30)}`)
            if (links.length > 0) {
              parts.push(`[链接列表(${links.length}条)]\n${links.slice(0, 15).join('\n')}`)
              continue
            }
          }
          // inject_script_* 结果 → 截 300 字符
          if (toolName.startsWith('inject_script_') && parsed?.ok && parsed?.result) {
            const resultStr = typeof parsed.result === 'string'
              ? parsed.result.slice(0, 300)
              : JSON.stringify(parsed.result).slice(0, 300)
            parts.push(`[脚本${toolName}结果] ${resultStr}`)
            continue
          }
          // 其他结果 → 截 80 字符
          if (parsed?.ok && parsed?.result) {
            const resultStr = typeof parsed.result === 'string'
              ? parsed.result.slice(0, 80)
              : JSON.stringify(parsed.result).slice(0, 80)
            parts.push(`[${toolName}] ${resultStr}`)
          } else if (parsed?.error) {
            // 错误 → 截 50 字符
            parts.push(`[${toolName}] 错误: ${String(parsed.error).slice(0, 50)}`)
          }
        } catch {
          parts.push(`[工具结果] ${String(m.content).slice(0, 60)}`)
        }
      } else if (m.role === 'system' && m.content) {
        // 系统消息过滤"没有变化/无变化"
        const content = String(m.content).slice(0, 80)
        if (!content.includes('没有变化') && !content.includes('无变化')) {
          parts.push(content)
        }
      }
    }

    // 截取最后 10 段（最重要的）
    const summary = parts.slice(-10).join('\n')
    return {
      role: 'system',
      content: `[上下文摘要] 以下为早期操作摘要：\n${summary}\n---\n原始用户需求: ${String(userMessage || '').slice(0, 200)}`
    }
  }

  /**
   * 使用 Node.js 原生 http/https 发起 POST JSON 请求
   * 根据 URL 协议自动选择 http 或 https 模块
   * @param {string} url - 请求 URL（configService.getAIProxyUrl() 返回）
   * @param {object} headers - 请求头（含签名，由 generateAuthHeaders 生成）
   * @param {object} bodyObj - 请求体对象（OpenAI 兼容，自动序列化为 JSON）
   * @param {number} timeoutMs - 超时毫秒，默认 15000
   * @returns {Promise<{ok:boolean, status:number, data:string}>}
   *   - HTTP 4xx/5xx 通过 resolve 返回 {ok:false}，由调用方决定是否回退
   *   - 网络错误/超时通过 reject 抛出，由调用方 catch 后回退
   */
  _postJson(url, headers, bodyObj, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify(bodyObj)
      let parsedUrl
      try {
        parsedUrl = new URL(url)
      } catch (e) {
        reject(new Error(`无效的 URL: ${url}`))
        return
      }

      const isHttps = parsedUrl.protocol === 'https:'
      const lib = isHttps ? https : http

      const options = {
        method: 'POST',
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      }

      let responseData = ''
      let settled = false

      const req = lib.request(options, (res) => {
        res.on('data', (chunk) => { responseData += chunk.toString() })
        res.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (res.statusCode >= 400) {
            // HTTP 错误通过 resolve 返回，由调用方决定是否回退
            resolve({ ok: false, status: res.statusCode, data: responseData })
          } else {
            resolve({ ok: true, status: res.statusCode, data: responseData })
          }
        })
      })

      // 超时处理：销毁请求并 reject
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        req.destroy()
        reject(new Error(`LLM 请求超时 (${timeoutMs}ms)`))
      }, timeoutMs)

      req.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })

      req.write(bodyStr)
      req.end()
    })
  }
}

module.exports = ContextCompressor
