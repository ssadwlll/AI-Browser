// GEO AI发布助手 - 知识卡片模块

let TEMPLATE_OPTIONS = [];
let TEMPLATE_CONFIG = null;

function initTemplateOptions() {
  TEMPLATE_OPTIONS = [
    { id: GEO_SHARED_CONSTANTS.DEFAULT_TEMPLATE_ID, name: '基础新闻事实卡', icon: '📰', fields: [
      {key: 'eventDate', label: '事件日期', required: false},
      {key: 'location', label: '地点', required: false},
      {key: 'keyFact', label: '核心事实', required: false}
    ]}
  ];
}

async function loadTemplateConfig() {
  try {
    // 检查缓存（1小时有效）
    const cached = localStorage.getItem('geo_template_config');
    const cacheTime = localStorage.getItem('geo_template_config_time');
    if (cached && cacheTime && (Date.now() - parseInt(cacheTime)) < 3600000) {
      const config = JSON.parse(cached);
      applyTemplateConfig(config);
      loadFieldMappingFromCache();
      return;
    }

    // 尝试远程加载
    const apiBaseUrl = (window.GEO_CONFIG && window.GEO_CONFIG.apiBaseUrl) || 'https://phpdev.66wz.com/api';

    try {
      let config = null;
      const configResp = await fetch(apiBaseUrl + '/config/config.json', { cache: 'no-cache' });
      if (configResp.ok) config = await configResp.json();

      let templates = null;
      const tplResp = await fetch(apiBaseUrl + '/config/templates.json', { cache: 'no-cache' });
      if (tplResp.ok) templates = await tplResp.json();

      if (config) applyGlobalConfig(config);
      if (config || templates) {
        const mergedConfig = mergeConfig(config, templates);
        if (mergedConfig) {
          applyTemplateConfig(mergedConfig);
          localStorage.setItem('geo_template_config', JSON.stringify(mergedConfig));
          localStorage.setItem('geo_template_config_time', String(Date.now()));
        }
      }
    } catch (e) {
      console.warn('AI发布助手: 远程配置加载失败，使用默认配置', e);
    }

    await loadFieldMapping();
  } catch (e) {
    console.warn('AI发布助手: 加载配置失败，使用默认配置', e);
  }
}

function mergeConfig(globalConfig, templates) {
  if (!globalConfig && !templates) return null;
  const result = {};
  if (globalConfig) {
    result.version = globalConfig.version;
    result.globalConfig = globalConfig;
  }
  if (templates) {
    result.templates = templates.templates;
  }
  return result;
}

function applyGlobalConfig(gc) {
  if (!gc) return;
  if (gc.schemaTypes && gc.schemaTypes.length > 0) {
    GEO_SHARED_CONSTANTS.VALID_SCHEMA_TYPES = gc.schemaTypes;
    GEO_SHARED_CONSTANTS.SCHEMA_TYPES_REGEX = '(' + gc.schemaTypes.join('|') + ')';
  }
  if (gc.authorRoles && gc.authorRoles.length > 0) {
    GEO_SHARED_CONSTANTS.AUTHOR_ROLES_REGEX = '^(' + gc.authorRoles.join('|') + ')\\s+(.+)$';
  }
  if (gc.defaultTemplateId) {
    GEO_SHARED_CONSTANTS.DEFAULT_TEMPLATE_ID = gc.defaultTemplateId;
  }
  if (gc.defaultTemplateName) {
    GEO_SHARED_CONSTANTS.DEFAULT_TEMPLATE_NAME = gc.defaultTemplateName;
  }
  if (gc.tagPatterns && gc.tagPatterns.length > 0) {
    GEO_SHARED_CONSTANTS.TAG_PATTERNS = gc.tagPatterns;
  }
}

