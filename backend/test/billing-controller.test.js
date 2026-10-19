import test from 'node:test';
import assert from 'node:assert/strict';
import { createBillingController } from '../src/controllers/billing.controller.js';
import { createEtlController } from '../src/controllers/etl.controller.js';
import { manualUsageFromRow } from '../src/models/user.model.js';
import { limitsForPlan } from '../src/services/billing.js';
import { assertQueryLimit, maxQueriesPerUser, maxManualEtlPerDay } from '../src/utils/limits.js';
import { kstToday, kstNextMidnight } from '../src/utils/kst.js';
import * as paddle from '../src/utils/paddle.js';

const NOW = new Date('2026-10-19T15:30:00Z');
const req = { user: { id: 7 }, body: { user_id: 99, customer_id: 'attacker' } };
const queryRows = [{ id: 1, is_active: true }, { id: 2, is_active: false }];
const usageRow = { manual_etl_date: '2026-10-20', manual_etl_count: 3, access_token_enc: 'secret-github' };

function mockRes() {
  return { body: null, json(body) { this.body = body; return this; } };
}

function failNext(error) { throw error; }

function deps(sub = null, options = {}) {
  return {
    subscriptions: { findByUserId: async (id) => { assert.equal(id, 7); return sub; } },
    queries: { findAll: async (id) => { assert.equal(id, 7); return queryRows; } },
    users: { findById: async (id) => { assert.equal(id, 7); return options.row ?? usageRow; }, manualUsageFromRow },
    paddle: {
      isPaddleConfigured: () => options.configured ?? true,
      paddleClientToken: () => 'test_public_client',
      paddleEnv: () => 'sandbox',
      createCheckoutTransaction: options.createCheckoutTransaction ?? (async () => { throw new Error('unexpected checkout'); }),
      createCustomerPortalSession: options.createCustomerPortalSession ?? (async () => { throw new Error('unexpected portal'); }),
    },
    clock: () => NOW,
  };
}

for (const [status, end, plan] of [
  [null, null, 'free'],
  ['active', '2026-11-20T00:00:00Z', 'pro'],
  ['trialing', '2026-11-20T00:00:00Z', 'pro'],
  ['canceled', '2026-11-20T00:00:00Z', 'pro'],
  ['past_due', null, 'pro'],
  ['canceled', '2026-10-01T00:00:00Z', 'free'],
  ['paused', null, 'free'],
]) {
  test(`billing me: ${status ?? 'no subscription'} ${end ?? ''} → ${plan}, enforcement usage`, async () => {
    const sub = status ? {
      status, current_period_end: end, price_id: 'pri_pro', paddle_customer_id: 'ctm_private',
      paddle_subscription_id: 'sub_private', secret: 'secret-subscription',
    } : null;
    const injected = deps(sub);
    const ctrl = createBillingController(injected);
    const res = mockRes();
    await ctrl.billingMe(req, res, failNext);
    const data = res.body.data;
    assert.equal(res.body.ok, true);
    assert.equal(data.plan, plan);
    assert.deepEqual(data.subscription, sub ? {
      status, current_period_end: end, price_id: 'pri_pro', has_customer: true,
    } : null);
    assert.deepEqual(data.client, { token: 'test_public_client', environment: 'sandbox' });
    assert.equal(data.configured, true);
    assert.deepEqual(data.limits, { free: limitsForPlan('free'), pro: limitsForPlan('pro') });
    assert.deepEqual(data.usage, {
      queries_used: queryRows.length,
      queries_limit: maxQueriesPerUser(plan),
      manual_used_today: manualUsageFromRow(usageRow, kstToday(NOW)),
      manual_limit: maxManualEtlPerDay(plan),
      manual_reset_at: kstNextMidnight(NOW).toISOString(),
    });
    assert.doesNotThrow(() => assertQueryLimit(data.usage.queries_limit - 1, plan));
    assert.throws(() => assertQueryLimit(data.usage.queries_limit, plan), { code: 'QUERY_LIMIT_EXCEEDED' });
    const etl = createEtlController({
      users: injected.users, clock: injected.clock, limit: maxManualEtlPerDay,
      plan: async () => plan, pipeline: { isRunning: () => false },
    });
    const statusRes = mockRes();
    await etl.status(req, statusRes, failNext);
    for (const key of ['manual_used_today', 'manual_limit', 'manual_reset_at']) {
      assert.equal(data.usage[key], statusRes.body.data[key], key);
    }
    assert.doesNotMatch(JSON.stringify(res.body), /ctm_private|sub_private|secret-subscription|secret-github/);
  });
}

