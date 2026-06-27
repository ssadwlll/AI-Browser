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

  /**
   * 鼠标悬停在指定元素上（触发 hover 事件、下拉菜单等）
   * @param {object} webContents
   * @param {string} selector
   * @param {number} index
   */
  async hoverElement(webContents, selector, index = 0) {
    const elementInfo = await this.getElementRect(webContents, selector, index)
    if (!elementInfo) {
      return { success: false, error: `未找到匹配元素: ${selector}` }
    }
    if (elementInfo.error) {
      return { success: false, error: elementInfo.error }
    }

    const { rect, tag, id, className, text } = elementInfo
    // 移动鼠标到元素中心（不点击，仅触发 mouseMove/mouseenter/mouseover）
    await webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(rect.centerX),
      y: Math.round(rect.centerY),
    })

    // 等待 hover 效果触发（如下拉菜单动画）
    await new Promise(r => setTimeout(r, 500))

    return {
      success: true,
      element: { tag, id, className, text, index },
      hoverMethod: 'sendInputEvent',
    }
  }

  /**
   * 滚动页面（sendInputEvent mouseWheel，比 JS scrollBy 更可靠）
   * @param {object} webContents
   * @param {number} direction - 1=向下, -1=向上
   * @param {number} amount - 滚动量（像素），默认300
   */
  async scrollPage(webContents, direction = 1, amount = 300) {
    // 先获取当前视口中心坐标
    const viewBounds = webContents.getOwnerBrowserWindow()?.getBounds() || { width: 1280, height: 800 }
    const centerX = Math.round(viewBounds.width / 2)
    const centerY = Math.round(viewBounds.height / 2)

    // 使用 mouseWheel 事件滚动
    await webContents.sendInputEvent({
      type: 'mouseWheel',
      x: centerX,
      y: centerY,
      deltaX: 0,
      deltaY: direction * amount,
    })

    await new Promise(r => setTimeout(r, 300))

    return {
      success: true,
      direction: direction > 0 ? 'down' : 'up',
      amount,
      scrollMethod: 'sendInputEvent',
    }
  }

  /**
   * 选择下拉框选项（select 元素）
   * 使用键盘事件模拟真实用户选择，比 JS .value= 更可靠
   * @param {object} webContents
   * @param {string} selector
   * @param {string} value - 选项值
   * @param {number} index
   */
  async selectOption(webContents, selector, value, index = 0) {
    const safeSelector = selector.replace(/'/g, "\\'")

    // 1. 聚焦 select 元素并获取选项信息
    const selectInfo = await webContents.executeJavaScript(`
      (function() {
        const els = document.querySelectorAll('${safeSelector}')
        if (els.length === 0) return { success: false, error: '未找到元素' }
        const el = els[${index}]
        if (!el) return { success: false, error: '索引越界' }
        if (el.tagName.toLowerCase() !== 'select') {
          return { success: false, error: '元素不是 select 类型: ' + el.tagName }
        }
        el.focus()
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })

        const options = [...el.options].map((opt, i) => ({
          index: i,
          value: opt.value,
          text: opt.textContent.trim(),
          selected: opt.selected,
        }))

        // 尝试匹配选项
        const targetIdx = el.options.length > 0
          ? [...el.options].findIndex(opt => opt.value === '${value.replace(/'/g, "\\'")}' || opt.textContent.trim() === '${value.replace(/'/g, "\\'")}')
          : -1

        if (targetIdx >= 0) {
          el.selectedIndex = targetIdx
          el.dispatchEvent(new Event('change', { bubbles: true }))
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return { success: true, selectedIndex: targetIdx, selectedText: el.options[targetIdx].textContent.trim() }
        }
        return { success: false, error: '未找到匹配选项', availableOptions: options }
      })()
    `)

    return selectInfo || { success: false, error: '执行失败' }
  }

  /**
   * 文件上传（通过 file input 元素）
   * @param {object} webContents
   * @param {string} selector - file input 的 CSS 选择器
   * @param {string} filePath - 本地文件路径
   * @param {number} index
   */
  async uploadFile(webContents, selector, filePath, index = 0) {
    const safeSelector = selector.replace(/'/g, "\\'")

    // 检查元素是否存在且是 file input
    const checkResult = await webContents.executeJavaScript(`
      (function() {
        const els = document.querySelectorAll('${safeSelector}')
        if (els.length === 0) return { success: false, error: '未找到元素' }
        const el = els[${index}]
        if (!el) return { success: false, error: '索引越界' }
        if (el.type !== 'file') {
          return { success: false, error: '元素不是 file input: type=' + el.type }
        }
        return { success: true, tag: el.tagName, type: el.type }
      })()
    `)

    if (!checkResult || !checkResult.success) {
      return checkResult || { success: false, error: '检查失败' }
    }

    // 使用 Electron 的 webContents.uploadFile 方法
    // 通过模拟选择文件对话框来上传
    await webContents.executeJavaScript(`
      (function() {
        const el = document.querySelectorAll('${safeSelector}')[${index}]
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })()
    `)

    // 短暂等待对话框触发
    await new Promise(r => setTimeout(r, 200))

    // 使用 uploadFile API（Electron 专有）
    webContents.uploadFile(filePath)

    return {
      success: true,
      filePath,
      uploadMethod: 'webContents.uploadFile',
    }
  }

  /**
   * 获取元素文本内容
   * @param {object} webContents
   * @param {string} selector
   * @param {number} index
   * @param {number} maxLength - 最大返回长度
   */
  async getElementText(webContents, selector, index = 0, maxLength = 5000) {
    const safeSelector = selector.replace(/'/g, "\\'")
    const result = await webContents.executeJavaScript(`
      (function() {
        const els = document.querySelectorAll('${safeSelector}')
        if (els.length === 0) return { success: false, error: '未找到元素' }
        const el = els[${index}]
        if (!el) return { success: false, error: '索引越界' }
        return {
          success: true,
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().substring(0, ${maxLength}),
          innerText: (el.innerText || '').trim().substring(0, ${maxLength}),
          totalMatching: els.length,
        }
      })()
    `)
    return result
  }

  /**
   * 获取元素属性
   * @param {object} webContents
   * @param {string} selector
   * @param {string} attribute - 属性名（如 href, src, data-id 等）
   * @param {number} index
   */
  async getElementAttribute(webContents, selector, attribute, index = 0) {
    const safeSelector = selector.replace(/'/g, "\\'")
    const safeAttr = attribute.replace(/'/g, "\\'")
    const result = await webContents.executeJavaScript(`
      (function() {
        const els = document.querySelectorAll('${safeSelector}')
        if (els.length === 0) return { success: false, error: '未找到元素' }
        const el = els[${index}]
        if (!el) return { success: false, error: '索引越界' }
        return {
          success: true,
          tag: el.tagName.toLowerCase(),
          attribute: '${safeAttr}',
          value: el.getAttribute('${safeAttr}') || el['${safeAttr}'] || null,
          totalMatching: els.length,
        }
      })()
    `)
    return result
  }

  /**
   * 拖拽元素到目标位置
   * @param {object} webContents
   * @param {number} fromX - 起点 X
   * @param {number} fromY - 起点 Y
   * @param {number} toX - 终点 X
   * @param {number} toY - 终点 Y
   */
  async dragAndDrop(webContents, fromX, fromY, toX, toY) {
    // 1. 移动到起点
    await webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(fromX), y: Math.round(fromY) })
    await new Promise(r => setTimeout(r, 100))

    // 2. 按下鼠标
    await webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(fromX), y: Math.round(fromY), button: 'left', clickCount: 1 })
    await new Promise(r => setTimeout(r, 100))

    // 3. 分步移动（模拟真实拖拽轨迹）
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(fromX + (toX - fromX) * (i / steps))
      const y = Math.round(fromY + (toY - fromY) * (i / steps))
      await webContents.sendInputEvent({ type: 'mouseMove', x, y })
      await new Promise(r => setTimeout(r, 30))
    }

    // 4. 释放鼠标
    await new Promise(r => setTimeout(r, 100))
    await webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(toX), y: Math.round(toY), button: 'left', clickCount: 1 })

    return {
      success: true,
      from: { x: fromX, y: fromY },
      to: { x: toX, y: toY },
      dragMethod: 'sendInputEvent',
    }
  }
}

module.exports = ElectronEngine
