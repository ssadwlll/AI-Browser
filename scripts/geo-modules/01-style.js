// GEO AI发布助手 - 样式注入模块
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
