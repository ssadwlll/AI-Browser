import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { FeaturePanelsWindow } from './components/FeaturePanels.jsx'
import ConversationViewerWindow from './components/ConversationViewerWindow.jsx'
import ReportWindow from './components/ReportWindow.jsx'
import SidebarWindow from './components/SidebarWindow.jsx'
import './styles/main.css'

// 根据 URL query 参数判断渲染哪个根组件
// ?window=feature-panels → 内置工具浮动窗口
// ?window=conversation → 全景对话窗口
// ?window=report → 数据报告窗口
// ?window=sidebar → 侧边栏分离窗口
// 其他 → 主应用
const params = new URLSearchParams(window.location.search)
const windowType = params.get('window')

if (windowType === 'feature-panels') {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <FeaturePanelsWindow />
    </React.StrictMode>
  )
} else if (windowType === 'conversation') {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <ConversationViewerWindow />
    </React.StrictMode>
  )
} else if (windowType === 'report') {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <ReportWindow />
    </React.StrictMode>
  )
} else if (windowType === 'sidebar') {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <SidebarWindow />
    </React.StrictMode>
  )
} else {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
