/**
 * background.js — Service Worker (Manifest V3)
 *
 * 职责：
 *   1. 管理 xiaohongshu.com 标签页（查找/创建）
 *   2. 在 popup 与 content script 之间转发消息
 *   3. 管理采集队列（支持多关键词顺序采集）
 *   4. 通过 chrome.storage.local 持久化进度与结果
 *
 * 消息协议：
 *   popup → background:
 *     START_COLLECTION { keyword, pages, feedDelayMin, feedDelayMax }
 *     STOP_COLLECTION
 *     GET_STATUS
 *     GET_RESULTS
 *     CLEAR_RESULTS
 *     OPEN_XHS_TAB
 *   background → content script:
 *     COLLECT { keyword, pages, feedDelayMin, feedDelayMax }
 *     STOP
 *     CHECK_STATUS
 *   content script → background:
 *     PROGRESS { phase, ... }
 *     CONTENT_READY { url }
 *     MNSV2_READY { rapParams }
 */

'use strict';

// ======================= 状态管理 =======================

var state = {
  collecting: false,           // 是否正在采集
  currentKeyword: '',          // 当前采集的关键词
  keywordQueue: [],            // 待采集的关键词队列
  totalPages: 3,
  feedDelayMin: 3000,
  feedDelayMax: 6000,
  progress: null,              // 最新进度
  mnsv2Ready: false,           // 签名函数是否就绪
  xhsTabId: null,              // 小红书标签页 ID
};

// 标记插件自身发起的导航（避免 onUpdated 误触发停止采集）
var _pluginNavigation = false;

// ======================= 工具函数 =======================

// 日志级别颜色映射
function _logLevel(msg) {
  if (/\[错误\]|error|失败|异常/i.test(msg)) return 'error';
  if (/\[警告\]|warn|超时/i.test(msg)) return 'warn';
  if (/完成|成功|就绪|ok/i.test(msg)) return 'success';
  return 'info';
}

function log(msg) {
  var line = '[bg] ' + msg;
  console.log(line);
  // 广播给 sidebar 控制台
  try {
    chrome.runtime.sendMessage({
      type: 'CONSOLE_LOG',
      message: msg,
      level: _logLevel(msg),
      timestamp: Date.now(),
    }).catch(function () {});
  } catch (e) {}
}

function saveState() {
  chrome.storage.local.set({
    xhs_state: {
      collecting: state.collecting,
      currentKeyword: state.currentKeyword,
      keywordQueue: state.keywordQueue,
      totalPages: state.totalPages,
      feedDelayMin: state.feedDelayMin,
      feedDelayMax: state.feedDelayMax,
      progress: state.progress,
      mnsv2Ready: state.mnsv2Ready,
      xhsTabId: state.xhsTabId,
    }
  });
}

function loadState() {
  return new Promise(function (resolve) {
    chrome.storage.local.get('xhs_state', function (result) {
      if (result.xhs_state) {
        Object.assign(state, result.xhs_state);
      }
      resolve(state);
    });
  });
}

// ======================= 标签页管理 =======================

function findXhsTab() {
  return new Promise(function (resolve) {
    chrome.tabs.query({ url: '*://*.xiaohongshu.com/*' }, function (tabs) {
      resolve(tabs.length > 0 ? tabs[0] : null);
    });
  });
}

async function ensureXhsTab() {
  var tab = await findXhsTab();
  if (!tab) {
    // 创建新标签页
    _pluginNavigation = true;
    tab = await new Promise(function (resolve) {
      chrome.tabs.create({ url: 'https://www.xiaohongshu.com/explore' }, resolve);
    });
    setTimeout(function () { _pluginNavigation = false; }, 1500);
    state.xhsTabId = tab.id;
    // 等待页面加载
    await waitForTabComplete(tab.id);
  } else {
    state.xhsTabId = tab.id;
  }

  // 不论新建还是复用，都验证 content script 是否就绪
  // MV3 中插件刷新后已打开的标签页不会自动注入 content_scripts
  var ready = await waitForContentScript(tab.id);
  if (!ready) {
    log('Content script 未就绪，主动注入...');
    await injectContentScripts(tab.id);
    // 注入后再等待 PING 响应
    await waitForContentScript(tab.id);
  }

  // 主动注入 MAIN world 脚本（绕过 CSP，获取 window.mnsv2）
  try {
    await injectMainWorldScript(tab.id);
    log('MAIN world 脚本已注入');
  } catch (e) {
    log('MAIN world 脚本注入失败: ' + e.message);
  }

  return tab;
}

/**
 * 主动注入 content scripts（用于已存在但未注入脚本的标签页）
 */
function injectContentScripts(tabId) {
  return new Promise(function (resolve, reject) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['lib/md5.js', 'lib/sign.js', 'content/content.js']
    }, function () {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/**
 * 注入 MAIN world 脚本（绕过 CSP，直接访问 window.mnsv2）
 */
function injectMainWorldScript(tabId) {
  return new Promise(function (resolve, reject) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      files: ['content/injected.js']
    }, function (result) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

function waitForTabComplete(tabId) {
  return new Promise(function (resolve) {
    var listener = function (id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // 超时保护
    setTimeout(function () {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

/**
 * 采集前预行为模拟：首页点击笔记 → 搜索页 → 点击笔记详情
 * 让浏览器产生完整真实浏览轨迹后再开始采集
 * @param {string} searchUrl - 第一个关键词的搜索页 URL
 * @returns {Promise<string>} 执行结果
 */
async function preCollectionBehavior(searchUrl) {
  var tabId = state.xhsTabId;
  if (!tabId) return 'no_tab';

  try {
    // === 阶段1：首页点击笔记 ===
    log('[预行为] 1/3 导航到首页...');
    await new Promise(function (resolve) {
      pluginTabsUpdate(tabId, { url: 'https://www.xiaohongshu.com/explore' }).then(resolve).catch(resolve);
    });
    await waitForTabComplete(tabId);
    await new Promise(function (r) { setTimeout(r, 3500); }); // 等待页面完全渲染

    // 验证首页已加载
    var homepageCheck = await clickNoteViaScripting(tabId);
    log('[预行为] 首页状态: ' + homepageCheck);

    // 如果第一次没找到笔记，再等一会重试
    if (homepageCheck.indexOf('no_notes') === 0 || homepageCheck.indexOf('no_visible') === 0) {
      log('[预行为] 首页笔记未加载，等待 3 秒重试...');
      await new Promise(function (r) { setTimeout(r, 3000); });
    }

    // 首页点击 2-3 个笔记
    var homepageClicks = 2 + Math.floor(Math.random() * 2);
    for (var i = 0; i < homepageClicks; i++) {
      if (!state.collecting) return 'stopped';
      var clickR = await clickNoteViaScripting(tabId);
      log('[预行为] 首页点击 ' + (i + 1) + '/' + homepageClicks + ': ' + clickR);
      // 只有成功点击才等待详情层打开
      if (clickR.indexOf('clicked') === 0) {
        await new Promise(function (r) { setTimeout(r, 3000 + Math.random() * 1500); });
        var closeR = await closeNoteDetailViaScripting(tabId);
        log('[预行为] 关闭详情: ' + closeR);
        await new Promise(function (r) { setTimeout(r, 1000 + Math.random() * 500); });
      } else {
        log('[预行为] 点击失败，跳过');
        break;
      }
    }

    if (!state.collecting) return 'stopped';

    // === 阶段2：导航到搜索页 ===
    log('[预行为] 2/3 导航到搜索页: ' + searchUrl);
    await new Promise(function (resolve) {
      pluginTabsUpdate(tabId, { url: searchUrl }).then(resolve).catch(resolve);
    });
    await waitForTabComplete(tabId);
    await new Promise(function (r) { setTimeout(r, 3500); }); // 等待搜索结果渲染

    // 验证搜索页已加载
    var searchCheck = await clickNoteViaScripting(tabId);
    log('[预行为] 搜索页状态: ' + searchCheck);

    if (searchCheck.indexOf('no_notes') === 0 || searchCheck.indexOf('no_visible') === 0) {
      log('[预行为] 搜索结果未加载，等待 3 秒重试...');
      await new Promise(function (r) { setTimeout(r, 3000); });
    }

    // === 阶段3：在搜索页点击笔记详情 ===
    log('[预行为] 3/3 搜索页点击笔记...');
    var searchClicks = 2 + Math.floor(Math.random() * 2);
    for (var j = 0; j < searchClicks; j++) {
      if (!state.collecting) return 'stopped';
      var sClickR = await clickNoteViaScripting(tabId);
      log('[预行为] 搜索页点击 ' + (j + 1) + '/' + searchClicks + ': ' + sClickR);
      if (sClickR.indexOf('clicked') === 0) {
        await new Promise(function (r) { setTimeout(r, 3500 + Math.random() * 2000); });
        var sCloseR = await closeNoteDetailViaScripting(tabId);
        log('[预行为] 关闭详情: ' + sCloseR);
        await new Promise(function (r) { setTimeout(r, 1000 + Math.random() * 500); });
      } else {
        log('[预行为] 点击失败，跳过');
        break;
      }
    }

    // 重新注入 content script 和 MAIN world 脚本（导航后需要）
    log('[预行为] 重新注入采集脚本...');
    await injectContentScripts(tabId);
    await injectMainWorldScript(tabId);
    await new Promise(function (r) { setTimeout(r, 2500); }); // 等待 mnsv2 就绪

    return 'pre_behavior_done (homepage=' + homepageClicks + ', search=' + searchClicks + ')';
  } catch (e) {
    return 'error: ' + e.message;
  }
}

/**
 * 导航到首页，点击笔记，再导航回搜索页
 * 关键词之间的强行为模拟，产生真实浏览轨迹
 * @param {string} searchUrl - 要返回的搜索页 URL
 * @returns {Promise<string>} 执行结果
 */
async function navigateHomepageAndClick(searchUrl) {
  var tabId = state.xhsTabId;
  if (!tabId) return 'no_tab';

  try {
    // 1. 导航到首页
    log('[行为] 导航到首页...');
    await new Promise(function (resolve) {
      pluginTabsUpdate(tabId, { url: 'https://www.xiaohongshu.com/explore' }).then(resolve).catch(resolve);
    });
    await waitForTabComplete(tabId);
    await new Promise(function (r) { setTimeout(r, 2000); }); // 等待页面渲染

    // 2. 在首页点击笔记（通过 executeScript 执行）
    var clickResult = await clickNoteViaScripting(tabId);
    log('[行为] 首页点击: ' + clickResult);

    // 3. 等待阅读
    await new Promise(function (r) { setTimeout(r, 2000 + Math.random() * 2000); });

    // 4. 关闭详情层
    var closeResult = await closeNoteDetailViaScripting(tabId);
    log('[行为] 关闭详情: ' + closeResult);

    await new Promise(function (r) { setTimeout(r, 1000); });

    // 5. 再随机点击 1-2 个笔记
    var extraClicks = Math.floor(Math.random() * 2) + 1;
    for (var i = 0; i < extraClicks; i++) {
      var r = await clickNoteViaScripting(tabId);
      log('[行为] 额外点击 ' + (i + 1) + ': ' + r);
      await new Promise(function (resolve) { setTimeout(resolve, 2500 + Math.random() * 2000); });
      await closeNoteDetailViaScripting(tabId);
      await new Promise(function (r) { setTimeout(r, 800 + Math.random() * 500); });
    }

    // 6. 随机点击侧边栏菜单（点点/世界杯/RED/直播/通知/我），模拟人类浏览不同频道
    var menuClicks = Math.floor(Math.random() * 2) + 1; // 1-2 个
    for (var m = 0; m < menuClicks; m++) {
      if (!state.collecting) return 'stopped';
      var menuResult = await clickSidebarMenuViaScripting(tabId);
      log('[行为] 侧边栏菜单点击 ' + (m + 1) + '/' + menuClicks + ': ' + menuResult);
      if (menuResult.indexOf('clicked') === 0) {
        // 等待页面加载
        await waitForTabComplete(tabId);
        await new Promise(function (r) { setTimeout(r, 2000 + Math.random() * 2000); });

        // 滚动浏览一下
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: function () {
              window.scrollTo({ top: 200 + Math.random() * 400, behavior: 'smooth' });
            },
          });
        } catch (e) {}
        await new Promise(function (r) { setTimeout(r, 2000 + Math.random() * 2000); });

        // 返回首页
        log('[行为] 返回首页...');
        await new Promise(function (resolve) {
          pluginTabsUpdate(tabId, { url: 'https://www.xiaohongshu.com/explore' }).then(resolve).catch(resolve);
        });
        await waitForTabComplete(tabId);
        await new Promise(function (r) { setTimeout(r, 1500 + Math.random() * 1000); });
      } else {
        await new Promise(function (r) { setTimeout(r, 1000); });
      }
    }

    // 7. 导航回搜索页
    if (searchUrl) {
      log('[行为] 导航回搜索页...');
      await new Promise(function (resolve) {
        pluginTabsUpdate(tabId, { url: searchUrl }).then(resolve).catch(resolve);
      });
      await waitForTabComplete(tabId);
      await new Promise(function (r) { setTimeout(r, 1500); });

      // 重新注入 content script（导航后需要重新注入）
      await injectContentScripts(tabId);
      await injectMainWorldScript(tabId);
      // 等待 mnsv2 就绪
      await new Promise(function (r) { setTimeout(r, 2000); });
    }

    return 'homepage_click_done (extra=' + extraClicks + ')';
  } catch (e) {
    return 'error: ' + e.message;
  }
}

/**
 * 随机点击侧边栏菜单（点点/世界杯/RED/直播/通知/我）
 * 模拟人类浏览不同频道，增加行为真实感
 */
async function clickSidebarMenuViaScripting(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async function () {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var dispatchMM = function (x, y, target) {
          try {
            (target || document).dispatchEvent(new MouseEvent('mousemove', {
              bubbles: true, cancelable: true, view: window, clientX: Math.round(x), clientY: Math.round(y)
            }));
          } catch (e) {}
        };

        // 侧边栏菜单列表
        var menus = [
          { selector: 'a[href="/ai_chat?from=sidebar"]', name: '点点' },
          { selector: 'a[href*="/worldcup26"]', name: '世界杯' },
          { selector: 'a[href="/red_video"]', name: 'RED' },
          { selector: 'a[href*="/livelist"]', name: '直播' },
          { selector: 'a[href="/notification"]', name: '通知' },
          { selector: '.side-bar-component a[href*="/user/profile/"]', name: '我' },
        ];

        // 随机选一个
        var idx = Math.floor(Math.random() * menus.length);
        var menu = menus[idx];

        var link = document.querySelector(menu.selector);
        if (!link) return 'menu_not_found: ' + menu.name;

        // 滚动到可见
        link.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(400 + Math.random() * 300);

        // 移除 target=_blank，防止开新 tab
        if (link.tagName === 'A') {
          link.removeAttribute('target');
          link.setAttribute('target', '_self');
        }

        // 获取元素位置
        var rect = link.getBoundingClientRect();
        var cx = Math.round(rect.left + rect.width / 2);
        var cy = Math.round(rect.top + rect.height / 2);

        // 50% 概率先把鼠标移到页面其他区域（模拟用户先看了别的内容）
        if (Math.random() < 0.5) {
          var rx = Math.floor(window.innerWidth * (0.2 + Math.random() * 0.6));
          var ry = Math.floor(window.innerHeight * (0.2 + Math.random() * 0.6));
          var sx = Math.max(0, rx - 100);
          var sy = Math.max(0, ry - 100);
          var sSteps = 4 + Math.floor(Math.random() * 4);
          for (var s0 = 0; s0 <= sSteps; s0++) {
            var t0 = s0 / sSteps;
            dispatchMM(sx + (rx - sx) * t0, sy + (ry - sy) * t0);
            await sleep(10 + Math.random() * 15);
          }
          await sleep(300 + Math.random() * 500);
        }

        // 平滑移动到元素（从随机起点，带缓动）
        var startX = Math.max(0, cx - 80 - Math.floor(Math.random() * 120));
        var startY = Math.max(0, cy - 60 - Math.floor(Math.random() * 80));
        var steps = 6 + Math.floor(Math.random() * 6);
        for (var s = 0; s <= steps; s++) {
          var t = s / steps;
          var eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          var mx = Math.round(startX + (cx - startX) * eased + (Math.random() * 5 - 2));
          var my = Math.round(startY + (cy - startY) * eased + (Math.random() * 5 - 2));
          dispatchMM(mx, my);
          await sleep(12 + Math.random() * 18);
        }

        // 悬停 + 微抖（模拟手部自然抖动 + 阅读考虑）
        try {
          link.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window, clientX: cx, clientY: cy }));
          link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window, clientX: cx, clientY: cy }));
        } catch (e) {}
        // 微抖：10-16 个点，3-7px 偏移，分2-3批
        var tremorCount = 10 + Math.floor(Math.random() * 6);
        var batchCount = 3;
        var perBatch = Math.ceil(tremorCount / batchCount);
        for (var b = 0; b < batchCount; b++) {
          for (var tb = 0; tb < perBatch; tb++) {
            dispatchMM(cx + (Math.random() * 7 - 3.5), cy + (Math.random() * 7 - 3.5), link);
          }
          await sleep(150 + Math.random() * 250);
        }

        // 10% 概率放弃点击（用户考虑后决定不点）
        if (Math.random() < 0.1) {
          // 移开鼠标
          for (var m = 0; m < 4; m++) {
            dispatchMM(cx + 30 + m * 15, cy + 20 + m * 10);
            await sleep(15);
          }
          return 'abandoned: ' + menu.name;
        }

        // 点击序列
        try {
          link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
          await sleep(40 + Math.random() * 60);
          link.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
          await sleep(10);
        } catch (e) {}
        link.click();

        return 'clicked: ' + menu.name;
      },
    });

    return results && results[0] ? results[0].result : 'no_result';
  } catch (e) {
    return 'error: ' + e.message;
  }
}

