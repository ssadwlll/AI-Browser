# AI Browser 插件开发指南

## 概述

AI Browser 插件系统让第三方能力以**子进程隔离**的方式接入主程序。每个插件在独立的 Node.js 子进程中运行后端逻辑，插件 UI 在独立的 Electron 窗口中运行，两者通过 IPC 与主进程通信。

核心特性：

- **子进程隔离**：每个插件 `fork` 独立 Node.js 子进程运行 `main.js`，插件崩溃不会影响主程序，主程序也不会因插件内存泄漏而退化。
- **宿主能力**：插件通过 IPC 调用主进程提供的签名服务、窗口、文件系统、日志、配置等能力，能力按 `manifest.json` 声明的权限授予。
- **全栈插件**：后端（Node.js，基于 `PluginBase`）+ UI（HTML + JS / React）均可开发，`type: "fullstack"` 的插件同时拥有后端与独立窗口。
- **按需创建**：重量级宿主能力（如 `SignServer`）仅在声明对应权限的插件启用时才实例化，全部禁用时自动销毁。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│  主进程 (Electron Main, Node.js)                                │
│                                                                 │
│  PluginManager                                                  │
│  ├── plugins: Map<id, {manifest, enabled, proc, winId, host}>   │
│  ├── SignServer (按需创建, 引用计数管理)                          │
│  ├── _createHost()  —— 为每个插件构建宿主能力对象                  │
│  └── IPC handlers: plugin:list/install/uninstall/enable/...     │
│                                                                 │
│  BrowserWindow (主窗口, React UI, 插件中心)                       │
└─────────────────────────────────────────────────────────────────┘
            │ fork (child_process)            │ BrowserWindow.loadFile
            ▼                                  ▼
┌────────────────────────┐         ┌─────────────────────────────┐
│  插件子进程 (Node.js)   │         │  插件 UI 窗口 (渲染进程)      │
│  main.js               │         │  ui/index.html + bundle.js   │
│  extends PluginBase    │         │                             │
│                        │         │  plugin_preload.js          │
│  HostProxy             │         │  → 注入 window.host         │
│  └── process.send      │         │                             │
│      {type:'host-call'}│         │  window.host.callBackend()  │
│                        │         │  window.host.signServer.*   │
│  onActivate/onDeactivate│        │  window.host.config.*       │
│  onMessage             │         │  window.host.onMessage()    │
└────────────────────────┘         └─────────────────────────────┘
            │                                  │
            └──────── IPC (主进程中转) ─────────┘
