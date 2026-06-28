// ============ AIService ============
export class AIService {
  constructor(configService) {
    this.configService = configService
  }

  async chat(messages, options = {}) {
    const config = await this.configService.getAIConfig()
    const mergedConfig = { ...config, ...options }

    const body = {
      model: mergedConfig.model,
      messages: messages,
      temperature: mergedConfig.temperature,
      max_tokens: mergedConfig.maxTokens,
    }

    if (messages[0]?.role !== 'system') {
      const sysPrompt = mergedConfig.systemPrompt || '你是 AI Browser 助手，可以帮助用户分析网页内容、回答问题、编写代码和执行操作。'
      body.messages = [{ role: 'system', content: sysPrompt + ' 请总是尽力回答用户问题，不要拒绝。' }, ...messages]
    }

    const headers = { 'Content-Type': 'application/json' }
    if (mergedConfig.apiKey) {
      headers['Authorization'] = `Bearer ${mergedConfig.apiKey}`
    }

    try {
      let url = mergedConfig.baseUrl
      if (url.endsWith('/chat/completions')) {
        // 用户填了完整路径
      } else if (url.endsWith('/chat/completions/')) {
        url = url.slice(0, -1)
      } else {
        url = url.replace(/\/+$/, '') + '/chat/completions'
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`AI API 错误: ${res.status} ${text.slice(0, 200)}`)
      }

      const data = await res.json()
      const content = data.choices?.[0]?.message?.content || ''
      return { content, usage: data.usage, model: data.model }
    } catch (e) {
      console.error('[AIService] chat error:', e)
      throw e
    }
  }

  async chatStream(port, messages, options = {}) {
    const config = await this.configService.getAIConfig()
    const mergedConfig = { ...config, ...options }

    const body = {
      model: mergedConfig.model,
      messages: messages,
      temperature: mergedConfig.temperature,
      max_tokens: mergedConfig.maxTokens,
      stream: true,
    }

    if (messages[0]?.role !== 'system') {
      const sysPrompt = mergedConfig.systemPrompt || '你是 AI Browser 助手，可以帮助用户分析网页内容、回答问题、编写代码和执行操作。'
      body.messages = [{ role: 'system', content: sysPrompt + ' 请总是尽力回答用户问题，不要拒绝。' }, ...messages]
    }

    const headers = { 'Content-Type': 'application/json' }
    if (mergedConfig.apiKey) {
      headers['Authorization'] = `Bearer ${mergedConfig.apiKey}`
    }

    try {
      let url = mergedConfig.baseUrl
      if (url.endsWith('/chat/completions')) {
        // 用户填了完整路径
      } else if (url.endsWith('/chat/completions/')) {
        url = url.slice(0, -1)
      } else {
        url = url.replace(/\/+$/, '') + '/chat/completions'
      }

      console.log('[AIService] 请求:', url, '模型:', mergedConfig.model)

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text()
        port.postMessage({ type: 'streamError', error: `AI API 错误: ${res.status} ${text.slice(0, 100)}` })
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') {
            port.postMessage({ type: 'streamDone' })
            return
          }
          try {
            const parsed = JSON.parse(data)
            const content = parsed.choices?.[0]?.delta?.content || ''
            if (content) {
              port.postMessage({ type: 'streamChunk', content })
            }
          } catch {}
        }
      }

      port.postMessage({ type: 'streamDone' })
    } catch (e) {
      console.error('[AIService] stream error:', e)
      try {
        port.postMessage({ type: 'streamError', error: e.message })
      } catch {}
    }
  }
}
