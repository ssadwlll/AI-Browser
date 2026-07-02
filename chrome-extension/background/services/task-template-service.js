// ============ Agent 任务模板库服务 ============
// Feature 7: Agent 任务模板库（Agent Task Template Library）
// 职责：
//   1. 管理可复用的 Agent 任务模板，可实例化为 TodoScheduler 的待办列表
//   2. 模板持久化到 IndexedDB（task_templates store）
//   3. 支持模板的增删改查、分类筛选、关键词搜索
//   4. 支持模板实例化（deep copy stages 供 TodoScheduler.submitTodo 使用）
//   5. 支持模板的 JSON 导入/导出，便于跨设备共享
//   6. 提供内置示例模板作为创建建议（不持久化）
// 说明：
//   - stages 结构与 TodoScheduler 约定一致：
//     [{ stage: 1|2|3, name, subTodos: [{ id, action, description, dataDependKeys, dataOutputKey }] }]
//   - 实例化时必须深拷贝 stages，避免外部修改污染原模板。

import { DBService } from './db-service.js'

// 任务模板存储仓名（keyPath: id, indexes: category / updatedAt）
const TEMPLATE_STORE = 'task_templates'
// 预定义模板分类列表
const PREDEFINED_CATEGORIES = ['数据采集', '页面操作', '内容处理', '自动化', '其他']

export class TaskTemplateService {
  // ============ 模板 CRUD ============

