# AI 自主决策流程分析报告

> 生成时间：2026-07-01
> 分析范围：chrome-extension（Chrome 扩展端）、electron（桌面端）、admin-server（服务端）
> 核心文件：`chrome-extension/background/services/agent-service.js`

---

## 一、整体架构概览

本项目定位为"基于大语言模型自主决策的浏览器智能操控系统"，存在 **双架构并行** 设计：

| 架构 | 位置 | AI 角色 | 控制范式 |
|------|------|---------|---------|
| Chrome 扩展端 | `chrome-extension/background/services/agent-service.js` | 工具调度者 | AI 调用预定义 DOM 工具 + 脚本库 |
| Electron 桌面端 | `electron/ai/agent_loop.js` | 程序员 | AI 生成任意 JS 代码注入执行 |
| 服务端 | `admin-server/` | 代理转发 + 工具仓库 | 不参与决策，仅转发 LLM 请求、提供脚本检索 |

**决策核心完全在浏览器端执行**，服务端角色为：
1. AI 代理转发（`controllers/aiProxyController.js`）— 查找模型+供应商，HMAC 签名认证，转发到上游 LLM
2. 脚本仓库（`controllers/scriptController.js`）— Embedding 语义搜索 + 关键词降级
3. 经验记忆（`controllers/memoryController.js`）— 脚本执行成功/失败记录

---

## 二、完整决策流程分析（Chrome 扩展端为主）

### 2.1 决策发起链路

```
用户输入任务
  └─ sidepanel.js 建立 "agent-stream" Port，发送 agentStart 消息
      └─ background/index.js:157 监听 Port，调用 agentService.startAgent()
          └─ agent-service.js:892 startAgent() 获取 tab、初始化状态
              └─ agent-service.js:1136 run() 进入主决策循环
```

关键引用：
- `941:945:chrome-extension/sidepanel/sidepanel.js` — 发送 `{ type: 'agentStart', userMessage, chatHistory }`
- `157:179:chrome-extension/background/index.js` — Port 路由
- `892:931:chrome-extension/background/services/agent-service.js` — `startAgent` 入口

### 2.2 决策循环的八个阶段

`run()` 方法（`1136:2212:agent-service.js`）的主循环结构：

#### 阶段 0：初始化与配置加载（1136:1198）
- 加载域名安全策略（`_loadDomainPolicy`）
- 从 `chrome.storage` 读取配置：`maxRounds`(15)、`MAX_CONSECUTIVE_FAILS`(5)、`MAX_LOW_VALUE`(3)、`MAX_IDLE_TEXT`(2)、`EXPLORATION_LIMIT`(5)
- 计算工具调用上限 = `min(200, max(30, maxRounds * 3))`
- 初始化动作循环检测器 `ActionLoopDetector(15)`

#### 阶段 1：系统提示词构建（1196:1271）
构建约 3138 字符的系统提示，包含 9 个结构化模块（详见第三节）。

#### 阶段 2：自动搜索工具脚本（1273:1312）
**进入循环前的预处理**，从用户消息提取中文关键词，主动搜索匹配脚本：
- 正则提取 2-4 字中文关键词
- 意图关键词映射扩展（采集→批量、新闻→采集 等）
- 调用 `toolService.searchScripts()` 语义搜索
- 将匹配结果注入系统消息告知 LLM

#### 阶段 3：任务复杂度预评估（1321:1328）
调用 `_assessComplexity()`（`984:1037`）发起一次轻量 LLM 请求（max_tokens=128），评估：
- 输出：`{ level: 'simple|medium|complex', estimatedRounds, needsScript }`
- 预估轮次 > 8 时注入提示建议用户开发专用脚本

#### 阶段 4：主决策循环（while 循环，1337:2201）
**核心决策引擎**，每次循环 = 一次 LLM API 请求 + 工具执行：

