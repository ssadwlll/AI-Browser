/**
 * Electron API 引擎
 * 使用 Electron 原生 API（sendInputEvent/insertText）实现可靠交互
 * 替代 JS .click() 的不完整性，提供 CDP 级别的完整事件链
 */

class ElectronEngine {
  /**
   * 获取元素的位置和尺寸信息
   * @param {object} webContents
   * @param {string} selector - CSS 选择器
   * @param {number} index - 匹配多个元素时的索引
   * @returns {Promise<object|null>} - 元素信息或 null
   */
  async getElementRect(webContents, selector, index = 0) {
    const safeSelector = selector.replace(/'/g, "\\'")
    const result = await webContents.executeJavaScript(`
      (function() {
        const els = document.querySelectorAll('${safeSelector}')
        if (els.length === 0) return null
        const idx = ${index}
        if (idx >= els.length) return { error: '索引越界: 共' + els.length + '个元素，请求第' + (idx + 1) + '个' }

        const el = els[idx]
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })

        // 等待滚动完成后重新获取位置
        return new Promise(resolve => {
          setTimeout(() => {
            const rect = el.getBoundingClientRect()
            resolve({
              found: true,
              tag: el.tagName.toLowerCase(),
              id: el.id || '',
              className: typeof el.className === 'string' ? el.className.substring(0, 80) : '',
              text: (el.textContent || '').trim().substring(0, 100),
              rect: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                centerX: rect.x + rect.width / 2,
                centerY: rect.y + rect.height / 2,
              },
              totalMatching: els.length,
            })
          }, 300)
        })
      })()
    `)
    return result
  }

  /**
   * 使用完整鼠标事件链点击元素
   * 事件链: mouseMove -> mouseDown -> mouseUp (等同于真实用户点击)
   * @param {object} webContents
   * @param {number} x - 点击 x 坐标
   * @param {number} y - 点击 y 坐标
   * @param {string} button - 鼠标按钮 'left'/'right'/'middle'
   * @param {number} clickCount - 点击次数
   */
  async click(webContents, x, y, button = 'left', clickCount = 1) {
    // 移动鼠标到目标位置
    await webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(x),
      y: Math.round(y),
    })

    // 小延迟模拟真实用户
    await new Promise(r => setTimeout(r, 50))

    // 按下鼠标
    await webContents.sendInputEvent({
      type: 'mouseDown',
      x: Math.round(x),
      y: Math.round(y),
      button,
      clickCount,
    })

    // 短暂延迟后释放
    await new Promise(r => setTimeout(r, 50))

    // 释放鼠标
    await webContents.sendInputEvent({
      type: 'mouseUp',
      x: Math.round(x),
      y: Math.round(y),
      button,
      clickCount,
    })
  }

  /**
   * 通过 CSS 选择器点击元素（完整流程）
   * 1. 获取元素位置 2. 滚动到可视区 3. sendInputEvent 完整事件链点击
   * @param {object} webContents
   * @param {string} selector
   * @param {number} index
   */
  async clickElement(webContents, selector, index = 0) {
    const elementInfo = await this.getElementRect(webContents, selector, index)

    if (!elementInfo) {
      return { success: false, error: `未找到匹配元素: ${selector}` }
    }
    if (elementInfo.error) {
      return { success: false, error: elementInfo.error }
    }

    const { rect, tag, id, className, text, totalMatching } = elementInfo

    // 验证元素在可视区域内
    if (rect.width === 0 || rect.height === 0) {
      return { success: false, error: `元素不可见或尺寸为0: ${selector}` }
    }

    // 执行点击
    await this.click(webContents, rect.centerX, rect.centerY)

    return {
      success: true,
      element: { tag, id, className, text, index },
      totalMatching,
      clickMethod: 'sendInputEvent',
    }
  }

  /**
   * 在指定元素中输入文本
   * 使用 insertText + 键盘事件，比 JS .value= 更可靠
   * @param {object} webContents
   * @param {string} selector
   * @param {string} text
   * @param {boolean} clearFirst - 是否先清空
   * @param {number} index
   */
  async typeText(webContents, selector, text, clearFirst = true, index = 0) {
    const safeSelector = selector.replace(/'/g, "\\'")

    // 1. 聚焦元素
    const focusResult = await webContents.executeJavaScript(`
      (function() {
        const els = document.querySelectorAll('${safeSelector}')
        if (els.length === 0) return { success: false, error: '未找到元素: ${safeSelector}' }
        const el = els[${index}]
        if (!el) return { success: false, error: '索引越界' }

        // 聚焦元素
        el.focus()
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })

        ${clearFirst ? `
        // 清空内容
        if (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea') {
          el.value = ''
          // 触发 input 事件让框架感知
          el.dispatchEvent(new Event('input', { bubbles: true }))
        } else if (el.isContentEditable) {
          el.textContent = ''
          el.dispatchEvent(new InputEvent('input', { bubbles: true }))
        }` : ''}

        return {
          success: true,
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
        }
      })()
    `)

    if (!focusResult || !focusResult.success) {
      return focusResult || { success: false, error: '聚焦失败' }
    }

    // 2. 使用 insertText 输入（触发完整 input 事件）
    await webContents.insertText(text)

    // 3. 触发 change 事件
    await webContents.executeJavaScript(`
      (function() {
        const el = document.querySelector('${safeSelector}')
        if (el) el.dispatchEvent(new Event('change', { bubbles: true }))
      })()
    `)

    return {
      success: true,
      element: { tag: focusResult.tag, type: focusResult.type },
      text,
      inputMethod: 'insertText',
    }
  }

  /**
   * 发送键盘按键
   * @param {object} webContents
   * @param {string} keyCode - 键码，如 'Enter', 'Escape', 'Tab'
   */
  async pressKey(webContents, keyCode) {
    await webContents.sendInputEvent({
      type: 'keyDown',
      keyCode,
    })
    await new Promise(r => setTimeout(r, 50))
    await webContents.sendInputEvent({
      type: 'keyUp',
      keyCode,
    })
  }

  /**
   * 获取元素是否可见
   * @param {object} webContents
   * @param {string} selector
   */
  async isElementVisible(webContents, selector) {
    const safeSelector = selector.replace(/'/g, "\\'")
    const result = await webContents.executeJavaScript(`
      (function() {
        const el = document.querySelector('${safeSelector}')
        if (!el) return { found: false }
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return {
          found: true,
          visible: style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }
      })()
    `)
    return result
  }
}

module.exports = ElectronEngine