async function loadFieldMapping() {
  try {
    // 先从缓存加载
    const cachedMapping = localStorage.getItem('geo_field_mapping');
    if (cachedMapping) {
      applyFieldMapping(JSON.parse(cachedMapping));
    }

    // 再从远程拉取最新配置
    const apiBaseUrl = (window.GEO_CONFIG && window.GEO_CONFIG.apiBaseUrl) || 'https://phpdev.66wz.com/api';
    try {
      const remoteResp = await fetch(apiBaseUrl + '/config/field-mapping.json', { cache: 'no-cache' });
      if (remoteResp.ok) {
        const remoteMapping = await remoteResp.json();
        applyFieldMapping(remoteMapping);
        localStorage.setItem('geo_field_mapping', JSON.stringify(remoteMapping));
        localStorage.setItem('geo_field_mapping_time', String(Date.now()));
        return;
      }
    } catch (e) {
      console.warn('AI发布助手: 远程字段映射加载失败，使用缓存配置', e);
    }
  } catch (e) {
    console.warn('AI发布助手: 加载字段映射失败，使用默认配置', e);
  }
}

function loadFieldMappingFromCache() {
  try {
    const cached = localStorage.getItem('geo_field_mapping');
    if (cached) {
      applyFieldMapping(JSON.parse(cached));
    }
  } catch (e) { /* 忽略 */ }
}

function applyFieldMapping(mapping) {
  if (!mapping) return;
  if (mapping.fieldMapping) {
    Object.assign(GeoFieldWriter.fieldMapping, mapping.fieldMapping);
  }
  if (mapping.titleInputId) {
    GeoFieldReader.TITLE_INPUT_ID = mapping.titleInputId;
  }
  if (mapping.contentTextareaId) {
    GeoFieldReader.CONTENT_TEXTAREA_ID = mapping.contentTextareaId;
  }
}

function applyTemplateConfig(config) {
  if (!config || !config.templates) return;
  TEMPLATE_CONFIG = config;
  TEMPLATE_OPTIONS = config.templates.map(t => ({
    id: t.id,
    name: t.name,
    icon: t.icon || '📋',
    fields: t.fields || []
  }));

  if (config.globalConfig) {
    const gc = config.globalConfig;
    if (gc.schemaTypes && gc.schemaTypes.length > 0) {
      GEO_SHARED_CONSTANTS.VALID_SCHEMA_TYPES = gc.schemaTypes;
      GEO_SHARED_CONSTANTS.SCHEMA_TYPES_REGEX = '(' + gc.schemaTypes.join('|') + ')';
    }
    if (gc.authorRoles && gc.authorRoles.length > 0) {
      GEO_SHARED_CONSTANTS.AUTHOR_ROLES_REGEX = '^(' + gc.authorRoles.join('|') + ')\\s+(.+)$';
    }
    if (gc.defaultTemplateId) {
      GEO_SHARED_CONSTANTS.DEFAULT_TEMPLATE_ID = gc.defaultTemplateId;
    }
    if (gc.defaultTemplateName) {
      GEO_SHARED_CONSTANTS.DEFAULT_TEMPLATE_NAME = gc.defaultTemplateName;
    }
    if (gc.tagPatterns && gc.tagPatterns.length > 0) {
      GEO_SHARED_CONSTANTS.TAG_PATTERNS = gc.tagPatterns;
    }
  }
}

