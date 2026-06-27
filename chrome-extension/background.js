// AI Browser 脚本中心 - Background Service Worker

// 默认配置
const DEFAULT_CONFIG = {
  serverUrl: 'http://localhost:3001',
  token: '',
  syncInterval: 30, // 分钟
  enabled: true,
}

// ============ 脚本同步 ============

async function getConfig() {
  const data = await chrome.storage.local.get('config')
  return { ...DEFAULT_CONFIG, ...(data.config || {}) }
}

async function getScripts() {
  const data = await chrome.storage.local.get('scripts')
  return data.scripts || []
}

async function saveScripts(scripts) {
  await chrome.storage.local.set({ scripts, lastSync: Date.now() })
}

// 从管理后台同步脚本列表
async function syncScripts() {
  const config = await getConfig()
  if (!config.serverUrl || !config.token) {
    console.warn('[AI Browser] 未配置服务器地址或Token，跳过同步')
    return
  }

  try {
    console.log('[AI Browser] 开始同步脚本列表...')
    const res = await fetch(`${config.serverUrl}/api/scripts?pageSize=100`, {
      headers: { Authorization: `Bearer ${config.token}` },
    })
    if (!res.ok) {
      const text = await res.text()
      console.error('[AI Browser] 同步HTTP错误:', res.status, text)
      await chrome.storage.local.set({ syncError: `HTTP ${res.status}` })
      return
    }
    const data = await res.json()
    if (data.success && Array.isArray(data.data)) {
      // 合并：保留本地的 enabled 状态
      const oldScripts = await getScripts()
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
        code: null, // Will be fetched via inject endpoint
        hasModules: s.module_count > 0,
      }))
      await saveScripts(scripts)
      await chrome.storage.local.set({ syncError: null })
      console.log('[AI Browser] 同步成功，获取', scripts.length, '个脚本')
    } else {
      const errMsg = data.error || data.message || '同步失败'
      console.warn('[AI Browser] 同步失败:', errMsg)
      await chrome.storage.local.set({ syncError: errMsg })
    }
  } catch (e) {
    console.error('[AI Browser] 同步异常:', e)
    await chrome.storage.local.set({ syncError: e.message })
  }
}

// 获取脚本注入数据（包含拼接后的模块代码 + 参数注入）
async function fetchInjectData(scriptId) {
  const config = await getConfig()
  if (!config.serverUrl || !config.token) return null

  try {
    const res = await fetch(`${config.serverUrl}/api/scripts/${scriptId}/inject`, {
      headers: { Authorization: `Bearer ${config.token}` },
    })
    const data = await res.json()
    if (data.success && data.data) {
      console.log('[AI Browser] 获取脚本注入数据成功:', data.data.name, 'code length:', (data.data.code || '').length)
      return data.data  // { id, name, url_pattern, params, params_schema, code }
    } else {
      console.warn('[AI Browser] 获取脚本注入数据失败:', data.error || data.message)
    }
  } catch (e) {
    console.error('[AI Browser] 获取脚本注入数据异常:', e)
  }
  return null
}

// ============ 脚本注入 ============

// URL 匹配检查
function matchUrl(urlPattern, url) {
  if (!urlPattern || urlPattern === '*') return true
  const patterns = urlPattern.split(',').map(p => p.trim()).filter(Boolean)
  return patterns.some(pattern => {
    // 将通配符模式转为正则
    // 支持格式：*://example.com*/path/*  (注意 host 后面的 * 可以匹配端口)
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    try {
      return new RegExp('^' + regexStr + '$').test(url)
    } catch {
      return false
    }
  })
}

// 向指定 tab 注入匹配的脚本
async function injectScriptsForTab(tabId, url) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return

  const config = await getConfig()
  if (!config.enabled) return

  const scripts = await getScripts()
  const matchedScripts = scripts.filter(s => s.enabled && matchUrl(s.urlPattern, url))
  console.log('[AI Browser] 检查页面:', url, '匹配脚本数:', matchedScripts.length)

  for (const script of matchedScripts) {
    // Fetch inject data (includes concatenated modules + params)
    const injectData = await fetchInjectData(script.id)
    if (!injectData || !injectData.code) {
      console.warn('[AI Browser] 脚本', script.name, '(ID:', script.id, ') 无注入代码')
      continue
    }

    console.log('[AI Browser] 注入脚本:', injectData.name, '代码长度:', injectData.code.length)

    // Inject the complete code (params + all modules concatenated)
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (scriptCode) => {
          try {
            // Use script element injection (more CSP-friendly than new Function)
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
      console.log('[AI Browser] 脚本', injectData.name, '注入成功')
    } catch (e) {
      console.warn('[AI Browser] 脚本注入失败(可能受限制页面):', e.message)
    }
  }
}

// ============ 事件监听 ============

// 页面加载完成时注入脚本
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    injectScriptsForTab(tabId, tab.url)
  }
})

// 扩展安装/启动时同步脚本
chrome.runtime.onInstalled.addListener(() => {
  syncScripts()
})

// 定时同步
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync-scripts') {
    syncScripts()
  }
})

// 设置定时器
async function setupAlarm() {
  const config = await getConfig()
  chrome.alarms.clear('sync-scripts', () => {
    chrome.alarms.create('sync-scripts', { periodInMinutes: config.syncInterval })
  })
}
setupAlarm()

// ============ 消息处理 ============

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'sync') {
    syncScripts().then(() => sendResponse({ ok: true }))
    return true
  }
  if (msg.action === 'getConfig') {
    getConfig().then(config => sendResponse(config))
    return true
  }
  if (msg.action === 'saveConfig') {
    chrome.storage.local.set({ config: msg.config }).then(() => {
      setupAlarm()
      syncScripts().then(() => sendResponse({ ok: true }))
    })
    return true
  }
  if (msg.action === 'getScripts') {
    getScripts().then(scripts => sendResponse(scripts))
    return true
  }
  if (msg.action === 'toggleScript') {
    getScripts().then(scripts => {
      const idx = scripts.findIndex(s => s.id === msg.scriptId)
      if (idx >= 0) {
        scripts[idx].enabled = msg.enabled
        saveScripts(scripts).then(() => sendResponse({ ok: true }))
      } else {
        sendResponse({ ok: false })
      }
    })
    return true
  }
  if (msg.action === 'injectNow') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        injectScriptsForTab(tabs[0].id, tabs[0].url).then(() => sendResponse({ ok: true }))
      } else {
        sendResponse({ ok: false })
      }
    })
    return true
  }
  if (msg.action === 'deleteScript') {
    getScripts().then(scripts => {
      const filtered = scripts.filter(s => s.id !== msg.scriptId)
      saveScripts(filtered).then(() => sendResponse({ ok: true }))
    })
    return true
  }
  if (msg.action === 'getStatus') {
    chrome.storage.local.get(['lastSync', 'syncError']).then(data => {
      sendResponse({ lastSync: data.lastSync, syncError: data.syncError || null })
    })
    return true
  }
})
