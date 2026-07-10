# 采集优化方案：API采集 → DOM采集

## 摘要

将详情采集从「browserFetch 调 feed API + 额外行为模拟」改为「搜索页点击卡片 → `__INITIAL_STATE__` 提取 → 关闭弹窗」。每条耗时从 ~15s 降至 ~5-6s，60条从 15分钟降至 6分钟，且点击本身就是行为事件，无需额外模拟。

## 当前实现状态

### sign_server.js — 端点已添加，存在语法错误

3个新端点已插入到 sign_server.js（`/simulate` 之后）：
- `/scrape-note` (POST, 行580-812) — 完整的 DOM 采集 IIFE 脚本，包含 getNoteElements/humanMouseMove/waitForDetailOpen/extractFromSSR/extractFromDOM/closeDetail
- `/scroll-search` (POST, 行814-848) — **⚠️ 语法错误**：行825和840使用了转义反引号 `\``，在 JS 源码中无效
- `/note-count` (GET, 行850-869) — 简单查询笔记卡片数量

**语法错误详情**（`node -c` 确认）：
```
sign_server.js:825
    const result = await bv.webContents.executeJavaScript(\`
                                                          ^
SyntaxError: Invalid or unexpected token
```

**修复方案**：将 `/scroll-search` 中的 `\`` 改为普通反引号 `` ` ``，与 `/scrape-note` 端点的写法保持一致（使用模板字符串字面量，不转义）。

### xhs-feed-collect.js — 未开始重写

当前仍为 API 采集模式，包含 browserFetch/getDynamicSign/fetchFeed/fetchFeedFallback/simulateHumanBehavior 等函数。

## 修改方案

### 步骤1：修复 sign_server.js 语法错误

文件：`electron/services/sign_server.js`

修复 `/scroll-search` 端点（行825、840）的转义反引号：
- 行825：`executeJavaScript(\`` → `executeJavaScript(`` ` `` ``
- 行840：`\`, true)` → `` `, true) ``
- 同时将模板内的 `${amount || ...}` 和 `${waitMs || ...}` 改为字符串拼接或使用占位符替换方式（与 /scrape-note 一致），因为 executeJavaScript 的模板字符串中 `${}` 会被 Node.js 先求值

具体改法：将 /scroll-search 重写为与 /scrape-note 相同的模式——先定义模板字符串用 `__AMOUNT__`/`__WAIT_MS__` 占位，再 `.replace()` 替换。

修复后运行 `node -c sign_server.js` 验证语法通过。

### 步骤2：重写 xhs-feed-collect.js

文件：`scripts/xhs-collection/xhs-feed-collect.js`

**保留的模块：**
- `http`/`fs`/`path` require
- `SIGN_SERVER_URL` 配置
- `checkSignServer()` 函数
- `browserNavigate()` 函数（DOM采集仍需导航到搜索页）
- `sleep()`/`randomDelay()`/`log()` 工具函数
- `KEYWORDS` 数组（80个关键词）
- `OUTPUT_DIR`/`FEED_DIR` 路径配置
- `START_INDEX` 断点续采支持

**新增函数：**

```javascript
// 调 /scrape-note 端点采集单条笔记
function browserScrapeNote(index) {
  // POST { index } → { ok, data, noteId, noteCount }
}

// 调 /scroll-search 端点滚动搜索页
function browserScrollSearch(amount, waitMs) {
  // POST { amount, waitMs } → { ok, noteCount }
}

// 调 /note-count 端点获取笔记数量
function getNoteCount() {
  // GET → { ok, noteCount }
}

// 适配 DOM 采集数据为统一格式
function adaptScrapedData(scraped, keyword) {
  // 将 SSR/DOM 提取的数据适配为与原 API 采集一致的输出格式
}
```

**重写 `collectKeyword()` 函数：**
```
1. browserNavigate(搜索页URL) → 等待笔记加载
2. getNoteCount() 确认笔记已加载
3. for i = 0 to MAX_NOTES_PER_KEYWORD(60):
   a. 若 i >= noteCount-3，browserScrollSearch() 加载更多
   b. browserScrapeNote(i) → 点击卡片 → SSR提取 → 关闭
   c. 若 ok: adaptScrapedData() → push to results
   d. 若 !ok: log 错误，跳过
   e. 每8条 sleep(BATCH_PAUSE_DURATION=8s)，否则 sleep(DETAIL_DELAY=2-4s)
4. 保存JSON文件
5. sleep(KEYWORD_PAUSE=5-10s)
```

**删除废弃函数和依赖：**
- `browserFetch()` / `getDynamicSign()` / `fetchFeed()` / `fetchFeedFallback()`
- `extractDetail()` / `simulateHumanBehavior()` / `browserSimulate()`
- `browserScroll()` / `fetchSearch()` 及搜索 API 签名逻辑
- `require('./xs-common-node')` / `require('./xys-sign-node')`
- `COMMON_COOKIES` / `getBrowserCookies()` / cookie 同步逻辑
- `initXysSign()` / `generateHeaders()` 调用

**配置常量：**
```javascript
const MAX_NOTES_PER_KEYWORD = 60;
const DETAIL_DELAY_MIN = 2000;
const DETAIL_DELAY_MAX = 4000;
const BATCH_PAUSE_EVERY = 8;
const BATCH_PAUSE_DURATION = 8000;
const MAX_SCROLLS = 5;
const KEYWORD_PAUSE_MIN = 5000;
const KEYWORD_PAUSE_MAX = 10000;
```

**简化 `main()` 函数：**
- 移除 XYS_ 签名初始化、cookie 同步逻辑
- 保留 sign_server 可用性检测（DOM采集仍需 sign_server 执行 executeJavaScript）

### 步骤3：语法验证 + 提交

1. `node -c electron/services/sign_server.js` — 验证 sign_server 语法
2. `node -c scripts/xhs-collection/xhs-feed-collect.js` — 验证采集脚本语法
3. `git add -A && git commit` — 提交

## 数据流对比

```
当前（API采集）:                     优化后（DOM采集）:
  fetchSearch() → 搜索API               browserNavigate() → 搜索页
  browserFetch() → feed API             browserScrapeNote(i) → 点击卡片
  browserSimulate() → 鼝鼠模拟            ↓ 页面自行请求feed API
  simulateHumanBehavior() → 导航           ↓ __INITIAL_STATE__ 更新
  ~15s/条                               extractFromSSR() → 读取数据
                                       closeDetail() → 关闭弹窗
                                       ~5-6s/条
```

## 风险与应对

| 风险 | 应对 |
|------|------|
| `__INITIAL_STATE__` 未及时更新 | waitForDetailOpen 后额外 sleep(800ms)，DOM 提取降级 |
| 弹窗未打开/关闭失败 | 10s 超时跳过，Escape 键兜底，多选择器匹配 |
| 搜索结果不足60条 | 滚动5次无新笔记则停止 |
| 长时间运行页面卡顿 | 每5关键词重新导航搜索页 |
| 选择器失效 | 多选择器兼容（`section.note-item, [class*="note-item"]`） |

## 预期效果

| 指标 | 当前(API) | 优化后(DOM) |
|------|-----------|-------------|
| 单条耗时 | ~15s | ~5-6s |
| 60条总耗时 | ~15分钟 | ~6分钟 |
| 签名复杂度 | XYS_+x-s-common | 无（页面自行处理） |
| 行为模拟 | 额外browserSimulate | 点击即行为 |
| 风控风险 | 300015/300011 | 极低（无直接API调用） |

## 验证步骤

1. 重启 Electron 应用使 sign_server 新端点生效
2. 单个关键词测试：确认 `__INITIAL_STATE__` 提取正常、弹窗关闭正常
3. 检查保存的 JSON 文件数据完整性（标题、描述、图片、互动数据）
4. 确认无误后批量采集
