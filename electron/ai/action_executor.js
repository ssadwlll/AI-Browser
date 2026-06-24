/**
 * 智能操作执行器
 * 流程: 用户描述需求 → 读取页面源码/DOM → 调用LLM生成JS代码 → 注入页面执行
 */
class ActionExecutor {
  constructor() {
    this.history = []       // 操作历史
    this.maxHistory = 50
    this.sessionMessages = []  // 会话上下文（system + 多轮对话）
    this.maxSessionMessages = 20  // 最多保留的上下文消息数
  }

  /**
   * 收集页面上下文信息（精简版，避免token过多）
   */
  async collectPageContext(browserView) {
    if (!browserView) return null

    try {
      // 先等待页面加载完成
      await this.waitForPageLoad(browserView)

      const context = await browserView.webContents.executeJavaScript(`
        (function() {
          // 页面基本信息
          const info = {
            url: location.href,
            title: document.title,
          };

          // 收集DOM结构摘要（避免过大）
          // 提取所有可见元素的标签、id、class、关键属性
          const visibleElements = [];
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_ELEMENT,
            null
          );
          let count = 0;
          let node;
          while ((node = walker.nextNode()) && count < 300) {
            const tag = node.tagName.toLowerCase();
            // 跳过script/style/svg等
            if (['script','style','svg','path','noscript','meta','link'].includes(tag)) continue;

            const el = {
              tag,
            };
            if (node.id) el.id = node.id;
            if (node.className && typeof node.className === 'string') el.cls = node.className.substring(0, 80);
            if (node.type) el.type = node.type;
            if (node.name) el.name = node.name;
            if (node.placeholder) el.placeholder = node.placeholder.substring(0, 50);
            if (node.href && tag === 'a') el.href = node.href.substring(0, 120);
            if (node.src) el.src = node.src.substring(0, 120);
            if (node.value && ['input','textarea','select'].includes(tag)) el.val = node.value.substring(0, 50);
            if (node.textContent) {
              const text = node.textContent.trim().substring(0, 60);
              if (text && !['div','span','section','article','main','header','footer','nav','ul','ol','li','table','tbody','thead','tr','td','th','form'].includes(tag)) {
                el.text = text;
              }
            }
            // aria标签
            if (node.getAttribute('aria-label')) el.ariaLabel = node.getAttribute('aria-label');
            if (node.getAttribute('role')) el.role = node.getAttribute('role');
            // data-* 属性
            const dataAttrs = {};
            for (const attr of node.attributes) {
              if (attr.name.startsWith('data-')) {
                dataAttrs[attr.name] = attr.value.substring(0, 50);
              }
            }
            if (Object.keys(dataAttrs).length > 0) el.data = dataAttrs;

            visibleElements.push(el);
            count++;
          }

          info.domSummary = visibleElements;
          return info;
        })()
      `)
      return context
    } catch (e) {
      return { url: '', title: '', domSummary: [], error: e.message }
    }
  }

