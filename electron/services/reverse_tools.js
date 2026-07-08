// ============ 逆向分析专用工具集 ============
// 独立于 agent_runner.js 的工具集，专门用于逆向分析场景
// 复用 payloadStore / workingMemory 等基础设施

const { fetchWithTimeout, safeJsonStringify } = require('./utils')
const networkCapture = require('./network_capture')

// 逆向专用工具定义（OpenAI Function Calling 格式）
const REVERSE_TOOLS = [
  {
    name: 'get_captured_requests',
    description: '获取已捕获的网络请求列表（含请求体和响应体）。逆向分析的核心数据来源。需要先调用 start_capture 开始捕获',
    parameters: {
      type: 'object',
      properties: {
        urlFilter: { type: 'string', description: 'URL 关键词过滤（如 api/sign、/login 等），空字符串返回全部' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP 方法过滤' },
        resourceType: { type: 'string', enum: ['XHR', 'Fetch', 'Script', 'Doc', 'Stylesheet', 'Image', ''], description: '资源类型过滤，空字符串默认只看 XHR/Fetch/Script' },
        includeBody: { type: 'boolean', description: '是否包含请求体/响应体（默认 true）。分析参数加密时建议 true' },
        limit: { type: 'number', description: '最多返回多少条（默认 50）' },
      },
    },
  },
  {
    name: 'fetch_script_source',
    description: '获取指定 JS 文件的完整源码（主进程发起请求，突破 CORS 限制）。用于分析加密算法实现',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'JS 文件的完整 URL' },
        maxChars: { type: 'number', description: '最大返回字符数，默认 50000（超出截断）' },
      },
      required: ['url'],
    },
  },
  {
    name: 'replay_request',
    description: '重放网络请求，可修改参数/headers验证逆向结果。对比原始响应可验证加密算法正确性',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '请求 URL' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP 方法' },
        headers: { type: 'object', description: '请求头键值对' },
        body: { type: 'string', description: '请求体（字符串形式）' },
        timeout: { type: 'number', description: '超时时间（毫秒），默认 30000' },
      },
      required: ['url', 'method'],
    },
  },
  {
    name: 'execute_js',
    description: '在页面上下文执行任意 JS 代码。用于调用页面内的加密函数、提取变量、调试逻辑。代码运行在 async 函数体中，必须用 return 返回结果',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 JS 代码（async function 体），必须 return 结果' },
      },
      required: ['code'],
    },
  },
  {
    name: 'read_page_content',
    description: '读取当前页面的标题和正文内容',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_page_html',
    description: '获取页面 HTML 源码（可指定选择器获取局部 HTML）',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器，空则获取整个页面 HTML' },
      },
    },
  },
  {
    name: 'finish_task',
    description: '完成逆向分析，输出完整分析报告',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '逆向分析总结报告（包含加密算法、关键函数位置、验证结果）' },
        data_refs: { type: 'array', items: { type: 'string' }, description: '引用的数据 ID 列表' },
      },
      required: ['summary'],
    },
  },
]

/**
 * 执行逆向分析工具
 * @param {string} toolName - 工具名
 * @param {object} args - 工具参数
 * @param {object} ctx - 上下文 { webContents, tabManager, tabId, payloadStore, workingMemory }
 * @returns {Promise<string>} JSON 字符串结果
 */
