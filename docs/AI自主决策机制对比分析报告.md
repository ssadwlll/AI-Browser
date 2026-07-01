# AI Browser Chrome Extension — AI 自主决策机制分析报告（v2）

*报告生成时间：2026-06-30 | 对比对象：browser-use (Python) v0.13.2*

---

## 一、AI Browser Chrome Extension 的 AI 自主决策过程与机制

### 1.1 架构总览

AI Browser 是一个基于 Chrome Manifest V3 的 AI 驱动浏览器扩展，采用五层架构：

```
┌────────────────────────────────────────────────────┐
│                SidePanel UI (用户交互)              │
│            sidepanel.js / popup.js                 │
├────────────────────────────────────────────────────┤
│         Background Service Worker (中枢)           │
│             background/index.js                     │
├──────────┬──────────┬──────────┬──────────────────┤
│ConfigSvc │  AISvc   │ AgentSvc │ ToolSvc/ScriptSvc│
│配置管理  │ AI代理   │ 决策引擎  │ 工具编排           │
├──────────┴──────────┴──────────┴──────────────────┤
│              Content Scripts (执行层)               │
│     DOM操作 / 网络拦截 / 脚本注入                    │
├────────────────────────────────────────────────────┤
│             远程 API 服务 (LLM 代理)                │
└────────────────────────────────────────────────────┘
```

### 1.2 核心决策引擎：AgentService

