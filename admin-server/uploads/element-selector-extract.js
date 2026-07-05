// @name: 网页元素选择器提取
// @description: 点击选择页面元素，自动生成CSS选择器，批量提取同结构元素的文本/属性/链接数据，支持导出CSV
// @version: 1.0.0
// @urlPattern: *

(function () {
  'use strict';

  // 防止重复运行
  if (document.getElementById('elem-select-bar')) {
    return;
  }

  // 常量
  var HIGHLIGHT_BORDER = '2px solid #4fc3f7';
  var HIGHLIGHT_BG = 'rgba(79, 195, 247, 0.08)';
  var PANEL_BG = '#1a1a2e';
  var PANEL_COLOR = '#eee';
  var Z_TOP = 999999;
  var MAX_TEXT_LEN = 100;
  var GENERIC_CLASSES = ['active', 'selected', 'first', 'last', 'current', 'open', 'closed', 'hidden', 'visible', 'disabled', 'enabled', 'loading', 'loaded', 'show', 'hide', 'on', 'off', 'hover', 'focus', 'blur'];

  // 状态
  var selectionMode = true;
  var highlightOverlay = null;
  var resultPanel = null;
  var controlBar = null;
  var selectedElement = null;
  var generatedSelector = '';
  var matchedElements = [];

  // ===== 样式注入 =====
  var styleEl = document.createElement('style');
  styleEl.id = 'elem-select-styles';
  styleEl.textContent = [
    '#elem-select-bar {',
    '  position: fixed; top: 10px; left: 50%; transform: translateX(-50%);',
    '  z-index: ' + Z_TOP + ';',
    '  background: ' + PANEL_BG + '; color: ' + PANEL_COLOR + ';',
    '  padding: 8px 16px; border-radius: 6px;',
    '  box-shadow: 0 2px 12px rgba(0,0,0,0.4);',
    '  display: flex; align-items: center; gap: 10px;',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '  font-size: 14px; user-select: none;',
    '}',
    '#elem-select-bar button {',
    '  background: #4fc3f7; color: #1a1a2e; border: none;',
    '  padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 13px;',
    '}',
    '#elem-select-bar button:hover { background: #81d4fa; }',
    '#elem-select-bar button.elem-cancel-btn { background: #ef5350; color: #fff; }',
    '#elem-select-bar button.elem-cancel-btn:hover { background: #f44336; }',
    '#elem-highlight-overlay {',
    '  position: fixed; pointer-events: none;',
    '  z-index: ' + (Z_TOP - 1) + ';',
    '  border: ' + HIGHLIGHT_BORDER + ';',
    '  background: ' + HIGHLIGHT_BG + ';',
    '  transition: all 0.05s ease;',
    '}',
    '#elem-result-panel {',
    '  position: fixed; top: 60px; right: 20px;',
    '  width: 400px; max-height: 500px;',
    '  z-index: ' + Z_TOP + ';',
    '  background: ' + PANEL_BG + '; color: ' + PANEL_COLOR + ';',
    '  border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '  font-size: 13px; overflow: hidden; display: flex; flex-direction: column;',
    '}',
    '#elem-result-panel .panel-header {',
    '  display: flex; justify-content: space-between; align-items: center;',
    '  padding: 10px 14px; border-bottom: 1px solid #333; font-size: 15px; font-weight: bold;',
    '}',
    '#elem-result-panel .panel-header .close-btn {',
    '  background: none; border: none; color: #999; font-size: 18px; cursor: pointer; line-height: 1;',
    '}',
    '#elem-result-panel .panel-header .close-btn:hover { color: #fff; }',
    '#elem-result-panel .panel-body {',
    '  padding: 10px 14px; overflow-y: auto; flex: 1;',
    '}',
    '#elem-result-panel .selector-row {',
    '  display: flex; gap: 6px; margin-bottom: 10px;',
    '}',
    '#elem-result-panel .selector-row input {',
    '  flex: 1; background: #111; color: #4fc3f7; border: 1px solid #444;',
    '  padding: 4px 8px; border-radius: 3px; font-size: 12px; font-family: monospace;',
    '}',
    '#elem-result-panel .selector-row button, #elem-result-panel .action-row button {',
    '  background: #4fc3f7; color: #1a1a2e; border: none;',
    '  padding: 4px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; white-space: nowrap;',
    '}',
    '#elem-result-panel .selector-row button:hover, #elem-result-panel .action-row button:hover {',
    '  background: #81d4fa;',
    '}',
    '#elem-result-panel .match-info {',
    '  margin-bottom: 8px; color: #aaa; font-size: 12px;',
    '}',
    '#elem-result-panel table {',
    '  width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 12px;',
    '}',
    '#elem-result-panel table th, #elem-result-panel table td {',
    '  padding: 4px 6px; border: 1px solid #333; text-align: left; vertical-align: top;',
    '  max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
    '}',
    '#elem-result-panel table th {',
    '  background: #222; color: #aaa; font-weight: normal;',
    '}',
    '#elem-result-panel table td {',
    '  color: #ccc;',
    '}',
    '#elem-result-panel .action-row {',
    '  display: flex; gap: 8px; padding-top: 6px; border-top: 1px solid #333;',
    '}',
    '#elem-result-panel .action-row button.reselect-btn {',
    '  background: #ff9800; color: #1a1a2e;',
    '}',
    '#elem-result-panel .action-row button.reselect-btn:hover {',
    '  background: #ffb74d;',
    '}'
  ].join('\n');
  document.head.appendChild(styleEl);

  // ===== 高亮覆盖层 =====
  function createHighlightOverlay() {
    var el = document.createElement('div');
    el.id = 'elem-highlight-overlay';
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }

  function updateHighlight(target) {
    if (!highlightOverlay) return;
    var rect = target.getBoundingClientRect();
    highlightOverlay.style.display = 'block';
    highlightOverlay.style.left = rect.left + 'px';
    highlightOverlay.style.top = rect.top + 'px';
    highlightOverlay.style.width = rect.width + 'px';
    highlightOverlay.style.height = rect.height + 'px';
  }

  function hideHighlight() {
    if (highlightOverlay) {
      highlightOverlay.style.display = 'none';
    }
  }

  // ===== 选择器生成 =====
  function isGenericClass(cls) {
    return GENERIC_CLASSES.indexOf(cls) !== -1;
  }

  function getMeaningfulClasses(el) {
    if (!el.className || typeof el.className !== 'string') return [];
    return el.className.trim().split(/\s+/).filter(function (c) {
      return c && !isGenericClass(c) && !/^\d/.test(c);
    });
  }

  function generateSelector(el) {
    var tag = el.tagName.toLowerCase();
    var meaningfulClasses = getMeaningfulClasses(el);

    // 策略1: 优先使用 tag.className 匹配多个同结构元素（批量提取核心）
    if (meaningfulClasses.length > 0) {
      // 尝试每个有意义的类，优先返回匹配多个元素的选择器
      for (var i = 0; i < meaningfulClasses.length; i++) {
        var sel = tag + '.' + cssEscape(meaningfulClasses[i]);
        var matches = document.querySelectorAll(sel);
        if (matches.length > 1 && matches.length <= 500) {
          // 验证选中元素中包含目标
          for (var j = 0; j < matches.length; j++) {
            if (matches[j] === el) {
              return sel;
            }
          }
        }
      }
      // 组合所有有意义的类
      var fullClassSel = tag + '.' + meaningfulClasses.map(function (c) { return cssEscape(c); }).join('.');
      var fullMatches = document.querySelectorAll(fullClassSel);
      if (fullMatches.length > 1 && fullMatches.length <= 500) {
        for (var k = 0; k < fullMatches.length; k++) {
          if (fullMatches[k] === el) {
            return fullClassSel;
          }
        }
      }
    }

    // 策略2: 寻找重复结构的容器，生成相对选择器（兄弟元素批量匹配）
    var relSelector = findRelativeSelector(el);
    if (relSelector) {
      return relSelector;
    }

    // 策略3: 如果没有同类兄弟，尝试向上查找有 ID 的祖先 + tag 选择器
    var ancestorSel = findAncestorWithId(el, tag);
    if (ancestorSel) {
      return ancestorSel;
    }

    // 策略4: 回退到 #id（如果有且唯一，至少保证选中目标）
    if (el.id) {
      var idTest = document.querySelectorAll('#' + cssEscape(el.id));
      if (idTest.length === 1) {
        return '#' + cssEscape(el.id);
      }
    }

    // 策略5: 最终回退 - 完整路径 nth-child
    return buildFullPath(el);
  }

  // 向上查找有 ID 的祖先元素，用 #ancestor tag 形式匹配同类元素
  function findAncestorWithId(el, tag) {
    var parent = el.parentElement;
    for (var depth = 0; depth < 5 && parent; depth++) {
      if (parent.id) {
        var sel = '#' + cssEscape(parent.id) + ' ' + tag;
        try {
          var matches = document.querySelectorAll(sel);
          if (matches.length >= 1 && matches.length <= 500) {
            // 验证目标在结果中
            for (var i = 0; i < matches.length; i++) {
              if (matches[i] === el) {
                return sel;
              }
            }
          }
        } catch (e) {}
      }
      parent = parent.parentElement;
    }
    return null;
  }

  function findRelativeSelector(el) {
    // 向上查找有多个相同子结构的容器
    var parent = el.parentElement;
    var tag = el.tagName.toLowerCase();
    var meaningfulClasses = getMeaningfulClasses(el);

    for (var depth = 0; depth < 5 && parent; depth++) {
      // 在当前父容器下，尝试用 tag + class 选择
      var candidateSelectors = [];

      if (meaningfulClasses.length > 0) {
        candidateSelectors.push(tag + '.' + meaningfulClasses.map(function (c) { return cssEscape(c); }).join('.'));
        for (var ci = 0; ci < meaningfulClasses.length; ci++) {
          candidateSelectors.push(tag + '.' + cssEscape(meaningfulClasses[ci]));
        }
      }
      candidateSelectors.push(tag);

      for (var si = 0; si < candidateSelectors.length; si++) {
        var items = parent.querySelectorAll(':scope > ' + candidateSelectors[si]);
        if (items.length > 1) {
          // 检查目标是否在其中
          var found = false;
          for (var fi = 0; fi < items.length; fi++) {
            if (items[fi] === el) { found = true; break; }
          }
          if (found) {
            // 构建父级选择器 + 子选择器
            var parentSel = getSimpleSelector(parent);
            if (parentSel) {
              var combined = parentSel + ' > ' + candidateSelectors[si];
              var combinedMatches = document.querySelectorAll(combined);
              if (combinedMatches.length > 1 && combinedMatches.length <= 500) {
                return combined;
              }
            }
          }
        }
      }

      parent = parent.parentElement;
    }

    return null;
  }

  function getSimpleSelector(el) {
    if (el.id) {
      return '#' + cssEscape(el.id);
    }
    var tag = el.tagName.toLowerCase();
    var classes = getMeaningfulClasses(el);
    if (classes.length > 0) {
      return tag + '.' + classes.map(function (c) { return cssEscape(c); }).join('.');
    }
    return null;
  }

  function buildFullPath(el) {
    var parts = [];
    var current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      var tag = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift('#' + cssEscape(current.id));
        break;
      }
      var parent = current.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === current.tagName;
        });
        if (siblings.length > 1) {
          var idx = siblings.indexOf(current) + 1;
          parts.unshift(tag + ':nth-child(' + idx + ')');
        } else {
          parts.unshift(tag);
        }
      } else {
        parts.unshift(tag);
      }
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function cssEscape(str) {
    // 简单的 CSS 选择器转义
    return str.replace(/([^\w-])/g, '\\$1');
  }

  // ===== 数据提取 =====
  function extractData(elements) {
    return elements.map(function (el, i) {
      var text = (el.textContent || '').trim();
      if (text.length > MAX_TEXT_LEN) {
        text = text.substring(0, MAX_TEXT_LEN) + '...';
      }
      var row = {
        index: i + 1,
        text: text,
        href: '',
        src: '',
        value: ''
      };
      var tag = el.tagName.toLowerCase();
      if (tag === 'a' && el.href) {
        row.href = el.href;
      }
      if (tag === 'img' && el.src) {
        row.src = el.src;
      }
      if ((tag === 'input' || tag === 'select' || tag === 'textarea') && el.value !== undefined) {
        row.value = el.value;
      }
      return row;
    });
  }

  // ===== CSV 导出 =====
  function exportCSV(data) {
    var headers = ['序号', '文本内容', '链接(href)', '图片(src)', '值(value)'];
    var lines = [headers.join(',')];
    data.forEach(function (row) {
      var cols = [
        row.index,
        csvEscape(row.text),
        csvEscape(row.href),
        csvEscape(row.src),
        csvEscape(row.value)
      ];
      lines.push(cols.join(','));
    });
    var csvContent = lines.join('\r\n');
    // BOM + UTF-8
    var bom = '\uFEFF';
    var blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var hostname = location.hostname || 'page';
    var timestamp = Date.now();
    a.href = url;
    a.download = hostname + '-extract-' + timestamp + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function csvEscape(str) {
    if (!str) return '';
    str = String(str);
    if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1 || str.indexOf('\r') !== -1) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  // ===== 控制栏 =====
  function createControlBar() {
    var bar = document.createElement('div');
    bar.id = 'elem-select-bar';

    var label = document.createElement('span');
    label.id = 'elem-select-label';
    label.textContent = '请点击页面元素';
    bar.appendChild(label);

    var doneBtn = document.createElement('button');
    doneBtn.id = 'elem-select-done';
    doneBtn.textContent = '完成选择';
    doneBtn.style.display = 'none';
    bar.appendChild(doneBtn);

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'elem-cancel-btn';
    cancelBtn.textContent = '取消';
    bar.appendChild(cancelBtn);

    document.body.appendChild(bar);

    doneBtn.addEventListener('click', function () {
      if (selectedElement) {
        showResults();
      }
    });

    cancelBtn.addEventListener('click', function () {
      cleanup();
    });

    return bar;
  }

  // ===== 结果面板 =====
  function createResultPanel(selector, data) {
    var panel = document.createElement('div');
    panel.id = 'elem-result-panel';

    // 头部
    var header = document.createElement('div');
    header.className = 'panel-header';
    var title = document.createElement('span');
    title.textContent = '提取结果';
    header.appendChild(title);
    var closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', function () {
      cleanup();
    });
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // 主体
    var body = document.createElement('div');
    body.className = 'panel-body';

    // 选择器行
    var selectorRow = document.createElement('div');
    selectorRow.className = 'selector-row';
    var selectorInput = document.createElement('input');
    selectorInput.type = 'text';
    selectorInput.readOnly = true;
    selectorInput.value = selector;
    selectorRow.appendChild(selectorInput);
    var copyBtn = document.createElement('button');
    copyBtn.textContent = '复制选择器';
    copyBtn.addEventListener('click', function () {
      selectorInput.select();
      try {
        document.execCommand('copy');
        copyBtn.textContent = '已复制';
        setTimeout(function () { copyBtn.textContent = '复制选择器'; }, 1500);
      } catch (e) {
        // 回退
        if (navigator.clipboard) {
          navigator.clipboard.writeText(selector).then(function () {
            copyBtn.textContent = '已复制';
            setTimeout(function () { copyBtn.textContent = '复制选择器'; }, 1500);
          });
        }
      }
    });
    selectorRow.appendChild(copyBtn);
    body.appendChild(selectorRow);

    // 匹配信息
    var matchInfo = document.createElement('div');
    matchInfo.className = 'match-info';
    matchInfo.textContent = '匹配到 ' + data.length + ' 个元素';
    body.appendChild(matchInfo);

    // 数据表格
    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['序号', '文本内容', '链接', '图片', '值'].forEach(function (h) {
      var th = document.createElement('th');
      th.textContent = h;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    data.forEach(function (row) {
      var tr = document.createElement('tr');
      var tdIdx = document.createElement('td');
      tdIdx.textContent = row.index;
      tr.appendChild(tdIdx);

      var tdText = document.createElement('td');
      tdText.textContent = row.text;
      tdText.title = row.text;
      tr.appendChild(tdText);

      var tdHref = document.createElement('td');
      tdHref.textContent = row.href;
      tdHref.title = row.href;
      tr.appendChild(tdHref);

      var tdSrc = document.createElement('td');
      tdSrc.textContent = row.src;
      tdSrc.title = row.src;
      tr.appendChild(tdSrc);

      var tdVal = document.createElement('td');
      tdVal.textContent = row.value;
      tdVal.title = row.value;
      tr.appendChild(tdVal);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);

    // 操作按钮行
    var actionRow = document.createElement('div');
    actionRow.className = 'action-row';
    var exportBtn = document.createElement('button');
    exportBtn.textContent = '导出CSV';
    exportBtn.addEventListener('click', function () {
      exportCSV(data);
    });
    actionRow.appendChild(exportBtn);

    var reselectBtn = document.createElement('button');
    reselectBtn.className = 'reselect-btn';
    reselectBtn.textContent = '重新选择';
    reselectBtn.addEventListener('click', function () {
      // 移除结果面板
      if (resultPanel) {
        resultPanel.remove();
        resultPanel = null;
      }
      // 重置状态
      selectedElement = null;
      generatedSelector = '';
      matchedElements = [];
      selectionMode = true;
      // 恢复控制栏
      var label = document.getElementById('elem-select-label');
      if (label) label.textContent = '请点击页面元素';
      var doneBtn = document.getElementById('elem-select-done');
      if (doneBtn) doneBtn.style.display = 'none';
    });
    actionRow.appendChild(reselectBtn);
    body.appendChild(actionRow);

    panel.appendChild(body);
    document.body.appendChild(panel);
    return panel;
  }

  // ===== 显示结果 =====
  function showResults() {
    selectionMode = false;
    hideHighlight();

    generatedSelector = generateSelector(selectedElement);
    try {
      matchedElements = Array.prototype.slice.call(document.querySelectorAll(generatedSelector));
    } catch (e) {
      matchedElements = [selectedElement];
    }

    // 确保目标元素在结果中
    if (matchedElements.indexOf(selectedElement) === -1) {
      matchedElements.unshift(selectedElement);
    }

    var data = extractData(matchedElements);
    resultPanel = createResultPanel(generatedSelector, data);

    // 隐藏控制栏
    if (controlBar) {
      controlBar.style.display = 'none';
    }
  }

  // ===== 事件处理 =====
  function onMouseOver(e) {
    if (!selectionMode) return;
    if (isOwnElement(e.target)) return;
    e.stopPropagation();
    updateHighlight(e.target);
  }

  function onMouseOut(e) {
    if (!selectionMode) return;
    if (isOwnElement(e.target)) return;
    e.stopPropagation();
    hideHighlight();
  }

  function onClick(e) {
    if (!selectionMode) return;
    if (isOwnElement(e.target)) return;
    e.preventDefault();
    e.stopPropagation();

    selectedElement = e.target;
    selectionMode = false;
    hideHighlight();

    // 更新控制栏
    var label = document.getElementById('elem-select-label');
    if (label) label.textContent = '已选择元素: ' + selectedElement.tagName.toLowerCase();
    var doneBtn = document.getElementById('elem-select-done');
    if (doneBtn) doneBtn.style.display = 'inline-block';

    showResults();
  }

  function isOwnElement(el) {
    // 检查是否是我们自己创建的UI元素
    while (el) {
      if (el.id === 'elem-select-bar' || el.id === 'elem-result-panel' || el.id === 'elem-highlight-overlay' || el.id === 'elem-select-styles') {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  // ===== 清理 =====
  function cleanup() {
    // 移除事件
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('click', onClick, true);

    // 移除DOM
    if (highlightOverlay) {
      highlightOverlay.remove();
      highlightOverlay = null;
    }
    if (resultPanel) {
      resultPanel.remove();
      resultPanel = null;
    }
    if (controlBar) {
      controlBar.remove();
      controlBar = null;
    }
    var style = document.getElementById('elem-select-styles');
    if (style) {
      style.remove();
    }

    selectedElement = null;
    generatedSelector = '';
    matchedElements = [];
    selectionMode = false;
  }

  // ===== 初始化 =====
  highlightOverlay = createHighlightOverlay();
  controlBar = createControlBar();

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mouseout', onMouseOut, true);
  document.addEventListener('click', onClick, true);

  // ===== 返回标准化信封（供 AI 下一轮调用使用） =====
  return {
    ok: true,
    data: [],
    count: 0,
    hint: '元素选择器已激活，进入交互模式。鼠标悬停高亮、点击选中后自动生成选择器',
    panelSelector: '#elem-select-bar',
    panelInfo: '控制栏支持：选择元素、取消、退出。点击页面元素后自动生成 CSS 选择器和数据预览面板'
  };
})();
