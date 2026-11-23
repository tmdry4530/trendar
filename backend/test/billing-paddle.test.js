import test from 'node:test';
import assert from 'node:assert/strict';
import * as paddle from '../src/utils/paddle.js';

function setEnv(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

for (const environment of ['sandbox', 'production']) {
  test(`Paddle portal session: ${environment} endpoint, bearer key`, async (t) => {
    setEnv(t, { PADDLE_API_KEY: 'server-secret', PADDLE_ENV: environment });
    let request;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ data: { urls: { general: { overview: 'https://customer-portal.paddle.com/s' } } } }) };
    });
    const result = await paddle.createCustomerPortalSession('ctm_1');
    assert.equal(request.url, `${environment === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com'}/customers/ctm_1/portal-sessions`);
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.Authorization, 'Bearer server-secret');
    assert.deepEqual(result, { portalUrl: 'https://customer-portal.paddle.com/s' });
  });
}

test('Paddle portal rejects a response without a portal URL', async (t) => {
  setEnv(t, { PADDLE_API_KEY: 'server-secret' });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ data: {} }) }));
  await assert.rejects(paddle.createCustomerPortalSession('ctm_1'), /portal URL/);
});

test('Paddle errors log diagnostic code/detail without secrets and throw a generic error', async (t) => {
  setEnv(t, { PADDLE_API_KEY: 'server-secret', PADDLE_WEBHOOK_SECRET: 'webhook-secret' });
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false, status: 400,
    json: async () => ({
      error: {
        code: 'some_error',
        detail: 'Failure (server-secret, webhook-secret)',
        request_body: { custom_data: { user_id: 'private-user' } },
      },
    }),
  }));
  await assert.rejects(paddle.createCustomerPortalSession('ctm_1'), {
    message: 'Paddle API request failed',
  });
  assert.deepEqual(logs, [['[paddle] API request failed', {
    status: 400,
    code: 'some_error',
    detail: 'Failure ([redacted], [redacted])',
  }]]);
  assert.doesNotMatch(JSON.stringify(logs), /server-secret|webhook-secret|private-user|request_body|Authorization/);
});