决策引擎全部集中在 [agent-service.js](file:///c:/phpstudy_pro/WWW/qwen3/ai-browser/chrome-extension/background/services/agent-service.js)（约 1900 行），通过 `run()` 方法实现完整的 Agent 自主循环。

#### 1.2.1 入口与生命周期管理

```
用户输入 (SidePanel)
    │  chrome.runtime.connect({name: 'agent-stream'})
    ▼
agentService.startAgent(port, userMessage, chatHistory)
    │
    ├─ 系统页面检查 (chrome://、edge://、about: 等拒绝执行)
    ├─ agentStates Map 管理 (tabId → {port, messages[], running})
    ▼
agentService.run(tabId, userMessage, chatHistory)
    │
    ├─ 加载域名安全策略 + 可配置参数
    ├─ 复杂度预评估 _assessComplexity()
    ├─ 构建系统提示词 (含规划指令)
    ├─ 主循环 (最多 maxRounds 轮)
    │   ├─ 探索上限检查
    │   ├─ 步骤预算通知 (70%)
    │   ├─ 低价值操作提示
    │   ├─ 计划停滞检测
    │   └─ 每轮: LLM推理 → tool_calls → 执行 → 反馈
    ├─ finish_task → 事后自评 _runJudge()
    └─ 返回结果写入 chatHistory
```

Agent 周期与 Port 是解耦的：Port 断开不会终止 Agent 运行，未发送的消息缓冲在 `agentStates[tabId].messages` 中，重连时回放。

#### 1.2.2 复杂度预评估（`_assessComplexity`）

在 Agent 主循环开始前，**专门发一次 AI 请求**对任务进行复杂度预评估：

```
评估标准:
  - simple  (≤5轮):   直接执行
  - medium  (6-12轮): 正常执行
  - complex (13+轮):  若 ≥8 轮 → 注入引导语建议用户开发专用脚本
```

这是一种 **"开局判断"机制**——在投入计算资源之前先预判任务是否需要走 Agent 路线。

#### 1.2.3 系统提示词设计（System Prompt）

系统提示词是整个约束体系的核心，分为 **6 个子模块**：

| 模块 | 内容 |
|------|------|
| **角色定位** | "AI Browser脚本调度器。分析用户需求，匹配工具库中的脚本执行" |
| **工具分阶段暴露** | 第1-2轮仅基础+探查+规划工具；第3轮起释放全部 |
| **任务规划** | 复杂任务第1轮用 create_plan 制定计划；每步完成后更新 current_step |
| **工具成本分类** | 零LLM成本（6个）/ 低成本辅助（7个）/ 核心工具（4个） |
| **工具选择原则** | 先探查(get_interactive_elements) → 再确认(find_text/get_element_info) → 再操作 |
| **行为约束** | 操作前评估、失败自律、导航约束、弹窗处理、重复操作上限、跨站禁止 |

**工具分阶段暴露**：

| 阶段 | 可用工具 | 目的 |
|------|---------|------|
| 第1-2轮 | `create_plan`, `get_interactive_elements`, `search_tools`, `read_page_content`, `find_text_on_page`, `get_element_info`, `click_element`, `fill_input`, `wait_for_element`, `scroll_page`, `go_back`, `go_forward`, `finish_task` | 降低 LLM 早期决策负担，先探查、制定计划 |
| 第3轮起 | 上述 + `hover_element`, `select_dropdown`, `press_key`, `screenshot_visible`, `inject_script_*` | 释放完整能力 |

**工具成本分类**：

| 层级 | 工具 | 成本 | 选择原则 |
|------|------|------|---------|
| 零 LLM 成本 | `get_interactive_elements`, `find_text_on_page`, `get_element_info`, `read_page_content`, `click_element`, `fill_input`, `wait_for_element` | 免费，即时返回 | **首选** |
| 低成本辅助 | `scroll_page`, `hover_element`, `select_dropdown`, `press_key`, `screenshot_visible`, `go_back`, `go_forward` | 合理使用 | 需要时使用 |
| 核心工具 | `create_plan`, `search_tools`, `inject_script_*`, `finish_task` | 需 LLM 参与 | 关键工具 |

#### 1.2.4 主循环决策流

```
while (aiRequestCount < maxRounds) {
    // 第一层：硬限制检查
    ├─ 总超时 (10分钟)
    ├─ 工具调用次数上限 (maxRounds * 3)
    
    // 第二层：运行时提醒注入
    ├─ 步骤预算警告 (≥70%)
    ├─ 低价值操作警告 (连续≥MAX_LOW_VALUE次)
    ├─ 探索上限提醒 (无脚本匹配≥EXPLORATION_LIMIT轮)      ← 新增
    └─ 计划停滞提醒 (5轮未推进)                           ← 新增
    
    // 第三层：构建工具集
    ├─ buildToolDefinitions()
    │   ├─ 第1-2轮: onlySpeedTools=true
    │   ├─ 第3轮起: 全部工具
    │   └─ 脚本按成功率降序排列                           ← 新增
    
    // 第四层：调用 LLM
    ├─ fetch(url, {body: {model, messages, temperature:0.3, tools}})
    ├─ 带重试 (429/5xx 最多2次)
    └─ 400/413 自动降级→去除 tools 参数重试
    
    // 第五层：处理 LLM 响应
    ├─ 有 tool_calls:
    │   ├─ finish_task → 流式输出 → 事后自评(_runJudge)   ← 新增
    │   ├─ create_plan → 更新计划状态 + UI展示             ← 新增
    │   ├─ get_interactive_elements → 元素索引 + UI展示    ← 新增
    │   ├─ search_tools → 累积搜索结果
    │   ├─ inject_script_* → precheck → 执行 → 记录记忆
    │   ├─ DOM工具 → executeDOMTool → 超时保护60s
    │   └─ 导航类 → 安全策略检查 + shouldTerminateSequence
    │
    │   每个动作后:
    │   ├─ ActionLoopDetector 记录动作
    │   ├─ 无进展检测 (连续maxConsecutiveFails次→强制结束)
    │   └─ 结果智能截断
    │
    │   所有动作后:
    │   └─ 循环检测提醒注入
    │
    └─ 无 tool_calls → 纯文本 → 连续maxIdleText次→强制结束
    
    // 第六层：上下文裁剪
    └─ messages > 30 时按 assistant+tool 分组裁剪
}
```

### 1.3 不确定性处理机制（八层防线）

#### 第一层：推理层 —— 显式评估要求

系统提示词强制要求 AI 在每次调用工具前进行**自我评估**：

```
"- CALL工具前，必须在思考中评估上一轮操作是否成功（成功/失败/不确定）"
"- 用 screenshot_visible 或 read_page_content 验证操作结果，不要假设成功"
```

#### 第二层：ActionLoopDetector —— 行为僵化检测

```javascript
class ActionLoopDetector {
    constructor(windowSize = 15)
    // 动作重复 ≥ 12 → 严重警告
    // 动作重复 ≥ 8  → 注意提醒  
    // 动作重复 ≥ 5  → 提示
    // 页面停滞 ≥ 5 步 → 停滞警告
}
```

**软检测**系统——只生成提醒消息，从不阻止动作。

#### 第三层：连续无进展检测

基于 `ok` 字段、内容非空、无 error 三重判断的结构化进展检测，连续 `maxConsecutiveFails` 次→强制终止。

#### 第四层：低价值操作检测

`find_text_on_page` / `screenshot_visible` 连续 `maxLowValue` 次无进展→注入收尾提醒。**仅在无进展时计数**，避免误杀有成果的搜索。

#### 第五层：连续纯文本无工具调用检测

连续 `maxIdleText` 轮纯粹文本回复而无工具调用→强制结束，防止 AI 陷入"分析-回复-不行动"的无效对话循环。

#### 第六层：探索上限机制（新增）

无脚本匹配的探索轮次超过 `explorationLimit`→注入收尾提醒，防止无休止搜索。

#### 第七层：计划停滞检测（新增）

`create_plan` 制定计划后 5 轮步骤未推进→提醒 AI 调整计划或收尾。

#### 第八层：硬限制强制终止

| 限制 | 默认值 | 行为 |
|------|--------|------|
| `maxRounds` | 15 | 达到后写入 chatHistory |
| `MAX_TOOL_CALLS` | `maxRounds * 3`（30-200） | agentError |
| `TIMEOUT_MS` | 600000 (10分钟) | agentError |
| `ACTION_TIMEOUT_MS` | 60000 (60秒) | 单动作超时 Promise.race |
| `maxConsecutiveFails` | 5 | 强制终止并流式告知 |
| `MAX_API_RETRIES` | 2 | 429/5xx 自动重试 |
| `maxLowValue` | 3 | 低价值操作警告 |
| `maxIdleText` | 2 | 纯文本无操作→终止 |
| `explorationLimit` | 5 | 无脚本探索上限 |

### 1.4 结构化规划系统（新增）

```
create_plan 工具：
  plan_items: [
    {step: "读取页面内容", estimatedTools: "read_page_content"},
    {step: "搜索新闻采集脚本", estimatedTools: "search_tools"},
    {step: "执行脚本采集数据", estimatedTools: "inject_script_42"},
  ]
  current_step: 0  // 当前执行到第几步

工作流：
  LLM输出 plan_items + current_step=0
  → Agent 存储 currentPlan 到内存
  → 执行步骤 0
  → 完成后 LLM 再次调用 create_plan 更新 current_step=1
  → 计划停滞 5 轮自动提醒
```

### 1.5 DOM 交互鲁棒性增强（新增）

新增 `get_interactive_elements` 工具：
- 序列化页面中所有可交互元素（链接、按钮、输入框、下拉框等）
- 每个元素带 `index` 编号和 `selector`
- 过滤不可见/零尺寸元素
- 零 LLM 成本，即时返回
- LLM 直接用返回的 selector 或 index 调用 click_element，减少选择器幻觉

```javascript
get_interactive_elements(selectorHint?) → {
  total: 45,
  listed: 20,
  elements: [
    {index: 0, tag: 'a', text: '新闻标题', selector: 'a.news-item', href: '/news/123'},
    {index: 1, tag: 'button', text: '加载更多', selector: 'button.load-more', type: 'button'},
    ...
  ],
  hint: "使用 click_element 配合 selector 或 index 参数进行交互"
}
```

### 1.6 事后自评机制（新增）

```
finish_task 执行后：
  → _runJudge(tabId, userMessage, agentSummary, executedTools)
  → 发送评判请求到 LLM（10秒超时，失败不阻塞）
  → 返回 {verdict: "success|partial|failure", comment: "简短评语"}
  → 通过 streamChunk 展示评判结果给用户
  → 可通过 agentConfig.enableJudge: false 关闭
```

### 1.7 经验记忆正向利用（新增）

- `buildToolDefinitions` 按 `memorySuccess/memoryTotal` 成功率**降序排列**脚本
- 每个脚本描述中展示 `[成功率:85%(17/20)]` 或 `[无历史记录]`
- 高成功率脚本排在前列，LLM 更倾向于优先选择
- 经验记忆通过 `_recordMemory` 异步记录到服务端

### 1.8 安全决策约束

- **域名安全策略**：白名单/黑名单/IP拦截三重检查，`navigate_to` 时强制拦截
- **系统页面拦截**：chrome:// / edge:// / about: 直接拒绝
- **跨站脚本禁止**：系统提示词明确禁止

### 1.9 容错与恢复机制

- **API 降级重试**：429/5xx 自动重试；400/413 去除 tools 降级重试
- **Port 断连容错**：Port 断开不终止 Agent，消息缓冲，重连回放
- **结果智能截断**：按数据结构截断而非一刀切
- **可配置参数**：6 个核心决策参数均可通过 agentConfig 动态调整

---

## 二、browser-use（Python）AI 自主决策机制概要

作为对比基准，browser-use 是一个业界成熟的 Python AI 浏览器自动化框架。

### 2.1 架构对比

| 维度 | browser-use | AI Browser Chrome Extension |
|------|------------|---------------------------|
| 运行环境 | Python 后端进程（Chromium via CDP） | Chrome 扩展（Service Worker + Content Script） |
| LLM 接入 | 直接调用 20+ LLM 提供商 | 通过服务端代理 API |
| 决策模型 | `AgentOutput` 结构化 JSON | OpenAI Function Calling (`tool_calls`) |
| 工具系统 | 注册式（`Tools` 类 + 装饰器） | 动态构建（`buildToolDefinitions`） |
| DOM 感知 | 完整 DOM 树 + 截图 + 可交互元素索引 | get_interactive_elements + 页面内容读取 + 元素查找 + 可选截图 |
| 规划系统 | 显式 `plan_update` / `current_plan_item` | create_plan 工具 + plan 状态跟踪 |
| 事后评判 | Judge 系统（5项标准） | _runJudge（3级判断：success/partial/failure） |

### 2.2 browser-use 的不确定性处理层次

1. **推理层**：`thinking` / `evaluation_previous_goal` / `memory` / `next_goal` 四个结构字段
2. **循环检测**：`ActionLoopDetector`（window=20），分5次/8次/12次三级
3. **页面停滞检测**：基于 URL+元素数量+DOM文本哈希的页面指纹（window=5）
4. **预算警告**：75% 步数预算时提醒
5. **重新计划**：连续3次无进展→重新输出 plan
6. **探索上限**：无计划探索 5 步后强制创建计划
7. **LLM 降级**：空动作重试→两次空动作注入 `done(success=False)`→`fallback_llm`
8. **安全**：域名白名单/黑名单 Watchdog，导航前后双重拦截
9. **事后评判**：Agent 完成后自动 Judge 评分（5项标准）

---

## 三、两个项目 AI 自主决策的设计限制与不确定性对比

### 3.1 AI 决策不确定性的根本来源

| 不确定性来源 | 说明 | browser-use 对策 | Chrome Extension 对策 |
|------------|------|-----------------|---------------------|
| **动作成功性** | DOM 操作执行了不代表产生预期效果 | `evaluation_previous_goal` + 截图验证 | 提示词要求显式评估 + `ok` 字段判断 + Judge 事后验证 |
| **页面状态不稳定** | 异步渲染/AJAX 内容 | `wait_for_element` + watchdog | `wait_for_element` + 页面指纹停滞检测 |
| **LLM 幻觉** | 生成不存在的选择器或 URL | 强禁止规则 + 可交互元素 [index] | get_interactive_elements 索引 + 禁止跨站 + 安全策略拦截 |
| **循环/僵化** | Agent 陷入重复无进展操作 | `ActionLoopDetector`(window=20) | `ActionLoopDetector`(window=15) + 计划停滞检测 |
| **任务超能力** | 复杂任务需专门脚本但 Agent 暴力尝试 | 规划系统 + 探索上限(5步无计划) | 复杂度预评估 + create_plan + 探索上限(5轮无脚本) |
| **成本/时间失控** | Agent 消耗过多 API 调用 | `max_steps`=500, budget 75% | `maxRounds`=15, budget 70% + 可配置所有阈值 |

### 3.2 设计限制对比表

| 限制类别 | 具体机制 | browser-use | Chrome Extension | 差异分析 |
|---------|---------|-------------|-----------------|---------|
| **步数限制** | 最大轮次 | `max_steps`=500（默认） | `maxRounds`=15（可配 ≥5） | **33 倍差距**：Extension 采用"少轮次+快速收尾"策略 |
| **工具暴露** | 分阶段开放 | 无（全量暴露） | 前 2 轮仅基础+规划工具 | Extension **独特设计** |
| **规划系统** | 显式任务规划 | `plan_update` / `current_plan_item` | `create_plan` + plan 跟踪 + 停滞检测 | **已补齐**，两者结构对等 |
| **DOM 交互鲁棒性** | 防选择器幻觉 | 完整 DOM 树 + 交互元素 [index] | `get_interactive_elements` + index 编号 | **已补齐**，零 LLM 成本即时返回 |
| **复杂度预评估** | 执行前预判 | 无 | `_assessComplexity()` | Extension **独特设计** |
| **探索上限** | 无进展探索 | 5 步无计划→强制创建计划 | 5 轮无脚本→收尾提醒 | Extension **独特设计**（已实现） |
| **计划停滞检测** | 计划未推进 | 重新计划 nudge | 5 轮未推进→提醒 | **已补齐** |
| **事后评判** | 结果验证 | Judge（5项标准） | `_runJudge`（3级评判) | **已补齐** |
| **低价值操作** | 检测辅助操作 | 无 | `LOW_VALUE_TOOLS` + streak | Extension **独特设计** |
| **纯文本空闲** | 检测不行动 | 无 | `MAX_IDLE_TEXT`=2 | Extension **独特设计** |
| **动作循环检测** | 重复行为 | window=20, 三级 | window=15, 三级 | **基本相同** |
| **页面停滞检测** | 页面不变 | URL+元素+DOM哈希 | URL+元素数量 | Extension 更简单 |
| **安全策略** | 域名限制 | CDP Watchdog（导航前后双重） | `_isUrlAllowed`（navigate_to 时） | 拦截点不同 |
| **LLM 容错** | 重试/降级 | 空动作重试→fallback_llm | 429/5xx重试→400/413降级 | 策略不同 |
| **费用/Token** | 计量 | 有 | 无 | Extension 无计量体系 |
| **经验学习** | 记录+利用 | 无（仅遥测） | `_recordMemory` + 脚本成功率排序 | Extension **独特设计**（已实现） |
| **参数可配置** | 动态调整 | 有限 | 6 个核心参数可配 | Extension **更灵活** |
| **Port 断连** | Agent 存活 | N/A（单进程） | 解耦+缓冲+重连回放 | Extension **独有场景** |
| **上下文裁剪** | Token 管理 | compact_every_n_steps | MAX_MESSAGES=30, 分组裁剪 | 策略相同 |

