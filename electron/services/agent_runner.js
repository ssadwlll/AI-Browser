// ============ Agent 主运行循环（Electron 主进程版） ============
// 迁移自 chrome-extension/background/services/agent-runner.js
// 包含：LLM API 调用、工具执行分发、待办进度管理、防死循环机制
//
// 关键适配点：
//   1. chrome.scripting.executeScript → browserView.webContents.executeJavaScript
//   2. chrome.tabs.sendMessage → 直接 executeJavaScript 提取页面内容
//   3. chrome.tabs.captureVisibleTab → browserView.webContents.capturePage().toDataURL()
//   4. chrome.runtime.Port 通信 → sendEvent(channel, data) 回调
//   5. Service Worker 心跳 → 不需要（Electron 主进程持久运行）
//   6. chrome.alarms → setInterval（已在 agent_resume_service 中实现）
//   7. ES modules → CommonJS (require/module.exports)
//   8. checkPortConnected → isAborted() 检查
//   9. PayloadStore 旧接口 → PayloadStoreAdapter 适配新 PayloadStore

const { fetchWithTimeout } = require('./utils')
const {
  shouldStoreToPayload,
  storeToPayload,
  smartTruncateResult,
  buildDataOverview,
  normalizePayload,
  formatSchemaSummary,
} = require('./payload_utils')
const { runJudge, saveToChatHistoryStorage, getTargetTab, recordMemory } = require('./agent_judge')
const { buildTools } = require('./tool_builder')
const WorkingMemory = require('./working_memory')
const ContextCompressor = require('./context_compressor')
const ScratchpadService = require('./scratchpad_service')
const GlobalDataStore = require('./global_data_store')
const StorageService = require('./storage_service')

// ============================================================
// 辅助函数
// ============================================================

// 上传对话归档到后端（在 finish_task 时调用，非阻塞主流程）
async function uploadConversationArchive(configService, data) {
  const syncConfig = await configService.getSyncConfig()
  if (!syncConfig.serverUrl || !syncConfig.appKey || !syncConfig.appSecret) {
    console.log('[ConversationArchive] 未配置后端服务器，跳过上传')
    return
  }
  const baseUrl = String(syncConfig.serverUrl).replace(/\/+$/, '')
  const url = `${baseUrl}/api/conversation-archives`
  const headers = await configService.generateAuthHeaders(syncConfig.appKey, syncConfig.appSecret)
  headers['Content-Type'] = 'application/json'
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  }, 60000)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = await res.json()
  if (!json.success) throw new Error(json.error || '上传失败')
  return json.data
}

// 从后端检索历史成功任务经验（RAG）
async function retrieveRAGExperiences(configService, userMessage, pageUrl, availableScriptIds = null) {
  const syncConfig = await configService.getSyncConfig()
  if (!syncConfig.serverUrl || !syncConfig.appKey || !syncConfig.appSecret) {
    return null
  }
  const baseUrl = String(syncConfig.serverUrl).replace(/\/+$/, '')
  const url = `${baseUrl}/api/conversation-archives/rag`
  const headers = await configService.generateAuthHeaders(syncConfig.appKey, syncConfig.appSecret)
  headers['Content-Type'] = 'application/json'
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ userMessage, pageUrl, topK: 3 }),
  }, 15000)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = await res.json()
  if (!json.success) throw new Error(json.error || 'RAG 检索失败')
  const data = json.data || {}
  const matches = Array.isArray(data.matches) ? data.matches : []
  if (matches.length === 0) return null

  const lines = []
  const usedVector = data.usedVectorRank === true
  lines.push(`[RAG 检索到 ${matches.length} 条相似历史任务经验，命中关键词: ${(data.keywords || []).join(', ')}${usedVector ? '，向量语义精排生效' : '，关键词匹配'}]`)
  matches.forEach((m, i) => {
    const vecScoreStr = (usedVector && typeof m.vectorScore === 'number') ? `，语义相似度=${m.vectorScore.toFixed(2)}` : ''
    lines.push(`\n--- 经验 ${i + 1}（任务 ${m.taskId}，${m.totalToolCalls} 次工具调用，${(m.durationMs / 1000).toFixed(0)}s${vecScoreStr}）${m.domainBoost ? ' [同域名加权]' : ''} ---`)
    lines.push(`用户原始请求: ${m.userMessage}`)
    if (m.summary) lines.push(`任务总结: ${m.summary}`)

    if (m.selectorFeedback && m.selectorFeedback.length > 0) {
      const validSels = m.selectorFeedback.filter(s => !s.isStale)
      const staleSels = m.selectorFeedback.filter(s => s.isStale)
      if (validSels.length > 0) {
        lines.push(`已验证可用选择器（${validSels.length} 个，可直接使用）:`)
        validSels.forEach(s => {
          const succInfo = s.successCount > 0 ? ` (成功${s.successCount}次)` : ''
          lines.push(`  - ${s.selector}${succInfo}`)
        })
      }
      if (staleSels.length > 0) {
        lines.push(`已失效选择器（${staleSels.length} 个，请勿使用，可能页面已改版）:`)
        staleSels.forEach(s => {
          lines.push(`  - ${s.selector} (失败${s.failCount}次，最后失败: ${s.lastFailureAt || '未知'})`)
        })
      }
    } else if (m.selectors && m.selectors.length > 0) {
      lines.push(`成功使用的选择器（未验证，仅供参考）: ${m.selectors.join(', ')}`)
    }

    if (m.scriptsUsed && m.scriptsUsed.length > 0) {
      const filterScripts = (arr) => {
        if (!availableScriptIds || availableScriptIds.size === 0) return arr
        return arr.filter(s => {
          const match = String(s).match(/#(\d+)/)
          if (!match) return true
          return availableScriptIds.has(Number(match[1]))
        })
      }
      const validScripts = filterScripts(m.scriptsUsed)
      const droppedCount = m.scriptsUsed.length - validScripts.length
      if (validScripts.length > 0) {
        lines.push(`调用的脚本: ${validScripts.join(', ')}`)
      }
      if (droppedCount > 0) {
        lines.push(`历史经验中有 ${droppedCount} 个脚本当前不可用（已从工具列表中移除，请改用 DOM 工具或 search_tools 查找其他可用脚本）`)
      }
    }
    if (m.toolsUsed && m.toolsUsed.length > 0) {
      const filterTools = (arr) => {
        if (!availableScriptIds || availableScriptIds.size === 0) return arr
        return arr.filter(t => {
          const match = String(t).match(/^inject_script_(\d+)$/)
          if (!match) return true
          return availableScriptIds.has(Number(match[1]))
        })
      }
      const validTools = filterTools(m.toolsUsed)
      if (validTools.length > 0) {
        lines.push(`工具调用顺序: ${validTools.join(' -> ')}`)
      }
    }
  })
  const hasAnyStale = matches.some(m => m.selectorFeedback?.some(s => s.isStale))
  const staleTip = hasAnyStale
    ? '已失效选择器来自旧版页面，请勿直接使用。优先使用已验证可用的选择器，并以 detect_page_template 实时结果为准。'
    : '以上为历史经验参考，仅供参考选择器/脚本方向。当前页面结构可能不同，请基于实际 detect_page_template 结果决定。'
  lines.push(staleTip)
  return lines.join('\n')
}

// 上报选择器使用结果到后端（非阻塞主流程）
let _feedbackQueue = Promise.resolve()
function reportSelectorFeedback(configService, { host, selector, toolName, taskId, resultStatus, itemCount }) {
  if (!host || !selector || !['success', 'failure'].includes(resultStatus)) return Promise.resolve()
  _feedbackQueue = _feedbackQueue.then(async () => {
    try {
      const syncConfig = await configService.getSyncConfig()
      if (!syncConfig.serverUrl || !syncConfig.appKey || !syncConfig.appSecret) return
      const baseUrl = String(syncConfig.serverUrl).replace(/\/+$/, '')
      const url = `${baseUrl}/api/selector-feedback/report`
      const headers = await configService.generateAuthHeaders(syncConfig.appKey, syncConfig.appSecret)
      headers['Content-Type'] = 'application/json'
      await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ host, selector, toolName, taskId, resultStatus, itemCount: itemCount || 0 }),
      }, 8000)
    } catch (e) {
      console.warn('[SelectorFeedback] 上报失败（非致命）:', e.message)
    }
  })
  return _feedbackQueue
}

// 解析 host：从 url 提取 hostname
function _extractHost(url) {
  try { return new URL(url).hostname || '' } catch { return '' }
}

// 统一规范 data_refs 参数：兼容数组、字符串、undefined
function normalizeDataRefs(raw) {
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean)
  if (typeof raw === 'string' && raw.length > 0) return raw.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

// 流式输出阈值
const STREAM_CHAR_THRESHOLD = 2000
const STREAM_DELAY_MS = 15

/** 将文本流式发送到 UI；超长内容采用分段发送避免累计超时 */
async function streamToUI(sendEvent, text) {
  if (!text) {
    sendEvent('streamDone', {})
    return
  }
  if (text.length > STREAM_CHAR_THRESHOLD) {
    const SEGMENT = 8000
    for (let i = 0; i < text.length; i += SEGMENT) {
      sendEvent('streamChunk', { content: text.slice(i, i + SEGMENT) })
      await new Promise(r => setTimeout(r, 30))
    }
  } else {
    for (const char of text) {
      sendEvent('streamChunk', { content: char })
      await new Promise(r => setTimeout(r, STREAM_DELAY_MS))
    }
  }
  sendEvent('streamDone', {})
}

// ============================================================
// DOM 工具执行（Electron 版）
// 通过 browserView.webContents.executeJavaScript 执行
// ============================================================

// 辅助函数注入代码：注入 _dqsa（深查询，穿透 Shadow DOM）和 _deepText（深文本提取）
const _HELPERS_CODE = `(() => {
  if (window._dqsa) return;
  window._dqsa = function deepQuerySelectorAll(selector, _root, _depth) {
    const root = _root || document;
    const depth = _depth || 0;
    if (depth > 10) return [];
    let results = [...root.querySelectorAll(selector)];
    const allEls = root.querySelectorAll('*');
    for (const el of allEls) {
      if (el.shadowRoot && el.tagName.includes('-')) {
        try {
          results = results.concat(deepQuerySelectorAll(selector, el.shadowRoot, depth + 1));
        } catch (e) {}
      }
    }
    return results;
  };
  window._deepText = function deepText(el, depth) {
    depth = depth || 0;
    if (depth > 10) return '';
    const parts = [];
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.trim();
        if (t) parts.push(t);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'NOSCRIPT') continue;
        parts.push(deepText(node, depth + 1));
        if (node.shadowRoot) {
          parts.push(deepText(node.shadowRoot, depth + 1));
        }
      }
    }
    return parts.filter(Boolean).join(' ');
  };
})()`

// qsa 工厂代码片段（每个使用选择器的工具内联，闭包变量序列化时丢失）
const _QSA_FACTORY = `const qsa=(s)=>{const m=s.match(/^(.*):contains\\("([^"]*)"\\)(.*)$/);if(!m)return window._dqsa(s);const c=(m[1]+m[3]).trim()||'*';const t=m[2].toLowerCase();return window._dqsa(c).filter(e=>window._deepText(e).toLowerCase().includes(t))}`

