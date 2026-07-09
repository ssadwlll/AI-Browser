/**
 * 小红书 API 客户端服务
 * 
 * 实现"方案 A：Headless 浏览器"的核心逻辑：
 * 1. 通过 XhsSignService 在页面上下文中生成签名（调用 window.mnsv2）
 * 2. 从 BrowserView session 提取 cookies
 * 3. 在 Node.js 主进程中直接调用小红书 API（绕过 ACE 行为检测）
 * 
 * 优势：
 * - 比 DOM 采集快 10 倍以上（直接 API 调用，无需滚动/点击）
 * - 返回完整结构化 JSON 数据
 * - 不触发 ACE 行为检测（API 调用在 Node.js 中，不在页面内）
 * - 不触发 API 风控（有合法签名）
 */

const https = require('https')
const signService = require('./xhs_sign_service')

const API_HOST = 'edith.xiaohongshu.com'
const API_BASE = '/api/sns/web/v1'

class XhsApiService {
  /**
   * 发起带签名的 API 请求
   * @param {BrowserView} browserView
   * @param {string} method - GET | POST
   * @param {string} apiPath - API路径，如 /api/sns/web/v1/search/notes
   * @param {object} body - 请求体
   * @param {object} opts - 额外选项 { host: 自定义API host }
   */
  async _request(browserView, method, apiPath, body, opts) {
    opts = opts || {}
    // 1. 生成签名
    const signResult = await signService.generateSign(browserView, apiPath, body)
    if (!signResult.ok) {
      return { ok: false, error: signResult.error }
    }

    // 2. 获取 cookies 和 UA
    const cookie = await signService.getCookies(browserView)
    const userAgent = await signService.getUserAgent(browserView)

    // 3. 构建请求
    const bodyStr = body ? JSON.stringify(body) : ''
    const fullPath = method === 'GET' && body
      ? apiPath + '?' + new URLSearchParams(body).toString()
      : apiPath

    const headers = {
      'User-Agent': userAgent,
      'Cookie': cookie,
      'Origin': 'https://www.xiaohongshu.com',
      'Referer': 'https://www.xiaohongshu.com/',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Content-Type': 'application/json;charset=UTF-8',
      'X-s': signResult.sign['X-s'],
      'X-t': signResult.sign['X-t'],
      'xsecappid': 'xhs-pc-web',
    }

    // 添加 x-s-common（如果签名服务生成了）
    if (signResult.sign['X-s-common']) {
      headers['X-s-common'] = signResult.sign['X-s-common']
    }

    // 4. 发送请求
    return new Promise((resolve) => {
      const options = {
        hostname: opts.host || API_HOST,
        port: 443,
        path: fullPath,
        method: method,
        headers: headers,
      }

      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            resolve({ ok: true, data: json, statusCode: res.statusCode })
          } catch (e) {
            resolve({ ok: false, error: '响应解析失败: ' + e.message, raw: data.substring(0, 500) })
          }
        })
      })

      req.on('error', (e) => {
        resolve({ ok: false, error: '请求失败: ' + e.message })
      })

      req.on('timeout', () => {
        req.destroy()
        resolve({ ok: false, error: '请求超时' })
      })

      req.setTimeout(15000)

      if (method === 'POST' && bodyStr) {
        req.write(bodyStr)
      }
      req.end()
    })
  }

  /**
   * 检查环境是否就绪
   */
  async checkEnvironment(browserView) {
    return signService.checkEnvironment(browserView)
  }

  /**
   * 生成随机 search_id（格式: 随机字母数字+数字串）
   */
  _genSearchId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let id = ''
    for (let i = 0; i < 20; i++) {
      id += chars[Math.floor(Math.random() * chars.length)]
    }
    return id
  }

  /**
   * 生成随机 session_id（UUID v4 格式）
   */
  _genSessionId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0
      const v = c === 'x' ? r : (r & 0x3 | 0x8)
      return v.toString(16)
    })
  }

  /**
   * 搜索笔记
   * API: POST /api/sns/web/v1/search/notes
   */
  async searchNotes(browserView, keyword, page = 1, pageSize = 20, sort = 'general') {
    const apiPath = API_BASE + '/search/notes'
    const body = {
      keyword: keyword,
      page: page,
      page_size: pageSize,
      search_id: this._genSearchId(),
      sort: sort,
      note_type: 0,
      ext_flags: [],
      geo: '',
      image_formats: ['jpg', 'webp', 'avif'],
      session_id: this._genSessionId(),
    }

    const result = await this._request(browserView, 'POST', apiPath, body)

    if (!result.ok) return result

    if (result.data.code !== 0 && result.data.success !== true) {
      // 常见错误码
      const errorMsg = this._formatApiError(result.data)
      return { ok: false, error: errorMsg, code: result.data.code }
    }

    const items = (result.data.data && result.data.data.items) || []
    const notes = items.map(item => this._normalizeSearchNote(item))

    return {
      ok: true,
      data: notes,
      count: notes.length,
      hasMore: result.data.data && result.data.data.has_more,
      hint: 'API 搜索 "' + keyword + '" 返回 ' + notes.length + ' 条结果（第' + page + '页）',
    }
  }

  /**
   * 获取笔记详情（Feed 接口）
   * API: POST /api/sns/web/v1/feed
   */
  async getNoteDetail(browserView, noteId) {
    const apiPath = API_BASE + '/feed'
    const body = {
      source_note_id: noteId,
      image_formats: ['jpg', 'webp', 'avif'],
      extra: { need_body_topic: '1' },
    }

    const result = await this._request(browserView, 'POST', apiPath, body)

    if (!result.ok) return result

    if (result.data.code !== 0 && result.data.success !== true) {
      return { ok: false, error: this._formatApiError(result.data), code: result.data.code }
    }

    const item = result.data.data && result.data.data.items && result.data.data.items[0]
    if (!item) {
      return { ok: false, error: '未找到笔记数据' }
    }

    const note = this._normalizeNoteDetail(item.note_card, noteId)

    return {
      ok: true,
      data: [note],
      count: 1,
      hint: 'API 获取笔记详情: ' + (note.title || note.desc.slice(0, 30) || noteId),
    }
  }

  /**
   * 批量获取笔记详情
   * API: POST /api/sns/web/v1/feed (一次最多 20 个)
   */
  async batchGetNoteDetail(browserView, noteIds) {
    const apiPath = API_BASE + '/feed'
    const body = {
      source_note_ids: noteIds.slice(0, 20),
    }

    const result = await this._request(browserView, 'POST', apiPath, body)

    if (!result.ok) return result

    if (result.data.code !== 0 && result.data.success !== true) {
      return { ok: false, error: this._formatApiError(result.data), code: result.data.code }
    }

    const items = (result.data.data && result.data.data.items) || []
    const notes = items.map(item => this._normalizeNoteDetail(item.note_card, item.id))

    return {
      ok: true,
      data: notes,
      count: notes.length,
      hint: 'API 批量获取 ' + notes.length + ' 条笔记详情',
    }
  }

  /**
   * 获取笔记评论
   * API: GET /api/sns/web/v2/comment/list
   */
  async getComments(browserView, noteId, cursor = '', topCommentId = '') {
    const apiPath = API_BASE + '/comment/list'
    const params = {
      note_id: noteId,
      cursor: cursor,
      top_comment_id: topCommentId,
      image_formats: 'jpg,webp,avif',
      xsec_token: '',
      xsec_source: 'pc_feed',
    }

    const result = await this._request(browserView, 'GET', apiPath, params)

    if (!result.ok) return result

    if (result.data.code !== 0 && result.data.success !== true) {
      return { ok: false, error: this._formatApiError(result.data), code: result.data.code }
    }

    const rawComments = (result.data.data && result.data.data.comments) || []
    const comments = rawComments.map(c => this._normalizeComment(c))

    return {
      ok: true,
      data: comments,
      count: comments.length,
      hasMore: result.data.data && result.data.data.has_more,
      cursor: result.data.data && result.data.data.cursor,
      hint: 'API 获取 ' + comments.length + ' 条评论',
    }
  }

  /**
   * 获取用户主页信息
   * API: GET /api/sns/web/v1/user/otherinfo
   */
  async getUserProfile(browserView, userId) {
    const apiPath = API_BASE + '/user/otherinfo'
    const params = {
      target_user_id: userId,
    }

    const result = await this._request(browserView, 'GET', apiPath, params)

    if (!result.ok) return result

    if (result.data.code !== 0 && result.data.success !== true) {
      return { ok: false, error: this._formatApiError(result.data), code: result.data.code }
    }

    const info = result.data.data && result.data.data.basic_info
    const interact = result.data.data && result.data.data.interactions

    const user = {
      userId: userId,
      nickname: (info && info.nickname) || '',
      redId: (info && info.redid) || '',
      desc: (info && info.desc) || '',
      gender: (info && info.gender === 1) ? '男' : (info && info.gender === 2) ? '女' : '未知',
      ipLocation: (result.data.data && result.data.data.ip_location) || '',
      avatar: (info && info.imageb) || (info && info.image) || '',
      fans: (interact && interact[0] && interact[0].count) || 0,
      follows: (interact && interact[1] && interact[1].count) || 0,
      interaction: (interact && interact[2] && interact[2].count) || 0,
    }

    return {
      ok: true,
      data: [user],
      count: 1,
      hint: 'API 获取用户信息: ' + user.nickname,
    }
  }

  /**
   * 获取用户发布的笔记
   * API: GET /api/sns/web/v1/user_posted
   */
  async getUserNotes(browserView, userId, cursor = '') {
    const apiPath = API_BASE + '/user_posted'
    const params = {
      user_id: userId,
      cursor: cursor,
      num: 30,
      image_formats: 'jpg,webp,avif',
      xsec_token: '',
      xsec_source: 'pc_feed',
    }

    const result = await this._request(browserView, 'GET', apiPath, params)

    if (!result.ok) return result

    if (result.data.code !== 0 && result.data.success !== true) {
      return { ok: false, error: this._formatApiError(result.data), code: result.data.code }
    }

    const notes = (result.data.data && result.data.data.notes) || []
    const normalized = notes.map(n => ({
      noteId: n.note_id,
      title: n.display_title || '',
      type: n.type,
      cover: (n.cover && n.cover.url) || '',
      xsecToken: n.xsec_token || '',
      likedCount: (n.interact_info && n.interact_info.liked_count) || '0',
    }))

    return {
      ok: true,
      data: normalized,
      count: normalized.length,
      hasMore: result.data.data && result.data.data.has_more,
      cursor: result.data.data && result.data.data.cursor,
      hint: 'API 获取用户笔记: ' + normalized.length + ' 条',
    }
  }

  // ========== 数据标准化方法 ==========

  _normalizeSearchNote(item) {
    const note = item.note_card || item
    return {
      noteId: item.id || note.note_id,
      title: note.display_title || '',
      type: note.type || '',
      cover: (note.cover && (note.cover.url || note.cover.url_default)) || '',
      user: {
        userId: (note.user && note.user.user_id) || '',
        nickname: (note.user && note.user.nickname) || '',
        avatar: (note.user && note.user.avatar) || '',
      },
      likedCount: (note.interact_info && note.interact_info.liked_count) || '0',
      xsecToken: note.xsec_token || '',
      scrapedAt: new Date().toISOString(),
    }
  }

  _normalizeNoteDetail(note, noteId) {
    if (!note) return { noteId }

    return {
      noteId: noteId,
      title: note.title || '',
      desc: note.desc || '',
      type: note.type || '',
      wordNum: note.word_num || 0,

      user: {
        userId: (note.user && note.user.user_id) || '',
        nickname: (note.user && note.user.nickname) || '',
        avatar: (note.user && note.user.avatar) || '',
      },

      interactInfo: {
        likedCount: (note.interact_info && note.interact_info.liked_count) || '0',
        collectedCount: (note.interact_info && note.interact_info.collected_count) || '0',
        commentCount: (note.interact_info && note.interact_info.comment_count) || '0',
        shareCount: (note.interact_info && note.interact_info.share_count) || '0',
      },

      imageList: (note.image_list || []).map(img => ({
        url: img.url_default || img.url || '',
        width: img.width || 0,
        height: img.height || 0,
      })),

      video: note.video ? {
        url: (note.video.media && note.video.media.stream && note.video.media.stream.h264 && note.video.media.stream.h264[0] && note.video.media.stream.h264[0].master_url) || '',
        firstFrame: note.video.first_frame_fileid || '',
        duration: (note.video.cap && note.video.cap.duration) || 0,
      } : null,

      tagList: (note.tag_list || []).map(tag => ({
        id: tag.id || '',
        name: tag.name || '',
        type: tag.type || '',
      })),

      time: note.time || '',
      ipLocation: note.ip_location || '',
      lastUpdateTime: note.last_update_time || '',

      pageUrl: 'https://www.xiaohongshu.com/explore/' + noteId,
      scrapedAt: new Date().toISOString(),
      _source: 'api',
    }
  }

  _normalizeComment(c) {
    return {
      id: c.id || '',
      content: c.content || '',
      time: c.create_time ? new Date(c.create_time).toISOString() : '',
      likeCount: (c.like_count !== undefined) ? String(c.like_count) : '0',
      user: {
        userId: (c.user_info && c.user_info.user_id) || '',
        nickname: (c.user_info && c.user_info.nickname) || '',
        avatar: (c.user_info && c.user_info.image) || '',
      },
      ipLocation: c.ip_location || '',
      subComments: (c.sub_comments || []).map(sub => ({
        id: sub.id || '',
        content: sub.content || '',
        likeCount: String(sub.like_count || 0),
        user: {
          userId: (sub.user_info && sub.user_info.user_id) || '',
          nickname: (sub.user_info && sub.user_info.nickname) || '',
        },
      })),
    }
  }

  _formatApiError(data) {
    const code = data.code
    const msg = data.msg || data.message || '未知错误'

    const knownErrors = {
      300011: '账号异常（频繁调用触发风控），请稍后重试',
      300012: '签名验证失败，请刷新页面后重试',
      300013: '请求过于频繁，请稍后重试',
      300014: '参数错误',
      '-1': '系统繁忙，请稍后重试',
      '-100': '未登录，请先在小红书页面登录',
      '-101': '未登录或 Cookie 过期',
      461: '请求被拒绝（可能是 a1 标记或 IP 风控）',
    }

    return knownErrors[code] || ('API错误[' + code + ']: ' + msg)
  }
}

module.exports = new XhsApiService()
