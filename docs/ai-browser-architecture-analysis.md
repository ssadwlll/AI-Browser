# AI Browser Chrome Extension 架构分析报告

> 分析范围：`chrome-extension/` 目录下所有核心服务模块
> 分析维度：AI自主决策机制、上下文管理机制、数据存储机制

---

## 一、AI自主决策机制

### 1.1 三阶段串行调度架构

系统采用**系统控制的两阶段串行架构**，AI无法自主切换阶段，所有阶段转换由后端规则驱动：

```
Stage 1 (DOM探索) → Stage 2 (脚本处理) → Stage 3 (结果汇总)
```

| 阶段 | 工具权限 | 目标 | 切出条件 |
|------|----------|------|---------|
| Stage 1 | 15个DOM工具 + search_tools + create_todo + finish_task | 页面探索、数据提取 | 连续4次无进展自动切Stage 2 |
| Stage 2 | inject_script_* + search_tools + read_page_content + recall_data + finish_task | 脚本批量处理 | 连续3次脚本失败切Stage 3 |
| Stage 3 | recall_data + finish_task | 数据汇总输出 | finish_task后终止 |

**核心约束**：
- AI**不能**独立切换执行阶段，所有转换由`TodoScheduler.shouldSwitchStage()`判断
- 每个阶段的提示词和工具列表完全独立，切换时清空messages重新注入
- Stage 1 屏蔽所有 `inject_script_*`，Stage 2 屏蔽DOM操作工具

### 1.2 待办调度引擎 (TodoScheduler)

AI通过`create_todo`工具提交三阶段待办列表，系统进行**严格校验**后按序驱动执行：

**校验规则**：
- 阶段工具合规性：Stage 1禁止inject_script、Stage 2禁止DOM工具、Stage 3仅允许recall_data/finish_task
- 数据依赖合法性：`dataDependKeys`引用的key必须存在于前序待办的`dataOutputKey`
- dataOutputKey唯一性：不允许重复
- 脚本ID存在性：引用的`inject_script_N`必须在search_tools结果中存在

**进度追踪**：
- `matchToolCall()`：宽松匹配当前待办（精确匹配 + inject_script前缀匹配）
- `recordProgress()/recordNoProgress()`：客观记录进展，重置/递增失败计数
- `getConvergencePrompt()`：预算驱动的收敛提示（70%软收敛、85%紧急收敛）

**阶段切换两种路径**：
1. **正常完成路径**：当前阶段所有待办完成 → `_switchToNextStage()`
2. **硬性规则路径**：连续无进展达阈值 → `shouldSwitchStage()` + `forceSwitchToStage()`

### 1.3 工具幻觉拦截

系统在工具执行前进行名称验证：

```
allowedToolNames = tools.map(t => t.function.name)
if (!allowedToolNames.includes(funcName)) → 拒绝执行，返回可用工具列表
```

这防止了LLM编造不存在的工具名（幻觉）。

### 1.4 简单请求快速路径

系统检测到用户请求为纯数据操作（导出、翻译、追问等）时，跳过Stage 1/2，直接进入Stage 3：

```javascript
const SIMPLE_REQUEST_PATTERNS = ['导出', 'csv', '格式化', '翻译', '汇总', ...]
const isFollowUp = cleanHistory.length > 0 && payloadSummary && userMessage.length <= 20 && !采集/抓取关键词
const isSimpleDataRequest = 有上轮数据 && 匹配简单模式 || isFollowUp
```

### 1.5 事后自评 (Agent Judge)

`finish_task`执行后，系统额外调用一次LLM进行结果评判：

- 输入：原始需求 + Agent结论 + 执行工具摘要
- 输出：`{ verdict: "success|partial|failure", comment: "简短评语" }`
- 结果附加在最终输出后，供用户参考

### 1.6 收敛控制机制