// DOM 工具函数定义：每个工具返回一段 JS 代码字符串（自包含 async 函数体）
// 参数通过 __args 对象传入
const DOM_TOOL_FUNCS = {
  extract_content: `(args) => {
    ${_QSA_FACTORY}
    const els = qsa(args.selector);
    const attrList = (() => {
      if (!args.attributes) return null;
      if (typeof args.attributes === 'string' && args.attributes.length > 0) return args.attributes.split(',').map(s => s.trim()).filter(Boolean);
      if (Array.isArray(args.attributes) && args.attributes.length > 0) return args.attributes;
      return null;
    })();
    const results = [];
    const max = Math.min(els.length, args.limit || 10);
    for (let i = 0; i < max; i++) {
      const item = { text: window._deepText(els[i]).slice(0, 500) };
      if (attrList) {
        item.attrs = {};
        for (const attr of attrList) {
          const val = els[i].getAttribute(attr);
          if (val !== null && val !== undefined) item.attrs[attr] = val;
        }
      }
      results.push(item);
    }
    return args.multiple !== false ? results : (results[0] || '');
  }`,

  click_element: `(args) => {
    ${_QSA_FACTORY}
    const els = qsa(args.selector);
    const el = els[args.index || 0];
    if (!el) return '元素未找到: ' + args.selector;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const linkHref = el.tagName === 'A' && el.href ? el.getAttribute('href') : null;
    if (el.tagName === 'A') { el.removeAttribute('target'); el.setAttribute('target', '_self'); }
    el.click();
    const text = window._deepText(el).slice(0, 50);
    if (linkHref) return '已点击链接: ' + (text || el.tagName) + ' -> ' + linkHref;
    return '已点击: ' + (text || el.tagName);
  }`,

  fill_input: `(args) => {
    ${_QSA_FACTORY}
    const els = qsa(args.selector);
    const el = els[0];
    if (!el) return '输入框未找到: ' + args.selector;
    el.focus();
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (el.tagName === 'TEXTAREA' && nativeTextareaSetter) { nativeTextareaSetter.call(el, args.value); }
    else if (nativeInputValueSetter) { nativeInputValueSetter.call(el, args.value); }
    else { el.value = args.value; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (args.submit) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
      const form = el.closest('form');
      if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    return '已填入: ' + (args.value || '').slice(0, 50) + (args.submit ? '（已提交）' : '');
  }`,

  wait_for_element: `(args) => {
    ${_QSA_FACTORY}
    return new Promise((resolve) => {
      const start = Date.now();
      const max = args.timeout || 5000;
      function check() {
        const els = qsa(args.selector);
        if (els.length > 0) { resolve({ found: true, count: els.length, elapsed: Date.now() - start, selector: args.selector }); return; }
        if (Date.now() - start > max) { resolve({ found: false, count: 0, elapsed: Date.now() - start, selector: args.selector, hint: '等待' + max + 'ms后未找到元素' }); return; }
        setTimeout(check, 200);
      }
      check();
    });
  }`,

  save_as_file: `(args) => {
    const blob = new Blob([args.content || ''], { type: args.mimeType || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = args.filename || 'download.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return '文件已触发下载: ' + (args.filename || 'download.txt');
  }`,

  navigate_to: `(args) => {
    if (!args.url || !args.url.startsWith('http')) return '无效URL: ' + args.url;
    window.location.href = args.url;
    return '正在导航到: ' + args.url;
  }`,

  go_back: `() => { window.history.back(); return '已返回上一页'; }`,

  go_forward: `() => { window.history.forward(); return '已前进到下一页'; }`,

  find_text_on_page: `(args) => {
    const collectText = (root, depth) => {
      depth = depth || 0;
      if (depth > 10) return '';
      let parts = [];
      for (const node of root.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent); }
        else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'NOSCRIPT') continue;
          parts.push(collectText(node, depth + 1));
          if (node.shadowRoot) { parts.push(collectText(node.shadowRoot, depth + 1)); }
        }
      }
      return parts.join(' ');
    };
    const text = collectText(document.body);
    const flags = args.caseSensitive ? 'g' : 'gi';
    const regex = new RegExp((args.query || '').replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), flags);
    const matches = text.match(regex) || [];
    const previews = [];
    for (let i = 0; i < Math.min(matches.length, 5); i++) {
      const idx = text.indexOf(matches[i]);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 30);
      const end = Math.min(text.length, idx + matches[i].length + 30);
      previews.push('...' + text.slice(start, end).replace(/\\n/g, ' ') + '...');
    }
    return { found: matches.length > 0, matchCount: matches.length, query: args.query, previews, hint: matches.length === 0 ? '未找到"' + args.query + '"' : null };
  }`,

  get_element_info: `(args) => {
    ${_QSA_FACTORY}
    const els = qsa(args.selector);
    const max = Math.min(els.length, args.limit || 5);
    const attrList = args.attributes ? args.attributes.split(',').map(a => a.trim()).filter(Boolean) : null;
    const items = [];
    for (let i = 0; i < max; i++) {
      const text = window._deepText(els[i]).slice(0, 80);
      let line = '[' + i + '] <' + els[i].tagName.toLowerCase() + '> ' + (text || '(空文本)');
      if (attrList) {
        const pairs = [];
        for (const attr of attrList) {
          let val = els[i].getAttribute(attr);
          if (val !== null && val !== undefined) {
            if (attr === 'href' && val.length > 60) val = val.slice(0, 57) + '...';
            pairs.push(attr + '="' + val + '"');
          }
        }
        if (pairs.length > 0) line += ' | ' + pairs.join(', ');
      }
      items.push(line);
    }
    let summary = '共' + els.length + '个匹配，返回前' + items.length + '条:\\n' + items.join('\\n');
    if (els.length > max) summary += '\\n(还有' + (els.length - max) + '条未显示)';
    return summary;
  }`,

  scroll_page: `(args) => {
    const dir = args.direction === 'up' ? -1 : 1;
    let px = window.innerHeight * 0.8;
    if (args.amount === 'half') px = window.innerHeight * 0.5;
    else if (args.amount && /^\\d+$/.test(args.amount)) px = parseInt(args.amount);
    window.scrollBy({ top: dir * px, behavior: 'smooth' });
    const scrolled = Math.round(window.scrollY);
    const total = Math.round(document.documentElement.scrollHeight - window.innerHeight);
    return '已' + (args.direction === 'up' ? '向上' : '向下') + '滚动' + px + 'px，当前位置: ' + scrolled + '/' + total;
  }`,

  hover_element: `(args) => {
    ${_QSA_FACTORY}
    const els = qsa(args.selector);
    const el = els[args.index || 0];
    if (!el) return { ok: false, error: '元素未找到: ' + args.selector };
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return '已悬停: ' + (window._deepText(el).slice(0, 50) || el.tagName);
  }`,

  select_dropdown: `(args) => {
    ${_QSA_FACTORY}
    const els = qsa(args.selector);
    const el = els[0];
    if (!el || el.tagName !== 'SELECT') return { ok: false, error: '未找到<select>元素: ' + args.selector };
    const mode = args.by || 'text';
    let matched = false;
    for (const opt of el.options) {
      const isMatch = mode === 'index' ? (opt.index === parseInt(args.value))
        : mode === 'value' ? (opt.value === args.value)
        : ((opt.textContent || '').trim() === args.value || opt.text === args.value);
      if (isMatch) { el.value = opt.value; matched = true; break; }
    }
    if (!matched) return { ok: false, error: '在下拉框中未找到选项: "' + args.value + '"' };
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return '已选择: ' + args.value;
  }`,

  press_key: `(args) => {
    const opts = { key: args.key, code: args.key, keyCode: { Escape: 27, Enter: 13, Tab: 9, PageDown: 34, PageUp: 33, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 }[args.key] || 0, bubbles: true };
    let target = document;
    if (args.selector) {
      const els = window._dqsa(args.selector);
      const el = els[0];
      if (el) { el.focus(); target = el; }
    }
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
    return '已按键: ' + args.key + (args.selector ? ' (目标: ' + args.selector + ')' : '');
  }`,

  get_interactive_elements: `(args) => {
    const interactives = ['a', 'button', 'input', 'select', 'textarea', '[onclick]', '[role="button"]', '[tabindex]', '[class*="btn"]', '[class*="link"]', '[class*="item"]'];
    const selector = args.selectorHint || interactives.join(',');
    const els = window._dqsa(selector);
    const results = [];
    const max = Math.min(els.length, 20);
    for (let i = 0; i < max; i++) {
      const el = els[i];
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const text = window._deepText(el).slice(0, 40) || (el.value || '').slice(0, 40);
      const tag = el.tagName.toLowerCase();
      const id = el.id ? '#' + el.id : '';
      const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : '';
      const href = el.tagName === 'A' ? (el.getAttribute('href') || '').slice(0, 50) : '';
      results.push({ index: results.length, tag, text, selector: (tag + id + cls).slice(0, 60), href, type: el.type || '' });
    }
    return { total: els.length, listed: results.length, elements: results, hint: '使用 click_element 配合 selector 或 index 参数进行交互' };
  }`,

  detect_page_template: `(args) => {
    const sampleLimit = Math.min(Math.max(parseInt(args.sample_limit) || 5, 1), 10);
    const listContainerSelectors = ['ul','ol','tbody','[class*="list"]','[class*="item"]','[class*="card"]','[class*="article"]','[class*="news"]','[class*="post"]','[class*="result"]','[class*="product"]','[class*="entry"]','article','li','tr'];
    const seen = new Set();
    const candidates = [];
    for (const sel of listContainerSelectors) {
      let els; try { els = window._dqsa(sel) } catch { continue }
      for (const el of els) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 100 || rect.height < 30) continue;
        if (el.children.length < 2) continue;
        const sig = el.tagName + '.' + (el.className || '').toString().slice(0, 30);
        if (seen.has(sig)) continue;
        seen.add(sig);
        candidates.push({ el, sel: sig, childCount: el.children.length });
      }
    }
    candidates.sort((a, b) => b.childCount - a.childCount);
    let repeatPattern = null;
    for (const c of candidates.slice(0, 15)) {
      const children = Array.from(c.el.children).slice(0, sampleLimit);
      if (children.length < 2) continue;
      const signatures = children.map(child => {
        const tag = child.tagName.toLowerCase();
        const cls = (child.className || '').toString().split(/\\s+/).slice(0, 2).join('.');
        return tag + '.' + cls;
      });
      const sigCounts = {};
      for (const s of signatures) sigCounts[s] = (sigCounts[s] || 0) + 1;
      let maxSig = null, maxCount = 0;
      for (const [s, n] of Object.entries(sigCounts)) { if (n > maxCount) { maxSig = s; maxCount = n; } }
      if (maxCount >= 2 && maxSig) {
        repeatPattern = { containerSelector: c.sel, containerTag: c.el.tagName.toLowerCase(), itemCount: c.childCount, sampleCount: children.length, itemSignature: maxSig, repeatCount: maxCount };
        break;
      }
    }
    const recommendSelectors = {};
    const titleEls = window._dqsa('h1, h2, h3, [class*="title"], [class*="heading"]');
    if (titleEls.length > 0) {
      const el = titleEls[0];
      const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : '';
      recommendSelectors.title = el.tagName.toLowerCase() + cls;
    }
    const links = window._dqsa('a[href]');
    let bestLink = null, bestLen = 0;
    for (const a of links) { const t = window._deepText(a); if (t.length > bestLen && t.length < 200) { bestLen = t.length; bestLink = a; } }
    if (bestLink) { const cls = bestLink.className && typeof bestLink.className === 'string' ? '.' + bestLink.className.split(' ').slice(0, 2).join('.') : ''; recommendSelectors.link = 'a' + cls + '[href]'; }
    const dateEls = window._dqsa('time, [class*="date"], [class*="time"]');
    if (dateEls.length > 0) { const el = dateEls[0]; const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : ''; recommendSelectors.date = el.tagName.toLowerCase() + cls; }
    const contentEls = window._dqsa('article, main, [class*="content"], [class*="article-body"], [class*="post-content"]');
    if (contentEls.length > 0) { const el = contentEls[0]; const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : ''; recommendSelectors.content = el.tagName.toLowerCase() + cls; }
    if (repeatPattern) { recommendSelectors.listItem = repeatPattern.itemSignature; recommendSelectors.listContainer = repeatPattern.containerSelector; }
    let pageType = 'unknown', pageTypeReason = '';
    const url = location.href.toLowerCase();
    const hasRepeat = repeatPattern && repeatPattern.repeatCount >= 2;
    const hasSearch = url.includes('search') || url.includes('q=') || url.includes('query');
    const hasArticle = recommendSelectors.content && titleEls.length > 0;
    const hasTable = window._dqsa('table tbody tr').length >= 2;
    if (hasTable) { pageType = 'table_data'; pageTypeReason = '检测到表格'; }
    else if (hasRepeat && hasSearch) { pageType = 'search_results'; pageTypeReason = 'URL含搜索参数+重复列表项'; }
    else if (hasRepeat && !hasArticle) { pageType = 'list_page'; pageTypeReason = '检测到重复容器'; }
    else if (hasArticle && !hasRepeat) { pageType = 'article_detail'; pageTypeReason = '检测到标题+正文'; }
    else if (hasRepeat && hasArticle) { pageType = 'article_detail'; pageTypeReason = '详情页带推荐'; }
    return { pageType, pageTypeReason, repeatPattern, recommendedSelectors: recommendSelectors, suggestion: pageType === 'list_page' ? '列表页，可用 extract_content 批量提取' : pageType === 'article_detail' ? '详情页，可提取正文' : '未识别到典型页面类型' };
  }`,
}

/**
 * 注入 DOM 辅助函数到页面（幂等，已存在则跳过）
 */
async function injectDOMHelpers(webContents) {
  try {
    await webContents.executeJavaScript(_HELPERS_CODE)
  } catch (e) {
    console.warn('[Agent] 注入 DOM 辅助函数失败:', e.message)
  }
}

/**
 * 执行 DOM 工具（Electron 版）
 * 通过 browserView.webContents.executeJavaScript 执行自包含的 JS 代码
 * @param {object} browserView - BrowserView 实例
 * @param {string} toolName - 工具名称
 * @param {object} args - 工具参数
 * @returns {Promise<{ok: boolean, result?: any, error?: string}>}
 */
async function executeDOMTool(browserView, toolName, args) {
  const funcCode = DOM_TOOL_FUNCS[toolName]
  if (!funcCode) return { ok: false, error: `未知DOM工具: ${toolName}` }

  const webContents = browserView.webContents
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: '页面不可用（webContents 已销毁）' }
  }

  try {
    // 先注入辅助函数（幂等）
    await injectDOMHelpers(webContents)

    // 构建执行代码：自包含 async IIFE
    const code = `(async () => {
      const __args = ${JSON.stringify(args || {})};
      const __func = ${funcCode};
      try {
        const __result = await __func(__args);
        return { ok: true, result: __result };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })()`

    const result = await webContents.executeJavaScript(code)
    return result
  } catch (e) {
    console.error('[Agent] executeDOMTool error:', toolName, e.message)
    if (e.message?.includes('Cannot access a chrome:// URL') || e.message?.includes('Cannot access contents of url')) {
      return { ok: false, error: '当前页面为系统页面，无法执行DOM操作。' }
    }
    return { ok: false, error: e.message }
  }
}

/**
 * 带超时的 DOM 工具执行
 */
async function executeDOMToolWithTimeout(browserView, toolName, args, timeoutMs) {
  let timeoutId = null
  try {
    const result = await Promise.race([
      executeDOMTool(browserView, toolName, args),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('动作超时')), timeoutMs)
      }),
    ])
    return result
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId)
  }
}

/**
 * 提取页面内容（替代 chrome.tabs.sendMessage {type:'extractPageContent'}）
 * 返回 { title, url, content }
 */
async function extractPageContent(browserView) {
  if (!browserView) return null
  try {
    const webContents = browserView.webContents
    if (!webContents || webContents.isDestroyed()) return null
    const data = await webContents.executeJavaScript(`(() => {
      const getText = (el) => {
        if (!el) return '';
        const parts = [];
        for (const node of el.querySelectorAll('h1,h2,h3,p,li,td,th,span,div,a,article,section')) {
          const t = (node.innerText || node.textContent || '').trim();
          if (t && t.length > 2) parts.push(t.slice(0, 200));
        }
        return parts.join(' ').slice(0, 3000);
      };
      return { title: document.title || '', url: location.href || '', content: getText(document.body) };
    })()`)
    return data
  } catch (e) {
    console.warn('[Agent] extractPageContent 失败:', e.message)
    return null
  }
}

