# AI Browser Chrome Extension 开发规范

## 一、项目概述

仿照 Monica AI 的界面和交互模式，改造 AI Browser Chrome 扩展，实现：
- 侧边栏 AI 对话（类 Monica SidePanel）
- 划词工具栏（类 Monica 划词工具）
- 脚本管理（保留原有服务端同步功能）
- AI 功能通过配置接入（OpenAI 兼容 API / Ollama）

## 二、技术栈

| 组件 | 选型 | 说明 |
|------|------|------|
| 扩展规范 | Manifest V3 | Chrome 最新标准 |
| UI 框架 | 原生 Web Components + Shadow DOM | 无需构建，轻量隔离 |
| 状态管理 | 自研 Store (PubSub) | 轻量响应式 |
| 样式 | CSS Variables + 内联样式 | Shadow DOM 内隔离 |
| AI 接口 | OpenAI 兼容 API | 通过配置接入任意模型 |
| 数据存储 | chrome.storage.local + IndexedDB | 脚本缓存 + 聊天记录 |
| 通信 | chrome.runtime.sendMessage + Port | 短消息 + 流式传输 |

## 三、架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                   AI Browser Chrome Extension                │
├──────────┬──────────┬──────────────┬────────────────────────┤
│ Popup    │ SidePanel│ Content      │ Background             │
│ (弹窗)    │ (侧边栏)  │ Script       │ (Service Worker)       │
│          │          │              │                        │
│ 脚本管理  │ AI 对话   │ 划词工具栏    │ 服务路由层              │
│ 设置页面  │ 聊天记录   │ 页面感知      │ AI 服务(流式)          │
│ 同步状态  │ 脚本快捷  │ 脚本注入      │ 脚本同步服务            │
│          │ 网页摘要  │ 侧边栏触发器  │ 消息分发                │
│          │          │              │ 定时任务                │
├──────────┴──────────┴──────────────┴────────────────────────┤
│                        共享模块                               │
│  store.js (状态) | ai-service.js (AI调用) | utils.js (工具)    │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 通信架构

```
Content Script  ←──chrome.runtime.sendMessage──→  Background
     │                                                │
     │  chrome.runtime.connect (Port 长连接)           │
     │────────────────────────────────────────────→   │
     │                                                │
     │  callService RPC 模式                           │
     │  {service, method, args} → [error, data]       │
     │                                                │
Popup/SidePanel ←──chrome.runtime.sendMessage──→     │
```

### 3.2 服务化架构（Background）

Background 采用服务化架构，每个功能模块独立 Service：

```javascript
// 服务注册表
const services = {
  aiService: new AIService(),       // AI 对话、流式调用
  scriptService: new ScriptService(), // 脚本同步、注入管理
  sidebarService: new SidebarService(), // 侧边栏控制
  storageService: new StorageService(), // 数据持久化
  configService: new ConfigService(),   // 配置管理
}
```

## 四、目录结构

```
chrome-extension/
├── manifest.json              # MV3 清单
├── background/
│   └── index.js               # Service Worker 入口 + 服务注册
├── services/
│   ├── ai-service.js          # AI 对话服务（流式 + Function Calling）
│   ├── script-service.js      # 脚本同步 + 注入服务
│   ├── sidebar-service.js     # 侧边栏控制服务
│   ├── storage-service.js     # 数据持久化服务
│   └── config-service.js      # 配置管理服务
├── content/
│   ├── index.js               # Content Script 入口
│   ├── sidebar-injector.js    # 侧边栏注入器（Shadow DOM）
│   ├── selection-toolbar.js   # 划词工具栏
│   ├── page-assistant.js      # 网页助手（摘要/翻译）
│   └── script-runner.js       # 脚本注入执行器
├── sidepanel/
│   ├── sidepanel.html         # 侧边栏页面
│   ├── sidepanel.js           # 侧边栏逻辑
│   └── sidepanel.css          # 侧边栏样式
├── popup/
│   ├── popup.html             # 弹窗页面
│   ├── popup.js               # 弹窗逻辑
│   └── popup.css              # 弹窗样式
├── shared/
│   ├── store.js               # 状态管理 (PubSub)
│   ├── constants.js           # 常量定义
│   └── utils.js               # 工具函数
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── styles/
    └── content.css            # 内容脚本共享样式
```

## 五、核心模块设计

### 5.1 AI Service（AI 对话服务）

```javascript
// services/ai-service.js
class AIService {
  // 配置驱动的多模型支持
  // 支持 OpenAI 兼容 API / Ollama / 通义千问
  
  async chat(messages, options) { ... }        // 普通对话
  async chatStream(messages, options) { ... }  // 流式对话（Port 长连接）
  async chatWithTools(messages, tools) { ... } // Function Calling
}
```

AI 配置结构：
```javascript
{
  provider: 'openai',        // openai | ollama | qwen
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-xxx',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 4096,
  systemPrompt: '你是 AI Browser 助手...',
}
```

### 5.2 Sidebar（侧边栏）