| 子阶段 | 行号 | 功能 |
|--------|------|------|
| 4a 超时与限额检查 | 1338:1347 | 总超时 10 分钟（600000ms）、工具调用上限 |
| 4b 步骤预算通知 | 1356:1368 | 70% 温和提醒，85% 紧急收尾 |
| 4c 规则检测与消息注入 | 1370:1436 | 低价值操作、探索上限、绝对轮次、计划停滞检测 |
| 4d LLM 请求 | 1440:1520 | 构建 messages、工具定义、调用 AI 代理 |
| 4e 工具执行 | 1530:1900 | 解析 tool_calls、执行工具、收集结果 |
| 4f 结果反馈 | 1900:1970 | 工具结果注入 messages，进入下一轮 |
| 4g 循环检测 | 1970:2010 | ActionLoopDetector 检测动作重复/页面停滞 |
| 4h 上下文压缩 | 2013:2170 | 超 40 条消息触发分级摘要压缩 |

#### 阶段 5：事后自评（2203:2212）
若 `enableJudge=true`，调用 `_runJudge()`（`1040:1084`）对执行结果评判 `success|partial|failure`。

#### 阶段 6：复杂度复核（可选）
任务结束后与预评估对比，验证评估准确性。

### 2.3 工具分阶段暴露策略

`buildToolDefinitions()`（`84:455:agent-service.js`）实现动态工具集：

| 轮次 | 可用工具数 | 包含工具 |
|------|-----------|---------|
| 第 1-2 轮 | 14 个 | 核心+探查工具（search_tools、read_page_content、click_element、fill_input、create_plan、finish_task 等） |
| 第 3 轮起 | 20+ 个 | 追加 scroll_page、hover_element、select_dropdown、press_key、screenshot_visible + 动态脚本工具（最多 6 个） |

**设计意图**：避免 AI 早期被过多工具选择干扰，先感知页面再操作。

### 2.4 LLM 请求构建（4d 阶段）

```
请求参数:
  - model: deepseek-chat（默认）
  - temperature: 0.3（Agent 模式降低随机性）
  - max_tokens: 2048-4096
  - tools: 动态工具定义（按轮次暴露）
  - messages: system prompt + 历史对话（含工具调用与结果）
  - stream: false（Agent 模式非流式，便于解析 tool_calls）
```

认证方式：HMAC-SHA256 签名（appKey/appSecret），通过 `config-service.js` 的 `getAIProxyUrl()` 获取代理地址。

### 2.5 上下文窗口管理（分级压缩）

`2013:2170:agent-service.js`，超 40 条消息触发压缩：

| 等级 | 保留策略 | 内容类型 |
|------|---------|---------|
| S 级 | 完整保留 | extract_content 链接列表、inject_script 批量采集结果 |
| A 级 | 关键摘要 | navigate_to、create_plan、search_tools 结果 |
| B 级 | 压缩为 100 字符结论 | 其他工具结果 |
| C 级 | 合并去重 | 系统提示消息 |

---

## 三、Prompt 设计分析

### 3.1 Agent 系统提示词结构（1198:1269:agent-service.js）

约 3138 字符，包含 9 个结构化模块：

1. **角色定义**："你是 AI Browser 脚本调度器"
2. **工具分阶段暴露策略**：第 1-2 轮核心工具，第 3 轮起全部工具
3. **任务规划指令**：复杂任务必须先 `create_plan` 再执行
4. **工具成本分类**（三级）：
   - 零 LLM 成本（优先）：`extract_content`、`get_interactive_elements`、`find_text_on_page`
   - 低成本辅助：`scroll_page`、`hover_element`、`press_key`
   - 核心工具：`create_plan`、`search_tools`、`inject_script_*`、`finish_task`
5. **工具选择原则**（7 条规则）
6. **脚本匹配规则**：域名过滤、禁止跨站注入
7. **操作铁律**（7 条强约束）
8. **输出规范**
9. **典型工作流程**（5 步示例）

### 3.2 辅助 Prompt

| Prompt | 位置 | 用途 |
|--------|------|------|
| 复杂度评估 | `993:994:agent-service.js` | "任务复杂度评估器"，输出 JSON |
| 结果评判 | `1055:1057:agent-service.js` | "任务结果评判器"，输出 verdict + comment |
| 默认对话 | `config-service.js:7` | 基础助手提示 |

---

## 四、关键点分析

### 4.1 核心创新点

