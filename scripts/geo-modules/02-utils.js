// GEO AI发布助手 - 工具函数模块

function safeSendMessage(message, callback) {
  return new Promise((resolve) => {
    const config = window.GEO_CONFIG || {};
    if (message.action === 'getConfig') {
      resolve({
        providerMode: config.providerMode || 'mock',
        dmxModel: config.dmxModel || 'gpt-4o-mini',
        dmxApiKey: config.dmxApiKey || '',
        cozeApiUrl: config.cozeApiUrl || '',
        cozeWorkflowId: config.cozeWorkflowId || '',
        apiBaseUrl: config.apiBaseUrl || '',
      });
    } else if (message.action === 'saveConfig') {
      Object.assign(window.GEO_CONFIG, message.data);
      try { localStorage.setItem('geo_config', JSON.stringify(message.data)); } catch(e) {}
      resolve({ success: true });
    } else if (message.action === 'saveToKnowledgeBase') {
      try {
        const kb = JSON.parse(localStorage.getItem('geo_knowledge_base') || '[]');
        kb.push({ ...message.data, savedAt: new Date().toISOString() });
        localStorage.setItem('geo_knowledge_base', JSON.stringify(kb));
        resolve({ success: true, count: kb.length });
      } catch (e) { resolve({ success: false }); }
    } else {
      resolve({});
    }
    if (typeof callback === 'function') callback(resolve);
  });
}

function findElementRecursively(doc, fieldId, depth, maxDepth) {
  maxDepth = maxDepth || 5;
  if (depth > maxDepth) return null;

  const element = doc.getElementById(fieldId);
  if (element) return element;

  try {
    const iframes = doc.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (!iframeDoc) continue;
        const found = findElementRecursively(iframeDoc, fieldId, depth + 1, maxDepth);
        if (found) return found;
      } catch (e) {
        // 跨域iframe无法访问
      }
    }
  } catch (error) {}

  return null;
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    showToast('已复制到剪贴板');
  } catch (e) {
    showToast('复制失败，请手动选择复制', 'error');
  }
  document.body.removeChild(textarea);
}

function showToast(message, type, duration) {
  type = type || 'success';
  duration = duration || 2000;
  const existing = document.getElementById('geo-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'geo-toast';
  toast.className = 'geo-toast geo-toast-' + type;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('geo-toast-show');
  });

  setTimeout(() => {
    toast.classList.remove('geo-toast-show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function showLoading(show) {
  const loading = document.getElementById('geo-loading');
  if (loading) {
    loading.style.display = show ? 'flex' : 'none';
    document.querySelectorAll('.geo-action-buttons .geo-btn').forEach(btn => {
      btn.disabled = show;
    });
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseTypedArray(val, defaultType) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string' && val.trim()) {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
      return [parsed];
    } catch (e) {
      return val.split(/[，,、]/).filter(s => s.trim()).map(s => {
        const m = s.trim().match(/^(.+)\((Person|Organization|Thing|CreativeWork)\)$/);
        if (m) return { name: m[1].trim(), type: m[2] };
        return { name: s.trim(), type: defaultType || 'Thing' };
      });
    }
  }
  if (val && typeof val === 'object') return [val];
  return [];
}

function removeTagWithAnimation(tagElement) {
  tagElement.style.transform = 'scale(0)';
  tagElement.style.opacity = '0';
  setTimeout(() => tagElement.remove(), 200);
}
