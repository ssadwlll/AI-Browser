// 报告模板定义（内置 4 个模板）
// 可从后端 report_templates 表加载（GET /api/report-templates），加载失败时降级使用内置模板
// 远程模板优先级高于内置模板（同 ID 时远程覆盖内置）
// 模板语法：Handlebars 兼容（{{var}}、{{#each}}、{{#if}}、{{this}}、{{@index}}）

export const BUILTIN_TEMPLATES = [
  {
    id: 'news_card_list',
    name: '新闻卡片列表',
    description: '适合新闻/文章类数据，每条一张卡片，含标题、链接、来源、时间、摘要',
    fields: [
      { key: 'title', label: '标题', required: true },
      { key: 'url', label: '链接', required: false },
      { key: 'summary', label: '摘要', required: false },
      { key: 'source', label: '来源', required: false },
      { key: 'date', label: '时间', required: false },
    ],
    dataKind: 'array',
    template: `
<div class="report-news-list">
  {{#each items}}
  <div class="news-card">
    <div class="news-card-header">
      <span class="news-card-index">{{@index}}</span>
      {{#if url}}<h3><a href="{{url}}" target="_blank">{{title}}</a></h3>{{else}}<h3>{{title}}</h3>{{/if}}
    </div>
    {{#if source}}
    <div class="news-card-meta">
      {{#if source}}<span class="meta-source">{{source}}</span>{{/if}}
      {{#if date}}<span class="meta-date">{{date}}</span>{{/if}}
    </div>
    {{/if}}
    {{#if summary}}<div class="news-card-summary">{{summary}}</div>{{/if}}
  </div>
  {{/each}}
</div>`,
    css: `
.report-news-list { display: flex; flex-direction: column; gap: 12px; }
.news-card { background: #fff; border: 1px solid #e5e5e5; border-left: 3px solid #6841ea; border-radius: 8px; padding: 14px 16px; }
.news-card-header { display: flex; align-items: baseline; gap: 8px; }
.news-card-index { display: inline-block; background: #6841ea; color: #fff; width: 22px; height: 22px; border-radius: 50%; text-align: center; line-height: 22px; font-size: 11px; font-weight: 600; flex-shrink: 0; }
.news-card-header h3 { font-size: 15px; font-weight: 600; color: #262626; margin: 0; flex: 1; }
.news-card-header h3 a { color: #262626; text-decoration: none; }
.news-card-header h3 a:hover { color: #6841ea; }
.news-card-meta { display: flex; gap: 12px; margin-top: 6px; font-size: 12px; color: #8c8c8c; }
.news-card-summary { margin-top: 8px; padding: 10px 12px; background: #f8f9fc; border-radius: 6px; font-size: 13px; color: #595959; line-height: 1.6; }
`,
  },
  {
    id: 'data_table',
    name: '数据表格',
    description: '适合结构化数据，表格展示所有字段',
    fields: null,
    dataKind: 'array',
    template: `
<table class="report-data-table">
  <thead>
    <tr>
      <th>#</th>
      {{#each headers}}<th>{{this}}</th>{{/each}}
    </tr>
  </thead>
  <tbody>
    {{#each rows}}
    <tr>
      <td class="row-idx">{{@index}}</td>
      {{#each this}}<td>{{this}}</td>{{/each}}
    </tr>
    {{/each}}
  </tbody>
</table>`,
    css: `
.report-data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.report-data-table th { background: #f5f5f5; padding: 8px 10px; text-align: left; font-weight: 600; color: #262626; border: 1px solid #e5e5e5; }
.report-data-table td { padding: 8px 10px; border: 1px solid #e5e5e5; color: #595959; vertical-align: top; max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
.report-data-table .row-idx { color: #8c8c8c; width: 36px; text-align: right; }
.report-data-table tr:hover td { background: #fafafa; }
`,
  },
  {
    id: 'timeline',
    name: '时间轴',
    description: '按时间排序展示事件，适合新闻动态、操作记录、变更日志',
    fields: [
      { key: 'title', label: '标题', required: true },
      { key: 'date', label: '时间', required: true },
      { key: 'description', label: '描述', required: false },
      { key: 'url', label: '链接', required: false },
    ],
    dataKind: 'array',
    template: `
<div class="report-timeline">
  {{#each items}}
  <div class="timeline-item">
    <div class="timeline-dot"></div>
    {{#if date}}<div class="timeline-date">{{date}}</div>{{/if}}
    <div class="timeline-content">
      {{#if url}}<h3><a href="{{url}}" target="_blank">{{title}}</a></h3>{{else}}<h3>{{title}}</h3>{{/if}}
      {{#if description}}<p>{{description}}</p>{{/if}}
    </div>
  </div>
  {{/each}}
</div>`,
    css: `
.report-timeline { position: relative; padding-left: 24px; }
.report-timeline::before { content: ''; position: absolute; left: 8px; top: 4px; bottom: 4px; width: 2px; background: #e5e5e5; }
.timeline-item { position: relative; padding-bottom: 18px; }
.timeline-dot { position: absolute; left: -22px; top: 4px; width: 12px; height: 12px; border-radius: 50%; background: #6841ea; border: 2px solid #fff; box-shadow: 0 0 0 2px #6841ea; }
.timeline-date { font-size: 12px; color: #6841ea; font-weight: 600; margin-bottom: 4px; }
.timeline-content { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 10px 14px; }
.timeline-content h3 { font-size: 14px; font-weight: 600; color: #262626; margin: 0 0 4px; }
.timeline-content h3 a { color: #262626; text-decoration: none; }
.timeline-content h3 a:hover { color: #6841ea; }
.timeline-content p { font-size: 13px; color: #595959; line-height: 1.6; margin: 4px 0 0; }
`,
  },
  {
    id: 'product_grid',
    name: '商品列表',
    description: '网格布局展示商品，含图片、标题、价格、链接',
    fields: [
      { key: 'title', label: '商品名称', required: true },
      { key: 'image', label: '图片URL', required: false },
      { key: 'price', label: '价格', required: false },
      { key: 'url', label: '链接', required: false },
      { key: 'description', label: '描述', required: false },
    ],
    dataKind: 'array',
    template: `
<div class="report-product-grid">
  {{#each items}}
  <div class="product-card">
    {{#if url}}<a href="{{url}}" target="_blank" class="product-link">{{/if}}
      {{#if image}}<div class="product-image"><img src="{{image}}" alt="{{title}}" loading="lazy"></div>{{/if}}
      <div class="product-info">
        <h3 class="product-title">{{title}}</h3>
        {{#if price}}<div class="product-price">¥{{price}}</div>{{/if}}
        {{#if description}}<p class="product-desc">{{description}}</p>{{/if}}
      </div>
    {{#if url}}</a>{{/if}}
  </div>
  {{/each}}
</div>`,
    css: `
.report-product-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.product-card { background: #fff; border: 1px solid #e5e5e5; border-radius: 10px; overflow: hidden; transition: box-shadow 0.2s; }
.product-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
.product-link { display: block; text-decoration: none; color: inherit; }
.product-image { width: 100%; height: 160px; background: #f5f5f5; overflow: hidden; }
.product-image img { width: 100%; height: 100%; object-fit: cover; }
.product-info { padding: 10px 12px; }
.product-title { font-size: 14px; font-weight: 600; color: #262626; margin: 0 0 6px; line-height: 1.4; }
.product-price { font-size: 16px; font-weight: 700; color: #ea3639; }
.product-desc { font-size: 12px; color: #8c8c8c; margin: 4px 0 0; line-height: 1.5; }
`,
  },
]

