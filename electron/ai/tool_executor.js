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
    const { browserView, analyzer, actionExecutor } = deps

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
}

module.exports = ToolExecutor
