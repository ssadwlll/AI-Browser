'use strict';

/**
 * plugin_preload.js — 插件 UI 窗口的 preload 脚本
 *
 * 注入 window.host API 到插件 UI 的渲染进程
 * 插件 UI 通过 window.host.* 调用宿主能力
 *
 * 插件 ID 通过 additionalArguments 传入（从窗口创建时指定）
 */

const { contextBridge, ipcRenderer } = require('electron');

// 从 additionalArguments 提取 plugin-id
let pluginId = '';
try {
  for (const arg of process.argv) {
    if (arg.startsWith('plugin-id=')) {
      pluginId = arg.slice('plugin-id='.length);
      break;
    }
  }
} catch {}

if (!pluginId) {
  console.error('[plugin_preload] 未找到 plugin-id 参数');
}

contextBridge.exposeInMainWorld('host', {
  pluginId,

  // 调用插件后端（main.js 导出的 onMessage）
  // 用于 UI 触发后端操作，如"开始采集"、"停止采集"
  callBackend: (channel, data) => ipcRenderer.invoke('plugin:call-backend', { id: pluginId, channel, data }),

  // 直接调用宿主能力（绕过插件后端，用于简单的配置读写、日志等）
  callHost: (namespace, method, args) =>
    ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace, method, args }),

  // 配置便捷方法
  config: {
    get: (key) => ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'config', method: 'get', args: [key] }),
    set: (key, value) => ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'config', method: 'set', args: [key, value] }),
    getAll: () => ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'config', method: 'getAll', args: [] }),
    setAll: (cfg) => ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'config', method: 'setAll', args: [cfg] }),
  },

  // 签名服务便捷方法
  signServer: {
    browserFetch: (apiPath, bodyStr, xsc, rapParam, xs, xt) =>
      ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'signServer', method: 'browserFetch', args: [apiPath, bodyStr, xsc, rapParam, xs, xt] }),
    getBrowserCookies: () =>
      ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'signServer', method: 'getBrowserCookies', args: [] }),
    getBrowserUA: () =>
      ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'signServer', method: 'getBrowserUA', args: [] }),
    browserNavigate: (url, delay) =>
      ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'signServer', method: 'browserNavigate', args: [url, delay] }),
    browserClickSearch: (keyword) =>
      ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'signServer', method: 'browserClickSearch', args: [keyword] }),
    browserScroll: () =>
      ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'signServer', method: 'browserScroll', args: [] }),
    browserSimulate: () =>
      ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'signServer', method: 'browserSimulate', args: [] }),
    executeScript: (code) =>
      ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'signServer', method: 'executeScript', args: [code] }),
    injectRapInterceptor: () =>
      ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'signServer', method: 'injectRapInterceptor', args: [] }),
    getRapParam: () =>
      ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'signServer', method: 'getRapParam', args: [] }),
  },

  // 文件系统（限定插件 dataDir）
  fs: {
    read: (relPath) => ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'fs', method: 'read', args: [relPath] }),
    write: (relPath, content) => ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'fs', method: 'write', args: [relPath, content] }),
    list: (relDir) => ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'fs', method: 'list', args: [relDir] }),
    exists: (relPath) => ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'fs', method: 'exists', args: [relPath] }),
    mkdir: (relDir) => ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'fs', method: 'mkdir', args: [relDir] }),
  },

  // 日志
  log: (msg, level) => ipcRenderer.invoke('plugin:host-call', { id: pluginId, namespace: 'log', method: 'log', args: [msg, level] }),

  // 关闭窗口
  closeWindow: () => ipcRenderer.invoke('plugin:close-window', { id: pluginId }),

  // 监听后端消息（后端 host.window.send → UI）
  onMessage: (channel, callback) => {
    const fullChannel = `plugin:${pluginId}:${channel}`;
    const handler = (e, data) => callback(data);
    ipcRenderer.on(fullChannel, handler);
    return () => ipcRenderer.removeListener(fullChannel, handler);
  },

  // 监听后端主动推送的日志
  onLog: (callback) => {
    const fullChannel = `plugin:${pluginId}:plugin:log`;
    const handler = (e, data) => callback(data);
    ipcRenderer.on(fullChannel, handler);
    return () => ipcRenderer.removeListener(fullChannel, handler);
  },
});
