-- 报告模板表
-- 用于 render_report 工具，AI 选模板 + 框架套模板渲染数据报告
-- 模板语法：Handlebars 兼容（{{var}}、{{#each}}、{{#if}}、{{this}}、{{@index}}）
CREATE TABLE IF NOT EXISTS report_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  template_id VARCHAR(50) NOT NULL UNIQUE COMMENT '模板标识，如 news_card_list',
  name VARCHAR(100) NOT NULL COMMENT '模板名称',
  description TEXT COMMENT '模板描述',
  fields JSON COMMENT '字段定义，供 AI 做字段映射参考',
  data_kind VARCHAR(20) DEFAULT 'array' COMMENT '数据形态：array / object',
  template TEXT NOT NULL COMMENT 'Handlebars 兼容的 HTML 模板',
  css TEXT COMMENT '模板样式',
  sort_order INT DEFAULT 0 COMMENT '排序',
  status ENUM('draft', 'published', 'archived') DEFAULT 'published',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='报告渲染模板';

-- ============ 预置常见模板 ============

-- 1. 新闻卡片列表
INSERT INTO report_templates (template_id, name, description, fields, data_kind, template, css, sort_order, status) VALUES
('news_card_list', '新闻卡片列表', '适合新闻/文章类数据，每条一张卡片，含标题、链接、来源、时间、摘要',
 JSON_ARRAY(
   JSON_OBJECT('key','title','label','标题','required',true),
   JSON_OBJECT('key','url','label','链接','required',false),
   JSON_OBJECT('key','summary','label','摘要','required',false),
   JSON_OBJECT('key','source','label','来源','required',false),
   JSON_OBJECT('key','date','label','时间','required',false)
 ),
 'array',
 '<div class="report-news-list">
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
</div>',
 '.report-news-list { display: flex; flex-direction: column; gap: 12px; }
.news-card { background: #fff; border: 1px solid #e5e5e5; border-left: 3px solid #6841ea; border-radius: 8px; padding: 14px 16px; }
.news-card-header { display: flex; align-items: baseline; gap: 8px; }
.news-card-index { display: inline-block; background: #6841ea; color: #fff; width: 22px; height: 22px; border-radius: 50%; text-align: center; line-height: 22px; font-size: 11px; font-weight: 600; flex-shrink: 0; }
.news-card-header h3 { font-size: 15px; font-weight: 600; color: #262626; margin: 0; flex: 1; }
.news-card-header h3 a { color: #262626; text-decoration: none; }
.news-card-header h3 a:hover { color: #6841ea; }
.news-card-meta { display: flex; gap: 12px; margin-top: 6px; font-size: 12px; color: #8c8c8c; }
.news-card-summary { margin-top: 8px; padding: 10px 12px; background: #f8f9fc; border-radius: 6px; font-size: 13px; color: #595959; line-height: 1.6; }',
 1, 'published');

-- 2. 数据表格
INSERT INTO report_templates (template_id, name, description, fields, data_kind, template, css, sort_order, status) VALUES
('data_table', '数据表格', '适合结构化数据，表格展示所有字段',
 NULL,
 'array',
 '<table class="report-data-table">
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
</table>',
 '.report-data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.report-data-table th { background: #f5f5f5; padding: 8px 10px; text-align: left; font-weight: 600; color: #262626; border: 1px solid #e5e5e5; }
.report-data-table td { padding: 8px 10px; border: 1px solid #e5e5e5; color: #595959; vertical-align: top; max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
.report-data-table .row-idx { color: #8c8c8c; width: 36px; text-align: right; }
.report-data-table tr:hover td { background: #fafafa; }',
 2, 'published');

-- 3. 时间轴
INSERT INTO report_templates (template_id, name, description, fields, data_kind, template, css, sort_order, status) VALUES
('timeline', '时间轴', '按时间排序展示事件，适合新闻动态、操作记录、变更日志',
 JSON_ARRAY(
   JSON_OBJECT('key','title','label','标题','required',true),
   JSON_OBJECT('key','date','label','时间','required',true),
   JSON_OBJECT('key','description','label','描述','required',false),
   JSON_OBJECT('key','url','label','链接','required',false)
 ),
 'array',
 '<div class="report-timeline">
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
</div>',
 '.report-timeline { position: relative; padding-left: 24px; }
.report-timeline::before { content: ""; position: absolute; left: 8px; top: 4px; bottom: 4px; width: 2px; background: #e5e5e5; }
.timeline-item { position: relative; padding-bottom: 18px; }
.timeline-dot { position: absolute; left: -22px; top: 4px; width: 12px; height: 12px; border-radius: 50%; background: #6841ea; border: 2px solid #fff; box-shadow: 0 0 0 2px #6841ea; }
.timeline-date { font-size: 12px; color: #6841ea; font-weight: 600; margin-bottom: 4px; }
.timeline-content { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 10px 14px; }
.timeline-content h3 { font-size: 14px; font-weight: 600; color: #262626; margin: 0 0 4px; }
.timeline-content h3 a { color: #262626; text-decoration: none; }
.timeline-content h3 a:hover { color: #6841ea; }
.timeline-content p { font-size: 13px; color: #595959; line-height: 1.6; margin: 4px 0 0; }',
 3, 'published');

-- 4. 商品列表
INSERT INTO report_templates (template_id, name, description, fields, data_kind, template, css, sort_order, status) VALUES
('product_grid', '商品列表', '网格布局展示商品，含图片、标题、价格、链接',
 JSON_ARRAY(
   JSON_OBJECT('key','title','label','商品名称','required',true),
   JSON_OBJECT('key','image','label','图片URL','required',false),
   JSON_OBJECT('key','price','label','价格','required',false),
   JSON_OBJECT('key','url','label','链接','required',false),
   JSON_OBJECT('key','description','label','描述','required',false)
 ),
 'array',
 '<div class="report-product-grid">
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
</div>',
 '.report-product-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.product-card { background: #fff; border: 1px solid #e5e5e5; border-radius: 10px; overflow: hidden; transition: box-shadow 0.2s; }
.product-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
.product-link { display: block; text-decoration: none; color: inherit; }
.product-image { width: 100%; height: 160px; background: #f5f5f5; overflow: hidden; }
.product-image img { width: 100%; height: 100%; object-fit: cover; }
.product-info { padding: 10px 12px; }
.product-title { font-size: 14px; font-weight: 600; color: #262626; margin: 0 0 6px; line-height: 1.4; }
.product-price { font-size: 16px; font-weight: 700; color: #ea3639; }
.product-desc { font-size: 12px; color: #8c8c8c; margin: 4px 0 0; line-height: 1.5; }',
 4, 'published');

-- 5. 统计卡片
INSERT INTO report_templates (template_id, name, description, fields, data_kind, template, css, sort_order, status) VALUES
('statistic_cards', '统计卡片', '网格布局展示关键指标/统计数据，适合 KPI、数据概览',
 JSON_ARRAY(
   JSON_OBJECT('key','label','label','指标名称','required',true),
   JSON_OBJECT('key','value','label','数值','required',true),
   JSON_OBJECT('key','unit','label','单位','required',false),
   JSON_OBJECT('key','trend','label','趋势(up/down/flat)','required',false),
   JSON_OBJECT('key','change','label','变化幅度','required',false)
 ),
 'array',
 '<div class="report-stat-grid">
  {{#each items}}
  <div class="stat-card-tmpl">
    <div class="stat-label-tmpl">{{label}}</div>
    <div class="stat-value-tmpl">{{value}}{{#if unit}}<span class="stat-unit">{{unit}}</span>{{/if}}</div>
    {{#if change}}<div class="stat-change {{trend}}">{{change}}</div>{{/if}}
  </div>
  {{/each}}
</div>',
 '.report-stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.stat-card-tmpl { background: #fff; border: 1px solid #e5e5e5; border-radius: 10px; padding: 16px; }
.stat-label-tmpl { font-size: 12px; color: #8c8c8c; margin-bottom: 8px; }
.stat-value-tmpl { font-size: 28px; font-weight: 700; color: #262626; }
.stat-unit { font-size: 14px; font-weight: 400; color: #8c8c8c; margin-left: 4px; }
.stat-change { font-size: 12px; margin-top: 6px; }
.stat-change.up { color: #52c41a; }
.stat-change.down { color: #ea3639; }
.stat-change.flat { color: #8c8c8c; }',
 5, 'published');

-- 6. 链接列表
INSERT INTO report_templates (template_id, name, description, fields, data_kind, template, css, sort_order, status) VALUES
('link_list', '链接列表', '简洁的链接列表，适合导航、书签、快速链接',
 JSON_ARRAY(
   JSON_OBJECT('key','title','label','标题','required',true),
   JSON_OBJECT('key','url','label','链接','required',false),
   JSON_OBJECT('key','description','label','描述','required',false)
 ),
 'array',
 '<div class="report-link-list">
  {{#each items}}
  <div class="link-item">
    <span class="link-index">{{@index}}</span>
    <div class="link-content">
      {{#if url}}<a href="{{url}}" target="_blank" class="link-title">{{title}}</a>{{else}}<span class="link-title">{{title}}</span>{{/if}}
      {{#if description}}<div class="link-desc">{{description}}</div>{{/if}}
    </div>
  </div>
  {{/each}}
</div>',
 '.report-link-list { display: flex; flex-direction: column; gap: 8px; }
.link-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; transition: border-color 0.2s; }
.link-item:hover { border-color: #6841ea; }
.link-index { display: inline-block; background: #f0f0f0; color: #8c8c8c; width: 22px; height: 22px; border-radius: 4px; text-align: center; line-height: 22px; font-size: 11px; font-weight: 600; flex-shrink: 0; }
.link-content { flex: 1; min-width: 0; }
.link-title { font-size: 14px; font-weight: 500; color: #262626; text-decoration: none; }
.link-title:hover { color: #6841ea; }
.link-desc { font-size: 12px; color: #8c8c8c; margin-top: 2px; }',
 6, 'published');
