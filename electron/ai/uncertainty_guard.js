/**
 * 不确定性检测模块
 * 解决 AI 代码注入执行带来的三类不确定性：
 * 1. DOM 变更感知（无导航的页面结构变化）
 * 2. 循环检测（AI 反复生成相同代码）
 * 3. 操作结果验证（验证操作是否真正生效）
 */

class UncertaintyGuard {
  constructor() {
    // 循环检测
    this.actionHistory = []       // 最近操作记录
    this.maxActionHistory = 10    // 保留最近10次操作
    this.loopWarningThreshold = 3 // 重复3次开始警告
    this.loopHardThreshold = 5    // 重复5次强制警告

    // DOM 快照
    this.lastDomSnapshot = null   // 上次 DOM 快照
  }

  /**
   * 1. DOM 变更感知
   * 在 JS 注入执行前拍快照，执行后对比变化
   * @param {object} webContents
   * @returns {Promise<object>} - 快照数据
   */
  async captureDomSnapshot(webContents) {
    try {
      const snapshot = await webContents.executeJavaScript(`
        (function() {
          // 元素总数
          const allElements = document.querySelectorAll('*')
          const elementCount = allElements.length

          // 关键元素统计
          const stats = {
            divs: document.querySelectorAll('div').length,
            buttons: document.querySelectorAll('button').length,
            links: document.querySelectorAll('a[href]').length,
            inputs: document.querySelectorAll('input,textarea,select').length,
            images: document.querySelectorAll('img').length,
            forms: document.querySelectorAll('form').length,
          }

          // body 内容哈希（简单哈希，用于检测内容变化）
          const bodyHTML = document.body ? document.body.innerHTML : ''
          let hash = 0
          const step = Math.max(1, Math.floor(bodyHTML.length / 5000))
          for (let i = 0; i < bodyHTML.length; i += step) {
            hash = ((hash << 5) - hash + bodyHTML.charCodeAt(i)) | 0
          }

          return { elementCount, stats, domHash: hash, url: location.href }
        })()
      `)
      return snapshot
    } catch (e) {
      return { elementCount: 0, stats: {}, domHash: 0, error: e.message }
    }
  }

  /**
   * 对比两个 DOM 快照，检测变更
   * @param {object} before - 执行前快照
   * @param {object} after - 执行后快照
   * @returns {object} - { changed, details }
   */
  detectDomChanges(before, after) {
    if (!before || !after) return { changed: false, details: '无快照数据' }

    const changes = {
      changed: false,
      urlChanged: before.url !== after.url,
      elementCountDelta: after.elementCount - before.elementCount,
      statsChanges: {},
    }

    // 检测 URL 变化
    if (changes.urlChanged) {
      changes.changed = true
      changes.details = `URL 从 ${before.url} 变为 ${after.url}`
      return changes
    }

    // 检测元素数量变化
    if (Math.abs(changes.elementCountDelta) > 0) {
      changes.changed = true
      changes.details = `元素数量变化: ${changes.elementCountDelta > 0 ? '+' : ''}${changes.elementCountDelta}`
    }

    // 检测各类元素变化
    if (before.stats && after.stats) {
      for (const key of Object.keys(before.stats)) {
        const delta = (after.stats[key] || 0) - (before.stats[key] || 0)
        if (delta !== 0) {
          changes.statsChanges[key] = delta
          changes.changed = true
        }
      }
    }

    // 检测 DOM 内容哈希变化
    if (before.domHash !== after.domHash && !changes.changed) {
      changes.changed = true
      changes.details = '页面内容发生变化（DOM 哈希不一致）'
    }

    if (changes.changed && !changes.details) {
      const parts = []
      for (const [k, v] of Object.entries(changes.statsChanges)) {
        parts.push(`${k} ${v > 0 ? '+' : ''}${v}`)
      }
      changes.details = parts.join(', ')
    }

    return changes
  }

