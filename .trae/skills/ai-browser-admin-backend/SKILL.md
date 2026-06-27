---
name: "ai-browser-admin-backend"
description: "AI Browser 脚本管理后台开发规范。定义 Node.js + Express + MySQL 技术栈下的项目结构、API 设计、数据库表结构、脚本模块规范。创建/修改 admin-server 相关代码时自动触发。"
---

# AI Browser 管理后台开发规范

## 一、项目概述

管理后台（admin-server）为 AI Browser 客户端提供脚本管理服务，支持脚本上传、分类、版本管理、下载和使用统计。

## 二、技术栈

| 组件 | 技术选型 |
|------|---------|
| 运行时 | Node.js 18+ |
| 框架 | Express 4.x |
| 数据库 | MySQL 8.0 |
| ORM | mysql2 (原生驱动) |
| 认证 | JWT (jsonwebtoken) |
| 文件存储 | 本地文件系统 + MySQL 记录 |
| 日志 | morgan + winston |

## 三、项目目录结构

```
admin-server/
├── app.js                  # 应用入口
├── package.json
├── .env                    # 环境变量（不提交）
├── config/
│   └── db.js               # 数据库连接配置
├── middleware/
│   ├── auth.js             # JWT 认证中间件
│   ├── errorHandler.js     # 全局错误处理
│   └── upload.js           # 文件上传中间件（multer）
├── routes/
│   ├── auth.js             # 登录/注册
│   ├── scripts.js          # 脚本 CRUD
│   └── stats.js            # 使用统计
├── models/
│   ├── user.js             # 用户模型
│   ├── script.js           # 脚本模型
│   └── stat.js             # 统计模型
├── controllers/
│   ├── authController.js
│   ├── scriptController.js
│   └── statController.js
├── utils/
│   ├── response.js         # 统一响应格式
│   └── validator.js        # 参数校验
├── uploads/                # 脚本文件存储目录
└── sql/
    └── init.sql            # 数据库初始化脚本
```

## 四、数据库表结构（MySQL）

### 4.1 用户表 users

```sql
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role ENUM('admin', 'developer', 'editor') DEFAULT 'editor',
  status TINYINT DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

### 4.2 脚本分类表 categories

```sql
CREATE TABLE categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  slug VARCHAR(50) NOT NULL UNIQUE,
  description VARCHAR(255),
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 4.3 脚本表 scripts

```sql
CREATE TABLE scripts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  category_id INT,
  version VARCHAR(20) DEFAULT '1.0.0',
  author_id INT,
  file_path VARCHAR(500) NOT NULL,
  file_size INT DEFAULT 0,
  icon VARCHAR(50) DEFAULT 'code',
  url_pattern VARCHAR(255) DEFAULT '*',
  config_schema JSON,
  status ENUM('draft', 'published', 'archived') DEFAULT 'draft',
  download_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id),
  FOREIGN KEY (author_id) REFERENCES users(id)
);
```

### 4.4 使用统计表 usage_stats

```sql
CREATE TABLE usage_stats (
  id INT AUTO_INCREMENT PRIMARY KEY,
  script_id INT NOT NULL,
  user_id INT NOT NULL,
  action ENUM('install', 'run', 'uninstall') NOT NULL,
  duration_ms INT DEFAULT 0,
  success TINYINT DEFAULT 1,
  error_msg TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (script_id) REFERENCES scripts(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 4.5 初始数据

```sql
-- 默认管理员
INSERT INTO users (username, password, role) VALUES ('admin', '$2b$10$...', 'admin');

-- 默认分类
INSERT INTO categories (name, slug, description, sort_order) VALUES
('数据采集', 'data-collection', '网页数据抓取与采集', 1),
('自动化操作', 'automation', '自动填表、签到、发布等', 2),
('页面增强', 'page-enhance', '去广告、暗黑模式、翻译等', 3),
('AI 增强', 'ai-enhance', 'AI 摘要、翻译、改写等', 4),
('内容生产', 'content-production', '排版、发布、多平台分发', 5),
('运营辅助', 'operation', '监控、检测、报告生成', 6);
```

## 五、API 设计规范

### 5.1 统一响应格式

```javascript
// 成功
{ success: true, data: {...}, message: '操作成功' }

// 失败
{ success: false, error: '错误描述', code: 400 }

// 分页列表
{ success: true, data: [...], pagination: { page: 1, pageSize: 20, total: 100, totalPages: 5 } }
```

### 5.2 API 路由设计

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | /api/auth/login | 用户登录 | 否 |
| POST | /api/auth/register | 用户注册 | 否 |
| GET | /api/scripts | 脚本列表（支持分页、分类筛选、搜索） | 是 |
| GET | /api/scripts/:id | 脚本详情 | 是 |
| POST | /api/scripts | 上传脚本（multipart/form-data） | 是(developer) |
| PUT | /api/scripts/:id | 更新脚本信息 | 是(developer) |
| DELETE | /api/scripts/:id | 删除脚本 | 是(admin) |
| GET | /api/scripts/:id/download | 下载脚本文件 | 是 |
| POST | /api/scripts/:id/stats | 上报使用统计 | 是 |
| GET | /api/stats | 使用统计概览 | 是(admin) |
| GET | /api/categories | 分类列表 | 是 |

## 六、代码规范

### 6.1 数据库连接 config/db.js

```javascript
const mysql = require('mysql2/promise')

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'aibrowser',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
})