function createKCEditField(field, value, evidence, label, required) {
  const isRequired = required ? ' geo-kc-field-required' : '';
  let valueHtml = '';

  if (field === 'qa' && Array.isArray(value)) {
    valueHtml = value.map((item, idx) => '<div class="geo-kc-qa-item">' +
      '<div class="geo-kc-qa-q">Q: <span class="geo-kc-editable" data-field="qa.' + idx + '.q">' + (item.q || '') + '</span></div>' +
      '<div class="geo-kc-qa-a">A: <span class="geo-kc-editable" data-field="qa.' + idx + '.a">' + (item.a || '') + '</span></div>' +
      (item.evidence ? '<div class="geo-kc-evidence">依据：' + item.evidence + '</div>' : '') +
      '</div>').join('');
  } else if (Array.isArray(value)) {
    valueHtml = value.map((v, idx) => {
      const display = (typeof v === 'object' && v !== null) ? v.name : v;
      const dataVal = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : '';
      return '<span class="geo-kc-tag"><span class="geo-kc-editable" data-field="' + field + '.' + idx + '" ' + (dataVal ? 'data-raw="' + escapeHtml(dataVal) + '"' : '') + '>' + display + '</span><span class="geo-kc-tag-del" data-action="kc-del-tag" data-field="' + field + '" data-index="' + idx + '">×</span></span>';
    }).join('');
  } else if (typeof value === 'object' && value !== null) {
    const display = value.name || JSON.stringify(value);
    const dataVal = JSON.stringify(value);
    valueHtml = '<span class="geo-kc-editable" data-field="' + field + '" data-raw="' + escapeHtml(dataVal) + '">' + display + '</span>';
  } else {
    valueHtml = '<span class="geo-kc-editable" data-field="' + field + '">' + (value || '') + '</span>';
  }

  return '<div class="geo-kc-field' + isRequired + '" data-field="' + field + '">' +
    '<div class="geo-kc-field-label">' + (required ? '<span class="geo-kc-required-mark">*</span>' : '') + label + '</div>' +
    '<div class="geo-kc-field-value">' + valueHtml + '</div>' +
    (evidence ? '<div class="geo-kc-evidence">依据：' + evidence + '</div>' : '') +
    '</div>';
}

function bindKnowledgeCardEvents(originalData, templateId) {
  const panel = document.getElementById('geo-panel-complete');

  const selectEl = document.getElementById('geo-kc-template-select');
  if (selectEl) {
    selectEl.addEventListener('change', () => {
      const newTemplateId = selectEl.value;
      const newOption = TEMPLATE_OPTIONS.find(o => o.id === newTemplateId);
      const newFields = newOption ? newOption.fields : [];
      const newTemplateName = newOption ? newOption.name : newTemplateId;

      const existingValues = {};
      const existingEvidences = {};
      if (Array.isArray(originalData.fields)) {
        originalData.fields.forEach(f => {
          if (f.value !== undefined) existingValues[f.key] = f.value;
          if (f.evidence) existingEvidences[f.key] = f.evidence;
        });
      }
      Object.keys(originalData).forEach(k => {
        if (k === 'fields' || k === 'templateId' || k === 'templateName' || k === 'confidence' || k === 'classifyReason' || k === 'tags' || k === 'entities' || k === 'qa' || k === 'title' || k === 'summary' || k === 'keywords') return;
        if (!existingValues.hasOwnProperty(k)) existingValues[k] = originalData[k];
        if (!existingEvidences.hasOwnProperty(k) && originalData[k + '_evidence']) existingEvidences[k] = originalData[k + '_evidence'];
      });

      const mergedFields = newFields.map(f => {
        const merged = Object.assign({}, f);
        if (existingValues.hasOwnProperty(f.key)) {
          merged.value = existingValues[f.key];
        }
        if (existingEvidences.hasOwnProperty(f.key)) {
          merged.evidence = existingEvidences[f.key];
        }
        return merged;
      });

      const newData = Object.assign({}, originalData, {
        templateId: newTemplateId,
        templateName: newTemplateName,
        fields: mergedFields
      });
      showResult(newData);
    });
  }

  panel.querySelectorAll('.geo-kc-editable').forEach(el => {
    el.addEventListener('click', () => {
      if (el.querySelector('input, textarea')) return;
      const currentText = el.textContent;
      const isLong = currentText.length > 30;
      if (isLong) {
        el.innerHTML = '<textarea class="geo-kc-edit-input">' + currentText + '</textarea>';
      } else {
        el.innerHTML = '<input type="text" class="geo-kc-edit-input" value="' + currentText.replace(/"/g, '&quot;') + '">';
      }
      const input = el.querySelector('.geo-kc-edit-input');
      input.focus();
      input.addEventListener('blur', () => {
        const newVal = input.value.trim();
        el.textContent = newVal || currentText;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !isLong) {
          input.blur();
        }
      });
    });
  });

  panel.querySelectorAll('[data-action="kc-del-tag"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tag = e.target.closest('.geo-kc-tag');
      if (tag) removeTagWithAnimation(tag);
    });
  });
}