async function executeReverseTool(toolName, args, ctx) {
  const { webContents, tabManager, tabId, payloadStore, workingMemory } = ctx
  const a = args || {}

  switch (toolName) {
    case 'get_captured_requests': {
      if (!webContents) return JSON.stringify({ ok: false, error: '无可用 webContents' })
      const result = networkCapture.getRequests(webContents, {
        urlFilter: a.urlFilter || '',
        method: a.method || '',
        resourceType: a.resourceType || '',
        includeBody: a.includeBody !== false,
        limit: a.limit || 50,
      })
      if (!result.success) return JSON.stringify({ ok: false, error: result.error })

      // 大数据存入 payloadStore
      const itemsStr = safeJsonStringify(result.requests)
      if (itemsStr.length > 1500 && payloadStore) {
        try {
          const storeId = await payloadStore.add('get_captured_requests', result.requests, '', {
            count: result.count, schema: { url: 'string', method: 'string', postData: 'string', responseBody: 'string' },
          })
          if (storeId) {
            workingMemory?.addDataRef('get_captured_requests', storeId, result.count, `捕获请求 ${result.count} 条`)
            return JSON.stringify({
              ok: true,
              count: result.count,
              total: result.total,
              storeId,
              hint: `已捕获 ${result.count} 条请求，完整数据已存储(ID:${storeId})。可用 fetch_script_source 拉取相关 JS 分析加密逻辑`,
              sample: result.requests.slice(0, 3).map(r => ({
                url: r.url, method: r.method, status: r.status,
                hasPostData: r.hasPostData, postDataPreview: r.postData?.slice(0, 100),
                responseBodyPreview: r.responseBody?.slice(0, 100),
              })),
            })
          }
        } catch (e) { /* 存储失败则全量返回 */ }
      }
      return itemsStr
    }

    case 'fetch_script_source': {
      const url = a.url
      if (!url) return JSON.stringify({ ok: false, error: '缺少 url 参数' })
      const maxChars = a.maxChars || 50000
      try {
        const response = await fetchWithTimeout(url, { method: 'GET' }, 30000)
        const text = await response.text()
        const truncated = text.length > maxChars
        const code = truncated ? text.slice(0, maxChars) + '\n...[截断]' : text

        // 大文件存入 payloadStore
        if (text.length > 1500 && payloadStore) {
          try {
            const storeId = await payloadStore.add('fetch_script_source', text, '', {
              count: 1, schema: { code: 'string', url: 'string', length: 'number' },
            })
            if (storeId) {
              workingMemory?.addDataRef('fetch_script_source', storeId, 1, `JS源码: ${url}`)
              return JSON.stringify({
                ok: true,
                url,
                length: text.length,
                truncated,
                storeId,
                preview: code.slice(0, 2000),
                hint: `JS 源码已存储(ID:${storeId})，长度 ${text.length} 字符。预览前 2000 字符，完整源码可通过 data_refs=["${storeId}"] 引用`,
              })
            }
          } catch (e) { /* fall through */ }
        }
        return JSON.stringify({ ok: true, url, length: text.length, truncated, code })
      } catch (e) {
        return JSON.stringify({ ok: false, error: `拉取 JS 失败: ${e.message}`, url })
      }
    }

    case 'replay_request': {
      const { url, method, headers = {}, body, timeout = 30000 } = a
      if (!url || !method) return JSON.stringify({ ok: false, error: '缺少 url 或 method' })
      try {
        const fetchOptions = {
          method: method.toUpperCase(),
          headers,
          timeout,
        }
        if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
          fetchOptions.body = body
        }
        const response = await fetchWithTimeout(url, fetchOptions, timeout)
        const respText = await response.text()
        const respHeaders = {}
        response.headers.forEach((v, k) => { respHeaders[k] = v })

        const result = {
          ok: true,
          url,
          method: method.toUpperCase(),
          status: response.status,
          statusText: response.statusText,
          respHeaders,
          body: respText.length > 20000 ? respText.slice(0, 20000) + '\n...[截断]' : respText,
          bodyLength: respText.length,
          truncated: respText.length > 20000,
        }

        // 大响应存入 payloadStore
        if (respText.length > 1500 && payloadStore) {
          try {
            const storeId = await payloadStore.add('replay_request', { request: { url, method, headers, body }, response: { status: response.status, headers: respHeaders, body: respText } }, '', {
              count: 1, schema: { request: 'object', response: 'object' },
            })
            if (storeId) {
              workingMemory?.addDataRef('replay_request', storeId, 1, `重放 ${method} ${url}`)
              result.storeId = storeId
              result.hint = `完整请求/响应已存储(ID:${storeId})，可在 finish_task 中通过 data_refs 引用`
            }
          } catch (e) { /* 忽略 */ }
        }
        return JSON.stringify(result)
      } catch (e) {
        return JSON.stringify({ ok: false, error: `重放失败: ${e.message}`, url, method })
      }
    }

    case 'execute_js': {
      if (!webContents) return JSON.stringify({ ok: false, error: '无可用 webContents' })
      try {
        const code = a.code
        if (!code) return JSON.stringify({ ok: false, error: '缺少 code 参数' })
        // 使用 new AsyncFunction 包装执行（与 generate_script 一致）
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
        const fn = new AsyncFunction(code)
        const result = await webContents.executeJavaScript(`(${fn.toString()})()`)
        const resultStr = safeJsonStringify(result)
        if (resultStr.length > 1500 && payloadStore) {
          try {
            const storeId = await payloadStore.add('execute_js', result, '', { count: 1 })
            if (storeId) {
              workingMemory?.addDataRef('execute_js', storeId, 1, '执行JS结果')
              return JSON.stringify({
                ok: true, storeId,
                preview: resultStr.slice(0, 2000),
                hint: `执行结果已存储(ID:${storeId})`,
              })
            }
          } catch (e) { /* fall through */ }
        }
        return resultStr
      } catch (e) {
        return JSON.stringify({ ok: false, error: `JS 执行失败: ${e.message}` })
      }
    }

    case 'read_page_content': {
      if (!webContents) return JSON.stringify({ ok: false, error: '无可用 webContents' })
      try {
        const result = await webContents.executeJavaScript(`({
          url: location.href,
          title: document.title,
          content: (document.body?.innerText || '').substring(0, 10000),
        })`)
        return JSON.stringify(result)
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message })
      }
    }

    case 'get_page_html': {
      if (!webContents) return JSON.stringify({ ok: false, error: '无可用 webContents' })
      try {
        const selector = a.selector || ''
        const html = await webContents.executeJavaScript(
          selector
            ? `(document.querySelector(${JSON.stringify(selector)})?.outerHTML || '').substring(0, 50000)`
            : `document.documentElement.outerHTML.substring(0, 50000)`
        )
        return JSON.stringify({ ok: true, html, selector: selector || 'html' })
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message })
      }
    }

    case 'finish_task': {
      // finish_task 由 reverse_runner 单独处理，这里不会走到
      return JSON.stringify({ ok: true })
    }

    default:
      return JSON.stringify({ ok: false, error: `未知工具: ${toolName}` })
  }
}

module.exports = { REVERSE_TOOLS, executeReverseTool }
