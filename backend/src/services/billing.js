// @ts-check
// services/billing.js — 요금제 판정 + 요금제별 한도.
// plan은 users.plan 컬럼이 아니라 구독 상태를 기준으로 계산한다 (웹훅이 최신 상태 반영).
import { findByUserId } from '../models/subscription.model.js';
import { maxManualEtlPerDay, maxQueriesPerUser } from '../utils/limits.js';

const PRO_ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

// 구독 레코드가 존재하고 해지 완료(canceled)가 아니면 계정 삭제를 차단한다(fail-closed).
// active·trialing·past_due·paused 및 알 수 없는 상태 모두 Paddle 고객·구독 식별자를 보존해야 한다.
export function hasBlockingSubscription(sub) {
  return Boolean(sub && sub.status !== 'canceled');
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

// 플랜과 무관한 공통 한도.
export function currentLimits() {
  return {
    manualEtlPerDay: maxManualEtlPerDay(),
    queriesPerUser: maxQueriesPerUser(),
  };
}
