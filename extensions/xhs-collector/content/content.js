/**
 * content.js — 内容脚本（ISOLATED world），采集流程的核心编排器
 *
 * 架构：
 *   popup → background → content.js → injected.js (MAIN world)
 *                                  → fetch API (同源请求，cookie 自动携带)
 *
 * 核心流程：
 *   1. 注入 injected.js 到页面 MAIN world（获取 window.mnsv2）
 *   2. 接收 background 的采集指令
 *   3. 按关键词搜索笔记列表（v2 search API）
 *   4. 逐条采集笔记详情（feed API）
 *   5. 实时上报进度，完成后返回完整数据
 *
 * 依赖：lib/md5.js（window.XHS_MD5）、lib/sign.js（window.XHS_SIGN）
 */
(function () {
  'use strict';

  // ======================= 状态管理 =======================

  var collecting = false;          // 是否正在采集
  var lastCollectResult = null;    // 最后一次采集结果缓存（供 GET_RESULT 查询）
  var mnsv2Ready = false;          // window.mnsv2 是否就绪
  var rapParams = {                // 自动捕获的 x-rap-param
    search: '',
    feed: '',
  };
  var sigCount = {                 // 签名计数（防风控，循环增长）
    search: Math.floor(Math.random() * 3) + 1,
    feed: Math.floor(Math.random() * 5) + 1,
  };

  // ======================= 注入 MAIN world 脚本 =======================

  function injectMainWorldScript() {
    return new Promise(function (resolve, reject) {
      // injected.js 只负责 fetch/XHR 拦截（捕获 x-rap-param）
      // mnsv2 调用通过 background 的 CALL_MNSV2 直接 executeScript，不依赖 injected.js
      // 所以这里只需注入脚本即可，不需要等待 ready 事件

      // 监听 ready 事件（仅用于更新状态显示，不阻塞流程）
      var onReady = function (e) {
        window.removeEventListener('xhs-mnsv2-ready', onReady);
        mnsv2Ready = e.detail.ready === true;
      };
      window.addEventListener('xhs-mnsv2-ready', onReady);

      chrome.runtime.sendMessage({ type: 'INJECT_MAIN_WORLD' }, function (response) {
        if (chrome.runtime.lastError || !response || !response.ok) {
          window.removeEventListener('xhs-mnsv2-ready', onReady);
          // 注入失败不阻塞，因为 mnsv2 可以通过 CALL_MNSV2 直接调用
          // injected.js 主要负责 x-rap-param 捕获
          console.warn('[xhs] injected.js 注入失败，x-rap-param 捕获将不可用');
          resolve(); // 仍然 resolve，不阻塞采集流程
          return;
        }
        // 给 injected.js 500ms 检测 mnsv2 并发 ready 事件
        setTimeout(function () {
          window.removeEventListener('xhs-mnsv2-ready', onReady);
          resolve();
        }, 500);
      });
    });
  }

  // ======================= 监听 x-rap-param 捕获 =======================

  window.addEventListener('xhs-rap-param-captured', function (e) {
    var detail = e.detail || {};
    if (detail.rapParam) {
      if (detail.type === 'search') {
        rapParams.search = detail.rapParam;
      } else if (detail.type === 'feed') {
        rapParams.feed = detail.rapParam;
      } else {
        // 未知类型，两个都存
        if (!rapParams.search) rapParams.search = detail.rapParam;
        if (!rapParams.feed) rapParams.feed = detail.rapParam;
      }
    }
  });

  // ======================= mnsv2 调用桥接 =======================

  function callMnsv2(c, u, p) {
    console.log('[xhs] callMnsv2 开始, c.length=' + c.length);
    return new Promise(function (resolve, reject) {
      var settled = false;

      // 超时保护（15秒）
      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          reject(new Error('mnsv2 调用超时(15s)'));
        }
      }, 15000);

      chrome.runtime.sendMessage(
        { type: 'CALL_MNSV2', c: c, u: u, p: p },
        function (response) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          console.log('[xhs] callMnsv2 响应:', response);

          if (chrome.runtime.lastError || !response || !response.ok) {
            reject(new Error(
              (response && response.error) ||
              (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
              'mnsv2 调用失败'
            ));
          } else {
            resolve(response.v);
          }
        }
      );
    });
  }

  // ======================= 签名生成 =======================

  /**
   * 生成完整签名头（x-s + x-t + x-s-common）
   * @param {string} apiPath - API 路径
   * @param {object|string} body - 请求体
   * @param {string} type - 'search' 或 'feed'
   * @returns {Promise<{xs: string, xt: string, xsc: string}>}
   */
  async function generateSignatures(apiPath, body, type) {
    var signInput = window.XHS_SIGN.buildSignInput(apiPath, body);

    // 调用页面 mnsv2 生成 XYS_ 签名核心
    var v = await callMnsv2(signInput.c, signInput.u, signInput.p);
    var signResult = signInput.buildPayload(v);

    // 生成 x-s-common
    var a1 = window.XHS_SIGN.getCookie('a1');
    sigCount[type] = (sigCount[type] || 1) + 1;
    if (sigCount[type] > 20 + Math.floor(Math.random() * 10)) {
      sigCount[type] = Math.floor(Math.random() * 3) + 1;
    }
    var xsc = window.XHS_SIGN.generateXsCommon({
      cookieA1: a1,
      version: '4.3.7',
      sigCount: sigCount[type],
    });

    return {
      xs: signResult['X-s'],
      xt: signResult['X-t'],
      xsc: xsc,
    };
  }

  // ======================= 工具函数 =======================

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /**
   * 基于正态分布生成随机延迟（Box-Muller 变换）
   * 均值为 (min+max)/2，标准差为 1-2 秒
   * 结果被 clamp 到 [min, max] 范围内，避免极端值
   * @param {number} min - 最小值（ms）
   * @param {number} max - 最大值（ms）
   * @returns {number} 正态分布随机延迟
   */
  function randomDelay(min, max) {
    var mean = (min + max) / 2;
    var stdDev = 1000 + Math.random() * 1000; // 1-2 秒标准差
    // Box-Muller 变换生成标准正态分布
    var u1 = Math.random();
    var u2 = Math.random();
    var z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    var value = mean + z * stdDev;
    // clamp 到 [min, max]
    return Math.floor(Math.max(min, Math.min(max, value)));
  }
  function randomHex(len) {
    var bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }
  function randomId(len) {
    len = len || 21;
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var result = '';
    var arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    for (var i = 0; i < len; i++) {
      result += chars[arr[i] % chars.length];
    }
    return result;
  }
  function genSessionId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function sendProgress(data) {
    chrome.runtime.sendMessage(Object.assign({ type: 'PROGRESS' }, data)).catch(function () {});
  }

  /**
   * 上报日志到 background（转发到 sidebar 控制台）
   * @param {string} msg - 日志消息
   * @param {string} level - 日志级别：info/success/warn/error
   */
  function bgLog(msg, level) {
    console.log('[xhs] ' + msg);
    try {
      chrome.runtime.sendMessage({
        type: 'CONTENT_LOG',
        message: msg,
        level: level || 'info',
        timestamp: Date.now(),
      }).catch(function () {});
    } catch (e) {}
  }

  // ======================= 人类行为模拟 =======================

  /**
   * 鼠标大幅动作库：多种随机大幅度快速移动，规避自动化检测
   * 用户关键发现：大幅度鼠标移动可避过检测
   * 每次调用随机选择一种动作，避免模式固定
   */

  // 限制坐标在屏幕内
  function clampToScreen(x, y) {
    return {
      x: Math.max(0, Math.min(window.innerWidth - 1, x)),
      y: Math.max(0, Math.min(window.innerHeight - 1, y)),
    };
  }

  // 分发单个 mousemove 事件
  function dispatchMouseMove(x, y) {
    try {
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, view: window, clientX: Math.round(x), clientY: Math.round(y)
      }));
    } catch (e) {}
  }

  // 动作1：椭圆轨迹（1-2圈）
  async function moveEllipse() {
    var cx = Math.floor(window.innerWidth / 2);
    var cy = Math.floor(window.innerHeight / 2);
    var rx = Math.floor(window.innerWidth * (0.3 + Math.random() * 0.15));
    var ry = Math.floor(window.innerHeight * (0.3 + Math.random() * 0.15));
    var startAngle = Math.random() * Math.PI * 2;
    var loops = 1 + Math.floor(Math.random() * 2);
    var pointsPerLoop = 20 + Math.floor(Math.random() * 10);
    var totalPoints = loops * pointsPerLoop;

    for (var i = 0; i <= totalPoints; i++) {
      var angle = startAngle + (i / pointsPerLoop) * Math.PI * 2;
      var p = clampToScreen(
        cx + rx * Math.cos(angle) + (Math.random() * 10 - 5),
        cy + ry * Math.sin(angle) + (Math.random() * 10 - 5)
      );
      dispatchMouseMove(p.x, p.y);
      await sleep(5 + Math.random() * 10);
    }
  }

  // 动作2：Z字形（从左上到右下，2-3段）
  async function moveZigZag() {
    var segments = 2 + Math.floor(Math.random() * 2); // 2-3段
    var pointsPerSeg = 15 + Math.floor(Math.random() * 8);
    var startX = Math.floor(window.innerWidth * 0.1);
    var startY = Math.floor(window.innerHeight * 0.15);

    for (var s = 0; s < segments; s++) {
      var endX = (s % 2 === 0)
        ? Math.floor(window.innerWidth * 0.9)
        : Math.floor(window.innerWidth * 0.1);
      var endY = Math.floor(window.innerHeight * (0.15 + (s + 1) * 0.7 / segments));
      for (var i = 0; i <= pointsPerSeg; i++) {
        var t = i / pointsPerSeg;
        var p = clampToScreen(
          startX + (endX - startX) * t + (Math.random() * 8 - 4),
          startY + (endY - startY) * t + (Math.random() * 8 - 4)
        );
        dispatchMouseMove(p.x, p.y);
        await sleep(5 + Math.random() * 8);
      }
      startX = endX;
      startY = endY;
    }
  }

  // 动作3：之字形垂直扫描（上下往返）
  async function moveVerticalSweep() {
    var loops = 1 + Math.floor(Math.random() * 2);
    var pointsPerLoop = 25 + Math.floor(Math.random() * 10);
    var x = Math.floor(window.innerWidth * (0.3 + Math.random() * 0.4));

    for (var l = 0; l < loops; l++) {
      var topY = Math.floor(window.innerHeight * 0.1);
      var bottomY = Math.floor(window.innerHeight * 0.9);
      var goingDown = (l % 2 === 0);
      var startY = goingDown ? topY : bottomY;
      var endY = goingDown ? bottomY : topY;
      // 每趟 X 略微偏移
      x = Math.floor(window.innerWidth * (0.2 + Math.random() * 0.6));

      for (var i = 0; i <= pointsPerLoop; i++) {
        var t = i / pointsPerLoop;
        var y = startY + (endY - startY) * t;
        // 水平方向小幅正弦摆动
        var xOffset = Math.sin(t * Math.PI * 4) * 30 + (Math.random() * 6 - 3);
        var p = clampToScreen(x + xOffset, y + (Math.random() * 6 - 3));
        dispatchMouseMove(p.x, p.y);
        await sleep(5 + Math.random() * 8);
      }
    }
  }

  // 动作4：随机大幅跳动（5-8个大跳跃，模拟用户视线快速切换）
  async function moveRandomJumps() {
    var jumps = 5 + Math.floor(Math.random() * 4);
    var lastX = Math.floor(window.innerWidth / 2);
    var lastY = Math.floor(window.innerHeight / 2);

    for (var j = 0; j < jumps; j++) {
      // 目标位置在屏幕 10%-90% 范围内
      var tx = Math.floor(window.innerWidth * (0.1 + Math.random() * 0.8));
      var ty = Math.floor(window.innerHeight * (0.1 + Math.random() * 0.8));
      // 在两点间快速插值（10-15步）
      var steps = 10 + Math.floor(Math.random() * 6);
      for (var i = 0; i <= steps; i++) {
        var t = i / steps;
        var eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        var p = clampToScreen(
          lastX + (tx - lastX) * eased + (Math.random() * 6 - 3),
          lastY + (ty - lastY) * eased + (Math.random() * 6 - 3)
        );
        dispatchMouseMove(p.x, p.y);
        await sleep(4 + Math.random() * 6);
      }
      lastX = tx;
      lastY = ty;
      // 到达后短暂停留
      await sleep(50 + Math.random() * 100);
    }
  }

  // 动作5：螺旋（从中心向外或从外向中心）
  async function moveSpiral() {
    var cx = Math.floor(window.innerWidth / 2);
    var cy = Math.floor(window.innerHeight / 2);
    var maxR = Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.4);
    var outward = Math.random() < 0.5;
    var points = 35 + Math.floor(Math.random() * 15);
    var startR = outward ? 10 : maxR;
    var endR = outward ? maxR : 10;

    for (var i = 0; i <= points; i++) {
      var t = i / points;
      var r = startR + (endR - startR) * t;
      var angle = t * Math.PI * 4; // 2圈
      var p = clampToScreen(
        cx + r * Math.cos(angle) + (Math.random() * 6 - 3),
        cy + r * Math.sin(angle) + (Math.random() * 6 - 3)
      );
      dispatchMouseMove(p.x, p.y);
      await sleep(5 + Math.random() * 8);
    }
  }

  /**
   * 随机选择一种大幅度鼠标动作执行
   * @returns {Promise<void>}
   */
  async function bigMouseMove() {
    var actionNames = ['ellipse', 'zigzag', 'vertical_sweep', 'random_jumps', 'spiral'];
    var actions = [moveEllipse, moveZigZag, moveVerticalSweep, moveRandomJumps, moveSpiral];
    var idx = Math.floor(Math.random() * actions.length);
    console.log('[xhs] 大幅鼠标动作: ' + actionNames[idx]);
    await actions[idx]();
    console.log('[xhs] 大幅鼠标动作完成: ' + actionNames[idx]);
  }

  /**
   * 批量分发鼠标轨迹点（XHS 页面会阻塞 setTimeout，导致 await sleep 循环膨胀）
   * 将所有 mousemove 事件分批同步分发，每批只做一次 await sleep，大幅减少 sleep 调用次数
   * @param {Array<{x:number,y:number}>} points - 轨迹点数组
   * @param {number} [batchSize=4] - 每批点数
   * @returns {Promise<void>}
   */
  async function dispatchMousePathBatch(points, batchSize) {
    batchSize = batchSize || 4;
    for (var i = 0; i < points.length; i += batchSize) {
      var end = Math.min(i + batchSize, points.length);
      for (var j = i; j < end; j++) {
        dispatchMouseMove(points[j].x, points[j].y);
      }
      // 每批只做一次 await sleep（而非每个点都 sleep）
      if (i + batchSize < points.length) {
        await sleep(10 + Math.random() * 15);
      }
    }
  }

  /**
   * 模拟鼠标从随机起点平滑移动到目标元素位置
   * 使用加速度变化轨迹（先快后慢/先慢后快），模拟人类手指滑动的物理特性
   * 使用批量分发避免 XHS 页面 setTimeout 阻塞
   * @param {Element} el - 目标元素
   * @param {number} steps - 移动步数（默认 8-15 步）
   * @returns {Promise<void>}
   */
  async function moveMouseToElement(el, steps) {
    var rect = el.getBoundingClientRect();
    var targetX = Math.round(rect.left + rect.width / 2);
    var targetY = Math.round(rect.top + rect.height / 2);

    // 随机起点（屏幕范围内，离目标有一定距离）
    var startX = Math.max(0, targetX - 150 - Math.floor(Math.random() * 200));
    var startY = Math.max(0, targetY - 100 - Math.floor(Math.random() * 150));

    steps = steps || (8 + Math.floor(Math.random() * 8));

    // 随机选择加速度模式：0=先快后慢(decelerate), 1=先慢后快(accelerate), 2=慢-快-慢(自然)
    var accelMode = Math.floor(Math.random() * 3);

    // 先计算所有轨迹点
    var points = [];
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var eased;
      if (accelMode === 0) {
        eased = 1 - Math.pow(1 - t, 3);
      } else if (accelMode === 1) {
        eased = Math.pow(t, 3);
      } else {
        eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      }
      points.push({
        x: Math.round(startX + (targetX - startX) * eased + (Math.random() * 8 - 4)),
        y: Math.round(startY + (targetY - startY) * eased + (Math.random() * 8 - 4))
      });
    }

    // 批量分发（2-4 次 await sleep，而非 8-15 次）
    await dispatchMousePathBatch(points, 4);
  }

  /**
   * 模拟人类点击元素：鼠标移动靠近 → mouseenter → mousedown → mouseup → click
   * @param {Element} el - 要点击的元素
   * @returns {Promise<void>}
   */
  async function humanClick(el) {
    // 只在元素不可见时滚动（避免 scrollIntoView 改变页面位置导致采集顺序乱）
    var rect1 = el.getBoundingClientRect();
    if (rect1.bottom < 0 || rect1.top > window.innerHeight || rect1.right < 0 || rect1.left > window.innerWidth) {
      try { el.scrollIntoView({ behavior: 'instant', block: 'nearest' }); } catch (e) { el.scrollIntoView(); }
      await sleep(300 + Math.random() * 200);
    } else {
      await sleep(200 + Math.random() * 200);
    }

    // 鼠标移动到元素位置
    await moveMouseToElement(el);

    // 获取最终位置
    var rect2 = el.getBoundingClientRect();
    var cx = Math.round(rect2.left + rect2.width / 2);
    var cy = Math.round(rect2.top + rect2.height / 2);
    var mouseOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };

    // 移入事件
    try {
      el.dispatchEvent(new MouseEvent('mouseenter', mouseOpts));
      el.dispatchEvent(new MouseEvent('mouseover', mouseOpts));
    } catch (e) {}
    await sleep(100 + Math.random() * 100);

    // 按下 → 松开 → 点击
    try {
      el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
    } catch (e) {}
    await sleep(50 + Math.random() * 50); // 按住 50-100ms
    try {
      el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
    } catch (e) {}
    await sleep(20 + Math.random() * 30);
    // 某些元素（如 SVG）没有 click() 方法，用 dispatchEvent 兜底
    if (typeof el.click === 'function') {
      el.click();
    } else {
      try {
        el.dispatchEvent(new MouseEvent('click', mouseOpts));
      } catch (e) {}
    }
  }

  /**
   * 模拟人类右键点击元素：滚动到可视区域 → 悬停（手部微抖） → mousedown(button=2) → contextmenu → mouseup
   * 用于模拟"右键 → 新窗口打开"的人类操作轨迹
   * @param {Element} el - 要右键点击的元素
   * @returns {Promise<void>}
   */
  async function humanRightClick(el) {
    // 滚动到可视区域（使用 center 确保元素在页面中间，便于操作）
    var rect1 = el.getBoundingClientRect();
    if (rect1.bottom < 0 || rect1.top > window.innerHeight || rect1.right < 0 || rect1.left > window.innerWidth) {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { el.scrollIntoView(); }
      await sleep(500 + Math.random() * 300);
    } else {
      await sleep(200 + Math.random() * 200);
    }

    // 悬停阶段：鼠标移动到元素 + 微抖（模拟用户在元素上停留考虑）
    await naturalHover(el, 400 + Math.random() * 800);

    // 获取最终位置
    var rect2 = el.getBoundingClientRect();
    var cx = Math.round(rect2.left + rect2.width / 2);
    var cy = Math.round(rect2.top + rect2.height / 2);
    var mouseOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 2 };

    // 右键按下 → contextmenu → 右键松开
    try {
      el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
    } catch (e) {}
    await sleep(50 + Math.random() * 80);
    try {
      el.dispatchEvent(new MouseEvent('contextmenu', mouseOpts));
    } catch (e) {}
    await sleep(30 + Math.random() * 50);
    try {
      el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
    } catch (e) {}
  }

  /**
   * 自然悬停：鼠标移动到元素后，在元素附近做微小移动（模拟手部抖动 + 阅读考虑）
   * 人类在点击前会悬停在按钮上一段时间，鼠标会有微小偏移
   * @param {Element} el - 目标元素
   * @param {number} [duration] - 悬停时长(ms)，默认 600-2000ms 随机
   * @returns {Promise<void>}
   */
  async function naturalHover(el, duration) {
    await moveMouseToElement(el);
    var rect = el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var hoverTime = duration || (600 + Math.random() * 1400);

    // 悬停期间的微移动作（手部自然抖动）
    try {
      el.dispatchEvent(new MouseEvent('mouseenter', {
        bubbles: true, cancelable: true, view: window,
        clientX: Math.round(cx), clientY: Math.round(cy)
      }));
    } catch (e) {}

    // 预计算微抖点（10-20 个，3-8px 随机偏移）
    var pointCount = 10 + Math.floor(Math.random() * 10);
    var points = [];
    for (var i = 0; i < pointCount; i++) {
      points.push({
        x: Math.round(cx + (Math.random() * 8 - 4)),
        y: Math.round(cy + (Math.random() * 8 - 4))
      });
    }
    // 批量分发微抖（2-4 次 await sleep，而非 10-20 次）
    await dispatchMousePathBatch(points, 5);

    // 用少量 sleep 填充剩余悬停时间（保持微抖活跃）
    // XHS 会阻塞 setTimeout，所以用 2-3 次调用近似 hoverTime
    var padCount = 2 + Math.floor(Math.random() * 2);
    var padDelay = Math.floor(hoverTime / padCount);
    for (var p = 0; p < padCount; p++) {
      dispatchMouseMove(
        Math.round(cx + (Math.random() * 8 - 4)),
        Math.round(cy + (Math.random() * 8 - 4))
      );
      await sleep(padDelay);
    }
  }

  /**
   * 鼠标移动到页面随机可见区域（模拟用户浏览不同内容区域）
   * 用于动作间的过渡，避免鼠标总是从 A 元素直接跳到 B 元素
   * 使用批量分发避免 XHS 页面 setTimeout 阻塞
   * @returns {Promise<void>}
   */
  async function moveMouseToRandomArea() {
    // 选择页面上的随机位置（避开边缘）
    var tx = Math.floor(window.innerWidth * (0.15 + Math.random() * 0.7));
    var ty = Math.floor(window.innerHeight * (0.15 + Math.random() * 0.7));
    // 从当前位置平滑移动到目标位置
    var startX = window.innerWidth * (0.2 + Math.random() * 0.6);
    var startY = window.innerHeight * (0.2 + Math.random() * 0.6);
    var steps = 6 + Math.floor(Math.random() * 6);

    // 先计算所有轨迹点
    var points = [];
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      points.push({
        x: Math.round(startX + (tx - startX) * eased + (Math.random() * 6 - 3)),
        y: Math.round(startY + (ty - startY) * eased + (Math.random() * 6 - 3))
      });
    }

    // 批量分发（2-3 次 await sleep，而非 6-12 次）
    await dispatchMousePathBatch(points, 4);
    // 到达后短暂停留
    await sleep(200 + Math.random() * 400);
  }

  /**
   * 模拟人类在输入框输入文字：鼠标移动到输入框 → focus → 逐字输入
   * @param {Element} input - 输入框元素
   * @param {string} text - 要输入的文字
   * @returns {Promise<void>}
   */
  async function humanType(input, text) {
    // 鼠标移动到输入框
    await moveMouseToElement(input);
    await sleep(200 + Math.random() * 200);

    // 点击聚焦
    var rect = input.getBoundingClientRect();
    var cx = Math.round(rect.left + rect.width / 2);
    var cy = Math.round(rect.top + rect.height / 2);
    var mouseOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    try {
      input.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
      input.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
    } catch (e) {}
    input.focus();
    input.click();
    await sleep(300 + Math.random() * 200);

    // 清空已有内容
    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
                       Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(input, '');
    } else {
      input.value = '';
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // 逐字输入
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      // 使用 keydown → input → keyup 模拟按键
      try {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code: ch, keyCode: ch.charCodeAt(0), bubbles: true }));
      } catch (e) {}

      // 追加字符
      if (nativeSetter) {
        nativeSetter.call(input, input.value + ch);
      } else {
        input.value += ch;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));

      try {
        input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, code: ch, keyCode: ch.charCodeAt(0), bubbles: true }));
      } catch (e) {}

      await sleep(80 + Math.random() * 120); // 80-200ms 每字
    }

    // 触发 change
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * 模拟平滑滚动到指定位置
   * 使用原生 behavior: 'smooth' 一次性滚动，避免 await sleep 循环被页面机制阻塞
   * @param {number} targetY - 目标 Y 位置
   * @returns {Promise<void>}
   */
  async function smoothScrollTo(targetY) {
    var currentY = window.scrollY;
    if (Math.abs(targetY - currentY) < 10) return;
    // 原生平滑滚动（浏览器自带缓动，更接近人类行为且可靠）
    window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
    // 等待原生滚动动画完成
    await sleep(400 + Math.random() * 300);
  }

  /**
   * 模拟向下滚动加载更多内容
   * 使用 window.scrollBy 原生平滑滚动，参考 xhs-api-search.js 实现
   * @param {number} times - 滚动次数
   * @returns {Promise<void>}
   */
  async function scrollDownToLoad(times) {
    for (var i = 0; i < times; i++) {
      var pageHeight = window.innerHeight;
      var scrollAmount = pageHeight * (0.8 + Math.random() * 0.4);
      // 原生平滑滚动，一次性 scrollBy（与已验证的 xhs-api-search.js 一致）
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      await sleep(1200 + Math.random() * 800); // 等待加载
    }
  }

  /**
   * 查找笔记链接
   * @returns {NodeList}
   */
  function findNoteLinks() {
    var selectors = [
      'a.cover.mask.ld',
      'section.note-item a.cover',
      'a[href*="/search_result/"]',
      'a[href*="/explore/"]',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var links = document.querySelectorAll(selectors[i]);
      if (links.length > 0) return links;
    }
    return [];
  }

  /**
   * 根据 noteId 在页面上查找对应的笔记链接元素
   * 搜索结果页的笔记链接 URL 格式：/explore/{noteId}?xsec_token=... 或 /search_result/{noteId}?...
   * @param {string} noteId - 笔记 ID
   * @returns {Element|null} 链接元素，未找到返回 null
   */
  function findNoteLinkById(noteId) {
    if (!noteId) return null;
    var selectors = [
      'a[href*="/explore/' + noteId + '"]',
      'a[href*="/search_result/' + noteId + '"]',
      'a[href*="' + noteId + '"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var links = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < links.length; j++) {
        var rect = links[j].getBoundingClientRect();
        // 只返回有尺寸的元素（可能在 DOM 中但被隐藏）
        if (rect.width > 0 && rect.height > 0) return links[j];
      }
    }
    return null;
  }

  /**
   * 查找页面上任意可见的笔记链接（用于右键鼠标模拟的回退）
   * 当目标笔记已被虚拟列表卸载时，右键任意可见笔记链接做鼠标动作模拟，
   * 实际打开的 URL 仍由 background 用目标笔记的 noteId 构建
   * @returns {Element|null}
   */
  function findAnyVisibleNoteLink() {
    var selectors = [
      'a.cover.mask.ld',
      'section.note-item a.cover',
      'a[href*="/explore/"]',
      'a[href*="/search_result/"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var links = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < links.length; j++) {
        var rect = links[j].getBoundingClientRect();
        // 必须可见且在视口内（顶部留 100px 余量，底部留 50px）
        if (rect.width > 0 && rect.height > 0 && rect.top > 80 && rect.top < window.innerHeight - 50) {
          return links[j];
        }
      }
    }
    return null;
  }

  /**
   * 滚动页面查找指定 noteId 的笔记链接
   * SPA 虚拟列表可能已卸载目标笔记，需要滚动让其重新渲染
   * @param {string} noteId - 笔记 ID
   * @param {number} [maxScrolls=8] - 最大滚动次数
   * @returns {Promise<Element|null>} 找到的链接元素，未找到返回 null
   */
  async function scrollToFindNote(noteId, maxScrolls) {
    maxScrolls = maxScrolls || 8;
    // 先在当前位置找
    var link = findNoteLinkById(noteId);
    if (link) return link;

    // 向下滚动查找
    var scrollStep = window.innerHeight * 0.6;
    for (var i = 0; i < maxScrolls; i++) {
      window.scrollBy({ top: scrollStep, behavior: 'smooth' });
      await sleep(600 + Math.random() * 400);
      link = findNoteLinkById(noteId);
      if (link) return link;
      // 到达底部
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 50) break;
    }

    // 回到顶部，再从上往下找（覆盖之前可能跳过的部分）
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(800 + Math.random() * 400);
    for (var i = 0; i < maxScrolls; i++) {
      link = findNoteLinkById(noteId);
      if (link) return link;
      window.scrollBy({ top: scrollStep, behavior: 'smooth' });
      await sleep(600 + Math.random() * 400);
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 50) break;
    }

    return null;
  }

  /**
   * 关闭笔记详情层
   * @returns {Promise<boolean>} 是否成功关闭
   */
  async function closeNoteDetail() {
    await sleep(1500 + Math.random() * 1000); // 等待详情层完全打开

    // 用户确认的关闭按钮：div.close.close-mask-dark
    var closeBtn = document.querySelector('div.close.close-mask-dark');
    if (closeBtn) {
      await humanClick(closeBtn);
      await sleep(500 + Math.random() * 300);
      return true;
    }

    // 兼容其他关闭按钮
    var closeSelectors = ['.close-circle', '.note-detail-mask .close', '.note-detail .close'];
    for (var i = 0; i < closeSelectors.length; i++) {
      var btn = document.querySelector(closeSelectors[i]);
      if (btn) {
        await humanClick(btn);
        await sleep(500 + Math.random() * 300);
        return true;
      }
    }

    // 点击遮罩层关闭
    var mask = document.querySelector('.note-detail-mask');
    if (mask) {
      await humanClick(mask);
      await sleep(500 + Math.random() * 300);
      return true;
    }

    // 按 ESC
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    await sleep(500);
    return false;
  }

  /**
   * 深度页面交互：随机打开2-3条笔记，做关注/点赞/收藏/深度阅读/直接关闭等动作
   * 所有动作都有鼠标移动轨迹，禁止直接点击
   * 用于关键词采集后产生真实浏览轨迹
   * @returns {Promise<void>}
   */
  async function deepPageInteraction() {
    // 深度交互是采集完成后的独立模拟行为，不依赖 collecting 标志
    // （COLLECT 完成后 collecting 已被置为 false）
    bgLog('深度页面交互开始');
    var noteLinks = findNoteLinks();
    if (!noteLinks || noteLinks.length === 0) {
      bgLog('深度交互: 未找到笔记链接，跳过', 'warn');
      return;
    }

    // 过滤可见的笔记链接
    var visibleLinks = [];
    for (var k = 0; k < noteLinks.length; k++) {
      var r = noteLinks[k].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) visibleLinks.push(noteLinks[k]);
    }
    bgLog('深度交互: 找到 ' + noteLinks.length + ' 个链接, ' + visibleLinks.length + ' 个可见');

    if (visibleLinks.length === 0) {
      bgLog('深度交互: 无可见笔记链接，跳过', 'warn');
      return;
    }

    // 随机选 2-3 条笔记
    var interactionCount = 2 + Math.floor(Math.random() * 2);
    var shuffled = visibleLinks.sort(function () { return Math.random() - 0.5; });
    var selected = shuffled.slice(0, Math.min(interactionCount, shuffled.length));
    bgLog('深度交互: 选择 ' + selected.length + ' 条笔记');

    for (var i = 0; i < selected.length; i++) {
      var link = selected[i];
      bgLog('深度交互 ' + (i + 1) + '/' + selected.length + ': 开始');

      try {
        // 大幅鼠标动作
        bgLog('深度交互: 大幅鼠标动作');
        await bigMouseMove();
        await sleep(300 + Math.random() * 200);

        // 点击打开笔记详情（humanClick 内含鼠标移动轨迹）
        if (link.tagName === 'A') {
          link.removeAttribute('target');
          link.setAttribute('target', '_self');
        }
        bgLog('深度交互: humanClick 点击笔记');
        await humanClick(link);
        await sleep(2000 + Math.random() * 1500); // 等待详情层打开

        // 检查详情层是否打开
        var detailMask = document.querySelector('.note-detail-mask') || document.querySelector('.note-detail');
        if (!detailMask) {
          bgLog('深度交互: 详情层未打开，跳过此笔记', 'warn');
          continue;
        }
        bgLog('深度交互: 详情层已打开');

        // 随机选择 1-2 个交互动作
        var actions = [];
        var possibleActions = ['like', 'collect', 'follow', 'deep_read', 'close'];
        actions.push(possibleActions[Math.floor(Math.random() * possibleActions.length)]);
        if (Math.random() < 0.3) {
          var secondAction;
          do {
            secondAction = possibleActions[Math.floor(Math.random() * possibleActions.length)];
          } while (secondAction === actions[0]);
          actions.push(secondAction);
        }

        for (var a = 0; a < actions.length; a++) {
          var action = actions[a];
          bgLog('深度交互动作: ' + action);

          if (action === 'like') {
            await interactWithElement('svg.like-icon');
          } else if (action === 'collect') {
            await interactWithElement('svg.collect-icon');
          } else if (action === 'follow') {
            await interactWithElement('div.author-container button.follow-button');
          } else if (action === 'deep_read') {
            await deepReadDetail();
          } else if (action === 'close') {
            // 直接关闭，什么都不做
          }
          await sleep(500 + Math.random() * 1000);
        }

        // 关闭详情层
        bgLog('深度交互: 关闭详情层');
        await closeNoteDetail();
        await sleep(800 + Math.random() * 700);

      } catch (e) {
        bgLog('深度交互异常（不影响采集）: ' + e.message, 'error');
        try { await closeNoteDetail(); } catch (e2) {}
      }
    }
    bgLog('深度页面交互完成', 'success');
  }

  /**
   * 在新 tab 打开的笔记详情页进行深度交互
   * 场景：background.js 通过 chrome.tabs.create 打开笔记 URL 后发送 DEEP_INTERACTION_ON_PAGE
   * 随机执行点赞/收藏/关注/深度阅读/访问用户主页等动作
   * 所有点击使用 humanClick（含鼠标移动轨迹），交互完成后由 background.js 关闭 tab
   * @returns {Promise<{actions: string[], visitedHomepage: boolean}>}
   */
  async function deepInteractionOnNotePage() {
    bgLog('[深度交互-新tab] 开始, url=' + location.href + ', readyState=' + document.readyState);

    // MV3 keepalive: 用 port 保持 Service Worker 活跃
    // port 是 Chrome 扩展 API，不受页面主线程阻塞影响（setInterval 会被 XHS 鼠标模拟阻塞）
    // 只要端口开着，SW 就不会被 30 秒超时终止
    var diPort = null;
    try {
      diPort = chrome.runtime.connect({ name: 'keepalive' });
      diPort.onDisconnect.addListener(function () {
        // SW 重启会导致端口断开，尝试重连
        diPort = null;
      });
    } catch (e) {}

    try {
    // 等待页面完全加载（最多等 6 秒）
    var waitStart = Date.now();
    while (document.readyState !== 'complete' && Date.now() - waitStart < 6000) {
      await sleep(500);
    }
    bgLog('[深度交互-新tab] 页面加载状态: ' + document.readyState + ', 耗时 ' + (Date.now() - waitStart) + 'ms');

    // 额外等待页面渲染（SPA 异步渲染笔记内容）
    await sleep(1500 + Math.random() * 1000);

    // 检查页面是否有效（非错误页/登录页）
    var noteContent = document.querySelector('.note-container, .note-detail, [class*="note-content"]');
    if (!noteContent) {
      bgLog('[深度交互-新tab] 未找到笔记内容容器，页面可能未正确加载', 'warn');
      // 仍然继续尝试，某些页面结构可能不同
    }

    // 鼠标移动到页面随机区域（模拟用户视线移动到页面）
    // 使用 moveMouseToRandomArea 而非 bigMouseMove：后者有 20-60 个 await sleep，
    // 在 XHS 页面会被阻塞导致 30-60 秒延迟，超出 90s 超时
    bgLog('[深度交互-新tab] 执行鼠标移动');
    try {
      await moveMouseToRandomArea();
    } catch (e) {
      bgLog('[深度交互-新tab] 鼠标移动异常: ' + e.message, 'warn');
    }
    await sleep(500 + Math.random() * 800);

    // === 阶段1：初始阅读（模拟用户先看笔记内容再决定是否互动）===
    bgLog('[深度交互-新tab] 阶段1: 阅读笔记内容');
    try {
      await deepReadDetail();
    } catch (e) {
      bgLog('[深度交互-新tab] 初始阅读异常: ' + e.message, 'warn');
    }
    // 阅读后短暂思考
    await sleep(800 + Math.random() * 1200);

    var performedActions = [];
    var visitedHomepage = false;

    // === 阶段2：随机交互动作（真实人类行为顺序：先看 → 再点赞/收藏/关注 → 最后访问主页）===
    // 动作权重：like(30%) > collect(20%) > follow(15%) > deep_read(15%) > visit_homepage(10%) > close(10%)
    var possibleActions = ['like', 'like', 'like', 'collect', 'collect', 'follow', 'follow', 'deep_read', 'deep_read', 'visit_homepage', 'close'];
    var actionCount = 1 + (Math.random() < 0.35 ? 1 : 0); // 35% 概率做 2 个动作
    var actions = [];
    actions.push(possibleActions[Math.floor(Math.random() * possibleActions.length)]);
    if (actionCount > 1) {
      var secondAction;
      do {
        secondAction = possibleActions[Math.floor(Math.random() * possibleActions.length)];
      } while (secondAction === actions[0]);
      actions.push(secondAction);
    }

    // 动作排序：deep_read 最先（继续阅读），like/collect/follow 中间，visit_homepage 最后（会导航）
    var actionOrder = { deep_read: 0, like: 1, collect: 2, follow: 3, close: 4, visit_homepage: 5 };
    actions.sort(function (a, b) {
      return (actionOrder[a] || 0) - (actionOrder[b] || 0);
    });

    bgLog('[深度交互-新tab] 计划动作: ' + actions.join(' -> '));

    for (var a = 0; a < actions.length; a++) {
      var action = actions[a];
      bgLog('[深度交互-新tab] 执行动作: ' + action);

      // 动作前：鼠标移动到页面随机区域（模拟用户视线从内容区移到操作区）
      if (a > 0) {
        await moveMouseToRandomArea();
        await sleep(300 + Math.random() * 500);
      }

      try {
        if (action === 'like') {
          if (await interactWithElement('svg.like-icon')) {
            performedActions.push('like');
          }
        } else if (action === 'collect') {
          if (await interactWithElement('svg.collect-icon')) {
            performedActions.push('collect');
          }
        } else if (action === 'follow') {
          if (await interactWithElement('div.author-container button.follow-button')) {
            performedActions.push('follow');
          }
        } else if (action === 'deep_read') {
          await deepReadDetail();
          performedActions.push('deep_read');
        } else if (action === 'visit_homepage') {
          // 点击用户主页：深度人类行为模拟（与 like/collect/follow 同级）
          // 流程：先看别处(50%) → naturalHover(微抖悬停) → 10%放弃 → humanClick → 观察
          var avatarLinks = document.querySelectorAll('a.avatar-item');
          if (avatarLinks.length === 0) {
            avatarLinks = document.querySelectorAll('div.avatar-click a, div.avatar-container a, a[href*="/user/profile/"]');
          }
          if (avatarLinks.length > 0) {
            var homeLink = avatarLinks[Math.floor(Math.random() * avatarLinks.length)];
            if (homeLink.href) {
              homeLink.setAttribute('target', '_blank');
              bgLog('[深度交互-新tab] 准备点击用户主页（avatar-item ' + (avatarLinks.length) + ' 个可选）: ' + homeLink.href);
              try {
                // 50% 概率先看别处（模拟用户先浏览内容，再决定看作者主页）
                if (Math.random() < 0.5) {
                  await moveMouseToRandomArea();
                  await sleep(300 + Math.random() * 500);
                }
                // naturalHover 悬停（微抖 + 阅读考虑，与 interactWithElement 一致）
                await naturalHover(homeLink, 600 + Math.random() * 1400);
                // 10% 概率放弃点击（用户考虑后决定不点）
                if (Math.random() < 0.1) {
                  bgLog('[深度交互-新tab] 考虑后放弃访问主页');
                  await moveMouseToRandomArea();
                } else {
                  // 点击
                  await humanClick(homeLink);
                  // 点击后观察（查看跳转效果）
                  await sleep(400 + Math.random() * 800);
                  bgLog('[深度交互-新tab] 用户主页点击完成');
                  // 通知 background 有新 tab 打开
                  try {
                    chrome.runtime.sendMessage({
                      type: 'HOMEPAGE_TAB_OPENED',
                      url: homeLink.href,
                    }).catch(function () {});
                  } catch (e) {}
                  performedActions.push('visit_homepage');
                  visitedHomepage = true;
                }
              } catch (e) {
                bgLog('[深度交互-新tab] 用户主页点击异常: ' + e.message, 'warn');
              }
              // visit_homepage 是最后动作，立即返回，跳过所有剩余 sleep
              bgLog('[深度交互-新tab] visit_homepage 完成，立即返回', 'success');
              return { actions: performedActions, visitedHomepage: visitedHomepage };
            } else {
              bgLog('[深度交互-新tab] avatar-item 链接无 href', 'warn');
            }
          } else {
            bgLog('[深度交互-新tab] 未找到 avatar-item 超链接', 'warn');
          }
        } else if (action === 'close') {
          // 直接关闭，什么都不做
          performedActions.push('close');
        }
      } catch (e) {
        bgLog('[深度交互-新tab] 动作 ' + action + ' 异常: ' + e.message, 'warn');
      }

      // 动作后：随机停顿（模拟用户查看交互结果后的思考）
      await sleep(600 + Math.random() * 1000);
    }

    bgLog('[深度交互-新tab] 完成, actions=[' + performedActions.join(',') + ']', 'success');
    return { actions: performedActions, visitedHomepage: visitedHomepage };
    } finally {
      if (diPort) {
        try { diPort.disconnect(); } catch (e) {}
      }
    }
  }

  /**
   * 用鼠标移动轨迹点击指定选择器的元素（深度人类行为模拟）
   * 流程：找到元素 → 鼠标移到随机区域（浏览其他内容）→ 悬停考虑 → 点击 → 停留查看结果
   * 如果页面上有多个匹配元素，随机选一个可见的（如点赞按钮可能出现在笔记区和评论区）
   * @param {string} selector - CSS 选择器
   * @returns {Promise<boolean>} 是否成功
   */
  async function interactWithElement(selector) {
    // 查找所有匹配元素，过滤可见的，随机选一个
    var allEls = document.querySelectorAll(selector);
    var visibleEls = [];
    for (var i = 0; i < allEls.length; i++) {
      var r = allEls[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) visibleEls.push(allEls[i]);
    }
    if (visibleEls.length === 0) {
      bgLog('交互元素未找到或不可见: ' + selector + ' (匹配 ' + allEls.length + ' 个)', 'warn');
      return false;
    }
    var el = visibleEls[Math.floor(Math.random() * visibleEls.length)];
    bgLog('[交互] ' + selector + ' 匹配 ' + allEls.length + ' 个, 可见 ' + visibleEls.length + ' 个, 随机选第 ' + (visibleEls.indexOf(el) + 1) + ' 个');
    // 先移动鼠标到页面其他区域（模拟用户先看了别的地方，然后才发现按钮）
    if (Math.random() < 0.5) {
      await moveMouseToRandomArea();
    }
    // 悬停考虑阶段（手部微抖 + 犹豫是否点击）
    await naturalHover(el, 500 + Math.random() * 1500);
    // 10% 概率放弃点击（用户考虑后决定不点）
    if (Math.random() < 0.1) {
      bgLog('[交互] 考虑后放弃点击: ' + selector);
      await moveMouseToRandomArea();
      return false;
    }
    // 点击
    await humanClick(el);
    // 点击后停留（查看点击效果，如点赞数变化）
    await sleep(400 + Math.random() * 800);
    return true;
  }

  /**
   * 深度阅读：在笔记详情内滚动 + 停留（深度人类行为模拟）
   * 包含：可变滚动量、偶尔回滚重读、滚动间鼠标移动、图片区域停留更长
   * 同时用于采集期间和新 tab 深度交互，不依赖 collecting 标志
   */
  async function deepReadDetail() {
    // 滚动 1-2 次（控制总时长，避免 XHS 阻塞 setTimeout 导致超时）
    var scrollTimes = 1 + Math.floor(Math.random() * 2);
    for (var i = 0; i < scrollTimes; i++) {
      // 可变滚动量：有时大幅滚动（快速浏览），有时小幅（仔细看）
      var scrollAmount;
      if (Math.random() < 0.3) {
        scrollAmount = 80 + Math.random() * 120;
      } else {
        scrollAmount = 200 + Math.random() * 300;
      }

      // 15% 概率回滚（重读之前的内容）
      if (i > 0 && Math.random() < 0.15) {
        scrollAmount = -Math.abs(scrollAmount) * 0.7;
        bgLog('[深度阅读] 回滚重读');
      }

      // 尝试在详情容器内滚动
      var detailContainer = document.querySelector('.note-detail-mask') || document.querySelector('.note-detail');
      if (detailContainer) {
        var scrollEl = detailContainer.querySelector('.note-content') || detailContainer;
        try {
          scrollEl.scrollBy({ top: scrollAmount, behavior: 'smooth' });
        } catch (e) {
          window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
        }
      } else {
        window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      }

      // 阅读停留时间：1.5-3 秒（缩短，避免总时长过长）
      var readTime = 1500 + Math.random() * 1500;
      await sleep(readTime);

      // 30% 概率在阅读期间移动鼠标（模拟用户视线跟随内容移动）
      if (Math.random() < 0.3) {
        await moveMouseToRandomArea();
      }
    }
  }

  /**
   * 在搜索框输入关键词并点击搜索
   * @param {string} keyword - 搜索关键词
   * @param {Function} [onBeforeSubmit] - 在点击搜索按钮前调用的回调（用于提前发送 sendResponse，避免 SPA 导航导致消息通道关闭）
   * @returns {Promise<boolean>} 是否成功
   */
 async function searchOnPage(keyword, onBeforeSubmit) {
    // 查找搜索输入框
    var searchInput = document.querySelector('#search-input-in-feeds');
    if (!searchInput) {
      // 可能在首页，需要先点击搜索图标
      var searchIcon = document.querySelector('.search-icon, [class*="search"] svg, svg.search-icon');
      if (searchIcon) {
        await humanClick(searchIcon);
        await sleep(1000);
        searchInput = document.querySelector('#search-input-in-feeds, input[type="text"][placeholder*="搜索"]');
      }
    }

    if (!searchInput) {
      return false;
    }

    // 鼠标移动到输入框并输入
    await humanType(searchInput, keyword);
    await sleep(500 + Math.random() * 300);

    // 关键：在点击搜索按钮前通知调用者发送响应
    // 点击搜索按钮会触发 SPA 导航，导航后 content script 上下文可能被销毁，
    // 导致 sendResponse 无法调用，Chrome 报 "message channel closed" 错误
    if (onBeforeSubmit) {
      try { onBeforeSubmit(); } catch (e) {}
    }

    // 点击搜索按钮（svg.submit-button）
    var searchBtn = document.querySelector('svg.submit-button, .submit-button, button[type="submit"]');
    if (searchBtn) {
      await humanClick(searchBtn);
    } else {
      // 没有搜索按钮，按回车
      try {
        searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      } catch (e) {}
    }

    await sleep(2000 + Math.random() * 1000); // 等待搜索结果加载
    return true;
  }

  // ======================= 搜索 API =======================

  /**
   * 搜索笔记列表
   * POST https://so.xiaohongshu.com/api/sns/web/v2/search/notes
   */
  async function fetchSearch(keyword, page) {
    var body = {
      keyword: keyword,
      page: page,
      page_size: 20,
      search_id: randomId(21),
      sort: 'general',
      note_type: 0,
      ext_flags: [],
      geo: '',
      image_formats: ['jpg', 'webp', 'avif'],
      message_id: 'sending',
      session_id: genSessionId(),
    };
    var apiPath = '/api/sns/web/v2/search/notes';

    var sigs = await generateSignatures(apiPath, body, 'search');

    var headers = {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
      'priority': 'u=1, i',
      'x-b3-traceid': randomHex(8),
      'x-xray-traceid': randomHex(16),
      'x-s': sigs.xs,
      'x-t': sigs.xt,
      'x-s-common': sigs.xsc,
    };
    if (rapParams.search) {
      headers['x-rap-param'] = rapParams.search;
    }

    var resp = await fetch('https://so.xiaohongshu.com' + apiPath, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      credentials: 'include',
      referrerPolicy: 'strict-origin-when-cross-origin',
    });

    return resp.json();
  }

  // ======================= Feed 详情 API =======================

  /**
   * 获取笔记详情
   * POST https://edith.xiaohongshu.com/api/sns/web/v1/feed
   */
  async function fetchFeed(noteId, xsecToken) {
    var body = {
      source_note_id: noteId,
      image_formats: ['jpg', 'webp', 'avif'],
      extra: { need_body_topic: '1' },
      xsec_source: 'pc_search',
      xsec_token: xsecToken,
    };
    var apiPath = '/api/sns/web/v1/feed';

    var sigs = await generateSignatures(apiPath, body, 'feed');

    var headers = {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
      'priority': 'u=1, i',
      'x-b3-traceid': randomHex(8),
      'x-xray-traceid': randomHex(16),
      'x-s': sigs.xs,
      'x-t': sigs.xt,
      'x-s-common': sigs.xsc,
    };
    if (rapParams.feed) {
      headers['x-rap-param'] = rapParams.feed;
    }

    var resp = await fetch('https://edith.xiaohongshu.com' + apiPath, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      credentials: 'include',
      referrerPolicy: 'strict-origin-when-cross-origin',
    });

    return resp.json();
  }

  // ======================= 详情数据提取 =======================

  function extractDetail(resp, note) {
    var nc = (resp.data && resp.data.items && resp.data.items[0] && resp.data.items[0].note_card) || {};
    return {
      noteId: note.noteId,
      keyword: note.keyword,
      xsecToken: note.xsecToken,
      title: nc.title || '',
      desc: nc.desc || '',
      type: nc.type || '',
      tagList: nc.tag_list || [],
      user: {
        userId: (nc.user && nc.user.user_id) || '',
        nickname: (nc.user && nc.user.nickname) || '',
        avatar: (nc.user && nc.user.avatar) || '',
      },
      interactInfo: {
        likedCount: (nc.interact_info && nc.interact_info.liked_count) || '0',
        collectedCount: (nc.interact_info && nc.interact_info.collected_count) || '0',
        commentCount: (nc.interact_info && nc.interact_info.comment_count) || '0',
        shareCount: (nc.interact_info && nc.interact_info.share_count) || '0',
      },
      imageList: (nc.image_list || []).map(function (img) {
        // API 返回 url 为空，真实 URL 在 url_default / url_pre / info_list 中
        var imgUrl = img.url_default || img.url_pre || '';
        if (!imgUrl && img.info_list && img.info_list.length > 0) {
          imgUrl = img.info_list[0].url || '';
        }
        return { url: imgUrl, width: img.width || 0, height: img.height || 0 };
      }),
      time: nc.time || '',
      lastUpdateTime: nc.last_update_time || '',
      shareInfo: nc.share_info || {},
    };
  }

  // ======================= 单关键词采集 =======================

  /**
   * 采集一个关键词的所有笔记（搜索 + 详情）
   * @param {string} keyword - 关键词
   * @param {number} pages - 搜索页数
   * @param {number} feedDelayMin - 详情间隔最小值(ms)
   * @param {number} feedDelayMax - 详情间隔最大值(ms)
   * @param {number} [deepInteractionInterval=10] - 每采集N条后触发一次新tab深度交互（0=不启用）
   * @returns {Promise<{notes: Array, details: Array, failures: Array, stopped: boolean}>}
   */
  async function collectKeyword(keyword, pages, feedDelayMin, feedDelayMax, deepInteractionInterval) {
    deepInteractionInterval = deepInteractionInterval !== undefined ? deepInteractionInterval : 10;
    // 注意：页面搜索框输入 + 滚动加载 + 回顶部 已由 background.js 分步消息驱动完成
    // background.js 在发送 COLLECT 消息前已依次发送：
    //   SEARCH（content.js 执行 searchOnPage）→ 等待加载 → SCROLL（滚动3次）→ SCROLL_TO_TOP
    // content.js 只负责 API 搜索 + 详情采集

    // --- Step 1: API 搜索获取笔记列表 ---
    sendProgress({ phase: 'search', keyword: keyword, page: 0, totalPages: pages, noteCount: 0 });

    var notes = [];
    var searchErrors = [];
    for (var page = 1; page <= pages; page++) {
      if (!collecting) return { notes: notes, details: [], failures: [], stopped: true };

      var resp;
      try {
        resp = await fetchSearch(keyword, page);
      } catch (e) {
        sendProgress({ phase: 'search_error', keyword: keyword, page: page, error: e.message });
        searchErrors.push({ page: page, code: -998, msg: e.message });
        await sleep(randomDelay(2000, 4000));
        continue;
      }

      if (resp.code !== 0) {
        sendProgress({ phase: 'search_error', keyword: keyword, page: page, code: resp.code, msg: resp.msg || '' });
        searchErrors.push({ page: page, code: resp.code, msg: resp.msg || '' });

        if (resp.code === -100) {
          return { notes: notes, details: [], failures: [], stopped: true, reason: 'login_expired' };
        }
        if (resp.code === 300011) {
          return { notes: notes, details: [], failures: [], stopped: true, reason: 'account_blocked' };
        }
        if (resp.code === 300013 || resp.code === 300015 || resp.code === 300012) {
          return { notes: notes, details: [], failures: [], stopped: true, reason: 'rate_limited', lastError: resp.code };
        }
        await sleep(randomDelay(2000, 4000));
        continue;
      }

      var items = (resp.data && resp.data.items) || [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.model_type !== 'note') continue;

        var nc = item.note_card || {};
        var noteId = item.id || nc.note_id;
        var xsecToken = item.xsec_token || nc.xsec_token || '';
        if (noteId && xsecToken && noteId.length < 30) {
          notes.push({
            noteId: noteId,
            xsecToken: xsecToken,
            keyword: keyword,
            title: nc.display_title || '',
            type: nc.type || '',
          });
        }
      }

      sendProgress({ phase: 'search', keyword: keyword, page: page, totalPages: pages, noteCount: notes.length });
    }

    if (notes.length === 0 && searchErrors.length > 0) {
      var lastErr = searchErrors[searchErrors.length - 1];
      return {
        notes: notes, details: [], failures: [], stopped: true,
        reason: 'search_all_failed',
        lastErrorCode: lastErr.code,
        lastErrorMsg: lastErr.msg,
      };
    }

    // --- Step 2: 按顺序点击笔记采集详情 ---
    // 滚动加载和回顶部已由 background.js 完成
    sendProgress({ phase: 'detail_start', keyword: keyword, totalNotes: notes.length });

    var details = [];
    var failures = [];
    var success = 0;
    var fail = 0;
    var consecutiveFail = 0;

    for (var j = 0; j < notes.length; j++) {
      if (!collecting) return { notes: notes, details: details, failures: failures, stopped: true };

      var note = notes[j];
      console.log('[xhs] 采集进度: ' + (j + 1) + '/' + notes.length + ' noteId=' + note.noteId);

      // 关键：采集第一条笔记前鼠标大幅移动，规避自动化检测
      if (j === 0) {
        await bigMouseMove();
        await sleep(300 + Math.random() * 200);
      }

      // 调用 API 获取详情（核心采集，顺序由 notes 数组严格保证）
      var feedResp;
      try {
        feedResp = await fetchFeed(note.noteId, note.xsecToken);
      } catch (e) {
        fail++;
        failures.push({ noteId: note.noteId, code: -998, msg: e.message });
        consecutiveFail++;
        sendProgress({
          phase: 'detail', keyword: keyword, current: j + 1, total: notes.length,
          success: success, fail: fail, lastError: e.message,
        });
        if (consecutiveFail >= 3) {
          sendProgress({ phase: 'consecutive_fail', keyword: keyword, count: consecutiveFail, current: j + 1, total: notes.length });
          await sleep(10000);
          consecutiveFail = 0;
        }
        await sleep(randomDelay(feedDelayMin, feedDelayMax));
        continue;
      }

      if (feedResp.code === 0) {
        details.push(extractDetail(feedResp, note));
        success++;
        consecutiveFail = 0;
      } else if (feedResp.code === -100) {
        return { notes: notes, details: details, failures: failures, stopped: true, reason: 'login_expired' };
      } else if (feedResp.code === 300011) {
        return { notes: notes, details: details, failures: failures, stopped: true, reason: 'account_blocked' };
      } else if (feedResp.code === 300013) {
        sendProgress({ phase: 'rate_limited', keyword: keyword, current: j + 1, total: notes.length, code: 300013 });
        await sleep(15000);
        try {
          var retryResp = await fetchFeed(note.noteId, note.xsecToken);
          if (retryResp.code === 0) {
            details.push(extractDetail(retryResp, note));
            success++;
            consecutiveFail = 0;
          } else {
            fail++;
            failures.push({ noteId: note.noteId, code: retryResp.code, msg: retryResp.msg || '限流重试失败' });
            consecutiveFail++;
          }
        } catch (e2) {
          fail++;
          failures.push({ noteId: note.noteId, code: -998, msg: '限流重试异常: ' + e2.message });
          consecutiveFail++;
        }
      } else if (feedResp.code === 300015) {
        sendProgress({ phase: 'env_detection', keyword: keyword, current: j + 1, total: notes.length, code: 300015 });
        await sleep(20000);
        try {
          var retry2 = await fetchFeed(note.noteId, note.xsecToken);
          if (retry2.code === 0) {
            details.push(extractDetail(retry2, note));
            success++;
            consecutiveFail = 0;
          } else {
            fail++;
            failures.push({ noteId: note.noteId, code: retry2.code, msg: '300015重试失败' });
            consecutiveFail++;
            if (retry2.code === 300015) {
              return { notes: notes, details: details, failures: failures, stopped: true, reason: 'env_detection' };
            }
          }
        } catch (e3) {
          fail++;
          failures.push({ noteId: note.noteId, code: -998, msg: '300015重试异常: ' + e3.message });
          consecutiveFail++;
        }
      } else if (feedResp.code === 300031 || feedResp.code === -510000) {
        fail++;
        failures.push({ noteId: note.noteId, code: feedResp.code, msg: feedResp.code === -510000 ? '笔记不存在' : '笔记已下架' });
      } else {
        fail++;
        failures.push({ noteId: note.noteId, code: feedResp.code, msg: feedResp.msg || '未知错误' });
        consecutiveFail++;
      }

      if (consecutiveFail >= 3) {
        sendProgress({ phase: 'consecutive_fail', keyword: keyword, count: consecutiveFail, current: j + 1, total: notes.length });
        await sleep(10000);
        consecutiveFail = 0;
      }

      sendProgress({
        phase: 'detail', keyword: keyword, current: j + 1, total: notes.length,
        success: success, fail: fail,
      });

      // 每采集 N 条后通过新 tab 进行深度交互（点赞/收藏/关注/访问用户主页等）
      // 流程：随机选 1 条笔记 → 在页面找到链接 → 滚动到可视区域 → 右键模拟新窗口打开 → 新 tab 中深度交互 → 关闭 tab
      // 采集关键词后不再做深度交互（由 background.js 控制调用时机）
      if (deepInteractionInterval > 0 && (j + 1) % deepInteractionInterval === 0) {
        // 随机选 1 条笔记
        var candidates = notes.slice(Math.max(0, j - deepInteractionInterval + 1), j + 1);
        var pickedNote = candidates[Math.floor(Math.random() * candidates.length)];
        bgLog('[采集] 第 ' + (j + 1) + ' 条后触发深度交互，选中笔记: ' + pickedNote.noteId);

        // 在当前搜索页找到该笔记的链接，滚动到可视区域，右键模拟"新窗口打开"
        // 笔记来自搜索 API，DOM 虚拟列表可能已卸载该笔记
        try {
          var noteLink = await scrollToFindNote(pickedNote.noteId, 6);
          if (!noteLink) {
            // 回退：找任意可见笔记链接做右键鼠标模拟
            // 实际打开的 URL 由 background 用 pickedNote 的 noteId 构建
            noteLink = findAnyVisibleNoteLink();
            if (noteLink) {
              bgLog('[采集] 目标笔记链接未找到，回退到右键任意可见笔记链接做鼠标模拟');
            }
          }
          if (noteLink) {
            bgLog('[采集] 找到笔记链接，右键模拟新窗口打开');
            // 鼠标移动到目标区域（用 moveMouseToRandomArea 而非 bigMouseMove，避免 XHS 阻塞）
            await moveMouseToRandomArea();
            await sleep(300 + Math.random() * 200);
            // 右键点击笔记链接
            await humanRightClick(noteLink);
            await sleep(800 + Math.random() * 600);
          } else {
            bgLog('[采集] 页面无可见笔记链接，直接打开新 tab', 'warn');
          }
        } catch (e) {
          bgLog('[采集] 右键交互异常（不影响后续）: ' + e.message, 'warn');
        }

        // 发送给 background 打开新 tab 进行深度交互（1 条笔记）
        try {
          await new Promise(function (resolve) {
            chrome.runtime.sendMessage(
              { type: 'DEEP_INTERACTION_TABS', notes: [{ noteId: pickedNote.noteId, xsecToken: pickedNote.xsecToken }] },
              function (response) {
                bgLog('[采集] 深度交互完成: ' + (response && response.ok ? '成功' : '失败') + ', 交互 ' + (response && response.interacted || 0) + ' 条');
                resolve();
              }
            );
          });
        } catch (e) {
          bgLog('[采集] 深度交互异常（不影响采集）: ' + e.message, 'warn');
        }
        // 交互后额外延迟，避免节奏过快
        await sleep(1000 + Math.random() * 1000);
      }

      // 详情间延迟（模拟人类阅读后切换下一篇）
      await sleep(randomDelay(feedDelayMin, feedDelayMax));
    }

    return { notes: notes, details: details, failures: failures, stopped: false };
  }

  // ======================= 消息处理 =======================

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    // 分步驱动：页面搜索（鼠标大幅移动 + 逐字输入 + 点击搜索按钮）
    // 由 background 调用，完成后 background 等待搜索结果加载再发 SCROLL
    if (message.type === 'SEARCH') {
      sendProgress({ phase: 'searching', keyword: message.keyword });
      var searchResponded = false;
      (async function () {
        // 关键：搜索前鼠标大幅移动（随机动作），规避自动化检测
        await bigMouseMove();
        await sleep(200 + Math.random() * 200);
        var ok = await searchOnPage(message.keyword, function () {
          // 在点击搜索按钮前发送响应，避免 SPA 导航导致消息通道关闭
          // 点击搜索按钮会触发页面导航，导航后 content script 上下文被销毁，
          // 此时 sendResponse 将无法调用，Chrome 报 "message channel closed" 错误
          searchResponded = true;
          try { sendResponse({ ok: true }); } catch (e) {}
        });
        // 如果 searchOnPage 在回调触发前就返回 false（找不到搜索框），需要在此发送响应
        if (!searchResponded) {
          searchResponded = true;
          try { sendResponse({ ok: ok }); } catch (e) {}
        }
      })().catch(function (e) {
        if (!searchResponded) {
          searchResponded = true;
          try { sendResponse({ ok: false, error: e.message }); } catch (e2) {}
        }
      });
      return true;
    }

    // 独立的大幅鼠标动作（用于 300011 恢复流程中导航首页/搜索后调用）
    if (message.type === 'BIG_MOUSE_MOVE') {
      bigMouseMove()
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    // 深度页面交互：关键词采集后随机打开2-3条笔记，做关注/点赞/收藏等动作
    // 注意：采集关键词后不再自动触发深度交互（background.js 已移除调用）
    // 此 handler 保留供手动调用或其他场景使用
    if (message.type === 'DEEP_INTERACTION') {
      sendProgress({ phase: 'behavior_simulation', behaviorCount: 1 });
      deepPageInteraction()
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    // 在新 tab 打开的笔记详情页进行深度交互
    // 由 background.js DEEP_INTERACTION_TABS handler 发送，在新 tab 的 content.js 中执行
    // 随机执行点赞/收藏/关注/深度阅读/访问用户主页等动作，所有点击使用人类鼠标轨迹
    if (message.type === 'DEEP_INTERACTION_ON_PAGE') {
      deepInteractionOnNotePage()
        .then(function (result) { sendResponse({ ok: true, result: result }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    // 分步驱动：滚动加载（原生平滑滚动）
    if (message.type === 'SCROLL') {
      sendProgress({ phase: 'scrolling', noteCount: 0 });
      scrollDownToLoad(message.times || 3)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    // 分步驱动：回顶部
    if (message.type === 'SCROLL_TO_TOP') {
      sendProgress({ phase: 'back_to_top' });
      smoothScrollTo(0)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (message.type === 'COLLECT') {
      handleCollectRequest(message)
        .then(function (result) {
          // 缓存结果（供 GET_RESULT 查询，防止 COLLECT_DONE 和 sendResponse 都丢失）
          lastCollectResult = result;
          // 先发 COLLECT_DONE 备用消息（更可靠，不依赖消息通道）
          // MV3 长操作后 sendResponse 的消息通道可能已被 Chrome 静默关闭
          try {
            chrome.runtime.sendMessage({ type: 'COLLECT_DONE', ok: true, data: result }).catch(function () {});
          } catch (e) {}
          // 再调 sendResponse（通道可能已失效，调用可能静默失败）
          try { sendResponse({ ok: true, data: result }); } catch (e) {}
        })
        .catch(function (err) {
          lastCollectResult = { error: err.message };
          try {
            chrome.runtime.sendMessage({ type: 'COLLECT_DONE', ok: false, error: err.message }).catch(function () {});
          } catch (e) {}
          try { sendResponse({ ok: false, error: err.message }); } catch (e) {}
        });
      return true; // 保持消息通道开放（异步响应）
    }

    // GET_RESULT: background.js 在 COLLECT_DONE/sendResponse 都丢失时主动查询结果
    if (message.type === 'GET_RESULT') {
      if (lastCollectResult && !lastCollectResult.error) {
        sendResponse({ ok: true, data: lastCollectResult });
      } else if (lastCollectResult && lastCollectResult.error) {
        sendResponse({ ok: false, error: lastCollectResult.error });
      } else {
        sendResponse({ ok: false, error: '无缓存结果' });
      }
      return false;
    }

    if (message.type === 'STOP') {
      collecting = false;
      stopKeepAlive();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'SW_RESTARTED') {
      // SW 重启通知：重连保活端口，继续采集
      bgLog('[content] 收到 SW_RESTARTED 通知，重连保活端口');
      if (collecting) {
        startKeepAlive();
      }
      sendResponse({ ok: true, collecting: collecting });
      return false;
    }

    if (message.type === 'CHECK_STATUS') {
      sendResponse({
        ok: true,
        mnsv2Ready: mnsv2Ready,
        collecting: collecting,
        rapParams: { search: !!rapParams.search, feed: !!rapParams.feed },
        // web_session 是 HttpOnly，无法通过 document.cookie 读取
        // 登录态由 API -100 错误码自然判断
        loggedIn: null,
      });
      return false;
    }

    if (message.type === 'PING') {
      sendResponse({ ok: true, url: location.href, readyState: document.readyState });
      return false;
    }
  });

  // 保活端口：采集期间保持长连接到 background，防止 Service Worker 休眠
  // MV3 中 setTimeout 不能保持 SW 活跃，但活跃的 chrome.runtime.connect 端口可以
  var keepAlivePort = null;
  var keepAliveStopped = false; // 标记是否为主动停止（避免 onDisconnect 触发重连）
  var keepAliveReconnectTimer = null; // pending 的重连定时器

  function startKeepAlive() {
    if (keepAlivePort) return;
    if (!collecting) return; // 不在采集中不连接
    keepAliveStopped = false;
    try {
      keepAlivePort = chrome.runtime.connect({ name: 'keepalive' });
      keepAlivePort.onDisconnect.addListener(function () {
        keepAlivePort = null;
        // 主动停止不重连；SW 重启导致的断开则自动重连
        if (!keepAliveStopped && collecting) {
          keepAliveReconnectTimer = setTimeout(function () {
            keepAliveReconnectTimer = null;
            if (!keepAliveStopped && collecting) {
              startKeepAlive();
            }
          }, 1000);
        }
      });
    } catch (e) {
      keepAlivePort = null;
      if (!keepAliveStopped && collecting) {
        keepAliveReconnectTimer = setTimeout(function () {
          keepAliveReconnectTimer = null;
          if (!keepAliveStopped && collecting) {
            startKeepAlive();
          }
        }, 2000);
      }
    }
  }

  function stopKeepAlive() {
    keepAliveStopped = true;
    if (keepAliveReconnectTimer) {
      clearTimeout(keepAliveReconnectTimer);
      keepAliveReconnectTimer = null;
    }
    if (keepAlivePort) {
      try { keepAlivePort.disconnect(); } catch (e) {}
      keepAlivePort = null;
    }
  }

  async function handleCollectRequest(message) {
    if (collecting) throw new Error('正在采集中，请先停止当前任务');
    collecting = true;
    startKeepAlive();

    try {
      // 确保注入脚本已加载（每次都确保注入）
      sendProgress({ phase: 'injecting' });
      await injectMainWorldScript();

      var keyword = message.keyword;
      var pages = message.pages || 3;
      var feedDelayMin = message.feedDelayMin || 3000;
      var feedDelayMax = message.feedDelayMax || 6000;
      var deepInteractionInterval = message.deepInteractionInterval !== undefined ? message.deepInteractionInterval : 10;

      // 注意：web_session 是 HttpOnly cookie，document.cookie 读不到
      // 不做登录预检查，由 API 返回 -100 时自然处理登录过期

      sendProgress({
        phase: 'start', keyword: keyword, pages: pages,
        rapParamReady: !!(rapParams.search || rapParams.feed),
      });

      var result = await collectKeyword(keyword, pages, feedDelayMin, feedDelayMax, deepInteractionInterval);

      sendProgress({
        phase: 'complete',
        keyword: keyword,
        notesCount: result.notes.length,
        detailsCount: result.details.length,
        failuresCount: result.failures.length,
        stopped: result.stopped,
        reason: result.reason,
      });

      return result;
    } finally {
      collecting = false;
      // 不在这里断开保活端口：关键词之间 background.js 还需要导航回首页、
      // 重新注入脚本等操作（约 10-15 秒）。若断开端口，SW 在此期间无活跃端口，
      // 会被 MV3 的 30 秒超时机制终止，导致 startCollection 的 async 上下文丢失，
      // 采集永久卡住。端口只在收到 STOP 消息时才断开（见 STOP handler）。
    }
  }

  // ======================= 初始化通知 =======================

  // 通知 background 内容脚本已就绪
  chrome.runtime.sendMessage({ type: 'CONTENT_READY', url: location.href }).catch(function () {});

  // 尝试预加载注入脚本（不阻塞，失败时在采集时重试）
  injectMainWorldScript().then(function () {
    chrome.runtime.sendMessage({
      type: 'MNSV2_READY',
      rapParams: { search: !!rapParams.search, feed: !!rapParams.feed },
    }).catch(function () {});
  }).catch(function () {});

})();
