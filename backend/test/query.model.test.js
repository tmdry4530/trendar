import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Query from '../src/models/query.model.js';
import { pool } from '../src/config/db.js';

const ORIGINAL_MAX = process.env.PRO_MAX_QUERIES_PER_USER;

after(() => {
  if (ORIGINAL_MAX === undefined) delete process.env.PRO_MAX_QUERIES_PER_USER;
  else process.env.PRO_MAX_QUERIES_PER_USER = ORIGINAL_MAX;
});

function fakeConnection({ count = 0, insertId = 1, insertError } = {}) {
  const calls = [];
  const connection = {
    calls,
    async beginTransaction() { calls.push({ type: 'begin' }); },
    async query(sql, params) {
      calls.push({ type: 'query', sql, params });
      if (sql.includes('SELECT id FROM users')) return [[{ id: params[0] }], []];
      if (sql.includes('SELECT COUNT(*)')) return [[{ c: count }], []];
      if (sql.startsWith('INSERT')) {
        if (insertError) throw insertError;
        return [{ insertId }, []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async commit() { calls.push({ type: 'commit' }); },
    async rollback() { calls.push({ type: 'rollback' }); },
    release() { calls.push({ type: 'release' }); },
  };
  return connection;
}

async function withConnection(connection, fn) {
  const originalGetConnection = pool.getConnection;
  pool.getConnection = async () => connection;
  try {
    return await fn();
  } finally {
    pool.getConnection = originalGetConnection;
  }
}

test('create: 제한 도달 시 users 행 잠금 후 INSERT 없이 rollback/release', async () => {
  process.env.PRO_MAX_QUERIES_PER_USER = '1';
  const connection = fakeConnection({ count: 1 });

  await withConnection(connection, async () => {
    await assert.rejects(
      Query.create(7, { query: 'agents', query_type: 'keyword' }),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.code, 'QUERY_LIMIT_EXCEEDED');
        return true;
      }
    );
  });

  const queries = connection.calls.filter((call) => call.type === 'query');
  assert.match(queries[0].sql, /SELECT id FROM users WHERE id = \? FOR UPDATE/);
  assert.equal(queries[0].params[0], 7);
  assert.match(queries[1].sql, /SELECT COUNT\(\*\) AS c FROM watch_queries/);
  assert.equal(queries.some((call) => call.sql.startsWith('INSERT')), false);
  assert.deepEqual(connection.calls.map((call) => call.type), [
    'begin', 'query', 'query', 'rollback', 'release',
  ]);
});

test('create: 삽입 성공 시 commit/release하고 생성 결과를 반환', async () => {
  process.env.PRO_MAX_QUERIES_PER_USER = '10';
  const connection = fakeConnection({ count: 0, insertId: 12 });

  const result = await withConnection(connection, () =>
    Query.create(7, { query: ' agents ', query_type: 'keyword' })
  );

  assert.equal(result.id, 12);
  assert.equal(result.query, ' agents ');
  assert.equal(result.query_type, 'keyword');
  assert.equal(connection.calls.some((call) => call.type === 'commit'), true);
  assert.equal(connection.calls.some((call) => call.type === 'rollback'), false);
  assert.equal(connection.calls.at(-1).type, 'release');
});

test('create: 중복 INSERT 오류는 그대로 전달하고 rollback/release', async () => {
  process.env.PRO_MAX_QUERIES_PER_USER = '10';
  const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
  const connection = fakeConnection({ insertError: duplicate });

  await withConnection(connection, async () => {
    await assert.rejects(Query.create(7, { query: 'agents' }), (err) => err === duplicate);
  });

  assert.equal(connection.calls.some((call) => call.type === 'commit'), false);
  assert.equal(connection.calls.some((call) => call.type === 'rollback'), true);
  assert.equal(connection.calls.at(-1).type, 'release');
});
