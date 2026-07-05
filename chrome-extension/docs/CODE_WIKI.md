# AI Browser — Code Wiki

> 版本：2.0.0 ｜ 更新日期：2026-07-04
> 性质：面向开发者的代码级文档，覆盖项目架构、模块职责、关键类与函数、依赖关系、运行方式

---

## 目录

1. [项目概览](#1-项目概览)
2. [技术栈与设计原则](#2-技术栈与设计原则)
3. [整体架构](#3-整体架构)
4. [目录结构](#4-目录结构)
5. [模块详解](#5-模块详解)
   - 5.1 [Background Service Worker](#51-background-service-worker)
   - 5.2 [Agent 引擎](#52-agent-引擎核心模块)
   - 5.3 [Content Scripts](#53-content-scripts)
   - 5.4 [SidePanel](#54-sidepanel)
   - 5.5 [Popup](#55-popup)
   - 5.6 [Shared 公共模块](#56-shared-公共模块)
6. [关键类与函数说明](#6-关键类与函数说明)
7. [通信机制](#7-通信机制)
8. [数据存储](#8-数据存储)
9. [安全设计](#9-安全设计)
10. [依赖关系](#10-依赖关系)
11. [项目运行方式](#11-项目运行方式)
12. [扩展性设计](#12-扩展性设计)

---

## 1. 项目概览

AI Browser 是一个基于 Chrome Extension Manifest V3 的浏览器扩展，采用纯 Vanilla JavaScript（ES Modules）开发，**无构建步骤、无依赖打包工具**，源码直接加载到 Chrome 中运行。

**核心能力：**

- AI 智能对话（基于当前页面上下文，流式输出）
- Agent 自主网页操作（三阶段执行：页面探索 → 脚本处理 → 结果汇总）
- 划词工具栏（解释/翻译/改写/摘要）
- 智能表单填充
- 脚本管理与定时任务调度
- 网络请求拦截与捕获
- 多格式数据导出（JSON/CSV/Markdown/HTML/TXT）

**架构特点：**

- Service Worker 作为中枢，统一调度服务与消息路由
- 依赖注入模式实例化服务，便于测试与替换
- Port 流式通信支持长连接，断线自动重连
- 三级存储策略（chrome.storage.local / IndexedDB / localStorage）各司其职

---

## 2. 技术栈与设计原则

| 层次 | 技术 | 说明 |
|------|------|------|
| 扩展框架 | Chrome Extension Manifest V3 | Service Worker 替代 Background Page |
| 编程语言 | Vanilla JavaScript (ES Modules) | 无 TypeScript，无编译 |
| 构建系统 | 无 | 直接加载源码到 Chrome |
| UI 渲染 | Vanilla DOM + Shadow DOM | 无框架依赖，Shadow DOM 隔离样式 |
| 样式方案 | 内联 CSS + CSS Custom Properties | 通过 JS 动态注入 |
| AI 后端 | OpenAI 兼容 API | 通过服务端代理 `/api/ai-proxy/chat` |
| 认证机制 | HMAC-SHA256（纯 JS 实现） | AppKey + Timestamp 签名 |
| 数据存储 | chrome.storage.local / IndexedDB / localStorage | 三级存储策略 |
| 进程通信 | chrome.runtime (RPC + Port) / BroadcastChannel | 多种通信模式 |
| 默认模型 | deepseek-v4-pro | 可配置切换 |

**设计原则：**

1. **零依赖**：所有功能用原生 JS 实现，避免外部库带来的体积与版本管理成本
2. **服务化分层**：每个服务单一职责，通过构造函数注入依赖
3. **流式优先**：长任务（AI 对话、Agent 执行）全部使用 Port 流式传输
4. **优雅降级**：网络错误、Port 断开、Service Worker 重启等场景均有兜底逻辑
5. **安全边界**：HMAC 签名、域名策略、Nonce 验证、XSS 防护多层防御

---

## 3. 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                    POPUP (popup.js)                           │
│  快速对话入口 │ 脚本管理 │ 设置面板 → 引导至 SidePanel        │
└──────────────────────────┬───────────────────────────────────┘
                           │ chrome.storage (pendingMessage)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│             SIDE PANEL (sidepanel.js)                         │
│  聊天 UI │ Agent 模式 │ 设置 │ 文件上传 │ 导出 │ 功能面板     │
└──────┬───────────────────────────────────┬───────────────────┘
       │ Port (ai-stream / agent-stream)   │ RPC (callService)
       ▼                                   ▼
┌──────────────────────────────────────────────────────────────┐
│          BACKGROUND SERVICE WORKER (index.js)                 │
│                                                               │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐   │
│  │ConfigService  │  │  AIService    │  │  AgentService    │   │
│  │StorageService │  │  (streaming)  │  │  → agent-runner  │   │
│  └──────────────┘  └───────────────┘  │  → dom-executor  │   │
│                                        │  → tool-builder  │   │
│  ┌──────────────┐  ┌───────────────┐  │  → judge         │   │
│  │ScriptService  │  │  ToolService  │  │  → todo-sched.   │   │
│  │(sync/inject)  │  │  (search/exec)│  └──────────────────┘   │
│  └──────────────┘  └───────────────┘                          │
│                                                               │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐   │
│  │DBService      │  │ScheduledTask  │  │Other services     │   │
│  │(IndexedDB)    │  │Service        │  │(resume, record,   │   │
│  └──────────────┘  └───────────────┘  │ sandbox, etc.)    │   │
│                                        └──────────────────┘   │
└──────────────────────────┬───────────────────────────────────┘
                           │ chrome.scripting.executeScript
                           │ chrome.tabs.sendMessage
                           ▼
┌──────────────────────────────────────────────────────────────┐
│            CONTENT SCRIPTS (注入到每个页面)                    │
│                                                               │
│  network-capture.js (document_start):                         │
│    拦截 fetch/XHR，捕获网络请求                                │
│                                                               │
│  index.js (document_idle):                                    │
│    浮动按钮 │ 划词工具栏 │ 表单填充 │ 待办面板 │ 内容提取     │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│            ADMIN SERVER (外部后端)                             │
│  /api/ai-proxy/chat         - AI 模型代理（SSE 流式）         │
│  /api/ai-models/available   - 可用模型列表                    │
│  /api/scripts               - 脚本注册表                      │
│  /api/scripts/:id/inject    - 脚本代码交付                    │
│  /api/scripts/:id/memories  - 经验记忆存储                    │
│  /api/ai-proxy/parse-pdf    - PDF 文本提取                    │
│  /api/ai-proxy/upload-image - 图片上传                        │
└──────────────────────────────────────────────────────────────┘
```

**分层职责：**

| 层 | 组件 | 运行上下文 | 职责 |
|----|------|-----------|------|
| 表现层 | Popup | 扩展弹出窗口 | 快速操作入口，引导至 SidePanel |
| 交互层 | SidePanel | Chrome 原生侧面板 | 核心交互界面，聊天/Agent/设置 |
| 业务层 | Background Service Worker | 扩展 Service Worker | 服务实例化、消息路由、Agent 引擎 |
| 注入层 | Content Scripts | 页面上下文 (ISOLATED world) | 页面操作、UI 注入、内容提取 |
| 服务层 | Admin Server | 远程服务器 | AI 代理、脚本管理、数据存储 |

---

## 4. 目录结构

```
chrome-extension/
├── manifest.json              # Chrome 扩展清单（Manifest V3）
├── background/
│   ├── index.js               # Service Worker 入口：服务实例化 + 消息路由
│   └── services/
│       ├── config-service.js          # 配置管理 + HMAC-SHA256 签名
│       ├── ai-service.js              # AI API 代理（流式/非流式）
│       ├── agent-service.js           # Agent 生命周期管理
│       ├── agent-runner.js            # Agent 主运行循环（核心）
│       ├── agent-dom-executor.js      # 15+ DOM 工具实现
│       ├── agent-tool-builder.js      # LLM 工具定义构建器
│       ├── agent-judge.js             # 任务评判 + 经验记忆
│       ├── agent-payload-utils.js     # 结果截断与存储判断
│       ├── agent-resume-service.js    # Agent 断点恢复（快照）
│       ├── todo-scheduler.js          # 扁平待办调度引擎
│       ├── working-memory.js          # 工作记忆层（关键发现/决策）
│       ├── context-compressor.js      # LLM 驱动的上下文压缩
│       ├── scratchpad-service.js      # 中间推理持久化（IndexedDB）
│       ├── output-service.js          # 任务结果输出持久化
│       ├── task-archive-service.js    # 任务追溯复盘（整合 scratchpad+outputs）
│       ├── tool-service.js            # 远程脚本搜索与执行
│       ├── script-service.js          # 脚本同步与注入
│       ├── sidebar-page-service.js    # 侧边栏与页面执行管理
│       ├── db-service.js              # IndexedDB CRUD 封装
│       ├── global-data-store.js       # 跨阶段持久数据存储
│       ├── payload-store.js           # 大结果截断与召回
│       ├── domain-policy.js           # URL 域名安全策略
│       ├── human-intervention-service.js  # 人机交互介入
│       ├── task-template-service.js   # 任务模板管理
│       ├── tool-recording-service.js  # 工具调用录制
│       └── scheduled-task-service.js  # 定时任务调度
├── content/
│   ├── index.js               # 内容脚本入口（UI 注入、表单填充、内容提取）
│   └── network-capture.js     # XHR/Fetch 拦截器
├── sidepanel/
│   ├── sidepanel.html         # 侧边栏界面
│   ├── sidepanel.js           # 侧边栏逻辑（聊天、Agent、设置）
│   ├── sidepanel.css          # 侧边栏样式
│   ├── feature-panels.js      # 功能面板（执行图谱、定时任务等）
│   ├── conversation-viewer.html  # 独立对话全景窗口
│   ├── conversation-viewer.js    # 对话全景窗口逻辑
│   ├── todo-viewer.html       # 独立待办查看器窗口
│   └── todo-viewer.js         # 独立待办查看器逻辑
├── popup/
│   ├── popup.html             # Popup 界面
│   └── popup.js               # Popup 逻辑
├── shared/
│   ├── utils.js               # 公共工具函数（fetch 超时、错误码、LRU 等）
│   └── export-service.js      # 多格式导出服务
├── docs/
│   ├── 产品功能说明.md
│   ├── 产品设计文档.md
│   └── 技术架构文档.md
└── icons/
    └── icon.png               # 扩展图标（16/32/48/128px 复用）
```

---

## 5. 模块详解

### 5.1 Background Service Worker

**入口文件：** [background/index.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/index.js)

Service Worker 是整个扩展的中枢，承担三大职责：

1. **服务实例化（依赖注入）**
2. **消息路由（RPC 调度 + Port 流式）**
3. **系统事件监听（安装、闹钟、右键菜单、快捷键）**

#### 5.1.1 服务实例化流程

```javascript
// 基础服务
const configService = new ConfigService()
const storageService = new StorageService()
const aiService = new AIService(configService)
const scriptService = new ScriptService(configService)

// 页面服务
const sidebarService = new SidebarService()
const pageService = new PageService(scriptService)
const toolService = new ToolService(configService)

// Agent 相关（需先于 agentService 实例化以注入）
const toolRecordingService = new ToolRecordingService()
const agentResumeService = new AgentResumeService()
const agentService = new AgentService(
  configService, toolService, pageService, scriptService,
  toolRecordingService, agentResumeService
)

// 辅助服务
const taskTemplateService = new TaskTemplateService()
const scratchpadService = new ScratchpadService()
const outputService = new OutputService()
const taskArchiveService = new TaskArchiveService()
const humanInterventionService = new HumanInterventionService(/* onRequest 回调 */)
const scheduledTaskService = new ScheduledTaskService({
  navigate, injectScript, sendAgentMessage  // 三个执行器回调
})
```

所有服务实例挂载到 `services` 对象，键名即为 RPC 调用时的 `service` 参数。

#### 5.1.2 RPC 调度机制

SidePanel 和 Popup 通过统一的 `callService` 消息格式调用后台服务：

```javascript
// 请求
{ type: 'callService', service: 'configService', method: 'getAIConfig', args: [] }

// 成功响应
{ error: null, data: { model: 'deepseek-v4-pro', ... } }

// 错误响应
{ error: 'Method not found: configService.xxx', data: null }
```

Service Worker 通过 `Promise.resolve` 包装方法调用，兼容同步和异步方法返回值。

#### 5.1.3 系统事件监听

| 事件 | 触发时机 | 处理逻辑 |
|------|---------|---------|
| `chrome.runtime.onInstalled` | 扩展安装/更新 | 同步脚本、设置侧边栏行为、创建右键菜单、启动定时任务闹钟、清理过期快照 |
| `chrome.alarms.onAlarm` | 闹钟触发 | `sync-scripts` 同步脚本、`scheduled-task-check` 检查到期任务 |
| `chrome.contextMenus.onClicked` | 右键菜单点击 | 转发到 content script 执行对应 action |
| `chrome.commands.onCommand` | 快捷键 | `open-sidebar` 打开侧边栏 |

#### 5.1.4 后台服务模块清单

| 服务名 | 文件 | 职责 |
|--------|------|------|
| ConfigService | [config-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/config-service.js) | 配置读写、HMAC 签名生成、模型列表查询 |
| StorageService | config-service.js | chrome.storage.local 封装、聊天历史管理 |
| AIService | [ai-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/ai-service.js) | AI API 调用（流式/非流式），SSE 解析 |
| ScriptService | [script-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/script-service.js) | 脚本同步、URL 模式匹配、按标签页注入 |
| SidebarService | [sidebar-page-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/sidebar-page-service.js) | 侧边栏打开/关闭、面板行为配置 |
| PageService | sidebar-page-service.js | 页面级脚本执行、内容提取、统计上报 |
| ToolService | [tool-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/tool-service.js) | 远程脚本搜索与执行（JS/API 双模式）、LRU 结果缓存 |
| AgentService | [agent-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-service.js) | Agent 生命周期、Port 绑定、状态管理 |
| DBService | [db-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/db-service.js) | IndexedDB 通用 CRUD（4 个 store） |
| TaskTemplateService | [task-template-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/task-template-service.js) | 任务模板 CRUD、分类筛选、JSON 导入导出 |
| ToolRecordingService | [tool-recording-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/tool-recording-service.js) | 工具调用录制、会话管理、IndexedDB 持久化 |
| AgentResumeService | [agent-resume-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-resume-service.js) | Agent 快照定期保存（10s 间隔）、断点恢复 |
| HumanInterventionService | [human-intervention-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/human-intervention-service.js) | 人机交互请求（approval/input/choice）、超时管理 |
| ScheduledTaskService | [scheduled-task-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/scheduled-task-service.js) | 定时任务 CRUD、全局心跳闹钟、到期执行 |
| ScratchpadService | [scratchpad-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/scratchpad-service.js) | 中间推理持久化、断点续传、导出 |
| OutputService | [output-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/output-service.js) | 任务结果持久化、完整对话与状态归档 |
| TaskArchiveService | [task-archive-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/task-archive-service.js) | 任务追溯复盘、对比分析、归档导出 |

### 5.2 Agent 引擎（核心模块）

Agent 引擎是项目最复杂的模块，由多个子模块协同工作：

```
AgentService (agent-service.js)
  ├── agent-runner.js       ← 主运行循环（LLM 调用、工具分发、阶段切换）
  ├── agent-dom-executor.js ← 15+ DOM 工具实现
  ├── agent-tool-builder.js ← 工具定义构建器（统一 tool schema）
  ├── agent-judge.js        ← 任务评判 & 经验记忆
  ├── agent-payload-utils.js← 结果截断与存储判断
  ├── todo-scheduler.js     ← 扁平待办调度引擎
  ├── working-memory.js     ← 工作记忆层（关键发现/决策）
  ├── context-compressor.js ← LLM 驱动的上下文压缩
  ├── global-data-store.js  ← 跨阶段持久数据存储
  └── payload-store.js      ← 大结果截断与召回
```

#### 5.2.1 Agent 生命周期

```
用户发送 Agent 指令
    │
    ▼
agentService.startAgent(port, userMessage, chatHistory)
    │
    ├── 检查是否已有运行中的 Agent（同 tabId），如有则中止旧任务
    ├── 创建运行上下文 ctx（状态、缓存、配置）
    ├── 初始化 TodoScheduler、PayloadStore、GlobalDataStore
    ├── PayloadStore.inheritFromLastSession() 继承上一轮 5 分钟内数据
    ├── 通知 UI（todoUpdate / conversationClear）
    ├── 启动 ToolRecordingService 会话
    ├── 启动 AgentResumeService 定期快照（10s）
    │
    ▼
runAgent(ctx) — agent-runner.js
    │
    ├── 1. 加载域名安全策略 (domainPolicy.load)
    ├── 2. 读取 Agent 配置（maxRounds、enableJudge、debug）
    ├── 3. 清洗历史消息（移除尾部失败记录、压缩长 assistant 消息）
    ├── 4. 自动读取当前页面内容（extractPageContent）
    ├── 5. 自动搜索服务端工具库（关键词提取 + 意图扩展）
    ├── 6. 构建系统提示词（注入页面上下文和脚本信息）
    ├── 7. 初始化 WorkingMemory
    │
    ▼
主循环开始（while aiRequestCount < maxRounds）
    │
    ├── 检查中止信号、超时（600s）、工具调用上限（30+）
    ├── 检查 Port 连接（用户关闭 SidePanel 则终止）
    ├── 清理上一轮临时消息
    ├── 生成收敛提示（70%/85% 预算阈值）
    ├── 注入待办进度上下文
    ├── 构建当前轮工具定义列表
    │
    ├── API 请求（带重试、超时、fallback）
    │     │
    │     ├── 工具调用响应 → 逐个执行工具
    │     │     ├── 工具名称验证（幻觉拦截）
    │     │     ├── 执行工具（DOM/脚本/辅助）
    │     │     ├── 待办进度匹配与更新
    │     │     ├── 硬性规则检查（强制 finish_task）
    │     │     ├── PayloadStore 存储判断
    │     │     └── 工具录制记录
    │     │
    │     ├── 纯文本响应 → 流式输出并结束
    │     │
    │     └── 错误处理 → 重试 / fallback / 终止
    │
    ├── 消息上下文压缩（超过 40 条时，LLM 压缩）
    │
    └── finish_task → 输出结果 → 事后评判 → 结束
```

#### 5.2.2 工具体系

**工具分类：**

| 类别 | 工具名 | 说明 |
|------|--------|------|
| 页面读取 | `read_page_content`, `extract_content`, `get_interactive_elements`, `get_element_info`, `find_text_on_page` | 零 LLM 成本 |
| 页面交互 | `click_element`, `fill_input`, `hover_element`, `select_dropdown`, `press_key` | 模拟用户操作 |
| 导航控制 | `navigate_to`, `go_back`, `go_forward`, `scroll_page`, `wait_for_element` | 页面跳转与等待 |
| 截图 | `screenshot_visible` | 可视区域截图 |
| 脚本执行 | `inject_script_N`, `generate_script` | 服务端脚本 / 动态生成代码 |
| 数据管理 | `recall_data`, `search_tools` | 召回存储数据 / 搜索工具库 |
| 任务控制 | `create_todo`, `finish_task` | 创建待办 / 完成任务 |

**工具执行流程：**

```
LLM 返回 tool_calls
   │
   ├── 验证工具名是否在当前允许列表（幻觉拦截）
   ├── 根据 toolName 分发：
   │     ├── DOM 工具 → executeDOMTool (chrome.scripting.executeScript, MAIN world)
   │     ├── inject_script_N → ToolService.executeTool (MAIN world)
   │     ├── generate_script → 动态 Function 执行
   │     ├── recall_data → payloadStore.query / globalDataStore.query
   │     ├── search_tools → toolService.searchScripts
   │     ├── create_todo → todoScheduler.submitTodo (校验+建表)
   │     └── finish_task → 终止循环 + 输出 + 评判
   │
   ├── 结果处理：
   │     ├── shouldStoreToPayload? → storeToPayload（存完整 + 返摘要 + ID）
   │     └── 否 → smartTruncateResult（轻度截断）
   │
   ├── 待办进度匹配（todoScheduler.markTodoResult）
   ├── 硬性规则检查（连续失败/无进展 → 强制 finish_task）
   └── 工具录制（toolRecordingService.record）
```

#### 5.2.3 TodoScheduler 扁平待办调度

[TodoScheduler](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/todo-scheduler.js) 是 Agent 的进度管理核心：

- **模板生成：** `getTemplate()` 返回结构化模板供 AI 填充
- **严格校验：** `submitTodo(items)` 校验 id/action/description 完整性、ID 唯一性
- **进度追踪：** `getCurrentTodo()` / `markTodoResult(status, outputData)`
- **收敛控制：**
  - 70% 预算 → 软收敛提示
  - 85% 预算 → 紧急收敛提示
- **硬性规则：**
  - 连续 5 次无进展 → 强制 `finish_task`
  - 连续 3 次脚本失败 → 强制 `finish_task`

#### 5.2.4 数据流设计

```
GlobalDataStore（任务级持久存储）
  │
  ├── set(key, data, source)     ← 待办完成时存储 dataOutputKey
  ├── get(key)                   ← recall_data 时查询
  ├── has(key)                   ← 依赖校验
  ├── getAllSummaries()          ← 阶段切换时生成摘要
  └── query({ entry_id, tool_name }) ← recall_data 调用入口

PayloadStore（大结果截断与召回）
  │
  ├── add(toolName, data, summary)  ← 工具结果超阈值时存储
  ├── query({ entry_id, filter, fields }) ← AI 召回完整数据
  ├── inheritFromLastSession(newSessionId, maxAgeMs) ← 跨会话数据继承
  └── getSummaryForFinish()         ← finish_task 时汇总

WorkingMemory（工作记忆）
  │
  ├── init(sessionId, userMessage, pageContent)
  ├── 记录：discoveries / decisions / excluded / errors / dataRefs
  └── 自动注入到上下文，避免长任务失忆
```

#### 5.2.5 上下文管理

- **消息清洗：** 移除尾部连续失败记录，避免 LLM 被错误历史误导
- **消息压缩：** 超过 40 条时使用 LLM 生成结构化摘要（关键发现/决策/排除方案/数据引用）
- **孤立消息清理：** 压缩后移除没有对应 `tool_calls` 的孤立 `tool` 消息
- **简单请求快速路径：** 检测追问或数据操作类请求（如"导出 csv"），跳过页面探索直接回答

#### 5.2.6 Port 弹性设计

Agent 运行过程中 SidePanel 可能断开（用户关闭侧边栏），处理策略：

- Agent 不终止，仅解除 Port 绑定（`detachPortByPort`）
- 后续消息暂存到 `state.messages` 数组
- SidePanel 重连后发送 `agentAttach`，回放暂存消息
- 主循环每轮检查 Port 心跳，断开则终止任务避免空转

### 5.3 Content Scripts

#### 5.3.1 注入策略

| 脚本 | 注入时机 | 职责 |
|------|---------|------|
| [network-capture.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/content/network-capture.js) | `document_start` | 拦截 XHR/Fetch，流式读取响应体（16KB 上限） |
| [index.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/content/index.js) | `document_idle` | UI 注入、表单填充、内容提取、待办面板 |

#### 5.3.2 主要功能模块

**Shadow DOM 隔离：** 所有注入的 UI（浮动按钮、划词工具栏、待办面板）使用 `mode: 'closed'` 的 Shadow DOM 隔离样式。

**浮动按钮系统：**

- 5 个按钮（工具箱、工具、待办、设置、AI）固定在页面右侧边缘
- MutationObserver 守护：被页面脚本移除时自动重新注入
- 扩展上下文失效检测：提醒用户刷新页面

**划词工具栏：**

- 监听 `mouseup` 事件，检测选中文本长度 ≥ 3 字符
- 使用 `getBoundingClientRect()` 定位工具栏在选中文本上方
- 四个操作按钮：解释、翻译、改写、摘要

**智能表单填充：**

- MutationObserver 监听 DOM 变化，持续扫描新增表单
- 过滤条件：至少 2 个可填写字段，排除纯搜索框
- 使用原生 `HTMLInputElement.prototype.value` setter 赋值，兼容 React/Vue 受控组件
- WeakMap 避免重复注入按钮

**网络请求拦截：**

- 在 `document_start` 阶段拦截 `fetch` 和 `XMLHttpRequest`
- 流式读取响应体（`ReadableStream`），上限 16KB
- 批量上报（500ms 定时器合并），减少消息频率
- 通过 `window.__aiBrowserGetCaptured` 暴露受控查询接口供 Agent 使用

**Nonce 回调验证：**

```javascript
// Content Script 生成随机 Nonce（防枚举）
const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36)
Object.defineProperty(window, '__AI_BROWSER_CB_NONCE__', {
  value: nonce, writable: false, configurable: false, enumerable: false
})

// 注入脚本回调必须携带 nonce
window.postMessage({ type: 'AI_BROWSER_CALLBACK', nonce, data })

// Content Script 校验 nonce 匹配后转发到 Background
```

### 5.4 SidePanel

**核心文件：** [sidepanel/sidepanel.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/sidepanel/sidepanel.js)

#### 5.4.1 聊天界面

- Markdown 渲染（支持代码块、链接、列表）
- XSS 安全：使用 `textContent` 渲染，链接协议过滤（仅 http/https/mailto）
- 流式字符级输出动画
- 附件持久化：图片 base64 + PDF 文本通过 `localStorage` 同步存取

#### 5.4.2 Agent 模式

- 步骤卡片渲染：工具名称、参数、执行状态、结果摘要
- 工具调用搜索结果的专用展示
- 阶段切换和进度更新

#### 5.4.3 文件上传

- **图片：** 转 base64 Data URL，附加到消息中（需视觉模型支持）
- **PDF：** 发送到服务端 `/api/ai-proxy/parse-pdf` 提取文本，附加到消息上下文
- **附件持久化：** `localStorage` 同步存取，关闭重开 SidePanel 后恢复

#### 5.4.4 功能面板 (feature-panels.js)

可拖动的浮动窗口，包含标签页：

| 面板 | 功能 |
|------|------|
| 资源监控 | Token 使用量、API 调用次数、IndexedDB 各 store 统计 |
| 任务模板 | 模板管理和快速启动 |
| 工具录制 | 录制会话列表和详情 |
| 定时任务 | 任务 CRUD 和管理 |
| 调试日志 | Agent 调试信息实时展示 |

### 5.5 Popup

**文件：** [popup/popup.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/popup/popup.js)

三标签页结构：AI 助手、脚本管理、设置。所有操作最终引导用户打开 SidePanel 以获得完整体验。

通过 `chrome.storage.local` 的 `pendingMessage` 键向 SidePanel 传递待发送消息。

### 5.6 Shared 公共模块

#### 5.6.1 utils.js

[shared/utils.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/shared/utils.js) 提供跨模块共享的工具函数：

| 导出 | 类型 | 用途 |
|------|------|------|
| `ERROR_CODES` | 常量对象 | 统一错误码体系（网络/认证/工具/数据/系统） |
| `AppError` | 类 | 应用错误类，携带 code/label/message/detail/cause |
| `fetchWithTimeout` | 函数 | 带超时与重试的 fetch（默认 30s，5xx 重试） |
| `escapeHtml` | 函数 | HTML 转义 |
| `isSafeUrl` | 函数 | URL 安全校验（阻止 javascript:/data: 等危险协议） |
| `isIPAddress` | 函数 | IPv4/IPv6 地址检测 |
| `isSystemUrl` | 函数 | 系统页面检测（chrome://、edge:// 等） |
| `safeJsonStringify` | 函数 | 处理循环引用的 JSON 序列化 |
| `globToRegex` | 函数 | glob 转 RegExp（防 ReDoS） |
| `callServiceWithTimeout` | 函数 | chrome.runtime.sendMessage 包装，带超时 |
| `LRUCache` | 类 | 简单 LRU 缓存实现 |

#### 5.6.2 export-service.js

[shared/export-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/shared/export-service.js) 支持五种导出格式：

- JSON：`safeJsonStringify` 格式化输出
- CSV：自动提取字段，处理逗号/换行转义
- Markdown：表格格式
- HTML：带样式的可读 HTML
- TXT：纯文本

---

## 6. 关键类与函数说明

### 6.1 ConfigService

**文件：** [config-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/config-service.js)

| 方法 | 签名 | 说明 |
|------|------|------|
| `getAIConfig` | `() => Promise<AIConfig>` | 读取 AI 配置（合并默认值） |
| `saveAIConfig` | `(config) => Promise<AIConfig>` | 串行化保存 AI 配置 |
| `getSyncConfig` | `() => Promise<SyncConfig>` | 读取同步配置 |
| `getAgentConfig` | `() => Promise<AgentConfig>` | 读取 Agent 配置（含 maxRounds、enableJudge） |
| `getAppAuth` | `() => Promise<{appKey, appSecret}>` | 获取认证信息 |
| `generateAuthHeaders` | `(appKey, appSecret) => Promise<Object>` | 生成 HMAC-SHA256 签名请求头 |
| `getAvailableModels` | `() => Promise<Model[]>` | 查询服务端可用模型列表 |
| `getAIProxyUrl` | `() => Promise<string>` | 获取 AI 代理接口 URL |
| `getPdfUploadConfig` | `() => Promise<{url, headers}>` | 获取 PDF 上传配置 |
| `getImageUploadConfig` | `() => Promise<{url, headers}>` | 获取图片上传配置 |

**关键实现：** 纯 JS HMAC-SHA256（`_sha256` / `_hmacSha256`），不依赖 `crypto.subtle`，兼容 HTTP 页面上下文。配置保存使用 `_saveChain` 串行化锁防止并发读-改-写。

### 6.2 AIService

**文件：** [ai-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/ai-service.js)

| 方法 | 签名 | 说明 |
|------|------|------|
| `chat` | `(messages, options) => Promise<{content, usage, model}>` | 非流式 AI 对话 |
| `chatStream` | `(port, messages, options) => Promise<void>` | 流式 AI 对话，通过 Port 推送 chunk |
| `_buildBody` | `(messages, config, stream) => Object` | 构建 OpenAI 兼容请求体 |
| `_cleanupStream` | `(portId, onDisconnect, port) => void` | 清理流式连接资源 |

**关键设计：**

- 每个流绑定独立 `AbortController`，Port 断开时中止 fetch
- `safePost` 包装 `postMessage`，捕获异常并标记端口状态
- SSE 解析：按行分割，提取 `data:` 前缀，处理 `[DONE]` 标记

### 6.3 AgentService

**文件：** [agent-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-service.js)

| 方法 | 签名 | 说明 |
|------|------|------|
| `startAgent` | `(port, userMessage, chatHistory) => Promise<void>` | 启动 Agent（含旧任务中止、状态初始化） |
| `isRunning` | `(tabId) => boolean` | 检查指定标签页是否有运行中 Agent |
| `attachPort` | `(tabId, port) => void` | 重连 Port 并回放暂存消息 |
| `detachPortByPort` | `(port) => void` | 解除 Port 绑定（Agent 继续运行） |
| `postToUI` | `(tabId, msg) => void` | 向 UI 推送消息（Port 断开时暂存） |
| `checkPortConnected` | `(tabId) => boolean` | 心跳检测 Port 是否连接 |
| `run` | `(tabId, userMessage, chatHistory) => Promise<void>` | 委托给 `runAgent(ctx)` |

**关键常量：** `MAX_AI_REQUESTS=15`、`MAX_TOOL_CALLS=30`、`TIMEOUT_MS=600000`（10 分钟）

### 6.4 runAgent (agent-runner.js)

**文件：** [agent-runner.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js)

```javascript
export async function runAgent(ctx)
```

**参数 `ctx` 包含：**

- 服务依赖：`configService`, `toolService`, `scriptService`
- 状态对象：`agentStates`, `payloadStore`, `todoScheduler`, `domainPolicy`
- 缓存：`filteredScriptsCache`, `domainMismatchLogged`, `pageReadCache`
- 限制：`MAX_AI_REQUESTS`, `TIMEOUT_MS`, `ACTION_TIMEOUT_MS`
- 回调：`postToUI`, `yieldUI`, `checkPortConnected`
- 任务数据：`tabId`, `userMessage`, `chatHistory`, `toolRecordingService`

**核心循环逻辑：**

1. 加载域名策略与 Agent 配置
2. 清洗历史消息（移除尾部失败、压缩长 assistant）
3. 自动读取页面内容 + 搜索服务端工具
4. 构建系统提示词 + 注入页面上下文
5. 主循环：检查中止/超时 → 清理临时消息 → Port 心跳 → 构建工具 → API 请求 → 工具分发 → 上下文压缩
6. `finish_task` 时输出结果 + 调用 `runJudge` 事后评判

### 6.5 executeDOMTool (agent-dom-executor.js)

**文件：** [agent-dom-executor.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-dom-executor.js)

```javascript
export async function executeDOMTool(tabId, toolName, args)
```

通过 `chrome.scripting.executeScript` 在页面 MAIN world 执行工具函数。

**关键设计：**

- 每个工具函数自包含 `qsa` 辅助函数定义（闭包变量序列化丢失）
- `qsa` 支持 `:contains("文本")` 伪类与 Shadow DOM 穿透
- 工具函数返回字符串或对象，由调用方包装为 `{ok, result}`

### 6.6 buildTools (agent-tool-builder.js)

**文件：** [agent-tool-builder.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-tool-builder.js)

```javascript
export function buildTools(searchResults, currentPageUrl, round, scriptService, filteredScriptsCache, domainMismatchLogged)
```

构建统一的 LLM 工具定义列表（OpenAI function calling schema）。

**工具排序策略：** 服务端脚本按经验记忆成功率降序排列，描述中标注触发词、是否需登录、分页策略、成功率。

### 6.7 TodoScheduler

**文件：** [todo-scheduler.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/todo-scheduler.js)

| 方法 | 说明 |
|------|------|
| `getTemplate(userMessage, pageContent, searchResults)` | 生成待办模板提示词 |
| `submitTodo(items)` | 校验并接受待办列表 |
| `getCurrentTodo()` | 获取当前待办 |
| `markTodoResult(status, outputData)` | 标记当前待办结果，推进指针 |
| `getProgress()` | 返回 `{total, completed}` 进度 |
| `checkHardRules()` | 检查硬性规则，返回是否强制 finish_task |
| `getConvergenceHint()` | 返回收敛提示（70%/85% 阈值） |

### 6.8 PayloadStore

**文件：** [payload-store.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/payload-store.js)

| 方法 | 说明 |
|------|------|
| `add(toolName, data, summary, metadata)` | 存储大结果，返回 entry ID（p1, p2...） |
| `query(options)` | 按 entry_id/tool_name 查询，支持 filter/fields |
| `inheritFromLastSession(newSessionId, maxAgeMs)` | 继承上一轮 5 分钟内数据 |
| `getSummaryForFinish()` | finish_task 时汇总所有条目 |
| `setSessionId(sessionId)` | 设置当前会话 ID（任务隔离） |

**关键设计：** 单调递增 ID 计数器（`_idCounter`）避免 FIFO 淘汰后 ID 复用导致数据错乱。

### 6.9 DBService

**文件：** [db-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/db-service.js)

通用的 IndexedDB CRUD 封装，单例模式管理连接。

**对象存储仓：**

| Store | keyPath | 索引 | 用途 |
|-------|---------|------|------|
| `task_templates` | id | category, updatedAt | 任务模板 |
| `tool_recordings` | id | sessionId, timestamp | 工具调用录制 |
| `agent_snapshots` | id | tabId, createdAt | Agent 快照 |
| `scheduled_tasks` | id | nextRun, enabled | 定时任务 |

**通用方法：** `put`, `putBatch`, `get`, `getAll`, `del`, `clear`, `queryByIndex`, `genId`

### 6.10 Shared 工具函数

#### `fetchWithTimeout(url, options, timeoutMs, retries, retryOnStatus)`

带超时与重试的 fetch：

- 默认超时 30s
- 仅对网络错误和指定状态码（429/500/502/503/504）重试
- 重试间隔指数退避（1s, 2s, 3s...）
- 超时抛出 `AppError(NETWORK_TIMEOUT)`

#### `callServiceWithTimeout(message, timeoutMs)`

`chrome.runtime.sendMessage` 包装：

- 默认超时 30s
- 处理 `chrome.runtime.lastError`
- 扩展上下文失效时返回 `SW_UNAVAILABLE` 错误码

#### `LRUCache`

基于 `Map` 的 LRU 缓存（get/set 时移到末尾，超容量删除最旧）。

---

## 7. 通信机制

### 7.1 通信模式汇总

| 模式 | 协议 | 方向 | 用途 |
|------|------|------|------|
| RPC | `chrome.runtime.sendMessage` | SidePanel/Popup → Background | 服务方法调用（callService） |
| 流式 | `chrome.runtime.connect` (Port) | SidePanel ↔ Background | AI 对话流式输出、Agent 事件流 |
| Tab 消息 | `chrome.tabs.sendMessage` | Background → Content Script | 页面内容提取、待办更新、Agent 指令 |
| Runtime 消息 | `chrome.runtime.sendMessage` | Content Script → Background | 注入回调、表单填充请求、侧边栏控制 |
| BroadcastChannel | `BroadcastChannel` | 跨上下文 | 跨窗口/iframe 事件广播（todo/conversation） |
| Storage 事件 | `chrome.storage.onChanged` | 全局 | 配置变更通知、待发消息传递 |

### 7.2 RPC 消息协议

```javascript
// 请求
{
  type: 'callService',
  service: 'configService',    // 服务名（services 对象键名）
  method: 'getAIConfig',       // 方法名
  args: []                     // 参数数组
}

// 成功响应
{ error: null, data: { model: 'deepseek-v4-pro', ... } }

// 错误响应
{ error: 'Method not found: configService.xxx', data: null }
```

### 7.3 Port 流式消息协议

**AI 对话流（port.name = 'ai-stream'）：**

```javascript
// SidePanel → Background
{ type: 'streamStart', messages: [...], options: {...} }

// Background → SidePanel
{ type: 'streamChunk', content: '你' }
{ type: 'streamChunk', content: '好' }
{ type: 'streamDone' }
{ type: 'streamError', error: '...' }
```

**Agent 流（port.name = 'agent-stream'）：**

```javascript
// SidePanel → Background
{ type: 'agentStart', userMessage: '...', chatHistory: [...] }
{ type: 'agentAttach' }  // 重连已有 Agent

// Background → SidePanel
{ type: 'agentStart' }
{ type: 'agentStep', step: 1, toolName: 'extract_content', toolArgs: {...} }
{ type: 'agentStepResult', step: 1, toolName: '...', result: '...', done: false }
{ type: 'agentTodoUpdate', data: {...} }
{ type: 'agentStatus', text: '阶段1 第3轮' }
{ type: 'agentDebug', label: '...', detail: '...' }
{ type: 'streamChunk', content: '...' }  // finish_task 输出
{ type: 'streamDone' }
{ type: 'agentError', error: '...' }
{ type: 'heartbeat' }  // Port 心跳检测
```

### 7.4 其他消息类型

| type | 方向 | 用途 |
|------|------|------|
| `openSidebar` / `toggleSidebar` | Content → Background | 浮动按钮触发侧边栏 |
| `injectCallback` | Content → Background | 注入脚本回调反馈 |
| `todoUpdate` | Background → Content | 待办面板更新 |
| `formFillRequest` | Content → Background | 表单填充 AI 请求 |
| `checkAgentStatus` | Content → Background | 查询 Agent 运行状态 |
| `humanInterventionRequest` | Background → SidePanel | 人工介入请求 |
| `humanInterventionRespond` | SidePanel → Background | 人工介入响应 |
| `network_capture_batch` | Content → Background | 批量网络捕获上报 |
| `scheduledAgentMessage` | Background → SidePanel | 定时任务触发 Agent 消息 |

---

## 8. 数据存储

### 8.1 三级存储策略

| 存储 | 用途 | 特点 |
|------|------|------|
| `chrome.storage.local` | 配置、聊天记录、注入回调、待发消息 | 异步 API，跨上下文可访问，5MB 配额 |
| IndexedDB | 定时任务、工具录制、Agent 快照、任务模板、scratchpad、outputs | 大容量，异步，通过 DBService 封装 |
| localStorage | 附件持久化（SidePanel 内部） | 同步 API，仅限扩展 origin，可靠快速 |

### 8.2 chrome.storage.local 键值设计

| 键 | 类型 | 说明 |
|----|------|------|
| `aiConfig` | Object | AI 模型配置（model, serverUrl, maxTokens, systemPrompt） |
| `appAuth` | Object | 认证信息（appKey, appSecret） |
| `syncConfig` | Object | 同步配置（syncInterval, serverUrl, enabled） |
| `chatHistory` | Array | 聊天历史记录（最多 50 条，8000 字符截断） |
| `scripts` | Array | 已同步的脚本列表 |
| `injectCallbacks` | Array | 注入脚本回调（最多 20 条） |
| `pendingMessage` | String | 待发送消息（Popup → SidePanel） |
| `floatingToolAction` | String | 浮动按钮点击的 action |
| `selectionToolsEnabled` | Boolean | 划词工具开关 |
| `agentConfig` | Object | Agent 配置（maxRounds, enableJudge, debug, allowedDomains） |

### 8.3 IndexedDB 数据库设计

**主数据库 `ai-browser-db`（DBService 管理）：**

| Store | 用途 | 索引 |
|-------|------|------|
| `task_templates` | 任务模板 | category, updatedAt |
| `tool_recordings` | 工具调用录制 | sessionId, timestamp |
| `agent_snapshots` | Agent 断点快照 | tabId, createdAt |
| `scheduled_tasks` | 定时任务 | nextRun, enabled |

**独立数据库：**

- `ai-browser-scratchpad`：中间推理持久化（ScratchpadService）
- `ai-browser-outputs`：任务结果归档（OutputService）

### 8.4 数据流示例

**跨阶段数据流转：**

```
Stage 1: extract_content → dataOutputKey="links"
  └→ globalDataStore.set("links", [...], "s1-2")

Stage 2: inject_script_10(dataDependKeys=["links"])
  └→ globalDataStore.get("links") → 传入脚本参数
  └→ 脚本结果 → dataOutputKey="details"
  └→ globalDataStore.set("details", [...], "s2-1")

Stage 3: finish_task(dataDependKeys=["links","details"])
  └→ globalDataStore.getAllSummaries() → 注入提示词
```

**大结果截断与召回：**

```javascript
shouldStoreToPayload(result, funcName)
  → 判断结果是否超过截断阈值
  → 是：storeToPayload() 存储完整数据，返回摘要 + 存储 ID（如 "p1"）
  → 否：smartTruncateResult() 轻度截断

// AI 召回
recall_data(entry_id="p1") → payloadStore.query({ entry_id: "p1" })
```

---

## 9. 安全设计

### 9.1 HMAC-SHA256 请求签名

所有到 Admin Server 的请求携带签名头：

```
X-App-Key: <appKey>
X-Timestamp: <unix_seconds>
X-Signature: HMAC-SHA256(appSecret, appKey + timestamp)
```

采用纯 JS 实现 HMAC-SHA256（非 `crypto.subtle`），兼容 HTTP 页面上下文。使用 `TextEncoder` 进行 UTF-8 编码，正确处理中文等多字节字符。

### 9.2 域名安全策略 (DomainPolicy)

**文件：** [domain-policy.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/domain-policy.js)

- 从 `agentConfig` 加载 `allowedDomains` / `prohibitedDomains` / `blockIPAddresses`
- Agent 的 `navigate_to` 工具执行前检查目标 URL 是否在允许范围内
- 域名匹配支持 `*.example.com`、精确匹配、`www` 变体
- IPv4/IPv6 地址检测，可选阻止 IP 直连

### 9.3 URL 安全检查

```javascript
// 阻止危险协议
const BLOCKED_PROTOCOLS = ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'view-source:', 'devtools:', 'chrome-search:', 'ftp:']
// 阻止系统页面
const SYSTEM_URLS = ['chrome://', 'edge://', 'about:', 'chrome-extension://']
```

### 9.4 XSS 防护

- **聊天渲染：** 所有文本内容使用 `textContent` 赋值，不直接 `innerHTML`
- **链接过滤：** 仅允许 `http://`、`https://`、`mailto:` 协议
- **HTML 转义：** `escapeHtml()` 工具函数处理特殊字符
- **待办面板：** 所有动态内容通过 DOM API + textContent 渲染

### 9.5 Nonce 回调验证

注入脚本的回调消息通过随机 Nonce 验证来源，防止页面脚本伪造回调注入后台。Nonce 以 `enumerable: false` 定义在 window 上，防止页面脚本枚举发现。

### 9.6 脚本执行隔离

- DOM 工具通过 `chrome.scripting.executeScript` 在页面 MAIN world 执行
- 注入脚本使用 `new Function()` 包装，通过 `window.__TOOL_CONFIG__` 传参
- `finally` 块确保 `__TOOL_CONFIG__` 总被清理，避免污染下一工具

---

## 10. 依赖关系

### 10.1 服务依赖图

```
ConfigService (无依赖)
  ↓
StorageService (无依赖)
  ↓
AIService ← ConfigService
ScriptService ← ConfigService
ToolService ← ConfigService
SidebarService (无依赖)
PageService ← ScriptService
  ↓
ToolRecordingService (无依赖)
AgentResumeService ← DBService
  ↓
AgentService ← ConfigService, ToolService, PageService, ScriptService,
                ToolRecordingService, AgentResumeService
                + 内部组合: PayloadStore, DomainPolicy, TodoScheduler
  ↓
TaskTemplateService ← DBService
HumanInterventionService (无依赖，构造时注入 onRequest 回调)
ScheduledTaskService ← DBService (构造时注入 navigate/injectScript/sendAgentMessage 回调)
ScratchpadService (无依赖)
OutputService (无依赖)
TaskArchiveService ← ScratchpadService, OutputService
```

### 10.2 Agent 引擎内部依赖

```
agent-runner.js
  ├── executeDOMTool (agent-dom-executor.js)
  ├── shouldStoreToPayload, storeToPayload, smartTruncateResult, buildDataOverview (agent-payload-utils.js)
  ├── runJudge, saveToChatHistoryStorage, getTargetTab, recordMemory (agent-judge.js)
  ├── buildTools (agent-tool-builder.js)
  ├── WorkingMemory (working-memory.js)
  ├── ContextCompressor (context-compressor.js)
  ├── ScratchpadService (scratchpad-service.js)
  ├── OutputService (output-service.js)
  └── 依赖注入: configService, toolService, scriptService, payloadStore,
              todoScheduler, domainPolicy, agentStates, postToUI, ...
```

### 10.3 前端依赖

```
sidepanel.js
  ├── fetchWithTimeout, callServiceWithTimeout (shared/utils.js)
  ├── initFeaturePanels, appendDebugLogToPanel (feature-panels.js)
  └── ExportService (shared/export-service.js)

popup.js
  └── chrome.runtime.sendMessage (callService 封装)

content/index.js
  └── chrome.runtime.sendMessage, chrome.storage.local

feature-panels.js
  └── DBService (通过 callService 间接调用)
```

### 10.4 外部服务依赖

| 外部服务 | 调用方 | 用途 |
|---------|--------|------|
| Admin Server | ConfigService | 模型列表查询 |
| Admin Server | AIService | AI 对话代理（SSE） |
| Admin Server | ScriptService | 脚本同步、代码获取 |
| Admin Server | ToolService | 脚本搜索、执行统计 |
| Admin Server | PageService | 脚本统计上报 |
| Admin Server | sidepanel.js | PDF 解析、图片上传 |
| Admin Server | agent-judge.js | 经验记忆存储 |

---

## 11. 项目运行方式

### 11.1 加载扩展到 Chrome

1. **打开 Chrome 扩展管理页面：** 访问 `chrome://extensions/`
2. **开启开发者模式：** 右上角开关切换为"开发者模式"
3. **加载已解压的扩展程序：** 点击"加载已解压的扩展程序"，选择项目根目录
   ```
   d:\phpstudy_pro\WWW\ai-browser\chrome-extension
   ```
4. **完成加载：** Chrome 自动检测 manifest.json 并注册扩展

### 11.2 配置后端服务

扩展依赖外部 Admin Server 提供以下能力：

- AI 模型代理（OpenAI 兼容 API）
- 脚本注册表与代码交付
- PDF 解析与图片上传

**配置步骤：**

1. 点击浏览器工具栏的 AI Browser 图标打开 Popup
2. 切换到"设置"标签页
3. 填写：
   - **服务器地址**（如 `http://localhost:3001`）
   - **AppKey / AppSecret**（用于 HMAC 签名认证）
   - **AI 模型**（默认 `deepseek-v4-pro`）
   - **同步间隔**（默认 30 分钟）
4. 保存配置后，扩展会自动同步脚本库

### 11.3 使用扩展

**打开侧边栏：**

- 点击工具栏图标
- 快捷键 `Ctrl+Shift+A`
- 点击页面右下角的 AI 浮动按钮
- 右键菜单 → "打开侧边栏"

**主要功能入口：**

| 功能 | 入口 |
|------|------|
| AI 对话 | SidePanel 输入框 |
| Agent 任务 | SidePanel 输入框（自动识别复杂任务） |
| 划词工具 | 选中页面文本 ≥ 3 字符 |
| 表单填充 | 页面表单旁的"AI 填充"按钮 |
| 脚本管理 | Popup → 脚本管理 标签页 |
| 功能面板 | SidePanel → 功能面板按钮 |

### 11.4 开发与调试

**Service Worker 调试：**

- 访问 `chrome://extensions/`
- 找到 AI Browser 扩展
- 点击"Service Worker"链接打开 DevTools

**Content Script 调试：**

- 在任意网页按 F12 打开 DevTools
- 切换到 Console，查看 `[AI Browser]` 前缀日志

**SidePanel 调试：**

- 在 SidePanel 内右键 → "检查"

**配置调试模式：**

在 Agent 配置中开启 `debug: true`，SidePanel 功能面板会显示实时调试信息（agentDebug 消息）。

### 11.5 更新与重载

- **修改源码后：** 访问 `chrome://extensions/`，点击 AI Browser 卡片的"刷新"按钮
- **Content Script 更新：** 需要刷新被注入的网页
- **Service Worker 自动重载：** 修改 `background/` 下文件后，Chrome 自动检测并重启 SW
- **配置变更：** 通过 `chrome.storage.onChanged` 事件自动同步到所有上下文

### 11.6 系统要求

- Chrome 浏览器 ≥ 114（支持 Manifest V3 + Side Panel API）
- 操作系统：Windows / macOS / Linux 均可
- 后端：需部署兼容的 Admin Server（提供 AI 代理、脚本管理接口）

---

## 12. 扩展性设计

### 12.1 添加新的 Agent 工具

1. 在 [agent-dom-executor.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-dom-executor.js) 的 `funcs` 对象中添加工具实现函数（注意自包含 `qsa`）
2. 在 [agent-tool-builder.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-tool-builder.js) 的 `buildTools` 中注册工具 schema
3. 在 [agent-runner.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js) 的工具分发逻辑中添加处理分支
4. （可选）在 [todo-scheduler.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/todo-scheduler.js) 的模板提示词中说明工具用途

### 12.2 添加新的服务模块

1. 在 `background/services/` 目录下创建服务文件（ES Module，导出 class 或对象）
2. 在 [background/index.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/index.js) 中导入并实例化服务
3. 将服务实例添加到 `services` 对象中（键名即为 RPC 调用时的 `service` 名）
4. SidePanel/Popup 中通过 `callService('serviceName', 'methodName', ...args)` 调用

### 12.3 扩展功能面板

1. 在 [feature-panels.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/sidepanel/feature-panels.js) 中添加面板渲染函数
2. 在 `injectStyles()` 中添加面板样式
3. 在 `initFeaturePanels()` 中注册面板初始化逻辑
4. 在 sidepanel.html 的功能面板容器中添加面板 HTML 结构（可选，也可纯 JS 创建）

### 12.4 扩展外部 API 接口

| 接口路径 | 方法 | 用途 |
|---------|------|------|
| `/api/ai-proxy/chat` | POST | AI 对话（流式 SSE） |
| `/api/ai-models/available` | GET | 获取可用模型列表 |
| `/api/scripts` | GET | 获取脚本注册表 |
| `/api/scripts/search` | GET | 搜索脚本 |
| `/api/scripts/:id/inject` | GET | 获取脚本代码 |
| `/api/scripts/:id/stats` | POST | 上报脚本执行统计 |
| `/api/scripts/:id/memories` | POST | 记录脚本执行经验 |
| `/api/ai-proxy/parse-pdf` | POST | PDF 文本提取 |
| `/api/ai-proxy/upload-image` | POST | 图片上传 |

所有接口均需携带 HMAC-SHA256 签名头（`X-App-Key` / `X-Timestamp` / `X-Sign`）。

---

## 附录：项目文件索引

| 文件路径 | 说明 | 行数估计 |
|---------|------|---------|
| [manifest.json](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/manifest.json) | Chrome 扩展清单（Manifest V3） | 65 |
| [background/index.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/index.js) | Service Worker 入口 | 375 |
| [background/services/config-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/config-service.js) | 配置管理与认证签名 | 294 |
| [background/services/ai-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/ai-service.js) | AI API 代理 | 188 |
| [background/services/agent-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-service.js) | Agent 生命周期管理 | 240 |
| [background/services/agent-runner.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js) | Agent 主运行循环 | 1000+ |
| [background/services/agent-dom-executor.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-dom-executor.js) | 15+ DOM 工具实现 | 314 |
| [background/services/agent-tool-builder.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-tool-builder.js) | 工具定义构建器 | 420 |
| [background/services/agent-judge.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-judge.js) | 任务评判与经验记忆 | 150+ |
| [background/services/agent-payload-utils.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-payload-utils.js) | 结果截断与存储判断 | 100+ |
| [background/services/agent-resume-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-resume-service.js) | Agent 断点恢复 | 100+ |
| [background/services/todo-scheduler.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/todo-scheduler.js) | 扁平待办调度引擎 | 467 |
| [background/services/working-memory.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/working-memory.js) | 工作记忆层 | 200+ |
| [background/services/context-compressor.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/context-compressor.js) | LLM 上下文压缩 | 200+ |
| [background/services/tool-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/tool-service.js) | 远程脚本搜索与执行 | 204 |
| [background/services/script-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/script-service.js) | 脚本同步与注入 | 200+ |
| [background/services/sidebar-page-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/sidebar-page-service.js) | 侧边栏与页面管理 | 162 |
| [background/services/db-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/db-service.js) | IndexedDB CRUD 封装 | 190 |
| [background/services/global-data-store.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/global-data-store.js) | 跨阶段持久数据存储 | 167 |
| [background/services/payload-store.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/payload-store.js) | 工具结果存储 | 329 |
| [background/services/domain-policy.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/domain-policy.js) | URL 域名安全策略 | 75 |
| [background/services/human-intervention-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/human-intervention-service.js) | 人机交互介入 | 235 |
| [background/services/task-template-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/task-template-service.js) | 任务模板管理 | 200+ |
| [background/services/tool-recording-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/tool-recording-service.js) | 工具调用录制 | 150+ |
| [background/services/scheduled-task-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/scheduled-task-service.js) | 定时任务调度 | 200+ |
| [background/services/scratchpad-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/scratchpad-service.js) | 中间推理持久化 | 200+ |
| [background/services/output-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/output-service.js) | 任务结果输出 | 200+ |
| [background/services/task-archive-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/task-archive-service.js) | 任务追溯复盘 | 100+ |
| [content/index.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/content/index.js) | 内容脚本入口 | 987 |
| [content/network-capture.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/content/network-capture.js) | XHR/Fetch 拦截器 | 200+ |
| [popup/popup.html](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/popup/popup.html) | Popup 界面 | 150 |
| [popup/popup.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/popup/popup.js) | Popup 逻辑 | 200+ |
| [sidepanel/sidepanel.html](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/sidepanel/sidepanel.html) | 侧边栏界面 | 300+ |
| [sidepanel/sidepanel.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/sidepanel/sidepanel.js) | 侧边栏逻辑 | 1500+ |
| [sidepanel/sidepanel.css](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/sidepanel/sidepanel.css) | 侧边栏样式 | 500+ |
| [sidepanel/feature-panels.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/sidepanel/feature-panels.js) | 功能面板 | 500+ |
| [sidepanel/conversation-viewer.html](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/sidepanel/conversation-viewer.html) | 独立对话全景窗口 | 50+ |
| [sidepanel/conversation-viewer.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/sidepanel/conversation-viewer.js) | 对话全景窗口逻辑 | 200+ |
| [sidepanel/todo-viewer.html](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/sidepanel/todo-viewer.html) | 独立待办查看器窗口 | 50 |
| [sidepanel/todo-viewer.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/sidepanel/todo-viewer.js) | 独立待办查看器逻辑 | 100+ |
| [shared/utils.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/shared/utils.js) | 公共工具函数 | 279 |
| [shared/export-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/shared/export-service.js) | 多格式导出服务 | 200 |
| [icons/icon.png](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/icons/icon.png) | 扩展图标（16/32/48/128px 复用） | - |

**总计约 40 个文件，约 8000+ 行代码。**

---

> 本 Wiki 文档基于源码分析生成，覆盖项目架构、模块、关键 API、通信、存储、安全、依赖与运行方式。如需了解产品功能与设计理念，请参阅 `docs/产品功能说明.md` 与 `docs/产品设计文档.md`；如需更详细的架构图，请参阅 `docs/技术架构文档.md`。
