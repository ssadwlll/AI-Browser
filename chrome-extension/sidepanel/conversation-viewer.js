// ============ 对话全景窗口 ============
// 主界面显示轮次列表，点击弹出详情窗口

const main = document.getElementById('main')
const detailModal = document.getElementById('detailModal')
const detailTitle = document.getElementById('detailTitle')
const detailBody = document.getElementById('detailBody')
const detailClose = document.getElementById('detailClose')
const dataModal = document.getElementById('dataModal')
const dataTitle = document.getElementById('dataTitle')
const dataBody = document.getElementById('dataBody')
const dataClose = document.getElementById('dataClose')
const dataCopyBtn = document.getElementById('dataCopyBtn')
const copyAllBtn = document.getElementById('copyAllBtn')
const clearBtn = document.getElementById('clearBtn')
const toast = document.getElementById('toast')

let roundsData = []
let storedDataMap = {}
let currentDataContent = null  // 当前弹窗显示的数据内容

const channel = new BroadcastChannel('ai-browser-conversation')
channel.onmessage = (e) => handleMessage(e.data)

function handleMessage(data) {
  if (data.type === 'conversationRound') addRound(data.payload)
  else if (data.type === 'conversationClear') clearAll()
  else if (data.type === 'conversationTaskDone') markTaskDone()
}

function addRound(payload) {
  roundsData.push(payload)
  renderRoundItem(payload)
}

// 渲染轮次列表项（紧凑）
function renderRoundItem(payload) {
  const empty = main.querySelector('.empty-state')
  if (empty) empty.remove()

  const { round, response, toolResults, storedData, isFinishRound } = payload

  const item = document.createElement('div')
  item.className = 'round-item' + (isFinishRound ? ' finish-round' : '')
  item.onclick = () => showRoundDetail(payload)
  item.dataset.round = round

  const title = document.createElement('div')
  title.className = 'round-item-title' + (isFinishRound ? ' finish' : '')
  title.textContent = isFinishRound ? `第 ${round} 轮 (完成 ✓)` : `第 ${round} 轮`

  const meta = document.createElement('div')
  meta.className = 'round-item-meta'
  const tc = response?.tool_calls?.length || 0
  const tr = toolResults?.length || 0
  const sd = storedData?.length || 0
  meta.textContent = `工具:${tc} 结果:${tr} 存储:${sd}`

  item.appendChild(title)
  item.appendChild(meta)
  main.appendChild(item)

  // 自动滚动到最新轮次（修复超过 N 轮看不到最新一条的问题）
  requestAnimationFrame(() => {
    main.scrollTop = main.scrollHeight
  })

  // 更新存储数据映射
  if (storedData) {
    storedData.forEach(s => storedDataMap[s.id] = s)
  }
}

// 显示轮次详情弹窗
function showRoundDetail(payload) {
  const { round, request, response, toolResults, storedData } = payload

  detailTitle.textContent = `第 ${round} 轮详情`
  detailBody.innerHTML = ''

  // 请求区块
  if (request) {
    const section = createDetailSection('📤 发送给AI的内容', request)
    detailBody.appendChild(section)
  }

  // 响应区块
  if (response) {
    const section = createDetailSection('📥 AI响应', response)
    detailBody.appendChild(section)
  }

  // 工具结果区块
  if (toolResults && toolResults.length > 0) {
    const section = createDetailSection('⚡ 工具执行结果', toolResults)
    detailBody.appendChild(section)
  }

  // 存储数据区块（特殊处理：显示卡片列表）
  if (storedData && storedData.length > 0) {
    const section = document.createElement('div')
    section.className = 'detail-section'

    const header = document.createElement('div')
    header.className = 'detail-section-header'

    const title = document.createElement('div')
    title.className = 'detail-section-title'
    title.textContent = `💾 已存储数据 (${storedData.length}条)`
    header.appendChild(title)

    const copyBtn = document.createElement('button')
    copyBtn.className = 'detail-section-copy'
    copyBtn.textContent = '📋 复制全部'
    copyBtn.onclick = () => copyToClipboard(storedData)
    header.appendChild(copyBtn)

    section.appendChild(header)

    storedData.forEach(sd => {
      const card = document.createElement('div')
      card.className = 'data-item'
      card.onclick = () => showDataModal(sd)

      const id = document.createElement('div')
      id.className = 'data-item-id'
      id.textContent = sd.id

      const meta = document.createElement('div')
      meta.className = 'data-item-meta'
      meta.textContent = `${sd.toolName} | ${sd.preview}`

      card.appendChild(id)
      card.appendChild(meta)
      section.appendChild(card)
    })

    detailBody.appendChild(section)
  }

  detailModal.classList.add('show')
}

