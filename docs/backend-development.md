# 后台服务开发说明（admin-server）

## 一、概述

`admin-server` 是 AI Browser 的可选后台服务，基于 Node.js + Express + MySQL 构建。桌面应用（Electron）与 Chrome 扩展可独立运行；连接后台后获得云端能力：

- 用户认证与权限管理
- 脚本市场（上传、分类、搜索、注入、下载、统计）
- AI 代理（云端密钥保护下的 LLM 调用、图片/PDF 上传解析）
- 应用密钥（AppKey）签发与鉴权
- 向量检索（脚本语义搜索、对话归档 RAG）
- 对话归档、采集页面、报告模板、选择器反馈等扩展模块
- 内置管理后台前端（静态资源托管于 `public/`）

后台默认监听 `http://localhost:3001`，提供健康检查接口 `GET /api/health`。

## 二、技术栈

| 组件 | 选型 | 版本 |
|------|------|------|
| 运行时 | Node.js | >= 18 |
| Web 框架 | Express | ^4.18.2 |
| 数据库 | MySQL | 5.7+ / 8.0 |
| 数据库驱动 | mysql2（连接池） | ^3.6.5 |
| 用户认证 | jsonwebtoken（JWT） | ^9.0.2 |
| 密码哈希 | bcryptjs | ^2.4.3 |
| AppKey 签名 | Node.js 原生 `crypto`（HMAC-SHA256） | - |
| 文件上传 | multer | ^1.4.5-lts.1 |
| HTTP 日志 | morgan | ^1.10.0 |
| 跨域 | cors | ^2.8.5 |
| 环境变量 | dotenv | ^16.3.1 |
| 向量推理 | @xenova/transformers（本地 ONNX 模型） | ^2.17.2 |
| PDF 解析 | pdf-parse | ^2.4.5 |
| 字符编码 | iconv-lite | ^0.7.2 |
| 进程热重载 | nodemon（dev） | ^3.0.2 |

## 三、目录结构

```
admin-server/
├── app.js                      # 应用入口：中间件、路由挂载、Embedding 启动
├── package.json                # 依赖与 scripts（start / dev / db:init）
├── nodemon.json                # nodemon 监听与忽略规则
├── config/
│   └── db.js                   # MySQL 连接池配置（mysql2/promise）
├── controllers/                # 业务控制器（每个模块一个文件）
│   ├── authController.js       # 登录、注册、me
│   ├── scriptController.js     # 脚本 CRUD、搜索、注入、油猴格式
│   ├── memoryController.js     # 脚本执行经验记忆
│   ├── categoryController.js   # 脚本分类 CRUD
│   ├── appKeyController.js     # AppKey 签发与管理
│   ├── aiModelController.js    # AI 供应商与模型 CRUD
│   ├── aiProxyController.js    # LLM 代理（chat / 图片 / PDF）
│   ├── aiCallLogController.js  # AI 调用日志查询
│   ├── appSettingController.js # 应用全局设置
│   ├── attachmentController.js # 附件上传与管理
│   ├── conversationArchiveController.js  # 对话归档上传/检索/统计
│   ├── collectPageController.js   # 批量采集页面
│   ├── reportTemplateController.js # 报告模板 CRUD
│   ├── selectorFeedbackController.js # 选择器反馈上报与统计
│   ├── hotspotController.js    # 热点聚合抓取
│   ├── forgeController.js      # AI 智能脚本生成
│   ├── statController.js       # 使用统计概览
│   └── userController.js       # 用户管理
├── middleware/
│   ├── auth.js                 # JWT 认证 + requireRole 角色权限
│   ├── appAuth.js              # AppKey 签名认证（HMAC-SHA256）
│   ├── upload.js               # 脚本文件上传（仅 .js，10MB）
│   ├── attachmentUpload.js     # 附件上传（图片/PDF/文档，50MB）
│   └── errorHandler.js         # 全局错误处理（Multer、业务异常）
├── routes/                     # 路由层（与 controllers 一一对应）
│   ├── auth.js  scripts.js  hotspot.js  stats.js  users.js
│   ├── categories.js  app-keys.js  ai-models.js  ai-proxy.js
│   ├── ai-call-logs.js  app-settings.js  report-templates.js
│   ├── attachments.js  forge.js  collect-pages.js
│   ├── conversation-archives.js  selector-feedback.js
├── services/
│   ├── embeddingService.js     # 向量生成与混合检索（all-MiniLM-L6-v2）
│   └── embedding_server.py     # 备用 Python 推理脚本
├── models/
│   └── all-MiniLM-L6-v2/       # 本地 ONNX 模型文件（含 tokenizer）
├── utils/
│   └── response.js             # 统一响应格式 success / error / paginated
├── public/                     # 管理后台前端静态资源
│   ├── index.html  admin.html
│   ├── css/admin.css
│   └── js/                     # 各模块前端脚本
├── uploads/                    # 上传文件存储（运行时自动创建）
├── sql/                        # 数据库初始化与迁移脚本
│   ├── init.sql  init.js       # 初始化表结构 + 默认数据
│   ├── migrate_vector.sql      # 脚本向量字段
│   ├── migrate_modules.sql     # script_modules 表
│   ├── migrate_script_metadata.sql  # metadata / precheck / script_memories
│   ├── migrate_call_logs.sql        # ai_call_logs
│   ├── migrate_attachments.sql      # attachments
│   ├── migrate_conversation_archives.sql             # conversation_archives
│   ├── migrate_conversation_archives_embedding.sql   # embedding 字段
│   ├── migrate_app_settings.sql    # app_settings
│   ├── migrate_report_templates.sql # report_templates
│   ├── migrate_selector_feedback.sql # selector_feedback
│   ├── migrate_tool_type.sql       # scripts.tool_type / tool_config
│   └── migrate_inject_script_9_wenzhou.sql  # 业务脚本回填
└── scripts/                    # 模型下载与转换辅助脚本
```

