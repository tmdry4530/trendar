import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { isAdmin } from '../src/config/admin.js';
import { createRequireAuth } from '../src/middleware/requireAuth.js';
import { createAdminRouter } from '../src/routes/admin.routes.js';
import { createAdminController } from '../src/controllers/admin.controller.js';
import { createAuthController } from '../src/controllers/auth.controller.js';
import { hashSessionToken } from '../src/utils/crypto.js';
import { createApp } from '../src/app.js';

const OWNER = { id: 1, github_id: 67108705, login: 'owner' };
const OTHER = { id: 2, github_id: 123, login: 'owner', isAdmin: true };
const FEEDS = [
  { kind: 'all', slug: 'all', name: { ko: '전체', en: 'All' } },
  { kind: 'topic', slug: 'llm', name: { ko: 'LLM', en: 'LLM' } },
];
const NOW = new Date('2026-11-05T00:00:00Z');

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run((path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options));
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

async function withAdmin(run, { data = {}, configured = '67108705' } = {}) {
  const previous = process.env.ADMIN_GITHUB_ID;
  if (configured == null) delete process.env.ADMIN_GITHUB_ID;
  else process.env.ADMIN_GITHUB_ID = configured;
  const calls = [];
  const handlers = createAdminController({
    model: {
      overview: async () => { calls.push('overview'); return data.overview; },
      listUsers: async (query) => { calls.push(query); return data.users ?? { items: [], total: 0 }; },
      listFeeds: async () => { calls.push('feeds'); return data.feeds ?? []; },
    },
    feeds: () => FEEDS,
    clock: () => NOW,
  });
  const authenticate = createRequireAuth({
    findValidByHash: async (hash) => {
      if (hash === hashSessionToken('owner')) return { user: OWNER };
      if (hash === hashSessionToken('other')) return { user: OTHER };
      return null;
    },
  });
  const app = express();
  app.use(cookieParser());
  app.use('/api/admin', createAdminRouter({ authenticate, handlers }));
  try { await withServer(app, (request) => run(request, calls)); }
  finally {
    if (previous === undefined) delete process.env.ADMIN_GITHUB_ID;
    else process.env.ADMIN_GITHUB_ID = previous;
  }
}

const ownerRequest = { headers: { cookie: 'sid=owner' } };

test('admin identity fails closed and compares canonical GitHub IDs, not login or client flags', () => {
  for (const configured of [undefined, '', '0', '-1', '+67108705', '67108705 ', '1e3', '67108705,123', '67108705\n', 67108705]) {
    assert.equal(isAdmin(OWNER, { ADMIN_GITHUB_ID: configured }), false, String(configured));
  }
  assert.equal(isAdmin(OWNER, { ADMIN_GITHUB_ID: '00067108705' }), true);
  assert.equal(isAdmin({ github_id: '00067108705' }, { ADMIN_GITHUB_ID: '67108705' }), true);
  assert.equal(isAdmin(OTHER, { ADMIN_GITHUB_ID: '67108705' }), false);
  assert.equal(isAdmin({ github_id: Number.MAX_SAFE_INTEGER + 1 }, { ADMIN_GITHUB_ID: '9007199254740992' }), false);
});

test('every path and method authorizes before dispatch, including HEAD and unknown routes', async () => {
  await withAdmin(async (request, calls) => {
    for (const path of ['/overview', '/users', '/feeds', '/unknown']) {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        for (const [cookie, status] of [['', 401], ['sid=expired', 401], ['sid=other', 403], ['sid=owner', method !== 'GET' ? 405 : path === '/unknown' ? 404 : null]]) {
          if (status === null) continue;
          const response = await request(`/api/admin${path}`, { method, headers: { cookie, 'x-is-admin': 'true' } });
          assert.equal(response.status, status, `${cookie} ${method} ${path}`);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          if (status === 405) assert.equal(response.headers.get('allow'), 'GET');
        }
      }
    }
    assert.deepEqual(calls, [], 'unauthorized and unsupported requests never query admin data');
  });
});

test('invalid server configuration denies a valid owner session', async () => {
  for (const configured of [null, '', '0', 'owner', '67108705,123']) {
    await withAdmin(async (request, calls) => {
      const response = await request('/api/admin/users', ownerRequest);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(calls, []);
    }, { configured });
  }
});

test('app boundary authenticates malformed POST bodies before parsing and always disables caching', async () => {
  await withServer(createApp(), async (request) => {
    const response = await request('/api/admin/unknown', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json',
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
  });
});

test('users query rejects duplicate, array, object and out-of-range parameters before DB calls', async () => {
  await withAdmin(async (request, calls) => {
    for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=1e2', 'page=100001', 'page=', 'page=1%0A', 'page=1&page=2', 'page[]=1', 'page[x]=1', 'search=a&search=b', 'search[]=a', 'search[x]=a', `search=${'a'.repeat(101)}`]) {
      const response = await request(`/api/admin/users?${query}`, ownerRequest);
      assert.equal(response.status, 400, query);
      assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
    }
    assert.deepEqual(calls, []);
    const response = await request(`/api/admin/users?search=${'a'.repeat(100)}&page=100000`, ownerRequest);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ search: 'a'.repeat(100), page: 100000 }]);
    assert.deepEqual((await response.json()).data, { items: [], total: 0, page: 100000, page_size: 25 });
  });
});