  /**
   * 构建发送给LLM的prompt，要求返回可注入的JS代码
   * 支持会话上下文：将之前的对话历史一并发送
   */
  buildActionPrompt(userInstruction, pageContext) {
    const systemPrompt = `你是一个网页自动化专家。用户会描述他们想在当前网页上实现的功能，你需要根据页面DOM结构生成一段JavaScript代码，注入到页面中执行以实现该功能。

## 规则
1. 只返回可执行的JavaScript代码，用\`\`\`javascript和\`\`\`包裹
2. 代码必须自包含、可直接在浏览器控制台运行
3. 优先使用document.querySelector / querySelectorAll定位元素
4. 如果需要等待元素加载，使用MutationObserver或setTimeout
5. 操作完成后通过 window.__actionResult = { success: true, message: '...' } 返回结果
6. 如果无法实现，返回 window.__actionResult = { success: false, message: '原因' }
7. 不要使用alert/prompt/confirm，改用DOM操作展示信息
8. 代码要健壮，做好null检查和异常处理
9. 如果需要添加UI元素，使用内联样式确保显示正确
10. 尽量精简代码，避免冗余

## 当前页面信息
URL: ${pageContext?.url || '未知'}
标题: ${pageContext?.title || '未知'}

## 页面DOM结构摘要
${JSON.stringify(pageContext?.domSummary || [], null, 2)}`

    // 如果有会话上下文，更新system并追加用户消息
    if (this.sessionMessages.length > 0) {
      // 更新system消息（页面可能已变化）
      this.sessionMessages[0] = { role: 'system', content: systemPrompt }
      this.sessionMessages.push({ role: 'user', content: userInstruction })
      // 限制上下文长度
      this._trimSession()
      return [...this.sessionMessages]
    }

    // 首次对话
    this.sessionMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInstruction },
    ]
    return [...this.sessionMessages]
  }

  /**
   * 将助手回复加入会话上下文
   */
  addAssistantReply(reply) {
    this.sessionMessages.push({ role: 'assistant', content: reply })
    this._trimSession()
  }

  /**
   * 裁剪会话上下文，保留system + 最近的对话轮次
   */
  _trimSession() {
    if (this.sessionMessages.length <= this.maxSessionMessages) return
    // 保留system消息 + 最近的对话
    const system = this.sessionMessages[0]
    const rest = this.sessionMessages.slice(1)
    const keep = rest.slice(-this.maxSessionMessages + 1)
    this.sessionMessages = [system, ...keep]
  }

  /**
   * 清空会话上下文（新会话）
   */
  clearSession() {
    this.sessionMessages = []
  }

  /**
   * 获取当前会话上下文
   */
  getSession() {
    return this.sessionMessages
  }

  /**
   * 从LLM回复中提取JS代码
   */
  extractJsCode(reply) {
    // 尝试提取 ```javascript ... ``` 代码块
    const codeBlockMatch = reply.match(/```(?:javascript|js)\s*\n([\s\S]*?)```/)
    if (codeBlockMatch) return codeBlockMatch[1].trim()

    // 尝试提取 ``` ... ``` 代码块
    const genericMatch = reply.match(/```\s*\n([\s\S]*?)```/)
    if (genericMatch) {
      const code = genericMatch[1].trim()
      // 简单判断是否像JS代码
      if (code.includes('document.') || code.includes('window.') || code.includes('function') ||
          code.includes('const ') || code.includes('let ') || code.includes('var ')) {
        return code
      }
    }

    // 如果整个回复看起来就是代码
    const trimmed = reply.trim()
    if (trimmed.includes('document.') || trimmed.includes('window.')) {
      return trimmed
    }

    return null
  }

  /**
   * 等待页面加载完成
   * @param {object} browserView - Electron BrowserView
   * @param {number} timeout - 最大等待时间(ms)
   */
  async waitForPageLoad(browserView, timeout = 15000) {
    if (!browserView) return

    const webContents = browserView.webContents

    // 如果页面正在加载，等待完成
    if (webContents.isLoading()) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(), timeout)
        webContents.once('did-finish-load', () => {
          clearTimeout(timer)
          // 额外等待确保DOM就绪
          setTimeout(resolve, 500)
        })
        // 也监听 did-navigate 事件（某些页面不触发 did-finish-load）
        webContents.once('did-navigate', () => {
          clearTimeout(timer)
          setTimeout(resolve, 500)
        })
      })
    }

    // 页面已加载，等待一小段时间确保DOM稳定
    await new Promise(r => setTimeout(r, 200))
  }

  /**
   * 在BrowserView中执行JS代码（支持页面导航感知）
   */
  async executeInPage(browserView, jsCode) {
    if (!browserView) {
      return { success: false, error: '没有打开的页面' }
    }

    const webContents = browserView.webContents
    const urlBefore = webContents.getURL()

    try {
      // 先等待页面加载完成（避免在页面加载中执行）
      await this.waitForPageLoad(browserView)

      // 清除上次结果
      await webContents.executeJavaScript('delete window.__actionResult')

      // 执行代码
      await webContents.executeJavaScript(jsCode)

      // 检查是否发生了导航
      const urlAfter = webContents.getURL()
      const navigated = urlBefore !== urlAfter || webContents.isLoading()

      if (navigated) {
        // 页面导航了，等待新页面加载
        await this.waitForPageLoad(browserView)
        return {
          success: true,
          message: '代码执行后页面发生了导航，新页面已加载完成',
          navigated: true,
          newUrl: webContents.getURL(),
          newTitle: webContents.getTitle(),
        }
      }

      // 没有导航，等待结果（最多10秒）
      const startTime = Date.now()
      while (Date.now() - startTime < 10000) {
        const result = await webContents.executeJavaScript(
          'window.__actionResult || null'
        )
        if (result) {
          return result
        }
        // 每次检查前也看看是否导航了
        if (webContents.getURL() !== urlAfter || webContents.isLoading()) {
          await this.waitForPageLoad(browserView)
          return {
            success: true,
            message: '代码执行后页面发生了导航，新页面已加载完成',
            navigated: true,
            newUrl: webContents.getURL(),
            newTitle: webContents.getTitle(),
          }
        }
        await new Promise(r => setTimeout(r, 300))
      }

      return { success: true, message: '代码已执行（未返回明确结果）' }
    } catch (e) {
      // 执行出错，可能是页面导航导致的上下文丢失
      if (webContents.isLoading()) {
        await this.waitForPageLoad(browserView)
        return {
          success: true,
          message: '代码执行触发了页面导航，新页面已加载',
          navigated: true,
          newUrl: webContents.getURL(),
          newTitle: webContents.getTitle(),
        }
      }
      return { success: false, error: e.message }
    }
  }

  /**
   * 记录操作历史
   */
  addHistory(entry) {
    this.history.push({
      ...entry,
      timestamp: Date.now(),
    })
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory)
    }
  }

  getHistory() {
    return this.history
  }

  clearHistory() {
    this.history = []
  }
}

module.exports = ActionExecutor
