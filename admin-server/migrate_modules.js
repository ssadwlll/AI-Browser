const pool = require('./config/db');

async function migrate() {
  try {
    console.log('Adding params_schema column...');
    await pool.query('ALTER TABLE scripts ADD COLUMN params_schema JSON');
    console.log('params_schema column added.');
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME') {
      console.log('params_schema column already exists, skipping.');
    } else {
      throw e;
    }
  }

  try {
    console.log('Adding params_data column...');
    await pool.query('ALTER TABLE scripts ADD COLUMN params_data JSON');
    console.log('params_data column added.');
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME') {
      console.log('params_data column already exists, skipping.');
    } else {
      throw e;
    }
  }

  try {
    console.log('Creating script_modules table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS script_modules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        script_id INT NOT NULL,
        name VARCHAR(100) NOT NULL,
        code LONGTEXT NOT NULL,
        load_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('script_modules table created.');
  } catch (e) {
    if (e.code === 'ER_TABLE_EXISTS_ERROR') {
      console.log('script_modules table already exists, skipping.');
    } else {
      throw e;
    }
  }

  console.log('Migration done!');
  process.exit(0);
}

migrate().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
