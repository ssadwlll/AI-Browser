# AI Browser - AI驱动的逆向分析浏览器

一款基于 Electron + React 的桌面浏览器，集成本地/云端大模型，支持网页逆向分析。

## 功能特性

### 核心功能
- **内嵌浏览器**: 基于 Electron BrowserView，完整网页浏览能力
- **AI 对话侧边栏**: 浏览网页时与 AI 实时对话，支持流式响应
- **逆向分析**: 输入提示词，AI 自动分析网页技术栈、API接口、JS逻辑
- **请求捕获**: 实时显示所有网络请求（方法、状态码、URL、资源类型）

### 多模型支持
| 服务商 | 说明 | 需要 API Key |
|--------|------|-------------|
| **OpenAI 兼容** | GPT-4o、Claude、DeepSeek 等 | 是 |
| **Ollama** | 本地模型（Qwen、Llama 等） | 否 |
| **Qwen DashScope** | 阿里云通义千问 | 是 |

### 逆向分析能力
- **技术栈检测**: 自动识别 React/Vue/Angular/jQuery/Next/Nuxt 等框架
- **API 接口分析**: 捕获 XHR/Fetch 请求，分析参数和加密逻辑
- **JS 代码提取**: 提取页面内联和外部脚本
- **AI 综合分析**: 将页面数据交给大模型，按提示词生成分析报告

## 快速开始

### 环境要求
- Node.js >= 18
- npm 或 yarn

### 安装与运行

```bash
# 安装依赖
npm install

# 开发模式（同时启动 Vite 和 Electron）
npm run dev

# 生产模式
npm run build
npm start
```

### 配置模型

1. 打开应用，点击右侧边栏「设置」标签
2. 选择服务商（OpenAI/Ollama/Qwen）
3. 填入 API Key（Ollama 不需要）
4. 确认 Base URL 和模型名称
5. 配置自动保存

### 使用逆向分析

1. 在地址栏输入网址并回车，浏览目标网页
2. 切换到「逆向分析」标签
3. 在提示词输入框中描述你想分析的内容，例如：
   - "分析这个网站的登录接口加密逻辑"
   - "识别这个网页使用的前端技术栈和CDN服务"
   - "提取并解释页面中的关键JS函数"
4. 点击「开始逆向分析」，AI 将基于捕获的页面数据生成报告

## 项目结构

```
ai-browser/
├── electron/
│   ├── main.js              # 主进程：BrowserView、请求拦截、IPC
│   ├── preload.js           # 预加载脚本：安全API暴露
│   └── ai/
│       ├── llm_provider.js  # 多模型适配层（OpenAI/Ollama/Qwen）
│       └── analyzer.js      # 逆向分析器（请求捕获、技术栈检测、上下文构建）
├── src/
│   ├── main.jsx             # React 入口
│   ├── App.jsx              # 主组件（导航栏、标签页）
│   ├── components/
│   │   ├── ChatPanel.jsx    # AI 对话面板
│   │   ├── AnalysisPanel.jsx # 逆向分析面板
│   │   └── SettingsPanel.jsx # 模型配置面板
│   └── styles/
│       └── main.css         # 全局样式
├── package.json
└── vite.config.js
```

## 技术栈

- **Electron 31**: 桌面应用框架，BrowserView 提供内嵌浏览器
- **React 18**: UI 框架
- **Vite 5**: 构建工具
- **react-markdown**: AI 回复 Markdown 渲染
- **Electron net 模块**: 大模型 API 调用（绕过 CORS）

## 常见模型配置示例

### OpenAI
```
Base URL: https://api.openai.com/v1
Model: gpt-4o
API Key: sk-xxx
```

### DeepSeek (OpenAI兼容)
```
Base URL: https://api.deepseek.com/v1
Model: deepseek-chat
API Key: sk-xxx
```

### Ollama 本地
```
Base URL: http://localhost:11434
Model: qwen2.5:14b
API Key: (留空)
```

### Qwen 通义千问
```
Base URL: https://dashscope.aliyuncs.com/compatible-mode/v1
Model: qwen-plus
API Key: sk-xxx
```

## 许可证

MIT
