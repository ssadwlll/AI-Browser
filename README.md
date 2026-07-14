# AI Browser

一款基于 Electron + React + Vite 的桌面 AI 浏览器，集成大模型能力，支持自然语言操控浏览器、网页逆向分析、脚本注入与插件扩展。

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Electron](https://img.shields.io/badge/Electron-31-47848F.svg)
![React](https://img.shields.io/badge/React-18-61DAFB.svg)
![Vite](https://img.shields.io/badge/Vite-5-646CFF.svg)

---

> ## 📞 联系方式 / Contact
>
> 微信（WeChat）：**`1085459519`**
>
> 欢迎交流 AI Browser、浏览器自动化、网页逆向分析、插件开发等话题。
>
> ---



## 核心特性

- **AI Agent**：通过 LLM + Function Calling 自动操控浏览器完成多步骤任务，支持工具调用循环、循环检测与不确定性感知
- **逆向分析**：独立窗口支持网络捕获、JS 提取、请求重放与 AI 逆向分析，输出技术栈与接口加密逻辑报告
- **插件系统**：子进程隔离的全栈插件框架（后端 Node.js + UI React），按需授予宿主能力，支持独立窗口与配置管理
- **多标签浏览器**：基于 Electron BrowserView 的多标签页浏览，完整网页交互能力与右键菜单
- **脚本注入**：脚本中心管理注入脚本，按 `urlPattern` 匹配自动注入页面，支持上传、启用、禁用
- **多模型支持**：兼容 OpenAI 协议、Ollama 本地模型、Qwen 通义千问，可在设置中自由切换

<!-- 截图 -->

## 快速开始

### 环境要求

- Node.js >= 18
- npm（或 yarn / pnpm）

### 安装

```bash
git clone <仓库地址>
cd ai-browser
npm install
```

### 开发模式

同时启动 Vite 开发服务器与 Electron 主进程：

```bash
npm run dev
```

### 生产构建

构建 React 渲染层产物到 `dist/`：

```bash
npm run build
```

以生产模式启动桌面应用（需先执行 build）：

```bash
npm start
```

### 打包分发

构建并打包为各平台安装包（Windows / macOS / Linux）：

```bash
npm run dist
```

## 项目结构

```
ai-browser/
├── electron/                       # 主进程（Node.js）
│   ├── main.js                     # 入口：窗口创建、IPC 注册、应用生命周期
│   ├── preload.js                  # 预加载：暴露 api 对象到渲染进程
│   ├── preload_browser.js          # 浏览器进程预加载：暴露 browserAPI
│   ├── plugin_preload.js           # 插件 UI 预加载：暴露 host 对象
│   ├── tab_manager.js              # 多标签页管理器
│   ├── service_manager.js          # 服务统一管理与依赖注入
│   ├── ai/                         # AI 核心模块
│   │   ├── llm_provider.js         # 多模型适配层（OpenAI / Ollama / Qwen）
│   │   ├── analyzer.js             # 逆向分析器：请求拦截、技术栈分析
│   │   ├── action_executor.js      # 智能操作：JS 生成与注入 + DOM 变更检测
│   │   ├── agent_loop.js           # 智能体循环：自主多轮任务执行
│   │   ├── tool_definitions.js     # 工具定义（OpenAI Function Calling）
│   │   ├── tool_executor.js        # 工具执行器（双引擎架构）
│   │   ├── electron_engine.js      # 引擎之一：基于 Electron API 的可靠交互
│   │   └── uncertainty_guard.js    # 不确定性检测：DOM 变更感知与循环检测
│   └── services/                   # 业务服务层
│       ├── agent_service.js        # Agent 会话管理
│       ├── agent_runner.js         # Agent 执行器
│       ├── agent_judge.js          # Agent 决策评估
│       ├── reverse_runner.js       # 逆向分析执行器
│       ├── reverse_tools.js        # 逆向分析工具集
│       ├── plugin_manager.js       # 插件管理器（子进程隔离）
│       ├── plugin_sdk.js           # 插件 SDK 基类
│       ├── network_capture.js      # 网络请求捕获
│       ├── tool_service.js         # 工具服务
│       ├── script_service.js       # 脚本管理服务
│       ├── sign_server.js          # 签名服务
│       ├── storage_service.js      # 存储服务
│       ├── db_service.js           # 数据库服务
│       ├── config_service.js       # 配置服务
│       ├── scheduled_task_service.js  # 定时任务
│       └── ...                     # 其他服务
├── src/                            # 渲染进程（React）
│   ├── main.jsx                    # React 入口
│   ├── App.jsx                     # 主组件：导航栏、标签栏、面板切换
│   ├── components/                 # UI 组件
│   │   ├── UnifiedPanel.jsx        # 统一 AI 面板（对话 + 工具调用可视化）
│   │   ├── ReverseWindow.jsx       # 逆向分析窗口
│   │   ├── ScriptCenterWindow.jsx  # 脚本中心窗口
│   │   ├── PluginCenter.jsx        # 插件中心
│   │   ├── SettingsPanel.jsx       # 设置面板（多模型配置）
│   │   ├── ReportWindow.jsx        # 报告窗口
│   │   ├── HistoryWindow.jsx       # 历史记录窗口
│   │   ├── SidebarWindow.jsx       # 侧边栏窗口
│   │   ├── FeaturePanels.jsx       # 功能面板
│   │   └── ConversationViewerWindow.jsx  # 会话查看器
│   ├── shared/                     # 渲染层共享模块
│   └── styles/
│       └── main.css                # 全局样式
├── admin-server/                   # 管理后台（可选，独立服务）
│   ├── app.js                      # Express 入口
│   ├── config/db.js                # 数据库配置
│   ├── controllers/                # 控制器（脚本、用户、AI 模型、统计等）
│   ├── routes/                     # 路由定义
│   ├── middleware/                 # 中间件（鉴权、上传、错误处理）
│   ├── services/                   # 后台服务（嵌入模型等）
│   ├── sql/                        # 数据库初始化与迁移脚本
│   ├── public/                     # 后台静态页面与脚本
│   └── uploads/                    # 上传文件存储
├── plugins/                        # 插件目录
│   ├── README.md                   # 插件开发指南
│   └── registry.json               # 插件注册表
├── docs/                           # 开发文档
│   ├── plugin-development.md       # 插件开发指南
│   ├── backend-development.md      # 管理后台开发指南
│   └── 小红书逆向分析报告.md        # 小红书逆向分析报告
├── package.json
├── vite.config.js
└── index.html
```

## 架构概览

本项目由五个相对独立的部分组成：

### 1. 主进程（electron/main.js + services/ + ai/）

主进程承载所有 Node.js 能力：窗口生命周期、BrowserView 管理、IPC 处理、AI 模型调用、工具执行、网络捕获、脚本与插件管理。`service_manager.js` 统一管理各服务的实例化与依赖注入，`ai/` 目录封装 LLM 适配、工具定义与执行、Agent 循环逻辑。

### 2. 渲染进程（src/，React 18）

渲染进程负责全部 UI 呈现，包括标签栏、地址栏、AI 对话面板、逆向分析窗口、脚本中心、插件中心与设置面板。组件间通过 `window.api` 与主进程通信，不直接访问 Node.js 能力。

### 3. Preload 桥接（electron/preload*.js）

通过 `contextBridge.exposeInMainWorld` 在隔离环境下向渲染进程暴露受控 API：

- `preload.js`：暴露 `window.api`（browser / tabs / ai / agent / unified 等）
- `preload_browser.js`：向 BrowserView 内网页暴露 `window.browserAPI`
- `plugin_preload.js`：向插件 UI 窗口暴露 `window.host`

安全配置：`contextIsolation: true`、`nodeIntegration: false`。

### 4. 管理后台（admin-server/）

可选的独立后台服务，基于 Node.js + Express + MySQL，提供脚本管理、用户体系、AI 模型配置、调用日志、统计报表等能力。该服务不影响桌面应用独立运行，仅在需要集中管理或多人协作时部署。详见 [docs/backend-development.md](docs/backend-development.md)。

### 5. 插件系统（plugins/ + electron/services/plugin_manager.js）

插件以独立子进程运行，与主进程隔离。每个插件通过 manifest 声明所需权限，宿主按权限白名单创建能力实例（签名服务、文件系统、窗口、配置等）。插件支持全栈形态：后端 Node.js 逻辑 + 前端 React UI。详见 [docs/plugin-development.md](docs/plugin-development.md)。

## AI Agent 工作原理

AI Agent 通过 LLM 与 Function Calling 形成闭环，自主完成多步骤浏览器任务：

```
用户指令
   │
   ▼
LLM 分析意图，决定是否调用工具
   │
   ├─ 调用工具 ──▶ ToolExecutor 执行（Electron API 或 JS 注入）
   │                    │
   │                    ▼
   │              工具结果返回 LLM
   │                    │
   └──── 重新进入循环 ◀─┘
   │
   ▼
LLM 返回最终文本回复（不再调用工具），任务完成
```

关键机制：

- **工具集**：`tool_definitions.js` 定义 17 种工具，涵盖页面上下文采集、导航、点击、输入、滚动、截图、网络请求获取、JS 执行等
- **双引擎执行**：`tool_executor.js` 优先使用 Electron API（`sendInputEvent` / `insertText`）保证交互可靠性，必要时通过 `execute_js` 注入任意 JS 实现灵活操作
- **循环检测**：`uncertainty_guard.js` 通过 DOM 指纹感知变更、检测重复操作，避免 Agent 陷入死循环
- **上下文管理**：`context_compressor.js` 与 `scratchpad_service.js` 压缩与持久化上下文，支持长任务断点续跑

## 实战案例：逆向小红书

本项目用 AI Browser 的逆向分析能力完整破解了小红书 Web 端的签名体系，并在纯 Node.js 环境中复现签名算法，实现脱离浏览器的批量数据采集。完整的逆向过程与技术细节见 [小红书逆向分析报告](docs/小红书逆向分析报告.md)。

### 反爬体系

小红书采用 ACE（Anti-Crawler Engine）多层防御：

| 防御层 | 机制 | 破解状态 |
|--------|------|----------|
| 请求头检测 | `x-b3-traceid` / `x-rap-param` / `x-xray-traceid` | 已破解，缺失会被标记 |
| 签名 X-s（XYS_） | `mnsv2` 字节码虚拟机 | 已破解，纯 Node.js 动态生成 |
| 签名 X-s（XYW_） | `_webmsxyw` 函数 | 已弃用，动态生成触发 300015 环境检测 |
| 签名 X-s-common | 独立加密机制 | 已破解，957+ 次调用 0 签名错误 |
| 环境检测（300015） | TLS 指纹 + 浏览器环境 | 已绕过，改用 XYS_ 格式 |

### 核心成果：mnsv2 VM 逆向

逆向的关键是让 `mnsv2` 字节码虚拟机在纯 Node.js 中运行，动态生成 XYS_ 签名：

```
ds.js (62KB)                    自解密 IIFE → 注册编译器基础设施
      ↓
vendor-dynamic.js (1.35MB)      webpack chunk，模块 68316 含 _AUuXfEG27Xa3x 编译器
      ↓                         + 233081 hex 字节码 + signV2Init()
执行模块 68316 → signV2Init()   注册全局 mnsv2 函数
      ↓
xys-sign-node.js                独立模块：init() 加载 VM，generateHeaders() 生成签名
```

`seccore_signv2` 算法：

```javascript
function seccoreSignV2(apiPath, body) {
  const c = apiPath + (body ? JSON.stringify(body) : '');
  const u = md5Hex(c);        // 请求体哈希
  const p = md5Hex(apiPath);  // 路径哈希
  const v = mnsv2(c, u, p);   // VM 签名 → "mns0201_..."

  const payload = {
    x0: '4.3.7',          // 指纹版本
    x1: 'xhs-pc-web',     // 应用 ID
    x2: 'Windows',        // 平台
    x3: v,                // mnsv2 签名
    x4: body ? typeof body : '',
  };

  // 自定义字母表 Base64 编码（字母表与标准 Base64 顺序不同）
  return { 'X-s': 'XYS_' + customBase64(JSON.stringify(payload)), 'X-t': String(Date.now()) };
}
```

### XYS_ vs XYW_：为什么弃用 XYW_

两种签名格式都从小红书源码中提取，但行为差异显著：

| 维度 | XYS_（采用） | XYW_（弃用） |
|------|-------------|-------------|
| 生成方式 | `mnsv2` VM 纯 Node.js 运行 | `_webmsxyw` 需浏览器环境 |
| 300015 环境检测 | 不触发 | 触发（Node.js TLS 指纹、executeJavaScript 环境均被识别） |
| 签名与请求体绑定 | 是（`c = apiPath + JSON.stringify(body)`） | 是 |
| 实测稳定性 | 957+ 次调用 0 签名错误 | 多次触发 300015 |

结论：XYS_ 格式在 Node.js 中生成不触发环境检测，是脱离浏览器采集的唯一可行方案。

### 实测数据

| 采集类型 | API | 签名策略 | 结果 |
|---------|-----|---------|------|
| 搜索列表 | `so.xiaohongshu.com/api/sns/web/v2/search/notes` | 动态 XYS_ + 动态 x-s-common | 20 关键词 × 3 页 = 1332 条笔记，成功率 100% |
| 笔记详情 | `edith.xiaohongshu.com/api/sns/web/v1/feed` | 动态 XYS_ + 动态 x-s-common | 16 关键词 957 条详情，签名错误 0 次 |

### 防风控措施

- 动态 XYS_ 签名：每次请求生成唯一签名，避免静态复用被检测
- 随机延迟：基于正态分布生成请求间隔，详情 4-7s，关键词间 15-30s
- sigCount 循环：x-s-common 中的签名计数 1-30 循环增长，到 30 后随机重置
- 行为模拟：浏览器内模拟鼠标移动（贝塞尔曲线）、滚动、逐字输入、深度交互（点赞/收藏/关注）
- 账号异常检测：遇到 300011 + "账号异常" 自动停止，避免连续触发风控

### 在 AI Browser 中的实现

逆向成果通过 AI Browser 的插件系统落地，核心能力由宿主的签名服务提供：

- **签名服务**：`sign_server.js` 提供 `browserFetch`（浏览器内 fetch，真实 Chrome TLS 指纹）、`getBrowserCookies`、`browserNavigate`、`browserClickSearch`、`browserSimulate` 等方法
- **行为模拟**：通过签名服务在浏览器内模拟人类操作（导航、搜索、滚动、点击），产生真实行为事件
- **数据采集**：优先用浏览器内 `fetch()`（`credentials: 'include'` 自动携带 cookie），失败回退 Node.js `https.request`（用 xys-sign-node.js 生成的签名）
- **按需启动**：声明 `sign-server` 权限的插件启用时自动创建 SignServer 实例，全部禁用时自动销毁

### 错误码参考

| 错误码 | 含义 | 处理方式 |
|--------|------|---------|
| 0 | 成功 | - |
| -100 | 登录过期 / Cookie 被标记 | 检查 cookie 有效性 |
| 300011 | 签名校验失败 / 账号异常 | 无"账号异常"→检查签名；有→停止采集 |
| 300013 | 请求频繁 | 降低频率，等待恢复 |
| 300015 | 浏览器环境异常 | 确认使用 XYS_ 格式而非 XYW_ |
| 300031 | 笔记不可浏览 | 笔记已下架 |

> 以上为逆向成果概要，完整的字节码解释器分析、环境 Mock 要求、从零获取运行时资源的指南等细节见 [小红书逆向分析报告](docs/小红书逆向分析报告.md)。

## 插件系统

插件框架采用子进程隔离架构，保障宿主稳定性：

- **隔离运行**：每个插件在独立子进程中执行，崩溃不影响主应用
- **宿主能力**：通过 `plugin_sdk.js` 的 `PluginBase` 基类，插件按声明权限获取 `host.signServer` / `host.fs` / `host.window` / `host.config` 等能力实例
- **权限白名单**：manifest.json 中 `permissions` 字段声明所需权限，宿主严格按声明授予，未声明的能力不可访问
- **全栈支持**：`type: "fullstack"` 插件可同时包含后端逻辑（main.js）与独立 UI 窗口（ui/index.html）

插件开发指南见 [docs/plugin-development.md](docs/plugin-development.md)。

## 管理后台

`admin-server/` 是一套可选的独立后台服务，技术栈为 Node.js + Express + MySQL：

- 脚本中心：上传、管理、分发注入脚本
- 用户体系：注册、登录、权限管理
- AI 模型管理：集中配置可用模型与 API Key
- 调用日志：记录 AI 调用明细与用量统计
- 统计报表：采集数据与使用情况分析

部署方式：

```bash
cd admin-server
npm install
npm run db:init    # 初始化数据库
npm run dev        # 开发模式（nodemon）
```

该服务为可选项，不部署时桌面应用仍可独立运行。详细开发说明见 [docs/backend-development.md](docs/backend-development.md)。

## 多模型配置

在应用内「设置」面板选择服务商并填入配置，所有配置自动保存。支持的模型如下：

| 服务商 | Base URL | Model 示例 | 需要 API Key |
|--------|----------|-----------|-------------|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` | 是 |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | 是 |
| Ollama | `http://localhost:11434` | `qwen2.5:14b` | 否 |
| Qwen 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 是 |

所有兼容 OpenAI 协议的服务商均可通过 OpenAI 类型接入，仅需替换 Base URL 与 Model。

## 开发文档

- [插件开发指南](docs/plugin-development.md)
- [管理后台开发指南](docs/backend-development.md)
- [小红书逆向分析报告](docs/小红书逆向分析报告.md)

## 贡献指南

欢迎通过 Pull Request 或 Issue 参与本项目：

1. Fork 仓库并创建特性分支：`git checkout -b feature/your-feature`
2. 提交清晰、聚焦的 commit，说明改动目的
3. 发起 PR 时描述变更内容、动机与测试情况
4. 报告问题请通过 Issue，附上复现步骤与环境信息

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
