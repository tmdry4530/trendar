// test/query-limit.test.js — utils/limits 사용자당 watch query 상한 검증(스텁, DB 불필요)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { maxQueriesPerUser, assertQueryLimit } from '../src/utils/limits.js';

const KEYS = ['PRO_MAX_QUERIES_PER_USER', 'MAX_QUERIES_PER_USER'];
const ORIGINAL = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function reset() {
  for (const k of KEYS) delete process.env[k];
}

after(() => {
  for (const k of KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

test('maxQueriesPerUser: env 미설정 시 기본값 50', () => {
  reset();
  assert.equal(maxQueriesPerUser(), 50);
});

test('maxQueriesPerUser: PRO_MAX_QUERIES_PER_USER=3이면 3', () => {
  reset();
  process.env.PRO_MAX_QUERIES_PER_USER = '3';
  assert.equal(maxQueriesPerUser(), 3);
});

test('maxQueriesPerUser: 구 저가 MAX_QUERIES_PER_USER는 무시한다', () => {
  reset();
  process.env.MAX_QUERIES_PER_USER = '3';
  assert.equal(maxQueriesPerUser(), 50);
});

for (const bad of ['abc', '-1', '0', '1.5', '']) {
  test(`maxQueriesPerUser: 잘못된 값(${JSON.stringify(bad)})이면 기본값 50`, () => {
    reset();
    process.env.PRO_MAX_QUERIES_PER_USER = bad;
    assert.equal(maxQueriesPerUser(), 50);
  });
}

test('assertQueryLimit: 경계 49 통과, 50 거부(400, QUERY_LIMIT_EXCEEDED)', () => {
  reset();
  assert.doesNotThrow(() => assertQueryLimit(49));
  assert.throws(() => assertQueryLimit(50), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'QUERY_LIMIT_EXCEEDED');
    return true;
  });
});

test('assertQueryLimit: PRO_MAX=3에서 count 3이면 throw, 구 MAX=1은 영향 없음', () => {
  reset();
  process.env.MAX_QUERIES_PER_USER = '1';
  process.env.PRO_MAX_QUERIES_PER_USER = '3';
  assert.doesNotThrow(() => assertQueryLimit(2));
  assert.throws(() => assertQueryLimit(3), { code: 'QUERY_LIMIT_EXCEEDED' });
});