// 创建详情区块（带复制按钮）
function createDetailSection(titleText, data) {
  const section = document.createElement('div')
  section.className = 'detail-section'

  const header = document.createElement('div')
  header.className = 'detail-section-header'

  const title = document.createElement('div')
  title.className = 'detail-section-title'
  title.textContent = titleText
  header.appendChild(title)

  const copyBtn = document.createElement('button')
  copyBtn.className = 'detail-section-copy'
  copyBtn.textContent = '📋 复制'
  copyBtn.onclick = () => copyToClipboard(data)
  header.appendChild(copyBtn)

  section.appendChild(header)

  const tree = createJsonTree(data)
  section.appendChild(tree)

  return section
}

// ============ JSON树形展示 ============
function createJsonTree(data) {
  const container = document.createElement('div')
  container.className = 'json-tree'
  renderNode(container, data, true)
  return container
}

function renderNode(container, value, isRoot) {
  const type = getType(value)

  if (type === 'object' || type === 'array') {
    const isArray = type === 'array'
    const keys = isArray ? value : Object.keys(value)
    const len = isArray ? value.length : keys.length

    const node = document.createElement('div')
    node.className = 'json-node'

    // 头部：括号 + 数量 + 折叠按钮
    const header = document.createElement('span')
    header.className = 'json-key'
    header.onclick = () => {
      const children = node.querySelector('.json-children')
      const toggle = node.querySelector('.json-toggle')
      if (children.style.display === 'none') {
        children.style.display = 'block'
        toggle.className = 'json-toggle expanded'
      } else {
        children.style.display = 'none'
        toggle.className = 'json-toggle collapsed'
      }
    }

    const toggle = document.createElement('span')
    toggle.className = 'json-toggle expanded'

    const bracket = document.createElement('span')
    bracket.className = 'json-bracket'
    bracket.textContent = isArray ? '[' : '{'

    const count = document.createElement('span')
    count.className = 'json-count'
    count.textContent = `${len} ${isArray ? '项' : '个属性'}`

    header.appendChild(toggle)
    header.appendChild(bracket)
    header.appendChild(count)
    node.appendChild(header)

    // 子节点容器
    const children = document.createElement('div')
    children.className = 'json-children'

    if (isArray) {
      value.forEach((item, i) => {
        const childNode = document.createElement('div')
        childNode.className = 'json-node'

        const keySpan = document.createElement('span')
        keySpan.className = 'json-key'
        keySpan.textContent = `${i}`
        keySpan.onclick = () => toggleNode(childNode)

        const colon = document.createElement('span')
        colon.className = 'json-colon'
        colon.textContent = ':'

        childNode.appendChild(keySpan)
        childNode.appendChild(colon)

        const valueContainer = document.createElement('span')
        renderSimpleValue(valueContainer, item)
        childNode.appendChild(valueContainer)

        // 如果子项也是对象/数组，递归渲染
        if (getType(item) === 'object' || getType(item) === 'array') {
          const subChildren = document.createElement('div')
          subChildren.className = 'json-children'
          renderNode(subChildren, item, false)
          childNode.appendChild(subChildren)
        }

        children.appendChild(childNode)
      })
    } else {
      Object.entries(value).forEach(([k, v]) => {
        const childNode = document.createElement('div')
        childNode.className = 'json-node'

        const keySpan = document.createElement('span')
        keySpan.className = 'json-key'
        keySpan.textContent = k
        keySpan.onclick = () => toggleNode(childNode)

        const colon = document.createElement('span')
        colon.className = 'json-colon'
        colon.textContent = ':'

        childNode.appendChild(keySpan)
        childNode.appendChild(colon)

        const valueContainer = document.createElement('span')
        renderSimpleValue(valueContainer, v)
        childNode.appendChild(valueContainer)

        // 如果子项也是对象/数组，递归渲染
        if (getType(v) === 'object' || getType(v) === 'array') {
          const subChildren = document.createElement('div')
          subChildren.className = 'json-children'
          renderNode(subChildren, v, false)
          childNode.appendChild(subChildren)
        }

        children.appendChild(childNode)
      })
    }

    // 尾部括号
    const closeBracket = document.createElement('span')
    closeBracket.className = 'json-bracket'
    closeBracket.textContent = isArray ? ']' : '}'
    children.appendChild(closeBracket)

    node.appendChild(children)
    container.appendChild(node)
  } else {
    // 简单值直接渲染
    const span = document.createElement('span')
    renderSimpleValue(span, value)
    container.appendChild(span)
  }
}

