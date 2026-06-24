/**
 * AI 工具定义 (OpenAI Function Calling 格式)
 * AI 根据用户需求自主决定调用哪些工具，客户端负责执行
 */

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'collect_page_context',
      description: '收集当前页面的上下文信息，包括URL、标题、DOM结构摘要。当需要了解页面内容、分析页面结构、或准备执行操作时调用。',
      parameters: {
        type: 'object',
        properties: {
          max_elements: {
            type: 'number',
            description: '最多收集的DOM元素数量，默认300',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_js',
      description: '在浏览器页面中执行JavaScript代码并返回结果。用于操作页面DOM、提取数据、注入脚本等。代码可通过 window.__actionResult = { success, message, data } 返回结果。',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: '要执行的JavaScript代码',
          },
          description: {
            type: 'string',
            description: '简要描述这段代码的作用',
          },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_network_requests',
      description: '获取当前页面捕获的网络请求数据。用于逆向分析API接口、查看请求参数和响应数据。',
      parameters: {
        type: 'object',
        properties: {
          filter_url: {
            type: 'string',
            description: '按URL关键词过滤请求',
          },
          method: {
            type: 'string',
            description: '按HTTP方法过滤，如 GET、POST',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
          },
          limit: {
            type: 'number',
            description: '最多返回的请求数量，默认20',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate_to',
      description: '导航浏览器到指定URL。用于打开新页面或跳转到目标网址。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要导航到的URL',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_page_scripts',
      description: '提取当前页面加载的所有JavaScript脚本文件信息，包括src地址和内联脚本内容。用于分析页面技术栈和脚本依赖。',
      parameters: {
        type: 'object',
        properties: {
          include_inline: {
            type: 'boolean',
            description: '是否包含内联脚本内容，默认true',
          },
          max_content_length: {
            type: 'number',
            description: '内联脚本内容的最大长度，默认5000字符',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_page_html',
      description: '获取当前页面的完整HTML源代码。用于深度分析页面结构。',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS选择器，只获取匹配元素的HTML。不填则获取整个页面。',
          },
          max_length: {
            type: 'number',
            description: '返回HTML的最大长度，默认50000字符',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: '对当前页面进行截图。用于视觉确认页面状态。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
]

module.exports = TOOL_DEFINITIONS
