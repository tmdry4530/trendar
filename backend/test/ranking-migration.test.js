import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateRankingV3 } from '../src/db/ranking-v3.js';

function database(columns, indexes = []) {
  const calls = [];
  return { calls, async query(sql) {
    calls.push(sql);
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return [columns.map(COLUMN_NAME => ({ COLUMN_NAME }))];
    if (sql.includes('INFORMATION_SCHEMA.STATISTICS')) return [indexes.map(INDEX_NAME => ({ INDEX_NAME }))];
    const column = sql.match(/ADD COLUMN (\w+)/)?.[1];
    const index = sql.match(/ADD KEY (\w+)/)?.[1];
    if (column) { assert.ok(!columns.includes(column)); columns.push(column); }
    if (index) { assert.ok(!indexes.includes(index)); indexes.push(index); }
    return [{}];
  } };
}

test('ranking migration handles old schema and reruns without duplicate DDL', async () => {
  const db = database(['github_id', 'growth_rate']);
  await migrateRankingV3(db);
  assert.equal(db.calls.filter(s => s.startsWith('ALTER')).length, 7);
  db.calls.length = 0;
  await migrateRankingV3(db);
  assert.equal(db.calls.filter(s => s.startsWith('ALTER')).length, 0);
  assert.match(db.calls.at(-1), /WHERE r.last_refreshed_at IS NULL/);
});

test('ranking migration repairs partial columns and missing indexes independently', async () => {
  const db = database(['github_id', 'growth_rate', 'delta_24h', 'score'], ['idx_user_score']);
  await migrateRankingV3(db);
  const alters = db.calls.filter(s => s.startsWith('ALTER'));
  assert.equal(alters.length, 4);
  assert.ok(alters.some(s => s.includes('ADD COLUMN delta_7d')));
  assert.ok(alters.some(s => s.includes('ADD KEY idx_user_refreshed')));
});

test('ranking migration leaves absent schema for fresh table creation', async () => {
  const db = database([]);
  await migrateRankingV3(db);
  assert.equal(db.calls.length, 1);
});

test('ranking migration retries an interrupted backfill without replaying DDL', async () => {
  const db = database(['github_id', 'growth_rate']);
  const query = db.query.bind(db);
  let failed = false;
  db.query = async sql => {
    if (sql.startsWith('UPDATE') && !failed) {
      failed = true;
      throw new Error('interrupted backfill');
    }
    return query(sql);
  };
  await assert.rejects(migrateRankingV3(db), /interrupted backfill/);
  db.calls.length = 0;
  await migrateRankingV3(db);
  assert.equal(db.calls.filter(s => s.startsWith('ALTER')).length, 0);
  assert.match(db.calls.at(-1), /UPDATE repos/);
});
