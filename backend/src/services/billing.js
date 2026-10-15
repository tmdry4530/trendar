// services/billing.js — 요금제 판정 + 요금제별 한도.
// plan은 users.plan 컬럼이 아니라 구독 상태를 기준으로 계산한다 (웹훅이 최신 상태 반영).
import { findByUserId } from '../models/subscription.model.js';

const PRO_ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

function intEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// 구독 레코드로부터 유효 요금제를 계산한다.
// canceled여도 current_period_end가 미래면 기간 끝까지 Pro 유지 (Paddle 정책과 동일).
export function planForSubscription(sub, now = new Date()) {
  if (!sub) return 'free';
  if (PRO_ACTIVE_STATUSES.has(sub.status)) return 'pro';
  if (sub.status === 'canceled' && sub.current_period_end) {
    const end = sub.current_period_end instanceof Date
      ? sub.current_period_end
      : new Date(sub.current_period_end);
    if (end > now) return 'pro';
  }
  return 'free';
}

export async function effectivePlan(userId) {
  const sub = await findByUserId(userId);
  return planForSubscription(sub);
}

// users.plan 컬럼은 표시용 캐시. 웹훅 처리 시 갱신한다.
export function planOfRow(row) {
  return row?.plan === 'pro' ? 'pro' : 'free';
}

export function limitsForPlan(plan) {
  if (plan === 'pro') {
    return {
      manualEtlPerDay: intEnv('PRO_MAX_MANUAL_ETL_PER_DAY', 100),
      queriesPerUser: intEnv('PRO_MAX_QUERIES_PER_USER', 50),
    };
  }
  return {
    manualEtlPerDay: intEnv('MAX_MANUAL_ETL_PER_DAY', 10),
    queriesPerUser: intEnv('MAX_QUERIES_PER_USER', 10),
  };
}
