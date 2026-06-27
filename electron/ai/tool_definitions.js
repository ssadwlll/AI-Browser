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
  {
    type: 'function',
    function: {
      name: 'click_element',
      description: '点击页面上的指定元素。使用Electron原生事件（mouseMove+mouseDown+mouseUp完整事件链），比JS .click()更可靠。用于与页面交互、触发按钮、打开链接等。',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS选择器，用于定位目标元素，如 "#id"、".class"、"button.submit" 等',
          },
          index: {
            type: 'number',
            description: '当选择器匹配多个元素时，指定点击第几个（从0开始），默认0',
          },
          wait_after_click: {
            type: 'number',
            description: '点击后等待时间（毫秒），默认500ms',
          },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: '在指定输入框中输入文本。使用Electron原生insertText，触发完整input/change事件链，比JS .value=更可靠。用于填写表单、输入搜索词等。',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS选择器，定位输入框元素',
          },
          text: {
            type: 'string',
            description: '要输入的文本内容',
          },
          clear_first: {
            type: 'boolean',
            description: '是否先清空已有内容，默认true',
          },
          index: {
            type: 'number',
            description: '当选择器匹配多个元素时，指定第几个（从0开始），默认0',
          },
        },
        required: ['selector', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description: '模拟键盘按键。使用Electron原生键盘事件。用于按下Enter提交、Escape关闭、Tab切换焦点等。',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: '按键名称，如 "Enter", "Escape", "Tab", "Backspace", "ArrowDown" 等',
          },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for_element',
      description: '等待指定元素出现在页面上。用于等待页面加载完成后再进行后续操作。',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS选择器，用于检测目标元素是否出现',
          },
          timeout: {
            type: 'number',
            description: '等待超时时间（毫秒），默认10000ms',
          },
          visible: {
            type: 'boolean',
            description: '是否要求元素可见（非隐藏），默认true',
          },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for_navigation',
      description: '等待页面导航完成（如点击链接后跳转）。用于在触发导航操作后等待新页面加载。',
      parameters: {
        type: 'object',
        properties: {
          timeout: {
            type: 'number',
            description: '等待超时时间（毫秒），默认30000ms',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_new_tab',
      description: '在新标签页中打开指定URL。用于同时浏览多个页面。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要打开的URL',
          },
          active: {
            type: 'boolean',
            description: '是否切换到新标签页，默认true',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_current_tab',
      description: '关闭当前标签页。如果只有一个标签页则不会关闭。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_images',
      description: '提取当前页面中所有图片的URL和相关信息。用于收集页面的图片资源。',
      parameters: {
        type: 'object',
        properties: {
          min_width: {
            type: 'number',
            description: '最小图片宽度（像素），过滤小图标，默认0',
          },
          min_height: {
            type: 'number',
            description: '最小图片高度（像素），过滤小图标，默认0',
          },
          limit: {
            type: 'number',
            description: '最多返回的图片数量，默认50',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_links',
      description: '提取当前页面中所有链接的URL和文本。用于收集页面的超链接资源。',
      parameters: {
        type: 'object',
        properties: {
          domain_only: {
            type: 'boolean',
            description: '是否只提取同域名链接，默认false',
          },
          filter: {
            type: 'string',
            description: '按URL关键词过滤链接',
          },
          limit: {
            type: 'number',
            description: '最多返回的链接数量，默认100',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll_to_element',
      description: '滚动页面到指定元素位置。用于将目标元素滚动到可视区域。',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS选择器，定位要滚动到的目标元素',
          },
          behavior: {
            type: 'string',
            enum: ['smooth', 'auto'],
            description: '滚动动画方式，smooth为平滑滚动，auto为立即跳转，默认smooth',
          },
          offset: {
            type: 'number',
            description: '距离元素顶部的偏移量（像素），默认0',
          },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hover_element',
      description: '将鼠标悬停在指定元素上（不点击）。使用Electron原生mouseMove事件，触发hover效果、下拉菜单、tooltip等。当需要触发鼠标悬停交互时使用。',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS选择器，定位目标元素',
          },
          index: {
            type: 'number',
            description: '当选择器匹配多个元素时，指定第几个（从0开始），默认0',
          },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll_page',
      description: '滚动页面。使用Electron原生mouseWheel事件，比JS scrollBy更可靠。用于向下或向上滚动页面查看更多内容。',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'number',
            description: '滚动方向：1=向下，-1=向上',
          },
          amount: {
            type: 'number',
            description: '滚动量（像素），默认300',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_option',
      description: '选择下拉框（select元素）的选项。自动触发change和input事件，比JS设置value更可靠。用于选择省份、类别等下拉选项。',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS选择器，定位select元素',
          },
          value: {
            type: 'string',
            description: '要选择的选项值或文本（会自动匹配value或text）',
          },
          index: {
            type: 'number',
            description: '当选择器匹配多个元素时，指定第几个（从0开始），默认0',
          },
        },
        required: ['selector', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upload_file',
      description: '上传文件到页面的file input。使用Electron原生uploadFile API。用于上传图片、文档等文件。',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS选择器，定位input[type=file]元素',
          },
          file_path: {
            type: 'string',
            description: '本地文件的完整路径，如 "C:\\\\Users\\\\test\\\\image.png"',
          },
          index: {
            type: 'number',
            description: '当选择器匹配多个元素时，指定第几个（从0开始），默认0',
          },
        },
        required: ['selector', 'file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_element_text',
      description: '获取指定元素的文本内容。用于读取页面文字、提取数据、验证内容等。比execute_js更简洁。',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS选择器，定位目标元素',
          },
          index: {
            type: 'number',
            description: '当选择器匹配多个元素时，指定第几个（从0开始），默认0',
          },
          max_length: {
            type: 'number',
            description: '最大返回文本长度，默认5000',
          },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_element_attribute',
      description: '获取指定元素的属性值。用于读取href、src、data-id等属性。比execute_js更简洁。',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS选择器，定位目标元素',
          },
          attribute: {
            type: 'string',
            description: '属性名，如 "href", "src", "data-id", "value" 等',
          },
          index: {
            type: 'number',
            description: '当选择器匹配多个元素时，指定第几个（从0开始），默认0',
          },
        },
        required: ['selector', 'attribute'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'drag_and_drop',
      description: '拖拽元素从起点到终点。使用Electron原生鼠标事件链（mouseMove+mouseDown+分步移动+mouseUp），模拟真实拖拽轨迹。用于拖拽排序、滑块验证等场景。',
      parameters: {
        type: 'object',
        properties: {
          from_x: {
            type: 'number',
            description: '起点X坐标',
          },
          from_y: {
            type: 'number',
            description: '起点Y坐标',
          },
          to_x: {
            type: 'number',
            description: '终点X坐标',
          },
          to_y: {
            type: 'number',
            description: '终点Y坐标',
          },
        },
        required: ['from_x', 'from_y', 'to_x', 'to_y'],
      },
    },
  },
]

module.exports = TOOL_DEFINITIONS