test('billing me: unconfigured hides client, missing customer is false, old KST usage resets', async () => {
  const ctrl = createBillingController(deps({ status: 'paused' }, {
    configured: false, row: { manual_etl_date: '2026-10-19', manual_etl_count: 20 },
  }));
  const res = mockRes();
  await ctrl.billingMe(req, res, failNext);
  assert.equal(res.body.data.configured, false);
  assert.equal(res.body.data.client, null);
  assert.deepEqual(res.body.data.subscription, {
    status: 'paused', current_period_end: null, price_id: null, has_customer: false,
  });
  assert.equal(res.body.data.usage.manual_used_today, 0);
  assert.equal(res.body.data.usage.manual_reset_at, '2026-10-20T15:00:00.000Z');
});

test('billing me never serializes server Paddle secrets', async (t) => {
  const values = { PADDLE_API_KEY: 'secret-api-key', PADDLE_PRICE_ID_PRO: 'pri_pro', PADDLE_CLIENT_TOKEN: 'test_public', PADDLE_WEBHOOK_SECRET: 'secret-webhook' };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    process.env[key] = value;
  }
  const ctrl = createBillingController({ ...deps(), paddle });
  const res = mockRes();
  await ctrl.billingMe(req, res, failNext);
  assert.equal(res.body.data.client.token, 'test_public');
  assert.doesNotMatch(JSON.stringify(res.body), /secret-api-key|secret-webhook|PADDLE_API_KEY|PADDLE_WEBHOOK_SECRET/);
});

test('checkout: unconfigured → 503 before reading subscriptions', async () => {
  const injected = deps(null, { configured: false });
  injected.subscriptions.findByUserId = async () => { throw new Error('unexpected DB'); };
  const res = mockRes();
  let error;
  await createBillingController(injected).checkout(req, res, (e) => { error = e; });
  assert.equal(error.status, 503);
  assert.equal(error.code, 'BILLING_NOT_CONFIGURED');
  assert.equal(res.body, null);
});

for (const sub of [
  { status: 'active' }, { status: 'past_due' },
  { status: 'canceled', current_period_end: '2026-11-20T00:00:00Z' },
]) {
  test(`checkout: effective Pro (${sub.status}) → 409 without transaction`, async () => {
    let error;
    const res = mockRes();
    await createBillingController(deps(sub)).checkout(req, res, (e) => { error = e; });
    assert.equal(error.status, 409);
    assert.equal(error.code, 'ALREADY_PRO');
    assert.equal(res.body, null);
  });
}

for (const sub of [null, { status: 'canceled', current_period_end: '2026-10-01T00:00:00Z', paddle_customer_id: 'ctm_previous' }]) {
  test(`checkout: success ${sub ? 'reuses customer' : 'without customer'} and returns only transaction ID`, async () => {
    let received;
    const ctrl = createBillingController(deps(sub, {
      createCheckoutTransaction: async (args) => { received = args; return { transactionId: 'txn_created' }; },
    }));
    const res = mockRes();
    await ctrl.checkout(req, res, failNext);
    assert.deepEqual(received, { userId: 7, customerId: sub?.paddle_customer_id });
    assert.deepEqual(res.body, { ok: true, data: { transaction_id: 'txn_created' } });
  });
}

test('portal: missing customer → 404, existing customer → portal URL', async () => {
  let error;
  await createBillingController(deps()).portal(req, mockRes(), (e) => { error = e; });
  assert.equal(error.status, 404);
  assert.equal(error.code, 'NO_SUBSCRIPTION');
  const ctrl = createBillingController(deps({ paddle_customer_id: 'ctm_existing' }, {
    createCustomerPortalSession: async (id) => {
      assert.equal(id, 'ctm_existing');
      return { portalUrl: 'https://customer-portal.paddle.com/session' };
    },
  }));
  const res = mockRes();
  await ctrl.portal(req, res, failNext);
  assert.deepEqual(res.body, { ok: true, data: { portal_url: 'https://customer-portal.paddle.com/session' } });
});