### 3.3 关键不确定性场景的设计差异

#### 场景 A：Agent 陷入循环重复无效操作

| | browser-use | Chrome Extension |
|---|---|---|
| 检测 | `ActionLoopDetector(window=20)` | `ActionLoopDetector(window=15)` |
| 分级 | 5→提示, 8→注意, 12→严重 | 完全相同的三级 |
| 附加 | 无 | 连续失败 + 低价值操作 + 计划停滞 **三重复合检测** |
| 结论 | 软检测 | **软+硬复合检测** |

#### 场景 B：任务过于复杂，无法直接完成

| | browser-use | Chrome Extension |
|---|---|---|
| 预判 | Agent 自己规划 | `_assessComplexity` 预评估 |
| 策略 | 先探索→输出计划→执行→偏离→重新计划 | 预判→create_plan→执行→停滞提醒→收尾 |
| 探索上限 | 5 步无计划→强制创建 | 5 轮无脚本→收尾提醒 |
| 结论 | 通过规划降维 | **规划+预判双保险** |

#### 场景 C：AI 产生幻觉（不存在的选择器）

| | browser-use | Chrome Extension |
|---|---|---|
| 约束 | 已知元素 [index] 强约束 | get_interactive_elements 提供真实 selector |
| 检测 | extract 工具验证 | `ok` 字段 + 无进展计数 + Judge 事后验证 |
| 结论 | 索引约束强 | **已对齐索引机制** |

