import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kstToday, kstNextMidnight } from '../src/utils/kst.js';
import { maxManualEtlPerDay, trendWindowDays, trendMinStars } from '../src/utils/limits.js';

// KST 자정 = UTC 15:00. 경계 전후로 날짜가 정확히 넘어가야 한다.

test('kstToday — UTC 15:00 직전은 KST 같은 날', () => {
  assert.equal(kstToday(new Date('2026-07-15T14:59:59Z')), '2026-07-15');
});

test('kstToday — UTC 15:00 정각부터 KST 다음 날', () => {
  assert.equal(kstToday(new Date('2026-07-15T15:00:00Z')), '2026-07-16');
});

test('kstToday — UTC 자정은 KST 오전 9시, 같은 날', () => {
  assert.equal(kstToday(new Date('2026-07-15T00:00:00Z')), '2026-07-15');
});

test('kstToday — 월말 경계 (UTC 7/31 15:00 = KST 8/1)', () => {
  assert.equal(kstToday(new Date('2026-07-31T15:00:00Z')), '2026-08-01');
});

test('kstNextMidnight — KST 저녁이면 오늘 밤 자정(UTC 15:00)', () => {
  assert.equal(
    kstNextMidnight(new Date('2026-07-15T10:00:00Z')).toISOString(),
    '2026-07-15T15:00:00.000Z'
  );
});

test('kstNextMidnight — 자정 직전이면 1초 뒤가 리셋', () => {
  assert.equal(
    kstNextMidnight(new Date('2026-07-15T14:59:59Z')).toISOString(),
    '2026-07-15T15:00:00.000Z'
  );
});

test('kstNextMidnight — 자정 정각이면 다음 날 자정', () => {
  assert.equal(
    kstNextMidnight(new Date('2026-07-15T15:00:00Z')).toISOString(),
    '2026-07-16T15:00:00.000Z'
  );
});

test('maxManualEtlPerDay — 기본 10, env 정수면 반영, 비정상 값은 기본값', () => {
  const orig = process.env.MAX_MANUAL_ETL_PER_DAY;
  try {
    delete process.env.MAX_MANUAL_ETL_PER_DAY;
    assert.equal(maxManualEtlPerDay(), 10);
    process.env.MAX_MANUAL_ETL_PER_DAY = '5';
    assert.equal(maxManualEtlPerDay(), 5);
    process.env.MAX_MANUAL_ETL_PER_DAY = '0';
    assert.equal(maxManualEtlPerDay(), 10);
    process.env.MAX_MANUAL_ETL_PER_DAY = 'abc';
    assert.equal(maxManualEtlPerDay(), 10);
  } finally {
    if (orig === undefined) delete process.env.MAX_MANUAL_ETL_PER_DAY;
    else process.env.MAX_MANUAL_ETL_PER_DAY = orig;
  }
});

test('trendWindowDays — 기본 90, env 양의 정수면 반영, 비정상 값은 기본값', () => {
  const orig = process.env.ETL_TREND_WINDOW_DAYS;
  try {
    delete process.env.ETL_TREND_WINDOW_DAYS;
    assert.equal(trendWindowDays(), 90);
    process.env.ETL_TREND_WINDOW_DAYS = '30';
    assert.equal(trendWindowDays(), 30);
    process.env.ETL_TREND_WINDOW_DAYS = '0';
    assert.equal(trendWindowDays(), 90);
    process.env.ETL_TREND_WINDOW_DAYS = '-5';
    assert.equal(trendWindowDays(), 90);
    process.env.ETL_TREND_WINDOW_DAYS = 'abc';
    assert.equal(trendWindowDays(), 90);
  } finally {
    if (orig === undefined) delete process.env.ETL_TREND_WINDOW_DAYS;
    else process.env.ETL_TREND_WINDOW_DAYS = orig;
  }
});

test('trendMinStars — 기본 50, env 0 이상 정수면 반영(0 포함), 비정상 값은 기본값', () => {
  const orig = process.env.ETL_TREND_MIN_STARS;
  try {
    delete process.env.ETL_TREND_MIN_STARS;
    assert.equal(trendMinStars(), 50);
    process.env.ETL_TREND_MIN_STARS = '10';
    assert.equal(trendMinStars(), 10);
    process.env.ETL_TREND_MIN_STARS = '0';
    assert.equal(trendMinStars(), 0);
    process.env.ETL_TREND_MIN_STARS = '-1';
    assert.equal(trendMinStars(), 50);
    process.env.ETL_TREND_MIN_STARS = 'abc';
    assert.equal(trendMinStars(), 50);
  } finally {
    if (orig === undefined) delete process.env.ETL_TREND_MIN_STARS;
    else process.env.ETL_TREND_MIN_STARS = orig;
  }
});
