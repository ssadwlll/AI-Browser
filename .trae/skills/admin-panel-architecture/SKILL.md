---
name: "admin-panel-architecture"
description: "管理后台前端架构规范。定义 CSS/JS/HTML 文件分离、模块划分、命名约定、新页面开发流程。在修改或新增管理后台页面、重构 admin 前端代码时调用。"
---

# 管理后台前端架构规范

适用项目：`ai-browser/admin-server/public/`

## 一、目录结构

```
public/
├── index.html          # 唯一入口文件，包含所有页面 HTML + 弹窗 + 内联路由
├── css/
│   └── admin.css       # 全部样式（CSS 变量、布局、组件、动画、响应式）
├── js/
│   ├── common.js       # 公共工具函数（无依赖，必须第一个加载）
│   ├── scripts.js      # 脚本管理模块
│   ├── users.js        # 用户管理模块
│   ├── categories.js   # 分类管理模块
│   ├── appkeys.js      # AppKey 管理模块
│   ├── aimodels.js     # AI 模型配置模块
│   ├── aicalllogs.js   # 调用记录模块
│   ├── attachments.js  # 附件管理模块
│   └── auth.js         # 认证与初始化（DOMContentLoaded，最后加载）
└── admin.html          # 保留（旧入口，向后兼容）
```

## 二、核心原则

### 2.1 文件分离

- **CSS**：所有样式写在 `css/admin.css`，禁止在 HTML 中使用 `<style>` 标签或行内 `style` 属性（弹窗动态样式除外）。
- **JS**：按功能模块拆分到 `js/` 目录下的独立文件，禁止在 `index.html` 的 `<script>` 标签中编写业务逻辑（仅允许路由函数 `switchPage()` 和控制台 `loadDashboard()`）。
- **HTML**：所有页面和弹窗的 HTML 结构集中在 `index.html` 中，使用 `<div id="page-xxx">` 标识页面容器。

### 2.2 全局作用域约定（无 ES Module）

所有 JS 文件运行在全局作用域中，因此需要遵守以下约定：

- **函数命名**：每个模块的函数使用模块前缀或唯一名称，避免跨文件冲突。例如附件模块使用 `loadAttachments()`、`uploadAttachments()`、`deleteAttachment()`。
- **变量命名**：分页变量使用模块前缀，如 `currentScriptPage`、`attPage`、`aclPage`。
- **依赖顺序**：`common.js` 定义 `toast()`、`api()`、`esc()`、`fmtDate()`、`fmtSize()` 等公共函数，其他模块依赖这些函数。`auth.js` 依赖 DOM 加载完成，最后加载。

### 2.3 Script 加载顺序

```html
<script src="js/common.js"></script>       <!-- 1. 无依赖，定义公共函数 -->
<script src="js/scripts.js"></script>      <!-- 2. 脚本管理（依赖 common.js） -->
<script src="js/users.js"></script>        <!-- 3. 用户管理 -->
<script src="js/categories.js"></script>   <!-- 4. 分类管理 -->
<script src="js/appkeys.js"></script>      <!-- 5. AppKey 管理 -->
<script src="js/aimodels.js"></script>     <!-- 6. AI 模型配置 -->
<script src="js/aicalllogs.js"></script>   <!-- 7. 调用记录 -->
<script src="js/attachments.js"></script>  <!-- 8. 附件管理 -->
<script src="js/auth.js"></script>         <!-- 9. 认证与 DOMContentLoaded 初始化 -->
```

**规则**：
- `common.js` 必须第一个加载。
- `auth.js` 必须最后一个加载（因为包含 `DOMContentLoaded` 事件监听）。
- 中间模块顺序无硬性依赖，但按复杂度排列（scripts 最复杂，排最前）。

## 三、新增页面步骤

### Step 1：创建 JS 模块文件

创建 `public/js/newfeature.js`：

