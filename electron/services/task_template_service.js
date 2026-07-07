// ============ TaskTemplateService（任务模板管理服务）============
// 管理可复用的 Agent 任务模板，支持变量替换与实例化
//
// 迁移自 chrome-extension/background/services/task-template-service.js
// 改动：
//   - ES Module → CommonJS
//   - IndexedDB → DBService（store=task_templates）
//   - stages 结构 → 模板结构（userMessage + pageContext + variables）
//   - 实例化逻辑：变量替换（{{varName}} → 实际值）
//   - 内置模板：数据采集 / 表单填写 / 页面分析 / 批量下载
//
// 模板数据结构：
//   {
//     id, name, description, category,
//     template: {
//       userMessage,                          // 含 {{var}} 占位符的用户消息
//       pageContext,                           // 页面上下文描述
//       variables: [{ name, description, defaultValue }]
//     },
//     createdAt, updatedAt
//   }

const DBService = require('./db_service')

// 任务模板存储仓名（已在 db_service.js 的 STORES 中定义）
const TEMPLATE_STORE = 'task_templates'
// 预定义模板分类列表
const PREDEFINED_CATEGORIES = ['数据采集', '页面操作', '内容处理', '自动化', '其他']

class TaskTemplateService {
  constructor() {
    this._initialized = false
  }

  /**
   * 初始化：首次使用时自动播种内置模板
   */
  async init() {
    if (this._initialized) return

    // 检查是否已有模板数据，若无则播种内置模板
    const all = await DBService.getAll(TEMPLATE_STORE)
    if (!all || all.length === 0) {
      const builtins = this._getBuiltinTemplates()
      const now = Date.now()
      for (const b of builtins) {
        const t = {
          ...b,
          id: DBService.genId(),
          createdAt: now,
          updatedAt: now,
        }
        await DBService.put(TEMPLATE_STORE, t)
      }
      console.log(`[TaskTemplateService] 已播种 ${builtins.length} 个内置模板`)
    }

    this._initialized = true
  }

  // ============ 模板 CRUD ============

  /**
   * 创建新模板
   * @param {object} templateData - 模板数据
   *   必填: name, template.userMessage
   *   可选: description, category, template.pageContext, template.variables
   * @returns {Promise<object>} 创建的模板对象
   */
  async create(templateData) {
    if (!templateData || typeof templateData !== 'object') {
      throw new Error('templateData 必须为对象')
    }
    if (!templateData.name || typeof templateData.name !== 'string') {
      throw new Error('缺少必填字段: name')
    }
    if (!templateData.template || !templateData.template.userMessage) {
      throw new Error('缺少必填字段: template.userMessage')
    }

    // 校验 variables 结构
    if (templateData.template.variables) {
      const varError = this._validateVariables(templateData.template.variables)
      if (varError) throw new Error(varError)
    }

    const now = Date.now()
    const template = {
      id: DBService.genId(),
      name: templateData.name,
      description: templateData.description || '',
      category: templateData.category || '其他',
      template: {
        userMessage: templateData.template.userMessage,
        pageContext: templateData.template.pageContext || '',
        variables: Array.isArray(templateData.template.variables)
          ? templateData.template.variables
          : [],
      },
      createdAt: now,
      updatedAt: now,
    }

    await DBService.put(TEMPLATE_STORE, template)
    console.log(`[TaskTemplateService] 模板已创建: ${template.id} (${template.name})`)
    return template
  }

  /**
   * 更新模板（合并 updates），自动刷新 updatedAt
   * 不允许修改 id / createdAt
   * @param {string} templateId - 模板 ID
   * @param {object} updates - 更新字段
   * @returns {Promise<object>} 更新后的模板对象
   */
  async update(templateId, updates) {
    if (!templateId) throw new Error('缺少 templateId')
    if (!updates || typeof updates !== 'object') throw new Error('updates 必须为对象')

    const existing = await DBService.get(TEMPLATE_STORE, templateId)
    if (!existing) throw new Error(`模板不存在: ${templateId}`)

    // 若更新了 variables，需校验结构
    if (updates.template && updates.template.variables) {
      const varError = this._validateVariables(updates.template.variables)
      if (varError) throw new Error(varError)
    }

    const merged = { ...existing, ...updates, id: existing.id, createdAt: existing.createdAt }

    // 合并 template 子对象（避免覆盖丢失字段）
    if (updates.template) {
      merged.template = {
        ...existing.template,
        ...updates.template,
      }
    }

    merged.updatedAt = Date.now()
    await DBService.put(TEMPLATE_STORE, merged)

    console.log(`[TaskTemplateService] 模板已更新: ${templateId}`)
    return merged
  }

  /**
   * 删除模板
   * @param {string} templateId - 模板 ID
   * @returns {Promise<boolean>}
   */
  async delete(templateId) {
    if (!templateId) throw new Error('缺少 templateId')
    await DBService.del(TEMPLATE_STORE, templateId)
    console.log(`[TaskTemplateService] 模板已删除: ${templateId}`)
    return true
  }