  /**
   * 2. 循环检测
   * 记录 AI 生成的代码哈希，检测是否反复生成相同代码
   * @param {string} codeOrAction - 代码或操作描述
   * @returns {object} - { isLoop, severity, message }
   */
  checkLoop(codeOrAction) {
    // 生成简单哈希（去除空格和换行后取前200字符）
    const normalized = codeOrAction.replace(/\s+/g, ' ').trim().substring(0, 200)
    let hash = 0
    for (let i = 0; i < normalized.length; i++) {
      hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0
    }

    this.actionHistory.push({ hash, code: normalized, timestamp: Date.now() })
    if (this.actionHistory.length > this.maxActionHistory) {
      this.actionHistory.shift()
    }

    // 统计最近相同操作次数
    let repeatCount = 0
    for (let i = this.actionHistory.length - 1; i >= 0; i--) {
      if (this.actionHistory[i].hash === hash) {
        repeatCount++
      } else {
        break
      }
    }

    if (repeatCount >= this.loopHardThreshold) {
      return {
        isLoop: true,
        severity: 'hard',
        repeatCount,
        message: `⚠️ 检测到操作已重复 ${repeatCount} 次！AI 可能陷入了循环。请尝试完全不同的方法，或检查页面状态是否如预期。`,
      }
    }

    if (repeatCount >= this.loopWarningThreshold) {
      return {
        isLoop: true,
        severity: 'warning',
        repeatCount,
        message: `⚠️ 此操作已重复 ${repeatCount} 次，可能需要换一种方式。请重新分析页面状态，考虑是否有遗漏的步骤。`,
      }
    }

    return { isLoop: false, repeatCount, message: '' }
  }

  /**
   * 3. 操作结果验证
   * 验证点击/输入等操作是否真正生效
   * @param {object} webContents
   * @param {string} operationType - 'click' | 'type' | 'navigate'
   * @param {object} expectedResult - 预期变化描述
   * @param {object} beforeSnapshot - 操作前快照
   * @returns {Promise<object>} - { verified, message }
   */
  async verifyOperation(webContents, operationType, expectedResult, beforeSnapshot) {
    try {
      // 操作后拍快照
      const afterSnapshot = await this.captureDomSnapshot(webContents)
      const changes = this.detectDomChanges(beforeSnapshot, afterSnapshot)

      // 点击操作：检查 DOM 是否发生变化
      if (operationType === 'click') {
        if (changes.urlChanged) {
          return {
            verified: true,
            message: `点击成功，页面已导航到 ${afterSnapshot.url}`,
            changes,
          }
        }
        if (changes.changed) {
          return {
            verified: true,
            message: `点击成功，页面发生变化: ${changes.details}`,
            changes,
          }
        }
        // DOM 没变，可能点击无效
        return {
          verified: false,
          message: '⚠️ 点击后页面无明显变化，可能点击未生效或元素需要其他交互方式。请检查元素状态。',
          changes,
        }
      }

      // 输入操作：检查输入框值
      if (operationType === 'type' && expectedResult && expectedResult.selector) {
        const safeSelector = expectedResult.selector.replace(/'/g, "\\'")
        const inputCheck = await webContents.executeJavaScript(`
          (function() {
            const el = document.querySelector('${safeSelector}')
            if (!el) return { found: false }
            return {
              found: true,
              value: el.value || el.textContent || '',
              tag: el.tagName.toLowerCase(),
            }
          })()
        `)
        if (inputCheck && inputCheck.found && expectedResult.expectedValue) {
          if (inputCheck.value.includes(expectedResult.expectedValue)) {
            return { verified: true, message: `输入成功，值为: "${inputCheck.value.substring(0, 50)}"` }
          }
          return {
            verified: false,
            message: `⚠️ 输入验证失败，期望包含 "${expectedResult.expectedValue}"，实际值: "${inputCheck.value.substring(0, 50)}"`,
          }
        }
      }

      return { verified: true, message: '操作已执行', changes }
    } catch (e) {
      return { verified: false, message: `验证失败: ${e.message}` }
    }
  }

  /**
   * 清空历史记录
   */
  reset() {
    this.actionHistory = []
    this.lastDomSnapshot = null
  }

  /**
   * 获取循环检测的引导 prompt
   * @param {object} loopResult - checkLoop 返回的结果
   * @returns {string} - 注入给 AI 的引导文本
   */
  getLoopGuidance(loopResult) {
    if (!loopResult.isLoop) return ''

    if (loopResult.severity === 'hard') {
      return `\n\n${loopResult.message}\n你已重复此操作 ${loopResult.repeatCount} 次，必须立即改变策略：\n1. 重新调用 collect_page_context 获取最新页面状态\n2. 分析之前的操作为何无效\n3. 尝试完全不同的方法\n`
    }

    return `\n\n${loopResult.message}\n`
  }
}

module.exports = UncertaintyGuard