## 四、环境准备

### 4.1 系统要求

- Node.js >= 18（需原生 `fetch`、`crypto` 模块）
- MySQL 5.7+ 或 8.0（建议 8.0，支持 JSON 字段索引优化）
- 操作系统：Windows / macOS / Linux 均可

### 4.2 数据库初始化

方式一：使用初始化脚本（推荐，会自动创建默认管理员 `admin / admin123`）

```bash
cd admin-server
npm run db:init        # 等价于 node sql/init.js
```

方式二：直接导入 SQL

```bash
mysql -u root -p < sql/init.sql
```

`init.sql` 包含核心表结构、默认分类、默认 AppKey、默认 AI 供应商与模型、默认应用设置。其它扩展表（attachments、conversation_archives、report_templates、selector_feedback 等）位于 `sql/migrate_*.sql`，按需执行。

### 4.3 数据库连接配置

`config/db.js` 通过环境变量读取配置，默认连接本地 `aibrowser` 数据库：

```javascript
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'aibrowser',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
})
```

推荐在 `admin-server/` 根目录创建 `.env` 文件（不提交到仓库）：

```env
PORT=3001
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=aibrowser
JWT_SECRET=your_jwt_secret
```

## 五、启动

```bash
# 安装依赖
npm install

# 生产启动
npm start                 # node app.js

# 开发模式（热重载）
npm run dev               # nodemon app.js
```

启动成功后控制台输出：

```
[Admin Server] 运行在 http://localhost:3001
[Admin Server] 健康检查: http://localhost:3001/api/health
[Embedding] 加载本地模型: all-MiniLM-L6-v2 (纯 Node.js)
[Embedding] 模型就绪, 维度: 384
```

Embedding 服务异步初始化，失败时不阻塞主服务，自动降级为 LIKE 关键词搜索。

## 六、数据库表结构

### 6.1 核心表（`sql/init.sql`）

