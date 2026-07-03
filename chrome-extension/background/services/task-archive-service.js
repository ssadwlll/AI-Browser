// ============ TaskArchiveService ============
// 任务追溯复盘服务：整合 scratchpad 和 outputs，提供完整历史管理
// 功能：
//   1. 获取完整任务历史（scratchpad + outputs）
//   2. 任务复盘：分析成功/失败原因、工具调用统计、阶段切换记录
//   3. 任务对比：对比相似任务的执行路径
//   4. 导出任务归档：下载为 .ai-browser/archive/{taskId}_full.json

import { ScratchpadService } from './scratchpad-service.js'
import { OutputService } from './output-service.js'

export class TaskArchiveService {
  constructor() {
    this.scratchpadService = new ScratchpadService()
    this.outputService = new OutputService()
  }

  /**
   * 初始化所有服务
   */
  async init() {
    await this.scratchpadService.init()
    await this.outputService.init()
  }

  /**
   * 获取任务完整信息（scratchpad + output）
   */
  async getTaskFull(taskId) {
    await this.init()
    
    const output = await this.outputService.load(taskId)
    if (!output) return null
    
    // 尝试加载对应的 scratchpad
    const scratchpad = await this.scratchpadService.load(output.sessionId)
    
    return {
      output,
      scratchpad,
      // 复盘分析
      analysis: this.analyzeTask(output, scratchpad),
    }
  }

  /**
   * 分析任务执行情况（复盘）
   */
  analyzeTask(output, scratchpad) {
    const analysis = {
      // 基本统计
      totalRounds: output.conversationLog?.length || 0,
      durationMs: output.durationMs || 0,
      status: output.status || 'unknown',
      
      // 工具调用统计
      toolStats: {},
      toolSuccessRate: 0,
      
      // 阶段统计
      stageStats: {
        stage1: { rounds: 0, tools: 0 },
        stage2: { rounds: 0, tools: 0 },
        stage3: { rounds: 0, tools: 0 },
      },
      stageSwitchCount: 0,
      
      // 关键决策路径
      decisionPath: [],
      
      // 错误分析
      errors: [],
      errorRate: 0,
      
      // 数据产出分析
      dataOutputs: output.dataOutputs?.length || 0,
      dataRefCount: scratchpad?.state?.dataRefs?.length || 0,
    }
    
    // 分析对话记录
    if (output.conversationLog && output.conversationLog.length > 0) {
      let totalTools = 0
      let successTools = 0
      let totalErrors = 0
      
      for (const round of output.conversationLog) {
        // 阶段统计
        const stage = round.stage || 1
        analysis.stageStats[`stage${stage}`].rounds++
        
        // 工具统计
        if (round.toolResults && round.toolResults.length > 0) {
          analysis.stageStats[`stage${stage}`].tools += round.toolResults.length
          
          for (const result of round.toolResults) {
            totalTools++
            if (result.success) successTools++
            
            // 工具类型统计
            if (!analysis.toolStats[result.toolName]) {
              analysis.toolStats[result.toolName] = { count: 0, success: 0 }
            }
            analysis.toolStats[result.toolName].count++
            if (result.success) analysis.toolStats[result.toolName].success++
            
            // 错误收集
            if (!result.success) {
              totalErrors++
              analysis.errors.push({
                round: round.round,
                tool: result.toolName,
                preview: result.resultPreview,
              })
            }
          }
        }
        
        // 阶段切换统计
        if (round.stageSwitch) {
          analysis.stageSwitchCount++
        }
      }
      
      analysis.toolSuccessRate = totalTools > 0 
        ? Math.round((successTools / totalTools) * 100) 
        : 0
      analysis.errorRate = totalTools > 0 
        ? Math.round((totalErrors / totalTools) * 100) 
        : 0
    }
    
    // 从 WorkingMemory 提取决策路径
    if (scratchpad?.state?.decisions) {
      analysis.decisionPath = scratchpad.state.decisions.slice(0, 10)
    }
    
    return analysis
  }

  /**
   * 获取任务历史列表（简略版，用于快速浏览）
   */
  async getTaskHistory(limit = 30) {
    await this.init()
    
    const outputs = await this.outputService.list(limit)
    const scratchpads = await this.scratchpadService.list(limit)
    
    // 合并成历史列表
    const history = outputs.map(output => ({
      taskId: output.taskId,
      sessionId: output.sessionId,
      userMessage: output.userMessage?.slice(0, 100),
      startTime: output.startTime,
      endTime: output.endTime,
      durationMs: output.durationMs,
      status: output.status,
      summaryPreview: output.summary?.slice(0, 80),
      totalRounds: output.conversationLog?.length || 0,
      hasScratchpad: scratchpads.some(s => s.sessionId === output.sessionId),
    }))
    
    return history
  }

