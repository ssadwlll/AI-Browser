// ============ AIService ============
// 通过服务端代理调用 AI（POST {serverUrl}/api/ai-proxy/chat），请求头携带 appKey 签名
import { fetchWithTimeout, AppError, ERROR_CODES } from '../../shared/utils.js'

export class AIService {
  constructor(configService) {
    this.configService = configService
    // 活跃流映射：portId -> AbortController，用于端口断开时中止请求
    this._activeStreams = new Map()
    this._portIdSeq = 0
  }

  /**
   * 构建请求体（与 OpenAI Chat Completions 兼容）
   * 若首条消息非 system，自动注入系统提示词
   * 注意：不再强制追加"不要拒绝"后缀，避免削弱模型安全拒答机制
   */
  _buildBody(messages, mergedConfig, stream = false) {
    const body = {
      model: mergedConfig.model,
      messages: messages,
      temperature: mergedConfig.temperature,
      max_tokens: mergedConfig.maxTokens,
    }
    if (stream) body.stream = true

    if (messages[0]?.role !== 'system') {
      const sysPrompt = mergedConfig.systemPrompt || '你是 AI Browser 助手，可以帮助用户分析网页内容、回答问题、编写代码和执行操作。请遵循安全规范，但尽力完成用户的合理请求。'
      body.messages = [{ role: 'system', content: sysPrompt }, ...messages]
    }
    return body
  }

  async chat(messages, options = {}) {
    const config = await this.configService.getAIConfig()
    const mergedConfig = { ...config, ...options }

    const body = this._buildBody(messages, mergedConfig, false)
    const { appKey, appSecret } = await this.configService.getAppAuth()
    const headers = await this.configService.generateAuthHeaders(appKey, appSecret)
    const url = await this.configService.getAIProxyUrl()

    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }, 60000)

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new AppError(
          res.status === 401 ? ERROR_CODES.AUTH_INVALID : ERROR_CODES.NETWORK_ERROR,
          `AI API 错误: ${res.status} ${text.slice(0, 200)}`,
          { status: res.status, url }
        )
      }

      const data = await res.json()
      const content = data.choices?.[0]?.message?.content || ''
      return { content, usage: data.usage, model: data.model }
    } catch (e) {
      console.error('[AIService] chat error:', e)
      throw e instanceof AppError ? e : AppError.fromError(e)
    }
  }

  async chatStream(port, messages, options = {}) {
    const config = await this.configService.getAIConfig()
    const mergedConfig = { ...config, ...options }

    const body = this._buildBody(messages, mergedConfig, true)
    const { appKey, appSecret } = await this.configService.getAppAuth()
    const headers = await this.configService.generateAuthHeaders(appKey, appSecret)
    const url = await this.configService.getAIProxyUrl()

    // 每个流绑定独立的 AbortController，便于端口断开时中止
    const controller = new AbortController()
    const portId = ++this._portIdSeq
    this._activeStreams.set(portId, controller)

    // 监听端口断开，中止 fetch 与 reader
    const onDisconnect = () => {
      console.log('[AIService] port 断开，中止流 portId=', portId)
      try { controller.abort() } catch {}
      this._activeStreams.delete(portId)
    }
    try {
      port.onDisconnect.addListener(onDisconnect)
    } catch {}

    // 端口可能已断开，用 try/catch 包装 postMessage 并记录端口存活状态
    let portAlive = true
    const safePost = (msg) => {
      if (!portAlive) return
      try {
        port.postMessage(msg)
      } catch (e) {
        portAlive = false
        console.warn('[AIService] postMessage 失败，标记端口为断开:', e.message)
        try { controller.abort() } catch {}
        this._activeStreams.delete(portId)
      }
    }

    try {
      console.log('[AIService] 请求代理:', url, '模型:', mergedConfig.model)

      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }, 60000).catch((e) => {
        // AbortError 由调用方期望的正常中止流程，不应报错
        if (e.name === 'AbortError' || e.code === ERROR_CODES.NETWORK_ABORTED.code) return null
        throw e
      })

      if (!res) {
        // 已被 abort（端口断开或超时）
        return
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        safePost({ type: 'streamError', error: `AI API 错误: ${res.status} ${text.slice(0, 100)}` })
        // 错误路径也发送 streamDone，确保调用方状态机收尾
        safePost({ type: 'streamDone' })
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      // 主动中止时 reader.read() 会 reject AbortError
      while (true) {
        let chunk
        try {
          chunk = await reader.read()
        } catch (e) {
          if (e.name === 'AbortError') break
          throw e
        }
        const { done, value } = chunk
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') {
            safePost({ type: 'streamDone' })
            this._cleanupStream(portId, onDisconnect, port)
            return
          }
          try {
            const parsed = JSON.parse(data)
            const content = parsed.choices?.[0]?.delta?.content || ''
            if (content) {
              safePost({ type: 'streamChunk', content })
            }
          } catch (e) {
            console.warn('[AIService] SSE 解析失败:', e.message, 'line:', trimmed.slice(0, 80))
          }
        }
      }

      safePost({ type: 'streamDone' })
    } catch (e) {
      console.error('[AIService] stream error:', e)
      try { port.postMessage({ type: 'streamError', error: e.message }) } catch {}
      try { port.postMessage({ type: 'streamDone' }) } catch {}
    } finally {
      this._cleanupStream(portId, onDisconnect, port)
    }
  }

  _cleanupStream(portId, onDisconnect, port) {
    this._activeStreams.delete(portId)
    try { port.onDisconnect.removeListener(onDisconnect) } catch {}
  }
}