| 表名 | 用途 |
|------|------|
| `users` | 用户账号，字段含 `username`、`password`（bcrypt 哈希）、`role`（admin/developer/editor）、`status` |
| `categories` | 脚本分类，含 `name`、`slug`、`sort_order`，初始化 6 个默认分类 |
| `scripts` | 脚本主表，含 `file_path`（相对路径）、`url_pattern`、`status`（draft/published/archived）、`tool_type`、`tool_config`、`params_schema`、`params_data`、`metadata`、`precheck`、`vector`、`vector_updated_at` |
| `script_modules` | 脚本多模块代码（`code` LONGTEXT，按 `load_order` 加载） |
| `usage_stats` | 脚本使用统计（install / run / uninstall + 耗时 + 成功标记） |
| `app_keys` | AppKey/AppSecret 凭证，含 `daily_limit`、`status` |
| `ai_providers` | AI 供应商（DeepSeek、通义千问、OpenAI 兼容）含 `base_url`、`api_key` |
| `ai_models` | AI 模型配置（`model_id`、上下文窗口、视觉/工具/流式能力标记） |
| `ai_call_logs` | LLM 调用日志（token 用量、耗时、状态码、错误） |
| `script_memories` | 脚本执行经验记忆（成功/失败、耗时、错误、摘要） |
| `app_settings` | 应用全局设置（KV 结构，含 `agent_max_rounds`、`agent_system_prompt`、`pdf_max_size`、`image_max_size`） |

### 6.2 扩展表（`sql/migrate_*.sql`）

| 表名 | 用途 | 迁移文件 |
|------|------|---------|
| `attachments` | 附件管理（图片、PDF、文档），存储相对路径 | `migrate_attachments.sql` |
| `conversation_archives` | 对话归档，含每轮 request/response/toolResults，附加 `embedding`/`embedding_text` 字段用于 RAG | `migrate_conversation_archives.sql` + `migrate_conversation_archives_embedding.sql` |
| `report_templates` | 报告渲染模板（Handlebars 兼容），预置新闻卡片、表格、时间轴、商品列表、统计卡片、链接列表 | `migrate_report_templates.sql` |
| `selector_feedback` | 选择器使用反馈（host + selector 级别累计成功/失败次数），用于 RAG 过滤失效选择器 | `migrate_selector_feedback.sql` |

### 6.3 scripts 表关键字段

```sql
SELECT id, name, description, category_id, version, author_id,
       file_path, file_size, icon, url_pattern,
       config_schema, params_schema, params_data,
       status, download_count,
       tool_type, tool_config, metadata, precheck,
       vector, vector_updated_at,
       created_at, updated_at
FROM scripts;
```

- `file_path`：相对项目根目录的路径（如 `uploads/1782647906867-xxx.js`）
- `tool_type`：`js`（默认注入脚本）/ 自定义工具类型
- `tool_config`：工具调用配置（JSON）
- `metadata`：结构化元数据（`triggers`、`platforms`、`requires_login` 等）
- `precheck`：执行前检查 JS 代码，返回 `{ok, reason}`
- `vector`：384 维 embedding 向量（JSON 数组字符串）

## 七、API 模块

所有 API 统一前缀 `/api`，响应格式：

```json
{ "success": true, "data": {}, "message": "操作成功" }
```

分页响应：

```json
{
  "success": true,
  "data": [],
  "pagination": { "page": 1, "pageSize": 20, "total": 100, "totalPages": 5 }
}
```

### 7.1 认证模块（auth）