function renderSimpleValue(container, value) {
  const type = getType(value)

  if (type === 'string') {
    const span = document.createElement('span')
    span.className = 'json-value'
    if (value.length > 100) {
      // 长字符串折叠
      const preview = document.createElement('span')
      preview.textContent = '"' + value.slice(0, 80) + '..."'
      preview.className = 'json-value'
      preview.style.cursor = 'pointer'
      preview.onclick = () => {
        if (preview.textContent.includes('...')) {
          preview.textContent = '"' + value + '"'
        } else {
          preview.textContent = '"' + value.slice(0, 80) + '..."'
        }
      }
      container.appendChild(preview)
    } else {
      span.textContent = '"' + value + '"'
      container.appendChild(span)
    }
  } else if (type === 'number') {
    const span = document.createElement('span')
    span.className = 'json-value number'
    span.textContent = value
    container.appendChild(span)
  } else if (type === 'boolean') {
    const span = document.createElement('span')
    span.className = 'json-value boolean'
    span.textContent = value ? 'true' : 'false'
    container.appendChild(span)
  } else if (type === 'null') {
    const span = document.createElement('span')
    span.className = 'json-value null'
    span.textContent = 'null'
    container.appendChild(span)
  }
}

function toggleNode(node) {
  const children = node.querySelector('.json-children')
  if (!children) return
  const toggle = node.querySelector('.json-toggle')
  if (children.style.display === 'none') {
    children.style.display = 'block'
    if (toggle) toggle.className = 'json-toggle expanded'
  } else {
    children.style.display = 'none'
    if (toggle) toggle.className = 'json-toggle collapsed'
  }
}

function getType(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'object') return 'object'
  return typeof v
}

// 显示数据详情弹窗
function showDataModal(sd) {
  dataTitle.textContent = `${sd.id} - ${sd.toolName}`
  dataBody.innerHTML = ''
  currentDataContent = sd.data || sd

  const tree = createJsonTree(currentDataContent)
  dataBody.appendChild(tree)

  dataModal.classList.add('show')
}

// 复制数据
function copyToClipboard(data) {
  const text = JSON.stringify(data, null, 2)
  navigator.clipboard.writeText(text).then(() => showToast('已复制')).catch(() => showToast('复制失败'))
}

// 关闭弹窗
detailClose.onclick = () => detailModal.classList.remove('show')
detailModal.onclick = (e) => { if (e.target === detailModal) detailModal.classList.remove('show') }

dataClose.onclick = () => dataModal.classList.remove('show')
dataModal.onclick = (e) => { if (e.target === dataModal) dataModal.classList.remove('show') }
dataCopyBtn.onclick = () => copyToClipboard(currentDataContent)

// 复制全部轮次数据
copyAllBtn.onclick = () => copyToClipboard(roundsData)

// 清空
clearBtn.onclick = () => {
  clearAll()
  channel.postMessage({ type: 'conversationClear' })
}

function clearAll() {
  roundsData = []
  storedDataMap = {}
  main.innerHTML = '<div class="empty-state">等待 Agent 任务启动…<br>点击轮次查看详情</div>'
}

function markTaskDone() {
  const items = main.querySelectorAll('.round-item')
  if (items.length > 0) {
    const last = items[items.length - 1]
    last.classList.add('done')
    last.querySelector('.round-item-title').classList.add('done')
    last.querySelector('.round-item-title').textContent += ' ✓'
  }
}

function showToast(msg) {
  toast.textContent = msg
  toast.style.opacity = '1'
  setTimeout(() => toast.style.opacity = '0', 2000)
}

console.log('[ConversationViewer] 已初始化')