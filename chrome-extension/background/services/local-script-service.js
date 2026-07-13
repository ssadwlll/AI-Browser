// ============ LocalScriptService ============
// 本地脚本管理：用户在编辑器中编写、保存的脚本，存储到 chrome.storage.local
// 支持：CRUD、URL 匹配自动注入、从工具箱手动触发执行

const LOCAL_SCRIPTS_KEY = 'local_scripts'

export class LocalScriptService {
  /**
   * 列出所有本地脚本
   * @returns {Promise<Array<{id, name, urlPattern, code, createdAt, updatedAt}>>}
   */
  async list() {
    const data = await chrome.storage.local.get(LOCAL_SCRIPTS_KEY)
    return data[LOCAL_SCRIPTS_KEY] || []
  }

  /**
   * 获取单个本地脚本
   * @param {string} id
   * @returns {Promise<{ok, script}?|null>}
   */
  async get(id) {
    const scripts = await this.list()
    const script = scripts.find(s => s.id === id)
    if (!script) return { ok: false, error: '脚本不存在' }
    return { ok: true, script }
  }

  /**
   * 保存本地脚本（新建或更新）
   * @param {object} data - { id?, name, urlPattern, code }
   * @returns {Promise<{ok, id?, error?}>}
   */
  async save(data) {
    if (!data || !data.name) return { ok: false, error: '缺少脚本名称' }
    if (!data.code || !data.code.trim()) return { ok: false, error: '缺少脚本代码' }

    const scripts = await this.list()
    const now = Date.now()

    if (data.id) {
      // 更新已有脚本
      const idx = scripts.findIndex(s => s.id === data.id)
      if (idx === -1) return { ok: false, error: '脚本不存在' }
      scripts[idx] = {
        ...scripts[idx],
        name: data.name,
        urlPattern: data.urlPattern || '*',
        code: data.code,
        updatedAt: now,
      }
      await this._save(scripts)
      return { ok: true, id: data.id }
    }

    // 新建脚本
    const id = 'local-' + now + '-' + Math.random().toString(36).slice(2, 7)
    const newScript = {
      id,
      name: data.name,
      urlPattern: data.urlPattern || '*',
      code: data.code,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }
    scripts.push(newScript)
    await this._save(scripts)
    return { ok: true, id }
  }

  /**
   * 删除本地脚本
   * @param {string} id
   * @returns {Promise<{ok}>}
   */
  async delete(id) {
    if (!id) return { ok: false, error: '缺少 id' }
    const scripts = await this.list()
    const filtered = scripts.filter(s => s.id !== id)
    await this._save(filtered)
    return { ok: true }
  }

  /**
   * 切换启用/禁用
   * @param {string} id
   * @param {boolean} enabled
   */
  async toggle(id, enabled) {
    const scripts = await this.list()
    const idx = scripts.findIndex(s => s.id === id)
    if (idx === -1) return { ok: false, error: '脚本不存在' }
    scripts[idx].enabled = !!enabled
    await this._save(scripts)
    return { ok: true }
  }

  /**
   * 获取匹配指定 URL 的本地脚本（用于自动注入）
   * @param {string} url
   * @returns {Promise<Array>}
   */
  async getMatchingScripts(url) {
    if (!url) return []
    const scripts = await this.list()
    return scripts.filter(s => s.enabled && this._matchUrl(s.urlPattern, url))
  }

  /**
   * 注入匹配 URL 的本地脚本到指定标签页
   * @param {number} tabId
   * @param {string} url
   */
  async injectMatchingScripts(tabId, url) {
    const scripts = await this.getMatchingScripts(url)
    for (const script of scripts) {
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
              console.error('[AI Browser 本地脚本] 注入错误:', e)
            }
          },
          args: [script.code],
          world: 'MAIN',
        })
        console.log('[LocalScriptService] 注入成功:', script.name)
      } catch (e) {
        console.warn('[LocalScriptService] 注入失败:', script.name, e.message)
      }
    }
  }

  /**
   * 导出所有本地脚本为 JSON
   */
  async exportAll() {
    const scripts = await this.list()
    return JSON.stringify({ version: '1.0', exportedAt: Date.now(), scripts }, null, 2)
  }

  /**
   * 从 JSON 导入本地脚本
   * @param {string} jsonStr
   */
  async importFromJson(jsonStr) {
    try {
      const data = JSON.parse(jsonStr)
      if (!data.scripts || !Array.isArray(data.scripts)) {
        return { ok: false, error: '无效的导入格式' }
      }
      const existing = await this.list()
      const now = Date.now()
      let imported = 0
      for (const s of data.scripts) {
        if (!s.name || !s.code) continue
        const id = 'local-' + (now + imported) + '-' + Math.random().toString(36).slice(2, 7)
        existing.push({
          id,
          name: s.name,
          urlPattern: s.urlPattern || '*',
          code: s.code,
          enabled: s.enabled !== false,
          createdAt: now,
          updatedAt: now,
        })
        imported++
      }
      await this._save(existing)
      return { ok: true, imported }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  // ============ 内部辅助 ============

  async _save(scripts) {
    await chrome.storage.local.set({ [LOCAL_SCRIPTS_KEY]: scripts })
  }

  /**
   * URL 匹配（与 ScriptService.matchUrl 逻辑一致）
   */
  _matchUrl(urlPattern, url) {
    if (!urlPattern || urlPattern === '*') return true
    const patterns = urlPattern.split(',').map(p => p.trim()).filter(Boolean)
    return patterns.some(pattern => {
      // 简单 glob 匹配：* 匹配任意字符
      const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // 转义特殊字符（保留 * 和 ?）
        .replace(/\*+/g, '.*')                   // * → .*
        .replace(/\?/g, '.')                      // ? → .
      try {
        return new RegExp('^' + regexStr + '$', 'i').test(url)
      } catch {
        return false
      }
    })
  }
}

console.log('[LocalScriptService] 本地脚本服务已加载')
