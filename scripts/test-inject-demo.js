// @name: 页面注入测试
// @description: 在页面上显示一个提示框，验证JS注入是否成功
// @version: 1.0.1
// @urlPattern: *

(function() {
  'use strict';

  // 支持多次注入，记录注入次数
  if (!window.__testInjectCount) window.__testInjectCount = 0;
  window.__testInjectCount++;
  var count = window.__testInjectCount;

  // 在页面右下角显示一个彩色提示
  var toast = document.createElement('div');
  toast.style.cssText = '\
    position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;\
    background: linear-gradient(135deg, #b059f8, #6841ea);\
    color: #fff; padding: 12px 20px; border-radius: 12px;\
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;\
    font-size: 14px; font-weight: 600;\
    box-shadow: 0 4px 20px rgba(104,65,234,0.4);\
    animation: testInjectIn 0.4s ease;\
  ';
  toast.textContent = '✅ 脚本注入成功！(第' + count + '次)';

  // 添加动画（仅首次）
  if (count === 1) {
    var style = document.createElement('style');
    style.textContent = '\
      @keyframes testInjectIn {\
        from { opacity: 0; transform: translateY(20px) scale(0.9); }\
        to { opacity: 1; transform: translateY(0) scale(1); }\
      }\
    ';
    document.head.appendChild(style);
  }

  document.body.appendChild(toast);

  // 3秒后自动消失
  setTimeout(function() {
    toast.style.transition = 'opacity 0.5s, transform 0.5s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
    setTimeout(function() { toast.remove(); }, 500);
  }, 3000);

  // 输出当前页面基本信息
  console.log('✅ [测试脚本] 第' + count + '次注入');
  console.log('   页面标题:', document.title);
  console.log('   页面URL:', location.href);
})();
