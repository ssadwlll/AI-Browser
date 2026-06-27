// GEO AI发布助手 - JSON-LD生成模块

function getFieldValue(cardData, key) {
  if (Array.isArray(cardData.fields)) {
    const field = cardData.fields.find(f => f.key === key);
    if (field && field.value !== undefined && field.value !== '') return field.value;
  }
  return cardData[key];
}

function cardToJsonLd(cardData, completeData) {
  const templateId = cardData.templateId || GEO_SHARED_CONSTANTS.DEFAULT_TEMPLATE_ID;

  const title = cardData.title || (completeData && completeData.title) || '';
  const summary = cardData.summary || (completeData && completeData.summary) || '';
  const ensureArray = (val) => Array.isArray(val) ? val : (val ? [val] : []);
  const keywords = ensureArray(cardData.keywords || (completeData && completeData.keywords));
  const tags = ensureArray(cardData.tags || (completeData && completeData.tags));
  const entities = ensureArray(cardData.entities || (completeData && completeData.entities));
  const qa = ensureArray(cardData.qa || (completeData && completeData.qa));
  const introduction = (completeData && completeData.introduction) || '';
  const authors = ensureArray(completeData && completeData.authors);

  const jsonLd = {
    '@type': 'NewsArticle',
    'headline': title,
    'description': summary
  };

  if (keywords.length > 0) {
    jsonLd.keywords = keywords.join(',');
  }

  if (introduction) {
    jsonLd.introduction = introduction;
  }

  if (entities.length > 0) {
    const seen = new Set();
    jsonLd.mentions = [];
    entities.forEach(e => {
      let name, type;
      if (typeof e === 'object' && e.name) {
        name = e.name;
        type = e.type || 'Thing';
      } else {
        name = String(e);
        type = 'Thing';
      }
      if (seen.has(name)) return;
      seen.add(name);
      const validTypes = GEO_SHARED_CONSTANTS.VALID_SCHEMA_TYPES;
      const schemaType = validTypes.includes(type) ? type : 'Thing';
      jsonLd.mentions.push({ '@type': schemaType, 'name': name });
    });
  }

  if (tags.length > 0) {
    const seenAbout = new Set();
    jsonLd.about = [];
    tags.forEach(t => {
      if (seenAbout.has(t)) return;
      seenAbout.add(t);
      jsonLd.about.push({ '@type': 'Thing', 'name': t });
    });
  }

  const graphItems = [];

  const templateConfig = TEMPLATE_CONFIG
    ? TEMPLATE_CONFIG.templates.find(t => t.id === templateId)
    : null;
  const mapping = templateConfig ? templateConfig.jsonLdMapping : null;

  if (mapping) {
    if (Array.isArray(mapping.graphItems)) {
      mapping.graphItems.forEach(gi => {
        const obj = { '@type': gi['@type'] };
        if (gi['@id']) obj['@id'] = gi['@id'];

        if (Array.isArray(gi.fieldMappings)) {
          gi.fieldMappings.forEach(fm => {
            let val = getFieldValue(cardData, fm.field);
            if (val === undefined || val === null || val === '') {
              if (fm.fallbackToTitle && title) val = title;
              else return;
            }
            if (fm.field === 'eventName' && fm.fallbackToTitle && !val) val = title;
            if (fm.parseTypedArray) {
              val = parseTypedArray(val, 'Organization');
            }
            if (fm.wrap) {
              if (fm.parseTypedArray && Array.isArray(val)) {
                obj[fm.target] = val.map(v => {
                  const name = typeof v === 'object' ? v.name : String(v);
                  const type = (typeof v === 'object' && v.type) ? v.type : (fm.wrap['@type'] || 'Thing');
                  return { '@type': type, 'name': name.replace(/\s*\((Organization|Person|Thing|CreativeWork)\)\s*$/, '').trim() };
                });
              } else {
                obj[fm.target] = { '@type': fm.wrap['@type'], [fm.wrap.valueKey || 'name']: val };
              }
            } else {
              obj[fm.target] = val;
            }
          });
        }

        if (!obj.description && summary) obj.description = summary;

        graphItems.push(obj);

        if (gi.linkToAbout && obj['@id']) {
          jsonLd.about = jsonLd.about || [];
          jsonLd.about.push({ '@id': obj['@id'] });
        }
      });
    }

    if (Array.isArray(mapping.directMappings)) {
      mapping.directMappings.forEach(dm => {
        const val = getFieldValue(cardData, dm.field);
        if (val === undefined || val === null || val === '') return;

        const action = dm.action || '';

        if (action === 'addMention') {
          jsonLd.mentions = jsonLd.mentions || [];
          let schemaType = dm.schemaType || 'Thing';
          if (dm.schemaTypeFromValue && typeof val === 'object' && val !== null) {
            schemaType = val.type || dm.defaultSchemaType || 'Organization';
            const name = val.name || String(val);
            const exists = jsonLd.mentions.some(m => m.name === name);
            if (!exists) {
              const mention = { '@type': schemaType, 'name': name };
              if (Array.isArray(dm.subFields)) {
                dm.subFields.forEach(sf => {
                  const subVal = getFieldValue(cardData, sf.field);
                  if (subVal) mention[sf.target] = subVal;
                });
              }
              jsonLd.mentions.unshift(mention);
            }
          } else {
            const mention = { '@type': schemaType, 'name': typeof val === 'object' ? val.name : String(val) };
            if (Array.isArray(dm.subFields)) {
              dm.subFields.forEach(sf => {
                const subVal = getFieldValue(cardData, sf.field);
                if (subVal) {
                  if (sf.wrap) {
                    mention[sf.target] = { '@type': sf.wrap['@type'], [sf.wrap.valueKey || 'name']: subVal };
                  } else {
                    mention[sf.target] = subVal;
                  }
                }
              });
            }
            jsonLd.mentions.unshift(mention);
          }
        } else if (action === 'addAbout') {
          const name = typeof val === 'object' ? val.name : String(val);
          const exists = jsonLd.about && jsonLd.about.some(a => a.name === name);
          if (!exists) {
            jsonLd.about = jsonLd.about || [];
            jsonLd.about.push({ '@type': 'Thing', 'name': name });
          }
        } else if (action === 'addTypedArray') {
          jsonLd.mentions = jsonLd.mentions || [];
          const parsed = parseTypedArray(val, dm.defaultType || 'Thing');
          if (Array.isArray(parsed)) {
            parsed.forEach(p => {
              const name = (typeof p === 'object' ? p.name : String(p)).replace(/\s*\((Organization|Person|Thing|CreativeWork)\)\s*$/, '').trim();
              const type = (typeof p === 'object' && p.type) ? p.type : (dm.defaultType || 'Thing');
              const exists = jsonLd.mentions.some(m => m.name === name);
              if (!exists) jsonLd.mentions.push({ '@type': type, 'name': name });
            });
          }
        } else if (action === 'parseAsPersonArray') {
          let list = [];
          if (Array.isArray(val)) {
            list = val.map(a => typeof a === 'object' ? (a.name || '') : String(a)).filter(s => s.trim());
          } else if (typeof val === 'string') {
            list = val.split(/[，,、]/).filter(s => s.trim());
          }
          if (list.length > 0) {
            jsonLd[dm.target] = list.map(name => ({ '@type': 'Person', 'name': name.trim() }));
          }
        } else if (action === 'addQuantitativeValue') {
          jsonLd.mentions = jsonLd.mentions || [];
          const numMatch = String(val).match(/([\d.]+)\s*(万吨|亿元|万元|吨|个|项|家|%|百分之)/);
          if (numMatch) {
            jsonLd.mentions.push({
              '@type': 'QuantitativeValue',
              'value': parseFloat(numMatch[1]),
              'unitText': numMatch[2],
              'description': String(val)
            });
          } else {
            jsonLd.mentions.push({ '@type': 'QuantitativeValue', 'description': String(val) });
          }
        } else if (dm.wrap) {
          jsonLd[dm.target] = { '@type': dm.wrap['@type'], [dm.wrap.valueKey || 'name']: val };
        } else {
          jsonLd[dm.target] = val;
        }
      });
    }

    if (mapping.addFaqGraph && qa.length > 0) {
      graphItems.push({
        '@type': 'FAQPage',
        'mainEntity': qa.map(item => ({
          '@type': 'Question',
          'name': item.q,
          'acceptedAnswer': { '@type': 'Answer', 'text': item.a }
        }))
      });
    }
  } else {
    if (Array.isArray(cardData.fields)) {
      cardData.fields.forEach(f => {
        const val = f.value !== undefined ? f.value : cardData[f.key];
        if (val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && val.length === 0)) {
          jsonLd[f.key] = val;
        }
      });
    }
  }

  const predefinedKeys = new Set([
    'id', 'templateId', 'templateName', 'confidence', 'classifyReason', 'fields',
    'title', 'summary', 'keywords', 'introduction', 'tags', 'entities', 'authors', 'qa',
    'reviewStatus', 'createdAt'
  ]);
  if (TEMPLATE_CONFIG && TEMPLATE_CONFIG.templates) {
    TEMPLATE_CONFIG.templates.forEach(t => {
      if (t.fields) t.fields.forEach(f => predefinedKeys.add(f.key));
      if (t.jsonLdMapping) {
        if (t.jsonLdMapping.directMappings) t.jsonLdMapping.directMappings.forEach(dm => {
          predefinedKeys.add(dm.field);
          if (dm.subFields) dm.subFields.forEach(sf => predefinedKeys.add(sf.field));
        });
        if (t.jsonLdMapping.graphItems) t.jsonLdMapping.graphItems.forEach(gi => {
          if (gi.fieldMappings) gi.fieldMappings.forEach(fm => predefinedKeys.add(fm.field));
        });
      }
    });
  } else {
    if (Array.isArray(cardData.fields)) {
      cardData.fields.forEach(f => predefinedKeys.add(f.key));
    }
  }

  const flexibleFields = {};
  if (Array.isArray(cardData.fields)) {
    cardData.fields.forEach(f => {
      if (!predefinedKeys.has(f.key) && f.value !== undefined && f.value !== '') {
        flexibleFields[f.key] = f.value;
      }
    });
  }
  Object.keys(cardData).forEach(k => {
    if (!predefinedKeys.has(k) && !flexibleFields.hasOwnProperty(k)) {
      const val = cardData[k];
      if (val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && val.length === 0)) {
        flexibleFields[k] = val;
      }
    }
  });

  Object.keys(flexibleFields).forEach(key => {
    const val = flexibleFields[key];
    if (Array.isArray(val) && val.length > 0) {
      jsonLd[key] = val.map(v => (typeof v === 'object' && v !== null && v.name) ? v.name : String(v));
    } else if (typeof val === 'object' && val !== null && val.name) {
      jsonLd[key] = val.name;
    } else if (typeof val === 'string') {
      jsonLd[key] = val;
    }
  });

  let result;
  if (graphItems.length > 0) {
    result = {
      '@context': 'https://schema.org',
      '@graph': [jsonLd, ...graphItems]
    };
  } else {
    jsonLd['@context'] = 'https://schema.org';
    result = jsonLd;
  }

  function clean(obj) {
    Object.keys(obj).forEach(k => {
      if (obj[k] === undefined || obj[k] === null || obj[k] === '' ||
          (Array.isArray(obj[k]) && obj[k].length === 0)) {
        delete obj[k];
      } else if (typeof obj[k] === 'object' && !Array.isArray(obj[k]) && k !== '@context') {
        clean(obj[k]);
      }
    });
  }
  clean(result);

  return result;
}