#### 场景 D：任务结果偏离预期

| | browser-use | Chrome Extension |
|---|---|---|
| 检测 | Judge（5项标准自动评分） | `_runJudge`（success/partial/failure） |
| 用户感知 | 评分结果返回 | 流式展示评判结果给用户 |
| 可关闭 | N/A | agentConfig.enableJudge |

### 3.4 设计哲学差异总结

| 维度 | browser-use | AI Browser Chrome Extension |
|------|------------|---------------------------|
| **设计理念** | 通用自动化 Agent 框架 | 脚本调度 + DOM 辅助 + 结构化规划 |
| **决策空间** | 大（完整浏览器操控 + 文件系统 + Skills） | 中（脚本优先 + 受限 DOM + 规划引导） |
| **对不确定性态度** | **重试型**：先尝试执行，不行再调整规划 | **预判+规划型**：先评估→先规划→执行→Judge验证 |
| **约束风格** | 软约束为主（提示词 + 循环提醒） | **软硬结合**（提示词 + 多层硬限制 + 事后验证） |
| **终止触发** | 任务达成 / 步数耗尽 | 无进展 / 低价值 / 纯文本空闲 / 计划停滞 / 探索上限 / 步数耗尽 |
| **用户交互** | 非交互式（批量执行完返回） | 流式交互（实时 UI 反馈每一步 + Judge 结果） |

