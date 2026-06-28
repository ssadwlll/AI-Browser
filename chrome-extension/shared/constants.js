// AI Browser Chrome Extension - 常量定义

export const MSG_TYPES = {
  CALL_SERVICE: 'callService',
  SERVICE_RESULT: 'serviceResult',
  STREAM_START: 'streamStart',
  STREAM_CHUNK: 'streamChunk',
  STREAM_DONE: 'streamDone',
  STREAM_ERROR: 'streamError',
  OPEN_SIDEBAR: 'openSidebar',
  CLOSE_SIDEBAR: 'closeSidebar',
  TOGGLE_SIDEBAR: 'toggleSidebar',
  SELECTION_ACTION: 'selectionAction',
  PAGE_SUMMARY: 'pageSummary',
  EXECUTE_SCRIPT: 'executeScript',
  SYNC_SCRIPTS: 'syncScripts',
}

export const AI_PROVIDERS = {
  OPENAI: 'openai',
  OLLAMA: 'ollama',
  QWEN: 'qwen',
  CUSTOM: 'custom',
}

export const DEFAULT_AI_CONFIG = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: 'qwen2.5:7b',
  temperature: 0.7,
  maxTokens: 4096,
  systemPrompt: '你是 AI Browser 助手，可以帮助用户分析网页内容、回答问题、编写代码和执行操作。',
}

export const DEFAULT_SYNC_CONFIG = {
  serverUrl: 'http://localhost:3001',
  token: '',
  syncInterval: 30,
  enabled: true,
}

export const SELECTION_TOOLS = [
  { id: 'explain', label: 'AI解释', icon: '💡', prompt: '请解释以下内容：\n\n' },
  { id: 'translate', label: '翻译', icon: '🌐', prompt: '请将以下内容翻译为中文：\n\n' },
  { id: 'rewrite', label: '改写', icon: '✍️', prompt: '请改写以下内容，使其更清晰：\n\n' },
  { id: 'summarize', label: '摘要', icon: '📋', prompt: '请总结以下内容的要点：\n\n' },
  { id: 'code', label: '代码解释', icon: '💻', prompt: '请解释以下代码的逻辑：\n\n' },
]

export const Z_INDEX = {
  SELECTION_TOOLBAR: 2147483600,
  FLOATING_SIDEBAR: 2147483599,
  OVERLAY: 2147483598,
}

export const CSS_PREFIX = 'ai-browser-'

export const STORAGE_KEYS = {
  AI_CONFIG: 'aiConfig',
  SYNC_CONFIG: 'syncConfig',
  SCRIPTS: 'scripts',
  CHAT_HISTORY: 'chatHistory',
  LAST_SYNC: 'lastSync',
  SYNC_ERROR: 'syncError',
  SIDEBAR_MODE: 'sidebarMode',
  SELECTION_TOOLS_ENABLED: 'selectionToolsEnabled',
}
