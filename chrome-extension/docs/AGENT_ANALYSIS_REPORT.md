# AI Browser Agent 深度分析报告

> 主题：AI 自主决策机制、上下文窗口管理、数据管理
> 分析日期：2026-07-04
> 分析对象：`background/services/` 下 Agent 核心模块
> 文档定位：基于最新代码的"机制级"深度剖析，揭示运行时行为与设计取舍

---

## 一、整体架构概览

Agent 子系统采用「单阶段、待办驱动、软收敛」的设计哲学，所有工具在每轮全量可用，由 LLM 自主决策下一步动作。系统通过三层记忆 + 三级存储协同工作，避免长任务失忆和上下文爆炸。

### 1.1 核心模块关系

```
agent-service.js         生命周期管理 + Port 弹性
    └─ agent-runner.js   ★ 主循环（自主决策/上下文/数据流转）
         ├─ agent-tool-builder.js   构建全工具列表
         ├─ agent-dom-executor.js   DOM 工具执行
         ├─ agent-payload-utils.js  数据存储判断 + 截断策略
         ├─ working-memory.js       结构化工作记忆
         ├─ context-compressor.js   LLM 驱动上下文压缩
         ├─ todo-scheduler.js       待办调度 + 硬性规则
         ├─ payload-store.js        大数据外置存储
         ├─ scratchpad-service.js   断点续传快照
         ├─ output-service.js       任务结果归档
         └─ agent-judge.js          事后自评
```

### 1.2 三层记忆架构

| 层 | 实现 | 容量 | 生命周期 | 用途 |
|---|---|---|---|---|
| 短期 | `messages` 对话流 | ≤40 条 | 单轮任务 | LLM 直接上下文 |
| 中期 | `WorkingMemory` 结构化 | 7 字段 + FIFO 上限 | 单轮任务 | 跨轮保持决策连贯 |
| 长期 | `PayloadStore` + `GlobalDataStore` | 不限（外置） | 跨会话继承 | 大数据持久化 |

---

## 二、AI 自主决策机制

### 2.1 单阶段全工具可用（关键变化）

旧版"三阶段"已被合并为单阶段。代码确认：

**[agent-runner.js:8](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L8)**：仅导入 `buildTools`，无 `buildPhase1Tools` / `buildPhase2Tools`。

**[agent-runner.js:409](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L409)**：每轮调用同一个 `buildTools`，传入 `searchResults`、`currentPageUrl`、`aiRequestCount+1`。

```javascript
const tools = buildTools(searchResults, currentPageUrl, aiRequestCount + 1,
                         scriptService, filteredScriptsCache, domainMismatchLogged)
```

含义：从第 1 轮起，DOM 工具、inject_script_N、generate_script、finish_task 等全部可用。系统不再硬性切换阶段，而是让 AI 根据待办进度自主选择工具。

### 2.2 工具选择完全自主

**[agent-runner.js:426](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L426)**：

```javascript
tools, tool_choice: 'auto',
```

LLM 收到完整工具列表后，自主决定是否调用工具、调用哪个、参数如何。系统不干预决策本身，仅做边界防护。

### 2.3 工具幻觉拦截（关键防护）

**[agent-runner.js:583-590](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L583-L590)**：

```javascript
const allowedToolNames = tools.map(t => t.function.name)
if (!allowedToolNames.includes(funcName)) {
  const rejectMsg = JSON.stringify({ ok: false,
    error: `工具 "${funcName}" 不在当前可用工具列表中，调用被拒绝。
            可用工具：${allowedToolNames.join('、')}。请仅使用列表中的工具。` })
  console.warn(`[Agent] 工具幻觉拦截: ${funcName}`)
  messages.push({ role: 'tool', tool_call_id: toolCall.id, content: rejectMsg })
  postToUI(tabId, { type: 'agentStepResult', step: totalToolCalls + 1,
                    toolName: `${funcName}(幻觉拦截)`, result: rejectMsg, done: false })
  continue  // ← 不计入 totalToolCalls
}
```

要点：
- 不命中 `allowedToolNames` 的工具调用被拦截
- **不计入 `totalToolCalls`**（避免误触工具次数上限）
- 返回拒绝原因 + 可用工具列表，引导 LLM 自我纠正
- UI 显示"幻觉拦截"标记，便于调试

