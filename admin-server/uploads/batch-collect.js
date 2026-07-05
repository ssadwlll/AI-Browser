// @name: 批量网页内容采集
// @description: 批量并发抓取多个URL的页面标题和正文内容。配合DOM工具使用：先用extract_content提取列表页的新闻链接URL，然后把这些URL作为urls参数传入此脚本，一次调用即可完成所有内页采集。替代逐篇navigate_to+extract_content的低效方式
// @version: 1.0.0
// @urlPattern: *

// 此脚本为 api 类型，实际逻辑由后端 /api/collect-pages 接口执行
// tool_config 配置如下：
// {
//   "apiEndpoint": "/api/collect-pages",
//   "apiMethod": "POST",
//   "apiHeaders": {},
//   "requireAuth": true,
//   "toolDescription": "批量采集多个URL的页面内容。使用方式：先用DOM工具extract_content提取列表页的新闻链接href，然后把这些URL组成数组传给urls参数。例如 urls=["https://example.com/news1","https://example.com/news2"]。最多20个URL，返回每个页面的标题和正文。",
//   "parameters": {
//     "type": "object",
//     "required": ["urls"],
//     "properties": {
//       "urls": {
//         "type": "array",
//         "description": "要采集的URL列表，最多20个",
//         "items": { "type": "string" },
//         "maxItems": 20
//       },
//       "maxPages": {
//         "type": "number",
//         "description": "最多处理几个URL，默认20，最大20。不传则处理全部URL"
//       }
//     }
//   },
//   "resultExtractor": "data"
// }
