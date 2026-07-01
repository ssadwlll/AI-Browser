// ============ 动作循环检测器 ============
// 追踪重复动作模式和页面停滞，向AI发出分级提醒
export class ActionLoopDetector {
  constructor(windowSize = 15) {
    this.windowSize = windowSize
    this.recentActions = []       // [{key, name, url}]
    this.consecutiveStagnant = 0  // 连续页面无变化次数
    this._lastPageState = null    // {url, elementCount}
  }

  record(name, params, currentUrl) {
    const selector = params?.selector || ''
    const navUrl = params?.url || ''
    const key = `${name}|${selector}|${navUrl}`
    this.recentActions.push({ key, name, url: currentUrl })
    if (this.recentActions.length > this.windowSize) {
      this.recentActions = this.recentActions.slice(-this.windowSize)
    }
  }

  recordPageState(url, elementCount) {
    const state = `${url}|${elementCount}`
    if (this._lastPageState === state) {
      this.consecutiveStagnant++
    } else {
      this.consecutiveStagnant = 0
      this._lastPageState = state
    }
  }

  getNudge() {
    const msgs = []

    // 动作重复检测
    const counts = {}
    for (const a of this.recentActions) {
      counts[a.key] = (counts[a.key] || 0) + 1
    }
    const maxRepeat = Math.max(...Object.values(counts), 0)

    if (maxRepeat >= 12) {
      msgs.push(`严重警告：同一操作已重复 ${maxRepeat} 次（最近 ${this.recentActions.length} 个动作中）。如果每次都在推进，请继续；否则强烈建议更换策略或调用 finish_task 报告。`)
    } else if (maxRepeat >= 8) {
      msgs.push(`注意：同一操作已重复 ${maxRepeat} 次。是否每次都有进展？如果没有，建议尝试不同方法。`)
    } else if (maxRepeat >= 5) {
      msgs.push(`提示：同一操作已重复 ${maxRepeat} 次。如果是有意为之且持续有进展，请继续；否则值得重新考虑策略。`)
    }

    // 页面停滞检测
    if (this.consecutiveStagnant >= 5) {
      msgs.push(`页面内容已连续 ${this.consecutiveStagnant} 步没有变化，DOM操作可能没有生效。建议尝试不同的元素或策略。`)
    }

    return msgs.length > 0 ? msgs.join('\n') : null
  }
}
