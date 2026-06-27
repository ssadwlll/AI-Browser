import React, { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'

// 工具名称映射为中文
const TOOL_LABELS = {
  collect_page_context: '收集页面信息',
  execute_js: '执行JS代码',
  get_network_requests: '获取网络请求',
  navigate_to: '导航页面',
  extract_page_scripts: '提取页面脚本',
  get_page_html: '获取页面HTML',
  screenshot: '页面截图',
  click_element: '点击元素',
  wait_for_element: '等待元素',
  wait_for_navigation: '等待导航',
  open_new_tab: '打开新标签',
  close_current_tab: '关闭标签',
  extract_images: '提取图片',
  extract_links: '提取链接',
  scroll_to_element: '滚动到元素',
  hover_element: '悬停元素',
  scroll_page: '滚动页面',
  select_option: '选择下拉选项',
  upload_file: '上传文件',
  get_element_text: '获取元素文本',
  get_element_attribute: '获取元素属性',
  drag_and_drop: '拖拽',
}

const SESSIONS_KEY = 'ai-browser-sessions'
const SAVED_SCRIPTS_KEY = 'ai-browser-scripts'

// 会话管理
function loadSessions() {
  try {
    const data = localStorage.getItem(SESSIONS_KEY)
    return data ? JSON.parse(data) : []
  } catch { return [] }
}

function saveSessions(sessions) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
}

function createSessionId() {
  return 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8)
}

// 已保存的脚本管理
function loadSavedScripts() {
  try {
    const data = localStorage.getItem(SAVED_SCRIPTS_KEY)
    return data ? JSON.parse(data) : []
  } catch { return [] }
}

function saveSavedScripts(scripts) {
  localStorage.setItem(SAVED_SCRIPTS_KEY, JSON.stringify(scripts))
}

