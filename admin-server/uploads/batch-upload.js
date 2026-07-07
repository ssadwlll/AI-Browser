// 批量上传脚本
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const http = require('http');

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwidXNlcm5hbWUiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTc4MzM4OTgxMCwiZXhwIjoxNzgzOTk0NjEwfQ.9HV6CCyWFSJloL8mEaRkotEgcWQ1ymdtUUurqjVayWw';
const baseUrl = 'http://localhost:3001';
const uploadsDir = path.join(__dirname);

const scripts = [
  { file: 'batch-image-download.js', name: '图片批量下载', cat: 1, desc: '提取页面所有图片，支持按最小分辨率筛选，预览勾选后批量下载为ZIP' },
  { file: 'reading-mode.js', name: '阅读模式', cat: 3, desc: '提取网页正文内容，去除广告和干扰元素，提供纯净阅读体验' },
  { file: 'dark-mode.js', name: '网页暗黑模式', cat: 3, desc: '一键切换网页暗黑模式，智能反转颜色，保护视力' },
  { file: 'element-selector-extract.js', name: '网页元素选择器提取', cat: 1, desc: '点击选择页面元素，自动生成CSS选择器，批量提取数据' },
  { file: 'weibo-hotsearch.js', name: '微博热搜采集', cat: 1, desc: '采集微博热搜榜单，支持一键导出JSON' },
  { file: 'wechat-articles.js', name: '公众号文章列表采集', cat: 1, desc: '采集微信公众号文章列表，支持分页滚动采集' },
  { file: 'table-export.js', name: '表格数据导出', cat: 1, desc: '自动检测页面中的表格，一键导出为CSV或JSON文件' },
  { file: 'full-screenshot.js', name: '网页长截图', cat: 2, desc: '自动滚动截取整个网页，拼合为长图下载' },
  { file: 'bilibili-video-download.js', name: 'B站视频下载助手', cat: 1, desc: '在B站视频页面添加下载面板，支持获取视频下载链接' }
];

async function uploadScript(script) {
  const filePath = path.join(uploadsDir, script.file);
  
  if (!fs.existsSync(filePath)) {
    console.log(`文件不存在: ${filePath}`);
    return null;
  }
  
  console.log(`正在上传: ${script.name}`);
  
  const formData = new FormData();
  formData.append('script', fs.createReadStream(filePath));
  formData.append('name', script.name);
  formData.append('category_id', script.cat.toString());
  formData.append('description', script.desc);
  
  const options = {
    hostname: 'localhost',
    port: 3001,
    path: '/api/scripts',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      ...formData.getHeaders()
    }
  };
  
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.success) {
            console.log(`✓ 成功: ${script.name} (ID: ${json.data.id})`);
            resolve(json.data.id);
          } else {
            console.log(`✗ 失败: ${script.name} - ${json.error}`);
            resolve(null);
          }
        } catch (e) {
          console.log(`✗ 解析异常: ${script.name} - ${e.message}`);
          resolve(null);
        }
      });
    });
    
    req.on('error', (e) => {
      console.log(`✗ 请求异常: ${script.name} - ${e.message}`);
      resolve(null);
    });
    
    formData.pipe(req);
  });
}

async function main() {
  for (const script of scripts) {
    await uploadScript(script);
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('\n批量上传完成！');
}

main();