function buildJsonLdVisual(jsonLd) {
  let html = '<div class="geo-preview-section">' +
    '<div class="geo-preview-section-title">JSON-LD 结构化数据 <span class="geo-preview-badge">Schema.org</span></div>' +
    '<div class="geo-preview-jsonld">';

  const mainType = jsonLd['@type'] || (jsonLd['@graph'] && jsonLd['@graph'][0] && jsonLd['@graph'][0]['@type']) || '';
  if (mainType) {
    html += '<div class="geo-preview-type-badge">' + mainType + '</div>';
  }

  if (jsonLd['@graph']) {
    jsonLd['@graph'].forEach((item) => {
      html += '<div class="geo-preview-graph-item">' +
        '<div class="geo-preview-graph-type">' + (item['@type'] || 'Object') + '</div>';
      html += buildJsonLdFields(item);
      html += '</div>';
    });
  } else {
    html += buildJsonLdFields(jsonLd);
  }

  html += '</div></div>';
  return html;
}

function buildJsonLdFields(obj) {
  let html = '<div class="geo-preview-ld-fields">';
  for (const [key, val] of Object.entries(obj)) {
    if (key === '@context' || key === '@type' || key === '@graph') continue;
    if (Array.isArray(val)) {
      if (val.length > 0 && typeof val[0] === 'object') {
        html += '<div class="geo-preview-ld-field">' +
          '<div class="geo-preview-ld-key">' + key + '</div>' +
          '<div class="geo-preview-ld-val">';
        val.forEach(item => {
          if (item['@type']) html += '<span class="geo-preview-ld-type">' + item['@type'] + '</span> ';
          if (item.name) {
            html += '<span class="geo-preview-ld-name">' + item.name + '</span>';
          } else if (item['@id']) {
            html += '<span class="geo-preview-ld-ref">' + item['@id'] + '</span>';
          } else {
            html += '<span class="geo-preview-ld-name">' + JSON.stringify(item) + '</span>';
          }
          html += ' ';
        });
        html += '</div></div>';
      } else {
        html += '<div class="geo-preview-ld-field">' +
          '<div class="geo-preview-ld-key">' + key + '</div>' +
          '<div class="geo-preview-ld-val">' + val.map(v => '<span class="geo-preview-tag">' + (typeof v === 'object' ? JSON.stringify(v) : v) + '</span>').join('') + '</div>' +
          '</div>';
      }
    } else if (typeof val === 'object' && val !== null) {
      html += '<div class="geo-preview-ld-field">' +
        '<div class="geo-preview-ld-key">' + key + '</div>' +
        '<div class="geo-preview-ld-val">';
      if (val['@type']) html += '<span class="geo-preview-ld-type">' + val['@type'] + '</span> ';
      if (val.name) html += '<span class="geo-preview-ld-name">' + val.name + '</span>';
      html += '</div></div>';
    } else {
      html += '<div class="geo-preview-ld-field">' +
        '<div class="geo-preview-ld-key">' + key + '</div>' +
        '<div class="geo-preview-ld-val">' + val + '</div>' +
        '</div>';
    }
  }
  html += '</div>';
  return html;
}