  /**
   * 获取单个模板
   * @param {string} templateId - 模板 ID
   * @returns {Promise<object|null>}
   */
  async get(templateId) {
    if (!templateId) return null
    return (await DBService.get(TEMPLATE_STORE, templateId)) || null
  }

  /**
   * 列出全部模板，或按分类筛选
   * @param {string} [category] - 可选分类筛选
   * @returns {Promise<object[]>}
   */
  async list(category) {
    await this.init()

    let templates
    if (category) {
      // 按分类索引查询
      templates = await DBService.queryByIndex(TEMPLATE_STORE, 'category', category, 500, 'next')
    } else {
      templates = await DBService.getAll(TEMPLATE_STORE)
    }
    templates = templates || []

    // 按 updatedAt 倒序排列
    templates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return templates
  }

  /**
   * 关键词搜索模板（name / description，大小写不敏感）
   * @param {string} keyword - 搜索关键词
   * @returns {Promise<object[]>}
   */
  async search(keyword) {
    if (!keyword || typeof keyword !== 'string') return []

    const kw = keyword.toLowerCase()
    const all = await DBService.getAll(TEMPLATE_STORE)
    const results = (all || []).filter((t) => {
      const name = (t.name || '').toLowerCase()
      const desc = (t.description || '').toLowerCase()
      return name.includes(kw) || desc.includes(kw)
    })

    results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return results
  }

  // ============ 模板实例化 ============

  /**
   * 实例化模板：替换变量占位符后返回可直接使用的用户消息
   * 变量占位符格式：{{varName}}
   * @param {string} templateId - 模板 ID
   * @param {object} variables - 变量键值对 { varName: value }
   * @returns {Promise<object>} 实例化结果 { userMessage, pageContext, template }
   */
  async instantiate(templateId, variables = {}) {
    if (!templateId) throw new Error('缺少 templateId')

    const template = await DBService.get(TEMPLATE_STORE, templateId)
    if (!template) throw new Error(`模板不存在: ${templateId}`)

    // 合并变量：模板默认值 < 传入值
    const mergedVars = {}
    const templateVars = template.template?.variables || []
    for (const v of templateVars) {
      mergedVars[v.name] = v.defaultValue !== undefined ? v.defaultValue : ''
    }
    Object.assign(mergedVars, variables || {})

    // 深拷贝 userMessage 后替换变量占位符
    let userMessage = template.template.userMessage
    for (const [name, value] of Object.entries(mergedVars)) {
      // 替换 {{name}} 和 {{ name }} 两种格式
      const regex = new RegExp(`\\{\\{\\s*${this._escapeRegExp(name)}\\s*\\}\\}`, 'g')
      userMessage = userMessage.replace(regex, String(value))
    }

    // 检查是否有未替换的占位符
    const unresolved = userMessage.match(/\{\{[^}]+\}\}/g)
    if (unresolved) {
      console.warn(
        `[TaskTemplateService] 实例化后有未解析的变量: ${unresolved.join(', ')}`
      )
    }

