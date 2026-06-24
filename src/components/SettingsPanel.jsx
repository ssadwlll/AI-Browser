import React from 'react'

const PROVIDER_PRESETS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', label: 'OpenAI兼容' },
  ollama: { baseUrl: 'http://localhost:11434', model: 'qwen2.5:14b', label: 'Ollama (本地)' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', label: 'Qwen DashScope' },
}

export default function SettingsPanel({ config, setConfig }) {
  const handleChange = (field, value) => {
    setConfig({ ...config, [field]: value })
  }

  const handleProviderChange = (provider) => {
    const preset = PROVIDER_PRESETS[provider]
    setConfig({ ...config, provider, baseUrl: preset.baseUrl, model: preset.model })
  }

  return (
    <div className="settings-panel">
      <div className="section-title">模型配置</div>

      <div className="form-group">
        <label className="form-label">服务商</label>
        <select
          className="form-select"
          value={config.provider}
          onChange={(e) => handleProviderChange(e.target.value)}
        >
          <option value="openai">OpenAI 兼容 (GPT/Claude等)</option>
          <option value="ollama">Ollama (本地模型)</option>
          <option value="qwen">Qwen DashScope (通义千问)</option>
        </select>
      </div>

      {config.provider !== 'ollama' && (
        <div className="form-group">
          <label className="form-label">API Key</label>
          <input
            className="form-input"
            type="password"
            value={config.apiKey}
            onChange={(e) => handleChange('apiKey', e.target.value)}
            placeholder="sk-..."
          />
        </div>
      )}

      <div className="form-group">
        <label className="form-label">Base URL</label>
        <input
          className="form-input"
          type="text"
          value={config.baseUrl}
          onChange={(e) => handleChange('baseUrl', e.target.value)}
          placeholder="API地址"
        />
      </div>

      <div className="form-group">
        <label className="form-label">模型名称</label>
        <input
          className="form-input"
          type="text"
          value={config.model}
          onChange={(e) => handleChange('model', e.target.value)}
          placeholder="gpt-4o / qwen-plus / qwen2.5:14b"
        />
      </div>

      <div className="form-group">
        <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>流式输出</span>
          <input
            type="checkbox"
            checked={config.streaming || false}
            onChange={(e) => handleChange('streaming', e.target.checked)}
            style={{ width: 16, height: 16, cursor: 'pointer' }}
          />
        </label>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
          开启后AI对话、逆向分析、智能操作将实时逐字输出，关闭则等待完整结果后一次性显示
        </div>
      </div>

      <div className="section-title" style={{ marginTop: 20 }}>AI 行为设置</div>

      <div className="form-group">
        <label className="form-label">最大工具调用轮次</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min="1"
            max="50"
            value={config.maxToolRounds || 20}
            onChange={(e) => handleChange('maxToolRounds', parseInt(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 14, fontWeight: 600, minWidth: 24, textAlign: 'center', color: 'var(--accent)' }}>
            {config.maxToolRounds || 20}
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
          AI对话中最大工具调用轮次，每轮可调用多个工具。值越大AI可执行越复杂的任务，但可能消耗更多API费用。
        </div>
      </div>

      <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-input)', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
        <div style={{ marginBottom: 8, color: 'var(--accent)' }}>当前配置预览</div>
        <div>服务商: {PROVIDER_PRESETS[config.provider]?.label || config.provider}</div>
        <div>Base URL: {config.baseUrl}</div>
        <div>模型: {config.model}</div>
        <div>API Key: {config.apiKey ? '已配置 (' + config.apiKey.slice(0, 6) + '...)' : '未配置'}</div>
        <div>流式输出: {config.streaming ? '已开启' : '已关闭'}</div>
        <div>最大工具调用轮次: {config.maxToolRounds || 20}</div>
      </div>

      <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
        <div style={{ color: 'var(--accent)', marginBottom: 8 }}>使用说明</div>
        <div>- OpenAI兼容: 支持OpenAI、Claude(via proxy)、DeepSeek等</div>
        <div>- Ollama: 需先安装Ollama并拉取模型，无需API Key</div>
        <div>- Qwen: 使用阿里云DashScope API</div>
        <div>- 配置自动保存到本地</div>
      </div>
    </div>
  )
}
