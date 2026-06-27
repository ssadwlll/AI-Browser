// GEO AI发布助手 - 主入口模块

// 防止重复注入
if (window.__GEO_SCRIPT_LOADED__) {
  console.log('AI发布助手: 脚本已加载，跳过重复注入');
} else {
  window.__GEO_SCRIPT_LOADED__ = true;

  // 验证样式模块已加载
  if (!document.getElementById('geo-sidebar-css')) {
    console.warn('AI发布助手: 样式模块未加载，可能存在加载顺序问题');
  }

  console.log('AI发布助手: 脚本开始加载，当前URL:', window.location.href);

  let sidebarInjected = false;
  let monitorTimer = null;
  let _configLoaded = false;
  let _configLoadPromise = null;

  function init() {
    console.log('AI发布助手: 初始化');
    initTemplateOptions();
    _configLoadPromise = loadTemplateConfig().then(() => { _configLoaded = true; });
    if (detectFormFields()) {
      injectSidebarAndSetup();
    }
    startFormDetection();
  }

  function injectSidebarAndSetup() {
    if (sidebarInjected) return;
    sidebarInjected = true;
    injectSidebar();
    setupIframeListener();
  }

  function removeSidebar() {
    if (!sidebarInjected) return;
    sidebarInjected = false;
    const sidebar = document.getElementById('geo-sidebar');
    const toggle = document.getElementById('geo-toggle');
    if (sidebar) sidebar.remove();
    if (toggle) toggle.remove();
    console.log('AI发布助手: 已移除侧边栏');
  }

  /**
   * 持续监听表单字段出现/消失
   */
  function startFormDetection() {
    if (monitorTimer) return;
    monitorTimer = setInterval(() => {
      const formExists = detectFormFields();
      if (formExists && !sidebarInjected) {
        injectSidebarAndSetup();
      } else if (!formExists && sidebarInjected) {
        removeSidebar();
      }
    }, 2000);
  }

  /**
   * 检测页面中是否存在发布表单字段
   */
  function detectFormFields() {
    return !!findElementRecursively(document, 'news_tnNewsVo_title', 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 100);
  }

  window.addEventListener('load', () => {
    console.log('AI发布助手: 页面加载完成');
    setTimeout(init, 500);
  });

  /**
   * 注入侧边栏HTML结构
   */
  function injectSidebar() {
    if (document.getElementById('geo-sidebar')) return;

    const toggleButtonHTML = `
      <button id="geo-toggle">
        <span class="geo-toggle-icon">🤖</span>
        <span class="geo-toggle-text">AI<br>助手</span>
      </button>
    `;

    const sidebarHTML = `
      <div id="geo-sidebar" class="geo-sidebar geo-sidebar-collapsed">
        <div class="geo-resize-handle" id="geo-resize-handle"></div>
        <div class="geo-sidebar-content">
          <div class="geo-sidebar-header">
            <h3>🤖 北方网AI发布助手</h3>
            <button class="geo-btn-close" id="geo-close">×</button>
          </div>

          <div class="geo-status-area">
            <div class="geo-status-item">
              <span class="geo-label">标题：</span>
              <span class="geo-value" id="geo-title-preview">未识别</span>
            </div>
            <div class="geo-status-item">
              <span class="geo-label">正文：</span>
              <span class="geo-value" id="geo-content-length">0 字</span>
            </div>
            <div class="geo-status-item">
              <span class="geo-label">状态：</span>
              <span class="geo-value geo-status-badge" id="geo-recognize-status">待识别</span>
            </div>
          </div>

          <div class="geo-action-buttons">
            <button class="geo-btn geo-btn-refresh" id="geo-btn-refresh" data-action="refresh">
              <span class="geo-btn-icon">🔄</span>
              <span class="geo-btn-text">读取状态</span>
            </button>
            <button class="geo-btn geo-btn-primary" id="geo-btn-complete" data-action="complete">
              <span class="geo-btn-icon">📝</span>
              <span class="geo-btn-text">AI补全信息</span>
            </button>
          </div>

          <div class="geo-tabs" id="geo-tabs" style="display: none;">
            <div class="geo-action-bar" id="geo-action-bar">
              <button class="geo-btn-small geo-btn-adopt-all" data-action="adopt-all">一键采用全部</button>
              <button class="geo-btn-small geo-btn-preview" data-action="preview-modal">预览</button>
            </div>
            <div class="geo-tab-bar">
              <button class="geo-tab-btn active" data-tab="complete">补全结果</button>
              <button class="geo-tab-btn" data-tab="knowledge">知识卡片</button>
            </div>
            <div class="geo-tab-panels">
              <div class="geo-tab-panel active" id="geo-panel-complete"></div>
              <div class="geo-tab-panel" id="geo-panel-knowledge"></div>
            </div>
          </div>

          <div class="geo-loading" id="geo-loading" style="display: none;">
            <div class="geo-spinner"></div>
            <span>AI处理中...</span>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', toggleButtonHTML);
    document.body.insertAdjacentHTML('beforeend', sidebarHTML);
    initSidebarInteraction();
    setTimeout(autoRecognize, 1000);
  }

  /**
   * 监听iframe加载事件
   */
  function setupIframeListener() {
    const findIframe = () => {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
          if (iframeDoc && (iframeDoc.getElementById('news_tnNewsVo_title') || iframeDoc.getElementById('news_clobs_content_'))) {
            console.log('AI发布助手: 找到目标iframe');
            return iframe;
          }
        } catch (e) {}
      }
      return null;
    };

    const setupInputListeners = (doc) => {
      try {
        const titleInput = doc.getElementById('news_tnNewsVo_title');
        const contentTextarea = doc.getElementById('news_clobs_content_');

        const onFieldChange = (fieldName) => {
          console.log('AI发布助手:', fieldName, '变化');
          setTimeout(autoRecognize, 300);
        };

        if (titleInput) {
          ['input', 'change', 'paste', 'keyup', 'mouseup'].forEach(evt => {
            titleInput.addEventListener(evt, () => onFieldChange('标题'));
          });
          titleInput.addEventListener('blur', () => onFieldChange('标题'));
        }

        if (contentTextarea) {
          ['input', 'change', 'paste', 'keyup', 'mouseup'].forEach(evt => {
            contentTextarea.addEventListener(evt, () => onFieldChange('正文'));
          });
          contentTextarea.addEventListener('blur', () => onFieldChange('正文'));
        }
      } catch (e) {
        console.log('无法设置输入监听器:', e.message);
      }
    };

    const checkInterval = setInterval(() => {
      const iframe = findIframe();
      if (iframe) {
        clearInterval(checkInterval);
        iframe.addEventListener('load', () => {
          console.log('AI发布助手: iframe内容加载，重新识别');
          setTimeout(() => {
            try {
              const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
              setupInputListeners(iframeDoc);
            } catch (e) {}
            autoRecognize();
          }, 500);
        });

        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
          setupInputListeners(iframeDoc);
        } catch (e) {}

        setupInputListeners(document);

        // 定时检查（兜底机制）
        let lastTitle = '';
        let lastContentLen = 0;
        setInterval(async () => {
          const result = await GeoFieldReader.readTitleAndContent();
          const currentTitle = result.title || '';
          const currentLen = result.contentLength || 0;
          if (currentTitle !== lastTitle || currentLen !== lastContentLen) {
            console.log('AI发布助手: 检测到内容变化（轮询）');
            lastTitle = currentTitle;
            lastContentLen = currentLen;
            autoRecognize();
          }
        }, 3000);

        // 定时检查DOM变化
        let timer = null;
        try {
          const iframeDoc = iframe.contentDocument;
          if (iframeDoc) {
            iframeDoc.addEventListener('DOMSubtreeModified', () => {
              clearTimeout(timer);
              timer = setTimeout(() => {
                setupInputListeners(iframeDoc);
                autoRecognize();
              }, 1000);
            });
          }
        } catch (e) {}
      }
    }, 500);
    setTimeout(() => clearInterval(checkInterval), 30000);
  }

  /**
   * 初始化侧边栏交互
   */
  function initSidebarInteraction() {
    const sidebar = document.getElementById('geo-sidebar');
    const toggleBtn = document.getElementById('geo-toggle');

    toggleBtn.addEventListener('click', () => {
      sidebar.classList.remove('geo-sidebar-collapsed');
      sidebar.classList.add('geo-sidebar-expanded');
      autoRecognize();
    });

    document.getElementById('geo-close').addEventListener('click', () => {
      sidebar.classList.remove('geo-sidebar-expanded');
      sidebar.classList.add('geo-sidebar-collapsed');
      setTimeout(autoRecognize, 300);
    });

    document.querySelectorAll('.geo-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tabName = btn.dataset.tab;
        document.querySelectorAll('.geo-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.geo-tab-panel').forEach(p => p.classList.remove('active'));
        const panel = document.getElementById('geo-panel-' + tabName);
        if (panel) panel.classList.add('active');
      });
    });

    document.getElementById('geo-btn-refresh').addEventListener('click', handleRefreshStatus);
    document.getElementById('geo-btn-complete').addEventListener('click', handleCompleteInfo);

    // 拖拽调整宽度
    const resizeHandle = document.getElementById('geo-resize-handle');
    if (resizeHandle) {
      let isResizing = false;
      let startX = 0;
      let startWidth = 0;

      resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = sidebar.offsetWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const diff = startX - e.clientX;
        const newWidth = Math.min(Math.max(startWidth + diff, 300), 800);
        sidebar.style.width = newWidth + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (!isResizing) return;
        isResizing = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      });
    }
  }

  /**
   * 读取状态按钮处理
   */
  async function handleRefreshStatus() {
    const result = await GeoFieldReader.readTitleAndContent();
    updateStatusUI(result);
    if (result.title || result.contentLength > 0) {
      showToast('状态已更新');
    } else {
      showToast('未检测到标题或正文', 'error');
    }
  }

  /**
   * 自动识别页面内容
   */
  async function autoRecognize() {
    console.log('AI发布助手: 尝试读取标题和正文');
    const result = await GeoFieldReader.readTitleAndContent();
    console.log('AI发布助手: 读取结果', result);
    updateStatusUI(result);
  }

  /**
   * 更新状态UI
   */
  function updateStatusUI(result) {
    const titlePreview = document.getElementById('geo-title-preview');
    const contentLength = document.getElementById('geo-content-length');
    const statusBadge = document.getElementById('geo-recognize-status');

    if (!titlePreview || !contentLength || !statusBadge) return;

    const title = result.title || '';
    titlePreview.textContent = title.length > 30 ? title.substring(0, 30) + '...' : (title || '空');
    contentLength.textContent = (result.contentLength || 0) + ' 字';

    if (result.contentLength > 0) {
      statusBadge.textContent = '已就绪';
      statusBadge.className = 'geo-value geo-status-badge geo-status-ready';
    } else if (title) {
      statusBadge.textContent = '正文缺失';
      statusBadge.className = 'geo-value geo-status-badge geo-status-warning';
    } else {
      statusBadge.textContent = '待输入';
      statusBadge.className = 'geo-value geo-status-badge geo-status-pending';
    }
  }

  /**
   * 处理补全发布信息
   */
  async function handleCompleteInfo() {
    // 等待模板配置加载完成（确保 apiBaseUrl 已设置）
    if (!_configLoaded && _configLoadPromise) {
      await _configLoadPromise;
    }

    const result = await GeoFieldReader.readTitleAndContent();
    if (!result.content) {
      showToast('正文为空，无法补全发布信息', 'error');
      return;
    }

    let content = result.content.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (content.length > 30000) {
      content = content.substring(0, 30000) + '...（正文过长已截断）';
    }

    // 记录开始时间
    const startTime = Date.now();
    const startTimeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });

    showLoading(true);
    try {
      let aiResult;
      let providerName = '';
      let durationInfo = {};

      const config = await safeSendMessage({ action: 'getConfig' });
      const mode = config ? config.providerMode : 'mock';

      if (mode === 'mock') {
        const mockStart = Date.now();
        aiResult = await GeoMockProvider.completePublishInfo(content);
        const mockEnd = Date.now();
        providerName = 'Mock模式';
        durationInfo = {
          total: (mockEnd - startTime),
          mock: (mockEnd - mockStart)
        };
      } else if (mode === 'dmx') {
        // 大模型直连模式
        const dmxStart = Date.now();
        await GeoDmxProvider.init();
        aiResult = await GeoDmxProvider.completePublishInfo(content);
        const dmxEnd = Date.now();
        providerName = '大模型(' + GeoDmxProvider.getModel() + ')';
        durationInfo = {
          total: (dmxEnd - startTime),
          api: (dmxEnd - dmxStart)
        };
      } else {
        const configured = await GeoCozeProvider.init();
        if (configured) {
          const cozeStart = Date.now();
          aiResult = await GeoCozeProvider.completePublishInfo(content);
          const cozeEnd = Date.now();
          providerName = 'Coze工作流';
          durationInfo = {
            total: (cozeEnd - startTime),
            coze: (cozeEnd - cozeStart),
            ...(aiResult._durationInfo || {})
          };
        } else {
          const mockStart = Date.now();
          aiResult = await GeoMockProvider.completePublishInfo(content);
          const mockEnd = Date.now();
          aiResult._fallbackToMock = true;
          aiResult._fallbackReason = 'Coze初始化失败';
          providerName = 'Mock模式(未配置)';
          durationInfo = {
            total: (mockEnd - startTime),
            mock: (mockEnd - mockStart)
          };
        }
      }

      // 计算处理时间
      const endTime = Date.now();
      const totalDuration = endTime - startTime;
      const durationStr = totalDuration < 1000 ? totalDuration + 'ms' : (totalDuration / 1000).toFixed(2) + '秒';

      // 在结果中添加详细时间信息
      aiResult.processTime = {
        startTime: startTimeStr,
        endTime: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        duration: durationStr,
        provider: providerName,
        details: {
          total: durationStr,
          network: durationInfo.network ? (durationInfo.network < 1000 ? durationInfo.network + 'ms' : (durationInfo.network/1000).toFixed(2) + '秒') : null,
          api: durationInfo.api ? (durationInfo.api < 1000 ? durationInfo.api + 'ms' : (durationInfo.api/1000).toFixed(2) + '秒') : null,
          coze: durationInfo.coze ? (durationInfo.coze < 1000 ? durationInfo.coze + 'ms' : (durationInfo.coze/1000).toFixed(2) + '秒') : null,
          mock: durationInfo.mock ? (durationInfo.mock < 1000 ? durationInfo.mock + 'ms' : (durationInfo.mock/1000).toFixed(2) + '秒') : null
        }
      };

      showResult(aiResult);
    } catch (error) {
      console.error('AI处理失败:', error);
      showToast('AI处理失败: ' + error.message, 'error');
    } finally {
      showLoading(false);
    }
  }

  /**
   * 显示结果卡片（合并补全发布信息 + 知识卡片）
   */
  function showResult(data) {
    const panelComplete = document.getElementById('geo-panel-complete');
    const panelKnowledge = document.getElementById('geo-panel-knowledge');
    const tabs = document.getElementById('geo-tabs');
    if (!panelComplete || !panelKnowledge || !tabs) return;

    // Mock回退提示
    if (data._fallbackToMock) {
      const reason = data._fallbackReason || '未知原因';
      showToast('AI服务调用失败，已回退到模拟数据：' + reason, 'warning', 8000);
    }

    // 存储补全结果供JSON-LD使用
    window._geoCompleteData = data;

    // 补全结果面板
    let completeHtml = '';

    // 添加处理时间信息
    if (data.processTime) {
      let detailsHtml = '';
      if (data.processTime.details) {
        const details = data.processTime.details;
        const detailItems = [];
        if (details.network) detailItems.push('网络: ' + details.network);
        if (details.api) detailItems.push('API: ' + details.api);
        if (details.coze) detailItems.push('Coze: ' + details.coze);
        if (details.mock) detailItems.push('Mock: ' + details.mock);
        if (detailItems.length > 0) {
          detailsHtml = '<div class="geo-process-details">' +
            '<div class="geo-process-detail-label">细分耗时:</div>' +
            '<div class="geo-process-detail-items">' + detailItems.join(' | ') + '</div>' +
          '</div>';
        }
      }

      completeHtml += '<div class="geo-process-time">' +
        '<div class="geo-process-main">' +
          '<div class="geo-process-item">' +
            '<span class="geo-process-label">来源:</span>' +
            '<span class="geo-process-value">' + data.processTime.provider + '</span>' +
          '</div>' +
          '<div class="geo-process-item">' +
            '<span class="geo-process-label">总耗时:</span>' +
            '<span class="geo-process-value geo-process-duration">' + data.processTime.duration + '</span>' +
          '</div>' +
          '<div class="geo-process-item">' +
            '<span class="geo-process-label">时间:</span>' +
            '<span class="geo-process-value">' + data.processTime.startTime + '</span>' +
          '</div>' +
        '</div>' +
        detailsHtml +
      '</div>';
    }

    if (data.title) completeHtml += createCard('标题', data.title, 'title');
    if (data.summary) completeHtml += createCard('摘要', data.summary, 'summary');
    if (data.introduction) completeHtml += createCard('导读', data.introduction, 'introduction');
    if (data.authors && data.authors.length > 0) completeHtml += createAuthorsCard(data.authors);
    if (data.keywords && data.keywords.length > 0) completeHtml += createKeywordsCard(data.keywords);
    if (data.tags && data.tags.length > 0) completeHtml += createTagsCard(data.tags);
    if (data.entities && data.entities.length > 0) completeHtml += createEntitiesCard(data.entities);
    if (data.qa && data.qa.length > 0) completeHtml += createQACard(data.qa);

    // 知识卡片面板
    let knowledgeHtml = '';
    const templateId = data.templateId || '';
    if (templateId) {
      const fields = data.fields || [];
      const requiredFields = fields.filter(f => f.required);
      const optionalFields = fields.filter(f => !f.required);
      const confidence = data.confidence || 0;
      const reason = data.classifyReason || '';

      const currentOption = TEMPLATE_OPTIONS.find(o => o.id === templateId);
      const templateIcon = currentOption ? currentOption.icon : '📋';
      const templateName = data.templateName || (currentOption ? currentOption.name : templateId);

      const missingFields = requiredFields.filter(f => {
        const val = f.value !== undefined ? f.value : data[f.key];
        if (val === undefined || val === null || val === '' || (Array.isArray(val) && val.length === 0)) {
          return true;
        }
        return false;
      });

      knowledgeHtml += '<div class="geo-kc-template">' +
        '<div class="geo-kc-template-header">' +
          '<span class="geo-kc-template-icon">' + templateIcon + '</span>' +
          '<span class="geo-kc-template-name">' + templateName + '</span>' +
          '<span class="geo-kc-confidence">置信度 ' + Math.round(confidence * 100) + '%</span>' +
        '</div>' +
        (reason ? '<div class="geo-kc-reason">推荐理由：' + reason + '</div>' : '') +
        '<div class="geo-kc-template-switch">' +
          '<span>切换模板：</span>' +
          '<select class="geo-kc-template-select" id="geo-kc-template-select">';

      TEMPLATE_OPTIONS.forEach(opt => {
        knowledgeHtml += '<option value="' + opt.id + '" ' + (opt.id === templateId ? 'selected' : '') + '>' + opt.icon + ' ' + opt.name + '</option>';
      });

      knowledgeHtml += '</select></div></div>';

      if (missingFields.length > 0) {
        const missingLabels = missingFields.map(f => f.label || f.key);
        knowledgeHtml += '<div class="geo-kc-missing">' +
          '<span class="geo-kc-missing-icon">⚠️</span>' +
          '<span>缺失必填字段：' + missingLabels.join('、') + '</span>' +
        '</div>';
      }

      knowledgeHtml += '<div class="geo-kc-fields">';

      requiredFields.forEach(field => {
        const val = field.value !== undefined ? field.value : data[field.key];
        const evidence = field.evidence || data[field.key + '_evidence'] || '';
        knowledgeHtml += createKCEditField(field.key, val, evidence, field.label, true);
      });

      optionalFields.forEach(field => {
        const val = field.value !== undefined ? field.value : data[field.key];
        const evidence = field.evidence || data[field.key + '_evidence'] || '';
        if (val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && val.length === 0)) {
          knowledgeHtml += createKCEditField(field.key, val, evidence, field.label, false);
        }
      });

      knowledgeHtml += '</div>';
    } else {
      knowledgeHtml = '<div style="text-align:center;color:#999;padding:30px 0;font-size:13px;">暂无知识卡片数据</div>';
    }

    panelComplete.innerHTML = completeHtml;
    panelKnowledge.innerHTML = knowledgeHtml;
    tabs.style.display = 'flex';
    // 记住当前Tab，避免切换模板时跳回
    const currentTab = document.querySelector('.geo-tab-btn.active');
    const currentTabName = currentTab ? currentTab.dataset.tab : 'complete';
    switchTab(currentTabName);
    bindCardEvents();
    if (templateId) {
      bindKnowledgeCardEvents(data, templateId);
    }
  }

  function switchTab(tabName) {
    document.querySelectorAll('.geo-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.geo-tab-panel').forEach(p => p.classList.remove('active'));
    const btn = document.querySelector('.geo-tab-btn[data-tab="' + tabName + '"]');
    const panel = document.getElementById('geo-panel-' + tabName);
    if (btn) btn.classList.add('active');
    if (panel) panel.classList.add('active');
  }

}