module.exports = pool
```

### 6.2 控制器示例 controllers/scriptController.js

```javascript
const pool = require('../config/db')
const { success, error, paginated } = require('../utils/response')

// 获取脚本列表
exports.list = async (req, res) => {
  try {
    const { page = 1, pageSize = 20, category, keyword } = req.query
    const offset = (page - 1) * pageSize
    
    let where = 'WHERE s.status = "published"'
    const params = []
    
    if (category) {
      where += ' AND c.slug = ?'
      params.push(category)
    }
    if (keyword) {
      where += ' AND (s.name LIKE ? OR s.description LIKE ?)'
      params.push(`%${keyword}%`, `%${keyword}%`)
    }
    
    const [rows] = await pool.query(
      `SELECT s.*, c.name as category_name, u.username as author_name
       FROM scripts s
       LEFT JOIN categories c ON s.category_id = c.id
       LEFT JOIN users u ON s.author_id = u.id
       ${where}
       ORDER BY s.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(pageSize), offset]
    )
    
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM scripts s LEFT JOIN categories c ON s.category_id = c.id ${where}`,
      params
    )
    
    res.json(paginated(rows, parseInt(page), parseInt(pageSize), total))
  } catch (err) {
    res.status(500).json(error(err.message))
  }
}
```

### 6.3 路由示例 routes/scripts.js

```javascript
const router = require('express').Router()
const ctrl = require('../controllers/scriptController')
const auth = require('../middleware/auth')
const upload = require('../middleware/upload')

router.get('/', auth, ctrl.list)
router.get('/:id', auth, ctrl.detail)
router.post('/', auth, upload.single('script'), ctrl.create)
router.put('/:id', auth, ctrl.update)
router.delete('/:id', auth, ctrl.remove)
router.get('/:id/download', auth, ctrl.download)
router.post('/:id/stats', auth, ctrl.reportStats)

module.exports = router
```

### 6.4 JWT 认证中间件 middleware/auth.js

```javascript
const jwt = require('jsonwebtoken')

module.exports = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ success: false, error: '未登录' })
  
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'ai-browser-secret')
    next()
  } catch (err) {
    res.status(401).json({ success: false, error: 'Token 无效或已过期' })
  }
}
```

### 6.5 文件上传中间件 middleware/upload.js

```javascript
const multer = require('multer')
const path = require('path')

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, uniqueSuffix + '-' + file.originalname)
  },
})

const fileFilter = (req, file, cb) => {
  if (file.originalname.endsWith('.js')) {
    cb(null, true)
  } else {
    cb(new Error('只允许上传 .js 脚本文件'), false)
  }
}

module.exports = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } })
```

## 七、环境变量 .env

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=66wz66wz
DB_NAME=aibrowser
JWT_SECRET=ai-browser-jwt-secret-2024
PORT=3001
```

## 八、脚本模块规范

### 8.1 脚本文件格式

每个脚本必须是一个 `.js` 文件，遵循以下格式：

```javascript
// @name: 热点新闻采集
// @description: 自动采集当前页面热点新闻标题和链接
// @version: 1.0.0
// @category: data-collection
// @urlPattern: *news*
// @author: 开发人员姓名

(function() {
  const results = []
  document.querySelectorAll('.news-item').forEach(item => {
    const title = item.querySelector('.title')?.textContent?.trim()
    const link = item.querySelector('a')?.href
    const time = item.querySelector('.time')?.textContent?.trim()
    if (title) results.push({ title, link, time })
  })
  window.__actionResult = { success: true, data: results, total: results.length }
})()
```

### 8.2 脚本元数据注释规范

| 注释标签 | 必填 | 说明 |
|---------|------|------|
| @name | 是 | 脚本名称 |
| @description | 是 | 脚本功能描述 |
| @version | 是 | 语义化版本号 |
| @category | 是 | 分类 slug |
| @urlPattern | 否 | URL 匹配模式（默认 *） |
| @author | 否 | 作者名称 |

## 九、客户端集成接口

### 9.1 脚本列表同步

客户端启动时调用 `GET /api/scripts` 获取脚本列表，与本地缓存对比，自动下载新版本。

### 9.2 脚本下载

调用 `GET /api/scripts/:id/download` 下载脚本文件，保存到本地脚本目录。

### 9.3 使用统计上报

脚本执行后调用 `POST /api/scripts/:id/stats` 上报执行结果。

```javascript
// 上报格式
{
  action: 'run',        // install | run | uninstall
  duration_ms: 1500,    // 执行耗时（毫秒）
  success: true,        // 是否成功
  error_msg: null       // 错误信息
}
```

## 十、开发检查清单

- [ ] 数据库连接配置正确
- [ ] 所有 API 有 JWT 认证（除登录/注册）
- [ ] 文件上传有类型和大小限制
- [ ] 统一响应格式
- [ ] 参数校验
- [ ] 错误日志记录
- [ ] SQL 注入防护（参数化查询）
- [ ] CORS 配置
- [ ] 环境变量不提交到仓库
- [ ] 初始化 SQL 脚本可用