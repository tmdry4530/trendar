import assert from 'node:assert/strict';
import test from 'node:test';
import app, { createApp } from '../src/app.js';
import { createPublicDeps } from '../src/public-mount.js';
import { createRateLimiter } from '../src/middleware/public-rate-limit.js';

async function requestHealth(headers = {}) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    const address = server.address();
    return await fetch(`http://127.0.0.1:${address.port}/api/health`, { headers });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('API 응답에 브라우저 보안 헤더를 설정한다', async () => {
  const response = await requestHealth();

  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('strict-transport-security') ?? '', /^max-age=/);
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');

  const policy = response.headers.get('content-security-policy') ?? '';
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
});

test('신뢰하지 않는 출처에 CORS 허용 헤더를 보내지 않는다', async () => {
  const response = await requestHealth({ Origin: 'https://attacker.example' });

  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('only public badge and OG responses allow cross-origin embedding, including errors and rate limits', async () => {
  const png = Buffer.from('png');
  const publicDeps = createPublicDeps({
    feeds: [],
    data: {
      getRepo: async () => null,
      getFeed: async (kind) => kind === 'all' ? { feed: { name: { en: 'All' } }, rows: [], revision: '1' } : null,
    },
    og: { fallbackPng: png, getFallbackPng: async () => png, render: async () => ({ buffer: png, fallback: false }) },
    tracker: { middleware: (req, res, next) => next() },
    isAuthenticated: async () => false,
    rateLimit: createRateLimiter({ limit: 1, keyOf: (req) => req.get('x-test-key') }),
  });
  const server = createApp({ publicDeps }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [key, path, status, corp] of [
      ['badge', '/badge/a/b.svg', 200, 'cross-origin'],
      ['badge', '/badge/a/b.svg', 200, 'cross-origin'],
      ['bad-badge', '/badge/bad_owner/x.svg', 200, 'cross-origin'],
      ['og', '/og/trending.png', 200, 'cross-origin'],
      ['og', '/og/trending.png', 429, 'cross-origin'],
      ['missing-og', '/og/repo/a/b.png', 404, 'cross-origin'],
      ['bad-og', '/og/repo/bad_owner/x.png', 404, 'cross-origin'],
      ['page', '/trending/topic/nope', 404, 'same-origin'],
      ['api', '/api/health', 200, 'same-origin'],
    ]) {
      const response = await fetch(`${base}${path}`, { headers: { 'x-test-key': key } });
      assert.equal(response.status, status, path);
      assert.equal(response.headers.get('cross-origin-resource-policy'), corp, path);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
      assert.match(response.headers.get('content-security-policy'), /default-src 'self'/, path);
      await response.arrayBuffer();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