/**
 * 通过 executeScript 在页面点击笔记（深度人类行为模拟）
 * 流程：找元素 → 滚动到可视 → 50%概率先移到随机区域 → 平滑移动到元素 → 悬停微抖 → 10%概率放弃 → 点击序列
 */
async function clickNoteViaScripting(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async function () {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

        try {
          var selectors = ['a.cover.mask.ld', 'section.note-item a.cover', 'a[href*="/explore/"]', 'a[href*="/search_result/"]'];
          var links = [];
          for (var i = 0; i < selectors.length; i++) {
            links = document.querySelectorAll(selectors[i]);
            if (links.length > 0) break;
          }
          if (links.length === 0) return 'no_notes (url=' + location.href + ')';

          // 过滤可见元素
          var visibleLinks = [];
          for (var k = 0; k < Math.min(links.length, 15); k++) {
            var rect = links[k].getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) visibleLinks.push(links[k]);
          }
          if (visibleLinks.length === 0) return 'no_visible_notes';

          var idx = Math.floor(Math.random() * Math.min(visibleLinks.length, 8));
          var link = visibleLinks[idx];

          // 滚动到可见位置
          link.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(400 + Math.random() * 300); // 等待平滑滚动完成

          // 关键：移除target属性，防止打开新标签页
          if (link.tagName === 'A') {
            link.removeAttribute('target');
            link.setAttribute('target', '_self');
          }

          // 获取元素位置
          var rect2 = link.getBoundingClientRect();
          var cx = Math.round(rect2.left + rect2.width / 2);
          var cy = Math.round(rect2.top + rect2.height / 2);

          // === 50% 概率先移动到页面随机区域（模拟用户先看了别处）===
          if (Math.random() < 0.5) {
            var randTx = Math.floor(window.innerWidth * (0.15 + Math.random() * 0.7));
            var randTy = Math.floor(window.innerHeight * (0.15 + Math.random() * 0.7));
            var randSx = Math.floor(window.innerWidth * (0.2 + Math.random() * 0.6));
            var randSy = Math.floor(window.innerHeight * (0.2 + Math.random() * 0.6));
            var randSteps = 6 + Math.floor(Math.random() * 6);
            for (var rs = 0; rs <= randSteps; rs++) {
              var rt = rs / randSteps;
              var rEased = rt < 0.5 ? 2 * rt * rt : 1 - Math.pow(-2 * rt + 2, 2) / 2;
              var rmx = Math.round(randSx + (randTx - randSx) * rEased + (Math.random() * 6 - 3));
              var rmy = Math.round(randSy + (randTy - randSy) * rEased + (Math.random() * 6 - 3));
              try {
                document.dispatchEvent(new MouseEvent('mousemove', {
                  bubbles: true, cancelable: true, view: window, clientX: rmx, clientY: rmy
                }));
              } catch (e) {}
              await sleep(15 + Math.random() * 25);
            }
            await sleep(200 + Math.random() * 400);
          }

          // === 平滑移动到元素位置（从随机起点，带加速度变化）===
          var startX = Math.max(0, cx - 100 - Math.floor(Math.random() * 200));
          var startY = Math.max(0, cy - 80 - Math.floor(Math.random() * 100));
          var steps = 8 + Math.floor(Math.random() * 8); // 8-15 步移动（更细腻）
          for (var s = 0; s <= steps; s++) {
            var t = s / steps;
            // ease-in-out 缓动（先慢后快再慢）
            var eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            var mx = Math.round(startX + (cx - startX) * eased + (Math.random() * 6 - 3));
            var my = Math.round(startY + (cy - startY) * eased + (Math.random() * 6 - 3));
            try {
              document.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true, cancelable: true, view: window, clientX: mx, clientY: my
              }));
            } catch (e) {}
            await sleep(10 + Math.random() * 20);
          }

          // === 悬停阶段：在元素上微抖（模拟手部抖动 + 阅读考虑）===
          try {
            link.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window, clientX: cx, clientY: cy }));
            link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window, clientX: cx, clientY: cy }));
          } catch (e) {}

          var hoverTime = 500 + Math.random() * 1500;
          var hoverStart = Date.now();
          while (Date.now() - hoverStart < hoverTime) {
            // 在元素中心附近做 3-8px 的随机偏移（手部微抖）
            var jx = cx + (Math.random() * 8 - 4);
            var jy = cy + (Math.random() * 8 - 4);
            try {
              document.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true, cancelable: true, view: window,
                clientX: Math.round(jx), clientY: Math.round(jy)
              }));
            } catch (e) {}
            await sleep(40 + Math.random() * 80);
          }

          // === 10% 概率放弃点击（用户考虑后决定不点）===
          if (Math.random() < 0.1) {
            // 移开鼠标
            var awayX = Math.max(0, cx - 200 - Math.floor(Math.random() * 100));
            var awayY = Math.max(0, cy - 150 - Math.floor(Math.random() * 100));
            try {
              document.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true, cancelable: true, view: window, clientX: awayX, clientY: awayY
              }));
            } catch (e) {}
            return 'abandoned idx=' + idx + ' total=' + visibleLinks.length;
          }

          // === 点击事件序列（mousedown → 停顿 → mouseup → click）===
          var mouseOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
          try {
            link.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
          } catch (e) {}
          await sleep(50 + Math.random() * 80); // 按住 50-130ms
          try {
            link.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
          } catch (e) {}
          await sleep(20 + Math.random() * 40);
          if (typeof link.click === 'function') {
            link.click();
          } else {
            try { link.dispatchEvent(new MouseEvent('click', mouseOpts)); } catch (e) {}
          }

          // 点击后短暂停留（查看效果）
          await sleep(200 + Math.random() * 400);

          var href = link.getAttribute('href') || '';
          return 'clicked idx=' + idx + ' total=' + visibleLinks.length + ' href=' + href.slice(0, 40);
        } catch (e) {
          return 'error: ' + e.message;
        }
      }
    });
    return results && results[0] ? results[0].result : 'no_result';
  } catch (e) {
    return 'error: ' + e.message;
  }
}

/**
 * 通过 executeScript 关闭笔记详情层（深度人类行为模拟）
 * 流程：找到关闭按钮 → 鼠标移动到按钮 → 悬停微抖 → 点击序列
 */
