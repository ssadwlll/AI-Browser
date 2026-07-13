// ============ CaptchaService ============
// 图片点选验证码自动识别：截图 → AI识别 → 模拟点击 → 验证
// 复用聊天窗口选中的模型（通过 callService 传入 modelId）
import { AppError, ERROR_CODES } from '../../shared/utils.js'

export class CaptchaService {
  constructor(aiService, configService) {
    this.aiService = aiService
    this.configService = configService
  }

  /**
   * 自动解决当前页面的验证码
   * @param {number} tabId - 目标标签页 ID
   * @param {object} modelInfo - 侧边栏选中的模型 { modelId, supportsVision }
   * @returns {Promise<{ok, solved, message, detail}>}
   */
  async solveCaptcha(tabId, modelInfo) {
    if (!tabId) throw new Error('未指定目标标签页')
    if (!modelInfo || !modelInfo.supportsVision) {
      return {
        ok: false, solved: false,
        message: '当前模型不支持图片识别，请在聊天窗口切换到视觉模型（如 GPT-4o、Qwen-VL）',
      }
    }

    // Step 1: 在页面中检测验证码并提取信息
    const extractResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: _extractCaptchaInfo,
    })
    const captchaInfo = extractResult?.[0]?.result
    if (!captchaInfo || !captchaInfo.found) {
      return { ok: true, solved: false, message: '页面未检测到验证码' }
    }

    console.log('[CaptchaService] 检测到验证码:', captchaInfo.prompt, '图片数:', captchaInfo.imageCount)

    // Step 2: 截取验证码区域截图
    const tab = await chrome.tabs.get(tabId)
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
    })

    // Step 3: 裁剪验证码区域（通过 content script 用 canvas 裁剪）
    let croppedDataUrl = screenshotDataUrl
    if (captchaInfo.boundingBox) {
      const cropResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: _cropScreenshot,
        args: [screenshotDataUrl, captchaInfo.boundingBox],
      })
      if (cropResult?.[0]?.result) {
        croppedDataUrl = cropResult[0].result
      }
    }

    // Step 4: 调用 AI 识别
    const aiResult = await this._callVisionAI(croppedDataUrl, captchaInfo, modelInfo)
    if (!aiResult.ok) {
      return { ok: false, solved: false, message: 'AI 识别失败: ' + aiResult.error }
    }

    console.log('[CaptchaService] AI 识别结果:', aiResult.indices, '理由:', aiResult.reasoning)

    // Step 5: 模拟点击选中的图片
    const clickResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: _clickCaptchaImages,
      args: [aiResult.indices],
    })
    const clickInfo = clickResult?.[0]?.result
    if (!clickInfo || !clickInfo.ok) {
      return { ok: false, solved: false, message: '点击失败: ' + (clickInfo?.error || '未知') }
    }

    // Step 6: 等待并点击验证按钮
    await new Promise(r => setTimeout(r, 500 + Math.random() * 300))
    const verifyResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: _clickVerifyButton,
    })
    const verifyInfo = verifyResult?.[0]?.result
    if (!verifyInfo || !verifyInfo.ok) {
      return { ok: false, solved: false, message: '验证按钮点击失败: ' + (verifyInfo?.error || '未知') }
    }

    // Step 7: 等待验证结果（检测验证码是否消失）
    await new Promise(r => setTimeout(r, 2000))
    const checkResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: _checkCaptchaGone,
    })
    const gone = checkResult?.[0]?.result
    if (gone && gone.gone) {
      return {
        ok: true, solved: true,
        message: `验证码已通过！选中第 ${aiResult.indices.map(i => i + 1).join('、')} 张图片`,
        detail: { indices: aiResult.indices, reasoning: aiResult.reasoning },
      }
    }

    return {
      ok: true, solved: false,
      message: `已点击第 ${aiResult.indices.map(i => i + 1).join('、')} 张图片并提交验证，但验证码可能未通过（请检查页面）`,
      detail: { indices: aiResult.indices, reasoning: aiResult.reasoning },
    }
  }

  /**
   * 调用视觉 AI 模型识别验证码
   */
  async _callVisionAI(imageDataUrl, captchaInfo, modelInfo) {
    const prompt = this._buildPrompt(captchaInfo)
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    }]

    try {
      const result = await this.aiService.chat(messages, {
        model: modelInfo.modelId,
        temperature: 0.1,
        maxTokens: 500,
      })
      return this._parseAIResponse(result.content, captchaInfo.imageCount)
    } catch (e) {
      console.error('[CaptchaService] AI 调用失败:', e)
      return { ok: false, error: e.message }
    }
  }

  /**
   * 构建 AI prompt
   */
  _buildPrompt(captchaInfo) {
    const count = captchaInfo.requiredCount || 2
    return [
      '这是一个图片点选验证码。',
      `验证要求：请选出最符合描述"${captchaInfo.prompt}"的${count}张图片。`,
      `一共有${captchaInfo.imageCount}张图片，按从左到右、从上到下编号为 0 到 ${captchaInfo.imageCount - 1}。`,
      '',
      '请仔细分析每张图片的内容，判断哪些最符合描述。',
      '返回 JSON 格式（不要加 markdown 代码块）：',
      '{"indices": [编号1, 编号2], "reasoning": "简短理由"}',
      '',
      '注意：',
      '- indices 是图片编号数组（0起始）',
      `- 必须选恰好${count}张`,
      '- 只返回 JSON，不要其他内容',
    ].join('\n')
  }

  /**
   * 解析 AI 返回的 JSON
   */
  _parseAIResponse(content, imageCount) {
    if (!content) return { ok: false, error: 'AI 返回为空' }

    // 尝试提取 JSON（可能被包裹在 markdown 代码块中）
    let jsonStr = content.trim()
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim()

    // 尝试找到 { ... } 部分
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/)
    if (braceMatch) jsonStr = braceMatch[0]

    try {
      const parsed = JSON.parse(jsonStr)
      const indices = parsed.indices || parsed.indexes || parsed.selected || []

      if (!Array.isArray(indices) || indices.length === 0) {
        return { ok: false, error: 'AI 返回格式异常: indices 不是数组' }
      }

      // 校验编号范围
      const valid = indices.filter(i => Number.isInteger(i) && i >= 0 && i < imageCount)
      if (valid.length === 0) {
        return { ok: false, error: 'AI 返回的编号无效' }
      }

      return {
        ok: true,
        indices: valid,
        reasoning: parsed.reasoning || parsed.reason || '',
      }
    } catch (e) {
      // JSON 解析失败，尝试用正则提取数字
      const numMatches = content.match(/\d+/g)
      if (numMatches) {
        const nums = numMatches
          .map(n => parseInt(n, 10))
          .filter(n => n >= 0 && n < imageCount)
        if (nums.length > 0) {
          return { ok: true, indices: nums, reasoning: '正则提取' }
        }
      }
      return { ok: false, error: 'AI 返回解析失败: ' + e.message }
    }
  }
}

