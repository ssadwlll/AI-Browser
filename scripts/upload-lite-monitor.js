// 上传 Lite 套餐监控脚本到管理后台
// 用法: node upload-lite-monitor.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const USERNAME = 'admin';
const PASSWORD = 'admin123';
const SCRIPT_FILE = path.join(__dirname, 'lite-monitor.js');

// Step 1: 登录获取 token
function login() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: USERNAME, password: PASSWORD });
    const req = http.request({
      hostname: 'localhost', port: PORT, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.data?.token);
        } catch { reject('登录失败: ' + data); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Step 2: 上传脚本文件
function upload(token) {
  return new Promise((resolve, reject) => {
    const fileContent = fs.readFileSync(SCRIPT_FILE, 'utf-8');
    const boundary = '----FormBoundary' + Date.now();

    const parts = [];
    const addField = (name, value) => {
      parts.push(`--${boundary}\r\n`);
      parts.push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
      parts.push(`${value}\r\n`);
    };
    const addFile = (fieldName, filename, content) => {
      parts.push(`--${boundary}\r\n`);
      parts.push(`Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n`);
      parts.push(`Content-Type: application/javascript\r\n\r\n`);
      parts.push(`${content}\r\n`);
    };

    addField('name', 'Lite套餐补货监控');
    addField('category_id', '2');  // 2 = 自动化操作
    addField('description', '定时监控Lite套餐购买按钮状态，补货时自动通知。每30秒检查一次，最长运行6小时。支持AI回调通知。');
    addField('tool_type', 'js');
    addFile('script', 'lite-monitor.js', fileContent);
    parts.push(`--${boundary}--\r\n`);

    const bodyBuffer = Buffer.from(parts.join(''), 'utf-8');

    const req = http.request({
      hostname: 'localhost', port: PORT, path: '/api/scripts', method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuffer.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.success) {
            console.log('✅ 上传成功!');
            console.log('   脚本ID:', parsed.data.id);
            console.log('   脚本名:', parsed.data.name);
          } else {
            console.log('❌ 上传失败:', parsed.error || parsed.message || data);
          }
          resolve();
        } catch { reject('解析响应失败: ' + data); }
      });
    });
    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}

// 执行
(async () => {
  try {
    console.log('📤 正在上传 Lite 套餐监控脚本...');
    console.log('   文件:', SCRIPT_FILE);
    console.log('   服务器: http://localhost:' + PORT);
    console.log('');
    const token = await login();
    if (!token) {
      console.error('❌ 获取 token 失败，请检查用户名密码');
      return;
    }
    console.log('🔑 登录成功');
    await upload(token);
  } catch (e) {
    console.error('❌ 错误:', e.message || e);
  }
})();
