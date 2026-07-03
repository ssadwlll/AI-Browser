// ============ OutputService ============
// 任务结果输出服务：类似 Devin 的 outputs 文件
// 功能：
//   1. 任务完成时持久化完整结果到 IndexedDB
//   2. 存储内容：对话记录 + 工具结果摘要 + 最终输出 + WorkingMemory 最终状态
//   3. 提供导出功能：下载为 .ai-browser/outputs/{taskId}.json 文件
// 数据结构：
//   {
//     taskId: string,
//     sessionId: string,
//     userMessage: string,
//     startTime: number,
//     endTime: number,
//     durationMs: number,
//     status: 'success' | 'partial' | 'failure',
//     summary: string,              // finish_task 的输出
//     conversationLog: [...],       // 完整对话记录
//     workingMemoryState: {...},    // WorkingMemory 最终状态
//     dataOutputs: [...],           // PayloadStore + GlobalDataStore 数据摘要
//     judgeResult: {...}            // 事后自评结果
//   }

const DB_NAME = 'ai-browser-outputs'
const STORE_NAME = 'outputs'
const DB_VERSION = 1

export class OutputService {
  constructor() {
    this._db = null
  }

  /**
   * 初始化 IndexedDB 连接
   */
  async init() {
    if (this._db) return this._db
    
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        this._db = request.result
        resolve(this._db)
      }
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'taskId' })
          store.createIndex('sessionId', 'sessionId', { unique: false })
          store.createIndex('startTime', 'startTime', { unique: false })
          store.createIndex('status', 'status', { unique: false })
        }
      }
    })
  }

  /**
   * 生成唯一任务 ID
   */
  generateTaskId() {
    return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * 保存任务输出
   * @param {object} taskOutput - 任务输出对象
   */
  async save(taskOutput) {
    await this.init()
    
    // 确保 taskId 存在
    if (!taskOutput.taskId) {
      taskOutput.taskId = this.generateTaskId()
    }
    
    // 计算耗时
    if (taskOutput.startTime && taskOutput.endTime) {
      taskOutput.durationMs = taskOutput.endTime - taskOutput.startTime
    }
    
    return new Promise((resolve, reject) => {
      const transaction = this._db.transaction([STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.put(taskOutput)
      
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        console.log(`[OutputService] 保存成功: taskId=${taskOutput.taskId}, status=${taskOutput.status}`)
        resolve(taskOutput)
      }
    })
  }

  /**
   * 加载指定任务的输出
   */
  async load(taskId) {
    await this.init()
    
    return new Promise((resolve, reject) => {
      const transaction = this._db.transaction([STORE_NAME], 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(taskId)
      
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const output = request.result
        if (output) {
          console.log(`[OutputService] 加载成功: taskId=${taskId}`)
        }
        resolve(output || null)
      }
    })
  }

  /**
   * 按会话 ID 加载所有任务输出
   */
  async loadBySession(sessionId) {
    await this.init()
    
    return new Promise((resolve, reject) => {
      const transaction = this._db.transaction([STORE_NAME], 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const index = store.index('sessionId')
      const request = index.getAll(sessionId)
      
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        resolve(request.result || [])
      }
    })
  }

  /**
   * 获取所有任务输出列表（按时间倒序）
   */
  async list(limit = 50) {
    await this.init()
    
    return new Promise((resolve, reject) => {
      const transaction = this._db.transaction([STORE_NAME], 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const index = store.index('startTime')
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
   * 获取任务统计信息
   */
  async getStats() {
    const list = await this.list(1000)
    
    const stats = {
      total: list.length,
      success: list.filter(t => t.status === 'success').length,
      partial: list.filter(t => t.status === 'partial').length,
      failure: list.filter(t => t.status === 'failure').length,
      avgDurationMs: list.length > 0 
        ? Math.round(list.reduce((sum, t) => sum + (t.durationMs || 0), 0) / list.length)
        : 0,
      totalRounds: list.reduce((sum, t) => sum + (t.conversationLog?.length || 0), 0),
    }
    
    return stats
  }

  /**
   * 删除指定任务的输出
   */
  async delete(taskId) {
    await this.init()
    
    return new Promise((resolve, reject) => {
      const transaction = this._db.transaction([STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.delete(taskId)
      
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        console.log(`[OutputService] 删除成功: taskId=${taskId}`)
        resolve()
      }
    })
  }

  /**
   * 导出指定任务为 JSON 文件（模拟 .ai-browser/outputs/{taskId}.json）
   */
  async export(taskId) {
    const output = await this.load(taskId)
    if (!output) return null
    
    const json = JSON.stringify(output, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    
    return {
      url,
      filename: `.ai-browser/outputs/${taskId}.json`,
      content: output,
    }
  }

  /**
   * 导出所有任务输出（模拟 .ai-browser/outputs/ 目录）
   */
  async exportAll() {
    const list = await this.list(100)
    const exportData = {
      version: '1.0',
      exportedAt: Date.now(),
      stats: await this.getStats(),
      outputs: list,
    }
    
    const json = JSON.stringify(exportData, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    
    return {
      url,
      filename: `.ai-browser/outputs_all_${Date.now()}.json`,
      content: exportData,
    }
  }

  /**
   * 搜索任务（按关键词）
   */
  async search(keyword) {
    const list = await this.list(100)
    const kw = keyword.toLowerCase()
    
    return list.filter(task => 
      task.userMessage?.toLowerCase().includes(kw) ||
      task.summary?.toLowerCase().includes(kw) ||
      task.taskId?.toLowerCase().includes(kw)
    )
  }

  /**
   * 清空所有任务输出
   */
  async clear() {
    await this.init()
    
    return new Promise((resolve, reject) => {
      const transaction = this._db.transaction([STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.clear()
      
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        console.log('[OutputService] 已清空所有任务输出')
        resolve()
      }
    })
  }
}