// ======================= 页面内执行函数（注入到目标页面） =======================
// 以下函数通过 chrome.scripting.executeScript 注入到目标页面执行
// 参考xhs-collector的人类行为模拟：贝塞尔曲线轨迹+加速度变化+微抖悬停+完整事件链

/**
 * 检测验证码并提取信息
 */
function _extractCaptchaInfo() {
  const captchaDiv = document.querySelector('#captcha-div, .fe-captcha-app, .capptch-modal-content-inner')
  if (!captchaDiv) return { found: false }

  const promptEl = captchaDiv.querySelector('.font-600.tc-3, .tc-3')
  const prompt = promptEl ? promptEl.textContent.trim() : ''

  const descEl = captchaDiv.querySelector('.lh-20.size-14, .tc-61')
  const descText = descEl ? descEl.textContent.trim() : ''
  let requiredCount = 2
  const countMatch = descText.match(/(\d+)张/)
  if (countMatch) requiredCount = parseInt(countMatch[1], 10)

  const imgContainers = captchaDiv.querySelectorAll('.img-container')
  const images = Array.from(imgContainers).map((el, i) => {
    const img = el.querySelector('img')
    const rect = el.getBoundingClientRect()
    return { index: i, src: img ? img.src : '', rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }
  })

  if (images.length === 0) return { found: false }

  const captchaRect = captchaDiv.getBoundingClientRect()
  return {
    found: true, prompt, descText, requiredCount,
    imageCount: images.length,
    images: images.map(img => ({ index: img.index, src: img.src })),
    boundingBox: { left: captchaRect.left, top: captchaRect.top, width: captchaRect.width, height: captchaRect.height },
  }
}

