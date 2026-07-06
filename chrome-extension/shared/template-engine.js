// 轻量级 Handlebars 兼容模板引擎
// 支持：{{variable}}、{{#each array}}...{{/each}}、{{#if cond}}...{{else}}...{{/if}}
// 支持：{{this}}、{{@index}}、{{@key}}、嵌套路径 {{obj.field}}
// 零依赖，适用于 Chrome Extension sidepanel 环境渲染报告模板

/**
 * 渲染模板字符串
 * @param {string} template 模板字符串
 * @param {object} context 数据上下文
 * @returns {string} 渲染后的 HTML 字符串
 */
export function renderTemplate(template, context = {}) {
  if (typeof template !== 'string') return ''
  const ast = _parse(template)
  return _renderAst(ast, context)
}

// ============ AST 解析 ============

function _parse(template) {
  const tokens = []
  let i = 0
  while (i < template.length) {
    const openIdx = template.indexOf('{{', i)
    if (openIdx === -1) {
      tokens.push({ type: 'text', value: template.slice(i) })
      break
    }
    if (openIdx > i) {
      tokens.push({ type: 'text', value: template.slice(i, openIdx) })
    }
    const closeIdx = template.indexOf('}}', openIdx + 2)
    if (closeIdx === -1) {
      tokens.push({ type: 'text', value: template.slice(openIdx) })
      break
    }
    const expr = template.slice(openIdx + 2, closeIdx).trim()
    tokens.push(_parseExpr(expr))
    i = closeIdx + 2
  }
  return _buildTree(tokens)
}

function _parseExpr(expr) {
  // 注释 {{!-- ... --}}
  if (expr.startsWith('!--') || expr.startsWith('!')) {
    return { type: 'comment' }
  }
  // 块开始 {{#each items}} / {{#if cond}}
  if (expr.startsWith('#')) {
    const spaceIdx = expr.indexOf(' ')
    if (spaceIdx === -1) {
      return { type: 'block_open', name: expr.slice(1), arg: '' }
    }
    const name = expr.slice(1, spaceIdx)
    const arg = expr.slice(spaceIdx + 1).trim()
    if (name === 'each') return { type: 'block_open', name: 'each', arg }
    if (name === 'if') return { type: 'block_open', name: 'if', arg }
    return { type: 'block_open', name, arg }
  }
  // 块结束 {{/each}} / {{/if}}
  if (expr.startsWith('/')) {
    return { type: 'block_close', name: expr.slice(1).trim() }
  }
  // else
  if (expr === 'else') {
    return { type: 'else' }
  }
  // 变量 {{variable}}（去掉 HTML 转义的三重大括号 {{{var}}} 也按普通变量处理）
  const unescaped = expr.startsWith('{') && expr.endsWith('}')
  const varName = unescaped ? expr.slice(1, -1).trim() : expr
  return { type: 'var', name: varName, escape: !unescaped }
}

function _buildTree(tokens) {
  const root = { type: 'root', children: [] }
  const stack = [root]
  for (const token of tokens) {
    const current = stack[stack.length - 1]
    if (token.type === 'text') {
      current.children.push({ type: 'text', value: token.value })
    } else if (token.type === 'var') {
      current.children.push(token)
    } else if (token.type === 'block_open') {
      const node = {
        type: 'block',
        name: token.name,
        arg: token.arg,
        children: [],
        elseChildren: null,
      }
      current.children.push(node)
      stack.push(node)
    } else if (token.type === 'else') {
      const top = stack[stack.length - 1]
      if (top.type === 'block') {
        top.elseChildren = []
      }
    } else if (token.type === 'block_close') {
      stack.pop()
    }
  }
  return root
}

// ============ AST 渲染 ============

function _renderAst(node, context) {
  if (node.type === 'root') {
    return (node.children || []).map(c => _renderAst(c, context)).join('')
  }
  if (node.type === 'text') {
    return node.value
  }
  if (node.type === 'var') {
    const val = _resolvePath(node.name, context)
    if (val === null || val === undefined) return ''
    const str = typeof val === 'object' ? JSON.stringify(val) : String(val)
    return node.escape ? _escapeHtml(str) : str
  }
  if (node.type === 'block') {
    if (node.name === 'each') {
      const arr = _resolvePath(node.arg, context)
      if (!Array.isArray(arr) || arr.length === 0) {
        // 空数组走 else 分支（如果有）
        if (node.elseChildren) {
          return node.elseChildren.map(c => _renderAst(c, context)).join('')
        }
        return ''
      }
      return arr.map((item, index) => {
        const childContext = Object.assign(
          {},
          context,
          { this: item, '@index': index, '@key': index }
        )
        // 如果 item 是对象，把它的字段也铺平到上下文顶层（方便 {{title}} 直接访问）
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          Object.assign(childContext, item)
        }
        return node.children.map(c => _renderAst(c, childContext)).join('')
      }).join('')
    }
    if (node.name === 'if') {
      const cond = _resolvePath(node.arg, context)
      const truthy = !!cond && !(Array.isArray(cond) && cond.length === 0)
      const children = truthy ? node.children : (node.elseChildren || [])
      return children.map(c => _renderAst(c, context)).join('')
    }
  }
  return ''
}

// 解析路径，支持 {{obj.field.nested}}、{{this}}、{{@index}}
function _resolvePath(path, context) {
  if (!path) return undefined
  if (path === 'this') return context.this
  if (path === '@index') return context['@index']
  if (path === '@key') return context['@key']
  const parts = path.split('.')
  let val = context
  for (const p of parts) {
    if (val === null || val === undefined) return undefined
    val = val[p]
  }
  return val
}

function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
