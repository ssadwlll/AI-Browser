# AI Browser 插件开发指南

## 快速开始

### 1. 目录结构

```
my-plugin/
├── manifest.json       # 插件清单（必需）
├── main.js             # 后端入口（必需）
├── ui/                 # UI 资源（如需窗口）
│   ├── index.html
│   └── bundle.js       # 开发者自己 build 的产物
├── data/               # 插件私有数据目录（自动创建）
└── package.json        # 可选，声明依赖
```

### 2. manifest.json

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "插件描述",
  "author": "作者名",
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
      { "key": "count", "label": "数量", "type": "number", "default": 10 }
    ]
  },
  "dataDir": "data"
}
```

### 3. 权限说明

| 权限 | 说明 |
|---|---|
| `sign-server` | 签名服务：浏览器内 fetch、cookies、UA、导航、点击搜索、滚动、模拟行为、executeScript、rap-param |
| `window` | 独立 Electron 窗口：send/close |
| `fs` | 文件系统（限定插件 dataDir）：read/write/list/exists/mkdir |
| `db` | 数据库（预留） |
| `log` | 日志输出（到终端 + UI） |
| `config` | 配置读写 |

### 4. 后端入口 main.js

```js
const { PluginBase } = require('../../electron/services/plugin_sdk');

class MyPlugin extends PluginBase {
  // 插件被启用时调用
  async onActivate() {
    await this.log('插件已激活');
  }

  // 插件被禁用时调用
  async onDeactivate() {
    await this.log('插件已停用');
  }

  // 接收 UI 窗口的调用
  async onMessage(channel, data) {
    switch (channel) {
      case 'start':
        return await this.startWork(data);
      case 'stop':
        return await this.stopWork();
      default:
        return null;
    }
  }

  async startWork(params) {
    // 读取配置
    const config = await this.host.config.getAll();
    // 调用签名服务
    const cookies = await this.host.signServer.getBrowserCookies();
    // 文件读写
    await this.host.fs.write('output.json', JSON.stringify(params));
    // 向 UI 推送进度
    await this.sendToUI('progress', { current: 1, total: 10 });
    return { success: true };
  }
}

module.exports = new MyPlugin();
```

### 5. UI 入口 ui/index.html

UI 通过 `window.host` API 调用宿主能力和插件后端：

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>我的插件</title></head>
<body>
  <div id="root"></div>
  <script src="bundle.js"></script>
</body>
</html>
```

```jsx
// bundle.js（开发者自己 build）
const { host } = window;

// 调用插件后端
const result = await host.callBackend('start', { keyword: '测试' });

// 直接调用宿主能力
const cookies = await host.signServer.getBrowserCookies();

// 读写配置
const keyword = await host.config.get('keyword');
await host.config.set('keyword', '新关键词');

// 监听后端推送的消息
host.onMessage('progress', (data) => {
  console.log('进度:', data.current, '/', data.total);
});

// 监听日志
host.onLog((log) => {
  console.log(log.message);
});
```

### 6. 构建 UI

插件 UI 使用 React 开发，开发者自行 build：

```bash
cd my-plugin/ui
# 安装依赖
npm install react react-dom
# 构建到 bundle.js
npx vite build --outDir . --outFile bundle.js
```

宿主只加载 `ui/index.html` + `bundle.js`，不引入构建工具链。

### 7. 打包安装

```bash
# 把插件目录打包为 zip
cd my-plugin
# 确保根目录有 manifest.json
zip -r ../my-plugin-1.0.0.zip .
```

在 AI Browser 主窗口点击工具栏的 🧩 按钮 → 「安装插件」→ 选择 zip 文件。

### 8. 调试

- **后端日志**：终端 stdout 实时输出 `[plugin:my-plugin] ...`
- **UI 调试**：插件窗口右键 → 检查元素（开发模式下）
- **IPC 通信**：所有 host 调用通过 IPC，可在 plugin_manager.js 加日志

## 完整示例

参考 `plugins/xhs-collector/`（即将从 `scripts/xhs-collection/` 迁移）。
