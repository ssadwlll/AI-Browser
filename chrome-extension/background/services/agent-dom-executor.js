// ============ DOM 工具执行器 ============
// 所有 DOM 工具的实现，通过 chrome.scripting.executeScript 在页面中执行
// 注意：每个工具函数必须自包含 qsa 定义（闭包变量在序列化时会丢失）
// Shadow DOM 支持：qsa 函数会递归穿透 open Shadow DOM 查找元素

/**
 * 执行 DOM 工具
 * @param {number} tabId - 标签页 ID
 * @param {string} toolName - 工具名称
 * @param {object} args - 工具参数
 * @returns {Promise<{ok: boolean, result?: any, error?: string}>}
 */
export async function executeDOMTool(tabId, toolName, args) {
  const funcs = {

    extract_content: (selector, multiple, limit, attributes) => {
      const qsa=(s)=>{const m=s.match(/^(.*):contains\("([^"]*)"\)(.*)$/);if(!m)return window._dqsa(s);const c=(m[1]+m[3]).trim()||'*';const t=m[2].toLowerCase();return window._dqsa(c).filter(e=>window._deepText(e).toLowerCase().includes(t))}
      const els = qsa(selector)
      const attrList = (() => {
        if (!attributes) return null
        if (typeof attributes === 'string' && attributes.length > 0) return attributes.split(',').map(s => s.trim()).filter(Boolean)
        if (Array.isArray(attributes) && attributes.length > 0) return attributes
        return null
      })()
      const results = []
      const max = Math.min(els.length, limit || 10)
      for (let i = 0; i < max; i++) {
        const item = { text: window._deepText(els[i]).slice(0, 500) }
        if (attrList) {
          item.attrs = {}
          for (const attr of attrList) {
            const val = els[i].getAttribute(attr)
            if (val !== null && val !== undefined) item.attrs[attr] = val
          }
        }
        results.push(item)
      }
      return multiple !== false ? results : (results[0] || '')
    },

    click_element: (selector, index) => {
      const qsa=(s)=>{const m=s.match(/^(.*):contains\("([^"]*)"\)(.*)$/);if(!m)return window._dqsa(s);const c=(m[1]+m[3]).trim()||'*';const t=m[2].toLowerCase();return window._dqsa(c).filter(e=>window._deepText(e).toLowerCase().includes(t))}
      const els = qsa(selector)
      const el = els[index || 0]
      if (!el) return '元素未找到: ' + selector
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      const linkHref = el.tagName === 'A' && el.href ? el.getAttribute('href') : null
      if (el.tagName === 'A') {
        el.removeAttribute('target')
        el.setAttribute('target', '_self')
      }
      el.click()
      const text = window._deepText(el).slice(0, 50)
      if (linkHref) return `已点击链接: ${text || el.tagName} → ${linkHref}`
      return '已点击: ' + (text || el.tagName)
    },

    fill_input: (selector, value, submit) => {
      const qsa=(s)=>{const m=s.match(/^(.*):contains\("([^"]*)"\)(.*)$/);if(!m)return window._dqsa(s);const c=(m[1]+m[3]).trim()||'*';const t=m[2].toLowerCase();return window._dqsa(c).filter(e=>window._deepText(e).toLowerCase().includes(t))}
      const els = qsa(selector)
      const el = els[0]
      if (!el) return '输入框未找到: ' + selector
      el.focus()
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (el.tagName === 'TEXTAREA' && nativeTextareaSetter) {
        nativeTextareaSetter.call(el, value)
      } else if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, value)
      } else {
        el.value = value
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      if (submit) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }))
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }))
        const form = el.closest('form')
        if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      }
      return '已填入: ' + value.slice(0, 50) + (submit ? '（已提交）' : '')
    },

    wait_for_element: (selector, timeout) => {
      const qsa=(s)=>{const m=s.match(/^(.*):contains\("([^"]*)"\)(.*)$/);if(!m)return window._dqsa(s);const c=(m[1]+m[3]).trim()||'*';const t=m[2].toLowerCase();return window._dqsa(c).filter(e=>window._deepText(e).toLowerCase().includes(t))}
      return new Promise((resolve) => {
        const start = Date.now()
        const max = timeout || 5000
        function check() {
          const els = qsa(selector)
          if (els.length > 0) {
            resolve({ found: true, count: els.length, elapsed: Date.now() - start, selector })
            return
          }
          if (Date.now() - start > max) {
            resolve({ found: false, count: 0, elapsed: Date.now() - start, selector, hint: `等待${max}ms后未找到元素"${selector}"，请检查选择器是否正确，或页面可能加载失败` })
            return
          }
          setTimeout(check, 200)
        }
        check()
      })
    },

    save_as_file: (content, filename, mimeType) => {
      const blob = new Blob([content], { type: mimeType || 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      return '文件已触发下载: ' + filename + ' (大小: ' + (content.length > 1024 ? (content.length / 1024).toFixed(1) + 'KB' : content.length + '字符') + ')'
    },

    navigate_to: (url) => {
      if (!url || !url.startsWith('http')) return '无效URL: ' + url
      window.location.href = url
      return '正在导航到: ' + url
    },

    go_back: () => {
      window.history.back()
      return '已返回上一页'
    },

    find_text_on_page: (query, caseSensitive) => {
      // 递归收集包含 Shadow DOM 的全部文本
      const collectText = (root, depth) => {
        depth = depth || 0
        if (depth > 10) return ''
        let parts = []
        for (const node of root.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            parts.push(node.textContent)
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'NOSCRIPT') continue
            parts.push(collectText(node, depth + 1))
            if (node.shadowRoot) {
              parts.push(collectText(node.shadowRoot, depth + 1))
            }
          }
        }
        return parts.join(' ')
      }
      const text = collectText(document.body)
      const flags = caseSensitive ? 'g' : 'gi'
      const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
      const matches = text.match(regex) || []
      const previews = []
      for (let i = 0; i < Math.min(matches.length, 5); i++) {
        const idx = text.search(new RegExp(matches[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i'))
        if (idx === -1) continue
        const start = Math.max(0, idx - 30)
        const end = Math.min(text.length, idx + matches[i].length + 30)
        previews.push('...' + text.slice(start, end).replace(/\n/g, ' ') + '...')
      }
      return {
        found: matches.length > 0,
        matchCount: matches.length,
        query,
        previews,
        hint: matches.length === 0 ? `未找到"${query}"。建议：检查拼写、尝试简化关键词、或用read_page_content重新读取页面` : null
      }
    },

    get_element_info: (selector, limit, attributes) => {
      const qsa=(s)=>{const m=s.match(/^(.*):contains\("([^"]*)"\)(.*)$/);if(!m)return window._dqsa(s);const c=(m[1]+m[3]).trim()||'*';const t=m[2].toLowerCase();return window._dqsa(c).filter(e=>window._deepText(e).toLowerCase().includes(t))}
      const els = qsa(selector)
      const max = Math.min(els.length, limit || 5)
      const attrList = attributes ? attributes.split(',').map(a => a.trim()).filter(Boolean) : null
      const items = []
      for (let i = 0; i < max; i++) {
        const text = window._deepText(els[i]).slice(0, 80)
        let line = `[${i}] <${els[i].tagName.toLowerCase()}> ${text || '(空文本)'}`
        if (attrList) {
          const pairs = []
          for (const attr of attrList) {
            let val = els[i].getAttribute(attr)
            if (val !== null && val !== undefined) {
              if (attr === 'href' && val.length > 60) val = val.slice(0, 57) + '...'
              pairs.push(`${attr}="${val}"`)
            }
          }
          if (pairs.length > 0) line += ' | ' + pairs.join(', ')
        }
        items.push(line)
      }
      let summary = `共${els.length}个匹配，返回前${items.length}条:\n` + items.join('\n')
      if (els.length > max) summary += `\n(还有${els.length - max}条未显示，可用 index 参数翻页)`
      return summary
    },

    scroll_page: (direction, amount) => {
      const dir = direction === 'up' ? -1 : 1
      let px = window.innerHeight * 0.8
      if (amount === 'half') px = window.innerHeight * 0.5
      else if (amount && /^\d+$/.test(amount)) px = parseInt(amount)
      window.scrollBy({ top: dir * px, behavior: 'smooth' })
      const scrolled = Math.round(window.scrollY)
      const total = Math.round(document.documentElement.scrollHeight - window.innerHeight)
      return `已${direction === 'up' ? '向上' : '向下'}滚动${px}px，当前位置: ${scrolled}/${total} (${Math.round(scrolled/Math.max(total,1)*100)}%)`
    },

    hover_element: (selector, index) => {
      const qsa=(s)=>{const m=s.match(/^(.*):contains\("([^"]*)"\)(.*)$/);if(!m)return window._dqsa(s);const c=(m[1]+m[3]).trim()||'*';const t=m[2].toLowerCase();return window._dqsa(c).filter(e=>window._deepText(e).toLowerCase().includes(t))}
      const els = qsa(selector)
      const el = els[index || 0]
      if (!el) return { ok: false, error: '元素未找到: ' + selector }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      return '已悬停: ' + (window._deepText(el).slice(0, 50) || el.tagName)
    },

    select_dropdown: (selector, value, by) => {
      const qsa=(s)=>{const m=s.match(/^(.*):contains\("([^"]*)"\)(.*)$/);if(!m)return window._dqsa(s);const c=(m[1]+m[3]).trim()||'*';const t=m[2].toLowerCase();return window._dqsa(c).filter(e=>window._deepText(e).toLowerCase().includes(t))}
      const els = qsa(selector)
      const el = els[0]
      if (!el || el.tagName !== 'SELECT') return { ok: false, error: '未找到<select>元素: ' + selector }
      const mode = by || 'text'
      let matched = false
      for (const opt of el.options) {
        const isMatch = mode === 'index' ? (opt.index === parseInt(value))
          : mode === 'value' ? (opt.value === value)
          : ((opt.textContent || '').trim() === value || opt.text === value)
        if (isMatch) {
          el.value = opt.value
          matched = true
          break
        }
      }
      if (!matched) return { ok: false, error: `在下拉框中未找到选项: "${value}" (by=${mode})。可用选项: ` + [...el.options].map(o => (o.textContent||'').trim()).slice(0,10).join(', ') }
      el.dispatchEvent(new Event('change', { bubbles: true }))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return `已选择: ${value}`
    },

    press_key: (key, selector) => {
      const opts = { key, code: key, keyCode: { Escape: 27, Enter: 13, Tab: 9, PageDown: 34, PageUp: 33, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 }[key] || 0, bubbles: true }
      let target = document
      if (selector) {
        const els = window._dqsa(selector)
        const el = els[0]
        if (el) { el.focus(); target = el }
      }
      target.dispatchEvent(new KeyboardEvent('keydown', opts))
      target.dispatchEvent(new KeyboardEvent('keyup', opts))
      return `已按键: ${key}` + (selector ? ` (目标: ${selector})` : '')
    },

    go_forward: () => {
      window.history.forward()
      return '已前进到下一页'
    },

    get_interactive_elements: (selectorHint) => {
      const interactives = ['a', 'button', 'input', 'select', 'textarea', '[onclick]', '[role="button"]', '[tabindex]', '[class*="btn"]', '[class*="link"]', '[class*="item"]']
      const selector = selectorHint || interactives.join(',')
      const els = window._dqsa(selector)
      const results = []
      const max = Math.min(els.length, 20)
      for (let i = 0; i < max; i++) {
        const el = els[i]
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        const text = window._deepText(el).slice(0, 40) || (el.value || '').slice(0, 40)
        const tag = el.tagName.toLowerCase()
        const id = el.id ? `#${el.id}` : ''
        const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : ''
        const href = el.tagName === 'A' ? (el.getAttribute('href') || '').slice(0, 50) : ''
        results.push({
          index: results.length,
          tag,
          text,
          selector: `${tag}${id}${cls}`.slice(0, 60),
          href,
          type: el.type || '',
        })
      }
      // 探测 Shadow DOM 内的自定义元素标签
      const customTags = new Set()
      const detectCustomTags = (root, depth) => {
        depth = depth || 0
        if (depth > 5) return
        for (const el of root.querySelectorAll('*')) {
          const tag = el.tagName?.toLowerCase()
          if (tag && tag.includes('-')) customTags.add(tag)
          if (el.shadowRoot) detectCustomTags(el.shadowRoot, depth + 1)
        }
      }
      detectCustomTags(document)
      const shadowHint = customTags.size > 0
        ? `页面包含 Shadow DOM 自定义元素: ${[...customTags].slice(0, 15).join(', ')}。如需提取这些元素内容，请用 extract_content 配合对应的标签名选择器（如 "${[...customTags][0]}"）`
        : null
      return {
        total: els.length,
        listed: results.length,
        elements: results,
        shadowHint,
        hint: `使用 click_element 配合上述元素的 selector 或 index 参数进行交互。例如: click_element(selector="${results[0]?.selector || ''}")`,
      }
    },

    // 页面模板识别：分析 DOM 结构，识别页面类型并推荐选择器
    detect_page_template: (sampleLimit) => {
      sampleLimit = Math.min(Math.max(parseInt(sampleLimit) || 5, 1), 10)

      // ===== 1. 探测重复容器（列表项候选）=====
      // 候选容器：常见列表包装器
      const listContainerSelectors = [
        'ul', 'ol', 'tbody',
        '[class*="list"]', '[class*="item"]', '[class*="card"]',
        '[class*="article"]', '[class*="news"]', '[class*="post"]',
        '[class*="result"]', '[class*="product"]', '[class*="entry"]',
        'article', 'li', 'tr',
      ]
      const seen = new Set()
      const candidates = []
      for (const sel of listContainerSelectors) {
        let els
        try { els = window._dqsa(sel) } catch { continue }
        for (const el of els) {
          // 跳过不可见
          const style = getComputedStyle(el)
          if (style.display === 'none' || style.visibility === 'hidden') continue
          const rect = el.getBoundingClientRect()
          if (rect.width < 100 || rect.height < 30) continue
          // 跳过导航类小元素容器
          if (el.children.length < 2) continue
          const sig = el.tagName + '.' + (el.className || '').toString().slice(0, 30)
          if (seen.has(sig)) continue
          seen.add(sig)
          candidates.push({ el, sel: sig, childCount: el.children.length })
        }
      }

      // 按子元素数量排序，找到重复模式最强的容器
      candidates.sort((a, b) => b.childCount - a.childCount)

      // ===== 2. 检测重复模式：找出有多个结构相似子元素的容器 =====
      let repeatPattern = null
      for (const c of candidates.slice(0, 15)) {
        const children = Array.from(c.el.children).slice(0, sampleLimit)
        if (children.length < 2) continue
        // 计算子元素结构签名（tag + class 前缀）
        const signatures = children.map(child => {
          const tag = child.tagName.toLowerCase()
          const cls = (child.className || '').toString().split(/\s+/).slice(0, 2).join('.')
          return `${tag}.${cls}`
        })
        // 统计相同签名的频次
        const sigCounts = {}
        for (const s of signatures) sigCounts[s] = (sigCounts[s] || 0) + 1
        // 找到频次最高的签名（至少 2 个相同才认为是列表）
        let maxSig = null, maxCount = 0
        for (const [s, n] of Object.entries(sigCounts)) {
          if (n > maxCount) { maxSig = s; maxCount = n }
        }
        if (maxCount >= 2 && maxSig) {
          repeatPattern = {
            containerSelector: c.sel,
            containerTag: c.el.tagName.toLowerCase(),
            itemCount: c.childCount,
            sampleCount: children.length,
            itemSignature: maxSig,
            repeatCount: maxCount,
          }
          break
        }
      }

      // ===== 3. 推荐字段选择器 =====
      const recommendSelectors = {}
      const ctx = repeatPattern ? repeatPattern.containerTag : 'body'
      const ctxEl = repeatPattern ? repeatPattern.containerEl : document

      // 标题：h1-h3, [class*="title"], a 文本
      const titleEls = window._dqsa('h1, h2, h3, [class*="title"], [class*="heading"]')
      if (titleEls.length > 0) {
        const el = titleEls[0]
        const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : ''
        recommendSelectors.title = `${el.tagName.toLowerCase()}${cls}`
      }

      // 链接：a[href] 中文本较长的
      const links = window._dqsa('a[href]')
      let bestLink = null, bestLen = 0
      for (const a of links) {
        const t = window._deepText(a)
        if (t.length > bestLen && t.length < 200) { bestLen = t.length; bestLink = a }
      }
      if (bestLink) {
        const cls = bestLink.className && typeof bestLink.className === 'string' ? '.' + bestLink.className.split(' ').slice(0, 2).join('.') : ''
        recommendSelectors.link = `a${cls}[href]`
      }

      // 日期：[class*="date"], [class*="time"], time
      const dateEls = window._dqsa('time, [class*="date"], [class*="time"]')
      if (dateEls.length > 0) {
        const el = dateEls[0]
        const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : ''
        recommendSelectors.date = `${el.tagName.toLowerCase()}${cls}`
      }

      // 正文：article, [class*="content"], [class*="article"], main
      const contentEls = window._dqsa('article, main, [class*="content"], [class*="article-body"], [class*="post-content"]')
      if (contentEls.length > 0) {
        const el = contentEls[0]
        const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : ''
        recommendSelectors.content = `${el.tagName.toLowerCase()}${cls}`
      }

      // 列表项选择器（如果有重复模式）
      if (repeatPattern) {
        recommendSelectors.listItem = repeatPattern.itemSignature
        recommendSelectors.listContainer = repeatPattern.containerSelector
      }

      // ===== 4. 判定页面类型 =====
      let pageType = 'unknown'
      let pageTypeReason = ''
      const url = location.href.toLowerCase()
      const hasRepeat = repeatPattern && repeatPattern.repeatCount >= 2
      const hasSearch = url.includes('search') || url.includes('q=') || url.includes('query')
      const hasArticle = recommendSelectors.content && titleEls.length > 0
      const hasTable = window._dqsa('table tbody tr').length >= 2

      if (hasTable) {
        pageType = 'table_data'
        pageTypeReason = `检测到表格（${window._dqsa('table tbody tr').length} 行）`
      } else if (hasRepeat && hasSearch) {
        pageType = 'search_results'
        pageTypeReason = `URL 含搜索参数 + 重复列表项（${repeatPattern.repeatCount} 个相同结构）`
      } else if (hasRepeat && !hasArticle) {
        pageType = 'list_page'
        pageTypeReason = `检测到重复容器（${repeatPattern.repeatCount} 个 ${repeatPattern.itemSignature}）`
      } else if (hasArticle && !hasRepeat) {
        pageType = 'article_detail'
        pageTypeReason = `检测到标题 + 正文容器`
      } else if (hasRepeat && hasArticle) {
        // 既有列表又有正文容器，可能详情页带相关推荐
        pageType = 'article_detail'
        pageTypeReason = `检测到标题+正文，同时有重复列表（可能是详情页带推荐）`
      } else {
        pageType = 'unknown'
        pageTypeReason = '未匹配到典型模式'
      }

      // ===== 5. 计算页面指纹 =====
      const fingerprint = {
        host: location.hostname,
        pathDepth: (location.pathname.match(/\//g) || []).length,
        hasRepeat: !!hasRepeat,
        repeatCount: hasRepeat ? repeatPattern.repeatCount : 0,
        titleCount: titleEls.length,
        linkCount: links.length,
        tableCount: window._dqsa('table').length,
        formCount: window._dqsa('form').length,
      }

      return {
        pageType,
        pageTypeReason,
        fingerprint,
        repeatPattern,
        recommendedSelectors: recommendSelectors,
        suggestion: pageType === 'list_page'
          ? `检测到列表页，可使用 extract_content(selector="${recommendSelectors.listItem || ''}", multiple=true) 批量提取每项数据`
          : pageType === 'article_detail'
          ? `检测到详情页，可使用 extract_content(selector="${recommendSelectors.content || ''}") 提取正文`
          : pageType === 'search_results'
          ? `检测到搜索结果页，可使用 extract_content(selector="${recommendSelectors.listItem || ''}", multiple=true) 提取结果列表`
          : pageType === 'table_data'
          ? `检测到表格数据，可使用 extract_content(selector="tr", multiple=true) 提取表格行`
          : `未识别到典型页面类型，建议先 get_interactive_elements 了解页面结构`,
      }
    },
  }

  const func = funcs[toolName]
  if (!func) return { ok: false, error: `未知DOM工具: ${toolName}` }

  const argMap = {
    extract_content: [args.selector, args.multiple, args.limit, args.attributes],
    click_element: [args.selector, args.index],
    fill_input: [args.selector, args.value, args.submit],
    wait_for_element: [args.selector, args.timeout],
    save_as_file: [args.content, args.filename, args.mimeType],
    navigate_to: [args.url],
    go_back: [],
    find_text_on_page: [args.query, args.caseSensitive],
    get_element_info: [args.selector, args.limit, args.attributes],
    scroll_page: [args.direction, args.amount],
    hover_element: [args.selector, args.index],
    select_dropdown: [args.selector, args.value, args.by],
    press_key: [args.key, args.selector],
    go_forward: [],
    get_interactive_elements: [args.selectorHint],
    detect_page_template: [args.sample_limit],
  }

  try {
    console.log('[Agent] executeDOMTool:', toolName, 'args:', JSON.stringify(args))
    const serializedArgs = (argMap[toolName] || []).map(v => v === undefined ? null : v)
    // 先注入深查询函数（穿透 Shadow DOM）
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (window._dqsa) return
        // 深查询：递归穿透 Shadow DOM 查找元素（只对自定义元素检查shadowRoot）
        window._dqsa = function deepQuerySelectorAll(selector, _root, _depth) {
          const root = _root || document
          const depth = _depth || 0
          if (depth > 10) return []
          let results = [...root.querySelectorAll(selector)]
          const allEls = root.querySelectorAll('*')
          for (const el of allEls) {
            // 只对自定义元素（标签名含-）检查shadowRoot，避免遍历所有元素导致性能问题
            if (el.shadowRoot && el.tagName.includes('-')) {
              try {
                results = results.concat(deepQuerySelectorAll(selector, el.shadowRoot, depth + 1))
              } catch (e) {}
            }
          }
          return results
        }
        // 深文本提取：递归穿透 Shadow DOM 获取完整文本（textContent 不穿透 Shadow DOM）
        window._deepText = function deepText(el, depth) {
          depth = depth || 0
          if (depth > 10) return ''
          const parts = []
          for (const node of el.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
              const t = node.textContent.trim()
              if (t) parts.push(t)
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'NOSCRIPT') continue
              parts.push(deepText(node, depth + 1))
              if (node.shadowRoot) {
                parts.push(deepText(node.shadowRoot, depth + 1))
              }
            }
          }
          return parts.filter(Boolean).join(' ')
        }
      },
    })
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args: serializedArgs,
    })
    console.log('[Agent] executeDOMTool result:', JSON.stringify(result?.result))
    return { ok: true, result: result?.result }
  } catch (e) {
    console.error('[Agent] executeDOMTool error:', toolName, e.message)
    if (e.message?.includes('Cannot access a chrome:// URL') || e.message?.includes('Cannot access contents of url')) {
      return { ok: false, error: '当前页面为系统页面（chrome://），无法执行DOM操作。必须用finish_task告知用户：请在普通网页上执行此操作，当前页面不支持自动化。不要再调用DOM工具。' }
    }
    return { ok: false, error: e.message }
  }
}
