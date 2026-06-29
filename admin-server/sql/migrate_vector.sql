-- ============ 向量存储迁移 ============
-- 为脚本表添加向量字段，将内存向量存储迁移到数据库

USE aibrowser;

-- 安全添加 vector 列（兼容 MySQL 5.7+）
DROP PROCEDURE IF EXISTS add_vector_columns;
DELIMITER $$
CREATE PROCEDURE add_vector_columns()
BEGIN
  IF NOT EXISTS (SELECT * FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'aibrowser' AND TABLE_NAME = 'scripts' AND COLUMN_NAME = 'vector') THEN
    ALTER TABLE scripts ADD COLUMN vector LONGTEXT NULL COMMENT '脚本名称+描述的1024维embedding向量(JSON数组)';
  END IF;
  IF NOT EXISTS (SELECT * FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'aibrowser' AND TABLE_NAME = 'scripts' AND COLUMN_NAME = 'vector_updated_at') THEN
    ALTER TABLE scripts ADD COLUMN vector_updated_at TIMESTAMP NULL COMMENT '向量最后生成时间';
  END IF;
END$$
DELIMITER ;
CALL add_vector_columns();
DROP PROCEDURE IF EXISTS add_vector_columns;
