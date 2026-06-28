-- 为 scripts 表增加 AI Agent 工具调用字段
ALTER TABLE scripts ADD COLUMN tool_type VARCHAR(20) DEFAULT 'js';
ALTER TABLE scripts ADD COLUMN tool_config JSON;