---

## 四、改进历程：风险 → 对策

以下是基于 v1 报告识别的五大不确定性风险及其对策实施情况：

| v1 识别的风险 | 对策 | 状态 |
|-------------|------|------|
| 无结构化规划系统，多步任务易陷入局部最优 | 新增 `create_plan` 工具 + `currentPlan` 跟踪 + 计划停滞检测 | ✅ 已实现 |
| DOM 选择器依赖 LLM 幻觉，选择器可能不存在 | 新增 `get_interactive_elements` 索引工具，返回真实 selector+index | ✅ 已实现 |
| 无事后自评闭环，Agent 可能以错误认知结束 | 新增 `_runJudge` 方法，finish_task 后自动评判 success/partial/failure | ✅ 已实现 |
| 硬限制参数不可配置，无法按场景调整 | 6 个核心参数写入 agentConfig存储，运行时动态读取 | ✅ 已实现 |
| 无脚本匹配时无限探索，浪费 API 调用 | 新增 `explorationRounds` 跟踪 + `explorationLimit` 阈值提醒 | ✅ 已实现 |
| 经验记忆只记录不利用，无法辅助决策 | `buildToolDefinitions` 按成功率降序排列，展示 `[成功率:N%]` | ✅ 已实现 |

---

## 五、Chrome Extension 当前 AI 决策不确定性残余风险

