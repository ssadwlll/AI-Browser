-- AI Browser 管理后台数据库初始化脚本
-- 使用方法: mysql -u root -p < sql/init.sql

-- 创建数据库（如果不存在）
CREATE DATABASE IF NOT EXISTS aibrowser CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE aibrowser;

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role ENUM('admin', 'developer', 'editor') DEFAULT 'editor',
  status TINYINT DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 脚本分类表
CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  slug VARCHAR(50) NOT NULL UNIQUE,
  description VARCHAR(255),
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 脚本表
CREATE TABLE IF NOT EXISTS scripts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  category_id INT,
  version VARCHAR(20) DEFAULT '1.0.0',
  author_id INT,
  file_path VARCHAR(500) NOT NULL,
  file_size INT DEFAULT 0,
  icon VARCHAR(50) DEFAULT 'code',
  url_pattern VARCHAR(255) DEFAULT '*',
  config_schema JSON,
  params_schema JSON,
  params_data JSON,
  status ENUM('draft', 'published', 'archived') DEFAULT 'draft',
  download_count INT DEFAULT 0,
  tool_type VARCHAR(20) DEFAULT 'js',
  tool_config JSON,
  metadata JSON,
  precheck TEXT,
  vector LONGTEXT COMMENT '1024维embedding向量',
  vector_updated_at TIMESTAMP NULL DEFAULT NULL COMMENT '向量最后生成时间',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 脚本模块表
CREATE TABLE IF NOT EXISTS script_modules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  script_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  code LONGTEXT NOT NULL,
  load_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 使用统计表
CREATE TABLE IF NOT EXISTS usage_stats (
  id INT AUTO_INCREMENT PRIMARY KEY,
  script_id INT NOT NULL,
  user_id INT NOT NULL,
  action ENUM('install', 'run', 'uninstall') NOT NULL,
  duration_ms INT DEFAULT 0,
  success TINYINT DEFAULT 1,
  error_msg TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 插入默认分类
INSERT INTO categories (name, slug, description, sort_order) VALUES
('数据采集', 'data-collection', '网页数据抓取与采集', 1),
('自动化操作', 'automation', '自动填表、签到、发布等', 2),
('页面增强', 'page-enhance', '去广告、暗黑模式、翻译等', 3),
('AI 增强', 'ai-enhance', 'AI 摘要、翻译、改写等', 4),
('内容生产', 'content-production', '排版、发布、多平台分发', 5),
('运营辅助', 'operation', '监控、检测、报告生成', 6)
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- ============ AppKey/AppSecret 管理表 ============
CREATE TABLE IF NOT EXISTS app_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  app_key VARCHAR(32) NOT NULL UNIQUE,
  app_secret VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL DEFAULT '',
  daily_limit INT DEFAULT 0,
  status TINYINT DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 插入默认 AppKey 数据（与 coze-proxy.php 的密钥保持一致）
INSERT INTO app_keys (app_key, app_secret, name, daily_limit) VALUES
('d23e6e9e70a5ab89', 'fc574b656d716c68b4b32717d2800c04', '默认编辑', 200),
('cdf3cbd1b2d807d3', '28e2d233d9948058043cc27f982acbc7', '开发测试', 200)
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- ============ AI 模型供应商表 ============
CREATE TABLE IF NOT EXISTS ai_providers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  base_url VARCHAR(255) NOT NULL,
  api_key VARCHAR(255) DEFAULT '',
  status TINYINT DEFAULT 1,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============ AI 模型表 ============
CREATE TABLE IF NOT EXISTS ai_models (
  id INT AUTO_INCREMENT PRIMARY KEY,
  provider_id INT NOT NULL,
  model_id VARCHAR(100) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  context_window INT DEFAULT 8192,
  max_tokens INT DEFAULT 4096,
  temperature DECIMAL(2,1) DEFAULT 0.7,
  supports_vision TINYINT DEFAULT 0,
  supports_tools TINYINT DEFAULT 0,
  supports_stream TINYINT DEFAULT 1,
  description TEXT,
  status TINYINT DEFAULT 1,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (provider_id) REFERENCES ai_providers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 插入默认 AI 供应商数据
INSERT INTO ai_providers (name, display_name, base_url, api_key, sort_order) VALUES
('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', '', 1),
('qwen', '通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1', '', 2),
('openai', 'OpenAI兼容', '', '', 3)
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name);

-- 插入默认 AI 模型数据
INSERT INTO ai_models (provider_id, model_id, display_name, supports_vision, supports_tools, supports_stream, sort_order) VALUES
((SELECT id FROM ai_providers WHERE name = 'deepseek'), 'deepseek-chat', 'DeepSeek Chat', 0, 1, 1, 1),
((SELECT id FROM ai_providers WHERE name = 'deepseek'), 'deepseek-reasoner', 'DeepSeek R1', 0, 0, 1, 2),
((SELECT id FROM ai_providers WHERE name = 'qwen'), 'qwen-plus', 'Qwen Plus', 0, 1, 1, 1),
((SELECT id FROM ai_providers WHERE name = 'qwen'), 'qwen-vl-plus', 'Qwen VL Plus', 1, 0, 1, 2),
((SELECT id FROM ai_providers WHERE name = 'openai'), 'gpt-4o', 'GPT-4o', 1, 1, 1, 1),
((SELECT id FROM ai_providers WHERE name = 'openai'), 'gpt-4o-mini', 'GPT-4o Mini', 1, 1, 1, 2)
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name);

