-- 新增 AI 大模型调用日志表
-- 用于记录每次 /api/ai-proxy/chat 的调用明细，供后台统计与查询
-- 执行方式: mysql -u root -p aibrowser < sql/migrate_call_logs.sql
-- 或在 admin-server 目录运行: npm run db:init (会重新执行 init.sql，含此表)

USE aibrowser;

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
