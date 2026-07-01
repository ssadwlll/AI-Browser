// @name: 网页暗黑模式
// @description: 一键切换网页暗黑模式，智能反转颜色，保护视力，支持亮度/对比度微调
// @version: 1.0.0
// @urlPattern: *

(function () {
  'use strict';

  // 防止重复注入
  if (document.getElementById('dark-mode-style')) {
    return;
  }

  // 默认配置
  var DEFAULTS = {
    enabled: true,
    brightness: 100,
    contrast: 100
  };

  var config = {
    enabled: DEFAULTS.enabled,
    brightness: DEFAULTS.brightness,
    contrast: DEFAULTS.contrast
  };

  // 暗黑模式核心CSS
  var DARK_CSS = '\
html {\
  background: #1a1a2e !important;\
}\
body {\
  background: #1a1a2e !important;\
  color: #e0e0e0 !important;\
  filter: brightness(var(--dm-brightness, 1)) contrast(var(--dm-contrast, 1)) !important;\
}\
h1, h2, h3, h4, h5, h6 {\
  color: #e0e0e0 !important;\
}\
p, span, div, li, td, th, label, caption, dt, dd, blockquote {\
  color: #e0e0e0 !important;\
}\
a {\
  color: #64b5f6 !important;\
}\
a:visited {\
  color: #ce93d8 !important;\
}\
table, th, td {\
  border-color: #444 !important;\
}\
hr {\
  border-color: #444 !important;\
}\
input, textarea, select {\
  background: #2a2a3e !important;\
  border-color: #555 !important;\
  color: #e0e0e0 !important;\
}\
input::placeholder, textarea::placeholder {\
  color: #999 !important;\
}\
button {\
  background: #2a2a3e !important;\
  border-color: #555 !important;\
  color: #e0e0e0 !important;\
}\
img, video, canvas, svg, picture {\
  filter: invert(1) hue-rotate(180deg) brightness(var(--dm-brightness, 1)) contrast(var(--dm-contrast, 1)) !important;\
}\
iframe {\
  filter: invert(1) hue-rotate(180deg) brightness(var(--dm-brightness, 1)) contrast(var(--dm-contrast, 1)) !important;\
}\
[role="img"] {\
  filter: invert(1) hue-rotate(180deg) brightness(var(--dm-brightness, 1)) contrast(var(--dm-contrast, 1)) !important;\
}\
pre, code {\
  background: #2a2a3e !important;\
  color: #e0e0e0 !important;\
  filter: invert(1) hue-rotate(180deg) brightness(var(--dm-brightness, 1)) contrast(var(--dm-contrast, 1)) !important;\
}\
[style*="background-image"] {\
  filter: invert(1) hue-rotate(180deg) brightness(var(--dm-brightness, 1)) contrast(var(--dm-contrast, 1)) !important;\
}\
select option {\
  background: #2a2a3e !important;\
  color: #e0e0e0 !important;\
}\
  ';

  // 注入暗黑模式样式
  function applyDarkMode() {
    if (!config.enabled) {
      removeDarkMode();
      return;
    }

    // 设置CSS自定义属性
    document.documentElement.style.setProperty('--dm-brightness', (config.brightness / 100).toString());
    document.documentElement.style.setProperty('--dm-contrast', (config.contrast / 100).toString());

    // 注入或更新样式
    var styleEl = document.getElementById('dark-mode-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'dark-mode-style';
      styleEl.textContent = DARK_CSS;
      (document.head || document.documentElement).appendChild(styleEl);
    }

    // 处理shadow DOM
    injectShadowRoots();
  }

  // 移除暗黑模式
  function removeDarkMode() {
    var styleEl = document.getElementById('dark-mode-style');
    if (styleEl) {
      styleEl.remove();
    }
    document.documentElement.style.removeProperty('--dm-brightness');
    document.documentElement.style.removeProperty('--dm-contrast');
  }

  // 尝试为shadow DOM注入样式
  function injectShadowRoots() {
    var allElements = document.querySelectorAll('*');
    for (var i = 0; i < allElements.length; i++) {
      var el = allElements[i];
      if (el.shadowRoot && !el.shadowRoot.querySelector('#dark-mode-style')) {
        var shadowStyle = document.createElement('style');
        shadowStyle.id = 'dark-mode-style';
        shadowStyle.textContent = DARK_CSS;
        el.shadowRoot.appendChild(shadowStyle);
      }
    }
  }

  // ========== 控制面板 ==========
  var widgetId = 'dark-mode-widget';
  var isExpanded = false;

  function createWidget() {
    if (document.getElementById(widgetId)) {
      return;
    }

    var container = document.createElement('div');
    container.id = widgetId;
    container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;line-height:1.4;';

    // 收起状态的月亮按钮
    var moonBtn = document.createElement('div');
    moonBtn.id = 'dark-mode-moon-btn';
    moonBtn.style.cssText = 'width:40px;height:40px;border-radius:50%;background:rgba(20,20,40,0.9);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);color:#e0e0e0;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:20px;border:1px solid rgba(100,181,246,0.3);box-shadow:0 2px 12px rgba(0,0,0,0.4);transition:all 0.3s ease;user-select:none;';
    moonBtn.textContent = '\u263E';
    moonBtn.title = '\u6697\u9ED1\u6A21\u5F0F\u63A7\u5236';
    moonBtn.onmouseenter = function () {
      moonBtn.style.borderColor = 'rgba(100,181,246,0.7)';
      moonBtn.style.transform = 'scale(1.1)';
    };
    moonBtn.onmouseleave = function () {
      moonBtn.style.borderColor = 'rgba(100,181,246,0.3)';
      moonBtn.style.transform = 'scale(1)';
    };

    // 展开面板
    var panel = document.createElement('div');
    panel.id = 'dark-mode-panel';
    panel.style.cssText = 'display:none;width:200px;background:rgba(20,20,40,0.9);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-radius:12px;border:1px solid rgba(100,181,246,0.2);box-shadow:0 4px 20px rgba(0,0,0,0.5);padding:12px;color:#e0e0e0;';

    // 标题行
    var titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';
    var titleText = document.createElement('span');
    titleText.style.cssText = 'font-size:13px;font-weight:600;';
    titleText.textContent = '\u6697\u9ED1\u6A21\u5F0F';
    titleRow.appendChild(titleText);

    // 关闭面板按钮
    var closeBtn = document.createElement('span');
    closeBtn.style.cssText = 'cursor:pointer;font-size:16px;color:#999;transition:color 0.2s;user-select:none;';
    closeBtn.textContent = '\u00D7';
    closeBtn.onmouseenter = function () { closeBtn.style.color = '#e0e0e0'; };
    closeBtn.onmouseleave = function () { closeBtn.style.color = '#999'; };
    closeBtn.onclick = function () { togglePanel(false); };
    titleRow.appendChild(closeBtn);
    panel.appendChild(titleRow);

    // 开关行
    var toggleRow = document.createElement('div');
    toggleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';
    var toggleLabel = document.createElement('span');
    toggleLabel.style.cssText = 'font-size:12px;';
    toggleLabel.textContent = '\u6697\u9ED1\u6A21\u5F0F';
    toggleRow.appendChild(toggleLabel);

    var toggleSwitch = document.createElement('div');
    toggleSwitch.id = 'dark-mode-toggle';
    updateToggleSwitch(toggleSwitch, config.enabled);
    toggleSwitch.onclick = function () {
      config.enabled = !config.enabled;
      updateToggleSwitch(toggleSwitch, config.enabled);
      applyDarkMode();
    };
    toggleRow.appendChild(toggleSwitch);
    panel.appendChild(toggleRow);

    // 亮度滑块
    var brightnessRow = createSliderRow('\u4EAE\u5EA6', config.brightness, 80, 120, function (val) {
      config.brightness = val;
      applyDarkMode();
    });
    brightnessRow.style.marginBottom = '8px';
    panel.appendChild(brightnessRow);

    // 对比度滑块
    var contrastRow = createSliderRow('\u5BF9\u6BD4\u5EA6', config.contrast, 80, 120, function (val) {
      config.contrast = val;
      applyDarkMode();
    });
    contrastRow.style.marginBottom = '10px';
    panel.appendChild(contrastRow);

    // 重置按钮
    var resetBtn = document.createElement('div');
    resetBtn.style.cssText = 'text-align:center;padding:5px 0;background:rgba(100,181,246,0.15);border-radius:6px;cursor:pointer;font-size:12px;color:#64b5f6;transition:background 0.2s;user-select:none;';
    resetBtn.textContent = '\u91CD\u7F6E';
    resetBtn.onmouseenter = function () { resetBtn.style.background = 'rgba(100,181,246,0.3)'; };
    resetBtn.onmouseleave = function () { resetBtn.style.background = 'rgba(100,181,246,0.15)'; };
    resetBtn.onclick = function () {
      config.brightness = DEFAULTS.brightness;
      config.contrast = DEFAULTS.contrast;
      config.enabled = DEFAULTS.enabled;
      applyDarkMode();
      updateToggleSwitch(toggleSwitch, config.enabled);
      // 更新滑块
      var bSlider = document.getElementById('dark-mode-brightness-slider');
      var bValue = document.getElementById('dark-mode-brightness-value');
      var cSlider = document.getElementById('dark-mode-contrast-slider');
      var cValue = document.getElementById('dark-mode-contrast-value');
      if (bSlider) bSlider.value = config.brightness;
      if (bValue) bValue.textContent = config.brightness + '%';
      if (cSlider) cSlider.value = config.contrast;
      if (cValue) cValue.textContent = config.contrast + '%';
    };
    panel.appendChild(resetBtn);

    // 点击月亮按钮切换面板
    moonBtn.onclick = function () {
      togglePanel(!isExpanded);
    };

    container.appendChild(moonBtn);
    container.appendChild(panel);
    document.body.appendChild(container);
  }

  function togglePanel(expand) {
    isExpanded = expand;
    var moonBtn = document.getElementById('dark-mode-moon-btn');
    var panel = document.getElementById('dark-mode-panel');
    if (!moonBtn || !panel) return;

    if (isExpanded) {
      moonBtn.style.display = 'none';
      panel.style.display = 'block';
    } else {
      moonBtn.style.display = 'flex';
      panel.style.display = 'none';
    }
  }

  function updateToggleSwitch(el, enabled) {
    el.style.cssText = 'width:36px;height:20px;border-radius:10px;cursor:pointer;position:relative;transition:background 0.3s;user-select:none;' +
      (enabled ? 'background:#64b5f6;' : 'background:#555;');
    el.innerHTML = '<div style="width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:2px;transition:left 0.3s;' +
      (enabled ? 'left:18px;' : 'left:2px;') +
      '"></div>';
  }

  function createSliderRow(label, value, min, max, onChange) {
    var row = document.createElement('div');

    var headerRow = document.createElement('div');
    headerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;';

    var labelText = document.createElement('span');
    labelText.style.cssText = 'font-size:12px;color:#bbb;';
    labelText.textContent = label;

    var valueText = document.createElement('span');
    var sliderId = 'dark-mode-' + label + '-slider';
    var valueId = 'dark-mode-' + label + '-value';
    valueText.id = valueId;
    valueText.style.cssText = 'font-size:11px;color:#64b5f6;min-width:35px;text-align:right;';
    valueText.textContent = value + '%';

    headerRow.appendChild(labelText);
    headerRow.appendChild(valueText);
    row.appendChild(headerRow);

    var slider = document.createElement('input');
    slider.id = sliderId;
    slider.type = 'range';
    slider.min = min;
    slider.max = max;
    slider.value = value;
    slider.style.cssText = 'width:100%;height:4px;-webkit-appearance:none;appearance:none;background:#444;border-radius:2px;outline:none;cursor:pointer;margin:0;padding:0;';

    // 自定义滑块样式
    var thumbStyle = document.createElement('style');
    thumbStyle.textContent = '#' + sliderId + '::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:50%;background:#64b5f6;cursor:pointer;border:none;}' +
      '#' + sliderId + '::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:#64b5f6;cursor:pointer;border:none;}';
    document.head.appendChild(thumbStyle);

    slider.oninput = function () {
      var val = parseInt(slider.value, 10);
      valueText.textContent = val + '%';
      onChange(val);
    };

    row.appendChild(slider);
    return row;
  }

  // ========== 初始化 ==========
  function init() {
    // 等待body可用
    if (!document.body) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        setTimeout(init, 50);
      }
      return;
    }

    // 再次检查防止重复
    if (document.getElementById('dark-mode-style')) {
      return;
    }

    applyDarkMode();
    createWidget();

    // 监听动态添加的shadow DOM
    if (typeof MutationObserver !== 'undefined') {
      var observer = new MutationObserver(function (mutations) {
        if (!config.enabled) return;
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          if (!added) continue;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (node.nodeType === 1 && node.shadowRoot && !node.shadowRoot.querySelector('#dark-mode-style')) {
              var shadowStyle = document.createElement('style');
              shadowStyle.id = 'dark-mode-style';
              shadowStyle.textContent = DARK_CSS;
              node.shadowRoot.appendChild(shadowStyle);
            }
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  init();
})();
