// ============ SidebarService + PageService ============

import { fetchWithTimeout } from '../../shared/utils.js'

export class SidebarService {
  // 关闭操作的版本号：用于取消过期的 setTimeout 回调，防止竞态
  _closeVersion = 0

  // 打开原生 sidePanel。返回是否成功（手势丢失时 chrome.sidePanel.open 会抛错）
  async open(tabId) {
    try {
      await chrome.sidePanel.open({ tabId })
      return true
    } catch (e) {
      console.warn('[SidebarService] open error:', e.message)
      return false
    }
  }

  async close(tabId) {
    // 递增版本号，使之前排队的 setTimeout 回调失效
    const myVersion = ++this._closeVersion
    try {
      await chrome.sidePanel.setOptions({ tabId, enabled: false })
      // 延迟恢复 enabled，但若期间有新的 close/open 调用则跳过
      setTimeout(() => {
        if (myVersion !== this._closeVersion) return  // 已被后续调用取代
        try {
          chrome.sidePanel.setOptions({ tabId, enabled: true }).catch(() => {})
        } catch (e) {
          console.warn('[SidebarService] restore enabled error:', e.message)
        }
      }, 100)
    } catch (e) {
      console.warn('[SidebarService] close error:', e.message)
    }
  }

  setupPanelBehavior() {
    try {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    } catch (e) {
      console.warn('[SidebarService] setPanelBehavior error:', e.message)
    }
  }
}

export class PageService {
  constructor(scriptService) {
    this.scriptService = scriptService
  }

  // 上报脚本使用统计到后端
  async reportScriptStats(scriptId, success, errorMsg, durationMs) {
    const configService = this.scriptService.configService
    const config = await configService.getSyncConfig()
    if (!config.serverUrl) return

    const auth = await configService.getAppAuth()
    const authHeaders = await configService.generateAuthHeaders(auth.appKey, auth.appSecret)

    try {
      await fetchWithTimeout(`${config.serverUrl}/api/scripts/${scriptId}/stats`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run',
          duration_ms: durationMs || 0,
          success,
          error_msg: errorMsg || null,
        }),
      }, 5000)
    } catch (e) {
      console.warn('[PageService] 上报统计失败:', e.message)
    }
  }

  async getContent() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) return null

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'extractPageContent',
      })
      return response?.data || null
    } catch (e) {
      console.warn('[PageService] getContent error:', e.message)
      return null
    }
  }

  async executeScript(code) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) throw new Error('No active tab')

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (scriptCode) => {
          try {
            new Function(scriptCode)()
            return undefined
          } catch (e) {
            return { __error: e.message }
          }
        },
        args: [code],
        world: 'MAIN',
      })
      const result = results[0]?.result
      if (result?.__error) {
        return { ok: false, error: result.__error }
      }
      // 脚本正常执行返回 undefined 时，统一为 null 避免下游 undefined 处理问题
      return { ok: true, result: result ?? null }
    } catch (e) {
      console.warn('[PageService] executeScript error:', e.message)
      return { ok: false, error: e.message }
    }
  }

  async injectToolboxScript(scriptId) {
    const startTime = Date.now()
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return { ok: false, error: 'No active tab' }

    const injectData = await this.scriptService.fetchInjectData(scriptId)
    if (!injectData?.code) return { ok: false, error: '无法获取脚本代码' }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (scriptCode) => {
          try {
            new Function(scriptCode)()
            return undefined
          } catch (e) {
            return { __error: e.message }
          }
        },
        args: [injectData.code],
        world: 'MAIN',
      })
      const result = results[0]?.result
      const durationMs = Date.now() - startTime
      
      if (result?.__error) {
        this.reportScriptStats(scriptId, false, result.__error, durationMs).catch(() => {})
        return { ok: false, error: result.__error }
      }
      
      this.reportScriptStats(scriptId, true, null, durationMs).catch(() => {})
      return { ok: true }
    } catch (e) {
      const durationMs = Date.now() - startTime
      this.reportScriptStats(scriptId, false, e.message, durationMs).catch(() => {})
      console.warn('[PageService] injectToolboxScript error:', e.message)
      return { ok: false, error: e.message }
    }
  }
}