test('concurrent owner and ordinary sessions cannot share authorization or response state', async () => {
  await withAdmin(async (request, calls) => {
    const responses = await Promise.all([
      request('/api/admin/users', ownerRequest),
      request('/api/admin/users', { headers: { cookie: 'sid=other' } }),
      request('/api/admin/users?search=second', ownerRequest),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 403, 200]);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((query) => query.page === 1));
    for (const response of responses) assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('user response projects only safe fields, normalizes numbers/dates and distinguishes missing collection', async () => {
  const row = {
    id: '7', login: 'member', name: null, created_at: NOW, plan: 'pro',
    subscription_status: 'gho_secret', current_period_end: '2026-12-05 00:00:00',
    query_count: '2', repo_count: '3', last_etl_at: null, last_etl_status: null, token_invalid: 0,
    github_id: 999, access_token_enc: 'encrypted-secret', token_hash: 'session-secret',
    paddle_subscription_id: 'sub_secret', paddle_customer_id: 'ctm_secret', last_etl_message: 'Bearer secret',
  };
  await withAdmin(async (request) => {
    const response = await request('/api/admin/users', ownerRequest);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.items, [{
      id: 7, login: 'member', name: null, created_at: NOW.toISOString(), plan: 'pro',
      subscription_status: 'unknown', current_period_end: '2026-12-05T00:00:00.000Z',
      query_count: 2, repo_count: 3, last_etl_at: null, last_etl_status: null, token_invalid: false,
    }]);
    assert.doesNotMatch(JSON.stringify(body), /secret|github_id|paddle_|token_hash|last_etl_message/);
  }, { data: { users: { items: [row], total: '1' } } });
});

test('overview aggregates unknown subscription statuses without exposing raw values or dropping members', async () => {
  await withAdmin(async (request) => {
    const response = await request('/api/admin/overview', ownerRequest);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, {
      users: { total: 5, free: 3, pro: 2, etl_failed: 2, token_invalid: 1 },
      subscriptions: [{ status: 'none', count: 1 }, { status: 'active', count: 2 }, { status: 'unknown', count: 2 }],
      public_repos: 4, generated_at: NOW.toISOString(),
    });
  }, { data: { overview: {
    users: { total: '5', free: '3', pro: '2', etl_failed: '2', token_invalid: '1', access_token_enc: 'secret' },
    subscriptions: [{ status: null, count: '1' }, { status: 'active', count: '2' }, { status: 'gho_secret', count: '1' }, { status: 'sub_secret', count: '1' }],
    public_repos: '4',
  } } });
});

test('configured feeds include missing rows, exclude removed feeds, and expose only allowlisted error codes', async () => {
  for (const code of [null, '400', '599', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'Error', '-', 'gho_secret', 'HTTP_500', '600', '500\n', 'constructor']) {
    await withAdmin(async (request) => {
      const response = await request('/api/admin/feeds', ownerRequest);
      const { items } = (await response.json()).data;
      const allowed = code === null || ['400', '599', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
      assert.deepEqual(items, [
        { ...FEEDS[0], last_attempt_at: NOW.toISOString(), last_success_at: null, last_status: 'error', last_error_code: allowed ? code : 'UNKNOWN_ERROR', repo_count: 7 },
        { ...FEEDS[1], last_attempt_at: null, last_success_at: null, last_status: null, last_error_code: null, repo_count: 0 },
      ]);
    }, { data: { feeds: [
      { kind: 'all', slug: 'all', last_attempt_at: NOW, last_status: 'error', last_error_code: code, repo_count: '7' },
      { kind: 'topic', slug: 'removed', last_error_code: 'gho_secret' },
    ] } });
  }
});

test('database failures never leak driver codes/messages and subsequent requests can recover', async () => {
  const app = express();
  let fail = true;
  const handlers = createAdminController({ model: { listUsers: async () => {
    if (fail) throw Object.assign(new Error('password=secret'), { code: 'gho_secret', sql: 'secret' });
    return { items: [], total: 0 };
  } } });
  app.use('/api/admin', createAdminRouter({ authenticate: (req, res, next) => next(), authorize: (req, res, next) => next(), handlers }));
  await withServer(app, async (request) => {
    const response = await request('/api/admin/users');
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.doesNotMatch(JSON.stringify(body), /secret|password|sql/);
    fail = false;
    assert.equal((await request('/api/admin/users')).status, 200);
  });
});

test('auth me adds a server-derived boolean while preserving the original account fields', async () => {
  const previous = process.env.ADMIN_GITHUB_ID;
  process.env.ADMIN_GITHUB_ID = '67108705';
  try {
    const controller = createAuthController({ oauth: {}, users: {}, sessions: {}, crypto: {}, effectivePlan: async () => 'pro' });
    for (const [user, expected] of [[OWNER, true], [OTHER, false]]) {
      let body;
      await controller.me({ user: { ...user, name: 'Name', avatar_url: '/avatar', token_invalid: false } }, { json: (value) => { body = value; } });
      assert.equal(body.ok, true);
      assert.deepEqual(body.data, { user: { login: user.login, name: 'Name', avatarUrl: '/avatar' }, tokenInvalid: false, plan: 'pro', isAdmin: expected });
    }
  } finally {
    if (previous === undefined) delete process.env.ADMIN_GITHUB_ID;
    else process.env.ADMIN_GITHUB_ID = previous;
  }
});