### 2.4 收敛控制（软强制）

收敛通过两个机制协同，均为「软强制」（注入 system 消息引导 LLM，不拦截 tool_calls）。

#### 2.4.1 预算阈值提示

**[todo-scheduler.js:11-16](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/todo-scheduler.js#L11-L16)**：

```javascript
const HARD_RULES = {
  FAIL_THRESHOLD: 5,        // 连续5次无进展 → 强制finish_task
  SCRIPT_FAIL_THRESHOLD: 3, // 连续3次脚本失败 → 强制finish_task
  CONVERGENCE_70: 0.7,
  CONVERGENCE_85: 0.85,
}
```

**[todo-scheduler.js:178-194](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/todo-scheduler.js#L178-L194)** 的 `getConvergencePrompt`：
- 70% 预算：软提醒"请加快推进核心待办"
- 85% 预算：紧急收敛"请立即完成剩余待办或调用 finish_task"
- **一次性触发**：通过 `_convergence70Fired` / `_convergence85Fired` 标志位避免重复注入

#### 2.4.2 硬性规则强制完成

**[agent-runner.js:393-397](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L393-L397)**：

```javascript
const forceFinish = todoScheduler.shouldForceFinish()
if (forceFinish.force) {
  _debugLog('🚨 硬性规则触发强制完成', forceFinish)
  _injections.push(`⚠️ 系统检测到${forceFinish.reason}，请立即调用 finish_task 汇报当前已有结果。不要再尝试其他操作。`)
}
```

`shouldForceFinish` 触发条件（[todo-scheduler.js:198-206](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/todo-scheduler.js#L198-L206)）：
- `failCount >= 5`（连续 5 次无进展）
- `scriptFailCount >= 3`（连续 3 次脚本失败）

⚠️ **重要**：即使硬性规则触发，仍是注入 system 消息"建议"LLM 调用 finish_task，**不是真正拦截**。LLM 理论上仍可选择其他工具。这种设计尊重 LLM 自主性，但极端情况下可能继续浪费预算。

### 2.5 主循环结构

**[agent-runner.js:329](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L329)**：`while (aiRequestCount < maxRounds)`

每轮执行流程：
1. 中止信号检查（`agentStates.get(tabId)?.aborted`）
2. 超时检查（`TIMEOUT_MS`）
3. 工具调用次数检查（`MAX_TOOL_CALLS = min(200, max(30, maxRounds*3))`）
4. 清理临时消息（`_temp` 标记）
5. Port 连接检查
6. 收敛提示注入
7. 待办进度上下文注入
8. WorkingMemory 上下文注入
9. shouldForceFinish 检查
10. 构建工具列表（每轮重建，反映最新 searchResults）
11. 系统 nudge 聚合注入
12. 调用 LLM API
13. 处理 tool_calls 或纯文本回复
14. WorkingMemory 自动提取
15. 待办匹配与进度更新
16. 工具结果存储判断
17. ScratchpadService 持久化
18. 上下文压缩检查

---

## 三、上下文窗口管理

### 3.1 消息数组构建

**[agent-runner.js:248-252](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L248-L252)**：

```javascript
const messages = lastIsUserMsg
  ? [systemMsg, ...cleanHistory]
  : [systemMsg, ...cleanHistory, { role: 'user', content: userMessage }]
```

初始结构：`[system, ...cleanHistory, user]`。后续每轮追加 assistant（含 tool_calls）+ tool 结果。

### 3.2 历史清洗（避免污染）

**[agent-runner.js:84-109](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L84-L109)** 两步清洗：

**步骤 1：移除末尾失败回复**
```javascript
const failureMarkers = ['❌', '脚本语法错误', '执行失败', 'Unexpected identifier',
                        'appKey', 'appSecret', '认证失败', '401', '403']
while (rawHistory.length >= 2) {
  const last = rawHistory[rawHistory.length - 1]
  if (last.role === 'assistant' && failureMarkers.some(m => last.content?.includes(m))) {
    rawHistory.pop()
    if (rawHistory[rawHistory.length - 1]?.role === 'user') rawHistory.pop()
  } else break
}
```

**步骤 2：长 assistant 消息压缩**
```javascript
if (clean.role === 'assistant' && clean.content.length > 1000) {
  const head = original.slice(0, 500)
  const tail = original.slice(-200)
  clean.content = head + `\n\n...(对话历史已压缩，原始${original.length}字符)...\n\n` + tail
}
```

同时移除 `toolCalls` / `tool_calls` 字段（避免 OpenAI API 拒绝带 tool_calls 但无对应 tool 消息的历史）。

### 3.3 临时消息清理（防膨胀）

**[agent-runner.js:349-359](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L349-L359)**：

```javascript
const tempMsgs = messages.filter(m => m._temp)
if (tempMsgs.length > 0) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._temp) messages.splice(i, 1)
  }
}
```

每轮开始时清理上一轮的临时消息（如 `payloadStore` 数据摘要、待办进度提示等带 `_temp` 标记的消息），避免上下文累积膨胀。

### 3.4 上下文压缩（LLM 驱动）

#### 3.4.1 触发条件

**[agent-runner.js:1135-1137](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L1135-L1137)**：

```javascript
const MAX_MESSAGES = 40
if (messages.length > MAX_MESSAGES) {
  const keepRecent = Math.floor(MAX_MESSAGES * 0.6)  // 24
  let cutOff = messages.length - keepRecent
```

当 `messages.length > 40` 时触发，保留最近 24 条，压缩前面的（cutOff 之前）。

#### 3.4.2 cutOff 调整

**[agent-runner.js:1139-1141](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L1139-L1141)**：

```javascript
if (cutOff > 1) {
  while (cutOff < messages.length && messages[cutOff]?.role === 'tool') cutOff++
}
```

避免在 tool 消息中间切割（破坏 assistant→tool 的配对关系）。

#### 3.4.3 LLM 压缩执行

**[agent-runner.js:1144-1147](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L1144-L1147)**：

```javascript
const summaryMsg = await contextCompressor.compress(messages, cutOff, userMessage, workingMemory)
if (summaryMsg) {
  messages.splice(1, cutOff - 1, summaryMsg)  // 用 1 条摘要替换 cutOff-1 条
}
```

`ContextCompressor.compress`（[context-compressor.js:49](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/context-compressor.js#L49)）：
- **输入**：`messages[1..cutOff]`（跳过 system prompt）
- **截断**：输入文本截到 6000 字符（[L76](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/context-compressor.js#L76)）
- **模型**：使用主任务同模型，`temperature: 0.1`，`max_tokens: 1024`，15s 超时
- **提示词**：`COMPRESSION_SYSTEM_PROMPT`（[L10-33](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/context-compressor.js#L10-L33)）要求输出五个固定章节：
  1. 关键发现
  2. 已做决策
  3. 排除方案
  4. 数据引用
  5. 当前状态

#### 3.4.4 4 种降级场景

`_ruleBasedFallback`（[L190-247](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/context-compressor.js#L190-L247)）在以下情况触发：
1. `inputText.length < 1500`（输入过短，不值得 LLM 压缩）
2. HTTP 请求失败（`!res.ok`）
3. LLM 摘要过短（`summary.length < 50`）
4. 异常捕获

降级策略：保留 `extract_content` 的链接列表、`inject_script_N` 结果前 300 字符、其他工具结果前 80 字符，取最后 10 条拼接。

### 3.5 孤立 tool 消息清理

**[agent-runner.js:1149-1157](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L1149-L1157)**：

```javascript
const validToolCallIds = new Set()
for (const m of messages) {
  if (m.role === 'assistant' && m.tool_calls) {
    for (const tc of m.tool_calls) validToolCallIds.add(tc.id)
  }
}
for (let i = messages.length - 1; i >= 0; i--) {
  if (messages[i].role === 'tool' && !validToolCallIds.has(messages[i].tool_call_id)) {
    messages.splice(i, 1)
  }
}
```

压缩后可能残留无对应 assistant 的 tool 消息（OpenAI API 会拒绝），此清理保证消息配对完整性。

### 3.6 WorkingMemory 上下文注入

**[agent-runner.js:385-390](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L385-L390)**：

```javascript
if (aiRequestCount > 1) {
  const memoryContext = workingMemory.toContext({
    includeErrors: true, includePage: false, maxLen: 1200
  })
  if (memoryContext) _injections.push(memoryContext)
}
```

- **第 2 轮起**注入（第 1 轮还没有工具结果可提取）
- `includePage: false`（避免与 userMessage 中的页面内容重复）
- `maxLen: 1200`（控制注入大小）

`WorkingMemory.toContext`（[working-memory.js:123-170](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/working-memory.js#L123-L170)）输出结构：
```
任务目标: ...
当前页面: ...
关键发现:
  - ...
已做决策:
  - ...
已排除: ...
已收集数据:
  - p1: 15条 (...) [ID:p1]
近期错误:
  - 轮次5 extract_content: 选择器无匹配
```

### 3.7 自动提取机制

**[agent-runner.js:974](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L974)**：

```javascript
workingMemory.autoExtractFromToolResult(funcName, funcArgs, toolResult, aiRequestCount)
```

无需 AI 介入，每个工具结果自动提取关键信息（[working-memory.js:176-237](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/working-memory.js#L176-L237)）：
- `navigate_to`/`go_back`/`go_forward` → 记录决策
- `extract_content` 成功 → 记录发现（数量 + 是否含链接 + 选择器）
- 工具失败 → 记录排除（选择器）+ 错误
- `inject_script_N` 成功 → 记录发现（数据条数/处理记录数）
- `inject_script_N` 失败 → 记录错误
- `read_page_content` → 更新页面状态
- `create_todo` 成功 → 记录决策
- `search_tools` → 记录发现（脚本数量）

### 3.8 ⚠️ 已知缺陷：update_memory 工具未接入

**[working-memory.js:107-117](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/working-memory.js#L107-L117)** 定义了 `applyUpdate` 方法，注释 L7 也声明"支持 AI 通过 update_memory / read_memory 工具主动更新"。

但 Grep 确认：`agent-runner.js` 中**没有任何 `update_memory` 工具的处理分支**，也**没有调用 `workingMemory.applyUpdate`**。

含义：WorkingMemory 当前只能通过 `autoExtractFromToolResult` 自动填充，AI 无法主动写入决策或发现。注释与实现存在偏差。

---

## 四、数据管理

### 4.1 三级存储体系

| 级别 | 存储 | 用途 | 容量 | 隔离 |
|---|---|---|---|---|
| L1 | `chrome.storage.local` | 配置、聊天历史 | ~5MB | 全局 |
| L2 | `IndexedDB` | Scratchpad、Output | 不限 | 按 sessionId/taskId |
| L3 | `chrome.storage.session` | PayloadStore 全量数据 | ~10MB | 按 sessionId |

### 4.2 PayloadStore（大数据外置）

#### 4.2.1 设计核心

**[payload-store.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/payload-store.js)** 采用「内存索引 + session 持久化」双轨：
- **内存索引**（`this.entries`）：快速查询，无需异步
- **chrome.storage.session**：全量数据持久化，Service Worker 重启后可恢复
- **sessionId 任务隔离**：不同任务数据互不污染

#### 4.2.2 单调递增 ID

```
p1, p2, p3, ...
```

即使 FIFO 淘汰旧数据，ID 也不复用，避免 AI 引用旧 ID 时取到新数据导致错乱。

#### 4.2.3 跨会话继承

`inheritFromLastSession`：5 分钟内重启的任务可继承上一会话数据（最多 10 条）。在 [agent-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-service.js) 的 `startAgent` 中调用。

#### 4.2.4 ⚠️ 死代码残留

**[payload-store.js:10](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/payload-store.js#L10)**：
```javascript
this.maxRecallChars = 5000  // recall_data 单次返回上限
```

Grep 确认 `_autoTruncate` 方法不存在，`maxRecallChars` 从未被引用。这是 `recall_data` 工具移除后的残留。

#### 4.2.5 ⚠️ recall_data 工具已移除但 query 保留

**[agent-runner.js:124](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L124)** 系统提示词明确：
```
- recall_data：（已移除，数据摘要直接在工具结果中显示）
```

但 `payload-store.js` 的 `query()` 方法仍保留，且：
- [agent-payload-utils.js:119](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-payload-utils.js#L119)：`if (toolName === 'recall_data') return false`（黑名单）
- [agent-payload-utils.js:262](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-payload-utils.js#L262)：存储提示仍写"可用 recall_data 查询"
- [todo-scheduler.js:170](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/todo-scheduler.js#L170)：`matchToolCall` 仍把 `recall_data` 当特例
- [context-compressor.js:153](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/context-compressor.js#L153)：压缩时仍按 `recall_data` 截断 150 字符
- [global-data-store.js:3](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/global-data-store.js#L3)：注释仍说"供 AI 通过 recall_data 查询"

**建议**：要么重新启用 recall_data（当数据量极大时仍有价值），要么彻底清理残留代码和注释，避免误导。

### 4.3 数据存储判断（agent-payload-utils.js）

#### 4.3.1 shouldStoreToPayload

**[agent-payload-utils.js:117-131](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-payload-utils.js#L117-L131)**：

```javascript
const BLACKLIST = ['search_tools', 'create_todo', 'finish_task', 'read_page_content']
const DATA_TOOLS = ['extract_content', 'get_interactive_elements', 'get_element_info', 'inject_script_']
const DATA_TOOL_THRESHOLD = 800
const OTHER_TOOL_THRESHOLD = 1500

if (BLACKLIST.includes(toolName)) return false
if (DATA_TOOLS.some(t => toolName === t || toolName.startsWith(t))) {
  return result.length > DATA_TOOL_THRESHOLD
}
return result.length > OTHER_TOOL_THRESHOLD
```

策略：
- 黑名单工具永不存储
- 数据采集类工具 ≥800 字符才存储
- 其他工具 ≥1500 字符才存储

#### 4.3.2 storeToPayload 返回值

**[agent-payload-utils.js:243-263](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-payload-utils.js#L243-L263)**：

存储后返回 schema 摘要 + `generate_script(data_refs)` 调用建议：
```
p1: 15条 | {title:string, url:string} | 样例: [{"title":"...","url":"..."}]
完整数据已存储(ID:p1)，使用 generate_script(data_refs=["p1"]) 操作。
window.__store.p1 是数组，可直接 .filter()/.map()/.forEach() 遍历
```

### 4.4 大结果存储的 4 条路径

**[agent-runner.js:1037-1090](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L1037-L1090)**：

| 路径 | 条件 | 行为 |
|---|---|---|
| 1 | `dataTools.includes(funcName) && returnMode==='full'` | 存纯数组，返回 schema + storeId |
| 2 | `dataTools.includes(funcName) && returnMode==='summary'` | 存纯数组，返回 overview + schema |
| 3 | `shouldStoreToPayload(funcName, toolResult)` | 存原始结果，返回截断 + storeId |
| 4 | 其他 | 直接返回 `smartTruncateResult` 截断结果 |

每条路径都会同步更新 WorkingMemory：
```javascript
workingMemory.addDataRef(funcName, storeId, envelope.count, summaryText)
```

### 4.5 GlobalDataStore（待办级归档）

**[global-data-store.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/global-data-store.js)**：

- 与 PayloadStore 区别：按 `todoId` 索引，每个待办完成时存储其输出
- `getAllSummaries()` 返回所有已收集数据摘要，注入到 `getProgressContext`
- 在 [agent-runner.js:1005](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L1005)：未匹配待办但有进展的工具结果也存入

### 4.6 TodoScheduler（进度追踪）

**[todo-scheduler.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/todo-scheduler.js)**：

#### 4.6.1 扁平待办结构

```javascript
parentTodo = {
  items: [
    { id: "t1", action: "extract_content", description: "...", _status: "done" },
    { id: "t2", action: "inject_script_9", description: "..." },
    { id: "t3", action: "finish_task", description: "汇总输出" }
  ]
}
```

不是树形，避免 AI 生成嵌套结构出错。

#### 4.6.2 工具-待办匹配

**[todo-scheduler.js:164-174](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/todo-scheduler.js#L164-L174)**：

```javascript
matchToolCall(funcName) {
  const todo = this.getCurrentTodo()
  if (!todo) return null
  if (todo.action === funcName) return todo
  if (todo.action?.startsWith('inject_script_') && funcName?.startsWith('inject_script_')) return todo
  if (funcName === 'search_tools' || funcName === 'recall_data' || funcName === 'generate_script') return null
  if (funcName === 'finish_task') return todo
  return null
}
```

含义：
- 工具名完全匹配 → 关联当前待办
- `inject_script_*` 模糊匹配（具体 ID 可不同）
- 辅助工具（search_tools / generate_script）不关联任何待办
- `finish_task` 总是匹配当前待办

#### 4.6.3 进度判定

**[agent-runner.js:976-1019](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L976-L1019)**：

- `search_tools`：有结果即算进展
- `create_todo`：`parsed.ok === true` 算进展
- `generate_script`：`parsed.ok === true` 算进展
- 其他工具：`parsed.ok === true || undefined` 且有内容且无 error 算进展
- `read_page_content` / `scroll_page` 无待办匹配时**不算进展**（避免假阳性）

### 4.7 ScratchpadService（断点续传）

**[scratchpad-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/scratchpad-service.js)**：

- 独立 IndexedDB `ai-browser-scratchpad`，keyPath = `sessionId`
- **每轮结束保存**（[agent-runner.js:1126](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L1126)）：
  ```javascript
  await scratchpadService.save(sessionId, workingMemory.state, {
    round: aiRequestCount,
    todoIndex: todoScheduler.currentTodoIndex,
  })
  ```
- 保存内容：`{sessionId, timestamp, taskGoal, state, lastRound:{round, todoIndex}, totalRounds}`

⚠️ **注释与实现偏差**：注释声明 `roundSummary` 含 `{round, stage, aiResponse, toolCalls, toolResults}`，实际只保存 `{round, todoIndex}`。这降低了断点续传的恢复精度。

### 4.8 OutputService（任务归档）

**[output-service.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/output-service.js)**：

- 独立 IndexedDB `ai-browser-outputs`，keyPath = `taskId`
- `finish_task` 时保存完整 output（[agent-runner.js:676-699](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L676-L699)）：
  ```javascript
  const output = {
    taskId, sessionId, userMessage,
    startTime, endTime, durationMs,
    status: judgeResult?.verdict || 'unknown',
    summary,
    workingMemoryState: workingMemory.state,
    dataOutputs: payloadStore.entries.map(...),
    judgeResult,
  }
  ```

⚠️ **注释与实现偏差**：注释提到 `conversationLog: [...]`，实际未包含。这导致 [task-archive-service.js:52](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/task-archive-service.js#L52) 的 `output.conversationLog?.length` 永远返回 0，复盘分析功能失效。

### 4.9 简单请求快速路径

**[agent-runner.js:280-321](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L280-L321)**：

```javascript
const SIMPLE_REQUEST_PATTERNS = ['导出', 'csv', 'excel', '格式化', '整理成', '转换',
                                  '翻译', '汇总', '合并', '去重', '统计', '分析',
                                  '列表', '重新输出', '再给我']
const isFollowUp = cleanHistory.length > 0
  && (payloadSummary || globalSummaries.length > 0)
  && userMessage.length <= 20
  && !userMessage.match(/采集|抓取|批量获取|爬|下载|打开|访问|点击/)
```

触发条件：
- 有上轮数据 + 用户消息 ≤20 字 + 非采集类动作 → 追问模式
- 有上轮数据 + 含数据操作关键词 + 非采集类动作 → 简单数据请求

行为：清空 messages，替换为精简 quickPrompt，仅暴露 `generate_script` 和 `finish_task` 两个工具，跳过页面探索。

### 4.10 finish_task 流程

**[agent-runner.js:603-716](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L603-L716)**：

1. 更新待办进度（finish_task 也算一个待办）
2. 处理 `data_refs` 参数：异步从 storage 读取全量数据，拼接到 summary
3. 注入 payloadStore 全量数据汇总提示
4. 返回 tool 结果 `{ok: true, summary}`
5. 事后自评 `runJudge`（temperature=0.1, max_tokens=128, 10s 超时）
6. 流式输出 `summary + referencedData + judgeMsg`（每字 15ms 延迟）
7. `saveToChatHistoryStorage` 保存到聊天历史（双重上限：50 条 / 8000 字符）
8. `toolRecordingService.record` 录制
9. `outputService.save` 持久化到 IndexedDB
10. 延迟 2 秒关闭待办面板

---

## 五、Agent 生命周期与 Port 弹性

### 5.1 启动流程（agent-service.js）

**[agent-service.js:30-147](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-service.js#L30-L147)** `startAgent`：

1. 中止旧任务（设置 `aborted = true`）
2. 清理旧状态
3. **继承 payloadStore**（不清除，供后续查询）
4. 启动录制和快照
5. 调用 `runAgent(ctx)`

### 5.2 Port 弹性

- `detachPortByPort`：SidePanel 关闭时不中止 Agent，缓冲消息
- `attachPort`：SidePanel 重连时回放暂存消息

### 5.3 finally 清理

⚠️ **关键**：`payloadStore` 不清除（[agent-service.js:121](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-service.js#L121) 注释明确），保留供后续 `recall_data` 查询。但 `recall_data` 已移除，此设计意图已失效。

### 5.4 延迟删除 state

延迟 30 秒删除 `agentStates`，让 SidePanel 有机会重连。

---

## 六、工具系统

### 6.1 工具构建

**[agent-tool-builder.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-tool-builder.js)** `buildTools`：

- 单阶段构建全部工具
- 工具类别：DOM 操作、脚本执行、数据管理、任务控制
- 服务端脚本按经验记忆成功率降序排序
- 工具描述标注：触发词 / 需登录 / 分页 / 前置检查 / 成功率

### 6.2 工具分类

| 类别 | 工具 | 说明 |
|---|---|---|
| DOM | `extract_content`, `click_element`, `get_interactive_elements`, `get_element_info`, `scroll_page`, `navigate_to`, `go_back`, `go_forward`, `read_page_content` | 页面探索与交互 |
| 脚本 | `inject_script_N`, `generate_script` | 服务端脚本 + 动态生成 |
| 数据 | `capture_network` | 网络请求捕获 |
| 任务 | `create_todo`, `search_tools`, `finish_task` | 任务控制 |

### 6.3 工具执行调度

**[agent-runner.js:568-968](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L568-L968)**：

- 同一轮多个 tool_calls 顺序执行
- `shouldTerminateSequence` 标志：导航类工具成功后跳过后续 tool_calls（页面已跳转）
- `MAX_TOOL_CALLS` 上限检查
- 每个 tool_call 独立计入 `totalToolCalls`

### 6.4 API 失败回退

**[agent-runner.js:504-538](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L504-L538)**：

当 API 返回 400/413 且带 tools 时，移除 tools 参数重试（兼容不支持 Function Calling 的模型）。同时截断最近 3 条消息到 800 字符。

---

## 七、关键设计取舍与发现

### 7.1 设计亮点

1. **单阶段全工具可用**：让 AI 自主决策，避免硬性阶段切换导致的工具能力受限
2. **三层记忆协同**：messages（短期）+ WorkingMemory（中期）+ PayloadStore（长期），各司其职
3. **LLM 驱动压缩**：比规则截断保留更多语义，且降级机制完善
4. **工具幻觉拦截不计入 totalToolCalls**：避免误触上限
5. **单调递增 storeId**：避免 FIFO 淘汰后 ID 复用导致数据错乱
6. **简单请求快速路径**：避免无谓的页面探索，提升响应速度
7. **Port 弹性**：SidePanel 断连不中止任务，重连后回放
8. **每轮 ScratchpadService 持久化**：支持断点续传

### 7.2 已知问题与偏差

| 问题 | 位置 | 影响 | 建议 |
|---|---|---|---|
| `update_memory` 工具未接入 | working-memory.js L107 | AI 无法主动写入 WorkingMemory | 要么实现工具分发分支，要么删除 applyUpdate 和注释 |
| `recall_data` 工具已移除但残留 | 多处 | 代码混淆，存储提示误导 AI | 彻底清理或重新启用 |
| `_autoTruncate` 不存在 | payload-store.js L10 | 死代码 | 删除 `maxRecallChars` |
| ScratchpadService 注释偏差 | scratchpad-service.js | 复盘分析功能受限 | 补全 roundSummary 字段 |
| OutputService 缺 conversationLog | output-service.js | task-archive-service 复盘失效 | 补全 conversationLog |
| 硬性规则仍是软强制 | agent-runner.js L393 | 极端情况下可能继续浪费预算 | 考虑在 failCount 阈值时真正拦截 tool_calls |

### 7.3 收敛机制总结

```
预算 70%  →  软提醒（一次性）
预算 85%  →  紧急收敛提示（一次性）
连续 5 次无进展  →  注入"请立即 finish_task"
连续 3 次脚本失败  →  注入"请立即 finish_task"
maxRounds 用尽  →  循环退出，返回"达到最大请求次数"
```

所有收敛都是「建议」而非「拦截」，尊重 LLM 自主性，但极端情况下可能继续浪费预算。

### 7.4 数据流转全景

```
用户消息
    ↓
[页面内容自动注入]
    ↓
[历史清洗 + 临时消息清理]
    ↓
[WorkingMemory 上下文注入]
    ↓
LLM 决策 tool_calls
    ↓
工具幻觉拦截
    ↓
工具执行
    ↓
WorkingMemory.autoExtractFromToolResult  →  WorkingMemory 状态
    ↓
TodoScheduler.matchToolCall  →  待办进度
    ↓
shouldStoreToPayload?
    ├─ 是 → PayloadStore.add → 返回 schema 摘要 + storeId
    └─ 否 → smartTruncateResult → 返回截断结果
    ↓
messages.push(tool result)
    ↓
ScratchpadService.save
    ↓
messages.length > 40?
    └─ 是 → ContextCompressor.compress → splice 替换
    ↓
下一轮 / finish_task
```

---

## 八、配置参数速查

| 参数 | 默认值 | 位置 | 说明 |
|---|---|---|---|
| `maxRounds` | 15 | agent-runner.js L32 | 最大 LLM 请求轮次 |
| `MAX_TOOL_CALLS` | `min(200, max(30, maxRounds*3))` | L58 | 工具调用总上限 |
| `TIMEOUT_MS` | ctx 传入 | L336 | 任务超时 |
| `MAX_MESSAGES` | 40 | L1135 | 上下文压缩触发阈值 |
| `keepRecent` | 24 | L1137 | 压缩时保留最近条数 |
| `FAIL_THRESHOLD` | 5 | todo-scheduler.js L12 | 连续无进展上限 |
| `SCRIPT_FAIL_THRESHOLD` | 3 | L13 | 脚本失败上限 |
| `CONVERGENCE_70` | 0.7 | L14 | 软提醒阈值 |
| `CONVERGENCE_85` | 0.85 | L15 | 紧急收敛阈值 |
| `DATA_TOOL_THRESHOLD` | 800 | agent-payload-utils.js | 数据工具存储阈值 |
| `OTHER_TOOL_THRESHOLD` | 1500 | 同上 | 其他工具存储阈值 |
| `API_TIMEOUT_MS` | 60000 | agent-runner.js L457 | API 超时 |
| `MAX_API_RETRIES` | 2 | L456 | API 重试次数 |
| 心跳间隔 | 20000 | L466 | Service Worker 保活 |
| 流式输出延迟 | 15ms | L660 | 每字延迟 |

---

## 九、总结

AI Browser 的 Agent 子系统是一套**「LLM 自主决策 + 多层防护 + 软收敛」**的智能体架构。核心特征：

1. **决策权完全交给 LLM**：`tool_choice: 'auto'`，系统不干预工具选择
2. **防护层完整**：幻觉拦截 + 收敛提示 + 硬性规则 + 超时/次数上限
3. **上下文管理精细**：三层记忆 + LLM 压缩 + 临时消息清理 + 孤立消息清理 + 历史清洗
4. **数据流转清晰**：4 条存储路径 + schema 摘要返回 + storeId 引用机制
5. **持久化完善**：ScratchpadService 每轮快照 + OutputService 任务归档 + PayloadStore 跨会话继承

主要改进空间集中在**注释与实现的偏差清理**（update_memory / recall_data / conversationLog），以及**硬性规则的真正拦截**（当前仍是软强制）。
