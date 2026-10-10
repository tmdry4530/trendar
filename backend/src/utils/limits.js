// utils/limits.js — 사용자당 watch query 상한
import { httpError } from '../middleware/errorHandler.js';

const DEFAULT_MAX_QUERIES_PER_USER = 10;
const DEFAULT_MAX_MANUAL_ETL_PER_DAY = 10;
const DEFAULT_TREND_WINDOW_DAYS = 90;
const DEFAULT_TREND_MIN_STARS = 50;
const DEFAULT_RISING_WINDOW_DAYS = 15;
const DEFAULT_RISING_MIN_DELTA = 500;
const DEFAULT_TREND_RANK_MIN_STARS = 50;
const DEFAULT_TREND_RANK_MIN_DELTA = 10;
const DEFAULT_TRACKED_REFRESH_DAYS = 14;

export function maxQueriesPerUser() {
  const raw = process.env.MAX_QUERIES_PER_USER;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_MAX_QUERIES_PER_USER;
  return parsed;
}

export function maxManualEtlPerDay() {
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

export function risingWindowDays() {
  const parsed = Number(process.env.RISING_WINDOW_DAYS);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_RISING_WINDOW_DAYS;
  return parsed;
}

export function risingMinDelta() {
  const parsed = Number(process.env.RISING_MIN_DELTA);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_RISING_MIN_DELTA;
  return parsed;
}

// 랭킹 v3 — '빠르게 성장 중' 노출 하한 (스타 수 / 24시간 증가량). 0 허용.
export function trendRankMinStars() {
  const parsed = Number(process.env.TREND_RANK_MIN_STARS);
  if (process.env.TREND_RANK_MIN_STARS === undefined || !Number.isInteger(parsed) || parsed < 0) return DEFAULT_TREND_RANK_MIN_STARS;
  return parsed;
}

export function trendRankMinDelta() {
  const parsed = Number(process.env.TREND_RANK_MIN_DELTA);
  if (process.env.TREND_RANK_MIN_DELTA === undefined || !Number.isInteger(parsed) || parsed < 0) return DEFAULT_TREND_RANK_MIN_DELTA;
  return parsed;
}

// 검색 top-N에서 빠진 추적 레포를 몇 일 동안 계속 갱신할지 (last_refreshed_at 기준).
export function trackedRefreshDays() {
  const parsed = Number(process.env.TRACKED_REFRESH_DAYS);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_TRACKED_REFRESH_DAYS;
  return parsed;
}

export function assertQueryLimit(currentCount) {
  const max = maxQueriesPerUser();
  if (currentCount >= max) {
    throw httpError(400, 'QUERY_LIMIT_EXCEEDED', `수집 조건은 사용자당 최대 ${max}개까지 등록할 수 있습니다.`);
  }
}
