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

/**
 * 检测验证码并提取信息
 */
function _extractCaptchaInfo() {
  // 小红书验证码容器
  const captchaDiv = document.querySelector('#captcha-div, .fe-captcha-app, .capptch-modal-content-inner')
  if (!captchaDiv) return { found: false }

  // 提取指令文本（"放在桌子上的小物件"）
  const promptEl = captchaDiv.querySelector('.font-600.tc-3, .tc-3')
  const prompt = promptEl ? promptEl.textContent.trim() : ''

  // 提取"请选择最符合描述的X张图片"中的数量
  const descEl = captchaDiv.querySelector('.lh-20.size-14, .tc-61')
  const descText = descEl ? descEl.textContent.trim() : ''
  let requiredCount = 2
  const countMatch = descText.match(/(\d+)张/)
  if (countMatch) requiredCount = parseInt(countMatch[1], 10)

  // 提取图片元素
  const imgContainers = captchaDiv.querySelectorAll('.img-container')
  const images = Array.from(imgContainers).map((el, i) => {
    const img = el.querySelector('img')
    const rect = el.getBoundingClientRect()
    return {
      index: i,
      src: img ? img.src : '',
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    }
  })

  if (images.length === 0) return { found: false }

  // 计算验证码区域边界框（用于裁剪截图）
  const captchaRect = captchaDiv.getBoundingClientRect()
  const boundingBox = {
    left: captchaRect.left,
    top: captchaRect.top,
    width: captchaRect.width,
    height: captchaRect.height,
  }

  return {
    found: true,
    prompt,
    descText,
    requiredCount,
    imageCount: images.length,
    images: images.map(img => ({ index: img.index, src: img.src })),
    boundingBox,
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
      canvas.width = sw
      canvas.height = sh
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

/**
 * 模拟人类点击选中的验证码图片
 */
function _clickCaptchaImages(indices) {
  const captchaDiv = document.querySelector('#captcha-div, .fe-captcha-app, .capptch-modal-content-inner')
  if (!captchaDiv) return { ok: false, error: '验证码容器未找到' }

  const imgContainers = captchaDiv.querySelectorAll('.img-container')
  if (imgContainers.length === 0) return { ok: false, error: '图片容器未找到' }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

  return (async function () {
    const clicked = []
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i]
      const el = imgContainers[idx]
      if (!el) continue

      const rect = el.getBoundingClientRect()
      const cx = rect.left + rect.width * (0.3 + Math.random() * 0.4)
      const cy = rect.top + rect.height * (0.3 + Math.random() * 0.4)

      // 模拟鼠标移动到目标
      document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window,
      }))
      await sleep(100 + Math.random() * 150)

      // 模拟完整点击事件链
      el.dispatchEvent(new MouseEvent('mousedown', {
        clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window,
      }))
      await sleep(40 + Math.random() * 60)
      el.dispatchEvent(new MouseEvent('mouseup', {
        clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window,
      }))
      await sleep(20 + Math.random() * 30)
      el.dispatchEvent(new MouseEvent('click', {
        clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window,
      }))

      clicked.push(idx)
      await sleep(300 + Math.random() * 200)
    }
    return { ok: true, clicked }
  })()
}

/**
 * 点击验证按钮
 */
function _clickVerifyButton() {
  const captchaDiv = document.querySelector('#captcha-div, .fe-captcha-app, .capptch-modal-content-inner')
  if (!captchaDiv) return { ok: false, error: '验证码容器未找到' }

  // 查找验证按钮（可能处于 disabled 状态）
  const btn = captchaDiv.querySelector('.btn:not(.btn-disabled), .btn.btn-disabled')
  if (!btn) return { ok: false, error: '验证按钮未找到' }

  const rect = btn.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2

  document.dispatchEvent(new MouseEvent('mousemove', {
    clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window,
  }))

  btn.dispatchEvent(new MouseEvent('mousedown', {
    clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window,
  }))

  btn.dispatchEvent(new MouseEvent('mouseup', {
    clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window,
  }))

  btn.dispatchEvent(new MouseEvent('click', {
    clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window,
  }))

  // 也尝试直接 .click()
  try { btn.click() } catch (e) {}

  return { ok: true }
}

/**
 * 检查验证码是否已消失（验证通过）
 */
function _checkCaptchaGone() {
  const captchaDiv = document.querySelector('#captcha-div, .fe-captcha-app')
  if (!captchaDiv) return { gone: true }
  if (captchaDiv.style.display === 'none' || captchaDiv.style.visibility === 'hidden') return { gone: true }
  // 检查是否还在 DOM 中
  if (!document.body.contains(captchaDiv)) return { gone: true }
  // 检查是否显示了"验证成功"之类的提示
  const successEl = captchaDiv.querySelector('.success, [class*="success"]')
  if (successEl) return { gone: true }
  return { gone: false }
}
