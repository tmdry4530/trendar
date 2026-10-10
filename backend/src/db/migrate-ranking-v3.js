import 'dotenv/config';
import { pool } from '../config/db.js';
import { migrateRankingV3 } from './ranking-v3.js';

try {
  const [[{ database }]] = await pool.query('SELECT DATABASE() AS database');
  if (!database) throw new Error('Select a database in MYSQL_URL, DATABASE_URL or DB_NAME.');
  const [tables] = await pool.query(`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('repos', 'repo_snapshots')`);
  if (tables.length !== 2) throw new Error('Existing repos and repo_snapshots tables are required.');
  console.log(`Migrating ranking v3 in database: ${database}`);
  await migrateRankingV3(pool);
  console.log('Ranking v3 migration completed.');
} finally {
  await pool.end();
}