路由：`/api/auth`

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/login` | 否 | 账号密码登录，返回 JWT（7 天有效期） |
| POST | `/register` | 否 | 注册新用户 |
| GET | `/me` | JWT | 获取当前用户信息 |

### 7.2 脚本管理（scripts）

路由：`/api/scripts`，是后台最核心模块，同时支持管理后台（JWT）与扩展端（AppKey）调用。

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/` | JWT | 脚本列表（分页、分类、关键词、状态、toolType 筛选） |
| GET | `/search` | AppKey | AI 工具语义搜索（embedding + 关键词混合） |
| GET | `/agent-index` | AppKey | 扩展端拉取全脚本索引（精简字段） |
| GET | `/inject-list` | 公开 | 列出已发布脚本及 url_pattern |
| GET | `/:id/inject` | AppKey | 拼接代码 + 参数，供扩展注入 |
| GET | `/:id/userjs` | 公开 | 输出油猴（Tampermonkey）格式 |
| POST | `/generate-userjs` | 公开 | 接受代码生成油猴格式（不入库） |
| GET | `/:id` | JWT | 脚本详情（含代码、模块、参数） |
| POST | `/` | JWT | 上传脚本（multipart，仅 `.js`） |
| POST | `/app-upload` | AppKey | 扩展端上传脚本 |
| PUT | `/:id` | JWT | 更新脚本（更新名称/描述时自动重生成向量） |
| DELETE | `/:id` | JWT | 删除脚本及文件 |
| GET | `/:id/download` | JWT | 下载脚本文件 |
| POST | `/:id/stats` | JWT | 上报使用统计 |
| POST | `/:id/memories` | AppKey | 上报执行经验记忆 |
| GET | `/:id/memories` | JWT | 查询脚本经验记忆 |

### 7.3 AI 代理（ai-proxy）

路由：`/api/ai-proxy`，全部 AppKey 签名鉴权。桌面应用不直接持有云端 API Key，通过后台代理调用 LLM。

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/chat` | AppKey | LLM 对话代理（支持 stream / tools） |
| POST | `/upload-image` | AppKey | 上传图片（最大 50MB，multipart） |
| POST | `/parse-pdf` | AppKey | 上传 PDF 并解析文本 |

每次 `/chat` 调用自动写入 `ai_call_logs`，记录 token 用量、耗时、状态码、错误信息。

### 7.4 应用密钥（app-keys）

路由：`/api/app-keys`，全部 JWT 鉴权。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 列表（appSecret 脱敏返回前 8 位 + ****） |
| POST | `/` | 创建（自动生成 appKey=16位hex, appSecret=32位hex，完整返回一次） |
| PUT | `/:id` | 更新 |
| DELETE | `/:id` | 删除 |
| POST | `/verify` | 校验 AppKey |

### 7.5 AI 模型管理（ai-models）

路由：`/api/ai-models`

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/available` | AppKey | 扩展端获取可用模型列表 |
| GET/POST/PUT/DELETE | `/providers[/:id]` | JWT | 供应商 CRUD |
| GET/POST/PUT/DELETE | `/[/:id]` | JWT | 模型 CRUD |

### 7.6 AI 调用日志（ai-call-logs）

路由：`/api/ai-call-logs`，全部 JWT 鉴权（后台管理用）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 日志列表（分页、筛选） |
| GET | `/daily-stats` | 按日统计 |
| GET | `/filters` | 筛选项（模型、供应商、AppKey） |

### 7.7 统计（stats）

路由：`/api/stats`，全部 JWT 鉴权。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/overview` | 使用统计概览 |
| GET | `/categories` | 按分类统计 |

### 7.8 附件上传（attachments）

路由：`/api/attachments`，全部 JWT 鉴权。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/upload` | 上传附件（图片/PDF/文档，最大 50MB） |
| GET | `/` | 附件列表 |
| DELETE | `/:id` | 删除附件 |

### 7.9 对话归档（conversation-archives）

路由：`/api/conversation-archives`，上传与检索由扩展端 AppKey 鉴权，后台查询 JWT 鉴权。

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/` | AppKey | 上传任务完整对话（含每轮 request/response/toolResults） |
| POST | `/rag` | AppKey | RAG 语义检索（关键词粗筛 + 向量精排） |
| GET | `/` | JWT | 后台列表 |
| GET | `/stats/summary` | JWT | 统计摘要 |
| GET | `/:taskId` | JWT | 详情 |
| DELETE | `/:taskId` | JWT | 删除 |

### 7.10 采集页面（collect-pages）

路由：`/api/collect-pages`，挂载时整路由套 `appAuth` 中间件（AppKey 鉴权）。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/` | 批量采集页面 |
| POST | `/wenzhou-detail` | 业务专用采集接口 |

