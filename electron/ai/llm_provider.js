/**
 * 多模型适配层
 * 支持 OpenAI兼容API、Ollama本地模型、Qwen DashScope
 */
const { net } = require('electron')

class LLMProvider {
  constructor() {
    this.config = null
  }

  setConfig(config) {
    this.config = config
  }

  /**
   * 非流式对话
   */
  async chat(messages) {
    const provider = this.config.provider

    if (provider === 'ollama') {
      return await this._callOllama(messages, false)
    } else if (provider === 'qwen') {
      return await this._callQwen(messages, false)
    } else {
      // 默认 OpenAI 兼容
      return await this._callOpenAI(messages, false)
    }
  }

  /**
   * 流式对话 (async generator)
   */
  async *chatStream(messages) {
    const provider = this.config.provider

    if (provider === 'ollama') {
      yield* this._streamOllama(messages)
    } else if (provider === 'qwen') {
      yield* this._streamQwen(messages)
    } else {
      yield* this._streamOpenAI(messages)
    }
  }

  // ============ OpenAI 兼容 API ============
  async _callOpenAI(messages, stream) {
    const { apiKey, baseUrl, model } = this.config
    const url = `${baseUrl || 'https://api.openai.com/v1'}/chat/completions`

    const response = await this._postRequest(url, {
      model: model || 'gpt-4o',
      messages,
      stream: false,
      temperature: 0.7,
    }, apiKey)

    const data = JSON.parse(response)
    return data.choices[0].message.content
  }

  async *_streamOpenAI(messages) {
    const { apiKey, baseUrl, model } = this.config
    const url = `${baseUrl || 'https://api.openai.com/v1'}/chat/completions`

    const body = JSON.stringify({
      model: model || 'gpt-4o',
      messages,
      stream: true,
      temperature: 0.7,
    })

    const chunks = await this._streamRequest(url, body, apiKey)
    for (const chunk of chunks) {
      if (chunk === '[DONE]') return
      try {
        const data = JSON.parse(chunk)
        const delta = data.choices?.[0]?.delta?.content
        if (delta) yield delta
      } catch (e) {
        // 跳过解析失败的块
      }
    }
  }

  // ============ Ollama 本地模型 ============
  async _callOllama(messages, stream) {
    const { baseUrl, model } = this.config
    const url = `${baseUrl || 'http://localhost:11434'}/api/chat`

    const response = await this._postRequest(url, {
      model: model || 'qwen2.5:14b',
      messages,
      stream: false,
    }, null)

    const data = JSON.parse(response)
    return data.message.content
  }

  async *_streamOllama(messages) {
    const { baseUrl, model } = this.config
    const url = `${baseUrl || 'http://localhost:11434'}/api/chat`

    const body = JSON.stringify({
      model: model || 'qwen2.5:14b',
      messages,
      stream: true,
    })

    const chunks = await this._streamRequest(url, body, null)
    for (const chunk of chunks) {
      try {
        const data = JSON.parse(chunk)
        if (data.message?.content) yield data.message.content
        if (data.done) return
      } catch (e) {
        // 跳过
      }
    }
  }

  // ============ Qwen DashScope ============
  async _callQwen(messages, stream) {
    const { apiKey, model } = this.config
    const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

    const response = await this._postRequest(url, {
      model: model || 'qwen-plus',
      messages,
      stream: false,
    }, apiKey)

    const data = JSON.parse(response)
    return data.choices[0].message.content
  }

  async *_streamQwen(messages) {
    const { apiKey, model } = this.config
    const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

    const body = JSON.stringify({
      model: model || 'qwen-plus',
      messages,
      stream: true,
    })

    const chunks = await this._streamRequest(url, body, apiKey)
    for (const chunk of chunks) {
      if (chunk === '[DONE]') return
      try {
        const data = JSON.parse(chunk)
        const delta = data.choices?.[0]?.delta?.content
        if (delta) yield delta
      } catch (e) {
        // 跳过
      }
    }
  }

  // ============ HTTP 工具方法 ============
  _postRequest(url, body, apiKey) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

      const request = net.request({
        method: 'POST',
        url,
      })

      let responseData = ''

      request.on('response', (response) => {
        response.on('data', (chunk) => {
          responseData += chunk.toString()
        })
        response.on('end', () => {
          if (response.statusCode >= 400) {
            reject(new Error(`HTTP ${response.statusCode}: ${responseData}`))
          } else {
            resolve(responseData)
          }
        })
      })

      request.on('error', reject)
      for (const [k, v] of Object.entries(headers)) {
        request.setHeader(k, v)
      }
      request.write(JSON.stringify(body))
      request.end()
    })
  }

  _streamRequest(url, body, apiKey) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

      const request = net.request({
        method: 'POST',
        url,
      })

      let buffer = ''
      const chunks = []

      request.on('response', (response) => {
        response.on('data', (chunk) => {
          buffer += chunk.toString()
          // SSE 格式: data: {...}\n\n
          const lines = buffer.split('\n')
          buffer = lines.pop() // 保留最后不完整的行

          for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.startsWith('data: ')) {
              const data = trimmed.slice(6)
              if (data === '[DONE]') {
                chunks.push('[DONE]')
              } else {
                chunks.push(data)
              }
            } else if (trimmed && !trimmed.startsWith(':')) {
              // Ollama 直接返回JSON
              chunks.push(trimmed)
            }
          }
        })
        response.on('end', () => {
          // 处理最后剩余的buffer
          if (buffer.trim()) {
            const trimmed = buffer.trim()
            if (trimmed.startsWith('data: ')) {
              const data = trimmed.slice(6)
              if (data !== '[DONE]') chunks.push(data)
            } else {
              chunks.push(trimmed)
            }
          }
          resolve(chunks)
        })
      })

      request.on('error', reject)
      for (const [k, v] of Object.entries(headers)) {
        request.setHeader(k, v)
      }
      request.write(body)
      request.end()
    })
  }
}

module.exports = LLMProvider
