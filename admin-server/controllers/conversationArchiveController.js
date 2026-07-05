const pool = require('../config/db')
const { success, error } = require('../utils/response')
const selectorFeedback = require('./selectorFeedbackController')
const embeddingService = require('../services/embeddingService')

/**
 * 对话归档控制器
 * 接收 Chrome 扩展上传的完整对话全景数据
 * 状态值统一规范：success / partial / failure / unknown（与 agent-judge verdict 对齐）
 */

/**
 * POST /api/conversation-archives
 * 上传一次任务的完整对话归档（由 Chrome 扩展调用，使用 appKey 鉴权）
 * Body: {
 *   taskId, sessionId?, userMessage, model?, totalRounds, totalToolCalls,
 *   status, durationMs, rounds (数组), summary?
 * }
 */
exports.upload = async (req, res) => {
  try {
    const {
      taskId, sessionId, userMessage, model,
      totalRounds, totalToolCalls, status, durationMs,
      rounds, summary,
    } = req.body || {}

    // 基础字段校验
    if (!taskId) return res.status(400).json(error('缺少 taskId'))
    if (!userMessage) return res.status(400).json(error('缺少 userMessage'))
    if (!Array.isArray(rounds)) return res.status(400).json(error('rounds 必须是数组'))

    // rounds_json 序列化（可能较大，限制 50MB）
    const roundsJson = JSON.stringify(rounds)
    if (roundsJson.length > 50 * 1024 * 1024) {
      return res.status(413).json(error('rounds 数据过大（>50MB），请减少轮次或精简数据'))
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''

    // 生成 embedding 向量（用于 RAG 向量语义检索）
    // embeddingText = userMessage + summary（含任务摘要，提高语义表达力）
    // 失败时降级为 null，不阻塞主流程
    let embeddingJson = null
    let embeddingText = null
    try {
      if (embeddingService.ready) {
        embeddingText = `${userMessage} ${summary || ''}`.trim()
        if (embeddingText.length > 0) {
          const vector = await embeddingService.embed(embeddingText)
          if (Array.isArray(vector) && vector.length > 0) {
            embeddingJson = JSON.stringify(vector)
          }
        }
      }
    } catch (e) {
      console.warn('[ConversationArchive] embedding 生成失败（非致命）:', e.message)
    }

    // 插入或更新（同 taskId 覆盖）
    await pool.query(
      `INSERT INTO conversation_archives
        (task_id, session_id, user_message, model, total_rounds, total_tool_calls,
         status, duration_ms, rounds_json, summary, client_ip, embedding, embedding_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         session_id = VALUES(session_id),
         user_message = VALUES(user_message),
         model = VALUES(model),
         total_rounds = VALUES(total_rounds),
         total_tool_calls = VALUES(total_tool_calls),
         status = VALUES(status),
         duration_ms = VALUES(duration_ms),
         rounds_json = VALUES(rounds_json),
         summary = VALUES(summary),
         client_ip = VALUES(client_ip),
         embedding = VALUES(embedding),
         embedding_text = VALUES(embedding_text)`,
      [
        taskId,
        sessionId || null,
        userMessage,
        model || null,
        parseInt(totalRounds) || 0,
        parseInt(totalToolCalls) || 0,
        status || 'unknown',
        parseInt(durationMs) || 0,
        roundsJson,
        summary || null,
        clientIp,
        embeddingJson,
        embeddingText,
      ]
    )

    return res.json(success({ taskId }, '对话归档已保存'))
  } catch (e) {
    console.error('[ConversationArchive] 上传失败:', e.message)
    return res.status(500).json(error('上传失败: ' + e.message))
  }
}

/**
 * GET /api/conversation-archives
 * 后台查询归档列表（JWT 鉴权）
 * Query: page, pageSize, keyword, status, model, start_date, end_date
 */
exports.list = async (req, res) => {
  try {
    const {
      page = 1, pageSize = 20,
      keyword, status, model, start_date, end_date,
    } = req.query

    const pageNum = Math.max(1, parseInt(page) || 1)
    const size = Math.min(100, Math.max(1, parseInt(pageSize) || 20))
    const offset = (pageNum - 1) * size

    const where = []
    const params = []
    if (keyword) {
      where.push('(user_message LIKE ? OR summary LIKE ? OR task_id LIKE ?)')
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
    }
    if (status) { where.push('status = ?'); params.push(status) }
    if (model) { where.push('model = ?'); params.push(model) }
    if (start_date) { where.push('DATE(created_at) >= ?'); params.push(start_date) }
    if (end_date) { where.push('DATE(created_at) <= ?'); params.push(end_date) }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''

    // 统计总数
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM conversation_archives ${whereSql}`,
      params
    )

    // 查询列表（不含 rounds_json，避免列表过大）
    const [rows] = await pool.query(
      `SELECT id, task_id, session_id, user_message, model, total_rounds,
              total_tool_calls, status, duration_ms, summary, client_ip, created_at
       FROM conversation_archives
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, size, offset]
    )

    return res.json(success({
      list: rows,
      total,
      page: pageNum,
      pageSize: size,
      totalPages: Math.ceil(total / size),
    }))
  } catch (e) {
    console.error('[ConversationArchive] 查询列表失败:', e.message)
    return res.status(500).json(error('查询失败: ' + e.message))
  }
}