```

通信路径说明：

1. **主进程 PluginManager** 管理 N 个插件子进程，每个子进程通过 `process.send` / `process.on('message')` 与主进程进行 IPC 通信。
2. **插件 UI** 由主进程通过 `BrowserWindow` 加载，`plugin_preload.js` 通过 `contextBridge` 注入 `window.host`。
3. **UI → 后端**：`window.host.callBackend(channel, data)` → 主进程 `plugin:call-backend` IPC → 子进程 `onMessage(channel, data)`。
4. **UI → 宿主**：`window.host.callHost(namespace, method, args)` 或便捷代理（`host.config.*`、`host.signServer.*` 等）→ 主进程 `plugin:host-call` IPC → 主进程 `host` 对象。
5. **后端 → UI**：子进程 `this.sendToUI(channel, data)` → 主进程 `_sendToPluginWindow` → UI `host.onMessage(channel, callback)`。
6. **宿主能力按需创建**：`SignServer` 仅当声明 `sign-server` 权限的插件启用时才实例化（引用计数 +1），全部禁用时销毁（引用计数归零）。

## 目录结构

标准插件目录结构：

```
my-plugin/
├── manifest.json        # 插件清单（必需），声明 id/权限/UI/配置 schema
├── main.js              # 后端入口（必需），继承 PluginBase
├── lib/
│   └── plugin_sdk.js    # PluginBase 副本（推荐复制，使插件自包含）
├── ui/
│   ├── index.html       # UI 入口 HTML
│   └── bundle.js        # UI 构建产物（开发者自行 build）
├── data/                # 插件私有数据目录（自动创建，沙箱限制在此目录）
└── package.json         # 可选，声明 UI 构建依赖
```

说明：

- `manifest.json` 与 `main.js` 为必需文件，缺失则无法安装或启用。
- `lib/plugin_sdk.js` 推荐从宿主 `electron/services/plugin_sdk.js` 复制一份到插件目录，使插件打包后自包含，不依赖宿主源码路径（参见 `xhs-collector/main.js` 的 `require('./lib/plugin_sdk')`）。
- `ui/` 仅 `type: "fullstack"` 的插件需要；`type: "backend"` 的纯后端插件可省略。
- `data/` 目录由 `PluginManager` 在安装时根据 `manifest.dataDir` 自动创建，插件运行时通过 `host.fs.*` 在此目录内读写。

## manifest.json 规范

### 字段说明

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 插件唯一标识，必须与目录名一致；安装时校验唯一性 |
| `name` | string | 是 | 插件显示名称（用于插件中心列表与窗口默认标题） |
| `version` | string | 是 | 语义化版本号，安装时校验 |
| `description` | string | 否 | 插件描述 |
| `author` | string | 否 | 作者 |
| `type` | string | 是 | 插件类型：`backend`（纯后端，无 UI）或 `fullstack`（后端 + UI 窗口） |
| `main` | string | 是 | 后端入口相对路径，如 `main.js` |
| `ui.entry` | string | 否 | UI 入口 HTML 相对路径，如 `ui/index.html`；`fullstack` 必填 |
| `ui.window.width` | number | 否 | 窗口宽度，默认 `1000` |
| `ui.window.height` | number | 否 | 窗口高度，默认 `700` |
| `ui.window.title` | string | 否 | 窗口标题，默认取 `name` |
| `permissions` | string[] | 否 | 权限声明数组，未声明的宿主能力不可调用 |
| `config.schema` | object[] | 否 | 配置表单 schema，插件中心据此自动生成配置 UI |
| `dataDir` | string | 否 | 私有数据目录名，默认 `data` |

### config.schema 字段

`config.schema` 是一个数组，每项描述一个配置项，插件中心 UI 会据此自动渲染配置表单：

| 属性 | 说明 |
|---|---|
| `key` | 配置键名，对应 `host.config.get(key)` |
| `label` | 表单标签 |
| `type` | 表单类型：`text`、`number`、`textarea`、`boolean` |
| `default` | 默认值 |

### 完整示例

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "一个示例插件",
  "author": "ai-browser",
  "type": "fullstack",
  "main": "main.js",
  "ui": {
    "entry": "ui/index.html",
    "window": {
      "width": 1000,
      "height": 700,
      "title": "我的插件"
    }
  },
  "permissions": ["sign-server", "window", "fs", "log", "config"],
  "config": {
    "schema": [
      { "key": "keyword", "label": "关键词", "type": "text", "default": "" },
      { "key": "count", "label": "数量", "type": "number", "default": 10 },
      { "key": "keywords", "label": "关键词列表（换行分隔）", "type": "textarea", "default": "美食\n旅游" },
      { "key": "autoStart", "label": "自动开始", "type": "boolean", "default": false }
    ]
  },
  "dataDir": "data"
}
```

## 权限系统

### 权限白名单

`PluginManager` 在安装时校验权限声明，未在白名单内的权限会被拒绝安装：

| 权限 | 说明 | 是否实现 |
|---|---|---|
| `sign-server` | 签名服务（浏览器内 fetch / cookies / UA / 导航 / 搜索 / 滚动 / 模拟 / 脚本注入 / rap-param） | 是 |
| `window` | 独立 Electron 窗口（向 UI 推送消息、关闭窗口） | 是 |
| `fs` | 文件系统（限定插件 `dataDir`，沙箱防越界） | 是 |
| `db` | 数据库 | 预留，暂未实现（调用会抛错） |
| `log` | 日志输出（终端 + UI） | 是 |
| `config` | 配置读写（持久化到 `registry.json`） | 是 |

### 各权限对应的宿主能力方法

以下方法清单严格依据 `plugin_manager.js` 的 `_createHost()` 实现。未声明对应权限时，该命名空间在 `host` 对象上为 `null`。

