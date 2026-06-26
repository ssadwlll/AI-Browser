---
name: "ai-browser-dev"
description: "AI Browser 项目开发指南。Electron+React+Vite 桌面浏览器，集成多模型AI(OpenAI/Ollama/Qwen)、Function Calling、工具调用循环、智能体。用于开发新功能、修改代码、调试问题时参考。"
---

# AI Browser 开发指南

## 项目概述

一个基于 **Electron + React + Vite** 的桌面 AI 浏览器，集成多模型 AI 能力，支持自然语言操控浏览器页面。

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面框架 | Electron (BrowserView 嵌入浏览器) |
| 前端 | React 18 + Vite |
| 样式 | 纯 CSS |
| AI 模型 | OpenAI 兼容 API / Ollama 本地 / Qwen DashScope |
| 进程通信 | Electron IPC (contextBridge + ipcRenderer) |

## 目录结构

```
ai-browser/
├── electron/                    # 主进程 (Node.js)
│   ├── main.js                  # 入口：窗口创建、IPC注册、应用生命周期
│   ├── preload.js               # 预加载脚本：暴露 api 对象到渲染进程
│   ├── preload_browser.js       # 浏览器进程预加载：暴露 browserAPI
│   ├── tab_manager.js           # 标签页管理器：创建/关闭/切换/事件/右键菜单
│   ├── ai/                      # AI 模块
│   │   ├── llm_provider.js      # 多模型适配层 (OpenAI/Ollama/Qwen)
│   │   ├── analyzer.js          # 逆向分析器：请求拦截、技术栈分析
│   │   ├── action_executor.js   # 智能操作：JS 代码生成与注入 + DOM变更检测
│   │   ├── agent_loop.js        # 智能体循环：自主多轮任务执行 + 循环检测
│   │   ├── tool_definitions.js  # 17 种工具定义 (OpenAI Function Calling)
│   │   ├── tool_executor.js     # 工具执行器（双引擎架构）
│   │   ├── electron_engine.js   # 引擎1: Electron API（sendInputEvent/insertText）
│   │   └── uncertainty_guard.js # 不确定性检测：DOM变更感知/循环检测/操作验证
├── src/                         # 渲染进程 (React)
│   ├── App.jsx                  # 主组件：导航栏、标签栏、面板切换
│   ├── main.jsx                 # React 入口
│   ├── styles/main.css          # 全局样式
│   └── components/
│       ├── UnifiedPanel.jsx     # 统一 AI 面板 (对话+工具调用可视化)
│       ├── SettingsPanel.jsx    # 设置面板 (多模型配置)
│       ├── FindBar.jsx          # 页面内查找栏
│       └── BookmarkDialog.jsx   # 书签对话框
├── package.json
├── vite.config.js
└── .trae/skills/ai-browser-dev/SKILL.md
```

## 核心架构

### 进程架构

```
┌─────────────────────────────────────────────────┐
│  渲染进程 (React)                                │
│  App.jsx → Components (UnifiedPanel)             │
│  ↓ window.api.xxx() / window.api.unified.xxx()   │
├─────────────────────────────────────────────────┤
│  preload.js (contextBridge)                      │
│  exposeInMainWorld('api', { browser, tabs, ai,   │
│    analysis, action, unified, agent })           │
├─────────────────────────────────────────────────┤
│  主进程 (Node.js)                                │
│  main.js                                         │
│  ├── TabManager (tab_manager.js)                 │
│  ├── IPC handlers (注册所有 ipcMain.handle)       │
│  ├── LLMProvider (llm_provider.js)               │
│  ├── Analyzer (analyzer.js)                      │
│  ├── ActionExecutor (action_executor.js)        │
│  │   └── DOM变更检测 (_captureDomFingerprint)    │
│  ├── AgentLoop (agent_loop.js)                   │
│  │   └── 循环检测 (_checkLoop)                   │
│  └── ToolExecutor (tool_executor.js) 双引擎       │
│      ├── ElectronEngine (electron_engine.js)     │
│      │   · click → sendInputEvent (完整事件链)    │
│      │   · type  → insertText                   │
│      │   · key   → sendInputEvent               │
│      ├── JS 注入引擎 (execute_js)                │
│      │   · 任意 JS 代码，不受 CSP 限制            │
│      └── UncertaintyGuard (uncertainty_guard.js) │
│          · DOM 变更感知 (captureDomSnapshot)      │
│          · 循环检测 (checkLoop)                   │
│          · 操作验证 (verifyOperation)             │
└─────────────────────────────────────────────────┘
```

### API 通信模式

所有渲染进程→主进程通信通过 `window.api` 对象：

```javascript
// 渲染进程调用
const result = await window.api.browser.navigate('https://example.com')
const tabs = await window.api.tabs.list()

// 事件监听（返回清理函数）
const unsubscribe = window.api.tabs.onUpdated((data) => { ... })
// 组件卸载时调用: unsubscribe()
```

### 安全原则