### 7.11 报告模板（report-templates）

路由：`/api/report-templates`

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/` | AppKey | 扩展端拉取已发布模板（Handlebars 兼容） |
| GET/POST/PUT/DELETE | `/admin[/:id]` | JWT | 后台 CRUD |

### 7.12 热点（hotspot）

路由：`/api/hotspot`，公开访问，从外部站点实时抓取热点聚合，不落库。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 抓取并解析热点榜单 |

### 7.13 分类（categories）

路由：`/api/categories`，全部 JWT 鉴权，提供分类 CRUD。

### 7.14 应用设置（app-settings）

路由：`/api/app-settings`

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/client` | AppKey | 客户端读取白名单公开设置 |
| GET | `/` | JWT | 后台列出全部设置 |
| PUT | `/:key` | JWT | 更新或新增设置 |
| DELETE | `/:key` | JWT | 删除设置 |

白名单 key：`agent_max_rounds`、`agent_system_prompt`、`pdf_max_size`、`image_max_size`。

### 7.15 选择器反馈（selector-feedback）

路由：`/api/selector-feedback`

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/report` | AppKey | 扩展端上报选择器执行结果（host+selector UPSERT 累计） |
| GET | `/stats` | JWT | 后台统计查询 |

### 7.16 锻造（forge）

路由：`/api/forge`，JWT 鉴权。分析页面 HTML 结构，AI 生成采集脚本草稿。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/analyze` | 提交页面 HTML，返回 AI 生成的脚本代码 |

### 7.17 用户管理（users）

路由：`/api/users`，全部 JWT 鉴权，提供用户 CRUD。

### 7.18 内置辅助接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/proxy-preview` | 抓取目标页面 HTML 注入脚本（srcdoc 预览） |
| GET | `/` | 管理后台首页（`public/index.html`） |

## 八、鉴权机制

后台采用双层鉴权：**管理后台用 JWT，桌面应用 / 扩展用 AppKey 签名**。

### 8.1 用户登录（JWT）

`middleware/auth.js` 从 `Authorization: Bearer <token>` 或 `?token=` 取出 JWT，使用 `JWT_SECRET` 验证；通过后将 `{id, username, role}` 挂到 `req.user`。Token 默认 7 天有效期。

```javascript
const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token
req.user = jwt.verify(token, process.env.JWT_SECRET || 'ai-browser-secret')
```

`auth.js` 还导出 `requireRole(...roles)` 角色权限中间件，可链式校验 admin/developer/editor。

### 8.2 AppKey 签名（扩展端）

`middleware/appAuth.js` 校验三段请求头：

| 请求头 | 含义 |
|--------|------|
| `X-App-Key` | AppKey（16 位 hex） |
| `X-Timestamp` | 当前秒级时间戳，5 分钟内有效 |
| `X-Sign` | HMAC-SHA256 签名（小写 hex） |

签名算法：

```javascript
const message = `${appKey}${timestamp}`
const sign = crypto.createHmac('sha256', appSecret).update(message, 'utf8').digest('hex')
```

校验通过后将 `appKeyInfo`（含 `id`、`daily_limit`、`name` 等）挂到 `req.appKeyInfo`，使用 `crypto.timingSafeEqual` 做时序安全比较。

### 8.3 双层鉴权约定

- **管理后台前端**（`public/` 静态页面）→ JWT
- **桌面应用 / Chrome 扩展**（Electron、扩展后台）→ AppKey 签名
- 同一路由文件可混用：例如 `routes/scripts.js` 中 `auth` 用于管理端，`appAuth` 用于扩展端
- 部分接口（`/inject-list`、`/:id/userjs`、`/generate-userjs`、`/api/hotspot`）公开访问

## 九、AI 代理服务

`controllers/aiProxyController.js` 实现云端 AI 代理，避免客户端直接持有云端 API Key。

### 9.1 工作流程

