'use strict';

/**
 * PluginManager — 插件管理核心
 *
 * 职责：
 *   1. 扫描 plugins/ 目录，加载已安装插件
 *   2. 安装：解压 .zip → 校验 manifest → 存入 registry
 *   3. 启用/禁用：fork 子进程运行插件后端，或终止子进程
 *   4. 卸载：终止子进程 + 删除插件目录
 *   5. 提供 IPC 通道供前端 UI 调用
 *
 * 目录结构：
 *   plugins/
 *     registry.json              # 已安装插件状态
 *     <plugin-id>/
 *       manifest.json            # 插件清单
 *       main.js                  # 后端入口
 *       ui/
 *         index.html             # UI 入口
 *         bundle.js              # UI 构建产物（开发者自建）
 *       data/                    # 插件私有数据目录
 *
 * manifest.json 规范见 docs/plugin-system.md
 */

const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const os = require('os');

const PLUGINS_DIR = path.join(__dirname, '..', '..', 'plugins');
const REGISTRY_PATH = path.join(PLUGINS_DIR, 'registry.json');

// 权限白名单（未声明的能力插件不可调用）
const PERMISSION_WHITELIST = new Set([
  'sign-server',   // 签名服务（浏览器内 executeJS/fetch/cookies/UA/导航/点击搜索/滚动/模拟/rap-param）
  'window',        // 独立 Electron 窗口
  'fs',            // 文件系统（限定插件 dataDir）
  'db',            // 数据库（预留）
  'log',           // 日志输出
  'config',        // 配置读写
]);

class PluginManager {
  constructor() {
    this.initialized = false;
    /** @type {Map<string, {manifest, enabled, proc, winId, host}>} */
    this.plugins = new Map();
    /** @type {SignServer|null} 按需创建的签名服务实例（仅当有 'sign-server' 权限插件启用时存在） */
    this.signServer = null;
    /** @type {number} 当前依赖 signServer 的启用插件计数，归零时销毁实例 */
    this.signServerRef = 0;
  }

  /**
   * 初始化：扫描 plugins/ 目录，加载 registry
   * @param {object} deps - { tabManager }
   */
  async init(deps = {}) {
    if (this.initialized) return;
    this.deps = deps;

    // 确保 plugins 目录存在
    if (!fs.existsSync(PLUGINS_DIR)) {
      fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    }

    // 加载 registry
    this.registry = this._loadRegistry();

    // 扫描目录，校验已注册的插件文件完整性
    for (const [id, entry] of Object.entries(this.registry)) {
      const pluginDir = path.join(PLUGINS_DIR, id);
      const manifestPath = path.join(pluginDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        console.warn(`[PluginManager] 插件 ${id} 目录缺失，跳过`);
        continue;
      }
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        this.plugins.set(id, {
          manifest,
          enabled: false,
          proc: null,
          winId: null,
          host: null,
          config: entry.config || {},
        });
        console.log(`[PluginManager] 已加载插件: ${id} v${manifest.version}`);
      } catch (e) {
        console.error(`[PluginManager] 插件 ${id} manifest 解析失败:`, e.message);
      }
    }

    // 自动发现：扫描 plugins/ 目录，注册未在 registry 中记录但目录存在的插件
    // 开发模式下直接放置插件目录即可被发现，无需手动安装
    try {
      const dirs = fs.readdirSync(PLUGINS_DIR).filter(d => {
        const stat = fs.statSync(path.join(PLUGINS_DIR, d));
        return stat.isDirectory();
      });
      for (const dir of dirs) {
        if (this.plugins.has(dir)) continue;
        const manifestPath = path.join(PLUGINS_DIR, dir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (manifest.id !== dir) continue; // 目录名必须匹配插件 id
          this.plugins.set(dir, {
            manifest,
            enabled: false,
            proc: null,
            winId: null,
            host: null,
            config: {},
          });
          console.log(`[PluginManager] 自动发现插件: ${dir} v${manifest.version}`);
        } catch (e) {
          console.warn(`[PluginManager] 目录 ${dir} manifest 解析失败:`, e.message);
        }
      }
    } catch (e) {
      console.warn('[PluginManager] 扫描插件目录失败:', e.message);
    }

