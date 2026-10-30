// @ts-check
// utils/limits.js — 사용자당 watch query 상한
import { httpError } from '../middleware/errorHandler.js';

const DEFAULT_MAX_QUERIES_PER_USER = 10;
const DEFAULT_MAX_MANUAL_ETL_PER_DAY = 10;
const DEFAULT_TREND_WINDOW_DAYS = 90;
const DEFAULT_TREND_MIN_STARS = 50;
const DEFAULT_RISING_WINDOW_DAYS = 15;
const DEFAULT_FRESH_WINDOW_DAYS = 7;
const DEFAULT_FRESH_MIN_STARS = 20;
const DEFAULT_RISING_MIN_RATE = 100;
const DEFAULT_RISING_MIN_GROWTH = 0.10;
const DEFAULT_RISING_ABS_PASS = 500;
const DEFAULT_SEARCH_INTERVAL_MS = 2100;
// GitHub Search API 30회/분 한도(R2.4): 설정값이 더 작아도 이 간격 미만으로는 호출하지 않는다.
const MIN_SEARCH_INTERVAL_MS = 2100;
const DEFAULT_PUBLIC_IMAGE_RATE_LIMIT_PER_MIN = 120;
const DEFAULT_PUBLIC_ANALYTICS_FLUSH_MS = 60000;
const DEFAULT_TRUST_PROXY_HOPS = 1;

export function maxQueriesPerUser(plan = 'free') {
  if (plan === 'pro') {
    const parsed = Number(process.env.PRO_MAX_QUERIES_PER_USER);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
    return 50;
  }
  const raw = process.env.MAX_QUERIES_PER_USER;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_MAX_QUERIES_PER_USER;
  return parsed;
}

export function maxManualEtlPerDay(plan = 'free') {
  if (plan === 'pro') {
    const parsed = Number(process.env.PRO_MAX_MANUAL_ETL_PER_DAY);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
    return 100;
  }
  const parsed = Number(process.env.MAX_MANUAL_ETL_PER_DAY);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_MAX_MANUAL_ETL_PER_DAY;
  return parsed;
}

export function trendWindowDays() {
  const parsed = Number(process.env.ETL_TREND_WINDOW_DAYS);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_TREND_WINDOW_DAYS;
  return parsed;
}

export function trendMinStars() {
  const parsed = Number(process.env.ETL_TREND_MIN_STARS);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_TREND_MIN_STARS;
  return parsed;
}

// 초신생(fresh) 슬라이스 — created:>N일. 90일 trend 슬라이스는 스타순 상위 100개라
// 커트라인이 수천 스타까지 올라가므로, 갓 생긴 레포를 일찍 잡기 위해 좁은 창을 따로 검색한다.
export function freshWindowDays() {
  const parsed = Number(process.env.ETL_FRESH_WINDOW_DAYS);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_FRESH_WINDOW_DAYS;
  return parsed;
}

export function freshMinStars() {
  const parsed = Number(process.env.ETL_FRESH_MIN_STARS);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_FRESH_MIN_STARS;
  return parsed;
}

export function risingWindowDays() {
  const parsed = Number(process.env.RISING_WINDOW_DAYS);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_RISING_WINDOW_DAYS;
  return parsed;
}

export function risingMinRate() {
  const parsed = Number(process.env.RISING_MIN_RATE);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_RISING_MIN_RATE;
  return parsed;
}

export function risingMinGrowth() {
  const parsed = Number(process.env.RISING_MIN_GROWTH);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RISING_MIN_GROWTH;
  return parsed;
}

export function risingAbsPass() {
  const parsed = Number(process.env.RISING_ABS_PASS);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_RISING_ABS_PASS;
  return parsed;
}

export function searchIntervalMs() {
  const parsed = Number(process.env.ETL_SEARCH_INTERVAL_MS);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_SEARCH_INTERVAL_MS;
  return Math.max(parsed, MIN_SEARCH_INTERVAL_MS);
}

export function publicImageRateLimitPerMin() {
  const parsed = Number(process.env.PUBLIC_IMAGE_RATE_LIMIT_PER_MIN);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_PUBLIC_IMAGE_RATE_LIMIT_PER_MIN;
  return parsed;
}

export function publicAnalyticsFlushMs() {
  const parsed = Number(process.env.PUBLIC_ANALYTICS_FLUSH_MS);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_PUBLIC_ANALYTICS_FLUSH_MS;
  return parsed;
}

export function trustProxyHops() {
  const raw = process.env.TRUST_PROXY_HOPS;
  const parsed = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_TRUST_PROXY_HOPS;
  }
  return parsed;
}

export function publicRisingConfig() {
  return {
    windowDays: risingWindowDays(),
    freshHours: 13,
    minRate: risingMinRate(),
    minGrowth: risingMinGrowth(),
    absPass: risingAbsPass(),
    limit: 50,
  };
}

export function assertQueryLimit(currentCount, plan = 'free') {
  const max = maxQueriesPerUser(plan);
  if (currentCount >= max) {
    throw httpError(400, 'QUERY_LIMIT_EXCEEDED', `수집 조건은 ${plan === 'pro' ? 'Pro ' : ''}사용자당 최대 ${max}개까지 등록할 수 있습니다.`);
  }
}
