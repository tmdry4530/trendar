// utils/limits.js — 사용자당 watch query 상한
import { httpError } from '../middleware/errorHandler.js';

const DEFAULT_MAX_QUERIES_PER_USER = 10;
const DEFAULT_MAX_MANUAL_ETL_PER_DAY = 10;

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

export function assertQueryLimit(currentCount) {
  const max = maxQueriesPerUser();
  if (currentCount >= max) {
    throw httpError(400, 'QUERY_LIMIT_EXCEEDED', `조건은 사용자당 최대 ${max}개까지 등록할 수 있습니다.`);
  }
}