function collectCardData(panel, templateId) {
  const data = {
    id: 'card-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8),
    templateId: templateId,
    reviewStatus: 'pending',
    createdAt: new Date().toISOString()
  };

  panel.querySelectorAll('.geo-kc-field').forEach(fieldEl => {
    const fieldName = fieldEl.dataset.field;
    if (!fieldName) return;

    const editables = fieldEl.querySelectorAll('.geo-kc-editable');
    if (fieldName === 'qa') {
      const qaItems = [];
      fieldEl.querySelectorAll('.geo-kc-qa-item').forEach(qaEl => {
        const qEl = qaEl.querySelector('.geo-kc-qa-q .geo-kc-editable');
        const aEl = qaEl.querySelector('.geo-kc-qa-a .geo-kc-editable');
        qaItems.push({
          q: qEl ? qEl.textContent : '',
          a: aEl ? aEl.textContent : ''
        });
      });
      data[fieldName] = qaItems;
    } else if (editables.length > 1) {
      data[fieldName] = Array.from(editables).map(el => {
        const raw = el.getAttribute('data-raw');
        if (raw) {
          try { return JSON.parse(raw); } catch (ex) { /* 降级 */ }
        }
        return el.textContent;
      });
    } else if (editables.length === 1) {
      const raw = editables[0].getAttribute('data-raw');
      const parsed = raw ? (() => { try { return JSON.parse(raw); } catch (ex) { return null; } })() : null;

      const arrayFields = ['keywords', 'tags', 'entities'];
      const isKnownArrayField = arrayFields.includes(fieldName);
      let isConfigArrayField = false;
      if (TEMPLATE_CONFIG && TEMPLATE_CONFIG.templates) {
        for (const t of TEMPLATE_CONFIG.templates) {
          if (t.jsonLdMapping && t.jsonLdMapping.directMappings) {
            const dm = t.jsonLdMapping.directMappings.find(d => d.field === fieldName);
            if (dm && (dm.action === 'addTypedArray' || dm.action === 'parseAsPersonArray' || dm.parseTypedArray)) {
              isConfigArrayField = true;
              break;
            }
          }
          if (t.jsonLdMapping && t.jsonLdMapping.graphItems) {
            for (const gi of t.jsonLdMapping.graphItems) {
              if (gi.fieldMappings) {
                const fm = gi.fieldMappings.find(f => f.field === fieldName);
                if (fm && fm.parseTypedArray) {
                  isConfigArrayField = true;
                  break;
                }
              }
            }
            if (isConfigArrayField) break;
          }
        }
      }
      const isParsedArray = Array.isArray(parsed);

      if (isKnownArrayField || isConfigArrayField || isParsedArray) {
        if (parsed) {
          data[fieldName] = isParsedArray ? parsed : [parsed];
        } else {
          data[fieldName] = [editables[0].textContent];
        }
      } else {
        if (parsed) {
          data[fieldName] = parsed;
        } else {
          data[fieldName] = editables[0].textContent;
        }
      }
    }
  });

  return data;
}