async function closeNoteDetailViaScripting(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async function () {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

        // 在元素上执行人类点击：平滑移动 → 悬停微抖 → mousedown → mouseup → click
        async function humanClickEl(el) {
          var rect = el.getBoundingClientRect();
          var cx = Math.round(rect.left + rect.width / 2);
          var cy = Math.round(rect.top + rect.height / 2);

          // 平滑移动到元素（从随机起点，带缓动）
          var startX = Math.max(0, cx - 80 - Math.floor(Math.random() * 120));
          var startY = Math.max(0, cy - 60 - Math.floor(Math.random() * 80));
          var steps = 6 + Math.floor(Math.random() * 6);
          for (var s = 0; s <= steps; s++) {
            var t = s / steps;
            var eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            var mx = Math.round(startX + (cx - startX) * eased + (Math.random() * 5 - 2));
            var my = Math.round(startY + (cy - startY) * eased + (Math.random() * 5 - 2));
            try {
              document.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true, cancelable: true, view: window, clientX: mx, clientY: my
              }));
            } catch (e) {}
            await sleep(12 + Math.random() * 18);
          }

          // 悬停微抖
          try {
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window, clientX: cx, clientY: cy }));
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window, clientX: cx, clientY: cy }));
          } catch (e) {}
          var hoverTime = 300 + Math.random() * 700;
          var hoverStart = Date.now();
          while (Date.now() - hoverStart < hoverTime) {
            var jx = cx + (Math.random() * 6 - 3);
            var jy = cy + (Math.random() * 6 - 3);
            try {
              document.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true, cancelable: true, view: window,
                clientX: Math.round(jx), clientY: Math.round(jy)
              }));
            } catch (e) {}
            await sleep(40 + Math.random() * 60);
          }

          // 点击序列
          var mouseOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
          try { el.dispatchEvent(new MouseEvent('mousedown', mouseOpts)); } catch (e) {}
          await sleep(40 + Math.random() * 60);
          try { el.dispatchEvent(new MouseEvent('mouseup', mouseOpts)); } catch (e) {}
          await sleep(15 + Math.random() * 30);
          if (typeof el.click === 'function') el.click();
          else { try { el.dispatchEvent(new MouseEvent('click', mouseOpts)); } catch (e) {} }
        }

        try {
          // 用户确认的关闭按钮：div.close.close-mask-dark
          var closeBtn = document.querySelector('div.close.close-mask-dark');
          if (closeBtn) {
            await humanClickEl(closeBtn);
            await sleep(200 + Math.random() * 300);
            return 'closed_btn';
          }
          // 兼容其他关闭按钮
          var closeSelectors = ['.close-circle', '.note-detail-mask .close', '.note-detail .close'];
          for (var i = 0; i < closeSelectors.length; i++) {
            var btn = document.querySelector(closeSelectors[i]);
            if (btn) {
              await humanClickEl(btn);
              await sleep(200 + Math.random() * 300);
              return 'closed_btn';
            }
          }
          var mask = document.querySelector('.note-detail-mask');
          if (mask) {
            await humanClickEl(mask);
            await sleep(200 + Math.random() * 300);
            return 'closed_mask';
          }
          // ESC 兜底
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
          await sleep(50 + Math.random() * 50);
          document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
          return 'closed_esc';
        } catch (e) {
          return 'error: ' + e.message;
        }
      }
    });
    return results && results[0] ? results[0].result : 'no_result';
  } catch (e) {
    return 'error: ' + e.message;
  }
}

/**
 * 通过 executeScript 在页面搜索框输入关键词并搜索（深度人类行为模拟）
 * 流程：鼠标移动到输入框 → 点击聚焦 → 逐字输入（80-200ms/字）→ 鼠标移动到搜索按钮 → 悬停 → 点击序列
 * @param {number} tabId
 * @param {string} keyword
 * @returns {Promise<string>}
 */
async function searchOnPageViaScripting(tabId, keyword) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async function (kw) {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

        // 平滑移动鼠标到元素位置（带缓动 + 微抖）
        async function moveMouseToEl(el) {
          var rect = el.getBoundingClientRect();
          var cx = Math.round(rect.left + rect.width / 2);
          var cy = Math.round(rect.top + rect.height / 2);
          var startX = Math.max(0, cx - 100 - Math.floor(Math.random() * 150));
          var startY = Math.max(0, cy - 80 - Math.floor(Math.random() * 100));
          var steps = 8 + Math.floor(Math.random() * 8);
          for (var s = 0; s <= steps; s++) {
            var t = s / steps;
            var eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            var mx = Math.round(startX + (cx - startX) * eased + (Math.random() * 6 - 3));
            var my = Math.round(startY + (cy - startY) * eased + (Math.random() * 6 - 3));
            try {
              document.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true, cancelable: true, view: window, clientX: mx, clientY: my
              }));
            } catch (e) {}
            await sleep(10 + Math.random() * 20);
          }
          return { cx: cx, cy: cy };
        }

        try {
          var searchInput = document.querySelector('#search-input-in-feeds');
          if (!searchInput) return 'no_input';

          // === 鼠标移动到输入框 ===
          var inputPos = await moveMouseToEl(searchInput);
          await sleep(200 + Math.random() * 200);

          // === 点击聚焦（mousedown → mouseup → focus → click）===
          var mouseOpts = { bubbles: true, cancelable: true, view: window, clientX: inputPos.cx, clientY: inputPos.cy };
          try {
            searchInput.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
          } catch (e) {}
          await sleep(50 + Math.random() * 50);
          try {
            searchInput.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
          } catch (e) {}
          searchInput.focus();
          if (typeof searchInput.click === 'function') searchInput.click();
          await sleep(300 + Math.random() * 200);

          // === 清空已有内容 ===
          var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
          if (!nativeSetter) nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          if (nativeSetter && nativeSetter.set) {
            nativeSetter.set.call(searchInput, '');
          } else {
            searchInput.value = '';
          }
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));

          // === 逐字输入（80-200ms 每字，带 keydown/keyup）===
          for (var i = 0; i < kw.length; i++) {
            var ch = kw[i];
            try {
              searchInput.dispatchEvent(new KeyboardEvent('keydown', {
                key: ch, code: ch, keyCode: ch.charCodeAt(0), bubbles: true
              }));
            } catch (e) {}
            if (nativeSetter && nativeSetter.set) {
              nativeSetter.set.call(searchInput, searchInput.value + ch);
            } else {
              searchInput.value += ch;
            }
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            try {
              searchInput.dispatchEvent(new KeyboardEvent('keyup', {
                key: ch, code: ch, keyCode: ch.charCodeAt(0), bubbles: true
              }));
            } catch (e) {}
            await sleep(80 + Math.random() * 120); // 80-200ms 每字
          }
          searchInput.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(400 + Math.random() * 300); // 输入后思考

          // === 鼠标移动到搜索按钮 ===
          var btn = document.querySelector('svg.submit-button, .submit-button, button[type="submit"]');
          if (btn) {
            var btnPos = await moveMouseToEl(btn);
            // 悬停微抖
            try {
              btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window, clientX: btnPos.cx, clientY: btnPos.cy }));
              btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window, clientX: btnPos.cx, clientY: btnPos.cy }));
            } catch (e) {}
            var hoverTime = 300 + Math.random() * 600;
            var hoverStart = Date.now();
            while (Date.now() - hoverStart < hoverTime) {
              var jx = btnPos.cx + (Math.random() * 6 - 3);
              var jy = btnPos.cy + (Math.random() * 6 - 3);
              try {
                document.dispatchEvent(new MouseEvent('mousemove', {
                  bubbles: true, cancelable: true, view: window,
                  clientX: Math.round(jx), clientY: Math.round(jy)
                }));
              } catch (e) {}
              await sleep(40 + Math.random() * 60);
            }
            // 点击序列
            var btnOpts = { bubbles: true, cancelable: true, view: window, clientX: btnPos.cx, clientY: btnPos.cy };
            try { btn.dispatchEvent(new MouseEvent('mousedown', btnOpts)); } catch (e) {}
            await sleep(40 + Math.random() * 60);
            try { btn.dispatchEvent(new MouseEvent('mouseup', btnOpts)); } catch (e) {}
            await sleep(15 + Math.random() * 30);
            if (typeof btn.click === 'function') btn.click();
            else { try { btn.dispatchEvent(new MouseEvent('click', btnOpts)); } catch (e) {} }
          } else {
            // 没有搜索按钮，按回车
            try {
              searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            } catch (e) {}
            await sleep(50 + Math.random() * 50);
            try {
              searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            } catch (e) {}
          }
          return 'searching';
        } catch (e) {
          return 'error: ' + e.message;
        }
      },
      args: [keyword],
    });
    var result = results && results[0] ? results[0].result : 'no_result';
    return result;
  } catch (e) {
    return 'error: ' + e.message;
  }
}

/**
 * 通过 executeScript 滚动笔记列表（深度人类行为模拟）
 * 用户确认：所有笔记的父 div 是 class="feeds-container"
 * 但 .feeds-container 本身可能不滚动（overflow 在祖先节点），所以从它向上找真正的滚动容器
 * 增强：可变滚动量（30%小幅仔细看/70%正常）、15%概率回滚重读、30%概率滚动间鼠标移动
 * @param {number} tabId
 * @param {number} times - 滚动次数
 */
async function scrollViaScripting(tabId, times) {
  times = times || 3;
  for (var i = 0; i < times; i++) {
    if (!state.collecting) break;
    try {
      var isBackScroll = i > 0 && Math.random() < 0.15; // 15% 概率回滚
      var isSmallScroll = Math.random() < 0.3; // 30% 概率小幅滚动
      var results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function (backScroll, smallScroll) {
          var el = document.querySelector('.feeds-container');
          if (!el) return 'no_feeds_container';

          // 从 .feeds-container 向上找真正的滚动容器
          // 滚动容器的特征：scrollHeight > clientHeight 且 scrollHeight 会被该元素限制
          var scroller = null;
          var cur = el;
          for (var up = 0; up < 15; up++) {
            if (!cur || cur === document.body || cur === document.documentElement) break;
            // 检查是否可滚动
            if (cur.scrollHeight > cur.clientHeight + 10 && cur.clientHeight > 100) {
              var style = getComputedStyle(cur);
              var oy = style.overflowY;
              // overflowY 为 auto/scroll，或者 clientHeight 明显小于 scrollHeight
              if (oy === 'auto' || oy === 'scroll' || cur.clientHeight < cur.scrollHeight * 0.8) {
                scroller = cur;
                break;
              }
            }
            cur = cur.parentElement;
          }
          // 兜底：用 window
          if (!scroller) scroller = { _useWindow: true };

          var pageHeight = window.innerHeight;
          var scrollAmount;
          if (backScroll) {
            // 回滚：负方向，小幅
            scrollAmount = -Math.round(pageHeight * (0.3 + Math.random() * 0.3));
          } else if (smallScroll) {
            // 小幅滚动（仔细看某段内容）
            scrollAmount = Math.round(80 + Math.random() * 120);
          } else {
            // 正常滚动
            scrollAmount = Math.round(pageHeight * (0.8 + Math.random() * 0.4));
          }

          if (scroller._useWindow) {
            var beforeW = Math.round(window.scrollY);
            window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
            return {
              before: beforeW, totalH: Math.round(document.documentElement.scrollHeight),
              amount: scrollAmount, target: 'window', backScroll: backScroll, smallScroll: smallScroll
            };
          } else {
            var before = Math.round(scroller.scrollTop);
            var totalH = Math.round(scroller.scrollHeight);
            scroller.scrollBy({ top: scrollAmount, behavior: 'smooth' });
            // 标记，供回顶部使用
            scroller.setAttribute('data-xhs-scroller', '1');
            return {
              before: before, totalH: totalH, amount: scrollAmount,
              target: 'ancestor tag=' + scroller.tagName + ' class=' + (scroller.className || '').toString().slice(0, 40),
              backScroll: backScroll, smallScroll: smallScroll
            };
          }
        },
        args: [isBackScroll, isSmallScroll],
      });
      var info = results && results[0] ? results[0].result : null;
      if (!info || typeof info === 'string') {
        log('[行为] 滚动 ' + (i + 1) + '/' + times + ': ' + (info || 'no_result'));
        continue;
      }

      var scrollType = info.backScroll ? '回滚' : (info.smallScroll ? '小幅' : '正常');
      // 等待 smooth 动画完成（小幅滚动等待时间更短）
      var waitMs = info.smallScroll ? (800 + Math.random() * 300) : (1200 + Math.random() * 300);
      await new Promise(function (r) { setTimeout(r, waitMs); });

      // 读取滚动后位置确认
      var afterResults = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function () {
          var el = document.querySelector('[data-xhs-scroller="1"]');
          if (el) return { target: 'ancestor', y: Math.round(el.scrollTop) };
          return { target: 'window', y: Math.round(window.scrollY) };
        },
      });
      var after = afterResults && afterResults[0] ? afterResults[0].result.y : -1;
      log('[行为] 滚动 ' + (i + 1) + '/' + times + ' [' + scrollType + ']: ' + info.target + ' y ' + info.before + '->' + after + ' (total=' + info.totalH + ')');

      // 30% 概率在滚动停顿期间移动鼠标（模拟用户视线跟随内容移动）
      if (Math.random() < 0.3) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: function () {
              var tx = Math.floor(window.innerWidth * (0.15 + Math.random() * 0.7));
              var ty = Math.floor(window.innerHeight * (0.15 + Math.random() * 0.7));
              var sx = Math.floor(window.innerWidth * (0.2 + Math.random() * 0.6));
              var sy = Math.floor(window.innerHeight * (0.2 + Math.random() * 0.6));
              var steps = 6 + Math.floor(Math.random() * 6);
              // 同步分发鼠标移动（executeScript 内无法 await，用 setTimeout 推迟）
              for (var i = 0; i <= steps; i++) {
                var t = i / steps;
                var eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
                var mx = Math.round(sx + (tx - sx) * eased + (Math.random() * 6 - 3));
                var my = Math.round(sy + (ty - sy) * eased + (Math.random() * 6 - 3));
                try {
                  document.dispatchEvent(new MouseEvent('mousemove', {
                    bubbles: true, cancelable: true, view: window, clientX: mx, clientY: my
                  }));
                } catch (e) {}
              }
            },
          });
        } catch (e) {}
      }

      // 等待内容加载（小幅滚动等待时间更短）
      var loadMs = info.smallScroll ? (800 + Math.random() * 400) : (1000 + Math.random() * 500);
      await new Promise(function (r) { setTimeout(r, loadMs); });
    } catch (e) {
      log('[行为] executeScript 滚动失败: ' + e.message);
    }
  }
}

