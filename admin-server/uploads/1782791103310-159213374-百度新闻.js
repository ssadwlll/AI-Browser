// 自动生成的「百度新闻——海量中文资讯平台」页面采集脚本
// 目标: https://news.baidu.com
// 生成时间: 2026-06-30T03:44:19.148Z

;(function() {
  try {
    const items = document.querySelectorAll('menu-list')
    const data = []

    for (let i = 0; i < items.length; i++) {
      const el = items[i]
      const link = el.querySelector('a')
      const img = el.querySelector('img')
      const text = el.textContent.trim().slice(0, 200)

      data.push({
        title: (link ? link.textContent.trim() : text).slice(0, 100),
        url: link ? (link.href || '') : '',
        image: img ? (img.src || img.getAttribute('data-src') || '') : '',
        text: text,
      })

      if (data.length >= 50) break
    }

    return {
      ok: true,
      data: data,
      count: data.length,
      hint: data.length > 0
        ? '已采集到 ' + data.length + ' 条百度新闻数据，可直接使用或通过 finish_task 输出'
        : '未采集到新闻数据，可能选择器 menu-list 已失效。可用 detect_page_template 重新检测页面结构',
      fields: ['title', 'url', 'image', 'text']
    }
  } catch (e) {
    return { ok: false, error: e.message, hint: '可用 detect_page_template 检测页面结构' }
  }
})()