-- ============ AI 大模型调用日志表 ============
CREATE TABLE IF NOT EXISTS ai_call_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  app_key_id INT NULL,
  provider_id INT NULL,
  model VARCHAR(100) NOT NULL,
  stream TINYINT(1) NOT NULL DEFAULT 0,
  prompt_tokens INT NULL,
  completion_tokens INT NULL,
  total_tokens INT NULL,
  duration_ms INT NULL,
  status_code INT NULL,
  success TINYINT(1) NOT NULL DEFAULT 1,
  error_msg TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_acl_created_at (created_at),
  INDEX idx_acl_app_key (app_key_id),
  INDEX idx_acl_provider (provider_id),
  INDEX idx_acl_model (model),
  CONSTRAINT fk_acl_appkey FOREIGN KEY (app_key_id) REFERENCES app_keys(id) ON DELETE SET NULL,
  CONSTRAINT fk_acl_provider FOREIGN KEY (provider_id) REFERENCES ai_providers(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============ 脚本经验记忆表 ============
CREATE TABLE IF NOT EXISTS script_memories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  script_id INT NOT NULL,
  success TINYINT(1) NOT NULL DEFAULT 1,
  duration_ms INT DEFAULT 0,
  error_msg TEXT,
  summary TEXT,
  url VARCHAR(500) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sm_script_id (script_id),
  FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============ 应用全局设置表 ============
-- 插件客户端通过 /api/app-settings/client 读取（appKey 签名认证）
-- 存储：agent_max_rounds、agent_system_prompt、pdf_max_size、image_max_size 等
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(50) PRIMARY KEY,
  setting_value TEXT,
  description VARCHAR(255),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 插入默认应用设置
INSERT INTO app_settings (setting_key, setting_value, description) VALUES
('agent_max_rounds', '30', 'Agent 模式最大执行轮数'),
('agent_system_prompt', '你是AI Browser智能体，一个能操作网页、调用脚本、整理数据的自主助手。\n\n=== 工作流程 ===\n1. 了解当前页面：使用 get_interactive_elements / read_page_content 获取页面概览\n2. 规划任务：复杂任务调用 create_todo 创建待办列表；简单任务（1-2步可完成）直接执行\n3. 按待办顺序执行工具操作，系统自动追踪进度\n4. 所有待办完成 → 调用 finish_task 汇报结果\n\n=== 工具使用策略 ===\n- DOM工具（extract_content、click_element等）：用于页面探索、简单数据提取、交互操作\n- inject_script_N：用于批量处理、深度数据采集（N是search_tools查到的脚本ID）\n- generate_script：当脚本库没有合适脚本且DOM工具无法完成时，动态生成代码执行\n- search_tools：搜索脚本库，查找可用的远程脚本\n\n=== 数据流转机制 ===\n工具返回的数据量较大时，系统会自动存储完整数据，只发回 schema+样例摘要。\n- 操作全量数据：generate_script(data_refs=["p1","p2"]) — 系统自动注入全量数据到页面，代码中通过 window.__store.p1 访问\n- 整合多份数据：generate_script(data_refs=["p1","p2"], code="return [...__store.p1, ...__store.p2]")\n\n=== 任务边界处理 ===\n当用户请求超出当前可用工具能力时，请：\n1. 直接调用 finish_task 说明情况并提供替代方案\n2. 不要反复尝试无法完成的操作，避免陷入循环\n\n当连续5次工具调用都无法推进任务时，请调用 finish_task 汇报当前已有结果。\n\n=== 输出规范 ===\n- 自然语言总结结果，不输出原始JSON\n- 错误时分析原因并在finish_task中告知', 'Agent 模式系统提示词（控制 Agent 行为规范）'),
('pdf_max_size', '10485760', 'PDF 上传大小上限（字节，默认 10MB）'),
('image_max_size', '5242880', '图片上传大小上限（字节，默认 5MB）')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- ============ 附件管理表 ============
-- 用途：管理上传的附件（图片、PDF 等），供侧边栏聊天使用
CREATE TABLE IF NOT EXISTS attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  filename VARCHAR(255) NOT NULL COMMENT '存储文件名',
  original_name VARCHAR(255) NOT NULL COMMENT '原始文件名',
  file_size INT DEFAULT 0 COMMENT '文件大小 (bytes)',
  mime_type VARCHAR(100) DEFAULT 'application/octet-stream' COMMENT 'MIME 类型',
  file_path VARCHAR(500) NOT NULL COMMENT '相对路径',
  purpose VARCHAR(50) DEFAULT 'attachment' COMMENT '用途: script|attachment',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='附件管理表';

-- ============ 对话归档表 ============
-- 存储每次 Agent 任务的完整对话全景，供后台管理页面查看每轮 AI 思考、工具调用、工具结果
-- 数据来源：Chrome 扩展 agent-runner.js 在任务结束时上传
-- embedding/embedding_text 字段用于 RAG 向量语义检索（all-MiniLM-L6-v2，384 维）
-- 提示：rounds_json 字段可能较大（16轮 × 30KB ≈ 500KB），使用 LONGTEXT
CREATE TABLE IF NOT EXISTS conversation_archives (
  id INT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  task_id VARCHAR(64) NOT NULL COMMENT '任务ID（客户端生成）',
  session_id VARCHAR(64) DEFAULT NULL COMMENT '会话ID',
  user_message TEXT NOT NULL COMMENT '用户原始需求',
  model VARCHAR(64) DEFAULT NULL COMMENT '使用的AI模型',
  total_rounds INT DEFAULT 0 COMMENT '总轮次数',
  total_tool_calls INT DEFAULT 0 COMMENT '工具调用总次数',
  status VARCHAR(20) DEFAULT 'unknown' COMMENT '任务结果: success/partial/failure/unknown',
  duration_ms BIGINT DEFAULT 0 COMMENT '任务耗时（毫秒）',
  rounds_json LONGTEXT NOT NULL COMMENT '完整轮次数据JSON（含每轮request/response/toolResults/storedData）',
  summary TEXT DEFAULT NULL COMMENT 'AI最终输出摘要',
  embedding JSON DEFAULT NULL COMMENT '用户消息的 embedding 向量（384维，all-MiniLM-L6-v2）',
  embedding_text TEXT DEFAULT NULL COMMENT '生成 embedding 的源文本（便于重新生成）',
  client_ip VARCHAR(64) DEFAULT NULL COMMENT '客户端IP',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '上传时间',
  UNIQUE KEY uk_task_id (task_id),
  INDEX idx_created_at (created_at),
  INDEX idx_status (status),
  INDEX idx_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='对话归档-存储完整任务对话全景';

-- ============ 选择器反馈表 ============
-- 记录每个 host+selector 的成功/失败历史
-- 用于 RAG 检索时过滤失效选择器，形成主动学习闭环
-- 数据来源：Chrome 扩展在 extract_content/click_element 等工具执行后自动上报
CREATE TABLE IF NOT EXISTS selector_feedback (
  id INT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  host VARCHAR(128) NOT NULL COMMENT '页面域名（不含路径）',
  selector VARCHAR(255) NOT NULL COMMENT 'CSS选择器',
  tool_name VARCHAR(64) DEFAULT NULL COMMENT '调用的工具名',
  task_id VARCHAR(64) DEFAULT NULL COMMENT '来源任务ID',
  result_status VARCHAR(20) NOT NULL COMMENT 'success / failure',
  item_count INT DEFAULT 0 COMMENT '返回的元素数量（成功时>0）',
  fail_count INT DEFAULT 0 COMMENT '累计失败次数（按 host+selector 聚合）',
  success_count INT DEFAULT 0 COMMENT '累计成功次数（按 host+selector 聚合）',
  last_success_at TIMESTAMP NULL DEFAULT NULL COMMENT '最近一次成功时间',
  last_failure_at TIMESTAMP NULL DEFAULT NULL COMMENT '最近一次失败时间',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '记录创建时间',
  UNIQUE KEY uk_host_selector (host, selector(80)),
  INDEX idx_host_status (host, result_status),
  INDEX idx_task (task_id),
  INDEX idx_last_failure (last_failure_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='选择器反馈-记录每个选择器的有效性历史';

-- ============ 报告渲染模板表 ============
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

-- ============ 预置报告模板数据 ============
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
 1, 'published')
ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), template = VALUES(template);

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
 2, 'published')
ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), template = VALUES(template);

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
 3, 'published')
ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), template = VALUES(template);

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
 4, 'published')
ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), template = VALUES(template);

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
 5, 'published')
ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), template = VALUES(template);

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
 6, 'published')
ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), template = VALUES(template);