function showPreviewModal(cardData, jsonLd) {
  const existing = document.getElementById('geo-preview-modal');
  if (existing) existing.remove();

  const output = { raw: cardData, jsonld: jsonLd };

  let visualHtml = '';
  visualHtml += buildJsonLdVisual(jsonLd);

  visualHtml += '<div class="geo-preview-section">' +
    '<div class="geo-preview-section-title">原始卡片数据</div>' +
    '<div class="geo-preview-fields">';

  const fields = (window._geoCompleteData && window._geoCompleteData.fields) || [];
  for (const field of fields) {
    const val = cardData[field.key];
    if (val === undefined || val === null || val === '' || (Array.isArray(val) && val.length === 0)) continue;
    const label = field.label || field.key;
    if (field.key === 'qa' && Array.isArray(val)) {
      visualHtml += '<div class="geo-preview-field"><div class="geo-preview-field-label">' + label + '</div><div class="geo-preview-field-value">';
      val.forEach(item => {
        visualHtml += '<div class="geo-preview-qa"><span class="geo-preview-q">Q: ' + item.q + '</span><span class="geo-preview-a">A: ' + item.a + '</span></div>';
      });
      visualHtml += '</div></div>';
    } else if (Array.isArray(val)) {
      visualHtml += '<div class="geo-preview-field"><div class="geo-preview-field-label">' + label + '</div><div class="geo-preview-field-value">' + val.map(v => {
        const display = (typeof v === 'object' && v !== null && v.name) ? v.name : String(v);
        return '<span class="geo-preview-tag">' + display + '</span>';
      }).join('') + '</div></div>';
    } else if (typeof val === 'object' && val !== null && val.name) {
      visualHtml += '<div class="geo-preview-field"><div class="geo-preview-field-label">' + label + '</div><div class="geo-preview-field-value">' + val.name + '</div></div>';
    } else {
      visualHtml += '<div class="geo-preview-field"><div class="geo-preview-field-label">' + label + '</div><div class="geo-preview-field-value">' + val + '</div></div>';
    }
  }
  visualHtml += '</div></div>';

  visualHtml += '<div class="geo-preview-section">' +
    '<div class="geo-preview-section-title">JSON源码</div>' +
    '<pre class="geo-preview-json">' + escapeHtml(JSON.stringify(output, null, 2)) + '</pre>' +
    '</div>';

  const modal = document.createElement('div');
  modal.id = 'geo-preview-modal';
  modal.innerHTML =
    '<div class="geo-preview-overlay"></div>' +
    '<div class="geo-preview-container">' +
      '<div class="geo-preview-header">' +
        '<span class="geo-preview-title">知识卡片可视化预览</span>' +
        '<button class="geo-preview-close" data-action="preview-close">&times;</button>' +
      '</div>' +
      '<div class="geo-preview-body">' + visualHtml + '</div>' +
      '<div class="geo-preview-footer">' +
        '<button class="geo-btn-small geo-btn-adopt-all" data-action="preview-fill">回填到表单</button>' +
        '<button class="geo-btn-small" data-action="preview-copy">复制JSON</button>' +
        '<button class="geo-btn-small" data-action="preview-close">关闭</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);

  modal.querySelectorAll('[data-action="preview-close"]').forEach(btn => {
    btn.addEventListener('click', () => modal.remove());
  });
  modal.querySelector('.geo-preview-overlay')?.addEventListener('click', () => modal.remove());

  modal.querySelector('[data-action="preview-fill"]')?.addEventListener('click', () => {
    const json = JSON.stringify(output, null, 2);
    const success = GeoFieldWriter.writeField('knowledgeCard', json);
    if (success) {
      showToast('知识卡片已回填（JSON-LD格式）');
    } else {
      showToast('无法找到知识卡片字段', 'error');
    }
  });

  modal.querySelector('[data-action="preview-copy"]')?.addEventListener('click', () => {
    const json = JSON.stringify(output, null, 2);
    copyToClipboard(json);
    showToast('JSON已复制到剪贴板');
  });
}

function saveKnowledgeCard(cardData) {
  try {
    const cards = JSON.parse(localStorage.getItem('geo_knowledge_cards') || '[]');
    cards.push(cardData);
    localStorage.setItem('geo_knowledge_cards', JSON.stringify(cards));
    showToast('知识卡片已保存（共' + cards.length + '张）');
  } catch (e) {
    showToast('保存失败', 'error');
  }
}

function exportCardAsFile(cardData) {
  const json = JSON.stringify(cardData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'knowledge-card-' + cardData.templateId + '-' + Date.now() + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('知识卡片已导出');
}