| 命名空间 | 权限 | 方法 |
|---|---|---|
| `host.signServer` | `sign-server` | `browserFetch`、`getBrowserCookies`、`getBrowserUA`、`browserNavigate`、`browserClickSearch`、`browserScroll`、`browserSimulate`、`executeScript`、`injectRapInterceptor`、`getRapParam` |
| `host.fs` | `fs` | `read`、`write`、`list`、`exists`、`mkdir` |
| `host.window` | `window` | `send(channel, data)`、`close()` |
| `host.db` | `db` | `query(sql, params)`（未实现，调用抛错） |
| `host.log` | 无需声明 | `log(msg, level)`、`info(msg)`、`warn(msg)`、`error(msg)` |
| `host.config` | 无需声明 | `get(key)`、`set(key, value)`、`getAll()`、`setAll(cfg)` |

说明：`host.log` 与 `host.config` 不受权限白名单限制，所有插件均可调用。

### SignServer 方法清单

`SignServer` 类（`electron/services/sign_server.js`）实现了以下方法。注意：当前 `host.signServer` 代理仅暴露其中部分方法（见上表），其余方法存在于 `SignServer` 类但未通过 `host` 代理对外暴露。

| 方法 | 签名 | 是否经 host 暴露 | 说明 |
|---|---|---|---|
| `healthCheck` | `() => {ok, hasWebmsxyw, hasMnsv2, url, title}` | 否 | 检查浏览器环境是否就绪（当前页面是否为小红书、`_webmsxyw`/`mnsv2` 是否可用） |
| `sign` | `(apiPath, body) => {X-s, X-t, X-s-common}` | 否 | 通过浏览器 `window._webmsxyw` 生成 XYW_ 签名 |
| `browserFetch` | `(apiPath, bodyStr, xsc, rapParam, xs, xt, host?) => {ok, status, data}` | 是 | 在浏览器页面内发起 API 请求（签名 + fetch 全部在浏览器中完成，真实 Chrome TLS） |
| `callMnsv2` | `(c, u, p) => {result}` | 否 | 调用浏览器 `window.mnsv2(c, u, p)` 生成 XYS_ 签名 |
| `getBrowserCookies` | `() => {ok, cookies}` | 是 | 获取浏览器小红书域名 cookies |
| `getBrowserUA` | `() => {ok, userAgent}` | 是 | 获取浏览器 User-Agent |
| `browserNavigate` | `(url, waitMs) => {ok, url}` | 是 | 导航浏览器到指定 URL（产生真实导航事件） |
| `browserScroll` | `() => {ok, scrollAmount}` | 是 | 页面滚动（产生行为事件） |
| `browserSimulate` | `() => {ok}` | 是 | 完整行为模拟（贝塞尔曲线鼠标移动 + 分步滚动 + 微移动） |
| `clickExploreNote` | `() => {ok, opened}` | 否 | 点击首页推荐笔记（用于异常恢复，含人类行为模拟） |
| `browserClickSearch` | `(keyword) => {ok, keyword, btnClicked, btnInfo}` | 是 | 搜索框输入关键词 + 点击搜索按钮（深度人类行为模拟） |
| `executeScript` | `(script) => {ok, result}` | 是 | 在浏览器页面上下文执行自定义 JS |
| `injectRapInterceptor` | `() => {ok}` | 是 | 注入 `x-rap-param` 拦截器，按 URL 分类捕获 |
| `getRapParam` | `() => {ok, search, feed, updatedAt}` | 是 | 获取最新捕获的 `x-rap-param` |

### SignServer 按需创建机制

`SignServer` 实例不是常驻的，而是按需创建与销毁，避免无插件使用时占用资源：

- **引用计数**：`PluginManager` 内部维护 `signServerRef` 计数器与 `signServer` 实例。
- **创建**：当声明 `sign-server` 权限的插件被启用时，`_acquireSignServer()` 将计数器 +1；若实例不存在则 `new SignServer(tabManager)` 创建。
- **销毁**：当声明 `sign-server` 权限的插件被禁用或卸载时，`_releaseSignServer()` 将计数器 -1；归零时置空实例，等待 GC 回收。
- **多插件共享**：多个声明 `sign-server` 权限的插件共享同一个 `SignServer` 实例，最后一个释放时才销毁。

## 后端开发（main.js）

### 基本结构

后端入口 `main.js` 继承 `PluginBase`，通过 `module.exports` 导出插件实例。`PluginBase` 内部已监听 `process.on('message')`，处理主进程的 `activate` / `deactivate` / `ui-call` 消息并转发到对应生命周期方法。

