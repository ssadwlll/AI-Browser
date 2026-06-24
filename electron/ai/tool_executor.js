/**
 * 工具执行器
 * 负责执行AI调用的各种工具，返回结果
 * 客户端负责执行，AI负责决策
 */

class ToolExecutor {
  constructor() {
    this.maxToolResultLength = 30000 // 工具返回结果最大长度
  }

  /**
   * 执行工具调用
   * @param {string} toolName - 工具名称
   * @param {object} args - 工具参数
   * @param {object} deps - 依赖注入 { browserView, analyzer, actionExecutor }
   * @returns {object} - { success, result }
   */
  async execute(toolName, args, deps) {
    const { browserView, analyzer, actionExecutor, tabManager } = deps

    try {
      switch (toolName) {
        case 'collect_page_context':
          return await this._collectPageContext(browserView, actionExecutor, args)

        case 'execute_js':
          return await this._executeJs(browserView, actionExecutor, args)

        case 'get_network_requests':
          return await this._getNetworkRequests(analyzer, args)

        case 'navigate_to':
          return await this._navigateTo(browserView, args)

        case 'extract_page_scripts':
          return await this._extractPageScripts(browserView, args)

        case 'get_page_html':
          return await this._getPageHtml(browserView, args)

        case 'screenshot':
          return await this._screenshot(browserView)

        case 'click_element':
          return await this._clickElement(browserView, args)

        case 'wait_for_element':
          return await this._waitForElement(browserView, args)

        case 'wait_for_navigation':
          return await this._waitForNavigation(browserView, args)

        case 'open_new_tab':
          return await this._openNewTab(tabManager, args)

        case 'close_current_tab':
          return await this._closeCurrentTab(tabManager)

        case 'extract_images':
          return await this._extractImages(browserView, args)

        case 'extract_links':
          return await this._extractLinks(browserView, args)

        case 'scroll_to_element':
          return await this._scrollToElement(browserView, args)

        default:
          return { success: false, error: `未知工具: ${toolName}` }
      }
    } catch (e) {
      return { success: false, error: `工具执行出错: ${e.message}` }
    }
  }

  /**
   * 收集页面上下文
   */
  async _collectPageContext(browserView, actionExecutor, args) {
    if (!browserView) {
      return { success: false, error: '没有打开的页面' }
    }

    const context = await actionExecutor.collectPageContext(browserView)
    if (!context) {
      return { success: false, error: '无法获取页面上下文' }
    }

    // 截断过大的DOM摘要
    if (context.domSummary && context.domSummary.length > (args.max_elements || 300)) {
      context.domSummary = context.domSummary.slice(0, args.max_elements || 300)
      context.domSummaryTruncated = true
    }

    return { success: true, result: context }
  }

  /**
   * 执行JS代码
   */
  async _executeJs(browserView, actionExecutor, args) {
    if (!browserView) {
      return { success: false, error: '没有打开的页面' }
    }

    if (!args.code) {
      return { success: false, error: '缺少code参数' }
    }

    const result = await actionExecutor.executeInPage(browserView, args.code)

    // 截断过大的结果
    const resultStr = JSON.stringify(result)
    if (resultStr.length > this.maxToolResultLength) {
      return {
        success: true,
        result: {
          ...result,
          data: result.data ? JSON.stringify(result.data).substring(0, 5000) + '...(数据已截断)' : undefined,
          _truncated: true,
          _originalLength: resultStr.length,
        },
        description: args.description || '代码已执行',
      }
    }

    return { success: true, result, description: args.description || '代码已执行' }
  }

  /**
   * 获取网络请求数据
   */
  async _getNetworkRequests(analyzer, args) {
    let requests = analyzer.getRequests()

    // 按URL过滤
    if (args.filter_url) {
      const pattern = args.filter_url.toLowerCase()
      requests = requests.filter(r => r.url && r.url.toLowerCase().includes(pattern))
    }

    // 按方法过滤
    if (args.method) {
      const method = args.method.toUpperCase()
      requests = requests.filter(r => r.method === method)
    }

    // 限制数量
    const limit = args.limit || 20
    if (requests.length > limit) {
      requests = requests.slice(0, limit)
    }

    // 精简每个请求的数据，避免过大
    const simplified = requests.map(r => ({
      url: r.url ? r.url.substring(0, 500) : '',
      method: r.method,
      status: r.statusCode,
      type: r.resourceType,
      mimeType: r.mimeType,
      contentLength: r.contentLength,
      // 请求头中的关键信息
      hasRequestBody: !!r.requestBody,
      requestBodyPreview: r.requestBody ? JSON.stringify(r.requestBody).substring(0, 2000) : null,
      // 响应体预览
      responseBodyPreview: r.responseBody ? r.responseBody.substring(0, 2000) : null,
    }))

    return { success: true, result: { requests: simplified, total: analyzer.getRequests().length } }
  }

