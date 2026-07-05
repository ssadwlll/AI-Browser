# AI Browser 项目 - 对话导出：Agent 数据流转 Bug 分析与修复

> 导出日期：2026-07-04
> 项目：ai-browser/chrome-extension
> 主题：Agent 自主决策机制分析、数据存储 Bug 修复、上下文压缩机制分析

---

## 目录

1. [Round 5 报错定位：normalizePayload + typeHint 协同 Bug](#1-round-5-报错定位)
2. [修复方案 C：双重修复](#2-修复方案-c)
3. [Round 3→4 浪费：inject_script_9 存储结构 Bug](#3-round-3--4-浪费)
4. [16 轮全浪费诊断：AI 正则 Bug + 失忆循环](#4-16-轮全浪费诊断)
5. [数据清理决策分析：是 AI 自主决策吗？](#5-数据清理决策分析)
6. [上下文压缩机制详解](#6-上下文压缩机制详解)
7. [关键代码位置索引](#7-关键代码位置索引)

---

## 1. Round 5 报错定位

### 报错代码（err.json:491）

```javascript
// Round 5 - generate_script 调用
const urls = window.__store.p2.result.items.map(item => item.url);
return urls;
```

**报错信息**：`Cannot read properties of undefined (reading 'items')`

### 根本原因：normalizePayload 与 typeHint 的协同 Bug

#### Step 1：Round 4 generate_script 返回值

AI 在 Round 4 写代码：
```javascript
return { count: unique.length, items: unique };
```

工具执行后包装成标准信封：
```json
{ "ok": true, "result": { "count": 33, "items": [...] } }
```

#### Step 2：存储流程进入路径3（shouldStoreToPayload）

`agent-runner.js:1077-1080`：

```javascript
} else if (shouldStoreToPayload(toolResult, funcName)) {
  const envelope = normalizePayload(toolResult, funcName)
  finalResult = storeToPayload(payloadStore, envelope.items, funcName, envelope)
```

#### Step 3：normalizePayload 的关键缺陷

`agent-payload-utils.js:71-85`：

```javascript
if (Array.isArray(obj)) {
  items = obj
} else if (obj.ok && Array.isArray(obj.result)) {        // ← result 是对象，不满足
  items = obj.result
} else if (obj.ok && obj.result && Array.isArray(obj.result.elements)) {  // 不满足
  items = obj.result.elements
} else if (Array.isArray(obj.pages)) {                    // 不满足
  items = obj.pages
} else if (typeof obj === 'object') {
  items = [obj]   // ← 落到这里！把整个 {ok, result} 包装成单元素数组
}
```

**结果**：`window.__store.p2` 实际存储的是 **数组** `[{ ok: true, result: {count, items} }]`，而不是对象。

#### Step 4：typeHint 误导 AI

`agent-payload-utils.js:253-257`：

```javascript
const typeHint = envelope.items.length > 1
  ? `window.__store.${entryId} 是数组，可直接 .filter()/.map()/.forEach() 遍历`
  : envelope.items.length === 1
  ? `window.__store.${entryId} 是单个对象`   // ← 触发这条
  : `window.__store.${entryId} 为空`
```

`envelope.items.length === 1`（数组长度1），输出 **"window.__store.p2 是单个对象"**。

#### Step 5：AI 被误导，访问路径错误

AI 看到 typeHint "是单个对象"，按对象语法访问：
```javascript
window.__store.p2.result.items   // 期望 p2 = {ok, result}
```

但实际 `window.__store.p2 = [{ok, result}]`（数组），`p2.result` 是 undefined，`.items` 抛错。

### 连锁浪费：Round 5 → Round 12

`Cannot read properties of undefined (reading 'items')` 错误在 **Round 5、6、7、8、9、10、11、12 连续 8 轮** 重复出现。

因为每轮都注入相同的、错误的 typeHint "window.__store.p2 是单个对象"，AI 持续信任系统提示，反复写 `window.__store.p2.result.items`，导致 8 轮预算被浪费。

---

## 2. 修复方案 C

采用方案 C（normalizePayload + typeHint 双重修复）。

### 修复 1：normalizePayload 的 generate_script 分支

在 `agent-payload-utils.js:75` 前插入 generate_script 特例：

```javascript
// generate_script 的 {ok, result} 包装，result 才是真正的数据
if (toolName === 'generate_script' && obj.ok && obj.result !== undefined) {
  if (Array.isArray(obj.result)) {
    items = obj.result
  } else if (obj.result && typeof obj.result === 'object') {
    items = [obj.result]   // 单对象包装
  } else {
    items = [{ value: obj.result }]   // 基本类型
  }
} else if (Array.isArray(obj)) {
  ...
}
```

### 修复 2：storeToPayload typeHint 描述

```javascript
const typeHint = envelope.items.length > 1
  ? `window.__store.${entryId} 是数组（长度${envelope.items.length}），可直接 .filter()/.map()/.forEach() 遍历`
  : envelope.items.length === 1
  ? `window.__store.${entryId} 是长度为1的数组，访问元素用 window.__store.${entryId}[0]`
  : `window.__store.${entryId} 为空`
```

### 修复 3：agent-runner.js return_mode='full' 路径 typeHint

同步修复，描述与 storeToPayload 保持一致。

### 修复 4：formatSchemaSummary 的 dataType

从"单对象"改为"长度1的数组"，明确存储始终是数组。

### 修复效果

修复前场景：AI 写 `return { count: 33, items: [...] }`
- ❌ 旧版存储：`window.__store.p2 = [{ok: true, result: {count, items}}]`
- ❌ 旧版提示：`是单个对象`（误导 AI 写 `p2.result.items`，抛错）

修复后场景：AI 写 `return { count: 33, items: [...] }`
- ✅ 新版存储：`window.__store.p2 = [{count: 33, items: [...]}]`（剥离 ok 层）
- ✅ 新版提示：`是长度为1的数组，访问元素用 window.__store.p2[0]`
- ✅ AI 应写：`window.__store.p2[0].items.map(...)`

---

## 3. Round 3 → 4 浪费

### inject_script_9 的存储 Bug

**Round 3 的 inject_script_9 返回值**：
```json
{ "ok": true, "result": { "pages": [...12条新闻...], "total": 12, "successCount": 12 } }
```

**存储到 p2 后**：
```
window.__store.p2 = [{ ok: true, result: { pages: [...] } }]
```

**问题**：`normalizePayload` 的 `Array.isArray(obj.pages)` 分支只匹配顶层 `obj.pages`，但 inject_script_9 的 pages 在 `obj.result.pages` 下，匹配不到，落到兜底分支 `items = [obj]`。

### 修复：新增 inject_script_N 分支

`agent-payload-utils.js:82-84`：

```javascript
} else if (obj.ok && obj.result && Array.isArray(obj.result.pages)) {
  // inject_script_N 返回 {ok, result: {pages: [...], total, successCount}}，剥离包装层
  items = obj.result.pages
}
```

### 修复后预期效果

修复前（5 轮）：R1 → R2 → R3（存 p2 错误）→ R4（解包 p2）→ R5（整理 p3）

修复后（4 轮）：R1 → R2 → R3（存 p2 正确，直接是 12 条新闻数组）→ R4（整理 p2 并 finish_task）

**节省 1 轮预算**。

---

## 4. 16 轮全浪费诊断

### 整体流程

| 阶段 | 轮次 | 工具 | 问题 |
|---|---|---|---|
| **采集阶段** | R1-R4 | extract_content + generate_script + inject_script_9 | ✅ 正常，存 p1/p2/p3 |
| **清理 Bug 触发** | **R5** | generate_script 清理 p3 → p4 | ❌ **AI 正则 Bug，正文全被清掉** |
| **重采尝试** | R6 | inject_script_10 重采 → p5 | AI 以为脚本问题 |
| **失忆循环** | R7-R16 | 反复 generate_script 清理 p5 | ❌ **10 轮死循环** |

### 核心问题1：AI 正则清理 Bug（R5）

AI 写的清理代码：
```javascript
content = content.replace(/温州新闻网[\s\S]*?(?:您当前的位置|新闻中心)/, '').trim();
```

**Bug 分析**：`[\s\S]*?` 虽是非贪婪，但匹配目标是"温州新闻网"到最近的"温州"或"新闻中心"。但原文中正文里频繁出现"温州"字样，导致正则跨过正文匹配到正文中的"温州"字，**把整段正文都替换为空**。

### 核心问题2：硬性规则未触发

`FAIL_THRESHOLD=5` 是针对**工具执行失败**（throw error），但 generate_script 一直返回 `ok:true`（只是结果质量差），所以硬性规则没有触发。

### 核心问题3：未创建待办导致无收敛目标

AI 没调用 create_todo，缺少明确的"完成定义"。**没有待办 → 没有"待办完成率" → 70%/85% 收敛控制失效**。

### 数据存储浪费

最终 payloadStore 堆积了 **12 个数据条目**（p1-p12），大部分是中间失败产物。

---

## 5. 数据清理决策分析

### 是 AI 自主决策吗？

**是**。系统提示词**没有强制清理**，只说了"整理给我"是用户原话。AI 自己看到 content 里有大量噪声，自主决定清理。

**Round 5 的 reasoning_content**（err.json:545）：

> "The data has been collected. Now I need to organize the news list with their full content. **Let me use generate_script to clean up the content and format it nicely for the user.**"

### 但 AI 的决策有合理性

inject_script_9 返回的**单篇 content 实际结构**：

```
温州新闻网 时政 温州 财经 文化 原创 视频...   ← 顶部导航（约80字）
您当前的位置 ： 温州网 > 新闻中心 > 温州 > 经济   ← 面包屑
正在阅读：3 多家温企回购股份"送"员工...          ← 标题重复
温州都市报 2026-07-01 08:33:37                  ← 来源时间
6月30日，浙江炜冈科技股份有限公司...             ← 【正文核心 ~1500字】
来 源：温州都市报                                ← 正文结束
原标题：多家温企回购股份"送"员工...
记者 郑俊杰
本文转自：温州新闻网 66wz.com 新闻中心
编辑：诸葛之伊 审核：潘涌燚 责任编辑：叶双莲...  ← 编辑信息
相关新闻                                         ← 【噪声开始】
为你推荐 禁止车内进食和外放声音！...             ← 10条相关新闻
温州城市书房可以寄存行李了...                    ← 5条今日精选
国新办发函2006.78号                              ← 版权信息
Copyright © 2021 66wz.com. All rights reserved.
浙ICP备09100296号-11
```

**统计**：单篇约 3000-5000 字，**正文核心仅约 30-40%**，剩余 60%+ 是导航、相关新闻、版权声明等重复噪声。**12 篇文章 × 60% 噪声 = 约 2-3 万字垃圾**。

### 真正的责任归属：inject_script_9 脚本设计粗糙

**根本问题**：inject_script_9 脚本返回的是 `document.body.innerText` 之类的"整页文本"，而不是只提取正文容器。

温州新闻网的文章正文在明确的容器里（通常是 `.TRS_Editor` 或 `#content` 或类似选择器），脚本应该精准提取，而不是把整页 innerText 扔回给 AI。

### 完整责任链

```
inject_script_9 脚本设计粗糙
  └─ 返回带噪声的原始文本（60% 是垃圾）
       └─ AI 看到噪声，自主决定清理（合理决策）
            └─ AI 写正则清理（实现有 Bug）
                 └─ 正文被误删（Round 5）
                      └─ 上下文压缩失忆
                           └─ 11 轮死循环（Round 5-16）
                                └─ 任务未完成
```

### 修复方向（按优先级）

**P0 - 优化 inject_script_9 脚本本身**（根本修复）：

```javascript
// 在脚本里精准提取正文容器
const article = document.querySelector('.TRS_Editor, #content, .article-content, .content');
const title = document.querySelector('h1, .title')?.innerText?.trim();
const meta = document.querySelector('.source, .info')?.innerText?.trim();
return { title, content: article?.innerText?.trim() || document.body.innerText };
```

**P1 - 系统提示词引导**：

```
=== 数据处理原则 ===
- 收到带噪声的网页内容时，优先用"正向提取"而非"反向删除"
- 推荐用 content.match(/正文起始标记([\s\S]*?)正文结束标记/) 提取目标段落
- 避免用 /[\s\S]*?/ 跨段落删除噪声，容易误删正文
- 如果数据已基本可用，直接 finish_task，不要过度优化
```

**P2 - 工具结果质量检测**：

连续 N 轮 generate_script 结果相似 → 强制 finish_task。

---

## 6. 上下文压缩机制详解

### 压缩触发条件

`agent-runner.js:1135-1148`：

```javascript
const MAX_MESSAGES = 40
if (messages.length > MAX_MESSAGES) {                    // 触发阈值
  const keepRecent = Math.floor(MAX_MESSAGES * 0.6)      // = 24
  let cutOff = messages.length - keepRecent              // = 43-24=19
  if (cutOff > 1) {
    while (cutOff < messages.length && messages[cutOff]?.role === 'tool') cutOff++
  }
  if (cutOff > 1) {
    // 使用 ContextCompressor 进行 LLM 驱动压缩
    const summaryMsg = await contextCompressor.compress(messages, cutOff, userMessage, workingMemory)
    if (summaryMsg) {
      messages.splice(1, cutOff - 1, summaryMsg)         // 前 18 条替换为 1 个摘要
    }
  }
  // 移除孤立 tool 消息
  const validToolCallIds = new Set()
  for (const m of messages) { if (m.role === 'assistant' && m.tool_calls) { for (const tc of m.tool_calls) validToolCallIds.add(tc.id) } }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool' && !validToolCallIds.has(messages[i].tool_call_id)) {
      console.warn('[Agent] 移除孤立tool消息:', messages[i].tool_call_id)
      messages.splice(i, 1)
    }
  }
}
```

### 触发时机

每轮 messages 增长 +3 条（assistant + tool + system memory）：

| 轮次 | messages 数量 | 是否触发 |
|---|---|---|
| Round 1 | 3 | ❌ |
| Round 7 | 22 | ❌ |
| Round 10 | 31 | ❌ |
| Round 13 | ~40 | ❌（刚好等于 40，不大于） |
| **Round 14** | **~43** | **✅ 触发** |

### Round 14 压缩后的实际状态

压缩后 messages 数组从 43 条 → 27 条：

```
[0] system (主提示词)
[1] system (摘要：覆盖 p1-p4 早期记录)
[2] system (WorkingMemory 快照：p2/p3/p4)
[3] assistant (inject_script_10)
[4] tool (p5 结果)
[5] system (含 p5 的快照)
[6] assistant (generate_script 清洗 p5)
[7] tool (p6 结果)
... 保留最近 24 条 ...
[26] system (最后状态)
```

### 关键发现：失忆不是主因

**p5/p6/p7/p8/p9/p10/p11 都在保留的最近 24 条里**，AI 并没有失忆。压缩后的摘要也包含了 p1-p4 的关键信息。

### 真正的任务失败原因

1. **AI 清洗策略持续失败**：Round 5-16 反复用 generate_script + 正则清理，每次都失败
2. **没有触发硬性规则**：FAIL_THRESHOLD=5 针对工具执行错误，但 generate_script 一直返回 ok:true
3. **没有调用 finish_task**：AI 一直试图"再试一次"，没有接受不完美结果
4. **16 轮预算耗尽**：达到 maxRounds 后循环退出

### 压缩本身的设计问题

虽然压缩没有直接导致失忆，但压缩质量确实有问题：

**摘要内容**（err.json:2969）：
```
[上下文摘要] 以下为早期操作摘要：
[已执行 read_page_content] 标题: 经济 - 新闻中心 - 温州新闻网 | URL: https://news.66wz/wenzh
[scroll_page] 已向下滚动1016.8000000000001px...
任务目标: 采集新闻列表...
💡 提示：已用 extract_content 提取过选择器 "a" 的数据...
[generate_script] [{"title":"多家温企回购股份...
[工具结果] p3(inject_script_9): 12条...
[工具结果] p4(generate_script): 12条...
```

**问题**：
1. **摘要是消息片段的拼接**，不是 LLM 真正理解的语义总结
2. **缺少"已尝试失败的清理策略"**，AI 看不到"Round 5 用正则 /温州新闻网[\s\S]*?(?:您当前的位置|新闻中心)/ 失败了"
3. **缺少"应该避免的做法"**，导致 AI 可能重试相同策略

---

## 7. 关键代码位置索引

### 核心文件

| 文件 | 关键函数/位置 | 职责 |
|---|---|---|
| [agent-runner.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js) | L18-1192 `runAgent` | Agent 主循环 |
| [agent-runner.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L1135-L1158) | L1135-1158 上下文压缩 | messages > 40 触发 |
| [agent-runner.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-runner.js#L1077-L1090) | L1077-1090 大结果存储 4 路径 | PayloadStore 写入 |
| [agent-payload-utils.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-payload-utils.js#L66-L95) | L66-95 `normalizePayload` | 数据结构标准化 |
| [agent-payload-utils.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-payload-utils.js#L243-L263) | L243-263 `storeToPayload` | 存储并生成 typeHint |
| [agent-payload-utils.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/agent-payload-utils.js#L305-L389) | L305-389 `smartTruncateResult` | 按结构截断 |
| [context-compressor.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/context-compressor.js) | LLM 压缩 | 5 章节摘要 |
| [working-memory.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/working-memory.js) | 7 字段结构化记忆 | 跨轮记忆 |
| [payload-store.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/payload-store.js) | 大数据外置存储 | 内存+session |
| [todo-scheduler.js](file:///d:/phpstudy_pro/WWW/ai-browser/chrome-extension/background/services/todo-scheduler.js) | 待办+硬性规则 | FAIL_THRESHOLD=5 |

### 关键常量

| 常量 | 值 | 位置 |
|---|---|---|
| MAX_MESSAGES | 40 | agent-runner.js:1135 |
| keepRecent | 24 (MAX_MESSAGES * 0.6) | agent-runner.js:1137 |
| FAIL_THRESHOLD | 5 | todo-scheduler.js |
| SCRIPT_FAIL_THRESHOLD | 3 | todo-scheduler.js |
| CONVERGENCE_70 | 0.7 | todo-scheduler.js |
| CONVERGENCE_85 | 0.85 | todo-scheduler.js |
| shouldStoreToPayload 阈值 | 800/1500 字符 | agent-payload-utils.js:117-131 |

### 数据存储 4 条路径

`agent-runner.js:1037-1090`：

1. **return_mode='full'**：直接存全部数据
2. **return_mode='summary'**：存摘要
3. **shouldStoreToPayload**：按阈值判断存储（800/1500 字符）
4. **不存储**：直接返回 finalResult

### normalizePayload 分支优先级

`agent-payload-utils.js:66-95`：

1. `Array.isArray(obj)` → 直接用
2. `obj.ok && Array.isArray(obj.result)` → 用 result
3. `obj.ok && obj.result && Array.isArray(obj.result.elements)` → 用 elements
4. `Array.isArray(obj.pages)` → 用 pages（inject_script 批量）
5. **新增**：`obj.ok && obj.result && Array.isArray(obj.result.pages)` → 用 result.pages（inject_script_N 包装层）
6. **新增**：`obj.ok && obj.result !== undefined && toolName === 'generate_script'` → 剥离 ok 包装
7. 兜底：`typeof obj === 'object'` → `[obj]`

---

## 8. 已修复的 Bug 清单

### Bug 1：normalizePayload 未剥离 generate_script 的 {ok, result} 包装

- **位置**：agent-payload-utils.js:66-95
- **影响**：AI 写 `p2.result.items` 抛错，浪费 8 轮预算
- **修复**：新增 generate_script 特例分支

### Bug 2：normalizePayload 未剥离 inject_script_N 的 {ok, result: {pages}} 包装

- **位置**：agent-payload-utils.js:82-84
- **影响**：Round 3→4 浪费 1 轮解包
- **修复**：新增 `obj.result.pages` 分支

### Bug 3：typeHint 描述"是单个对象"误导 AI

- **位置**：agent-payload-utils.js:253-257 + agent-runner.js:1052-1056
- **影响**：AI 按对象语法访问数组，抛错
- **修复**：改为"是长度为1的数组，访问元素用 window.__store.pX[0]"

### Bug 4：formatSchemaSummary 的 dataType 标注错误

- **位置**：agent-payload-utils.js:114
- **影响**：dataType 显示"单对象"与实际数组不符
- **修复**：改为"长度1的数组"

---

## 9. 待修复的问题

### P0：inject_script_9 脚本本身粗糙

- **问题**：返回 `document.body.innerText` 整页文本，60% 是噪声
- **修复方向**：在脚本里精准提取正文容器（`.TRS_Editor` / `#content` 等）
- **影响**：AI 不需要清理，整个悲剧链根本不会发生

### P1：工具结果质量检测缺失

- **问题**：连续 N 轮 generate_script 结果相似/失败，没有收敛机制
- **修复方向**：增加循环检测，连续 3 轮相同工具 + 相同 data_refs → 注入强制警告
- **影响**：避免 10 轮死循环

### P1：复杂任务未强制创建待办

- **问题**：3 步任务（采集+内页+整理）未创建待办，收敛控制失效
- **修复方向**：任务包含多步骤时强制 create_todo

### P2：上下文压缩摘要质量差

- **问题**：摘要是消息片段拼接，缺少"已尝试失败的方法"
- **修复方向**：改进 ContextCompressor，把失败的清理策略写入 WorkingMemory.excluded

### P2：硬性规则覆盖不全

- **问题**：FAIL_THRESHOLD 只针对工具执行错误，不针对结果质量差
- **修复方向**：增加"结果质量阈值"检测

---

## 10. 总结

### 核心结论

1. **AI 自主决策是事实**，但决策有合理性（content 确实 60% 是噪声）
2. **根本责任在 inject_script_9 脚本设计**，应该返回干净数据
3. **AI 实现有 Bug**（正则误删正文）
4. **系统层收敛机制缺失**（结果质量差未触发硬性规则）
5. **上下文压缩没有直接导致失忆**，但摘要质量差放大了问题

### 已修复 4 个 Bug

- normalizePayload 的 generate_script 分支
- normalizePayload 的 inject_script_N 分支
- typeHint 描述错误
- formatSchemaSummary 的 dataType 标注

### 待修复 5 个问题

- P0：inject_script_9 脚本本身
- P1：工具结果质量检测
- P1：复杂任务强制待办
- P2：上下文压缩摘要质量
- P2：硬性规则覆盖范围

---

## 附录：err.json 文件信息

- **路径**：`d:\phpstudy_pro\WWW\ai-browser\chrome-extension\docs\err.json`
- **大小**：625KB
- **总轮次**：16 轮
- **未 finish_task**：是
- **任务**：采集新闻列表，内页也要，整理给我
- **目标网站**：https://news.66wz.com/wenzhou/jingji/
