// @ts-check
// utils/limits.js — 사용자당 watch query 상한
import { httpError } from '../middleware/errorHandler.js';

const DEFAULT_MAX_QUERIES_PER_USER = 50;
const DEFAULT_MAX_MANUAL_ETL_PER_DAY = 100;
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
const DEFAULT_PUBLIC_PAGE_RATE_LIMIT_PER_MIN = 120;
const DEFAULT_PUBLIC_CACHE_MAX_PENDING = 100;
const DEFAULT_PUBLIC_ANALYTICS_FLUSH_MS = 60000;
const DEFAULT_TRUST_PROXY_HOPS = 1;

export const REPO_LIST_DEFAULT_LIMIT = 30;
export const REPO_LIST_MAX_LIMIT = 100;
export const REPO_LIST_MAX_OFFSET = 10000;
export const REPO_SEARCH_MAX_LENGTH = 200;
export const REPO_TRENDS_DEFAULT_LIMIT = 10;
export const REPO_BOOKMARKS_DEFAULT_LIMIT = 8;
export const REPO_RANK_MAX_LIMIT = 50;
export const SNAPSHOT_DEFAULT_LIMIT = 500;
export const SNAPSHOT_MAX_LIMIT = 1000;
export const SNAPSHOT_MAX_DAYS = 365;

// 모든 로그인 사용자 공통 한도. 기존 Pro 설정(PRO_MAX_*)만 따르고 낮은 구 무료 MAX_*는 쓰지 않는다.
export function maxQueriesPerUser() {
  const parsed = Number(process.env.PRO_MAX_QUERIES_PER_USER);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return DEFAULT_MAX_QUERIES_PER_USER;
}

export function maxManualEtlPerDay() {
  const parsed = Number(process.env.PRO_MAX_MANUAL_ETL_PER_DAY);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return DEFAULT_MAX_MANUAL_ETL_PER_DAY;
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

export function publicPageRateLimitPerMin() {
  const parsed = Number(process.env.PUBLIC_PAGE_RATE_LIMIT_PER_MIN);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_PUBLIC_PAGE_RATE_LIMIT_PER_MIN;
  return parsed;
}

export function publicCacheMaxPending() {
  const parsed = Number(process.env.PUBLIC_CACHE_MAX_PENDING);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_PUBLIC_CACHE_MAX_PENDING;
  return parsed;
}

/**
 * @param {unknown} raw
 * @param {{ defaultValue: number, min: number, max: number }} options
 * @returns {number}
 */
export function clampBoundedInt(raw, { defaultValue, min, max }) {
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  if (typeof raw === 'string' && raw.trim() === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  const truncated = Math.trunc(parsed);
  if (truncated < min) return min;
  if (truncated > max) return max;
  return truncated;
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parsePositiveIntParam(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === 'string' && /^[1-9]\d*$/.test(raw.trim())) {
    const parsed = Number(raw.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
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

export function assertQueryLimit(currentCount) {
  const max = maxQueriesPerUser();
  if (currentCount >= max) {
    throw httpError(400, 'QUERY_LIMIT_EXCEEDED', `수집 조건은 사용자당 최대 ${max}개까지 등록할 수 있습니다.`);
  }
}
