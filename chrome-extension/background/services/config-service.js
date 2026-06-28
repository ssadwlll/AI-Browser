// ============ ConfigService + StorageService ============

const DEFAULT_AI_CONFIG = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: 'qwen2.5:7b',
  temperature: 0.7,
  maxTokens: 16384,
  systemPrompt: '你是 AI Browser 助手，可以帮助用户分析网页内容、回答问题、编写代码和执行操作。',
}

const DEFAULT_SYNC_CONFIG = {
  serverUrl: 'http://localhost:3000',
  token: '',
  syncInterval: 30,
  enabled: true,
}

export class ConfigService {
  async getAIConfig() {
    const data = await chrome.storage.local.get('aiConfig')
    return { ...DEFAULT_AI_CONFIG, ...(data.aiConfig || {}) }
  }

  async saveAIConfig(config) {
    const merged = { ...DEFAULT_AI_CONFIG, ...config }
    await chrome.storage.local.set({ aiConfig: merged })
    return merged
  }

  async getSyncConfig() {
    const data = await chrome.storage.local.get('syncConfig')
    return { ...DEFAULT_SYNC_CONFIG, ...(data.syncConfig || {}) }
  }

  async saveSyncConfig(config) {
    const merged = { ...DEFAULT_SYNC_CONFIG, ...config }
    await chrome.storage.local.set({ syncConfig: merged })
    return merged
  }

  async getSidebarMode() {
    const data = await chrome.storage.local.get('sidebarMode')
    return data.sidebarMode || 'sidepanel'
  }

  async saveSidebarMode(mode) {
    await chrome.storage.local.set({ sidebarMode: mode })
  }

  async getSelectionToolsEnabled() {
    const data = await chrome.storage.local.get('selectionToolsEnabled')
    return data.selectionToolsEnabled !== false
  }

  async saveSelectionToolsEnabled(enabled) {
    await chrome.storage.local.set({ selectionToolsEnabled: enabled })
  }
}

export class StorageService {
  async get(key) {
    const data = await chrome.storage.local.get(key)
    return data[key]
  }

  async set(key, value) {
    await chrome.storage.local.set({ [key]: value })
  }

  async getChatHistory() {
    const data = await chrome.storage.local.get('chatHistory')
    return data.chatHistory || []
  }

  /**
   * 保存聊天历史，按 token 和条数双重截断
   * 中文约 1 字符 ≈ 1.5 token，目标控制在 ~8000 字符以内
   */
  async saveChatHistory(history) {
    const MAX_CHARS = 8000
    const MAX_ITEMS = 50
    let trimmed = history.slice(-MAX_ITEMS)
    // 从旧到新累加，超过阈值时丢弃旧消息
    let totalChars = 0
    const keep = []
    for (let i = trimmed.length - 1; i >= 0; i--) {
      const msg = trimmed[i]
      const charLen = (msg.content || '').length + (msg.role || '').length
      totalChars += charLen
      if (totalChars > MAX_CHARS && keep.length >= 2) break // 至少保留最后2条
      keep.unshift(msg)
    }
    await chrome.storage.local.set({ chatHistory: keep })
  }

  async clearChatHistory() {
    await chrome.storage.local.remove('chatHistory')
  }
}
