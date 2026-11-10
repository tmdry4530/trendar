// /api/webhook HTTP 계약: 인증·사용자 격리·검증·비밀 비노출 (DB·외부 네트워크 불필요).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createRequireAuth } from '../src/middleware/requireAuth.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { createWebhookController } from '../src/controllers/webhook.controller.js';
import { createWebhookRouter, noStore } from '../src/routes/webhook.routes.js';
import { hashSessionToken } from '../src/utils/crypto.js';
import { resolveTarget } from '../src/utils/webhook-target.js';

const USERS = { alice: { id: 1, login: 'alice' }, bob: { id: 2, login: 'bob' } };
const DNS = { 'hooks.example.com': ['93.184.216.34'], 'intranet.example.com': ['10.0.0.8'], 'discord.com': ['162.159.128.233'] };

function fixture({ allowPrivate = false, claimedElsewhere = false } = {}) {
  const state = { endpoints: new Map(), deliveries: [], seeded: [], cancelled: [], dispatched: [], clock: new Date('2026-11-10T00:00:00Z'), secrets: 0 };
  const model = {
    getEndpoint: async (userId) => (state.endpoints.has(userId) ? { ...state.endpoints.get(userId) } : null),
    createEndpoint: async (userId, row) => {
      if (state.endpoints.has(userId)) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
      state.endpoints.set(userId, {
        user_id: userId, ...row, enabled: true, auto_disabled: false, consecutive_failures: 0, created_at: state.clock, updated_at: state.clock,
      });
    },
    updateEndpointUrl: async (userId, row) => {
      Object.assign(state.endpoints.get(userId), row, { enabled: true, auto_disabled: false, consecutive_failures: 0, updated_at: state.clock });
      return true;
    },
    setEnabled: async (userId, enabled) => {
      Object.assign(state.endpoints.get(userId), enabled ? { enabled: true, auto_disabled: false, consecutive_failures: 0 } : { enabled: false });
      return true;
    },
    setSecret: async (userId, secretEnc) => { state.endpoints.get(userId).secret_enc = secretEnc; return true; },
    deleteEndpoint: async (userId) => {
      state.deliveries = state.deliveries.filter((row) => row.user_id !== userId);
      return state.endpoints.delete(userId);
    },
    cancelPending: async (userId) => { state.cancelled.push(userId); return 0; },
    insertDelivery: async (row) => {
      state.deliveries.push({ ...row, status: 'pending', attempts: 0, last_status_code: null, last_error_code: null, completed_at: null });
    },
    listDeliveries: async (userId, limit) => state.deliveries.filter((row) => row.user_id === userId).slice(-limit).reverse(),
  };
  const handlers = createWebhookController({
    model,
    seedSeen: async (userId) => { state.seeded.push(userId); return 0; },
    dispatcher: {
      dispatchOne: async (deliveryId) => {
        state.dispatched.push(deliveryId);
        // 분 단위 발신이 먼저 집은 경우: 여기서는 아무것도 하지 않고, 그쪽이 잠시 뒤 끝낸다.
        if (claimedElsewhere) return null;
        Object.assign(state.deliveries.find((row) => row.delivery_id === deliveryId), {
          status: 'success', attempts: 1, last_status_code: 204, completed_at: state.clock,
        });
        return { status: 'success' };
      },
    },
    encrypt: (plain) => `enc(${Buffer.from(plain).toString('base64')})`,
    resolveTarget: (url, options) => resolveTarget(url, {
      ...options,
      lookup: async (host) => {
        if (!DNS[host]) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
        return DNS[host].map((address) => ({ address, family: 4 }));
      },
    }),
    allowPrivate: () => allowPrivate,
    now: () => state.clock,
    newId: () => `00000000-0000-4000-8000-${String(state.deliveries.length + 1).padStart(12, '0')}`,
    newSecret: () => String(++state.secrets).repeat(64).slice(0, 64),
    sleep: async () => {
      state.sleeps = (state.sleeps ?? 0) + 1;
      if (state.sleeps === 3) Object.assign(state.deliveries.at(-1), { status: 'success', attempts: 1, last_status_code: 204, completed_at: state.clock });
    },
  });
  const authenticate = createRequireAuth({
    findValidByHash: async (hash) => {
      for (const [name, user] of Object.entries(USERS)) if (hash === hashSessionToken(name)) return { user };
      return null;
    },
  });
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/webhook', noStore, authenticate, createWebhookRouter(handlers));
  app.use(errorHandler);
  return { app, state };
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const call = async (who, method, path = '', body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/webhook${path}`, {
      method,
      headers: { ...(who ? { Cookie: `sid=${who}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, headers: res.headers, json: await res.json() };
  };
  try {
    await run(call);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test('비로그인 요청은 모든 연산에서 401이고 처리기에 닿지 않는다', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { app, state } = fixture();
  await withServer(app, async (call) => {
    for (const [method, path, body] of [
      ['GET', ''], ['PUT', '', { url: 'https://hooks.example.com/in' }], ['PATCH', '', { enabled: false }],
      ['POST', '/secret'], ['POST', '/test'], ['DELETE', ''],
    ]) {
      const res = await call(null, method, path, body);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.json.error.code, 'UNAUTHORIZED');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.equal(state.endpoints.size, 0);
  });
});

