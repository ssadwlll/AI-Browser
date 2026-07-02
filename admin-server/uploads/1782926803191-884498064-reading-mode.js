// @name: 阅读模式
// @description: 提取网页正文内容，去除广告和干扰元素，提供纯净阅读体验，支持字体大小和背景色调整
// @version: 1.0.0
// @urlPattern: *

(function () {
  'use strict';

  // 防止重复运行
  if (document.getElementById('reading-mode-overlay')) {
    return;
  }

  // ========================
  // 配置与常量
  // ========================

  var MIN_FONT_SIZE = 14;
  var MAX_FONT_SIZE = 28;
  var DEFAULT_FONT_SIZE = 18;
  var MIN_IMAGE_SIZE = 50;

  var THEMES = [
    { name: '护眼', bg: '#f8f5f0', text: '#333333', meta: '#888888', barBg: '#f0ece5', border: '#d8d2c8' },
    { name: '白色', bg: '#ffffff', text: '#333333', meta: '#888888', barBg: '#f5f5f5', border: '#e0e0e0' },
    { name: '深色', bg: '#1a1a2e', text: '#cccccc', meta: '#888888', barBg: '#16162a', border: '#2a2a44' }
  ];

  var PENALTY_CLASS_NAMES = [
    'nav', 'sidebar', 'footer', 'header', 'menu', 'ad', 'comment',
    'social', 'share', 'related', 'recommend'
  ];

  // ========================
  // 内容检测算法
  // ========================

  /**
   * 检查元素的 class 或 id 是否包含惩罚关键词
   */
  function hasPenaltyName(el) {
    var className = (el.className || '').toString().toLowerCase();
    var id = (el.id || '').toString().toLowerCase();
    var combined = className + ' ' + id;
    for (var i = 0; i < PENALTY_CLASS_NAMES.length; i++) {
      if (combined.indexOf(PENALTY_CLASS_NAMES[i]) !== -1) {
        return true;
      }
    }
    return false;
  }

  /**
   * 为元素计算内容得分
   */
  function scoreElement(el) {
    var textContent = el.textContent || '';
    var innerHTML = el.innerHTML || '';
    var textLen = textContent.length;
    var htmlLen = innerHTML.length;

    if (textLen < 100) {
      return -1; // 内容太少，直接排除
    }

    // 文本密度：文本长度 / HTML长度，越高说明纯文本越多
    var textDensity = htmlLen > 0 ? textLen / htmlLen : 0;

    // 段落计数
    var paragraphs = el.querySelectorAll('p');
    var paraCount = paragraphs.length;

    // 基础得分
    var score = textDensity * 100 + paraCount * 10 + Math.min(textLen / 100, 50);

    // 惩罚：导航/侧边栏等类名
    if (hasPenaltyName(el)) {
      score *= 0.1;
    }

    return score;
  }

  /**
   * 查找页面的主内容区域
   */
  function findMainContent() {
    // 第一步：检查语义化元素
    var semanticSelectors = ['article', 'main', '[role="main"]'];
    for (var i = 0; i < semanticSelectors.length; i++) {
      var el = document.querySelector(semanticSelectors[i]);
      if (el && el.textContent && el.textContent.length > 200) {
        return el;
      }
    }

    // 第二步：对所有 div/section 评分
    var candidates = document.querySelectorAll('div, section');
    var bestEl = null;
    var bestScore = -1;

    for (var j = 0; j < candidates.length; j++) {
      var candidate = candidates[j];
      var score = scoreElement(candidate);
      if (score > bestScore) {
        bestScore = score;
        bestEl = candidate;
      }
    }

    return bestEl;
  }

  // ========================
  // 元数据提取
  // ========================

  function extractTitle() {
    var h1 = document.querySelector('h1');
    if (h1 && h1.textContent.trim().length > 0) {
      return h1.textContent.trim();
    }
    return document.title || '';
  }

  function extractAuthor() {
    var meta = document.querySelector('meta[name="author"]');
    if (meta && meta.content) {
      return meta.content;
    }
    // 尝试常见的作者 class
    var authorSelectors = ['.author', '.post-author', '.byline', '[rel="author"]'];
    for (var i = 0; i < authorSelectors.length; i++) {
      var el = document.querySelector(authorSelectors[i]);
      if (el && el.textContent.trim().length > 0) {
        return el.textContent.trim();
      }
    }
    return '';
  }

  function extractPublishDate() {
    // meta 标签
    var meta = document.querySelector('meta[property="article:published_time"]');
    if (meta && meta.content) {
      return meta.content;
    }
    // time 元素
    var timeEl = document.querySelector('time');
    if (timeEl) {
      var datetime = timeEl.getAttribute('datetime');
      if (datetime) return datetime;
      if (timeEl.textContent.trim().length > 0) return timeEl.textContent.trim();
    }
    return '';
  }

  // ========================
  // 内容清理
  // ========================

  function cleanContent(contentEl) {
    // 克隆节点，不修改原始 DOM
    var clone = contentEl.cloneNode(true);

    // 移除不需要的标签
    var removeTags = ['script', 'style', 'iframe', 'nav', 'aside'];
    for (var i = 0; i < removeTags.length; i++) {
      var elements = clone.querySelectorAll(removeTags[i]);
      for (var j = 0; j < elements.length; j++) {
        elements[j].parentNode.removeChild(elements[j]);
      }
    }

    // 移除广告/评论/社交类元素
    var allElements = clone.querySelectorAll('*');
    for (var k = 0; k < allElements.length; k++) {
      if (hasPenaltyName(allElements[k])) {
        allElements[k].parentNode.removeChild(allElements[k]);
      }
    }

    // 移除小图片
    var images = clone.querySelectorAll('img');
    for (var m = 0; m < images.length; m++) {
      var img = images[m];
      var w = parseInt(img.getAttribute('width'), 10) || img.naturalWidth || 0;
      var h = parseInt(img.getAttribute('height'), 10) || img.naturalHeight || 0;
      // 如果设置了宽高属性且小于阈值，移除
      if ((w > 0 && w < MIN_IMAGE_SIZE) || (h > 0 && h < MIN_IMAGE_SIZE)) {
        img.parentNode.removeChild(img);
      }
    }

    // 移除空段落
    var paragraphs = clone.querySelectorAll('p');
    for (var n = 0; n < paragraphs.length; n++) {
      if (paragraphs[n].textContent.trim().length === 0 && !paragraphs[n].querySelector('img')) {
        paragraphs[n].parentNode.removeChild(paragraphs[n]);
      }
    }

    return clone.innerHTML;
  }

  // ========================
  // 界面构建
  // ========================

  var currentFontSize = DEFAULT_FONT_SIZE;
  var currentThemeIndex = 0;

  function buildOverlay(title, author, pubDate, contentHTML) {
    var theme = THEMES[currentThemeIndex];

    var overlay = document.createElement('div');
    overlay.id = 'reading-mode-overlay';

    // 控制栏
    var controlBar = document.createElement('div');
    controlBar.id = 'reading-mode-controls';

    var controlInner = document.createElement('div');
    controlInner.className = 'rm-controls-inner';

    // 字体大小控制
    var fontGroup = document.createElement('div');
    fontGroup.className = 'rm-control-group';

    var fontDown = document.createElement('button');
    fontDown.className = 'rm-btn rm-font-btn';
    fontDown.textContent = 'A-';
    fontDown.title = '缩小字体';

    var fontUp = document.createElement('button');
    fontUp.className = 'rm-btn rm-font-btn';
    fontUp.textContent = 'A+';
    fontUp.title = '放大字体';

    var fontLabel = document.createElement('span');
    fontLabel.className = 'rm-font-label';
    fontLabel.textContent = currentFontSize + 'px';

    fontGroup.appendChild(fontDown);
    fontGroup.appendChild(fontLabel);
    fontGroup.appendChild(fontUp);

    // 主题控制
    var themeGroup = document.createElement('div');
    themeGroup.className = 'rm-control-group';

    for (var t = 0; t < THEMES.length; t++) {
      var themeBtn = document.createElement('button');
      themeBtn.className = 'rm-btn rm-theme-btn' + (t === currentThemeIndex ? ' rm-theme-active' : '');
      themeBtn.textContent = THEMES[t].name;
      themeBtn.setAttribute('data-theme-index', t);
      themeGroup.appendChild(themeBtn);
    }

    // 退出按钮
    var exitBtn = document.createElement('button');
    exitBtn.className = 'rm-btn rm-exit-btn';
    exitBtn.textContent = '退出阅读';

    controlInner.appendChild(fontGroup);
    controlInner.appendChild(themeGroup);
    controlInner.appendChild(exitBtn);
    controlBar.appendChild(controlInner);

    // 内容区域
    var contentArea = document.createElement('div');
    contentArea.id = 'reading-mode-content';

    // 标题
    var titleEl = document.createElement('h1');
    titleEl.className = 'rm-title';
    titleEl.textContent = title;

    // 元信息
    var metaEl = document.createElement('div');
    metaEl.className = 'rm-meta';
    var metaParts = [];
    if (author) metaParts.push(author);
    if (pubDate) metaParts.push(pubDate);
    metaEl.textContent = metaParts.join('  |  ');

    // 正文
    var bodyEl = document.createElement('div');
    bodyEl.className = 'rm-body';
    bodyEl.innerHTML = contentHTML;

    contentArea.appendChild(titleEl);
    if (metaEl.textContent) {
      contentArea.appendChild(metaEl);
    }
    contentArea.appendChild(bodyEl);

    overlay.appendChild(controlBar);
    overlay.appendChild(contentArea);

    // 注入样式
    var style = document.createElement('style');
    style.id = 'reading-mode-styles';
    style.textContent = buildCSS(theme);
    overlay.appendChild(style);

    document.body.appendChild(overlay);

    // ========================
    // 事件绑定
    // ========================

    fontDown.addEventListener('click', function () {
      if (currentFontSize > MIN_FONT_SIZE) {
        currentFontSize -= 2;
        fontLabel.textContent = currentFontSize + 'px';
        bodyEl.style.fontSize = currentFontSize + 'px';
      }
    });

    fontUp.addEventListener('click', function () {
      if (currentFontSize < MAX_FONT_SIZE) {
        currentFontSize += 2;
        fontLabel.textContent = currentFontSize + 'px';
        bodyEl.style.fontSize = currentFontSize + 'px';
      }
    });

    themeGroup.addEventListener('click', function (e) {
      var target = e.target;
      if (target.getAttribute('data-theme-index')) {
        var idx = parseInt(target.getAttribute('data-theme-index'), 10);
        currentThemeIndex = idx;
        var newTheme = THEMES[idx];

        // 更新样式
        style.textContent = buildCSS(newTheme);

        // 更新主题按钮状态
        var themeBtns = themeGroup.querySelectorAll('.rm-theme-btn');
        for (var b = 0; b < themeBtns.length; b++) {
          themeBtns[b].className = 'rm-btn rm-theme-btn';
          if (parseInt(themeBtns[b].getAttribute('data-theme-index'), 10) === idx) {
            themeBtns[b].className = 'rm-btn rm-theme-btn rm-theme-active';
          }
        }
      }
    });

    exitBtn.addEventListener('click', function () {
      var el = document.getElementById('reading-mode-overlay');
      if (el) {
        el.parentNode.removeChild(el);
      }
    });

    // ESC 键退出
    function onKeydown(e) {
      if (e.key === 'Escape') {
        var el = document.getElementById('reading-mode-overlay');
        if (el) {
          el.parentNode.removeChild(el);
        }
        document.removeEventListener('keydown', onKeydown);
      }
    }
    document.addEventListener('keydown', onKeydown);
  }

  // ========================
  // CSS 生成
  // ========================

  function buildCSS(theme) {
    return '' +
      '#reading-mode-overlay {' +
      '  position: fixed;' +
      '  inset: 0;' +
      '  z-index: 999998;' +
      '  background: ' + theme.bg + ';' +
      '  color: ' + theme.text + ';' +
      '  overflow-y: auto;' +
      '  font-family: "Georgia", "Noto Serif SC", serif;' +
      '  transition: background 0.3s ease, color 0.3s ease;' +
      '}' +
      '' +
      '#reading-mode-controls {' +
      '  position: sticky;' +
      '  top: 0;' +
      '  z-index: 1;' +
      '  background: ' + theme.barBg + ';' +
      '  border-bottom: 1px solid ' + theme.border + ';' +
      '  padding: 10px 30px;' +
      '  transition: background 0.3s ease, border-color 0.3s ease;' +
      '}' +
      '' +
      '.rm-controls-inner {' +
      '  max-width: 720px;' +
      '  margin: 0 auto;' +
      '  display: flex;' +
      '  align-items: center;' +
      '  gap: 12px;' +
      '  flex-wrap: wrap;' +
      '}' +
      '' +
      '.rm-control-group {' +
      '  display: flex;' +
      '  align-items: center;' +
      '  gap: 6px;' +
      '}' +
      '' +
      '.rm-btn {' +
      '  border: 1px solid ' + theme.border + ';' +
      '  background: ' + theme.bg + ';' +
      '  color: ' + theme.text + ';' +
      '  cursor: pointer;' +
      '  font-size: 14px;' +
      '  padding: 4px 10px;' +
      '  border-radius: 4px;' +
      '  transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;' +
      '}' +
      '' +
      '.rm-btn:hover {' +
      '  opacity: 0.8;' +
      '}' +
      '' +
      '.rm-font-btn {' +
      '  font-weight: bold;' +
      '  font-family: sans-serif;' +
      '}' +
      '' +
      '.rm-font-label {' +
      '  font-size: 13px;' +
      '  min-width: 36px;' +
      '  text-align: center;' +
      '}' +
      '' +
      '.rm-theme-btn {' +
      '  font-size: 13px;' +
      '}' +
      '' +
      '.rm-theme-active {' +
      '  font-weight: bold;' +
      '  border-color: ' + theme.text + ';' +
      '}' +
      '' +
      '.rm-exit-btn {' +
      '  margin-left: auto;' +
      '  font-size: 13px;' +
      '}' +
      '' +
      '#reading-mode-content {' +
      '  max-width: 720px;' +
      '  margin: 0 auto;' +
      '  padding: 40px 30px;' +
      '}' +
      '' +
      '.rm-title {' +
      '  font-size: 28px;' +
      '  font-weight: bold;' +
      '  line-height: 1.4;' +
      '  margin-bottom: 20px;' +
      '}' +
      '' +
      '.rm-meta {' +
      '  font-size: 14px;' +
      '  color: ' + theme.meta + ';' +
      '  margin-bottom: 30px;' +
      '  transition: color 0.3s ease;' +
      '}' +
      '' +
      '.rm-body {' +
      '  font-size: ' + currentFontSize + 'px;' +
      '  line-height: 1.8;' +
      '  word-break: break-word;' +
      '  transition: font-size 0.2s ease;' +
      '}' +
      '' +
      '.rm-body p {' +
      '  margin-bottom: 16px;' +
      '}' +
      '' +
      '.rm-body img {' +
      '  max-width: 100%;' +
      '  height: auto;' +
      '  display: block;' +
      '  margin: 20px auto;' +
      '  border-radius: 4px;' +
      '}' +
      '' +
      '.rm-body a {' +
      '  color: ' + theme.text + ';' +
      '  text-decoration: underline;' +
      '  transition: color 0.3s ease;' +
      '}' +
      '' +
      '.rm-body a:hover {' +
      '  opacity: 0.7;' +
      '}' +
      '' +
      '.rm-body pre, .rm-body code {' +
      '  font-family: "Consolas", "Monaco", "Courier New", monospace;' +
      '}' +
      '' +
      '.rm-body pre {' +
      '  background: ' + theme.barBg + ';' +
      '  padding: 16px;' +
      '  border-radius: 4px;' +
      '  overflow-x: auto;' +
      '  margin-bottom: 16px;' +
      '  transition: background 0.3s ease;' +
      '}' +
      '' +
      '.rm-body code {' +
      '  background: ' + theme.barBg + ';' +
      '  padding: 2px 6px;' +
      '  border-radius: 3px;' +
      '  font-size: 0.9em;' +
      '  transition: background 0.3s ease;' +
      '}' +
      '' +
      '.rm-body pre code {' +
      '  background: none;' +
      '  padding: 0;' +
      '}' +
      '' +
      '.rm-body blockquote {' +
      '  border-left: 4px solid ' + theme.border + ';' +
      '  margin: 16px 0;' +
      '  padding: 8px 20px;' +
      '  color: ' + theme.meta + ';' +
      '  transition: border-color 0.3s ease, color 0.3s ease;' +
      '}' +
      '' +
      '.rm-body h1, .rm-body h2, .rm-body h3, .rm-body h4, .rm-body h5, .rm-body h6 {' +
      '  margin-top: 24px;' +
      '  margin-bottom: 12px;' +
      '  line-height: 1.4;' +
      '}' +
      '' +
      '.rm-body h1 { font-size: 1.6em; }' +
      '.rm-body h2 { font-size: 1.4em; }' +
      '.rm-body h3 { font-size: 1.2em; }' +
      '.rm-body h4 { font-size: 1.1em; }' +
      '' +
      '.rm-body ul, .rm-body ol {' +
      '  margin-bottom: 16px;' +
      '  padding-left: 24px;' +
      '}' +
      '' +
      '.rm-body li {' +
      '  margin-bottom: 6px;' +
      '}' +
      '' +
      '.rm-body table {' +
      '  border-collapse: collapse;' +
      '  width: 100%;' +
      '  margin-bottom: 16px;' +
      '}' +
      '' +
      '.rm-body th, .rm-body td {' +
      '  border: 1px solid ' + theme.border + ';' +
      '  padding: 8px 12px;' +
      '  text-align: left;' +
      '  transition: border-color 0.3s ease;' +
      '}' +
      '' +
      '.rm-body th {' +
      '  background: ' + theme.barBg + ';' +
      '  font-weight: bold;' +
      '  transition: background 0.3s ease;' +
      '}' +
      '' +
      '@media print {' +
      '  #reading-mode-controls {' +
      '    display: none;' +
      '  }' +
      '  #reading-mode-overlay {' +
      '    position: static;' +
      '    background: #fff;' +
      '    color: #333;' +
      '  }' +
      '  #reading-mode-content {' +
      '    max-width: 100%;' +
      '    padding: 0;' +
      '  }' +
      '  .rm-body {' +
      '    font-size: 12pt;' +
      '  }' +
      '  .rm-body a {' +
      '    color: #333;' +
      '    text-decoration: underline;' +
      '  }' +
      '}' +
      '';
  }

  // ========================
  // 主逻辑
  // ========================

  var mainContent = findMainContent();

  if (!mainContent) {
    // 未找到主内容区域，提示用户
    var noContentOverlay = document.createElement('div');
    noContentOverlay.id = 'reading-mode-overlay';
    noContentOverlay.style.cssText = 'position:fixed;inset:0;z-index:999998;background:#f8f5f0;display:flex;align-items:center;justify-content:center;font-family:"Georgia","Noto Serif SC",serif;';

    var msgBox = document.createElement('div');
    msgBox.style.cssText = 'text-align:center;color:#888;';

    var msgText = document.createElement('p');
    msgText.style.cssText = 'font-size:18px;margin-bottom:20px;';
    msgText.textContent = '未能识别页面正文内容';

    var closeBtn = document.createElement('button');
    closeBtn.textContent = '关闭';
    closeBtn.style.cssText = 'padding:8px 24px;border:1px solid #d8d2c8;background:#f8f5f0;color:#333;cursor:pointer;border-radius:4px;font-size:14px;';
    closeBtn.addEventListener('click', function () {
      var el = document.getElementById('reading-mode-overlay');
      if (el) el.parentNode.removeChild(el);
    });

    msgBox.appendChild(msgText);
    msgBox.appendChild(closeBtn);
    noContentOverlay.appendChild(msgBox);
    document.body.appendChild(noContentOverlay);
    return;
  }

  var title = extractTitle();
  var author = extractAuthor();
  var pubDate = extractPublishDate();
  var contentHTML = cleanContent(mainContent);

  buildOverlay(title, author, pubDate, contentHTML);

})();
