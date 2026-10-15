// utils/limits.js — 사용자당 watch query 상한
import { httpError } from '../middleware/errorHandler.js';

const DEFAULT_MAX_QUERIES_PER_USER = 10;
const DEFAULT_MAX_MANUAL_ETL_PER_DAY = 10;
const DEFAULT_TREND_WINDOW_DAYS = 90;
const DEFAULT_TREND_MIN_STARS = 50;
const DEFAULT_RISING_WINDOW_DAYS = 15;
const DEFAULT_RISING_MIN_DELTA = 500;

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

export function assertQueryLimit(currentCount, plan = 'free') {
  const max = maxQueriesPerUser(plan);
  if (currentCount >= max) {
    throw httpError(400, 'QUERY_LIMIT_EXCEEDED', `수집 조건은 ${plan === 'pro' ? 'Pro ' : ''}사용자당 최대 ${max}개까지 등록할 수 있습니다.`);
  }
}