/**
 * GET /api/conversation-archives/:taskId
 * 获取单个任务的完整对话归档（含 rounds_json）
 */
exports.detail = async (req, res) => {
  try {
    const { taskId } = req.params
    const [rows] = await pool.query(
      `SELECT * FROM conversation_archives WHERE task_id = ? LIMIT 1`,
      [taskId]
    )
    if (rows.length === 0) {
      return res.status(404).json(error('未找到该任务'))
    }
    const row = rows[0]
    // rounds_json 反序列化为对象
    let rounds = []
    try { rounds = JSON.parse(row.rounds_json || '[]') } catch {}
    return res.json(success({
      ...row,
      rounds_json: undefined,  // 不返回原始 JSON 字符串
      rounds,
    }))
  } catch (e) {
    console.error('[ConversationArchive] 查询详情失败:', e.message)
    return res.status(500).json(error('查询失败: ' + e.message))
  }
}

/**
 * DELETE /api/conversation-archives/:taskId
 * 删除单个任务归档
 */
exports.remove = async (req, res) => {
  try {
    const { taskId } = req.params
    const [result] = await pool.query(
      `DELETE FROM conversation_archives WHERE task_id = ?`,
      [taskId]
    )
    if (result.affectedRows === 0) {
      return res.status(404).json(error('未找到该任务'))
    }
    return res.json(success(null, '已删除'))
  } catch (e) {
    console.error('[ConversationArchive] 删除失败:', e.message)
    return res.status(500).json(error('删除失败: ' + e.message))
  }
}

/**
 * GET /api/conversation-archives/stats/summary
 * 统计概览：总数、成功率、平均耗时、平均轮次
 */
