/**
 * 多模型适配层
 * 支持 OpenAI兼容API、Ollama本地模型、Qwen DashScope
 * 支持 Function Calling / Tool Use
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
   * 非流式对话（支持tools）
   */
  async chat(messages, options = {}) {
    const provider = this.config.provider

    if (provider === 'ollama') {
      return await this._callOllama(messages, false, options)
    } else if (provider === 'qwen') {
      return await this._callQwen(messages, false, options)
    } else {
      return await this._callOpenAI(messages, false, options)
    }
  }

  /**
   * 流式对话 (async generator，支持tools)
   */
  async *chatStream(messages, options = {}) {
    const provider = this.config.provider

    if (provider === 'ollama') {
      yield* this._streamOllama(messages, options)
    } else if (provider === 'qwen') {
      yield* this._streamQwen(messages, options)
    } else {
      yield* this._streamOpenAI(messages, options)
    }
  }

  // ============ OpenAI 兼容 API ============
  async _callOpenAI(messages, stream, options = {}) {
    const { apiKey, baseUrl, model } = this.config
    const url = `${baseUrl || 'https://api.openai.com/v1'}/chat/completions`

    const body = {
      model: model || 'gpt-4o',
      messages,
      stream: false,
      temperature: 0.7,
    }
    if (options.tools) body.tools = options.tools

    const response = await this._postRequest(url, body, apiKey)
    const data = JSON.parse(response)
    return data.choices[0].message
  }

  async *_streamOpenAI(messages, options = {}) {
    const { apiKey, baseUrl, model } = this.config
    const url = `${baseUrl || 'https://api.openai.com/v1'}/chat/completions`

    const body = {
      model: model || 'gpt-4o',
      messages,
      stream: true,
      temperature: 0.7,
    }
    if (options.tools) body.tools = options.tools

    const chunks = await this._streamRequest(url, JSON.stringify(body), apiKey)

    // 流式模式下需要累积tool_calls的delta
    let toolCallsAccum = {}

    for (const chunk of chunks) {
      if (chunk === '[DONE]') {
        // 如果有累积的tool_calls，yield出来
        if (Object.keys(toolCallsAccum).length > 0) {
          const toolCalls = Object.values(toolCallsAccum).sort((a, b) => a.index - b.index)
          yield { type: 'tool_calls', tool_calls: toolCalls }
        }
        return
      }
      try {
        const data = JSON.parse(chunk)
        const choice = data.choices?.[0]
        if (!choice) continue

        const delta = choice.delta

        // 处理content
        if (delta?.content) {
          yield { type: 'content', content: delta.content }
        }

        // 处理tool_calls (流式增量)
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            if (!toolCallsAccum[idx]) {
              toolCallsAccum[idx] = {
                index: idx,
                id: tc.id || '',
                type: tc.type || 'function',
                function: { name: '', arguments: '' },
              }
            }
            if (tc.id) toolCallsAccum[idx].id = tc.id
            if (tc.type) toolCallsAccum[idx].type = tc.type
            if (tc.function?.name) toolCallsAccum[idx].function.name += tc.function.name
            if (tc.function?.arguments) toolCallsAccum[idx].function.arguments += tc.function.arguments
          }
        }

        // 如果流结束且有tool_calls
        if (choice.finish_reason === 'tool_calls' && Object.keys(toolCallsAccum).length > 0) {
          const toolCalls = Object.values(toolCallsAccum).sort((a, b) => a.index - b.index)
          yield { type: 'tool_calls', tool_calls: toolCalls }
          toolCallsAccum = {}
        }
      } catch (e) {
        // 跳过解析失败的块
      }
    }
  }

  // ============ Ollama 本地模型 ============
  async _callOllama(messages, stream, options = {}) {
    const { baseUrl, model } = this.config
    const url = `${baseUrl || 'http://localhost:11434'}/api/chat`

    const body = {
      model: model || 'qwen2.5:14b',
      messages,
      stream: false,
    }
    if (options.tools) body.tools = options.tools

    const response = await this._postRequest(url, body, null)
    const data = JSON.parse(response)
    return data.message
  }

  async *_streamOllama(messages, options = {}) {
    const { baseUrl, model } = this.config
    const url = `${baseUrl || 'http://localhost:11434'}/api/chat`

    const body = {
      model: model || 'qwen2.5:14b',
      messages,
      stream: true,
    }
    if (options.tools) body.tools = options.tools

    const chunks = await this._streamRequest(url, JSON.stringify(body), null)

    let toolCallsAccum = {}

    for (const chunk of chunks) {
      try {
        const data = JSON.parse(chunk)
        const msg = data.message
        if (!msg) continue

        // 处理content
        if (msg.content) {
          yield { type: 'content', content: msg.content }
        }

        // Ollama tool_calls 格式
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            yield { type: 'tool_call', tool_call: tc }
          }
        }

        if (data.done) {
          // 如果有累积的tool_calls
          if (Object.keys(toolCallsAccum).length > 0) {
            yield { type: 'tool_calls', tool_calls: Object.values(toolCallsAccum) }
          }
          return
        }
      } catch (e) {
        // 跳过
      }
    }
  }

  // ============ Qwen DashScope ============
  async _callQwen(messages, stream, options = {}) {
    const { apiKey, model } = this.config
    const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

    const body = {
      model: model || 'qwen-plus',
      messages,
      stream: false,
    }
    if (options.tools) body.tools = options.tools

    const response = await this._postRequest(url, body, apiKey)
    const data = JSON.parse(response)
    return data.choices[0].message
  }

  async *_streamQwen(messages, options = {}) {
    const { apiKey, model } = this.config
    const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

    const body = {
      model: model || 'qwen-plus',
      messages,
      stream: true,
    }
    if (options.tools) body.tools = options.tools

    const chunks = await this._streamRequest(url, JSON.stringify(body), apiKey)

    let toolCallsAccum = {}

    for (const chunk of chunks) {
      if (chunk === '[DONE]') {
        if (Object.keys(toolCallsAccum).length > 0) {
          const toolCalls = Object.values(toolCallsAccum).sort((a, b) => a.index - b.index)
          yield { type: 'tool_calls', tool_calls: toolCalls }
        }
        return
      }
      try {
        const data = JSON.parse(chunk)
        const choice = data.choices?.[0]
        if (!choice) continue

        const delta = choice.delta

        if (delta?.content) {
          yield { type: 'content', content: delta.content }
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            if (!toolCallsAccum[idx]) {
              toolCallsAccum[idx] = {
                index: idx,
                id: tc.id || '',
                type: tc.type || 'function',
                function: { name: '', arguments: '' },
              }
            }
            if (tc.id) toolCallsAccum[idx].id = tc.id
            if (tc.type) toolCallsAccum[idx].type = tc.type
            if (tc.function?.name) toolCallsAccum[idx].function.name += tc.function.name
            if (tc.function?.arguments) toolCallsAccum[idx].function.arguments += tc.function.arguments
          }
        }

        if (choice.finish_reason === 'tool_calls' && Object.keys(toolCallsAccum).length > 0) {
          const toolCalls = Object.values(toolCallsAccum).sort((a, b) => a.index - b.index)
          yield { type: 'tool_calls', tool_calls: toolCalls }
          toolCallsAccum = {}
        }
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
      let timeoutId = null

      // 设置超时（5分钟）
      timeoutId = setTimeout(() => {
        request.abort()
        reject(new Error('请求超时（5分钟）'))
      }, 300000)

      request.on('response', (response) => {
        // 检查 HTTP 状态码
        if (response.statusCode >= 400) {
          clearTimeout(timeoutId)
          let errorData = ''
          response.on('data', (chunk) => { errorData += chunk.toString() })
          response.on('end', () => {
            reject(new Error(`HTTP ${response.statusCode}: ${errorData || '请求失败'}`))
          })
          return
        }

        response.on('data', (chunk) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop()

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
              chunks.push(trimmed)
            }
          }
        })
        response.on('end', () => {
          clearTimeout(timeoutId)
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
        response.on('error', (err) => {
          clearTimeout(timeoutId)
          reject(err)
        })
      })

      request.on('error', (err) => {
        clearTimeout(timeoutId)
        reject(err)
      })

      for (const [k, v] of Object.entries(headers)) {
        request.setHeader(k, v)
      }
      request.write(body)
      request.end()
    })
  }
}

module.exports = LLMProvider
