-- AI Browser 管理后台数据库初始化脚本
-- 使用方法: mysql -u root -p < sql/init.sql

-- 创建数据库（如果不存在）
CREATE DATABASE IF NOT EXISTS aibrowser CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE aibrowser;

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role ENUM('admin', 'developer', 'editor') DEFAULT 'editor',
  status TINYINT DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 脚本分类表
CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  slug VARCHAR(50) NOT NULL UNIQUE,
  description VARCHAR(255),
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 脚本表
CREATE TABLE IF NOT EXISTS scripts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  category_id INT,
  version VARCHAR(20) DEFAULT '1.0.0',
  author_id INT,
  file_path VARCHAR(500) NOT NULL,
  file_size INT DEFAULT 0,
  icon VARCHAR(50) DEFAULT 'code',
  url_pattern VARCHAR(255) DEFAULT '*',
  config_schema JSON,
  params_schema JSON,
  params_data JSON,
  status ENUM('draft', 'published', 'archived') DEFAULT 'draft',
  download_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 脚本模块表
CREATE TABLE IF NOT EXISTS script_modules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  script_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  code LONGTEXT NOT NULL,
  load_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 使用统计表
CREATE TABLE IF NOT EXISTS usage_stats (
  id INT AUTO_INCREMENT PRIMARY KEY,
  script_id INT NOT NULL,
  user_id INT NOT NULL,
  action ENUM('install', 'run', 'uninstall') NOT NULL,
  duration_ms INT DEFAULT 0,
  success TINYINT DEFAULT 1,
  error_msg TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 插入默认分类
INSERT INTO categories (name, slug, description, sort_order) VALUES
('数据采集', 'data-collection', '网页数据抓取与采集', 1),
('自动化操作', 'automation', '自动填表、签到、发布等', 2),
('页面增强', 'page-enhance', '去广告、暗黑模式、翻译等', 3),
('AI 增强', 'ai-enhance', 'AI 摘要、翻译、改写等', 4),
('内容生产', 'content-production', '排版、发布、多平台分发', 5),
('运营辅助', 'operation', '监控、检测、报告生成', 6)
ON DUPLICATE KEY UPDATE name = VALUES(name);