/**
 * 通过 executeScript 回到顶部
 * @param {number} tabId
 */
async function scrollToTopViaScripting(tabId) {
  try {
    var results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function () {
        var el = document.querySelector('[data-xhs-scroller="1"]');
        if (el) {
          var before = Math.round(el.scrollTop);
          el.scrollTo({ top: 0, behavior: 'smooth' });
          return { target: 'ancestor', before: before };
        }
        var beforeW = Math.round(window.scrollY);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return { target: 'window', before: beforeW };
      },
    });
    var info = results && results[0] ? results[0].result : null;

    await new Promise(function (r) { setTimeout(r, 800 + Math.random() * 200); });

    var afterResults = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function () {
        var el = document.querySelector('[data-xhs-scroller="1"]');
        if (el) return { target: 'ancestor', y: Math.round(el.scrollTop) };
        return { target: 'window', y: Math.round(window.scrollY) };
      },
    });
    var after = afterResults && afterResults[0] ? afterResults[0].result.y : -1;
    log('[行为] 回顶部: ' + (info ? info.target : '?') + ' y ' + (info ? info.before : '?') + '->' + after);
  } catch (e) {
    log('[行为] executeScript 回顶部失败: ' + e.message);
  }
}

/**
 * 检测页面是否跳转到 300011 安全限制页面
 * @param {number} tabId
 * @returns {Promise<boolean>} true=被限制, false=正常
 */
async function isBlockedBySecurity(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function () {
        var bodyText = document.body ? document.body.innerText : '';
        var url = location.href;
        // 检测 300011 安全限制页面特征
        if (url.indexOf('300011') !== -1) return true;
        if (bodyText.indexOf('账号异常') !== -1 && bodyText.length < 500) return true;
        if (bodyText.indexOf('安全验证') !== -1) return true;
        if (bodyText.indexOf('请稍后再试') !== -1 && bodyText.length < 500) return true;
        // 检测详情层是否正常打开（有笔记详情容器）
        var detail = document.querySelector('.note-detail-mask, .note-detail, .note-content');
        if (detail) return false; // 详情层打开了，说明正常
        return false;
      },
    });
    return results && results[0] ? results[0].result === true : false;
  } catch (e) {
    return false;
  }
}

/**
 * 等待笔记详情层打开或页面跳转
 * @param {number} tabId
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true=详情层打开, false=超时或被限制
 */
async function waitForNoteDetailOpen(tabId, timeoutMs) {
  timeoutMs = timeoutMs || 5000;
  var start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(function (r) { setTimeout(r, 500); });
    var blocked = await isBlockedBySecurity(tabId);
    if (blocked) return false;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function () {
          var detail = document.querySelector('.note-detail-mask, .note-detail, .note-content');
          return !!detail;
        },
      });
      if (results && results[0] && results[0].result) return true;
    } catch (e) {}
  }
  return false;
}

/**
 * 300011 账号异常恢复：循环操作直到笔记详情能正常打开
 * 流程：导航首页 → 点击笔记详情 → 检测是否被限制 → 如果被限制，随机关键词搜索 → 点击笔记详情 → 重复
 * @param {number} tabId
 * @returns {Promise<boolean>} true=恢复正常, false=未能恢复
 */
async function recoverFrom300011(tabId) {
  var randomKeywords = ['美食', '旅行', '穿搭', '健身', '摄影', '宠物', '咖啡', '读书', '电影', '音乐', '家居', '数码', '化妆', '烘焙', '露营'];
  var maxAttempts = 15; // 最多尝试 15 次

  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!state.collecting) return false;
    log('[恢复] 第 ' + attempt + '/' + maxAttempts + ' 次尝试...');

    if (attempt === 1) {
      // 第 1 次：导航到首页
      log('[恢复] 导航到首页...');
      await pluginTabsUpdate(tabId, { url: 'https://www.xiaohongshu.com/explore' });
      await new Promise(function (r) { setTimeout(r, 3000); });
      await ensureXhsTab();
      await new Promise(function (r) { setTimeout(r, 1000); });
      // 导航首页后执行大幅鼠标动作（规避检测）
      log('[恢复] 首页大幅鼠标动作...');
      try { await sendToContent({ type: 'BIG_MOUSE_MOVE' }); } catch (e) { log('[恢复] 鼠标动作失败: ' + e.message); }
      await new Promise(function (r) { setTimeout(r, 500 + Math.random() * 300); });
    } else if (attempt % 3 === 2) {
      // 第 2, 5, 8, 11, 14 次：随机关键词搜索
      var kw = randomKeywords[Math.floor(Math.random() * randomKeywords.length)];
      log('[恢复] 随机关键词搜索: ' + kw);
      // 搜索前执行大幅鼠标动作（通过 SEARCH 消息已内置 bigMouseMove，这里直接用 SEARCH）
      try {
        await sendToContent({ type: 'SEARCH', keyword: kw });
      } catch (e) {
        // SEARCH 失败则降级用 executeScript 搜索
        log('[恢复] SEARCH 消息失败，降级 executeScript: ' + e.message);
        var searchResult = await searchOnPageViaScripting(tabId, kw);
        log('[恢复] 搜索结果: ' + searchResult);
        // executeScript 搜索没有 bigMouseMove，单独补一次
        try { await sendToContent({ type: 'BIG_MOUSE_MOVE' }); } catch (e2) {}
      }
      await new Promise(function (r) { setTimeout(r, 2500 + Math.random() * 1500); }); // 等待搜索结果加载
    }

    // 点击笔记详情
    var clickResult = await clickNoteViaScripting(tabId);
    log('[恢复] 点击笔记: ' + clickResult);

    if (clickResult.indexOf('clicked') === -1) {
      // 没找到笔记，等待一下重试
      await new Promise(function (r) { setTimeout(r, 2000); });
      continue;
    }

    // 等待详情层打开或被限制
    var detailOk = await waitForNoteDetailOpen(tabId, 5000);
    log('[恢复] 详情层状态: ' + (detailOk ? '正常打开' : '被限制或超时'));

    if (detailOk) {
      // 详情正常打开，关闭它，恢复成功
      await new Promise(function (r) { setTimeout(r, 2000 + Math.random() * 1000); }); // 模拟阅读
      var closeResult = await closeNoteDetailViaScripting(tabId);
      log('[恢复] 关闭详情: ' + closeResult);
      await new Promise(function (r) { setTimeout(r, 1500 + Math.random() * 500); });
      log('[恢复] 恢复成功！');
      return true;
    }

    // 被限制，关闭可能的限制页面（如果有的话），继续尝试
    await new Promise(function (r) { setTimeout(r, 2000); });

    // 每 3 次失败后导航回首页重新开始
    if (attempt % 3 === 0) {
      log('[恢复] 多次失败，导航回首页重新开始...');
      await pluginTabsUpdate(tabId, { url: 'https://www.xiaohongshu.com/explore' });
      await new Promise(function (r) { setTimeout(r, 3000); });
      await ensureXhsTab();
      await new Promise(function (r) { setTimeout(r, 1000); });
      // 导航回首页后执行大幅鼠标动作
      log('[恢复] 回首页后大幅鼠标动作...');
      try { await sendToContent({ type: 'BIG_MOUSE_MOVE' }); } catch (e) {}
      await new Promise(function (r) { setTimeout(r, 500 + Math.random() * 300); });
    }
  }

  log('[恢复] ' + maxAttempts + ' 次尝试均失败，放弃恢复');
  return false;
}

function waitForContentScript(tabId) {
  return new Promise(function (resolve) {
    var attempts = 0;
    var maxAttempts = 20; // 10 秒
    var check = function () {
      attempts++;
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, function (response) {
        if (chrome.runtime.lastError || !response) {
          if (attempts < maxAttempts) {
            setTimeout(check, 500);
          } else {
            resolve(false);
          }
        } else {
          resolve(true);
        }
      });
    };
    check();
  });
}

// ======================= 向 content script 发送消息 =======================

function sendToContent(message) {
  return new Promise(function (resolve, reject) {
    if (!state.xhsTabId) {
      reject(new Error('小红书标签页未找到'));
      return;
    }
    // 超时保护：避免 content script 无响应导致采集永久卡住（服务中断）
    var timeout = 120000; // 2 分钟超时（详情采集可能较久）
    if (message.type === 'COLLECT') timeout = 600000; // COLLECT 最多 10 分钟
    if (message.type === 'STOP' || message.type === 'PING' || message.type === 'CHECK_STATUS') timeout = 5000;
    if (message.type === 'SEARCH' || message.type === 'SCROLL' || message.type === 'SCROLL_TO_TOP' || message.type === 'BIG_MOUSE_MOVE' || message.type === 'DEEP_INTERACTION') timeout = 120000;

    var settled = false;
    var timer = setTimeout(function () {
      if (!settled) {
        settled = true;
        if (doneHandler) chrome.runtime.onMessage.removeListener(doneHandler);
        reject(new Error('content script 超时无响应 (' + message.type + ', ' + timeout + 'ms)'));
      }
    }, timeout);

    // COLLECT 备用接收通道：content.js 通过 chrome.runtime.sendMessage 发送 COLLECT_DONE
    // 防止 sendResponse 因 SW 短暂终止导致消息通道断裂而静默失败
    var doneHandler = null;
    var progressCompleteReceived = false;  // PROGRESS complete 信号（第三道保险）
    if (message.type === 'COLLECT') {
      doneHandler = function (msg, sender, sendResp) {
        if (msg && msg.type === 'COLLECT_DONE') {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            chrome.runtime.onMessage.removeListener(doneHandler);
            doneHandler = null;
            if (msg.ok) {
              log('[采集] 通过备用通道收到 COLLECT_DONE 结果');
              resolve({ ok: true, data: msg.data });
            } else {
              reject(new Error(msg.error || '采集失败'));
            }
          }
          sendResp({ ok: true });
          return false;
        }
        // 第三道保险：收到 PROGRESS complete 说明采集已完成
        // 但 COLLECT_DONE 和 sendResponse 都可能丢失（MV3 长时间操作后消息通道静默关闭）
        // 此时启动 15 秒等待，若 COLLECT_DONE 仍未到达，主动向 content.js 查询结果
        if (msg && msg.type === 'PROGRESS' && msg.phase === 'complete' && !progressCompleteReceived) {
          progressCompleteReceived = true;
          log('[采集] 收到 PROGRESS complete，等待 COLLECT_DONE...');
          var completeKeyword = msg.keyword;
          setTimeout(function () {
            if (!settled) {
              log('[采集] COLLECT_DONE 未到达，主动查询 content.js 结果...');
              // 向 content.js 发送 GET_RESULT 消息查询采集结果
              chrome.tabs.sendMessage(state.xhsTabId, { type: 'GET_RESULT' }, function (resp) {
                if (chrome.runtime.lastError || !resp || !resp.ok) {
                  // 查询也失败，从 IndexedDB 读取增量保存的数据
                  if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    if (doneHandler) {
                      chrome.runtime.onMessage.removeListener(doneHandler);
                      doneHandler = null;
                    }
                    log('[采集] 查询也失败，从 IndexedDB 读取增量保存数据...');
                    // 从 IndexedDB 读取该关键词的增量保存数据
                    readKeywordResult(completeKeyword).then(function (dbResult) {
                      if (dbResult && dbResult.details && dbResult.details.length > 0) {
                        log('[采集] 从 IndexedDB 恢复: ' + dbResult.notes.length + ' 笔记, ' + dbResult.details.length + ' 详情');
                        resolve({ ok: true, data: {
                          notes: dbResult.notes || [],
                          details: dbResult.details || [],
                          failures: dbResult.failures || [],
                          stopped: false,
                          recovered: true,
                          recoveredFrom: 'indexeddb',
                        }});
                      } else {
                        log('[采集] IndexedDB 无数据，使用空结果恢复');
                        resolve({ ok: true, data: { notes: [], details: [], failures: [], stopped: false, recovered: true } });
                      }
                    }).catch(function (e) {
                      log('[采集] IndexedDB 读取失败: ' + e.message);
                      resolve({ ok: true, data: { notes: [], details: [], failures: [], stopped: false, recovered: true } });
                    });
                  }
                  return;
                }
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  if (doneHandler) {
                    chrome.runtime.onMessage.removeListener(doneHandler);
                    doneHandler = null;
                  }
                  log('[采集] 通过 GET_RESULT 恢复结果');
                  resolve({ ok: true, data: resp.data });
                }
              });
            }
          }, 15000);
        }
      };
      chrome.runtime.onMessage.addListener(doneHandler);
    }

    chrome.tabs.sendMessage(state.xhsTabId, message, function (response) {
      if (settled) return; // 已通过备用通道或超时处理

      // MV3 长操作后消息通道可能已被 Chrome 静默关闭
      // 此时 lastError 会被设置，但 COLLECT_DONE 备用消息可能仍在路上
      // 不立即移除 doneHandler，等待 5 秒让 COLLECT_DONE 有机会到达
      if (chrome.runtime.lastError && doneHandler && message.type === 'COLLECT') {
        var lastErrMsg = chrome.runtime.lastError.message;  // 必须缓存：lastError 在回调返回后会被 Chrome 清空
        log('[采集] 消息通道可能已关闭: ' + lastErrMsg + '，等待 COLLECT_DONE...');
        setTimeout(function () {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            if (doneHandler) {
              chrome.runtime.onMessage.removeListener(doneHandler);
              doneHandler = null;
            }
            reject(new Error(lastErrMsg));
          }
        }, 5000);
        return;
      }

      // SEARCH/SCROLL 等消息遇到 bfcache 时，延迟 3 秒再 reject（给页面恢复时间）
      if (chrome.runtime.lastError && message.type !== 'COLLECT') {
        var errMsg = chrome.runtime.lastError.message;
        setTimeout(function () {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            if (doneHandler) {
              chrome.runtime.onMessage.removeListener(doneHandler);
              doneHandler = null;
            }
            reject(new Error(errMsg));
          }
        }, 3000);
        return;
      }

      settled = true;
      clearTimeout(timer);
      if (doneHandler) {
        chrome.runtime.onMessage.removeListener(doneHandler);
        doneHandler = null;
      }
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ======================= 采集流程 =======================