    // 同步 registry（包含自动发现的插件）
    this._saveRegistry();

    this._registerIpc();
    this.initialized = true;
    console.log(`[PluginManager] 初始化完成，共 ${this.plugins.size} 个插件`);
  }

  // ============================================================
  // Registry 持久化
  // ============================================================

  _loadRegistry() {
    try {
      if (fs.existsSync(REGISTRY_PATH)) {
        return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
      }
    } catch (e) {
      console.warn('[PluginManager] registry 解析失败，重置:', e.message);
    }
    return {};
  }

  _saveRegistry() {
    const data = {};
    for (const [id, p] of this.plugins) {
      data[id] = { config: p.config || {} };
    }
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2), 'utf8');
  }

  // ============================================================
  // 插件安装/卸载
  // ============================================================

  /**
   * 安装插件（从 zip 压缩包）
   * zip 结构：根目录或单一子目录必须包含 manifest.json
   * @param {string} zipPath - zip 文件路径
   * @returns {Promise<{success, id?, error?}>}
   */
  async install(zipPath) {
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();

      // 找到 manifest.json 的位置（可能在根或单层子目录）
      const manifestEntry = entries.find(e => e.entryName.endsWith('manifest.json'));
      if (!manifestEntry) {
        return { success: false, error: '压缩包中未找到 manifest.json' };
      }

      // 确定 zip 内基础路径
      const basePath = manifestEntry.entryName.replace(/manifest\.json$/, '');

      // 先读取 manifest 确定插件 id
      const manifestText = manifestEntry.getData().toString('utf8');
      const manifest = JSON.parse(manifestText);
      if (!manifest.id || !manifest.version || !manifest.main) {
        return { success: false, error: 'manifest.json 缺少必填字段（id/version/main）' };
      }
      if (this.plugins.has(manifest.id)) {
        return { success: false, error: `插件 ${manifest.id} 已安装，请先卸载` };
      }

      // 权限校验
      const perms = manifest.permissions || [];
      const invalid = perms.filter(p => !PERMISSION_WHITELIST.has(p));
      if (invalid.length > 0) {
        return { success: false, error: `未知的权限声明: ${invalid.join(', ')}` };
      }

      // 解压到 plugins/<id>/
      const pluginDir = path.join(PLUGINS_DIR, manifest.id);
      fs.mkdirSync(pluginDir, { recursive: true });
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const relPath = entry.entryName.slice(basePath.length);
        if (!relPath) continue;
        const targetPath = path.join(pluginDir, relPath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, entry.getData());
      }

      // 创建 data 目录
      const dataDir = path.join(pluginDir, manifest.dataDir || 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

      // 注册
      this.plugins.set(manifest.id, {
        manifest,
        enabled: false,
        proc: null,
        winId: null,
        host: null,
        config: {},
      });
      this._saveRegistry();

      console.log(`[PluginManager] 插件安装成功: ${manifest.id} v${manifest.version}`);
      return { success: true, id: manifest.id };
    } catch (e) {
      console.error('[PluginManager] 安装失败:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * 卸载插件
   */
  async uninstall(id) {
    const p = this.plugins.get(id);
    if (!p) return { success: false, error: '插件未安装' };

    // 先禁用（终止子进程）
    if (p.enabled) {
      await this.disable(id);
    }

    // 删除目录
    const pluginDir = path.join(PLUGINS_DIR, id);
    try {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[PluginManager] 删除插件目录失败:`, e.message);
    }

    this.plugins.delete(id);
    this._saveRegistry();
    console.log(`[PluginManager] 插件已卸载: ${id}`);
    return { success: true };
  }

  // ============================================================
  // 启用/禁用（fork 子进程）
  // ============================================================

  /**
   * 启用插件：fork 子进程运行 main.js
   */
  async enable(id) {
    const p = this.plugins.get(id);
    if (!p) return { success: false, error: '插件未安装' };
    if (p.enabled) return { success: true, message: '插件已启用' };

    const pluginDir = path.join(PLUGINS_DIR, id);
    const mainPath = path.join(pluginDir, p.manifest.main);
    if (!fs.existsSync(mainPath)) {
      return { success: false, error: `插件入口文件不存在: ${p.manifest.main}` };
    }

    // 若插件声明 'sign-server' 权限，按需创建 SignServer 实例
    const perms = new Set(p.manifest.permissions || []);
    if (perms.has('sign-server')) {
      this._acquireSignServer();
    }

    // 构建宿主能力对象（通过 IPC 通道通信）
    const host = this._createHost(id, p.manifest);
    p.host = host;

    // fork 子进程
    const proc = fork(mainPath, [], {
      cwd: pluginDir,
      env: {
        ...process.env,
        PLUGIN_ID: id,
        PLUGIN_DIR: pluginDir,
        PLUGIN_DATA_DIR: path.join(pluginDir, p.manifest.dataDir || 'data'),
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    p.proc = proc;
    p.enabled = true;

    // 接收子进程消息（转发到插件 UI 窗口）
    proc.on('message', async (msg) => {
      await this._handlePluginMessage(id, msg);
    });

    proc.on('exit', (code, signal) => {
      console.log(`[PluginManager] 插件 ${id} 子进程退出: code=${code} signal=${signal}`);
      p.proc = null;
      p.enabled = false;
    });

    proc.on('error', (err) => {
      console.error(`[PluginManager] 插件 ${id} 子进程错误:`, err);
    });

    // stdout/stderr 转发到终端
    proc.stdout.on('data', (d) => process.stdout.write(`[plugin:${id}] ${d}`));
    proc.stderr.on('data', (d) => process.stderr.write(`[plugin:${id}] ${d}`));

    // 调用插件 onActivate
    proc.send({ type: 'activate', host: this._serializeHost(host) });

    console.log(`[PluginManager] 插件已启用: ${id} (PID: ${proc.pid})`);
    return { success: true, pid: proc.pid };
  }

  /**
   * 禁用插件：终止子进程
   */
  async disable(id) {
    const p = this.plugins.get(id);
    if (!p || !p.enabled) return { success: true };

    // 关闭窗口
    if (p.winId) {
      const win = BrowserWindow.fromId(p.winId);
      if (win && !win.isDestroyed()) win.close();
      p.winId = null;
    }

    // 通知插件 deactivate
    if (p.proc && p.proc.connected) {
      p.proc.send({ type: 'deactivate' });
      // 给 500ms 清理时间
      await new Promise(r => setTimeout(r, 500));
    }

    // 终止子进程
    if (p.proc) {
      try { p.proc.kill('SIGTERM'); } catch {}
      p.proc = null;
    }

    p.enabled = false;
    p.host = null;

    // 若插件声明 'sign-server' 权限，释放 SignServer 引用，归零时销毁实例
    const perms = new Set(p.manifest.permissions || []);
    if (perms.has('sign-server')) {
      this._releaseSignServer();
    }

    console.log(`[PluginManager] 插件已禁用: ${id}`);
    return { success: true };
  }

  // ============================================================
  // SignServer 生命周期管理（按需创建/销毁）
  // ============================================================

  /**
   * 获取/创建 SignServer 实例（引用计数 +1）
   * 仅当有声明 'sign-server' 权限的插件启用时创建
   */
  _acquireSignServer() {
    this.signServerRef++;
    if (!this.signServer) {
      const SignServer = require('./sign_server');
      this.signServer = new SignServer(this.deps?.tabManager);
      console.log('[PluginManager] SignServer 实例已创建（按需启动）');
    }
  }

  /**
   * 释放 SignServer 引用（引用计数 -1，归零时销毁实例）
   */
  _releaseSignServer() {
    if (this.signServerRef > 0) this.signServerRef--;
    if (this.signServerRef === 0 && this.signServer) {
      this.signServer = null;
      console.log('[PluginManager] SignServer 实例已销毁（无插件使用）');
    }
  }

  // ============================================================
  // 宿主能力封装
  // ============================================================

  /**
   * 为插件创建 host 对象（通过 IPC 与主进程通信）
   * 子进程通过 process.on('message') 接收 host 调用结果
   */
  _createHost(pluginId, manifest) {
    const perms = new Set(manifest.permissions || []);
    const dataDir = path.join(PLUGINS_DIR, pluginId, manifest.dataDir || 'data');
    const self = this;

    return {
      pluginId,
      permissions: perms,
      dataDir,

      // 签名服务（需 'sign-server' 权限）
      signServer: perms.has('sign-server') ? {
        browserFetch: (apiPath, bodyStr, xsc, rapParam, xs, xt) =>
          self._callSignServer('browserFetch', [apiPath, bodyStr, xsc, rapParam, xs, xt]),
        getBrowserCookies: () => self._callSignServer('getBrowserCookies', []),
        getBrowserUA: () => self._callSignServer('getBrowserUA', []),
        browserNavigate: (url, delay) => self._callSignServer('browserNavigate', [url, delay]),
        browserClickSearch: (keyword) => self._callSignServer('browserClickSearch', [keyword]),
        browserScroll: () => self._callSignServer('browserScroll', []),
        browserSimulate: () => self._callSignServer('browserSimulate', []),
        executeScript: (code) => self._callSignServer('executeScript', [code]),
        injectRapInterceptor: () => self._callSignServer('injectRapInterceptor', []),
        getRapParam: () => self._callSignServer('getRapParam', []),
      } : null,

      // 文件系统（限定 dataDir，需 'fs' 权限）
      fs: perms.has('fs') ? {
        read: (relPath) => {
          const abs = path.resolve(dataDir, relPath);
          if (!abs.startsWith(dataDir)) throw new Error('路径越界');
          return fs.readFileSync(abs, 'utf8');
        },
        write: (relPath, content) => {
          const abs = path.resolve(dataDir, relPath);
          if (!abs.startsWith(dataDir)) throw new Error('路径越界');
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content);
        },
        list: (relDir = '.') => {
          const abs = path.resolve(dataDir, relDir);
          if (!abs.startsWith(dataDir)) throw new Error('路径越界');
          return fs.readdirSync(abs);
        },
        exists: (relPath) => {
          const abs = path.resolve(dataDir, relPath);
          if (!abs.startsWith(dataDir)) throw new Error('路径越界');
          return fs.existsSync(abs);
        },
        mkdir: (relDir) => {
          const abs = path.resolve(dataDir, relDir);
          if (!abs.startsWith(dataDir)) throw new Error('路径越界');
          fs.mkdirSync(abs, { recursive: true });
        },
      } : null,

      // 数据库（预留，需 'db' 权限）
      db: perms.has('db') ? {
        query: (sql, params) => {
          // TODO: 接入实际数据库
          throw new Error('数据库能力尚未实现');
        },
      } : null,

      // 日志（对象形式，与 HostProxy 期望一致）
      log: {
        log: (msg, level = 'info') => {
          console.log(`[plugin:${pluginId}] ${msg}`);
          self._sendToPluginWindow(pluginId, 'plugin:log', { message: msg, level, timestamp: Date.now() });
        },
        info: (msg) => {
          console.log(`[plugin:${pluginId}] ${msg}`);
          self._sendToPluginWindow(pluginId, 'plugin:log', { message: msg, level: 'info', timestamp: Date.now() });
        },
        warn: (msg) => {
          console.warn(`[plugin:${pluginId}] ${msg}`);
          self._sendToPluginWindow(pluginId, 'plugin:log', { message: msg, level: 'warn', timestamp: Date.now() });
        },
        error: (msg) => {
          console.error(`[plugin:${pluginId}] ${msg}`);
          self._sendToPluginWindow(pluginId, 'plugin:log', { message: msg, level: 'error', timestamp: Date.now() });
        },
      },

      // 配置
      config: {
        get: (key) => {
          const p = self.plugins.get(pluginId);
          return p ? p.config[key] : undefined;
        },
        set: (key, value) => {
          const p = self.plugins.get(pluginId);
          if (p) {
            p.config[key] = value;
            self._saveRegistry();
          }
        },
        getAll: () => {
          const p = self.plugins.get(pluginId);
          return p ? { ...p.config } : {};
        },
        setAll: (cfg) => {
          const p = self.plugins.get(pluginId);
          if (p) {
            p.config = { ...cfg };
            self._saveRegistry();
          }
        },
      },

      // 窗口（向插件 UI 窗口发消息，需 'window' 权限）
      window: perms.has('window') ? {
        send: (channel, data) => self._sendToPluginWindow(pluginId, channel, data),
        close: () => self._closePluginWindow(pluginId),
      } : null,
    };
  }

  /**
   * 序列化 host 传给子进程（子进程通过 IPC 调用，不直接持有对象）
   * 子进程收到的是方法名列表，调用时通过 process.send({type:'host-call', method, args}) 发起
   */
  _serializeHost(host) {
    const result = {};
    for (const key of Object.keys(host)) {
      if (host[key] === null) {
        result[key] = null;
      } else if (typeof host[key] === 'function') {
        result[key] = 'function';
      } else if (typeof host[key] === 'object') {
        const sub = {};
        for (const subKey of Object.keys(host[key])) {
          sub[subKey] = typeof host[key][subKey] === 'function' ? 'function' : subKey;
        }
        result[key] = sub;
      } else {
        result[key] = host[key];
      }
    }
    return result;
  }

  /**
   * 处理子进程发起的 host 调用
   */
  async _handlePluginMessage(pluginId, msg) {
    if (!msg || msg.type !== 'host-call') return;
    const p = this.plugins.get(pluginId);
    if (!p || !p.host) return;

    const { callId, namespace, method, args } = msg;
    try {
      let target = p.host;
      if (namespace) target = p.host[namespace];
      if (!target || typeof target[method] !== 'function') {
        throw new Error(`未知的 host 方法: ${namespace}.${method}`);
      }
      const result = await target[method](...(args || []));
      if (p.proc && p.proc.connected) {
        p.proc.send({ type: 'host-result', callId, success: true, result });
      }
    } catch (e) {
      if (p.proc && p.proc.connected) {
        p.proc.send({ type: 'host-result', callId, success: false, error: e.message });
      }
    }
  }

  /**
   * 调用签名服务（使用按需创建的本地实例）
   */
  async _callSignServer(method, args) {
    if (!this.signServer) throw new Error('签名服务未启动（需启用声明 sign-server 权限的插件）');
    if (typeof this.signServer[method] !== 'function') {
      throw new Error(`签名服务未实现方法: ${method}`);
    }
    return await this.signServer[method](...args);
  }

  // ============================================================
  // 插件窗口管理
  // ============================================================

  /**
   * 打开插件 UI 窗口
   */
  async openWindow(id) {
    const p = this.plugins.get(id);
    if (!p) return { success: false, error: '插件未安装' };
    if (!p.enabled) return { success: false, error: '插件未启用' };

    // 窗口已存在则聚焦
    if (p.winId) {
      const win = BrowserWindow.fromId(p.winId);
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
        return { success: true };
      }
    }

    const uiConfig = p.manifest.ui || {};
    const entryPath = path.join(PLUGINS_DIR, id, uiConfig.entry || 'ui/index.html');
    if (!fs.existsSync(entryPath)) {
      return { success: false, error: `UI 入口不存在: ${uiConfig.entry}` };
    }

    const win = new BrowserWindow({
      width: uiConfig.window?.width || 1000,
      height: uiConfig.window?.height || 700,
      title: uiConfig.window?.title || p.manifest.name,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '..', 'plugin_preload.js'),
        additionalArguments: [`plugin-id=${id}`],
      },
    });

    win.loadFile(entryPath);
    p.winId = win.id;

    win.on('closed', () => {
      p.winId = null;
    });

    return { success: true };
  }

  /**
   * 向插件 UI 窗口发送消息
   */
  _sendToPluginWindow(pluginId, channel, data) {
    const p = this.plugins.get(pluginId);
    if (!p || !p.winId) return;
    const win = BrowserWindow.fromId(p.winId);
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.send(`plugin:${pluginId}:${channel}`, data);
    }
  }

  _closePluginWindow(pluginId) {
    const p = this.plugins.get(pluginId);
    if (!p || !p.winId) return;
    const win = BrowserWindow.fromId(p.winId);
    if (win && !win.isDestroyed()) win.close();
    p.winId = null;
  }

  // ============================================================
  // 查询
  // ============================================================

  list() {
    const result = [];
    for (const [id, p] of this.plugins) {
      result.push({
        id,
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description,
        author: p.manifest.author,
        enabled: p.enabled,
        hasWindow: !!p.manifest.ui,
        windowOpen: !!p.winId,
        permissions: p.manifest.permissions || [],
        configSchema: p.manifest.config?.schema || [],
        config: p.config,
      });
    }
    return result;
  }

  get(id) {
    const p = this.plugins.get(id);
    if (!p) return null;
    return {
      id,
      manifest: p.manifest,
      enabled: p.enabled,
      config: p.config,
    };
  }

  // ============================================================
  // IPC 注册
  // ============================================================

  _registerIpc() {
    // 列出所有插件
    ipcMain.handle('plugin:list', async () => ({ success: true, data: this.list() }));

    // 安装
    ipcMain.handle('plugin:install', async (e, { zipPath }) => this.install(zipPath));

    // 卸载
    ipcMain.handle('plugin:uninstall', async (e, { id }) => this.uninstall(id));

    // 启用
    ipcMain.handle('plugin:enable', async (e, { id }) => this.enable(id));

    // 禁用
    ipcMain.handle('plugin:disable', async (e, { id }) => this.disable(id));

    // 打开窗口
    ipcMain.handle('plugin:open-window', async (e, { id }) => this.openWindow(id));

    // 关闭窗口
    ipcMain.handle('plugin:close-window', async (e, { id }) => {
      this._closePluginWindow(id);
      return { success: true };
    });

    // 获取配置
    ipcMain.handle('plugin:config-get', async (e, { id }) => {
      const p = this.plugins.get(id);
      return { success: true, data: p ? p.config : {} };
    });

    // 保存配置
    ipcMain.handle('plugin:config-save', async (e, { id, config }) => {
      const p = this.plugins.get(id);
      if (p) {
        p.config = { ...config };
        this._saveRegistry();
      }
      return { success: true };
    });

    // 从 UI 窗口发消息到插件后端
    ipcMain.handle('plugin:call-backend', async (e, { id, channel, data }) => {
      const p = this.plugins.get(id);
      if (!p || !p.proc || !p.proc.connected) {
        return { success: false, error: '插件后端未运行' };
      }
      return new Promise((resolve) => {
        const callId = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => resolve({ success: false, error: '后端调用超时' }), 30000);
        const handler = (msg) => {
          if (msg.type === 'backend-result' && msg.callId === callId) {
            clearTimeout(timer);
            p.proc.off('message', handler);
            resolve(msg.success ? { success: true, data: msg.result } : { success: false, error: msg.error });
          }
        };
        p.proc.on('message', handler);
        p.proc.send({ type: 'ui-call', callId, channel, data });
      });
    });

    // 从 UI 窗口调用宿主能力（绕过插件后端，直接调用 host）
    // 用于 UI 直接读取配置、调用签名服务等场景
    ipcMain.handle('plugin:host-call', async (e, { id, namespace, method, args }) => {
      const p = this.plugins.get(id);
      if (!p || !p.host) return { success: false, error: '插件未启用' };
      try {
        let target = p.host;
        if (namespace) target = p.host[namespace];
        if (!target || typeof target[method] !== 'function') {
          throw new Error(`未知方法: ${namespace}.${method}`);
        }
        const result = await target[method](...(args || []));
        return { success: true, data: result };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });
  }

  /**
   * 清理所有插件（应用退出时）
   */
  async cleanup() {
    for (const id of this.plugins.keys()) {
      try { await this.disable(id); } catch {}
    }
  }
}

const pluginManager = new PluginManager();
module.exports = pluginManager;
