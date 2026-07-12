/**
 * injected.js — 在页面 MAIN world 中运行
 *
 * 职责：
 *   1. 桥接 content script 与 window.mnsv2（签名函数）
 *   2. 拦截页面自身的 fetch/XHR 请求，自动捕获 x-rap-param
 *   3. 检测 mnsv2 可用性并通知 content script
 *
 * 通信方式：CustomEvent（ISOLATED ↔ MAIN world 唯一桥梁）
 *   - 请求签名：content → injected: event 'xhs-mnsv2-request' { requestId, c, u, p }
 *   - 返回签名：injected → content: event 'xhs-mnsv2-response' { requestId, v, error }
 *   - 状态通知：injected → content: event 'xhs-mnsv2-ready' / 'xhs-rap-param-captured'
 */
(function () {
  'use strict';

  // 拦截器和事件监听只设置一次，但 mnsv2 状态检查每次注入都执行
  var alreadyInitialized = window.__xhs_injected;
  window.__xhs_injected = true;

  // ======================= mnsv2 签名桥接 =======================

  function notifyReady() {
    window.dispatchEvent(new CustomEvent('xhs-mnsv2-ready', {
      detail: { ready: true }
    }));
  }

  function checkMnsv2AndNotify() {
    if (typeof window.mnsv2 === 'function') {
      notifyReady();
      return true;
    }
    return false;
  }

  // 每次注入都检查 mnsv2（处理重复注入场景）
  if (!checkMnsv2AndNotify()) {
    // 轮询检测 mnsv2（页面异步加载 vendor-dynamic.js）
    var checkCount = 0;
    var maxChecks = 60; // 30 秒超时 (500ms * 60)
    var interval = setInterval(function () {
      checkCount++;
      if (checkMnsv2AndNotify()) {
        clearInterval(interval);
      } else if (checkCount >= maxChecks) {
        clearInterval(interval);
        window.dispatchEvent(new CustomEvent('xhs-mnsv2-ready', {
          detail: { ready: false, error: 'mnsv2 不可用（页面未加载签名脚本）' }
        }));
      }
    }, 500);
  }

  // ======================= 行为模拟函数 =======================

  /**
   * 贝塞尔曲线生成鼠标轨迹
   * @param {number} startX - 起点 X
   * @param {number} startY - 起点 Y
   * @param {number} endX - 终点 X
   * @param {number} endY - 终点 Y
   * @param {number} steps - 轨迹点数量
   * @returns {Array} 轨迹点数组
   */
  function generateBezierPath(startX, startY, endX, endY, steps) {
    var path = [];
    // 控制点随机偏移，模拟人类不完美的轨迹
    var cx1 = startX + (endX - startX) * 0.25 + Math.random() * 50 - 25;
    var cy1 = startY + (endY - startY) * 0.25 + Math.random() * 50 - 25;
    var cx2 = startX + (endX - startX) * 0.75 + Math.random() * 50 - 25;
    var cy2 = startY + (endY - startY) * 0.75 + Math.random() * 50 - 25;

    for (var t = 0; t <= 1; t += 1/steps) {
      var x = Math.pow(1-t, 3) * startX +
              3 * Math.pow(1-t, 2) * t * cx1 +
              3 * (1-t) * Math.pow(t, 2) * cx2 +
              Math.pow(t, 3) * endX;
      var y = Math.pow(1-t, 3) * startY +
              3 * Math.pow(1-t, 2) * t * cy1 +
              3 * (1-t) * Math.pow(t, 2) * cy2 +
              Math.pow(t, 3) * endY;
      path.push({ x: Math.round(x), y: Math.round(y) });
    }
    return path;
  }

  /**
   * 模拟鼠标移动（贝塞尔曲线轨迹）
   * @param {number} fromX - 起点 X
   * @param {number} fromY - 起点 Y
   * @param {number} toX - 终点 X
   * @param {number} toY - 终点 Y
   * @param {Function} callback - 完成回调
   */
  function simulateMouseMove(fromX, fromY, toX, toY, callback) {
    var path = generateBezierPath(fromX, fromY, toX, toY, 20);
    var currentIndex = 0;

    function moveNext() {
      if (currentIndex >= path.length) {
        if (callback) callback();
        return;
      }

      var point = path[currentIndex];
      var event = new MouseEvent('mousemove', {
        bubbles: true,
        clientX: point.x,
        clientY: point.y,
        screenX: point.x,
        screenY: point.y + window.screenTop,
        view: window
      });
      document.dispatchEvent(event);

      currentIndex++;
      // 每个点间隔 50ms，加随机抖动
      setTimeout(moveNext, 50 + Math.random() * 30);
    }

    moveNext();
  }

  /**
   * 模拟阅读行为（随机停留 3-8秒，期间随机移动鼠标）
   * @param {Function} callback - 完成回调
   */
  function simulateReading(callback) {
    var viewportWidth = window.innerWidth;
    var viewportHeight = window.innerHeight;

    // 随机移动鼠标到页面某处
    var fromX = Math.random() * viewportWidth;
    var fromY = Math.random() * viewportHeight * 0.3;
    var toX = Math.random() * viewportWidth;
    var toY = Math.random() * viewportHeight * 0.7;

    simulateMouseMove(fromX, fromY, toX, toY, function() {
      // 随机阅读时长 3-8秒
      var duration = 3000 + Math.random() * 5000;
      setTimeout(function() {
        if (callback) callback();
      }, duration);
    });
  }

  /**
   * 模拟平滑滚动
   * @param {number} targetY - 目标滚动位置
   * @param {Function} callback - 完成回调
   */
  function simulateScroll(targetY, callback) {
    var startY = window.scrollY;
    var distance = targetY - startY;
    var steps = Math.max(1, Math.abs(distance) / 100); // 每次滚动 100px
    var currentStep = 0;

    var interval = setInterval(function() {
      currentStep++;
      var progress = currentStep / steps;
      var currentY = startY + distance * progress;
      window.scrollTo(0, currentY);

      // 触发 scroll 事件
      var event = new Event('scroll', { bubbles: true });
      window.dispatchEvent(event);

      if (currentStep >= steps) {
        clearInterval(interval);
        if (callback) callback();
      }
    }, 100 + Math.random() * 50); // 滚动间隔随机化
  }

  /**
   * 模拟浏览行为（滚动到页面中部或底部）
   * @param {Function} callback - 完成回调
   */
  function simulateBrowsing(callback) {
    // 随机决定滚动位置
    var scrollTarget = Math.random() > 0.5 ?
      window.innerHeight * 0.5 :  // 滚动到中部
      document.body.scrollHeight * 0.3;  // 滚动到底部（适度）

    simulateScroll(scrollTarget, function() {
      // 滚动后停留 2-4秒
      var pause = 2000 + Math.random() * 2000;
      setTimeout(function() {
        if (callback) callback();
      }, pause);
    });
  }

  // 事件监听只注册一次
  if (!alreadyInitialized) {
    // 监听签名请求
    window.addEventListener('xhs-mnsv2-request', function (e) {
      var detail = e.detail || {};
      var requestId = detail.requestId;
      var c = detail.c;
      var u = detail.u;
      var p = detail.p;

      try {
        if (typeof window.mnsv2 !== 'function') {
          throw new Error('window.mnsv2 不可用');
        }
        var v = window.mnsv2(c, u, p);
        if (!v) throw new Error('mnsv2 返回空值');

        window.dispatchEvent(new CustomEvent('xhs-mnsv2-response', {
          detail: { requestId: requestId, v: v, error: null }
        }));
      } catch (err) {
        window.dispatchEvent(new CustomEvent('xhs-mnsv2-response', {
          detail: { requestId: requestId, v: null, error: err.message }
        }));
      }
    });

    // ======================= x-rap-param 自动捕获 =======================

    // 拦截 fetch
    var originalFetch = window.fetch;
    window.fetch = function () {
      var args = arguments;
      try {
        var url = args[0];
        var options = args[1] || {};
        var headers = options.headers;
        if (headers) {
          var rapParam = null;
          if (typeof headers.get === 'function') {
            rapParam = headers.get('x-rap-param') || headers.get('X-rap-param');
          } else if (typeof headers === 'object') {
            rapParam = headers['x-rap-param'] || headers['X-rap-param'] || headers['x-Rap-Param'];
          }
          if (rapParam) {
            captureRapParam(rapParam, typeof url === 'string' ? url : (url && url.url) || '');
          }
        }
      } catch (e) { /* 忽略拦截错误 */ }
      return originalFetch.apply(this, args);
    };

    // 拦截 XMLHttpRequest
    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__xhs_url = url;
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try {
        if (name && name.toLowerCase() === 'x-rap-param' && value) {
          captureRapParam(value, this.__xhs_url || '');
        }
      } catch (e) { /* 忽略 */ }
      return originalSetRequestHeader.apply(this, arguments);
    };

    function captureRapParam(rapParam, url) {
      var type = 'unknown';
      if (url.indexOf('search/notes') !== -1 || url.indexOf('so.xiaohongshu.com') !== -1) {
        type = 'search';
      } else if (url.indexOf('/feed') !== -1 || url.indexOf('edith.xiaohongshu.com') !== -1) {
        type = 'feed';
      }

      window.dispatchEvent(new CustomEvent('xhs-rap-param-captured', {
        detail: { rapParam: rapParam, type: type, url: url }
      }));
    }

    // ======================= 行为模拟指令监听 =======================

    window.addEventListener('xhs-simulate-behavior', function (e) {
      var detail = e.detail || {};
      var action = detail.action;

      if (action === 'reading') {
        simulateReading(function () {
          window.dispatchEvent(new CustomEvent('xhs-behavior-done', {
            detail: { action: 'reading', success: true }
          }));
        });
      } else if (action === 'browsing') {
        simulateBrowsing(function () {
          window.dispatchEvent(new CustomEvent('xhs-behavior-done', {
            detail: { action: 'browsing', success: true }
          }));
        });
      } else if (action === 'mousemove') {
        var fromX = detail.fromX || 0;
        var fromY = detail.fromY || 0;
        var toX = detail.toX || window.innerWidth;
        var toY = detail.toY || window.innerHeight;
        simulateMouseMove(fromX, fromY, toX, toY, function () {
          window.dispatchEvent(new CustomEvent('xhs-behavior-done', {
            detail: { action: 'mousemove', success: true }
          }));
        });
      }
    });
  }

})();