  /**
   * 导航到URL
   */
  async _navigateTo(browserView, args) {
    if (!browserView) {
      return { success: false, error: '没有浏览器视图' }
    }

    let url = args.url
    if (!url) {
      return { success: false, error: '缺少url参数' }
    }

    if (!url.startsWith('http')) {
      url = 'https://' + url
    }

    return new Promise((resolve) => {
      browserView.webContents.loadURL(url)
      browserView.webContents.once('did-finish-load', () => {
        resolve({
          success: true,
          result: {
            url: browserView.webContents.getURL(),
            title: browserView.webContents.getTitle(),
          },
        })
      })
      browserView.webContents.once('did-fail-load', (event, code, desc) => {
        resolve({ success: false, error: `页面加载失败: ${desc}` })
      })

      // 超时保护
      setTimeout(() => {
        resolve({
          success: true,
          result: {
            url: browserView.webContents.getURL(),
            title: browserView.webContents.getTitle(),
            _timeout: true,
          },
        })
      }, 15000)
    })
  }

  /**
   * 提取页面脚本
   */
  async _extractPageScripts(browserView, args) {
    if (!browserView) {
      return { success: false, error: '没有打开的页面' }
    }

    const includeInline = args.include_inline !== false
    const maxContent = args.max_content_length || 5000

    try {
      const scripts = await browserView.webContents.executeJavaScript(`
        Array.from(document.querySelectorAll('script')).map(s => ({
          src: s.src || '(inline)',
          type: s.type || 'text/javascript',
          async: s.async,
          defer: s.defer,
          content: ${includeInline} && !s.src ? s.textContent.substring(0, ${maxContent}) : null,
        }))
      `)

      return { success: true, result: { scripts, count: scripts.length } }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  /**
   * 获取页面HTML
   */
  async _getPageHtml(browserView, args) {
    if (!browserView) {
      return { success: false, error: '没有打开的页面' }
    }

    const maxLength = args.max_length || 50000

    try {
      let html
      if (args.selector) {
        html = await browserView.webContents.executeJavaScript(`
          const el = document.querySelector('${args.selector.replace(/'/g, "\\'")}')
          el ? el.outerHTML : 'Element not found: ${args.selector.replace(/'/g, "\\'")}'
        `)
      } else {
        html = await browserView.webContents.executeJavaScript('document.documentElement.outerHTML')
      }

      if (html && html.length > maxLength) {
        html = html.substring(0, maxLength) + '\n... (HTML已截断)'
      }

      return { success: true, result: { html, length: html.length } }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  /**
   * 截图
   */
  async _screenshot(browserView) {
    if (!browserView) {
      return { success: false, error: '没有打开的页面' }
    }

    try {
      const image = await browserView.webContents.capturePage()
      const base64 = image.toPNG().toString('base64')
      return {
        success: true,
        result: {
          message: '截图成功',
          size: `${image.getSize().width}x${image.getSize().height}`,
          // 返回base64，前端可显示
          base64: base64.substring(0, 100) + '...(base64数据过大，仅显示前100字符)',
        },
      }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
/**
   * 点击元素
   */
  async _clickElement(browserView, args) {
    if (!browserView) {
      return { success: false, error: '没有打开的页面' }
    }
    if (!args.selector) {
      return { success: false, error: '缺少selector参数' }
    }

    const index = args.index || 0
    const waitAfter = args.wait_after_click || 500
    const selector = args.selector.replace(/'/g, "\\'")

    try {
      const result = await browserView.webContents.executeJavaScript(`
        (function() {
          const els = document.querySelectorAll('${selector}')
          if (els.length === 0) {
            return { success: false, error: '未找到匹配元素: ${selector}' }
          }
          const idx = ${index}
          if (idx >= els.length) {
            return { success: false, error: '索引越界: 共' + els.length + '个元素，请求第' + (idx + 1) + '个' }
          }
          const el = els[idx]
          const tag = el.tagName.toLowerCase()
          const text = (el.textContent || '').trim().substring(0, 100)
          const id = el.id || ''
          const className = el.className || ''
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          el.click()
          return {
            success: true,
            element: { tag, id, className, text, index: idx },
            totalMatching: els.length,
          }
        })()
      `)

      if (result && result.success && waitAfter > 0) {
        await new Promise(resolve => setTimeout(resolve, waitAfter))
      }

      return { success: true, result, description: `已点击元素: ${args.selector}` }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  /**
   * 等待元素出现
   */
  async _waitForElement(browserView, args) {
    if (!browserView) {
      return { success: false, error: '没有打开的页面' }
    }
    if (!args.selector) {
      return { success: false, error: '缺少selector参数' }
    }

    const timeout = args.timeout || 10000
    const visible = args.visible !== false
    const selector = args.selector.replace(/'/g, "\\'")
    const pollInterval = 200

    const startTime = Date.now()
    let found = false
    let lastError = ''

    while (Date.now() - startTime < timeout) {
      try {
        const result = await browserView.webContents.executeJavaScript(`
          (function() {
            const el = document.querySelector('${selector}')
            if (!el) return { found: false }
            if (${visible}) {
              const style = window.getComputedStyle(el)
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                return { found: false, reason: '元素不可见' }
              }
            }
            return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().substring(0, 100) }
          })()
        `)

        if (result && result.found) {
          found = true
          return {
            success: true,
            result: {
              message: `元素已出现: ${selector}`,
              element: result,
              waitedMs: Date.now() - startTime,
            },
          }
        }
        lastError = result && result.reason ? result.reason : '元素未出现'
      } catch (e) {
        lastError = e.message
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }

    return { success: false, error: `等待超时(${timeout}ms): ${selector} - ${lastError}` }
  }

  /**
   * 等待页面导航完成
   */
  async _waitForNavigation(browserView, args) {
    if (!browserView) {
      return { success: false, error: '没有打开的页面' }
    }

    const timeout = args.timeout || 30000

    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer)
        browserView.webContents.removeListener('did-finish-load', onFinish)
        browserView.webContents.removeListener('did-fail-load', onFail)
      }

      const onFinish = () => {
        cleanup()
        resolve({
          success: true,
          result: {
            url: browserView.webContents.getURL(),
            title: browserView.webContents.getTitle(),
            message: '导航完成',
          },
        })
      }

      const onFail = (event, code, desc) => {
        cleanup()
        resolve({ success: false, error: `导航失败: ${desc}` })
      }

      const timer = setTimeout(() => {
        cleanup()
        resolve({
          success: true,
          result: {
            url: browserView.webContents.getURL(),
            title: browserView.webContents.getTitle(),
            message: '导航等待超时，但页面可能仍在加载',
            _timeout: true,
          },
        })
      }, timeout)

      browserView.webContents.once('did-finish-load', onFinish)
      browserView.webContents.once('did-fail-load', onFail)
    })
  }

  /**
   * 打开新标签页
   */
  async _openNewTab(tabManager, args) {
    if (!tabManager) {
      return { success: false, error: '标签管理功能不可用' }
    }
    if (!args.url) {
      return { success: false, error: '缺少url参数' }
    }

    try {
      let url = args.url
      if (!url.startsWith('http')) {
        url = 'https://' + url
      }
      const active = args.active !== false
      const tabInfo = tabManager.createTab(url)

      return {
        success: true,
        result: {
          tabId: tabInfo.id,
          url: url,
          active: active,
          message: active ? `已在新标签页打开: ${url}` : `已在后台标签页打开: ${url}`,
        },
      }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  /**
   * 关闭当前标签页
   */
  async _closeCurrentTab(tabManager) {
    if (!tabManager) {
      return { success: false, error: '标签管理功能不可用' }
    }

    try {
      const activeTabId = tabManager.getActiveTabId()
      if (activeTabId === null) {
        return { success: false, error: '没有活跃标签页' }
      }
      const result = tabManager.closeTab(activeTabId)
      if (result && result === 'last_tab') {
        return { success: false, error: '无法关闭最后一个标签页' }
      }
      return { success: true, result: { message: '标签页已关闭' } }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  /**
   * 提取图片
   */
  async _extractImages(browserView, args) {
    if (!browserView) {
      return { success: false, error: '没有打开的页面' }
    }

    const minWidth = args.min_width || 0
    const minHeight = args.min_height || 0
    const limit = args.limit || 50

    try {
      let images = await browserView.webContents.executeJavaScript(`
        (function() {
          const results = []
          const baseUrl = window.location.origin
          const seen = new Set()

          document.querySelectorAll('img').forEach(img => {
            const src = img.src || img.getAttribute('data-src') || img.getAttribute('srcset') || ''
            if (!src || src.startsWith('data:') || seen.has(src)) return
            seen.add(src)

            const rect = img.getBoundingClientRect()
            const info = {
              src: src.substring(0, 500),
              width: rect.width || img.naturalWidth || img.width || 0,
              height: rect.height || img.naturalHeight || img.height || 0,
              alt: (img.alt || '').substring(0, 200),
              title: (img.title || '').substring(0, 200),
              visible: rect.width > 0 && rect.height > 0,
            }

            if (info.width >= ${minWidth} && info.height >= ${minHeight}) {
              results.push(info)
            }
          })

          // 也收集 picture 标签中的 source
          document.querySelectorAll('picture source').forEach(source => {
            const srcset = source.getAttribute('srcset')
            if (srcset && !seen.has(srcset)) {
              seen.add(srcset)
              results.push({ src: srcset.substring(0, 500), width: 0, height: 0, alt: '', title: '', visible: false, fromPicture: true })
            }
          })

          return results.slice(0, ${limit})
        })()
      `)

      return { success: true, result: { images, count: images.length } }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  /**
   * 提取链接
   */
  async _extractLinks(browserView, args) {
    if (!browserView) {
      return { success: false, error: '没有打开的页面' }
    }

    const domainOnly = args.domain_only || false
    const filter = args.filter || ''
    const limit = args.limit || 100

    try {
      const links = await browserView.webContents.executeJavaScript(`
        (function() {
          const results = []
          const seen = new Set()
          const currentDomain = window.location.hostname

          document.querySelectorAll('a[href]').forEach(a => {
            const href = a.href
            if (!href || href.startsWith('javascript:') || href.startsWith('#') || seen.has(href)) return
            seen.add(href)

            const info = {
              url: href.substring(0, 500),
              text: (a.textContent || '').trim().substring(0, 200),
              title: (a.title || '').substring(0, 200),
              rel: a.rel || '',
              isExternal: !href.includes(currentDomain),
            }

            results.push(info)
          })

          let filtered = results
          if (${domainOnly}) {
            filtered = results.filter(r => !r.isExternal)
          }
          if ('${filter.replace(/'/g, "\\'")}') {
            const kw = '${filter.replace(/'/g, "\\'").toLowerCase()}'
            filtered = filtered.filter(r => r.url.toLowerCase().includes(kw) || r.text.toLowerCase().includes(kw))
          }

          return filtered.slice(0, ${limit})
        })()
      `)

      return { success: true, result: { links, count: links.length } }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  /**
   * 滚动到元素
   */
  async _scrollToElement(browserView, args) {
    if (!browserView) {
      return { success: false, error: '没有打开的页面' }
    }
    if (!args.selector) {
      return { success: false, error: '缺少selector参数' }
    }

    const behavior = args.behavior || 'smooth'
    const offset = args.offset || 0
    const selector = args.selector.replace(/'/g, "\\'")

    try {
      const result = await browserView.webContents.executeJavaScript(`
        (function() {
          const el = document.querySelector('${selector}')
          if (!el) {
            return { success: false, error: '未找到匹配元素: ${selector}' }
          }
          const rect = el.getBoundingClientRect()
          const scrollTop = window.pageYOffset + rect.top - ${offset}
          window.scrollTo({ top: scrollTop, behavior: '${behavior}' })
          return {
            success: true,
            element: {
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || '').trim().substring(0, 100),
              position: { top: Math.round(rect.top), left: Math.round(rect.left) },
            },
            scrolledTo: Math.round(scrollTop),
          }
        })()
      `)

      return { success: true, result, description: `已滚动到元素: ${args.selector}` }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
}

module.exports = ToolExecutor