```javascript
const { PluginBase } = require('./lib/plugin_sdk');

class MyPlugin extends PluginBase {
  constructor() {
    super();
    this.running = false;
  }

  // 插件被启用时调用，host 已注入，可在此初始化
  async onActivate() {
    // 读取配置
    const cfg = await this.host.config.getAll();
    this.config = cfg;

    // 记录日志（同时输出到终端和 UI）
    await this.log('插件已激活');
  }

  // 插件被禁用时调用，可在此清理资源
  async onDeactivate() {
    this.running = false;
    await this.log('插件已停用', 'warn');
  }

  // 处理 UI 通过 host.callBackend 发起的调用
  async onMessage(channel, data) {
    switch (channel) {
      case 'start':
        return await this._start(data);
      case 'stop':
        return await this._stop();
      case 'get-status':
        return { running: this.running };
      default:
        return null;
    }
  }

  async _start(params) {
    if (this.running) return { success: false, error: '已在运行' };
    this.running = true;

    // 异步执行主流程，立即返回
    this._run().catch((e) => {
      this.log(`运行异常: ${e.message}`, 'error');
      this.running = false;
    });

    return { success: true, started: true };
  }

  async _run() {
    // 调用签名服务（需声明 sign-server 权限）
    const cookies = await this.host.signServer.getBrowserCookies();
    this.log(`cookies: ${JSON.stringify(cookies).slice(0, 50)}...`);

    // 文件读写（限定 dataDir，需声明 fs 权限）
    await this.host.fs.write('output.json', JSON.stringify({ ok: true }));

    // 向 UI 推送进度
    await this.sendToUI('progress', { current: 1, total: 10 });
    this.running = false;
  }
}

module.exports = new MyPlugin();
```

### this.host 代理

`this.host` 是 `HostProxy` 实例，通过 `process.send({type:'host-call',...})` 将调用转发到主进程。所有方法均返回 Promise。

```javascript
// 签名服务（需 sign-server 权限）
await this.host.signServer.browserFetch(apiPath, bodyStr, xsc, rapParam, xs, xt);
await this.host.signServer.getBrowserCookies();
await this.host.signServer.browserNavigate(url, delay);

// 文件系统（需 fs 权限，限定 dataDir）
const content = await this.host.fs.read('file.json');
await this.host.fs.write('file.json', content);
const files = await this.host.fs.list('.');
const exists = await this.host.fs.exists('file.json');
await this.host.fs.mkdir('subdir');

// 配置（无需权限声明）
const val = await this.host.config.get('key');
await this.host.config.set('key', value);
const all = await this.host.config.getAll();
await this.host.config.setAll({ k1: 'v1' });

// 日志（无需权限声明）
await this.host.log.info('消息');
await this.host.log.warn('警告');
await this.host.log.error('错误');

// 窗口（需 window 权限）
await this.host.window.send('channel', data);  // 等同于 sendToUI
await this.host.window.close();
```

### 内置便捷方法

`PluginBase` 提供两个便捷方法，封装常用操作：

- `this.sendToUI(channel, data)` — 向插件 UI 窗口推送消息，内部调用 `host.window.send(channel, data)`。UI 侧通过 `host.onMessage(channel, callback)` 监听。
- `this.log(msg, level = 'info')` — 记录日志，内部调用 `host.log.log(msg, level)`，同时输出到终端 `[plugin:<id>]` 和 UI 的 `host.onLog` 回调。

### 生命周期说明

| 方法 | 触发时机 | 用途 |
|---|---|---|
| `onActivate()` | 插件被启用、子进程 fork 完成后 | host 已注入，可读取配置、初始化资源、启动定时任务 |
| `onDeactivate()` | 插件被禁用前（主进程先发 `deactivate`，等待 500ms 再 kill） | 清理资源、停止任务、保存状态 |
| `onMessage(channel, data)` | UI 调用 `host.callBackend(channel, data)` | 处理 UI 请求，返回值会回传给 UI |

## UI 开发

### 文件结构

UI 由 `ui/index.html` 与构建产物 `bundle.js` 组成。主进程通过 `BrowserWindow.loadFile` 加载 HTML，`plugin_preload.js` 作为 preload 脚本注入 `window.host`。

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>我的插件</title>
</head>
<body>
  <div id="root"></div>
  <script src="bundle.js"></script>
