// test/query-limit.test.js — utils/limits 사용자당 watch query 상한 검증(스텁, DB 불필요)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { maxQueriesPerUser, assertQueryLimit } from '../src/utils/limits.js';

const ORIGINAL_MAX = process.env.MAX_QUERIES_PER_USER;

after(() => {
  if (ORIGINAL_MAX === undefined) {
    delete process.env.MAX_QUERIES_PER_USER;
  } else {
    process.env.MAX_QUERIES_PER_USER = ORIGINAL_MAX;
  }
});

test('maxQueriesPerUser: env 미설정 시 기본값 10', () => {
  delete process.env.MAX_QUERIES_PER_USER;
  assert.equal(maxQueriesPerUser(), 10);
});

test('maxQueriesPerUser: MAX_QUERIES_PER_USER=3이면 3', () => {
  process.env.MAX_QUERIES_PER_USER = '3';
  assert.equal(maxQueriesPerUser(), 3);
});

test('maxQueriesPerUser: 잘못된 값("abc")이면 기본값 10', () => {
  process.env.MAX_QUERIES_PER_USER = 'abc';
  assert.equal(maxQueriesPerUser(), 10);
});

test('maxQueriesPerUser: 잘못된 값("-1")이면 기본값 10', () => {
  process.env.MAX_QUERIES_PER_USER = '-1';
  assert.equal(maxQueriesPerUser(), 10);
});

test('assertQueryLimit: count 9 & 기본 상한(10)이면 통과', () => {
  delete process.env.MAX_QUERIES_PER_USER;
  assert.doesNotThrow(() => assertQueryLimit(9));
});

test('assertQueryLimit: count 10 & 기본 상한(10)이면 throw(400, QUERY_LIMIT_EXCEEDED)', () => {
  delete process.env.MAX_QUERIES_PER_USER;
  assert.throws(() => assertQueryLimit(10), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'QUERY_LIMIT_EXCEEDED');
    return true;
  });
});

test('assertQueryLimit: env=3에서 count 3이면 throw', () => {
  process.env.MAX_QUERIES_PER_USER = '3';
  assert.throws(() => assertQueryLimit(3), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'QUERY_LIMIT_EXCEEDED');
    return true;
  });
});
