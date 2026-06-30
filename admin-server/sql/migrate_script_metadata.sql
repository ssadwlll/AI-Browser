-- ============ 脚本元数据结构化迁移 ============
-- P0: scripts.metadata (JSON)     — YAML-style 元数据（triggers/category/platforms等）
-- P1: scripts.precheck (TEXT)     — 执行前检查 JS 代码
-- P3: script_memories 表         — 执行经验记忆

ALTER TABLE `scripts` ADD COLUMN `metadata` json NULL COMMENT '结构化元数据: {triggers, platforms, requires_login, success_criteria, known_limits, pagination}' AFTER `tool_config`;

ALTER TABLE `scripts` ADD COLUMN `precheck` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL COMMENT '执行前检查JS代码，返回{ok,reason}' AFTER `metadata`;

-- ============ P3: 执行经验记忆 ============
DROP TABLE IF EXISTS `script_memories`;
CREATE TABLE `script_memories` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `script_id` int(11) NOT NULL COMMENT '关联脚本ID',
  `session_id` varchar(36) DEFAULT NULL COMMENT '执行会话ID',
  `success` tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否成功',
  `duration_ms` int(11) DEFAULT 0 COMMENT '执行耗时(毫秒)',
  `error_message` text COMMENT '错误信息',
  `result_summary` text COMMENT '结果摘要(截断200字)',
  `executed_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_mem_script`(`script_id`),
  INDEX `idx_mem_script_success`(`script_id`, `success`),
  CONSTRAINT `fk_mem_script` FOREIGN KEY (`script_id`) REFERENCES `scripts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci ROW_FORMAT=DYNAMIC;