| 机制 | 阈值 | 行为 |
|------|------|------|
| 软收敛 | 70%轮次预算 | 提示加快推进核心待办 |
| 紧急收敛 | 85%轮次预算 | 要求立即完成或finish_task |
| 导航预算 | 85%轮次预算 | 提醒导航新页面可能消耗过多轮次 |
| 最大轮次 | 默认15轮 | 强制终止 |
| 最大工具调用 | maxRounds*3 | 强制终止 |
| 全局超时 | 600秒 | 强制终止 |

### 1.7 安全策略

- **DomainPolicy**：导航工具检查目标URL是否在允许域名范围内
- **系统页面拦截**：chrome://、edge://、about:等系统页面不允许执行Agent
- **Service Worker心跳**：每20秒发送一次心跳防止Chrome终止后台进程

---

## 二、上下文管理机制

### 2.1 三层记忆架构

```
┌─────────────────────────────────────────────┐
│          Messages (LLM对话流)                │  即时上下文，每轮构建
├─────────────────────────────────────────────┤
│       WorkingMemory (工作记忆)               │  结构化状态，跨阶段持久
├─────────────────────────────────────────────┤
│    ContextCompressor (压缩层)                │  LLM驱动的语义压缩
└─────────────────────────────────────────────┘
```

### 2.2 WorkingMemory

独立于对话流的结构化记忆，解决阶段切换时`messages.length=0`导致的上下文失忆：

**状态结构**：
```javascript
{
  taskGoal: '',              // 任务目标
  currentPage: { url, title, summary },  // 当前页面状态
  discoveries: [],           // 关键发现（最多20条）
  decisions: [],             // 已做决策（最多15条）
  excluded: [],              // 排除方案（最多10条）
  dataRefs: [],              // 数据引用 [{key, storeId, count, summary}]
  pendingActions: [],        // 待执行操作
  errors: [],                // 错误记录（最多10条）
  stageHistory: [],          // 阶段切换历史
}
```

**自动提取**：`autoExtractFromToolResult()`从工具结果自动提取关键信息：
- 导航类工具 → 记录决策
- extract_content成功 → 记录数据发现
- 工具失败 → 记录排除/错误
- inject_script成功 → 记录结果摘要
- read_page_content → 更新页面状态

**上下文注入策略**（去重）：
- 阶段切换后前2轮：只注入错误和排除信息（交接摘要已包含其他信息）
- 超过2轮后：注入完整WorkingMemory（不含页面信息，避免与userMessage重复）

**交接摘要**：`toHandoffContext()`生成聚焦的交接信息，只保留对下一阶段有用的内容。

### 2.3 ContextCompressor

LLM驱动的上下文压缩，替代传统的规则截断：

**两种压缩模式**：

| 模式 | 触发条件 | 输入 | 输出 |
|------|---------|------|------|
| 对话压缩 | messages > 40条 | 早期消息 + WorkingMemory | 语义摘要（≤800字符） |
| 阶段交接 | 阶段切换 | 当前消息 + WorkingMemory | 交接摘要（≤600字符） |

**压缩流程**：
1. `_messagesToText()`：将消息流转为可读文本（assistant→AI调用、tool→工具结果、system→系统提示）
2. 发送至LLM生成结构化摘要（关键发现/已做决策/排除方案/数据引用/当前状态）
3. 失败时回退到`_ruleBasedFallback()`（规则驱动的保留链接列表+脚本结果）

**降级策略**：
- 输入<1500字符 → 直接规则压缩，不调LLM
- LLM调用失败 → 规则压缩兜底
- 阶段交接LLM失败 → 使用WorkingMemory的`toHandoffContext()`

### 2.4 消息管理策略

**临时消息机制**：依赖数据注入标记为`_temp`，下轮自动清理，避免累积膨胀。

**对话历史预处理**：
1. 移除末尾连续的失败agent回复（含❌、脚本语法错误、401等标记）
2. 压缩长assistant消息：保留前500字符+尾部200字符+压缩标记

