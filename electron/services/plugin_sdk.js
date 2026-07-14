'use strict';

/**
 * PluginSDK — 插件子进程辅助工具
 *
 * 插件 main.js 通过 require 使用此 SDK，简化与主进程的 IPC 通信
 *
 * 用法：
 *   const { PluginBase } = require('./plugin_sdk');
 *
 *   class MyPlugin extends PluginBase {
 *     async onActivate() { ... }
 *     async onStart(params) { ... }
 *     async onStop() { ... }
 *     async onMessage(channel, data) { ... }
 *   }
 *
 *   module.exports = new MyPlugin();
 */

const fs = require('fs');
const path = require('path');

/**
 * Host 代理对象 — 通过 IPC 调用主进程的宿主能力
 * 子进程不直接持有 host 对象，而是通过 process.send 发起调用
 */
class HostProxy {
  constructor() {
    this._callId = 0;
    this._pending = new Map();
    this._dataDir = process.env.PLUGIN_DATA_DIR || '';
    this.pluginId = process.env.PLUGIN_ID || '';
    this.pluginDir = process.env.PLUGIN_DIR || '';

    process.on('message', (msg) => {
      if (!msg) return;
      // host 调用结果
      if (msg.type === 'host-result' && this._pending.has(msg.callId)) {
        const { resolve, reject } = this._pending.get(msg.callId);
        this._pending.delete(msg.callId);
        if (msg.success) resolve(msg.result);
        else reject(new Error(msg.error || 'host 调用失败'));
      }
    });
  }

  /**
   * 发起 host 调用
   * @param {string} namespace - 'signServer' | 'fs' | 'db' | 'log' | 'window' | 'config' | ''
   * @param {string} method - 方法名
   * @param {Array} args - 参数
   */
  _call(namespace, method, args) {
    return new Promise((resolve, reject) => {
      const callId = `host-${++this._callId}-${Date.now()}`;
      this._pending.set(callId, { resolve, reject });
      process.send({ type: 'host-call', callId, namespace, method, args: args || [] });
    });
  }

  get signServer() {
    return {
      browserFetch: (...a) => this._call('signServer', 'browserFetch', a),
      getBrowserCookies: () => this._call('signServer', 'getBrowserCookies', []),
      getBrowserUA: () => this._call('signServer', 'getBrowserUA', []),
      browserNavigate: (...a) => this._call('signServer', 'browserNavigate', a),
      browserClickSearch: (...a) => this._call('signServer', 'browserClickSearch', a),
      browserScroll: () => this._call('signServer', 'browserScroll', []),
      browserSimulate: () => this._call('signServer', 'browserSimulate', []),
      executeScript: (...a) => this._call('signServer', 'executeScript', a),
      injectRapInterceptor: () => this._call('signServer', 'injectRapInterceptor', []),
      getRapParam: () => this._call('signServer', 'getRapParam', []),
    };
  }

  get fs() {
    return {
      read: (...a) => this._call('fs', 'read', a),
      write: (...a) => this._call('fs', 'write', a),
      list: (...a) => this._call('fs', 'list', a),
      exists: (...a) => this._call('fs', 'exists', a),
      mkdir: (...a) => this._call('fs', 'mkdir', a),
    };
  }

  get config() {
    return {
      get: (...a) => this._call('config', 'get', a),
      set: (...a) => this._call('config', 'set', a),
      getAll: () => this._call('config', 'getAll', []),
      setAll: (...a) => this._call('config', 'setAll', a),
    };
  }

  get log() {
    return {
      log: (msg, level) => this._call('log', 'log', [msg, level]),
      info: (msg) => this._call('log', 'log', [msg, 'info']),
      warn: (msg) => this._call('log', 'log', [msg, 'warn']),
      error: (msg) => this._call('log', 'log', [msg, 'error']),
    };
  }

  get window() {
    return {
      send: (...a) => this._call('window', 'send', a),
      close: () => this._call('window', 'close', []),
    };
  }

  get db() {
    return {
      query: (...a) => this._call('db', 'query', a),
    };
  }
}

/**
 * 插件基类 — 子进程入口
 */
class PluginBase {
  constructor() {
    this.host = new HostProxy();
    this._initIpc();
  }

  _initIpc() {
    process.on('message', async (msg) => {
      if (!msg) return;

      switch (msg.type) {
        case 'activate':
          // 主进程通知激活，host schema 已传入
          try {
            await this.onActivate();
          } catch (e) {
            console.error('[Plugin] onActivate 异常:', e);
          }
          break;

        case 'deactivate':
          try {
            await this.onDeactivate();
          } catch (e) {
            console.error('[Plugin] onDeactivate 异常:', e);
          }
          break;

        case 'ui-call':
          // UI 窗口发起的调用，转发到插件的 onMessage
          try {
            const result = await this.onMessage(msg.channel, msg.data);
            process.send({ type: 'backend-result', callId: msg.callId, success: true, result });
          } catch (e) {
            process.send({ type: 'backend-result', callId: msg.callId, success: false, error: e.message });
          }
          break;
      }
    });
  }

  // 子类重写
  async onActivate() {}
  async onDeactivate() {}
  async onMessage(channel, data) { return null; }

  /**
   * 向 UI 窗口发送消息
   */
  sendToUI(channel, data) {
    return this.host.window.send(channel, data);
  }

  /**
   * 记录日志（同时发送到 UI 和终端）
   */
  log(msg, level = 'info') {
    return this.host.log.log(msg, level);
  }
}

module.exports = { PluginBase, HostProxy };
