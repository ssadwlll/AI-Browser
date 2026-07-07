// ============ 本地数据库服务（Electron 主进程版） ============
// 替代 IndexedDB，使用 JSON 文件持久化（每个 store 独立文件）
// 文件路径：path.join(app.getPath('userData'), 'db', `${storeName}.json`)
// 特性：内存缓存全量数据 + 防抖持久化
// 用于任务模板、工具调用录制、Agent 断点续传、定时任务等

const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const { safeJsonParse, safeJsonStringify } = require('./utils')

// 防抖写入间隔（毫秒）
const WRITE_DEBOUNCE_MS = 500

// 对象存储仓定义：每个 store 对应一类数据
// keyPath 为主键字段名，indexes 为索引列表
const STORES = {
  task_templates: {
    keyPath: 'id',
    indexes: [
      { name: 'category', keyPath: 'category' },
      { name: 'updatedAt', keyPath: 'updatedAt' },
    ],
  },
  tool_recordings: {
    keyPath: 'id',
    indexes: [
      { name: 'sessionId', keyPath: 'sessionId' },
      { name: 'timestamp', keyPath: 'timestamp' },
    ],
  },
  agent_snapshots: {
    keyPath: 'id',
    indexes: [
      { name: 'tabId', keyPath: 'tabId' },
      { name: 'createdAt', keyPath: 'createdAt' },
    ],
  },
  scheduled_tasks: {
    keyPath: 'id',
    indexes: [
      { name: 'nextRun', keyPath: 'nextRun' },
      { name: 'enabled', keyPath: 'enabled' },
    ],
  },
}

// 内存缓存：{ storeName: Map(key, record) }
const _cache = {}
// 防抖定时器：{ storeName: timerId }
const _timers = {}

/**
 * 获取数据库目录路径（延迟获取，app 可能尚未 ready）
 */
function getDbDir() {
  return path.join(app.getPath('userData'), 'db')
}

/**
 * 获取 store 文件路径
 */
function getStorePath(storeName) {
  return path.join(getDbDir(), `${storeName}.json`)
}

/**
 * 校验 storeName 是否合法
 */
function assertStore(storeName) {
  if (!STORES[storeName]) {
    throw new Error(`未知的 store: ${storeName}`)
  }
}

/**
 * 获取 store 的主键字段名
 */
function getKeyPath(storeName) {
  return STORES[storeName].keyPath
}

/**
 * 获取索引的 keyPath
 */
function getIndexKeyPath(storeName, indexName) {
  const idx = STORES[storeName].indexes.find((i) => i.name === indexName)
  if (!idx) throw new Error(`未知的索引: ${storeName}.${indexName}`)
  return idx.keyPath
}

/**
 * 原子写入：先写临时文件再 rename
 */
function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, filePath)
}

/**
 * 从文件加载 store 数据到内存缓存（仅首次访问时执行）
 * 文件格式为 JSON 数组，加载后转为 Map（以主键为 key）
 */
function loadStore(storeName) {
  if (_cache[storeName]) return _cache[storeName]

  const map = new Map()
  try {
    const filePath = getStorePath(storeName)
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8')
      const arr = safeJsonParse(raw, [])
      if (Array.isArray(arr)) {
        const keyPath = getKeyPath(storeName)
        for (const record of arr) {
          const key = record[keyPath]
          if (key !== undefined && key !== null) {
            map.set(key, record)
          }
        }
      }
    }
  } catch (e) {
    console.error(`[DB] 加载 store "${storeName}" 失败:`, e)
  }

  _cache[storeName] = map
  return map
}

/**
 * 防抖持久化：合并短时间内的多次写入为一次 IO
 */
function schedulePersist(storeName) {
  if (_timers[storeName]) clearTimeout(_timers[storeName])
  _timers[storeName] = setTimeout(() => {
    _timers[storeName] = null
    persistStore(storeName)
  }, WRITE_DEBOUNCE_MS)
}

/**
 * 立即持久化单个 store 到磁盘
 */
function persistStore(storeName) {
  try {
    const map = _cache[storeName]
    if (!map) return
    const arr = Array.from(map.values())
    const filePath = getStorePath(storeName)
    atomicWrite(filePath, safeJsonStringify(arr, null, 2))
  } catch (e) {
    console.error(`[DB] 持久化 store "${storeName}" 失败:`, e)
  }
}

