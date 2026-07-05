-- 为 conversation_archives 表添加 embedding 字段
-- 用于 RAG 向量语义检索（混合方案：SQL 关键词粗筛 + 向量相似度精排）
-- 模型：all-MiniLM-L6-v2（384 维），由 admin-server/services/embeddingService.js 计算

ALTER TABLE `conversation_archives`
  ADD COLUMN `embedding` JSON DEFAULT NULL COMMENT '用户消息的 embedding 向量（384维，all-MiniLM-L6-v2）' AFTER `summary`,
  ADD COLUMN `embedding_text` TEXT DEFAULT NULL COMMENT '生成 embedding 的源文本（便于重新生成）' AFTER `embedding`;

-- 提示：
-- 1. embedding 字段存储 JSON 数组，如 [0.0123, -0.045, ...]（共 384 个 float）
-- 2. JSON 字段不建索引，向量检索在内存中进行（候选集已由 SQL 限制为 30 条）
-- 3. 历史数据回填：执行 SELECT task_id, user_message FROM conversation_archives WHERE embedding IS NULL
--    后逐条调用 embeddingService.embed(userMessage) 并 UPDATE 即可
-- 4. 向量生成时机：上传对话归档时同步生成（见 conversationArchiveController.upload）
