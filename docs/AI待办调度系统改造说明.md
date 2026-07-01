# AI待办调度系统改造说明

## 改造背景

原有 Agent 架构中，AI 自主判断任务进度、自主决定收敛时机，存在以下问题：

- 软性收敛规则（预算警告、低价值 streak、探索轮次等）分散在 agent-service.js 主循环中，逻辑复杂且难以维护
- 失败计数（consecutiveFailCount、phase1FailCount、phase2FailCount）与阶段切换逻辑耦合，容易出错
- AI 可以自行计算进度，但实际进度判断不够客观，导致收敛过早或过晚
- 阶段切换由 AI 自主决策触发，缺乏系统层的硬性保障

本次改造将 AI 自主决策模式转变为「分阶段AI待办调度系统」，由系统层客观统计进度、驱动收敛和阶段切换。

## 架构设计

### 核心原则

1. AI 只负责填充待办模板和执行工具调用，不再自行计算进度
2. 系统层客观统计整体待办进度，达到阈值自动下发收敛提示
3. 硬性规则内置在调度引擎中，不依赖 AI 遵守

### 三层存储

| 存储层 | 实现 | 生命周期 | 用途 |
|--------|------|----------|------|
| 全局持久存储 | GlobalDataStore | 跨阶段共享，任务结束时清理 | 跨阶段数据传递，子待办通过 dataOutputKey/dataDependKeys 建立数据依赖 |
| 阶段临时缓存 | TodoScheduler.stageCache | 切换阶段时清空 | 阶段内临时数据 |
| PayloadStore 隔离 | PayloadStore | 工具结果超过 1500 字符时存储 | 大结果暂存，recall_data/search_tools 结果不存入 |

### 三阶段分工

| 阶段 | 名称 | 可用工具 | 切换条件 |
|------|------|----------|----------|
| Stage 1 | 本地 DOM 工具 | read_page_content, extract_content, click_element, navigate_to 等 DOM 工具 + search_tools + recall_data + create_todo + finish_task | 连续 4 次无进展 → Stage 2 |
| Stage 2 | 远程脚本 | search_tools, inject_script_*, recall_data, read_page_content, finish_task | 3 次脚本执行失败 → Stage 3 |
| Stage 3 | 数据汇总 | recall_data, finish_task | 调用 finish_task 后结束 |

Stage 1 硬性屏蔽 inject_script_*，Stage 3 不做缺陷校验/修复，仅汇总输出。

### 两套模板

**三阶段父待办模板**（AI 填充，系统校验）：

```
Stage 1（本地DOM工具）
  subTodos:
  - { id: "s1-1", action: "read_page_content", description: "读取页面内容", dataDependKeys: [], dataOutputKey: "page_content" }
  - { id: "s1-2", action: "extract_content", description: "提取新闻列表", dataDependKeys: [], dataOutputKey: "news_links" }

Stage 2（远程脚本）
  subTodos:
  - { id: "s2-1", action: "inject_script_N", description: "批量采集内页", dataDependKeys: ["news_links"], dataOutputKey: "article_content" }

Stage 3（数据汇总）
  subTodos:
  - { id: "s3-1", action: "finish_task", description: "汇总所有数据", dataDependKeys: ["news_links", "article_content"], dataOutputKey: null }
```

**系统校验规则**：
- 每个 subTodo 必须有 id、action、description
- dataDependKeys 引用的 key 必须在之前待办的 dataOutputKey 中已注册（数据依赖合法性）
- Stage 1 的 action 禁止 inject_script_*（硬性规则）
- Stage 2 的 action 只允许 search_tools / inject_script_* / recall_data / read_page_content / finish_task
- Stage 3 的 action 只允许 recall_data / finish_task

### 调度引擎流程

```
工具执行 → hasProgress 判定 → markTodoResult(记录输出数据)
         → recordProgress/recordNoProgress(更新失败计数)
         → shouldSwitchStage(检查硬性规则阈值)
         → forceSwitchToStage(如触发，重置计数+清空缓存+注入新阶段提示词)
```

关键点：recordNoProgress 在 shouldSwitchStage 之前执行，确保当前轮次的失败被计入阈值判断。

## 文件清单