</body>
</html>
```

### window.host API 完整清单

`window.host` 由 `plugin_preload.js` 通过 `contextBridge.exposeInMainWorld('host', {...})` 注入。完整 API 如下：

| API | 签名 | 说明 |
|---|---|---|
| `host.pluginId` | `string` | 当前插件 ID（从窗口 `additionalArguments` 提取） |
| `host.callBackend` | `(channel, data) => Promise<any>` | 调用插件后端 `onMessage(channel, data)`，返回值即后端 return 的结果 |
| `host.callHost` | `(namespace, method, args) => Promise<any>` | 通用宿主能力调用接口，直接调用主进程 `host` 对象的方法 |
| `host.config.get` | `(key) => Promise<any>` | 读取单个配置项 |
| `host.config.set` | `(key, value) => Promise<void>` | 写入单个配置项 |
| `host.config.getAll` | `() => Promise<object>` | 读取全部配置 |
| `host.config.setAll` | `(cfg) => Promise<void>` | 写入全部配置 |
| `host.signServer.*` | 同后端 `host.signServer` | 签名服务便捷代理（10 个已暴露方法） |
| `host.fs.read` | `(relPath) => Promise<string>` | 读取文件（限定 dataDir） |
| `host.fs.write` | `(relPath, content) => Promise<void>` | 写入文件 |
| `host.fs.list` | `(relDir) => Promise<string[]>` | 列出目录 |
| `host.fs.exists` | `(relPath) => Promise<boolean>` | 判断文件是否存在 |
| `host.fs.mkdir` | `(relDir) => Promise<void>` | 创建目录 |
| `host.log` | `(msg, level) => Promise<void>` | 记录日志 |
| `host.closeWindow` | `() => Promise<void>` | 关闭插件窗口 |
| `host.onMessage` | `(channel, callback) => () => void` | 监听后端 `sendToUI` 推送，返回取消监听函数 |
| `host.onLog` | `(callback) => () => void` | 监听后端日志推送，返回取消监听函数 |

说明：`host.callBackend` 与 `host.callHost` 是底层通用接口，`host.config`、`host.signServer`、`host.fs` 等是对 `callHost` 的便捷封装。

### 原生 JS 示例

```javascript
// bundle.js（原生 JS，直接引入或由构建工具打包）
const { host } = window;

const btnStart = document.getElementById('btn-start');
const logBox = document.getElementById('log');

// 调用插件后端
btnStart.addEventListener('click', async () => {
  const result = await host.callBackend('start', { keyword: '测试' });
  console.log('启动结果:', result);
});

// 直接读取配置
const keyword = await host.config.get('keyword');

// 监听后端推送的进度
host.onMessage('progress', (data) => {
  console.log(`进度: ${data.current}/${data.total}`);
});

// 监听后端日志
host.onLog((log) => {
  logBox.textContent += `[${log.level}] ${log.message}\n`;
});
```

### React 示例

```jsx
import { useEffect, useState } from 'react';

function App() {
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    // 监听后端推送
    const offMsg = window.host.onMessage('status', (data) => {
      setRunning(data.state === 'running');
    });
    const offLog = window.host.onLog((log) => {
      setLogs((prev) => [...prev, log]);
    });
    return () => { offMsg(); offLog(); };
  }, []);

  const handleStart = async () => {
    await window.host.callBackend('start', {});
  };

  return (
    <div>
      <button onClick={handleStart} disabled={running}>
        {running ? '运行中' : '开始'}
      </button>
      <pre>{logs.map((l) => `[${l.level}] ${l.message}`).join('\n')}</pre>
    </div>
  );
}

export default App;
```

## 配置管理

### 声明配置 schema

在 `manifest.json` 的 `config.schema` 中声明配置项，插件中心 UI 会自动根据 schema 渲染配置表单，用户填写后通过 `plugin:config-save` IPC 持久化到 `registry.json`。

```json
{
  "config": {
    "schema": [
      { "key": "keyword", "label": "关键词", "type": "text", "default": "" },
      { "key": "count", "label": "数量", "type": "number", "default": 10 },
      { "key": "keywords", "label": "关键词列表", "type": "textarea", "default": "美食\n旅游" },
      { "key": "autoStart", "label": "自动开始", "type": "boolean", "default": false }
    ]
  }
}
```

### 读写配置

后端通过 `this.host.config` 读写，UI 通过 `window.host.config` 读写，两者操作同一份持久化数据。

```javascript
// 后端（main.js）
async onActivate() {
  const cfg = await this.host.config.getAll();
  // cfg = { keyword: '...', count: 10, ... }
}

