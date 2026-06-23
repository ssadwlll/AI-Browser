/**
 * 逆向分析器
 * - 捕获并记录所有网络请求/响应
 * - 提取页面JS、分析技术栈
 * - 构建AI分析上下文
 */

class Analyzer {
  constructor() {
    this.requests = []
    this.responses = []
    this.errors = []
  }

  reset() {
    this.requests = []
    this.responses = []
    this.errors = []
  }

  recordRequest(details) {
    // 过滤掉 favicon 等无用请求
    if (details.url.includes('favicon.ico')) return

    this.requests.push({
      id: details.id,
      url: details.url,
      method: details.method,
      resourceType: details.resourceType,
      timestamp: details.timestamp,
      uploadData: details.uploadData ? details.uploadData.length : 0,
    })
  }

  recordResponse(details) {
    this.responses.push({
      id: details.id,
      url: details.url,
      statusCode: details.statusCode,
      statusLine: details.statusLine,
      mimeType: details.mimeType,
      resourceType: details.resourceType,
    })
  }

  recordError(details) {
    this.errors.push({
      id: details.id,
      url: details.url,
      error: details.error,
    })
  }

  getRequests() {
    // 合并请求和响应
    const responseMap = new Map(this.responses.map(r => [r.id, r]))
    return this.requests.map(req => ({
      ...req,
      response: responseMap.get(req.id) || null,
    }))
  }

  /**
   * 收集页面数据用于分析
   */
  async collectPageData(browserView) {
    if (!browserView) return null

    const url = browserView.webContents.getURL()
    const title = browserView.webContents.getTitle()

    let pageInfo = {}
    let scripts = []
    let html = ''

    try {
      pageInfo = await browserView.webContents.executeJavaScript(`
        ({
          title: document.title,
          url: location.href,
          metaTags: Array.from(document.querySelectorAll('meta')).map(m => ({
            name: m.name || m.getAttribute('property'),
            content: m.content,
          })).filter(m => m.name),
          scripts: Array.from(document.querySelectorAll('script[src]')).map(s => s.src),
          stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(l => l.href),
          frameworks: {
            react: !!window.React || !!document.querySelector('[data-reactroot], #root, #app'),
            vue: !!window.Vue || !!document.querySelector('[data-v-app], #app'),
            angular: !!window.angular || !!document.querySelector('app-root'),
            jquery: !!window.jQuery,
            next: !!window.__NEXT_DATA__,
            nuxt: !!window.__NUXT__,
          }
        })
      `)
    } catch (e) {
      // 忽略
    }

    try {
      scripts = await browserView.webContents.executeJavaScript(`
        Array.from(document.querySelectorAll('script')).map(s => ({
          src: s.src || '(inline)',
          type: s.type || 'text/javascript',
          content: s.src ? null : (s.textContent || '').substring(0, 3000),
        })).filter(s => s.src !== '(inline)' || s.content)
      `)
    } catch (e) {
      // 忽略
    }

    return {
      url,
      title,
      pageInfo,
      scripts,
      requests: this.getRequests(),
      errorRequests: this.errors,
    }
  }

  /**
   * 构建发送给AI的分析上下文
   */
  buildAnalysisContext(userPrompt, pageData) {
    if (!pageData) {
      return [{ role: 'system', content: '你是一个网页逆向分析专家助手。' }]
    }

    const { pageInfo, scripts, requests } = pageData

    // 过滤敏感请求信息，只保留关键数据
    const apiRequests = requests
      .filter(r => r.resourceType === 'xhr' || r.resourceType === 'fetch')
      .map(r => ({
        url: r.url,
        method: r.method,
        status: r.response?.statusCode,
        mimeType: r.response?.mimeType,
      }))

    const allRequests = requests.map(r => ({
      url: r.url,
      method: r.method,
      type: r.resourceType,
      status: r.response?.statusCode,
    }))

    const systemContent = `你是一个专业的网页逆向分析专家。你擅长：
1. 分析网页技术栈（前端框架、CDN、第三方服务）
2. 逆向分析网页API接口（请求/响应、参数加密）
3. 分析JS代码逻辑（反混淆、提取关键函数）

请根据提供的页面数据回答用户的问题。回答要专业、结构化、可操作。

页面数据：
- URL: ${pageData.url}
- 标题: ${pageData.title}

技术栈检测结果:
${JSON.stringify(pageInfo.frameworks || {}, null, 2)}

页面元信息:
${JSON.stringify(pageInfo.metaTags?.slice(0, 10) || [], null, 2)}

脚本列表:
${scripts.map(s => `- ${s.src}`).join('\n')}

API请求 (XHR/Fetch):
${JSON.stringify(apiRequests.slice(0, 30), null, 2)}

全部资源请求:
${JSON.stringify(allRequests.slice(0, 50), null, 2)}`

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: userPrompt || '请综合分析这个网页的技术栈、API接口和关键JS逻辑。' },
    ]
  }
}

module.exports = Analyzer
