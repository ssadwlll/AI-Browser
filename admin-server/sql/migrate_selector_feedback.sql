-- 选择器反馈表：记录每个 host+selector 的成功/失败历史
-- 用于 RAG 检索时过滤失效选择器，形成主动学习闭环
-- 数据来源：Chrome 扩展在 extract_content/click_element 等工具执行后自动上报

CREATE TABLE IF NOT EXISTS `selector_feedback` (
  `id` INT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  `host` VARCHAR(128) NOT NULL COMMENT '页面域名（不含路径）',
  `selector` VARCHAR(255) NOT NULL COMMENT 'CSS选择器',
  `tool_name` VARCHAR(64) DEFAULT NULL COMMENT '调用的工具名',
  `task_id` VARCHAR(64) DEFAULT NULL COMMENT '来源任务ID',
  `result_status` VARCHAR(20) NOT NULL COMMENT 'success / failure',
  `item_count` INT DEFAULT 0 COMMENT '返回的元素数量（成功时>0）',
  `fail_count` INT DEFAULT 0 COMMENT '累计失败次数（按 host+selector 聚合）',
  `success_count` INT DEFAULT 0 COMMENT '累计成功次数（按 host+selector 聚合）',
  `last_success_at` TIMESTAMP NULL DEFAULT NULL COMMENT '最近一次成功时间',
  `last_failure_at` TIMESTAMP NULL DEFAULT NULL COMMENT '最近一次失败时间',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '记录创建时间',
  UNIQUE KEY `uk_host_selector` (`host`, `selector`(80)),
  KEY `idx_host_status` (`host`, `result_status`),
  KEY `idx_task` (`task_id`),
  KEY `idx_last_failure` (`last_failure_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='选择器反馈-记录每个选择器的有效性历史';

-- 提示：
-- 1. fail_count/success_count 是按 host+selector 聚合的累计值，
--    每次 report 调用时 UPSERT 更新（不存在则插入，存在则累加）
-- 2. RAG 检索时 JOIN 此表，过滤 fail_count >= 3 且 last_failure_at 在 30 天内的选择器
-- 3. 任务 status='success' 时上报的选择器可信度更高（success_count 权重 ×2）
