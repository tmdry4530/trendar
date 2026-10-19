import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  risingMinRate, risingMinGrowth, risingAbsPass, searchIntervalMs,
  publicImageRateLimitPerMin, publicAnalyticsFlushMs, trustProxyHops, publicRisingConfig,
} from '../src/utils/limits.js';

const CASES = [
  ['RISING_MIN_RATE', risingMinRate, 100],
  ['RISING_MIN_GROWTH', risingMinGrowth, 0.10],
  ['RISING_ABS_PASS', risingAbsPass, 500],
  ['ETL_SEARCH_INTERVAL_MS', searchIntervalMs, 2100],
  ['PUBLIC_IMAGE_RATE_LIMIT_PER_MIN', publicImageRateLimitPerMin, 120],
  ['PUBLIC_ANALYTICS_FLUSH_MS', publicAnalyticsFlushMs, 60000],
];
const KEYS = [...CASES.map(([key]) => key), 'TRUST_PROXY_HOPS', 'RISING_WINDOW_DAYS'];
const original = new Map(KEYS.map((key) => [key, process.env[key]]));
after(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

for (const [key, getLimit, fallback] of CASES) {
  test(`${key}는 미설정·잘못된 값·0 대신 기본값을 사용한다`, () => {
    for (const value of [undefined, '', 'abc', '-1', '0', 'Infinity', 'NaN']) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      assert.equal(getLimit(), fallback, `${key}=${value}`);
    }
    if (key !== 'ETL_SEARCH_INTERVAL_MS') {
      process.env[key] = '123';
      assert.equal(getLimit(), 123);
    }
    if (key !== 'RISING_MIN_GROWTH') {
      process.env[key] = '1.5';
      assert.equal(getLimit(), fallback);
    }
    delete process.env[key];
  });
}

test('RISING_MIN_GROWTH는 양의 유한 소수를 허용한다', () => {
  process.env.RISING_MIN_GROWTH = '0.25';
  assert.equal(risingMinGrowth(), 0.25);
  delete process.env.RISING_MIN_GROWTH;
});

test('ETL_SEARCH_INTERVAL_MS는 2100ms 미만이면 2100ms로 올리고 그 이상은 그대로 쓴다', () => {
  for (const value of ['1', '123', '2099']) {
    process.env.ETL_SEARCH_INTERVAL_MS = value;
    assert.equal(searchIntervalMs(), 2100, `ETL_SEARCH_INTERVAL_MS=${value}`);
  }
  for (const value of ['2100', '2101', '5000']) {
    process.env.ETL_SEARCH_INTERVAL_MS = value;
    assert.equal(searchIntervalMs(), Number(value));
  }
  delete process.env.ETL_SEARCH_INTERVAL_MS;
});

test('TRUST_PROXY_HOPS는 0을 허용하고 잘못된 설정은 1이다', () => {
  for (const value of [undefined, '', ' ', 'abc', '-1', '1.5', 'Infinity']) {
    if (value === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = value;
    assert.equal(trustProxyHops(), 1, `TRUST_PROXY_HOPS=${value}`);
  }
  process.env.TRUST_PROXY_HOPS = '0';
  assert.equal(trustProxyHops(), 0);
  process.env.TRUST_PROXY_HOPS = '2';
  assert.equal(trustProxyHops(), 2);
  delete process.env.TRUST_PROXY_HOPS;
});

test('publicRisingConfig는 기본 계약과 런타임 환경설정을 반환한다', () => {
  for (const key of KEYS) delete process.env[key];
  assert.deepEqual(publicRisingConfig(), {
    windowDays: 15, freshHours: 13, minRate: 100, minGrowth: 0.1, absPass: 500, limit: 50,
  });
  process.env.RISING_WINDOW_DAYS = '21';
  process.env.RISING_MIN_RATE = '200';
  process.env.RISING_MIN_GROWTH = '0.25';
  process.env.RISING_ABS_PASS = '700';
  assert.deepEqual(publicRisingConfig(), {
    windowDays: 21, freshHours: 13, minRate: 200, minGrowth: 0.25, absPass: 700, limit: 50,
  });
});