test('등록: 서명 키는 등록 응답에서만 한 번 나오고, 저장·조회에는 전체 URL과 키가 남지 않는다', async () => {
  const { app, state } = fixture();
  await withServer(app, async (call) => {
    const empty = await call('alice', 'GET');
    assert.deepEqual(empty.json, { ok: true, data: { endpoint: null, deliveries: [] } });
    assert.equal(empty.headers.get('cache-control'), 'no-store');

    const created = await call('alice', 'PUT', '', { url: 'https://hooks.example.com/in/secret-path-token' });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.equal(created.json.data.secret, '1'.repeat(64));
    assert.deepEqual(created.json.data.endpoint, {
      url_hint: 'https://hooks.example.com/…oken', format: 'generic', enabled: true, auto_disabled: false,
      created_at: '2026-11-10T00:00:00.000Z', updated_at: '2026-11-10T00:00:00.000Z',
    });
    // 등록 시점의 급상승 목록을 보낸 것으로 기록한다(R2.4).
    assert.deepEqual(state.seeded, [1]);
    const stored = state.endpoints.get(1);
    assert.match(stored.url_enc, /^enc\(/);
    assert.match(stored.secret_enc, /^enc\(/);
    assert.doesNotMatch(JSON.stringify(stored), /secret-path-token|1{64}/);

    const shown = await call('alice', 'GET');
    assert.deepEqual(Object.keys(shown.json.data), ['endpoint', 'deliveries']);
    assert.doesNotMatch(JSON.stringify(shown.json), /secret-path-token|1{64}|url_enc|secret_enc|enc\(/);

    // URL만 바꾸면 서명 키는 그대로이고 응답에 키가 없다.
    const replaced = await call('alice', 'PUT', '', { url: 'https://discord.com/api/webhooks/123/tokenXYZ9' });
    assert.equal(replaced.status, 200);
    assert.deepEqual(Object.keys(replaced.json.data), ['endpoint']);
    assert.equal(replaced.json.data.endpoint.format, 'discord');
    assert.equal(replaced.json.data.endpoint.url_hint, 'https://discord.com/…XYZ9');
    assert.equal(state.endpoints.get(1).secret_enc, stored.secret_enc);
    assert.deepEqual(state.seeded, [1], '켜진 상태에서 URL만 바꾸면 기준선을 다시 기록하지 않는다');
  });
});

test('잘못된 URL·사설 주소·풀리지 않는 이름은 400으로 거부하고 저장하지 않는다', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { app, state } = fixture();
  await withServer(app, async (call) => {
    for (const [url, code] of [
      [42, 'VALIDATION_ERROR'], ['', 'VALIDATION_ERROR'], [`https://hooks.example.com/${'a'.repeat(2048)}`, 'VALIDATION_ERROR'],
      ['http://hooks.example.com/in', 'WEBHOOK_URL_INVALID'], ['https://user:pw@hooks.example.com/in', 'WEBHOOK_URL_INVALID'],
      ['not a url', 'WEBHOOK_URL_INVALID'], ['https://no-such-host.example.com/in', 'WEBHOOK_URL_INVALID'],
      ['https://127.0.0.1/in', 'WEBHOOK_URL_BLOCKED'], ['https://169.254.169.254/latest/meta-data', 'WEBHOOK_URL_BLOCKED'],
      ['https://[::1]/in', 'WEBHOOK_URL_BLOCKED'], ['https://intranet.example.com/in', 'WEBHOOK_URL_BLOCKED'],
    ]) {
      const res = await call('alice', 'PUT', '', { url });
      assert.equal(res.status, 400, String(url).slice(0, 40));
      assert.equal(res.json.error.code, code, String(url).slice(0, 40));
    }
    assert.equal((await call('alice', 'PUT', '')).status, 400);
    assert.equal(state.endpoints.size, 0);
    assert.deepEqual(state.seeded, []);
  });
});

test('로컬 검증용 허용이 켜진 환경에서만 http·루프백 주소를 받는다', async () => {
  const { app } = fixture({ allowPrivate: true });
  await withServer(app, async (call) => {
    const res = await call('alice', 'PUT', '', { url: 'http://127.0.0.1:9911/hook' });
    assert.equal(res.status, 201);
    assert.equal(res.json.data.endpoint.url_hint, 'http://127.0.0.1:9911/…');
  });
});

test('끄면 대기 중인 발신을 취소하고, 다시 켜거나 꺼진 상태에서 URL을 바꾸면 그 시점 목록을 보낸 것으로 기록한다', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { app, state } = fixture();
  await withServer(app, async (call) => {
    assert.equal((await call('alice', 'PATCH', '', { enabled: false })).status, 404);
    await call('alice', 'PUT', '', { url: 'https://hooks.example.com/in' });
    Object.assign(state.endpoints.get(1), { auto_disabled: true, enabled: false, consecutive_failures: 3 });

    const on = await call('alice', 'PATCH', '', { enabled: true });
    assert.equal(on.status, 200);
    assert.deepEqual([on.json.data.endpoint.enabled, on.json.data.endpoint.auto_disabled], [true, false]);
    assert.deepEqual(state.seeded, [1, 1]);
    assert.equal(state.endpoints.get(1).consecutive_failures, 0);

    // 이미 켜져 있으면 다시 기록하지 않는다.
    await call('alice', 'PATCH', '', { enabled: true });
    assert.deepEqual(state.seeded, [1, 1]);

    const off = await call('alice', 'PATCH', '', { enabled: false });
    assert.equal(off.json.data.endpoint.enabled, false);
    assert.deepEqual(state.cancelled, [1]);

    const moved = await call('alice', 'PUT', '', { url: 'https://hooks.example.com/other' });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.data.endpoint.enabled, true);
    assert.deepEqual(state.seeded, [1, 1, 1]);

    for (const body of [{ enabled: 'yes' }, {}, { enabled: 1 }]) {
      const res = await call('alice', 'PATCH', '', body);
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'VALIDATION_ERROR');
    }
  });
});

