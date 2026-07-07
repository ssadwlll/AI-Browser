// ============ 存储服务（Electron 主进程版） ============
// 替代 chrome.storage.local，使用 JSON 文件持久化
// 文件路径：path.join(app.getPath('userData'), 'storage.json')
// 特性：内存缓存 + 防抖写入 + 串行化锁（防止并发读-改-写）

const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const { safeJsonParse, safeJsonStringify } = require('./utils')

// 防抖写入间隔（毫秒）：避免频繁 IO
const WRITE_DEBOUNCE_MS = 500

// 内存缓存：首次访问时从文件加载
let _cache = null
// 串行化锁：所有写操作排队执行，防止并发读-改-写
let _writeChain = Promise.resolve()
// 防抖定时器
let _writeTimer = null

/**
 * 获取存储文件路径（延迟获取，app 可能尚未 ready）
 */
function getStoragePath() {
  return path.join(app.getPath('userData'), 'storage.json')
}

/**
 * 原子写入：先写临时文件再 rename，避免写入过程中崩溃导致文件损坏
 */
function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, filePath)
}

/**
 * 从文件加载到内存缓存（仅首次调用时执行，后续直接返回缓存）
 */
function load() {
  if (_cache !== null) return _cache
  try {
    const filePath = getStoragePath()
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8')
      _cache = safeJsonParse(raw, {})
      if (_cache === null || typeof _cache !== 'object' || Array.isArray(_cache)) {
        _cache = {}
      }
    } else {
      _cache = {}
    }
  } catch (e) {
    console.error('[StorageService] 加载存储文件失败:', e)
    _cache = {}
  }
  return _cache
}

/**
 * 防抖持久化：合并短时间内的多次写入为一次 IO
 */
function schedulePersist() {
  if (_writeTimer) clearTimeout(_writeTimer)
  _writeTimer = setTimeout(() => {
    _writeTimer = null
    persistNow()
  }, WRITE_DEBOUNCE_MS)
}

/**
 * 立即持久化到磁盘
 */
function persistNow() {
  try {
    const filePath = getStoragePath()
    atomicWrite(filePath, safeJsonStringify(_cache || {}, null, 2))
  } catch (e) {
    console.error('[StorageService] 持久化失败:', e)
  }
}

/**
 * 串行化执行：将操作加入写链排队，确保读-改-写的原子性
 */
function serialize(fn) {
  const run = () => fn()
  _writeChain = _writeChain.then(run, run)
  return _writeChain
}

// ============ 通用键值操作 ============

/**
 * 读取单个 key
 */
async function get(key) {
  const data = load()
  return data[key]
}

/**
 * 写入单个 key（串行化，防抖持久化）
 */
async function set(key, value) {
  return serialize(() => {
    const data = load()
    data[key] = value
    schedulePersist()
  })
}

/**
 * 删除 key（串行化，防抖持久化）
 */
async function remove(key) {
  return serialize(() => {
    const data = load()
    delete data[key]
    schedulePersist()
  })
}

// ============ 聊天历史管理 ============

/**
 * 读取聊天历史
 */
async function getChatHistory() {
  const data = load()
  return data.chatHistory || []
}

/**
 * 保存聊天历史，按 token 和条数双重截断
 * 中文约 1 字符 ≈ 1.5 token，目标控制在 ~8000 字符以内
 * 带 attachments（图片/PDF）的消息强制保留，不受字符截断影响
 */
async function saveChatHistory(history) {
  const MAX_CHARS = 8000
  const MAX_ITEMS = 50

  return serialize(() => {
    const data = load()
    let trimmed = (history || []).slice(-MAX_ITEMS)

    // 从新到旧累加字符数，超过阈值时丢弃旧消息
    let totalChars = 0
    const keep = []
    for (let i = trimmed.length - 1; i >= 0; i--) {
      const msg = trimmed[i]
      const charLen = (msg.content || '').length + (msg.role || '').length
      totalChars += charLen

      // 带 attachments 的消息强制保留，不受字符截断影响
      // 避免 base64 体积大的图片消息被丢弃，导致重开后图片消失
      if (msg.attachments && (msg.attachments.image || msg.attachments.pdf)) {
        keep.unshift(msg)
        continue
      }
      if (totalChars > MAX_CHARS && keep.length >= 2) break // 至少保留最后 2 条
      keep.unshift(msg)
    }

    data.chatHistory = keep
    schedulePersist()
  })
}

/**
 * 清空聊天历史
 */
async function clearChatHistory() {
  return serialize(() => {
    const data = load()
    delete data.chatHistory
    schedulePersist()
  })
}

/**
 * 立即刷新所有待写入数据到磁盘（应用退出前可调用）
 */
function flush() {
  if (_writeTimer) {
    clearTimeout(_writeTimer)
    _writeTimer = null
  }
  persistNow()
}

module.exports = {
  get,
  set,
  remove,
  getChatHistory,
  saveChatHistory,
  clearChatHistory,
  flush,
}
