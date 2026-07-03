# AI Browser 对话记录分析报告

**分析文件**: `docs/error`
**任务**: 采集新闻列表，内页也要采集，整理给我
**页面**: https://news.66wz.com/wenzhou/jingji/（温州新闻网 - 经济频道）
**模型**: qwen3.7-plus
**配置**: maxRounds=50, enableJudge=true, debug=true

---

## 一、对话流程概览

| 轮次 | 阶段 | AI 行为 | 问题 |
|------|------|---------|------|
| 1 | Stage1 | get_interactive_elements + extract_content(宽泛选择器) | 获取50条数据含大量导航链接 |
| 2 | Stage1 | recall_data(p2) + read_page_content | **冗余recall**，数据已在截断样本中 |
| 3 | Stage1 | extract_content(更精确选择器) + get_element_info | 重复提取，选择器优化 |
| 4 | Stage1 | recall_data(p4) + recall_data(p5) | **再次冗余recall**，且用完2次限额 |
| 5 | Stage1 | search_tools("采集新闻") | 终于搜索脚本，但已浪费4轮 |
| 6 | Stage1 | create_todo | 创建待办列表 |
| 7 | Stage1 | extract_content(精确选择器) | 完成s1-1待办，Stage1结束 |
| 8 | Stage2 | inject_script_9 | 执行脚本采集内页 |
| ... | Stage2/3 | 后续处理 | |

**总耗时**: Stage1 用了7轮才完成，其中4轮在做冗余数据查询和重复提取。

---

## 二、发现的问题

### 问题1：AI 反复 recall_data 查看已有数据（严重）

**表现**:
- 第2轮: AI 调用 `recall_data(p2)` 查看已在截断样本中展示的 extract_content 结果
- 第4轮: AI 调用 `recall_data(p4)` + `recall_data(p5)`，用完当轮2次限额

**根因**:
尽管 `smartTruncateResult` 已经返回了前5-10条样本数据，AI 仍然不信任截断结果，坚持用 `recall_data` 获取完整数据。这导致：
- 浪费轮次（每轮 recall_data 不推进任务进展）
- 上下文膨胀（recall_data 返回完整数据可能达5000字符）
- 触发"连续无进展"检测的风险

**建议**:
1. 在截断样本提示中更明确说明："以上为数据预览，存储ID仅用于后续阶段引用，**无需在当前阶段recall**"
2. 对 Stage1 的 recall_data 增加限制：如果数据已在上下文中（截断样本已展示），拒绝 recall 并返回提示

---

### 问题2：Stage1 重复提取同类数据（中等）

**表现**:
- 第1轮: extract_content 返回50条数据（含导航链接和新闻链接混在一起）
- 第3轮: extract_content 用更精确的选择器再次提取，返回36条
- 第7轮: extract_content 用最精确选择器 `a[href*="system/2026"]` 提取，返回20条

三次 extract_content 本质上是逐步优化选择器，但每次的结果都包含上次的子集，造成：
- PayloadStore 中 p2、p4、p6 存储了重复数据
- 上下文中堆积了大量相同内容
- AI 在第3轮和第7轮都看到了完全相同的新闻标题

**根因**:
AI 在第1轮选择器太宽泛（`.news-list a, .list a, ul a[href*="66wz"]`），获取了导航链接+新闻链接的混合。后续轮次不断优化选择器。

**建议**:
1. 提示词中强调"Stage1只提取一次关键数据，如果选择器不准确保留到Stage2脚本处理"
2. 对同一工具+相似选择器的重复调用注入提醒

---

### 问题3：create_todo 延迟创建（中等）

**表现**:
AI 在第6轮才创建待办列表，前5轮都在"自由探索"。系统提示词要求"先了解页面→创建待办→执行"，但AI在了解页面后没有立即规划。

**影响**:
- 前5轮没有待办约束，系统无法追踪进度
- 可能触发"连续4次无进展"强制切换

**建议**:
在第2轮结束时（已有足够页面信息），注入提示"页面信息已充足，请立即调用 create_todo 创建待办列表"

---

### 问题4：recall_data 返回数据与截断样本完全重复（中等）

**表现**:
第2轮 recall_data(p2) 返回的数据，与第1轮 extract_content 的截断样本前5条完全相同。AI 看到相同的内容却没有意识到这是浪费。

