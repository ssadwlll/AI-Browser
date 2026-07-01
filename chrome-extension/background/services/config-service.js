// ============ ConfigService + StorageService ============

const DEFAULT_AI_CONFIG = {
  model: 'deepseek-v4-pro',
  temperature: 0.7,
  maxTokens: 4096,
  systemPrompt: '你是 AI Browser 助手，可以帮助用户分析网页内容、回答问题、编写代码和执行操作。',
}

const DEFAULT_SYNC_CONFIG = {
  serverUrl: 'http://localhost:3001',
  appKey: '',
  appSecret: '',
  syncInterval: 30,
  enabled: true,
}

// ============ 纯 JS HMAC-SHA256（兼容 HTTP 页面，不依赖 crypto.subtle） ============
// 算法：HMAC(K, m) = SHA256((K⊕opad) || SHA256((K⊕ipad) || m))
// 与 coze-proxy.php 服务端验证逻辑一致

function _strToBytes(str) {
  const arr = []
  for (let i = 0; i < str.length; i++) arr.push(str.charCodeAt(i) & 0xFF)
  return arr
}

/**
 * 纯 JS SHA-256，返回 32 字节原始数组
 * 基于 FIPS 180-4 / RFC 6234 参考实现
 */
function _sha256(msg) {
  const src = (typeof msg === 'string' ? _strToBytes(msg) : msg).slice()
  const bitLen = src.length * 8
  src.push(0x80)
  while ((src.length % 64) !== 56) src.push(0)
  for (let i = 56; i >= 0; i -= 8) src.push((bitLen / Math.pow(2, i)) & 0xff)

  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
  const rr = (n, d) => (n >>> d) | (n << (32 - d))

  for (let off = 0; off < src.length; off += 64) {
    const w = []
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4
      w[i] = (src[j] << 24) | (src[j+1] << 16) | (src[j+2] << 8) | src[j+3]
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rr(w[i-15],7) ^ rr(w[i-15],18) ^ (w[i-15]>>>3)
      const s1 = rr(w[i-2],17) ^ rr(w[i-2],19) ^ (w[i-2]>>>10)
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0
    }
    let [a,b,c,d,e,f,g,h] = H
    for (let i = 0; i < 64; i++) {
      const S1 = rr(e,6) ^ rr(e,11) ^ rr(e,25)
      const ch = (e&f) ^ (~e&g)
      const t1 = (h+S1+ch+K[i]+w[i]) | 0
      const S0 = rr(a,2) ^ rr(a,13) ^ rr(a,22)
      const maj = (a&b) ^ (a&c) ^ (b&c)
      const t2 = (S0+maj) | 0
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0
    }
    H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0
    H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0
  }
  return H.flatMap(v => [(v>>>24)&0xff, (v>>>16)&0xff, (v>>>8)&0xff, v&0xff])
}

/**
 * 纯 JS HMAC-SHA256，返回小写 hex 字符串
 */
