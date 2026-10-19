// test/session.model.test.js — hasValidByHash는 sessions만 조회한다(users 조인 없음, DB 불필요)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/db.js';
import { hasValidByHash } from '../src/models/session.model.js';

const originalQuery = pool.query;
afterEach(() => {
  pool.query = originalQuery;
});

function fakeQuery(rows) {
  const calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return [rows, []];
  };
  return calls;
}

test('hasValidByHash: 행이 있으면 true, sessions만 조회', async () => {
  const calls = fakeQuery([{ 1: 1 }]);
  assert.equal(await hasValidByHash('hash-1'), true);
  assert.equal(calls.length, 1);
  const { sql, params } = calls[0];
  assert.match(sql, /FROM sessions\b/);
  assert.doesNotMatch(sql, /JOIN/i);
  assert.doesNotMatch(sql, /users/i);
  assert.match(sql, /token_hash = \?/);
  assert.match(sql, /expires_at > NOW\(\)/);
  assert.match(sql, /LIMIT 1/);
  assert.deepEqual(params, ['hash-1']);
});

test('hasValidByHash: 행이 없으면 false', async () => {
  fakeQuery([]);
  assert.equal(await hasValidByHash('missing'), false);
});