async function startCollection(keywords, options) {
  if (state.collecting) {
    throw new Error('正在采集中，请先停止');
  }

  // 解析关键词（支持逗号分隔）
  var keywordList = keywords
    .split(/[,，\n]/)
    .map(function (k) { return k.trim(); })
    .filter(function (k) { return k.length > 0; });

  if (keywordList.length === 0) {
    throw new Error('请输入至少一个关键词');
  }

  state.collecting = true;
  state.keywordQueue = keywordList;
  state.totalPages = options.pages || 3;
  state.feedDelayMin = options.feedDelayMin || 3000;
  state.feedDelayMax = options.feedDelayMax || 6000;
  state.deepInteractionInterval = options.deepInteractionInterval !== undefined ? options.deepInteractionInterval : 10;
  state.progress = null;

  // 清除 user_stopped 标记
  chrome.storage.session.remove('user_stopped');

  // 清除可能残留的 alarm（不再创建新 alarm，端口保活已足够）
  stopAlarmKeepalive();

  saveState();

  // 确保标签页就绪
  log('确保小红书标签页就绪...');
  await ensureXhsTab();

  // 顺序采集每个关键词
  var allResults = [];
  var keywordCount = 0; // 已采集完成的关键词数

  while (state.keywordQueue.length > 0) {
    if (!state.collecting) {
      log('采集已停止');
      break;
    }

    var keyword = state.keywordQueue.shift();
    state.currentKeyword = keyword;
    saveState();

    log('开始采集关键词: ' + keyword);

    var keywordRetried = false; // 当前关键词是否已因 300011 重试过
    while (true) {
      if (!state.collecting) break;

      try {
        // === 搜索(content.js行为模拟) → 滚动(executeScript) → 回顶部(executeScript) → 采集 ===
        // 搜索用 content.js 消息（有人类行为模拟），滚动/回顶部用 executeScript（可靠）

        // 1. 页面搜索框输入关键词（content.js 执行 searchOnPage，含鼠标移动+逐字输入）
        log('[行为] 页面搜索: ' + keyword);
        try {
          var searchR = await sendToContent({ type: 'SEARCH', keyword: keyword });
          log('[行为] 搜索结果: ' + (searchR && searchR.ok ? 'ok' : (searchR && searchR.error || 'fail')));
        } catch (e) {
          log('[行为] 页面搜索异常（可能触发导航）: ' + e.message);
          // 搜索异常时也发 STOP，防止 content.js 的 collecting 标志残留
          try { await sendToContent({ type: 'STOP' }); } catch (stopErr) {}
          // bfcache 错误：页面被移入前进/后退缓存，需要等待页面恢复
          if (e.message && e.message.indexOf('back/forward cache') !== -1) {
            log('[行为] 检测到 bfcache，等待页面恢复...');
            await new Promise(function (r) { setTimeout(r, 3000); });
          }
        }

        // 等待搜索结果加载（SPA 导航 + DOM 渲染）
        await new Promise(function (r) { setTimeout(r, 3000); });

        // 关闭AI推荐弹窗（搜索后可能出现，遮挡搜索结果）- 深度人类行为模拟
        try {
          await chrome.scripting.executeScript({
            target: { tabId: state.xhsTabId },
            func: function () {
              function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
              return (async function () {
                var closeBtn = document.querySelector('button.xhs-ai-chat-header__close');
                if (!closeBtn) return { ok: false, reason: 'not_found' };

                var rect = closeBtn.getBoundingClientRect();
                var targetX = rect.left + rect.width / 2;
                var targetY = rect.top + rect.height / 2;

                // 贝塞尔轨迹鼠标移动（3种加速度模式随机）
                var startX = Math.max(0, targetX - 150 - Math.floor(Math.random() * 200));
                var startY = Math.max(0, targetY - 100 - Math.floor(Math.random() * 150));
                var steps = 8 + Math.floor(Math.random() * 8);
                var accelMode = Math.floor(Math.random() * 3);
                for (var i = 0; i <= steps; i++) {
                  var t = i / steps;
                  var eased;
                  if (accelMode === 0) eased = 1 - Math.pow(1 - t, 3);
                  else if (accelMode === 1) eased = Math.pow(t, 3);
                  else eased = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
                  document.dispatchEvent(new MouseEvent('mousemove', {
                    bubbles: true, cancelable: true, view: window,
                    clientX: Math.round(startX + (targetX - startX) * eased + (Math.random() * 8 - 4)),
                    clientY: Math.round(startY + (targetY - startY) * eased + (Math.random() * 8 - 4)),
                  }));
                  if (i % 4 === 0) await sleep(10 + Math.random() * 15);
                }

                // 悬停微抖
                var mouseOpts = { bubbles: true, cancelable: true, view: window, clientX: Math.round(targetX), clientY: Math.round(targetY) };
                try {
                  closeBtn.dispatchEvent(new MouseEvent('mouseenter', mouseOpts));
                  closeBtn.dispatchEvent(new MouseEvent('mouseover', mouseOpts));
                } catch (e) {}
                await sleep(150 + Math.random() * 200);
                for (var j = 0; j < 8; j++) {
                  document.dispatchEvent(new MouseEvent('mousemove', {
                    bubbles: true, cancelable: true, view: window,
                    clientX: Math.round(targetX + (Math.random() * 6 - 3)),
                    clientY: Math.round(targetY + (Math.random() * 6 - 3)),
                  }));
                  await sleep(20 + Math.random() * 30);
                }

                // 完整点击事件链
                try { closeBtn.dispatchEvent(new MouseEvent('mousedown', mouseOpts)) } catch (e) {}
                await sleep(50 + Math.random() * 50);
                try { closeBtn.dispatchEvent(new MouseEvent('mouseup', mouseOpts)) } catch (e) {}
                await sleep(20 + Math.random() * 30);
                if (typeof closeBtn.click === 'function') closeBtn.click();
                else { try { closeBtn.dispatchEvent(new MouseEvent('click', mouseOpts)) } catch (e) {} }

                console.log('[行为] AI推荐弹窗已关闭');
                return { ok: true };
              })();
            },
          });
        } catch (e) {}

        // 重新检测 content script（搜索可能触发导航导致 content script 重新加载）
        var csReady = await waitForContentScript(state.xhsTabId);
        if (!csReady) {
          log('[行为] Content script 未就绪，重新注入...');
          await injectContentScripts(state.xhsTabId);
          await new Promise(function (r) { setTimeout(r, 1500); });
        }

        // 2. 滚动加载（通过 executeScript，自动查找滚动容器）
        log('[行为] 滚动加载笔记...');
        var scrollTimes = 5 + Math.floor(Math.random() * 4); // 5-8次随机滚动
        await scrollViaScripting(state.xhsTabId, scrollTimes);

        // 3. 回顶部（通过 executeScript）
        log('[行为] 回到顶部...');
        await scrollToTopViaScripting(state.xhsTabId);
        await new Promise(function (r) { setTimeout(r, 1000); });

        // 4. 采集（content.js 执行 API 搜索 + 详情采集）
        // 即使 state.collecting 在 await 期间被设为 false，content.js 也会检测到并返回 stopped=true
        var response = await sendToContent({
          type: 'COLLECT',
          keyword: keyword,
          pages: state.totalPages,
          feedDelayMin: state.feedDelayMin,
          feedDelayMax: state.feedDelayMax,
          deepInteractionInterval: state.deepInteractionInterval,
        });

        log('[采集] COLLECT 响应已收到: ' + (response ? (response.ok ? 'ok' : response.error) : 'null'));

        // 停止后立即退出，不处理结果
        if (!state.collecting) {
          log('采集已停止，退出关键词循环');
          break;
        }

        if (response && response.ok) {
          var data = response.data;
          var keywordResult = {
            keyword: keyword,
            notes: data.notes,
            details: data.details,
            failures: data.failures,
            stopped: data.stopped,
            reason: data.reason,
            lastErrorCode: data.lastErrorCode,
            lastErrorMsg: data.lastErrorMsg,
          };
          allResults.push(keywordResult);

          // 按关键词增量写入 IndexedDB（只写这一条，不影响其他关键词记录）
          await saveKeywordResult(keywordResult);

          if (data.stopped) {
            var stopReason = data.reason || '未知原因';
            if (data.reason === 'login_expired') {
              stopReason = '登录已过期，请重新登录小红书';
            } else if (data.reason === 'account_blocked') {
              stopReason = '账号异常（300011），可能被风控';
            } else if (data.reason === 'rate_limited') {
              stopReason = '触发限流/环境检测（code=' + data.lastErrorCode + '），停止采集';
            } else if (data.reason === 'search_all_failed') {
              stopReason = '搜索全部失败：code=' + data.lastErrorCode + ' msg=' + (data.lastErrorMsg || '');
            }
            log('采集被中断: ' + stopReason);

            // 300011 账号异常：循环操作恢复（不延迟5分钟）
            if (data.reason === 'account_blocked' && !keywordRetried && state.collecting) {
              log('[恢复] 300011 账号异常，开始循环恢复...');
              var recovered = await recoverFrom300011(state.xhsTabId);

              if (recovered && state.collecting) {
                keywordRetried = true;
                log('[恢复] 恢复成功，重试关键词: ' + keyword);
                continue; // 重试当前关键词
              } else {
                log('[恢复] 未能恢复，跳过当前关键词');
                break;
              }
            }

            // 登录过期直接停止
            if (data.reason === 'login_expired') {
              state.collecting = false;
            }
          } else {
            log('关键词 [' + keyword + '] 采集完成: ' +
              data.notes.length + ' 条笔记, ' + data.details.length + ' 条详情');
          }
          break; // 成功或不可恢复，跳出重试循环
        } else {
          log('采集失败: ' + (response ? response.error : '无响应'));
          // 发送 STOP 重置 content.js 的 collecting 标志（防止下个关键词卡在"正在采集中"）
          try { await sendToContent({ type: 'STOP' }); } catch (stopErr) {}
          break;
        }
      } catch (e) {
        // bfcache 错误：页面被移入前进/后退缓存
        if (e.message && e.message.indexOf('back/forward cache') !== -1) {
          log('采集异常（bfcache）: 点击笔记触发页面缓存，尝试恢复...');
          await new Promise(function (r) { setTimeout(r, 3000); });
          try {
            await ensureXhsTab();
          } catch (e2) {
            log('恢复失败: ' + e2.message);
          }
          break; // 跳出重试循环，继续下一个关键词
        }
        // 超时：尝试恢复后继续下一个关键词（避免卡死）
        if (e.message && e.message.indexOf('超时') !== -1) {
          log('采集超时: ' + e.message + '，尝试恢复后继续下一个关键词...');
          await new Promise(function (r) { setTimeout(r, 3000); });
          try {
            // 先发送 STOP 停止 content.js 可能仍在运行的采集
            try { await sendToContent({ type: 'STOP' }); } catch (stopErr) {}
            await ensureXhsTab();
          } catch (e2) {
            log('超时恢复失败: ' + e2.message);
          }
          break; // 跳出重试循环，继续下一个关键词
        }
        log('采集异常: ' + e.message);
        // 通用异常也发 STOP，防止 content.js 的 collecting 标志残留
        try { await sendToContent({ type: 'STOP' }); } catch (stopErr) {}
        break;
      }
    }

    keywordCount++;

    // 关键词间行为模拟：回首页 → 点击笔记 → 侧边栏菜单浏览（点点/世界杯/RED/直播/通知/我）
    if (state.keywordQueue.length > 0 && state.collecting) {
      var pauseMs = Math.floor(3000 + Math.random() * 2000);
      log('关键词间暂停 ' + (pauseMs / 1000) + 's...');
      await new Promise(function (r) { setTimeout(r, pauseMs); });

      if (state.collecting) {
        // navigateHomepageAndClick 会：导航到首页 → 点击笔记 → 关闭详情 → 额外点击 → 侧边栏菜单浏览
        // 不传 searchUrl（下一个关键词通过搜索框输入，不需要导航到搜索页）
        try {
          // 超时保护：防止 navigateHomepageAndClick 卡死
          var navResult = await Promise.race([
            navigateHomepageAndClick(null),
            new Promise(function (_, reject) {
              setTimeout(function () { reject(new Error('navigateHomepageAndClick 超时(60s)')); }, 60000);
            })
          ]);
          log('[行为] 关键词间行为模拟完成: ' + navResult);
          // 重新注入 content script（navigateHomepageAndClick 内部多次导航，需确保脚本就绪）
          await ensureXhsTab();
          log('[行为] 准备下一个关键词');
        } catch (e) {
          log('[行为] 关键词间行为模拟失败: ' + e.message + '，尝试恢复...');
          try {
            await pluginTabsUpdate(state.xhsTabId, { url: 'https://www.xiaohongshu.com/explore' });
            await new Promise(function (r) { setTimeout(r, 3000); });
            await ensureXhsTab();
          } catch (e2) {
            log('[行为] 恢复失败: ' + e2.message);
          }
        }
      }
    }
  }

  state.collecting = false;
  state.currentKeyword = '';
  stopAlarmKeepalive();
  saveState();

  log('采集完成，共 ' + allResults.length + ' 个关键词');
  return allResults;
}

