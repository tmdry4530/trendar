import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRisingQuery, buildTrendsQuery, orderByForSort } from '../src/models/repo.model.js';

test('신생 급상승 쿼리 — 24시간 500스타 증가·15일 필터를 적용한다', () => {
  const { sql, params } = buildRisingQuery(42, {
    windowDays: 15,
    minDelta: 500,
    limit: 8,
  });

  const compactSql = sql.replace(/\s+/g, ' ').trim();
  assert.match(compactSql, /s\.captured_at <= DATE_SUB\(NOW\(\), INTERVAL 24 HOUR\)/);
  assert.match(compactSql, /ORDER BY s\.captured_at DESC, s\.id DESC LIMIT 1/);
  assert.match(compactSql, /r\.stars - baseline\.stars >= \?/);
  assert.match(compactSql, /ORDER BY star_delta_24h DESC, growth_rate_24h DESC/);
  assert.deepEqual(params, [42, 15, 500, 8]);
});

test('빠르게 성장 중 쿼리 (랭킹 v3) — 스타·24h 증가 하한, 48시간 신선도, 점수 정렬', () => {
  const { sql, params } = buildTrendsQuery(42, 10);
  const compactSql = sql.replace(/\s+/g, ' ').trim();
  assert.match(compactSql, /stars >= \? AND delta_24h >= \? AND last_refreshed_at >= DATE_SUB\(NOW\(\), INTERVAL 48 HOUR\)/);
  assert.match(compactSql, /ORDER BY score DESC, delta_24h DESC LIMIT \?/);
  assert.match(compactSql, /delta_24h \/ GREATEST\(delta_7d \/ 7, 1\) AS acceleration/);
  assert.doesNotMatch(compactSql, /stars >= 1000|ORDER BY growth_rate/);
  assert.deepEqual(params, [42, 50, 10, 10], '기본 하한: 50스타 · 24h +10');
});

test('빠르게 성장 중 쿼리 — TREND_RANK_MIN_STARS/MIN_DELTA 환경변수와 명시 옵션', () => {
  const prevS = process.env.TREND_RANK_MIN_STARS;
  const prevD = process.env.TREND_RANK_MIN_DELTA;
  process.env.TREND_RANK_MIN_STARS = '200';
  process.env.TREND_RANK_MIN_DELTA = '0';
  try {
    assert.deepEqual(buildTrendsQuery(7, 5).params, [7, 200, 0, 5]);
    process.env.TREND_RANK_MIN_STARS = 'abc';
    assert.deepEqual(buildTrendsQuery(7, 5).params, [7, 50, 0, 5], '잘못된 값은 기본값');
    assert.deepEqual(buildTrendsQuery(7, 5, { minStars: 1, minDelta: 2 }).params, [7, 1, 2, 5]);
  } finally {
    if (prevS === undefined) delete process.env.TREND_RANK_MIN_STARS; else process.env.TREND_RANK_MIN_STARS = prevS;
    if (prevD === undefined) delete process.env.TREND_RANK_MIN_DELTA; else process.env.TREND_RANK_MIN_DELTA = prevD;
  }
});

test('findMany 정렬 — score 추가, growth는 score로 매핑, 기존 정렬 유지', () => {
  assert.equal(orderByForSort('score'), 'score DESC, delta_24h DESC');
  assert.equal(orderByForSort('growth'), 'score DESC, delta_24h DESC');
  assert.equal(orderByForSort('recent'), 'first_seen_at DESC');
  assert.equal(orderByForSort('stars'), 'stars DESC');
  assert.equal(orderByForSort(undefined), 'stars DESC');
  assert.equal(orderByForSort('DROP TABLE'), 'stars DESC', '임의 입력은 SQL에 섞이지 않는다');
});
