// 验证 user/me 和 homefeed 的正确签名格式
// 同时测试多种签名输入格式，找出哪个能通过
async function verifySignFormats() {
  const result = { tests: [] }

  // 创建 iframe 获取原始 fetch
  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  iframe.src = 'about:blank'
  document.body.appendChild(iframe)
  await new Promise(r => setTimeout(r, 100))
  const rawFetch = iframe.contentWindow.fetch.bind(iframe.contentWindow)

  // ===== user/me: 测试不同签名输入 =====
  const userUrl = 'https://edith.xiaohongshu.com/api/sns/web/v1/user/me'
  const userSignInputs = [
    { name: 'A: {url, method:GET}', input: { url: '/api/sns/web/v1/user/me', method: 'GET' } },
    { name: 'B: {url} 无method', input: { url: '/api/sns/web/v1/user/me' } },
    { name: 'C: 纯url字符串', input: '/api/sns/web/v1/user/me' },
    { name: 'D: {url, method, data:{}}', input: { url: '/api/sns/web/v1/user/me', method: 'GET', data: {} } },
    { name: 'E: 完整URL', input: { url: userUrl, method: 'GET' } },
    { name: 'F: {url, method, data:null}', input: { url: '/api/sns/web/v1/user/me', method: 'GET', data: null } },
  ]

  for (const t of userSignInputs) {
    try {
      const sign = window._webmsxyw(JSON.stringify(t.input))
      const resp = await rawFetch(userUrl, {
        headers: {
          'X-s': sign['X-s'],
          'X-t': String(sign['X-t']),
          'Origin': 'https://www.xiaohongshu.com',
          'Referer': 'https://www.xiaohongshu.com/',
        },
        credentials: 'include',
      })
      const data = await resp.json().catch(() => ({}))
      result.tests.push({
        interface: 'user/me',
        name: t.name,
        httpStatus: resp.status,
        apiCode: data.code,
        msg: data.msg,
      })
    } catch (e) { result.tests.push({ interface: 'user/me', name: t.name, error: e.message }) }
  }

  // ===== homefeed: 测试不同签名输入 =====
  const homefeedUrl = 'https://edith.xiaohongshu.com/api/sns/web/v1/homefeed'
  const homefeedBody = { cursor_score: '', num: 5, refresh_type: 1, note_index: 0, category: 'homefeed_recommend' }
  const homefeedSignInputs = [
    { name: 'A: {url, method, data}', input: { url: '/api/sns/web/v1/homefeed', method: 'POST', data: homefeedBody } },
    { name: 'B: {url, method, data:bodyStr}', input: { url: '/api/sns/web/v1/homefeed', method: 'POST', data: JSON.stringify(homefeedBody) } },
    { name: 'C: {url, data}', input: { url: '/api/sns/web/v1/homefeed', data: homefeedBody } },
    { name: 'D: 纯url', input: '/api/sns/web/v1/homefeed' },
    { name: 'E: {url, method, data, headers}', input: { url: '/api/sns/web/v1/homefeed', method: 'POST', data: homefeedBody, headers: { 'Content-Type': 'application/json;charset=UTF-8' } } },
  ]

  for (const t of homefeedSignInputs) {
    try {
      const sign = window._webmsxyw(JSON.stringify(t.input))
      const resp = await rawFetch(homefeedUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'X-s': sign['X-s'],
          'X-t': String(sign['X-t']),
          'Origin': 'https://www.xiaohongshu.com',
          'Referer': 'https://www.xiaohongshu.com/',
        },
        body: JSON.stringify(homefeedBody),
        credentials: 'include',
      })
      const data = await resp.json().catch(() => ({}))
      result.tests.push({
        interface: 'homefeed',
        name: t.name,
        httpStatus: resp.status,
        apiCode: data.code,
        msg: data.msg,
        itemsCount: data.data?.items?.length,
      })
    } catch (e) { result.tests.push({ interface: 'homefeed', name: t.name, error: e.message }) }
  }

  // ===== 再测一次 search/notes 确认绕过稳定 =====
  try {
    const sign = window._webmsxyw(JSON.stringify({
      url: '/api/sns/web/v1/search/notes',
      method: 'POST',
      data: { keyword: '美食', page: 1, page_size: 20, sort: 'general', note_type: 0, search_id: crypto.randomUUID(), session_id: '' },
    }))
    const resp = await rawFetch('https://edith.xiaohongshu.com/api/sns/web/v1/search/notes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'X-s': sign['X-s'],
        'X-t': String(sign['X-t']),
        'Origin': 'https://www.xiaohongshu.com',
        'Referer': 'https://www.xiaohongshu.com/',
      },
      body: JSON.stringify({ keyword: '美食', page: 1, page_size: 20, sort: 'general', note_type: 0, search_id: crypto.randomUUID(), session_id: '' }),
      credentials: 'include',
    })
    const data = await resp.json().catch(() => ({}))
    result.tests.push({
      interface: 'search/notes',
      name: '确认绕过稳定性',
      httpStatus: resp.status,
      apiCode: data.code,
      msg: data.msg,
      itemsCount: data.data?.items?.length,
    })
  } catch (e) { result.tests.push({ interface: 'search/notes', name: '确认', error: e.message }) }

  // 清理
  setTimeout(() => { try { document.body.removeChild(iframe) } catch {} }, 1000)
  return JSON.stringify(result, null, 2)
}

verifySignFormats().then(r => console.log(r))
