// ============ 脚本中心独立窗口（BrowserWindow） ============
// 浏览后台脚本中心、下载到本地、一键注入页面、设为自动注入、管理本地脚本
//
// 数据来源：
//   - 远程脚本：通过 window.api.admin.getScripts / getScriptDetail 调用后台 API
//   - 本地脚本：localStorage key 'ai-browser-scripts'
//     格式: [{ id, name, description, code, savedAt }]
//   - 后台配置：localStorage key 'ai-browser-config'（adminServerUrl / adminToken）
//   - 主题：localStorage key 'ai-browser-theme'
//
// 特性：
//   - 无边框窗口，自定义标题栏可拖拽（-webkit-app-region: drag）
//   - 暗色主题（读取 localStorage 'ai-browser-theme'，默认 dark-blue）
//   - 两个 Tab：远程脚本 | 本地脚本
//   - 远程脚本：搜索 / 刷新 / 卡片列表 / 下载到本地 / 注入页面 / 自动注入 / 分页
//   - 本地脚本：卡片列表 / 注入页面 / 自动注入 / 上传到后台（弹窗）/ 删除
//   - 通过 storage 事件与主窗口 UnifiedPanel 同步本地脚本

import { useState, useEffect, useCallback, useRef } from 'react'

const SAVED_SCRIPTS_KEY = 'ai-browser-scripts'
const CONFIG_KEY = 'ai-browser-config'
const THEME_KEY = 'ai-browser-theme'

function defaultConfig() {
  return {
    adminServerUrl: 'http://localhost:3001',
    appKey: '',
    appSecret: '',
  }
}

// 通过 IPC 从主进程读取 syncConfig（AppKey/AppSecret 存在主进程 storage.json 中）
async function loadConfigFromMain() {
  try {
    const result = await window.api.config.getSync()
    if (result?.success && result.data) {
      const cfg = {
        adminServerUrl: result.data.serverUrl || defaultConfig().adminServerUrl,
        appKey: result.data.appKey || '',
        appSecret: result.data.appSecret || '',
      }
      return cfg
    }
    return null
  } catch (e) {
    console.warn('[ScriptCenter] loadConfigFromMain error:', e)
    return null
  }
}

function loadSavedScripts() {
  try {
    const data = localStorage.getItem(SAVED_SCRIPTS_KEY)
    return data ? JSON.parse(data) : []
  } catch {
    return []
  }
}

function saveSavedScripts(scripts) {
  localStorage.setItem(SAVED_SCRIPTS_KEY, JSON.stringify(scripts))
}

// 友好时间格式
function formatTime(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return ''
  }
}