test('서명 키 재발급은 새 키를 그 응답에서만 돌려주고 저장된 키를 바꾼다', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { app, state } = fixture();
  await withServer(app, async (call) => {
    assert.equal((await call('alice', 'POST', '/secret')).status, 404);
    const created = await call('alice', 'PUT', '', { url: 'https://hooks.example.com/in' });
    const before = state.endpoints.get(1).secret_enc;
    const rotated = await call('alice', 'POST', '/secret');
    assert.equal(rotated.status, 200);
    assert.deepEqual(Object.keys(rotated.json.data), ['secret']);
    assert.notEqual(rotated.json.data.secret, created.json.data.secret);
    assert.notEqual(state.endpoints.get(1).secret_enc, before);
    assert.doesNotMatch(JSON.stringify((await call('alice', 'GET')).json), new RegExp(rotated.json.data.secret));
  });
});

test('테스트 발신은 ping 1회를 즉시 보내 결과를 돌려주고, 같은 사용자는 10초 안에 다시 요청할 수 없다', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { app, state } = fixture();
  await withServer(app, async (call) => {
    assert.equal((await call('alice', 'POST', '/test')).status, 404);
    await call('alice', 'PUT', '', { url: 'https://hooks.example.com/in' });
    await call('bob', 'PUT', '', { url: 'https://hooks.example.com/bob' });

    const first = await call('alice', 'POST', '/test');
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.data.delivery, {
      id: '00000000-0000-4000-8000-000000000001', event: 'ping', status: 'success', attempts: 1, status_code: 204, error_code: null,
      created_at: '2026-11-10T00:00:00.000Z', completed_at: '2026-11-10T00:00:00.000Z',
    });
    const row = state.deliveries[0];
    assert.deepEqual([row.user_id, row.event, row.max_attempts], [1, 'ping', 1]);
    assert.deepEqual(JSON.parse(row.payload), { id: row.delivery_id, event: 'ping', created_at: '2026-11-10T00:00:00.000Z', data: {} });
    assert.deepEqual(state.dispatched, [row.delivery_id]);

    state.clock = new Date(state.clock.getTime() + 9_999);
    const tooSoon = await call('alice', 'POST', '/test');
    assert.equal(tooSoon.status, 429);
    assert.equal(tooSoon.json.error.code, 'WEBHOOK_TEST_RATE_LIMITED');
    // 제한은 사용자별이다.
    assert.equal((await call('bob', 'POST', '/test')).status, 200);

    state.clock = new Date(state.clock.getTime() + 1);
    assert.equal((await call('alice', 'POST', '/test')).status, 200);
    assert.equal(state.deliveries.filter((item) => item.user_id === 1).length, 2);

    // 꺼진 상태에서도 테스트는 보낼 수 있다.
    await call('bob', 'PATCH', '', { enabled: false });
    state.clock = new Date(state.clock.getTime() + 10_000);
    assert.equal((await call('bob', 'POST', '/test')).status, 200);
  });
});

