# 双线程采集重构计划

## 概述

将 `xhs-feed-collect.js` 从单线程架构重构为双线程并发架构：
- **采集线程**：搜索 + 详情采集，纯 Node.js httpPost，不依赖浏览器
- **行为线程**：后台循环，通过 sign_server 操控浏览器持续产生真实行为事件
- **Cookie 同步**：仅程序启动时同步一次，运行期间不刷新

## 问题检查

### 已解决的冲突

| 冲突 | 原架构 | 新架构 |
|------|--------|--------|
| BrowserView 争抢 | 采集(browserFetch) + 行为(simulate) 争抢同一 BrowserView | 采集纯 Node.js，BrowserView 由行为线程独占 |
| 行为模拟阻塞采集 | 每8条 await simulateHumanBehavior() 阻塞 ~20s | 行为线程后台运行，采集线程零阻塞 |
| Cookie 频繁刷新 | 每5关键词 + -100重试 + 300015重试都刷新 | 仅启动时同步，-100直接停止 |

### 残留风险（用户已知，可接受）

1. **TLS 聚类风控(300015)**：纯 Node.js httpPost 的 TLS 指纹与 Chrome 不同，~300条后可能触发。缓解：行为线程持续产生真实事件流，且 XYS_ 签名本身不触发 300015。保留重试一次逻辑。
2. **Cookie 过期(-100)**：长时间运行后 cookie 可能过期。缓解：-100 直接停止，用户重启脚本重新同步。
3. **行为线程速率 < 采集速率**：行为线程每条 15-27s，采集线程每条 1.3-2.5s，速率比约 1:6-10。行为线程不会"追上"采集线程，但持续产生事件流即可维持账号活跃度。

## 延迟配置保留（不变）

以下延迟配置全部保留，重构不修改任何延迟值：

| 配置项 | 当前值 | 用途 | 保留位置 |
|--------|--------|------|----------|
| `FEED_DELAY_MIN/MAX` | 800-2000ms | 详情采集间隔 | collectKeyword 每条详情后 sleep |
| `KEYWORD_PAUSE_MIN/MAX` | 5000-10000ms | 关键词间暂停 | main() 关键词循环末尾 sleep |
| `SEARCH_DELAY` | 500ms | 搜索页间隔（当前实际用 1-2s 随机） | collectKeyword 搜索循环 |
| `BATCH_PAUSE_MIN/MAX` | 15000-30000ms | 每100条批次暂停 | collectKeyword 批次检查 |
| `FEED_RETRY_DELAY` | 15000ms | 限流重试等待 | collectKeyword 300013 处理 |
| `CONSECUTIVE_FAIL_PAUSE` | 30000ms | 连续3次失败暂停 | collectKeyword 错误处理 |

**关键保证**：collectKeyword 中每条详情后的 `await sleep(randomDelay(FEED_DELAY_MIN, FEED_DELAY_MAX))` 和 main() 中关键词间的 `await sleep(randomDelay(KEYWORD_PAUSE_MIN, KEYWORD_PAUSE_MAX))` 均保留不动。

## 修改文件

仅修改 `scripts/xhs-collection/xhs-feed-collect.js`，`sign_server.js` 无需修改。

## 详细修改方案

### 修改 1：新增 sharedNotes + behaviorLoop()

**位置**：工具函数区之后（约第 365 行）、搜索 API 之前插入

