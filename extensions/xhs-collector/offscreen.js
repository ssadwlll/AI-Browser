// offscreen.js - 离屏文档保活
// 离屏文档不受窗口最小化/标签页冻结影响，定时器正常运行
// 通过 chrome.runtime.connect 保持 SW 活跃

var keepAlivePort = null;
var pingTimer = null;
var stopped = false;

function connect() {
  if (stopped) return;
  try {
    keepAlivePort = chrome.runtime.connect({ name: 'offscreen-keepalive' });

    keepAlivePort.onDisconnect.addListener(function () {
      keepAlivePort = null;
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (stopped) return;
      // SW 重启导致断开，1 秒后重连
      setTimeout(function () {
        if (stopped) return;
        // 检查是否还需要保活（SW 可能已停止采集）
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_CHECK_ALIVE' }).then(function (resp) {
          if (resp && resp.alive === false) {
            stopped = true;
          } else {
            connect();
          }
        }).catch(function () {
          // SW 不可达，尝试重连
          connect();
        });
      }, 1000);
    });

    // 每 20 秒发送 ping，保持端口活跃
    // 离屏文档的定时器不受窗口最小化影响
    pingTimer = setInterval(function () {
      if (keepAlivePort && !stopped) {
        try {
          keepAlivePort.postMessage({ type: 'PING', time: Date.now(), source: 'offscreen' });
        } catch (e) {
          if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        }
      }
    }, 20000);

    // 立即发送第一个 ping
    try {
      keepAlivePort.postMessage({ type: 'PING', time: Date.now(), source: 'offscreen' });
    } catch (e) {}
  } catch (e) {
    if (!stopped) setTimeout(connect, 2000);
  }
}

connect();
