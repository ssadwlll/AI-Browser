-- 对话归档表：存储每次 Agent 任务的完整对话全景
-- 用于后台管理页面查看每轮 AI 思考、工具调用、工具结果
-- 数据来源：Chrome 扩展 agent-runner.js 在任务结束时上传

CREATE TABLE IF NOT EXISTS `conversation_archives` (
  `id` INT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  `task_id` VARCHAR(64) NOT NULL COMMENT '任务ID（客户端生成）',
  `session_id` VARCHAR(64) DEFAULT NULL COMMENT '会话ID',
  `user_message` TEXT NOT NULL COMMENT '用户原始需求',
  `model` VARCHAR(64) DEFAULT NULL COMMENT '使用的AI模型',
  `total_rounds` INT DEFAULT 0 COMMENT '总轮次数',
  `total_tool_calls` INT DEFAULT 0 COMMENT '工具调用总次数',
  `status` VARCHAR(20) DEFAULT 'unknown' COMMENT '任务结果: success/partial/failure/unknown',
  `duration_ms` BIGINT DEFAULT 0 COMMENT '任务耗时（毫秒）',
  `rounds_json` LONGTEXT NOT NULL COMMENT '完整轮次数据JSON（含每轮request/response/toolResults/storedData）',
  `summary` TEXT DEFAULT NULL COMMENT 'AI最终输出摘要',
  `client_ip` VARCHAR(64) DEFAULT NULL COMMENT '客户端IP',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '上传时间',
  UNIQUE KEY `uk_task_id` (`task_id`),
  KEY `idx_created_at` (`created_at`),
  KEY `idx_status` (`status`),
  KEY `idx_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='对话归档-存储完整任务对话全景';

-- 提示：rounds_json 字段可能较大（16轮 × 30KB ≈ 500KB），使用 LONGTEXT
-- 实际生产建议超过 5MB 时考虑分表或使用 MongoDB
