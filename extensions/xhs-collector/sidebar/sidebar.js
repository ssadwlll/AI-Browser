/**
 * sidebar.js — 侧边栏交互逻辑
 *
 * 相比 popup.js 的改进：
 *   1. 侧边栏常驻不销毁，轮询持续运行，进度实时更新
 *   2. visibilitychange 监听：切回侧栏时自动恢复轮询
 *   3. SW 重启容错：轮询中收到 collecting=false 时不立即停止，
 *      先重试确认，避免 SW 重启瞬间状态未同步导致误停
 */
(function () {
  'use strict';

  // ======================= DOM 元素 =======================

  var el = {
    keyword: document.getElementById('keyword'),
    pages: document.getElementById('pages'),
    delayMin: document.getElementById('delayMin'),
    delayMax: document.getElementById('delayMax'),
    deepInteractionInterval: document.getElementById('deepInteractionInterval'),
    btnStart: document.getElementById('btnStart'),
    btnStop: document.getElementById('btnStop'),
    btnOpenXhs: document.getElementById('btnOpenXhs'),
    statusMnsv2: document.getElementById('statusMnsv2'),
    statusCookie: document.getElementById('statusCookie'),
    statusRapParam: document.getElementById('statusRapParam'),
    statusTab: document.getElementById('statusTab'),
    progressSection: document.getElementById('progressSection'),
    progressKeyword: document.getElementById('progressKeyword'),
    progressPhase: document.getElementById('progressPhase'),
    progressCounts: document.getElementById('progressCounts'),
    progressBar: document.getElementById('progressBar'),
    progressText: document.getElementById('progressText'),
    resultsList: document.getElementById('resultsList'),
    resultsSummary: document.getElementById('resultsSummary'),
    totalNotes: document.getElementById('totalNotes'),
    totalDetails: document.getElementById('totalDetails'),
    btnExportJson: document.getElementById('btnExportJson'),
    btnExportCsv: document.getElementById('btnExportCsv'),
    btnExportDb: document.getElementById('btnExportDb'),
    btnClear: document.getElementById('btnClear'),
    consoleOutput: document.getElementById('consoleOutput'),
    btnClearLog: document.getElementById('btnClearLog'),
  };

  // ======================= 控制台日志 =======================

  var MAX_LOG_LINES = 500; // 最多保留 500 行日志，避免内存占用过大
  var logLineCount = 0;

  function appendLog(message, level, timestamp) {
    if (!el.consoleOutput) return;
    var time = new Date(timestamp || Date.now());
    var timeStr = time.getHours().toString().padStart(2, '0') + ':' +
      time.getMinutes().toString().padStart(2, '0') + ':' +
      time.getSeconds().toString().padStart(2, '0') + '.' +
      time.getMilliseconds().toString().padStart(3, '0');

    var line = document.createElement('div');
    line.className = 'log-line log-' + (level || 'info');
    line.innerHTML = '<span class="log-time">[' + timeStr + ']</span>' + escapeHtml(message);

    // 倒序显示：新日志插入到最前面，无需滚动即可看到最新日志
    if (el.consoleOutput.firstChild) {
      el.consoleOutput.insertBefore(line, el.consoleOutput.firstChild);
    } else {
      el.consoleOutput.appendChild(line);
    }
    logLineCount++;

    // 超过最大行数时删除最早的日志（最后一条）
    if (logLineCount > MAX_LOG_LINES) {
      var lastChild = el.consoleOutput.lastChild;
      if (lastChild) el.consoleOutput.removeChild(lastChild);
      logLineCount--;
    }
  }

  // 监听 background 的日志广播
  chrome.runtime.onMessage.addListener(function (message) {
    if (message.type === 'CONSOLE_LOG') {
      appendLog(message.message, message.level, message.timestamp);
    }
  });

  // ======================= 消息工具 =======================

  function sendMessage(message) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(message, function (response) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  /**
   * 带超时的 sendMessage，避免 content script 忙时卡住侧栏
   */
  function sendMessageWithTimeout(message, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          reject(new Error('消息超时 (' + message.type + ', ' + timeoutMs + 'ms)'));
        }
      }, timeoutMs);
      chrome.runtime.sendMessage(message, function (response) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  // ======================= IndexedDB 直访 =======================
  //
  // 侧边栏与 background 同源，可直接打开同一个 IndexedDB。
  // 导出大量数据（10000+ 笔记，140MB+）时避免通过 chrome.runtime.sendMessage
  // 传递——sendMessage 需要结构化克隆，大对象会卡顿甚至失败。
  // 直接读 IndexedDB 在 sidebar 自身 JS 上下文完成，无跨上下文开销。

  var DB_NAME = 'xhs_collector';
  var DB_VERSION = 1;
  var STORE_NAME = 'results';

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'keyword' });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  /**
   * 读取所有采集结果（直访 IndexedDB，不经 sendMessage）
   */
  async function dbGetAllResults() {
    var db = await openDB();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readonly');
      var req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = function (e) {
        db.close();
        var results = e.target.result || [];
        results.sort(function (a, b) {
          return (a.savedAt || 0) - (b.savedAt || 0);
        });
        resolve(results);
      };
      req.onerror = function (e) {
        db.close();
        reject(e.target.error);
      };
    });
  }

  /**
   * 获取记录数（轻量判空，避免为判空加载全部数据）
   */
  async function dbGetCount() {
    var db = await openDB();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readonly');
      var req = tx.objectStore(STORE_NAME).count();
      req.onsuccess = function (e) { db.close(); resolve(e.target.result || 0); };
      req.onerror = function (e) { db.close(); reject(e.target.error); };
    });
  }

  // ======================= 状态更新 =======================

  function setStatusDot(element, status, label) {
    var dot = element.querySelector('.status-dot');
    var text = element.querySelector('.status-label');
    dot.className = 'status-dot ' + status;
    text.textContent = label;
  }

  async function updateStatus() {
    try {
      var resp = await sendMessageWithTimeout({ type: 'CHECK_CONTENT_STATUS' }, 3000);
      if (resp && resp.ok) {
        setStatusDot(el.statusMnsv2, resp.mnsv2Ready ? 'ok' : 'warn',
          resp.mnsv2Ready ? '签名引擎就绪' : '签名引擎未就绪');
        if (resp.loggedIn === null) {
          setStatusDot(el.statusCookie, 'warn', '登录态采集时验证');
        } else {
          setStatusDot(el.statusCookie, resp.loggedIn ? 'ok' : 'error',
            resp.loggedIn ? '已登录' : '未登录');
        }
        setStatusDot(el.statusRapParam,
          (resp.rapParams && (resp.rapParams.search || resp.rapParams.feed)) ? 'ok' : 'warn',
          (resp.rapParams && (resp.rapParams.search || resp.rapParams.feed)) ? '反爬参数已捕获' : '反爬参数待捕获');
        setStatusDot(el.statusTab, 'ok', '标签页已连接');
        el.btnOpenXhs.style.display = 'none';
      } else {
        setStatusDot(el.statusMnsv2, 'error', '签名引擎未连接');
        setStatusDot(el.statusCookie, 'error', '未连接');
        setStatusDot(el.statusRapParam, 'error', '未连接');
        setStatusDot(el.statusTab, 'warn', '标签页未找到');
        el.btnOpenXhs.style.display = 'inline-block';
      }
    } catch (e) {
      setStatusDot(el.statusMnsv2, 'error', '未连接');
      setStatusDot(el.statusCookie, 'error', '未连接');
      setStatusDot(el.statusRapParam, 'error', '未连接');
      setStatusDot(el.statusTab, 'warn', '标签页未找到');
      el.btnOpenXhs.style.display = 'inline-block';
    }
  }

  // ======================= 进度更新 =======================

  function updateProgress(progress) {
    if (!progress) return;

    el.progressSection.style.display = 'block';

    el.progressKeyword.textContent = progress.keyword || '-';

    var phaseText = '';
    switch (progress.phase) {
      case 'start':
        phaseText = '开始采集';
        break;
      case 'injecting':
        phaseText = '注入签名脚本...';
        break;
      case 'searching':
        phaseText = '页面搜索框输入关键词...';
        break;
      case 'search':
        phaseText = '搜索第 ' + progress.page + '/' + progress.totalPages + ' 页 (' + progress.noteCount + ' 条)';
        break;
      case 'search_error':
        phaseText = '搜索错误: ' + (progress.msg || progress.error || ('code:' + progress.code));
        break;
      case 'scrolling':
        phaseText = '滚动加载笔记 (' + progress.noteCount + ' 条)';
        break;
      case 'back_to_top':
        phaseText = '回到顶部';
        break;
      case 'detail_start':
        phaseText = '开始采集详情 (' + progress.totalNotes + ' 条)';
        break;
      case 'detail':
        phaseText = '详情采集 ' + progress.current + '/' + progress.total;
        el.progressCounts.textContent = (progress.success || 0) + ' / ' + (progress.fail || 0);
        var pct = progress.total > 0 ? Math.round(progress.current / progress.total * 100) : 0;
        el.progressBar.style.width = pct + '%';
        el.progressText.textContent = pct + '%';
        break;
      case 'rate_limited':
        phaseText = '限流，等待重试...';
        break;
      case 'env_detection':
        phaseText = '环境检测，等待恢复...';
        break;
      case 'consecutive_fail':
        phaseText = '连续失败 ' + progress.count + ' 次，暂停';
        break;
      case 'behavior_simulation':
        phaseText = '模拟人类行为... (第 ' + (progress.behaviorCount || 1) + ' 次)';
        break;
      case 'complete':
        phaseText = '采集完成';
        el.progressCounts.textContent = (progress.detailsCount || 0) + ' / ' + (progress.failuresCount || 0);
        if (progress.stopped) {
          var reasonText = '';
          if (progress.reason === 'login_expired') reasonText = ' (登录过期)';
          else if (progress.reason === 'account_blocked') reasonText = ' (账号异常)';
          else if (progress.reason === 'env_detection') reasonText = ' (环境检测)';
          else if (progress.reason === 'rate_limited') reasonText = ' (限流/环境检测)';
          else if (progress.reason === 'search_all_failed') reasonText = ' (搜索全部失败)';
          else if (progress.reason === 'service_worker_restart') reasonText = ' (服务重启)';
          else if (progress.reason === 'user_stopped') reasonText = ' (用户停止)';
          else if (progress.reason === 'tab_closed') reasonText = ' (标签页关闭)';
          else if (progress.reason === 'tab_refreshed') reasonText = ' (标签页刷新)';
          phaseText = '采集中断' + reasonText;
        }
        el.progressBar.style.width = '100%';
        el.progressText.textContent = '完成';
        break;
      default:
        phaseText = progress.phase || '处理中...';
    }

    el.progressPhase.textContent = phaseText;

    if (progress.phase === 'search' || progress.phase === 'search_error') {
      el.progressCounts.textContent = progress.noteCount + ' 条';
      var searchPct = progress.totalPages > 0 ? Math.round(progress.page / progress.totalPages * 100) : 0;
      el.progressBar.style.width = searchPct + '%';
      el.progressText.textContent = searchPct + '%';
    }
  }

  // ======================= 结果展示 =======================

  async function loadResults() {
    try {
      // 先用 count 轻量判空，避免无数据时加载全部
      var count = await dbGetCount();
      if (count === 0) {
        el.resultsList.innerHTML = '<div class="empty-state">暂无采集结果</div>';
        el.resultsSummary.style.display = 'none';
        el.btnExportJson.disabled = true;
        el.btnExportCsv.disabled = true;
        el.btnExportDb.disabled = true;
        el.btnClear.disabled = true;
        return;
      }
      // 直访 IndexedDB 读取全部结果（避免 sendMessage 传递大数据）
      var results = await dbGetAllResults();
      renderResults(results);
      el.btnExportJson.disabled = false;
      el.btnExportCsv.disabled = false;
      el.btnExportDb.disabled = false;
      el.btnClear.disabled = false;
    } catch (e) {
      el.resultsList.innerHTML = '<div class="empty-state">加载结果失败: ' + escapeHtml(e.message) + '</div>';
    }
  }

  function renderResults(results) {
    var html = '';
    var totalNotes = 0;
    var totalDetails = 0;

    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var notesCount = (r.notes || []).length;
      var detailsCount = (r.details || []).length;
      var failCount = (r.failures || []).length;
      totalNotes += notesCount;
      totalDetails += detailsCount;

      var status = r.stopped ? '⛔' : '✅';
      html += '<div class="result-item" data-idx="' + i + '">';
      html += '<div class="result-header">';
      html += '<div class="result-keyword">' + status + ' ' + escapeHtml(r.keyword) + '</div>';
      html += '<button class="btn btn-small btn-view" data-idx="' + i + '">查看</button>';
      html += '</div>';
      html += '<div class="result-stats">';
      html += '<span class="stat">笔记 ' + notesCount + '</span>';
      html += '<span class="stat stat-success">详情 ' + detailsCount + '</span>';
      if (failCount > 0) {
        html += '<span class="stat stat-fail">失败 ' + failCount + '</span>';
      }
      html += '</div>';
      // 笔记详情列表（默认隐藏）
      html += '<div class="result-details" id="resultDetails_' + i + '" style="display:none;"></div>';
      html += '</div>';
    }

    el.resultsList.innerHTML = html;
    el.totalNotes.textContent = totalNotes;
    el.totalDetails.textContent = totalDetails;
    el.resultsSummary.style.display = 'block';

    // 缓存结果数据供查看按钮使用
    cachedResults = results;

    // 绑定查看按钮事件
    var viewBtns = el.resultsList.querySelectorAll('.btn-view');
    for (var j = 0; j < viewBtns.length; j++) {
      viewBtns[j].addEventListener('click', toggleResultDetails);
    }
  }

  // 缓存的结果数据（供查看按钮使用）
  var cachedResults = [];

  function toggleResultDetails(e) {
    var idx = parseInt(e.target.getAttribute('data-idx'));
    var detailsEl = document.getElementById('resultDetails_' + idx);
    if (!detailsEl) return;

    if (detailsEl.style.display === 'none') {
      // 展开：渲染笔记详情
      if (detailsEl.innerHTML === '') {
        renderResultDetails(detailsEl, cachedResults[idx]);
      }
      detailsEl.style.display = 'block';
      e.target.textContent = '收起';
    } else {
      detailsEl.style.display = 'none';
      e.target.textContent = '查看';
    }
  }

  function renderResultDetails(container, result) {
    var details = result.details || [];
    var notes = result.notes || [];
    var html = '';

    if (details.length === 0 && notes.length === 0) {
      html = '<div class="detail-empty">无笔记数据</div>';
      container.innerHTML = html;
      return;
    }

    // 详情列表
    if (details.length > 0) {
      html += '<div class="detail-section-title">详情 (' + details.length + ')</div>';
      for (var i = 0; i < details.length; i++) {
        var d = details[i];
        html += '<div class="detail-item">';
        html += '<div class="detail-title">' + escapeHtml(d.title || '(无标题)') + '</div>';
        html += '<div class="detail-desc">' + escapeHtml((d.desc || '').slice(0, 100)) + (d.desc && d.desc.length > 100 ? '...' : '') + '</div>';
        html += '<div class="detail-meta">';
        if (d.user && d.user.nickname) {
          html += '<span class="meta-item">作者: ' + escapeHtml(d.user.nickname) + '</span>';
        }
        if (d.interactInfo) {
          if (d.interactInfo.likedCount !== undefined) html += '<span class="meta-item">赞 ' + d.interactInfo.likedCount + '</span>';
          if (d.interactInfo.collectedCount !== undefined) html += '<span class="meta-item">藏 ' + d.interactInfo.collectedCount + '</span>';
          if (d.interactInfo.commentCount !== undefined) html += '<span class="meta-item">评 ' + d.interactInfo.commentCount + '</span>';
        }
        if (d.type) html += '<span class="meta-item">类型: ' + escapeHtml(d.type) + '</span>';
        if (d.noteId) html += '<a class="meta-link" href="https://www.xiaohongshu.com/explore/' + d.noteId + '" target="_blank">打开 ↗</a>';
        html += '</div>';
        html += '</div>';
      }
    }

    // 笔记列表（仅列表，无详情）
    if (notes.length > 0 && details.length === 0) {
      html += '<div class="detail-section-title">笔记列表 (' + notes.length + ')</div>';
      for (var j = 0; j < notes.length; j++) {
        var n = notes[j];
        html += '<div class="detail-item">';
        html += '<div class="detail-title">' + escapeHtml(n.title || n.noteId || '(无标题)') + '</div>';
        html += '<div class="detail-meta">';
        if (n.noteId) html += '<span class="meta-item">ID: ' + escapeHtml(n.noteId) + '</span>';
        if (n.user && n.user.nickname) html += '<span class="meta-item">作者: ' + escapeHtml(n.user.nickname) + '</span>';
        html += '</div>';
        html += '</div>';
      }
    }

    container.innerHTML = html;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ======================= 导出功能 =======================

  function downloadFile(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function exportJson() {
    try {
      // 直访 IndexedDB，避免 sendMessage 传递大数据
      var results = await dbGetAllResults();
      if (!results || results.length === 0) {
        alert('暂无采集结果可导出');
        return;
      }
      var json = JSON.stringify(results, null, 2);
      var ts = new Date().toISOString().slice(0, 10);
      downloadFile('xhs_notes_' + ts + '.json', json, 'application/json');
    } catch (e) {
      alert('导出 JSON 失败: ' + e.message);
    }
  }

  async function exportCsv() {
    try {
      var results = await dbGetAllResults();
      if (!results || results.length === 0) {
        alert('暂无采集结果可导出');
        return;
      }

      var rows = [['关键词', '笔记ID', '标题', '描述', '类型', '用户ID', '昵称', '点赞', '收藏', '评论', '分享', '发布时间', '图片数', '笔记链接']];
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        var details = r.details || [];
        for (var j = 0; j < details.length; j++) {
          var d = details[j];
          rows.push([
            csvEscape(d.keyword || r.keyword),
            csvEscape(d.noteId),
            csvEscape(d.title),
            csvEscape(d.desc),
            csvEscape(d.type),
            csvEscape(d.user ? d.user.userId : ''),
            csvEscape(d.user ? d.user.nickname : ''),
            csvEscape(d.interactInfo ? d.interactInfo.likedCount : ''),
            csvEscape(d.interactInfo ? d.interactInfo.collectedCount : ''),
            csvEscape(d.interactInfo ? d.interactInfo.commentCount : ''),
            csvEscape(d.interactInfo ? d.interactInfo.shareCount : ''),
            csvEscape(d.time),
            d.imageList ? d.imageList.length : 0,
            'https://www.xiaohongshu.com/explore/' + d.noteId,
          ]);
        }
      }

      var csv = '\ufeff' + rows.map(function (row) {
        return row.join(',');
      }).join('\n');

      var ts = new Date().toISOString().slice(0, 10);
      downloadFile('xhs_notes_' + ts + '.csv', csv, 'text/csv;charset=utf-8');
    } catch (e) {
      alert('导出 CSV 失败: ' + e.message);
    }
  }

  /**
   * 导出完整 IndexedDB 数据库备份
   * 包含数据库元信息 + 全部记录，可用于数据迁移/归档
   */
  async function exportDatabase() {
    try {
      var results = await dbGetAllResults();
      if (!results || results.length === 0) {
        alert('数据库为空，无数据可导出');
        return;
      }
      var backup = {
        database: DB_NAME,
        version: DB_VERSION,
        store: STORE_NAME,
        exportedAt: new Date().toISOString(),
        recordCount: results.length,
        totalNotes: results.reduce(function (s, r) { return s + (r.notes || []).length; }, 0),
        totalDetails: results.reduce(function (s, r) { return s + (r.details || []).length; }, 0),
        records: results,
      };
      var json = JSON.stringify(backup, null, 2);
      var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      downloadFile('xhs_collector_db_' + ts + '.json', json, 'application/json');
    } catch (e) {
      alert('导出数据库失败: ' + e.message);
    }
  }

  function csvEscape(value) {
    if (value === null || value === undefined) return '';
    var str = String(value);
    if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  // ======================= 轮询进度 =======================

  var pollTimer = null;
  // 标记当前是否应该处于采集状态（用户点了开始，且未收到完成确认）
  // 用于 SW 重启容错：收到 collecting=false 但本标志为 true 时，重试确认
  var expectCollecting = false;
  var falseCount = 0; // 连续收到 collecting=false 的次数

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async function () {
      try {
        var resp = await sendMessage({ type: 'GET_STATUS' });
        if (!resp || !resp.ok || !resp.state) return;

        if (resp.state.collecting) {
          // 确实在采集，更新进度，重置计数
          falseCount = 0;
          updateProgress(resp.state.progress);
        } else {
          // 收到 collecting=false
          falseCount++;

          if (expectCollecting && falseCount < 3) {
            // 预期在采集但收到 false，可能是 SW 重启瞬间状态未同步
            // 重试确认，不立即停止轮询
            console.log('[sidebar] 收到 collecting=false，但预期采集中，重试确认 (' + falseCount + '/3)');
            return;
          }

          // 确认采集已结束（连续 3 次收到 false，或本来就不在采集）
          expectCollecting = false;
          falseCount = 0;
          if (resp.state.progress && resp.state.progress.phase === 'complete') {
            updateProgress(resp.state.progress);
          }
          stopPolling();
          updateButtonStates(false);
          loadResults();
        }
      } catch (e) {
        // 轮询错误不停止，继续重试
        console.log('[sidebar] 轮询错误: ' + e.message);
      }
    }, 500);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ======================= 按钮状态 =======================

  function updateButtonStates(collecting) {
    el.btnStart.disabled = collecting;
    el.btnStop.disabled = !collecting;
    el.keyword.disabled = collecting;
    el.pages.disabled = collecting;
    el.delayMin.disabled = collecting;
    el.delayMax.disabled = collecting;
    el.deepInteractionInterval.disabled = collecting;
  }

  // ======================= 事件绑定 =======================

  el.btnStart.addEventListener('click', async function () {
    var keyword = el.keyword.value.trim();
    if (!keyword) {
      el.keyword.focus();
      return;
    }

    var pages = parseInt(el.pages.value);
    var delayMin = (parseInt(el.delayMin.value) || 3) * 1000;
    var delayMax = (parseInt(el.delayMax.value) || 6) * 1000;
    var deepInteractionInterval = parseInt(el.deepInteractionInterval.value);
    if (isNaN(deepInteractionInterval) || deepInteractionInterval < 0) deepInteractionInterval = 10;

    if (delayMax < delayMin) delayMax = delayMin + 1000;

    expectCollecting = true;
    falseCount = 0;
    updateButtonStates(true);
    el.progressSection.style.display = 'block';
    el.progressPhase.textContent = '初始化...';
    el.progressBar.style.width = '0%';
    el.progressText.textContent = '';

    sendMessage({
      type: 'START_COLLECTION',
      keyword: keyword,
      pages: pages,
      feedDelayMin: delayMin,
      feedDelayMax: delayMax,
      deepInteractionInterval: deepInteractionInterval,
    }).then(function (resp) {
      if (resp && resp.ok && resp.started) {
        // 采集已启动，依赖轮询跟踪进度和完成状态
        // 不停止轮询，不重置 expectCollecting（轮询会在采集结束时处理）
      } else {
        // 启动失败
        expectCollecting = false;
        updateButtonStates(false);
        stopPolling();
        el.progressPhase.textContent = '错误: ' + (resp && resp.error ? resp.error : '启动失败');
      }
    }).catch(function (e) {
      expectCollecting = false;
      updateButtonStates(false);
      stopPolling();
      el.progressPhase.textContent = '错误: ' + e.message;
    });

    startPolling();
  });

  el.btnStop.addEventListener('click', async function () {
    try {
      await sendMessage({ type: 'STOP_COLLECTION' });
      expectCollecting = false;
      updateButtonStates(false);
      el.progressPhase.textContent = '已停止';
    } catch (e) { /* 忽略 */ }
  });

  el.btnOpenXhs.addEventListener('click', function () {
    sendMessage({ type: 'OPEN_XHS_TAB' }).then(function () {
      setTimeout(updateStatus, 2000);
    });
  });

  el.btnExportJson.addEventListener('click', exportJson);
  el.btnExportCsv.addEventListener('click', exportCsv);
  if (el.btnExportDb) el.btnExportDb.addEventListener('click', exportDatabase);

  el.btnClear.addEventListener('click', async function () {
    if (!confirm('确定要清空所有采集结果吗？这将同时停止后台采集任务。')) return;
    await sendMessage({ type: 'CLEAR_RESULTS' });
    expectCollecting = false;
    stopPolling();
    updateButtonStates(false);
    loadResults();
    el.progressSection.style.display = 'none';
  });

  el.keyword.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !el.btnStart.disabled) {
      el.btnStart.click();
    }
  });

  // ======================= visibilitychange 监听 =======================
  // 侧栏切回可见时，如果检测到采集中，自动恢复轮询
  // （侧栏隐藏时浏览器可能降低 setInterval 频率，切回时需主动确认状态）

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      // 切回可见时立即查询状态
      sendMessage({ type: 'GET_STATUS' }).then(function (resp) {
        if (resp && resp.ok && resp.state) {
          if (resp.state.collecting) {
            // 后台仍在采集，恢复轮询
            expectCollecting = true;
            updateButtonStates(true);
            updateProgress(resp.state.progress);
            startPolling();
          } else {
            // 未在采集，更新最终状态
            if (resp.state.progress && resp.state.progress.phase === 'complete') {
              updateProgress(resp.state.progress);
            }
            updateButtonStates(false);
          }
        }
      }).catch(function () {});
      // 同时更新状态指示灯
      updateStatus().catch(function () {});
    }
  });

  // ======================= 初始化 =======================

  async function init() {
    // 加载已保存的设置
    chrome.storage.local.get('xhs_settings', function (result) {
      if (result.xhs_settings) {
        var s = result.xhs_settings;
        if (s.keyword) el.keyword.value = s.keyword;
        if (s.pages) el.pages.value = s.pages;
        el.delayMin.value = s.delayMin || '3';
        el.delayMax.value = s.delayMax || '6';
        el.deepInteractionInterval.value = s.deepInteractionInterval || '10';
      }
    });

    function saveSettings() {
      chrome.storage.local.set({
        xhs_settings: {
          keyword: el.keyword.value,
          pages: el.pages.value,
          delayMin: el.delayMin.value,
          delayMax: el.delayMax.value,
          deepInteractionInterval: el.deepInteractionInterval.value,
        }
      });
    }
    el.keyword.addEventListener('change', saveSettings);
    el.pages.addEventListener('change', saveSettings);
    el.delayMin.addEventListener('change', saveSettings);
    el.delayMax.addEventListener('change', saveSettings);
    el.deepInteractionInterval.addEventListener('change', saveSettings);

    // 清空控制台日志
    el.btnClearLog.addEventListener('click', function () {
      el.consoleOutput.innerHTML = '';
      logLineCount = 0;
    });

    // 控制台欢迎日志
    appendLog('侧边栏已启动', 'success');

    // 先检查采集状态（GET_STATUS 快速响应，不依赖 content script）
    try {
      var resp = await sendMessage({ type: 'GET_STATUS' });
      if (resp && resp.ok && resp.state) {
        if (resp.state.collecting) {
          expectCollecting = true;
          updateButtonStates(true);
          startPolling();
        } else if (resp.state.progress) {
          updateProgress(resp.state.progress);
        }
      }
    } catch (e) { /* 忽略 */ }

    // 再更新状态指示灯（非阻塞）
    updateStatus().catch(function () {});

    // 加载已有结果
    loadResults();

    // 定期更新状态指示灯（带超时保护）
    setInterval(function () {
      updateStatus().catch(function () {});
    }, 5000);
  }

  init();
})();
