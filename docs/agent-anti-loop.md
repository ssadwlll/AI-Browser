# AI Agent 防死循环机制

## 设计理念

传统防死循环方案按"同一工具调用次数"设硬限制，存在两个问题：

1. **误杀合理场景**：翻页采集 `extract_content` 调8次是正常的，但硬限制5次就杀掉了
2. **漏杀异常场景**：`inject_js` 反复失败3次就该停，但硬限制5次才停太晚

核心观察：**死循环的本质不是"调用多"，而是"无进展"**。

- `inject_js` 成功5次、每次调试不同效果 → 有进展 → 不该停
- `click_element` 点同一个按钮5次没反应 → 无进展 → 该停
- `extract_content` 翻页8次、每次内容不同 → 有进展 → 不该停
- `extract_content` 同一元素提取5次内容相同 → 无进展 → 该停

因此，采用 **"连续无进展检测"** 替代 "调用次数限制"。

---

## 防护层级

Agent 共有 **8 层** 由内到外的防护：

### 1. 连续无进展检测（核心）

**变量**：`consecutiveFailCount`，阈值 `MAX_CONSECUTIVE_FAILS = 5`

每次工具执行后，基于**结构化字段**判断是否有进展（不依赖字符串匹配）：

| 条件 | 判定 | 计数器 |
|------|------|--------|
| 工具执行**失败**（`ok: false`） | 无进展 | `+1` |
| `navigate_to_url` / `go_back`（无论成功失败） | 无进展 | `+1` |
| `search_tools` 搜索结果为空 | 无进展 | `+1` |
| 工具执行**成功**且 `result`/`content`/`title` 有值且无 `error` | 有进展 | **重置为0** |
| JSON 解析失败 | 无进展 | `+1` |

连续5次无进展 → 强制退出，输出提示信息。

**关键特性**：
- 中间只要有一次成功，计数器就重置，不会"累加历史"
- 导航类工具不重置计数（导航成功≠任务有进展，只是改变了位置）
- 正常流程 `navigate → wait_for_element → extract_content` 中，后两步成功会重置计数

```
# 示例：inject_js 反复调试
inject_js (成功) → count=0  ✅
extract_content (成功) → count=0  ✅
inject_js (失败) → count=1  ⚠️
inject_js (失败) → count=2  ⚠️
inject_js (成功，代码修正后) → count=0  ✅ 重置！
inject_js (成功) → count=0  ✅
```

```
# 示例：多页面采集
navigate_to_url(A) → count=1  ⚠️ (导航不重置)
wait_for_element → count=0  ✅ (等待成功重置)
extract_content → count=0  ✅ (提取成功重置)
navigate_to_url(B) → count=1  ⚠️ (导航不重置)
extract_content → count=0  ✅ (提取成功重置)
finish_task → 正常结束 ✅
```

### 2. AI 请求次数上限

**变量**：`aiRequestCount`，阈值 `MAX_AI_REQUESTS = 15`

每次 while 循环（即每次向 AI API 发送请求）+1。这是"思考轮次"的上限，防止 AI 无意义地反复请求。

### 3. 工具调用总次数上限

**变量**：`totalToolCalls`，阈值 `MAX_TOOL_CALLS = 30`

每个工具调用（含 parallel tool calls 中的每个）+1。这是"动作次数"的上限，防止一次返回多个工具时突破限制。

### 4. 超时保护

**阈值**：`TIMEOUT_MS = 120000`（2分钟）

整体运行时间超过2分钟，无论什么状态都强制退出。

### 5. 端口断开检测

**变量**：`portAlive`

Sidepanel 关闭 → port 断开 → `safePost` 标记 `portAlive=false` → while 循环条件不满足 → 退出。

### 6. 空内容退出

AI 返回空内容（`msg.content=''`）且不调用任何工具 → 直接退出，避免空转。

### 7. Messages 上下文截断（分组安全）

**阈值**：`MAX_MESSAGES = 30`

messages 数组超过30条时裁剪早期对话，防止上下文膨胀导致 API 超时或 token 超限。

**分组安全机制**：截断后自动清理可能破坏 API 格式的孤立消息：
- 删除孤立的 `tool` 消息（没有对应 `assistant` 声明的）
- 删除不完整的 `assistant(tool_calls)` + `tool results` 分组（tool_calls 数量与 tool results 不匹配）

确保发送给 API 的 messages 始终符合 `assistant.tool_calls` 与 `tool` 消息一一对应的格式要求。

### 8. API 请求重试（容错）

**阈值**：`MAX_API_RETRIES = 2`

AI API 请求失败时的重试策略：

