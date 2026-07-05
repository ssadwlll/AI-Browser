// ============ ScratchpadService ============
// 中间推理持久化服务：类似 Devin 的 scratchpad 文件
// 功能：
//   1. 每轮结束后持久化 WorkingMemory.state 到 IndexedDB
//   2. 任务启动时恢复 scratchpad（支持断点续传）
//   3. 提供导出功能：下载为 .ai-browser/scratchpad.json 文件
// 数据结构：
//   {
//     sessionId: string,
//     timestamp: number,
//     state: { taskGoal, currentPage, discoveries, decisions, excluded, dataRefs, errors, stageHistory },
//     roundSummary: { round, stage, aiResponse, toolCalls, toolResults }
//   }

const DB_NAME = 'ai-browser-scratchpad'
const STORE_NAME = 'scratchpads'
const DB_VERSION = 1

export class ScratchpadService {
  constructor() {
    this._db = null
    this._currentSessionId = null
  }

  /**
   * 初始化 IndexedDB 连接
   */
  async init() {
    if (this._db) return this._db
    
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      
      request.onblocked = () => reject(new Error('DB 升级被其他标签页阻塞'))
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        this._db = request.result
        // 连接意外关闭时重置引用，下次调用会自动重连
        this._db.onclose = () => { this._db = null }
        this._db.onerror = (e) => { console.error('[ScratchpadService] DB 错误:', e.target.error) }
        resolve(this._db)
      }
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' })
          store.createIndex('timestamp', 'timestamp', { unique: false })
          store.createIndex('taskGoal', 'taskGoal', { unique: false })
        }
      }
    })
  }

  /**
   * 设置当前会话 ID
   */
  setSessionId(sessionId) {
    this._currentSessionId = sessionId
  }

  /**
   * 保存本轮中间推理到 scratchpad
   * @param {string} sessionId - 会话 ID
   * @param {object} workingMemoryState - WorkingMemory.state
   * @param {object} roundSummary - 本轮摘要 { round, stage, aiResponse, toolCalls, toolResults }
   */
  async save(sessionId, workingMemoryState, roundSummary) {
    await this.init()
    
    const scratchpad = {
      sessionId,
      timestamp: Date.now(),
      taskGoal: workingMemoryState?.taskGoal || '',
      state: workingMemoryState,
      lastRound: roundSummary,
      totalRounds: roundSummary?.round || 0,
    }
    
    return new Promise((resolve, reject) => {
      const transaction = this._db.transaction([STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.put(scratchpad)
      
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        console.log(`[ScratchpadService] 保存成功: sessionId=${sessionId}, round=${roundSummary?.round}`)
        resolve(scratchpad)
      }
    })
  }

  /**
   * 加载指定会话的 scratchpad（用于断点续传）
   */
  async load(sessionId) {
    await this.init()
    
    return new Promise((resolve, reject) => {
      const transaction = this._db.transaction([STORE_NAME], 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(sessionId)
      
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const scratchpad = request.result
        if (scratchpad) {
          console.log(`[ScratchpadService] 加载成功: sessionId=${sessionId}, rounds=${scratchpad.totalRounds}`)
        }
        resolve(scratchpad || null)
      }
    })
  }

  /**
   * 获取所有 scratchpad 列表（按时间倒序）
   */
  async list(limit = 20) {
    await this.init()
    
    return new Promise((resolve, reject) => {
      const transaction = this._db.transaction([STORE_NAME], 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const index = store.index('timestamp')
      const request = index.openCursor(null, 'prev')
      
      const results = []
      request.onerror = () => reject(request.error)
      request.onsuccess = (event) => {
        const cursor = event.target.result
        if (cursor && results.length < limit) {
          results.push(cursor.value)
          cursor.continue()
        } else {
          resolve(results)
        }
      }
    })
  }

  /**
   * 删除指定会话的 scratchpad
   */
  async delete(sessionId) {
    await this.init()
    
    return new Promise((resolve, reject) => {
      const transaction = this._db.transaction([STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.delete(sessionId)
      
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        console.log(`[ScratchpadService] 删除成功: sessionId=${sessionId}`)
        resolve()
      }
    })
  }

  /**
   * 导出当前 scratchpad 为 JSON 文件（模拟 .ai-browser/scratchpad.json）
   */
  async export(sessionId) {
    const scratchpad = await this.load(sessionId)
    if (!scratchpad) return null
    
    const json = JSON.stringify(scratchpad, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    // 30秒后自动释放 Blob URL，避免内存泄漏
    setTimeout(() => URL.revokeObjectURL(url), 30000)
    
    return {
      url,
      filename: `.ai-browser/scratchpad_${sessionId}.json`,
      content: scratchpad,
    }
  }

  /**
   * 导出所有 scratchpad（模拟 .ai-browser/ 目录）
   */
  async exportAll() {
    const list = await this.list(100)
    const exportData = {
      version: '1.0',
      exportedAt: Date.now(),
      scratchpads: list,
    }
    
    const json = JSON.stringify(exportData, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    // 30秒后自动释放 Blob URL，避免内存泄漏
    setTimeout(() => URL.revokeObjectURL(url), 30000)
    
    return {
      url,
      filename: `.ai-browser/scratchpads_all_${Date.now()}.json`,
      content: exportData,
    }
  }

  /**
   * 清空所有 scratchpad
   */
  async clear() {
    await this.init()
    
    return new Promise((resolve, reject) => {
      const transaction = this._db.transaction([STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.clear()
      
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        console.log('[ScratchpadService] 已清空所有 scratchpad')
        resolve()
      }
    })
  }
}