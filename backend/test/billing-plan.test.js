// test/billing-plan.test.js — 요금제 판정 로직 (DB 불필요, 순수 함수).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planForSubscription, limitsForPlan } from '../src/services/billing.js';

test('구독 없으면 free', () => {
  assert.equal(planForSubscription(null), 'free');
});

test('active/trialing/past_due면 pro', () => {
  for (const status of ['active', 'trialing', 'past_due']) {
    assert.equal(planForSubscription({ status }), 'pro', status);
  }
});

test('canceled여도 기간 종료 전이면 pro', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  assert.equal(planForSubscription({ status: 'canceled', current_period_end: future }), 'pro');
});

test('canceled + 기간 종료 후면 free', () => {
  const past = new Date(Date.now() - 86400000).toISOString();
  assert.equal(planForSubscription({ status: 'canceled', current_period_end: past }), 'free');
});

test('paused면 free', () => {
  assert.equal(planForSubscription({ status: 'paused' }), 'free');
});

test('한도: free=10/10, pro=100/50 (기본값)', () => {
  delete process.env.PRO_MAX_MANUAL_ETL_PER_DAY;
  delete process.env.PRO_MAX_QUERIES_PER_USER;
  delete process.env.MAX_MANUAL_ETL_PER_DAY;
  delete process.env.MAX_QUERIES_PER_USER;
  assert.deepEqual(limitsForPlan('free'), { manualEtlPerDay: 10, queriesPerUser: 10 });
  assert.deepEqual(limitsForPlan('pro'), { manualEtlPerDay: 100, queriesPerUser: 50 });
});

test('한도: env로 재정의 가능', () => {
  process.env.PRO_MAX_MANUAL_ETL_PER_DAY = '200';
  assert.equal(limitsForPlan('pro').manualEtlPerDay, 200);
  delete process.env.PRO_MAX_MANUAL_ETL_PER_DAY;
});