  /**
   * 搜索相似任务（用于对比分析）
   */
  async findSimilarTasks(userMessage, limit = 5) {
    await this.init()
    
    const outputs = await this.outputService.search(userMessage)
    
    // 计算相似度并排序
    const similar = outputs
      .map(output => ({
        taskId: output.taskId,
        sessionId: output.sessionId,
        userMessage: output.userMessage,
        status: output.status,
        durationMs: output.durationMs,
        similarity: this.calculateSimilarity(userMessage, output.userMessage),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
    
    return similar
  }

  /**
   * 计算文本相似度（简单版本，基于关键词匹配）
   */
  calculateSimilarity(text1, text2) {
    if (!text1 || !text2) return 0
    
    const words1 = text1.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    const words2 = text2.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    
    const intersection = words1.filter(w => words2.includes(w))
    const union = [...new Set([...words1, ...words2])]
    
    return intersection.length / union.length
  }

  /**
   * 对比两个任务的执行路径
   */
  async compareTasks(taskId1, taskId2) {
    const task1 = await this.getTaskFull(taskId1)
    const task2 = await this.getTaskFull(taskId2)
    
    if (!task1 || !task2) return null
    
    const comparison = {
      task1: { taskId: taskId1, analysis: task1.analysis },
      task2: { taskId: taskId2, analysis: task2.analysis },
      
      // 对比结果
      differences: {
        durationMs: task1.analysis.durationMs - task2.analysis.durationMs,
        rounds: task1.analysis.totalRounds - task2.analysis.totalRounds,
        successRate: task1.analysis.toolSuccessRate - task2.analysis.toolSuccessRate,
        errorRate: task1.analysis.errorRate - task2.analysis.errorRate,
      },
      
      // 共同点
      commonTools: this.findCommonTools(task1.analysis.toolStats, task2.analysis.toolStats),
      commonDecisions: this.findCommonDecisions(
        task1.scratchpad?.state?.decisions || [],
        task2.scratchpad?.state?.decisions || []
      ),
    }
    
    return comparison
  }

  /**
   * 找出共同使用的工具
   */
  findCommonTools(stats1, stats2) {
    const tools1 = Object.keys(stats1 || {})
    const tools2 = Object.keys(stats2 || {})
    return tools1.filter(t => tools2.includes(t))
  }

  /**
   * 找出共同决策
   */
  findCommonDecisions(decisions1, decisions2) {
    return decisions1.filter(d => 
      decisions2.some(d2 => d2.includes(d.slice(0, 20)))
    ).slice(0, 5)
  }

  /**
   * 导出完整任务归档（模拟 .ai-browser/archive/{taskId}_full.json）
   */
  async exportTaskArchive(taskId) {
    const taskFull = await this.getTaskFull(taskId)
    if (!taskFull) return null
    
    const archive = {
      version: '1.0',
      exportedAt: Date.now(),
      taskId: taskFull.output.taskId,
      sessionId: taskFull.output.sessionId,
      
      // 任务基本信息
      taskInfo: {
        userMessage: taskFull.output.userMessage,
        startTime: taskFull.output.startTime,
        endTime: taskFull.output.endTime,
        durationMs: taskFull.output.durationMs,
        status: taskFull.output.status,
        summary: taskFull.output.summary,
      },
      
      // 复盘分析
      analysis: taskFull.analysis,
      
      // 完整对话记录
      conversationLog: taskFull.output.conversationLog,
      
      // WorkingMemory 最终状态
      workingMemoryState: taskFull.scratchpad?.state || null,
      
      // 数据产出
      dataOutputs: taskFull.output.dataOutputs || [],
      
      // 事后自评
      judgeResult: taskFull.output.judgeResult || null,
    }
    
    const json = JSON.stringify(archive, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    
    return {
      url,
      filename: `.ai-browser/archive/${taskId}_full.json`,
      content: archive,
    }
  }

  /**
   * 导出所有任务归档
   */
  async exportAllArchives() {
    const history = await this.getTaskHistory(50)
    const stats = await this.outputService.getStats()
    
    const allArchives = {
      version: '1.0',
      exportedAt: Date.now(),
      stats,
      tasks: history,
    }
    
    const json = JSON.stringify(allArchives, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    
    return {
      url,
      filename: `.ai-browser/archive/all_tasks_${Date.now()}.json`,
      content: allArchives,
    }
  }

  /**
   * 清空所有任务归档
   */
  async clear() {
    await this.init()
    await this.scratchpadService.clear()
    await this.outputService.clear()
    console.log('[TaskArchiveService] 已清空所有任务归档')
  }

  /**
   * 删除指定任务的所有数据（scratchpad + output）
   */
  async deleteTask(taskId) {
    const output = await this.outputService.load(taskId)
    if (!output) return
    
    await this.outputService.delete(taskId)
    if (output.sessionId) {
      await this.scratchpadService.delete(output.sessionId)
    }
    console.log(`[TaskArchiveService] 已删除任务: ${taskId}`)
  }
}