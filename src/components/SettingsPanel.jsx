import React, { useState, useEffect, useCallback } from 'react'

const THEME_KEY = 'ai-browser-theme'

const THEMES = [
  { id: 'dark-blue', label: '深邃蓝', primary: '#1a1a2e', secondary: '#16213e', accent: '#00d4ff' },
  { id: 'dark-black', label: '午夜黑', primary: '#0d0d0d', secondary: '#1a1a1a', accent: '#5b9aff' },
  { id: 'light-cream', label: '米白', primary: '#faf8f5', secondary: '#f0ece5', accent: '#4a90d9' },
  { id: 'light-blue', label: '清新蓝', primary: '#f0f4f8', secondary: '#e3eaf2', accent: '#1976d2' },
  { id: 'light-gray', label: '雅致灰', primary: '#ffffff', secondary: '#f5f5f7', accent: '#5856d6' },
]

function ThemeSelector() {
  const [current, setCurrent] = useState(() => localStorage.getItem(THEME_KEY) || 'dark-blue')

  const handleChange = (id) => {
    setCurrent(id)
    document.documentElement.setAttribute('data-theme', id)
    localStorage.setItem(THEME_KEY, id)
  }

  return (
    <div className="theme-selector">
      {THEMES.map(t => (
        <div
          key={t.id}
          className={`theme-option ${current === t.id ? 'active' : ''}`}
          onClick={() => handleChange(t.id)}
          title={t.label}
        >
          <div className="theme-swatch">
            <div className="theme-swatch-half theme-swatch-half-left" style={{ background: t.primary }} />
            <div className="theme-swatch-half theme-swatch-half-right" style={{ background: t.secondary }} />
          </div>
          <span className="theme-label">{t.label}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * 设置面板（对齐 chrome-extension 的设置视图）
 *
 * 4 个设置分区：
 *   1. 服务端连接 —— 管理后台地址 / AppKey / AppSecret + 测试连接
 *   2. AI 模型配置 —— 系统提示词(只读) / Temperature(只读) / 上下文窗口(只读) / 可用模型列表
 *   3. 功能开关 —— 划词工具栏
 *   4. Agent 模式 —— 最大执行轮次(只读, 后端控制) / 调试模式 / 任务结果自评 / 对话全景
 *
 * 主要通过 window.api.config 与主进程通信读写配置；
 * 仍接收 config / setConfig props 以保持与 App.jsx 的兼容性。
 */
export default function SettingsPanel({ config, setConfig }) {
  // ===== 整体加载状态 =====
  const [loading, setLoading] = useState(true)

  // ===== 分区1：服务端连接 =====
  const [sync, setSync] = useState({ serverUrl: '', appKey: '', appSecret: '' })
  // 连接测试状态：type ∈ '' | 'loading' | 'success' | 'error'
  const [connStatus, setConnStatus] = useState({ type: '', text: '' })

  // ===== 分区2：AI 模型配置 =====
  // aiConfig 仅用于只读展示 temperature（当前模型配置的兜底值）
  const [aiConfig, setAiConfig] = useState({ temperature: 0.7, maxTokens: 8192, systemPrompt: '' })
  // 后端应用设置：agent_max_rounds / agent_system_prompt / pdf_max_size / image_max_size
  const [appSettings, setAppSettings] = useState({ agent_max_rounds: 30, agent_system_prompt: '' })
  // 可用模型列表 { providers: [], models: [] }
  const [models, setModels] = useState({ providers: [], models: [] })
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')

  // ===== 分区3：功能开关 =====
  const [selectionTools, setSelectionTools] = useState(true)

  // ===== 分区4：Agent 模式 =====
  const [agent, setAgent] = useState({
    debug: false,
    enableJudge: true,
    conversationViewer: false,
  })

  // ===== 保存提示 =====
  const [saveMsg, setSaveMsg] = useState('')

  // ---------- 工具函数：加载可用模型列表 ----------
  const loadModels = useCallback(async () => {
    setModelsLoading(true)
    setModelsError('')
    try {
      const res = await window.api.config.getAvailableModels()
      // 主进程返回 { success, data } 或 { success: false, error }
      if (res && res.success) {
        const data = res.data || {}
        setModels({ providers: data.providers || [], models: data.models || [] })
      } else {
        setModels({ providers: [], models: [] })
        setModelsError((res && res.error) || '获取模型列表失败')
      }
    } catch (e) {
      setModels({ providers: [], models: [] })
      setModelsError(e.message || '获取模型列表失败')
    } finally {
      setModelsLoading(false)
    }
  }, [])

  // ---------- 工具函数：加载全部配置（mount 时执行） ----------
  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      // 并行加载各项配置
      const [syncRes, aiRes, agentRes, selRes, appRes] = await Promise.all([
        window.api.config.getSync(),
        window.api.config.getAI(),
        window.api.config.getAgent(),
        window.api.config.getSelectionTools(),
        window.api.config.getAppSettings(),
      ])

      // 服务端连接
      if (syncRes && syncRes.success) {
        const d = syncRes.data || {}
        setSync({
          serverUrl: d.serverUrl || '',
          appKey: d.appKey || '',
          appSecret: d.appSecret || '',
        })
      }
      // AI 配置（兜底显示用）
      if (aiRes && aiRes.success) setAiConfig(aiRes.data || {})
      // Agent 配置
      if (agentRes && agentRes.success) {
        const d = agentRes.data || {}
        setAgent({
          debug: d.debug === true,
          enableJudge: d.enableJudge !== false, // 默认开启
          conversationViewer: d.conversationViewer === true,
        })
      }
      // 划词工具开关（默认开启）
      if (selRes && selRes.success) {
        setSelectionTools((selRes.data || {}).enabled !== false)
      }
      // 后端应用设置（agent_max_rounds / agent_system_prompt）
      if (appRes && appRes.success) setAppSettings(appRes.data || {})
    } catch (e) {
      console.warn('[SettingsPanel] 加载配置失败:', e)
    } finally {
      setLoading(false)
    }
    // 模型列表单独加载（可能因未配置 appKey/appSecret 而失败）
    loadModels()
  }, [loadModels])

  // 组件挂载时异步加载所有配置
  useEffect(() => {
    loadAll()
  }, [loadAll])

  // ---------- 分区1：测试连接 ----------
  const handleTestConnection = async () => {
    // 校验必填项
    if (!sync.serverUrl || !sync.appKey || !sync.appSecret) {
      setConnStatus({ type: 'error', text: '请填写完整的服务端地址、AppKey 和 AppSecret' })
      return
    }
    setConnStatus({ type: 'loading', text: '正在测试连接...' })
    try {
      // 先保存表单中的服务端配置，使后续后端请求使用最新凭据
      await window.api.config.saveSync({ ...sync, enabled: true })
      // 调用 getAppSettings 刷新后端应用设置缓存（按需求）
      const appRes = await window.api.config.getAppSettings()
      if (appRes && appRes.success) setAppSettings(appRes.data || {})
      // 使用 getAvailableModels 真实验证连通性与鉴权（会返回 success:false 指示失败）
      const res = await window.api.config.getAvailableModels()
      if (res && res.success) {
        const data = res.data || {}
        setModels({ providers: data.providers || [], models: data.models || [] })
        setModelsError('')
        setConnStatus({ type: 'success', text: '连接成功' })
      } else {
        setConnStatus({
          type: 'error',
          text: '连接失败：' + ((res && res.error) || '未知错误'),
        })
      }
    } catch (e) {
      setConnStatus({ type: 'error', text: '连接失败：' + (e.message || '未知错误') })
    }
  }

  // ---------- 统一保存 ----------
  const handleSave = async () => {
    try {
      // 1. 保存服务端连接配置（开启同步）
      await window.api.config.saveSync({ ...sync, enabled: true })
      // 2. 保存功能开关（划词工具栏）
      await window.api.config.saveSelectionTools(selectionTools)
      // 3. 保存 Agent 配置（maxRounds 由后端控制，不本地保存）
      await window.api.config.saveAgent({
        debug: agent.debug,
        enableJudge: agent.enableJudge,
        conversationViewer: agent.conversationViewer,
      })
      // 4. 保存后刷新应用设置与模型列表（用户可能刚填好 appKey/appSecret）
      try {
        const appRes = await window.api.config.getAppSettings()
        if (appRes && appRes.success) setAppSettings(appRes.data || {})
      } catch (_) {}
      await loadModels()

      // 同步写入 props config 以保持 App.jsx 兼容
      if (typeof setConfig === 'function') {
        setConfig({
          ...(config || {}),
          adminServerUrl: sync.serverUrl,
        })
      }

      setSaveMsg('保存成功')
      setTimeout(() => setSaveMsg(''), 2000)
    } catch (e) {
      setSaveMsg('保存失败：' + (e.message || ''))
      setTimeout(() => setSaveMsg(''), 3000)
    }
  }

  // ---------- 计算只读展示值 ----------
  // Temperature：显示当前模型配置的 temperature（无选中模型时用 aiConfig 兜底）
  const displayTemperature =
    typeof aiConfig.temperature === 'number' ? aiConfig.temperature : 0.7
  // 上下文窗口大小：取第一个可用模型的 context_window，否则兜底 8192
  const firstModel = (models.models || [])[0] || {}
  const displayContextWindow = firstModel.context_window || aiConfig.maxTokens || 8192
  // Agent 最大执行轮次：由后端 agent_max_rounds 控制（只读）
  const displayMaxRounds = appSettings.agent_max_rounds || 30
  // 系统提示词：显示后端 agent_system_prompt（只读）
  const displaySystemPrompt =
    appSettings.agent_system_prompt || aiConfig.systemPrompt || ''

  // ---------- 渲染：模型列表 ----------
  const renderModels = () => {
    if (modelsLoading) {
      return <div className="settings-hint">加载中...</div>
    }
    const providers = models.providers || []
    const allModels = models.models || []
    if (modelsError) {
      // 未配置 AppKey/AppSecret 时给出可操作提示
      if (
        modelsError.includes('401') ||
        modelsError.includes('认证') ||
        modelsError.includes('sign')
      ) {
        return (
          <div className="settings-hint">
            认证失败：AppKey/AppSecret 无效或已过期，请在上方重新配置并保存
          </div>
        )
      }
      return <div className="settings-hint">{modelsError}</div>
    }
    if (providers.length === 0 || allModels.length === 0) {
      return <div className="settings-hint">暂无可用模型</div>
    }
    // 按 provider_id 分组展示
    const byProvider = new Map()
    for (const m of allModels) {
      const pid = m.provider_id
      if (!byProvider.has(pid)) byProvider.set(pid, [])
      byProvider.get(pid).push(m)
    }
    return (
      <div className="model-list">
        {providers.map((p) => {
          const list = byProvider.get(p.id) || []
          if (list.length === 0) return null
          return (
            <div className="model-group" key={p.id}>
              <div className="model-group-label">
                {p.display_name || p.name || '供应商'}
              </div>
              {list.map((m) => (
                <div className="model-row" key={m.model_id}>
                  <span className="model-row-name">
                    {m.display_name || m.model_id}
                  </span>
                  <span className="model-row-tags">
                    {String(m.supports_vision) === '1' && (
                      <span className="model-tag vision">图片</span>
                    )}
                    {String(m.supports_tools) === '1' && (
                      <span className="model-tag">工具</span>
                    )}
                  </span>
                  <span className="model-row-ctx">
                    上下文 {m.context_window || 8192}
                  </span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    )
  }

  // 加载中占位
  if (loading) {
    return (
      <div className="settings-panel">
        <div className="empty-state">
          <div className="loading-spinner" />
          <div>加载设置中...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-panel">
      {/* ========== 主题设置 ========== */}
      <div className="settings-section">
        <h3 className="settings-section-title">外观主题</h3>
        <ThemeSelector />
      </div>

      {/* ========== 分区1：服务端连接 ========== */}
      <div className="settings-section">
        <h3 className="settings-section-title">服务端连接</h3>

        <div className="form-group">
          <label className="form-label">管理后台地址</label>
          <input
            className="form-input"
            type="text"
            value={sync.serverUrl}
            onChange={(e) => setSync({ ...sync, serverUrl: e.target.value })}
            placeholder="http://localhost:3001"
          />
        </div>

        <div className="form-group">
          <label className="form-label">AppKey</label>
          <input
            className="form-input"
            type="text"
            value={sync.appKey}
            onChange={(e) => setSync({ ...sync, appKey: e.target.value })}
            placeholder="输入 AppKey"
          />
        </div>

        <div className="form-group">
          <label className="form-label">AppSecret</label>
          <input
            className="form-input"
            type="password"
            value={sync.appSecret}
            onChange={(e) => setSync({ ...sync, appSecret: e.target.value })}
            placeholder="输入 AppSecret"
          />
        </div>

        <div className="settings-test-row">
          <button
            className="settings-test-btn"
            onClick={handleTestConnection}
            disabled={connStatus.type === 'loading'}
          >
            {connStatus.type === 'loading' ? '测试中...' : '测试连接'}
          </button>
          {connStatus.text && (
            <span
              className={`settings-conn-status ${connStatus.type}`}
            >
              {connStatus.type === 'success' ? '✓ ' : connStatus.type === 'error' ? '✗ ' : ''}
              {connStatus.text}
            </span>
          )}
        </div>
      </div>

      {/* ========== 分区2：AI 模型配置 ========== */}
      <div className="settings-section">
        <h3 className="settings-section-title">AI 模型配置</h3>

        {/* 系统提示词：只读，显示后端 agent_system_prompt */}
        <div className="form-group">
          <label className="form-label">系统提示词</label>
          <textarea
            className="form-textarea"
            rows={3}
            readOnly
            value={displaySystemPrompt}
            placeholder="系统提示词由后台配置"
          />
        </div>

        {/* Temperature：只读 range，显示当前模型 temperature */}
        <div className="form-group">
          <label className="form-label">
            Temperature
            <span className="settings-value-badge">{displayTemperature}</span>
          </label>
          <input
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={displayTemperature}
            disabled
            className="settings-range-disabled"
          />
        </div>

        {/* 上下文窗口大小：只读 number，显示 context_window */}
        <div className="form-group">
          <label className="form-label">上下文窗口大小</label>
          <input
            className="form-input"
            type="number"
            min="2048"
            max="131072"
            value={displayContextWindow}
            disabled
          />
          <div className="settings-hint">
            由当前模型的 context_window 单独配置控制（范围 2048 ~ 131072）
          </div>
        </div>

        {/* 可用模型列表 */}
        <div className="form-group">
          <label className="form-label">可用模型列表</label>
          {renderModels()}
        </div>
      </div>

      {/* ========== 分区3：功能开关 ========== */}
      <div className="settings-section">
        <h3 className="settings-section-title">功能开关</h3>

        <div className="toggle-row">
          <span className="toggle-row-label">
            划词工具栏
            <span className="settings-hint-inline">选中页面文本时显示浮动工具栏</span>
          </span>
          <Toggle
            on={selectionTools}
            onChange={(v) => setSelectionTools(v)}
          />
        </div>
      </div>

      {/* ========== 分区4：Agent 模式 ========== */}
      <div className="settings-section">
        <h3 className="settings-section-title">Agent 模式</h3>

        {/* 最大执行轮次：只读，由后端 agent_max_rounds 控制 */}
        <div className="form-group">
          <label className="form-label">
            最大执行轮次
            <span className="settings-value-badge">{displayMaxRounds}</span>
          </label>
          <input
            type="range"
            min="5"
            max="100"
            step="1"
            value={displayMaxRounds}
            disabled
            className="settings-range-disabled"
          />
          <div className="settings-hint">
            由后台 agent_max_rounds 控制（只读），默认 30
          </div>
        </div>

        {/* 调试模式 */}
        <div className="toggle-row">
          <span className="toggle-row-label">
            调试模式
            <span className="settings-hint-inline">显示每步的提示词、工具调用、规则触发</span>
          </span>
          <Toggle
            on={agent.debug}
            onChange={(v) => setAgent({ ...agent, debug: v })}
          />
        </div>

        {/* 任务结果自评 */}
        <div className="toggle-row">
          <span className="toggle-row-label">
            任务结果自评
            <span className="settings-hint-inline">Agent 完成任务后对结果进行自评（enableJudge）</span>
          </span>
          <Toggle
            on={agent.enableJudge}
            onChange={(v) => setAgent({ ...agent, enableJudge: v })}
          />
        </div>

        {/* 对话全景 */}
        <div className="toggle-row">
          <span className="toggle-row-label">
            对话全景
            <span className="settings-hint-inline">任务启动时自动弹出可视化窗口，展示完整对话过程</span>
          </span>
          <Toggle
            on={agent.conversationViewer}
            onChange={(v) => {
              setAgent({ ...agent, conversationViewer: v })
              if (v) window.api?.conversationWindow?.open()
              else window.api?.conversationWindow?.close()
            }}
          />
        </div>
      </div>

      {/* ========== 底部操作区 ========== */}
      <div className="settings-bottom-actions">
        <button className="save-btn" onClick={handleSave}>
          保存设置
        </button>
        <button className="settings-tools-btn" type="button" onClick={() => window.api?.toolWindow?.open()}>
          打开内置工具
        </button>
        {saveMsg && (
          <div
            className={`settings-save-msg ${saveMsg.includes('失败') ? 'error' : 'success'}`}
          >
            {saveMsg}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 自定义 Toggle 开关（不使用原生 checkbox）
 * 样式由 .toggle / .toggle.on 控制
 */
function Toggle({ on, onChange, title }) {
  return (
    <div
      className={`toggle ${on ? 'on' : ''}`}
      onClick={() => onChange(!on)}
      title={title}
      role="switch"
      aria-checked={on}
    />
  )
}