| 错误类型 | 是否重试 | 说明 |
|---------|---------|------|
| 429 Too Many Requests | ✅ 重试 | 限流，等待后重试 |
| 5xx 服务器错误 | ✅ 重试 | 临时性错误 |
| 网络异常（fetch抛错） | ✅ 重试 | 网络抖动 |
| 401/403 鉴权失败 | ❌ 不重试 | 配置问题，重试无意义 |
| 400 参数错误 | ❌ 不重试 | 请求格式问题 |
| 200 成功 | ❌ 不重试 | 正常响应 |

重试间隔递增：第1次重试等待1s，第2次重试等待2s。重试全部失败后输出带状态码和错误信息的提示。

---

## 配置参数速查

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `MAX_AI_REQUESTS` | 15 | AI API 请求轮次上限 |
| `MAX_TOOL_CALLS` | 30 | 工具调用总次数上限 |
| `MAX_CONSECUTIVE_FAILS` | 5 | 连续无进展次数上限 |
| `MAX_API_RETRIES` | 2 | API 请求失败重试次数 |
| `TIMEOUT_MS` | 120000 | 整体超时（毫秒） |
| `MAX_MESSAGES` | 30 | messages 数组最大长度 |
| `MAX_TOOL_RESULT_LEN` | 2000 | 单个工具结果截断长度 |

---

## 典型场景分析

### 场景1：翻页采集（正常）

```
extract_content(第1页) → 有进展 → count=0
scroll_page → 有进展 → count=0
extract_content(第2页) → 有进展 → count=0
scroll_page → 有进展 → count=0
extract_content(第3页) → 有进展 → count=0
finish_task → 正常结束 ✅
```

### 场景2：注入脚本反复调试（正常）

```
inject_js(v1) → 成功 → count=0
extract_content → 成功 → count=0
inject_js(v2, 修正后) → 成功 → count=0
extract_content → 成功 → count=0
finish_task → 正常结束 ✅
```

### 场景3：多页面采集（正常）

```
navigate_to_url(A) → count=1  ⚠️ (导航不重置)
wait_for_element → 成功 → count=0  ✅
extract_content → 成功 → count=0  ✅
navigate_to_url(B) → count=1  ⚠️
extract_content → 成功 → count=0  ✅
finish_task → 正常结束 ✅
```

### 场景4：搜索不到工具反复重试（死循环，被拦截）

```
search_tools("爬虫") → 搜不到 → count=1
search_tools("采集") → 搜不到 → count=2
search_tools("抓取") → 搜不到 → count=3
search_tools("数据") → 搜不到 → count=4
search_tools("下载") → 搜不到 → count=5 → 强制退出 ⛔
```

### 场景5：登录弹窗阻塞（死循环，被拦截）

```
click_element(关闭按钮) → 失败 → count=1
extract_content → 内容被弹窗遮挡 → count=2
press_key(Escape) → 失败 → count=3
extract_content → 同样内容 → count=4
click_element(另一按钮) → 失败 → count=5 → 强制退出 ⛔
```

### 场景6：inject_js 反复失败（被拦截）

```
inject_js(代码有语法错) → 失败 → count=1
inject_js(修正后仍有错) → 失败 → count=2
inject_js(再修正仍有错) → 失败 → count=3
inject_js(继续错) → 失败 → count=4
inject_js(还是错) → 失败 → count=5 → 强制退出 ⛔
```

### 场景7：连续导航但不提取内容（死循环，被拦截）

```
navigate_to_url(A) → count=1  ⚠️
navigate_to_url(B) → count=2  ⚠️
navigate_to_url(C) → count=3  ⚠️
navigate_to_url(D) → count=4  ⚠️
navigate_to_url(E) → count=5 → 强制退出 ⛔
```

### 场景8：API 限流（自动重试后恢复）

```
AI请求 → 429 → 等待1s → 重试 → 429 → 等待2s → 重试 → 200 ✅
继续执行任务
```

### 场景9：API 鉴权失败（不重试，直接退出）

```
AI请求 → 401 → 不重试 → 输出 "AI API错误: 401" → 退出 ⛔
```

---

## 与旧方案对比

| 维度 | 旧方案（toolCallCount） | 新方案（consecutiveFailCount） |
|------|------------------------|-------------------------------|
| 检测依据 | 同一工具调用次数 | 是否有进展 |
| 翻页采集8次 | 被误杀 ❌ | 正常运行 ✅ |
| inject_js调试5次 | 被误杀 ❌ | 正常运行 ✅ |
| 同一按钮点5次没反应 | 第5次才杀 | 第5次杀（但会先检测无进展） |
| 不同工具交替失败 | 不计数 | 计数 ✅ |
| 中间成功一次 | 不重置 | 重置 ✅ |
| 连续导航不提取 | 不计数 | 计数 ✅ |
| API限流 | 直接退出 | 自动重试 ✅ |
| 判断方式 | 字符串匹配 | 结构化字段 ✅ |