**根因**:
截断样本只展示5条，但完整数据有50条。AI 可能以为截断丢失了重要信息，所以 recall 查看完整内容。但实际 recall 返回的也是同样的50条数据（因为 smartTruncateResult 的截断策略对 recall 没有限制）。

**建议**:
1. 截断样本中明确标注"共N条数据，以下展示前5条代表性样本。其余数据已存储，后续阶段可引用"
2. recall_data 对 Stage1 阶段限制只返回摘要而非完整数据

---

### 问题5：上下文膨胀严重（严重）

**表现**:
- 第7轮发送LLM时，messages 已有25条（msgs: 25）
- 每条 tool 消息都包含完整的 JSON 数据（1651字符、2021字符等）
- recall_data 返回的消息更是接近 5000 字符限制
- 系统提示词每轮重复发送（2616字符）

按第7轮的25条消息估算，总上下文约 **30,000-40,000 字符**，其中大量是重复的新闻标题。

**影响**:
- API 调用成本增加
- 到达40条消息阈值时触发压缩，压缩本身消耗一轮 LLM 调用
- 重复数据可能导致 AI 混淆

**建议**:
1. 对同一工具的重复结果进行去重（如多次 extract_content 的数据只保留最精确的一次）
2. recall_data 返回结果限制更严格（如Stage1阶段最多返回500字符摘要）

---

### 问题6：WorkingMemory 上下文注入中的数据引用方式（轻微）

**表现**:
WorkingMemory 注入的 `已收集数据` 列表使用 `[ID:p1]` 格式，这是之前修复的结果（原来用 `recall_data entry_id="p1" 查看` 会导致 AI 误触发 recall）。但 AI 仍然在第4轮用了2次 recall_data。

**说明**:
数据引用格式已从"recall_data entry_id=p1 查看"改为"[ID:p1]"，但仍未完全阻止 AI 的 recall 冲动。需要更强的提示来阻止 Stage1 阶段不必要的 recall。

---

## 三、Stage2 执行分析

第8轮进入 Stage2，系统正确地：
1. 清空了 messages 数组（msgs: 4）
2. 注入了 Stage2 提示词
3. 注入了阶段交接摘要（包含关键发现、已收集数据、阶段切换原因）
4. 注入了全局存储数据摘要
5. 仅暴露5个工具（search_tools, read_page_content, recall_data, inject_script_9, finish_task）

交接摘要质量良好，包含了：
- 关键发现（3次 extract_content 的结果摘要）
- 已做决策（创建了待办列表）
- 已收集数据（4条，含存储ID）
- 阶段切换原因（Stage1待办全部完成）

---

## 四、核心结论与优化方向

### 4.1 最关键问题：Stage1 的 recall_data 滥用

在本次对话中，7轮 Stage1 有2轮纯粹用于 recall_data，占比 **28.6%**。加上重复提取，有效推进仅3轮。

**优化优先级**：
1. **Stage1 禁止 recall_data**（或限制为0次/轮）：Stage1 的目标是页面探索和数据提取，不应回看已存储的数据
2. **截断样本增加防recall提示**：如"数据已预览，勿用recall_data重复查询"
3. **create_todo 提前触发**：第2轮后如无待办列表，注入规划提示

### 4.2 数据冗余问题

三次 extract_content 提取的是同一页面的同类数据，差异仅在选择器精度。建议：
1. 工具结果去重：同一页面同一工具的多次结果，只保留最精确的
2. 或提示 AI："数据已足够，请停止重复提取，直接创建待办"

### 4.3 上下文膨胀问题

25条消息中大量重复内容。建议：
1. 压缩阈值从40条降到25条
2. 或在每轮结束后自动清理重复的 tool 消息

---

## 五、待办窗口问题

### 现状
- 任务完成（finish_task）后，待办面板**保持显示**，展示最终完成状态
- 只在新任务启动时才清除（通过 `agentTodoClear` 广播消息）
- 用户需要手动关闭待办面板

### 用户期望
- 任务完成后待办面板自动关闭
- 下次任务启动时重新生成

### 修复方案
在 `finish_task` 执行后，发送 `agentTodoClear` 消息给所有 UI 实例（todo-viewer、content script），并在 content script 的 `updateTodoPanel` 中处理空数据时自动隐藏面板。