1. **"决策—执行—反馈"闭环**（`专利交底书.md:9`）
   - AI 自主决定调用哪些工具、传什么参数，客户端执行后反馈结果，形成多轮迭代

2. **防死循环 8 层防护**（`docs/agent-anti-loop.md`）
   - 核心理念："死循环的本质不是调用多，而是无进展"
   - 用"连续无进展检测"（`MAX_CONSECUTIVE_FAILS=5`）替代简单调用次数限制

3. **工具分阶段暴露**
   - 避免工具过载，先感知后操作，降低早期决策复杂度

4. **任务复杂度预评估 + 事后自评**
   - 双向校验：执行前预估资源需求，执行后验证结果质量

5. **上下文分级压缩**（S/A/B/C 四级）
   - 精细化管理上下文窗口，关键数据完整保留，次要信息压缩

6. **域名安全策略**
   - 白名单/黑名单/IP 拦截/脚本域名过滤，防止越权操作

### 4.2 关键控制参数

| 参数 | 默认值 | 作用 | 位置 |
|------|--------|------|------|
| `maxRounds` | 15 | AI API 请求轮次上限 | `config-service.js:124` |
| `MAX_CONSECUTIVE_FAILS` | 5 | 连续无进展终止 | `agent-service.js` |
| `MAX_LOW_VALUE` | 3 | 连续低价值操作上限 | `agent-service.js` |
| `MAX_IDLE_TEXT` | 2 | 连续纯文本无工具调用上限 | `agent-service.js` |
| `EXPLORATION_LIMIT` | 5 | 探索轮次上限 | `agent-service.js` |
| `TIMEOUT_MS` | 600000 | 总超时 10 分钟 | `agent-service.js` |
| `MAX_TOOL_CALLS` | min(200, max(30, maxRounds*3)) | 工具调用总上限 | `agent-service.js:1167` |
| `temperature` | 0.3 | Agent 模式温度 | `agent-service.js:1471` |

### 4.3 数据流转

```
用户消息
  ↓
[预处理] 关键词提取 → 脚本语义搜索 → 复杂度评估
  ↓
[主循环] ┌→ 构建messages+tools → LLM请求 → 解析tool_calls
  │       ↓
  │       工具执行（DOM操作/脚本注入/页面导航）
  │       ↓
  │       结果反馈到messages → 循环检测 → 上下文压缩
  └──────┘ (直到 finish_task 或触发终止条件)
  ↓
[后处理] 事后自评 → 结果返回用户
```

### 4.4 服务端角色（非决策方）

| 服务 | 文件 | 决策中的角色 |
|------|------|-------------|
| AI 代理转发 | `aiProxyController.js` | 查找模型+供应商，HMAC 认证，转发到上游 LLM |
| 脚本搜索 | `scriptController.js` | Embedding 语义搜索 + LIKE 降级，返回匹配脚本 |
| 经验记忆 | `memoryController.js` | 记录脚本执行成功/失败，用于排序脚本工具 |
| 嵌入服务 | `embeddingService.js` | 本地 all-MiniLM-L6-v2（384维），Python 备选 Qwen3-Embedding-0.6B |

**关键发现**：admin-server 目录下**没有**以 agent/decision/planning 命名的文件，决策逻辑完全在浏览器端。

---

## 五、问题识别与完善建议

### 5.1 架构层面

#### 问题 1：双架构代码重复，维护成本高
- Electron 端（`agent_loop.js`）和 Chrome 扩展端（`agent-service.js`）各自实现了完整的决策循环、循环检测、上下文管理，逻辑高度相似但实现不同
- Prompt 模板、工具定义、防死循环逻辑存在重复

**建议**：抽取共享决策核心层
- 将决策循环、循环检测、上下文压缩等通用逻辑抽取为独立模块
- 两个端共享同一套决策引擎，仅工具执行层（CDP vs DOM API）各自实现
- 统一 Prompt 模板管理，避免两端不一致

#### 问题 2：服务端缺少决策可观测性
- 当前 `ai_call_logs` 表仅记录 LLM 调用日志，缺少 Agent 决策过程日志
- 无法回溯分析：某次任务走了哪些步骤、为什么终止、工具调用链路