尽管以上改进大幅提升了决策质量和鲁棒性，以下残余风险仍然存在：

### 5.1 上下文裁剪的长期记忆丢失

`MAX_MESSAGES=30` 裁剪策略在长会话中会丢失早期上下文。虽已通过分组裁剪保证 assistant+tool 配对完整，但长期记忆无法保留。

**缓解**：计划系统（create_plan）提供了结构化的"中期记忆"，每一步完成会更新计划状态，减少对原始上下文的依赖。

### 5.2 脚本过滤缓存可能过期

`_filteredScriptsCache` 按 URL 缓存过滤后的脚本列表。URL 重定向后缓存可能不匹配。

**缓解**：探索上限机制会在无脚本匹配超时后触发收尾。

### 5.3 无 Token 成本计量

与 browser-use 不同，Extension 未实现 API 调用成本追踪。

### 5.4 Judge 评判粒度有限

当前 `_runJudge` 返回 success/partial/failure 三级，相比 browser-use 的 5 项标准评分精度较低。

---

## 六、决策机制对比的最终结论

经过本轮改进，AI Browser Chrome Extension 在 AI 自主决策方面的成熟度已显著提升：

| 能力维度 | 对齐程度 | 说明 |
|---------|---------|------|
| 动作选择 | ⬤⬤⬤⬤⬤ | Function Calling + buildToolDefinitions + 分阶段暴露 |
| 结构化规划 | ⬤⬤⬤⬤○ | create_plan + 停滞检测，但无自动重规划（需 LLM 主动调用） |
| 循环/僵化检测 | ⬤⬤⬤⬤⬤ | 动作重复 + 页面停滞 + 无进展 + 低价值 + 纯文本空闲 + 计划停滞 **六维复合检测** |
| DOM 交互鲁棒性 | ⬤⬤⬤⬤○ | get_interactive_elements 对齐了 browser-use 的元素索引机制 |
| 安全约束 | ⬤⬤⬤⬤○ | 域名策略 + 系统页面 + 跨站禁止，但无导航后 Watchdog |
| 事后验证 | ⬤⬤⬤○○ | _runJudge 三级评判，粒度较 browser-use 的 5 项评分粗 |
| 经验学习 | ⬤⬤⬤⬤○ | 记忆记录 + 成功率排序，browser-use 无此机制 |
| 容错降级 | ⬤⬤⬤⬤○ | API 重试 + 去 tools 降级 + Port 解耦，机制完备 |
| 参数灵活性 | ⬤⬤⬤⬤⬤ | 6 个核心阈值均可配置，browser-use 可配项较少 |

*图例：⬤ 已实现 ⬤ 已实现但有改进空间 ○ 缺失*

---

*报告版本：v2（含改进实施记录）*
*覆盖文件：browser-use (全量) / ai-browser/chrome-extension (全量)*
*改动涉及：config-service.js, agent-service.js*
