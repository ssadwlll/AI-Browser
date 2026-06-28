// ============ SidebarService + PageService ============

export class SidebarService {
  async open(tabId) {
    try {
      await chrome.sidePanel.open({ tabId })
    } catch (e) {
      console.warn('[SidebarService] open error:', e.message)
    }
  }

  async close(tabId) {
    try {
      await chrome.sidePanel.setOptions({ tabId, enabled: false })
      setTimeout(() => chrome.sidePanel.setOptions({ tabId, enabled: true }), 100)
    } catch (e) {
      console.warn('[SidebarService] close error:', e.message)
    }
  }

  async setMode(mode) {
    await chrome.storage.local.set({ sidebarMode: mode })
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
      return { ok: true, result }
    } catch (e) {
      console.warn('[PageService] executeScript error:', e.message)
      return { ok: false, error: e.message }
    }
  }

  async injectToolboxScript(scriptId) {
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
      if (result?.__error) {
        return { ok: false, error: result.__error }
      }
      return { ok: true }
    } catch (e) {
      console.warn('[PageService] injectToolboxScript error:', e.message)
      return { ok: false, error: e.message }
    }
  }
}