// ============================================================
// PayloadStoreAdapter
// 适配新 PayloadStore（set/get/getByEntryId）为旧接口（entries/add/getDataByIds/getSummaryForFinish）
// ============================================================
class PayloadStoreAdapter {
  constructor(payloadStore) {
    this.payloadStore = payloadStore
    this._sessionId = null
    this._counter = 0
    // entries 数组：保持与原接口兼容，供 getSummaryForFinish / entries.filter 等使用
    this.entries = []
  }

  getSessionId() { return this._sessionId }

  setSessionId(id) { this._sessionId = id }

  /**
   * 存储工具结果数据
   * @returns {Promise<string|null>} storeId（如 "p1"），失败返回 null
   */
  async add(toolName, items, summary, metadata) {
    this._counter++
    const storeId = `p${this._counter}`
    const entry = {
      id: storeId,
      toolName,
      summary: String(summary || '').slice(0, 200),
      metadata: metadata || {},
      sessionId: this._sessionId,
    }
    const entryId = await this.payloadStore.set(this._sessionId, storeId, items, summary)
    if (entryId === null) {
      this._counter--
      return null
    }
    this.entries.push(entry)
    return storeId
  }

  /**
   * 按 ID 列表批量获取数据
   * @param {string[]} ids
   * @returns {Promise<object>} { id: data }
   */
  async getDataByIds(ids) {
    const result = {}
    for (const id of ids) {
      result[id] = await this.payloadStore.get(this._sessionId, id)
    }
    return result
  }

  /**
   * 生成 finish_task 用的数据摘要
   * @returns {object|null} { count, items: [{id, toolName, count, schema, sample, summary, renderType...}] }
   */
  getSummaryForFinish() {
    const sessionEntries = this.entries.filter(e => e.sessionId === this._sessionId)
    if (sessionEntries.length === 0) return null
    return {
      count: sessionEntries.length,
      items: sessionEntries.map(e => ({
        id: e.id,
        toolName: e.toolName,
        count: e.metadata?.count || 1,
        schema: e.metadata?.schema || null,
        sample: e.metadata?.sample || null,
        summary: e.summary,
        renderType: e.metadata?.renderType || null,
        templateId: e.metadata?.template_id || null,
        fieldMapping: e.metadata?.field_mapping || null,
        reportTitle: e.metadata?.title || null,
      })),
    }
  }

  /**
   * 继承上一轮会话数据（简化版：仅继承 entries 元数据，数据本身由 PayloadStore 管理）
   */
  inheritFromLastSession(newSessionId, ttl) {
    // 新 PayloadStore 按 sessionId 隔离，跨会话继承需要显式拷贝
    // 此处简化：仅更新 sessionId，不拷贝数据（agent_runner 中 payloadStore.entries 仍可访问旧数据）
    this._sessionId = newSessionId
  }
}

// ============================================================
// SimpleOutputService
// 简化版输出服务，使用 StorageService 替代 IndexedDB
// ============================================================
class SimpleOutputService {
  generateTaskId() {
    return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  async save(output) {
    try {
      const outputs = (await StorageService.get('agent_outputs')) || []
      outputs.push(output)
      // 仅保留最近 50 条
      if (outputs.length > 50) outputs.shift()
      await StorageService.set('agent_outputs', outputs)
      console.log(`[OutputService] 任务输出已保存: taskId=${output.taskId}`)
    } catch (e) {
      console.warn('[OutputService] 保存失败（非致命）:', e.message)
    }
  }
}

// ============================================================
// Agent 主运行循环
// ============================================================

/**
 * Agent 主运行循环
 * @param {object} ctx - 运行上下文（包含所有依赖）
 */
async function runAgent(ctx) {
  const {
    configService, scriptService,
    tabManager, actionExecutor,
    agentStates, domainPolicy, payloadStore, todoScheduler,
    filteredScriptsCache, domainMismatchLogged, pageReadCache,
    MAX_AI_REQUESTS, TIMEOUT_MS, ACTION_TIMEOUT_MS,
    sendEvent, isAborted, yieldUI,
    tabId, userMessage, chatHistory,
    toolRecordingService,
    modelInfo,
  } = ctx

  // toolService 容错：如果未注入（admin-server 未连接），使用空操作适配器
  const toolService = ctx.toolService || {
    searchScripts: async () => [],
    fetchAgentIndex: async () => [],
    executeTool: async () => { throw new Error('toolService 未配置') },
    fetchReportTemplates: async () => [],
  }

  const startTime = Date.now()
  await domainPolicy.load()

  // postToUI 包装：统一通过 sendEvent 发送事件
  const postToUI = (_tabId, msg) => sendEvent(msg.type, msg)

  // ===== 应用全局设置（从后端读取，缓存兜底） =====
  let appSettings = null
  try {
    appSettings = await configService.getAppSettings()
  } catch (e) {
    console.warn('[Agent] 读取应用设置失败，使用默认值:', e.message)
  }
  const backendMaxRounds = appSettings?.agent_max_rounds || 30
  const backendSystemPrompt = appSettings?.agent_system_prompt || ''

  let maxRounds = backendMaxRounds
  let enableJudge = true
  let debug = false
  try {
    const agentCfg = await configService.getAgentConfig()
    if (!appSettings && agentCfg?.maxRounds >= 5) maxRounds = agentCfg.maxRounds
    enableJudge = agentCfg?.enableJudge !== false
    debug = agentCfg?.debug === true
  } catch {}

  const _debugLog = (label, detail) => {
    if (!debug) return
    const summary = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)
    console.log(`[AgentDebug] ${label}`, detail)
    try { sendEvent('agentDebug', { label, detail: summary }) } catch(e) { console.warn('[AgentDebug] sendEvent失败', e) }
  }

  // _allRoundsData: 收集所有轮次的完整数据，用于任务结束时上传到后端
  const _allRoundsData = []

  // ===== 全景对话：收集和发送轮次数据 =====
  let _requestMessagesSnapshot = []  // AI 请求前的 messages 快照
  let _roundToolResults = []         // 本轮工具执行结果

  // 发送轮次数据到全景对话窗口
  const _sendConversationRound = (roundData) => {
    try {
      _allRoundsData.push(roundData)
      sendEvent('conversationRound', roundData)
    } catch (e) { /* 忽略 */ }
  }

  // ===== 上限策略 =====
  const ABSOLUTE_MAX_ROUNDS = 100
  const effectiveMaxRounds = Math.min(maxRounds, ABSOLUTE_MAX_ROUNDS)
  if (effectiveMaxRounds !== maxRounds) {
    console.warn(`[Agent] maxRounds ${maxRounds} 超过绝对硬上限 ${ABSOLUTE_MAX_ROUNDS}，自动收敛`)
  }
  const MAX_TOOL_CALLS = Math.min(300, Math.max(30, effectiveMaxRounds * 3))
  let aiRequestCount = 0
  let totalToolCalls = 0
  let searchResults = []
  const executedTools = []
  const _injections = []

  // ===== ScratchpadService & OutputService 初始化 =====
  const scratchpadService = new ScratchpadService()
  const outputService = new SimpleOutputService()
  const _startTime = Date.now()
  let _taskId = null

  // ===== WorkingMemory & ContextCompressor 初始化 =====
  const sessionId = payloadStore.getSessionId() || `s_${tabId}_${Date.now()}`
  payloadStore.setSessionId(sessionId)
  const workingMemory = new WorkingMemory()
  const contextCompressor = new ContextCompressor(configService)
  let hasSearchedTools = false
  todoScheduler.clear()
  const _usedSelectorToolCombo = new Set()

  // ===== 预加载报告模板（Electron 版使用内置模板，跳过远程加载） =====
  // tool_builder.js 已内置报告模板，无需 loadRemoteTemplates

  // ===== 历史清理 =====
  const rawHistory = (chatHistory || [])
  const failureMarkers = ['❌', '脚本语法错误', '执行失败', 'Unexpected identifier', 'appKey', 'appSecret', '认证失败', '401', '403']
  while (rawHistory.length >= 2) {
    const last = rawHistory[rawHistory.length - 1]
    if (last.role === 'assistant' && failureMarkers.some(m => last.content?.includes(m))) {
      rawHistory.pop()
      if (rawHistory.length > 0 && rawHistory[rawHistory.length - 1].role === 'user') {
        rawHistory.pop()
      }
    } else {
      break
    }
  }
  // 清理末尾连续的孤儿 user 消息
  while (rawHistory.length >= 1) {
    const last = rawHistory[rawHistory.length - 1]
    if (last?.role === 'user' && last?.content === userMessage) {
      rawHistory.pop()
    } else {
      break
    }
  }
  const cleanHistory = rawHistory.map(m => {
    const { toolCalls, tool_calls, ...clean } = m
    if (clean.role === 'assistant' && typeof clean.content === 'string' && clean.content.length > 1000) {
      const original = clean.content
      const head = original.slice(0, 500)
      const tail = original.slice(-200)
      clean.content = head + `\n\n...(对话历史已压缩，原始${original.length}字符)...\n\n` + tail
    }
    return clean
  })

  // ===== 统一系统提示词 =====
  const DEFAULT_SYSTEM_PROMPT = `你是AI Browser智能体，一个能操作网页、调用脚本、整理数据的自主助手。

=== 工作流程 ===
1. 了解当前页面：使用 get_interactive_elements / read_page_content 获取页面概览（系统可能已自动注入页面内容，如有则直接使用）
2. 规划任务：复杂任务调用 create_todo 创建待办列表；简单任务（1-2步可完成）直接执行，无需创建待办
3. 按待办顺序执行工具操作，系统自动追踪进度
4. 所有待办完成 → 调用 finish_task 汇报结果

=== 工具使用策略 ===
- DOM工具（extract_content、click_element等）：用于页面探索、简单数据提取、交互操作
- inject_script_N：用于批量处理、深度数据采集（N是search_tools查到的脚本ID）
- generate_script：动态生成代码执行任意JS逻辑（DOM操作/数据处理/同源fetch等）。代码运行在 async 函数体中，可直接 await；必须用 return 返回结果。受页面 CSP 限制（严格 CSP 站点会报 unsafe-eval 错误，此时改用 inject_script_N 或 DOM 工具）。返回 HTML 字符串时自动渲染为可视化报告
- fetch_url：在主进程发起网络请求，突破 CORS 限制。跨域 fetch 用此工具，不要用 generate_script 中的 fetch
- search_tools：搜索脚本库，查找可用的远程脚本
- finish_task：完成所有任务后输出最终结果

=== 脚本选择优先级（必须遵守） ===
1. 优先查看系统注入的"当前可用脚本库"清单，按 urlPattern 匹配当前页面选择 inject_script_N
2. 清单未明确匹配时，主动调用 search_tools 用任务关键词搜索脚本库
3. 以上都无匹配时，使用 DOM 工具组合完成（navigate_to + extract_content + click_element）
严禁：脚本库已有可用脚本却跳过，造成重复造轮子

=== 数据流转机制 ===
工具返回的数据量较大时，系统会自动存储完整数据，只发回 schema+样例摘要。
- 数据摘要可直接用于回答用户，或在 finish_task 中通过 data_refs 引用完整数据
- 操作全量数据：generate_script(data_refs=["p1","p2"]) — 系统自动注入全量数据到页面，代码中通过 window.__store.p1 访问
- 整合多份数据：generate_script(data_refs=["p1","p2"], code="return [...__store.p1, ...__store.p2]")

=== finish_task 数据报告（重要） ===
当任务涉及数据采集/提取/生成时，finish_task 必须通过 data_refs 参数引用所有已存储的数据，系统会自动渲染结构化数据报告（表格/卡片/HTML）。
- 查看系统注入的"[存储数据汇总]"获取可用 data_refs ID（格式如 p1, p2, store_xxx）
- 示例：finish_task(summary="采集完成，共获取20条数据", data_refs=["p1","p2"])
- 如果任务不涉及数据（如页面操作、导航等），可省略 data_refs
- data_refs 引用的数据将以可视化报告形式展示给用户，而非纯文本

=== 任务边界处理 ===
当用户请求超出当前可用工具能力时，请：
1. 直接调用 finish_task 说明情况并提供替代方案
2. 不要反复尝试无法完成的操作，避免陷入循环

当连续5次工具调用都无法推进任务时，请调用 finish_task 汇报当前已有结果。

=== 输出规范 ===
- 自然语言总结结果，不输出原始JSON
- 错误时分析原因并在finish_task中告知

=== 对话上下文 ===
你正在与用户进行连续对话。如果上下文中存在"上轮任务数据"或"历史存储数据"，表示之前已执行过任务并产生了结果。
- 这些数据可供你参考和使用，无需重新执行页面操作
- 完整数据可通过 finish_task(data_refs) 在最终输出中引用`

  const systemPrompt = backendSystemPrompt || DEFAULT_SYSTEM_PROMPT
  const systemMsg = { role: 'system', content: systemPrompt }

  // ===== 自动读取页面内容 =====
  let autoPageContent = null
  try {
    const targetTab = await getTargetTab(tabManager, tabId)
    if (targetTab) {
      autoPageContent = await extractPageContent(targetTab.browserView)
      if (autoPageContent) {
        console.log('[Agent] 自动读取页面内容:', autoPageContent.title, 'URL:', autoPageContent.url, '内容长度:', (autoPageContent.content || '').length)
      }
    }
  } catch (e) {
    console.warn('[Agent] 自动读取页面内容失败（非致命）:', e.message)
  }