export default function ScriptCenterWindow() {
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'dark-blue')
  const [config, setConfig] = useState(() => defaultConfig())

  const [activeTab, setActiveTab] = useState('remote')

  // 远程脚本状态
  const [remoteScripts, setRemoteScripts] = useState([])
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remotePage, setRemotePage] = useState(1)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [remoteError, setRemoteError] = useState('')

  // 本地脚本状态
  const [localScripts, setLocalScripts] = useState(() => loadSavedScripts())

  // 上传弹窗状态
  const [uploadModal, setUploadModal] = useState(null) // { script, name, description, urlPattern, toolType, loading }

  // Toast 提示
  const [toast, setToast] = useState(null) // { type: 'success'|'error'|'info', message }
  const toastTimerRef = useRef(null)

  const showToast = useCallback((type, message) => {
    setToast({ type, message })
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 3000)
  }, [])

  // 应用主题
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // 监听 localStorage 变化：主窗口修改 theme/本地脚本时同步
  useEffect(() => {
    const handleStorage = (e) => {
      if (e.key === THEME_KEY && e.newValue) {
        setTheme(e.newValue)
      }
      if (e.key === SAVED_SCRIPTS_KEY) {
        try { setLocalScripts(e.newValue ? JSON.parse(e.newValue) : []) } catch { /* 忽略 */ }
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  // 定期通过 IPC 从主进程同步 config（AppKey/AppSecret 可能被主窗口修改）
  useEffect(() => {
    const interval = setInterval(async () => {
      const cfg = await loadConfigFromMain()
      if (cfg) {
        setConfig(prev => {
          if (JSON.stringify(prev) !== JSON.stringify(cfg)) return cfg
          return prev
        })
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current) }
  }, [])

  // ============ 远程脚本 ============

  const loadRemoteScripts = useCallback(async (page, keyword) => {
    const serverUrl = config.adminServerUrl || ''
    const appKey = config.appKey || ''
    const appSecret = config.appSecret || ''
    if (!serverUrl || !appKey || !appSecret) {
      setRemoteError('请先在主窗口设置中配置服务器地址和 AppKey/AppSecret')
      setRemoteScripts([])
      return
    }
    setRemoteLoading(true)
    setRemoteError('')
    const usePage = page || 1
    setRemotePage(usePage)
    try {
      const kw = keyword !== undefined ? keyword : searchKeyword
      const result = await window.api.scripts.search({
        serverUrl, appKey, appSecret, keyword: kw,
      })
      if (result.success && result.data) {
        // 兼容多种返回结构：数组 / { data: [...] } / { list: [...] }
        let list = []
        if (Array.isArray(result.data)) list = result.data
        else if (Array.isArray(result.data.data)) list = result.data.data
        else if (Array.isArray(result.data.list)) list = result.data.list
        setRemoteScripts(list)
      } else {
        setRemoteScripts([])
        setRemoteError(result.error || '加载失败')
      }
    } catch (e) {
      setRemoteScripts([])
      setRemoteError(e.message || '请求异常')
    } finally {
      setRemoteLoading(false)
    }
  }, [config, searchKeyword])

  // 首次加载：通过 IPC 从主进程读取 syncConfig
  const [configLoaded, setConfigLoaded] = useState(false)
  useEffect(() => {
    (async () => {
      const cfg = await loadConfigFromMain()
      if (cfg) {
        setConfig(cfg)
      }
      setConfigLoaded(true)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // config 加载完成后自动加载远程脚本
  useEffect(() => {
    if (configLoaded && config.adminServerUrl && config.appKey && config.appSecret) {
      loadRemoteScripts(1, '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configLoaded, config.adminServerUrl, config.appKey, config.appSecret])

  const handleSearch = () => {
    setSearchKeyword(searchInput)
    loadRemoteScripts(1, searchInput)
  }

  const handleRefresh = () => {
    setSearchInput('')
    setSearchKeyword('')
    loadRemoteScripts(1, '')
  }

  // 获取远程脚本代码（通过 AppKey 签名的 inject 接口）
  const fetchRemoteCode = async (serverScript) => {
    const serverUrl = config.adminServerUrl || ''
    const appKey = config.appKey || ''
    const appSecret = config.appSecret || ''
    const detailResult = await window.api.scripts.getDetail({ serverUrl, appKey, appSecret, id: serverScript.id })
    if (!detailResult.success || !detailResult.data) {
      throw new Error(detailResult.error || '获取脚本详情失败')
    }
    const detail = detailResult.data.data || detailResult.data
    const code = detail.code || detail.content || ''
    if (!code) throw new Error('脚本内容为空')
    return code
  }

  // 下载到本地
  const handleDownloadToLocal = async (serverScript) => {
    try {
      const code = await fetchRemoteCode(serverScript)
      const newScript = {
        id: 'script_' + Date.now(),
        name: serverScript.name,
        description: serverScript.description || '',
        code,
        savedAt: Date.now(),
      }
      const updated = [newScript, ...loadSavedScripts()]
      saveSavedScripts(updated)
      setLocalScripts(updated)
      showToast('success', `已下载 "${serverScript.name}" 到本地脚本库`)
    } catch (e) {
      showToast('error', `下载失败: ${e.message}`)
    }
  }

  // 注入到当前页面
  const handleInjectPage = async (code, name) => {
    if (!code) { showToast('error', '脚本内容为空'); return }
    try {
      const result = await window.api.action.executeJs(code)
      if (result.success) {
        showToast('success', `已注入 "${name}" 到当前页面`)
      } else {
        showToast('error', `注入失败: ${result.error || '未知错误'}`)
      }
    } catch (e) {
      showToast('error', `注入异常: ${e.message}`)
    }
  }

  const handleInjectRemote = async (serverScript) => {
    try {
      const code = await fetchRemoteCode(serverScript)
      await handleInjectPage(code, serverScript.name)
    } catch (e) {
      showToast('error', `注入失败: ${e.message}`)
    }
  }

  // 自动注入
  const handleAutoInject = async (code, name, urlPattern) => {
    if (!code) { showToast('error', '脚本内容为空'); return }
    try {
      const result = await window.api.action.addAutoInject(name, code, urlPattern || '*')
      if (result.success) {
        showToast('success', `已设为自动注入: "${name}"`)
      } else {
        showToast('error', `设置失败: ${result.error || '未知错误'}`)
      }
    } catch (e) {
      showToast('error', `设置异常: ${e.message}`)
    }
  }

  const handleAutoInjectRemote = async (serverScript) => {
    try {
      const code = await fetchRemoteCode(serverScript)
      await handleAutoInject(code, serverScript.name, serverScript.url_pattern || '*')
    } catch (e) {
      showToast('error', `设置失败: ${e.message}`)
    }
  }

  // ============ 本地脚本 ============

  const handleDeleteLocal = (script) => {
    if (!confirm(`确定删除本地脚本 "${script.name}" 吗？`)) return
    const updated = loadSavedScripts().filter(s => s.id !== script.id)
    saveSavedScripts(updated)
    setLocalScripts(updated)
    showToast('info', `已删除 "${script.name}"`)
  }

  // ============ 上传到后台 ============

  const openUploadModal = (script) => {
    setUploadModal({
      script,
      name: script.name,
      description: script.description || '',
      urlPattern: '*',
      toolType: 'js',
      loading: false,
    })
  }

  const handleUploadSubmit = async () => {
    if (!uploadModal) return
    const { script, name, description, urlPattern, toolType } = uploadModal
    if (!name || !name.trim()) { showToast('error', '请输入脚本名称'); return }
    const serverUrl = config.adminServerUrl || ''
    const appKey = config.appKey || ''
    const appSecret = config.appSecret || ''
    if (!serverUrl || !appKey || !appSecret) {
      showToast('error', '请先在主窗口设置中配置服务器地址和 AppKey/AppSecret')
      return
    }
    setUploadModal(prev => ({ ...prev, loading: true }))
    try {
      const result = await window.api.scripts.upload({
        serverUrl, appKey, appSecret,
        name: name.trim(),
        code: script.code,
        description: description || '',
        categoryId: 1,
        urlPattern: urlPattern || '*',
        toolType: toolType || 'js',
      })
      if (result.success) {
        showToast('success', `已上传 "${name}" 到后台脚本中心`)
        setUploadModal(null)
      } else {
        showToast('error', `上传失败: ${result.error || result.data?.error || '未知错误'}`)
        setUploadModal(prev => ({ ...prev, loading: false }))
      }
    } catch (e) {
      showToast('error', `上传异常: ${e.message}`)
      setUploadModal(prev => ({ ...prev, loading: false }))
    }
  }

  // ============ 窗口关闭 ============

  const handleClose = async () => {
    try {
      if (window.api?.scriptCenterWindow?.close) {
        await window.api.scriptCenterWindow.close()
      }
    } catch (e) {
      console.error('[ScriptCenterWindow] IPC 关闭失败:', e)
    }
    if (!window.closed) window.close()
  }

  // ============ 渲染 ============

  const configReady = !!(config.adminServerUrl && config.appKey && config.appSecret)

  return (
    <div className="scw-root">
      {/* 可拖拽标题栏 */}
      <div className="scw-titlebar">
        <span className="scw-title">⚡ 脚本中心</span>
        <div className="scw-titlebar-actions">
          <button className="scw-close-btn" onClick={handleClose} title="关闭">✕</button>
        </div>
      </div>

      {/* Tab 栏 */}
      <div className="scw-tabs">
        <div className={`scw-tab ${activeTab === 'remote' ? 'active' : ''}`} onClick={() => setActiveTab('remote')}>
          远程脚本
        </div>
        <div className={`scw-tab ${activeTab === 'local' ? 'active' : ''}`} onClick={() => setActiveTab('local')}>
          本地脚本 ({localScripts.length})
        </div>
      </div>

      {/* 远程脚本 Tab */}
      <div className="scw-content" style={{ display: activeTab === 'remote' ? 'flex' : 'none' }}>
        {/* 搜索栏 */}
        <div className="scw-search-bar">
          <input
            className="scw-input"
            type="text"
            placeholder="输入关键词搜索脚本..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
          />
          <button className="scw-btn scw-btn-primary" onClick={handleSearch}>搜索</button>
          <button className="scw-btn scw-btn-secondary" onClick={handleRefresh}>刷新</button>
        </div>

        {/* 配置提示 */}
        {!configReady && (
          <div className="scw-hint scw-hint-warning">
            请先在主窗口「设置」中配置服务器地址和 AppKey/AppSecret，然后重新打开本窗口。
          </div>
        )}

        {/* 脚本列表 */}
        <div className="scw-list">
          {remoteLoading && <div className="scw-empty">加载中...</div>}
          {!remoteLoading && remoteError && <div className="scw-empty scw-empty-error">{remoteError}</div>}
          {!remoteLoading && !remoteError && remoteScripts.length === 0 && configReady && (
            <div className="scw-empty">暂无远程脚本</div>
          )}
          {!remoteLoading && !remoteError && remoteScripts.map(script => (
            <div key={script.id} className="scw-card">
              <div className="scw-card-header">
                <span className="scw-card-name">{script.name}</span>
                {script.tool_type && (
                  <span className={`scw-badge scw-badge-${script.tool_type === 'api' ? 'api' : 'js'}`}>
                    {script.tool_type}
                  </span>
                )}
              </div>
              {script.description && (
                <div className="scw-card-desc">{script.description}</div>
              )}
              <div className="scw-card-meta">
                <span>分类: {script.category_name || '未分类'}</span>
                <span>v{script.version || '1.0.0'}</span>
                <span>下载 {script.download_count || 0} 次</span>
              </div>
              <div className="scw-card-actions">
                <button
                  className="scw-btn scw-btn-success"
                  onClick={() => handleDownloadToLocal(script)}
                  title="下载到本地脚本库"
                >下载到本地</button>
                <button
                  className="scw-btn scw-btn-primary"
                  onClick={() => handleInjectRemote(script)}
                  title="注入到当前页面执行"
                >注入页面</button>
                <button
                  className="scw-btn scw-btn-accent"
                  onClick={() => handleAutoInjectRemote(script)}
                  title="设为自动注入（页面加载后自动执行）"
                >自动注入</button>
              </div>
            </div>
          ))}
        </div>

        {/* 分页 */}
        {!remoteLoading && !remoteError && remoteScripts.length > 0 && (
          <div className="scw-pagination">
            <button
              className="scw-btn scw-btn-secondary"
              onClick={() => loadRemoteScripts(remotePage - 1)}
              disabled={remotePage <= 1}
            >上一页</button>
            <span className="scw-page-info">第 {remotePage} 页</span>
            <button
              className="scw-btn scw-btn-secondary"
              onClick={() => loadRemoteScripts(remotePage + 1)}
              disabled={remoteScripts.length < 1}
            >下一页</button>
          </div>
        )}
      </div>

      {/* 本地脚本 Tab */}
      <div className="scw-content" style={{ display: activeTab === 'local' ? 'flex' : 'none' }}>
        <div className="scw-local-header">
          <span className="scw-local-tip">已保存的本地脚本，点击「上传到后台」可分享到脚本中心</span>
        </div>
        <div className="scw-list">
          {localScripts.length === 0 && (
            <div className="scw-empty">
              暂无本地脚本
              <div className="scw-empty-sub">在主窗口 AI 生成的代码块中点击「保存代码」即可保存到本地</div>
            </div>
          )}
          {localScripts.map(script => (
            <div key={script.id} className="scw-card">
              <div className="scw-card-header">
                <span className="scw-card-name">{script.name}</span>
                <span className="scw-card-size">{(script.code || '').length} 字符</span>
              </div>
              {script.description && (
                <div className="scw-card-desc">{script.description}</div>
              )}
              <div className="scw-card-meta">
                <span>创建: {formatTime(script.savedAt || script.createdAt)}</span>
              </div>
              <div className="scw-card-actions">
                <button
                  className="scw-btn scw-btn-primary"
                  onClick={() => handleInjectPage(script.code, script.name)}
                  title="注入到当前页面执行"
                >注入页面</button>
                <button
                  className="scw-btn scw-btn-accent"
                  onClick={() => handleAutoInject(script.code, script.name, '*')}
                  title="设为自动注入（页面加载后自动执行）"
                >自动注入</button>
                <button
                  className="scw-btn scw-btn-info"
                  onClick={() => openUploadModal(script)}
                  title="上传到后台脚本中心"
                >上传到后台</button>
                <button
                  className="scw-btn scw-btn-danger"
                  onClick={() => handleDeleteLocal(script)}
                  title="删除本地脚本"
                >删除</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 上传到后台 弹窗 */}
      {uploadModal && (
        <div className="scw-modal-overlay" onClick={() => !uploadModal.loading && setUploadModal(null)}>
          <div className="scw-modal" onClick={(e) => e.stopPropagation()}>
            <div className="scw-modal-header">
              <span className="scw-modal-title">上传脚本到后台</span>
              <button
                className="scw-modal-close"
                onClick={() => !uploadModal.loading && setUploadModal(null)}
                disabled={uploadModal.loading}
              >✕</button>
            </div>
            <div className="scw-modal-body">
              <div className="scw-form-row">
                <label className="scw-label">脚本名称</label>
                <input
                  className="scw-input"
                  type="text"
                  value={uploadModal.name}
                  onChange={(e) => setUploadModal(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="请输入脚本名称"
                  disabled={uploadModal.loading}
                />
              </div>
              <div className="scw-form-row">
                <label className="scw-label">描述</label>
                <textarea
                  className="scw-input scw-textarea"
                  value={uploadModal.description}
                  onChange={(e) => setUploadModal(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="脚本功能描述（可选）"
                  rows={3}
                  disabled={uploadModal.loading}
                />
              </div>
              <div className="scw-form-row">
                <label className="scw-label">URL 匹配模式</label>
                <input
                  className="scw-input"
                  type="text"
                  value={uploadModal.urlPattern}
                  onChange={(e) => setUploadModal(prev => ({ ...prev, urlPattern: e.target.value }))}
                  placeholder="* 表示所有页面，或输入 URL 通配符如 *.example.com/*"
                  disabled={uploadModal.loading}
                />
              </div>
              <div className="scw-form-row">
                <label className="scw-label">工具类型</label>
                <select
                  className="scw-input scw-select"
                  value={uploadModal.toolType}
                  onChange={(e) => setUploadModal(prev => ({ ...prev, toolType: e.target.value }))}
                  disabled={uploadModal.loading}
                >
                  <option value="js">js（页面注入脚本）</option>
                  <option value="api">api（接口调用工具）</option>
                </select>
              </div>
            </div>
            <div className="scw-modal-footer">
              <button
                className="scw-btn scw-btn-secondary"
                onClick={() => setUploadModal(null)}
                disabled={uploadModal.loading}
              >取消</button>
              <button
                className="scw-btn scw-btn-primary"
                onClick={handleUploadSubmit}
                disabled={uploadModal.loading}
              >{uploadModal.loading ? '上传中...' : '确认上传'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast 提示 */}
      {toast && (
        <div className={`scw-toast scw-toast-${toast.type}`}>{toast.message}</div>
      )}
    </div>
  )
}