借鉴 Monica 的 SidePanel + 浮动侧边栏双模式：

**模式1：chrome.sidePanel API**
- 点击扩展图标打开侧边栏
- 独立页面，不侵入宿主页面
- 适合深度对话

**模式2：Content Script 浮动侧边栏**
- 在页面右侧注入浮动面板
- Shadow DOM 隔离，不影响宿主页面
- 适合边浏览边对话

### 5.3 划词工具栏

```
用户选中文字 → 检测选区 → 在选区上方弹出工具栏
┌──────────────────────────────────┐
│ 🤖AI解释 │ 🌐翻译 │ ✍️改写 │ 📋摘要 │ ⚡脚本 │
└──────────────────────────────────┘
```

- Shadow DOM 隔离
- 固定在选区上方
- 可配置工具列表
- AI 结果以气泡展示

### 5.4 脚本管理（保留并增强）

保留原有功能：
- 服务端脚本同步
- URL 匹配自动注入
- 启用/禁用切换

新增功能：
- 侧边栏内快捷执行脚本
- 脚本执行结果 AI 分析
- 脚本收藏/最近使用

### 5.5 页面助手

| 功能 | 触发方式 | 实现 |
|------|---------|------|
| 网页摘要 | 侧边栏按钮 | 提取正文 + AI 总结 |
| 翻译页面 | 侧边栏按钮 / 右键菜单 | 提取正文 + AI 翻译 |
| 代码解释 | 划词工具栏 | 选中代码 + AI 解释 |
| AI 搜索 | 侧边栏输入 | 联网搜索 + AI 回答 |

## 六、Manifest V3 配置

```json
{
  "manifest_version": 3,
  "name": "AI Browser",
  "version": "2.0.0",
  "permissions": [
    "storage",
    "activeTab",
    "scripting",
    "alarms",
    "sidePanel",
    "contextMenus"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background/index.js"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
  },
  "side_panel": {
    "default_path": "sidepanel/sidepanel.html"
  },
  "content_scripts": [{
    "js": ["content/index.js"],
    "css": ["styles/content.css"],
    "matches": ["<all_urls>"],
    "run_at": "document_idle"
  }],
  "commands": {
    "_execute_action": { "suggested_key": { "default": "Ctrl+Shift+A" } },
    "open-sidebar": { "description": "打开侧边栏" },
    "explain-selection": { "description": "解释选中文字" }
  }
}
```

## 七、开发规范

### 7.1 Shadow DOM 规范

所有注入页面的 UI 必须使用 Shadow DOM：

```javascript
const host = document.createElement('div')
host.id = 'ai-browser-host'
const shadow = host.attachShadow({ mode: 'closed' })
// 所有样式和结构在 shadow 内
document.body.appendChild(host)
```

### 7.2 消息通信规范

```javascript
// RPC 调用模式
const [err, data] = await chrome.runtime.sendMessage({
  type: 'callService',
  service: 'aiService',
  method: 'chat',
  args: [messages, options]
})

// 流式传输（Port）
const port = chrome.runtime.connect({ name: 'ai-stream' })
port.postMessage({ type: 'start', messages, options })
port.onMessage.addListener(msg => {
  if (msg.type === 'chunk') appendContent(msg.content)
  if (msg.type === 'done') finalizeContent()
})
```

### 7.3 CSS 隔离规范

- Shadow DOM 内样式独立
- CSS 变量命名前缀 `--ai-browser-`
- 不使用全局 class 名
- z-index 从 2147483600 起步（确保最高层级）

### 7.4 AI 配置规范

AI 功能通过配置实现，不硬编码模型：
- 配置存储在 `chrome.storage.local` 的 `aiConfig` 字段
- 支持多配置切换
- 默认配置指向本地 Ollama

## 八、与 Monica 的功能对照

| 功能 | Monica | AI Browser 扩展 | 说明 |
|------|--------|-----------------|------|
| AI 对话 | 云端 API | 配置化 API | 支持本地模型 |
| 侧边栏 | chrome.sidePanel | sidePanel + 浮动面板 | 双模式 |
| 划词工具 | 有 | 有 | 可配置工具 |
| 写作助手 | 有 | 有 | AI 驱动 |
| 网页摘要 | YouTube/GitHub/PDF | 通用摘要 | AI 提取正文 |
| 脚本管理 | 无 | 有 | 服务端同步 |
| 自定义机器人 | 有 | 有 | 提示词模板 |
| Function Calling | 无 | 有 | Agent 能力 |
| 本地模型 | 无 | 有 | Ollama 支持 |

## 九、开发检查清单

- [ ] Shadow DOM 隔离所有注入 UI
- [ ] AI 配置化，不硬编码模型
- [ ] 脚本同步功能保留
- [ ] Port 长连接实现流式 AI 响应
- [ ] RPC 服务调用模式
- [ ] CSS 变量命名前缀
- [ ] 消息类型统一规范
- [ ] 错误处理和重试机制
- [ ] CSP 兼容方案
- [ ] Service Worker 生命周期管理