function stopCollection(reason) {
  reason = reason || 'user_stopped';
  log('[停止] 正在停止采集... reason=' + reason);
  state.collecting = false;
  state.currentKeyword = '';
  state.keywordQueue = [];
  state.progress = { phase: 'complete', stopped: true, reason: reason };

  // 停止 alarm 兜底保活
  stopAlarmKeepalive();

  saveState();

  // 只有用户主动停止才写入 user_stopped 标记
  // 其他原因（标签页关闭、刷新、SW 重启）不写，避免污染状态
  if (reason === 'user_stopped') {
    chrome.storage.session.set({ user_stopped: true });
  }

  // 通知 content script 停止
  // 用 chrome.tabs.sendMessage 直接发送，不经过 sendToContent 的超时包装
  // 因为 onMessage 是事件监听，content script 即使在跑 COLLECT 也能收到 STOP
  if (state.xhsTabId) {
    chrome.tabs.sendMessage(state.xhsTabId, { type: 'STOP' }, function () {
      if (chrome.runtime.lastError) {
        log('[停止] 通知 content script 失败: ' + chrome.runtime.lastError.message);
      } else {
        log('[停止] 已通知 content script 停止');
      }
    });
  }

  // 发送停止进度
  chrome.runtime.sendMessage({
    type: 'PROGRESS',
    phase: 'complete',
    stopped: true,
    reason: reason,
  }).catch(function () {});
}

// ======================= 结果存储（IndexedDB） =======================
//
// 使用 IndexedDB 按关键词分记录存储，解决 chrome.storage.local 单键存储在大数据量
// （10000+ 笔记，140MB+）下的性能与配额问题：
//   - 每个关键词一条记录（keyPath='keyword'），put 增量写入，无需重写整库
//   - 导出时 sidebar 直接打开同一 IndexedDB（扩展同源），避免通过 sendMessage
//     传递 100MB+ 数据造成卡顿/失败
//
// 数据库结构：
//   DB_NAME = 'xhs_collector'
//   STORE_NAME = 'results'  (keyPath='keyword')
//   记录字段：{ keyword, notes, details, failures, stopped, reason, savedAt }

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
 * 按关键词保存/更新一条采集结果（增量写入，不影响其他关键词）
 */
async function saveKeywordResult(result) {
  var db = await openDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(STORE_NAME, 'readwrite');
    var store = tx.objectStore(STORE_NAME);
    var record = Object.assign({}, result, { savedAt: Date.now() });
    store.put(record);
    tx.oncomplete = function () {
      db.close();
      var notesCount = (result.notes || []).length;
      var detailsCount = (result.details || []).length;
      log('结果已保存到 IndexedDB [关键词=' + result.keyword + ']: ' +
        notesCount + ' 笔记, ' + detailsCount + ' 详情');
      resolve();
    };
    tx.onerror = function (e) {
      db.close();
      reject(e.target.error);
    };
  });
}

/**
 * 从 IndexedDB 读取指定关键词的采集结果（用于 COLLECT 响应丢失时恢复数据）
 */
async function readKeywordResult(keyword) {
  var db = await openDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(STORE_NAME, 'readonly');
    var store = tx.objectStore(STORE_NAME);
    var req = store.get(keyword);
    req.onsuccess = function (e) {
      db.close();
      resolve(e.target.result || null);
    };
    req.onerror = function (e) {
      db.close();
      reject(e.target.error);
    };
  });
}

/**
 * 读取所有关键词的采集结果
 */
async function getResults() {
  var db = await openDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(STORE_NAME, 'readonly');
    var store = tx.objectStore(STORE_NAME);
    var req = store.getAll();
    req.onsuccess = function (e) {
      db.close();
      var results = e.target.result || [];
      // 按 savedAt 升序排列，保持采集先后顺序
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
 * 获取结果记录数（用于 UI 判空，比 getAll 更轻量）
 */
async function getResultCount() {
  var db = await openDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(STORE_NAME, 'readonly');
    var store = tx.objectStore(STORE_NAME);
    var req = store.count();
    req.onsuccess = function (e) {
      db.close();
      resolve(e.target.result || 0);
    };
    req.onerror = function (e) {
      db.close();
      reject(e.target.error);
    };
  });
}

function clearResults() {
  return new Promise(function (resolve) {
    // 通知 content script 停止采集（用 chrome.tabs.sendMessage 直接发送，
    // 不经过 sendToContent，因为 onMessage 事件不阻塞）
    var stopPromise = Promise.resolve();
    var sendStop = function (tabId) {
      if (!tabId) return Promise.resolve();
      return new Promise(function (res) {
        chrome.tabs.sendMessage(tabId, { type: 'STOP' }, function () {
          if (chrome.runtime.lastError) {
            log('[清空] 通知 content script 停止失败: ' + chrome.runtime.lastError.message);
          }
          res();
        });
      });
    };

    if (state.xhsTabId) {
      stopPromise = sendStop(state.xhsTabId);
    } else {
      stopPromise = findXhsTab().then(function (tab) {
        if (tab) {
          state.xhsTabId = tab.id;
          return sendStop(tab.id);
        }
      });
    }

    stopPromise.then(async function () {
      // 清空 IndexedDB results 表
      try {
        var db = await openDB();
        await new Promise(function (res, rej) {
          var tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).clear();
          tx.oncomplete = function () { res(); };
          tx.onerror = function (e) { rej(e.target.error); };
        });
        db.close();
        log('[清空] IndexedDB results 表已清空');
      } catch (e) {
        log('[清空] IndexedDB 清空失败: ' + e.message);
      }
      // 同时清除遗留的 xhs_state（旧版可能存有 xhs_results，一并清理）
      chrome.storage.local.remove(['xhs_results', 'xhs_state'], function () {
        state.collecting = false;
        state.progress = null;
        state.currentKeyword = '';
        state.keywordQueue = [];
        // 清空不写 user_stopped 标记（清空 ≠ 用户停止采集）
        resolve();
      });
    });
  });
}

// ======================= 消息监听 =======================

// 保活连接：content script 采集期间保持长连接，防止 SW 休眠
// MV3 中 setTimeout 不能保持 SW 活跃，但活跃端口可以
chrome.runtime.onConnect.addListener(function (port) {
  if (port.name === 'keepalive') {
    log('[保活] content script 已连接保活端口');
    // 只要有活跃端口连接，SW 就不会休眠
    port.onDisconnect.addListener(function () {
      log('[保活] content script 断开保活端口');
    });
  }
});

// chrome.alarms 兜底保活：即使端口保活失败（SW 被终止），alarm 也能唤醒 SW
// alarm 最小周期 1 分钟，唤醒后 SW 会重新检查采集状态
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'keepalive') {
    if (state.collecting) {
      log('[保活] alarm 触发，采集进行中');
    } else {
      // 未在采集但 alarm 仍触发 → 说明 stopAlarmKeepalive 没生效，立即清除
      log('[保活] alarm 触发，但未在采集，立即清除 alarm');
      stopAlarmKeepalive();
    }
  }
});

function startAlarmKeepalive() {
  chrome.alarms.create('keepalive', { periodInMinutes: 1 });
  log('[保活] alarm 已创建（1分钟周期）');
}