1. 扩展端通过 `config_service.getAIProxyUrl()` 拿到 `{serverUrl}/api/ai-proxy/chat`
2. 请求头携带 AppKey 签名（`X-App-Key` / `X-Timestamp` / `X-Sign`）
3. 后台根据请求体 `model` 字段查 `ai_models` + `ai_providers` 取 `base_url` 与 `api_key`
4. 后台用云端密钥向上游 LLM 发起请求（支持 stream / tools / tool_choice）
5. 透传响应给客户端，同时记录调用日志

### 9.2 调用日志

每次 `/chat` 调用无论成功失败都写入 `ai_call_logs`：

```sql
INSERT INTO ai_call_logs
  (app_key_id, provider_id, model, stream, prompt_tokens, completion_tokens,
   total_tokens, duration_ms, status_code, success, error_msg)
VALUES (...);
```

日志通过 fire-and-forget 方式写入，不影响主流程；流式响应通过正则解析最后一个 `"usage":{...}` 提取 token 统计。

### 9.3 用量统计

后台 `/api/ai-call-logs` 提供按日统计、筛选、列表查询，便于按 AppKey / 模型 / 供应商维度查看用量。

## 十、向量检索

`services/embeddingService.js` 提供脚本语义搜索与对话归档 RAG 检索能力。

### 10.1 模型

- 名称：`all-MiniLM-L6-v2`
- 格式：ONNX 量化版（位于 `models/all-MiniLM-L6-v2/onnx/model_quantized.onnx`）
- 维度：384
- 推理：纯 Node.js，通过 `@xenova/transformers` 的 `pipeline('feature-extraction', ...)` 加载，`local_files_only: true` 强制本地加载，不联网

### 10.2 向量存储

- 脚本向量：`scripts.vector` 字段（LONGTEXT，存储 384 维 JSON 数组），`vector_updated_at` 记录生成时间
- 对话归档向量：`conversation_archives.embedding`（JSON）+ `embedding_text`（源文本）
- 迁移脚本：`sql/migrate_vector.sql`、`sql/migrate_conversation_archives_embedding.sql`

### 10.3 混合检索策略

脚本搜索采用 **向量相似度 70% + 关键词匹配 30%** 的混合评分：

```javascript
const finalScore = row.vector
  ? vectorScore * 0.7 + kwScore * 0.3
  : kwScore * 0.5   // 无向量降级
```

- 关键词评分考虑 `name`、`description`、`metadata.triggers` 加权
- 阈值过滤 `score >= 0.15`，返回 topK
- Embedding 服务不可用时自动降级为 LIKE 搜索（含中文 bigram 分词）

### 10.4 向量生成时机

- 脚本上传（`scriptController.create`）→ 异步 `embeddingService.generateVector(scriptId)`
- 脚本更新（name 或 description 变更）→ 清空旧向量 + 异步重新生成
- 服务启动 → `buildMissingVectors()` 扫描所有缺向量的已发布脚本批量补全
- 对话归档上传 → 同步生成 embedding（见 `conversationArchiveController.upload`）

## 十一、桌面应用如何连接后台

### 11.1 配置入口

`electron/services/config_service.js` 管理 AI / 同步 / Agent 三类配置，默认值：

```javascript
const DEFAULT_SYNC_CONFIG = {
  serverUrl: 'http://localhost:3001',
  appKey: '',
  appSecret: '',
  syncInterval: 30,
  enabled: false,    // 默认关闭同步，避免未配置时持续失败
}
```

配置持久化到 `app.getPath('userData')/storage.json`（由 `storage_service.js` 管理，内存缓存 + 防抖写入 + 串行化锁）。

### 11.2 签名请求

`ConfigService.generateAuthHeaders(appKey, appSecret)` 生成签名请求头，与后台 `appAuth` 中间件算法一致：

```javascript
const timestamp = String(Math.floor(Date.now() / 1000))
const message = appKey + timestamp
headers['X-App-Key'] = appKey
headers['X-Timestamp'] = timestamp
headers['X-Sign'] = crypto.createHmac('sha256', appSecret).update(message).digest('hex')
```

### 11.3 主要后台调用