- `contextIsolation: true` — 渲染进程不能直接访问 Node.js
- `nodeIntegration: false` — 禁止渲染进程使用 require
- 所有 IPC 通过 `contextBridge.exposeInMainWorld` 暴露
- **关键**: 向主进程发送数据前必须检查 `mainWindow.isDestroyed()`
- 使用 `safeSend(channel, data)` 辅助函数替代直接 `mainWindow.webContents.send()`

## 关键模块说明

### TabManager (`electron/tab_manager.js`)

- **职责**: 多标签页生命周期管理、事件绑定/解绑、上下文菜单
- **关键方法**: `createTab(url)`, `closeTab(id)`, `switchTab(id)`, `getActiveBrowserView()`
- **事件清理**: `closeTab` 必须调用 `_detachTabEvents()` 移除所有事件监听器，防止内存泄漏
- **数据结构**: `tabs: Map<id, { id, browserView, url, title, loading, favicon, _eventHandlers }>`

### LLMProvider (`electron/ai/llm_provider.js`)

- **职责**: 多模型统一适配，支持流式和非流式
- **支持的 provider**: `openai` (默认), `ollama`, `qwen`
- **关键方法**: `chat(messages, options)` 非流式, `chatStream(messages, options)` 流式生成器
- **options.tools**: 传入 `TOOL_DEFINITIONS` 启用 Function Calling

### ToolExecutor (`electron/ai/tool_executor.js`)

- **职责**: 执行 AI 调用的工具，返回结果给 AI
- **双引擎架构**:
  - **引擎1 Electron API** (`electron_engine.js`): `click_element`（sendInputEvent 完整事件链）、`type_text`（insertText）、`press_key`（键盘事件）— 可靠交互
  - **引擎2 JS 注入** (`execute_js`): AI 生成任意 JS 代码注入执行 — 灵活操作，不受 CSP 限制
- **不确定性检测** (`uncertainty_guard.js`): DOM 变更感知、循环检测、操作结果验证
- **17 种工具**: `collect_page_context`, `execute_js`, `get_network_requests`, `navigate_to`, `extract_page_scripts`, `get_page_html`, `screenshot`, `click_element`, `type_text`, `press_key`, `wait_for_element`, `wait_for_navigation`, `open_new_tab`, `close_current_tab`, `extract_images`, `extract_links`, `scroll_to_element`
- **依赖注入**: 通过 `deps` 参数传入 `{ browserView, analyzer, actionExecutor, tabManager }`

### 统一 AI 工具调用循环 (`ai:unified-chat` / `ai:unified-chat-stream`)

核心流程：
```
用户消息 → AI 分析 → AI 决定调用工具 → 客户端执行工具 → 结果返回AI → 循环
直到 AI 返回最终文本回复（不调用工具）
```

## 开发规范

### 添加新 IPC 通道

1. 在 `electron/main.js` 的 `registerIpcHandlers()` 中注册 handler
2. 在 `electron/preload.js` 中暴露 API
3. 在渲染进程 React 组件中通过 `window.api.xxx()` 调用

```javascript
// 1. main.js - registerIpcHandlers()
ipcMain.handle('feature:action', async (event, { param }) => {
  // 逻辑
  return { success: true, data: result }
})

// 2. preload.js
feature: {
  action: (param) => ipcRenderer.invoke('feature:action', { param }),
}

// 3. React 组件
const result = await window.api.feature.action(param)
```

### 添加新 AI 工具

1. 在 `electron/ai/tool_definitions.js` 中添加工具定义
2. 在 `electron/ai/tool_executor.js` 的 `execute()` 中添加 case
3. 实现对应的 `_toolName()` 方法

### 安全检查

```javascript
// 发送事件到渲染进程前必须检查
function isWindowValid() {
  return mainWindow && !mainWindow.isDestroyed()
}

function safeSend(channel, data) {
  if (isWindowValid()) {
    mainWindow.webContents.send(channel, data)
  }
}
```

### 样式规范

- 全部样式在 `src/styles/main.css` 中（纯 CSS，无预处理器）
- 使用 CSS 变量定义主题色
- 组件样式通过 className 隔离

## 启动命令

```bash
npm run dev      # 开发模式 (Vite + Electron 并行)
npm run build    # 构建生产版本
```

## 常见开发任务

### 扩展右键菜单

编辑 `electron/tab_manager.js` 的 `buildContextMenu()` 方法，添加菜单项。

### 添加新面板

1. 创建 `src/components/NewPanel.jsx`
2. 在 `src/App.jsx` 中导入并添加面板切换逻辑
3. 添加对应的 CSS 样式

### 接入新 AI 模型

1. 在 `electron/ai/llm_provider.js` 中添加 `_callNewProvider()` 和 `_streamNewProvider()` 方法
2. 在 `chat()` 和 `chatStream()` 中添加 provider 分支
3. 在 `src/components/SettingsPanel.jsx` 中添加配置项

### 实现新功能

1. 先确定功能属于哪个进程（主进程 vs 渲染进程）
2. 如果是浏览器操作，用 `execute_js` 工具注入 JS 到页面
3. 如果是 UI 功能，在 React 组件中实现
4. 如果是系统功能（文件、网络等），在主进程中实现并通过 IPC 暴露