**孤立工具消息清理**：验证tool消息的tool_call_id是否存在于assistant消息的tool_calls中，不匹配则移除。

### 2.5 依赖数据自动注入

阶段切换到Stage 2时，系统自动将当前待办依赖的数据注入上下文：

```javascript
// 检查 dataDependKeys → 从 GlobalDataStore 获取数据 → 注入为临时系统消息
dependDataInjection = '\n=== 依赖数据已自动加载 ===\n...'
messages.push({ role: 'system', content: dependDataInjection, _temp: true })
```

注入数据截断到2000字符，标记`_temp`，下轮清理。

### 2.6 页面内容自动注入

任务启动时自动读取当前页面内容并注入：
- 标注`[已执行 read_page_content]`，防止AI重复调用
- 同时自动搜索匹配脚本，结果一并注入
- 缓存到`pageReadCache`，后续read_page_content调用可命中缓存

---

## 三、数据存储机制

### 3.1 存储架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                    内存存储（任务期间）                         │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ PayloadStore │  │GlobalDataStore│  │   pageReadCache   │  │
│  │ (工具结果暂存)│  │ (跨阶段持久)  │  │  (页面内容缓存)    │  │
│  └──────────────┘  └──────────────┘  └───────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                  IndexedDB 持久存储                           │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  DBService   │  │ Scratchpad   │  │  OutputService    │  │
│  │ (通用CRUD)   │  │ (推理快照)    │  │  (任务输出)        │  │
│  └──────────────┘  └──────────────┘  └───────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                  Chrome Storage                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  chatHistory (对话历史，≤50条，≤8000字符)              │   │
│  └──────────────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────────────┤
│                  远程服务端存储                                │
│  ┌──────────────┐  ┌──────────────────────────────────┐     │
│  │  MySQL脚本表  │  │  memories + usage_stats 表        │     │
│  └──────────────┘  └──────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 PayloadStore — 工具结果暂存区

**职责**：大数据工具结果只发摘要给AI，完整数据存于此，供recall_data查询。

**关键特性**：
- **Session隔离**：每个任务绑定sessionId，默认只查当前session数据
- **单调递增ID**：`p1, p2, p3...`，FIFO淘汰不复用，避免ID错乱
- **跨会话继承**：`inheritFromLastSession()`，5分钟内的数据可继承到新session（支持"导出csv"等连续对话场景）
- **查询能力**：支持按entry_id、tool_name、filter（前N条/范围/关键词）、fields（字段投影）
- **自动截断**：单次返回≤5000字符，超出自动截断保留核心数据
- **容量限制**：最多30条，超出FIFO淘汰

**存储阈值策略**：
| 工具类型 | 存储阈值 |
|---------|---------|
| 数据采集类（extract_content等） | 800字符 |
| 其他工具 | 1500字符 |
| recall_data/search_tools/finish_task | 不存储 |

### 3.3 GlobalDataStore — 跨阶段持久存储

**职责**：通过`dataOutputKey`索引，实现待办间的数据流转。

**与PayloadStore的区别**：

| 维度 | PayloadStore | GlobalDataStore |
|------|-------------|-----------------|
| 索引方式 | 自增ID (p1,p2...) | 语义key (dataOutputKey) |
| 数据来源 | 工具结果自动存储 | 待办完成时主动存储 |
| 查询方式 | recall_data工具 | dataDependKeys引用 |
| 生命周期 | 跨session继承 | 任务结束清空 |
| 用途 | AI按需查询完整数据 | 阶段间自动数据传递 |

**数据摘要自动生成**：数组类型自动提取字段、样本；对象类型提取key列表。

### 3.4 DBService — IndexedDB通用服务

**数据库**：`ai-browser-db`，版本1

**对象存储仓**：