export default function UnifiedPanel({ config }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessions, setSessions] = useState(() => loadSessions())
  const [activeSessionId, setActiveSessionId] = useState(null)
  const [showSessionList, setShowSessionList] = useState(false)
  const [savedScripts, setSavedScripts] = useState(() => loadSavedScripts())
  const [showSavedScripts, setShowSavedScripts] = useState(false)
  const [showScriptCenter, setShowScriptCenter] = useState(false)
  const [scriptCenterList, setScriptCenterList] = useState([])
  const [scriptCenterLoading, setScriptCenterLoading] = useState(false)
  const [scriptCenterPage, setScriptCenterPage] = useState(1)
  const [autoInjectScripts, setAutoInjectScripts] = useState([])
  const [showAutoInject, setShowAutoInject] = useState(false)
  const [modal, setModal] = useState(null) // {title, message, defaultValue, placeholder, resolve}
  const messagesEndRef = useRef(null)
  const nextIdRef = useRef(1)
  const chatHistoryRef = useRef([]) // 发送给AI的对话历史
  const currentStreamMsgIdRef = useRef(null)

  // 加载自动注入脚本
  useEffect(() => {
    window.api.action.getAutoInjectScripts().then(res => {
      if (res.success) setAutoInjectScripts(res.scripts)
    })
    // 监听自动注入执行结果
    const unsubscribe = window.api.action.onAutoInjectExecuted((data) => {
      const injected = data.results.filter(r => r.success).length
      const failed = data.results.filter(r => !r.success).length
      if (injected > 0) {
        addMessage({ role: 'system', type: 'tool_call', content: `自动注入: ${injected}个脚本执行成功${failed > 0 ? `, ${failed}个失败` : ''} (${data.url})` })
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // 添加消息
  const addMessage = useCallback((msg) => {
    const id = nextIdRef.current++
    setMessages(prev => [...prev, { id, timestamp: Date.now(), ...msg }])
    return id
  }, [])

  // 更新消息
  const updateMessage = useCallback((id, updates) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...updates } : m))
  }, [])

  // ============ 会话管理 ============

  // 保存当前会话
  const saveCurrentSession = useCallback(() => {
    if (!activeSessionId || messages.length === 0) return

    setSessions(prev => {
      const idx = prev.findIndex(s => s.id === activeSessionId)

      // 从消息中重建对话历史（用于发送给AI）
      const chatHistory = []
      for (const m of messages) {
        if (m.role === 'user') {
          chatHistory.push({ role: 'user', content: m.content })
        } else if (m.role === 'assistant' && m.type === 'reply' && m.content) {
          chatHistory.push({ role: 'assistant', content: m.content })
        }
      }

      const sessionData = {
        id: activeSessionId,
        title: messages.find(m => m.role === 'user')?.content?.substring(0, 40) || '新会话',
        messages: messages.map(({ role, type, content, jsCode, toolName, success, error, result, description }) =>
          ({ role, type, content, jsCode, toolName, success, error, result, description })
        ),
        chatHistory,
        updatedAt: Date.now(),
        messageCount: messages.length,
      }

      let newSessions
      if (idx >= 0) {
        newSessions = [...prev]
        newSessions[idx] = sessionData
      } else {
        newSessions = [sessionData, ...prev]
      }
      saveSessions(newSessions)
      return newSessions
    })
  }, [activeSessionId, messages])

  // 自动保存
  useEffect(() => {
    if (activeSessionId && messages.length > 0) {
      saveCurrentSession()
    }
  }, [messages, activeSessionId, saveCurrentSession])

  // 新建会话
  const handleNewSession = useCallback(() => {
    // 先保存当前会话
    if (activeSessionId) saveCurrentSession()

    const newId = createSessionId()
    setMessages([])
    chatHistoryRef.current = []
    nextIdRef.current = 1
    setActiveSessionId(newId)
    setShowSessionList(false)
  }, [activeSessionId, saveCurrentSession])

  // 切换会话
  const handleSwitchSession = useCallback((session) => {
    if (activeSessionId) saveCurrentSession()

    setActiveSessionId(session.id)
    setMessages(session.messages || [])
    chatHistoryRef.current = session.chatHistory || []
    nextIdRef.current = (session.messages || []).length + 1
    setShowSessionList(false)
  }, [activeSessionId, saveCurrentSession])

  // 删除会话
  const handleDeleteSession = useCallback((sessionId, e) => {
    e.stopPropagation()
    setSessions(prev => {
      const newSessions = prev.filter(s => s.id !== sessionId)
      saveSessions(newSessions)
      return newSessions
    })
    if (sessionId === activeSessionId) {
      handleNewSession()
    }
  }, [activeSessionId, handleNewSession])

  // ============ 统一AI事件监听 ============

  const handleThinking = useCallback((data) => {
    addMessage({
      role: 'system', type: 'thinking',
      content: `AI正在思考... (第 ${data.round} 轮)`,
    })
  }, [addMessage])

  const handleStreamChunk = useCallback((data) => {
    const msgId = currentStreamMsgIdRef.current
    if (!msgId) return
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId) return m
      return { ...m, content: m.content + data.chunk }
    }))
  }, [])

  const handleToolCall = useCallback((data) => {
    addMessage({
      role: 'system', type: 'tool_call',
      content: `调用工具: ${TOOL_LABELS[data.toolName] || data.toolName}`,
      toolName: data.toolName,
      toolArgs: data.toolArgs,
      round: data.round,
    })
  }, [addMessage])

  const handleToolResult = useCallback((data) => {
    const label = TOOL_LABELS[data.toolName] || data.toolName
    if (data.toolName === 'execute_js' && data.toolArgs?.code) {
      addMessage({
        role: 'assistant', type: 'tool_execute',
        content: data.success ? `${label}成功` : `${label}失败`,
        jsCode: data.toolArgs.code,
        result: data.result,
        error: data.error,
        description: data.description,
        round: data.round,
      })
    } else {
      addMessage({
        role: 'system', type: 'tool_result',
        content: data.success
          ? `${label}完成${data.result?.url ? ` - ${data.result.url}` : ''}${data.result?.title ? ` (${data.result.title})` : ''}`
          : `${label}失败: ${data.error || '未知错误'}`,
        toolName: data.toolName,
        success: data.success,
        result: data.result,
        round: data.round,
      })
    }
  }, [addMessage])

  const handleFinalReply = useCallback((data) => {
    const msgId = addMessage({
      role: 'assistant', type: 'reply',
      content: data.content || '',
    })
    currentStreamMsgIdRef.current = msgId
    // 将AI实际回复加入对话历史
    if (data.content) {
      chatHistoryRef.current.push({ role: 'assistant', content: data.content })
    }
  }, [addMessage])

  const handleDone = useCallback((data) => {
    setLoading(false)
    currentStreamMsgIdRef.current = null
    if (!data.success && data.error) {
      addMessage({
        role: 'assistant', type: 'error',
        content: `任务失败: ${data.error}`,
      })
    }
  }, [addMessage])

  useEffect(() => {
    const unsub1 = window.api.unified.onThinking(handleThinking)
    const unsub2 = window.api.unified.onStreamChunk(handleStreamChunk)
    const unsub3 = window.api.unified.onToolCall(handleToolCall)
    const unsub4 = window.api.unified.onToolResult(handleToolResult)
    const unsub5 = window.api.unified.onFinalReply(handleFinalReply)
    const unsub6 = window.api.unified.onDone(handleDone)
    return () => {
      unsub1()
      unsub2()
      unsub3()
      unsub4()
      unsub5()
      unsub6()
    }
  }, [handleThinking, handleStreamChunk, handleToolCall, handleToolResult, handleFinalReply, handleDone])

  // ============ 发送消息 ============

  const handleSend = async () => {
    const userMsg = input.trim()
    if (!userMsg || loading) return

    // 如果没有活跃会话，自动创建
    if (!activeSessionId) {
      setActiveSessionId(createSessionId())
    }

    setInput('')
    addMessage({ role: 'user', content: userMsg })
    setLoading(true)

    chatHistoryRef.current.push({ role: 'user', content: userMsg })

    try {
      const result = await window.api.unified.chatStream(
        chatHistoryRef.current,
        config,
        config.maxToolRounds || 20,
      )
      
      // 检查返回结果
      if (result && result.success === false) {
        addMessage({ 
          role: 'assistant', 
          type: 'error', 
          content: `错误: ${result.error || result.summary || '未知错误'}` 
        })
      }
    } catch (e) {
      addMessage({ role: 'assistant', type: 'error', content: `错误: ${e.message || '请求失败'}` })
    } finally {
      // 确保 loading 状态被重置
      setLoading(false)
    }
  }

  // 重新执行JS代码
  const handleReExecute = async (jsCode) => {
    if (!jsCode.trim() || loading) return

    setLoading(true)
    addMessage({ role: 'system', type: 'tool_call', content: '重新执行JS代码' })

    try {
      const result = await window.api.action.executeJs(jsCode)
      addMessage({
        role: 'assistant', type: 'tool_execute',
        content: result.success ? '代码重新执行成功' : '代码重新执行失败',
        jsCode,
        result: result.result,
        error: result.success ? null : result.error,
      })
    } catch (e) {
      addMessage({
        role: 'assistant', type: 'error',
        content: `代码执行异常: ${e.message}`,
      })
    } finally {
      setLoading(false)
    }
  }

  // 重新注入JS代码（先执行，然后将结果反馈给AI）
  const handleReInject = async (jsCode) => {
    if (!jsCode.trim() || loading) return

    setLoading(true)
    addMessage({ role: 'system', type: 'tool_call', content: '重新注入JS代码' })

    try {
      const result = await window.api.action.executeJs(jsCode)
      const resultMsg = result.success
        ? result.result?.message || '代码执行成功'
        : `执行失败: ${result.error || '未知错误'}`

      addMessage({
        role: 'assistant', type: 'tool_execute',
        content: resultMsg,
        jsCode,
        result: result.result,
        error: result.success ? null : result.error,
      })

      // 将结果反馈给AI继续对话
      chatHistoryRef.current.push({
        role: 'user',
        content: `我重新执行了以下代码:\n\`\`\`javascript\n${jsCode}\n\`\`\`\n\n执行结果: ${resultMsg}${result.result?.data ? '\n返回数据: ' + JSON.stringify(result.result.data) : ''}\n\n请根据结果继续任务。`,
      })
      addMessage({ role: 'user', content: `已重新注入代码并反馈结果给AI` })
    } catch (e) {
      addMessage({
        role: 'assistant', type: 'error',
        content: `代码执行异常: ${e.message}`,
      })
    } finally {
      setLoading(false)
    }
  }

  // 保存JS代码（弹窗输入名称和描述）
  const handleSaveScript = async (jsCode) => {
    if (!jsCode.trim()) return

    // 使用双字段弹窗，一次性输入名称和描述
    const result = await showSaveModal(jsCode.trim().substring(0, 40).replace(/\n/g, ' '))
    if (!result) return

    const newScript = {
      id: 'script_' + Date.now(),
      name: result.name || jsCode.trim().substring(0, 30).replace(/\n/g, ' '),
      description: result.description || '',
      code: jsCode,
      savedAt: Date.now(),
    }

    setSavedScripts(prev => {
      const updated = [newScript, ...prev]
      saveSavedScripts(updated)
      return updated
    })
    addMessage({ role: 'system', type: 'tool_call', content: `脚本 "${newScript.name}" 已保存到本地脚本库` })
  }

  // 删除已保存的脚本
  const handleDeleteScript = (scriptId) => {
    setSavedScripts(prev => {
      const updated = prev.filter(s => s.id !== scriptId)
      saveSavedScripts(updated)
      return updated
    })
  }

  // 自定义弹窗（替代 Electron 中不支持的 prompt()）
  const showModal = (title, message, defaultValue = '') => {
    return new Promise((resolve) => {
      setModal({ type: 'single', title, message, defaultValue, placeholder: '', value: defaultValue, resolve })
    })
  }

  // 保存脚本专用弹窗（名称+描述双字段）
  const showSaveModal = (defaultName) => {
    return new Promise((resolve) => {
      setModal({
        type: 'save',
        title: '保存脚本',
        nameValue: defaultName,
        descValue: '',
        resolve,
      })
    })
  }

  // 上传脚本专用弹窗（名称+描述双字段）
  const showUploadModal = (defaultName, defaultDesc) => {
    return new Promise((resolve) => {
      setModal({
        type: 'upload',
        title: '上传脚本到管理后台',
        nameValue: defaultName,
        descValue: defaultDesc || '',
        resolve,
      })
    })
  }

  // 添加为自动注入脚本（页面加载后自动执行）
  const handleAddAutoInject = async (jsCode, scriptName) => {
    const urlPattern = await showModal('自动注入设置', '请输入URL匹配模式（* 匹配所有页面，如 *example.com* 匹配指定域名）', '*')
    if (urlPattern === null) return

    const res = await window.api.action.addAutoInject(scriptName || '自动注入脚本', jsCode, urlPattern)
    if (res.success) {
      setAutoInjectScripts(prev => [...prev, res.script])
      addMessage({ role: 'system', type: 'tool_call', content: `已添加自动注入脚本: ${res.script.name} (匹配: ${urlPattern})` })
    }
  }

  // 切换自动注入脚本启用状态
  const handleToggleAutoInject = async (scriptId) => {
    const res = await window.api.action.toggleAutoInject(scriptId)
    if (res.success) {
      setAutoInjectScripts(prev => prev.map(s => s.id === scriptId ? { ...s, enabled: res.script.enabled } : s))
    }
  }

  // 删除自动注入脚本
  const handleRemoveAutoInject = async (scriptId) => {
    const res = await window.api.action.removeAutoInject(scriptId)
    if (res.success) {
      setAutoInjectScripts(prev => prev.filter(s => s.id !== scriptId))
    }
  }

  // 立即执行所有自动注入脚本
  const handleRunAutoInjectNow = async () => {
    const res = await window.api.action.runAutoInject()
    if (res.success) {
      const ok = res.results.filter(r => r.success).length
      const fail = res.results.filter(r => !r.success).length
      addMessage({ role: 'system', type: 'tool_call', content: `手动触发自动注入: ${ok}个成功${fail > 0 ? `, ${fail}个失败` : ''}` })
    }
  }

  // 上传脚本到管理后台
  const handleUploadToServer = async (jsCode, scriptName, scriptDescription) => {
    if (!jsCode.trim() || loading) return

    const serverUrl = config.adminServerUrl || ''
    const token = config.adminToken || ''

    if (!serverUrl || !token) {
      addMessage({
        role: 'assistant', type: 'error',
        content: '请先在设置中配置管理后台地址和 Token。\n\n获取 Token 方式：\n1. 访问管理后台 ' + (serverUrl || 'http://localhost:3001') + '\n2. 登录（默认账号 admin/admin123）\n3. 获取返回的 Token 填入设置',
      })
      return
    }

    let name, description
    if (scriptName) {
      name = scriptName
      description = scriptDescription || ''
    } else {
      const result = await showUploadModal(jsCode.trim().substring(0, 40).replace(/\n/g, ' '), '')
      if (!result) return
      name = result.name
      description = result.description || ''
    }

    setLoading(true)
    addMessage({ role: 'system', type: 'tool_call', content: `正在上传脚本到管理后台: ${name}` })

    try {
      const result = await window.api.admin.uploadScript({
        serverUrl, token, name,
        code: jsCode,
        description: description || '从 AI Browser 客户端上传',
        categoryId: 1,
      })
      if (result.success) {
        addMessage({
          role: 'assistant', type: 'tool_execute',
          content: `脚本 "${name}" 已成功上传到管理后台脚本中心！`,
          jsCode,
        })
      } else {
        addMessage({
          role: 'assistant', type: 'error',
          content: `上传失败: ${result.error || result.data?.error || '未知错误'}`,
        })
      }
    } catch (e) {
      addMessage({
        role: 'assistant', type: 'error',
        content: `上传异常: ${e.message}`,
      })
    } finally {
      setLoading(false)
    }
  }

  // 注入已保存的脚本
  const handleInjectSaved = async (script) => {
    if (loading) return
    setShowSavedScripts(false)

    setLoading(true)
    addMessage({ role: 'system', type: 'tool_call', content: `注入已保存脚本: ${script.name}` })

    try {
      const result = await window.api.action.executeJs(script.code)
      const resultMsg = result.success
        ? result.result?.message || '代码执行成功'
        : `执行失败: ${result.error || '未知错误'}`

      addMessage({
        role: 'assistant', type: 'tool_execute',
        content: resultMsg,
        jsCode: script.code,
        result: result.result,
        error: result.success ? null : result.error,
      })

      chatHistoryRef.current.push({
        role: 'user',
        content: `我执行了保存的脚本 "${script.name}":\n\`\`\`javascript\n${script.code}\n\`\`\`\n\n执行结果: ${resultMsg}${result.result?.data ? '\n返回数据: ' + JSON.stringify(result.result.data) : ''}\n\n请根据结果继续任务。`,
      })
      addMessage({ role: 'user', content: `已注入脚本 "${script.name}" 并反馈结果给AI` })
    } catch (e) {
      addMessage({
        role: 'assistant', type: 'error',
        content: `脚本执行异常: ${e.message}`,
      })
    } finally {
      setLoading(false)
    }
  }

  // 中止
  const handleAbort = async () => {
    await window.api.unified.abort()
  }

  // ============ 脚本中心 ============
  const loadScriptCenter = async (page) => {
    const serverUrl = config.adminServerUrl || ''
    const tk = config.adminToken || ''
    if (!serverUrl || !tk) {
      addMessage({ role: 'assistant', type: 'error', content: '请先在设置中配置管理后台地址和 Token' })
      return
    }
    setScriptCenterLoading(true)
    setScriptCenterPage(page || 1)
    try {
      const result = await window.api.admin.getScripts({ serverUrl, token: tk, page: page || 1 })
      if (result.success && result.data) {
        setScriptCenterList(Array.isArray(result.data) ? result.data : [])
      } else {
        addMessage({ role: 'assistant', type: 'error', content: `加载脚本中心失败: ${result.error || '未知错误'}` })
      }
    } catch (e) {
      addMessage({ role: 'assistant', type: 'error', content: `加载脚本中心异常: ${e.message}` })
    } finally {
      setScriptCenterLoading(false)
    }
  }

  // 安装脚本到油猴 (Tampermonkey)
  const handleInstallToTampermonkey = (serverScript) => {
    const serverUrl = config.adminServerUrl || ''
    if (!serverUrl) {
      addMessage({ role: 'assistant', type: 'error', content: '请先在设置中配置管理后台地址' })
      return
    }
    const userjsUrl = serverUrl.replace(/\/+$/, '') + '/api/scripts/' + serverScript.id + '/userjs'
    // 在系统默认浏览器中打开，油猴会自动识别 .user.js 并弹出安装提示
    window.api.action.openExternal(userjsUrl)
    addMessage({ role: 'system', type: 'tool_call', content: `已在浏览器中打开油猴安装页面: ${serverScript.name}` })
  }

  // 安装本地保存的脚本到油猴
  const handleInstallLocalToTampermonkey = async (script) => {
    try {
      const res = await window.api.action.installTampermonkey({
        name: script.name,
        description: script.description,
        code: script.code,
        urlPattern: '*',
      })
      if (res.success) {
        addMessage({ role: 'system', type: 'tool_call', content: `已在浏览器中打开油猴安装页面: ${script.name}` })
      } else {
        addMessage({ role: 'assistant', type: 'error', content: `油猴安装失败: ${res.error || '未知错误'}` })
      }
    } catch (e) {
      addMessage({ role: 'assistant', type: 'error', content: `油猴安装异常: ${e.message}` })
    }
  }

  // 从脚本中心获取注入代码（含参数注入和多模块合并）
  const fetchInjectCode = async (serverScript) => {
    const serverUrl = config.adminServerUrl || ''
    const tk = config.adminToken || ''
    const detailResult = await window.api.admin.getScriptDetail({ serverUrl, token: tk, id: serverScript.id })
    if (!detailResult.success || !detailResult.data) {
      addMessage({ role: 'assistant', type: 'error', content: `获取脚本详情失败: ${detailResult.error || '未知错误'}` })
      return null
    }
    const detail = detailResult.data.data || detailResult.data
    const code = detail.code || ''
    if (!code) {
      addMessage({ role: 'assistant', type: 'error', content: '脚本内容为空' })
      return null
    }
    return { code, urlPattern: detail.url_pattern || '*' }
  }

  // 从脚本中心下载脚本到本地
  const handleDownloadFromCenter = async (serverScript) => {
    try {
      const result = await fetchInjectCode(serverScript)
      if (!result) return
      const newScript = {
        id: 'script_' + Date.now(),
        name: serverScript.name,
        description: serverScript.description || '',
        code: result.code,
        savedAt: Date.now(),
      }
      setSavedScripts(prev => {
        const updated = [newScript, ...prev]
        saveSavedScripts(updated)
        return updated
      })
      addMessage({ role: 'system', type: 'tool_call', content: `脚本 "${serverScript.name}" 已从脚本中心下载到本地` })
    } catch (e) {
      addMessage({ role: 'assistant', type: 'error', content: `下载脚本异常: ${e.message}` })
    }
  }

  // 从脚本中心添加为自动注入脚本
  const handleAddAutoInjectFromCenter = async (serverScript) => {
    try {
      const result = await fetchInjectCode(serverScript)
      if (!result) return
      await handleAddAutoInject(result.code, serverScript.name)
    } catch (e) {
      addMessage({ role: 'assistant', type: 'error', content: `添加自动注入异常: ${e.message}` })
    }
  }

  // 清空当前会话消息
  const handleClear = () => {
    setMessages([])
    chatHistoryRef.current = []
    nextIdRef.current = 1
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ============ 渲染消息 ============

  const renderMessage = (msg) => {
    if (msg.role === 'system') {
      if (msg.type === 'thinking') {
        return (
          <div key={msg.id} className="msg-system thinking-msg">
            <span className="thinking-dot" />
            <span>{msg.content}</span>
          </div>
        )
      }
      if (msg.type === 'tool_call') {
        return (
          <div key={msg.id} className="msg-system tool-call-msg">
            <span className="tool-icon">⚡</span>
            <span>{msg.content}</span>
          </div>
        )
      }
      if (msg.type === 'tool_result') {
        if (msg.toolName === 'collect_page_context' && msg.success) {
          return (
            <div key={msg.id} className="msg-system tool-result-msg">
              <span className="tool-icon">📄</span>
              <span>{msg.content}</span>
              {msg.result?.domSummary && (
                <details className="context-details">
                  <summary>查看页面结构 ({msg.result.domSummary.length} 个元素)</summary>
                  <pre className="code-preview">{JSON.stringify(msg.result.domSummary.slice(0, 30), null, 2)}</pre>
                </details>
              )}
            </div>
          )
        }
        if (msg.toolName === 'get_network_requests' && msg.success) {
          return (
            <div key={msg.id} className="msg-system tool-result-msg">
              <span className="tool-icon">🌐</span>
              <span>{msg.content}</span>
              {msg.result?.requests && msg.result.requests.length > 0 && (
                <details className="context-details">
                  <summary>查看请求列表 ({msg.result.requests.length} 条)</summary>
                  <pre className="code-preview">{JSON.stringify(msg.result.requests.slice(0, 10), null, 2)}</pre>
                </details>
              )}
            </div>
          )
        }
        return (
          <div key={msg.id} className="msg-system tool-result-msg">
            <span className="tool-icon">{msg.success ? '✓' : '✗'}</span>
            <span>{msg.content}</span>
          </div>
        )
      }
      return (
        <div key={msg.id} className="msg-system">
          <span className="msg-system-icon">ℹ</span>
          <span>{msg.content}</span>
        </div>
      )
    }

    if (msg.role === 'user') {
      return (
        <div key={msg.id} className="msg-user">
          <div className="msg-content">{msg.content}</div>
        </div>
      )
    }

    if (msg.type === 'error') {
      return (
        <div key={msg.id} className="msg-error">
          <span className="msg-error-icon">✗</span>
          <span>{msg.content}</span>
        </div>
      )
    }

    if (msg.type === 'tool_execute') {
      return (
        <div key={msg.id} className="msg-action">
          <div className={`round-result-inline ${msg.error ? 'error' : 'success'}`}>
            <span>{msg.error ? '✗' : '✓'}</span>
            <span>{msg.error || msg.result?.message || msg.content}</span>
          </div>
          {msg.jsCode && (
            <div className="code-block-with-replay">
              <div className="code-block-header">
                <span className="code-block-label">执行的代码</span>
                <div className="code-block-actions">
                  <button
                    className="code-replay-btn"
                    onClick={() => handleReExecute(msg.jsCode)}
                    disabled={loading}
                    title="重新执行这段代码"
                  >
                    重新执行
                  </button>
                  <button
                    className="code-replay-btn code-replay-inject"
                    onClick={() => handleReInject(msg.jsCode)}
                    disabled={loading}
                    title="重新注入并反馈结果给AI继续对话"
                  >
                    重新注入
                  </button>
                  <button
                    className="code-replay-btn code-replay-save"
                    onClick={() => handleSaveScript(msg.jsCode)}
                    title="保存代码到脚本库"
                  >
                    保存代码
                  </button>
                  <button
                    className="code-replay-btn code-replay-auto"
                    onClick={() => handleAddAutoInject(msg.jsCode, msg.content?.substring(0, 30))}
                    title="设为自动注入脚本（页面刷新后自动执行）"
                  >
                    自动注入
                  </button>
                </div>
              </div>
              <pre className="code-preview">{msg.jsCode}</pre>
            </div>
          )}
          {msg.result?.data && (
            <details className="data-details">
              <summary>查看返回数据</summary>
              <pre>{JSON.stringify(msg.result.data, null, 2)}</pre>
            </details>
          )}
        </div>
      )
    }

    if (msg.type === 'reply') {
      const codeComponents = {
        pre({ node, children, ...props }) {
          const codeEl = children?.props?.children
          const codeText = String(codeEl).replace(/\n$/, '')
          const className = children?.props?.className || ''
          const match = /language-(\w+)/.exec(className)
          const language = match ? match[1] : ''
          const langLabel = language ? language.charAt(0).toUpperCase() + language.slice(1) : '代码'
          const isJS = language === 'javascript' || language === 'js'
          return (
            <div className="code-block-inline">
              <div className="code-block-header">
                <span className="code-block-label">{langLabel}</span>
                <div className="code-block-actions">
                  {isJS && (
                    <>
                      <button className="code-replay-btn" onClick={() => handleReExecute(codeText)} disabled={loading} title="在当前页面重新执行这段代码">重新执行</button>
                      <button className="code-replay-btn code-replay-inject" onClick={() => handleReInject(codeText)} disabled={loading} title="执行代码并将结果反馈给AI继续对话">重新注入</button>
                    </>
                  )}
                  <button className="code-replay-btn code-replay-save" onClick={() => handleSaveScript(codeText)} title="保存到本地脚本库">保存代码</button>
                  <button className="code-replay-btn code-replay-auto" onClick={() => handleAddAutoInject(codeText, codeText.substring(0, 30))} title="页面刷新后自动执行">自动注入</button>
                </div>
              </div>
              <pre className="code-preview">{codeText}</pre>
            </div>
          )
        },
        code({ node, inline, className, children, ...props }) {
          if (!inline) {
            return <code className={className} {...props}>{children}</code>
          }
          return <code className={className} {...props}>{children}</code>
        },
      }
      return (
        <div key={msg.id} className="msg-assistant">
          <div className="msg-markdown">
            <ReactMarkdown components={codeComponents}>{msg.content}</ReactMarkdown>
          </div>
        </div>
      )
    }

    return (
      <div key={msg.id} className="msg-assistant">
        <div className="msg-markdown">
          <ReactMarkdown>{msg.content || ''}</ReactMarkdown>
        </div>
      </div>
    )
  }

  return (
    <div className="unified-panel">
      {/* 工具栏 */}
      <div className="unified-toolbar">
        <div className="toolbar-left">
          <button className="toolbar-btn" onClick={handleNewSession} title="新建会话">
            + 新会话
          </button>
          <button className="toolbar-btn" onClick={() => setShowSessionList(!showSessionList)} title="历史会话">
            历史 ({sessions.length})
          </button>
          <button className="toolbar-btn" onClick={() => setShowSavedScripts(!showSavedScripts)} title="已保存的脚本">
            脚本 ({savedScripts.length})
          </button>
          <button className="toolbar-btn" onClick={() => { setShowScriptCenter(!showScriptCenter); if (!showScriptCenter) loadScriptCenter(1) }} title="从后台脚本中心浏览和下载脚本">
            脚本中心
          </button>
          <button className="toolbar-btn" onClick={() => setShowAutoInject(!showAutoInject)} title="自动注入脚本（页面刷新后自动执行）">
            自动注入 ({autoInjectScripts.length})
          </button>
          {loading && (
            <button className="toolbar-btn stop-btn" onClick={handleAbort}>
              停止
            </button>
          )}
        </div>
        <div className="toolbar-right">
          <button className="toolbar-btn" onClick={handleClear} title="清空当前对话">
            清空
          </button>
        </div>
      </div>

      {/* 会话列表 */}
      {showSessionList && (
        <div className="session-list">
          {sessions.length === 0 && (
            <div className="session-empty">暂无历史会话</div>
          )}
          {sessions.map(s => (
            <div
              key={s.id}
              className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
              onClick={() => handleSwitchSession(s)}
            >
              <div className="session-item-title">{s.title}</div>
              <div className="session-item-meta">
                <span>{new Date(s.updatedAt).toLocaleString()}</span>
                <span>{s.messageCount || 0} 条消息</span>
              </div>
              <button
                className="session-delete-btn"
                onClick={(e) => handleDeleteSession(s.id, e)}
                title="删除会话"
              >
                ✗
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 已保存的脚本列表 */}
      {showSavedScripts && (
        <div className="session-list">
          <div className="session-list-header">
            <span>已保存的脚本 ({savedScripts.length})</span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              点击注入到页面并反馈给AI
            </span>
          </div>
          {savedScripts.length === 0 && (
            <div className="session-empty">暂无保存的脚本，在AI生成的代码块中点击"保存代码"即可保存</div>
          )}
          {savedScripts.map(script => (
            <div
              key={script.id}
              className="session-item script-item"
              onClick={() => handleInjectSaved(script)}
            >
              <div className="session-item-title">{script.name}</div>
              {script.description && (
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{script.description}</div>
              )}
              <div className="session-item-meta">
                <span>{new Date(script.savedAt).toLocaleString()}</span>
                <span>{script.code.length} 字符</span>
              </div>
              <div style={{ display: 'flex', gap: '4px', marginTop: 4 }}>
                <button
                  style={{ background: '#76b900', color: '#fff', fontSize: 11, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer' }}
                  onClick={(e) => { e.stopPropagation(); handleInstallLocalToTampermonkey(script) }}
                  title="安装到油猴 (Tampermonkey)"
                >
                  安装到油猴
                </button>
                <button
                  style={{ background: '#ec4899', color: '#fff', fontSize: 11, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer' }}
                  onClick={(e) => { e.stopPropagation(); handleUploadToServer(script.code, script.name, script.description) }}
                  title="上传到管理后台"
                >
                  上传
                </button>
                <button
                  style={{ background: '#ef4444', color: '#fff', fontSize: 11, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer' }}
                  onClick={(e) => { e.stopPropagation(); if (confirm('确定删除脚本 "' + script.name + '" 吗？')) handleDeleteScript(script.id) }}
                  title="删除脚本"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 脚本中心 */}
      {showScriptCenter && (
        <div className="session-list">
          <div className="session-list-header">
            <span>脚本中心（来自管理后台）</span>
            <button style={{ fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }} onClick={() => loadScriptCenter(scriptCenterPage)}>
              刷新
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '0 12px 8px' }}>
            从管理后台下载脚本到本地使用
          </div>
          {scriptCenterLoading && (
            <div className="session-empty">加载中...</div>
          )}
          {!scriptCenterLoading && scriptCenterList.length === 0 && (
            <div className="session-empty">暂无远程脚本，请确保管理后台已启动且有脚本数据</div>
          )}
          {!scriptCenterLoading && scriptCenterList.map(script => (
            <div key={script.id} className="session-item script-item">
              <div className="session-item-title">{script.name}</div>
              {script.description && (
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{script.description}</div>
              )}
              <div className="session-item-meta">
                <span>{script.category_name || '未分类'}</span>
                <span>v{script.version || '1.0.0'}</span>
                <span>下载 {script.download_count || 0} 次</span>
              </div>
              <div style={{ display: 'flex', gap: '4px', marginTop: 4 }}>
                <button
                  style={{ background: '#10b981', color: '#fff', fontSize: 11, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer' }}
                  onClick={() => handleDownloadFromCenter(script)}
                  title="下载到本地脚本库"
                >
                  下载到本地
                </button>
                <button
                  style={{ background: '#f59e0b', color: '#fff', fontSize: 11, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer' }}
                  onClick={() => handleAddAutoInjectFromCenter(script)}
                  title="添加为自动注入脚本（页面加载后自动执行）"
                >
                  自动注入
                </button>
                <button
                  style={{ background: '#76b900', color: '#fff', fontSize: 11, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer' }}
                  onClick={() => handleInstallToTampermonkey(script)}
                  title="安装到油猴 (Tampermonkey)"
                >
                  安装到油猴
                </button>
              </div>
            </div>
          ))}
          {!scriptCenterLoading && scriptCenterList.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '8px 12px', fontSize: 12, color: 'var(--text-secondary)' }}>
              <button style={{ padding: '4px 12px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', cursor: 'pointer', fontSize: 12 }} onClick={() => loadScriptCenter(scriptCenterPage - 1)} disabled={scriptCenterPage <= 1}>
                上一页
              </button>
              <span>第 {scriptCenterPage} 页</span>
              <button style={{ padding: '4px 12px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', cursor: 'pointer', fontSize: 12 }} onClick={() => loadScriptCenter(scriptCenterPage + 1)}>
                下一页
              </button>
            </div>
          )}
        </div>
      )}

      {/* 自动注入脚本列表 */}
      {showAutoInject && (
        <div className="session-list">
          <div className="session-list-header">
            <span>自动注入脚本 ({autoInjectScripts.length})</span>
            <button
              className="toolbar-btn"
              style={{ fontSize: 11, padding: '2px 8px' }}
              onClick={handleRunAutoInjectNow}
              title="立即执行所有自动注入脚本"
            >
              立即执行
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '0 12px 8px' }}>
            页面刷新或导航后自动执行匹配的脚本
          </div>
          {autoInjectScripts.length === 0 && (
            <div className="session-empty">暂无自动注入脚本，在AI生成的代码块中点击"自动注入"即可添加</div>
          )}
          {autoInjectScripts.map(script => (
            <div
              key={script.id}
              className={`session-item script-item ${!script.enabled ? 'disabled' : ''}`}
            >
              <div className="session-item-title" style={{ opacity: script.enabled ? 1 : 0.5 }}>
                {script.name}
              </div>
              <div className="session-item-meta">
                <span>匹配: {script.urlPattern}</span>
                <span>已注入 {script.injectCount || 0} 次</span>
              </div>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  className="session-delete-btn"
                  style={{ background: script.enabled ? 'var(--success)' : 'var(--text-secondary)' }}
                  onClick={(e) => { e.stopPropagation(); handleToggleAutoInject(script.id) }}
                  title={script.enabled ? '点击禁用' : '点击启用'}
                >
                  {script.enabled ? '●' : '○'}
                </button>
                <button
                  className="session-delete-btn"
                  onClick={(e) => { e.stopPropagation(); handleRemoveAutoInject(script.id) }}
                  title="删除"
                >
                  ✗
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 消息区 */}
      <div className="unified-messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <div style={{ fontSize: 28, marginBottom: 8 }}>✦</div>
            <div>AI 浏览器助手</div>
            <div style={{ fontSize: 11, marginTop: 4, color: 'var(--text-secondary)' }}>
              AI自主决策 · 工具调用 · 对话即操作
            </div>
            <div className="empty-hints">
              <div className="hint-item" onClick={() => { setInput('分析当前页面的技术栈和API接口') }}>
                🔍 分析页面技术栈
              </div>
              <div className="hint-item" onClick={() => { setInput('抓取页面上所有数据，整理为JSON格式') }}>
                🤖 抓取页面数据
              </div>
              <div className="hint-item" onClick={() => { setInput('移除页面上的广告和弹窗') }}>
                ⚡ 去除广告弹窗
              </div>
              <div className="hint-item" onClick={() => { setInput('帮我看看这个页面有什么内容') }}>
                💬 了解页面内容
              </div>
            </div>
          </div>
        )}
        {messages.map((msg, i) => { const el = renderMessage(msg); return el.key ? el : React.cloneElement(el, { key: msg.id ?? `msg-${i}` }) })}
        {loading && messages.length > 0 && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="msg-assistant">
            <div className="loading-spinner" />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 输入区 */}
      <div className="unified-input-area">
        <div className="input-row">
          <textarea
            className="unified-input"
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px'
            }}
            onKeyDown={handleKeyDown}
            placeholder="输入问题或任务，AI自主决策调用工具..."
            rows={1}
            disabled={loading}
          />
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={loading || !input.trim()}
          >
            {loading ? '运行中' : '发送'}
          </button>
        </div>
      </div>

      {/* 自定义 Modal 弹窗（绝对定位在面板内，避免被 BrowserView 遮挡） */}
      {modal && (
        <div className="modal-overlay" onClick={() => { modal.resolve(null); setModal(null) }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{modal.title}</span>
              <button className="modal-close" onClick={() => { modal.resolve(null); setModal(null) }}>✕</button>
            </div>
            {modal.type === 'single' ? (
              <>
                <div className="modal-body">
                  <div className="modal-message">{modal.message}</div>
                  <input
                    className="modal-input"
                    type="text"
                    autoFocus
                    value={modal.value}
                    onChange={(e) => setModal({ ...modal, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { modal.resolve(modal.value); setModal(null) }
                      if (e.key === 'Escape') { modal.resolve(null); setModal(null) }
                    }}
                    placeholder={modal.placeholder}
                  />
                </div>
                <div className="modal-footer">
                  <button className="modal-btn modal-btn-cancel" onClick={() => { modal.resolve(null); setModal(null) }}>取消</button>
                  <button className="modal-btn modal-btn-confirm" onClick={() => { modal.resolve(modal.value); setModal(null) }}>确定</button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-body">
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>脚本名称</label>
                    <input
                      className="modal-input"
                      type="text"
                      autoFocus
                      value={modal.nameValue}
                      onChange={(e) => setModal({ ...modal, nameValue: e.target.value })}
                      placeholder="请输入脚本名称"
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>脚本描述（可选）</label>
                    <input
                      className="modal-input"
                      type="text"
                      value={modal.descValue}
                      onChange={(e) => setModal({ ...modal, descValue: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { modal.resolve({ name: modal.nameValue, description: modal.descValue }); setModal(null) }
                        if (e.key === 'Escape') { modal.resolve(null); setModal(null) }
                      }}
                      placeholder="请输入脚本描述"
                    />
                  </div>
                </div>
                <div className="modal-footer">
                  <button className="modal-btn modal-btn-cancel" onClick={() => { modal.resolve(null); setModal(null) }}>取消</button>
                  <button className="modal-btn modal-btn-confirm" onClick={() => { modal.resolve({ name: modal.nameValue, description: modal.descValue }); setModal(null) }}>
                    {modal.type === 'save' ? '保存' : '上传'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