exports.stats = async (req, res) => {
  try {
    const [[row]] = await pool.query(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successCount,
         SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) as partialCount,
         SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) as failureCount,
         AVG(total_rounds) as avgRounds,
         AVG(duration_ms) as avgDurationMs,
         AVG(total_tool_calls) as avgToolCalls
       FROM conversation_archives`
    )
    const total = Number(row.total) || 0
    const successCount = Number(row.successCount) || 0
    // failed = 非成功的全部（partial + failure + unknown）
    const failed = total - successCount
    const result = {
      total,
      success: successCount,
      failed,
      partial: Number(row.partialCount) || 0,
      failure: Number(row.failureCount) || 0,
      avgRounds: Math.round(Number(row.avgRounds) || 0),
      avgDurationMs: Math.round(Number(row.avgDurationMs) || 0),
      avgToolCalls: Math.round(Number(row.avgToolCalls) || 0),
    }
    result.successRate = total > 0 ? Math.round((successCount / total) * 100) : 0
    return res.json(success(result))
  } catch (e) {
    console.error('[ConversationArchive] 统计失败:', e.message)
    return res.status(500).json(error('统计失败: ' + e.message))
  }
}

/**
 * POST /api/conversation-archives/rag
 * RAG 检索：从历史成功任务中提取可复用经验（由 Chrome 扩展调用，appKey 鉴权）
 * Body: { userMessage, pageUrl?, topK? }
 *
 * 策略（结构化过滤，零向量调用）：
 * 1. 从 userMessage 提取中文关键词（2-4字）
 * 2. 查询 status='success' 的历史任务，user_message LIKE 关键词
 * 3. 同域名加权（pageUrl 解析出的 host 命中则排前）
 * 4. 从 rounds_json 中提取成功工具调用模式（selector/script_name 等）
 * 5. 返回 top K 条经验摘要（不含完整 rounds，避免响应过大）
 */
exports.ragRetrieve = async (req, res) => {
  try {
    const { userMessage, pageUrl, topK } = req.body || {}
    if (!userMessage || typeof userMessage !== 'string') {
      return res.status(400).json(error('缺少 userMessage'))
    }
    const limit = Math.min(Math.max(parseInt(topK) || 5, 1), 10)

    // 1. 关键词提取：中文 2-4 字词组 + 英文单词
    const cnWords = (userMessage.match(/[\u4e00-\u9fff]{2,4}/g) || [])
    const enWords = (userMessage.toLowerCase().match(/[a-z]{3,}/g) || []).filter(w => !['the', 'and', 'for', 'with', 'from'].includes(w))
    const keywords = [...new Set([...cnWords, ...enWords])].slice(0, 6)

    if (keywords.length === 0) {
      return res.json(success({ matches: [], keywords, reason: 'no_keywords' }))
    }

    // 2. 构造 LIKE 条件（任一关键词命中即匹配，按命中数加权）
    const likeClauses = keywords.map(() => '(user_message LIKE ? OR summary LIKE ?)').join(' OR ')
    const likeParams = keywords.flatMap(k => [`%${k}%`, `%${k}%`])

    // 3. 解析 pageUrl 的 host（用于同域名加权）
    let pageHost = ''
    try {
      if (pageUrl) pageHost = new URL(pageUrl).hostname || ''
    } catch {}

    // 4. Stage 1 - SQL 关键词粗筛（status='success'，命中关键词，LIMIT 30 限制扫描量）
    //    同时拉取 embedding 字段供 Stage 2 向量精排使用
    const [rows] = await pool.query(
      `SELECT task_id, user_message, summary, model, total_rounds, total_tool_calls,
              duration_ms, rounds_json, created_at, embedding,
              (${keywords.map(() => '(user_message LIKE ? OR summary LIKE ?)').join(' + ')}) as hit_score
       FROM conversation_archives
       WHERE status = 'success'
         AND (${likeClauses})
       ORDER BY hit_score DESC, created_at DESC
       LIMIT 30`,
      [...likeParams, ...likeParams]
    )

    if (rows.length === 0) {
      return res.json(success({ matches: [], keywords, reason: 'no_match' }))
    }

    // 5. Stage 2 - 向量语义精排（混合评分：0.4*向量 + 0.3*关键词命中 + 0.3*同域名加权）
    //    若 embeddingService 不可用或所有候选都无 embedding，降级为纯关键词排序
    let rankedRows = rows
    let usedVectorRank = false
    if (embeddingService.ready && rows.some(r => r.embedding)) {
      try {
        // 计算查询向量（用 userMessage 提高任务意图的语义匹配度）
        const queryVector = await embeddingService.embed(userMessage)
        if (queryVector && queryVector.length > 0) {
          // 收集所有候选的 embedding（缺失时为 null）
          const scored = rows.map(row => {
            let vectorScore = 0
            if (row.embedding) {
              try {
                const vec = JSON.parse(row.embedding)
                vectorScore = embeddingService.cosineSimilarity(queryVector, vec)
              } catch { vectorScore = 0 }
            }
            const kwScore = Number(row.hit_score) || 0
            // 同域名加权（0 或 1）
            const domainBoost = (pageHost && row.user_message && row.user_message.includes(pageHost.split('.').slice(-2).join('.'))) ? 1 : 0
            // 混合评分：向量 0.4 + 关键词命中数归一化 0.3 + 同域名 0.3
            // 关键词命中数最多为 keywords.length*2（user_message + summary 各算一次），归一化到 [0,1]
            const kwNorm = keywords.length > 0 ? Math.min(1, kwScore / (keywords.length * 2)) : 0
            const finalScore = vectorScore * 0.4 + kwNorm * 0.3 + domainBoost * 0.3
            return { row, vectorScore, kwScore, kwNorm, domainBoost, finalScore }
          })
          scored.sort((a, b) => b.finalScore - a.finalScore)
          rankedRows = scored.map(s => ({
            ...s.row,
            _vectorScore: s.vectorScore,
            _finalScore: s.finalScore,
            _kwNorm: s.kwNorm,
            _domainBoost: s.domainBoost,
          }))
          usedVectorRank = true
          console.log(`[ConversationArchive] RAG 向量精排生效，top1 finalScore=${scored[0]?.finalScore.toFixed(3)}`)
        }
      } catch (e) {
        console.warn('[ConversationArchive] 向量精排失败，降级为关键词排序:', e.message)
      }
    }

    // 5. 从 rounds_json 提取可复用模式（基于 Stage 2 精排后的 rankedRows）
    const matches = []
    for (const row of rankedRows.slice(0, limit)) {
      let rounds = []
      try { rounds = JSON.parse(row.rounds_json || '[]') } catch {}

      // 提取工具调用模式
      const toolPatterns = {}  // toolName → [args...]
      const selectors = new Set()
      const scriptsUsed = new Set()
      let hasFinishTask = false

      for (const rd of rounds) {
        const toolCalls = rd?.response?.tool_calls || rd?.response?.toolCalls || []
        for (const tc of toolCalls) {
          const fnName = tc?.function?.name || tc?.name || ''
          let args = tc?.function?.arguments || tc?.arguments || ''
          if (typeof args === 'string') {
            try { args = JSON.parse(args) } catch {}
          }
          if (!toolPatterns[fnName]) toolPatterns[fnName] = []
          toolPatterns[fnName].push(args)

          // 收集选择器
          if (args && typeof args === 'object') {
            if (args.selector && typeof args.selector === 'string') selectors.add(args.selector)
            if (args.selectorHint && typeof args.selectorHint === 'string') selectors.add(args.selectorHint)
          }
          // 收集脚本 ID
          const scriptMatch = fnName.match(/^inject_script_(\d+)$/)
          if (scriptMatch) scriptsUsed.add(`脚本 #${scriptMatch[1]}`)
          if (fnName === 'finish_task') hasFinishTask = true
        }
      }

      // 同域名加权
      let domainBoost = 0
      if (pageHost) {
        const archiveHost = (() => {
          for (const rd of rounds) {
            const req = rd?.request?.messages || []
            for (const m of req) {
              const c = typeof m.content === 'string' ? m.content : ''
              const urlMatch = c.match(/https?:\/\/([^/\s]+)/)
              if (urlMatch) return urlMatch[1]
            }
          }
          return ''
        })()
        if (archiveHost && pageHost.includes(archiveHost.split('.').slice(-2).join('.'))) {
          domainBoost = 1
        }
      }

      matches.push({
        taskId: row.task_id,
        userMessage: row.user_message,
        summary: row.summary || '',
        model: row.model || '',
        totalRounds: row.total_rounds || 0,
        totalToolCalls: row.total_tool_calls || 0,
        durationMs: row.duration_ms || 0,
        hitScore: Number(row.hit_score) + domainBoost,
        // 向量精排分数（仅当 usedVectorRank 时有意义）
        vectorScore: usedVectorRank ? Number(row._vectorScore) || 0 : null,
        finalScore: usedVectorRank ? Number(row._finalScore) || 0 : null,
        domainBoost: domainBoost === 1,
        toolsUsed: Object.keys(toolPatterns),
        selectors: [...selectors].slice(0, 8),
        scriptsUsed: [...scriptsUsed],
        createdAt: row.created_at,
      })
    }

    // 6. 若 Stage 2 已生效，matches 已按 finalScore 排序；否则按 hitScore 排序
    if (!usedVectorRank) {
      matches.sort((a, b) => b.hitScore - a.hitScore || b.totalToolCalls - a.totalToolCalls)
    }
    const topMatches = matches.slice(0, limit)

    // 7. 关联选择器反馈状态：标注每个选择器是否已失效
    // 仅当有 pageHost 时才查询（避免无意义查询）
    let selectorStatusMap = new Map()
    if (pageHost) {
      try {
        selectorStatusMap = await selectorFeedback.queryByHost(pageHost)
      } catch (e) {
        console.warn('[ConversationArchive] RAG 查询选择器反馈失败（非致命）:', e.message)
      }
    }
    if (selectorStatusMap.size > 0) {
      for (const m of topMatches) {
        m.selectorFeedback = m.selectors.map(sel => {
          const st = selectorStatusMap.get(sel) || null
          return st ? {
            selector: sel,
            isStale: st.isStale,
            failCount: st.failCount,
            successCount: st.successCount,
            lastSuccessAt: st.lastSuccessAt,
            lastFailureAt: st.lastFailureAt,
          } : { selector: sel, isStale: false, failCount: 0, successCount: 0 }
        })
        // 标记失效选择器数量，便于客户端展示
        m.staleSelectorCount = m.selectorFeedback.filter(s => s.isStale).length
      }
    }

    return res.json(success({
      matches: topMatches,
      keywords,
      pageHost,
      totalCandidates: rows.length,
      usedVectorRank,
    }))
  } catch (e) {
    console.error('[ConversationArchive] RAG 检索失败:', e.message)
    return res.status(500).json(error('RAG 检索失败: ' + e.message))
  }
}
