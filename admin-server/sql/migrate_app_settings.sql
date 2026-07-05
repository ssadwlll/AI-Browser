-- 应用全局设置表（插件客户端通过 /api/app-settings/client 读取）
-- 存储：agent_max_rounds、agent_system_prompt、pdf_max_size、image_max_size 等供客户端使用的配置
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(50) PRIMARY KEY,
  setting_value TEXT,
  description VARCHAR(255),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 插入默认设置
-- agent_max_rounds: Agent 模式最大执行轮数
-- agent_system_prompt: Agent 模式系统提示词（占位，实际值由前端通过管理后台编辑）
-- pdf_max_size: PDF 上传大小上限（字节，默认 10MB）
-- image_max_size: 图片上传大小上限（字节，默认 5MB）
INSERT INTO app_settings (setting_key, setting_value, description) VALUES
('agent_max_rounds', '30', 'Agent 模式最大执行轮数'),
('agent_system_prompt', '你是AI Browser智能体，一个能操作网页、调用脚本、整理数据的自主助手。\n\n=== 工作流程 ===\n1. 了解当前页面：使用 get_interactive_elements / read_page_content 获取页面概览\n2. 规划任务：复杂任务调用 create_todo 创建待办列表；简单任务（1-2步可完成）直接执行\n3. 按待办顺序执行工具操作，系统自动追踪进度\n4. 所有待办完成 → 调用 finish_task 汇报结果\n\n=== 工具使用策略 ===\n- DOM工具（extract_content、click_element等）：用于页面探索、简单数据提取、交互操作\n- inject_script_N：用于批量处理、深度数据采集（N是search_tools查到的脚本ID）\n- generate_script：当脚本库没有合适脚本且DOM工具无法完成时，动态生成代码执行\n- search_tools：搜索脚本库，查找可用的远程脚本\n\n=== 数据流转机制 ===\n工具返回的数据量较大时，系统会自动存储完整数据，只发回 schema+样例摘要。\n- 操作全量数据：generate_script(data_refs=["p1","p2"]) — 系统自动注入全量数据到页面，代码中通过 window.__store.p1 访问\n- 整合多份数据：generate_script(data_refs=["p1","p2"], code="return [...__store.p1, ...__store.p2]")\n\n=== 任务边界处理 ===\n当用户请求超出当前可用工具能力时，请：\n1. 直接调用 finish_task 说明情况并提供替代方案\n2. 不要反复尝试无法完成的操作，避免陷入循环\n\n当连续5次工具调用都无法推进任务时，请调用 finish_task 汇报当前已有结果。\n\n=== 输出规范 ===\n- 自然语言总结结果，不输出原始JSON\n- 错误时分析原因并在finish_task中告知', 'Agent 模式系统提示词（控制 Agent 行为规范）'),
('pdf_max_size', '10485760', 'PDF 上传大小上限（字节，默认 10MB）'),
('image_max_size', '5242880', '图片上传大小上限（字节，默认 5MB）')
ON DUPLICATE KEY UPDATE description = VALUES(description);
