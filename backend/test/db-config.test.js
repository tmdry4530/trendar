import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPoolConfig, pool } from '../src/config/db.js';

test('DB_* 풀 설정은 기존 연결 옵션을 유지하고 Date를 UTC로 처리한다', () => {
  assert.deepEqual(buildPoolConfig({
    DB_HOST: 'db.example', DB_PORT: '3307', DB_USER: 'trendar',
    DB_PASSWORD: 'password', DB_NAME: 'public_test',
  }), {
    host: 'db.example', port: 3307, user: 'trendar', password: 'password',
    database: 'public_test', waitForConnections: true, connectionLimit: 10, timezone: 'Z',
  });
});

test('DB 포트 미설정·0·잘못된 값은 기존 기본값 3306을 유지한다', () => {
  for (const DB_PORT of [undefined, '', '0', 'invalid']) {
    assert.equal(buildPoolConfig({ DB_PORT }).port, 3306);
    assert.equal(buildPoolConfig({ DB_PORT }).timezone, 'Z');
  }
});

test('MYSQL_URL은 원문 URI와 UTC 옵션으로 전달되며 DATABASE_URL보다 우선한다', () => {
  const uri = 'mysql://name:p%40ss@db.example:3307/trendar?connectionLimit=4';
  assert.deepEqual(buildPoolConfig({ MYSQL_URL: uri, DATABASE_URL: 'mysql://other/ignored', DB_HOST: 'ignored' }), {
    uri, timezone: 'Z',
  });
});

test('DATABASE_URL도 원문 URI와 UTC 옵션으로 전달하고 빈 MYSQL_URL은 건너뛴다', () => {
  const uri = 'mysql://name:password@db.example/trendar';
  assert.deepEqual(buildPoolConfig({ DATABASE_URL: uri }), { uri, timezone: 'Z' });
  assert.deepEqual(buildPoolConfig({ MYSQL_URL: '', DATABASE_URL: uri }), { uri, timezone: 'Z' });
  assert.equal(buildPoolConfig({ MYSQL_URL: '', DATABASE_URL: '' }).timezone, 'Z');
});

test('새 연결마다 첫 쿼리로 MySQL 세션 시간대를 UTC로 맞춘다', () => {
  const calls = [];
  for (let id = 0; id < 2; id++) {
    pool.pool.emit('connection', { query: (sql) => calls.push([id, sql]) });
  }
  assert.deepEqual(calls, [
    [0, "SET time_zone = '+00:00'"],
    [1, "SET time_zone = '+00:00'"],
  ]);
});
