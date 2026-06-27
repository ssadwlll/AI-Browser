@echo off
cd /d c:\phpstudy_pro\WWW\qwen3\ai-browser\admin-server
c:\phpstudy_pro\Extensions\MySQL8.0.12\bin\mysql.exe -u root -p66wz66wz aibrowser -e "ALTER TABLE scripts ADD COLUMN params_schema JSON; ALTER TABLE scripts ADD COLUMN params_data JSON; CREATE TABLE IF NOT EXISTS script_modules (id INT AUTO_INCREMENT PRIMARY KEY, script_id INT NOT NULL, name VARCHAR(100) NOT NULL, code LONGTEXT NOT NULL, load_order INT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
echo Done!
pause