  // ===== 自动搜索服务端工具库 =====
  let autoSearchKeywords = []
  try {
    const chineseWords = userMessage.match(/[\u4e00-\u9fff]{2,4}/g) || []
    const pageKeywords = []
    if (autoPageContent) {
      const urlHost = (autoPageContent.url || '').match(/(?:https?:\/\/)?([^./]+)/)?.[1] || ''
      if (urlHost.length >= 2) pageKeywords.push(urlHost)
      const titleWords = (autoPageContent.title || '').match(/[\u4e00-\u9fff]{2,4}/g) || []
      pageKeywords.push(...titleWords.slice(0, 3))
      const contentWords = (autoPageContent.content || '').match(/[\u4e00-\u9fff]{2,4}/g) || []
      const noiseWords = new Set(['可以', '已经', '但是', '因为', '所以', '或者', '如果', '虽然', '我们', '他们', '这个', '那个', '什么', '怎么', '就是', '也是', '不是', '还是', '只是', '以及', '其中', '其他', '一些', '这些', '那些'])
      const meaningfulContentWords = contentWords.filter(w => !noiseWords.has(w)).slice(0, 5)
      pageKeywords.push(...meaningfulContentWords)
    }
    const INTENT_KEYWORDS = {
      '采集': ['采集', '批量'], '批量': ['批量', '采集'], '抓取': ['抓取', '采集'],
      '新闻': ['新闻', '采集'], '导出': ['导出', '下载'], '下载': ['下载', '导出'],
      '翻译': ['翻译'], '监控': ['监控'], '搜索': ['搜索'], '热点': ['热点', '热搜'],
    }
    const expandedWords = new Set(chineseWords)
    for (const word of chineseWords) {
      if (INTENT_KEYWORDS[word]) INTENT_KEYWORDS[word].forEach(w => expandedWords.add(w))
    }
    for (const pw of pageKeywords) {
      if (!expandedWords.has(pw)) expandedWords.add(pw)
    }
    autoSearchKeywords = [...expandedWords].slice(0, 6)
  } catch {}

  if (autoSearchKeywords.length > 0) {
    try {
      const autoResults = await toolService.searchScripts(autoSearchKeywords.join(' '))
      if (autoResults.length > 0) {
        const existingIds = new Set(searchResults.map(s => s.id))
        for (const r of autoResults) {
          if (!existingIds.has(r.id)) {
            searchResults.push(r)
            existingIds.add(r.id)
          }
        }
        hasSearchedTools = true
        console.log(`[Agent] 自动搜索命中${autoResults.length}个脚本:`, autoResults.map(s => `${s.name}(#${s.id})`).join(', '))
      } else {
        hasSearchedTools = true
        console.log('[Agent] 自动搜索无结果:', autoSearchKeywords.join(' '))
      }
    } catch (e) {
      console.warn('[Agent] 自动搜索失败（非致命）:', e.message)
    }
  }

  // ===== 注入页面内容到上下文 =====
  if (autoPageContent) {
    const pageContentBrief = (autoPageContent.content || '').slice(0, 500)
    let pageContextMsg = `[已执行 read_page_content] 标题: ${autoPageContent.title || '无标题'} | URL: ${autoPageContent.url || ''}\n页面正文: ${pageContentBrief}\n\n⚠️ read_page_content 已自动执行，请勿重复调用此工具。如需更多内容可滚动页面(scroll_page)后再次提取。`
    if (searchResults.length > 0) {
      pageContextMsg += `\n\n已匹配到 ${searchResults.length} 个专用脚本，可直接使用：\n` + searchResults.slice(0, 5).map(s => {
        const params = s.toolConfig?.parameters?.properties ? Object.keys(s.toolConfig.parameters.properties) : []
        const paramHint = params.length > 0 ? `（参数: ${params.join(', ')}）` : ''
        return `  - inject_script_${s.id}(${s.name})${paramHint}: ${(s.description || '').slice(0, 80)}`
      }).join('\n')
    } else {
      pageContextMsg += '\n暂无匹配的专用脚本，请使用本地DOM工具（extract_content/click_element/scroll_page等）完成任务。'
    }
    _injections.push(pageContextMsg)

    // ===== 注入完整脚本索引 =====
    try {
      const allScripts = await toolService.fetchAgentIndex()
      if (allScripts.length > 0) {
        const currentUrl = autoPageContent.url || ''
        let currentHost = ''
        try { currentHost = new URL(currentUrl).hostname || '' } catch {}

        const sorted = [...allScripts].sort((a, b) => {
          const aMatch = a.urlPattern && currentHost && a.urlPattern.includes(currentHost) ? 1 : 0
          const bMatch = b.urlPattern && currentHost && b.urlPattern.includes(currentHost) ? 1 : 0
          return bMatch - aMatch
        })

        const lines = sorted.map(s => {
          const host = s.urlPattern ? ` [适用: ${s.urlPattern.slice(0, 40)}]` : ''
          return `  - inject_script_${s.id}(${s.name})${host}: ${s.description || '无描述'}`
        })
        let scriptIndex = lines.join('\n')
        if (scriptIndex.length > 4000) {
          scriptIndex = scriptIndex.slice(0, 4000) + `\n  ...（共 ${allScripts.length} 个脚本，已截断）`
        }
        const indexMsg = `\n\n当前可用脚本库（共 ${allScripts.length} 个，按当前页面匹配度排序）:\n${scriptIndex}\n\n⚠️ 优先使用上述脚本库中的 inject_script_N，脚本库中没有合适的再使用 DOM 工具组合。`
        _injections.push(indexMsg)
        console.log(`[Agent] 已注入全脚本索引: ${allScripts.length} 个脚本`)
      }
    } catch (e) {
      console.warn('[Agent] 全脚本索引注入失败（非致命）:', e.message)
    }

    // ===== 自动页面模板识别 + RAG 经验检索 =====
    try {
      const targetTab = await getTargetTab(tabManager, tabId)
      if (targetTab) {
        const availableScriptIds = new Set(searchResults.map(s => Number(s.id)).filter(Boolean))

        const [templateResult, ragExperiences] = await Promise.allSettled([
          executeDOMToolWithTimeout(targetTab.browserView, 'detect_page_template', {}, 5000),
          retrieveRAGExperiences(configService, userMessage, autoPageContent.url || '', availableScriptIds),
        ])

        if (templateResult.status === 'fulfilled' && templateResult.value?.ok) {
          const tpl = templateResult.value.result
          if (tpl && tpl.pageType) {
            const selHint = tpl.recommendedSelectors ? Object.entries(tpl.recommendedSelectors).map(([k, v]) => `${k}=${v}`).join(', ') : ''
            const tplMsg = `[已自动执行 detect_page_template] 页面类型: ${tpl.pageType}（${tpl.pageTypeReason}）\n推荐选择器: ${selHint || '无'}\n${tpl.suggestion || ''}\n⚠️ detect_page_template 已自动执行，请勿重复调用。`
            _injections.push(tplMsg)
            console.log('[Agent] 页面模板识别:', tpl.pageType, '| 选择器:', selHint)
          }
        } else if (templateResult.status === 'rejected') {
          console.warn('[Agent] 页面模板识别失败（非致命）:', templateResult.reason?.message)
        }

        if (ragExperiences.status === 'fulfilled' && ragExperiences.value) {
          _injections.push(ragExperiences.value)
          console.log('[Agent] RAG 经验已注入上下文')
        } else if (ragExperiences.status === 'rejected') {
          console.warn('[Agent] RAG 检索失败（非致命）:', ragExperiences.reason?.message)
        }
      }
    } catch (e) {
      console.warn('[Agent] 页面模板/RAG 注入失败（非致命）:', e.message)
    }

    // 初始化 WorkingMemory
    workingMemory.init(sessionId, userMessage, autoPageContent)
    const pageUrl = autoPageContent.url || ''
    if (pageUrl) {
      pageReadCache.set(pageUrl, JSON.stringify({
        ok: true,
        title: autoPageContent.title || '',
        url: autoPageContent.url || '',
        content: (autoPageContent.content || '').slice(0, 3000),
      }))
    }
  } else {
    workingMemory.init(sessionId, userMessage)
  }

  const lastHistoryMsg = cleanHistory.length > 0 ? cleanHistory[cleanHistory.length - 1] : null
  const lastIsUserMsg = lastHistoryMsg?.role === 'user' && lastHistoryMsg?.content === userMessage
  const messages = lastIsUserMsg
    ? [systemMsg, ...cleanHistory]
    : [systemMsg, ...cleanHistory, { role: 'user', content: userMessage }]

  // ===== 注入 payloadStore 历史数据摘要 =====
  const payloadSummary = payloadStore.getSummaryForFinish()
  const globalSummaries = todoScheduler.globalDataStore.getSummary() ? [todoScheduler.globalDataStore.getSummary()] : []
  if (payloadSummary || globalSummaries.length > 0) {
    const parts = []
    if (payloadSummary) {
      parts.push(`上一轮执行的工具及结果（${payloadSummary.count}条）：`)
      for (const item of payloadSummary.items) {
        if (item.schema) {
          const schemaStr = Object.entries(item.schema).map(([k, v]) => `${k}:${v}`).join(', ')
          const sampleStr = item.sample && item.sample.length > 0 ? JSON.stringify(item.sample).slice(0, 120) : ''
          let line = `  - ${item.id}(${item.toolName}): ${item.count}条 | {${schemaStr}}`
          if (sampleStr) line += ` | 样例: ${sampleStr}`
          parts.push(line)
        } else {
          parts.push(`  - ${item.id}(${item.toolName}): ${item.summary}`)
        }
      }
    }
    if (globalSummaries.length > 0) {
      parts.push(`\n全局存储数据：\n${globalSummaries.join('\n')}`)
    }
    _injections.push(`=== 上轮任务数据 ===\n${parts.join('\n')}\n\n这些数据可直接在 finish_task 中通过 data_refs 引用作为最终输出。`)
  }

  // ===== 简单请求快速路径 =====
  const SIMPLE_REQUEST_PATTERNS = ['导出', 'csv', 'excel', '格式化', '整理成', '转换', '翻译', '汇总', '合并', '去重', '统计', '分析', '列表', '重新输出', '再给我']
  const isFollowUp = cleanHistory.length > 0
    && (payloadSummary || globalSummaries.length > 0)
    && userMessage.length <= 20
    && !userMessage.match(/采集|抓取|批量获取|爬|下载|打开|访问|点击/)
  const isSimpleDataRequest = (cleanHistory.length > 0
    && (payloadSummary || globalSummaries.length > 0)
    && SIMPLE_REQUEST_PATTERNS.some(p => userMessage.includes(p))
    && !userMessage.match(/采集|抓取|批量获取|爬|下载|打开|访问|点击/))
    || isFollowUp

  if (isSimpleDataRequest) {
    const allData = todoScheduler.globalDataStore.getSummary() ? [todoScheduler.globalDataStore.getSummary()] : []
    const payloadItems = payloadSummary ? payloadSummary.items.map(i => {
      if (i.schema) {
        const schemaStr = Object.entries(i.schema).map(([k, v]) => `${k}:${v}`).join(', ')
        return `  - ${i.id}(${i.toolName}): ${i.count}条 | {${schemaStr}}`
      }
      return `  - ${i.id}(${i.toolName}): ${i.summary}`
    }).join('\n') : ''
    const quickPrompt = `你是AI Browser智能体。用户请求是对已有数据的简单操作或追问，无需页面探索或脚本执行，直接回答即可。

=== 可用工具 ===
finish_task: 输出结果（通过 data_refs 可引用完整数据）

=== 执行要点 ===
1. 下方已有上轮数据摘要（含schema+样例），直接使用即可
2. 处理完成后立即调用finish_task输出结果
3. 如果用户是在追问（如"在哪里呢"、"怎么用"），直接回答问题，无需查数据

=== 上轮数据 ===
${allData.length > 0 ? '全局存储:\n' + allData.join('\n') : ''}${payloadItems ? '\n工具结果:\n' + payloadItems : ''}`
    messages.length = 0
    messages.push({ role: 'system', content: quickPrompt })
    messages.push({ role: 'user', content: userMessage })
    _debugLog('简单请求快速路径', isFollowUp ? '追问模式，直接回答' : '数据操作，跳过页面探索')
  }

  postToUI(tabId, { type: 'agentStart' })
  // 全景对话：清空旧数据
  try { sendEvent('conversationClear', {}) } catch (e) { /* 忽略 */ }
  _debugLog('调试模式已开启', '待办驱动调度系统：全工具可用、待办进度追踪、收敛提示')
  _debugLog('Agent配置', { maxRounds: effectiveMaxRounds, enableJudge, debug })
  _debugLog('系统提示词', systemMsg.content)

