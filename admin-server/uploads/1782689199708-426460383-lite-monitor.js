// @name: Lite套餐补货监控
// @description: 定时监控Lite套餐购买按钮状态，补货时自动通知。每30秒检查一次，最长运行6小时。
// @version: 1.0.0
// @urlPattern: *

// 监控面板显示脚本 - 监听 Lite 套餐补货状态
// 创建监控面板 UI
const panel = document.createElement('div');
panel.id = 'monitor-panel';
panel.style.cssText =
  'position:fixed;top:20px;right:20px;width:320px;background:#1a1a2e;border:2px solid #9b59b6;border-radius:12px;padding:18px;z-index:999999;font-family:"Segoe UI",Arial,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,0.5);color:#fff;';

panel.innerHTML = `
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;border-bottom:1px solid #333;padding-bottom:10px;">
    <span style="font-size:16px;font-weight:bold;color:#9b59b6;">🤖 抢购监控面板</span>
    <span id="panel-status" style="font-size:12px;background:#e74c3c;color:#fff;padding:2px 8px;border-radius:10px;">监控中</span>
  </div>
  <div style="font-size:13px;line-height:1.8;">
    <div>🔍 状态：⛔ 暂时售罄</div>
    <div>🔄 已检查：<span id="check-count">0</span> 次</div>
    <div>⏰ 已运行：<span id="run-time">0s</span></div>
    <div>📅 下次补货：<span style="color:#f1c40f;font-weight:bold;">06月29日 10:00</span></div>
    <div>⏱️ 检测频率：每 30 秒</div>
  </div>
  <div style="margin-top:12px;padding-top:10px;border-top:1px solid #333;font-size:11px;color:#888;">
    页面请保持打开 🟢
  </div>
`;

document.body.appendChild(panel);

// 监控逻辑
let checkCount = 0;
const startTime = Date.now();
const maxDuration = 6 * 60 * 60 * 1000; // 6小时

function updatePanel(status, isAvailable) {
  const statusEl = document.getElementById('panel-status');
  if (isAvailable) {
    statusEl.textContent = '🎉 可购买！';
    statusEl.style.background = '#2ecc71';
    panel.style.borderColor = '#2ecc71';
    const statusLine = panel.querySelector('div[style*="font-size:13px"] div:first-child');
    if (statusLine) {
      statusLine.innerHTML = '🔍 状态：<span style="color:#2ecc71;font-weight:bold;">🎉 可以购买了！</span>';
    }
  }
}

function checkButton() {
  checkCount++;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  document.getElementById('check-count').textContent = checkCount;
  document.getElementById('run-time').textContent =
    Math.floor(elapsed / 60) + '分' + (elapsed % 60) + '秒';

  // 查找 Lite 套餐的购买按钮
  const btns = document.querySelectorAll('button, a, div[class*="btn"], div[role="button"]');
  for (const btn of btns) {
    const text = btn.textContent.trim();
    if ((text.includes('Lite') || text.includes('lite')) &&
        (text.includes('购买') || text.includes('订阅') || text.includes('立即') || text.includes('抢购'))) {
      // 检查是否可点击（不是售罄状态）
      if (!text.includes('售罄') && !text.includes('sold') &&
          !btn.disabled && btn.offsetParent !== null) {
        updatePanel('', true);
        window.postMessage({
          type: "AI_BROWSER_CALLBACK",
          data: {
            action: "lite_available",
            message: "🎉 Lite套餐已补货！按钮可点击，请立即操作！"
          }
        }, "*");
        clearInterval(interval);
        return;
      }
    }
  }

  // 超时停止
  if (Date.now() - startTime > maxDuration) {
    clearInterval(interval);
    window.postMessage({
      type: "AI_BROWSER_CALLBACK",
      data: {
        action: "timeout",
        message: "⏰ 监控超时（6小时），已自动停止"
      }
    }, "*");
  }
}

const interval = setInterval(checkButton, 30000);
checkButton(); // 立即执行一次
