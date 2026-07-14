// ============ 插件中心 ============
//
// 管理本地安装的插件：
//   ┌─ 标题栏（插件中心 + 关闭）────────────────────────┐
//   ├─ 工具栏（安装插件 按钮）───────────────────────────┤
//   ├─ 插件列表（卡片式）                                 │
//   │   ┌─ 插件卡片 ───────────────────────────────┐   │
//   │   │ 名称 版本  作者                          │   │
//   │   │ 描述                                      │   │
//   │   │ 权限标签                                  │   │
//   │   │ [启用/禁用] [打开窗口] [配置] [卸载]      │   │
//   │   └──────────────────────────────────────────┘   │
//   └────────────────────────────────────────────────────┘
//
// 架构：UI ←→ preload (pluginCenter) ←→ 主进程 PluginManager

import { useState, useEffect, useCallback, useRef } from 'react'

export default function PluginCenter({ onClose }) {
  // 关闭窗口：优先用传入的 onClose，否则调用主进程关闭独立窗口
  const handleClose = () => {
    if (typeof onClose === 'function') onClose()
    else window.api?.pluginCenterWindow?.close()
  }
  const [theme] = useState(() => localStorage.getItem('ai-browser-theme') || 'dark-blue')
  const [plugins, setPlugins] = useState([])
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [message, setMessage] = useState(null) // {type, text}
  const [expandedConfig, setExpandedConfig] = useState(null) // pluginId
  const [configDraft, setConfigDraft] = useState({})
  const fileInputRef = useRef(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const refresh = useCallback(async () => {
    try {
      const res = await window.api.pluginCenter.list()
      if (res.success) setPlugins(res.data)
    } catch (e) {
      setMessage({ type: 'error', text: '加载插件列表失败: ' + e.message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // 安装插件
  const handleInstallClick = () => fileInputRef.current?.click()

  const handleFileSelected = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = '' // 允许重复选择同一文件

    setInstalling(true)
    setMessage(null)
    try {
      // Electron 文件选择返回的是 path
      const zipPath = file.path
      if (!zipPath) {
        setMessage({ type: 'error', text: '无法获取文件路径' })
        return
      }
      const res = await window.api.pluginCenter.install(zipPath)
      if (res.success) {
        setMessage({ type: 'success', text: `插件 ${res.id} 安装成功` })
        await refresh()
      } else {
        setMessage({ type: 'error', text: res.error || '安装失败' })
      }
    } catch (e) {
      setMessage({ type: 'error', text: '安装失败: ' + e.message })
    } finally {
      setInstalling(false)
    }
  }

  // 启用/禁用
  const handleToggleEnable = async (plugin) => {
    try {
      const res = plugin.enabled
        ? await window.api.pluginCenter.disable(plugin.id)
        : await window.api.pluginCenter.enable(plugin.id)
      if (!res.success) {
        setMessage({ type: 'error', text: res.error || '操作失败' })
      } else {
        await refresh()
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message })
    }
  }

  // 打开窗口
  const handleOpenWindow = async (plugin) => {
    const res = await window.api.pluginCenter.openWindow(plugin.id)
    if (!res.success) {
      setMessage({ type: 'error', text: res.error || '打开窗口失败' })
    }
  }

  // 卸载
  const handleUninstall = async (plugin) => {
    if (!confirm(`确认卸载插件「${plugin.name}」？所有数据将被删除。`)) return
    const res = await window.api.pluginCenter.uninstall(plugin.id)
    if (res.success) {
      setMessage({ type: 'success', text: `插件 ${plugin.name} 已卸载` })
      await refresh()
    } else {
      setMessage({ type: 'error', text: res.error || '卸载失败' })
    }
  }

  // 配置编辑
  const handleToggleConfig = async (plugin) => {
    if (expandedConfig === plugin.id) {
      setExpandedConfig(null)
      return
    }
    const res = await window.api.pluginCenter.getConfig(plugin.id)
    if (res.success) {
      setConfigDraft(res.data || {})
      setExpandedConfig(plugin.id)
    }
  }

  const handleConfigChange = (key, value) => {
    setConfigDraft(prev => ({ ...prev, [key]: value }))
  }

  const handleSaveConfig = async (pluginId) => {
    const res = await window.api.pluginCenter.saveConfig(pluginId, configDraft)
    if (res.success) {
      setMessage({ type: 'success', text: '配置已保存' })
      setExpandedConfig(null)
      await refresh()
    } else {
      setMessage({ type: 'error', text: res.error || '保存失败' })
    }
  }

  // 渲染配置表单（根据 manifest.config.schema 自动生成）
  const renderConfigForm = (plugin) => {
    if (expandedConfig !== plugin.id) return null
    const schema = plugin.configSchema || []
    if (schema.length === 0) {
      return <div className="plugin-config-empty">此插件无可配置项</div>
    }
    return (
      <div className="plugin-config-form">
        {schema.map(field => (
          <div key={field.key} className="plugin-config-field">
            <label>{field.label}</label>
            {field.type === 'text' && (
              <input
                type="text"
                value={configDraft[field.key] ?? field.default ?? ''}
                onChange={e => handleConfigChange(field.key, e.target.value)}
              />
            )}
            {field.type === 'number' && (
              <input
                type="number"
                value={configDraft[field.key] ?? field.default ?? 0}
                onChange={e => handleConfigChange(field.key, Number(e.target.value))}
              />
            )}
            {field.type === 'textarea' && (
              <textarea
                rows="4"
                value={configDraft[field.key] ?? field.default ?? ''}
                onChange={e => handleConfigChange(field.key, e.target.value)}
              />
            )}
            {field.type === 'boolean' && (
              <input
                type="checkbox"
                checked={configDraft[field.key] ?? field.default ?? false}
                onChange={e => handleConfigChange(field.key, e.target.checked)}
              />
            )}
          </div>
        ))}
        <div className="plugin-config-actions">
          <button className="btn-primary" onClick={() => handleSaveConfig(plugin.id)}>保存</button>
          <button className="btn-secondary" onClick={() => setExpandedConfig(null)}>取消</button>
        </div>
      </div>
    )
  }

  return (
    <div className="plugin-center-root">
      <div className="plugin-header">
        <h2>插件中心</h2>
        <div className="plugin-header-actions">
          <button
            className="btn-primary"
            onClick={handleInstallClick}
            disabled={installing}
          >
            {installing ? '安装中...' : '安装插件'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={handleFileSelected}
          />
          <button className="btn-icon" onClick={handleClose} title="关闭">✕</button>
        </div>
      </div>

      {message && (
        <div className={`plugin-message ${message.type}`}>
          {message.text}
          <button onClick={() => setMessage(null)}>✕</button>
        </div>
      )}

      <div className="plugin-list">
        {loading ? (
          <div className="plugin-empty">加载中...</div>
        ) : plugins.length === 0 ? (
          <div className="plugin-empty">
            <p>暂无已安装插件</p>
            <p className="plugin-empty-hint">点击右上角「安装插件」上传 .zip 压缩包</p>
          </div>
        ) : (
          plugins.map(plugin => (
            <div key={plugin.id} className={`plugin-card ${plugin.enabled ? 'enabled' : ''}`}>
              <div className="plugin-card-header">
                <div className="plugin-card-title">
                  <span className="plugin-name">{plugin.name}</span>
                  <span className="plugin-version">v{plugin.version}</span>
                  {plugin.enabled && <span className="plugin-badge badge-on">已启用</span>}
                  {!plugin.enabled && <span className="plugin-badge badge-off">已禁用</span>}
                </div>
                <div className="plugin-card-meta">
                  {plugin.author && <span className="plugin-author">作者: {plugin.author}</span>}
                </div>
              </div>

              {plugin.description && (
                <div className="plugin-desc">{plugin.description}</div>
              )}

              {plugin.permissions.length > 0 && (
                <div className="plugin-perms">
                  {plugin.permissions.map(p => (
                    <span key={p} className="perm-tag">{p}</span>
                  ))}
                </div>
              )}

              <div className="plugin-card-actions">
                <button
                  className={plugin.enabled ? 'btn-warn' : 'btn-primary'}
                  onClick={() => handleToggleEnable(plugin)}
                >
                  {plugin.enabled ? '禁用' : '启用'}
                </button>
                {plugin.hasWindow && plugin.enabled && (
                  <button
                    className="btn-secondary"
                    onClick={() => handleOpenWindow(plugin)}
                  >
                    {plugin.windowOpen ? '聚焦窗口' : '打开窗口'}
                  </button>
                )}
                <button
                  className="btn-secondary"
                  onClick={() => handleToggleConfig(plugin)}
                >
                  {expandedConfig === plugin.id ? '收起配置' : '配置'}
                </button>
                <button
                  className="btn-danger"
                  onClick={() => handleUninstall(plugin)}
                >
                  卸载
                </button>
              </div>

              {renderConfigForm(plugin)}
            </div>
          ))
        )}
      </div>

      <style>{`
        .plugin-center-root {
          display: flex;
          flex-direction: column;
          height: 100vh;
          background: var(--bg-primary, #1a1a2e);
          color: var(--text-primary, #e0e0e0);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          overflow: hidden;
        }
        .plugin-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border-color, #2a2a4a);
          background: var(--bg-secondary, #16213e);
          -webkit-app-region: drag;
        }
        .plugin-header h2 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
        }
        .plugin-header-actions {
          display: flex;
          gap: 8px;
          align-items: center;
          -webkit-app-region: no-drag;
        }
        .plugin-message {
          margin: 12px 20px;
          padding: 10px 14px;
          border-radius: 6px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 13px;
        }
        .plugin-message.success { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
        .plugin-message.error { background: rgba(239, 68, 68, 0.15); color: #f87171; }
        .plugin-message button {
          background: none;
          border: none;
          color: inherit;
          cursor: pointer;
          opacity: 0.7;
        }
        .plugin-list {
          flex: 1;
          overflow-y: auto;
          padding: 16px 20px;
        }
        .plugin-empty {
          text-align: center;
          padding: 60px 20px;
          color: var(--text-secondary, #888);
        }
        .plugin-empty-hint {
          font-size: 12px;
          margin-top: 8px;
          opacity: 0.6;
        }
        .plugin-card {
          background: var(--bg-secondary, #16213e);
          border: 1px solid var(--border-color, #2a2a4a);
          border-radius: 8px;
          padding: 16px;
          margin-bottom: 12px;
          transition: border-color 0.2s;
        }
        .plugin-card.enabled {
          border-color: rgba(34, 197, 94, 0.4);
        }
        .plugin-card-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 8px;
        }
        .plugin-card-title {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .plugin-name {
          font-size: 15px;
          font-weight: 600;
        }
        .plugin-version {
          font-size: 12px;
          color: var(--text-secondary, #888);
          padding: 2px 6px;
          background: var(--bg-tertiary, #0f172a);
          border-radius: 4px;
        }
        .plugin-badge {
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 10px;
          font-weight: 500;
        }
        .badge-on { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
        .badge-off { background: rgba(100, 116, 139, 0.2); color: #94a3b8; }
        .plugin-card-meta {
          font-size: 12px;
          color: var(--text-secondary, #888);
        }
        .plugin-desc {
          font-size: 13px;
          color: var(--text-secondary, #aaa);
          margin-bottom: 10px;
          line-height: 1.5;
        }
        .plugin-perms {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          margin-bottom: 12px;
        }
        .perm-tag {
          font-size: 11px;
          padding: 2px 8px;
          background: rgba(99, 102, 241, 0.15);
          color: #818cf8;
          border-radius: 4px;
        }
        .plugin-card-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .plugin-card-actions button {
          padding: 6px 14px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
          transition: opacity 0.2s;
        }
        .plugin-card-actions button:hover { opacity: 0.85; }
        .btn-primary { background: #3b82f6; color: white; }
        .btn-secondary { background: #475569; color: white; }
        .btn-warn { background: #f59e0b; color: #1a1a2e; }
        .btn-danger { background: #ef4444; color: white; }
        .btn-icon {
          background: none;
          border: none;
          color: var(--text-secondary, #888);
          font-size: 18px;
          cursor: pointer;
          padding: 4px 8px;
        }
        .btn-icon:hover { color: var(--text-primary, #e0e0e0); }
        .plugin-config-form {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid var(--border-color, #2a2a4a);
        }
        .plugin-config-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-bottom: 10px;
        }
        .plugin-config-field label {
          font-size: 12px;
          color: var(--text-secondary, #aaa);
        }
        .plugin-config-field input,
        .plugin-config-field textarea {
          background: var(--bg-tertiary, #0f172a);
          border: 1px solid var(--border-color, #2a2a4a);
          color: var(--text-primary, #e0e0e0);
          padding: 6px 10px;
          border-radius: 4px;
          font-size: 13px;
          font-family: inherit;
        }
        .plugin-config-empty {
          font-size: 12px;
          color: var(--text-secondary, #888);
          padding: 12px 0;
        }
        .plugin-config-actions {
          display: flex;
          gap: 8px;
          margin-top: 8px;
        }
        .plugin-config-actions button {
          padding: 6px 14px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
        }
      `}</style>
    </div>
  )
}