```javascript
// ============ 全局状态 ============
let nfPage = 1;

// ============ 功能函数 ============
async function loadNewFeature(page) {
  // 使用 api() 和 toast() 等公共函数
}

function showNewFeatureModal() {
  // 弹窗逻辑
}

function saveNewFeature() {
  // 保存逻辑
}
```

### Step 2：在 index.html 中添加侧边栏导航

在 `.sidebar-nav` 中添加：

```html
<div class="nav-item" data-page="newfeature" onclick="switchPage('newfeature')">
  <span class="icon">🆕</span> 新功能
</div>
```

### Step 3：在 index.html 中添加页面容器

在 `main-content` 内添加：

```html
<div id="page-newfeature" class="page">
  <div class="page-header"><h2>新功能</h2></div>
  <div class="card">
    <!-- 页面内容 -->
    <div class="table-wrap">
      <table>...</table>
    </div>
    <div class="pagination" id="nfPagination"></div>
  </div>
</div>
```

### Step 4：在 index.html 的 `switchPage()` 中添加路由

```javascript
if (page === 'newfeature') loadNewFeature(1);
```

### Step 5（可选）：添加弹窗

在 `</div></div>`（mainPage 结束标签）之后、`<script>` 之前添加弹窗 HTML。

## 四、公共工具函数（common.js）

| 函数 | 说明 |
|------|------|
| `toast(msg, type)` | 显示提示消息，type 为 `'success'` 或 `'error'` |
| `api(method, path, body, isFormData)` | 封装 fetch 请求，自动携带 Authorization header，401 自动登出 |
| `esc(str)` | HTML 转义 |
| `fmtDate(d)` | 格式化日期为 zh-CN locale 字符串 |
| `fmtSize(bytes)` | 格式化文件大小（B/KB/MB） |

## 五、认证模块（auth.js）

定义全局变量和函数：

| 变量/函数 | 说明 |
|-----------|------|
| `token` | 当前登录 token |
| `currentUser` | 当前用户信息对象 |
| `login()` | 登录并保存到 localStorage |
| `logout()` | 登出并清除 localStorage |
| `copyToken()` | 复制 token 到剪贴板 |
| `refreshToken()` | 返回登录页等待重新登录 |
| `DOMContentLoaded` 监听器 | 恢复登录状态、注册事件监听（回车登录、附件上传区拖拽等） |

## 六、CSS 规范（admin.css）

- CSS 变量统一在 `:root` 中定义（`--primary`, `--bg`, `--text`, `--border` 等）。
- 组件样式命名采用语义化类名（`.btn`, `.card`, `.modal-overlay`, `.table-wrap`）。
- 状态类使用 `.badge-{status}` 约定。
- 弹窗动画使用 `@keyframes fadeIn` 和 `@keyframes slideIn`。
- 响应式断点按需添加，当前仅有一处 `@media(max-width:1100px)`。

## 七、JS 模块模板

每个 JS 模块文件遵循统一结构：

```javascript
// ============ 全局状态（模块级变量） ============
let moduleVar1 = null;
let moduleVar2 = 1;

// ============ 核心 CRUD 函数 ============
async function loadModule(page) { ... }
function showModuleModal() { ... }
function closeModuleModal() { ... }
function saveModule() { ... }
function deleteModule(id) { ... }

// ============ 辅助函数 ============
function renderModuleList(data) { ... }
```

## 八、禁止事项

1. **禁止**在 `index.html` 的 `<script>` 标签中编写超过 5 行的业务逻辑。
2. **禁止**在 HTML 中使用内联 `style` 属性（`style="display:none"` 除外）。
3. **禁止**创建新的 CSS 文件——所有样式统一放入 `admin.css`。
4. **禁止**使用 ES Module（`import`/`export`）——所有代码运行在全局作用域。
5. **禁止**在 `DOMContentLoaded` 之外直接操作 DOM（需确保 DOM 已就绪）。