**建议**：增加 Agent 决策日志表
```sql
CREATE TABLE agent_sessions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id VARCHAR(64),
  tab_url VARCHAR(2048),
  user_message TEXT,
  complexity_level VARCHAR(20),
  estimated_rounds INT,
  actual_rounds INT,
  tool_calls_json JSON,       -- 工具调用链路
  termination_reason VARCHAR(100),
  judge_verdict VARCHAR(20),
  judge_comment VARCHAR(200),
  duration_ms BIGINT,
  created_at TIMESTAMP
);
```
- 浏览器端每轮决策上报心跳，便于线上问题排查

#### 问题 3：`configService.js` 缺失
- `forgeController.js:125` 引用了 `../services/configService`，但 `services/` 目录下不存在此文件
- 运行时会导致 `require` 失败

**建议**：补全缺失文件或修改引用路径

### 5.2 决策流程层面

#### 问题 4：复杂度预评估增加延迟，但结果利用率低
- `_assessComplexity()` 每次任务都发起一次额外 LLM 请求（max_tokens=128）
- 预估轮次 > 8 时仅注入提示，未实际影响 `maxRounds` 配置或资源分配

**建议**：让预评估结果驱动决策参数
- `complex` 任务自动提升 `maxRounds` 上限（如 15→25）
- `simple` 任务降低 `maxRounds`（如 15→8），减少不必要的轮次
- 对 `needsScript=true` 但脚本库无匹配的情况，提前提示用户而非进入循环后才发现

#### 问题 5：工具分阶段暴露的轮次阈值固定
- 固定"第 3 轮起释放全部工具"，未根据任务类型动态调整

**建议**：基于复杂度评估动态调整
- `simple` 任务可从第 1 轮就暴露全部工具
- `complex` 任务保持分阶段，避免早期工具过载

#### 问题 6：计划停滞检测的跳过策略较粗暴
- 计划在某步骤停滞 ≥8 轮时"强制跳过步骤"（`1417:1436`）
- 跳过后可能导致后续步骤依赖的前置条件未满足

**建议**：跳过前增加依赖检查
- 跳过步骤前，由 LLM 快速评估跳过对后续步骤的影响
- 或将跳过的步骤标记为"跳过原因"，在 finish_task 时纳入自评

#### 问题 7：上下文压缩可能丢失关键信息
- B 级压缩将工具结果截断为 100 字符，可能丢失关键错误信息
- 压缩触发阈值固定 40 条消息，未考虑单条消息大小

**建议**：基于 token 数而非消息数触发压缩
- 计算当前 messages 的估算 token 数，接近 context_window 80% 时触发
- B 级压缩时保留错误信息完整（检测 "error"、"失败" 等关键词），仅截断成功结果

### 5.3 Prompt 设计层面

#### 问题 8：系统提示词过长（3138 字符）
- 占用大量上下文窗口，每轮请求都重复发送
- 部分内容（如典型工作流程示例）可精简

**建议**：精简并分层 Prompt
- 核心约束（铁律、输出规范）保留在 system prompt
- 示例、工具成本分类等移至首次用户消息或动态注入
- 监控 system prompt 的 token 占比，建议 < 总上下文的 15%

#### 问题 9：Prompt 为中文，但 LLM 训练数据以英文为主
- 中文 Prompt 可能增加 token 消耗（中文 token 化效率低于英文）
- 部分模型的中文指令遵循能力弱于英文

**建议**：A/B 测试中英文 Prompt 效果
- 对 DeepSeek 等中文优化模型保持中文
- 对 GPT-4o 等模型考虑英文 Prompt + 中文输出要求
- 提供 Prompt 模板的多语言版本

#### 问题 10：缺少 Few-shot 示例
- 当前 Prompt 仅描述规则，未提供成功/失败案例
- AI 对"低价值操作"、"计划停滞"等概念的理解可能不一致

**建议**：增加结构化 Few-shot
- 在系统提示中嵌入 1-2 个成功任务的工具调用序列示例
- 标注哪些操作属于"低价值"，帮助 AI 对齐概念

