// ============ IndexedDB 本地数据库服务 ============
// Feature 24: 提供结构化本地持久化存储
// 用于任务模板、工具调用录制、Agent 断点续传、定时任务等

const DB_NAME = 'ai-browser-db'
const DB_VERSION = 1

// 对象存储仓定义：每个 store 对应一类数据
const STORES = {
  task_templates: { keyPath: 'id', indexes: [{ name: 'category', keyPath: 'category' }, { name: 'updatedAt', keyPath: 'updatedAt' }] },
  tool_recordings: { keyPath: 'id', indexes: [{ name: 'sessionId', keyPath: 'sessionId' }, { name: 'timestamp', keyPath: 'timestamp' }] },
  agent_snapshots: { keyPath: 'id', indexes: [{ name: 'tabId', keyPath: 'tabId' }, { name: 'createdAt', keyPath: 'createdAt' }] },
  scheduled_tasks: { keyPath: 'id', indexes: [{ name: 'nextRun', keyPath: 'nextRun' }, { name: 'enabled', keyPath: 'enabled' }] },
}

let _dbInstance = null

/**
 * 打开/初始化数据库连接
 * 使用单例模式避免重复打开
 */
function openDB() {
  if (_dbInstance) return Promise.resolve(_dbInstance)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = (event) => {
      const db = event.target.result
      for (const [storeName, config] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(storeName)) {
          const store = db.createObjectStore(storeName, { keyPath: config.keyPath })
          if (config.indexes) {
            for (const idx of config.indexes) {
              store.createIndex(idx.name, idx.keyPath, { unique: false })
            }
          }
        }
      }
    }

    req.onsuccess = (event) => {
      _dbInstance = event.target.result
      // 连接意外关闭时重置单例
      _dbInstance.onclose = () => { _dbInstance = null }
      _dbInstance.onerror = (e) => { console.error('[DB] 数据库错误:', e.target.error) }
      resolve(_dbInstance)
    }

    req.onerror = (event) => {
      console.error('[DB] 打开数据库失败:', event.target.error)
      reject(event.target.error)
    }
  })
}

/**
 * 事务辅助：在指定 store 上执行操作
 */
async function withTx(storeName, mode, fn) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const store = tx.objectStore(storeName)
    let result
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
    const req = fn(store)
    if (req) {
      req.onsuccess = () => { result = req.result }
    }
  })
}

// ============ 通用 CRUD ============

/**
 * 新增/更新一条记录（put 语义：存在则覆盖）
 */
async function put(storeName, record) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).put(record)
    tx.oncomplete = () => resolve(record)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * 批量写入
 */
async function putBatch(storeName, records) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    for (const r of records) store.put(r)
    tx.oncomplete = () => resolve(records.length)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * 按 key 获取
 */
async function get(storeName, key) {
  return withTx(storeName, 'readonly', (store) => store.get(key))
}

/**
 * 获取全部记录
 */
async function getAll(storeName) {
  return withTx(storeName, 'readonly', (store) => store.getAll())
}

/**
 * 按 key 删除
 */
async function del(storeName, key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).delete(key)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * 清空 store
 */
async function clear(storeName) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).clear()
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * 按索引查询（支持范围）
 * @param {string} storeName - 存储仓名
 * @param {string} indexName - 索引名
 * @param {*} value - 精确值或 IDBRange
 * @param {number} limit - 最多返回条数
 * @param {string} direction - 遍历方向 'next' | 'prev'
 */
async function queryByIndex(storeName, indexName, value, limit = 100, direction = 'next') {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const store = tx.objectStore(storeName)
    const index = store.index(indexName)
    const range = value instanceof IDBKeyRange ? value : IDBKeyRange.only(value)
    const results = []
    const req = index.openCursor(range, direction)
    req.onsuccess = (e) => {
      const cursor = e.target.result
      if (cursor && results.length < limit) {
        results.push(cursor.value)
        cursor.continue()
      } else {
        resolve(results)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

// ============ 导出 ============

export const DBService = {
  put,
  putBatch,
  get,
  getAll,
  del,
  clear,
  queryByIndex,
  // 生成唯一 ID
  genId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  },
}

console.log('[DB] IndexedDB 服务已加载')
