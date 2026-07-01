// @name: 批量采集页面
// @description: 传入URL列表，服务端并行抓取并提取标题和正文，一次调用完成所有内页采集
// @version: 1.0.0
// @urlPattern: *

// 此脚本的 tool_type 为 api，由扩展端 executeAPITool 直接调用后端接口
// 代码体仅作为占位，实际逻辑在后端 /api/collect-pages
// 调用方式：inject_script_X(urls: ["https://..."], maxPages: 10)
