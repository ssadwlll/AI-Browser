// ============ ScriptService ============
export class ScriptService {
  constructor(configService) {
    this.configService = configService
  }

  async getScripts() {
    const data = await chrome.storage.local.get('scripts')
    return data.scripts || []
  }

  async saveScripts(scripts) {
    await chrome.storage.local.set({ scripts, lastSync: Date.now() })
  }

  async syncScripts() {
    const config = await this.configService.getSyncConfig()
    if (!config.serverUrl || !config.token) {
      console.warn('[ScriptService] 未配置服务器地址或Token')
      await chrome.storage.local.set({ syncError: '未配置服务器地址或Token' })
      return { ok: false, error: '未配置' }
    }

    try {
      const res = await fetch(`${config.serverUrl}/api/scripts?pageSize=100`, {
        headers: { Authorization: `Bearer ${config.token}` },
      })
      if (!res.ok) {
        const text = await res.text()
        await chrome.storage.local.set({ syncError: `HTTP ${res.status}` })
        return { ok: false, error: `HTTP ${res.status}` }
      }
      const data = await res.json()
      if (data.success && Array.isArray(data.data)) {
        const oldScripts = await this.getScripts()
        const oldMap = {}
        for (const s of oldScripts) oldMap[s.id] = s.enabled

        const scripts = data.data.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description || '',
          version: s.version || '1.0.0',
          urlPattern: s.url_pattern || '*',
          category: s.category_name || '',
          downloadCount: s.download_count || 0,
          enabled: oldMap[s.id] !== undefined ? oldMap[s.id] : true,
          code: null,
          hasModules: s.module_count > 0,
        }))
        await this.saveScripts(scripts)
        await chrome.storage.local.set({ syncError: null })
        console.log('[ScriptService] 同步成功，', scripts.length, '个脚本')
        return { ok: true, count: scripts.length }
      }
      const errMsg = data.error || data.message || '同步失败'
      await chrome.storage.local.set({ syncError: errMsg })
      return { ok: false, error: errMsg }
    } catch (e) {
      console.error('[ScriptService] 同步异常:', e)
      await chrome.storage.local.set({ syncError: e.message })
      return { ok: false, error: e.message }
    }
  }

  async fetchInjectData(scriptId) {
    const config = await this.configService.getSyncConfig()
    if (!config.serverUrl) return null
    try {
      const res = await fetch(`${config.serverUrl}/api/scripts/${scriptId}/inject`, {
        headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
      })
      const data = await res.json()
      if (data.success && data.data) return data.data
    } catch (e) {
      console.error('[ScriptService] fetchInjectData error:', e)
    }
    return null
  }

  matchUrl(urlPattern, url) {
    if (!urlPattern || urlPattern === '*') return true
    const patterns = urlPattern.split(',').map(p => p.trim()).filter(Boolean)
    return patterns.some(pattern => {
      const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
      try { return new RegExp('^' + regexStr + '$').test(url) } catch { return false }
    })
  }

  async injectScriptsForTab(tabId, url) {
    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return
    const config = await this.configService.getSyncConfig()
    if (!config.enabled) return

    const scripts = await this.getScripts()
    const matched = scripts.filter(s => s.enabled && this.matchUrl(s.urlPattern, url))

    for (const script of matched) {
      const injectData = await this.fetchInjectData(script.id)
      if (!injectData?.code) continue

      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (scriptCode) => {
            try {
              const el = document.createElement('script')
              el.textContent = scriptCode
              ;(document.head || document.documentElement).appendChild(el)
              el.remove()
            } catch (e) {
              console.error('[AI Browser 脚本中心] 注入错误:', e)
            }
          },
          args: [injectData.code],
          world: 'MAIN',
        })
        console.log('[ScriptService] 注入成功:', injectData.name)
      } catch (e) {
        console.warn('[ScriptService] 注入失败:', e.message)
      }
    }
  }

  async toggleScript(scriptId, enabled) {
    const scripts = await this.getScripts()
    const idx = scripts.findIndex(s => s.id === scriptId)
    if (idx >= 0) {
      scripts[idx].enabled = enabled
      await this.saveScripts(scripts)
      return true
    }
    return false
  }

  async deleteScript(scriptId) {
    const scripts = await this.getScripts()
    const filtered = scripts.filter(s => s.id !== scriptId)
    await this.saveScripts(filtered)
    return true
  }
}