  /**
   * 创建新模板
   * 自动填充 id / createdAt / updatedAt / usageCount=0
   * @param {object} templateData - 模板数据
   *   必填: name, stages
   *   可选: description, category, tags
   * @returns {Promise<{ok:boolean, template?:object, error?:string}>}
   */
  async create(templateData) {
    try {
      if (!templateData || typeof templateData !== 'object') {
        return { ok: false, error: 'templateData 必须为对象' }
      }
      if (!templateData.name || typeof templateData.name !== 'string') {
        return { ok: false, error: '缺少必填字段: name' }
      }
      // 校验 stages 结构：必须是非空数组
      const stagesError = this._validateStages(templateData.stages)
      if (stagesError) return { ok: false, error: stagesError }

      const now = Date.now()
      const template = {
        id: DBService.genId(),
        name: templateData.name,
        description: templateData.description || '',
        category: templateData.category || '其他',
        stages: templateData.stages,
        tags: Array.isArray(templateData.tags) ? templateData.tags : [],
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
      }

      await DBService.put(TEMPLATE_STORE, template)
      console.log(`[TaskTemplateService] 模板已创建: ${template.id} (${template.name})`)
      return { ok: true, template }
    } catch (e) {
      console.error('[TaskTemplateService] create 失败:', e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  /**
   * 更新模板（合并 updates），自动刷新 updatedAt
   * 不允许修改 id / createdAt
   */
  async update(id, updates) {
    try {
      if (!id) return { ok: false, error: '缺少 id' }
      if (!updates || typeof updates !== 'object') return { ok: false, error: 'updates 必须为对象' }

      const existing = await DBService.get(TEMPLATE_STORE, id)
      if (!existing) return { ok: false, error: `模板不存在: ${id}` }

      // 若更新了 stages，需校验结构
      if (updates.stages !== undefined) {
        const stagesError = this._validateStages(updates.stages)
        if (stagesError) return { ok: false, error: stagesError }
      }

      const merged = { ...existing, ...updates, id: existing.id, createdAt: existing.createdAt }
      merged.updatedAt = Date.now()
      // usageCount 由 instantiate 维护，不允许通过 update 直接修改
      if (updates.usageCount !== undefined) merged.usageCount = existing.usageCount

      await DBService.put(TEMPLATE_STORE, merged)
      console.log(`[TaskTemplateService] 模板已更新: ${id}`)
      return { ok: true, template: merged }
    } catch (e) {
      console.error('[TaskTemplateService] update 失败:', e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  /**
   * 删除模板
   */
  async delete(id) {
    try {
      if (!id) return { ok: false, error: '缺少 id' }
      await DBService.del(TEMPLATE_STORE, id)
      console.log(`[TaskTemplateService] 模板已删除: ${id}`)
      return { ok: true }
    } catch (e) {
      console.error('[TaskTemplateService] delete 失败:', e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  /**
   * 获取单个模板
   */
  async get(id) {
    try {
      if (!id) return { ok: false, error: '缺少 id' }
      const template = await DBService.get(TEMPLATE_STORE, id)
      if (!template) return { ok: false, error: `模板不存在: ${id}` }
      return { ok: true, template }
    } catch (e) {
      console.error('[TaskTemplateService] get 失败:', e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  /**
   * 列出全部模板，或按分类筛选
   * 结果按 usageCount 降序排列（高频使用模板靠前）
   * @param {string} [category] - 可选分类，传入则按 category 索引查询
   * @returns {Promise<{ok:boolean, templates?:array, error?:string}>}
   */
  async list(category) {
    try {
      let templates
      if (category) {
        // 按分类索引查询
        templates = await DBService.queryByIndex(TEMPLATE_STORE, 'category', category, 500, 'next')
      } else {
        templates = await DBService.getAll(TEMPLATE_STORE)
      }
      templates = templates || []

      // 首次使用时自动播种内置模板
      if (templates.length === 0 && !category) {
        const builtins = this.getBuiltins()
        const now = Date.now()
        for (const b of builtins) {
          const t = { ...b, id: DBService.genId(), usageCount: 0, createdAt: now, updatedAt: now }
          await DBService.put(TEMPLATE_STORE, t)
          templates.push(t)
        }
        console.log(`[TaskTemplateService] 已播种 ${builtins.length} 个内置模板`)
      }

      // 按 usageCount 降序排列
      templates.sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))
      return { ok: true, templates }
    } catch (e) {
      console.error('[TaskTemplateService] list 失败:', e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  /**
   * 关键词搜索模板（name / description / tags，大小写不敏感）
   * @param {string} keyword - 搜索关键词
   * @returns {Promise<{ok:boolean, templates?:array, error?:string}>}
   */
  async search(keyword) {
    try {
      if (!keyword || typeof keyword !== 'string') {
        return { ok: false, error: 'keyword 必须为非空字符串' }
      }
      const kw = keyword.toLowerCase()
      const all = await DBService.getAll(TEMPLATE_STORE)
      const results = (all || []).filter(t => {
        const name = (t.name || '').toLowerCase()
        const desc = (t.description || '').toLowerCase()
        const tags = Array.isArray(t.tags) ? t.tags.map(x => String(x).toLowerCase()) : []
        return name.includes(kw) || desc.includes(kw) || tags.some(tag => tag.includes(kw))
      })
      // 搜索结果同样按 usageCount 降序
      results.sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))
      return { ok: true, templates: results }
    } catch (e) {
      console.error('[TaskTemplateService] search 失败:', e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  // ============ 模板实例化 ============

  /**
   * 实例化模板：取出模板、usageCount +1、返回 stages 的深拷贝
   * 返回的 stages 可直接传给 TodoScheduler.submitTodo()
   * 深拷贝使用 JSON.parse(JSON.stringify())，避免外部修改污染原模板
   * @param {string} id - 模板 id
   * @returns {Promise<{ok:boolean, stages?:array, template?:object, error?:string}>}
   */
  async instantiate(id) {
    try {
      if (!id) return { ok: false, error: '缺少 id' }
      const template = await DBService.get(TEMPLATE_STORE, id)
      if (!template) return { ok: false, error: `模板不存在: ${id}` }

      // 深拷贝 stages，避免外部修改污染原模板数据
      const stagesCopy = JSON.parse(JSON.stringify(template.stages || []))

      // 使用计数 +1 并持久化
      template.usageCount = (template.usageCount || 0) + 1
      template.updatedAt = Date.now()
      await DBService.put(TEMPLATE_STORE, template)

      console.log(`[TaskTemplateService] 模板已实例化: ${id} (usageCount=${template.usageCount})`)
      return { ok: true, stages: stagesCopy, template }
    } catch (e) {
      console.error('[TaskTemplateService] instantiate 失败:', e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  // ============ 导入 / 导出 ============

  /**
   * 从 JSON 字符串导入模板（校验结构后创建新记录）
   * @param {string} templateJson - 模板 JSON 字符串
   * @returns {Promise<{ok:boolean, template?:object, error?:string}>}
   */
  async importTemplate(templateJson) {
    try {
      if (!templateJson || typeof templateJson !== 'string') {
        return { ok: false, error: 'templateJson 必须为非空字符串' }
      }
      let parsed
      try {
        parsed = JSON.parse(templateJson)
      } catch (e) {
        return { ok: false, error: `JSON 解析失败: ${e.message}` }
      }
      if (!parsed || typeof parsed !== 'object') {
        return { ok: false, error: '导入数据必须是对象' }
      }
      // 校验必填字段
      if (!parsed.name || typeof parsed.name !== 'string') {
        return { ok: false, error: '导入模板缺少必填字段: name' }
      }
      const stagesError = this._validateStages(parsed.stages)
      if (stagesError) return { ok: false, error: stagesError }

      // 导入时忽略原 id/usageCount/createdAt/updatedAt，重新生成
      const now = Date.now()
      const template = {
        id: DBService.genId(),
        name: parsed.name,
        description: parsed.description || '',
        category: parsed.category || '其他',
        stages: parsed.stages,
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
      }

      await DBService.put(TEMPLATE_STORE, template)
      console.log(`[TaskTemplateService] 模板已导入: ${template.id} (${template.name})`)
      return { ok: true, template }
    } catch (e) {
      console.error('[TaskTemplateService] importTemplate 失败:', e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  /**
   * 导出模板为 JSON 字符串
   * @param {string} id - 模板 id
   * @returns {Promise<{ok:boolean, json?:string, error?:string}>}
   */
  async exportTemplate(id) {
    try {
      if (!id) return { ok: false, error: '缺少 id' }
      const template = await DBService.get(TEMPLATE_STORE, id)
      if (!template) return { ok: false, error: `模板不存在: ${id}` }
      const json = JSON.stringify(template, null, 2)
      console.log(`[TaskTemplateService] 模板已导出: ${id}`)
      return { ok: true, json }
    } catch (e) {
      console.error('[TaskTemplateService] exportTemplate 失败:', e)
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }

  // ============ 分类与内置模板 ============

  /**
   * 返回预定义分类列表
   */
  getCategories() {
    return PREDEFINED_CATEGORIES.slice()
  }

  /**
   * 返回内置示例模板（仅作为建议返回，不持久化）
   * 包含：数据采集、页面导航、内容汇总、表单填写 四个示例
   */
  getBuiltins() {
    return [
      // 数据采集模板
      {
        name: '数据采集模板',
        description: '读取页面内容并提取条目列表，适合列表页数据抓取场景',
        category: '数据采集',
        tags: ['采集', '列表', '提取'],
        builtin: true,
        stages: [
          {
            stage: 1,
            name: '页面探索',
            subTodos: [
              { id: 's1-1', action: 'read_page_content', description: '读取页面整体内容', dataDependKeys: [], dataOutputKey: 'page_data' },
              { id: 's1-2', action: 'extract_content', description: '提取条目列表', dataDependKeys: [], dataOutputKey: 'item_list' },
            ],
          },
          {
            stage: 2,
            name: '脚本处理',
            subTodos: [
              { id: 's2-1', action: 'inject_script_1', description: '批量处理详情页数据', dataDependKeys: ['item_list'], dataOutputKey: 'detail_data' },
            ],
          },
          {
            stage: 3,
            name: '结果汇总',
            subTodos: [
              { id: 's3-1', action: 'finish_task', description: '汇总所有采集数据', dataDependKeys: ['item_list', 'detail_data'], dataOutputKey: null },
            ],
          },
        ],
      },
      // 页面导航模板
      {
        name: '页面导航模板',
        description: '导航到目标页面并执行点击操作，适合多页浏览与翻页场景',
        category: '页面操作',
        tags: ['导航', '点击', '翻页'],
        builtin: true,
        stages: [
          {
            stage: 1,
            name: '页面操作',
            subTodos: [
              { id: 's1-1', action: 'navigate_to', description: '导航到目标页面', dataDependKeys: [], dataOutputKey: 'target_page' },
              { id: 's1-2', action: 'click_element', description: '点击翻页按钮加载更多', dataDependKeys: [], dataOutputKey: null },
              { id: 's1-3', action: 'extract_content', description: '提取当前页内容', dataDependKeys: [], dataOutputKey: 'page_content' },
            ],
          },
          {
            stage: 2,
            name: '脚本处理',
            subTodos: [],
          },
          {
            stage: 3,
            name: '结果汇总',
            subTodos: [
              { id: 's3-1', action: 'finish_task', description: '汇总导航采集结果', dataDependKeys: ['page_content'], dataOutputKey: null },
            ],
          },
        ],
      },
      // 内容汇总模板
      {
        name: '内容汇总模板',
        description: '读取页面内容后经脚本处理并输出摘要，适合长文提炼与总结场景',
        category: '内容处理',
        tags: ['汇总', '摘要', '总结'],
        builtin: true,
        stages: [
          {
            stage: 1,
            name: '页面探索',
            subTodos: [
              { id: 's1-1', action: 'read_page_content', description: '读取页面正文内容', dataDependKeys: [], dataOutputKey: 'raw_content' },
            ],
          },
          {
            stage: 2,
            name: '脚本处理',
            subTodos: [
              { id: 's2-1', action: 'inject_script_1', description: '调用脚本生成内容摘要', dataDependKeys: ['raw_content'], dataOutputKey: 'summary' },
            ],
          },
          {
            stage: 3,
            name: '结果汇总',
            subTodos: [
              { id: 's3-1', action: 'finish_task', description: '输出最终摘要结果', dataDependKeys: ['summary'], dataOutputKey: null },
            ],
          },
        ],
      },
      // 表单填写模板
      {
        name: '表单填写模板',
        description: '自动填写表单字段并提交，适合注册/登录/信息录入场景',
        category: '自动化',
        tags: ['表单', '填写', '提交'],
        builtin: true,
        stages: [
          {
            stage: 1,
            name: '表单操作',
            subTodos: [
              { id: 's1-1', action: 'fill_input', description: '填写用户名输入框', dataDependKeys: [], dataOutputKey: null },
              { id: 's1-2', action: 'fill_input', description: '填写密码输入框', dataDependKeys: [], dataOutputKey: null },
              { id: 's1-3', action: 'select_dropdown', description: '选择下拉选项', dataDependKeys: [], dataOutputKey: null },
              { id: 's1-4', action: 'click_element', description: '点击提交按钮', dataDependKeys: [], dataOutputKey: 'submit_result' },
            ],
          },
          {
            stage: 2,
            name: '脚本处理',
            subTodos: [],
          },
          {
            stage: 3,
            name: '结果汇总',
            subTodos: [
              { id: 's3-1', action: 'finish_task', description: '汇总表单提交结果', dataDependKeys: ['submit_result'], dataOutputKey: null },
            ],
          },
        ],
      },
    ]
  }

  // ============ 内部辅助 ============

  /**
   * 校验 stages 结构是否符合 TodoScheduler 约定
   * 必须是非空数组，每个 stage 需包含 stage(1|2|3) 与 subTodos(数组)
   * @param {*} stages
   * @returns {string|null} 校验失败返回错误信息，通过返回 null
   */
  _validateStages(stages) {
    if (!Array.isArray(stages) || stages.length === 0) {
      return 'stages 必须是非空数组'
    }
    for (const s of stages) {
      if (!s || typeof s !== 'object') return 'stages 中存在非对象元素'
      if (![1, 2, 3].includes(s.stage)) return `非法阶段编号: ${s.stage}（应为 1/2/3）`
      if (!Array.isArray(s.subTodos)) return `Stage ${s.stage} 的 subTodos 不是数组`
    }
    return null
  }
}

console.log('[TaskTemplateService] 任务模板服务已加载')