| Store | keyPath | 索引 | 用途 |
|-------|---------|------|------|
| task_templates | id | category, updatedAt | 任务模板 |
| tool_recordings | id | sessionId, timestamp | 工具调用录制 |
| agent_snapshots | id | tabId, createdAt | Agent断点续传快照 |
| scheduled_tasks | id | nextRun, enabled | 定时任务 |

**API**：put/putBatch/get/getAll/del/clear/queryByIndex，支持索引范围查询。

### 3.5 ScratchpadService — 推理快照

**数据库**：`ai-browser-scratchpad`（独立IndexedDB）

**存储结构**：
```javascript
{
  sessionId: string,        // 主键
  timestamp: number,        // 索引
  taskGoal: string,         // 索引
  state: WorkingMemory.state,
  lastRound: { round, stage },
  totalRounds: number
}
```

**用途**：每轮结束后保存WorkingMemory状态，支持断点续传和导出。

### 3.6 OutputService — 任务输出

**数据库**：`ai-browser-outputs`（独立IndexedDB）

**存储结构**：
```javascript
{
  taskId: string,           // 主键
  sessionId: string,        // 索引
  startTime: number,        // 索引
  status: string,           // 索引 (success/partial/failure)
  userMessage: string,
  summary: string,
  workingMemoryState: {...},
  dataOutputs: [...],
  judgeResult: {...}
}
```

### 3.7 ToolRecordingService — 工具调用录制

**职责**：录制Agent完整的工具调用序列，支持回放、导出、导入。

**录制流程**：
1. `startSession()` → 创建录制会话
2. 每次工具调用 → `record()` → 内存+IndexedDB双重存储
3. `stopSession()` → 生成统计摘要

**回放功能**：`playback()`按序重新执行工具调用，对比原始结果与回放结果。

### 3.8 ChatHistory — 对话历史

**存储**：`chrome.storage.local`

**管理策略**：
- 最多50条，总字符数≤8000
- 从末尾向前保留，优先保留有附件的消息
- 去重：与最后一条assistant消息内容相同时跳过写入
- 失败标记过滤：新任务启动时移除末尾连续失败回复

### 3.9 远程服务端存储

| 表 | 用途 | 写入时机 |
|----|------|---------|
| scripts | 脚本定义、工具配置 | 管理后台维护 |
| usage_stats | 脚本执行统计 | 每次脚本执行后 |
| memories | 脚本执行经验记忆 | 每次脚本执行后 |

**经验记忆**：记录脚本成功/失败、执行耗时、错误信息、结果摘要，用于工具排序（成功率高的脚本优先展示）。

---

## 四、数据流转全景

### 4.1 典型任务数据流

```
用户输入
  │
  ▼
AgentService.startAgent()
  │── 继承上轮PayloadStore数据
  │── 自动读取页面内容 → WorkingMemory.init()
  │── 自动搜索脚本 → searchResults[]
  │
  ▼
┌─── 主循环 (agent-runner.js) ────────────────────────┐
│                                                       │
│  Stage 1: DOM工具执行                                 │
│    │── 工具结果 → smartTruncateResult / storeToPayload │
│    │── WorkingMemory.autoExtractFromToolResult()       │
│    │── TodoScheduler.matchToolCall() + recordProgress()│
│    │── GlobalDataStore.set(dataOutputKey, result)      │
│    │── ScratchpadService.save() 每轮持久化             │
│    │                                                   │
│    ▼ 阶段切换 (4轮无进展 或 待办完成)                  │
│    │── ContextCompressor.generateHandoff()             │
│    │── 清空messages，注入新阶段提示词+交接摘要          │
│    │── 依赖数据自动注入 (GlobalDataStore → _temp msg)   │
│    │                                                   │
│  Stage 2: 脚本执行                                    │
│    │── inject_script_N → ToolService.executeTool()     │
│    │── JS脚本: chrome.scripting.executeScript(MAIN)    │
│    │── API脚本: fetchWithTimeout → 远程服务            │
│    │── 结果存储 + 经验记忆上报                          │
│    │                                                   │
│    ▼ 阶段切换 (3次脚本失败 或 待办完成)                │
│    │                                                   │
│  Stage 3: 结果汇总                                    │
│    │── recall_data (PayloadStore + GlobalDataStore)    │
│    │── finish_task → 结果评估 + 流式输出               │
│    │── OutputService.save() 持久化                     │
│    │── ToolRecordingService.stopSession()              │
│                                                       │
└───────────────────────────────────────────────────────┘
```

