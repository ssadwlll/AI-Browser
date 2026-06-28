// ==================== 小红书笔记采集面板 v2.0 ====================
// 使用方法：在小红书搜索列表页打开浏览器控制台(F12)，粘贴全部代码并回车运行
// 支持：搜索结果页 / 话题页 / 用户主页笔记列表
// =================================================================

(function() {
  'use strict';
  
  // 防止重复注入
  if (document.getElementById('xhs-scraper-panel')) {
    console.log('⚠️ 采集面板已存在，跳过注入');
    return;
  }
  
  // ==================== 1. 注入样式 ====================
  const style = document.createElement('style');
  style.id = 'xhs-scraper-style';
  style.textContent = `
    #xhs-scraper-panel {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 99999;
      width: 400px;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      color: #e0e0e0;
      user-select: none;
      overflow: hidden;
      transition: transform 0.3s ease, opacity 0.3s ease;
      font-size: 12px;
    }
    #xhs-scraper-panel.minimized {
      transform: translateY(calc(-100% + 50px));
      opacity: 0.88;
    }
    #xhs-scraper-panel.minimized:hover { opacity: 1; }

    .xhs-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 18px;
      background: rgba(255,255,255,0.03);
      border-bottom: 1px solid rgba(255,255,255,0.08);
      cursor: move;
    }
    .xhs-panel-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 15px;
      font-weight: 700;
      color: #ff6b6b;
      letter-spacing: 0.5px;
    }
    .xhs-panel-title .xhs-logo {
      width: 30px;
      height: 30px;
      background: linear-gradient(135deg, #ff6b6b, #ee5a24);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      box-shadow: 0 4px 15px rgba(255,107,107,0.3);
    }
    .xhs-panel-actions { display: flex; gap: 6px; }
    .xhs-btn-icon {
      width: 32px; height: 32px;
      border-radius: 8px; border: none;
      background: rgba(255,255,255,0.06);
      color: #aaa; cursor: pointer;
      font-size: 16px; display: flex;
      align-items: center; justify-content: center;
      transition: all 0.2s;
    }
    .xhs-btn-icon:hover { background: rgba(255,255,255,0.14); color: #fff; }

    .xhs-panel-body {
      padding: 14px 18px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .xhs-stats-row { display: flex; gap: 8px; }
    .xhs-stat-card {
      flex: 1;
      background: rgba(255,255,255,0.04);
      border-radius: 10px;
      padding: 10px 6px;
      text-align: center;
      border: 1px solid rgba(255,255,255,0.05);
    }
    .xhs-stat-value { font-size: 22px; font-weight: 700; color: #ff6b6b; line-height: 1; }
    .xhs-stat-label { font-size: 10px; color: #888; margin-top: 4px; }

    .xhs-progress-wrap {
      background: rgba(255,255,255,0.06);
      border-radius: 10px; height: 6px; overflow: hidden;
    }
    .xhs-progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #ff6b6b, #ee5a24);
      border-radius: 10px;
      transition: width 0.4s ease;
      width: 0%;
    }

    .xhs-status {
      display: flex; align-items: center; gap: 8px;
      font-size: 11px; color: #aaa;
    }
    .xhs-status-dot {
      width: 8px; height: 8px; border-radius: 50%; background: #666;
    }
    .xhs-status-dot.running { background: #2ed573; animation: xhs-pulse 1.2s infinite; }
    .xhs-status-dot.paused  { background: #ffa502; }
    .xhs-status-dot.stopped { background: #ff4757; }

    @keyframes xhs-pulse {
      0%,100% { opacity:1; box-shadow: 0 0 0 0 rgba(46,213,115,0.6); }
      50% { opacity:0.6; box-shadow: 0 0 0 10px rgba(46,213,115,0); }
    }

    .xhs-control-row { display: flex; gap: 6px; }
    .xhs-btn {
      flex: 1; padding: 10px 12px; border-radius: 10px; border: none;
      font-size: 12px; font-weight: 700; cursor: pointer;
      letter-spacing: 0.5px; transition: all 0.25s;
      display: flex; align-items: center; justify-content: center; gap: 5px;
    }
    .xhs-btn:active { transform: scale(0.95); }
    .xhs-btn-start  { background: linear-gradient(135deg,#2ed573,#7bed9f); color:#1a1a2e; }
    .xhs-btn-start:hover  { box-shadow: 0 4px 20px rgba(46,213,115,0.4); }
    .xhs-btn-pause  { background: linear-gradient(135deg,#ffa502,#ffbe76); color:#1a1a2e; }
    .xhs-btn-pause:hover  { box-shadow: 0 4px 20px rgba(255,165,2,0.4); }
    .xhs-btn-stop   { background: linear-gradient(135deg,#ff4757,#ff6b81); color:#fff; }
    .xhs-btn-stop:hover   { box-shadow: 0 4px 20px rgba(255,71,87,0.4); }
    .xhs-btn-export { background: linear-gradient(135deg,#3742fa,#5352ed); color:#fff; }
    .xhs-btn-export:hover { box-shadow: 0 4px 20px rgba(55,66,250,0.4); }

    .xhs-settings { display: flex; gap: 6px; flex-wrap: wrap; }
    .xhs-setting-item {
      display: flex; align-items: center; gap: 4px;
      font-size: 10px; color: #999;
    }
    .xhs-setting-item input {
      width: 48px; padding: 4px 6px; border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.05); color: #e0e0e0;
      font-size: 10px; text-align: center;
    }
    .xhs-setting-item input:focus { outline: none; border-color: #ff6b6b; }
    .xhs-setting-item label { cursor: pointer; display: flex; align-items: center; gap: 3px; }

    .xhs-log-area {
      max-height: 150px; overflow-y: auto;
      background: rgba(0,0,0,0.3); border-radius: 10px;
      padding: 10px; font-size: 10px;
      font-family: 'SF Mono','Menlo','Consolas',monospace;
      color: #aaa; line-height: 1.7;
    }
    .xhs-log-area .log-success { color: #2ed573; }
    .xhs-log-area .log-error   { color: #ff4757; }
    .xhs-log-area .log-info    { color: #70a1ff; }
    .xhs-log-area .log-warn    { color: #ffa502; }
    .xhs-log-area::-webkit-scrollbar { width: 4px; }
    .xhs-log-area::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.1); border-radius: 2px;
    }

    /* 待采集列表预览 */
    .xhs-preview-row {
      display: flex; gap: 6px; overflow-x: auto;
      padding: 6px 0; max-height: 60px;
    }
    .xhs-preview-item {
      flex-shrink: 0; width: 48px; height: 48px;
      border-radius: 8px; overflow: hidden;
      border: 2px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.05);
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; color: #666;
    }
    .xhs-preview-item.done { border-color: #2ed573; opacity: 0.7; }
    .xhs-preview-item.current { border-color: #ff6b6b; animation: xhs-pulse 1.2s infinite; }
    .xhs-preview-item img { width: 100%; height: 100%; object-fit: cover; }

    /* 键盘快捷键提示 */
    .xhs-shortcuts {
      font-size: 9px; color: #555; text-align: center;
      padding: 4px 0; border-top: 1px solid rgba(255,255,255,0.04);
    }
    .xhs-shortcuts kbd {
      background: rgba(255,255,255,0.08); padding: 1px 5px;
      border-radius: 3px; margin: 0 2px;
    }
  `;
  document.head.appendChild(style);

  // ==================== 2. 面板HTML ====================
  const panelHTML = `
    <div id="xhs-scraper-panel">
      <div class="xhs-panel-header" id="xhs-panel-header">
        <div class="xhs-panel-title">
          <div class="xhs-logo">📕</div>
          <span>小红书采集器 Pro</span>
        </div>
        <div class="xhs-panel-actions">
          <button class="xhs-btn-icon" id="xhs-btn-min" title="最小化/展开">−</button>
          <button class="xhs-btn-icon" id="xhs-btn-close-panel" title="移除面板">✕</button>
        </div>
      </div>
      <div class="xhs-panel-body" id="xhs-panel-body">
        <!-- 统计卡片 -->
        <div class="xhs-stats-row">
          <div class="xhs-stat-card">
            <div class="xhs-stat-value" id="xhs-stat-total">0</div>
            <div class="xhs-stat-label">📝 列表笔记数</div>
          </div>
          <div class="xhs-stat-card">
            <div class="xhs-stat-value" id="xhs-stat-collected">0</div>
            <div class="xhs-stat-label">✅ 已采集</div>
          </div>
          <div class="xhs-stat-card">
            <div class="xhs-stat-value" id="xhs-stat-errors">0</div>
            <div class="xhs-stat-label">❌ 失败/跳过</div>
          </div>
        </div>

        <!-- 进度条 -->
        <div class="xhs-progress-wrap">
          <div class="xhs-progress-bar" id="xhs-progress-bar"></div>
        </div>

        <!-- 状态 -->
        <div class="xhs-status">
          <div class="xhs-status-dot stopped" id="xhs-status-dot"></div>
          <span id="xhs-status-text">🟢 就绪 - 点击「开始采集」</span>
          <span style="margin-left:auto;font-size:10px;color:#555;" id="xhs-current-note"></span>
        </div>

        <!-- 设置 -->
        <div class="xhs-settings">
          <div class="xhs-setting-item">
            ⏱ 最小延迟<input type="number" id="xhs-delay-min" value="2" min="0.3" step="0.1">s
          </div>
          <div class="xhs-setting-item">
            最大延迟<input type="number" id="xhs-delay-max" value="4" min="0.5" step="0.1">s
          </div>
          <div class="xhs-setting-item">
            📜 最大翻页<input type="number" id="xhs-max-scrolls" value="15" min="1" step="1">
          </div>
          <div class="xhs-setting-item">
            🔄 翻页间隔<input type="number" id="xhs-scroll-interval" value="3" min="0.5" step="0.5">s
          </div>
        </div>

        <!-- 按钮 -->
        <div class="xhs-control-row">
          <button class="xhs-btn xhs-btn-start" id="xhs-btn-start">▶ 开始采集</button>
          <button class="xhs-btn xhs-btn-pause" id="xhs-btn-pause">⏸ 暂停</button>
          <button class="xhs-btn xhs-btn-stop" id="xhs-btn-stop">⏹ 停止</button>
        </div>
        <div class="xhs-control-row">
          <button class="xhs-btn xhs-btn-export" id="xhs-btn-export" style="flex:1;">📥 导出 JSON</button>
          <button class="xhs-btn xhs-btn-export" id="xhs-btn-copy" style="flex:1;background:linear-gradient(135deg,#6c5ce7,#a29bfe);">📋 复制到剪贴板</button>
        </div>

        <!-- 日志 -->
        <div style="font-size:10px;color:#555;margin-top:2px;">📋 运行日志</div>
        <div class="xhs-log-area" id="xhs-log-area">
          <div class="log-info">🔧 面板初始化完成</div>
        </div>

        <!-- 快捷键 -->
        <div class="xhs-shortcuts">
          <kbd>Space</kbd> 开始/暂停 &nbsp; <kbd>Esc</kbd> 停止 &nbsp; <kbd>Ctrl+E</kbd> 导出
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', panelHTML);

  // ==================== 3. 核心采集引擎 ====================
  const XHSScraper = {
    state: 'stopped',     // stopped | running | paused
    collected: [],        // 已采集数据
    collectedIds: new Set(),
    currentIndex: 0,
    scrollCount: 0,
    errorCount: 0,
    requestCount: 0,      // 请求计数(用于反爬节奏控制)

    config: {
      delayMin: 2000,
      delayMax: 4000,
      maxScrolls: 15,
      scrollInterval: 3000,
    },

    // 反爬节奏：每处理N条后休息更久
    batchPause: {
      every: 8,              // 每8条
      extraSleep: 8000,      // 额外休息8秒
    },

    /* ========== 工具函数 ========== */
    randomDelay() {
      const { delayMin, delayMax } = this.config;
      return delayMin + Math.random() * (delayMax - delayMin);
    },

    async sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },

    // 获取笔记ID
    getNoteId(noteEl) {
      // 多种方式提取
      const link = noteEl.querySelector('a[href*="/explore/"]');
      if (link) {
        const m = link.href.match(/\/explore\/([a-zA-Z0-9]+)/);
        if (m) return m[1];
      }
      const cover = noteEl.querySelector('a.cover');
      if (cover) {
        const m = cover.href.match(/\/search_result\/([a-zA-Z0-9]+)/);
        if (m) return m[1];
      }
      return noteEl.getAttribute('data-index') || `unknown-${Date.now()}`;
    },

    getNoteElements() {
      return Array.from(document.querySelectorAll('section.note-item'));
    },

    /* ========== 人类行为模拟 ========== */

    // 贝塞尔曲线人类化鼠标移动
    async humanMouseMove(targetEl) {
      const rect = targetEl.getBoundingClientRect();
      const tx = rect.left + rect.width * (0.25 + Math.random() * 0.5);
      const ty = rect.top + rect.height * (0.25 + Math.random() * 0.5);
      const sx = window.innerWidth * (0.15 + Math.random() * 0.7);
      const sy = window.innerHeight * (0.15 + Math.random() * 0.7);

      const steps = 6 + Math.floor(Math.random() * 8);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const ease = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
        const cx = sx + (tx - sx) * ease + (Math.random()-0.5) * 25;
        const cy = sy + (ty - sy) * ease + (Math.random()-0.5) * 25;
        document.dispatchEvent(new MouseEvent('mousemove', {
          clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window
        }));
        await this.sleep(12 + Math.random() * 30);
      }
    },

    // 人类化点击（模拟按下+抬起+点击完整事件链）
    async humanClick(targetEl) {
      const rect = targetEl.getBoundingClientRect();
      const cx = rect.left + rect.width * (0.3 + Math.random() * 0.4);
      const cy = rect.top + rect.height * (0.3 + Math.random() * 0.4);

      // mousedown
      targetEl.dispatchEvent(new MouseEvent('mousedown', {
        clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window
      }));
      await this.sleep(40 + Math.random() * 80);

      // mouseup
      targetEl.dispatchEvent(new MouseEvent('mouseup', {
        clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window
      }));
      await this.sleep(20 + Math.random() * 40);

      // click
      targetEl.dispatchEvent(new MouseEvent('click', {
        clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window
      }));

      // 原生click兜底
      try { targetEl.click(); } catch(e) {}
    },

    // 人类化滚动
    async humanScroll(px) {
      const jitter = (Math.random() - 0.5) * 80;
      const amount = px + jitter;
      const steps = 3 + Math.floor(Math.random() * 5);
      const perStep = amount / steps;
      for (let i = 0; i < steps; i++) {
        window.scrollBy({ top: perStep + (Math.random()-0.5)*40, behavior: 'smooth' });
        await this.sleep(60 + Math.random() * 130);
      }
    },

    // 随机微小移动（模拟活人）
    async microMovement() {
      const dx = (Math.random() - 0.5) * 30;
      const dy = (Math.random() - 0.5) * 30;
      document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: window.innerWidth/2 + dx,
        clientY: window.innerHeight/2 + dy,
        bubbles: true, view: window
      }));
    },

    /* ========== 详情页操作 ========== */

    async waitForDetailOpen(timeout = 10000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const mask = document.querySelector('.close-mask-dark');
        const detail = document.querySelector('[class*="note-detail"], .note-scroller, #detail-desc');
        if (mask || detail) {
          await this.sleep(400 + Math.random() * 400);
          return true;
        }
        await this.sleep(250);
      }
      return false;
    },

    async waitForDetailClose(timeout = 6000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (!document.querySelector('.close-mask-dark')) {
          await this.sleep(300);
          return true;
        }
        await this.sleep(200);
      }
      return false;
    },

    async openNoteDetail(noteEl) {
      const coverLink = noteEl.querySelector('a.cover');
      const titleLink = noteEl.querySelector('a.title, a[href*="/search_result/"]');
      const target = coverLink || titleLink || noteEl.querySelector('a');
      if (!target) throw new Error('找不到笔记链接');

      // 滚动到可见
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await this.sleep(400 + Math.random() * 300);

      // 模拟人移动并点击
      await this.humanMouseMove(target);
      await this.sleep(150 + Math.random() * 250);
      await this.humanClick(target);

      const opened = await this.waitForDetailOpen();
      if (!opened) throw new Error('详情页未打开（超时）');
    },

    async closeDetail() {
      // 首选 .close-mask-dark
      let closeBtn = document.querySelector('.close-mask-dark');

      if (closeBtn) {
        await this.humanMouseMove(closeBtn);
        await this.sleep(100 + Math.random() * 200);
        await this.humanClick(closeBtn);
      } else {
        // 备选：按Escape
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        await this.sleep(200);
        // 尝试其他关闭按钮
        const altClose = document.querySelector('[class*="close-modal"], [class*="close-mask"]');
        if (altClose) { await this.humanClick(altClose); }
      }

      await this.waitForDetailClose();
      await this.microMovement();
    },

    /* ========== 数据提取 ========== */
    async extractDetailData() {
      await this.sleep(500 + Math.random() * 500);

      const data = {};

      // 标题
      const titleEl = document.querySelector('#detail-title, .note-title, h1[class*="title"], [class*="title"]');
      data.title = titleEl ? titleEl.textContent.trim() : '';

      // 正文
      const descEl = document.querySelector('#detail-desc, .note-text, [class*="note-text"], .desc, [class*="desc"]');
      data.description = descEl ? descEl.textContent.trim() : '';

      // 作者
      const authorEl = document.querySelector('.author-name, .username, [class*="author"] [class*="name"], .name, [class*="nickname"]');
      data.author = authorEl ? authorEl.textContent.trim() : '';

      // 点赞
      const likeEl = document.querySelector('[class*="like-wrapper"] span, [class*="like"] [class*="count"], .like-count');
      data.likes = likeEl ? likeEl.textContent.trim() : '';

      // 收藏
      const collectEl = document.querySelector('[class*="collect-wrapper"] span, [class*="collect"] [class*="count"], .collect-count');
      data.collects = collectEl ? collectEl.textContent.trim() : '';

      // 评论
      const commentEl = document.querySelector('[class*="comment-wrapper"] span, [class*="comment"] [class*="count"], .comment-count');
      data.comments = commentEl ? commentEl.textContent.trim() : '';

      // 时间
      const timeEl = document.querySelector('.date, .publish-date, [class*="date"], .bottom-container .date');
      data.publishTime = timeEl ? timeEl.textContent.trim() : '';

      // 标签
      const tags = document.querySelectorAll('.tag, [class*="tag"], .topic, [class*="topic"], a[href*="/tag/"]');
      data.tags = Array.from(tags).map(t => t.textContent.trim().replace(/^#/, '')).filter(Boolean);

      // 图片数
      const imgs = document.querySelectorAll('.note-scroller img, [class*="swiper"] img, .slide img');
      data.imageCount = imgs.length;

      // 笔记URL
      data.pageUrl = window.location.href;
      data.scrapedAt = new Date().toISOString();

      return data;
    },

    /* ========== 单条采集流程 ========== */
    async scrapeOneNote(noteEl, index) {
      const noteId = this.getNoteId(noteEl);

      if (this.collectedIds.has(noteId)) {
        this.log(`⏭ 跳过已采集: ${noteId.slice(0,12)}...`, 'warn');
        return null;
      }

      this.updateCurrentNote(`📌 #${index + 1}`);

      // 滚动到笔记
      noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await this.sleep(500 + Math.random() * 400);

      // 打开详情
      this.log(`🖱 点击打开笔记 #${index + 1}`, 'info');
      await this.openNoteDetail(noteEl);

      // 提取
      this.log(`📊 提取数据中...`, 'info');
      const data = await this.extractDetailData();
      data._noteId = noteId;
      data._index = index;

      // 关闭详情
      this.log(`🔙 关闭详情弹窗`, 'info');
      await this.closeDetail();

      // 记录
      this.collected.push(data);
      this.collectedIds.add(noteId);

      const preview = (data.title || data.description || '无标题').slice(0, 35);
      this.log(`✅ 采集成功: ${preview}`, 'success');

      return data;
    },

    /* ========== 主循环 ========== */
    async run() {
      if (this.state === 'running') return;
      this.state = 'running';
      this.updateUI();

      this.log('🚀 ===== 开始采集任务 =====', 'info');

      let notes = this.getNoteElements();
      this.updateTotal(notes.length);
      this.log(`📌 当前列表共 ${notes.length} 条笔记`, 'info');

      while (this.state === 'running' && this.currentIndex < notes.length) {
        // 滚动加载更多
        if (this.currentIndex >= notes.length - 3 && this.scrollCount < this.config.maxScrolls) {
          this.scrollCount++;
          this.log(`📜 滚动翻页 ${this.scrollCount}/${this.config.maxScrolls}`, 'info');
          await this.humanScroll(350 + Math.random() * 500);
          await this.sleep(this.config.scrollInterval);
          notes = this.getNoteElements();
          this.updateTotal(notes.length);
        }

        if (this.currentIndex >= notes.length) break;

        // 反爬节奏：批量休息
        if (this.currentIndex > 0 && this.currentIndex % this.batchPause.every === 0) {
          this.log(`😴 反爬节奏：休息 ${this.batchPause.extraSleep/1000}s...`, 'warn');
          await this.sleep(this.batchPause.extraSleep);
          await this.microMovement();
        }

        const noteEl = notes[this.currentIndex];

        try {
          await this.scrapeOneNote(noteEl, this.currentIndex);
        } catch (err) {
          this.errorCount++;
          this.log(`❌ 失败 #${this.currentIndex+1}: ${err.message}`, 'error');
          this.updateErrors();
          try { await this.closeDetail(); } catch(e) {}
        }

        this.currentIndex++;
        this.updateCollected(this.collected.length);
        this.updateProgress();

        // 暂停检查
        while (this.state === 'paused') {
          await this.sleep(500);
        }

        // 随机延迟
        if (this.state === 'running') {
          const delay = this.randomDelay();
          this.log(`⏳ 等待 ${delay.toFixed(0)}ms...`, 'info');
          await this.sleep(delay);
          await this.microMovement();
        }
      }

      if (this.state === 'running') {
        this.state = 'stopped';
        this.log('🎉 ===== 采集任务完成! =====', 'success');
      }
      this.updateUI();
    },

    pause()  { if(this.state==='running'){this.state='paused'; this.log('⏸ 已暂停','warn'); this.updateUI();} },
    resume() { if(this.state==='paused'){this.state='running'; this.log('▶ 继续采集','info'); this.updateUI();} },
    stop()   { this.state='stopped'; this.log('⏹ 已停止','warn'); this.updateUI(); },

    readConfig() {
      this.config.delayMin = parseFloat(document.getElementById('xhs-delay-min')?.value) * 1000 || 2000;
      this.config.delayMax = parseFloat(document.getElementById('xhs-delay-max')?.value) * 1000 || 4000;
      this.config.maxScrolls = parseInt(document.getElementById('xhs-max-scrolls')?.value) || 15;
      this.config.scrollInterval = parseFloat(document.getElementById('xhs-scroll-interval')?.value) * 1000 || 3000;
      if (this.config.delayMin > this.config.delayMax) this.config.delayMin = this.config.delayMax;
    },

    exportData() {
      if (this.collected.length === 0) { alert('暂无采集数据'); return; }
      const json = JSON.stringify(this.collected, null, 2);
      const blob = new Blob([json], {type:'application/json'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `小红书采集_${new Date().toISOString().slice(0,10)}_${this.collected.length}条.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.log(`📥 已导出 ${this.collected.length} 条数据`, 'success');
    },

    copyToClipboard() {
      if (this.collected.length === 0) { alert('暂无采集数据'); return; }
      navigator.clipboard.writeText(JSON.stringify(this.collected, null, 2))
        .then(() => this.log('📋 已复制到剪贴板', 'success'))
        .catch(() => alert('复制失败，请使用导出功能'));
    },

    /* ===== UI ===== */
    updateTotal(n)    { const el = document.getElementById('xhs-stat-total'); if(el) el.textContent = n; },
    updateCollected(n){ const el = document.getElementById('xhs-stat-collected'); if(el) el.textContent = n; },
    updateErrors()    { const el = document.getElementById('xhs-stat-errors'); if(el) el.textContent = this.errorCount; },
    updateProgress()  {
      const total = parseInt(document.getElementById('xhs-stat-total')?.textContent) || 1;
      const pct = Math.min(100, Math.round((this.currentIndex / total) * 100));
      const bar = document.getElementById('xhs-progress-bar');
      if(bar) bar.style.width = pct + '%';
    },
    updateCurrentNote(t){ const el = document.getElementById('xhs-current-note'); if(el) el.textContent = t; },
    updateUI() {
      const dot = document.getElementById('xhs-status-dot');
      const txt = document.getElementById('xhs-status-text');
      if(dot) dot.className = 'xhs-status-dot ' + this.state;
      if(txt) {
        const map = {
          running: '🟢 运行中 - 正在采集...',
          paused:  '🟡 已暂停 - 点击继续',
          stopped: this.collected.length ? `🔴 已停止 - 共采集${this.collected.length}条` : '🟢 就绪 - 点击「开始采集」'
        };
        txt.textContent = map[this.state] || '';
      }
    },
    log(msg, type='info') {
      const area = document.getElementById('xhs-log-area');
      if(!area) return;
      const div = document.createElement('div');
      div.className = 'log-' + type;
      div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      area.appendChild(div);
      area.scrollTop = area.scrollHeight;
      while(area.children.length > 80) area.removeChild(area.firstChild);
      console.log(`[XHS] ${msg}`);
    },
  };

  // ==================== 4. 绑定事件 ====================
  document.getElementById('xhs-btn-start').addEventListener('click', () => {
    XHSScraper.readConfig();
    XHSScraper.currentIndex = XHSScraper.collected.length; // 支持断点续采
    XHSScraper.scrollCount = 0;
    XHSScraper.errorCount = 0;
    XHSScraper.updateErrors();
    XHSScraper.updateProgress();
    XHSScraper.run();
  });

  document.getElementById('xhs-btn-pause').addEventListener('click', () => {
    XHSScraper.state === 'running' ? XHSScraper.pause() : XHSScraper.resume();
  });

  document.getElementById('xhs-btn-stop').addEventListener('click', () => XHSScraper.stop());
  document.getElementById('xhs-btn-export').addEventListener('click', () => XHSScraper.exportData());
  document.getElementById('xhs-btn-copy').addEventListener('click', () => XHSScraper.copyToClipboard());

  // 最小化
  const btnMin = document.getElementById('xhs-btn-min');
  btnMin.addEventListener('click', () => {
    const panel = document.getElementById('xhs-scraper-panel');
    panel.classList.toggle('minimized');
    btnMin.textContent = panel.classList.contains('minimized') ? '+' : '−';
  });

  // 关闭面板
  document.getElementById('xhs-btn-close-panel').addEventListener('click', () => {
    if (XHSScraper.state === 'running' && !confirm('采集正在进行中，确定关闭面板？')) return;
    XHSScraper.stop();
    document.getElementById('xhs-scraper-panel')?.remove();
    document.getElementById('xhs-scraper-style')?.remove();
    console.log('🧹 采集面板已移除');
  });

  // 拖拽
  (function() {
    const panel = document.getElementById('xhs-scraper-panel');
    const header = document.getElementById('xhs-panel-header');
    let dragging = false, sx, sy, px, py;
    header.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect();
      px = r.left; py = r.top;
      panel.style.transition = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if(!dragging) return;
      panel.style.right = 'auto';
      panel.style.left = (px + e.clientX - sx) + 'px';
      panel.style.top = Math.max(0, py + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if(dragging) { dragging = false; panel.style.transition = 'transform 0.3s ease, opacity 0.3s ease'; }
    });
  })();

  // 键盘快捷键
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (XHSScraper.state === 'running') XHSScraper.pause();
      else if (XHSScraper.state === 'paused') XHSScraper.resume();
      else { XHSScraper.readConfig(); XHSScraper.run(); }
    }
    if (e.code === 'Escape') { XHSScraper.stop(); }
    if (e.ctrlKey && e.code === 'KeyE') { e.preventDefault(); XHSScraper.exportData(); }
  });

  // 初始化日志
  const initialCount = document.querySelectorAll('section.note-item').length;
  XHSScraper.updateTotal(initialCount);
  XHSScraper.log(`🔧 面板初始化完成，检测到 ${initialCount} 条笔记`, 'info');
  XHSScraper.log(`💡 提示：Space开始/暂停 | Esc停止 | Ctrl+E导出`, 'info');
  XHSScraper.log(`🛡 已启用反爬策略：随机延迟、鼠标模拟、批量休息`, 'info');

  // 暴露全局
  window.__xhsScraper = XHSScraper;
  console.log('✅ 小红书采集器 Pro 已就绪 | 笔记数:', initialCount);

})();