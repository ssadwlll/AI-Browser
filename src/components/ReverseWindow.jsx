import React, { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'

// ============ 样式（自包含，使用项目 CSS 变量并带回退） ============
const CSS_TEXT = `
.rw-window {
  width: 100vw; height: 100vh;
  display: flex; flex-direction: column;
  background: var(--bg-primary, #1a1a2e);
  color: var(--text-primary, #e0e0e0);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  overflow: hidden;
}
.rw-titlebar {
  height: 32px; display: flex; align-items: center; padding: 0 12px;
  background: var(--bg-secondary, #16213e);
  border-bottom: 1px solid var(--border, #2a2a4a);
  -webkit-app-region: drag; user-select: none;
}
.rw-title { flex: 1; font-weight: 600; font-size: 13px; }
.rw-title-actions { display: flex; gap: 8px; -webkit-app-region: no-drag; }
.rw-btn {
  padding: 4px 10px; border: 1px solid var(--border, #2a2a4a);
  background: var(--bg-tertiary, #0f3460); color: var(--text-primary, #e0e0e0);
  border-radius: 4px; cursor: pointer; font-size: 12px;
  transition: all 0.15s;
}
.rw-btn:hover { background: var(--accent, #00d4ff); color: #000; }
.rw-btn.primary { background: var(--accent, #00d4ff); color: #000; border-color: var(--accent, #00d4ff); }
.rw-btn.danger { color: var(--error, #f44336); }
.rw-btn.danger:hover { background: var(--error, #f44336); color: #fff; }
.rw-btn.close { padding: 4px 8px; min-width: 28px; }

.rw-toolbar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; background: var(--bg-secondary, #16213e);
  border-bottom: 1px solid var(--border, #2a2a4a); flex-wrap: wrap;
}
.rw-tabs { display: flex; gap: 2px; }
.rw-tab {
  padding: 6px 14px; cursor: pointer; border-radius: 4px 4px 0 0;
  border: 1px solid transparent; color: var(--text-secondary, #a0a0b0);
  font-size: 12px;
}
.rw-tab.active {
  background: var(--bg-primary, #1a1a2e); color: var(--accent, #00d4ff);
  border-color: var(--border, #2a2a4a); border-bottom-color: var(--bg-primary, #1a1a2e);
}
.rw-input {
  padding: 4px 8px; background: var(--bg-input, #1e1e3f);
  border: 1px solid var(--border, #2a2a4a); color: var(--text-primary, #e0e0e0);
  border-radius: 3px; font-size: 12px; min-width: 160px;
}
.rw-select {
  padding: 4px 8px; background: var(--bg-input, #1e1e3f);
  border: 1px solid var(--border, #2a2a4a); color: var(--text-primary, #e0e0e0);
  border-radius: 3px; font-size: 12px;
}
.rw-status {
  margin-left: auto; font-size: 11px; color: var(--text-secondary, #a0a0b0);
}
.rw-status.active { color: var(--success, #4caf50); }

.rw-main {
  flex: 1; display: flex; overflow: hidden;
}
.rw-split { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

/* 网络面板 */
.rw-net-list {
  width: 360px; border-right: 1px solid var(--border, #2a2a4a);
  overflow-y: auto; flex-shrink: 0;
}
.rw-net-item {
  padding: 6px 10px; border-bottom: 1px solid var(--border, #2a2a4a);
  cursor: pointer; font-size: 11px;
  display: flex; align-items: center; gap: 6px;
}
.rw-net-item:hover { background: var(--bg-secondary, #16213e); }
.rw-net-item.active { background: var(--bg-tertiary, #0f3460); border-left: 3px solid var(--accent, #00d4ff); }
.rw-net-method {
  font-size: 10px; padding: 1px 4px; border-radius: 2px; font-weight: 600;
  min-width: 36px; text-align: center;
}
.rw-net-method.GET { background: rgba(76,175,80,0.2); color: #4caf50; }
.rw-net-method.POST { background: rgba(255,152,0,0.2); color: #ff9800; }
.rw-net-method.PUT { background: rgba(33,150,243,0.2); color: #2196f3; }
.rw-net-method.DELETE { background: rgba(244,67,54,0.2); color: #f44336; }
.rw-net-url { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary, #e0e0e0); }
.rw-net-status { font-size: 10px; min-width: 28px; }
.rw-net-status.s2 { color: var(--success, #4caf50); }
.rw-net-status.s3, .rw-net-status.s4, .rw-net-status.s5 { color: var(--error, #f44336); }

.rw-detail {
  flex: 1; overflow-y: auto; padding: 12px;
}
.rw-detail-section {
  margin-bottom: 16px; border: 1px solid var(--border, #2a2a4a); border-radius: 4px;
}
.rw-detail-header {
  padding: 6px 10px; background: var(--bg-secondary, #16213e);
  font-weight: 600; font-size: 12px; cursor: pointer;
  display: flex; align-items: center; gap: 6px;
}
.rw-detail-body { padding: 8px 10px; font-family: 'Consolas', 'Monaco', monospace; font-size: 11px; }
.rw-detail-body pre {
  margin: 0; white-space: pre-wrap; word-break: break-all;
  max-height: 300px; overflow-y: auto;
}
.rw-key-val {
  display: flex; gap: 8px; padding: 2px 0;
  border-bottom: 1px solid var(--border, #2a2a4a);
}
.rw-key { color: var(--text-secondary, #a0a0b0); min-width: 120px; }
.rw-val { color: var(--text-primary, #e0e0e0); flex: 1; word-break: break-all; }

/* AI 分析面板 */
.rw-ai-panel { display: flex; flex-direction: column; height: 100%; }
.rw-ai-input {
  padding: 8px 12px; border-bottom: 1px solid var(--border, #2a2a4a);
  display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap;
}
.rw-ai-options {
  flex-basis: 100%; width: 100%; display: flex; gap: 12px; align-items: center;
  margin-bottom: 2px; font-size: 11px; color: var(--text-secondary, #a0a0b0);
}
.rw-ai-option { display: inline-flex; align-items: center; gap: 4px; }
.rw-ai-option input[type="number"] {
  width: 64px; padding: 2px 4px; background: var(--bg-input, #1e1e3f);
  border: 1px solid var(--border, #2a2a4a); color: var(--text-primary, #e0e0e0);
  border-radius: 3px; font-size: 11px; font-family: inherit;
}
.rw-ai-running-badge {
  color: var(--accent, #00d4ff); font-size: 11px;
  animation: rw-blink 1.5s infinite;
}
.rw-ai-textarea {
  flex: 1; min-height: 40px; max-height: 120px; resize: vertical;
  padding: 6px 8px; background: var(--bg-input, #1e1e3f);
  border: 1px solid var(--border, #2a2a4a); color: var(--text-primary, #e0e0e0);
  border-radius: 3px; font-size: 12px; font-family: inherit;
}
.rw-ai-messages { flex: 1; overflow-y: auto; padding: 8px 12px; }

/* 时间线容器 */
.rw-timeline { position: relative; }

/* 时间线项 */
.rw-tl-item {
  position: relative; padding-left: 28px; margin-bottom: 10px;
}
/* 左侧竖线 */
.rw-timeline::before {
  content: ''; position: absolute; left: 11px; top: 4px; bottom: 4px;
  width: 2px; background: var(--border, #2a2a4a);
}
/* 时间点圆点 */
.rw-tl-dot {
  position: absolute; left: 0; top: 2px;
  width: 24px; height: 24px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; z-index: 1;
  border: 2px solid var(--bg-primary, #1a1a2e);
}
.rw-tl-dot.user { background: #4caf50; }
.rw-tl-dot.thinking { background: #9c27b0; }
.rw-tl-dot.tool { background: #2196f3; }
.rw-tl-dot.tool.running { background: #ff9800; animation: rw-pulse 1.2s infinite; }
.rw-tl-dot.reply { background: #00bcd4; }
.rw-tl-dot.error { background: #f44336; }
.rw-tl-dot.status {
  background: transparent; border: none; color: var(--text-secondary, #a0a0b0);
  font-size: 20px; width: 24px; height: 16px;
}

/* 卡片 */
.rw-tl-card {
  background: var(--bg-secondary, #16213e);
  border: 1px solid var(--border, #2a2a4a);
  border-radius: 6px; overflow: hidden;
}
.rw-tl-header {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px; font-size: 11px;
  border-bottom: 1px solid var(--border, #2a2a4a);
  background: rgba(255,255,255,0.02);
}
.rw-tl-tag {
  padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600;
}
.rw-tl-tag.user { background: #4caf50; color: #fff; }
.rw-tl-tag.thinking { background: #9c27b0; color: #fff; }
.rw-tl-tag.tool { background: #2196f3; color: #fff; }
.rw-tl-tag.tool.running { background: #ff9800; color: #fff; }
.rw-tl-tag.reply { background: #00bcd4; color: #fff; }
.rw-tl-tag.error { background: #f44336; color: #fff; }
.rw-tl-toolname { font-weight: 600; color: var(--text-primary, #e0e0e0); }
.rw-tl-round { margin-left: auto; color: var(--text-secondary, #a0a0b0); font-size: 10px; }

/* 卡片内容 */
.rw-tl-body { padding: 6px 8px; font-size: 12px; }
.rw-tl-body.user {
  background: rgba(76, 175, 80, 0.08); color: var(--text-primary, #e0e0e0);
}
.rw-tl-body.thinking {
  background: rgba(156, 39, 176, 0.08); color: var(--text-primary, #e0e0e0);
}
.rw-tl-body.thinking p { margin: 4px 0; }
.rw-tl-body.tool {
  background: rgba(33, 150, 243, 0.06); font-family: monospace; font-size: 11px;
}
.rw-tl-body.reply {
  background: rgba(0, 188, 212, 0.08); color: var(--text-primary, #e0e0e0);
}
.rw-tl-body.reply p { margin: 6px 0; }
.rw-tl-body.reply pre {
  background: var(--bg-tertiary, #0f3460); padding: 8px; border-radius: 4px;
  overflow-x: auto; font-size: 11px;
}
.rw-tl-body.reply code {
  background: var(--bg-tertiary, #0f3460); padding: 1px 4px; border-radius: 2px;
  font-size: 11px;
}
.rw-tl-body.error {
  background: rgba(244, 67, 54, 0.1); color: #ff6b6b;
}

/* 思考展开按钮 */
.rw-tl-expand-btn {
  background: none; border: 1px solid var(--border, #2a2a4a);
  color: var(--accent, #00d4ff); padding: 2px 8px;
  border-radius: 3px; cursor: pointer; font-size: 10px;
  margin-top: 4px;
}
.rw-tl-expand-btn:hover { background: var(--accent, #00d4ff); color: #000; }

/* 工具参数/结果折叠区 */
.rw-tl-section {
  display: flex; align-items: flex-start; gap: 4px;
  padding: 2px 0; cursor: pointer;
}
.rw-tl-section:hover { background: rgba(255,255,255,0.03); }
.rw-tl-section-toggle {
  color: var(--text-secondary, #a0a0b0); font-size: 10px;
  margin-top: 2px; user-select: none;
}
.rw-tl-section-label {
  color: var(--text-secondary, #a0a0b0); font-size: 10px;
  min-width: 32px; margin-top: 2px;
}
.rw-tl-pre {
  flex: 1; margin: 0; white-space: pre-wrap; word-break: break-all;
  color: var(--text-primary, #e0e0e0); font-size: 11px;
  max-height: 300px; overflow-y: auto;
}
.rw-tl-pre.collapsed {
  max-height: 36px; overflow: hidden; text-overflow: ellipsis;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.rw-tl-running-hint {
  color: var(--accent, #00d4ff); font-size: 11px;
  padding: 2px 0; animation: rw-blink 1s infinite;
}

/* 状态提示（非卡片） */
.rw-tl-status {
  display: flex; align-items: center; gap: 6px;
  padding-left: 28px; margin-bottom: 6px;
}
.rw-tl-status-text {
  font-size: 11px; color: var(--text-secondary, #a0a0b0);
  font-style: italic;
}

.rw-ai-streaming {
  display: inline-block; width: 8px; height: 14px;
  background: var(--accent, #00d4ff); margin-left: 2px;
  animation: rw-blink 1s infinite;
}
@keyframes rw-blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
@keyframes rw-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 152, 0, 0.6); }
  50% { box-shadow: 0 0 0 6px rgba(255, 152, 0, 0); }
}

/* 脚本面板 */
.rw-script-item {
  padding: 6px 10px; border-bottom: 1px solid var(--border, #2a2a4a);
  cursor: pointer; font-size: 11px;
}
.rw-script-item:hover { background: var(--bg-secondary, #16213e); }
.rw-script-src { color: var(--accent, #00d4ff); word-break: break-all; }
.rw-script-code {
  font-family: monospace; font-size: 11px; white-space: pre-wrap;
  word-break: break-all; padding: 8px; max-height: 500px; overflow-y: auto;
  background: var(--bg-input, #1e1e3f);
}

/* 重放面板 */
.rw-replay-form { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.rw-replay-row { display: flex; gap: 8px; align-items: center; }
.rw-replay-label { min-width: 60px; font-size: 12px; color: var(--text-secondary, #a0a0b0); }
.rw-replay-input {
  flex: 1; padding: 4px 8px; background: var(--bg-input, #1e1e3f);
  border: 1px solid var(--border, #2a2a4a); color: var(--text-primary, #e0e0e0);
  border-radius: 3px; font-size: 12px;
}
.rw-replay-textarea {
  width: 100%; min-height: 60px; padding: 4px 8px;
  background: var(--bg-input, #1e1e3f); border: 1px solid var(--border, #2a2a4a);
  color: var(--text-primary, #e0e0e0); border-radius: 3px; font-size: 12px;
  font-family: monospace; resize: vertical;
}

/* Toast */
.rw-toast {
  position: fixed; bottom: 20px; right: 20px;
  padding: 8px 16px; background: var(--bg-tertiary, #0f3460);
  border: 1px solid var(--accent, #00d4ff); border-radius: 4px;
  font-size: 12px; z-index: 1000; animation: rw-fade-in 0.2s;
}
@keyframes rw-fade-in { from { opacity: 0; } to { opacity: 1; } }

/* JSON 查看器 */
.rw-json-node { margin-left: 16px; }
.rw-json-row {
  display: flex; align-items: flex-start; padding: 1px 0;
  border-radius: 2px; cursor: default; line-height: 1.5;
}
.rw-json-row:hover { background: rgba(255,255,255,0.04); }
.rw-json-toggle {
  cursor: pointer; user-select: none; min-width: 14px;
  color: var(--text-secondary, #a0a0b0); font-size: 10px;
  display: inline-flex; align-items: center; justify-content: center;
  margin-top: 2px;
}
.rw-json-toggle:hover { color: var(--accent, #00d4ff); }
.rw-json-key { color: #9cdcfe; margin-right: 4px; white-space: nowrap; }
.rw-json-colon { color: var(--text-secondary, #a0a0b0); margin-right: 6px; }
.rw-json-string { color: #ce9178; word-break: break-all; }
.rw-json-number { color: #b5cea8; }
.rw-json-boolean { color: #569cd6; }
.rw-json-null { color: #569cd6; font-style: italic; }
.rw-json-bracket { color: #ffd700; }
.rw-json-count { color: var(--text-secondary, #a0a0b0); font-size: 10px; margin-left: 4px; }
.rw-json-ellipsis { color: var(--text-secondary, #a0a0b0); cursor: pointer; font-style: italic; }
.rw-json-ellipsis:hover { color: var(--accent, #00d4ff); }
.rw-json-root { font-family: 'Consolas', 'Monaco', monospace; font-size: 12px; }
.rw-json-root > .rw-json-row { margin-left: 0; }

/* 搜索栏 */
.rw-search-bar {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 8px; background: var(--bg-input, #1e1e3f);
  border: 1px solid var(--border, #2a2a4a); border-radius: 4px;
}
.rw-search-bar input {
  flex: 1; border: none; background: transparent;
  color: var(--text-primary, #e0e0e0); font-size: 12px; outline: none;
  font-family: inherit;
}
.rw-search-bar input::placeholder { color: var(--text-secondary, #a0a0b0); }
.rw-search-count { font-size: 10px; color: var(--text-secondary, #a0a0b0); white-space: nowrap; }
.rw-search-nav {
  background: none; border: none; color: var(--text-secondary, #a0a0b0);
  cursor: pointer; padding: 0 2px; font-size: 12px; line-height: 1;
}
.rw-search-nav:hover { color: var(--accent, #00d4ff); }
.rw-search-highlight { background: rgba(255, 200, 0, 0.35); border-radius: 2px; }
.rw-search-highlight.active { background: rgba(255, 152, 0, 0.6); }

/* 复制按钮 */
.rw-copy-btn {
  padding: 2px 8px; border: 1px solid var(--border, #2a2a4a);
  background: var(--bg-input, #1e1e3f); color: var(--text-secondary, #a0a0b0);
  border-radius: 3px; cursor: pointer; font-size: 10px;
  transition: all 0.15s; margin-left: auto;
}
.rw-copy-btn:hover { color: var(--accent, #00d4ff); border-color: var(--accent, #00d4ff); }

/* 请求列表增强 */
.rw-net-item-info {
  display: flex; gap: 6px; font-size: 10px; color: var(--text-secondary, #a0a0b0);
  margin-top: 2px; padding-left: 42px;
}
.rw-net-time { color: var(--text-secondary, #a0a0b0); }
.rw-net-size { color: var(--text-secondary, #a0a0b0); }

/* 右键菜单 */
.rw-context-menu {
  position: fixed; z-index: 2000;
  background: var(--bg-secondary, #16213e);
  border: 1px solid var(--border, #2a2a4a);
  border-radius: 6px; padding: 4px 0;
  min-width: 160px; max-width: 220px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  font-size: 12px;
}
.rw-context-item {
  padding: 6px 12px; cursor: pointer;
  display: flex; align-items: center; gap: 8px;
  color: var(--text-primary, #e0e0e0);
}
.rw-context-item:hover { background: var(--bg-tertiary, #0f3460); }
.rw-context-item.primary { color: var(--accent, #00d4ff); }
.rw-context-separator {
  height: 1px; background: var(--border, #2a2a4a); margin: 4px 0;
}
.rw-context-label {
  padding: 4px 12px; font-size: 10px; color: var(--text-secondary, #a0a0b0);
  font-weight: 600;
}

/* 存储面板 */
.rw-storage-table {
  width: 100%; border-collapse: collapse; font-size: 11px;
}
.rw-storage-table th {
  background: var(--bg-secondary, #16213e);
  padding: 6px 8px; text-align: left;
  border-bottom: 1px solid var(--border, #2a2a4a);
  color: var(--text-secondary, #a0a0b0); font-weight: 600;
}
.rw-storage-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border, #2a2a4a);
}
.rw-storage-table tr:hover td { background: var(--bg-secondary, #16213e); }
.rw-storage-value {
  color: var(--text-primary, #e0e0e0);
  cursor: pointer; max-width: 200px;
}
.rw-storage-value-preview {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  display: inline-block; max-width: 100%;
}
.rw-storage-value-full {
  position: fixed; z-index: 2000;
  background: var(--bg-secondary, #16213e);
  border: 1px solid var(--accent, #00d4ff); border-radius: 6px;
  padding: 12px; max-width: 600px; max-height: 400px;
  overflow: auto; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
}
.rw-storage-value-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 8px; padding-bottom: 8px;
  border-bottom: 1px solid var(--border, #2a2a4a);
}
.rw-storage-value-title {
  font-weight: 600; font-size: 12px; color: var(--accent, #00d4ff);
}
.rw-storage-value-content {
  white-space: pre-wrap; word-break: break-all;
  font-family: 'Consolas', 'Monaco', monospace; font-size: 12px;
  color: var(--text-primary, #e0e0e0);
}
.rw-storage-delete {
  background: none; border: none; color: var(--error, #f44336);
  cursor: pointer; padding: 2px 6px; font-size: 10px; border-radius: 2px;
}
.rw-storage-delete:hover { background: rgba(244,67,54,0.2); }

/* 空状态 */
.rw-empty {
  display: flex; align-items: center; justify-content: center;
  height: 100%; color: var(--text-secondary, #a0a0b0); font-size: 12px;
}

/* 滚动条 */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: var(--scrollbar-track, #1a1a2e); }
::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb, #2a2a4a); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--accent, #00d4ff); }
`

// ============ 主组件 ============
export default function ReverseWindow() {
  const [activeTab, setActiveTab] = useState('network') // network | scripts | replay | ai
  const [capturing, setCapturing] = useState(false)
  const [requests, setRequests] = useState([])
  const [selectedReqId, setSelectedReqId] = useState(null)
  const [filter, setFilter] = useState({ urlFilter: '', method: '', resourceType: '' })
  const [scripts, setScripts] = useState([])
  const [selectedScript, setSelectedScript] = useState(null)
  const [scriptCode, setScriptCode] = useState('')
  const [replayForm, setReplayForm] = useState({ url: '', method: 'GET', headers: '{}', body: '' })
  const [replayResult, setReplayResult] = useState(null)
  const [aiMessages, setAiMessages] = useState([])
  const [aiInput, setAiInput] = useState('')
  const [aiRunning, setAiRunning] = useState(false)
  const [maxRounds, setMaxRounds] = useState(30) // 从后端获取 agent_max_rounds
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchMatches, setSearchMatches] = useState([]) // 匹配的 requestId 列表
  const [searchCurrentIdx, setSearchCurrentIdx] = useState(-1)
  const [contextMenu, setContextMenu] = useState(null) // { x, y, req }
  const [cookies, setCookies] = useState([])
  const [localStorageData, setLocalStorageData] = useState([])
  const [sessionStorageData, setSessionStorageData] = useState([])
  const [storageDomain, setStorageDomain] = useState('')
  const [toast, setToast] = useState('')
  const aiStreamRef = useRef(null) // 当前流式回复的消息 id
  const messagesEndRef = useRef(null)

  // Toast 辅助
  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(''), 2000)
  }, [])

  // 从后端获取 agent_max_rounds 设置（与设置面板共享）
  useEffect(() => {
    const loadMaxRounds = async () => {
      try {
        const res = await window.api.config.getAppSettings()
        if (res?.success && res.data?.agent_max_rounds) {
          setMaxRounds(res.data.agent_max_rounds)
        }
      } catch (e) {
        console.error('[ReverseWindow] Failed to load agent_max_rounds:', e)
      }
    }
    loadMaxRounds()
  }, [])

  // 监听 Agent 事件（用于 AI 分析）
  useEffect(() => {
    if (!window.api?.reverse?.onEvent) return
    const unsubscribe = window.api.reverse.onEvent((channel, data) => {
      switch (channel) {
        case 'agentStart':
          setAiRunning(true)
          setAiMessages([])
          aiStreamRef.current = null
          break
        case 'agentStatus':
          // 显示状态提示（如"第N轮分析中..."）
          if (data?.text) {
            setAiMessages(prev => [...prev, {
              id: 'status_' + Date.now() + Math.random(),
              type: 'status',
              content: data.text,
            }])
          }
          break
        case 'agentThinking':
          // AI 每轮的思考内容
          if (data?.content) {
            setAiMessages(prev => [...prev, {
              id: 'think_' + Date.now() + Math.random(),
              type: 'thinking',
              round: data.round,
              content: data.content,
            }])
          }
          break
        case 'streamChunk': {
          // 最终回复的流式输出
          const chunk = data?.content || ''
          if (!aiStreamRef.current) {
            const id = 'reply_' + Date.now()
            setAiMessages(prev => [...prev, { id, type: 'reply', content: chunk, streaming: true }])
            aiStreamRef.current = id
          } else {
            const targetId = aiStreamRef.current
            setAiMessages(prev => prev.map(m => {
              if (m.id !== targetId) return m
              return { ...m, content: (m.content || '') + chunk }
            }))
          }
          break
        }
        case 'streamDone':
          if (aiStreamRef.current) {
            const doneId = aiStreamRef.current
            setAiMessages(prev => prev.map(m => m.id === doneId ? { ...m, streaming: false } : m))
            aiStreamRef.current = null
          }
          break
        case 'agentStep': {
          // 工具调用：running 时创建，done 时更新同一条
          const step = data?.step
          const round = data?.round
          const toolName = data?.toolName
          if (!toolName || toolName === 'finish_task' || toolName === '回复') break
          const toolKey = `tool_${step}_${round}_${toolName}`
          if (data.status === 'running') {
            setAiMessages(prev => [...prev, {
              id: toolKey,
              type: 'tool',
              step, round, toolName,
              status: 'running',
              args: data.args || {},
              result: null,
            }])
          } else {
            // done：更新对应工具消息
            setAiMessages(prev => prev.map(m => {
              if (m.id !== toolKey) return m
              return { ...m, status: 'done', result: data.result || '' }
            }))
          }
          break
        }
        case 'agentDataReport':
          // 数据报告可选处理
          break
        case 'agentError':
          setAiMessages(prev => [...prev, {
            id: 'err_' + Date.now(),
            type: 'error',
            content: data?.error || '错误',
          }])
          break
        case 'agentDone':
          setAiRunning(false)
          break
      }
    })
    return unsubscribe
  }, [])

  // 自动滚动
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [aiMessages])

  // ===== 网络面板操作 =====
  const refreshRequests = useCallback(async () => {
    const apiFilter = { ...filter }
    // 前端默认 resourceType 为空字符串，后端默认值 '__default__' 会过滤出 XHR/Fetch/Script
    // 前端选 "ALL" 传 "ALL"，选具体类型传对应值，选默认时传空（后端会用 __default__）
    if (!apiFilter.resourceType) delete apiFilter.resourceType
    const res = await window.api.reverse.getRequests(apiFilter)
    if (res?.success) {
      setRequests(res.requests || [])
    }
  }, [filter])

  // ===== 搜索功能 =====
  const doSearch = useCallback((keyword) => {
    setSearchKeyword(keyword)
    if (!keyword.trim()) {
      setSearchMatches([])
      setSearchCurrentIdx(-1)
      return
    }
    const kw = keyword.toLowerCase()
    const matches = requests.filter(req => {
      const searchableText = [
        req.url,
        req.method,
        req.postData,
        req.responseBody,
        JSON.stringify(req.requestHeaders || {}),
        JSON.stringify(req.responseHeaders || {}),
      ].join(' ').toLowerCase()
      return searchableText.includes(kw)
    }).map(req => req.requestId)
    setSearchMatches(matches)
    if (matches.length > 0) {
      setSearchCurrentIdx(0)
      setSelectedReqId(matches[0])
    } else {
      setSearchCurrentIdx(-1)
    }
  }, [requests])

  const searchPrev = useCallback(() => {
    if (searchMatches.length === 0) return
    const newIdx = (searchCurrentIdx - 1 + searchMatches.length) % searchMatches.length
    setSearchCurrentIdx(newIdx)
    setSelectedReqId(searchMatches[newIdx])
  }, [searchMatches, searchCurrentIdx])

  const searchNext = useCallback(() => {
    if (searchMatches.length === 0) return
    const newIdx = (searchCurrentIdx + 1) % searchMatches.length
    setSearchCurrentIdx(newIdx)
    setSelectedReqId(searchMatches[newIdx])
  }, [searchMatches, searchCurrentIdx])

  // ===== 右键菜单 =====
  const handleContextMenu = useCallback((e, req) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, req })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  // ===== 存储面板 =====
  const loadStorageData = useCallback(async () => {
    if (!window.api?.reverse?.getStorage) return
    const res = await window.api.reverse.getStorage()
    if (res?.success) {
      setCookies(res.cookies || [])
      setLocalStorageData(res.localStorage || [])
      setSessionStorageData(res.sessionStorage || [])
      setStorageDomain(res.domain || '')
    }
  }, [])

  const clearCookie = useCallback(async (name) => {
    if (!window.api?.reverse?.clearCookie) return
    await window.api.reverse.clearCookie(name)
    showToast(`已删除 Cookie: ${name}`)
    loadStorageData()
  }, [loadStorageData, showToast])

  const clearStorageItem = useCallback(async (type, key) => {
    if (!window.api?.reverse?.clearStorageItem) return
    await window.api.reverse.clearStorageItem(type, key)
    showToast(`已删除 ${type}: ${key}`)
    loadStorageData()
  }, [loadStorageData, showToast])

  const clearAllStorage = useCallback(async (type) => {
    if (!window.api?.reverse?.clearAllStorage) return
    await window.api.reverse.clearAllStorage(type)
    showToast(`已清空 ${type}`)
    loadStorageData()
  }, [loadStorageData, showToast])

  const toggleCapture = useCallback(async () => {
    if (capturing) {
      await window.api.reverse.stopCapture()
      setCapturing(false)
      showToast('已停止捕获')
    } else {
      const res = await window.api.reverse.startCapture()
      if (res?.success) {
        setCapturing(true)
        showToast('已开始捕获')
        // 自动刷新
        setTimeout(refreshRequests, 1000)
      } else {
        showToast('捕获失败: ' + (res?.error || ''))
      }
    }
  }, [capturing, refreshRequests, showToast])

  const clearRequests = useCallback(async () => {
    await window.api.reverse.clearRequests()
    setRequests([])
    setSelectedReqId(null)
    showToast('已清空')
  }, [showToast])

  // 选中请求
  const selectRequest = useCallback((req) => {
    setSelectedReqId(req.requestId)
    // 如果是 POST/PUT，填充重放表单
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      setReplayForm({
        url: req.url,
        method: req.method,
        headers: JSON.stringify(req.requestHeaders || {}, null, 2),
        body: req.postData || '',
      })
    } else {
      setReplayForm({ url: req.url, method: req.method, headers: '{}', body: '' })
    }
  }, [])

  // ===== 脚本面板 =====
  const extractScripts = useCallback(async () => {
    const res = await window.api.reverse.extractScripts()
    if (res?.success) {
      setScripts(res.scripts || [])
    }
  }, [])

  const fetchScriptSource = useCallback(async (url) => {
    setSelectedScript(url)
    const res = await window.api.reverse.fetchScriptSource(url)
    if (res?.success) {
      setScriptCode(res.code || res.preview || '(空)')
    } else {
      setScriptCode('拉取失败: ' + (res?.error || ''))
    }
  }, [])

  // ===== 重放面板 =====
  const doReplay = useCallback(async () => {
    let headers = {}
    try { headers = JSON.parse(replayForm.headers || '{}') } catch { showToast('headers JSON 格式错误'); return }
    setReplayResult(null)
    const res = await window.api.reverse.replayRequest({
      url: replayForm.url,
      method: replayForm.method,
      headers,
      body: replayForm.body || undefined,
    })
    setReplayResult(res)
  }, [replayForm, showToast])

  // ===== AI 分析 =====
  const startAiAnalysis = useCallback(async () => {
    if (!aiInput.trim() || aiRunning) return
    const userMsg = aiInput
    setAiMessages(prev => [...prev, { id: 'user_' + Date.now(), type: 'user', content: userMsg }])
    // 不清空输入框，保留用户输入内容
    aiStreamRef.current = null
    await window.api.reverse.startAnalysis({ userMessage: userMsg, maxRounds })
  }, [aiInput, aiRunning, maxRounds])

  const abortAi = useCallback(async () => {
    await window.api.reverse.abortAnalysis()
    setAiRunning(false)
  }, [])

  // 关闭窗口
  const handleClose = useCallback(() => {
    window.api.reverseWindow?.close()
  }, [])

  // Tab 切换时自动加载
  useEffect(() => {
    if (activeTab === 'network' && capturing) refreshRequests()
    if (activeTab === 'scripts' && scripts.length === 0) extractScripts()
    if (activeTab === 'storage') loadStorageData()
  }, [activeTab])

  const selectedReq = requests.find(r => r.requestId === selectedReqId)

  return (
    <div className="rw-window">
      <style>{CSS_TEXT}</style>
      {/* 标题栏 */}
      <div className="rw-titlebar">
        <span className="rw-title">🔍 逆向分析工具</span>
        <div className="rw-title-actions">
          <button className={`rw-btn ${capturing ? 'danger' : 'primary'}`} onClick={toggleCapture}>
            {capturing ? '⏹ 停止捕获' : '▶ 开始捕获'}
          </button>
          <button className="rw-btn close" onClick={handleClose} title="关闭">✕</button>
        </div>
      </div>

      {/* 工具栏 */}
      <div className="rw-toolbar">
        <div className="rw-tabs">
          <div className={`rw-tab ${activeTab === 'network' ? 'active' : ''}`} onClick={() => setActiveTab('network')}>网络</div>
          <div className={`rw-tab ${activeTab === 'storage' ? 'active' : ''}`} onClick={() => setActiveTab('storage')}>存储</div>
          <div className={`rw-tab ${activeTab === 'scripts' ? 'active' : ''}`} onClick={() => setActiveTab('scripts')}>脚本</div>
          <div className={`rw-tab ${activeTab === 'replay' ? 'active' : ''}`} onClick={() => setActiveTab('replay')}>重放</div>
          <div className={`rw-tab ${activeTab === 'ai' ? 'active' : ''}`} onClick={() => setActiveTab('ai')}>AI 分析</div>
        </div>
        <span className={`rw-status ${capturing ? 'active' : ''}`}>
          {capturing ? '● 捕获中' : '○ 未捕获'} · {requests.length} 条请求
        </span>
      </div>

      {/* 主区域 */}
      <div className="rw-main">
        {activeTab === 'network' && (
          <div className="rw-split" style={{ flexDirection: 'row' }}>
            {/* 请求列表 */}
            <div className="rw-net-list">
              <div style={{ padding: 8, display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
                <input
                  className="rw-input"
                  placeholder="URL 过滤"
                  value={filter.urlFilter}
                  onChange={e => setFilter({ ...filter, urlFilter: e.target.value })}
                  onKeyDown={e => e.key === 'Enter' && refreshRequests()}
                  style={{ minWidth: 100, flex: 1 }}
                />
                <select className="rw-select" value={filter.method} onChange={e => setFilter({ ...filter, method: e.target.value })}>
                  <option value="">全部方法</option>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="DELETE">DELETE</option>
                </select>
                <select className="rw-select" value={filter.resourceType} onChange={e => setFilter({ ...filter, resourceType: e.target.value })}>
                  <option value="">XHR/Fetch/Script</option>
                  <option value="ALL">全部类型</option>
                  <option value="XHR">XHR</option>
                  <option value="Fetch">Fetch</option>
                  <option value="Script">Script</option>
                  <option value="Document">Document</option>
                  <option value="Image">Image</option>
                  <option value="Stylesheet">Stylesheet</option>
                </select>
                <button className="rw-btn" onClick={refreshRequests} style={{ padding: '4px 8px' }}>刷新</button>
                <button className="rw-btn" onClick={clearRequests} style={{ padding: '4px 8px' }}>清空</button>
              </div>
              {/* 搜索栏 */}
              <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
                <SearchBar
                  value={searchKeyword}
                  onChange={doSearch}
                  matchCount={searchMatches.length}
                  currentMatch={searchCurrentIdx}
                  onPrev={searchPrev}
                  onNext={searchNext}
                  onKeyDown={e => { if (e.key === 'Enter') { e.shiftKey ? searchPrev() : searchNext() } if (e.key === 'Escape') { doSearch('') } }}
                />
              </div>
              {requests.length === 0 ? (
                <div className="rw-empty">暂无请求<br/>{capturing ? '请触发目标操作' : '请先开始捕获'}</div>
              ) : (
                requests.map(req => {
                  const isSearchMatch = searchMatches.includes(req.requestId)
                  return (
                    <div
                      key={req.requestId}
                      className={`rw-net-item ${selectedReqId === req.requestId ? 'active' : ''}`}
                      onClick={() => selectRequest(req)}
                      onContextMenu={e => handleContextMenu(e, req)}
                      style={isSearchMatch && selectedReqId !== req.requestId ? { borderLeft: '3px solid rgba(255,200,0,0.5)' } : {}}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                        <span className={`rw-net-method ${req.method}`}>{req.method}</span>
                        <span className="rw-net-url" title={req.url}>{req.url}</span>
                        <span className={`rw-net-status s${Math.floor((req.status || 0) / 100)}`}>{req.status || '...'}</span>
                      </div>
                      {(req.contentLength != null || req.timing?.totalDuration != null) && (
                        <div className="rw-net-item-info">
                          {req.contentLength != null && <span className="rw-net-size">{req.contentLength < 1024 ? req.contentLength + ' B' : (req.contentLength / 1024).toFixed(1) + ' KB'}</span>}
                          {req.timing?.totalDuration != null && <span className="rw-net-time">{req.timing.totalDuration}ms</span>}
                          {isSearchMatch && <span style={{ color: '#ffc800', fontSize: 10 }}>●匹配</span>}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
            {/* 请求详情 */}
            <div className="rw-detail">
              {!selectedReq ? (
                <div className="rw-empty">选择左侧请求查看详情</div>
              ) : (
                <RequestDetail req={selectedReq} searchKeyword={searchKeyword} onReplay={() => { setReplayForm({ url: selectedReq.url, method: selectedReq.method, headers: JSON.stringify(selectedReq.requestHeaders || {}, null, 2), body: selectedReq.postData || '' }); setActiveTab('replay') }} onAiAnalyze={() => { setAiInput(`分析这个请求的加密参数:\nURL: ${selectedReq.url}\n方法: ${selectedReq.method}\n请求体: ${selectedReq.postData || '(无)'}\n响应: ${(selectedReq.responseBody || '').slice(0, 500)}`); setActiveTab('ai') }} />
              )}
            </div>
          </div>
        )}

        {activeTab === 'scripts' && (
          <div className="rw-split" style={{ flexDirection: 'row' }}>
            <div className="rw-net-list">
              <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
                <button className="rw-btn" onClick={extractScripts} style={{ width: '100%' }}>提取页面脚本</button>
              </div>
              {scripts.length === 0 ? (
                <div className="rw-empty">点击上方按钮提取脚本</div>
              ) : (
                scripts.map((s, i) => (
                  <div key={i} className="rw-script-item" onClick={() => s.src && s.src !== '(inline)' && fetchScriptSource(s.src)}>
                    <div className="rw-script-src">{s.src || '(inline)'}</div>
                    {s.type && <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{s.type}</div>}
                  </div>
                ))
              )}
            </div>
            <div className="rw-detail">
              {!selectedScript ? (
                <div className="rw-empty">点击脚本查看源码</div>
              ) : (
                <div>
                  <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedScript}</span>
                    <CopyButton text={scriptCode} />
                  </div>
                  <pre className="rw-script-code">{scriptCode}</pre>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'storage' && (
          <div className="rw-split" style={{ padding: 12, overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {storageDomain ? `域名: ${storageDomain}` : '点击刷新加载数据'}
              </span>
              <button className="rw-btn" onClick={loadStorageData} style={{ padding: '4px 8px' }}>🔄 刷新</button>
            </div>

            {/* Cookies */}
            <div className="rw-detail-section" style={{ marginBottom: 12 }}>
              <div className="rw-detail-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>🍪 Cookies ({cookies.length})</span>
                {cookies.length > 0 && (
                  <button className="rw-btn" onClick={() => clearAllStorage('cookies')} style={{ padding: '2px 6px', fontSize: 10 }}>清空</button>
                )}
              </div>
              {cookies.length === 0 ? (
                <div className="rw-detail-body" style={{ color: 'var(--text-secondary)' }}>无 Cookie</div>
              ) : (
                <div className="rw-detail-body" style={{ padding: 0 }}>
                  <table className="rw-storage-table">
                    <thead>
                      <tr><th>名称</th><th>值</th><th>域名</th><th>路径</th><th>操作</th></tr>
                    </thead>
                    <tbody>
                      {cookies.map((c, i) => (
                        <tr key={i}>
                          <td style={{ wordBreak: 'break-all' }}>{c.name}</td>
                          <StorageValueCell value={c.value} name={c.name} />
                          <td style={{ wordBreak: 'break-all' }}>{c.domain}</td>
                          <td style={{ wordBreak: 'break-all' }}>{c.path}</td>
                          <td>
                            <button className="rw-storage-delete" onClick={() => clearCookie(c.name)}>删除</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* LocalStorage */}
            <div className="rw-detail-section" style={{ marginBottom: 12 }}>
              <div className="rw-detail-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>📦 LocalStorage ({localStorageData.length})</span>
                {localStorageData.length > 0 && (
                  <button className="rw-btn" onClick={() => clearAllStorage('localStorage')} style={{ padding: '2px 6px', fontSize: 10 }}>清空</button>
                )}
              </div>
              {localStorageData.length === 0 ? (
                <div className="rw-detail-body" style={{ color: 'var(--text-secondary)' }}>无数据</div>
              ) : (
                <div className="rw-detail-body" style={{ padding: 0 }}>
                  <table className="rw-storage-table">
                    <thead>
                      <tr><th>键</th><th>值</th><th>操作</th></tr>
                    </thead>
                    <tbody>
                      {localStorageData.map((item, i) => (
                        <tr key={i}>
                          <td style={{ wordBreak: 'break-all' }}>{item.key}</td>
                          <StorageValueCell value={item.value} name={item.key} />
                          <td>
                            <button className="rw-storage-delete" onClick={() => clearStorageItem('localStorage', item.key)}>删除</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* SessionStorage */}
            <div className="rw-detail-section">
              <div className="rw-detail-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>📂 SessionStorage ({sessionStorageData.length})</span>
                {sessionStorageData.length > 0 && (
                  <button className="rw-btn" onClick={() => clearAllStorage('sessionStorage')} style={{ padding: '2px 6px', fontSize: 10 }}>清空</button>
                )}
              </div>
              {sessionStorageData.length === 0 ? (
                <div className="rw-detail-body" style={{ color: 'var(--text-secondary)' }}>无数据</div>
              ) : (
                <div className="rw-detail-body" style={{ padding: 0 }}>
                  <table className="rw-storage-table">
                    <thead>
                      <tr><th>键</th><th>值</th><th>操作</th></tr>
                    </thead>
                    <tbody>
                      {sessionStorageData.map((item, i) => (
                        <tr key={i}>
                          <td style={{ wordBreak: 'break-all' }}>{item.key}</td>
                          <StorageValueCell value={item.value} name={item.key} />
                          <td>
                            <button className="rw-storage-delete" onClick={() => clearStorageItem('sessionStorage', item.key)}>删除</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'replay' && (
          <div className="rw-split">
            <div className="rw-replay-form">
              <div className="rw-replay-row">
                <span className="rw-replay-label">方法</span>
                <select className="rw-select" value={replayForm.method} onChange={e => setReplayForm({ ...replayForm, method: e.target.value })} style={{ minWidth: 100 }}>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="DELETE">DELETE</option>
                  <option value="PATCH">PATCH</option>
                </select>
                <span className="rw-replay-label">URL</span>
                <input className="rw-replay-input" value={replayForm.url} onChange={e => setReplayForm({ ...replayForm, url: e.target.value })} placeholder="https://..." />
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>请求头 (JSON)</div>
                <textarea className="rw-replay-textarea" value={replayForm.headers} onChange={e => setReplayForm({ ...replayForm, headers: e.target.value })} placeholder='{"Content-Type":"application/json"}' />
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>请求体</div>
                <textarea className="rw-replay-textarea" value={replayForm.body} onChange={e => setReplayForm({ ...replayForm, body: e.target.value })} placeholder="请求体内容" />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="rw-btn primary" onClick={doReplay} disabled={aiRunning}>发送请求</button>
                <button className="rw-btn" onClick={() => setReplayResult(null)}>清空结果</button>
              </div>
            </div>
            {replayResult && (
              <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
                <div className="rw-detail-section">
                  <div className="rw-detail-header">
                    <span>▼</span> 响应结果
                    <span style={{ fontSize: 11, marginLeft: 8, color: replayResult.ok ? 'var(--success)' : 'var(--error)', fontWeight: 600 }}>
                      {replayResult.status || replayResult.error}
                    </span>
                    {replayResult.bodyLength && <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 4 }}>{replayResult.bodyLength} 字符</span>}
                  </div>
                  <div className="rw-detail-body">
                    {replayResult.respHeaders && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'flex', alignItems: 'center' }}>
                          响应头
                          <CopyButton text={JSON.stringify(replayResult.respHeaders, null, 2)} />
                        </div>
                        <JsonViewer data={replayResult.respHeaders} defaultExpand={1} />
                      </div>
                    )}
                    {replayResult.body && (() => {
                      let bodyJson = null
                      try { bodyJson = JSON.parse(replayResult.body) } catch {}
                      return (
                        <div>
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'flex', alignItems: 'center' }}>
                            响应体
                            <CopyButton text={bodyJson ? JSON.stringify(bodyJson, null, 2) : replayResult.body} />
                          </div>
                          {bodyJson ? (
                            <JsonViewer data={bodyJson} defaultExpand={2} />
                          ) : (
                            <pre className="rw-script-code">{replayResult.body}</pre>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'ai' && (
          <div className="rw-split rw-ai-panel">
            <div className="rw-ai-input">
              <div className="rw-ai-options">
                <label className="rw-ai-option" title="最大执行轮次由后台设置面板控制">
                  最大轮次：
                  <input
                    type="number"
                    value={maxRounds}
                    readOnly
                    style={{ width: 64, opacity: 0.7, cursor: 'not-allowed' }}
                  />
                  <span style={{ fontSize: 11, color: '#888', marginLeft: 4 }}>（后台设置）</span>
                </label>
                {aiRunning && <span className="rw-ai-running-badge">● 分析中</span>}
              </div>
              <textarea
                className="rw-ai-textarea"
                placeholder="描述你要分析的逆向任务... 例如：分析这个请求的签名算法"
                value={aiInput}
                onChange={e => setAiInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startAiAnalysis() } }}
              />
              {aiRunning ? (
                <button className="rw-btn danger" onClick={abortAi}>中止</button>
              ) : (
                <button className="rw-btn primary" onClick={startAiAnalysis} disabled={!aiInput.trim()}>开始分析</button>
              )}
            </div>
            <div className="rw-ai-messages rw-timeline">
              {aiMessages.length === 0 ? (
                <div className="rw-empty">
                  AI 逆向分析引擎<br/>
                  输入任务描述开始分析<br/><br/>
                  示例：<br/>
                  · 分析登录接口的签名算法<br/>
                  · 提取页面加密函数并验证<br/>
                  · 对比原始请求和重放请求的差异
                </div>
              ) : (
                aiMessages.map(msg => <AiMessageItem key={msg.id} msg={msg} />)
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          req={contextMenu.req}
          onClose={closeContextMenu}
          onCopy={() => showToast('已复制到剪贴板')}
          onReplay={() => {
            const req = contextMenu.req
            setReplayForm({
              url: req.url,
              method: req.method,
              headers: JSON.stringify(req.requestHeaders || {}, null, 2),
              body: req.postData || '',
            })
            setActiveTab('replay')
          }}
          onAiAnalyze={() => {
            const req = contextMenu.req
            setAiInput(`分析这个请求的加密参数:\nURL: ${req.url}\n方法: ${req.method}\n请求体: ${req.postData || '(无)'}\n响应: ${(req.responseBody || '').slice(0, 500)}`)
            setActiveTab('ai')
          }}
        />
      )}

      {toast && <div className="rw-toast">{toast}</div>}
    </div>
  )
}

// ============ AI 消息项组件（时间线样式） ============
// 工具名中文映射
const REVERSE_TOOL_LABELS = {
  get_captured_requests: '获取捕获请求',
  fetch_script_source: '拉取脚本源码',
  replay_request: '重放请求',
  execute_js: '执行JS',
  read_page_content: '读取页面内容',
  get_page_html: '获取页面HTML',
  finish_task: '完成任务',
}

function AiMessageItem({ msg }) {
  const [expanded, setExpanded] = useState(false)

  // 用户消息
  if (msg.type === 'user') {
    return (
      <div className="rw-tl-item rw-tl-user">
        <div className="rw-tl-dot user">👤</div>
        <div className="rw-tl-card">
          <div className="rw-tl-header"><span className="rw-tl-tag user">用户</span></div>
          <div className="rw-tl-body user">{msg.content}</div>
        </div>
      </div>
    )
  }

  // 状态提示（如"第N轮分析中..."）
  if (msg.type === 'status') {
    return (
      <div className="rw-tl-item rw-tl-status">
        <div className="rw-tl-dot status">·</div>
        <div className="rw-tl-status-text">{msg.content}</div>
      </div>
    )
  }

  // AI 思考内容
  if (msg.type === 'thinking') {
    const preview = (msg.content || '').slice(0, 120)
    const isLong = (msg.content || '').length > 120
    return (
      <div className="rw-tl-item rw-tl-thinking">
        <div className="rw-tl-dot thinking">🧠</div>
        <div className="rw-tl-card">
          <div className="rw-tl-header">
            <span className="rw-tl-tag thinking">思考</span>
            {msg.round && <span className="rw-tl-round">第{msg.round}轮</span>}
          </div>
          <div className="rw-tl-body thinking">
            {expanded || !isLong ? (
              <ReactMarkdown>{msg.content}</ReactMarkdown>
            ) : (
              <>
                <ReactMarkdown>{preview + '...'}</ReactMarkdown>
                <button className="rw-tl-expand-btn" onClick={() => setExpanded(true)}>展开全部</button>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  // 工具调用
  if (msg.type === 'tool') {
    const label = REVERSE_TOOL_LABELS[msg.toolName] || msg.toolName
    const argsStr = msg.args && Object.keys(msg.args).length > 0 ? JSON.stringify(msg.args, null, 2) : '(无参数)'
    const resultStr = msg.result || ''
    const isRunning = msg.status === 'running'
    return (
      <div className="rw-tl-item rw-tl-tool">
        <div className={`rw-tl-dot tool ${isRunning ? 'running' : 'done'}`}>
          {isRunning ? '⏳' : '🔧'}
        </div>
        <div className="rw-tl-card">
          <div className="rw-tl-header">
            <span className={`rw-tl-tag tool ${isRunning ? 'running' : 'done'}`}>
              {isRunning ? '执行中' : '已完成'}
            </span>
            <span className="rw-tl-toolname">{label}</span>
            {msg.round && <span className="rw-tl-round">第{msg.round}轮 · 步骤{msg.step}</span>}
          </div>
          <div className="rw-tl-body tool">
            <div className="rw-tl-section" onClick={() => setExpanded(e => !e)}>
              <span className="rw-tl-section-toggle">{expanded ? '▼' : '▶'}</span>
              <span className="rw-tl-section-label">参数</span>
              <pre className={`rw-tl-pre ${expanded ? '' : 'collapsed'}`}>{argsStr}</pre>
            </div>
            {!isRunning && resultStr && (
              <div className="rw-tl-section" onClick={() => setExpanded(e => !e)}>
                <span className="rw-tl-section-toggle">{expanded ? '▼' : '▶'}</span>
                <span className="rw-tl-section-label">结果</span>
                <pre className={`rw-tl-pre ${expanded ? '' : 'collapsed'}`}>{resultStr}</pre>
              </div>
            )}
            {isRunning && <div className="rw-tl-running-hint">正在执行...</div>}
          </div>
        </div>
      </div>
    )
  }

  // 最终回复
  if (msg.type === 'reply') {
    return (
      <div className="rw-tl-item rw-tl-reply">
        <div className="rw-tl-dot reply">💬</div>
        <div className="rw-tl-card">
          <div className="rw-tl-header">
            <span className="rw-tl-tag reply">最终回复</span>
          </div>
          <div className="rw-tl-body reply">
            <ReactMarkdown>{msg.content || ''}</ReactMarkdown>
            {msg.streaming && <span className="rw-ai-streaming" />}
          </div>
        </div>
      </div>
    )
  }

  // 错误
  if (msg.type === 'error') {
    return (
      <div className="rw-tl-item rw-tl-error">
        <div className="rw-tl-dot error">⚠️</div>
        <div className="rw-tl-card">
          <div className="rw-tl-header"><span className="rw-tl-tag error">错误</span></div>
          <div className="rw-tl-body error">{msg.content}</div>
        </div>
      </div>
    )
  }

  return null
}

// ============ JSON 查看器组件 ============
function JsonViewer({ data, defaultExpand = 1, highlight = '' }) {
  const [collapsed, setCollapsed] = useState({})

  const togglePath = (path) => setCollapsed(prev => ({ ...prev, [path]: !prev[path] }))

  const highlightText = (text) => {
    if (!highlight || !text) return text
    const str = String(text)
    const idx = str.toLowerCase().indexOf(highlight.toLowerCase())
    if (idx === -1) return str
    return <>
      {str.slice(0, idx)}<span className="rw-search-highlight">{str.slice(idx, idx + highlight.length)}</span>{str.slice(idx + highlight.length)}
    </>
  }

  const renderValue = (val, path, depth) => {
    if (val === null) return <span className="rw-json-null">null</span>
    if (val === undefined) return <span className="rw-json-null">undefined</span>
    if (typeof val === 'boolean') return <span className="rw-json-boolean">{String(val)}</span>
    if (typeof val === 'number') return <span className="rw-json-number">{val}</span>
    if (typeof val === 'string') return <span className="rw-json-string">"{highlightText(val)}"</span>
    if (Array.isArray(val)) {
      const isCollapsed = collapsed[path] !== undefined ? collapsed[path] : depth >= defaultExpand
      if (val.length === 0) return <span className="rw-json-bracket">[]</span>
      return (
        <>
          <span className="rw-json-toggle" onClick={() => togglePath(path)}>{isCollapsed ? '▶' : '▼'}</span>
          <span className="rw-json-bracket" onClick={() => togglePath(path)} style={{ cursor: 'pointer' }}>[</span>
          <span className="rw-json-count">{val.length} 项</span>
          {isCollapsed ? (
            <span className="rw-json-ellipsis" onClick={() => togglePath(path)}> ... ]</span>
          ) : (
            <>
              <div className="rw-json-node">
                {val.map((item, i) => (
                  <div key={i} className="rw-json-row">
                    <span className="rw-json-key" style={{ color: '#6a9955' }}>{i}</span>
                    <span className="rw-json-colon">:</span>
                    {renderValue(item, `${path}[${i}]`, depth + 1)}
                  </div>
                ))}
              </div>
              <span className="rw-json-bracket">]</span>
            </>
          )}
        </>
      )
    }
    if (typeof val === 'object') {
      const keys = Object.keys(val)
      const isCollapsed = collapsed[path] !== undefined ? collapsed[path] : depth >= defaultExpand
      if (keys.length === 0) return <span className="rw-json-bracket">{'{}'}</span>
      return (
        <>
          <span className="rw-json-toggle" onClick={() => togglePath(path)}>{isCollapsed ? '▶' : '▼'}</span>
          <span className="rw-json-bracket" onClick={() => togglePath(path)} style={{ cursor: 'pointer' }}>{'{'}</span>
          <span className="rw-json-count">{keys.length} 字段</span>
          {isCollapsed ? (
            <span className="rw-json-ellipsis" onClick={() => togglePath(path)}> ... {'}'}</span>
          ) : (
            <>
              <div className="rw-json-node">
                {keys.map(k => (
                  <div key={k} className="rw-json-row">
                    <span className="rw-json-key">"{highlightText(k)}"</span>
                    <span className="rw-json-colon">:</span>
                    {renderValue(val[k], `${path}.${k}`, depth + 1)}
                  </div>
                ))}
              </div>
              <span className="rw-json-bracket">{'}'}</span>
            </>
          )}
        </>
      )
    }
    return String(val)
  }

  // 尝试解析 JSON 字符串
  let parsed = data
  if (typeof data === 'string') {
    try { parsed = JSON.parse(data) } catch { return <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{highlightText(data)}</pre> }
  }

  return <div className="rw-json-root">{renderValue(parsed, '$', 0)}</div>
}

// ============ 复制到剪贴板 ============
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return <button className="rw-copy-btn" onClick={handleCopy}>{copied ? '已复制' : '复制'}</button>
}

// ============ 存储值单元格（可展开/复制） ============
function StorageValueCell({ value, name }) {
  const [expanded, setExpanded] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const tdRef = useRef(null)
  const strValue = String(value || '')
  const truncated = strValue.length > 80
  const preview = truncated ? strValue.slice(0, 80) + '...' : strValue

  // 尝试解析为 JSON
  let jsonValue = null
  try { jsonValue = JSON.parse(strValue) } catch {}

  const handleClick = (e) => {
    e.stopPropagation()
    // 计算弹窗位置
    const rect = tdRef.current?.getBoundingClientRect()
    if (rect) {
      const x = Math.min(rect.left, window.innerWidth - 620)
      const y = Math.min(rect.bottom + 4, window.innerHeight - 420)
      setPosition({ x, y })
    }
    setExpanded(true)
  }

  const handleClose = () => setExpanded(false)

  // 点击外部关闭
  useEffect(() => {
    if (!expanded) return
    const handleClickOutside = (e) => {
      const popup = document.querySelector('.rw-storage-value-full')
      if (popup && !popup.contains(e.target)) {
        setExpanded(false)
      }
    }
    setTimeout(() => document.addEventListener('click', handleClickOutside), 0)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [expanded])

  return (
    <>
      <td ref={tdRef} className="rw-storage-value" onClick={handleClick} title={truncated ? '点击查看完整值' : ''}>
        <span className="rw-storage-value-preview">{preview}</span>
        {truncated && <span style={{ color: 'var(--accent)', marginLeft: 4, fontSize: 10 }}>···</span>}
      </td>
      {expanded && (
        <div className="rw-storage-value-full" style={{ left: position.x, top: position.y }} onClick={e => e.stopPropagation()}>
          <div className="rw-storage-value-header">
            <span className="rw-storage-value-title">{name || '值'}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <CopyButton text={strValue} />
              <button className="rw-btn" onClick={handleClose} style={{ padding: '2px 8px', fontSize: 10 }}>关闭</button>
            </div>
          </div>
          <div className="rw-storage-value-content">
            {jsonValue ? (
              <JsonViewer data={jsonValue} defaultExpand={2} />
            ) : (
              strValue
            )}
          </div>
        </div>
      )}
    </>
  )
}

// ============ 搜索面板 ============
function SearchBar({ value, onChange, matchCount, currentMatch, onPrev, onNext, onKeyDown }) {
  return (
    <div className="rw-search-bar">
      <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>🔍</span>
      <input
        placeholder="搜索请求内容..."
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
      />
      {value && (
        <>
          <span className="rw-search-count">{matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : '无匹配'}</span>
          <button className="rw-search-nav" onClick={onPrev} title="上一个">▲</button>
          <button className="rw-search-nav" onClick={onNext} title="下一个">▼</button>
        </>
      )}
    </div>
  )
}

// ============ 请求复制格式生成 ============
function generateCopyFormats(req, cookieStr = '') {
  const headers = { ...(req.requestHeaders || {}) }
  const body = req.postData || ''
  const method = req.method || 'GET'
  const url = req.url || ''

  // 如果请求头中没有 Cookie，使用传入的 cookieStr
  if (!headers['Cookie'] && !headers['cookie'] && cookieStr) {
    headers['Cookie'] = cookieStr
  }

  // PowerShell Invoke-WebRequest
  const powershellHeaders = Object.entries(headers)
    .map(([k, v]) => `-Headers @{ "${k}" = "${String(v).replace(/"/g, '\\"')}" }`)
    .join(' ')
  const powershellBody = body ? `-Body '${body.replace(/'/g, "''")}'` : ''
  const powershellCmd = method === 'GET'
    ? `Invoke-WebRequest -Uri "${url}" -Method ${method} ${powershellHeaders}`
    : `Invoke-WebRequest -Uri "${url}" -Method ${method} ${powershellHeaders} ${powershellBody}`

  // curl (bash)
  const curlHeaders = Object.entries(headers)
    .map(([k, v]) => `-H "${k}: ${String(v).replace(/"/g, '\\"')}"`)
    .join(' ')
  const curlBody = body ? `-d '${body.replace(/'/g, "'\\''")}'` : ''
  const curlCmd = `curl '${url}' -X ${method} ${curlHeaders} ${curlBody}`

  // fetch (JavaScript)
  const fetchHeadersObj = Object.entries(headers)
    .reduce((acc, [k, v]) => { acc[k] = String(v); return acc }, {})
  const fetchHeaders = JSON.stringify(fetchHeadersObj)
  const fetchBody = body ? `, body: '${body.replace(/'/g, "\\'")}'` : ''
  const fetchCmd = `fetch('${url}', {\n  method: '${method}',\n  headers: ${fetchHeaders}${fetchBody}\n});`

  // HTTP (raw)
  const httpLines = [`${method} ${url.split('?')[0] || url} HTTP/1.1`]
  Object.entries(headers).forEach(([k, v]) => httpLines.push(`${k}: ${String(v)}`))
  if (body) {
    httpLines.push('')
    httpLines.push(body)
  }
  const httpRaw = httpLines.join('\n')

  return {
    powershell: powershellCmd.trim(),
    curl: curlCmd.trim(),
    fetch: fetchCmd.trim(),
    httpRaw: httpRaw,
    url: url,
    urlWithQuery: url,
  }
}

// ============ 右键菜单组件 ============
function ContextMenu({ x, y, req, onClose, onCopy, onReplay, onAiAnalyze }) {
  const [cookieStr, setCookieStr] = useState('')

  // 加载当前页面 Cookie
  useEffect(() => {
    const loadCookies = async () => {
      try {
        const res = await window.api.reverse.getCookies()
        if (res?.success && res.cookieStr) {
          setCookieStr(res.cookieStr)
        }
      } catch (e) {
        console.error('[ContextMenu] Failed to get cookies:', e)
      }
    }
    loadCookies()
  }, [])

  useEffect(() => {
    const handleClick = () => onClose()
    const handleKeyDown = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  const formats = generateCopyFormats(req, cookieStr)
  const menuStyle = { left: x, top: y }

  const handleCopyFormat = (format) => {
    navigator.clipboard.writeText(format)
    onCopy()
    onClose()
  }

  return (
    <div className="rw-context-menu" style={menuStyle} onClick={e => e.stopPropagation()}>
      <div className="rw-context-label">复制请求</div>
      <div className="rw-context-item" onClick={() => handleCopyFormat(formats.url)}>
        <span>📋</span> 复制 URL
      </div>
      <div className="rw-context-item" onClick={() => handleCopyFormat(formats.curl)}>
        <span>📜</span> 复制为 curl (bash)
      </div>
      <div className="rw-context-item" onClick={() => handleCopyFormat(formats.powershell)}>
        <span>⚡</span> 复制为 PowerShell
      </div>
      <div className="rw-context-item" onClick={() => handleCopyFormat(formats.fetch)}>
        <span>🌐</span> 复制为 fetch (JS)
      </div>
      <div className="rw-context-item" onClick={() => handleCopyFormat(formats.httpRaw)}>
        <span>📄</span> 复制为 HTTP (raw)
      </div>
      <div className="rw-context-separator" />
      <div className="rw-context-item primary" onClick={() => { onReplay(); onClose() }}>
        <span>🔄</span> 重放请求
      </div>
      <div className="rw-context-item" onClick={() => { onAiAnalyze(); onClose() }}>
        <span>🔍</span> AI 分析
      </div>
      <div className="rw-context-separator" />
      <div className="rw-context-item" onClick={() => { navigator.clipboard.writeText(JSON.stringify(req, null, 2)); onCopy(); onClose() }}>
        <span>📦</span> 复制完整 JSON
      </div>
    </div>
  )
}

// ============ 请求详情组件 ============
function RequestDetail({ req, onReplay, onAiAnalyze, searchKeyword }) {
  const [expanded, setExpanded] = useState({ overview: true, requestHeaders: false, requestBody: true, responseHeaders: false, responseBody: true })
  const toggle = (k) => setExpanded({ ...expanded, [k]: !expanded[k] })

  // 尝试解析请求体和响应体为 JSON
  let reqBodyJson = null
  let respBodyJson = null
  try { reqBodyJson = req.postData ? JSON.parse(req.postData) : null } catch { reqBodyJson = null }
  try { respBodyJson = req.responseBody ? JSON.parse(req.responseBody) : null } catch { respBodyJson = null }

  const formatSize = (bytes) => {
    if (!bytes) return ''
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  }

  return (
    <div>
      {/* 概览 */}
      <div className="rw-detail-section">
        <div className="rw-detail-header" onClick={() => toggle('overview')}>
          <span>{expanded.overview ? '▼' : '▶'}</span> 概览
          <CopyButton text={`${req.method} ${req.url}`} />
        </div>
        {expanded.overview && (
          <div className="rw-detail-body">
            <div className="rw-key-val"><span className="rw-key">URL</span><span className="rw-val" style={{ color: '#9cdcfe' }}>{req.url}</span></div>
            <div className="rw-key-val"><span className="rw-key">方法</span><span className="rw-val"><span className={`rw-net-method ${req.method}`} style={{ display: 'inline-block' }}>{req.method}</span></span></div>
            <div className="rw-key-val"><span className="rw-key">状态</span><span className="rw-val"><span className={`rw-net-status s${Math.floor((req.status || 0) / 100)}`} style={{ fontWeight: 600 }}>{req.status}</span> {req.statusText}</span></div>
            <div className="rw-key-val"><span className="rw-key">类型</span><span className="rw-val">{req.resourceType || '-'}</span></div>
            <div className="rw-key-val"><span className="rw-key">MIME</span><span className="rw-val">{req.mimeType || '-'}</span></div>
            {req.contentLength != null && <div className="rw-key-val"><span className="rw-key">大小</span><span className="rw-val">{formatSize(req.contentLength)}</span></div>}
            {req.timing && req.timing.totalDuration != null && <div className="rw-key-val"><span className="rw-key">耗时</span><span className="rw-val">{req.timing.totalDuration}ms</span></div>}
            {req.remoteIP && <div className="rw-key-val"><span className="rw-key">远程地址</span><span className="rw-val">{req.remoteIP}:{req.remotePort}</span></div>}
            {req.initiator && <div className="rw-key-val"><span className="rw-key">发起者</span><span className="rw-val">{req.initiator.type}: {req.initiator.url}</span></div>}
          </div>
        )}
      </div>

      {/* 请求头 */}
      {req.requestHeaders && Object.keys(req.requestHeaders).length > 0 && (
        <div className="rw-detail-section">
          <div className="rw-detail-header" onClick={() => toggle('requestHeaders')}>
            <span>{expanded.requestHeaders ? '▼' : '▶'}</span> 请求头
            <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 4 }}>({Object.keys(req.requestHeaders).length})</span>
            <CopyButton text={JSON.stringify(req.requestHeaders, null, 2)} />
          </div>
          {expanded.requestHeaders && (
            <div className="rw-detail-body">
              {Object.entries(req.requestHeaders).map(([k, v]) => (
                <div key={k} className="rw-key-val"><span className="rw-key">{k}</span><span className="rw-val">{String(v)}</span></div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 请求体 */}
      {req.postData && (
        <div className="rw-detail-section">
          <div className="rw-detail-header" onClick={() => toggle('requestBody')}>
            <span>{expanded.requestBody ? '▼' : '▶'}</span> 请求体
            {req.hasPostData && <span style={{ color: '#ffd700', marginLeft: 4 }}>★</span>}
            <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 4 }}>({formatSize(req.postData.length)})</span>
            <CopyButton text={reqBodyJson ? JSON.stringify(reqBodyJson, null, 2) : req.postData} />
          </div>
          {expanded.requestBody && (
            <div className="rw-detail-body">
              {reqBodyJson ? (
                <JsonViewer data={reqBodyJson} defaultExpand={2} highlight={searchKeyword} />
              ) : (
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{req.postData}</pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* 响应头 */}
      {req.responseHeaders && Object.keys(req.responseHeaders).length > 0 && (
        <div className="rw-detail-section">
          <div className="rw-detail-header" onClick={() => toggle('responseHeaders')}>
            <span>{expanded.responseHeaders ? '▼' : '▶'}</span> 响应头
            <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 4 }}>({Object.keys(req.responseHeaders).length})</span>
            <CopyButton text={JSON.stringify(req.responseHeaders, null, 2)} />
          </div>
          {expanded.responseHeaders && (
            <div className="rw-detail-body">
              {Object.entries(req.responseHeaders).map(([k, v]) => (
                <div key={k} className="rw-key-val"><span className="rw-key">{k}</span><span className="rw-val">{String(v)}</span></div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 响应体 */}
      {req.responseBody && (
        <div className="rw-detail-section">
          <div className="rw-detail-header" onClick={() => toggle('responseBody')}>
            <span>{expanded.responseBody ? '▼' : '▶'}</span> 响应体
            {req.responseBodyTruncated && <span style={{ color: '#ff9800', marginLeft: 4, fontSize: 10 }}>(已截断)</span>}
            <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 4 }}>({formatSize(req.responseBody.length)})</span>
            <CopyButton text={respBodyJson ? JSON.stringify(respBodyJson, null, 2) : req.responseBody} />
          </div>
          {expanded.responseBody && (
            <div className="rw-detail-body">
              {respBodyJson ? (
                <JsonViewer data={respBodyJson} defaultExpand={2} highlight={searchKeyword} />
              ) : (
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{req.responseBody}</pre>
              )}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="rw-btn primary" onClick={onReplay}>🔄 重放此请求</button>
        <button className="rw-btn" onClick={onAiAnalyze}>🔍 AI 分析此请求</button>
      </div>
    </div>
  )
}