function stopAlarmKeepalive() {
  // 用 clearAll 确保彻底清除所有 alarm（防止 clear 按名字不生效的边缘情况）
  chrome.alarms.clearAll().then(function () {
    log('[保活] alarm 已清除');
  }).catch(function (e) {
    log('[保活] alarm 清除失败: ' + (e && e.message || e));
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  // 在 MAIN world 执行行为模拟（和 CALL_MNSV2 同样方式，更可靠）
  if (message.type === 'SIMULATE_BEHAVIOR') {
    var simTabId = sender.tab && sender.tab.id;
    if (!simTabId) {
      sendResponse({ ok: false, error: '无标签页' });
      return false;
    }
    chrome.scripting.executeScript({
      target: { tabId: simTabId },
      world: 'MAIN',
      func: function (action, params) {
        try {
          // 滚动行为
          if (action === 'browsing' || action === 'scroll') {
            var targetY = params.targetY;
            if (targetY === undefined) {
              targetY = Math.random() > 0.5
                ? document.body.scrollHeight * 0.5
                : document.body.scrollHeight * 0.3;
            }
            var startY = window.scrollY;
            var distance = targetY - startY;
            var steps = 20;
            var currentStep = 0;
            return new Promise(function (resolve) {
              function step() {
                if (currentStep >= steps) {
                  window.scrollTo(0, targetY);
                  resolve({ ok: true, action: 'scroll', from: startY, to: targetY });
                  return;
                }
                var progress = currentStep / steps;
                // 缓动函数
                var eased = progress < 0.5
                  ? 2 * progress * progress
                  : 1 - Math.pow(-2 * progress + 2, 2) / 2;
                window.scrollTo(0, startY + distance * eased);
                currentStep++;
                setTimeout(step, 30 + Math.random() * 20);
              }
              step();
            });
          }

          // 鼠标移动（贝塞尔曲线轨迹）
          if (action === 'mousemove' || action === 'reading') {
            var fromX = params.fromX !== undefined ? params.fromX : Math.random() * window.innerWidth;
            var fromY = params.fromY !== undefined ? params.fromY : Math.random() * window.innerHeight;
            var toX = params.toX !== undefined ? params.toX : Math.random() * window.innerWidth;
            var toY = params.toY !== undefined ? params.toY : Math.random() * window.innerHeight;

            // 贝塞尔曲线控制点
            var cx1 = fromX + (toX - fromX) * 0.25 + Math.random() * 50 - 25;
            var cy1 = fromY + (toY - fromY) * 0.25 + Math.random() * 50 - 25;
            var cx2 = fromX + (toX - fromX) * 0.75 + Math.random() * 50 - 25;
            var cy2 = fromY + (toY - fromY) * 0.75 + Math.random() * 50 - 25;

            var mouseSteps = 25;
            var currentIdx = 0;
            return new Promise(function (resolve) {
              function moveNext() {
                if (currentIdx >= mouseSteps) {
                  resolve({ ok: true, action: action, to: { x: toX, y: toY } });
                  return;
                }
                var t = currentIdx / mouseSteps;
                var x = Math.pow(1-t, 3) * fromX +
                        3 * Math.pow(1-t, 2) * t * cx1 +
                        3 * (1-t) * Math.pow(t, 2) * cx2 +
                        Math.pow(t, 3) * toX;
                var y = Math.pow(1-t, 3) * fromY +
                        3 * Math.pow(1-t, 2) * t * cy1 +
                        3 * (1-t) * Math.pow(t, 2) * cy2 +
                        Math.pow(t, 3) * toY;
                document.dispatchEvent(new MouseEvent('mousemove', {
                  bubbles: true,
                  clientX: Math.round(x),
                  clientY: Math.round(y),
                  screenX: Math.round(x),
                  screenY: Math.round(y) + window.screenTop,
                  view: window
                }));
                currentIdx++;
                setTimeout(moveNext, 40 + Math.random() * 30);
              }
              moveNext();
            });
          }

          return { ok: false, error: '未知行为: ' + action };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
      args: [message.action || 'browsing', message.params || {}]
    }, function (results) {
      if (chrome.runtime.lastError) {
        log('SIMULATE_BEHAVIOR 错误: ' + chrome.runtime.lastError.message);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else if (results && results[0]) {
        // executeScript 返回的 Promise 会被自动 await
        var r = results[0].result;
        if (r && r.then) {
          r.then(function (v) {
            log('SIMULATE_BEHAVIOR 完成: ' + (v.action || '') + (v.to ? ' -> (' + Math.round(v.to.x) + ',' + Math.round(v.to.y) + ')' : ''));
            sendResponse(v);
          }).catch(function (e) {
            log('SIMULATE_BEHAVIOR Promise 异常: ' + e.message);
            sendResponse({ ok: false, error: e.message });
          });
        } else {
          log('SIMULATE_BEHAVIOR 完成: ' + (r && r.action ? r.action : JSON.stringify(r)));
          sendResponse(r || { ok: false, error: '无结果' });
        }
      } else {
        sendResponse({ ok: false, error: 'executeScript 无结果' });
      }
    });
    return true;
  }

  // 来自 content script 的进度消息
  if (message.type === 'PROGRESS') {
    state.progress = message;
    saveState();
    // 所有阶段都记录到日志（方便调试）
    {
      var logMsg = '进度: ' + message.phase +
        (message.keyword ? ' keyword=' + message.keyword : '') +
        (message.page ? ' page=' + message.page : '') +
        (message.code !== undefined ? ' code=' + message.code : '') +
        (message.error ? ' error=' + message.error : '') +
        (message.msg ? ' msg=' + message.msg : '') +
        (message.notesCount !== undefined ? ' notes=' + message.notesCount : '') +
        (message.detailsCount !== undefined ? ' details=' + message.detailsCount : '') +
        (message.failuresCount !== undefined ? ' fails=' + message.failuresCount : '') +
        (message.current !== undefined ? ' current=' + message.current + '/' + message.total : '') +
        (message.success !== undefined ? ' success=' + message.success : '') +
        (message.fail !== undefined ? ' fail=' + message.fail : '') +
        (message.behaviorCount !== undefined ? ' behavior=' + message.behaviorCount : '') +
        (message.clickCount !== undefined ? ' click=' + message.clickCount : '') +
        (message.action ? ' action=' + message.action : '') +
        (message.stopped ? ' STOPPED' : '') +
        (message.reason ? ' reason=' + message.reason : '');
      log(logMsg);
    }
    sendResponse({ ok: true });
    return false;
  }

  // 增量保存：content.js 每采集 10 条详情发送一次，保存到 IndexedDB
  // 防止 COLLECT 响应丢失导致整个关键词数据全部丢失
  if (message.type === 'INCREMENT_SAVE') {
    var incResult = {
      keyword: message.keyword,
      notes: message.notes || [],
      details: message.details || [],
      failures: message.failures || [],
      stopped: false,
      incremental: true,
    };
    saveKeywordResult(incResult).then(function () {
      log('[采集] 增量保存成功 [关键词=' + message.keyword + ']: ' +
        incResult.notes.length + ' 笔记, ' + incResult.details.length + ' 详情');
    }).catch(function (e) {
      log('[采集] 增量保存失败: ' + e.message);
    });
    sendResponse({ ok: true });
    return false;
  }

  // content script 日志转发到 sidebar 控制台
  if (message.type === 'CONTENT_LOG') {
    var csLogMsg = '[content] ' + message.message;
    console.log('[bg] ' + csLogMsg);
    try {
      chrome.runtime.sendMessage({
        type: 'CONSOLE_LOG',
        message: csLogMsg,
        level: message.level || 'info',
        timestamp: message.timestamp || Date.now(),
      }).catch(function () {});
    } catch (e) {}
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'CONTENT_READY') {
    log('内容脚本就绪: ' + message.url);
    sendResponse({ ok: true });
    return false;
  }

  // MV3 keepalive: 保持 Service Worker 活跃，防止长操作期间被终止
  if (message.type === 'KEEPALIVE') {
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'MNSV2_READY') {
    state.mnsv2Ready = true;
    saveState();
    log('mnsv2 就绪, rapParams: ' + JSON.stringify(message.rapParams));
    sendResponse({ ok: true });
    return false;
  }

  // 来自 popup 的命令
  if (message.type === 'START_COLLECTION') {
    // 立即响应，避免长时间采集期间 sidepanel 关闭导致消息通道关闭
    // 采集进度通过 PROGRESS 消息和 GET_STATUS 轮询获取
    sendResponse({ ok: true, started: true });
    var waitStart = _initDone ? Promise.resolve() : _initPromise;
    waitStart.then(function () {
      startCollection(message.keyword, {
        pages: message.pages,
        feedDelayMin: message.feedDelayMin,
        feedDelayMax: message.feedDelayMax,
      }).catch(function (err) {
        log('采集异常: ' + err.message);
        state.collecting = false;
        state.progress = { phase: 'complete', stopped: true, reason: 'error: ' + err.message };
        saveState();
      });
    });
    return false; // 同步响应，不需要保持通道
  }

  if (message.type === 'STOP_COLLECTION') {
    var waitStop = _initDone ? Promise.resolve() : _initPromise;
    waitStop.then(function () {
      stopCollection();
      sendResponse({ ok: true });
    });
    return true; // 异步响应
  }

  if (message.type === 'GET_STATUS') {
    // 等待 SW 初始化完成，避免 loadState 覆盖初始化逻辑设置的 collecting=false
    // 问题场景：SW 重启初始化设置了 collecting=false 并 saveState，
    // 但 GET_STATUS 中的 loadState 从 storage 读到旧值 collecting=true 并 Object.assign 覆盖
    var waitInit = _initDone ? Promise.resolve() : _initPromise;
    waitInit.then(function () {
      sendResponse({
        ok: true,
        state: {
          collecting: state.collecting,
          currentKeyword: state.currentKeyword,
          keywordQueue: state.keywordQueue,
          progress: state.progress,
          mnsv2Ready: state.mnsv2Ready,
          xhsTabId: state.xhsTabId,
        }
      });
    });
    return true; // 异步响应
  }

  if (message.type === 'GET_RESULTS') {
    getResults().then(function (results) {
      sendResponse({ ok: true, results: results });
    });
    return true;
  }

  if (message.type === 'CLEAR_RESULTS') {
    var waitClear = _initDone ? Promise.resolve() : _initPromise;
    waitClear.then(function () {
      clearResults().then(function () {
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (message.type === 'OPEN_XHS_TAB') {
    chrome.tabs.create({ url: 'https://www.xiaohongshu.com/explore' });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'CHECK_CONTENT_STATUS') {
    if (state.xhsTabId) {
      sendToContent({ type: 'CHECK_STATUS' })
        .then(function (resp) { sendResponse(resp); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
    } else {
      findXhsTab().then(function (tab) {
        if (tab) {
          state.xhsTabId = tab.id;
          sendToContent({ type: 'CHECK_STATUS' })
            .then(function (resp) { sendResponse(resp); })
            .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
        } else {
          sendResponse({ ok: false, error: '未找到小红书标签页' });
        }
      });
    }
    return true;
  }

  if (message.type === 'INJECT_MAIN_WORLD') {
    var tabId = message.tabId || state.xhsTabId || (sender.tab && sender.tab.id);
    if (!tabId) {
      sendResponse({ ok: false, error: '无标签页 ID' });
      return false;
    }
    injectMainWorldScript(tabId)
      .then(function () { sendResponse({ ok: true }); })
      .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  // 直接在 MAIN world 调用 window.mnsv2（绕过 CustomEvent，更可靠）
  if (message.type === 'CALL_MNSV2') {
    var mnsv2TabId = sender.tab && sender.tab.id;
    log('CALL_MNSV2 收到, tabId=' + mnsv2TabId + ', c.length=' + (message.c || '').length);
    if (!mnsv2TabId) {
      sendResponse({ ok: false, error: '无标签页' });
      return false;
    }
    chrome.scripting.executeScript({
      target: { tabId: mnsv2TabId },
      world: 'MAIN',
      func: function (c, u, p) {
        // 用 try-catch 包裹，避免抛错导致回调不触发
        try {
          if (typeof window.mnsv2 !== 'function') {
            return { __error: 'window.mnsv2 不可用 (type=' + typeof window.mnsv2 + ')' };
          }
          var v = window.mnsv2(c, u, p);
          if (!v) return { __error: 'mnsv2 返回空值' };
          return { __v: v };
        } catch (e) {
          return { __error: 'mnsv2 执行异常: ' + e.message };
        }
      },
      args: [message.c, message.u, message.p]
    }, function (results) {
      if (chrome.runtime.lastError) {
        log('CALL_MNSV2 executeScript 错误: ' + chrome.runtime.lastError.message);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      if (!results || !results[0]) {
        log('CALL_MNSV2 无结果');
        sendResponse({ ok: false, error: 'executeScript 无结果' });
        return;
      }
      var r = results[0].result;
      log('CALL_MNSV2 结果: ' + (r && r.__error ? 'ERROR: ' + r.__error : 'OK, v.length=' + (r && r.__v ? String(r.__v).length : 0)));
      if (r && r.__error) {
        sendResponse({ ok: false, error: r.__error });
      } else if (r && r.__v !== undefined) {
        sendResponse({ ok: true, v: r.__v });
      } else {
        sendResponse({ ok: false, error: 'mnsv2 返回格式异常' });
      }
    });
    return true;
  }

  // 深度交互：在新 tab 中打开笔记，执行随机动作（点赞/收藏/关注/深度阅读/访问用户主页）
  // 由 content.js 在采集每 N 条笔记后发送，包含可选笔记列表
  if (message.type === 'DEEP_INTERACTION_TABS') {
    var interactionNotes = message.notes || [];
    if (interactionNotes.length === 0) {
      sendResponse({ ok: true, interacted: 0 });
      return false;
    }

    // content.js 已选好 1 条笔记，直接使用
    var selectedNotes = interactionNotes;

    log('[深度交互] 选择 ' + selectedNotes.length + ' 条笔记进行新tab深度交互');

    (async function () {
      var interacted = 0;
      for (var i = 0; i < selectedNotes.length; i++) {
        if (!state.collecting) break;
        var note = selectedNotes[i];
        var noteUrl = 'https://www.xiaohongshu.com/explore/' + note.noteId
          + '?xsec_token=' + note.xsecToken + '&xsec_source=pc_search&source=web_explore_feed';

        log('[深度交互] (' + (i + 1) + '/' + selectedNotes.length + ') 打开: ' + note.noteId);

        var tab = null;
        try {
          // 在后台新 tab 中打开笔记
          tab = await chrome.tabs.create({ url: noteUrl, active: false });

          // 轮询等待 content script 就绪且页面完全加载（最多 30 秒）
        var ready = false;
        for (var attempt = 0; attempt < 60; attempt++) {
          await new Promise(function (r) { setTimeout(r, 500); });
          // 10 秒后尝试主动注入 content script（MV3 可能不会自动注入）
          if (attempt === 20) {
            try {
              await injectContentScripts(tab.id);
              log('[深度交互] 主动注入 content script');
            } catch (e) {
              log('[深度交互] 注入 content script 失败: ' + e.message);
            }
          }
          try {
            var pingResp = await new Promise(function (resolve, reject) {
              chrome.tabs.sendMessage(tab.id, { type: 'PING' }, function (response) {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                } else {
                  resolve(response);
                }
              });
            });
            // 必须同时满足：content script 响应 + readyState === 'complete'
            // 避免页面还在 loading/interactive 阶段就发送交互指令，
            // 导致后续 onTabUpdated 监听器误捕获页面加载过程中的 loading 事件
            if (pingResp && pingResp.ok && pingResp.readyState === 'complete') {
              ready = true;
              break;
            }
          } catch (e) {
            // content script 尚未就绪
          }
        }

        if (!ready) {
          log('[深度交互] content script 未就绪或页面未完全加载，跳过此笔记');
          try { await chrome.tabs.remove(tab.id); } catch (e) {}
          continue;
        }

        // 发送深度交互指令到新 tab
        log('[深度交互] 发送交互指令到 tab ' + tab.id);
        var interactionStart = Date.now();
        // 宽限期：交互开始后的前 3 秒忽略所有导航事件
        // 页面 SPA 路由可能在加载后仍有二次导航（如重定向、路由参数更新），需要给页面稳定的时间
        var NAV_GRACE_PERIOD = 3000;
        var interactionResult = await new Promise(function (resolve) {
          var settled = false;
          var timeout = setTimeout(function () {
            if (!settled) {
              settled = true;
              chrome.tabs.onUpdated.removeListener(onTabUpdated);
              resolve({ ok: false, error: '交互超时(120s)' });
            }
          }, 120000);

          // 监听 tab 导航：如果页面发生 SPA 跳转，content script 上下文会被销毁
          // 此时 sendMessage 回调永远不会触发，需要通过 onUpdated 检测并提前 resolve
          // 注意：
          //   1. visit_homepage 动作会主动导航到用户主页，属于预期行为（耗时 > 8s）
          //   2. 宽限期内（前 3 秒）的导航事件一律忽略（页面仍在稳定中）
          var onTabUpdated = function (tabId, info, tabInfo) {
            if (tabId === tab.id && info.status === 'loading' && !settled) {
              var elapsed = Date.now() - interactionStart;
              // 宽限期内忽略导航事件（页面加载后的二次稳定导航）
              if (elapsed < NAV_GRACE_PERIOD) {
                log('[深度交互] 宽限期内忽略导航事件（' + elapsed + 'ms），页面仍在稳定中');
                return;
              }
              settled = true;
              clearTimeout(timeout);
              chrome.tabs.onUpdated.removeListener(onTabUpdated);
              if (elapsed > 8000) {
                // 交互已执行超过 8 秒，可能是 SPA 路由变化导致的导航
                log('[深度交互] 检测到页面导航（耗时 ' + elapsed + 'ms），content script 可能已销毁');
                resolve({ ok: false, error: '页面导航导致交互中断' });
              } else {
                log('[深度交互] 检测到页面导航（交互早期），content script 可能已销毁');
                resolve({ ok: false, error: '页面导航导致交互中断' });
              }
            }
          };
          chrome.tabs.onUpdated.addListener(onTabUpdated);

          chrome.tabs.sendMessage(tab.id, { type: 'DEEP_INTERACTION_ON_PAGE' }, function (response) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(onTabUpdated);
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(response);
            }
          });
        });

          log('[深度交互] 结果: ' + (interactionResult && interactionResult.ok ? '成功' : (interactionResult && interactionResult.error || '失败')));
          interacted++;

          // 关闭 tab（无论成功失败）
          log('[深度交互] 关闭笔记详情 tab: ' + tab.id);
          try {
            await chrome.tabs.remove(tab.id);
            log('[深度交互] 笔记详情 tab 已关闭');
          } catch (e) {
            log('[深度交互] 关闭 tab 失败: ' + e.message, 'warn');
          }

          // tab 间间隔
          await new Promise(function (r) { setTimeout(r, 2000 + Math.random() * 2000); });

        } catch (e) {
          log('[深度交互] 异常: ' + e.message);
          // 确保关闭 tab
          if (tab) {
            log('[深度交互] 异常后关闭 tab: ' + tab.id);
            try {
              await chrome.tabs.remove(tab.id);
              log('[深度交互] tab 已关闭');
            } catch (e2) {
              log('[深度交互] 异常后关闭 tab 失败: ' + e2.message);
            }
          }
        }
      }

      log('[深度交互] 完成，共交互 ' + interacted + ' 条');
      // 确保深度交互后 state.xhsTabId 仍指向主 tab（防止 findXhsTab 返回错误 tab）
      try {
        var mainTab = await chrome.tabs.get(state.xhsTabId);
        if (!mainTab || mainTab.status === 'unloaded') {
          log('[深度交互] 主 tab 异常，重新查找...');
          var found = await findXhsTab();
          if (found) state.xhsTabId = found.id;
        }
      } catch (e) {
        log('[深度交互] 主 tab 检查失败: ' + e.message + '，重新查找...');
        var found2 = await findXhsTab();
        if (found2) state.xhsTabId = found2.id;
      }
      sendResponse({ ok: true, interacted: interacted });
    })();

    return true;
  }

  // 用户主页 tab 管理：content.js 点击用户主页链接（target="_blank"）后通知
  // background 随机停留后关闭该 tab
  if (message.type === 'HOMEPAGE_TAB_OPENED') {
    var homepageUrl = message.url || '';
    log('[深度交互] 用户主页新 tab 已打开: ' + homepageUrl);

    // 方案：监听 onCreated，记录新 tab ID，再用 onUpdated 等待 URL 就绪后匹配
    // onCreated 触发时 tab.url 可能为空，需要用 onUpdated 确认 URL
    var newTabIds = [];
    var homepageTabId = null;

    var onCreatedListener = function (tab) {
      // 记录所有新创建的 tab（稍后在 onUpdated 中匹配 URL）
      newTabIds.push(tab.id);
    };

    var onUpdatedListener = function (tabId, changeInfo, tabInfo) {
      // 只检查新创建的 tab，且 URL 包含 /user/profile/
      if (newTabIds.indexOf(tabId) === -1) return;
      var url = changeInfo.url || (tabInfo && tabInfo.url) || '';
      if (url.indexOf('/user/profile/') !== -1) {
        homepageTabId = tabId;
        chrome.tabs.onCreated.removeListener(onCreatedListener);
        chrome.tabs.onUpdated.removeListener(onUpdatedListener);
        var stayTime = 8000 + Math.floor(Math.random() * 12000); // 停留 8-20 秒
        log('[深度交互] 用户主页 tab ' + tabId + ' 停留 ' + (stayTime / 1000) + 's 后关闭');
        setTimeout(function () {
          chrome.tabs.remove(tabId, function () {
            if (chrome.runtime.lastError) {
              log('[深度交互] 关闭用户主页 tab 失败: ' + chrome.runtime.lastError.message);
            } else {
              log('[深度交互] 用户主页 tab 已关闭');
            }
          });
        }, stayTime);
      }
    };

    chrome.tabs.onCreated.addListener(onCreatedListener);
    chrome.tabs.onUpdated.addListener(onUpdatedListener);

    // 兜底：30 秒后移除监听器（避免泄漏），如果仍未匹配到则查询所有 tab
    setTimeout(function () {
      chrome.tabs.onCreated.removeListener(onCreatedListener);
      chrome.tabs.onUpdated.removeListener(onUpdatedListener);
      if (homepageTabId === null) {
        // 兜底：查询所有包含 /user/profile/ 的 tab，关闭它们
        chrome.tabs.query({ url: '*://*.xiaohongshu.com/user/profile/*' }, function (tabs) {
          for (var i = 0; i < tabs.length; i++) {
            var tab = tabs[i];
            // 不关闭采集标签页（state.xhsTabId）
            if (tab.id !== state.xhsTabId) {
              log('[深度交互] 兜底关闭用户主页 tab: ' + tab.id);
              chrome.tabs.remove(tab.id, function () {
                if (chrome.runtime.lastError) {
                  log('[深度交互] 兜底关闭失败: ' + chrome.runtime.lastError.message);
                }
              });
            }
          }
        });
      }
    }, 30000);

    sendResponse({ ok: true });
    return false;
  }
});

// ======================= 初始化 =======================

// 初始化完成标志：确保 GET_STATUS 等消息在初始化完成后才响应
var _initDone = false;
var _initPromise = null;

// 点击扩展图标打开 sidePanel（manifest 中已移除 default_popup，
// 所以 action.onClicked 会被触发）
chrome.runtime.onInstalled.addListener(function () {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(function (e) {
      log('设置 sidePanel 行为失败: ' + e.message);
    });
});

_initPromise = loadState().then(function () {
  log('后台服务启动');

  // Service Worker 重启后的处理：
  // 核心问题：SW 休眠后 async 上下文丢失，但 content script 可能仍在运行
  // 解决方案：
  // 1. content script 采集期间保持 keepalive 长连接（防止 SW 休眠）
  // 2. SW 重启时总是发 STOP（即使 state.collecting 已是 false，
  //    因为上轮重启可能因 xhsTabId=null 导致 STOP 发送失败）
  // 3. 用 chrome.storage.session 的 user_stopped 标记区分用户主动停止

  return new Promise(function (resolve) {
    chrome.storage.session.get('user_stopped', function (result) {
      var wasCollecting = state.collecting;

      // 无论是否在采集，启动时总是清除可能残留的 alarm
      stopAlarmKeepalive();

      if (wasCollecting && result.user_stopped) {
        // 用户主动停止
        log('检测到用户已主动停止采集，重置采集状态');
        state.collecting = false;
        state.currentKeyword = '';
        state.progress = null;
        saveState();
      } else if (wasCollecting) {
        // SW 重启，但不中断采集——content script 仍在运行
        // 端口自动重连 + 排队消息会正常处理，无需发 STOP
        log('[重启] Service Worker 重启，采集继续（不中断 content script）');
      }

      // 通知 content script：SW 已重启，重连端口
      // 不发 STOP——深度交互期间的 SW 重启不应中断采集
      var notifyRestart = function (tabId) {
        if (!tabId) {
          if (wasCollecting) {
            log('[重启] 未找到小红书标签页，重置采集状态');
            state.collecting = false;
            state.currentKeyword = '';
            state.progress = null;
            saveState();
          }
          resolve();
          return;
        }
        state.xhsTabId = tabId;
        chrome.tabs.sendMessage(tabId, { type: 'SW_RESTARTED' }, function () {
          if (chrome.runtime.lastError) {
            if (wasCollecting) {
              // content script 不存在（插件重载/页面刷新/标签页关闭）
              // 尝试重新注入 content script
              log('[重启] 通知 content script 失败: ' + chrome.runtime.lastError.message + '，尝试重新注入...');
              injectContentScripts(tabId).then(function () {
                log('[重启] content script 重新注入成功，重置采集状态（用户需手动恢复）');
                state.collecting = false;
                state.currentKeyword = '';
                state.progress = null;
                saveState();
                resolve();
              }).catch(function (e) {
                log('[重启] content script 重新注入失败: ' + e.message + '，重置采集状态');
                state.collecting = false;
                state.currentKeyword = '';
                state.progress = null;
                saveState();
                resolve();
              });
            } else {
              resolve();
            }
          } else if (wasCollecting) {
            log('[重启] 已通知 content script: SW 已重启');
            resolve();
          } else {
            resolve();
          }
        });
      };

      if (state.xhsTabId) {
        notifyRestart(state.xhsTabId);
      } else {
        findXhsTab().then(function (tab) {
          notifyRestart(tab ? tab.id : null);
        });
      }

      // 清除 user_stopped 标记
      chrome.storage.session.remove('user_stopped');
    });
  });
}).then(function () {
  _initDone = true;
  log('后台服务初始化完成');
});

// 标签页关闭时清理
chrome.tabs.onRemoved.addListener(function (tabId) {
  if (tabId === state.xhsTabId) {
    state.xhsTabId = null;
    log('小红书标签页已关闭');
    if (state.collecting) {
      stopCollection('tab_closed');
    }
  }
});

// 标记插件自身发起的导航（已在文件顶部声明 _pluginNavigation）

// 封装 chrome.tabs.update，标记为插件导航
function pluginTabsUpdate(tabId, props) {
  return new Promise(function (resolve, reject) {
    _pluginNavigation = true;
    chrome.tabs.update(tabId, props, function (tab) {
      // 1.5 秒后清除标记（足够覆盖 loading 事件）
      setTimeout(function () { _pluginNavigation = false; }, 1500);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(tab);
      }
    });
  });
}

// 标签页刷新检测
// 采集期间的所有导航（搜索、点击笔记、插件导航）都是插件发起的，不应触发停止
// 只有非采集期间的用户刷新才需要处理（清理状态）
// 用户在采集期间手动刷新的情况：content script 会重载，sendToContent 会失败，
// 采集流程自然中断，无需在这里主动停止
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (tabId === state.xhsTabId && changeInfo.status === 'loading' && !_pluginNavigation) {
    if (state.collecting) {
      // 采集期间：忽略所有 loading 事件（搜索、点击笔记等都会触发）
      // 不停止采集，避免误判
      log('[导航] 采集期间检测到标签页 loading，忽略（可能是搜索/点击笔记触发）');
    } else {
      // 非采集期间：用户刷新页面，清理过期的 xhsTabId（content script 已重载）
      log('[导航] 非采集期间检测到标签页刷新，清理状态');
      // 不清除 xhsTabId，只是标记需要重新验证 content script
    }
  }
});
