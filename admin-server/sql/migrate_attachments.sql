-- 附件管理表迁移
-- 用途：管理上传的附件（图片、PDF 等），供侧边栏聊天使用
USE aibrowser;

CREATE TABLE IF NOT EXISTS attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  filename VARCHAR(255) NOT NULL COMMENT '存储文件名',
  original_name VARCHAR(255) NOT NULL COMMENT '原始文件名',
  file_size INT DEFAULT 0 COMMENT '文件大小 (bytes)',
  mime_type VARCHAR(100) DEFAULT 'application/octet-stream' COMMENT 'MIME 类型',
  file_path VARCHAR(500) NOT NULL COMMENT '相对路径',
  purpose VARCHAR(50) DEFAULT 'attachment' COMMENT '用途: script|attachment',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='附件管理表';
