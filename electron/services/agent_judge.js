// ============ Agent 评判器 & 辅助函数（Electron 主进程版） ============
// 迁移自 chrome-extension/background/services/agent-judge.js
// 结果自评、chatHistory 存储、标签页校验、经验记忆
// 改动：
//   - ES Module → CommonJS (module.exports / require)
//   - chrome.storage.local → StorageService
//   - chrome.tabs API → tabManager（BrowserView）
//   - fetch + AbortController → fetchWithTimeout
//   - isSystemUrl 内联实现（Electron utils.js 暂未导出）

const { fetchWithTimeout, safeJsonStringify } = require('./utils')
const StorageService = require('./storage_service')

/**
 * 判断是否为系统 URL（chrome/edge/about 等危险协议）
 * 覆盖所有危险协议：chrome://、edge://、about:、chrome-extension://、
 * file://、view-source:、devtools://、chrome-search: 等
 * 迁移自 chrome-extension/shared/utils.js 的 isSystemUrl
 */
function isSystemUrl(url) {
  if (!url || typeof url !== 'string') return true
  return /^(chrome|edge|about|chrome-extension|view-source|devtools|chrome-search|file):/i.test(url)
}

/**
 * 事后自评：对 Agent 执行结果进行快速评判
 * 调用 LLM 判断 success/partial/failure，temperature=0.1, max_tokens=128, 超时10秒
 * 用正则提取 JSON，失败返回 null
 * @param {object} configService - ConfigService 实例
 * @param {string} userMessage - 原始用户需求
 * @param {string} agentSummary - Agent 的完成摘要
 * @param {Array} executedTools - 已执行的工具列表 [{name, result}]
 * @returns {Promise<object|null>} {verdict, comment} 或 null
 */
async function runJudge(configService, userMessage, agentSummary, executedTools) {
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

    // 使用 fetchWithTimeout 替代手写 AbortController，超时 10 秒
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          messages: judgeMessages,
          temperature: 0.1,
          max_tokens: 128,
        }),
      },
      10000
    )

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
 * 去重（与最后一条 assistant 消息内容相同则跳过）+ 截断（委托 StorageService）
 * @param {string} content - 助手回复内容
 * @param {Array} toolCalls - 工具调用列表 [{name, result}]
 */
async function saveToChatHistoryStorage(content, toolCalls, options = {}) {
  try {
    const { fullDataMode = false } = options
    const history = await StorageService.getChatHistory()
    const lastMsg = history[history.length - 1]
    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content === content) {
      console.log('[Agent] chatHistory 已存在相同内容，跳过写入')
      return
    }
    const record = { role: 'assistant', content }
    if (toolCalls && toolCalls.length > 0) {
      record.toolCalls = toolCalls.map(t => ({
        name: t.name,
        // 全量模式：保存完整工具结果；摘要模式：仅 200 字符摘要
        summary: fullDataMode
          ? String(t.result || '').slice(0, 50000)
          : String(t.result || '').slice(0, 200),
      }))
    }
    history.push(record)
    // 委托 StorageService.saveChatHistory 做条数(50)/字符(8000)双重截断
    // 全量模式下放宽字符上限以保留完整工具结果
    // 带 attachments 的消息会被强制保留
    if (fullDataMode) {
      await StorageService.saveChatHistory(history, { maxChars: 100000, maxItems: 50 })
    } else {
      await StorageService.saveChatHistory(history)
    }
    console.log(`[Agent] chatHistory 已写入 storage, 长度: ${content.length}, fullDataMode: ${fullDataMode}`)
  } catch (e) {
    console.error('[Agent] chatHistory 写入失败:', e)
  }
}

/**
 * 获取并校验目标标签页（Electron 版）
 * 通过 tabManager 获取 BrowserView，排除系统 URL
 * 覆盖所有危险协议（chrome://、edge://、about:、chrome-extension://、file:// 等）
 * @param {object} tabManager - TabManager 实例
 * @param {number} tabId - 标签页 ID
 * @returns {Promise<object|null>} 标签页对象（含 id/url/browserView）或 null
 */
async function getTargetTab(tabManager, tabId) {
  try {
    const tab = tabManager.tabs.get(tabId)
    if (!tab) return null
    const browserView = tab.browserView
    if (!browserView) return null
    const webContents = browserView.webContents
    if (!webContents || webContents.isDestroyed()) return null
    // 从 webContents 获取实时 URL（比 tab.url 更准确）
    const url = webContents.getURL() || ''
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
 * 上报使用统计到 usage_stats 表 + 记忆到 memories 表
 * @param {object} configService - ConfigService 实例
 * @param {string} scriptId - 脚本 ID
 * @param {boolean} success - 是否成功
 * @param {number} durationMs - 执行耗时（毫秒）
 * @param {string} errorMessage - 错误信息
 * @param {string} resultSummary - 结果摘要
 */
async function recordMemory(configService, scriptId, success, durationMs, errorMessage, resultSummary) {
  const config = await configService.getSyncConfig()
  if (!config?.serverUrl) return
  try {
    const auth = await configService.getAppAuth()
    const authHeaders = await configService.generateAuthHeaders(auth.appKey, auth.appSecret)
    const baseUrl = String(config.serverUrl).replace(/\/+$/, '')

    // 上报使用统计到 usage_stats 表
    await fetchWithTimeout(
      `${baseUrl}/api/scripts/${scriptId}/stats`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          action: 'run',
          duration_ms: durationMs || 0,
          success,
          error_msg: (errorMessage || '').slice(0, 500) || null,
        }),
      },
      5000,
      0
    ).catch(() => {})

    // 上报记忆到 memories 表
    await fetchWithTimeout(
      `${baseUrl}/api/scripts/${scriptId}/memories`,
      {
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
      },
      10000,
      0
    )
  } catch (e) {
    // memory 记录失败不影响主流程
  }
}

module.exports = {
  runJudge,
  saveToChatHistoryStorage,
  getTargetTab,
  recordMemory,
}
