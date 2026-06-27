// GEO AI发布助手 - 卡片HTML构建模块

function createCard(title, content, type) {
  return '<div class="geo-result-card" data-type="' + type + '">' +
    '<div class="geo-card-header">' +
      '<span class="geo-card-title">' + title + '</span>' +
      '<div class="geo-card-actions">' +
        '<button class="geo-btn-small geo-btn-adopt" data-action="adopt" data-field="' + type + '">采用</button>' +
        '<button class="geo-btn-small geo-btn-edit" data-action="edit" data-field="' + type + '">修改</button>' +
        '<button class="geo-btn-small geo-btn-ignore" data-action="ignore" data-field="' + type + '">忽略</button>' +
      '</div>' +
    '</div>' +
    '<div class="geo-card-body" data-raw="' + content.replace(/"/g, '&quot;') + '">' + content + '</div>' +
  '</div>';
}

function createKeywordsCard(keywords) {
  const tagsHtml = keywords.map(k =>
    '<span class="geo-keyword-tag">' +
      '<span class="geo-keyword-text">' + k + '</span>' +
      '<span class="geo-keyword-delete" data-action="delete-keyword" title="删除">×</span>' +
    '</span>'
  ).join('');
  return '<div class="geo-result-card" data-type="keywords">' +
    '<div class="geo-card-header"><span class="geo-card-title">关键词</span>' +
      '<div class="geo-card-actions">' +
        '<button class="geo-btn-small geo-btn-adopt" data-action="adopt-keywords">采用</button>' +
        '<button class="geo-btn-small geo-btn-ignore" data-action="ignore" data-field="keywords">忽略</button>' +
      '</div>' +
    '</div>' +
    '<div class="geo-card-body">' +
      '<div class="geo-keywords-list">' + tagsHtml + '</div>' +
      '<div class="geo-keyword-add">' +
        '<input type="text" class="geo-keyword-input" placeholder="输入新关键词" />' +
        '<button class="geo-btn-small" data-action="add-keyword">添加</button>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function createTagsCard(tags) {
  const tagsHtml = tags.map(t =>
    '<span class="geo-tag-item">' +
      '<span class="geo-tag-text">' + t + '</span>' +
      '<span class="geo-tag-delete" data-action="delete-tag" title="删除">×</span>' +
    '</span>'
  ).join('');
  return '<div class="geo-result-card" data-type="tags">' +
    '<div class="geo-card-header"><span class="geo-card-title">主题标签</span>' +
      '<div class="geo-card-actions">' +
        '<button class="geo-btn-small geo-btn-adopt" data-action="adopt-tags">采用</button>' +
        '<button class="geo-btn-small geo-btn-ignore" data-action="ignore" data-field="tags">忽略</button>' +
      '</div>' +
    '</div>' +
    '<div class="geo-card-body"><div class="geo-tags-list">' + tagsHtml + '</div></div>' +
  '</div>';
}

function createEntitiesCard(entities) {
  const itemsHtml = entities.map(e => {
    const name = typeof e === 'object' ? e.name : e;
    const type = typeof e === 'object' ? e.type : '';
    const typeLabel = type ? '<span class="geo-entity-type">' + type + '</span>' : '';
    return '<li>' + typeLabel + name + '</li>';
  }).join('');
  return '<div class="geo-result-card" data-type="entities">' +
    '<div class="geo-card-header"><span class="geo-card-title">核心实体</span>' +
      '<div class="geo-card-actions">' +
        '<button class="geo-btn-small geo-btn-ignore" data-action="ignore" data-field="entities">忽略</button>' +
      '</div>' +
    '</div>' +
    '<div class="geo-card-body"><ul class="geo-entities-list">' + itemsHtml + '</ul></div>' +
  '</div>';
}

function createAuthorsCard(authors) {
  const authorsHtml = authors.map(a => {
    const display = typeof a === 'object' ? (a.role ? a.role + ' ' + a.name : a.name) : a;
    const dataVal = typeof a === 'object' ? JSON.stringify(a) : a;
    return '<span class="geo-keyword-tag">' +
      '<span class="geo-keyword-text" data-raw="' + escapeHtml(dataVal) + '">' + display + '</span>' +
      '<span class="geo-keyword-delete" data-action="delete-author" title="删除">×</span>' +
    '</span>';
  }).join('');
  return '<div class="geo-result-card" data-type="authors">' +
    '<div class="geo-card-header"><span class="geo-card-title">作者</span>' +
      '<div class="geo-card-actions">' +
        '<button class="geo-btn-small geo-btn-adopt" data-action="adopt-authors">采用</button>' +
        '<button class="geo-btn-small geo-btn-ignore" data-action="ignore" data-field="authors">忽略</button>' +
      '</div>' +
    '</div>' +
    '<div class="geo-card-body">' +
      '<div class="geo-keywords-list">' + authorsHtml + '</div>' +
      '<div class="geo-keyword-add">' +
        '<input type="text" class="geo-keyword-input" placeholder="身份 姓名（如：记者 张三）" />' +
        '<button class="geo-btn-small" data-action="add-author">添加</button>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function createQACard(qa) {
  const qaHtml = qa.map(item => '<div class="geo-qa-item">' +
    '<div class="geo-qa-q">Q: ' + item.q + '</div>' +
    '<div class="geo-qa-a">A: ' + item.a + '</div>' +
  '</div>').join('');
  return '<div class="geo-result-card" data-type="qa">' +
    '<div class="geo-card-header"><span class="geo-card-title">AI问答</span>' +
      '<div class="geo-card-actions">' +
        '<button class="geo-btn-small geo-btn-ignore" data-action="ignore" data-field="qa">忽略</button>' +
      '</div>' +
    '</div>' +
    '<div class="geo-card-body"><div class="geo-qa-list">' + qaHtml + '</div></div>' +
  '</div>';
}

function bindCardEvents() {
  document.querySelectorAll('[data-action="adopt-all"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const panel = document.getElementById('geo-panel-complete');
      if (!panel) return;
      let adoptedCount = 0;

      const titleCard = panel.querySelector('[data-type="title"]');
      if (titleCard) {
        const body = titleCard.querySelector('.geo-card-body');
        const content = body ? (body.getAttribute('data-raw') || body.innerText) : '';
        if (content && GeoFieldWriter.writeField('title', content)) adoptedCount++;
      }

      const summaryCard = panel.querySelector('[data-type="summary"]');
      if (summaryCard) {
        const body = summaryCard.querySelector('.geo-card-body');
        const content = body ? (body.getAttribute('data-raw') || body.innerText) : '';
        if (content && GeoFieldWriter.writeField('summary', content)) adoptedCount++;
      }

      const keywordsCard = panel.querySelector('[data-type="keywords"]');
      if (keywordsCard) {
        const tags = Array.from(keywordsCard.querySelectorAll('.geo-keyword-tag .geo-keyword-text')).map(t => t.textContent);
        const keywords = tags.join(' ');
        if (keywords && GeoFieldWriter.writeField('keywords', keywords)) adoptedCount++;
      }

      const introCard = panel.querySelector('[data-type="introduction"]');
      if (introCard) {
        const body = introCard.querySelector('.geo-card-body');
        const content = body ? (body.getAttribute('data-raw') || body.innerText) : '';
        if (content && GeoFieldWriter.writeField('introduction', content)) adoptedCount++;
      }

      const tagsCard = panel.querySelector('[data-type="tags"]');
      if (tagsCard) {
        const tags = Array.from(tagsCard.querySelectorAll('.geo-tag-item .geo-tag-text')).map(t => t.textContent);
        const tagsStr = tags.join('、');
        if (tagsStr && GeoFieldWriter.writeField('tags', tagsStr)) adoptedCount++;
      }

      const authorsCard = panel.querySelector('[data-type="authors"]');
      if (authorsCard) {
        const authorTags = Array.from(authorsCard.querySelectorAll('.geo-keyword-tag .geo-keyword-text'));
        const authorsStr = authorTags.map(t => {
          const raw = t.getAttribute('data-raw');
          if (raw) {
            try {
              const obj = JSON.parse(raw);
              return obj.role ? obj.role + ' ' + obj.name : obj.name;
            } catch (ex) {
              return t.textContent;
            }
          }
          return t.textContent;
        }).join(' ');
        if (authorsStr && GeoFieldWriter.writeField('authors', authorsStr)) adoptedCount++;
      }

      const completeData = window._geoCompleteData;
      if (completeData && completeData.templateId) {
        const knowledgePanel = document.getElementById('geo-panel-knowledge');
        const cardData = collectCardData(knowledgePanel || panel, completeData.templateId);
        const jsonLdData = cardToJsonLd(cardData, completeData);
        const fillData = { raw: cardData, jsonld: jsonLdData };
        const fillJson = JSON.stringify(fillData);
        if (GeoFieldWriter.writeField('knowledgeCard', fillJson)) adoptedCount++;
      }

      panel.querySelectorAll('.geo-btn-adopt').forEach(b => {
        b.textContent = '已采用';
      });
      panel.querySelectorAll('.geo-btn-adopt-all').forEach(b => {
        b.textContent = '已采用' + adoptedCount + '项，点击重新采用';
      });

      showToast('已回填' + adoptedCount + '个字段');
    });
  });

  document.querySelectorAll('[data-action="preview-modal"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const completeData = window._geoCompleteData;
      if (!completeData) {
        showToast('暂无数据可预览', 'error');
        return;
      }
      const templateId = completeData.templateId || GEO_SHARED_CONSTANTS.DEFAULT_TEMPLATE_ID;
      const knowledgePanel = document.getElementById('geo-panel-knowledge');
      const cardData = knowledgePanel ? collectCardData(knowledgePanel, templateId) : completeData;
      const jsonLdData = cardToJsonLd(cardData, completeData);
      showPreviewModal(cardData, jsonLdData);
    });
  });

  document.querySelectorAll('[data-action="adopt"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const field = e.target.dataset.field;
      const card = e.target.closest('.geo-result-card');
      if (!card) return;

      let fieldType = field;
      if (field === '摘要') fieldType = 'summary';
      else if (field === '导读') fieldType = 'introduction';

      const body = card.querySelector('.geo-card-body');
      const content = body ? (body.getAttribute('data-raw') || body.innerText) : '';

      const success = GeoFieldWriter.writeField(fieldType, content);
      if (success) {
        showToast('已回填' + field + '字段');
        e.target.textContent = '已采用';
      } else {
        showToast('无法找到' + field + '字段', 'error');
      }
    });
  });

  document.querySelectorAll('[data-action="adopt-keywords"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const card = e.target.closest('.geo-result-card');
      if (!card) return;
      const tags = Array.from(card.querySelectorAll('.geo-keyword-tag .geo-keyword-text')).map(t => t.textContent);
      const keywords = tags.join(' ');

      const success = GeoFieldWriter.writeField('keywords', keywords);
      if (success) {
        showToast('已回填关键词字段');
        e.target.textContent = '已采用';
      } else {
        showToast('无法找到关键词字段', 'error');
      }
    });
  });

  document.querySelectorAll('[data-action="adopt-tags"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const card = e.target.closest('.geo-result-card');
      if (!card) return;
      const tags = Array.from(card.querySelectorAll('.geo-tag-item .geo-tag-text')).map(t => t.textContent);
      const tagsStr = tags.join('、');

      const success = GeoFieldWriter.writeField('tags', tagsStr);
      if (success) {
        showToast('已回填主题标签字段');
        e.target.textContent = '已采用';
      } else {
        showToast('无法找到主题标签字段', 'error');
      }
    });
  });

  document.querySelectorAll('[data-action="adopt-authors"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const card = e.target.closest('.geo-result-card');
      if (!card) return;
      const authorTags = Array.from(card.querySelectorAll('.geo-keyword-tag .geo-keyword-text'));
      const authorsStr = authorTags.map(t => {
        const raw = t.getAttribute('data-raw');
        if (raw) {
          try {
            const obj = JSON.parse(raw);
            return obj.role ? obj.role + ' ' + obj.name : obj.name;
          } catch (ex) {
            return t.textContent;
          }
        }
        return t.textContent;
      }).join(' ');

      const success = GeoFieldWriter.writeField('authors', authorsStr);
      if (success) {
        showToast('已回填作者字段');
        e.target.textContent = '已采用';
      } else {
        showToast('无法找到作者字段', 'error');
      }
    });
  });

  document.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const card = e.target.closest('.geo-result-card');
      if (!card) return;
      const body = card.querySelector('.geo-card-body');
      if (!body) return;

      const textarea = body.querySelector('.geo-edit-textarea');
      if (textarea) {
        const newContent = textarea.value.trim();
        body.textContent = newContent;
        body.setAttribute('data-raw', newContent.replace(/"/g, '&quot;'));
        e.target.textContent = '修改';
        if (window._geoCompleteData) {
          const fieldType = card.getAttribute('data-type');
          if (fieldType && newContent) {
            window._geoCompleteData[fieldType] = newContent;
          }
        }
        return;
      }

      const currentText = body.getAttribute('data-raw') || body.innerText;
      body.innerHTML = '<textarea class="geo-edit-textarea">' + currentText + '</textarea>';
      const editArea = body.querySelector('.geo-edit-textarea');
      editArea.focus();
      editArea.setSelectionRange(editArea.value.length, editArea.value.length);
      e.target.textContent = '保存';

      editArea.addEventListener('keydown', (ev) => {
        if (ev.ctrlKey && ev.key === 'Enter') {
          e.target.click();
        }
      });
    });
  });

  document.querySelectorAll('[data-action="delete-keyword"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tag = e.target.closest('.geo-keyword-tag');
      if (tag) {
        removeTagWithAnimation(tag);
        syncKeywordsToGlobal();
      }
    });
  });

  document.querySelectorAll('[data-action="delete-author"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tag = e.target.closest('.geo-keyword-tag');
      if (tag) {
        removeTagWithAnimation(tag);
        syncAuthorsToGlobal();
      }
    });
  });

  document.querySelectorAll('[data-action="add-keyword"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const card = e.target.closest('.geo-result-card');
      if (!card) return;
      const input = card.querySelector('.geo-keyword-input');
      if (!input || !input.value.trim()) return;

      const keywordsList = card.querySelector('.geo-keywords-list');
      const newTag = document.createElement('span');
      newTag.className = 'geo-keyword-tag';
      newTag.innerHTML = '<span class="geo-keyword-text">' + input.value.trim() + '</span><span class="geo-keyword-delete" data-action="delete-keyword" title="删除">×</span>';
      newTag.querySelector('[data-action="delete-keyword"]').addEventListener('click', (ev) => {
        removeTagWithAnimation(newTag);
      });
      keywordsList.appendChild(newTag);
      input.value = '';
      input.focus();
      syncKeywordsToGlobal();
    });
  });

  document.querySelectorAll('.geo-keyword-input').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const card = input.closest('.geo-result-card');
        const addBtn = card.querySelector('[data-action="add-keyword"]') || card.querySelector('[data-action="add-author"]');
        if (addBtn) addBtn.click();
      }
    });
  });

  document.querySelectorAll('[data-action="add-author"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const card = e.target.closest('.geo-result-card');
      if (!card) return;
      const input = card.querySelector('.geo-keyword-input');
      if (!input || !input.value.trim()) return;

      const authorsList = card.querySelector('.geo-keywords-list');
      const newTag = document.createElement('span');
      newTag.className = 'geo-keyword-tag';
      newTag.innerHTML = '<span class="geo-keyword-text">' + input.value.trim() + '</span><span class="geo-keyword-delete" data-action="delete-author" title="删除">×</span>';
      newTag.querySelector('[data-action="delete-author"]').addEventListener('click', (ev) => {
        removeTagWithAnimation(newTag);
      });
      authorsList.appendChild(newTag);
      input.value = '';
      input.focus();
      syncAuthorsToGlobal();
    });
  });

  document.querySelectorAll('[data-action="delete-tag"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tag = e.target.closest('.geo-tag-item');
      if (tag) {
        removeTagWithAnimation(tag);
        syncTagsToGlobal();
      }
    });
  });

  document.querySelectorAll('[data-action="ignore"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const card = e.target.closest('.geo-result-card');
      if (card) card.style.display = 'none';
    });
  });
}

function syncKeywordsToGlobal() {
  if (!window._geoCompleteData) return;
  const card = document.querySelector('[data-type="keywords"]');
  if (card) {
    const tags = Array.from(card.querySelectorAll('.geo-keyword-tag .geo-keyword-text')).map(t => t.textContent);
    window._geoCompleteData.keywords = tags;
  }
}

function syncTagsToGlobal() {
  if (!window._geoCompleteData) return;
  const card = document.querySelector('[data-type="tags"]');
  if (card) {
    const tags = Array.from(card.querySelectorAll('.geo-tag-item .geo-tag-text')).map(t => t.textContent);
    window._geoCompleteData.tags = tags;
  }
}

function syncAuthorsToGlobal() {
  if (!window._geoCompleteData) return;
  const card = document.querySelector('[data-type="authors"]');
  if (card) {
    const authorTags = Array.from(card.querySelectorAll('.geo-keyword-tag .geo-keyword-text'));
    window._geoCompleteData.authors = authorTags.map(t => {
      const raw = t.getAttribute('data-raw');
      if (raw) {
        try { return JSON.parse(raw); } catch (ex) { return t.textContent; }
      }
      return t.textContent;
    });
  }
}