test('다른 사용자의 설정·발신 기록은 보이지 않고 바꿀 수 없다. 삭제는 자기 것만 지운다', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { app, state } = fixture();
  await withServer(app, async (call) => {
    await call('alice', 'PUT', '', { url: 'https://hooks.example.com/alice-token' });
    await call('alice', 'POST', '/test');

    assert.deepEqual((await call('bob', 'GET')).json.data, { endpoint: null, deliveries: [] });
    for (const [method, path, body] of [['PATCH', '', { enabled: false }], ['POST', '/secret'], ['POST', '/test'], ['DELETE', '']]) {
      assert.equal((await call('bob', method, path, body)).status, 404, `${method} ${path}`);
    }
    assert.equal(state.endpoints.get(1).enabled, true);
    assert.equal((await call('alice', 'GET')).json.data.deliveries.length, 1);

    await call('bob', 'PUT', '', { url: 'https://hooks.example.com/bob-token' });
    const removed = await call('alice', 'DELETE');
    assert.deepEqual(removed.json, { ok: true, data: { deleted: true } });
    assert.deepEqual((await call('alice', 'GET')).json.data, { endpoint: null, deliveries: [] });
    assert.equal(state.endpoints.has(2), true);
    assert.equal((await call('alice', 'DELETE')).status, 404);
  });
});

test('등록 요청이 겹쳐 먼저 만들어진 설정이 있으면 그 서명 키를 유지하고 URL만 바꾼다', async () => {
  const { app, state } = fixture();
  await withServer(app, async (call) => {
    const [a, b] = await Promise.all([
      call('alice', 'PUT', '', { url: 'https://hooks.example.com/one' }),
      call('alice', 'PUT', '', { url: 'https://hooks.example.com/two' }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(state.endpoints.size, 1);
    assert.equal([a, b].filter((res) => res.json.data.secret).length, 1);
  });
});

test('다른 발신 작업이 테스트 ping을 먼저 집으면 그 결과를 기다려 돌려준다', async () => {
  const { app, state } = fixture({ allowPrivate: true, claimedElsewhere: true });
  await withServer(app, async (call) => {
    assert.equal((await call('alice', 'PUT', '', { url: 'http://127.0.0.1:9911/hook' })).status, 201);
    const res = await call('alice', 'POST', '/test');
    assert.equal(res.status, 200);
    assert.deepEqual([res.json.data.delivery.status, res.json.data.delivery.status_code], ['success', 204]);
    assert.equal(state.sleeps, 3);
  });
});
