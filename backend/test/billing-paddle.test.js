import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckoutTransaction, isPaddleConfigured, paddleEnv } from '../src/utils/paddle.js';

function setEnv(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('Paddle requires API key, price ID and public client token', (t) => {
  setEnv(t, { PADDLE_API_KEY: 'server-secret', PADDLE_PRICE_ID_PRO: 'pri_pro', PADDLE_CLIENT_TOKEN: 'test_client' });
  assert.equal(isPaddleConfigured(), true);
  for (const key of ['PADDLE_API_KEY', 'PADDLE_PRICE_ID_PRO', 'PADDLE_CLIENT_TOKEN']) {
    const value = process.env[key];
    delete process.env[key];
    assert.equal(isPaddleConfigured(), false, key);
    process.env[key] = value;
  }
});

for (const environment of ['sandbox', 'production']) {
  for (const customerId of [undefined, 'ctm_previous']) {
    test(`Paddle transaction: ${environment}, customer=${customerId ?? 'new'}, no checkout.url`, async (t) => {
      setEnv(t, { PADDLE_API_KEY: 'server-secret', PADDLE_PRICE_ID_PRO: 'pri_pro', PADDLE_ENV: environment });
      let request;
      t.mock.method(globalThis, 'fetch', async (url, options) => {
        request = { url, options };
        return { ok: true, json: async () => ({ data: { id: 'txn_created' } }) };
      });
      const result = await createCheckoutTransaction({ userId: 7, customerId });
      assert.equal(paddleEnv(), environment);
      assert.equal(request.url, `${environment === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com'}/transactions`);
      assert.equal(request.options.method, 'POST');
      assert.equal(request.options.headers.Authorization, 'Bearer server-secret');
      const body = JSON.parse(request.options.body);
      assert.deepEqual(body, {
        items: [{ price_id: 'pri_pro', quantity: 1 }],
        custom_data: { user_id: '7' },
        collection_mode: 'automatic',
        ...(customerId ? { customer_id: customerId } : {}),
      });
      assert.equal('checkout' in body, false);
      assert.deepEqual(result, { transactionId: 'txn_created' });
    });
  }
}

test('Paddle transaction rejects a missing transaction ID instead of returning a checkout URL', async (t) => {
  setEnv(t, { PADDLE_API_KEY: 'server-secret', PADDLE_PRICE_ID_PRO: 'pri_pro' });
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, json: async () => ({ data: { checkout: { url: 'https://buy.paddle.com/old' } } }),
  }));
  await assert.rejects(createCheckoutTransaction({ userId: 7 }), /transaction ID/);
});

test('Paddle errors log diagnostic code/detail without secrets or request body and throw a generic error', async (t) => {
  setEnv(t, {
    PADDLE_API_KEY: 'server-secret', PADDLE_PRICE_ID_PRO: 'pri_pro',
    PADDLE_WEBHOOK_SECRET: 'webhook-secret',
  });
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false, status: 400,
    json: async () => ({
      error: {
        code: 'transaction_default_checkout_url_not_set',
        detail: 'Default payment link is not set (server-secret, webhook-secret)',
        request_body: { custom_data: { user_id: 'private-user' } },
      },
    }),
  }));
  await assert.rejects(createCheckoutTransaction({ userId: 'private-user' }), {
    message: 'Paddle API request failed',
  });
  assert.deepEqual(logs, [['[paddle] API request failed', {
    status: 400,
    code: 'transaction_default_checkout_url_not_set',
    detail: 'Default payment link is not set ([redacted], [redacted])',
  }]]);
  assert.doesNotMatch(JSON.stringify(logs), /server-secret|webhook-secret|private-user|request_body|Authorization/);
});