```javascript
// ======================= 双线程共享状态 =======================

const sharedNotes = [];        // 行为线程消费的笔记池
let collectionRunning = true;  // 采集线程运行标志
let behaviorNoteCount = 0;     // 行为线程计数

// ======================= 行为线程（后台循环） =======================

async function behaviorLoop() {
  if (!signServerAvailable) {
    log('[行为] 签名服务不可用，行为线程不启动');
    return;
  }
  log('[行为] 行为线程启动（后台循环）');

  while (collectionRunning) {
    if (sharedNotes.length === 0) {
      await browserSimulate();
      await sleep(randomDelay(3000, 5000));
      continue;
    }

    // 随机取一条（交换尾部+pop，O(1)）
    const idx = Math.floor(Math.random() * sharedNotes.length);
    const note = sharedNotes[idx];
    sharedNotes[idx] = sharedNotes[sharedNotes.length - 1];
    sharedNotes.pop();

    log(`  [行为] 浏览笔记: ${note.noteId} (关键词: ${note.keyword})`);

    // 导航前模拟
    await browserSimulate();

    // 导航到详情页
    const noteUrl = `https://www.xiaohongshu.com/explore/${note.noteId}`
      + `?xsec_token=${note.xsecToken}&xsec_source=pc_search&source=web_explore_feed`;
    const navResult = await browserNavigate(noteUrl, randomDelay(3000, 6000));

    if (navResult.ok) {
      await sleep(randomDelay(1000, 2000));
      await browserSimulate();
      await sleep(randomDelay(3000, 6000));  // 阅读停留
      await browserSimulate();
      await sleep(randomDelay(800, 1500));
      await browserSimulate();

      // 返回搜索页
      await sleep(randomDelay(1000, 2000));
      const searchUrl = `https://www.xiaohongshu.com/search_result`
        + `?keyword=${encodeURIComponent(note.keyword)}&source=web_explore_feed`;
      await browserNavigate(searchUrl, randomDelay(2000, 4000));
      await browserSimulate();
    } else {
      log(`  [行为] 导航失败，在当前页面模拟`);
      await browserSimulate();
    }

    behaviorNoteCount++;

    // 每8条休息8s（参考验证脚本 batchPause.every=8）
    if (behaviorNoteCount % 8 === 0) {
      log(`  [行为] 已浏览 ${behaviorNoteCount} 条，休息 8s...`);
      await sleep(8000);
    }

    await sleep(randomDelay(2000, 4000));
  }
  log('[行为] 行为线程结束');
}
```

### 修改 2：fetchFeed() 改为纯 Node.js

**当前第 432-499 行**：删除 browserFetch 分支，简化为直接委托 fetchFeedFallback

```javascript
async function fetchFeed(noteId, xsecToken) {
  const body = {
    source_note_id: noteId,
    image_formats: ['jpg', 'webp', 'avif'],
    extra: { need_body_topic: '1' },
    xsec_source: 'pc_search',
    xsec_token: xsecToken,
  };
  const bodyStr = JSON.stringify(body);
  return fetchFeedFallback(noteId, xsecToken, bodyStr);
}
```

删除：第 444-498 行的 sigCount 递增、dynamicXsc/dynamicXs 生成、策略注释、browserFetch 调用、路径分支。
保留：fetchFeedFallback() 函数（第 504-550 行）不变，它已独立生成签名。

### 修改 3：collectKeyword() 调整

**3a. 搜索完成后推送 sharedNotes**（第 641 行后插入）：
```javascript
  for (const note of notes) {
    sharedNotes.push({ noteId: note.noteId, xsecToken: note.xsecToken, keyword: note.keyword });
  }
  log(`  [共享池] 已推送 ${notes.length} 条（池总量: ${sharedNotes.length}）`);
```

**3b. 删除内联行为模拟**（第 754-762 行）：
删除 simulateHumanBehavior/browserSimulate 调用，保留 totalDetailsCollected++、详情延迟和批次暂停。

修改后该区域变为：
```javascript
    // 详情间延迟（保留不动）
    await sleep(randomDelay(FEED_DELAY_MIN, FEED_DELAY_MAX));

    totalDetailsCollected++;

    // 每 BATCH_SIZE 条详情，随机长暂停（保留不动）
    if (totalDetailsCollected % BATCH_SIZE === 0) {
      const batchPause = randomDelay(BATCH_PAUSE_MIN, BATCH_PAUSE_MAX);
      log(`  [详情] 已采集 ${totalDetailsCollected} 条，批次暂停 ${batchPause / 1000}s...`);
      await sleep(batchPause);
    }
```

**3c. 搜索 -100 直接停止**（第 598-624 行简化）：
删除 cookie 刷新重试逻辑，直接 return stopped=true。

**3d. 详情 -100 直接停止**（第 681-700 行简化）：
删除 cookie 刷新重试逻辑，直接 return stopped=true。

**3e. 详情 300015 修复**（第 705-741 行）：
- 移除 cookie 刷新（第 710-716 行删除）
- 修复 `resp = retry` 的 const 赋值 bug（第 732 行删除）
- 重试后非 0/非 300015 错误直接记录失败

### 修改 4：main() 调整

**4a. 启动 behaviorLoop**（第 851 行后插入）：
```javascript
behaviorLoop().catch(err => log(`[行为] 异常: ${err.message}`));
log(`  行为线程: 已启动（后台运行）`);
```

**4b. 删除定期 cookie 刷新**（第 879-886 行删除）

**保留**：关键词间暂停（第 888-892 行）不动：
```javascript
    if (i < KEYWORDS.length - 1) {
      const pauseMs = randomDelay(KEYWORD_PAUSE_MIN, KEYWORD_PAUSE_MAX);
      log(`\n  关键词间暂停 ${pauseMs / 1000}s...`);
      await sleep(pauseMs);
    }
```

**4c. 采集结束后停止行为线程**（第 893 行后插入）：
```javascript
collectionRunning = false;
log(`[行为] 采集已结束，行为线程将退出`);
```

## 验证步骤

1. `grep -n "browserFetch" xhs-feed-collect.js` 确认 fetchFeed 中无调用
2. `grep -n "simulateHumanBehavior" xhs-feed-collect.js` 确认 collectKeyword 中无调用
3. `grep -n "getBrowserCookies" xhs-feed-collect.js` 确认仅 main() 启动时调用一次
4. `node -c xhs-feed-collect.js` 语法检查
5. 实际运行：先改 KEYWORDS 为前 2 个关键词测试，观察行为线程日志与采集日志交替出现