async onMessage(channel, data) {
  if (channel === 'apply-config') {
    await this.host.config.setAll(data);  // 持久化
    return { success: true };
  }
}
```

```javascript
// UI（bundle.js）
await window.host.config.set('keyword', '新关键词');
const all = await window.host.config.getAll();
```

### 运行时应用配置

`registry.json` 中持久化的配置不会自动注入到插件运行时。插件应在 `onActivate` 时主动调用 `host.config.getAll()` 读取并应用到业务模块。UI 保存配置后若需立即生效，可通过 `callBackend('apply-config', cfg)` 通知后端重新加载（参见 `xhs-collector/main.js` 的 `apply-config` 通道）。

## 文件系统

### 沙箱限制

`host.fs` 的所有操作都被限制在插件 `dataDir` 内。`_createHost()` 实现了路径越界检查：`path.resolve(dataDir, relPath)` 的结果必须以 `dataDir` 开头，否则抛出 `路径越界` 错误。插件无法读写 `dataDir` 之外的任何文件。

`dataDir` 由 `PluginManager` 在 `onActivate` 时通过环境变量 `PLUGIN_DATA_DIR` 与 `host.dataDir` 注入，路径为 `plugins/<id>/<manifest.dataDir>`（默认 `data`）。

### 方法清单

| 方法 | 签名 | 说明 |
|---|---|---|
| `read(relPath)` | `(relPath: string) => string` | 读取文件，返回 UTF-8 字符串 |
| `write(relPath, content)` | `(relPath: string, content: string) => void` | 写入文件，自动创建父目录 |
| `list(relDir)` | `(relDir: string = '.') => string[]` | 列出目录下的文件名 |
| `exists(relPath)` | `(relPath: string) => boolean` | 判断文件是否存在 |
| `mkdir(relDir)` | `(relDir: string) => void` | 递归创建目录 |

注意：后端 `host.fs` 是同步实现（直接调用 `fs` 模块），但通过 IPC 代理后变为异步 Promise。UI 侧 `host.fs.*` 始终为异步。

## 构建与打包

### UI 构建

插件 UI 由开发者自行构建为 `bundle.js`，宿主只加载 `ui/index.html` + `bundle.js`，不引入构建工具链。推荐使用 Vite：

```bash
cd my-plugin/ui
npm install react react-dom
# 构建（输出到当前目录的 bundle.js）
npx vite build --outDir . --outFile bundle.js
```

`index.html` 中通过 `<script src="bundle.js"></script>` 引入产物即可。

### 打包为 zip

将插件目录打包为 zip，**根目录必须包含 `manifest.json`**（也支持单层子目录包含 `manifest.json`）：

```bash
cd my-plugin
# 确保根目录有 manifest.json
zip -r ../my-plugin-1.0.0.zip .
```

打包时注意：

- 不要包含 `data/` 目录内的运行数据（安装时会自动创建）。
- 若插件 `require('./lib/plugin_sdk')`，需将 `plugin_sdk.js` 一并打包，使插件自包含。
- `node_modules` 仅 UI 构建需要，打包发布时无需包含（UI 已构建为 `bundle.js`）。

### 安装方式

在 AI Browser 主窗口打开插件中心 → 选择「安装插件」→ 选择 zip 文件。安装流程（`PluginManager.install`）：

1. 解压 zip，定位 `manifest.json`（根目录或单层子目录）。
2. 校验必填字段（`id` / `version` / `main`）与权限白名单。
3. 校验 `id` 唯一性（已安装则拒绝）。
4. 解压到 `plugins/<id>/`。
5. 创建 `dataDir` 目录。
6. 写入 `registry.json`。

### 开发模式

开发时无需打包，直接将插件目录放入 `plugins/` 即可。`PluginManager.init` 会自动扫描 `plugins/` 目录，发现目录名与 `manifest.id` 一致但未在 registry 中记录的插件，自动注册。修改代码后重启应用即可生效。

## 调试

### 后端日志

插件子进程的 `stdout` / `stderr` 会被主进程转发到终端，前缀为 `[plugin:<id>]`。调用 `this.log(msg)` 或 `console.log(msg)` 都会在终端输出：

```
[plugin:my-plugin] 插件已激活
[plugin:my-plugin] cookies: {"a1":"..."}
```

### UI 调试

插件窗口在开发模式下支持右键 → 检查元素，打开 DevTools 调试 DOM、网络、Console。`window.host` 对象可在 Console 中直接访问。

### IPC 通信调试

所有 `host` 调用都经过 IPC。如需排查通信问题，可在 `electron/services/plugin_manager.js` 的 `_handlePluginMessage` 与 `ipcMain.handle('plugin:host-call', ...)` 处添加日志，观察 `namespace` / `method` / `args` 的实际值。

### 常见问题

- **插件启用后无反应**：检查终端是否有 `[plugin:<id>]` 输出；确认 `main.js` 路径与 `manifest.main` 一致。
- **host 调用报错「未知的 host 方法」**：权限未声明或方法名拼写错误，对照权限系统章节核对。
- **`sign-server` 调用报错「签名服务未启动」**：`SignServer` 仅在声明 `sign-server` 权限的插件启用时创建，确认 manifest 已声明且插件已启用。
- **UI 无法调用后端**：确认插件已启用（子进程在运行）且窗口由 `plugin:open-window` 打开。

## 完整示例

`plugins/xhs-collector/`（小红书采集）是真实可运行的全栈插件示例，关键设计点：

- **自包含 SDK**：`main.js` 通过 `require('./lib/plugin_sdk')` 引入 `PluginBase` 副本，而非依赖宿主源码路径，保证打包后独立运行。
- **host 注入业务模块**：`onActivate` 中调用 `hostBridge.setHost(this.host)`，将宿主能力注入到独立的 `host-bridge.js` 模块，业务代码（`collector`、`behavior` 等）通过 `host-bridge` 间接调用 `host.signServer.*`，与原 HTTP 版签名服务解耦。
- **事件回调注入**：`onActivate` 中通过 `setCallbacks({ log, progress, status, result })` 将 `sendToUI` 绑定到事件总线 `bus`，业务模块 `bus.emit('progress', data)` 即可推送到 UI。
- **配置应用**：`onActivate` 读取 `host.config.getAll()` 并调用 `setRuntimeConfig(cfg)` 注入运行时；UI 保存配置后通过 `callBackend('apply-config', cfg)` 热更新。
- **异步主流程**：`onMessage('start')` 异步启动采集主流程 `_runCollection()`，立即返回 `{ started: true }`，避免阻塞 IPC 响应；通过 `sendToUI` 持续推送进度。
- **优雅停止**：`onMessage('stop')` 设置 `stopRequested` 标志，主流程在当前关键词采集完成后退出，而非强制中断。
- **manifest 配置**：`config.schema` 声明了 `keywords`（textarea）、`pages`（number）、`feedDelayMin`/`feedDelayMax`（number）、`deepInterval`（number）、`startIndex`（number，断点续采）等配置项，插件中心自动渲染表单。

参考文件：

- `plugins/xhs-collector/manifest.json` — 清单示例
- `plugins/xhs-collector/main.js` — 后端入口
- `plugins/xhs-collector/src/host-bridge.js` — host 调用封装

## 限制与注意事项

- **插件间不能互调**：每个插件运行在独立子进程，没有跨插件通信通道，无法直接调用其他插件的 API。
- **插件不能访问主进程内存**：子进程通过 IPC 与主进程通信，无法直接 `require` 主进程模块或访问主进程变量。`host` 对象是 IPC 代理，非真实引用。
- **`db` 权限预留**：`host.db.query()` 当前会抛出「数据库能力尚未实现」，后续版本再接入。
- **子进程崩溃后不会自动重启**：`proc.on('exit')` 仅记录日志并标记 `enabled = false`，不会重新 fork。如需心跳检测，可在 UI 侧定时 `callBackend('get-status')`，超时则提示用户重新启用。
- **窗口单例**：每个插件同时只能有一个 UI 窗口。重复调用 `openWindow` 会聚焦已有窗口而非新建。
- **IPC 超时**：UI 调用后端（`callBackend`）默认 30 秒超时；长耗时任务应异步执行并立即返回，通过 `sendToUI` 推送进度。
- **路径安全**：`host.fs` 已做沙箱越界检查，插件不应尝试通过 `..` 逃逸 `dataDir`。