/**
 * 裁剪截图到验证码区域
 */
function _cropScreenshot(dataUrl, bbox) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = function () {
      const canvas = document.createElement('canvas')
      const dpr = window.devicePixelRatio || 1
      const sx = Math.max(0, bbox.left * dpr)
      const sy = Math.max(0, bbox.top * dpr)
      const sw = Math.min(img.width - sx, bbox.width * dpr)
      const sh = Math.min(img.height - sy, bbox.height * dpr)
      canvas.width = sw; canvas.height = sh
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

/**
 * 模拟人类点击选中的验证码图片（深度行为模拟）
 * 参考 xhs-collector 的 humanClick + moveMouseToElement + naturalHover
 */
function _clickCaptchaImages(indices) {
  const captchaDiv = document.querySelector('#captcha-div, .fe-captcha-app, .capptch-modal-content-inner')
  if (!captchaDiv) return { ok: false, error: '验证码容器未找到' }

  const imgContainers = captchaDiv.querySelectorAll('.img-container')
  if (imgContainers.length === 0) return { ok: false, error: '图片容器未找到' }

  // ======================= 人类行为模拟工具函数 =======================

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

  /** 分发单个 mousemove 事件 */
  function dispatchMouseMove(x, y) {
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, view: window,
      clientX: Math.round(x), clientY: Math.round(y),
      screenX: Math.round(x), screenY: Math.round(y + window.screenTop),
    }))
  }

  /** 批量分发鼠标轨迹点（避免每个点单独 sleep，防止页面 setTimeout 阻塞） */
  async function dispatchMousePathBatch(points, batchSize) {
    batchSize = batchSize || 4
    for (var i = 0; i < points.length; i += batchSize) {
      var end = Math.min(i + batchSize, points.length)
      for (var j = i; j < end; j++) {
        dispatchMouseMove(points[j].x, points[j].y)
      }
      if (i + batchSize < points.length) {
        await sleep(10 + Math.random() * 15)
      }
    }
  }

  /**
   * 模拟鼠标从随机起点平滑移动到目标位置
   * 使用3种加速度模式（先快后慢/先慢后快/自然），模拟人类手指滑动物理特性
   */
  async function moveMouseTo(targetX, targetY, steps) {
    var startX = Math.max(0, targetX - 150 - Math.floor(Math.random() * 200))
    var startY = Math.max(0, targetY - 100 - Math.floor(Math.random() * 150))
    steps = steps || (8 + Math.floor(Math.random() * 8))

    var accelMode = Math.floor(Math.random() * 3)
    var points = []
    for (var i = 0; i <= steps; i++) {
      var t = i / steps
      var eased
      if (accelMode === 0) {
        eased = 1 - Math.pow(1 - t, 3)        // 先快后慢（decelerate）
      } else if (accelMode === 1) {
        eased = Math.pow(t, 3)                  // 先慢后快（accelerate）
      } else {
        eased = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2  // 慢-快-慢（自然）
      }
      points.push({
        x: Math.round(startX + (targetX - startX) * eased + (Math.random() * 8 - 4)),
        y: Math.round(startY + (targetY - startY) * eased + (Math.random() * 8 - 4)),
      })
    }
    await dispatchMousePathBatch(points, 4)
  }

  /**
   * 自然悬停：移到元素位置 → mouseenter → 微抖动（3-8px偏移）
   * 模拟用户在元素上停留考虑时的手部自然抖动
   */
  async function naturalHover(el, duration) {
    var rect = el.getBoundingClientRect()
    var cx = rect.left + rect.width / 2
    var cy = rect.top + rect.height / 2

    await moveMouseTo(cx, cy)

    // mouseenter + mouseover
    var mouseOpts = { bubbles: true, cancelable: true, view: window, clientX: Math.round(cx), clientY: Math.round(cy) }
    try {
      el.dispatchEvent(new MouseEvent('mouseenter', mouseOpts))
      el.dispatchEvent(new MouseEvent('mouseover', mouseOpts))
    } catch (e) {}

    // 微抖动（10-20个点，3-8px随机偏移）
    var pointCount = 10 + Math.floor(Math.random() * 10)
    var points = []
    for (var i = 0; i < pointCount; i++) {
      points.push({
        x: Math.round(cx + (Math.random() * 8 - 4)),
        y: Math.round(cy + (Math.random() * 8 - 4)),
      })
    }
    await dispatchMousePathBatch(points, 5)

    // 填充剩余悬停时间
    var hoverTime = duration || (600 + Math.random() * 1400)
    var padCount = 2 + Math.floor(Math.random() * 2)
    var padDelay = Math.floor(hoverTime / padCount)
    for (var p = 0; p < padCount; p++) {
      dispatchMouseMove(
        Math.round(cx + (Math.random() * 8 - 4)),
        Math.round(cy + (Math.random() * 8 - 4))
      )
      await sleep(padDelay)
    }
  }

  /**
   * 模拟人类点击元素：鼠标移动靠近 → mouseenter → mousedown → mouseup → click
   * 参考 xhs-collector 的 humanClick
   */
  async function humanClick(el) {
    var rect1 = el.getBoundingClientRect()
    if (rect1.bottom < 0 || rect1.top > window.innerHeight || rect1.right < 0 || rect1.left > window.innerWidth) {
      try { el.scrollIntoView({ behavior: 'instant', block: 'nearest' }) } catch (e) { el.scrollIntoView() }
      await sleep(300 + Math.random() * 200)
    } else {
      await sleep(200 + Math.random() * 200)
    }

    await moveMouseToElement(el)

    var rect2 = el.getBoundingClientRect()
    var cx = Math.round(rect2.left + rect2.width / 2)
    var cy = Math.round(rect2.top + rect2.height / 2)
    var mouseOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }

    try {
      el.dispatchEvent(new MouseEvent('mouseenter', mouseOpts))
      el.dispatchEvent(new MouseEvent('mouseover', mouseOpts))
    } catch (e) {}
    await sleep(100 + Math.random() * 100)

    try { el.dispatchEvent(new MouseEvent('mousedown', mouseOpts)) } catch (e) {}
    await sleep(50 + Math.random() * 50)
    try { el.dispatchEvent(new MouseEvent('mouseup', mouseOpts)) } catch (e) {}
    await sleep(20 + Math.random() * 30)
    if (typeof el.click === 'function') { el.click() }
    else { try { el.dispatchEvent(new MouseEvent('click', mouseOpts)) } catch (e) {} }
  }

  /** moveMouseToElement - 移动鼠标到元素中心 */
  async function moveMouseToElement(el, steps) {
    var rect = el.getBoundingClientRect()
    var targetX = Math.round(rect.left + rect.width / 2)
    var targetY = Math.round(rect.top + rect.height / 2)
    await moveMouseTo(targetX, targetY, steps)
  }

  // ======================= 执行点击流程 =======================

  return (async function () {
    const clicked = []

    // 先在验证码区域做一次大幅鼠标移动（模拟用户查看验证码）
    var captchaRect = captchaDiv.getBoundingClientRect()
    await moveMouseTo(
      captchaRect.left + captchaRect.width * (0.2 + Math.random() * 0.6),
      captchaRect.top + captchaRect.height * (0.2 + Math.random() * 0.6),
      12 + Math.floor(Math.random() * 6)
    )
    await sleep(300 + Math.random() * 400)

    // 逐个点击选中的图片
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i]
      const el = imgContainers[idx]
      if (!el) continue

      // 悬停考虑（模拟用户在看图片判断）
      await naturalHover(el, 500 + Math.random() * 800)

      // 点击
      await humanClick(el)
      clicked.push(idx)

      // 点击后短暂观察
      await sleep(400 + Math.random() * 300)

      // 移开鼠标（模拟用户看其他图片）
      if (i < indices.length - 1) {
        var nextEl = imgContainers[indices[i + 1]]
        if (nextEl) {
          var nextRect = nextEl.getBoundingClientRect()
          await moveMouseTo(
            nextRect.left + nextRect.width * (0.3 + Math.random() * 0.4),
            nextRect.top + nextRect.height * (0.3 + Math.random() * 0.4),
            6 + Math.floor(Math.random() * 6)
          )
          await sleep(200 + Math.random() * 200)
        }
      }
    }

    return { ok: true, clicked }
  })()
}

