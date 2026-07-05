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