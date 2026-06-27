/**
 * GEO AI发布助手 - 合并注入脚本
 * 由以下源文件合并而成（按顺序）：
 * 1. css/sidebar.css          - 内联为style标签注入
 * 2. js/utils.js              - 移除safeSendMessage，替换为localStorage版本
 * 3. js/fieldReader.js
 * 4. js/fieldWriter.js
 * 5. js/cozeProvider.js       - 含GEO_SHARED_CONSTANTS硬编码
 * 6. js/dmxProvider.js        - 替换chrome APIs为localStorage/远程
 * 7. js/mockProvider.js
 * 8. js/jsonld.js
 * 9. js/knowledgeCard.js      - 替换chrome APIs为localStorage/远程
 * 10. js/cards.js
 * 11. js/content.js
 */
(function() {
  'use strict';

  // ========== 防止重复注入 ==========
  if (document.getElementById('geo-sidebar-css')) {
    console.log('AI发布助手: 脚本已加载，跳过重复注入');
    return;
  }

  // ========== 1. 注入CSS ==========
  if (!document.getElementById('geo-sidebar-css')) {
    const style = document.createElement('style');
    style.id = 'geo-sidebar-css';
    style.textContent = `
/**
 * 侧边栏样式
 * 不影响原页面布局的悬浮侧边栏
 */

/* 侧边栏容器 */
#geo-sidebar {
  position: fixed;
  top: 0;
  right: 0;
  width: 360px;
  height: 100vh;
  background: #fff;
  box-shadow: -2px 0 20px rgba(0, 0, 0, 0.1);
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 14px;
  color: #333;
  transition: transform 0.3s ease;
  display: flex;
  flex-direction: column;
}

/* 拖拽调整宽度手柄 */
.geo-resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
  background: transparent;
  transition: background 0.2s;
}

.geo-resize-handle:hover,
.geo-resize-handle:active {
  background: rgba(102, 126, 234, 0.3);
}

/* 折叠状态 */
#geo-sidebar.geo-sidebar-collapsed {
  width: 0;
  overflow: hidden;
}

#geo-sidebar.geo-sidebar-collapsed .geo-sidebar-content {
  display: none;
}

/* 展开状态 */
#geo-sidebar.geo-sidebar-expanded {
  width: 360px;
}

/* 独立的浮条按钮（当侧边栏折叠时显示） */
#geo-toggle {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 50px;
  height: 80px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border: none;
  border-radius: 8px 0 0 8px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  box-shadow: -2px 2px 10px rgba(102, 126, 234, 0.4);
  transition: all 0.2s ease;
  z-index: 2147483647;
}

/* 侧边栏展开时隐藏浮条按钮 */
#geo-sidebar.geo-sidebar-expanded ~ #geo-toggle {
  display: none;
}

/* 侧边栏折叠时显示浮条按钮 */
#geo-sidebar.geo-sidebar-collapsed ~ #geo-toggle {
  display: flex;
}

#geo-toggle:hover {
  width: 56px;
  box-shadow: -2px 2px 15px rgba(102, 126, 234, 0.6);
}

#geo-toggle .geo-toggle-icon {
  font-size: 24px;
}

#geo-toggle .geo-toggle-text {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.1;
  text-align: center;
  letter-spacing: 1px;
}

/* 隐藏时的浮条 */
#geo-sidebar.geo-sidebar-collapsed .geo-sidebar-content,
#geo-sidebar.geo-sidebar-collapsed #geo-toggle {
  display: flex !important;
}

/* 展开的侧边栏内容 */
.geo-sidebar-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 侧边栏头部 */
.geo-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #eee;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #fff;
}

.geo-sidebar-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.geo-btn-close {
  width: 28px;
  height: 28px;
  border: none;
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
  font-size: 20px;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
}

.geo-btn-close:hover {
  background: rgba(255, 255, 255, 0.3);
}

/* 状态区域 */
.geo-status-area {
  padding: 16px 20px;
  background: #f8f9fa;
  border-bottom: 1px solid #eee;
}

.geo-status-item {
  display: flex;
  align-items: flex-start;
  margin-bottom: 10px;
}

.geo-status-item:last-child {
  margin-bottom: 0;
}

.geo-status-item .geo-label {
  flex-shrink: 0;
  width: 50px;
  color: #666;
  font-size: 13px;
}

.geo-status-item .geo-value {
  flex: 1;
  color: #333;
  font-size: 13px;
  word-break: break-all;
}

/* 状态徽章 */
.geo-status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 12px;
}

.geo-status-ready {
  background: #d4edda;
  color: #155724;
}

.geo-status-warning {
  background: #fff3cd;
  color: #856404;
}

.geo-status-error {
  background: #f8d7da;
  color: #721c24;
}

.geo-status-pending {
  background: #e9ecef;
  color: #6c757d;
}

/* 主按钮区域 */
.geo-action-buttons {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-bottom: 1px solid #eee;
}

/* 读取状态按钮 - 紧凑横条 */
.geo-btn-refresh {
  width: 100%;
  padding: 6px 12px;
  font-size: 12px;
  background: linear-gradient(135deg, #36d1dc 0%, #5b86e5 100%);
  color: #fff;
}

.geo-btn-refresh:hover:not(:disabled) {
  box-shadow: 0 2px 8px rgba(54, 209, 220, 0.4);
}

/* 通用按钮样式 */
.geo-btn {
  border: none;
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all 0.2s ease;
  padding: 10px 16px;
  font-size: 13px;
}

.geo-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.geo-btn-icon {
  font-size: 16px;
}

.geo-btn-text {
  font-size: 13px;
  line-height: 1.2;
}

/* 主功能按钮 */
.geo-btn-primary {
  width: 100%;
  padding: 12px 16px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #fff;
  font-size: 14px;
}

.geo-btn-primary:hover:not(:disabled) {
  box-shadow: 0 2px 8px rgba(102, 126, 234, 0.4);
  filter: brightness(1.05);
}

.geo-btn-secondary {
  background: #f1f3f5;
  color: #495057;
}

.geo-btn-secondary:hover:not(:disabled) {
  background: #e9ecef;
}

/* 结果展示区域 */
.geo-result-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 16px 20px;
  background: #fafafa;
}

.geo-result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  font-weight: 600;
  color: #495057;
}

.geo-btn-mini {
  padding: 4px 10px;
  border: 1px solid #ddd;
  background: #fff;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  color: #666;
}

.geo-btn-mini:hover {
  background: #f5f5f5;
}

/* 展开结果按钮 */
.geo-result-expand-btn {
  display: block;
  width: calc(100% - 40px);
  margin: 8px 20px;
  padding: 8px 16px;
  border: 1px dashed #667eea;
  background: #f0f0ff;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  color: #667eea;
  text-align: center;
  transition: all 0.2s;
}

.geo-result-expand-btn:hover {
  background: #e5e5ff;
  border-color: #5568d3;
}

.geo-result-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 一键采用栏 */
.geo-adopt-all-bar {
  display: flex;
  justify-content: flex-end;
  padding: 4px 0 8px;
}

.geo-btn-adopt-all {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
  color: #fff !important;
  border: none !important;
  padding: 6px 16px !important;
  border-radius: 6px !important;
  font-size: 13px !important;
  cursor: pointer;
  transition: opacity 0.2s;
}

.geo-btn-adopt-all:hover {
  opacity: 0.9;
}

.geo-btn-adopt-all:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 结果卡片 */
.geo-result-card {
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  overflow: hidden;
}

.geo-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: #f8f9fa;
  border-bottom: 1px solid #eee;
}

.geo-card-title {
  font-weight: 600;
  color: #495057;
  font-size: 13px;
}

.geo-card-actions {
  display: flex;
  gap: 6px;
}

.geo-card-body {
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.6;
  color: #333;
  max-height: 200px;
  overflow-y: auto;
}

/* 小按钮 */
.geo-btn-small {
  padding: 3px 8px;
  border: 1px solid #ddd;
  background: #fff;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  color: #666;
  transition: all 0.2s;
}

.geo-btn-small:hover {
  background: #f5f5f5;
  border-color: #ccc;
}

.geo-btn-adopt {
  background: #d4edda;
  border-color: #c3e6cb;
  color: #155724;
}

.geo-btn-adopt:hover {
  background: #c3e6cb;
}

/* 关键词列表 */
.geo-keywords-list,
.geo-tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.geo-keyword-tag,
.geo-tag-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px 3px 10px;
  background: #e7f5ff;
  color: #1864ab;
  border-radius: 15px;
  font-size: 12px;
  transition: all 0.2s;
}

.geo-keyword-delete,
.geo-tag-delete {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(24, 100, 171, 0.15);
  color: #1864ab;
  cursor: pointer;
  font-size: 12px;
  font-weight: bold;
  line-height: 1;
  transition: all 0.15s;
}

.geo-keyword-delete:hover,
.geo-tag-delete:hover {
  background: #1864ab;
  color: #fff;
}

/* 关键词添加区域 */
.geo-keyword-add {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed #ddd;
}

.geo-keyword-input {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 12px;
  outline: none;
  transition: border-color 0.2s;
}

.geo-keyword-input:focus {
  border-color: #667eea;
}

/* 内联编辑 textarea */
.geo-edit-textarea {
  width: 100%;
  min-height: 80px;
  padding: 8px;
  border: 1px solid #667eea;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
  color: #333;
  resize: vertical;
  outline: none;
  font-family: inherit;
  box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.15);
}

/* 实体列表 */
.geo-entities-list {
  margin: 0;
  padding-left: 18px;
}

.geo-entities-list li {
  margin-bottom: 4px;
  color: #495057;
}

.geo-entity-type {
  display: inline-block;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  margin-right: 6px;
  font-weight: 500;
  vertical-align: middle;
}

.geo-entity-type.Person { background: #e3f2fd; color: #1565c0; }
.geo-entity-type.Organization { background: #fff3e0; color: #e65100; }
.geo-entity-type.Place { background: #e8f5e9; color: #2e7d32; }
.geo-entity-type.CreativeWork { background: #fce4ec; color: #c62828; }
.geo-entity-type.Periodical { background: #f3e5f5; color: #7b1fa2; }
.geo-entity-type.Thing { background: #f5f5f5; color: #616161; }

/* QA列表 */
.geo-qa-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.geo-qa-item {
  padding-bottom: 10px;
  border-bottom: 1px dashed #eee;
}

.geo-qa-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.geo-qa-q {
  color: #1864ab;
  font-weight: 500;
  margin-bottom: 4px;
}

.geo-qa-a {
  color: #495057;
  font-size: 12px;
}

/* 加载状态 */
.geo-loading {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: #666;
  font-size: 14px;
  background: rgba(255, 255, 255, 0.95);
  padding: 30px;
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  z-index: 100;
}

.geo-spinner {
  width: 36px;
  height: 36px;
  border: 3px solid #e9ecef;
  border-top-color: #667eea;
  border-radius: 50%;
  animation: geo-spin 0.8s linear infinite;
}

@keyframes geo-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 滚动条美化 */
.geo-result-area::-webkit-scrollbar,
.geo-card-body::-webkit-scrollbar {
  width: 6px;
}

.geo-result-area::-webkit-scrollbar-thumb,
.geo-card-body::-webkit-scrollbar-thumb {
  background: #ddd;
  border-radius: 3px;
}

.geo-result-area::-webkit-scrollbar-thumb:hover,
.geo-card-body::-webkit-scrollbar-thumb:hover {
  background: #ccc;
}

/* Toast 提示 */
.geo-toast {
  position: fixed;
  top: 20px;
  left: 50%;
  transform: translateX(-50%) translateY(-20px);
  padding: 10px 24px;
  border-radius: 8px;
  font-size: 14px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  z-index: 2147483647;
  opacity: 0;
  transition: all 0.3s ease;
  pointer-events: none;
  white-space: nowrap;
}

.geo-toast.geo-toast-show {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.geo-toast-success {
  background: #d4edda;
  color: #155724;
  border: 1px solid #c3e6cb;
  box-shadow: 0 4px 12px rgba(21, 87, 36, 0.15);
}

.geo-toast-error {
  background: #f8d7da;
  color: #721c24;
  border: 1px solid #f5c6cb;
  box-shadow: 0 4px 12px rgba(114, 28, 36, 0.15);
}

.geo-toast-warning {
  background: #fff3cd;
  color: #856404;
  border: 1px solid #ffeeba;
  box-shadow: 0 4px 12px rgba(133, 100, 4, 0.2);
  font-weight: 500;
}

/* 处理时间显示 */
.geo-process-time {
  padding: 10px 12px;
  background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
  border-radius: 8px;
  margin-bottom: 10px;
  border: 1px solid #bae6fd;
}

.geo-process-main {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.geo-process-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.geo-process-label {
  color: #64748b;
  font-weight: 500;
}

.geo-process-value {
  color: #1e40af;
  font-weight: 600;
}

.geo-process-duration {
  color: #dc2626;
  font-weight: 700;
  font-size: 13px;
}

/* 详细时间信息 */
.geo-process-details {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed #93c5fd;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.geo-process-detail-label {
  font-size: 11px;
  color: #64748b;
  font-weight: 500;
}

.geo-process-detail-items {
  font-size: 11px;
  color: #3b82f6;
}

.geo-process-detail-items span {
  margin-right: 8px;
}

.geo-process-detail-items span:last-child {
  margin-right: 0;
}

/* 响应式：小屏幕隐藏侧边栏 */
@media (max-width: 768px) {
  #geo-sidebar {
    width: 100%;
  }
}

/* ============ Tab标签页样式 ============ */

.geo-tabs {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 操作栏（一键采用 + 预览） */
.geo-action-bar {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px 16px;
  background: #fff;
  border-bottom: 1px solid #eee;
  flex-shrink: 0;
}

.geo-action-bar .geo-btn-adopt-all {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
  color: #fff !important;
  border: none !important;
  padding: 6px 16px !important;
  border-radius: 6px !important;
  font-size: 13px !important;
  cursor: pointer;
  transition: opacity 0.2s;
}

.geo-action-bar .geo-btn-adopt-all:hover {
  opacity: 0.9;
}

.geo-action-bar .geo-btn-preview {
  background: #f1f3f5 !important;
  border: 1px solid #dee2e6 !important;
  color: #495057 !important;
  padding: 6px 16px !important;
  border-radius: 6px !important;
  font-size: 13px !important;
  cursor: pointer;
  transition: background 0.2s;
}

.geo-action-bar .geo-btn-preview:hover {
  background: #e9ecef !important;
}

.geo-tab-bar {
  display: flex;
  border-bottom: 2px solid #eee;
  flex-shrink: 0;
}

.geo-tab-btn {
  flex: 1;
  padding: 8px 4px;
  border: none;
  background: #f8f9fa;
  font-size: 12px;
  font-weight: 500;
  color: #6c757d;
  cursor: pointer;
  transition: all 0.2s;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
}

.geo-tab-btn:hover {
  color: #495057;
  background: #e9ecef;
}

.geo-tab-btn.active {
  color: #667eea;
  background: #fff;
  border-bottom-color: #667eea;
}

.geo-tab-panels {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
}

.geo-tab-panel {
  display: none;
}

.geo-tab-panel.active {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ============ 知识卡片样式 ============ */

.geo-kc-divider {
  height: 1px;
  background: linear-gradient(90deg, transparent, #c0c0c0, transparent);
  margin: 16px 0;
}

.geo-kc-template {
  background: linear-gradient(135deg, #f5f0ff 0%, #fce4f3 100%);
  border-radius: 8px;
  padding: 12px 14px;
  border: 1px solid #e0d0f0;
}

.geo-kc-template-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.geo-kc-template-icon {
  font-size: 20px;
}

.geo-kc-template-name {
  font-weight: 600;
  font-size: 14px;
  color: #495057;
  flex: 1;
}

.geo-kc-confidence {
  font-size: 11px;
  padding: 2px 8px;
  background: #fff;
  border-radius: 10px;
  color: #667eea;
  font-weight: 500;
  border: 1px solid #d0c8f0;
}

.geo-kc-reason {
  font-size: 12px;
  color: #6c757d;
  margin-bottom: 8px;
  padding-left: 28px;
}

.geo-kc-template-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #495057;
  padding-top: 8px;
  border-top: 1px dashed #d0c8f0;
}

.geo-kc-template-select {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid #d0c8f0;
  border-radius: 4px;
  font-size: 12px;
  color: #495057;
  background: #fff;
  outline: none;
  cursor: pointer;
}

.geo-kc-template-select:focus {
  border-color: #a18cd1;
}

.geo-kc-missing {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: #fff3cd;
  border-radius: 6px;
  font-size: 12px;
  color: #856404;
  border: 1px solid #ffc107;
}

.geo-kc-missing-icon {
  font-size: 14px;
}

.geo-kc-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.geo-kc-field {
  background: #fff;
  border-radius: 6px;
  border: 1px solid #e9ecef;
  padding: 8px 12px;
  transition: border-color 0.2s;
}

.geo-kc-field:hover {
  border-color: #d0c8f0;
}

.geo-kc-field-required {
  border-left: 3px solid #667eea;
}

.geo-kc-field-label {
  font-size: 12px;
  font-weight: 600;
  color: #495057;
  margin-bottom: 4px;
}

.geo-kc-required-mark {
  color: #dc3545;
  margin-right: 2px;
}

.geo-kc-field-value {
  font-size: 13px;
  color: #333;
  line-height: 1.5;
}

.geo-kc-editable {
  cursor: pointer;
  border-bottom: 1px dashed #ccc;
  padding: 1px 2px;
  transition: border-color 0.2s;
}

.geo-kc-editable:hover {
  border-bottom-color: #667eea;
  background: #f0f0ff;
}

.geo-kc-edit-input {
  width: 100%;
  padding: 4px 6px;
  border: 1px solid #667eea;
  border-radius: 4px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.5;
  outline: none;
  box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.15);
  resize: vertical;
}

.geo-kc-evidence {
  font-size: 11px;
  color: #6c757d;
  padding: 2px 6px;
  background: #f8f9fa;
  border-radius: 3px;
  margin-top: 4px;
  border-left: 2px solid #dee2e6;
}

.geo-kc-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  background: #e7f5ff;
  color: #1864ab;
  border-radius: 12px;
  font-size: 12px;
  margin: 2px;
  transition: all 0.2s;
}

.geo-kc-tag-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: rgba(24, 100, 171, 0.15);
  color: #1864ab;
  cursor: pointer;
  font-size: 11px;
  font-weight: bold;
  line-height: 1;
  transition: all 0.15s;
}

.geo-kc-tag-del:hover {
  background: #1864ab;
  color: #fff;
}

.geo-kc-qa-item {
  padding-bottom: 6px;
  border-bottom: 1px dashed #eee;
  margin-bottom: 4px;
}

.geo-kc-qa-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
  margin-bottom: 0;
}

.geo-kc-qa-q {
  color: #1864ab;
  font-weight: 500;
  font-size: 12px;
  margin-bottom: 2px;
}

.geo-kc-qa-a {
  color: #495057;
  font-size: 12px;
}

.geo-kc-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding-top: 8px;
  border-top: 1px solid #eee;
}

.geo-kc-save {
  background: #d4edda !important;
  border-color: #c3e6cb !important;
  color: #155724 !important;
}

.geo-kc-save:hover {
  background: #c3e6cb !important;
}

.geo-kc-copy-json {
  background: #d1ecf1 !important;
  border-color: #bee5eb !important;
  color: #0c5460 !important;
}

.geo-kc-copy-json:hover {
  background: #bee5eb !important;
}

.geo-kc-export {
  background: #e2d5f1 !important;
  border-color: #d0c0e8 !important;
  color: #5b3a8c !important;
}

.geo-kc-export:hover {
  background: #d0c0e8 !important;
}

.geo-kc-ignore {
  background: #f8f9fa !important;
  border-color: #dee2e6 !important;
  color: #6c757d !important;
}

.geo-kc-ignore:hover {
  background: #e9ecef !important;
}

/* ==================== 可视化预览弹窗 ==================== */
#geo-preview-modal {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 14px;
  color: #333;
}

.geo-preview-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.5);
}

.geo-preview-container {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 680px;
  max-height: 80vh;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.geo-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid #e9ecef;
  background: #f8f9fa;
}

.geo-preview-title {
  font-size: 16px;
  font-weight: 600;
  color: #333;
}

.geo-preview-close {
  background: none;
  border: none;
  font-size: 22px;
  cursor: pointer;
  color: #666;
  padding: 0 4px;
  line-height: 1;
}

.geo-preview-close:hover {
  color: #333;
}

.geo-preview-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

.geo-preview-footer {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  padding: 12px 20px;
  border-top: 1px solid #e9ecef;
  background: #f8f9fa;
}

/* 预览区块 */
.geo-preview-section {
  margin-bottom: 20px;
}

.geo-preview-section-title {
  font-size: 14px;
  font-weight: 600;
  color: #333;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 2px solid #667eea;
  display: flex;
  align-items: center;
  gap: 8px;
}

.geo-preview-badge {
  display: inline-block;
  background: #667eea;
  color: #fff;
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 10px;
  font-weight: 500;
}

.geo-preview-type-badge {
  display: inline-block;
  background: #764ba2;
  color: #fff;
  font-size: 12px;
  padding: 3px 12px;
  border-radius: 12px;
  font-weight: 600;
  margin-bottom: 10px;
}

/* JSON-LD 可视化 */
.geo-preview-jsonld {
  background: #f8f9fa;
  border-radius: 8px;
  padding: 12px;
}

.geo-preview-graph-item {
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 10px;
}

.geo-preview-graph-item:last-child {
  margin-bottom: 0;
}

.geo-preview-graph-type {
  font-size: 13px;
  font-weight: 600;
  color: #764ba2;
  margin-bottom: 8px;
}

.geo-preview-ld-fields {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.geo-preview-ld-field {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.geo-preview-ld-key {
  color: #667eea;
  font-weight: 500;
  min-width: 90px;
  flex-shrink: 0;
}

.geo-preview-ld-val {
  color: #333;
  word-break: break-all;
}

.geo-preview-ld-type {
  display: inline-block;
  background: #e8e0f0;
  color: #764ba2;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.geo-preview-ld-name {
  color: #333;
}

.geo-preview-ld-ref {
  color: #667eea;
  font-family: monospace;
}

/* 原始卡片数据 */
.geo-preview-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.geo-preview-field {
  display: flex;
  gap: 10px;
  font-size: 13px;
}

.geo-preview-field-label {
  color: #666;
  font-weight: 500;
  min-width: 80px;
  flex-shrink: 0;
}

.geo-preview-field-value {
  color: #333;
  word-break: break-all;
}

.geo-preview-tag {
  display: inline-block;
  background: #e8eaf6;
  color: #3f51b5;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  margin: 1px 3px 1px 0;
}

.geo-preview-qa {
  margin-bottom: 4px;
}

.geo-preview-q {
  color: #667eea;
  font-weight: 500;
  margin-right: 8px;
}

.geo-preview-a {
  color: #333;
}

/* JSON源码 */
.geo-preview-json {
  background: #1e1e2e;
  color: #cdd6f4;
  padding: 14px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
  overflow-x: auto;
  max-height: 300px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}
`;
    document.head.appendChild(style);
  }

  // ========== 2. GEO_SHARED_CONSTANTS (硬编码，来源: config/config.json) ==========
  const GEO_SHARED_CONSTANTS = {
    VALID_SCHEMA_TYPES: ['Person', 'Organization', 'Place', 'CreativeWork', 'Periodical', 'CollegeOrUniversity', 'ResearchOrganization', 'Thing'],
    SCHEMA_TYPES_REGEX: '(Person|Organization|Place|CreativeWork|Periodical|CollegeOrUniversity|ResearchOrganization|Thing)',
    AUTHOR_ROLES_REGEX: '^(记者|通讯员|摄影|编辑|见习记者|本报记者)\\s+(.+)$',
    DEFAULT_TEMPLATE_ID: 'basic_fact_card',
    DEFAULT_TEMPLATE_NAME: '基础新闻事实卡',
    TAG_PATTERNS: [
      { keywords: ['会议', '座谈', '研讨', '论坛'], tag: '会议' },
      { keywords: ['项目', '开工', '竣工', '投产'], tag: '项目' },
      { keywords: ['民生', '就业', '医疗', '教育'], tag: '民生' },
      { keywords: ['文化', '旅游', '景区', '公园'], tag: '文旅' },
      { keywords: ['经济', '产业', '企业', '投资'], tag: '经济' },
      { keywords: ['安全', '生产', '消防', '应急'], tag: '安全' },
      { keywords: ['党建', '党史', '党员'], tag: '党建' },
      { keywords: ['乡村', '农村', '振兴'], tag: '乡村振兴' }
    ]
  };

  // ========== 3. utils.js (替换safeSendMessage) ==========

  function safeSendMessage(message, callback) {
    return new Promise((resolve) => {
      if (message.action === 'getConfig') {
        const config = {};
        try {
          const raw = localStorage.getItem('geo_config');
          if (raw) Object.assign(config, JSON.parse(raw));
        } catch (e) {}
        config.providerMode = config.providerMode || 'mock';
        resolve(config);
      } else if (message.action === 'saveConfig') {
        try {
          localStorage.setItem('geo_config', JSON.stringify(message.data));
        } catch (e) {}
        resolve({ success: true });
      } else if (message.action === 'saveToKnowledgeBase') {
        try {
          const kb = JSON.parse(localStorage.getItem('geo_knowledge_base') || '[]');
          kb.push({ ...message.data, savedAt: new Date().toISOString() });
          localStorage.setItem('geo_knowledge_base', JSON.stringify(kb));
          resolve({ success: true, count: kb.length });
        } catch (e) { resolve({ success: false }); }
      } else {
        resolve({});
      }
      if (typeof callback === 'function') callback(resolve);
    });
  }

  function findElementRecursively(doc, fieldId, depth, maxDepth) {
    maxDepth = maxDepth || 5;
    if (depth > maxDepth) return null;

    const element = doc.getElementById(fieldId);
    if (element) return element;

    try {
      const iframes = doc.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
          if (!iframeDoc) continue;
          const found = findElementRecursively(iframeDoc, fieldId, depth + 1, maxDepth);
          if (found) return found;
        } catch (e) {
          // 跨域iframe无法访问
        }
      }
    } catch (error) {}

    return null;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      showToast('已复制到剪贴板');
    } catch (e) {
      showToast('复制失败，请手动选择复制', 'error');
    }
    document.body.removeChild(textarea);
  }

  function showToast(message, type, duration) {
    type = type || 'success';
    duration = duration || 2000;
    const existing = document.getElementById('geo-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'geo-toast';
    toast.className = 'geo-toast geo-toast-' + type;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('geo-toast-show');
    });

    setTimeout(() => {
      toast.classList.remove('geo-toast-show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  function showLoading(show) {
    const loading = document.getElementById('geo-loading');
    if (loading) {
      loading.style.display = show ? 'flex' : 'none';
      document.querySelectorAll('.geo-action-buttons .geo-btn').forEach(btn => {
        btn.disabled = show;
      });
    }
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function parseTypedArray(val, defaultType) {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string' && val.trim()) {
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) return parsed;
        return [parsed];
      } catch (e) {
        return val.split(/[，,、]/).filter(s => s.trim()).map(s => {
          const m = s.trim().match(/^(.+)\((Person|Organization|Thing|CreativeWork)\)$/);
          if (m) return { name: m[1].trim(), type: m[2] };
          return { name: s.trim(), type: defaultType || 'Thing' };
        });
      }
    }
    if (val && typeof val === 'object') return [val];
    return [];
  }

  function removeTagWithAnimation(tagElement) {
    tagElement.style.transform = 'scale(0)';
    tagElement.style.opacity = '0';
    setTimeout(() => tagElement.remove(), 200);
  }

  // ========== 4. fieldReader.js ==========

  const GeoFieldReader = {
    TITLE_INPUT_ID: 'news_tnNewsVo_title',
    CONTENT_TEXTAREA_ID: 'news_clobs_content_',
    MAX_DEPTH: 5,

    async readTitleAndContent() {
      try {
        let title = null;
        let content = null;

        const found = this.searchRecursively(document, 0);
        title = found.title;
        content = found.content;

        if (!content) {
          content = await this.readFromVisualEditor();
        }

        return {
          success: !!(title || content),
          title: title || '',
          content: content || '',
          contentLength: (content || '').replace(/\s/g, '').length
        };
      } catch (error) {
        console.error('读取字段失败:', error);
        return { success: false, title: '', content: '', contentLength: 0 };
      }
    },

    searchRecursively(doc, depth) {
      let result = { title: null, content: null };

      if (depth > this.MAX_DEPTH) return result;

      result.title = this.readFromDocument(doc, this.TITLE_INPUT_ID);
      result.content = this.readFromDocument(doc, this.CONTENT_TEXTAREA_ID);

      if (result.title && result.content) return result;

      try {
        const iframes = doc.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
            if (!iframeDoc) continue;

            const iframeResult = this.searchRecursively(iframeDoc, depth + 1);

            if (!result.title && iframeResult.title) {
              result.title = iframeResult.title;
            }
            if (!result.content && iframeResult.content) {
              result.content = iframeResult.content;
            }

            if (result.title && result.content) return result;
          } catch (e) {
            console.log('无法访问iframe(深度' + depth + '):', e.message);
          }
        }
      } catch (error) {
        console.error('遍历iframe失败:', error);
      }

      return result;
    },

    readFromDocument(doc, elementId) {
      try {
        const element = doc.getElementById(elementId);
        if (!element) return null;
        const tagName = element.tagName.toLowerCase();
        if (tagName === 'input' || tagName === 'textarea') {
          return element.value || '';
        }
        if (element.isContentEditable) {
          return element.textContent || '';
        }
        return element.value || '';
      } catch (error) {
        return null;
      }
    },

    async readFromVisualEditor() {
      try {
        const radio0 = this.findElementById(document, 'editor_case_0');
        const radio1 = this.findElementById(document, 'editor_case_1');

        if (!radio0) {
          console.log('AI发布助手: 未找到editor_case_0 radio');
          return null;
        }

        const wasVisualMode = radio1 ? radio1.checked : false;

        if (!wasVisualMode) {
          console.log('AI发布助手: 当前已是文本模式，textarea应有值');
          return null;
        }

        console.log('AI发布助手: 当前为可视化模式，临时切换到文本模式读取正文');

        radio0.click();

        const content = await this.waitForTextareaContent(3000);

        if (wasVisualMode && radio1) {
          radio1.click();
          console.log('AI发布助手: 已恢复为可视化模式');
        }

        return content;
      } catch (error) {
        console.error('从可视化编辑器读取失败:', error);
        try {
          const radio1 = this.findElementById(document, 'editor_case_1');
          if (radio1 && !radio1.checked) radio1.click();
        } catch (e) {}
        return null;
      }
    },

    waitForTextareaContent(timeout) {
      return new Promise((resolve) => {
        const startTime = Date.now();
        const check = () => {
          const found = this.searchRecursively(document, 0);
          if (found.content && found.content.trim()) {
            resolve(found.content);
            return;
          }
          if (Date.now() - startTime > timeout) {
            console.log('AI发布助手: 等待textarea内容超时');
            resolve(null);
            return;
          }
          setTimeout(check, 100);
        };
        check();
      });
    },

    findElementById(doc, elementId) {
      const el = doc.getElementById(elementId);
      if (el) return el;

      try {
        const iframes = doc.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
            if (!iframeDoc) continue;
            const found = this.findElementById(iframeDoc, elementId);
            if (found) return found;
          } catch (e) {}
        }
      } catch (e) {}

      return null;
    }
  };

  // ========== 5. fieldWriter.js ==========

  const GeoFieldWriter = {
    fieldMapping: {
      title: 'news_tnNewsVo_title',
      summary: 'news_clobs_abstract_',
      introduction: 'news_tnNewsVo_zhaiyao',
      keywords: 'news_tnNewsVo_keywords',
      tags: 'news_tnNewsVo_tags',
      authors: 'news_tnNewsVo_keywords4',
      knowledgeCard: 'news_clobs_content6_',
    },
    MAX_DEPTH: 5,

    writeField(fieldType, data) {
      try {
        const fieldId = this.fieldMapping[fieldType];
        if (!fieldId) return false;

        let element = findElementRecursively(document, fieldId, 0, this.MAX_DEPTH);
        if (!element) return false;

        this.setValue(element, data);
        return true;
      } catch (error) {
        console.error('回填失败:', error);
        return false;
      }
    },

    setValue(element, data) {
      const tagName = element.tagName.toLowerCase();
      if (tagName === 'input' || tagName === 'textarea') {
        element.value = data;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (element.isContentEditable) {
        element.textContent = data;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        element.textContent = data;
      }
    }
  };

  // ========== 6. cozeProvider.js ==========

  const GeoCozeProvider = {
    PROXY_API: 'https://phpdev.66wz.com/api/coze-proxy.php',
    POLL_INTERVAL: 3000,
    MAX_POLL_TIME: 120000,
    _apiBaseUrl: 'https://phpdev.66wz.com/api',

    async init() {
      return true;
    },

    async completePublishInfo(content) {
      try {
        const result = await this._runWorkflow(content, '', 'complete');
        return result;
      } catch (error) {
        console.error('Coze调用失败，回退到Mock模式:', error);
        return GeoMockProvider.completePublishInfo(content);
      }
    },

    async _runWorkflow(content, title, task) {
      const result = await this._submitWorkflow(content, title, task);

      if (result.data) {
        return this._parseOutput(result.data, task);
      }

      if (result.execute_id) {
        const output = await this._pollResult(result.execute_id);
        return this._parseOutput(output, task);
      }

      throw new Error('工作流未返回有效结果');
    },

    async _submitWorkflow(content, title, task) {
      const body = { content: content, task: task || 'complete' };
      if (title) body.title = title;

      const response = await fetch(this.PROXY_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMsg = `代理接口请求失败: ${response.status}`;
        try {
          const errorData = JSON.parse(errorText);
          errorMsg = errorData.error || errorMsg;
        } catch (e) {}
        throw new Error(errorMsg);
      }

      const result = await response.json();

      if (result.code !== 0) {
        throw new Error(`Coze工作流提交失败: ${result.msg || '未知错误'}`);
      }

      return {
        data: result.data || '',
        execute_id: result.execute_id || '',
        token: result.token || 0,
        debug_url: result.debug_url || ''
      };
    },

    async _pollResult(executeId) {
      const startTime = Date.now();

      while (Date.now() - startTime < this.MAX_POLL_TIME) {
        try {
          const response = await fetch(
            `${this.PROXY_API}?execute_id=${encodeURIComponent(executeId)}`,
            {
              method: 'GET',
              headers: {
                'Content-Type': 'application/json'
              }
            }
          );

          if (!response.ok) {
            console.warn('轮询请求失败，继续重试...');
            await this._delay(this.POLL_INTERVAL);
            continue;
          }

          const history = await response.json();

          if (!history.data || history.data.length === 0) {
            console.log('暂无数据返回，继续查询...');
            await this._delay(this.POLL_INTERVAL);
            continue;
          }

          const status = history.data[0].execute_status;
          console.log('工作流状态:', status);

          if (status === 'Success') {
            const usage = history.data[0].usage || {};
            console.log('Token消耗:', usage);
            return history.data[0].output || '';
          }

          if (status === 'Failed') {
            const errorMsg = history.data[0].error_message || '未知错误';
            throw new Error(`工作流执行失败: ${errorMsg}`);
          }

          await this._delay(this.POLL_INTERVAL);

        } catch (error) {
          if (error.message.includes('工作流执行失败')) {
            throw error;
          }
          console.warn('轮询异常:', error.message);
          await this._delay(this.POLL_INTERVAL);
        }
      }

      throw new Error('工作流执行超时');
    },

    _parseOutput(outputStr, task) {
      if (!outputStr) {
        throw new Error('工作流输出为空');
      }

      let layer1;
      try {
        layer1 = JSON.parse(outputStr);
      } catch (e) {
        throw new Error('输出JSON解析失败: ' + e.message);
      }

      const outputInner = layer1.Output || layer1.output || '';
      if (!outputInner) {
        if (layer1.summary || layer1.templateId) {
          return this._buildResult(layer1, task);
        }
        throw new Error('Output字段为空，请检查Coze工作流输出节点配置');
      }

      let rawOutput = '';
      if (typeof outputInner === 'string' && outputInner.trim().startsWith('```')) {
        rawOutput = outputInner;
      } else {
        let layer2;
        try {
          layer2 = typeof outputInner === 'string' ? JSON.parse(outputInner) : outputInner;
        } catch (e) {
          throw new Error('输出嵌套JSON解析失败: ' + e.message);
        }
        rawOutput = layer2.output || layer2.Output || '';
        if (!rawOutput) {
          if (layer2.summary || layer2.templateId) {
            return this._buildResult(layer2, task);
          }
          throw new Error('内层output字段为空');
        }
      }

      let jsonStr = rawOutput.trim();
      jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/i, '');
      jsonStr = jsonStr.replace(/\n?```\s*$/i, '');
      jsonStr = jsonStr.trim();

      let outputData;
      try {
        outputData = JSON.parse(jsonStr);
      } catch (e) {
        throw new Error('输出JSON解析失败: ' + e.message);
      }

      return this._buildResult(outputData, task);
    },

    _buildResult(outputData, task) {
      return {
        templateId: outputData.templateId || 'basic_fact_card',
        templateName: outputData.templateName || '基础新闻事实卡',
        confidence: outputData.confidence || 0.8,
        classifyReason: outputData.classifyReason || '',
        fields: Array.isArray(outputData.fields) ? outputData.fields : [],
        title: outputData.title || '',
        summary: outputData.summary || '',
        keywords: Array.isArray(outputData.keywords) ? outputData.keywords : [],
        introduction: outputData.introduction || '',
        tags: Array.isArray(outputData.tags) ? outputData.tags : [],
        entities: Array.isArray(outputData.entities) ? outputData.entities.map(e => {
          if (typeof e === 'object' && e !== null) return e;
          if (typeof e === 'string') return { name: e, type: 'Thing' };
          return e;
        }) : [],
        authors: Array.isArray(outputData.authors) ? outputData.authors.map(a => {
          if (typeof a === 'object' && a !== null) return a;
          if (typeof a === 'string') {
            const match = a.match(/^(记者|通讯员|摄影|编辑|见习记者|本报记者)\s+(.+)$/);
            if (match) return { role: match[1], name: match[2] };
            return { role: '', name: a };
          }
          return a;
        }) : [],
        qa: Array.isArray(outputData.qa) ? outputData.qa : [],
        eventDate: outputData.eventDate || '',
        eventDate_evidence: outputData.eventDate_evidence || '',
        location: outputData.location || '',
        location_evidence: outputData.location_evidence || '',
        keyFact: outputData.keyFact || '',
        eventName: outputData.eventName || '',
        organizer: outputData.organizer || '',
        participants: Array.isArray(outputData.participants) ? outputData.participants.map(p => {
          if (typeof p === 'object' && p !== null) return p;
          if (typeof p === 'string') {
            const m = p.match(/^(.+)\((Organization|Person|Thing)\)$/);
            if (m) return { name: m[1], type: m[2] };
            return { name: p, type: 'Organization' };
          }
          return p;
        }) : (outputData.participants || ''),
        result: outputData.result || '',
        scale: outputData.scale || '',
        eventLink: outputData.eventLink || '',
        leaderName: outputData.leaderName || '',
        leaderName_evidence: outputData.leaderName_evidence || '',
        leaderTitle: outputData.leaderTitle || '',
        activityType: outputData.activityType || '',
        speechHighlights: outputData.speechHighlights || '',
        attendees: outputData.attendees || '',
        keyDecision: outputData.keyDecision || '',
        eventDescription: outputData.eventDescription || '',
        casualty: outputData.casualty || '',
        impact: outputData.impact || '',
        response: outputData.response || '',
        reminder: outputData.reminder || '',
        institution: (typeof outputData.institution === 'object' && outputData.institution !== null) ? outputData.institution : { name: outputData.institution || '', type: 'Organization' },
        researchField: outputData.researchField || '',
        achievement: outputData.achievement || '',
        significance: outputData.significance || '',
        keyPerson: Array.isArray(outputData.keyPerson) ? outputData.keyPerson.map(p => {
          if (typeof p === 'object' && p !== null) return p;
          if (typeof p === 'string') {
            const m = p.match(/^(.+)\((Person|Organization|Thing)\)$/);
            if (m) return { name: m[1], type: m[2] };
            return { name: p, type: 'Person' };
          }
          return p;
        }) : (outputData.keyPerson || ''),
        dataSupport: outputData.dataSupport || '',
        industry: outputData.industry || '',
        dataIndicator: outputData.dataIndicator || '',
        trend: outputData.trend || '',
        policyImpact: outputData.policyImpact || '',
        keyEntity: Array.isArray(outputData.keyEntity) ? outputData.keyEntity.map(e => {
          if (typeof e === 'object' && e !== null) return e;
          if (typeof e === 'string') {
            const m = e.match(/^(.+)\((Organization|CreativeWork|Thing|Person)\)$/);
            if (m) return { name: m[1], type: m[2] };
            return { name: e, type: 'Organization' };
          }
          return e;
        }) : (outputData.keyEntity || ''),
        comparison: outputData.comparison || ''
      };
    },

    _delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
  };

  // ========== 7. dmxProvider.js (替换chrome APIs) ==========

  const GeoDmxProvider = {
    API_URL: 'https://www.dmxapi.cn/v1/chat/completions',
    API_KEY: 'sk-wEWb0Zoc7XFmXKy2yo7SdTaVRZRwwjPzLomJEh3gETkkjWOl',

    MODELS: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash（快速）' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro（高质量）' },
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'qwen3.6-27b', name: 'Qwen3.6-27B' },
      { id: 'qwen3.6-flash', name: 'Qwen3.6 Flash（快速）' }
    ],

    DEFAULT_MODEL: 'deepseek-v4-pro',
    _selectedModel: null,

    async init() {
      try {
        const raw = localStorage.getItem('geo_config');
        const config = raw ? JSON.parse(raw) : {};
        if (config.dmxModel === 'custom' && config.dmxCustomModel) {
          this._selectedModel = config.dmxCustomModel;
        } else {
          this._selectedModel = config.dmxModel || this.DEFAULT_MODEL;
        }
      } catch (e) {
        this._selectedModel = this.DEFAULT_MODEL;
      }
      return true;
    },

    getModel() {
      return this._selectedModel || this.DEFAULT_MODEL;
    },

    async completePublishInfo(content) {
      try {
        const result = await this._callModel(content);
        return result;
      } catch (error) {
        console.error('DMX调用失败，回退到Mock模式:', error);
        const mockResult = await GeoMockProvider.completePublishInfo(content);
        mockResult._fallbackToMock = true;
        mockResult._fallbackReason = error.message;
        return mockResult;
      }
    },

    async _buildPrompt(content) {
      let promptTemplate = this._getDefaultPrompt();

      const { templateList, requiredFields } = this._generateTemplateInfoSync();

      let prompt = promptTemplate
        .replace('{{content}}', content)
        .replace('{{template_list}}', templateList)
        .replace('{{required_fields}}', requiredFields);

      return prompt;
    },

    _generateTemplateInfoSync() {
      let templateList = '';
      let requiredFields = '';
      const options = (typeof TEMPLATE_OPTIONS !== 'undefined') ? TEMPLATE_OPTIONS : [];
      if (options.length > 0) {
        const tplTableLines = ['| 模板ID | 名称 | 适用场景 |', '|--------|------|----------|'];
        const matchRules = ['- 根据标题和正文内容判断最合适的知识卡片模板', '- 给出置信度（0-1之间的数值）和推荐理由', '- 识别规则（按优先级从高到低）：'];
        const reqTableLines = ['| 模板ID | 必填字段 | 说明 |', '|--------|----------|------|'];
        options.forEach(opt => {
          const tpl = (TEMPLATE_CONFIG && TEMPLATE_CONFIG.templates) ? TEMPLATE_CONFIG.templates.find(t => t.id === opt.id) : null;
          tplTableLines.push('| ' + opt.id + ' | ' + opt.name + ' | ' + (tpl && tpl.applicableScenarios || '') + ' |');
          if (tpl && tpl.matchRules && tpl.matchRules.keywords && tpl.matchRules.keywords.length > 0) {
            matchRules.push('  - 包含"' + tpl.matchRules.keywords.join('/') + '"等关键词 → ' + opt.id);
          } else {
            matchRules.push('  - 其他 → ' + opt.id);
          }
          const reqFields = (opt.fields || []).filter(f => f.required);
          reqTableLines.push('| ' + opt.id + ' | ' + reqFields.map(f => f.key).join(', ') + ' | ' + reqFields.map(f => f.label).join('、') + ' |');
        });
        matchRules.push('- **优先级原则**：当多个模板都可能匹配时，选择能抽取更多结构化字段的模板。');
        templateList = tplTableLines.join('\n') + '\n\n' + matchRules.join('\n');
        requiredFields = reqTableLines.join('\n');
      }
      return { templateList, requiredFields };
    },

    _getDefaultPrompt() {
      return `# 角色
你是一个专业的新闻内容结构化助手，专注于从新闻正文中自动提取并生成标准化的新闻发布补充信息，同时识别内容类型、匹配知识卡片模板，并抽取结构化字段数据。你需要严格依据新闻正文的事实内容，以客观、准确、简洁的语言完成以下信息的结构化处理，为新闻发布提供清晰、规范的辅助内容。

## 输入
正文：{{content}}

## 知识卡片模板类型

{{template_list}}

## 技能

### 技能 1: 内容类型识别
- 根据标题和正文内容判断最合适的知识卡片模板
- 给出置信度（0-1之间的数值）和推荐理由
- 置信度低于0.6时默认使用basic_fact_card

### 技能 2: 标题生成
- 基于新闻正文核心事件、时间、地点或人物，生成15-30字的标题

### 技能 3: 摘要提炼
- 用100-150字概括新闻核心内容，确保客观中立

### 技能 4: 关键词提取
- 提取5个最具代表性的关键词

### 技能 5: 导读撰写
- 创作50-80字的导读内容

### 技能 6: 主题标签选择
- 选择3个与内容高度相关的主题标签

### 技能 7: 核心实体识别
- 识别3-5个核心实体，标注类型

### 技能 8: 常见问答（QA）生成
- 生成2组问答，附带原文依据

### 技能 9: 作者提取
- 提取所有作者信息

### 技能 10: 模板字段抽取
{{required_fields}}

## 输出格式
严格按照以下JSON模板输出结果，不得包含任何额外文本说明：
\`\`\`json
{
  "templateId": "模板ID",
  "templateName": "模板中文名称",
  "confidence": 0.85,
  "classifyReason": "推荐理由",
  "fields": [
    {"key": "字段key", "label": "字段中文名", "required": true, "value": "字段值", "evidence": "原文依据"}
  ],
  "title": "标题",
  "summary": "摘要",
  "keywords": ["关键词1", "关键词2", "关键词3", "关键词4", "关键词5"],
  "introduction": "导读",
  "tags": ["标签1", "标签2", "标签3"],
  "entities": [{"name": "实体名", "type": "Person|Organization|Place|CreativeWork|Periodical|Thing"}],
  "authors": [{"role": "身份", "name": "姓名"}],
  "qa": [
    {"q": "问题", "a": "回答", "evidence": "原文依据"}
  ]
}
\`\`\`

## 限制条件
1. 所有信息必须严格基于输入的新闻正文，不得编造或篡改
2. 输出语言需正式、客观
3. 字数限制：标题不超过30字，摘要不超过150字
4. 正文中未提及的信息留空字符串""
5. 通用字段必须全部输出`;
    },

    async _callModel(content) {
      const model = this.getModel();
      const prompt = await this._buildPrompt(content);

      console.group('%c[GEO-DMX] 发送给大模型的内容', 'color: #4CAF50; font-weight: bold;');
      console.log('模型:', model);
      console.log('提示词长度:', prompt.length, '字符');
      console.log('完整提示词:', prompt);
      console.log('正文内容:', content);
      console.groupEnd();

      const requestBody = {
        model: model,
        messages: [
          {
            role: 'system',
            content: '你是一个专业的新闻内容结构化助手。严格按照要求的JSON格式输出，不要包含任何额外文本。'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 4000,
        thinking: { type: 'disabled' },
        stream: true
      };

      console.log('[GEO-DMX] 请求体:', { ...requestBody, stream: true });

      const startTime = Date.now();
      const response = await fetch(this.API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.API_KEY}`
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMsg = `DMX API请求失败: ${response.status}`;
        try {
          const errorData = JSON.parse(errorText);
          errorMsg = errorData.error?.message || errorData.error || errorMsg;
        } catch (e) {}
        throw new Error(errorMsg);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let buffer = '';
      let firstTokenTime = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta?.content || '';
            if (delta) {
              if (!firstTokenTime) {
                firstTokenTime = Date.now() - startTime;
                console.log(`[GEO-DMX] 首字耗时: ${firstTokenTime}ms`);
              }
              fullContent += delta;
            }
          } catch (e) {
            // 忽略解析错误的chunk
          }
        }
      }

      const totalTime = Date.now() - startTime;
      console.log(`[GEO-DMX] 流式总耗时: ${totalTime}ms, 内容长度: ${fullContent.length}`);

      if (!fullContent) {
        throw new Error('DMX API返回内容为空');
      }

      return this._parseOutput(fullContent);
    },

    _parseOutput(outputStr) {
      if (!outputStr) {
        throw new Error('模型输出为空');
      }

      let jsonStr = outputStr.trim();

      jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/i, '');
      jsonStr = jsonStr.replace(/\n?```\s*$/i, '');
      jsonStr = jsonStr.trim();

      jsonStr = jsonStr
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');

      let outputData;
      try {
        outputData = JSON.parse(jsonStr);
      } catch (firstError) {
        console.warn('[GEO-DMX] JSON首次解析失败，尝试修复...', firstError.message);

        const firstBrace = jsonStr.indexOf('{');
        const lastBrace = jsonStr.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          let subStr = jsonStr.substring(firstBrace, lastBrace + 1);
          try {
            outputData = JSON.parse(subStr);
          } catch (e2) {
            throw new Error('输出JSON解析失败: ' + firstError.message);
          }
        } else {
          throw new Error('输出JSON解析失败: ' + firstError.message);
        }
      }

      return this._buildResult(outputData);
    },

    _buildResult(outputData) {
      return GeoCozeProvider._buildResult(outputData, 'complete');
    }
  };

  // ========== 8. mockProvider.js ==========

  const GeoMockProvider = {
    async completePublishInfo(content) {
      await this._delay(800 + Math.random() * 700);

      const title = this._generateTitle(content);
      const keywords = this._extractKeywords(content);
      const summary = this._generateSummary(content);
      const introduction = this._generateIntroduction(content);
      const tags = this._extractTags(content);
      const entities = this._extractEntities(content);
      const qa = this._generateQA(content, entities);
      const authors = this._extractAuthors(content);
      const classify = this._classifyContent(title, content);
      const cardFields = this._extractCardFields(classify.templateId, title, content);

      return {
        templateId: classify.templateId,
        templateName: classify.templateName || classify.templateId,
        confidence: classify.confidence,
        classifyReason: classify.reason,
        fields: cardFields._fields || [],
        title,
        summary,
        keywords,
        introduction,
        tags,
        entities,
        authors,
        qa
      };
    },

    _classifyContent(text) {
      const options = (typeof TEMPLATE_OPTIONS !== 'undefined') ? TEMPLATE_OPTIONS : [];
      const config = (typeof TEMPLATE_CONFIG !== 'undefined' && TEMPLATE_CONFIG) ? TEMPLATE_CONFIG : null;

      if (config && config.templates) {
        for (const tpl of config.templates) {
          const rules = tpl.matchRules;
          if (!rules || !rules.keywords || rules.keywords.length === 0) continue;
          if (tpl.id === 'basic_fact_card') continue;
          const pattern = new RegExp(rules.keywords.join('|'));
          if (pattern.test(text)) {
            return {
              templateId: tpl.id,
              templateName: tpl.name,
              confidence: 0.75 + Math.random() * 0.15,
              reason: '内容涉及' + (tpl.applicableScenarios || tpl.name)
            };
          }
        }
      } else {
        for (const opt of options) {
          if (opt.id === 'basic_fact_card') continue;
          if (opt.name && text.includes(opt.name.replace(/[（）()类新闻]/g, ''))) {
            return {
              templateId: opt.id,
              templateName: opt.name,
              confidence: 0.7 + Math.random() * 0.15,
              reason: '内容涉及' + opt.name
            };
          }
        }
      }

      return {
        templateId: 'basic_fact_card',
        templateName: '基础新闻事实卡',
        confidence: 0.6 + Math.random() * 0.2,
        reason: '通用新闻事实，使用基础新闻事实卡'
      };
    },

    _extractCardFields(templateId, title, content) {
      const date = this._extractDate(content) || '';
      const dateEvidence = this._extractDateEvidence(content);
      const location = this._extractLocation(content) || '';
      const locationEvidence = this._extractLocationEvidence(content);
      const organizer = this._extractOrganizer(content) || '';

      const options = (typeof TEMPLATE_OPTIONS !== 'undefined') ? TEMPLATE_OPTIONS : [];
      const tplOption = options.find(o => o.id === templateId);
      const fields = tplOption ? tplOption.fields : [
        { key: 'eventDate', label: '事件日期', required: false },
        { key: 'location', label: '地点', required: false },
        { key: 'keyFact', label: '核心事实', required: false }
      ];

      const FIELD_DEFAULTS = {
        eventDate: () => date,
        location: () => location,
        organizer: () => organizer,
        institution: () => organizer ? { name: organizer, type: 'Organization' } : { name: '', type: 'Organization' },
        participants: () => [],
        keyPerson: () => [],
        keyEntity: () => [],
        attendees: () => [],
        eventDescription: () => this._truncate(content, 100),
        trend: () => this._truncate(content, 100),
        achievement: () => this._truncate(content, 100),
        speechHighlights: () => this._truncate(content, 100),
      };

      const FIELD_EVIDENCE = {
        eventDate: dateEvidence,
        location: locationEvidence,
      };

      const fieldValues = {};
      fields.forEach(f => {
        if (FIELD_DEFAULTS[f.key]) {
          fieldValues[f.key] = FIELD_DEFAULTS[f.key]();
        } else {
          fieldValues[f.key] = '';
        }
        if (FIELD_EVIDENCE[f.key]) {
          fieldValues[f.key + '_evidence'] = FIELD_EVIDENCE[f.key];
        }
      });

      const enrichedFields = fields.map(field => ({
        ...field,
        value: fieldValues[field.key] || '',
        evidence: fieldValues[field.key + '_evidence'] || ''
      }));

      fieldValues._fields = enrichedFields;
      return fieldValues;
    },

    _extractDate(content) {
      const patterns = [
        /(\d{4})年(\d{1,2})月(\d{1,2})日/,
        /(\d{4})\.(\d{1,2})\.(\d{1,2})/,
        /(\d{4})-(\d{1,2})-(\d{1,2})/
      ];
      for (const p of patterns) {
        const m = content.match(p);
        if (m) return m[0];
      }
      return '';
    },

    _extractDateEvidence(content) {
      const date = this._extractDate(content);
      if (!date) return '';
      const idx = content.indexOf(date);
      const start = Math.max(0, idx - 10);
      const end = Math.min(content.length, idx + date.length + 10);
      return '原文："' + content.substring(start, end) + '"';
    },

    _extractLocation(content) {
      const m = content.match(/([^\s]{2,8}(?:市|县|区|镇|路|街|广场|中心|馆|园|院))/);
      return m ? m[1] : '';
    },

    _extractLocationEvidence(content) {
      const loc = this._extractLocation(content);
      if (!loc) return '';
      const idx = content.indexOf(loc);
      const start = Math.max(0, idx - 8);
      const end = Math.min(content.length, idx + loc.length + 8);
      return '原文："' + content.substring(start, end) + '"';
    },

    _extractOrganizer(content) {
      const m = content.match(/([^\s]{2,10}(?:局|委|办|厅|部|会|中心|集团|公司|协会|基金会))/);
      return m ? m[1] : '';
    },

    _delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },

    _truncate(text, maxLength) {
      if (!text) return '';
      const plain = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (plain.length <= maxLength) return plain;
      return plain.substring(0, maxLength - 3) + '...';
    },

    _generateTitle(content) {
      const plain = this._truncate(content, 200);
      const sentences = plain.split(/[。！？]/);
      const first = sentences[0] || '';
      if (first.length <= 30) return first;
      return first.substring(0, 28) + '…';
    },

    _extractKeywords(content) {
      const allText = content || '';
      const words = allText.match(/[\u4e00-\u9fa5]{2,4}/g) || [];

      const freq = {};
      words.forEach(w => {
        if (w.length >= 2) {
          freq[w] = (freq[w] || 0) + 1;
        }
      });

      const sorted = Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(item => item[0]);

      return sorted.length > 0 ? sorted : ['新闻', '资讯'];
    },

    _generateSummary(content) {
      const plain = this._truncate(content, 200);
      if (plain.length < 50) return plain;

      const sentences = plain.split(/[。！？]/);
      if (sentences.length >= 2) {
        return sentences.slice(0, 2).join('。') + '。';
      }
      return this._truncate(plain, 100);
    },

    _generateIntroduction(content) {
      return `本文围绕${this._truncate(content, 15)}展开，${this._truncate(content, 80)}...`;
    },

    _extractTags(content) {
      const allText = content || '';
      const tags = [];

      let tagPatterns;
      if (typeof GEO_SHARED_CONSTANTS !== 'undefined' && GEO_SHARED_CONSTANTS.TAG_PATTERNS) {
        tagPatterns = GEO_SHARED_CONSTANTS.TAG_PATTERNS.map(tp => ({
          pattern: new RegExp(tp.keywords.join('|'), 'g'),
          tag: tp.tag
        }));
      } else {
        tagPatterns = [
          { pattern: /会议|座谈|研讨|论坛/g, tag: '会议' },
          { pattern: /项目|开工|竣工|投产/g, tag: '项目' },
          { pattern: /民生|就业|医疗|教育/g, tag: '民生' },
          { pattern: /文化|旅游|景区|公园/g, tag: '文旅' },
          { pattern: /经济|产业|企业|投资/g, tag: '经济' },
          { pattern: /安全|生产|消防|应急/g, tag: '安全' },
          { pattern: /党建|党史|党员/g, tag: '党建' },
          { pattern: /乡村|农村|振兴/g, tag: '乡村振兴' },
        ];
      }

      for (const { pattern, tag } of tagPatterns) {
        if (pattern.test(allText)) {
          tags.push(tag);
        }
      }

      return tags.length > 0 ? tags.slice(0, 3) : ['综合'];
    },

    _extractEntities(content) {
      const allText = content || '';
      const entities = [];

      const locationPattern = /([^\s]{2,6}(?:市|县|区|镇|乡|村|街|路|港|湾|岛|江|河|湖|山|海))/g;
      const locations = allText.match(locationPattern);
      if (locations) {
        new Set(locations.slice(0, 3)).forEach(name => {
          entities.push({ name: name, type: 'Place' });
        });
      }

      const orgPattern = /([^\s]{2,10}(?:公司|局|院|所|委|办|厅|部|委员会|集团|企业|学校|医院|银行|协会|联盟))/g;
      const orgs = allText.match(orgPattern);
      if (orgs) {
        new Set(orgs.slice(0, 2)).forEach(name => {
          entities.push({ name: name, type: 'Organization' });
        });
      }

      const personPattern = /(?:记者|通讯员|教授|博士|院士|主任|总监|所长|院长|校长|书记|市长|局长)\s*([^\s,，、]{2,4})/g;
      let match;
      const seenNames = new Set(entities.map(e => e.name));
      while ((match = personPattern.exec(allText)) !== null) {
        const name = match[1].trim();
        if (!seenNames.has(name) && !/^(报道|讯|摄|文|图)$/.test(name)) {
          entities.push({ name: name, type: 'Person' });
          seenNames.add(name);
        }
      }

      return entities.slice(0, 5);
    },

    _generateQA(content, entities) {
      const qa = [];

      const plainTitle = this._generateTitle(content);
      qa.push({
        q: this._truncate(plainTitle, 30) + '是怎么回事？',
        a: this._truncate(content, 100) || '目前暂无详细信息。'
      });

      if (entities.length > 0) {
        qa.push({
          q: (typeof entities[0] === 'object' ? entities[0].name : entities[0]) + '与什么相关？',
          a: this._truncate(content, 80) || '相关内容正在整理中。'
        });
      }

      qa.push({
        q: '这件事说明了什么？',
        a: '反映了当地在相关领域的积极举措。'
      });

      return qa;
    },

    _extractAuthors(content) {
      const allText = content || '';
      const authors = [];

      const roleStr = GEO_SHARED_CONSTANTS.AUTHOR_ROLES_REGEX.match(/\((.+)\)/)[1];
      const roles = roleStr.split('|');
      const rolePattern = roles.join('|');

      const authorPattern = new RegExp(`(?:${rolePattern})\\s*([^\\s,，、]{2,4})`, 'g');
      let match;
      while ((match = authorPattern.exec(allText)) !== null) {
        const fullMatch = match[0];
        const name = match[1].trim();
        const roleMatch = fullMatch.match(new RegExp(`(${rolePattern})`));
        const role = roleMatch ? roleMatch[1] : '记者';
        if (name && !/^(报道|讯|摄|文|图)$/.test(name)) {
          if (!authors.some(a => a.name === name)) {
            authors.push({ role: role, name: name });
          }
        }
      }

      return authors;
    }
  };

  // ========== 9. jsonld.js ==========

  function getFieldValue(cardData, key) {
    if (Array.isArray(cardData.fields)) {
      const field = cardData.fields.find(f => f.key === key);
      if (field && field.value !== undefined && field.value !== '') return field.value;
    }
    return cardData[key];
  }

  function cardToJsonLd(cardData, completeData) {
    const templateId = cardData.templateId || GEO_SHARED_CONSTANTS.DEFAULT_TEMPLATE_ID;

    const title = cardData.title || (completeData && completeData.title) || '';
    const summary = cardData.summary || (completeData && completeData.summary) || '';
    const ensureArray = (val) => Array.isArray(val) ? val : (val ? [val] : []);
    const keywords = ensureArray(cardData.keywords || (completeData && completeData.keywords));
    const tags = ensureArray(cardData.tags || (completeData && completeData.tags));
    const entities = ensureArray(cardData.entities || (completeData && completeData.entities));
    const qa = ensureArray(cardData.qa || (completeData && completeData.qa));
    const introduction = (completeData && completeData.introduction) || '';
    const authors = ensureArray(completeData && completeData.authors);

    const jsonLd = {
      '@type': 'NewsArticle',
      'headline': title,
      'description': summary
    };

    if (keywords.length > 0) {
      jsonLd.keywords = keywords.join(',');
    }

    if (introduction) {
      jsonLd.introduction = introduction;
    }

    if (entities.length > 0) {
      const seen = new Set();
      jsonLd.mentions = [];
      entities.forEach(e => {
        let name, type;
        if (typeof e === 'object' && e.name) {
          name = e.name;
          type = e.type || 'Thing';
        } else {
          name = String(e);
          type = 'Thing';
        }
        if (seen.has(name)) return;
        seen.add(name);
        const validTypes = GEO_SHARED_CONSTANTS.VALID_SCHEMA_TYPES;
        const schemaType = validTypes.includes(type) ? type : 'Thing';
        jsonLd.mentions.push({ '@type': schemaType, 'name': name });
      });
    }

    if (tags.length > 0) {
      const seenAbout = new Set();
      jsonLd.about = [];
      tags.forEach(t => {
        if (seenAbout.has(t)) return;
        seenAbout.add(t);
        jsonLd.about.push({ '@type': 'Thing', 'name': t });
      });
    }

    const graphItems = [];

    const templateConfig = TEMPLATE_CONFIG
      ? TEMPLATE_CONFIG.templates.find(t => t.id === templateId)
      : null;
    const mapping = templateConfig ? templateConfig.jsonLdMapping : null;

    if (mapping) {
      if (Array.isArray(mapping.graphItems)) {
        mapping.graphItems.forEach(gi => {
          const obj = { '@type': gi['@type'] };
          if (gi['@id']) obj['@id'] = gi['@id'];

          if (Array.isArray(gi.fieldMappings)) {
            gi.fieldMappings.forEach(fm => {
              let val = getFieldValue(cardData, fm.field);
              if (val === undefined || val === null || val === '') {
                if (fm.fallbackToTitle && title) val = title;
                else return;
              }
              if (fm.field === 'eventName' && fm.fallbackToTitle && !val) val = title;
              if (fm.parseTypedArray) {
                val = parseTypedArray(val, 'Organization');
              }
              if (fm.wrap) {
                if (fm.parseTypedArray && Array.isArray(val)) {
                  obj[fm.target] = val.map(v => {
                    const name = typeof v === 'object' ? v.name : String(v);
                    const type = (typeof v === 'object' && v.type) ? v.type : (fm.wrap['@type'] || 'Thing');
                    return { '@type': type, 'name': name.replace(/\s*\((Organization|Person|Thing|CreativeWork)\)\s*$/, '').trim() };
                  });
                } else {
                  obj[fm.target] = { '@type': fm.wrap['@type'], [fm.wrap.valueKey || 'name']: val };
                }
              } else {
                obj[fm.target] = val;
              }
            });
          }

          if (!obj.description && summary) obj.description = summary;

          graphItems.push(obj);

          if (gi.linkToAbout && obj['@id']) {
            jsonLd.about = jsonLd.about || [];
            jsonLd.about.push({ '@id': obj['@id'] });
          }
        });
      }

      if (Array.isArray(mapping.directMappings)) {
        mapping.directMappings.forEach(dm => {
          const val = getFieldValue(cardData, dm.field);
          if (val === undefined || val === null || val === '') return;

          const action = dm.action || '';

          if (action === 'addMention') {
            jsonLd.mentions = jsonLd.mentions || [];
            let schemaType = dm.schemaType || 'Thing';
            if (dm.schemaTypeFromValue && typeof val === 'object' && val !== null) {
              schemaType = val.type || dm.defaultSchemaType || 'Organization';
              const name = val.name || String(val);
              const exists = jsonLd.mentions.some(m => m.name === name);
              if (!exists) {
                const mention = { '@type': schemaType, 'name': name };
                if (Array.isArray(dm.subFields)) {
                  dm.subFields.forEach(sf => {
                    const subVal = getFieldValue(cardData, sf.field);
                    if (subVal) mention[sf.target] = subVal;
                  });
                }
                jsonLd.mentions.unshift(mention);
              }
            } else {
              const mention = { '@type': schemaType, 'name': typeof val === 'object' ? val.name : String(val) };
              if (Array.isArray(dm.subFields)) {
                dm.subFields.forEach(sf => {
                  const subVal = getFieldValue(cardData, sf.field);
                  if (subVal) {
                    if (sf.wrap) {
                      mention[sf.target] = { '@type': sf.wrap['@type'], [sf.wrap.valueKey || 'name']: subVal };
                    } else {
                      mention[sf.target] = subVal;
                    }
                  }
                });
              }
              jsonLd.mentions.unshift(mention);
            }
          } else if (action === 'addAbout') {
            const name = typeof val === 'object' ? val.name : String(val);
            const exists = jsonLd.about && jsonLd.about.some(a => a.name === name);
            if (!exists) {
              jsonLd.about = jsonLd.about || [];
              jsonLd.about.push({ '@type': 'Thing', 'name': name });
            }
          } else if (action === 'addTypedArray') {
            jsonLd.mentions = jsonLd.mentions || [];
            const parsed = parseTypedArray(val, dm.defaultType || 'Thing');
            if (Array.isArray(parsed)) {
              parsed.forEach(p => {
                const name = (typeof p === 'object' ? p.name : String(p)).replace(/\s*\((Organization|Person|Thing|CreativeWork)\)\s*$/, '').trim();
                const type = (typeof p === 'object' && p.type) ? p.type : (dm.defaultType || 'Thing');
                const exists = jsonLd.mentions.some(m => m.name === name);
                if (!exists) jsonLd.mentions.push({ '@type': type, 'name': name });
              });
            }
          } else if (action === 'parseAsPersonArray') {
            let list = [];
            if (Array.isArray(val)) {
              list = val.map(a => typeof a === 'object' ? (a.name || '') : String(a)).filter(s => s.trim());
            } else if (typeof val === 'string') {
              list = val.split(/[，,、]/).filter(s => s.trim());
            }
            if (list.length > 0) {
              jsonLd[dm.target] = list.map(name => ({ '@type': 'Person', 'name': name.trim() }));
            }
          } else if (action === 'addQuantitativeValue') {
            jsonLd.mentions = jsonLd.mentions || [];
            const numMatch = String(val).match(/([\d.]+)\s*(万吨|亿元|万元|吨|个|项|家|%|百分之)/);
            if (numMatch) {
              jsonLd.mentions.push({
                '@type': 'QuantitativeValue',
                'value': parseFloat(numMatch[1]),
                'unitText': numMatch[2],
                'description': String(val)
              });
            } else {
              jsonLd.mentions.push({ '@type': 'QuantitativeValue', 'description': String(val) });
            }
          } else if (dm.wrap) {
            jsonLd[dm.target] = { '@type': dm.wrap['@type'], [dm.wrap.valueKey || 'name']: val };
          } else {
            jsonLd[dm.target] = val;
          }
        });
      }

      if (mapping.addFaqGraph && qa.length > 0) {
        graphItems.push({
          '@type': 'FAQPage',
          'mainEntity': qa.map(item => ({
            '@type': 'Question',
            'name': item.q,
            'acceptedAnswer': { '@type': 'Answer', 'text': item.a }
          }))
        });
      }
    } else {
      if (Array.isArray(cardData.fields)) {
        cardData.fields.forEach(f => {
          const val = f.value !== undefined ? f.value : cardData[f.key];
          if (val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && val.length === 0)) {
            jsonLd[f.key] = val;
          }
        });
      }
    }

    const predefinedKeys = new Set([
      'id', 'templateId', 'templateName', 'confidence', 'classifyReason', 'fields',
      'title', 'summary', 'keywords', 'introduction', 'tags', 'entities', 'authors', 'qa',
      'reviewStatus', 'createdAt'
    ]);
    if (TEMPLATE_CONFIG && TEMPLATE_CONFIG.templates) {
      TEMPLATE_CONFIG.templates.forEach(t => {
        if (t.fields) t.fields.forEach(f => predefinedKeys.add(f.key));
        if (t.jsonLdMapping) {
          if (t.jsonLdMapping.directMappings) t.jsonLdMapping.directMappings.forEach(dm => {
            predefinedKeys.add(dm.field);
            if (dm.subFields) dm.subFields.forEach(sf => predefinedKeys.add(sf.field));
          });
          if (t.jsonLdMapping.graphItems) t.jsonLdMapping.graphItems.forEach(gi => {
            if (gi.fieldMappings) gi.fieldMappings.forEach(fm => predefinedKeys.add(fm.field));
          });
        }
      });
    } else {
      if (Array.isArray(cardData.fields)) {
        cardData.fields.forEach(f => predefinedKeys.add(f.key));
      }
    }

    const flexibleFields = {};
    if (Array.isArray(cardData.fields)) {
      cardData.fields.forEach(f => {
        if (!predefinedKeys.has(f.key) && f.value !== undefined && f.value !== '') {
          flexibleFields[f.key] = f.value;
        }
      });
    }
    Object.keys(cardData).forEach(k => {
      if (!predefinedKeys.has(k) && !flexibleFields.hasOwnProperty(k)) {
        const val = cardData[k];
        if (val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && val.length === 0)) {
          flexibleFields[k] = val;
        }
      }
    });

    Object.keys(flexibleFields).forEach(key => {
      const val = flexibleFields[key];
      if (Array.isArray(val) && val.length > 0) {
        jsonLd[key] = val.map(v => (typeof v === 'object' && v !== null && v.name) ? v.name : String(v));
      } else if (typeof val === 'object' && val !== null && val.name) {
        jsonLd[key] = val.name;
      } else if (typeof val === 'string') {
        jsonLd[key] = val;
      }
    });

    let result;
    if (graphItems.length > 0) {
      result = {
        '@context': 'https://schema.org',
        '@graph': [jsonLd, ...graphItems]
      };
    } else {
      jsonLd['@context'] = 'https://schema.org';
      result = jsonLd;
    }

    function clean(obj) {
      Object.keys(obj).forEach(k => {
        if (obj[k] === undefined || obj[k] === null || obj[k] === '' ||
            (Array.isArray(obj[k]) && obj[k].length === 0)) {
          delete obj[k];
        } else if (typeof obj[k] === 'object' && !Array.isArray(obj[k]) && k !== '@context') {
          clean(obj[k]);
        }
      });
    }
    clean(result);

    return result;
  }

  function buildJsonLdVisual(jsonLd) {
    let html = '<div class="geo-preview-section">' +
      '<div class="geo-preview-section-title">JSON-LD 结构化数据 <span class="geo-preview-badge">Schema.org</span></div>' +
      '<div class="geo-preview-jsonld">';

    const mainType = jsonLd['@type'] || (jsonLd['@graph'] && jsonLd['@graph'][0] && jsonLd['@graph'][0]['@type']) || '';
    if (mainType) {
      html += '<div class="geo-preview-type-badge">' + mainType + '</div>';
    }

    if (jsonLd['@graph']) {
      jsonLd['@graph'].forEach((item) => {
        html += '<div class="geo-preview-graph-item">' +
          '<div class="geo-preview-graph-type">' + (item['@type'] || 'Object') + '</div>';
        html += buildJsonLdFields(item);
        html += '</div>';
      });
    } else {
      html += buildJsonLdFields(jsonLd);
    }

    html += '</div></div>';
    return html;
  }

  function buildJsonLdFields(obj) {
    let html = '<div class="geo-preview-ld-fields">';
    for (const [key, val] of Object.entries(obj)) {
      if (key === '@context' || key === '@type' || key === '@graph') continue;
      if (Array.isArray(val)) {
        if (val.length > 0 && typeof val[0] === 'object') {
          html += '<div class="geo-preview-ld-field">' +
            '<div class="geo-preview-ld-key">' + key + '</div>' +
            '<div class="geo-preview-ld-val">';
          val.forEach(item => {
            if (item['@type']) html += '<span class="geo-preview-ld-type">' + item['@type'] + '</span> ';
            if (item.name) {
              html += '<span class="geo-preview-ld-name">' + item.name + '</span>';
            } else if (item['@id']) {
              html += '<span class="geo-preview-ld-ref">' + item['@id'] + '</span>';
            } else {
              html += '<span class="geo-preview-ld-name">' + JSON.stringify(item) + '</span>';
            }
            html += ' ';
          });
          html += '</div></div>';
        } else {
          html += '<div class="geo-preview-ld-field">' +
            '<div class="geo-preview-ld-key">' + key + '</div>' +
            '<div class="geo-preview-ld-val">' + val.map(v => '<span class="geo-preview-tag">' + (typeof v === 'object' ? JSON.stringify(v) : v) + '</span>').join('') + '</div>' +
            '</div>';
        }
      } else if (typeof val === 'object' && val !== null) {
        html += '<div class="geo-preview-ld-field">' +
          '<div class="geo-preview-ld-key">' + key + '</div>' +
          '<div class="geo-preview-ld-val">';
        if (val['@type']) html += '<span class="geo-preview-ld-type">' + val['@type'] + '</span> ';
        if (val.name) html += '<span class="geo-preview-ld-name">' + val.name + '</span>';
        html += '</div></div>';
      } else {
        html += '<div class="geo-preview-ld-field">' +
          '<div class="geo-preview-ld-key">' + key + '</div>' +
          '<div class="geo-preview-ld-val">' + val + '</div>' +
          '</div>';
      }
    }
    html += '</div>';
    return html;
  }

  // ========== 10. knowledgeCard.js (替换chrome APIs) ==========

  let TEMPLATE_OPTIONS = [];
  let TEMPLATE_CONFIG = null;

  function initTemplateOptions() {
    TEMPLATE_OPTIONS = [
      { id: GEO_SHARED_CONSTANTS.DEFAULT_TEMPLATE_ID, name: '基础新闻事实卡', icon: '📰', fields: [
        {key: 'eventDate', label: '事件日期', required: false},
        {key: 'location', label: '地点', required: false},
        {key: 'keyFact', label: '核心事实', required: false}
      ]}
    ];
  }

  async function loadTemplateConfig() {
    try {
      // 检查缓存（1小时有效）
      const cached = localStorage.getItem('geo_template_config');
      const cacheTime = localStorage.getItem('geo_template_config_time');
      if (cached && cacheTime && (Date.now() - parseInt(cacheTime)) < 3600000) {
        const config = JSON.parse(cached);
        applyTemplateConfig(config);
        loadFieldMappingFromCache();
        return;
      }

      // 尝试远程加载
      const apiBaseUrl = 'https://phpdev.66wz.com/api';
      GeoCozeProvider._apiBaseUrl = apiBaseUrl;

      try {
        let config = null;
        const configResp = await fetch(apiBaseUrl + '/config/config.json', { cache: 'no-cache' });
        if (configResp.ok) config = await configResp.json();

        let templates = null;
        const tplResp = await fetch(apiBaseUrl + '/config/templates.json', { cache: 'no-cache' });
        if (tplResp.ok) templates = await tplResp.json();

        if (config) applyGlobalConfig(config);
        if (config || templates) {
          const mergedConfig = mergeConfig(config, templates);
          if (mergedConfig) {
            applyTemplateConfig(mergedConfig);
            localStorage.setItem('geo_template_config', JSON.stringify(mergedConfig));
            localStorage.setItem('geo_template_config_time', String(Date.now()));
          }
        }
      } catch (e) {
        console.warn('AI发布助手: 远程配置加载失败，使用默认配置', e);
      }

      await loadFieldMapping();
    } catch (e) {
      console.warn('AI发布助手: 加载配置失败，使用默认配置', e);
    }
  }

  function mergeConfig(globalConfig, templates) {
    if (!globalConfig && !templates) return null;
    const result = {};
    if (globalConfig) {
      result.version = globalConfig.version;
      result.globalConfig = globalConfig;
    }
    if (templates) {
      result.templates = templates.templates;
    }
    return result;
  }

  function applyGlobalConfig(gc) {
    if (!gc) return;
    if (gc.apiBaseUrl) {
      GeoCozeProvider._apiBaseUrl = gc.apiBaseUrl;
    }
    if (gc.schemaTypes && gc.schemaTypes.length > 0) {
      GEO_SHARED_CONSTANTS.VALID_SCHEMA_TYPES = gc.schemaTypes;
      GEO_SHARED_CONSTANTS.SCHEMA_TYPES_REGEX = '(' + gc.schemaTypes.join('|') + ')';
    }
    if (gc.authorRoles && gc.authorRoles.length > 0) {
      GEO_SHARED_CONSTANTS.AUTHOR_ROLES_REGEX = '^(' + gc.authorRoles.join('|') + ')\\s+(.+)$';
    }
    if (gc.defaultTemplateId) {
      GEO_SHARED_CONSTANTS.DEFAULT_TEMPLATE_ID = gc.defaultTemplateId;
    }
    if (gc.defaultTemplateName) {
      GEO_SHARED_CONSTANTS.DEFAULT_TEMPLATE_NAME = gc.defaultTemplateName;
    }
    if (gc.tagPatterns && gc.tagPatterns.length > 0) {
      GEO_SHARED_CONSTANTS.TAG_PATTERNS = gc.tagPatterns;
    }
  }

  async function loadFieldMapping() {
    try {
      // 先从缓存加载
      const cachedMapping = localStorage.getItem('geo_field_mapping');
      if (cachedMapping) {
        applyFieldMapping(JSON.parse(cachedMapping));
      }

      // 再从远程拉取最新配置
      const apiBaseUrl = GeoCozeProvider._apiBaseUrl || 'https://phpdev.66wz.com/api';
      try {
        const remoteResp = await fetch(apiBaseUrl + '/config/field-mapping.json', { cache: 'no-cache' });
        if (remoteResp.ok) {
          const remoteMapping = await remoteResp.json();
          applyFieldMapping(remoteMapping);
          localStorage.setItem('geo_field_mapping', JSON.stringify(remoteMapping));
          localStorage.setItem('geo_field_mapping_time', String(Date.now()));
          return;
        }
      } catch (e) {
        console.warn('AI发布助手: 远程字段映射加载失败，使用缓存配置', e);
      }
    } catch (e) {
      console.warn('AI发布助手: 加载字段映射失败，使用默认配置', e);
    }
  }

  function loadFieldMappingFromCache() {
    try {
      const cached = localStorage.getItem('geo_field_mapping');
      if (cached) {
        applyFieldMapping(JSON.parse(cached));
      }
    } catch (e) { /* 忽略 */ }
  }

  function applyFieldMapping(mapping) {
    if (!mapping) return;
    if (mapping.fieldMapping) {
      Object.assign(GeoFieldWriter.fieldMapping, mapping.fieldMapping);
    }
    if (mapping.titleInputId) {
      GeoFieldReader.TITLE_INPUT_ID = mapping.titleInputId;
    }
    if (mapping.contentTextareaId) {
      GeoFieldReader.CONTENT_TEXTAREA_ID = mapping.contentTextareaId;
    }
  }

  function applyTemplateConfig(config) {
    if (!config || !config.templates) return;
    TEMPLATE_CONFIG = config;
    TEMPLATE_OPTIONS = config.templates.map(t => ({
      id: t.id,
      name: t.name,
      icon: t.icon || '📋',
      fields: t.fields || []
    }));

    if (config.globalConfig) {
      const gc = config.globalConfig;
      if (gc.schemaTypes && gc.schemaTypes.length > 0) {
        GEO_SHARED_CONSTANTS.VALID_SCHEMA_TYPES = gc.schemaTypes;
        GEO_SHARED_CONSTANTS.SCHEMA_TYPES_REGEX = '(' + gc.schemaTypes.join('|') + ')';
      }
      if (gc.authorRoles && gc.authorRoles.length > 0) {
        GEO_SHARED_CONSTANTS.AUTHOR_ROLES_REGEX = '^(' + gc.authorRoles.join('|') + ')\\s+(.+)$';
      }
      if (gc.defaultTemplateId) {
        GEO_SHARED_CONSTANTS.DEFAULT_TEMPLATE_ID = gc.defaultTemplateId;
      }
      if (gc.defaultTemplateName) {
        GEO_SHARED_CONSTANTS.DEFAULT_TEMPLATE_NAME = gc.defaultTemplateName;
      }
      if (gc.tagPatterns && gc.tagPatterns.length > 0) {
        GEO_SHARED_CONSTANTS.TAG_PATTERNS = gc.tagPatterns;
      }
    }
  }

  function createKCEditField(field, value, evidence, label, required) {
    const isRequired = required ? ' geo-kc-field-required' : '';
    let valueHtml = '';

    if (field === 'qa' && Array.isArray(value)) {
      valueHtml = value.map((item, idx) => '<div class="geo-kc-qa-item">' +
        '<div class="geo-kc-qa-q">Q: <span class="geo-kc-editable" data-field="qa.' + idx + '.q">' + (item.q || '') + '</span></div>' +
        '<div class="geo-kc-qa-a">A: <span class="geo-kc-editable" data-field="qa.' + idx + '.a">' + (item.a || '') + '</span></div>' +
        (item.evidence ? '<div class="geo-kc-evidence">依据：' + item.evidence + '</div>' : '') +
        '</div>').join('');
    } else if (Array.isArray(value)) {
      valueHtml = value.map((v, idx) => {
        const display = (typeof v === 'object' && v !== null) ? v.name : v;
        const dataVal = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : '';
        return '<span class="geo-kc-tag"><span class="geo-kc-editable" data-field="' + field + '.' + idx + '" ' + (dataVal ? 'data-raw="' + escapeHtml(dataVal) + '"' : '') + '>' + display + '</span><span class="geo-kc-tag-del" data-action="kc-del-tag" data-field="' + field + '" data-index="' + idx + '">×</span></span>';
      }).join('');
    } else if (typeof value === 'object' && value !== null) {
      const display = value.name || JSON.stringify(value);
      const dataVal = JSON.stringify(value);
      valueHtml = '<span class="geo-kc-editable" data-field="' + field + '" data-raw="' + escapeHtml(dataVal) + '">' + display + '</span>';
    } else {
      valueHtml = '<span class="geo-kc-editable" data-field="' + field + '">' + (value || '') + '</span>';
    }

    return '<div class="geo-kc-field' + isRequired + '" data-field="' + field + '">' +
      '<div class="geo-kc-field-label">' + (required ? '<span class="geo-kc-required-mark">*</span>' : '') + label + '</div>' +
      '<div class="geo-kc-field-value">' + valueHtml + '</div>' +
      (evidence ? '<div class="geo-kc-evidence">依据：' + evidence + '</div>' : '') +
      '</div>';
  }

  function bindKnowledgeCardEvents(originalData, templateId) {
    const panel = document.getElementById('geo-panel-complete');

    const selectEl = document.getElementById('geo-kc-template-select');
    if (selectEl) {
      selectEl.addEventListener('change', () => {
        const newTemplateId = selectEl.value;
        const newOption = TEMPLATE_OPTIONS.find(o => o.id === newTemplateId);
        const newFields = newOption ? newOption.fields : [];
        const newTemplateName = newOption ? newOption.name : newTemplateId;

        const existingValues = {};
        const existingEvidences = {};
        if (Array.isArray(originalData.fields)) {
          originalData.fields.forEach(f => {
            if (f.value !== undefined) existingValues[f.key] = f.value;
            if (f.evidence) existingEvidences[f.key] = f.evidence;
          });
        }
        Object.keys(originalData).forEach(k => {
          if (k === 'fields' || k === 'templateId' || k === 'templateName' || k === 'confidence' || k === 'classifyReason' || k === 'tags' || k === 'entities' || k === 'qa' || k === 'title' || k === 'summary' || k === 'keywords') return;
          if (!existingValues.hasOwnProperty(k)) existingValues[k] = originalData[k];
          if (!existingEvidences.hasOwnProperty(k) && originalData[k + '_evidence']) existingEvidences[k] = originalData[k + '_evidence'];
        });

        const mergedFields = newFields.map(f => {
          const merged = Object.assign({}, f);
          if (existingValues.hasOwnProperty(f.key)) {
            merged.value = existingValues[f.key];
          }
          if (existingEvidences.hasOwnProperty(f.key)) {
            merged.evidence = existingEvidences[f.key];
          }
          return merged;
        });

        const newData = Object.assign({}, originalData, {
          templateId: newTemplateId,
          templateName: newTemplateName,
          fields: mergedFields
        });
        showResult(newData);
      });
    }

    panel.querySelectorAll('.geo-kc-editable').forEach(el => {
      el.addEventListener('click', () => {
        if (el.querySelector('input, textarea')) return;
        const currentText = el.textContent;
        const isLong = currentText.length > 30;
        if (isLong) {
          el.innerHTML = '<textarea class="geo-kc-edit-input">' + currentText + '</textarea>';
        } else {
          el.innerHTML = '<input type="text" class="geo-kc-edit-input" value="' + currentText.replace(/"/g, '&quot;') + '">';
        }
        const input = el.querySelector('.geo-kc-edit-input');
        input.focus();
        input.addEventListener('blur', () => {
          const newVal = input.value.trim();
          el.textContent = newVal || currentText;
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !isLong) {
            input.blur();
          }
        });
      });
    });

    panel.querySelectorAll('[data-action="kc-del-tag"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tag = e.target.closest('.geo-kc-tag');
        if (tag) removeTagWithAnimation(tag);
      });
    });
  }

  function collectCardData(panel, templateId) {
    const data = {
      id: 'card-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8),
      templateId: templateId,
      reviewStatus: 'pending',
      createdAt: new Date().toISOString()
    };

    panel.querySelectorAll('.geo-kc-field').forEach(fieldEl => {
      const fieldName = fieldEl.dataset.field;
      if (!fieldName) return;

      const editables = fieldEl.querySelectorAll('.geo-kc-editable');
      if (fieldName === 'qa') {
        const qaItems = [];
        fieldEl.querySelectorAll('.geo-kc-qa-item').forEach(qaEl => {
          const qEl = qaEl.querySelector('.geo-kc-qa-q .geo-kc-editable');
          const aEl = qaEl.querySelector('.geo-kc-qa-a .geo-kc-editable');
          qaItems.push({
            q: qEl ? qEl.textContent : '',
            a: aEl ? aEl.textContent : ''
          });
        });
        data[fieldName] = qaItems;
      } else if (editables.length > 1) {
        data[fieldName] = Array.from(editables).map(el => {
          const raw = el.getAttribute('data-raw');
          if (raw) {
            try { return JSON.parse(raw); } catch (ex) { /* 降级 */ }
          }
          return el.textContent;
        });
      } else if (editables.length === 1) {
        const raw = editables[0].getAttribute('data-raw');
        const parsed = raw ? (() => { try { return JSON.parse(raw); } catch (ex) { return null; } })() : null;

        const arrayFields = ['keywords', 'tags', 'entities'];
        const isKnownArrayField = arrayFields.includes(fieldName);
        let isConfigArrayField = false;
        if (TEMPLATE_CONFIG && TEMPLATE_CONFIG.templates) {
          for (const t of TEMPLATE_CONFIG.templates) {
            if (t.jsonLdMapping && t.jsonLdMapping.directMappings) {
              const dm = t.jsonLdMapping.directMappings.find(d => d.field === fieldName);
              if (dm && (dm.action === 'addTypedArray' || dm.action === 'parseAsPersonArray' || dm.parseTypedArray)) {
                isConfigArrayField = true;
                break;
              }
            }
            if (t.jsonLdMapping && t.jsonLdMapping.graphItems) {
              for (const gi of t.jsonLdMapping.graphItems) {
                if (gi.fieldMappings) {
                  const fm = gi.fieldMappings.find(f => f.field === fieldName);
                  if (fm && fm.parseTypedArray) {
                    isConfigArrayField = true;
                    break;
                  }
                }
              }
              if (isConfigArrayField) break;
            }
          }
        }
        const isParsedArray = Array.isArray(parsed);

        if (isKnownArrayField || isConfigArrayField || isParsedArray) {
          if (parsed) {
            data[fieldName] = isParsedArray ? parsed : [parsed];
          } else {
            data[fieldName] = [editables[0].textContent];
          }
        } else {
          if (parsed) {
            data[fieldName] = parsed;
          } else {
            data[fieldName] = editables[0].textContent;
          }
        }
      }
    });

    return data;
  }

  function showPreviewModal(cardData, jsonLd) {
    const existing = document.getElementById('geo-preview-modal');
    if (existing) existing.remove();

    const output = { raw: cardData, jsonld: jsonLd };

    let visualHtml = '';
    visualHtml += buildJsonLdVisual(jsonLd);

    visualHtml += '<div class="geo-preview-section">' +
      '<div class="geo-preview-section-title">原始卡片数据</div>' +
      '<div class="geo-preview-fields">';

    const fields = (window._geoCompleteData && window._geoCompleteData.fields) || [];
    for (const field of fields) {
      const val = cardData[field.key];
      if (val === undefined || val === null || val === '' || (Array.isArray(val) && val.length === 0)) continue;
      const label = field.label || field.key;
      if (field.key === 'qa' && Array.isArray(val)) {
        visualHtml += '<div class="geo-preview-field"><div class="geo-preview-field-label">' + label + '</div><div class="geo-preview-field-value">';
        val.forEach(item => {
          visualHtml += '<div class="geo-preview-qa"><span class="geo-preview-q">Q: ' + item.q + '</span><span class="geo-preview-a">A: ' + item.a + '</span></div>';
        });
        visualHtml += '</div></div>';
      } else if (Array.isArray(val)) {
        visualHtml += '<div class="geo-preview-field"><div class="geo-preview-field-label">' + label + '</div><div class="geo-preview-field-value">' + val.map(v => {
          const display = (typeof v === 'object' && v !== null && v.name) ? v.name : String(v);
          return '<span class="geo-preview-tag">' + display + '</span>';
        }).join('') + '</div></div>';
      } else if (typeof val === 'object' && val !== null && val.name) {
        visualHtml += '<div class="geo-preview-field"><div class="geo-preview-field-label">' + label + '</div><div class="geo-preview-field-value">' + val.name + '</div></div>';
      } else {
        visualHtml += '<div class="geo-preview-field"><div class="geo-preview-field-label">' + label + '</div><div class="geo-preview-field-value">' + val + '</div></div>';
      }
    }
    visualHtml += '</div></div>';

    visualHtml += '<div class="geo-preview-section">' +
      '<div class="geo-preview-section-title">JSON源码</div>' +
      '<pre class="geo-preview-json">' + escapeHtml(JSON.stringify(output, null, 2)) + '</pre>' +
      '</div>';

    const modal = document.createElement('div');
    modal.id = 'geo-preview-modal';
    modal.innerHTML =
      '<div class="geo-preview-overlay"></div>' +
      '<div class="geo-preview-container">' +
        '<div class="geo-preview-header">' +
          '<span class="geo-preview-title">知识卡片可视化预览</span>' +
          '<button class="geo-preview-close" data-action="preview-close">&times;</button>' +
        '</div>' +
        '<div class="geo-preview-body">' + visualHtml + '</div>' +
        '<div class="geo-preview-footer">' +
          '<button class="geo-btn-small geo-btn-adopt-all" data-action="preview-fill">回填到表单</button>' +
          '<button class="geo-btn-small" data-action="preview-copy">复制JSON</button>' +
          '<button class="geo-btn-small" data-action="preview-close">关闭</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    modal.querySelectorAll('[data-action="preview-close"]').forEach(btn => {
      btn.addEventListener('click', () => modal.remove());
    });
    modal.querySelector('.geo-preview-overlay')?.addEventListener('click', () => modal.remove());

    modal.querySelector('[data-action="preview-fill"]')?.addEventListener('click', () => {
      const json = JSON.stringify(output, null, 2);
      const success = GeoFieldWriter.writeField('knowledgeCard', json);
      if (success) {
        showToast('知识卡片已回填（JSON-LD格式）');
      } else {
        showToast('无法找到知识卡片字段', 'error');
      }
    });

    modal.querySelector('[data-action="preview-copy"]')?.addEventListener('click', () => {
      const json = JSON.stringify(output, null, 2);
      copyToClipboard(json);
      showToast('JSON已复制到剪贴板');
    });
  }

  function saveKnowledgeCard(cardData) {
    try {
      const cards = JSON.parse(localStorage.getItem('geo_knowledge_cards') || '[]');
      cards.push(cardData);
      localStorage.setItem('geo_knowledge_cards', JSON.stringify(cards));
      showToast('知识卡片已保存（共' + cards.length + '张）');
    } catch (e) {
      showToast('保存失败', 'error');
    }
  }

  function exportCardAsFile(cardData) {
    const json = JSON.stringify(cardData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'knowledge-card-' + cardData.templateId + '-' + Date.now() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('知识卡片已导出');
  }

  // ========== 11. cards.js ==========

  function createCard(title, content, type) {
    return '<div class="geo-result-card" data-type="' + type + '">' +
      '<div class="geo-card-header">' +
        '<span class="geo-card-title">' + title + '</span>' +
        '<div class="geo-card-actions">' +
          '<button class="geo-btn-small geo-btn-adopt" data-action="adopt" data-field="' + type + '">采用</button>' +
          '<button class="geo-btn-small geo-btn-edit" data-action="edit" data-field="' + type + '">修改</button>' +
          '<button class="geo-btn-small geo-btn-ignore" data-action="ignore" data-field="' + type + '">忽略</button>' +
        '</div>' +
      '</div>' +
      '<div class="geo-card-body" data-raw="' + content.replace(/"/g, '&quot;') + '">' + content + '</div>' +
    '</div>';
  }

  function createKeywordsCard(keywords) {
    const tagsHtml = keywords.map(k =>
      '<span class="geo-keyword-tag">' +
        '<span class="geo-keyword-text">' + k + '</span>' +
        '<span class="geo-keyword-delete" data-action="delete-keyword" title="删除">×</span>' +
      '</span>'
    ).join('');
    return '<div class="geo-result-card" data-type="keywords">' +
      '<div class="geo-card-header"><span class="geo-card-title">关键词</span>' +
        '<div class="geo-card-actions">' +
          '<button class="geo-btn-small geo-btn-adopt" data-action="adopt-keywords">采用</button>' +
          '<button class="geo-btn-small geo-btn-ignore" data-action="ignore" data-field="keywords">忽略</button>' +
        '</div>' +
      '</div>' +
      '<div class="geo-card-body">' +
        '<div class="geo-keywords-list">' + tagsHtml + '</div>' +
        '<div class="geo-keyword-add">' +
          '<input type="text" class="geo-keyword-input" placeholder="输入新关键词" />' +
          '<button class="geo-btn-small" data-action="add-keyword">添加</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function createTagsCard(tags) {
    const tagsHtml = tags.map(t =>
      '<span class="geo-tag-item">' +
        '<span class="geo-tag-text">' + t + '</span>' +
        '<span class="geo-tag-delete" data-action="delete-tag" title="删除">×</span>' +
      '</span>'
    ).join('');
    return '<div class="geo-result-card" data-type="tags">' +
      '<div class="geo-card-header"><span class="geo-card-title">主题标签</span>' +
        '<div class="geo-card-actions">' +
          '<button class="geo-btn-small geo-btn-adopt" data-action="adopt-tags">采用</button>' +
          '<button class="geo-btn-small geo-btn-ignore" data-action="ignore" data-field="tags">忽略</button>' +
        '</div>' +
      '</div>' +
      '<div class="geo-card-body"><div class="geo-tags-list">' + tagsHtml + '</div></div>' +
    '</div>';
  }

  function createEntitiesCard(entities) {
    const itemsHtml = entities.map(e => {
      const name = typeof e === 'object' ? e.name : e;
      const type = typeof e === 'object' ? e.type : '';
      const typeLabel = type ? '<span class="geo-entity-type">' + type + '</span>' : '';
      return '<li>' + typeLabel + name + '</li>';
    }).join('');
    return '<div class="geo-result-card" data-type="entities">' +
      '<div class="geo-card-header"><span class="geo-card-title">核心实体</span>' +
        '<div class="geo-card-actions">' +
          '<button class="geo-btn-small geo-btn-ignore" data-action="ignore" data-field="entities">忽略</button>' +
        '</div>' +
      '</div>' +
      '<div class="geo-card-body"><ul class="geo-entities-list">' + itemsHtml + '</ul></div>' +
    '</div>';
  }

  function createAuthorsCard(authors) {
    const authorsHtml = authors.map(a => {
      const display = typeof a === 'object' ? (a.role ? a.role + ' ' + a.name : a.name) : a;
      const dataVal = typeof a === 'object' ? JSON.stringify(a) : a;
      return '<span class="geo-keyword-tag">' +
        '<span class="geo-keyword-text" data-raw="' + escapeHtml(dataVal) + '">' + display + '</span>' +
        '<span class="geo-keyword-delete" data-action="delete-author" title="删除">×</span>' +
      '</span>';
    }).join('');
    return '<div class="geo-result-card" data-type="authors">' +
      '<div class="geo-card-header"><span class="geo-card-title">作者</span>' +
        '<div class="geo-card-actions">' +
          '<button class="geo-btn-small geo-btn-adopt" data-action="adopt-authors">采用</button>' +
          '<button class="geo-btn-small geo-btn-ignore" data-action="ignore" data-field="authors">忽略</button>' +
        '</div>' +
      '</div>' +
      '<div class="geo-card-body">' +
        '<div class="geo-keywords-list">' + authorsHtml + '</div>' +
        '<div class="geo-keyword-add">' +
          '<input type="text" class="geo-keyword-input" placeholder="身份 姓名（如：记者 张三）" />' +
          '<button class="geo-btn-small" data-action="add-author">添加</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function createQACard(qa) {
    const qaHtml = qa.map(item => '<div class="geo-qa-item">' +
      '<div class="geo-qa-q">Q: ' + item.q + '</div>' +
      '<div class="geo-qa-a">A: ' + item.a + '</div>' +
    '</div>').join('');
    return '<div class="geo-result-card" data-type="qa">' +
      '<div class="geo-card-header"><span class="geo-card-title">AI问答</span>' +
        '<div class="geo-card-actions">' +
          '<button class="geo-btn-small geo-btn-ignore" data-action="ignore" data-field="qa">忽略</button>' +
        '</div>' +
      '</div>' +
      '<div class="geo-card-body"><div class="geo-qa-list">' + qaHtml + '</div></div>' +
    '</div>';
  }

  function bindCardEvents() {
    document.querySelectorAll('[data-action="adopt-all"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const panel = document.getElementById('geo-panel-complete');
        if (!panel) return;
        let adoptedCount = 0;

        const titleCard = panel.querySelector('[data-type="title"]');
        if (titleCard) {
          const body = titleCard.querySelector('.geo-card-body');
          const content = body ? (body.getAttribute('data-raw') || body.innerText) : '';
          if (content && GeoFieldWriter.writeField('title', content)) adoptedCount++;
        }

        const summaryCard = panel.querySelector('[data-type="summary"]');
        if (summaryCard) {
          const body = summaryCard.querySelector('.geo-card-body');
          const content = body ? (body.getAttribute('data-raw') || body.innerText) : '';
          if (content && GeoFieldWriter.writeField('summary', content)) adoptedCount++;
        }

        const keywordsCard = panel.querySelector('[data-type="keywords"]');
        if (keywordsCard) {
          const tags = Array.from(keywordsCard.querySelectorAll('.geo-keyword-tag .geo-keyword-text')).map(t => t.textContent);
          const keywords = tags.join(' ');
          if (keywords && GeoFieldWriter.writeField('keywords', keywords)) adoptedCount++;
        }

        const introCard = panel.querySelector('[data-type="introduction"]');
        if (introCard) {
          const body = introCard.querySelector('.geo-card-body');
          const content = body ? (body.getAttribute('data-raw') || body.innerText) : '';
          if (content && GeoFieldWriter.writeField('introduction', content)) adoptedCount++;
        }

        const tagsCard = panel.querySelector('[data-type="tags"]');
        if (tagsCard) {
          const tags = Array.from(tagsCard.querySelectorAll('.geo-tag-item .geo-tag-text')).map(t => t.textContent);
          const tagsStr = tags.join('、');
          if (tagsStr && GeoFieldWriter.writeField('tags', tagsStr)) adoptedCount++;
        }

        const authorsCard = panel.querySelector('[data-type="authors"]');
        if (authorsCard) {
          const authorTags = Array.from(authorsCard.querySelectorAll('.geo-keyword-tag .geo-keyword-text'));
          const authorsStr = authorTags.map(t => {
            const raw = t.getAttribute('data-raw');
            if (raw) {
              try {
                const obj = JSON.parse(raw);
                return obj.role ? obj.role + ' ' + obj.name : obj.name;
              } catch (ex) {
                return t.textContent;
              }
            }
            return t.textContent;
          }).join(' ');
          if (authorsStr && GeoFieldWriter.writeField('authors', authorsStr)) adoptedCount++;
        }

        const completeData = window._geoCompleteData;
        if (completeData && completeData.templateId) {
          const knowledgePanel = document.getElementById('geo-panel-knowledge');
          const cardData = collectCardData(knowledgePanel || panel, completeData.templateId);
          const jsonLdData = cardToJsonLd(cardData, completeData);
          const fillData = { raw: cardData, jsonld: jsonLdData };
          const fillJson = JSON.stringify(fillData);
          if (GeoFieldWriter.writeField('knowledgeCard', fillJson)) adoptedCount++;
        }

        panel.querySelectorAll('.geo-btn-adopt').forEach(b => {
          b.textContent = '已采用';
        });
        panel.querySelectorAll('.geo-btn-adopt-all').forEach(b => {
          b.textContent = '已采用' + adoptedCount + '项，点击重新采用';
        });

        showToast('已回填' + adoptedCount + '个字段');
      });
    });

    document.querySelectorAll('[data-action="preview-modal"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const completeData = window._geoCompleteData;
        if (!completeData) {
          showToast('暂无数据可预览', 'error');
          return;
        }
        const templateId = completeData.templateId || GEO_SHARED_CONSTANTS.DEFAULT_TEMPLATE_ID;
        const knowledgePanel = document.getElementById('geo-panel-knowledge');
        const cardData = knowledgePanel ? collectCardData(knowledgePanel, templateId) : completeData;
        const jsonLdData = cardToJsonLd(cardData, completeData);
        showPreviewModal(cardData, jsonLdData);
      });
    });

    document.querySelectorAll('[data-action="adopt"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const field = e.target.dataset.field;
        const card = e.target.closest('.geo-result-card');
        if (!card) return;

        let fieldType = field;
        if (field === '摘要') fieldType = 'summary';
        else if (field === '导读') fieldType = 'introduction';

        const body = card.querySelector('.geo-card-body');
        const content = body ? (body.getAttribute('data-raw') || body.innerText) : '';

        const success = GeoFieldWriter.writeField(fieldType, content);
        if (success) {
          showToast('已回填' + field + '字段');
          e.target.textContent = '已采用';
        } else {
          showToast('无法找到' + field + '字段', 'error');
        }
      });
    });

    document.querySelectorAll('[data-action="adopt-keywords"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const card = e.target.closest('.geo-result-card');
        if (!card) return;
        const tags = Array.from(card.querySelectorAll('.geo-keyword-tag .geo-keyword-text')).map(t => t.textContent);
        const keywords = tags.join(' ');

        const success = GeoFieldWriter.writeField('keywords', keywords);
        if (success) {
          showToast('已回填关键词字段');
          e.target.textContent = '已采用';
        } else {
          showToast('无法找到关键词字段', 'error');
        }
      });
    });

    document.querySelectorAll('[data-action="adopt-tags"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const card = e.target.closest('.geo-result-card');
        if (!card) return;
        const tags = Array.from(card.querySelectorAll('.geo-tag-item .geo-tag-text')).map(t => t.textContent);
        const tagsStr = tags.join('、');

        const success = GeoFieldWriter.writeField('tags', tagsStr);
        if (success) {
          showToast('已回填主题标签字段');
          e.target.textContent = '已采用';
        } else {
          showToast('无法找到主题标签字段', 'error');
        }
      });
    });

    document.querySelectorAll('[data-action="adopt-authors"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const card = e.target.closest('.geo-result-card');
        if (!card) return;
        const authorTags = Array.from(card.querySelectorAll('.geo-keyword-tag .geo-keyword-text'));
        const authorsStr = authorTags.map(t => {
          const raw = t.getAttribute('data-raw');
          if (raw) {
            try {
              const obj = JSON.parse(raw);
              return obj.role ? obj.role + ' ' + obj.name : obj.name;
            } catch (ex) {
              return t.textContent;
            }
          }
          return t.textContent;
        }).join(' ');

        const success = GeoFieldWriter.writeField('authors', authorsStr);
        if (success) {
          showToast('已回填作者字段');
          e.target.textContent = '已采用';
        } else {
          showToast('无法找到作者字段', 'error');
        }
      });
    });

    document.querySelectorAll('[data-action="edit"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const card = e.target.closest('.geo-result-card');
        if (!card) return;
        const body = card.querySelector('.geo-card-body');
        if (!body) return;

        const textarea = body.querySelector('.geo-edit-textarea');
        if (textarea) {
          const newContent = textarea.value.trim();
          body.textContent = newContent;
          body.setAttribute('data-raw', newContent.replace(/"/g, '&quot;'));
          e.target.textContent = '修改';
          if (window._geoCompleteData) {
            const fieldType = card.getAttribute('data-type');
            if (fieldType && newContent) {
              window._geoCompleteData[fieldType] = newContent;
            }
          }
          return;
        }

        const currentText = body.getAttribute('data-raw') || body.innerText;
        body.innerHTML = '<textarea class="geo-edit-textarea">' + currentText + '</textarea>';
        const editArea = body.querySelector('.geo-edit-textarea');
        editArea.focus();
        editArea.setSelectionRange(editArea.value.length, editArea.value.length);
        e.target.textContent = '保存';

        editArea.addEventListener('keydown', (ev) => {
          if (ev.ctrlKey && ev.key === 'Enter') {
            e.target.click();
          }
        });
      });
    });

    document.querySelectorAll('[data-action="delete-keyword"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tag = e.target.closest('.geo-keyword-tag');
        if (tag) {
          removeTagWithAnimation(tag);
          syncKeywordsToGlobal();
        }
      });
    });

    document.querySelectorAll('[data-action="delete-author"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tag = e.target.closest('.geo-keyword-tag');
        if (tag) {
          removeTagWithAnimation(tag);
          syncAuthorsToGlobal();
        }
      });
    });

    document.querySelectorAll('[data-action="add-keyword"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const card = e.target.closest('.geo-result-card');
        if (!card) return;
        const input = card.querySelector('.geo-keyword-input');
        if (!input || !input.value.trim()) return;

        const keywordsList = card.querySelector('.geo-keywords-list');
        const newTag = document.createElement('span');
        newTag.className = 'geo-keyword-tag';
        newTag.innerHTML = '<span class="geo-keyword-text">' + input.value.trim() + '</span><span class="geo-keyword-delete" data-action="delete-keyword" title="删除">×</span>';
        newTag.querySelector('[data-action="delete-keyword"]').addEventListener('click', (ev) => {
          removeTagWithAnimation(newTag);
        });
        keywordsList.appendChild(newTag);
        input.value = '';
        input.focus();
        syncKeywordsToGlobal();
      });
    });

    document.querySelectorAll('.geo-keyword-input').forEach(input => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const card = input.closest('.geo-result-card');
          const addBtn = card.querySelector('[data-action="add-keyword"]') || card.querySelector('[data-action="add-author"]');
          if (addBtn) addBtn.click();
        }
      });
    });

    document.querySelectorAll('[data-action="add-author"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const card = e.target.closest('.geo-result-card');
        if (!card) return;
        const input = card.querySelector('.geo-keyword-input');
        if (!input || !input.value.trim()) return;

        const authorsList = card.querySelector('.geo-keywords-list');
        const newTag = document.createElement('span');
        newTag.className = 'geo-keyword-tag';
        newTag.innerHTML = '<span class="geo-keyword-text">' + input.value.trim() + '</span><span class="geo-keyword-delete" data-action="delete-author" title="删除">×</span>';
        newTag.querySelector('[data-action="delete-author"]').addEventListener('click', (ev) => {
          removeTagWithAnimation(newTag);
        });
        authorsList.appendChild(newTag);
        input.value = '';
        input.focus();
        syncAuthorsToGlobal();
      });
    });

    document.querySelectorAll('[data-action="delete-tag"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tag = e.target.closest('.geo-tag-item');
        if (tag) {
          removeTagWithAnimation(tag);
          syncTagsToGlobal();
        }
      });
    });

    document.querySelectorAll('[data-action="ignore"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const card = e.target.closest('.geo-result-card');
        if (card) card.style.display = 'none';
      });
    });
  }

  function syncKeywordsToGlobal() {
    if (!window._geoCompleteData) return;
    const card = document.querySelector('[data-type="keywords"]');
    if (card) {
      const tags = Array.from(card.querySelectorAll('.geo-keyword-tag .geo-keyword-text')).map(t => t.textContent);
      window._geoCompleteData.keywords = tags;
    }
  }

  function syncTagsToGlobal() {
    if (!window._geoCompleteData) return;
    const card = document.querySelector('[data-type="tags"]');
    if (card) {
      const tags = Array.from(card.querySelectorAll('.geo-tag-item .geo-tag-text')).map(t => t.textContent);
      window._geoCompleteData.tags = tags;
    }
  }

  function syncAuthorsToGlobal() {
    if (!window._geoCompleteData) return;
    const card = document.querySelector('[data-type="authors"]');
    if (card) {
      const authorTags = Array.from(card.querySelectorAll('.geo-keyword-tag .geo-keyword-text'));
      window._geoCompleteData.authors = authorTags.map(t => {
        const raw = t.getAttribute('data-raw');
        if (raw) {
          try { return JSON.parse(raw); } catch (ex) { return t.textContent; }
        }
        return t.textContent;
      });
    }
  }

  // ========== 12. content.js (主入口) ==========

  console.log('AI发布助手: 脚本开始加载，当前URL:', window.location.href);

  let sidebarInjected = false;
  let monitorTimer = null;
  let _configLoaded = false;
  let _configLoadPromise = null;

  function init() {
    console.log('AI发布助手: 初始化');
    initTemplateOptions();
    _configLoadPromise = loadTemplateConfig().then(() => { _configLoaded = true; });
    if (detectFormFields()) {
      injectSidebarAndSetup();
    }
    startFormDetection();
  }

  function injectSidebarAndSetup() {
    if (sidebarInjected) return;
    sidebarInjected = true;
    injectSidebar();
    setupIframeListener();
  }

  function removeSidebar() {
    if (!sidebarInjected) return;
    sidebarInjected = false;
    const sidebar = document.getElementById('geo-sidebar');
    const toggle = document.getElementById('geo-toggle');
    if (sidebar) sidebar.remove();
    if (toggle) toggle.remove();
    console.log('AI发布助手: 已移除侧边栏');
  }

  /**
   * 持续监听表单字段出现/消失
   */
  function startFormDetection() {
    if (monitorTimer) return;
    monitorTimer = setInterval(() => {
      const formExists = detectFormFields();
      if (formExists && !sidebarInjected) {
        injectSidebarAndSetup();
      } else if (!formExists && sidebarInjected) {
        removeSidebar();
      }
    }, 2000);
  }

  /**
   * 检测页面中是否存在发布表单字段
   */
  function detectFormFields() {
    return !!findElementRecursively(document, 'news_tnNewsVo_title', 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 100);
  }

  window.addEventListener('load', () => {
    console.log('AI发布助手: 页面加载完成');
    setTimeout(init, 500);
  });

  /**
   * 注入侧边栏HTML结构
   */
  function injectSidebar() {
    if (document.getElementById('geo-sidebar')) return;

    const toggleButtonHTML = `
      <button id="geo-toggle">
        <span class="geo-toggle-icon">🤖</span>
        <span class="geo-toggle-text">AI<br>助手</span>
      </button>
    `;

    const sidebarHTML = `
      <div id="geo-sidebar" class="geo-sidebar geo-sidebar-collapsed">
        <div class="geo-resize-handle" id="geo-resize-handle"></div>
        <div class="geo-sidebar-content">
          <div class="geo-sidebar-header">
            <h3>🤖 北方网AI发布助手</h3>
            <button class="geo-btn-close" id="geo-close">×</button>
          </div>

          <div class="geo-status-area">
            <div class="geo-status-item">
              <span class="geo-label">标题：</span>
              <span class="geo-value" id="geo-title-preview">未识别</span>
            </div>
            <div class="geo-status-item">
              <span class="geo-label">正文：</span>
              <span class="geo-value" id="geo-content-length">0 字</span>
            </div>
            <div class="geo-status-item">
              <span class="geo-label">状态：</span>
              <span class="geo-value geo-status-badge" id="geo-recognize-status">待识别</span>
            </div>
          </div>

          <div class="geo-action-buttons">
            <button class="geo-btn geo-btn-refresh" id="geo-btn-refresh" data-action="refresh">
              <span class="geo-btn-icon">🔄</span>
              <span class="geo-btn-text">读取状态</span>
            </button>
            <button class="geo-btn geo-btn-primary" id="geo-btn-complete" data-action="complete">
              <span class="geo-btn-icon">📝</span>
              <span class="geo-btn-text">AI补全信息</span>
            </button>
          </div>

          <div class="geo-tabs" id="geo-tabs" style="display: none;">
            <div class="geo-action-bar" id="geo-action-bar">
              <button class="geo-btn-small geo-btn-adopt-all" data-action="adopt-all">一键采用全部</button>
              <button class="geo-btn-small geo-btn-preview" data-action="preview-modal">预览</button>
            </div>
            <div class="geo-tab-bar">
              <button class="geo-tab-btn active" data-tab="complete">补全结果</button>
              <button class="geo-tab-btn" data-tab="knowledge">知识卡片</button>
            </div>
            <div class="geo-tab-panels">
              <div class="geo-tab-panel active" id="geo-panel-complete"></div>
              <div class="geo-tab-panel" id="geo-panel-knowledge"></div>
            </div>
          </div>

          <div class="geo-loading" id="geo-loading" style="display: none;">
            <div class="geo-spinner"></div>
            <span>AI处理中...</span>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', toggleButtonHTML);
    document.body.insertAdjacentHTML('beforeend', sidebarHTML);
    initSidebarInteraction();
    setTimeout(autoRecognize, 1000);
  }

  /**
   * 监听iframe加载事件
   */
  function setupIframeListener() {
    const findIframe = () => {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
          if (iframeDoc && (iframeDoc.getElementById('news_tnNewsVo_title') || iframeDoc.getElementById('news_clobs_content_'))) {
            console.log('AI发布助手: 找到目标iframe');
            return iframe;
          }
        } catch (e) {}
      }
      return null;
    };

    const setupInputListeners = (doc) => {
      try {
        const titleInput = doc.getElementById('news_tnNewsVo_title');
        const contentTextarea = doc.getElementById('news_clobs_content_');

        const onFieldChange = (fieldName) => {
          console.log('AI发布助手:', fieldName, '变化');
          setTimeout(autoRecognize, 300);
        };

        if (titleInput) {
          ['input', 'change', 'paste', 'keyup', 'mouseup'].forEach(evt => {
            titleInput.addEventListener(evt, () => onFieldChange('标题'));
          });
          titleInput.addEventListener('blur', () => onFieldChange('标题'));
        }

        if (contentTextarea) {
          ['input', 'change', 'paste', 'keyup', 'mouseup'].forEach(evt => {
            contentTextarea.addEventListener(evt, () => onFieldChange('正文'));
          });
          contentTextarea.addEventListener('blur', () => onFieldChange('正文'));
        }
      } catch (e) {
        console.log('无法设置输入监听器:', e.message);
      }
    };

    const checkInterval = setInterval(() => {
      const iframe = findIframe();
      if (iframe) {
        clearInterval(checkInterval);
        iframe.addEventListener('load', () => {
          console.log('AI发布助手: iframe内容加载，重新识别');
          setTimeout(() => {
            try {
              const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
              setupInputListeners(iframeDoc);
            } catch (e) {}
            autoRecognize();
          }, 500);
        });

        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
          setupInputListeners(iframeDoc);
        } catch (e) {}

        setupInputListeners(document);

        // 定时检查（兜底机制）
        let lastTitle = '';
        let lastContentLen = 0;
        setInterval(async () => {
          const result = await GeoFieldReader.readTitleAndContent();
          const currentTitle = result.title || '';
          const currentLen = result.contentLength || 0;
          if (currentTitle !== lastTitle || currentLen !== lastContentLen) {
            console.log('AI发布助手: 检测到内容变化（轮询）');
            lastTitle = currentTitle;
            lastContentLen = currentLen;
            autoRecognize();
          }
        }, 3000);

        // 定时检查DOM变化
        let timer = null;
        try {
          const iframeDoc = iframe.contentDocument;
          if (iframeDoc) {
            iframeDoc.addEventListener('DOMSubtreeModified', () => {
              clearTimeout(timer);
              timer = setTimeout(() => {
                setupInputListeners(iframeDoc);
                autoRecognize();
              }, 1000);
            });
          }
        } catch (e) {}
      }
    }, 500);
    setTimeout(() => clearInterval(checkInterval), 30000);
  }

  /**
   * 初始化侧边栏交互
   */
  function initSidebarInteraction() {
    const sidebar = document.getElementById('geo-sidebar');
    const toggleBtn = document.getElementById('geo-toggle');

    toggleBtn.addEventListener('click', () => {
      sidebar.classList.remove('geo-sidebar-collapsed');
      sidebar.classList.add('geo-sidebar-expanded');
      autoRecognize();
    });

    document.getElementById('geo-close').addEventListener('click', () => {
      sidebar.classList.remove('geo-sidebar-expanded');
      sidebar.classList.add('geo-sidebar-collapsed');
      setTimeout(autoRecognize, 300);
    });

    document.querySelectorAll('.geo-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tabName = btn.dataset.tab;
        document.querySelectorAll('.geo-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.geo-tab-panel').forEach(p => p.classList.remove('active'));
        const panel = document.getElementById('geo-panel-' + tabName);
        if (panel) panel.classList.add('active');
      });
    });

    document.getElementById('geo-btn-refresh').addEventListener('click', handleRefreshStatus);
    document.getElementById('geo-btn-complete').addEventListener('click', handleCompleteInfo);

    // 拖拽调整宽度
    const resizeHandle = document.getElementById('geo-resize-handle');
    if (resizeHandle) {
      let isResizing = false;
      let startX = 0;
      let startWidth = 0;

      resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = sidebar.offsetWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const diff = startX - e.clientX;
        const newWidth = Math.min(Math.max(startWidth + diff, 300), 800);
        sidebar.style.width = newWidth + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (!isResizing) return;
        isResizing = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      });
    }
  }

  /**
   * 读取状态按钮处理
   */
  async function handleRefreshStatus() {
    const result = await GeoFieldReader.readTitleAndContent();
    updateStatusUI(result);
    if (result.title || result.contentLength > 0) {
      showToast('状态已更新');
    } else {
      showToast('未检测到标题或正文', 'error');
    }
  }

  /**
   * 自动识别页面内容
   */
  async function autoRecognize() {
    console.log('AI发布助手: 尝试读取标题和正文');
    const result = await GeoFieldReader.readTitleAndContent();
    console.log('AI发布助手: 读取结果', result);
    updateStatusUI(result);
  }

  /**
   * 更新状态UI
   */
  function updateStatusUI(result) {
    const titlePreview = document.getElementById('geo-title-preview');
    const contentLength = document.getElementById('geo-content-length');
    const statusBadge = document.getElementById('geo-recognize-status');

    if (!titlePreview || !contentLength || !statusBadge) return;

    const title = result.title || '';
    titlePreview.textContent = title.length > 30 ? title.substring(0, 30) + '...' : (title || '空');
    contentLength.textContent = (result.contentLength || 0) + ' 字';

    if (result.contentLength > 0) {
      statusBadge.textContent = '已就绪';
      statusBadge.className = 'geo-value geo-status-badge geo-status-ready';
    } else if (title) {
      statusBadge.textContent = '正文缺失';
      statusBadge.className = 'geo-value geo-status-badge geo-status-warning';
    } else {
      statusBadge.textContent = '待输入';
      statusBadge.className = 'geo-value geo-status-badge geo-status-pending';
    }
  }

  /**
   * 处理补全发布信息
   */
  async function handleCompleteInfo() {
    // 等待模板配置加载完成（确保 apiBaseUrl 已设置）
    if (!_configLoaded && _configLoadPromise) {
      await _configLoadPromise;
    }

    const result = await GeoFieldReader.readTitleAndContent();
    if (!result.content) {
      showToast('正文为空，无法补全发布信息', 'error');
      return;
    }

    let content = result.content.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (content.length > 30000) {
      content = content.substring(0, 30000) + '...（正文过长已截断）';
    }

    // 记录开始时间
    const startTime = Date.now();
    const startTimeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });

    showLoading(true);
    try {
      let aiResult;
      let providerName = '';
      let durationInfo = {};

      const config = await safeSendMessage({ action: 'getConfig' });
      const mode = config ? config.providerMode : 'mock';

      if (mode === 'mock') {
        const mockStart = Date.now();
        aiResult = await GeoMockProvider.completePublishInfo(content);
        const mockEnd = Date.now();
        providerName = 'Mock模式';
        durationInfo = {
          total: (mockEnd - startTime),
          mock: (mockEnd - mockStart)
        };
      } else if (mode === 'dmx') {
        // 大模型直连模式
        const dmxStart = Date.now();
        await GeoDmxProvider.init();
        aiResult = await GeoDmxProvider.completePublishInfo(content);
        const dmxEnd = Date.now();
        providerName = '大模型(' + GeoDmxProvider.getModel() + ')';
        durationInfo = {
          total: (dmxEnd - startTime),
          api: (dmxEnd - dmxStart)
        };
      } else {
        const configured = await GeoCozeProvider.init();
        if (configured) {
          const cozeStart = Date.now();
          aiResult = await GeoCozeProvider.completePublishInfo(content);
          const cozeEnd = Date.now();
          providerName = 'Coze工作流';
          durationInfo = {
            total: (cozeEnd - startTime),
            coze: (cozeEnd - cozeStart),
            ...(aiResult._durationInfo || {})
          };
        } else {
          const mockStart = Date.now();
          aiResult = await GeoMockProvider.completePublishInfo(content);
          const mockEnd = Date.now();
          aiResult._fallbackToMock = true;
          aiResult._fallbackReason = 'Coze初始化失败';
          providerName = 'Mock模式(未配置)';
          durationInfo = {
            total: (mockEnd - startTime),
            mock: (mockEnd - mockStart)
          };
        }
      }

      // 计算处理时间
      const endTime = Date.now();
      const totalDuration = endTime - startTime;
      const durationStr = totalDuration < 1000 ? totalDuration + 'ms' : (totalDuration / 1000).toFixed(2) + '秒';

      // 在结果中添加详细时间信息
      aiResult.processTime = {
        startTime: startTimeStr,
        endTime: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        duration: durationStr,
        provider: providerName,
        details: {
          total: durationStr,
          network: durationInfo.network ? (durationInfo.network < 1000 ? durationInfo.network + 'ms' : (durationInfo.network/1000).toFixed(2) + '秒') : null,
          api: durationInfo.api ? (durationInfo.api < 1000 ? durationInfo.api + 'ms' : (durationInfo.api/1000).toFixed(2) + '秒') : null,
          coze: durationInfo.coze ? (durationInfo.coze < 1000 ? durationInfo.coze + 'ms' : (durationInfo.coze/1000).toFixed(2) + '秒') : null,
          mock: durationInfo.mock ? (durationInfo.mock < 1000 ? durationInfo.mock + 'ms' : (durationInfo.mock/1000).toFixed(2) + '秒') : null
        }
      };

      showResult(aiResult);
    } catch (error) {
      console.error('AI处理失败:', error);
      showToast('AI处理失败: ' + error.message, 'error');
    } finally {
      showLoading(false);
    }
  }

  /**
   * 显示结果卡片（合并补全发布信息 + 知识卡片）
   */
  function showResult(data) {
    const panelComplete = document.getElementById('geo-panel-complete');
    const panelKnowledge = document.getElementById('geo-panel-knowledge');
    const tabs = document.getElementById('geo-tabs');
    if (!panelComplete || !panelKnowledge || !tabs) return;

    // Mock回退提示
    if (data._fallbackToMock) {
      const reason = data._fallbackReason || '未知原因';
      showToast('AI服务调用失败，已回退到模拟数据：' + reason, 'warning', 8000);
    }

    // 存储补全结果供JSON-LD使用
    window._geoCompleteData = data;

    // 补全结果面板
    let completeHtml = '';

    // 添加处理时间信息
    if (data.processTime) {
      let detailsHtml = '';
      if (data.processTime.details) {
        const details = data.processTime.details;
        const detailItems = [];
        if (details.network) detailItems.push('网络: ' + details.network);
        if (details.api) detailItems.push('API: ' + details.api);
        if (details.coze) detailItems.push('Coze: ' + details.coze);
        if (details.mock) detailItems.push('Mock: ' + details.mock);
        if (detailItems.length > 0) {
          detailsHtml = '<div class="geo-process-details">' +
            '<div class="geo-process-detail-label">细分耗时:</div>' +
            '<div class="geo-process-detail-items">' + detailItems.join(' | ') + '</div>' +
          '</div>';
        }
      }

      completeHtml += '<div class="geo-process-time">' +
        '<div class="geo-process-main">' +
          '<div class="geo-process-item">' +
            '<span class="geo-process-label">来源:</span>' +
            '<span class="geo-process-value">' + data.processTime.provider + '</span>' +
          '</div>' +
          '<div class="geo-process-item">' +
            '<span class="geo-process-label">总耗时:</span>' +
            '<span class="geo-process-value geo-process-duration">' + data.processTime.duration + '</span>' +
          '</div>' +
          '<div class="geo-process-item">' +
            '<span class="geo-process-label">时间:</span>' +
            '<span class="geo-process-value">' + data.processTime.startTime + '</span>' +
          '</div>' +
        '</div>' +
        detailsHtml +
      '</div>';
    }

    if (data.title) completeHtml += createCard('标题', data.title, 'title');
    if (data.summary) completeHtml += createCard('摘要', data.summary, 'summary');
    if (data.introduction) completeHtml += createCard('导读', data.introduction, 'introduction');
    if (data.authors && data.authors.length > 0) completeHtml += createAuthorsCard(data.authors);
    if (data.keywords && data.keywords.length > 0) completeHtml += createKeywordsCard(data.keywords);
    if (data.tags && data.tags.length > 0) completeHtml += createTagsCard(data.tags);
    if (data.entities && data.entities.length > 0) completeHtml += createEntitiesCard(data.entities);
    if (data.qa && data.qa.length > 0) completeHtml += createQACard(data.qa);

    // 知识卡片面板
    let knowledgeHtml = '';
    const templateId = data.templateId || '';
    if (templateId) {
      const fields = data.fields || [];
      const requiredFields = fields.filter(f => f.required);
      const optionalFields = fields.filter(f => !f.required);
      const confidence = data.confidence || 0;
      const reason = data.classifyReason || '';

      const currentOption = TEMPLATE_OPTIONS.find(o => o.id === templateId);
      const templateIcon = currentOption ? currentOption.icon : '📋';
      const templateName = data.templateName || (currentOption ? currentOption.name : templateId);

      const missingFields = requiredFields.filter(f => {
        const val = f.value !== undefined ? f.value : data[f.key];
        if (val === undefined || val === null || val === '' || (Array.isArray(val) && val.length === 0)) {
          return true;
        }
        return false;
      });

      knowledgeHtml += '<div class="geo-kc-template">' +
        '<div class="geo-kc-template-header">' +
          '<span class="geo-kc-template-icon">' + templateIcon + '</span>' +
          '<span class="geo-kc-template-name">' + templateName + '</span>' +
          '<span class="geo-kc-confidence">置信度 ' + Math.round(confidence * 100) + '%</span>' +
        '</div>' +
        (reason ? '<div class="geo-kc-reason">推荐理由：' + reason + '</div>' : '') +
        '<div class="geo-kc-template-switch">' +
          '<span>切换模板：</span>' +
          '<select class="geo-kc-template-select" id="geo-kc-template-select">';

      TEMPLATE_OPTIONS.forEach(opt => {
        knowledgeHtml += '<option value="' + opt.id + '" ' + (opt.id === templateId ? 'selected' : '') + '>' + opt.icon + ' ' + opt.name + '</option>';
      });

      knowledgeHtml += '</select></div></div>';

      if (missingFields.length > 0) {
        const missingLabels = missingFields.map(f => f.label || f.key);
        knowledgeHtml += '<div class="geo-kc-missing">' +
          '<span class="geo-kc-missing-icon">⚠️</span>' +
          '<span>缺失必填字段：' + missingLabels.join('、') + '</span>' +
        '</div>';
      }

      knowledgeHtml += '<div class="geo-kc-fields">';

      requiredFields.forEach(field => {
        const val = field.value !== undefined ? field.value : data[field.key];
        const evidence = field.evidence || data[field.key + '_evidence'] || '';
        knowledgeHtml += createKCEditField(field.key, val, evidence, field.label, true);
      });

      optionalFields.forEach(field => {
        const val = field.value !== undefined ? field.value : data[field.key];
        const evidence = field.evidence || data[field.key + '_evidence'] || '';
        if (val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && val.length === 0)) {
          knowledgeHtml += createKCEditField(field.key, val, evidence, field.label, false);
        }
      });

      knowledgeHtml += '</div>';
    } else {
      knowledgeHtml = '<div style="text-align:center;color:#999;padding:30px 0;font-size:13px;">暂无知识卡片数据</div>';
    }

    panelComplete.innerHTML = completeHtml;
    panelKnowledge.innerHTML = knowledgeHtml;
    tabs.style.display = 'flex';
    // 记住当前Tab，避免切换模板时跳回
    const currentTab = document.querySelector('.geo-tab-btn.active');
    const currentTabName = currentTab ? currentTab.dataset.tab : 'complete';
    switchTab(currentTabName);
    bindCardEvents();
    if (templateId) {
      bindKnowledgeCardEvents(data, templateId);
    }
  }

  function switchTab(tabName) {
    document.querySelectorAll('.geo-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.geo-tab-panel').forEach(p => p.classList.remove('active'));
    const btn = document.querySelector('.geo-tab-btn[data-tab="' + tabName + '"]');
    const panel = document.getElementById('geo-panel-' + tabName);
    if (btn) btn.classList.add('active');
    if (panel) panel.classList.add('active');
  }

})();