/**
 * 点击验证按钮（深度行为模拟）
 */
function _clickVerifyButton() {
  const captchaDiv = document.querySelector('#captcha-div, .fe-captcha-app, .capptch-modal-content-inner')
  if (!captchaDiv) return { ok: false, error: '验证码容器未找到' }

  const btn = captchaDiv.querySelector('.btn:not(.btn-disabled), .btn.btn-disabled')
  if (!btn) return { ok: false, error: '验证按钮未找到' }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

  function dispatchMouseMove(x, y) {
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, view: window,
      clientX: Math.round(x), clientY: Math.round(y),
    }))
  }

  async function dispatchMousePathBatch(points, batchSize) {
    batchSize = batchSize || 4
    for (var i = 0; i < points.length; i += batchSize) {
      var end = Math.min(i + batchSize, points.length)
      for (var j = i; j < end; j++) dispatchMouseMove(points[j].x, points[j].y)
      if (i + batchSize < points.length) await sleep(10 + Math.random() * 15)
    }
  }

  return (async function () {
    var rect = btn.getBoundingClientRect()
    var targetX = rect.left + rect.width / 2
    var targetY = rect.top + rect.height / 2

    // 贝塞尔轨迹移动到验证按钮
    var startX = Math.max(0, targetX - 150 - Math.floor(Math.random() * 200))
    var startY = Math.max(0, targetY - 100 - Math.floor(Math.random() * 150))
    var steps = 8 + Math.floor(Math.random() * 8)
    var accelMode = Math.floor(Math.random() * 3)
    var points = []
    for (var i = 0; i <= steps; i++) {
      var t = i / steps
      var eased
      if (accelMode === 0) eased = 1 - Math.pow(1 - t, 3)
      else if (accelMode === 1) eased = Math.pow(t, 3)
      else eased = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2
      points.push({
        x: Math.round(startX + (targetX - startX) * eased + (Math.random() * 8 - 4)),
        y: Math.round(startY + (targetY - startY) * eased + (Math.random() * 8 - 4)),
      })
    }
    await dispatchMousePathBatch(points, 4)

    // 悬停微抖
    var mouseOpts = { bubbles: true, cancelable: true, view: window, clientX: Math.round(targetX), clientY: Math.round(targetY) }
    try {
      btn.dispatchEvent(new MouseEvent('mouseenter', mouseOpts))
      btn.dispatchEvent(new MouseEvent('mouseover', mouseOpts))
    } catch (e) {}
    await sleep(150 + Math.random() * 200)

    // 微抖动
    for (var j = 0; j < 8; j++) {
      dispatchMouseMove(targetX + (Math.random() * 6 - 3), targetY + (Math.random() * 6 - 3))
      await sleep(20 + Math.random() * 30)
    }

    // 完整点击事件链
    try { btn.dispatchEvent(new MouseEvent('mousedown', mouseOpts)) } catch (e) {}
    await sleep(50 + Math.random() * 50)
    try { btn.dispatchEvent(new MouseEvent('mouseup', mouseOpts)) } catch (e) {}
    await sleep(20 + Math.random() * 30)
    if (typeof btn.click === 'function') btn.click()
    else { try { btn.dispatchEvent(new MouseEvent('click', mouseOpts)) } catch (e) {} }

    return { ok: true }
  })()
}

/**
 * 检查验证码是否已消失（验证通过）
 */
function _checkCaptchaGone() {
  const captchaDiv = document.querySelector('#captcha-div, .fe-captcha-app')
  if (!captchaDiv) return { gone: true }
  if (captchaDiv.style.display === 'none' || captchaDiv.style.visibility === 'hidden') return { gone: true }
  if (!document.body.contains(captchaDiv)) return { gone: true }
  const successEl = captchaDiv.querySelector('.success, [class*="success"]')
  if (successEl) return { gone: true }
  return { gone: false }
}