### 新建文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `background/services/todo-scheduler.js` | ~430 | 调度引擎：模板校验、进度统计、收敛提示、硬性规则、阶段切换 |
| `background/services/global-data-store.js` | ~150 | 跨阶段持久存储：数据存取、依赖校验、自动摘要生成 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `background/services/agent-service.js` | 移除旧计数变量和软性收敛规则，集成 TodoScheduler，替换 create_plan 为 create_todo，重构 hasProgress 和阶段切换逻辑 |

### 遗留文件

`background/services/action-loop-detector.js` — 旧循环检测器，已被 TodoScheduler 替代，不再被任何文件 import，可安全删除。

## 改造详情

### 1. 工具定义：create_plan → create_todo

旧工具 `create_plan` 让 AI 自由生成计划，无校验。新工具 `create_todo` 强制 AI 按三阶段模板填充，系统校验合规性和数据依赖合法性。

### 2. 进度统计：系统驱动替代 AI 自主

旧架构中 AI 自行判断进度、自行决定收敛。新架构由 `TodoScheduler.getConvergencePrompt()` 在预算 70% 时下发软收敛提示，85% 时下发紧急收敛提示，由系统客观统计待办完成数/总数。

### 3. 失败计数：统一管理

删除 6 个旧变量（consecutiveFailCount、phase1FailCount、phase2FailCount、MAX_CONSECUTIVE_FAILS、PHASE1_FAIL_THRESHOLD、PHASE2_FAIL_THRESHOLD），统一由调度引擎的 `recordProgress()` / `recordNoProgress()` 管理：

- `stageFailCount`：连续无进展计数，有进展时重置，切换阶段时重置
- `stage2ScriptFailCount`：Stage 2 脚本失败累计计数，不随 stageFailCount 重置，仅切换阶段时重置

### 4. 阶段切换：硬性规则保障

- Stage 1 → Stage 2：stageFailCount >= 4
- Stage 2 → Stage 3：stage2ScriptFailCount >= 3
- 切换时：重置所有计数 → 清空阶段缓存 → 重置 messages → 注入新阶段隔离提示词

## 自检发现并修复的 Bug

| # | 文件 | 严重度 | 描述 |
|---|------|--------|------|
| 1 | todo-scheduler.js | 高 | `forceSwitchToStage()` / `_switchToNextStage()` 未重置 `stage2ScriptFailCount`，切回 Stage 2 时会误触发立即切换 |
| 2 | todo-scheduler.js | 高 | Stage 1 的 `inject_script_*` 拦截条件反转（`!startsWith` 在外层 `if` 中导致内层检查永不执行），inject_script 动作静默通过校验 |
| 3 | agent-service.js | 高 | Stage 3 工具列表只有 `finish_task`，但提示词告知 AI `recall_data` 可用，导致 AI 调用 recall_data 时返回「未知工具」 |
| 4 | agent-service.js | 高 | `recordProgress`/`recordNoProgress` 在 `shouldSwitchStage` 之后执行，导致当前轮次失败未被计入阈值，实际需要 N+1 轮才触发切换 |
| 5 | global-data-store.js | 中 | `get()` / `getSummary()` 使用 `\|\|` 而非 `??`，假值（0、false、""）被错误返回为 null |
| 6 | global-data-store.js | 中 | `_generateSummary()` 对纯文本字符串执行 JSON.parse 抛异常，字符串摘要分支为死代码 |
| 7 | global-data-store.js | 低 | `obj.total === 0` 被假值判断跳过，无法正确显示「0条结果」 |
| 8 | global-data-store.js | 低 | `getUrls()` 同样的 `||` 和 JSON.parse 问题 |

## 兼容性

本次改造删除的历史规则：
- ActionLoopDetector 循环检测（已被 TodoScheduler 进度追踪替代）
- 软性收敛规则（预算警告、低价值 streak、探索轮次、idleText 等）
- create_plan 工具（已被 create_todo 替代）
- 旧失败计数变量（已由调度引擎统一管理）

保留的历史规则：
- PayloadStore 大结果隔离 + recall_data 查询机制
- _shouldStoreToPayload 排除 recall_data 和 search_tools
- 上下文滑动窗口 + 分级摘要压缩
- 域名安全策略
- 右键上下文菜单
