import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPoolConfig, pool } from '../src/config/db.js';

test('DB_* 풀 설정은 기존 연결 옵션을 유지하고 큐·타임아웃 상한과 UTC를 적용한다', () => {
  assert.deepEqual(buildPoolConfig({
    DB_HOST: 'db.example', DB_PORT: '3307', DB_USER: 'trendar',
    DB_PASSWORD: 'password', DB_NAME: 'public_test',
  }), {
    host: 'db.example', port: 3307, user: 'trendar', password: 'password',
    database: 'public_test', waitForConnections: true, connectionLimit: 10,
    queueLimit: 200, connectTimeout: 10000, timezone: 'Z',
  });
});

test('DB 포트 미설정·0·잘못된 값은 기존 기본값 3306을 유지한다', () => {
  for (const DB_PORT of [undefined, '', '0', 'invalid']) {
    assert.equal(buildPoolConfig({ DB_PORT }).port, 3306);
    assert.equal(buildPoolConfig({ DB_PORT }).timezone, 'Z');
    assert.equal(buildPoolConfig({ DB_PORT }).queueLimit, 200);
    assert.equal(buildPoolConfig({ DB_PORT }).connectTimeout, 10000);
  }
});

test('MYSQL_URL은 원문 URI와 큐·타임아웃 상한·UTC 옵션으로 전달되며 DATABASE_URL보다 우선한다', () => {
  const uri = 'mysql://name:p%40ss@db.example:3307/trendar?connectionLimit=4';
  assert.deepEqual(buildPoolConfig({ MYSQL_URL: uri, DATABASE_URL: 'mysql://other/ignored', DB_HOST: 'ignored' }), {
    uri, timezone: 'Z', queueLimit: 200, connectTimeout: 10000,
  });
});

test('DATABASE_URL도 원문 URI와 큐·타임아웃 상한·UTC 옵션으로 전달하고 빈 MYSQL_URL은 건너뛴다', () => {
  const uri = 'mysql://name:password@db.example/trendar';
  assert.deepEqual(buildPoolConfig({ DATABASE_URL: uri }), { uri, timezone: 'Z', queueLimit: 200, connectTimeout: 10000 });
  assert.deepEqual(buildPoolConfig({ MYSQL_URL: '', DATABASE_URL: uri }), { uri, timezone: 'Z', queueLimit: 200, connectTimeout: 10000 });
  assert.equal(buildPoolConfig({ MYSQL_URL: '', DATABASE_URL: '' }).timezone, 'Z');
});

test('DB_QUEUE_LIMIT과 DB_CONNECT_TIMEOUT_MS는 양의 정수일 때만 재정의된다', () => {
  const custom = buildPoolConfig({ DB_QUEUE_LIMIT: '50', DB_CONNECT_TIMEOUT_MS: '5000' });
  assert.equal(custom.queueLimit, 50);
  assert.equal(custom.connectTimeout, 5000);
  const fallback = buildPoolConfig({ DB_QUEUE_LIMIT: '0', DB_CONNECT_TIMEOUT_MS: '-1' });
  assert.equal(fallback.queueLimit, 200);
  assert.equal(fallback.connectTimeout, 10000);
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