// ============ 通用 CRUD ============

/**
 * 新增/更新一条记录（put 语义：存在则覆盖）
 * @param {string} storeName - 存储仓名
 * @param {object} record - 记录对象（必须包含主键字段）
 * @returns {Promise<object>} 写入的记录
 */
async function put(storeName, record) {
  assertStore(storeName)
  const map = loadStore(storeName)
  const keyPath = getKeyPath(storeName)
  const key = record[keyPath]
  if (key === undefined || key === null) {
    throw new Error(`记录缺少主键字段 "${keyPath}"`)
  }
  map.set(key, record)
  schedulePersist(storeName)
  return record
}

/**
 * 批量写入记录
 * @param {string} storeName - 存储仓名
 * @param {object[]} records - 记录数组
 * @returns {Promise<number>} 写入条数
 */
async function putBatch(storeName, records) {
  assertStore(storeName)
  const map = loadStore(storeName)
  const keyPath = getKeyPath(storeName)
  let count = 0
  for (const record of records) {
    const key = record[keyPath]
    if (key !== undefined && key !== null) {
      map.set(key, record)
      count++
    }
  }
  schedulePersist(storeName)
  return count
}

/**
 * 按主键获取单条记录
 * @param {string} storeName - 存储仓名
 * @param {*} key - 主键值
 * @returns {Promise<object|undefined>}
 */
async function get(storeName, key) {
  assertStore(storeName)
  const map = loadStore(storeName)
  return map.get(key)
}

/**
 * 获取全部记录
 * @param {string} storeName - 存储仓名
 * @returns {Promise<object[]>}
 */
async function getAll(storeName) {
  assertStore(storeName)
  const map = loadStore(storeName)
  return Array.from(map.values())
}

/**
 * 按主键删除
 * @param {string} storeName - 存储仓名
 * @param {*} key - 主键值
 * @returns {Promise<boolean>}
 */
async function del(storeName, key) {
  assertStore(storeName)
  const map = loadStore(storeName)
  const existed = map.delete(key)
  if (existed) schedulePersist(storeName)
  return true
}

/**
 * 清空 store 中的所有记录
 * @param {string} storeName - 存储仓名
 * @returns {Promise<boolean>}
 */
async function clear(storeName) {
  assertStore(storeName)
  const map = loadStore(storeName)
  map.clear()
  schedulePersist(storeName)
  return true
}

/**
 * 按索引查询（精确值匹配 + 排序）
 * @param {string} storeName - 存储仓名
 * @param {string} indexName - 索引名
 * @param {*} value - 精确匹配值
 * @param {number} limit - 最多返回条数，默认 100
 * @param {string} direction - 排序方向 'next'（正序）| 'prev'（倒序）
 * @returns {Promise<object[]>}
 */
async function queryByIndex(storeName, indexName, value, limit = 100, direction = 'next') {
  assertStore(storeName)
  const map = loadStore(storeName)
  const indexKeyPath = getIndexKeyPath(storeName, indexName)

  // 遍历全量数据，按索引值精确匹配
  const results = []
  for (const record of map.values()) {
    if (record[indexKeyPath] === value) {
      results.push(record)
    }
  }

  // 按索引字段排序
  results.sort((a, b) => {
    const av = a[indexKeyPath]
    const bv = b[indexKeyPath]
    if (av === bv) return 0
    const cmp = av < bv ? -1 : 1
    return direction === 'next' ? cmp : -cmp
  })

  return results.slice(0, limit)
}

/**
 * 生成唯一 ID
 * 格式：{时间戳}-{随机串}
 */
function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * 立即刷新所有 store 的待写入数据到磁盘
 */
function flush() {
  for (const storeName of Object.keys(_timers)) {
    if (_timers[storeName]) {
      clearTimeout(_timers[storeName])
      _timers[storeName] = null
    }
  }
  for (const storeName of Object.keys(_cache)) {
    persistStore(storeName)
  }
}

module.exports = {
  put,
  putBatch,
  get,
  getAll,
  del,
  clear,
  queryByIndex,
  genId,
  flush,
}
