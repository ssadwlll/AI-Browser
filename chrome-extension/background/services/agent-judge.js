// ============ Agent 评判器 & 辅助函数 ============
// 任务复杂度评估、结果自评、chatHistory 存储、标签页校验、经验记忆

/**
 * 任务复杂度预评估：快速判断任务是否需要开发专用脚本
 */
export async function assessComplexity(configService, userMessage, chatHistory) {
  try {
    const config = await configService.getAIConfig()
    const url = await configService.getAIProxyUrl()
    const auth = await configService.getAppAuth()
    const headers = await configService.generateAuthHeaders(auth.appKey, auth.appSecret)

    const assessMessages = [
      {
        role: 'system',
        content: '你是一个任务复杂度评估器。分析用户请求，仅输出一行JSON，格式：{"level":"simple|medium|complex","estimatedRounds":数字,"needsScript":true|false}。评估标准：simple(≤5轮,单页面简单操作)、medium(6-12轮,多步骤单页面)、complex(13+轮,多页面/翻页/批量结构化提取)。needsScript=true表示任务最好用专用脚本而非DOM工具逐个操作。只输出JSON，不要任何解释。'
      },
      {
        role: 'user',
        content: `评估这个任务的复杂度：${userMessage}\n\n历史上下文摘要：${(chatHistory || []).slice(-3).map(m => `${m.role}: ${(m.content || '').slice(0, 100)}`).join(' | ')}`
      }
    ]

    const body = { model: config.model, messages: assessMessages, temperature: 0.1, max_tokens: 128 }
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
    clearTimeout(timeoutId)

    if (!res.ok) return { level: 'unknown', estimatedRounds: 0, needsScript: false }

    const data = await res.json()
    const text = data.choices?.[0]?.message?.content?.trim() || ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { level: 'unknown', estimatedRounds: 0, needsScript: false }

    const result = JSON.parse(jsonMatch[0])
    return {
      level: result.level || 'unknown',
      estimatedRounds: parseInt(result.estimatedRounds) || 0,
      needsScript: !!result.needsScript,
    }
  } catch (e) {
    console.log('[Agent] 复杂度评估失败（非致命）:', e.message)
    return { level: 'unknown', estimatedRounds: 0, needsScript: false }
  }
}

/**
 * 事后自评：对 Agent 执行结果进行快速评判
 */
export async function runJudge(configService, userMessage, agentSummary, executedTools) {
  try {
    const config = await configService.getAIConfig()
    const url = await configService.getAIProxyUrl()
    const auth = await configService.getAppAuth()
    const headers = await configService.generateAuthHeaders(auth.appKey, auth.appSecret)

    const toolSummary = executedTools.slice(0, 10).map(t => {
      const name = t.name || ''
      const resultStr = typeof t.result === 'string' ? t.result : JSON.stringify(t.result || '')
      return `${name}: ${resultStr.slice(0, 120)}`
    }).join('\n')

    const judgeMessages = [
      {
        role: 'system',
        content: '你是任务结果评判器。对比原始需求和Agent执行结果，判断任务完成度。仅输出一行JSON：{"verdict":"success|partial|failure","comment":"简短评语(20字内)"}。success=任务完全达成，partial=部分达成，failure=未达成。只输出JSON。',
      },
      {
        role: 'user',
        content: `原始需求：${userMessage}\n\nAgent结论：${agentSummary.slice(0, 500)}\n\n执行工具摘要：\n${toolSummary.slice(0, 1000)}`,
      },
    ]

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, messages: judgeMessages, temperature: 0.1, max_tokens: 128 }),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    if (!res.ok) return null
    const data = await res.json()
    const text = data.choices?.[0]?.message?.content?.trim() || ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    return JSON.parse(jsonMatch[0])
  } catch (e) {
    console.log('[Agent] Judge失败（非致命）:', e.message)
    return null
  }
}

/**
 * 统一入口：Agent 完成时写入 chatHistory
 */
export async function saveToChatHistoryStorage(content, toolCalls) {
  try {
    const historyData = await chrome.storage.local.get('chatHistory')
    const history = (historyData.chatHistory || []).slice()
    const lastMsg = history[history.length - 1]
    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content === content) {
      console.log('[Agent] chatHistory 已存在相同内容，跳过写入')
      return
    }
    const record = { role: 'assistant', content }
    if (toolCalls && toolCalls.length > 0) {
      record.toolCalls = toolCalls.map(t => ({ name: t.name, summary: String(t.result || '').slice(0, 200) }))
    }
    history.push(record)
    const MAX_CHARS = 8000, MAX_ITEMS = 50
    let trimmed = history.slice(-MAX_ITEMS)
    let totalChars = 0
    const keep = []
    for (let i = trimmed.length - 1; i >= 0; i--) {
      const m = trimmed[i]
      const charLen = (m.content || '').length + (m.role || '').length
      totalChars += charLen
      if (m.attachments && (m.attachments.image || m.attachments.pdf)) { keep.unshift(m); continue }
      if (totalChars > MAX_CHARS && keep.length >= 2) break
      keep.unshift(m)
    }
    await chrome.storage.local.set({ chatHistory: keep })
    console.log('[Agent] chatHistory 已写入 storage, 长度:', content.length)
  } catch (e) {
    console.error('[Agent] chatHistory 写入失败:', e)
  }
}

/**
 * 获取并校验目标标签页
 */
export async function getTargetTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab) return null
    const url = tab.url || ''
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://') || url.startsWith('about:')) {
      return null
    }
    return tab
  } catch {
    return null
  }
}

/**
 * 记录脚本执行经验记忆（异步，不阻塞主流程）
 */
export async function recordMemory(configService, scriptId, success, durationMs, errorMessage, resultSummary) {
  const config = await configService.getSyncConfig()
  if (!config?.serverUrl) return
  try {
    const auth = await configService.getAppAuth()
    const authHeaders = await configService.generateAuthHeaders(auth.appKey, auth.appSecret)
    await fetch(`${config.serverUrl}/api/scripts/${scriptId}/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        scriptId,
        sessionId: null,
        ok: success,
        durationMs,
        errorMessage: (errorMessage || '').slice(0, 500),
        resultSummary: (resultSummary || '').slice(0, 200),
      }),
    })
  } catch (e) {
    // memory 记录失败不影响主流程
  }
}