// ============ 远程模板加载（带缓存和降级）============

let _remoteTemplates = null
let _remoteLoadedAt = 0
const REMOTE_CACHE_TTL = 5 * 60 * 1000

export async function loadRemoteTemplates(fetcher) {
  if (_remoteTemplates && Date.now() - _remoteLoadedAt < REMOTE_CACHE_TTL) {
    return getMergedTemplates()
  }
  try {
    const remote = await fetcher()
    if (Array.isArray(remote) && remote.length > 0) {
      _remoteTemplates = remote
      _remoteLoadedAt = Date.now()
    } else {
      _remoteTemplates = []
      _remoteLoadedAt = Date.now()
    }
  } catch (e) {
    _remoteTemplates = []
    _remoteLoadedAt = Date.now()
  }
  return getMergedTemplates()
}

export function getMergedTemplates() {
  if (!_remoteTemplates || _remoteTemplates.length === 0) return BUILTIN_TEMPLATES
  const builtinIds = new Set(BUILTIN_TEMPLATES.map(t => t.id))
  const remoteOnly = _remoteTemplates.filter(t => !builtinIds.has(t.id))
  const overridden = BUILTIN_TEMPLATES.map(b => {
    const remote = _remoteTemplates.find(r => r.id === b.id)
    return remote || b
  })
  return [...overridden, ...remoteOnly]
}

export function getTemplateById(id) {
  if (_remoteTemplates) {
    const remote = _remoteTemplates.find(t => t.id === id)
    if (remote) return remote
  }
  return BUILTIN_TEMPLATES.find(t => t.id === id) || null
}

export function getTemplateList() {
  return getMergedTemplates().map(t => ({ id: t.id, name: t.name, description: t.description, fields: t.fields }))
}
