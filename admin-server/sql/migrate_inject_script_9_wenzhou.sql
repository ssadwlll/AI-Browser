-- ============================================================
-- 迁移: 更新 inject_script_9 为温州新闻网详情页采集（API类型）
-- 日期: 2026-07-04
-- 说明:
--   1. 将 ID=9 的脚本改为 tool_type='api'，指向 /api/collect-pages/wenzhou-detail
--   2. 配置 resultExtractor='data'，配合 chrome-extension normalizePayload
--      的 inject_script_N 分支：obj.ok && obj.result && Array.isArray(obj.result.pages)
--   3. 客户端 executeAPITool 会将 API 响应 {success, data:{pages}} 包装为
--      {ok:true, result:{pages}}, 再由 normalizePayload 剥离为 pages 数组
--   4. file_path 设为空字符串（API 类型不需要 .js 文件）
-- ============================================================

INSERT INTO scripts (
  id, name, description, category_id, version, author_id,
  file_path, file_size, icon, url_pattern,
  tool_type, tool_config, metadata, status
) VALUES (
  9,
  '温州新闻网详情页采集',
  '采集温州新闻网(66wz.com)新闻详细页。按id精准提取：标题(#artibodytitle的h1)、摘要(#abs)、正文(#artibody)。返回结构化数据，供AI总结、改写、翻译等后续处理。',
  1,
  '1.0.0',
  1,
  '',
  0,
  'newspaper',
  '*66wz.com*',
  'api',
  JSON_OBJECT(
    'apiEndpoint', '/api/collect-pages/wenzhou-detail',
    'apiMethod', 'POST',
    'apiHeaders', JSON_OBJECT('Content-Type', 'application/json'),
    'apiBody', JSON_OBJECT(),
    'requireAuth', true,
    'cacheable', true,
    'toolDescription', '采集温州新闻网新闻详细页，返回标题、摘要、正文。适用于news.66wz.com下的详情页URL。',
    'resultExtractor', 'data',
    'parameters', JSON_OBJECT(
      'type', 'object',
      'properties', JSON_OBJECT(
        'url', JSON_OBJECT(
          'type', 'string',
          'description', '温州新闻网新闻详情页URL，如 https://news.66wz.com/...'
        )
      ),
      'required', JSON_ARRAY('url')
    )
  ),
  JSON_OBJECT(
    'triggers', JSON_ARRAY('温州新闻', '温州新闻网', '新闻详情', '66wz', '采集新闻'),
    'platforms', JSON_ARRAY('news.66wz.com'),
    'requires_login', false,
    'success_criteria', '采集到标题、摘要、正文三段内容',
    'data_fields', JSON_ARRAY('title', 'summary', 'content', 'url', 'contentLength')
  ),
  'published'
)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  file_path = VALUES(file_path),
  file_size = VALUES(file_size),
  icon = VALUES(icon),
  url_pattern = VALUES(url_pattern),
  tool_type = VALUES(tool_type),
  tool_config = VALUES(tool_config),
  metadata = VALUES(metadata),
  status = VALUES(status);

-- 验证
SELECT id, name, tool_type, url_pattern,
       JSON_EXTRACT(tool_config, '$.apiEndpoint') AS api_endpoint,
       JSON_EXTRACT(tool_config, '$.resultExtractor') AS result_extractor,
       JSON_EXTRACT(metadata, '$.triggers') AS triggers
FROM scripts WHERE id = 9;