### 5.4 安全与鲁棒性层面

#### 问题 11：域名安全策略仅在启动时加载一次
- `_loadDomainPolicy()` 在 `run()` 开始时调用（`1136:1139`）
- 若任务执行过程中导航到新域名，策略不会更新

**建议**：每次 `navigate_to` 后重新加载策略
- 或在 `navigate_to` 工具执行前检查目标域名是否在策略允许范围内

#### 问题 12：HMAC 签名密钥存储在 chrome.storage
- `appKey`/`appSecret` 存储在扩展本地，存在泄露风险
- 攻击者获取密钥后可冒充扩展调用 AI 代理

**建议**：改用短期令牌
- 扩展启动时用长期密钥换取短期 access_token
- AI 代理验证 token 有效性而非直接验签

#### 问题 13：工具执行无沙箱隔离
- `inject_script_*` 直接在页面上下文执行脚本，可能被恶意网页劫持
- 页面的 `window` 对象可被重写，影响工具执行结果

**建议**：关键操作在 isolated world 执行
- Chrome 扩展 content script 默认运行在 isolated world，利用这一特性
- 对 `inject_script_*` 的执行结果做完整性校验

### 5.5 性能层面

#### 问题 14：每次任务都发起复杂度评估请求，增加延迟
- 对于明显简单的任务（如"提取页面标题"），预评估是额外开销

**建议**：增加本地快速预判
- 基于用户消息长度、关键词匹配做本地预判
- 仅对中等复杂度任务发起 LLM 评估

#### 问题 15：脚本语义搜索每次任务都执行
- `searchScripts()` 在阶段 2 自动执行，即使任务不需要脚本

**建议**：延迟搜索或基于复杂度评估结果决定
- `needsScript=false` 时跳过自动搜索
- 或将搜索延迟到 AI 主动调用 `search_tools` 时

### 5.6 可扩展性层面

#### 问题 16：工具定义硬编码在 agent-service.js 中
- `buildToolDefinitions()`（`84:455`）将 20 个工具定义硬编码
- 新增工具需修改核心文件，违反开闭原则

**建议**：工具注册表模式
- 每个工具独立为模块，实现统一接口 `{ name, description, parameters, execute }`
- `agent-service.js` 从注册表动态组装工具集
- 便于第三方扩展工具

#### 问题 17：防死循环参数全局固定，未按任务类型调整
- 所有任务使用相同的 `MAX_CONSECUTIVE_FAILS=5` 等阈值
- 数据采集类任务可能需要更多重试，交互类任务需要更严格限制

**建议**：按任务类型动态配置阈值
- 复杂度评估时同时输出推荐参数
- 或提供任务类型分类（采集/交互/分析），各类使用不同参数集

---

## 六、优先级排序建议

| 优先级 | 建议 | 预期收益 | 实施难度 |
|--------|------|---------|---------|
| P0 | 补全缺失的 `configService.js`（问题 3） | 修复运行时错误 | 低 |
| P0 | 域名策略导航后刷新（问题 11） | 安全性 | 低 |
| P1 | Agent 决策日志表（问题 2） | 可观测性 | 中 |
| P1 | 预评估结果驱动参数（问题 4） | 减少无效轮次 | 中 |
| P1 | 上下文压缩保留错误信息（问题 7） | 决策准确性 | 中 |
| P2 | HMAC 改短期令牌（问题 12） | 安全性 | 中 |
| P2 | 工具注册表模式（问题 16） | 可扩展性 | 高 |
| P2 | 双架构共享决策核心（问题 1） | 维护成本 | 高 |
| P3 | Prompt 精简与分层（问题 8） | 上下文效率 | 中 |
| P3 | Few-shot 示例（问题 10） | 决策质量 | 中 |
| P3 | 按任务类型动态阈值（问题 17） | 灵活性 | 中 |

---

## 七、总结

本项目的 AI 自主决策系统已具备**完整的"感知→决策→执行→反馈"闭环**，核心创新在于：

