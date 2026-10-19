// test/paddle-webhook.test.js — 서명 검증 + 구독 교체·지연 이벤트 (DB·네트워크 불필요).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyWebhookSignature } from '../src/utils/paddle.js';
import { createBillingWebhook } from '../src/controllers/billing.controller.js';
import { upsertSubscription } from '../src/models/subscription.model.js';
import { pool } from '../src/config/db.js';

const SECRET = 'pdl_ntf_test_secret_123';


function header(ts, body, secret = SECRET) {
  const h1 = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${ts}:`, 'utf8'), Buffer.from(body, 'utf8')]))
    .digest('hex');
  return `ts=${ts};h1=${h1}`;
}

test('올바른 서명은 통과', () => {
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ event_id: 'evt_1', event_type: 'subscription.created' });
  assert.equal(verifyWebhookSignature(Buffer.from(body), header(ts, body), SECRET), true);
});

test('잘못된 secret 서명은 거부', () => {
  const ts = Math.floor(Date.now() / 1000);
  const body = '{"event_id":"evt_1"}';
  assert.equal(verifyWebhookSignature(Buffer.from(body), header(ts, body, 'wrong'), SECRET), false);
});

test('body가 변조되면 거부', () => {
  const ts = Math.floor(Date.now() / 1000);
  const body = '{"event_id":"evt_1"}';
  const tampered = '{"event_id":"evt_2"}';
  assert.equal(verifyWebhookSignature(Buffer.from(tampered), header(ts, body), SECRET), false);
});

test('5분 이상 오래된 ts는 리플레이로 거부', () => {
  const ts = Math.floor(Date.now() / 1000) - 301;
  const body = '{"event_id":"evt_1"}';
  assert.equal(verifyWebhookSignature(Buffer.from(body), header(ts, body), SECRET), false);
});

test('헤더 형식이 깨지면 거부', () => {
  assert.equal(verifyWebhookSignature(Buffer.from('{}'), 'garbage', SECRET), false);
  assert.equal(verifyWebhookSignature(Buffer.from('{}'), '', SECRET), false);
  assert.equal(verifyWebhookSignature(null, 'ts=1;h1=abc', SECRET), false);
});

function webhookFixture() {
  let row = null;
  let plan = 'free';
  let writes = 0;
  const processed = new Set();
  const subscriptions = {
    findByUserId: async (id) => { assert.equal(id, 7); return row; },
    findByPaddleSubscriptionId: async (id) => row?.paddle_subscription_id === id ? row : null,
    upsertSubscription: async (sub) => {
      writes += 1;
      row = {
        user_id: sub.userId,
        paddle_subscription_id: sub.paddleSubscriptionId,
        paddle_customer_id: sub.paddleCustomerId,
        status: sub.status,
        price_id: sub.priceId,
        current_period_end: sub.currentPeriodEnd,
      };
    },
    setUserPlan: async (id, value) => { assert.equal(id, 7); plan = value; },
    isEventProcessed: async (id) => processed.has(id),
    markEventProcessed: async (id) => { processed.add(id); },
  };
  const webhook = createBillingWebhook({ subscriptions, secret: () => SECRET });
  async function send(id, status, { eventId = `evt_${processed.size}`, customData = true, periodEnd } = {}) {
    const body = JSON.stringify({
      event_id: eventId,
      event_type: 'subscription.updated',
      data: {
        id, status, customer_id: 'ctm_existing', items: [{ price: { id: 'pri_pro' } }],
        ...(periodEnd === undefined ? {} : { current_billing_period: { ends_at: periodEnd } }),
        ...(customData ? { custom_data: { user_id: '7' } } : {}),
      },
    });
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await webhook({
      body: Buffer.from(body), headers: { 'paddle-signature': header(Math.floor(Date.now() / 1000), body) },
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    return res;
  }
  return { send, get row() { return row; }, get plan() { return plan; }, get writes() { return writes; }, processed };
}

for (const initial of ['canceled', 'paused']) {
  for (const replacement of ['active', 'trialing', 'past_due']) {
    test(`webhook: A ${initial} → B ${replacement}, stale A events ignored, same-id B still updates`, async () => {
      const fixture = webhookFixture();
      await fixture.send('sub_A', initial);
      assert.equal(fixture.writes, 1, 'first-ever subscription inserts even when inactive');
      assert.equal(fixture.row.paddle_subscription_id, 'sub_A');
      assert.equal(fixture.plan, 'free');
      await fixture.send('sub_B', replacement);
      assert.equal(fixture.row.paddle_subscription_id, 'sub_B');
      assert.equal(fixture.row.status, replacement);
      assert.equal(fixture.plan, 'pro');
      const writes = fixture.writes;
      for (const staleStatus of ['canceled', 'paused', 'unknown']) {
        await fixture.send('sub_A', staleStatus);
        assert.equal(fixture.writes, writes);
        assert.equal(fixture.row.paddle_subscription_id, 'sub_B');
        assert.equal(fixture.row.status, replacement);
        assert.equal(fixture.plan, 'pro');
      }
      await fixture.send('sub_B', 'past_due', { customData: false });
      assert.equal(fixture.row.status, 'past_due');
      assert.equal(fixture.plan, 'pro');
      await fixture.send('sub_B', 'paused');
      assert.equal(fixture.row.status, 'paused');
      assert.equal(fixture.plan, 'free');
      assert.equal(fixture.row.paddle_subscription_id, 'sub_B');
    });
  }
}

test('webhook: first active subscription inserts and duplicate event is not reapplied', async () => {
  const fixture = webhookFixture();
  await fixture.send('sub_first', 'active', { eventId: 'evt_first' });
  assert.equal(fixture.row.paddle_subscription_id, 'sub_first');
  assert.equal(fixture.row.paddle_customer_id, 'ctm_existing');
  assert.equal(fixture.row.price_id, 'pri_pro');
  assert.equal(fixture.plan, 'pro');
  const res = await fixture.send('sub_first', 'paused', { eventId: 'evt_first' });
  assert.equal(res.body.data.deduped, true);
  assert.equal(fixture.writes, 1);
  assert.equal(fixture.plan, 'pro');
});

test('subscription upsert replaces paddle_subscription_id on the existing user row', async (t) => {
  const calls = [];
  t.mock.method(pool, 'query', async (sql, values) => {
    calls.push({ sql, values });
    return [{ affectedRows: 1 }];
  });
  await upsertSubscription({
    userId: 7, paddleSubscriptionId: 'sub_B', paddleCustomerId: 'ctm_existing',
    status: 'active', priceId: 'pri_pro', currentPeriodEnd: null,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE\s+paddle_subscription_id = VALUES\(paddle_subscription_id\)/);
  assert.deepEqual(calls[0].values, [7, 'sub_B', 'ctm_existing', 'active', 'pri_pro', null]);
});

test('webhook converts Paddle RFC3339 microseconds to a valid Date before model upsert', async () => {
  const fixture = webhookFixture();
  await fixture.send('sub_dated', 'active', { periodEnd: '2026-11-19T10:00:00.000000Z' });
  assert.ok(fixture.row.current_period_end instanceof Date);
  assert.equal(fixture.row.current_period_end.toISOString(), '2026-11-19T10:00:00.000Z');
  assert.equal(fixture.plan, 'pro');
});

test('webhook passes null to model for invalid or missing billing period end', async () => {
  for (const periodEnd of ['not-a-date', '', null, undefined]) {
    const fixture = webhookFixture();
    await fixture.send('sub_undated', 'active', { periodEnd });
    assert.equal(fixture.row.current_period_end, null);
    assert.equal(fixture.plan, 'pro');
  }
});