    console.log(`[TaskTemplateService] 模板已实例化: ${templateId}`)
    return {
      userMessage,
      pageContext: template.template.pageContext || '',
      template,
      resolvedVariables: mergedVars,
    }
  }

  // ============ 导入 / 导出 ============

  /**
   * 从 JSON 字符串导入模板（校验结构后创建新记录）
   * @param {string} jsonStr - 模板 JSON 字符串
   * @returns {Promise<object>} 创建的模板对象
   */
  async importTemplate(jsonStr) {
    if (!jsonStr || typeof jsonStr !== 'string') {
      throw new Error('jsonStr 必须为非空字符串')
    }

    let parsed
    try {
      parsed = JSON.parse(jsonStr)
    } catch (e) {
      throw new Error(`JSON 解析失败: ${e.message}`)
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('导入数据必须是对象')
    }
    if (!parsed.name || typeof parsed.name !== 'string') {
      throw new Error('导入模板缺少必填字段: name')
    }
    if (!parsed.template || !parsed.template.userMessage) {
      throw new Error('导入模板缺少必填字段: template.userMessage')
    }

    // 校验 variables
    if (parsed.template.variables) {
      const varError = this._validateVariables(parsed.template.variables)
      if (varError) throw new Error(varError)
    }

    // 导入时忽略原 id/createdAt/updatedAt，重新生成
    const now = Date.now()
    const template = {
      id: DBService.genId(),
      name: parsed.name,
      description: parsed.description || '',
      category: parsed.category || '其他',
      template: {
        userMessage: parsed.template.userMessage,
        pageContext: parsed.template.pageContext || '',
        variables: Array.isArray(parsed.template.variables)
          ? parsed.template.variables
          : [],
      },
      createdAt: now,
      updatedAt: now,
    }

    await DBService.put(TEMPLATE_STORE, template)
    console.log(`[TaskTemplateService] 模板已导入: ${template.id} (${template.name})`)
    return template
  }

  /**
   * 导出模板为 JSON 字符串
   * @param {string} templateId - 模板 ID
   * @returns {Promise<string>} JSON 字符串
   */
  async exportTemplate(templateId) {
    if (!templateId) throw new Error('缺少 templateId')
    const template = await DBService.get(TEMPLATE_STORE, templateId)
    if (!template) throw new Error(`模板不存在: ${templateId}`)

    const json = JSON.stringify(template, null, 2)
    console.log(`[TaskTemplateService] 模板已导出: ${templateId}`)
    return json
  }

  // ============ 分类与内置模板 ============

  /**
   * 返回预定义分类列表
   * @returns {string[]}
   */
  getCategories() {
    return PREDEFINED_CATEGORIES.slice()
  }

  /**
   * 返回内置示例模板（4 个）
   * 1. 数据采集 - 采集页面数据并导出
   * 2. 表单填写 - 自动填写表单
   * 3. 页面分析 - 分析页面结构和技术栈
   * 4. 批量下载 - 批量下载页面图片
   * @returns {object[]}
   */
  _getBuiltinTemplates() {
    return [
      // 1. 数据采集模板
      {
        name: '数据采集',
        description: '采集页面数据并导出为结构化格式，适合列表页数据抓取场景',
        category: '数据采集',
        builtin: true,
        template: {
          userMessage:
            '请采集当前页面的数据，提取以下字段：{{fields}}。' +
            '数据范围：{{scope}}。将结果整理为表格格式并导出。',
          pageContext: '当前页面为列表页，包含多条数据记录',
          variables: [
            { name: 'fields', description: '需要采集的字段列表', defaultValue: '标题、链接、时间' },
            { name: 'scope', description: '数据采集范围', defaultValue: '当前页面所有条目' },
          ],
        },
      },
      // 2. 表单填写模板
      {
        name: '表单填写',
        description: '自动填写页面表单字段并提交，适合注册/登录/信息录入场景',
        category: '自动化',
        builtin: true,
        template: {
          userMessage:
            '请自动填写当前页面的表单，填写内容如下：\n' +
            '用户名：{{username}}\n' +
            '密码：{{password}}\n' +
            '其他字段使用默认值。填写完成后点击提交按钮。',
          pageContext: '当前页面包含需要填写的表单',
          variables: [
            { name: 'username', description: '用户名', defaultValue: 'test_user' },
            { name: 'password', description: '密码', defaultValue: 'test_pass_123' },
          ],
        },
      },
      // 3. 页面分析模板
      {
        name: '页面分析',
        description: '分析页面结构和技术栈，输出页面组成与使用技术的分析报告',
        category: '内容处理',
        builtin: true,
        template: {
          userMessage:
            '请分析当前页面的结构和技术栈，包括：\n' +
            '1. 页面布局结构（{{layoutDepth}}层深度）\n' +
            '2. 使用的前端框架和库\n' +
            '3. 页面性能指标\n' +
            '4. SEO 优化建议\n' +
            '输出详细的分析报告。',
          pageContext: '需要分析的网页',
          variables: [
            { name: 'layoutDepth', description: '布局分析深度', defaultValue: '3' },
          ],
        },
      },
      // 4. 批量下载模板
      {
        name: '批量下载',
        description: '批量下载页面中的图片资源，支持按尺寸和格式筛选',
        category: '数据采集',
        builtin: true,
        template: {
          userMessage:
            '请批量下载当前页面中的所有图片，筛选条件：\n' +
            '图片格式：{{format}}\n' +
            '最小尺寸：{{minSize}}\n' +
            '下载后保存到本地，并生成下载清单。',
          pageContext: '当前页面包含多张图片资源',
          variables: [
            { name: 'format', description: '图片格式筛选', defaultValue: 'jpg,png,webp' },
            { name: 'minSize', description: '最小图片尺寸', defaultValue: '200x200' },
          ],
        },
      },
    ]
  }

  // ============ 内部辅助 ============

  /**
   * 校验 variables 结构
   * 必须是数组，每个元素需包含 name 字段
   * @param {*} variables
   * @returns {string|null} 校验失败返回错误信息，通过返回 null
   */
  _validateVariables(variables) {
    if (!Array.isArray(variables)) {
      return 'variables 必须是数组'
    }
    for (const v of variables) {
      if (!v || typeof v !== 'object') return 'variables 中存在非对象元素'
      if (!v.name || typeof v.name !== 'string') return 'variable 缺少 name 字段'
    }
    return null
  }

  /**
   * 转义正则表达式特殊字符
   * @param {string} str
   * @returns {string}
   */
  _escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
}

module.exports = TaskTemplateService