1. **8 层防死循环机制**，以"无进展检测"替代简单计数
2. **工具分阶段暴露**，降低早期决策复杂度
3. **任务复杂度预评估 + 事后自评**，双向校验
4. **上下文分级压缩**（S/A/B/C），精细化管理窗口

主要改进方向集中在：
- **可观测性**（决策日志缺失）
- **参数自适应性**（全局固定阈值）
- **安全性**（密钥管理、域名策略时效）
- **可扩展性**（工具硬编码、双架构重复）

---

## 八、已实施的修复与架构优化

### 8.1 Bug 修复：右键菜单 AI 总结/翻译功能失效

**根因**：`background/index.js:200-209` 右键菜单点击后发送 `{ type: 'selectionAction', action, text }` 到 content script，但 `content/index.js:45-52` 的消息监听器只处理 `extractPageContent`，**未处理 `selectionAction`**，导致消息被忽略。

**修复**：
1. 在 `content/index.js` 的 `chrome.runtime.onMessage.addListener` 中添加 `selectionAction` 消息处理，调用 `handleSelectionAction(msg.action, msg.text)`
2. 优化 `handleSelectionAction` 区分页面级（右键菜单 summarize/translate）与划词级操作：
   - 页面级（无选中文本）：使用短提示如"总结当前页面内容"，sidepanel 的 `sendMessage` 自动检测关键词并注入页面内容
   - 划词级（有选中文本）：使用"请总结以下内容要点：\n\n" + text 格式

### 8.2 架构优化：agent-service.js 模块拆分

`agent-service.js` 原有 2535 行，过于庞大。已将独立模块提取为单独文件：

| 新模块 | 原行号范围 | 行数 | 说明 |
|--------|-----------|------|------|
| `payload-store.js` | 1-178 | 178 | PayloadStore 工具结果暂存区，零依赖 |
| `action-loop-detector.js` | 180-235 | 55 | ActionLoopDetector 动作循环检测器，零依赖 |
| `domain-policy.js` | 998-1060 | 62 | DomainPolicy 域名安全策略，依赖 configService + scriptService |
| `agent-service.js`（剩余） | 237-2535 | ~2240 | AgentService 主体（import 导入上述模块） |

拆分后 `agent-service.js` 从 2535 行减少到约 2240 行，减少了约 295 行。三个独立模块职责清晰、可独立测试。

**后续拆分建议**（降低 agent-service.js 到 ~1500 行）：
- `agent-tools.js`：提取 `buildToolDefinitions`(~390行) 和 `executeDOMTool`(~315行)
- `agent-prompt.js`：提取系统提示词构建、复杂度评估、事后自评

建议按 P0→P1→P2→P3 优先级逐步完善，优先修复阻塞性问题和安全风险，再提升可观测性和自适应性。

### 8.3 代码级强制机制实施

**背景**：系统提示词经过3次迭代重写，AI仍反复违反规则（不调用匹配脚本、重复查询recall_data、重复提取同一selector）。根本原因是**提示词规则在上下文膨胀后被淹没**，LLM不再遵守。必须用代码级拦截代替提示词约束。

**已实施的4项强制机制**：

| 机制 | 拦截对象 | 触发条件 | 拦截行为 |
|------|---------|---------|---------|
| 1. recall_data调用限制 | recall_data | 单条entry_id被查询超过2次 | 返回 `{ ok: false, error: "该存储数据已查询2次以上..." }` |
| 2. selector重复提取拦截 | extract_content/get_element_info/find_text_on_page | 同一selector+tool组合重复调用 | 返回 `{ ok: false, error: "已用xxx提取过选择器..." }` |
| 3. 脚本优先强制执行 | inject_script_* | 有匹配脚本但连续3轮未调用 | 注入🚨强制提示；连续5轮未调用→强制终止任务 |
| 4. 预算导航拦截 | navigate_to | 预算使用≥85%时调用navigate_to | 返回 `{ ok: false, error: "预算不足，禁止导航到新页面..." }` |

**关键设计原则**：所有拦截返回结构化错误 `{ ok: false, error: "..." }`，而非简单跳过。LLM收到明确的拒绝原因后可调整策略，不会陷入"工具无声失败→重复调用→再失败"的死循环。