| ConfigService 方法 | 后台接口 | 用途 |
|--------------------|----------|------|
| `getAppSettings()` | `GET /api/app-settings/client` | 拉取应用全局设置（10 分钟缓存 + 失败回退） |
| `getAvailableModels()` | `GET /api/ai-models/available` | 拉取可用模型列表 |
| `getAIProxyUrl()` | `POST /api/ai-proxy/chat` | LLM 对话代理 |
| `getPdfUploadConfig()` | `POST /api/ai-proxy/parse-pdf` | PDF 上传 URL + 签名头 |
| `getImageUploadConfig()` | `POST /api/ai-proxy/upload-image` | 图片上传 URL + 签名头 |

### 11.4 本地存储

`storage_service.js` 替代 `chrome.storage.local`，特性：

- 单文件 JSON 持久化（`storage.json`）
- 内存缓存，首次访问懒加载
- 防抖写入（500ms）+ 串行化锁（防止并发读改写覆盖）
- 原子写入：先写 `.tmp` 再 `rename`，避免崩溃损坏

## 十二、开发约定

### 12.1 Controller-Route 分层

- `routes/<module>.js`：仅声明路由 + 鉴权中间件挂载，不含业务逻辑
- `controllers/<module>Controller.js`：处理请求参数、数据库查询、业务编排、统一响应
- `middleware/`：通用中间件（鉴权、上传、错误处理）
- `services/`：跨控制器的领域服务（如 embedding）
- `utils/`：工具函数（统一响应、校验等）

### 12.2 统一响应格式

`utils/response.js` 暴露三个函数，所有控制器统一使用：

```javascript
const { success, error, paginated } = require('../utils/response')

res.json(success(data, '操作成功'))
res.status(400).json(error('参数错误', 400))
res.json(paginated(rows, page, pageSize, total))
```

### 12.3 错误处理

- 控制器内 `try/catch` 捕获业务异常，返回 500 + `error(err.message)`
- `middleware/errorHandler.js` 兜底处理 Multer 错误（文件超限、字段意外）、文件类型错误
- 上传失败时清理已落盘文件，避免残留

### 12.4 文件上传

- 脚本文件：`middleware/upload.js`，仅 `.js`，单文件 10MB
- 通用附件：`middleware/attachmentUpload.js`，支持图片 / PDF / 文本 / Word，50MB
- 存储目录：`admin-server/uploads/`（应用启动时自动创建）
- 命名规则：`{时间戳}-{随机数}-{原始文件名}`，避免重名
- 数据库存相对路径（如 `uploads/1782647906867-xxx.js`），读取时通过 `resolveFilePath` 兼容旧绝对路径

### 12.5 SQL 安全

所有数据库查询使用 mysql2 参数化查询（`?` 占位符），禁止字符串拼接 SQL，杜绝 SQL 注入。

### 12.6 路由挂载约定

`app.js` 中按 `/api/<module>` 挂载路由，整路由需要 AppKey 鉴权的可在挂载时链式中件件：

```javascript
app.use('/api/collect-pages', require('./middleware/appAuth'), require('./routes/collect-pages'))
```

同一路由文件内部也可对单个端点混用鉴权（见 `routes/scripts.js`、`routes/conversation-archives.js`）。

### 12.7 启动顺序

1. 加载 `.env`
2. 创建 `uploads/` 目录
3. 挂载全局中间件（cors / morgan / json 50mb / urlencoded）
4. 挂载 17 个 API 路由 + 内置接口
5. 静态资源（`public/`、`/uploads`）
6. 全局错误处理
7. `app.listen` 后异步初始化 Embedding（失败不阻塞）

### 12.8 数据库迁移管理

- 表结构演进通过 `sql/migrate_*.sql` 文件管理，命名格式 `migrate_<功能>.sql`
- `init.sql` 始终保持最新完整结构，新部署只需执行 `npm run db:init`
- 迁移脚本使用 `IF NOT EXISTS` / `IF EXISTS` 守卫，保证可重复执行
- 向量字段迁移使用存储过程 + `information_schema` 判断，兼容 MySQL 5.7+