function _hmacSha256(key, message) {
  const blockSize = 64
  let keyArr = typeof key === 'string' ? _strToBytes(key) : key.slice()
  if (keyArr.length > blockSize) keyArr = _sha256(keyArr)
  while (keyArr.length < blockSize) keyArr.push(0)
  const ipad = keyArr.map(b => b ^ 0x36)
  const opad = keyArr.map(b => b ^ 0x5c)
  const msgArr = typeof message === 'string' ? _strToBytes(message) : message
  const inner = _sha256(ipad.concat(msgArr))   // 返回原始字节数组
  return _sha256(opad.concat(inner)).map(b => b.toString(16).padStart(2, '0')).join('')
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

  async getSelectionToolsEnabled() {
    const data = await chrome.storage.local.get('selectionToolsEnabled')
    return data.selectionToolsEnabled !== false
  }

  async saveSelectionToolsEnabled(enabled) {
    await chrome.storage.local.set({ selectionToolsEnabled: enabled })
  }

  async getAgentConfig() {
    const data = await chrome.storage.local.get('agentConfig')
    return {
      maxRounds: 15,
      maxConsecutiveFails: 5,
      maxLowValue: 3,
      maxIdleText: 2,
      explorationLimit: 5,
      enableJudge: true,
      enablePlanning: true,
      debug: false,
      ...(data.agentConfig || {}),
    }
  }

  async saveAgentConfig(config) {
    const merged = { ...(await this.getAgentConfig()), ...config }
    await chrome.storage.local.set({ agentConfig: merged })
    return merged
  }

  /**
   * 获取 AppKey/AppSecret 认证信息
   */
  async getAppAuth() {
    const syncConfig = await this.getSyncConfig()
    return { appKey: syncConfig.appKey || '', appSecret: syncConfig.appSecret || '' }
  }

  /**
   * 生成签名请求头
   * 算法：HMAC-SHA256(appKey + timestamp, appSecret)，输出小写hex
   */
  async generateAuthHeaders(appKey, appSecret) {
    const headers = { 'Content-Type': 'application/json' }
    if (appKey && appSecret) {
      const timestamp = String(Math.floor(Date.now() / 1000))
      const message = appKey + timestamp
      headers['X-App-Key'] = appKey
      headers['X-Timestamp'] = timestamp
      headers['X-Sign'] = _hmacSha256(appSecret, message)
    }
    return headers
  }

  /**
   * 获取可用模型列表
   * 调用 GET {serverUrl}/api/ai-models/available（带签名认证）
   */
  async getAvailableModels() {
    const syncConfig = await this.getSyncConfig()
    const url = syncConfig.serverUrl.replace(/\/+$/, '') + '/api/ai-models/available'
    const headers = await this.generateAuthHeaders(syncConfig.appKey, syncConfig.appSecret)
    const res = await fetch(url, { method: 'GET', headers })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`获取模型列表失败: ${res.status} ${text.slice(0, 200)}`)
    }
    const json = await res.json()
    if (!json.success) {
      throw new Error(json.error || json.message || '获取模型列表失败')
    }
    return json.data
  }

  /**
   * 返回 AI 代理接口 URL
   */
  async getAIProxyUrl() {
    const syncConfig = await this.getSyncConfig()
    return syncConfig.serverUrl.replace(/\/+$/, '') + '/api/ai-proxy/chat'
  }

  /**
   * 获取 PDF 上传所需的 URL 与签名请求头（不含二进制内容）
   * 调用方在 sidepanel 上下文中直接用 File 对象 fetch 上传，
   * 避免 ArrayBuffer 经 chrome.runtime.sendMessage 传递导致内容丢失。
   * @returns {Promise<{url:string, headers:Object}>}
   */
  async getPdfUploadConfig() {
    const syncConfig = await this.getSyncConfig()
    const url = syncConfig.serverUrl.replace(/\/+$/, '') + '/api/ai-proxy/parse-pdf'
    const headers = await this.generateAuthHeaders(syncConfig.appKey, syncConfig.appSecret)
    // multipart 上传由 fetch 自动设置 Content-Type + boundary，移除默认的 JSON 头
    delete headers['Content-Type']
    return { url, headers }
  }

  // 图片上传配置：返回 url + 认证 headers，sidepanel 用 fetch 直传 File 对象
  async getImageUploadConfig() {
    const syncConfig = await this.getSyncConfig()
    const url = syncConfig.serverUrl.replace(/\/+$/, '') + '/api/ai-proxy/upload-image'
    const headers = await this.generateAuthHeaders(syncConfig.appKey, syncConfig.appSecret)
    delete headers['Content-Type']
    return { url, headers }
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
      // 带 attachments（图片/PDF）的消息强制保留，不受字符截断影响
      // 避免带图片的历史消息因 base64 体积大被丢弃，导致重开后图片消失
      if (msg.attachments && (msg.attachments.image || msg.attachments.pdf)) {
        keep.unshift(msg)
        continue
      }
      if (totalChars > MAX_CHARS && keep.length >= 2) break // 至少保留最后2条
      keep.unshift(msg)
    }
    await chrome.storage.local.set({ chatHistory: keep })
  }

  async clearChatHistory() {
    await chrome.storage.local.remove('chatHistory')
  }
}
