import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../src/db/init.js';

test('startup repairs interrupted setup before ranking snapshot backfill', async () => {
  const tables = new Set(['users', 'repos']); // Previous startup stopped before snapshots.
  const queries = [];
  const db = { async query(sql) {
    queries.push(sql);
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
      return [[...tables].map(TABLE_NAME => ({ TABLE_NAME }))];
    }
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
      const names = sql.includes("TABLE_NAME = 'users'")
        ? ['manual_etl_date', 'manual_etl_count']
        : ['github_id', 'growth_rate', 'github_created_at'];
      return [names.map(COLUMN_NAME => ({ COLUMN_NAME }))];
    }
    if (sql.includes('INFORMATION_SCHEMA.STATISTICS')) return [[]];
    const created = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];
    if (created) tables.add(created);
    if (sql.includes('UPDATE repos r')) {
      assert.ok(tables.has('repo_snapshots'), 'backfill must not run before snapshots table exists');
    }
    return [{}];
  } };
  await initDb(db);
  const create = queries.findIndex(sql => sql.startsWith('CREATE TABLE IF NOT EXISTS repo_snapshots'));
  const backfill = queries.findIndex(sql => sql.includes('UPDATE repos r'));
  assert.ok(create >= 0 && backfill > create);
  assert.ok(queries.some(sql => sql.includes('ADD COLUMN delta_24h')));
  assert.ok(queries.some(sql => sql.includes('ADD KEY idx_user_refreshed')));
});
