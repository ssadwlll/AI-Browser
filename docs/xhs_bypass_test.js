// 逆向分析脚本：绕过小红书 ACE 拦截器直接调用 API
// 原理：拦截器只替换了当前 window 的 fetch/XHR，iframe（about:blank）里的 fetch 是原始的
// 步骤：1. 创建 about:blank iframe 2. 用 iframe 的 fetch 发请求 3. 手动加 _webmsxyw 生成的签名

async function bypassInterceptorAndCall() {
  const result = { steps: [] }

  // ===== Step 1: 检测 Electron 指纹问题 =====
  result.steps.push({
    step: 1,
    name: 'Electron 指纹检测',
    fingerprints: {
      webdriver: navigator.webdriver,
      hasChrome: typeof window.chrome !== 'undefined',
      chromeKeys: typeof window.chrome !== 'undefined' ? Object.keys(window.chrome) : null,
      pluginsLength: navigator.plugins?.length,
      languages: navigator.languages,
      // Electron 特征
      hasElectronInProcess: typeof process !== 'undefined' && process.versions?.electron,
      outerHeight: window.outerHeight,
      outerWidth: window.outerWidth,
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
    },
  })

  // ===== Step 2: 创建 about:blank iframe 获取原始 fetch =====
  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  iframe.src = 'about:blank'
  document.body.appendChild(iframe)

  // 等待 iframe 加载
  await new Promise(r => setTimeout(r, 100))

  const rawFetch = iframe.contentWindow.fetch.bind(iframe.contentWindow)
  const rawXHR = iframe.contentWindow.XMLHttpRequest
  result.steps.push({
    step: 2,
    name: '获取原始 fetch',
    rawFetchIsNative: rawFetch.toString().includes('[native code]'),
    mainFetchIsNative: window.fetch.toString().includes('[native code]'),
    // 确认主 window 的 fetch 已被替换
    mainFetchModified: !window.fetch.toString().includes('[native code]'),
  })

  // ===== Step 3: 用原始 fetch + _webmsxyw 签名调用接口 =====
  const testCases = [
    {
      name: 'user/me（GET，无需 body）',
      url: 'https://edith.xiaohongshu.com/api/sns/web/v1/user/me',
      method: 'GET',
      signInput: { url: '/api/sns/web/v1/user/me', method: 'GET' },
      body: null,
    },
    {
      name: 'homefeed（POST，推荐流）',
      url: 'https://edith.xiaohongshu.com/api/sns/web/v1/homefeed',
      method: 'POST',
      signInput: {
        url: '/api/sns/web/v1/homefeed',
        method: 'POST',
        data: { cursor_score: '', num: 5, refresh_type: 1, note_index: 0, category: 'homefeed_recommend' },
      },
      body: { cursor_score: '', num: 5, refresh_type: 1, note_index: 0, category: 'homefeed_recommend' },
    },
    {
      name: 'search/notes（搜索接口）',
      url: 'https://edith.xiaohongshu.com/api/sns/web/v1/search/notes',
      method: 'POST',
      signInput: {
        url: '/api/sns/web/v1/search/notes',
        method: 'POST',
        data: { keyword: '美食', page: 1, page_size: 20, sort: 'general', note_type: 0, search_id: '00000000-0000-0000-0000-000000000000', session_id: '' },
      },
      body: { keyword: '美食', page: 1, page_size: 20, sort: 'general', note_type: 0, search_id: '00000000-0000-0000-0000-000000000000', session_id: '' },
    },
  ]

  for (const tc of testCases) {
    try {
      // 生成签名
      const sign = window._webmsxyw(JSON.stringify(tc.signInput))

      // 构造 headers
      const headers = {
        'X-s': sign['X-s'],
        'X-t': String(sign['X-t']),
        'Origin': 'https://www.xiaohongshu.com',
        'Referer': 'https://www.xiaohongshu.com/',
      }
      if (tc.method === 'POST') {
        headers['Content-Type'] = 'application/json;charset=UTF-8'
      }

      // 用原始 fetch 调用（带 cookie）
      const opts = {
        method: tc.method,
        headers,
        credentials: 'include',  // 自动带 cookie
      }
      if (tc.body) {
        opts.body = JSON.stringify(tc.body)
      }

      const resp = await rawFetch(tc.url, opts)
      const data = await resp.json().catch(() => ({}))

      result.steps.push({
        step: 3,
        name: tc.name,
        httpStatus: resp.status,
        apiCode: data.code,
        apiSuccess: data.success,
        msg: data.msg || data.message || null,
        itemsCount: data.data?.items?.length || null,
        loggedIn: tc.name.includes('user/me') ? (data.success && !!data.data?.user_id) : null,
      })
    } catch (e) {
      result.steps.push({
        step: 3,
        name: tc.name,
        error: e.message,
      })
    }
  }

  // ===== Step 4: 对比 - 用被拦截的 fetch 调用同一接口 =====
  try {
    const sign = window._webmsxyw(JSON.stringify({
      url: '/api/sns/web/v1/user/me',
      method: 'GET',
    }))
    const resp = await window.fetch('https://edith.xiaohongshu.com/api/sns/web/v1/user/me', {
      headers: { 'X-s': sign['X-s'], 'X-t': String(sign['X-t']) },
      credentials: 'include',
    })
    result.steps.push({
      step: 4,
      name: '对比：用被拦截的 fetch 调 user/me',
      httpStatus: resp.status,
      note: '若此处 406 而 Step 3 成功，说明绕过拦截器有效',
    })
  } catch (e) {
    result.steps.push({ step: 4, name: '对比', error: e.message })
  }

  // 清理 iframe
  setTimeout(() => {
    try { document.body.removeChild(iframe) } catch {}
  }, 1000)

  return JSON.stringify(result, null, 2)
}

bypassInterceptorAndCall().then(r => console.log(r))
