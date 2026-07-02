// ============ Agent 评判器 & 辅助函数 ============
// 结果自评、chatHistory 存储、标签页校验、经验记忆
import { isSystemUrl, safeJsonStringify, fetchWithTimeout } from '../../shared/utils.js'

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
      // 使用 safeJsonStringify 避免循环引用导致 JSON.stringify 崩溃
      const resultStr = typeof t.result === 'string' ? t.result : safeJsonStringify(t.result || '')
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
 * 使用统一的 isSystemUrl 判断，覆盖所有危险协议
 * （chrome://、edge://、about:、chrome-extension://、file://、view-source:、devtools:// 等）
 */
export async function getTargetTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab) return null
    const url = tab.url || ''
    if (isSystemUrl(url)) {
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
    
    // 上报使用统计到 usage_stats 表
    await fetchWithTimeout(`${config.serverUrl}/api/scripts/${scriptId}/stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        action: 'run',
        duration_ms: durationMs || 0,
        success,
        error_msg: (errorMessage || '').slice(0, 500) || null,
      }),
    }, 5000, 0).catch(() => {})
    
    // 上报记忆到 memories 表
    await fetchWithTimeout(`${config.serverUrl}/api/scripts/${scriptId}/memories`, {
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
    }, 10000, 0)
  } catch (e) {
    // memory 记录失败不影响主流程
  }
}