  // ===== 主循环开始 =====
  while (aiRequestCount < effectiveMaxRounds) {
    // 检查是否被新任务中止
    const curState = agentStates.get(tabId)
    if (curState?.aborted) {
      console.log('[Agent] 检测到中止信号，退出主循环')
      return
    }
    // Electron 版：通过 isAborted() 检查（替代 checkPortConnected）
    if (isAborted && isAborted()) {
      console.log('[Agent] 任务已中止（isAborted），退出主循环')
      _debugLog('任务中止', { round: aiRequestCount })
      return
    }
    if (Date.now() - startTime > TIMEOUT_MS) {
      postToUI(tabId, { type: 'agentError', error: 'Agent执行超时' })
      await saveToChatHistoryStorage('⚠️ Agent 执行超时，请简化任务后重试。', [])
      return
    }
    if (totalToolCalls >= MAX_TOOL_CALLS) {
      postToUI(tabId, { type: 'agentError', error: '工具调用次数超限，请简化任务重试' })
      await saveToChatHistoryStorage('⚠️ 工具调用次数超限，请简化任务后重试。', [])
      return
    }

    aiRequestCount++

    // ===== 全景对话：记录发送前的 messages 快照 =====
    _requestMessagesSnapshot = messages.map(m => {
      if (m.role === 'tool') return { role: m.role, content: (m.content || '').slice(0, 400) }
      return {
        role: m.role,
        content: typeof m.content === 'string' ? (m.content.length > 800 ? m.content.slice(0, 400) + '\n...(已压缩)' : m.content) : m.content,
        tool_calls: m.tool_calls?.map(tc => ({ name: tc.function?.name, args: tc.function?.arguments })),
      }
    })
    _roundToolResults = []  // 重置本轮工具结果

    // ===== 清理临时消息（_temp标记） =====
    const tempMsgs = messages.filter(m => m._temp)
    if (tempMsgs.length > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]._temp) {
          messages.splice(i, 1)
        }
      }
      _debugLog('清理临时消息', { removed: tempMsgs.length })
    }

    postToUI(tabId, { type: 'agentStatus', text: `思考中... (第${aiRequestCount}轮)` })
    await yieldUI()

    // 收敛提示
    const convergencePrompt = todoScheduler.getConvergencePrompt(aiRequestCount, effectiveMaxRounds)
    if (convergencePrompt) {
      _debugLog('系统收敛提示', convergencePrompt)
      _injections.push(convergencePrompt)
    }

    // 待办进度上下文
    if (todoScheduler.parentTodo) {
      const progressCtx = todoScheduler.getProgressContext()
      if (progressCtx) _injections.push(progressCtx)
    }

    // ===== WorkingMemory 结构化上下文注入 =====
    if (aiRequestCount > 1) {
      const memoryContext = workingMemory.toContext({ includeErrors: true, includePage: false, maxLen: 1200 })
      if (memoryContext) _injections.push(memoryContext)
    }

    // ===== shouldForceFinish 检查 =====
    const forceFinish = todoScheduler.shouldForceFinish()
    if (forceFinish.force) {
      _debugLog('硬性规则触发强制完成', forceFinish)
      _injections.push(`⚠️ 系统检测到${forceFinish.reason}，请立即调用 finish_task 汇报当前已有结果。不要再尝试其他操作。`)
    }

    // 获取当前页面URL
    let currentPageUrl = ''
    try {
      const tab = await getTargetTab(tabManager, tabId)
      if (tab) {
        currentPageUrl = tab.browserView?.webContents?.getURL() || ''
      }
    } catch {}

    postToUI(tabId, { type: 'agentStatus', text: `第${aiRequestCount}轮` })

    // 构建工具列表（全工具可用）
    const tools = buildTools(searchResults, currentPageUrl, aiRequestCount + 1, scriptService, filteredScriptsCache, domainMismatchLogged)

    console.log(`[Agent] 第${aiRequestCount}轮API请求, tools:${tools.length}个, 已搜到${searchResults.length}个脚本`)
    _debugLog(`第${aiRequestCount}轮 工具(${tools.length}个)`, tools.map(t => `  ${t.function.name}`).join('\n'))

    // 系统消息聚合
    const systemNudges = []
    while (_injections.length > 0) systemNudges.push(_injections.shift())
    if (systemNudges.length > 0) {
      messages.push({ role: 'system', content: systemNudges.join('\n'), _temp: true })
    }

    const config = await configService.getAIConfig()
    const auth = await configService.getAppAuth()
    // 优先使用 UI 传入的当前选中模型，避免异步保存时序问题导致用了旧配置
    const effectiveModel = (modelInfo && modelInfo.modelId) ? modelInfo.modelId : config.model
    console.log(`[Agent] LLM请求模型: effectiveModel=${effectiveModel}, modelInfo.modelId=${modelInfo?.modelId}, config.model=${config.model}`)
    const modelTemperature = (modelInfo && typeof modelInfo.temperature === 'number')
      ? modelInfo.temperature
      : (config.temperature ?? 0.3)
    const modelMaxTokens = (modelInfo && modelInfo.maxTokens)
      ? modelInfo.maxTokens
      : (config.maxTokens || 2048)
    const messagesForAI = messages.map(({ _temp, ...rest }) => rest)
    const body = {
      model: effectiveModel, messages: messagesForAI,
      temperature: modelTemperature,
      max_tokens: Math.min(Math.max(modelMaxTokens || 2048, 2048), 32768),
      tools, tool_choice: 'auto',
    }

    _debugLog(`第${aiRequestCount}轮 发送LLM`, JSON.stringify({
      model: effectiveModel, msgs: messages.length,
      lastRole: messages[messages.length - 1]?.role, tools: tools.length,
    }))

    const url = await configService.getAIProxyUrl()

    try {
      const headers = await configService.generateAuthHeaders(auth.appKey, auth.appSecret)
      const MAX_API_RETRIES = 2
      const API_TIMEOUT_MS = 60000
      let res, lastError

      // Electron 主进程持久运行，不需要 Service Worker 心跳

      for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
        try {
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
          const waitNotifyId = setTimeout(() => {
            postToUI(tabId, { type: 'agentStatus', status: 'thinking', text: `思考中... (第${aiRequestCount + 1}轮) - API响应较慢，请耐心等待` })
          }, 15000)
          res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
          clearTimeout(timeoutId)
          clearTimeout(waitNotifyId)
          if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) break
          if (attempt < MAX_API_RETRIES) {
            const waitMs = (attempt + 1) * 1000
            console.warn(`[Agent] API返回 ${res.status}，${waitMs}ms后重试 (${attempt + 1}/${MAX_API_RETRIES})`)
            postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: '等待重试', status: 'waiting' })
            await new Promise(r => setTimeout(r, waitMs))
          }
        } catch (e) {
          lastError = e
          const isTimeout = e.name === 'AbortError'
          if (isTimeout) {
            console.warn(`[Agent] API请求超时(${API_TIMEOUT_MS}ms)，尝试 ${attempt + 1}/${MAX_API_RETRIES + 1}`)
            if (attempt < MAX_API_RETRIES) postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: '请求超时，重试中', status: 'waiting' })
          } else {
            console.warn(`[Agent] API请求异常: ${e.message}，${(attempt + 1) * 1000}ms后重试 (${attempt + 1}/${MAX_API_RETRIES})`)
          }
          if (attempt < MAX_API_RETRIES) await new Promise(r => setTimeout(r, (attempt + 1) * 1000))
        }
      }

      if (!res || !res.ok) {
        let errDetail = ''
        try { const errJson = await res?.json(); errDetail = errJson?.error?.message || errJson?.message || JSON.stringify(errJson).slice(0, 200) } catch {}
        console.error('[Agent] API请求失败:', res?.status, errDetail)
        if ((res?.status === 400 || res?.status === 413) && body.tools) {
          console.warn('[Agent] API返回', res.status, '，尝试不带tools参数重试。原因:', errDetail)
          const fallbackBody = { ...body }
          delete fallbackBody.tools
          delete fallbackBody.tool_choice
          const fbMessages = [...fallbackBody.messages]
          for (let i = fbMessages.length - 1; i >= Math.max(0, fbMessages.length - 3); i--) {
            if (fbMessages[i].content && fbMessages[i].content.length > 800) {
              fbMessages[i] = { ...fbMessages[i], content: fbMessages[i].content.slice(0, 800) + '...(已截断)' }
            }
          }
          fallbackBody.messages = fbMessages
          try {
            const controller2 = new AbortController()
            const timeoutId2 = setTimeout(() => controller2.abort(), API_TIMEOUT_MS)
            const fallbackRes = await fetch(url, { method: 'POST', headers, body: JSON.stringify(fallbackBody), signal: controller2.signal })
            clearTimeout(timeoutId2)
            if (fallbackRes.ok) {
              res = fallbackRes
            } else {
              let fbErr = ''
              try { const fe = await fallbackRes?.json(); fbErr = fe?.error?.message || fe?.message || JSON.stringify(fe).slice(0, 200) } catch {}
              console.error('[Agent] 不带tools重试也失败:', fallbackRes?.status, fbErr)
              postToUI(tabId, { type: 'agentError', error: `AI API错误: ${fallbackRes?.status || '未知'} — ${fbErr || errDetail || '不支持Function Calling或请求过大'}` })
              return
            }
          } catch (e2) {
            postToUI(tabId, { type: 'agentError', error: `AI API错误: ${e2.message}` })
            return
          }
        } else {
          postToUI(tabId, { type: 'agentError', error: `AI API错误: ${res?.status || '网络错误'}${lastError ? ' (' + lastError.message + ')' : ''}` })
          return
        }
      }

      const data = await res.json()
      const choice = data.choices?.[0]
      const msg = choice?.message
      console.log(`[Agent] 第${aiRequestCount}轮响应:`, msg?.tool_calls?.length ? `tool_calls:${msg.tool_calls.length}` : (msg?.content ? `text:${msg.content.slice(0, 80)}` : 'empty'))

      if (!msg) {
        postToUI(tabId, { type: 'agentError', error: 'AI返回为空' })
        return
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        console.log('[Agent] tool_calls:', msg.tool_calls.map(t => t.function.name).join(', '))
        _debugLog(`第${aiRequestCount}轮 LLM响应: tool_calls`, msg.tool_calls.map(t => `${t.function.name}(${JSON.stringify(t.function.arguments || {})})`).join('\n'))
        // 将 AI 思考内容发送到 UI
        if (msg.content && msg.content.trim()) {
          postToUI(tabId, { type: 'agentThinking', content: msg.content.trim() })
        }
        // 收集 round 数据用于后端上传和全景对话
        // 注意：_roundToolResults 会在工具执行后填充，此处先记录基础信息
        const _currentRoundData = {
          round: aiRequestCount,
          request: {
            messages: _requestMessagesSnapshot,
            toolsCount: tools.length,
          },
          response: {
            content: msg.content || '',
            tool_calls: msg.tool_calls.map(tc => ({ name: tc.function.name, args: tc.function.arguments })),
          },
          toolResults: _roundToolResults,
          storedData: payloadStore.entries.filter(e => e.sessionId === sessionId).map(e => ({
            id: e.id, toolName: e.toolName, count: e.metadata?.count || 1, schema: e.metadata?.schema || null,
          })),
        }
        _allRoundsData.push(_currentRoundData)
        // 发送到全景对话窗口
        _sendConversationRound(_currentRoundData)
        messages.push({ role: 'assistant', content: null, tool_calls: msg.tool_calls })
        let shouldTerminateSequence = false

        for (const toolCall of msg.tool_calls) {
          if (shouldTerminateSequence) {
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ skipped: true, reason: '页面已跳转，后续操作被跳过' }) })
            continue
          }
          if (totalToolCalls >= MAX_TOOL_CALLS) {
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ skipped: true, reason: '工具调用次数已达上限' }) })
            continue
          }

          const funcName = toolCall.function.name
          let funcArgs = {}
          try { funcArgs = JSON.parse(toolCall.function.arguments || '{}') } catch {}

          // 工具名称验证
          const allowedToolNames = tools.map(t => t.function.name)
          if (!allowedToolNames.includes(funcName)) {
            const rejectMsg = JSON.stringify({ ok: false, error: `工具 "${funcName}" 不在当前可用工具列表中，调用被拒绝。可用工具：${allowedToolNames.join('、')}。请仅使用列表中的工具。` })
            console.warn(`[Agent] 工具幻觉拦截: ${funcName}`)
            _debugLog('工具幻觉拦截', { rejected: funcName, allowed: allowedToolNames })
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: rejectMsg })
            postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls + 1, toolName: `${funcName}(幻觉拦截)`, result: rejectMsg, done: false })
            continue
          }

          totalToolCalls++
          let _intercepted = false

          postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: funcArgs })
          await yieldUI()

          const _toolStartTime = Date.now()
          let toolResult

          // ============================================================
          // 工具执行分发
          // ============================================================

          if (funcName === 'finish_task') {
            console.log('[Agent] finish_task, summary:', funcArgs.summary, 'data_refs:', funcArgs.data_refs)
            // 标记当前轮次为完成轮
            if (_currentRoundData) _currentRoundData.isFinishRound = true

            // 更新待办进度
            if (todoScheduler.parentTodo) {
              const currentTodo = todoScheduler.getCurrentTodo()
              if (currentTodo && currentTodo.action === 'finish_task') {
                todoScheduler.markTodoResult('done', { summary: funcArgs.summary })
                todoScheduler.recordProgress()
              }
              postToUI(tabId, { type: 'agentTodoUpdate', data: { items: todoScheduler.parentTodo.items || [], progress: todoScheduler.getProgress(), currentTodoIndex: todoScheduler.currentTodoIndex, lastTool: 'finish_task', lastProgress: true } })
            }

            // 处理 data_refs
            let referencedDataContent = ''
            let dataRefIds = normalizeDataRefs(funcArgs.data_refs)
            const reportDataItems = []

            console.log(`[Agent] finish_task data_refs=${JSON.stringify(funcArgs.data_refs)}, payloadStore.entries.length=${payloadStore.entries.length}, entries=[${payloadStore.entries.map(e => e.id).join(',')}]`)

            // 自动补全：如果 AI 没传 data_refs 但 payloadStore 中有数据，自动引用所有存储数据
            if (dataRefIds.length === 0 && payloadStore.entries.length > 0) {
              dataRefIds = payloadStore.entries.map(e => e.id)
              console.log(`[Agent] finish_task 自动补全 data_refs: ${dataRefIds.join(', ')}`)
              _debugLog('finish_task 自动补全 data_refs', { refs: dataRefIds })
            }

            if (dataRefIds.length > 0) {
              _debugLog('finish_task 数据引用', { refs: dataRefIds })
              const storeData = await payloadStore.getDataByIds(dataRefIds)
              console.log(`[Agent] getDataByIds 返回 keys: ${Object.keys(storeData).join(',')}`)
              for (const refId of dataRefIds) {
                const data = storeData[refId]
                const entry = payloadStore.entries.find(e => e.id === refId)
                console.log(`[Agent] refId=${refId}, data存在=${data !== undefined}, entry存在=${!!entry}`)
                if (data !== undefined) {
                  reportDataItems.push({
                    id: refId,
                    toolName: entry?.toolName || 'unknown',
                    data: data,
                    schema: entry?.metadata?.schema || null,
                    count: entry?.metadata?.count || (Array.isArray(data) ? data.length : 1),
                    renderType: entry?.metadata?.renderType || null,
                    templateId: entry?.metadata?.template_id || null,
                    fieldMapping: entry?.metadata?.field_mapping || null,
                    reportTitle: entry?.metadata?.title || null,
                  })
                  const dataPreview = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
                  const MAX_REF_CHARS = 2000
                  const truncated = dataPreview.length > MAX_REF_CHARS
                    ? dataPreview.slice(0, MAX_REF_CHARS) + `\n...(完整数据见下方报告)`
                    : dataPreview
                  referencedDataContent += `\n\n=== 数据 ${refId} (${entry?.toolName || 'unknown'}) ===\n${truncated}`
                }
              }
              if (referencedDataContent) {
                referencedDataContent = '\n\n【引用数据摘要】' + referencedDataContent
              }
            }

            const payloadSummary = payloadStore.getSummaryForFinish()
            if (payloadSummary) {
              const summaryHint = `\n[存储数据汇总] 共${payloadSummary.count}条存储：${payloadSummary.items.map(e => `${e.id}(${e.toolName}:${e.count}条)`).join(', ')}。可在 finish_task 中通过 data_refs 引用完整数据。`
              messages.push({ role: 'system', content: summaryHint })
            }
            const summary = funcArgs.summary || '任务已完成'
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ ok: true, summary }) })

            // 事后自评
            let judgeResult = null
            let finalOutput = summary + referencedDataContent
            if (enableJudge) {
              try {
                judgeResult = await runJudge(configService, userMessage, summary, executedTools)
                if (judgeResult) {
                  const judgeMsg = `\n\n---\n结果评估：${judgeResult.verdict === 'success' ? '✅ 任务完成' : judgeResult.verdict === 'partial' ? '⚠️ 部分完成' : '❌ 可能未完成'}\n${judgeResult.comment || ''}`
                  finalOutput = summary + referencedDataContent + judgeMsg
                }
              } catch (e) { console.warn('[Agent] 事后自评失败（非致命）:', e.message) }
            }

            // 流式输出完整内容
            await streamToUI(sendEvent, finalOutput)

            // 发送结构化数据报告
            console.log(`[Agent] reportDataItems.length=${reportDataItems.length}, 即将发送 agentDataReport 事件`)
            if (reportDataItems.length > 0) {
              try {
                const reportPayload = {
                  type: 'agentDataReport',
                  items: reportDataItems.map(item => {
                    let dataToSend = item.data
                    try {
                      const dataStr = JSON.stringify(item.data)
                      if (dataStr.length > 500000) {
                        const truncated = JSON.parse(dataStr.slice(0, 500000))
                        dataToSend = { _truncated: true, ...truncated }
                      }
                    } catch (e) {
                      console.warn(`[Agent] dataRefs 数据序列化失败 (${item.id}):`, e.message)
                      dataToSend = { _error: '数据序列化失败', preview: String(item.data).slice(0, 200) }
                    }
                    return {
                      id: item.id,
                      toolName: item.toolName,
                      schema: item.schema,
                      count: item.count,
                      renderType: item.renderType,
                      templateId: item.templateId,
                      fieldMapping: item.fieldMapping,
                      reportTitle: item.reportTitle,
                      data: dataToSend,
                    }
                  }),
                }
                postToUI(tabId, reportPayload)
                console.log(`[Agent] agentDataReport 事件已发送，items=${reportPayload.items.length}`)
              } catch (e) {
                console.error('[Agent] agentDataReport 发送失败:', e.message, e.stack)
              }
            }

            // 保存到 chatHistory
            await saveToChatHistoryStorage(finalOutput, executedTools.map(t => ({ name: t.name, result: typeof t.result === 'string' ? t.result : JSON.stringify(t.result || '') })))

            // Feature 4: finish_task 录制
            if (toolRecordingService) {
              try { toolRecordingService.record('finish_task', funcArgs, summary, Date.now() - _toolStartTime) } catch {}
            }

            // Output 持久化
            _taskId = outputService.generateTaskId()
            const endTime = Date.now()
            const output = {
              taskId: _taskId,
              sessionId: sessionId,
              userMessage: userMessage,
              startTime: _startTime,
              endTime: endTime,
              durationMs: endTime - _startTime,
              status: judgeResult?.verdict || 'unknown',
              summary: summary,
              workingMemoryState: workingMemory.state,
              dataOutputs: payloadStore.entries.map(e => ({
                id: e.id,
                toolName: e.toolName,
                summary: e.summary,
                count: e.metadata?.count || 1,
              })),
              judgeResult: judgeResult || null,
            }
            try {
              await outputService.save(output)
            } catch (e) {
              console.warn('[OutputService] 保存失败（非致命）:', e.message)
            }

            // 全景对话：发送任务完成事件
            try { sendEvent('conversationTaskDone', { taskId: _taskId, summary }) } catch (e) { /* 忽略 */ }

            // 上传对话归档到后端
            try {
              await uploadConversationArchive(configService, {
                taskId: _taskId,
                sessionId,
                userMessage,
                model: effectiveModel,
                totalRounds: aiRequestCount,
                totalToolCalls: totalToolCalls,
                status: judgeResult?.verdict || 'unknown',
                durationMs: endTime - _startTime,
                summary,
                rounds: _allRoundsData,
              })
              console.log(`[ConversationArchive] 已上传至后端: taskId=${_taskId}`)
            } catch (e) {
              console.warn('[ConversationArchive] 上传失败（非致命）:', e.message)
            }

            // 任务完成后发送待办清除事件
            setTimeout(() => {
              try {
                sendEvent('agentTodoClear', {})
              } catch {}
            }, 2000)

            return
          } else if (funcName === 'capture_network') {
            // Electron 版暂不支持网络捕获
            toolResult = JSON.stringify({ ok: false, error: '网络捕获功能在 Electron 版暂不可用' })
          } else if (funcName === 'search_tools') {
            hasSearchedTools = true
            const query = funcArgs.query || userMessage
            postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: 'search_tools', toolArgs: { query }, status: 'searching' })
            const newResults = await toolService.searchScripts(query)
            const existingIds = new Set(searchResults.map(s => s.id))
            for (const r of newResults) { if (!existingIds.has(r.id)) { searchResults.push(r); existingIds.add(r.id) } }
            if (newResults.length === 0) {
              const noResultHint = `未找到与"${query}"匹配的专用脚本。你可以用本地DOM工具直接在页面上操作，或尝试搜索其他关键词。`
              toolResult = JSON.stringify({ ok: true, result: noResultHint })
            } else {
              toolResult = JSON.stringify(newResults.slice(0, 5).map(t => ({ id: t.id, name: t.name, description: t.description, toolType: t.toolType, toolConfig: t.toolConfig ? '已配置' : '未配置' })))
            }
            executedTools.push({ name: 'search_tools', result: { ok: newResults.length > 0, count: newResults.length } })
            postToUI(tabId, { type: 'agentSearchResult', results: newResults.slice(0, 5) })
          } else if (funcName === 'create_todo') {
            let itemsArg = funcArgs.items || []
            if (typeof itemsArg === 'string') { try { const parsed = JSON.parse(itemsArg.trim()); if (Array.isArray(parsed)) itemsArg = parsed } catch {} }

            const availableScriptIds = new Set(searchResults.map(s => `inject_script_${s.id}`))
            const scriptIdErrors = []
            if (Array.isArray(itemsArg)) {
              for (const item of itemsArg) {
                if (item.action && item.action.startsWith('inject_script_')) {
                  if (!availableScriptIds.has(item.action)) {
                    const available = [...availableScriptIds].join(', ') || '（请先调用 search_tools 搜索）'
                    scriptIdErrors.push(`待办 ${item.id || '?'} 的 action "${item.action}" 对应的脚本不存在。当前可用脚本: ${available}`)
                  }
                }
              }
            }
            if (scriptIdErrors.length > 0) {
              toolResult = JSON.stringify({ ok: false, error: `待办列表校验失败：\n${scriptIdErrors.join('\n')}\n请使用 search_tools 查询到的脚本ID，勿编造不存在的脚本。` })
              _debugLog('脚本ID不存在', scriptIdErrors)
            } else {
              const submitResult = todoScheduler.submitTodo(itemsArg)
              if (submitResult.ok) {
                const progress = todoScheduler.getProgress()
                toolResult = JSON.stringify({ ok: true, result: `待办列表已创建并通过校验：共${progress.total}个待办。系统将按待办顺序驱动执行，自动跟踪进度。当前待办: ${todoScheduler.getCurrentTodo()?.id || '无'} - ${todoScheduler.getCurrentTodo()?.description || ''}` })
                _debugLog('待办列表已创建', { total: progress.total, currentTodoIndex: todoScheduler.currentTodoIndex })
              } else {
                const errors = submitResult.errors || [submitResult.error || '校验失败']
                toolResult = JSON.stringify({ ok: false, error: `待办列表校验失败：\n${errors.join('\n')}\n请修正后重新提交。` })
                _debugLog('待办校验失败', errors)
              }
            }
            const isCreateTodoOk = !scriptIdErrors.length && todoScheduler.parentTodo
            executedTools.push({ name: 'create_todo', result: { ok: isCreateTodoOk, total: todoScheduler.totalTodos || 0 } })
            postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: 'create_todo', result: toolResult, done: false })
            if (isCreateTodoOk) {
              postToUI(tabId, { type: 'agentTodoUpdate', data: { items: todoScheduler.parentTodo?.items || [], progress: todoScheduler.getProgress(), currentTodoIndex: todoScheduler.currentTodoIndex } })
            }
          } else if (funcName === 'read_page_content') {
            const targetTab = await getTargetTab(tabManager, tabId)
            if (!targetTab) {
              toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用' })
            } else {
              const pageUrl = targetTab.browserView?.webContents?.getURL() || ''
              const cachedRead = pageReadCache.get(pageUrl)
              if (cachedRead) {
                console.log('[Agent] read_page_content 命中缓存:', pageUrl)
                toolResult = cachedRead
              } else {
                let pageData = null
                try { pageData = await extractPageContent(targetTab.browserView) } catch {}
                if (!pageData) {
                  toolResult = JSON.stringify({ ok: false, error: '无法读取页面内容。' })
                } else {
                  toolResult = JSON.stringify({ ok: true, title: pageData.title || '', url: pageData.url || '', content: (pageData.content || '').slice(0, 3000) })
                  pageReadCache.set(pageUrl, toolResult)
                }
              }
            }
          } else if (funcName.startsWith('inject_script_')) {
            const scriptId = parseInt(funcName.replace('inject_script_', ''))
            if (!scriptId || isNaN(scriptId)) {
              toolResult = JSON.stringify({ ok: false, error: '无效的脚本ID' })
            } else {
              const tool = searchResults.find(t => t.id === scriptId) || { id: scriptId, name: '脚本#' + scriptId, toolType: 'js', toolConfig: {}, metadata: {}, precheck: '' }
              const targetTab = await getTargetTab(tabManager, tabId)
              if (!targetTab) {
                toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用' })
                executedTools.push({ name: `${funcName}(标签页不可用)`, result: toolResult })
                postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, success: false, done: false })
                messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
                continue
              }
              // precheck
              if (tool.precheck && tool.precheck.trim()) {
                postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: { check: 'precheck' }, status: 'running' })
                try {
                  const precheckCode = `(function(code) { try { const fn = new Function(code); const r = fn(); return { ok: true, result: r } } catch (e) { return { ok: false, error: e.message } } })(${JSON.stringify(tool.precheck)})`
                  const pr = await targetTab.browserView.webContents.executeJavaScript(precheckCode)
                  if (pr && !pr.ok && pr.result?.ok === false) {
                    const precheckReason = pr.result.reason || pr.result.error || '未知原因'
                    toolResult = JSON.stringify({ ok: false, error: `前置检查失败: ${precheckReason}` })
                    executedTools.push({ name: `${funcName}(precheck失败)`, result: toolResult })
                    recordMemory(configService, scriptId, false, 0, `前置检查失败: ${precheckReason}`, '').catch(() => {})
                    postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, success: false, done: false })
                    messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
                    continue
                  }
                } catch (e) {
                  if (e.message?.includes('Cannot access a chrome:// URL') || e.message?.includes('Cannot access contents of url')) {
                    toolResult = JSON.stringify({ ok: false, error: '当前页面为系统页面，无法执行脚本。' })
                    executedTools.push({ name: `${funcName}(系统页面)`, result: toolResult })
                    postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
                    messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
                    continue
                  }
                  console.warn('[Agent] precheck 执行异常，继续执行:', e.message)
                }
              }
              postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: { scriptId, scriptName: tool.name }, status: 'running' })
              const execStart = Date.now()
              // Electron 版：toolService.executeTool 需要适配 BrowserView
              // 传入 tabId，toolService 内部通过 tabManager 获取 BrowserView
              const execResult = await toolService.executeTool(tool, tabId, funcArgs)
              const execDuration = Date.now() - execStart
              toolResult = JSON.stringify(execResult)
              if (execResult?.ok && (tool.toolType === 'api' || tool.toolConfig?.apiEndpoint)) {
                _injections.push(`脚本 ${tool.name} 已成功执行并返回完整结果，可直接基于这些数据继续后续步骤或 finish_task，无需再用其他工具重复获取。`)
              }
              executedTools.push({ name: tool.name || funcName, result: execResult })
              const memOk = execResult?.ok === true
              let memSummary = ''
              const innerResult = execResult?.result
              if (typeof innerResult === 'string') memSummary = innerResult.slice(0, 200)
              else if (innerResult && typeof innerResult === 'object') {
                if (Array.isArray(innerResult.data)) { memSummary = `${innerResult.data.length}条数据`; if (innerResult.total !== undefined) memSummary += ` (共${innerResult.total})`; memSummary = memSummary.slice(0, 200) }
                else if (Array.isArray(innerResult)) memSummary = `${innerResult.length}条结果`
                else memSummary = JSON.stringify(innerResult).slice(0, 200)
              }
              recordMemory(configService, scriptId, memOk, execDuration, memOk ? '' : (execResult?.error || ''), memSummary).catch(() => {})
            }
          } else if (funcName === 'fetch_url') {
            const fetchUrl = typeof funcArgs.url === 'string' ? funcArgs.url : ''
            if (!fetchUrl) {
              toolResult = JSON.stringify({ ok: false, error: 'url 参数不能为空' })
              executedTools.push({ name: `${funcName}(空url)`, result: toolResult })
              postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
              messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
              continue
            }
            postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: { url: fetchUrl, method: funcArgs.method || 'GET' }, status: 'running' })
            try {
              const fetchOpts = {
                method: funcArgs.method || 'GET',
                headers: funcArgs.headers || {},
              }
              if (funcArgs.body && ['POST', 'PUT', 'PATCH'].includes(fetchOpts.method.toUpperCase())) {
                fetchOpts.body = funcArgs.body
              }
              // Electron 主进程可直接跨域 fetch，无需 CORS 豁免
              const resp = await fetchWithTimeout(fetchUrl, fetchOpts, 30000)
              if (!resp.ok) {
                toolResult = JSON.stringify({ ok: false, error: `HTTP ${resp.status}: ${resp.statusText}` })
              } else {
                const returnMode = funcArgs.return_mode || 'text'
                if (returnMode === 'json') {
                  const jsonData = await resp.json()
                  toolResult = JSON.stringify({ ok: true, result: jsonData })
                } else {
                  const text = await resp.text()
                  toolResult = JSON.stringify({ ok: true, result: text, _contentType: resp.headers.get('content-type') || '' })
                }
              }
            } catch (e) {
              toolResult = JSON.stringify({ ok: false, error: `fetch 失败: ${e.message}` })
            }
            executedTools.push({ name: funcName, result: toolResult })
          } else if (funcName === 'generate_script') {
            // 动态代码执行：把 data_refs 全量数据注入 window.__store，执行 code，返回 {ok, result}
            const targetTab = await getTargetTab(tabManager, tabId)
            if (!targetTab) {
              toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用' })
              executedTools.push({ name: `${funcName}(标签页不可用)`, result: toolResult })
              postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
              messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
              continue
            }
            const code = typeof funcArgs.code === 'string' ? funcArgs.code : ''
            const dataRefIds = normalizeDataRefs(funcArgs.data_refs)
            if (!code.trim()) {
              toolResult = JSON.stringify({ ok: false, error: 'code 参数不能为空' })
              executedTools.push({ name: `${funcName}(空代码)`, result: toolResult })
              postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
              messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
              continue
            }
            postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: { description: funcArgs.description || '', data_refs: dataRefIds }, status: 'running' })
            try {
              // 读取 data_refs 对应的全量数据
              let storeData = {}
              if (dataRefIds.length > 0) {
                storeData = await payloadStore.getDataByIds(dataRefIds)
                const missing = dataRefIds.filter(id => storeData[id] === undefined)
                if (missing.length > 0) {
                  toolResult = JSON.stringify({ ok: false, error: `引用的数据不存在: ${missing.join(', ')}` })
                  executedTools.push({ name: `${funcName}(引用缺失)`, result: toolResult })
                  postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
                  messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
                  continue
                }
              }
              // 在页面中注入 window.__store 并执行 code
              // Electron 的 executeJavaScript 默认在 MAIN world 执行，无需额外指定
              // 使用 AsyncFunction 构造器：让 AI 代码顶层可直接 await
              const generateScriptCode = `(async (storeObj, userCode) => {
                try {
                  window.__store = window.__store || {};
                  if (storeObj && typeof storeObj === 'object') {
                    for (const k of Object.keys(storeObj)) window.__store[k] = storeObj[k];
                  }
                  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
                  const fn = new AsyncFunction(userCode);
                  const r = await fn();
                  if (r === undefined || r === null) {
                    return { ok: false, error: '代码未返回结果，请确保使用 return 语句返回数据' };
                  }
                  if ((typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 0)
                      || (Array.isArray(r) && r.length === 0)
                      || (typeof r === 'string' && r.length === 0)) {
                    return { ok: false, error: '代码返回了空数据，请检查逻辑' };
                  }
                  return { ok: true, result: r };
                } catch (e) {
                  return { ok: false, error: e.message };
                }
              })(${JSON.stringify(storeData)}, ${JSON.stringify(code)})`

              const r = await targetTab.browserView.webContents.executeJavaScript(generateScriptCode)
              if (r && r.ok) {
                toolResult = JSON.stringify({ ok: true, result: r.result })
              } else {
                const errMsg = r?.error || '代码执行失败'
                const hint = errMsg.includes('Content Security Policy') || errMsg.includes('unsafe-eval')
                  ? ' [建议：改用 inject_script_N（search_tools 查找）或 DOM 工具组合完成]'
                  : ''
                toolResult = JSON.stringify({ ok: false, error: errMsg + hint })
              }
            } catch (e) {
              if (e.message?.includes('Cannot access a chrome:// URL') || e.message?.includes('Cannot access contents of url')) {
                toolResult = JSON.stringify({ ok: false, error: '当前页面为系统页面，无法执行脚本。' })
              } else {
                toolResult = JSON.stringify({ ok: false, error: `执行失败: ${e.message}` })
              }
            }
            executedTools.push({ name: funcName, result: toolResult })
          } else if (funcName === 'screenshot_visible') {
            toolResult = await (async () => {
              try {
                const targetTab = await getTargetTab(tabManager, tabId)
                if (!targetTab) return JSON.stringify({ ok: false, error: '目标标签页不可用' })
                postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, status: 'running' })
                // Electron 版：使用 webContents.capturePage() 替代 chrome.tabs.captureVisibleTab()
                const image = await targetTab.browserView.webContents.capturePage()
                const dataUrl = image.toDataURL({ format: 'jpeg', quality: 60 })
                const sizeKB = Math.round(dataUrl.length / 1024)
                return JSON.stringify({ ok: true, result: `截图已获取 (${sizeKB}KB, JPEG)`, _hasScreenshot: true, _dataUrl: dataUrl })
              } catch (e) { return JSON.stringify({ ok: false, error: `截图失败: ${e.message}` }) }
            })()
            executedTools.push({ name: funcName, result: toolResult })
          } else if (funcName === 'render_report') {
            postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: funcArgs, status: 'running' })
            toolResult = JSON.stringify({ ok: true, _pending: true, message: 'render_report 数据处理中...' })
            executedTools.push({ name: funcName, result: toolResult })
          } else if (['extract_content','click_element','fill_input','wait_for_element','save_as_file','navigate_to','go_back','find_text_on_page','get_element_info','scroll_page','hover_element','select_dropdown','press_key','go_forward','get_interactive_elements','detect_page_template'].includes(funcName)) {
            // ===== DOM 工具执行（17个） =====
            const selectorTools = ['extract_content', 'get_element_info', 'find_text_on_page']
            if (selectorTools.includes(funcName) && funcArgs.selector) {
              const comboKey = `${funcArgs.selector}|${funcName}`
              if (_usedSelectorToolCombo.has(comboKey)) {
                _injections.push(`💡 提示：已用 ${funcName} 提取过选择器 "${funcArgs.selector}" 的数据，重复提取可能浪费时间。建议推进下一步操作或调用finish_task，但你可以自主决定。`)
              }
              _usedSelectorToolCombo.add(comboKey)
            }

            if (funcName === 'navigate_to' && !domainPolicy.isUrlAllowed(funcArgs.url)) {
              toolResult = JSON.stringify({ ok: false, error: `导航被安全策略阻止：${funcArgs.url} 不在允许的域名范围内。` })
              executedTools.push({ name: `${funcName}(域名被拦截)`, result: toolResult })
              postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })
              messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult })
              _intercepted = true
            } else if (funcName === 'navigate_to' && aiRequestCount / effectiveMaxRounds >= 0.85) {
              _debugLog('预算提示: navigate_to接近预算上限', { round: aiRequestCount, maxRounds: effectiveMaxRounds })
              _injections.push(`💡 提示：已使用${Math.round(aiRequestCount / effectiveMaxRounds * 100)}%预算，导航新页面可能消耗较多轮次。请评估剩余轮次能否完成，如不能请调用finish_task汇总已有结果。`)
              const targetTab = await getTargetTab(tabManager, tabId)
              if (!targetTab) { toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用' }) }
              else {
                postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: funcArgs, status: 'running' })
                const domResult = await executeDOMToolWithTimeout(targetTab.browserView, funcName, funcArgs, ACTION_TIMEOUT_MS)
                toolResult = JSON.stringify(domResult)
                executedTools.push({ name: funcName, result: domResult })
              }
            } else {
              const targetTab = await getTargetTab(tabManager, tabId)
              if (!targetTab) { toolResult = JSON.stringify({ ok: false, error: '目标标签页不可用' }) }
              else {
                postToUI(tabId, { type: 'agentStep', step: totalToolCalls, toolName: funcName, toolArgs: funcArgs, status: 'running' })
                const domResult = await executeDOMToolWithTimeout(targetTab.browserView, funcName, funcArgs, ACTION_TIMEOUT_MS)
                toolResult = JSON.stringify(domResult)
                executedTools.push({ name: funcName, result: domResult })
              }
            }
            // 导航类工具成功后终止后续工具调用序列（避免在已跳转的页面上继续操作）
            if (['navigate_to', 'go_back', 'go_forward'].includes(funcName) && !toolResult.includes('域名被拦截') && !toolResult.includes('"ok":false')) {
              shouldTerminateSequence = true
            }
          } else {
            toolResult = JSON.stringify({ ok: false, error: `未知工具: ${funcName}` })
          }

          if (_intercepted) continue
          _debugLog(`工具结果: ${funcName}`, toolResult || '')

          // ===== WorkingMemory 自动提取 =====
          workingMemory.autoExtractFromToolResult(funcName, funcArgs, toolResult, aiRequestCount)

          // ===== 待办调度：匹配工具调用到当前待办 =====
          const matchedTodo = todoScheduler.matchToolCall(funcName)
          let hasProgress = false
          try {
            const parsed = JSON.parse(toolResult)
            if (parsed?.ok === false) {
              hasProgress = false
              if (matchedTodo) todoScheduler.markTodoResult('failed')
            } else if (funcName === 'search_tools') {
              const results = Array.isArray(parsed) ? parsed : parsed?.result
              hasProgress = Array.isArray(results) && results.length > 0
              if (matchedTodo && hasProgress) todoScheduler.markTodoResult('done', parsed)
              else if (matchedTodo) todoScheduler.markTodoResult('failed')
            } else if (funcName === 'create_todo') {
              hasProgress = parsed?.ok === true
              if (hasProgress && matchedTodo) todoScheduler.markTodoResult('done', parsed)
            } else if (parsed?.ok === true || parsed?.ok === undefined) {
              const hasContent = parsed?.result !== undefined && String(parsed.result).length > 0 || parsed?.content !== undefined && String(parsed.content).length > 0 || parsed?.title !== undefined
              hasProgress = hasContent && !parsed?.error
              if (matchedTodo && hasProgress) todoScheduler.markTodoResult('done', parsed)
              else if (!matchedTodo && hasProgress && parsed) todoScheduler.globalDataStore.set(funcName, parsed)
            }
          } catch {}

          // ===== 进度记录 =====
          if (hasProgress) {
            const isNonProgressTool = (funcName === 'read_page_content' || funcName === 'scroll_page') && !matchedTodo
            if (!isNonProgressTool) {
              todoScheduler.recordProgress()
            }
          } else {
            todoScheduler.recordNoProgress(funcName)
          }

          // 发送待办进度更新
          if (todoScheduler.parentTodo) {
            postToUI(tabId, { type: 'agentTodoUpdate', data: { items: todoScheduler.parentTodo.items || [], progress: todoScheduler.getProgress(), currentTodoIndex: todoScheduler.currentTodoIndex, lastTool: funcName, lastProgress: hasProgress } })
          }

          postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls, toolName: funcName, result: toolResult, done: false })

          // Feature 4: 工具调用录制
          if (toolRecordingService) {
            try {
              toolRecordingService.record(funcName, funcArgs, toolResult, Date.now() - _toolStartTime)
            } catch (e) {
              console.warn('[ToolRecording] record 失败（非致命）:', e.message)
            }
          }

          // ===== 工具结果处理：标准化信封 + 存储 =====
          let finalResult
          const returnMode = funcArgs.return_mode || 'summary'
          const dataTools = ['extract_content', 'get_interactive_elements', 'get_element_info']

          if (dataTools.includes(funcName) && returnMode === 'full') {
            const envelope = normalizePayload(toolResult, funcName)
            const storeId = await payloadStore.add(funcName, envelope.items, formatSchemaSummary('?', funcName, envelope),
              { count: envelope.count, schema: envelope.schema, sample: envelope.sample })
            if (storeId === null) {
              finalResult = JSON.stringify({ ok: false, error: '数据存储失败（可能超过配额），请尝试缩小采集范围后重试' })
              console.warn(`[Agent] ${funcName} return_mode=full 存储失败`)
            } else {
              const summaryText = formatSchemaSummary(storeId, funcName, envelope)
              const typeHint = envelope.items.length > 1
                ? `共${envelope.items.length}条数据，schema 见上方`
                : envelope.items.length === 1 ? `共1条数据` : `数据为空`
              finalResult = `${summaryText}\n完整数据已存储(ID:${storeId})，可在 finish_task 中通过 data_refs=["${storeId}"] 引用。${typeHint}。`
              console.log(`[Agent] ${funcName} return_mode=full，存储全量数据，返回schema摘要（存储ID:${storeId}）`)
              workingMemory.addDataRef(funcName, storeId, envelope.count, summaryText)
            }
          } else if (dataTools.includes(funcName) && returnMode === 'summary') {
            const envelope = normalizePayload(toolResult, funcName)
            const storeId = await payloadStore.add(funcName, envelope.items, formatSchemaSummary('?', funcName, envelope),
              { count: envelope.count, schema: envelope.schema, sample: envelope.sample })
            if (storeId === null) {
              finalResult = JSON.stringify({ ok: false, error: '数据存储失败（可能超过配额），请尝试缩小采集范围后重试' })
              console.warn(`[Agent] ${funcName} return_mode=summary 存储失败`)
            } else {
              const summaryText = formatSchemaSummary(storeId, funcName, envelope)
              const overview = buildDataOverview(toolResult, funcName)
              overview._stored = storeId
              overview._schemaHint = summaryText
              finalResult = JSON.stringify(overview)
              console.log(`[Agent] ${funcName} return_mode=summary，返回概览（存储ID:${storeId}）`)
              const count = overview._overview?.content_count || overview._overview?.total || 1
              workingMemory.addDataRef(funcName, storeId, count, summaryText)
            }
          } else if (funcName === 'generate_script' && toolResult.includes('"ok":true')) {
            // generate_script 专用存储：直接存 result（AI return 的原始值）
            try {
              const parsed = JSON.parse(toolResult)
              const actualData = parsed.result
              const dataStr = JSON.stringify(actualData)
              if (dataStr.length > 1500) {
                const isHtmlReport = typeof actualData === 'string'
                  && /^\s*<(?:!doctype\s+html|html|head|body|style|script|div|section|article|main|table|ul|ol|h[1-6]|p|header|footer|nav|figure|form)\b/i.test(actualData)
                const metadata = isHtmlReport
                  ? { renderType: 'html', count: 1 }
                  : { count: Array.isArray(actualData) ? actualData.length : 1 }
                const storeId = await payloadStore.add('generate_script', actualData,
                  `generate_script: ${funcArgs.description || ''}`.slice(0, 100),
                  metadata)
                if (storeId === null) {
                  finalResult = JSON.stringify({ ok: false, error: '数据存储失败（可能超过配额），请尝试缩小数据量后重试' })
                  console.warn('[Agent] generate_script 存储失败')
                } else {
                  let typeHint
                  if (isHtmlReport) {
                    typeHint = `HTML 报告字符串（长度 ${actualData.length}），sidepanel 将用 iframe 渲染`
                  } else if (Array.isArray(actualData)) {
                    typeHint = actualData.length > 0
                      ? `window.__store.${storeId} 是数组（长度${actualData.length}），可直接 .filter()/.map()/.forEach() 遍历`
                      : `window.__store.${storeId} 是空数组`
                  } else if (actualData && typeof actualData === 'object') {
                    const keys = Object.keys(actualData).slice(0, 8)
                    typeHint = `window.__store.${storeId} 是对象，字段: ${keys.join(', ')}（访问用 window.__store.${storeId}.字段名）`
                  } else {
                    typeHint = `window.__store.${storeId} 是 ${typeof actualData}: ${String(actualData).slice(0, 50)}`
                  }
                  const preview = dataStr.slice(0, 200)
                  finalResult = `generate_script 已执行。返回值预览: ${preview}${dataStr.length > 200 ? '...' : ''}\n完整数据已存储(ID:${storeId})，使用 generate_script(data_refs=["${storeId}"]) 操作。${typeHint}。`
                  workingMemory.addDataRef('generate_script', storeId,
                    Array.isArray(actualData) ? actualData.length : 1, finalResult)
                  console.log(`[Agent] generate_script 存储原始返回值（ID:${storeId}），数据类型: ${isHtmlReport ? 'HTML报告' : (Array.isArray(actualData) ? `数组(${actualData.length}条)` : typeof actualData)}`)
                }
              } else {
                finalResult = toolResult
              }
            } catch (e) {
              console.warn('[Agent] generate_script 存储异常:', e.message)
              finalResult = toolResult
            }
          } else if (funcName === 'render_report') {
            // render_report：用预设模板渲染数据报告
            try {
              const refIds = normalizeDataRefs(funcArgs.data_refs)
              if (refIds.length === 0) {
                finalResult = JSON.stringify({ ok: false, error: 'data_refs 不能为空' })
              } else {
                const storeData = await payloadStore.getDataByIds(refIds)
                let combinedData = []
                for (const refId of refIds) {
                  const d = storeData[refId]
                  if (Array.isArray(d)) {
                    combinedData = combinedData.concat(d)
                  } else if (d !== undefined && d !== null) {
                    combinedData.push(d)
                  }
                }
                const templateId = funcArgs.template_id
                const fieldMapping = funcArgs.field_mapping || null
                const reportTitle = funcArgs.title || ''
                const storeId = await payloadStore.add('render_report', combinedData,
                  `render_report: ${templateId}`.slice(0, 100),
                  {
                    renderType: 'template',
                    template_id: templateId,
                    field_mapping: fieldMapping,
                    title: reportTitle,
                    count: combinedData.length,
                  })
                if (storeId === null) {
                  finalResult = JSON.stringify({ ok: false, error: '数据存储失败（可能超过配额）' })
                } else {
                  finalResult = JSON.stringify({
                    ok: true,
                    storeId,
                    template: templateId,
                    count: combinedData.length,
                    message: `报告已准备（模板:${templateId}，数据:${combinedData.length}条）。finish_task 时通过 data_refs=["${storeId}"] 引用即可显示`,
                  })
                  workingMemory.addDataRef('render_report', storeId, combinedData.length, `模板报告: ${templateId}`)
                  console.log(`[Agent] render_report 存储渲染请求（ID:${storeId}，模板:${templateId}，数据:${combinedData.length}条）`)
                }
              }
            } catch (e) {
              console.warn('[Agent] render_report 处理异常:', e.message)
              finalResult = JSON.stringify({ ok: false, error: e.message })
            }
          } else if (shouldStoreToPayload(toolResult, funcName)) {
            const envelope = normalizePayload(toolResult, funcName)
            finalResult = await storeToPayload(payloadStore, envelope.items, funcName, envelope)
            const storeId = payloadStore.entries[payloadStore.entries.length - 1]?.id
            console.log('[Agent] payloadStore 存储:', funcName, '→ ID:', storeId)
            if (storeId) {
              const summaryText = formatSchemaSummary(storeId, funcName, envelope)
              workingMemory.addDataRef(funcName, storeId, envelope.count, summaryText)
            }
          } else {
            finalResult = smartTruncateResult(toolResult)
          }

          // ===== 全景对话：收集工具执行结果 =====
          _roundToolResults.push({
            toolName: funcName,
            args: funcArgs,
            result: (toolResult || '').slice(0, 500),
            finalResult: (finalResult || '').slice(0, 500),
            ok: !toolResult?.includes('error') && !toolResult?.includes('skipped'),
          })

          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: finalResult })

          // ===== 选择器反馈上报 =====
          try {
            const usedSelector = funcArgs.selector || funcArgs.selectorHint || null
            if (usedSelector && typeof usedSelector === 'string' && usedSelector.length > 0 && autoPageContent?.url) {
              const host = _extractHost(autoPageContent.url)
              if (host) {
                let itemCount = 0
                let isFailure = false
                try {
                  const parsed = JSON.parse(toolResult)
                  if (parsed?.ok === false) {
                    isFailure = true
                  } else if (parsed?.result) {
                    if (Array.isArray(parsed.result)) {
                      itemCount = parsed.result.length
                    } else if (parsed.result.elements && Array.isArray(parsed.result.elements)) {
                      itemCount = parsed.result.elements.length
                    } else if (parsed.result.items && Array.isArray(parsed.result.items)) {
                      itemCount = parsed.result.items.length
                    } else if (parsed.result.total) {
                      itemCount = Number(parsed.result.total) || 0
                    } else if (parsed.result.count) {
                      itemCount = Number(parsed.result.count) || 0
                    }
                    if (itemCount === 0) isFailure = true
                  }
                } catch {}
                reportSelectorFeedback(configService, {
                  host,
                  selector: usedSelector,
                  toolName: funcName,
                  taskId: _taskId,
                  resultStatus: isFailure ? 'failure' : 'success',
                  itemCount,
                })
              }
            }
          } catch (e) {
            // 上报失败不影响主流程
          }

          await new Promise(r => setTimeout(r, 200))
        }

        // ===== Scratchpad 持久化 =====
        try {
          await scratchpadService.save(sessionId, workingMemory.state, {
            round: aiRequestCount,
            todoIndex: todoScheduler.currentTodoIndex,
          })
        } catch (e) {
          console.warn('[ScratchpadService] 保存失败（非致命）:', e.message)
        }

        // ===== 消息上下文压缩（基于 token 估算，动态适配模型 context window） =====
        const estimateContextChars = (msgs) => {
          let total = 0
          for (const m of msgs) {
            if (typeof m.content === 'string') total += m.content.length
            if (Array.isArray(m.tool_calls)) {
              for (const tc of m.tool_calls) {
                total += (tc.function?.arguments || '').length
              }
            }
          }
          return total
        }

        const modelContextTokens = (modelInfo && modelInfo.contextWindow) || 32000
        const RESERVED_TOKENS = 8000
        const SAFETY_RATIO = 0.85
        const availableTokens = Math.max(8000, Math.floor(modelContextTokens * SAFETY_RATIO) - RESERVED_TOKENS)
        const MAX_CONTEXT_CHARS = Math.floor(availableTokens * 3.5)
        const COMPRESS_KEEP_RATIO = 0.6

        const currentChars = estimateContextChars(messages)
        if (currentChars > MAX_CONTEXT_CHARS) {
          const targetChars = Math.floor(MAX_CONTEXT_CHARS * COMPRESS_KEEP_RATIO)
          let keepRecent = 0
          let keptChars = 0
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i]
            const mChars = (typeof m.content === 'string' ? m.content.length : 0)
              + (Array.isArray(m.tool_calls) ? m.tool_calls.reduce((s, tc) => s + (tc.function?.arguments || '').length, 0) : 0)
            if (keptChars + mChars > targetChars && keepRecent >= 12) break
            keptChars += mChars
            keepRecent++
          }
          while (keepRecent < messages.length) {
            const idx = messages.length - keepRecent - 1
            if (idx < 0) break
            if (messages[idx].role === 'assistant' && messages[idx].tool_calls) break
            keepRecent++
          }
          let cutOff = messages.length - keepRecent
          if (cutOff > 1) {
            while (cutOff < messages.length && messages[cutOff]?.role === 'tool') cutOff++
          }
          if (cutOff > 1) {
            console.log(`[Agent] 上下文压缩: ${currentChars}字符 > ${MAX_CONTEXT_CHARS}字符(modelCtx=${modelContextTokens}t), 保留近${keepRecent}条(${keptChars}字符), 压缩前${cutOff - 1}条`)
            const summaryMsg = await contextCompressor.compress(messages, cutOff, userMessage, workingMemory)
            if (summaryMsg) {
              messages.splice(1, cutOff - 1, summaryMsg)
            }
          }
          // 移除孤立 tool 消息
          const validToolCallIds = new Set()
          for (const m of messages) { if (m.role === 'assistant' && m.tool_calls) { for (const tc of m.tool_calls) validToolCallIds.add(tc.id) } }
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'tool' && !validToolCallIds.has(messages[i].tool_call_id)) {
              console.warn('[Agent] 移除孤立tool消息:', messages[i].tool_call_id)
              messages.splice(i, 1)
            }
          }
        }
      } else {
        // ===== 纯文本回复 =====
        console.log('[Agent] 纯文本回复（无tool_calls）:', (msg.content || '').slice(0, 80))
        const content = msg.content || ''

        // 全景对话：发送纯文本轮次数据
        const _textRoundData = {
          round: aiRequestCount,
          request: { messages: _requestMessagesSnapshot, toolsCount: tools.length },
          response: { content: content || '' },
          toolResults: [],
          storedData: payloadStore.entries.filter(e => e.sessionId === sessionId).map(e => ({
            id: e.id, toolName: e.toolName, count: e.metadata?.count || 1, schema: e.metadata?.schema || null,
          })),
          isTextOnlyRound: true,
        }
        _sendConversationRound(_textRoundData)

        // 检测：AI 输出了类工具调用文本但未走标准 tool_calls
        const looksLikeToolCall = /<function\s*=\s*[\w_]+|<parameter\s*=\s*\w+>|call\s+function[:：]\s*\w+/i.test(content)
        if (looksLikeToolCall) {
          console.warn('[Agent] 检测到 AI 用文本格式输出工具调用，注入纠正提示')
          _injections.push(`⚠️ 你上一轮的输出被识别为纯文本，工具调用未执行。请使用标准 tool_calls JSON 格式重新调用工具（不要用 <function=xxx> 标签）。如果任务已完成，请直接调用 finish_task。当前剩余轮次：${effectiveMaxRounds - aiRequestCount}`)
          messages.push({ role: 'assistant', content: content || '(空文本)', _parseFailedToolCall: true })
          messages.push({ role: 'user', content: '请用标准 tool_calls 格式重新发起调用，或调用 finish_task 结束任务。', _temp: true })
          continue
        }
        const textContent = content || 'AI未返回有效响应，请重试。'
        if (content) {
          await streamToUI(sendEvent, content)
        } else {
          console.warn('[Agent] AI返回空内容且无工具调用，强制结束')
          postToUI(tabId, { type: 'streamChunk', content: textContent })
          postToUI(tabId, { type: 'streamDone' })
        }
        await saveToChatHistoryStorage(textContent)
        return
      }
    } catch (e) {
      console.error('[AgentService] iteration error:', e)
      postToUI(tabId, { type: 'agentError', error: e.message })
      return
    }
  }

  // ===== 循环结束：达到最大轮次 =====
  const reachedRounds = aiRequestCount
  const reachedToolCalls = totalToolCalls
  postToUI(tabId, { type: 'agentError', error: `Agent达到最大请求次数（已执行 ${reachedRounds}/${effectiveMaxRounds} 轮），请简化任务重试` })
  _debugLog('Agent终止: 达到最大轮次', { effectiveMaxRounds, maxRounds, aiRequestCount, executedToolsCount: executedTools.length })
  const capNote = effectiveMaxRounds < maxRounds
    ? `（后端配置 ${maxRounds} 轮，超过绝对硬上限 100，已收敛为 ${effectiveMaxRounds} 轮）`
    : ''
  const finalNote = `⚠️ Agent 已达到最大请求次数上限，任务可能未完成。\n实际执行：${reachedRounds}/${effectiveMaxRounds} 轮 AI 请求，${reachedToolCalls} 次工具调用${capNote}。\n建议：1) 拆分任务为更小子任务 2) 简化需求描述 3) 后端调高 agent_max_rounds 配置（当前=${maxRounds}）。`
  const toolCallsSummary = executedTools.length > 0
    ? executedTools.filter(t => !t.name?.includes('search_tools') && !t.name?.includes('read_page_content')).slice(0, 15)
    : []
  await saveToChatHistoryStorage(finalNote, toolCallsSummary)
}

module.exports = { runAgent, PayloadStoreAdapter }