### 4.2 return_mode 数据返回机制

AI可自主决定工具结果的返回模式：

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `summary`（默认） | 返回概览（高分样本10条+低分去重3条），完整数据存入PayloadStore | 了解数据结构和内容 |
| `full` | 返回完整数据，不截断不存储，标记`_temp` | 需要全部数据进行下一步处理 |

**评分规则**（buildDataOverview）：
- 文本长度>15字符 → +3分
- 文本长度>30字符 → +1分
- 有属性(attrs) → +2分
- 属性数>2 → +1分
- 高分(≥3) = 有意义数据，低分(<3) = 简单数据

### 4.3 recall_data 查询链路

```
recall_data(entry_id)
  │
  ├── PayloadStore.query()
  │   └── 按entry_id / tool_name / filter / fields 查询
  │
  └── (若PayloadStore无结果) → GlobalDataStore.query()
      └── 大数据 → 存入PayloadStore + 返回摘要+ID
      └── 小数据 → 直接返回
```

**防护机制**：
- 每轮限2次recall_data调用
- 同一entry_id查询>3次时下发收敛提示
- 单次返回≤5000字符

---

## 五、关键设计决策总结

### 5.1 优势

1. **系统驱动的阶段调度**：AI不能自主切换阶段，避免跨阶段逻辑混乱
2. **双重记忆机制**：WorkingMemory（结构化状态）+ Messages（对话流），解决阶段切换的上下文失忆
3. **LLM驱动的语义压缩**：替代粗暴截断，保留语义完整性
4. **依赖数据自动注入**：避免AI浪费轮次recall_data查询已知依赖
5. **工具幻觉拦截**：在执行前验证工具名，防止LLM编造工具
6. **经验记忆排序**：成功率高的脚本优先展示，提高执行效率
7. **简单请求快速路径**：追问/导出等场景跳过Stage 1/2，节省轮次

### 5.2 潜在风险

1. **LLM压缩额外消耗**：每次压缩/交接摘要额外消耗1次LLM调用，可能增加延迟和成本
2. **PayloadStore内存占用**：纯内存存储，30条上限可能不足，大数据场景需关注内存
3. **recall_data循环风险**：虽然限制2次/轮，但AI仍可能在多轮反复查询相同数据
4. **阶段切换的上下文丢失**：清空messages后依赖交接摘要和WorkingMemory，信息可能不完整
5. **待办列表不可修改**：创建后无法调整，若AI规划不当可能导致任务卡死

### 5.3 文件依赖关系

```
agent-service.js (入口，状态管理)
  └── agent-runner.js (主循环，核心逻辑)
        ├── agent-tool-builder.js (工具定义构建)
        ├── agent-dom-executor.js (DOM工具执行)
        ├── agent-judge.js (事后自评 + 辅助函数)
        ├── agent-payload-utils.js (数据截断/存储策略)
        ├── working-memory.js (工作记忆)
        ├── context-compressor.js (上下文压缩)
        ├── todo-scheduler.js (待办调度)
        │     └── global-data-store.js (跨阶段数据)
        ├── payload-store.js (工具结果暂存)
        ├── scratchpad-service.js (推理快照)
        ├── output-service.js (任务输出)
        ├── tool-service.js (脚本执行)
        ├── domain-policy.js (安全策略)
        └── config-service.js (配置管理)
```
