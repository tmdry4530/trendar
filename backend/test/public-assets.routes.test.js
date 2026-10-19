import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createPublicAssetsRouter } from '../src/routes/public-assets.routes.js';
import { createRateLimiter } from '../src/middleware/public-rate-limit.js';
import { createOgRenderer } from '../src/services/public-og.js';

const FALLBACK = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x66, 0x62]);
const RENDERED = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x72, 0x72]);

const feedView = {
  feed: { kind: 'all', slug: 'all', name: { en: 'All', ko: '전체' }, last_success_at: new Date('2026-10-19T06:00:00Z') },
  rows: [{ rank: 1, full_name: 'acme/rocket', rate_24h: 500, baseline_source: 'snapshot' }],
  revision: 'rev-feed',
};
const repoView = {
  repo: { id: 7, full_name: 'acme/rocket', owner: 'acme', name: 'rocket', stars: 900 },
  latest: { stars: 910, rate_24h: 320, baseline_source: 'snapshot' },
  best: { kind: 'language', slug: 'python', name: { en: 'Python', ko: 'Python' }, rank: 3 },
  revision: 'rev-repo',
};

const calls = { getFeed: [], getRepo: [], render: [] };
const data = {
  async getFeed(kind, slug) {
    calls.getFeed.push([kind, slug]);
    return kind === 'all' ? feedView : null;
  },
  async getRepo(owner, name) {
    calls.getRepo.push([owner, name]);
    if (owner === 'boom') throw new Error('db down');
    if (owner === 'unranked') return { ...repoView, best: null, feeds: [{ rank: null }] };
    return owner === 'acme' && name === 'rocket' ? repoView : null;
  },
};
const og = {
  fallbackPng: Buffer.from('static-last-resort'),
  getFallbackPng: async () => FALLBACK,
  async render(target) {
    calls.render.push(target);
    return { buffer: RENDERED, fallback: false };
  },
};
const silent = { error() {} };

let server;
let base;

before(async () => {
  const app = express();
  app.use(createPublicAssetsRouter({ data, og, rateLimit: createRateLimiter({ limit: 1000 }), log: silent }));
  app.get('/elsewhere', (req, res) => res.send('ok'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function reset() {
  calls.getFeed.length = 0;
  calls.getRepo.length = 0;
  calls.render.length = 0;
}

test('GET /og/trending.png renders the all feed as cached PNG', async () => {
  reset();
  const res = await fetch(`${base}/og/trending.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=600');
  assert.ok(res.headers.get('etag'));
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(RENDERED));
  assert.deepEqual(calls.getFeed, [['all', 'all']]);
  assert.equal(calls.render[0].key, 'feed:all:all');
  assert.equal(calls.render[0].revision, 'rev-feed');
  assert.ok(calls.render[0].svg.includes('acme/rocket'));
});

test('unknown feed OG returns 404 with fallback PNG bytes', async () => {
  reset();
  const res = await fetch(`${base}/og/trending/topic/nope.png`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(FALLBACK));
  assert.deepEqual(calls.getFeed, [['topic', 'nope']]);
});

test('malformed slugs and owners return 404 without data access', async () => {
  reset();
  const badOwner = await fetch(`${base}/og/repo/bad owner/x.png`);
  assert.equal(badOwner.status, 404);
  assert.ok(Buffer.from(await badOwner.arrayBuffer()).equals(FALLBACK));
  const badSlug = await fetch(`${base}/og/trending/language/Bad_Slug.png`);
  assert.equal(badSlug.status, 404);
  await badSlug.arrayBuffer();
  assert.equal(calls.getRepo.length, 0);
  assert.equal(calls.getFeed.length, 0);
});

test('repo OG renders a known repo and 404s an unknown one', async () => {
  reset();
  const unknown = await fetch(`${base}/og/repo/nobody/nothing.png`);
  assert.equal(unknown.status, 404);
  assert.ok(Buffer.from(await unknown.arrayBuffer()).equals(FALLBACK));
  const known = await fetch(`${base}/og/repo/acme/rocket.png`);
  assert.equal(known.status, 200);
  await known.arrayBuffer();
  const target = calls.render.at(-1);
  assert.equal(target.key, 'repo:acme/rocket');
  assert.equal(target.revision, 'rev-repo');
  assert.ok(target.svg.includes('910'));
  assert.ok(target.svg.includes('Trending #3 · Python'));
});

test('render fallback and data errors respond 200 with uncacheable fallback', async () => {
  const failing = express();
  failing.use(createPublicAssetsRouter({
    data: { getFeed: async () => feedView, getRepo: async () => { throw new Error('db down'); } },
    og: { fallbackPng: FALLBACK, getFallbackPng: async () => FALLBACK, render: async () => ({ buffer: FALLBACK, fallback: true }) },
    rateLimit: (req, res, next) => next(),
    log: silent,
  }));
  const srv = failing.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (const path of ['/og/trending.png', '/og/repo/acme/rocket.png']) {
      const res = await fetch(`${url}${path}`);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('cache-control'), 'no-store', path);
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(FALLBACK), path);
    }
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('badge responds 200 SVG for ranked, unknown, malformed and failing repos', async () => {
  reset();
  const ranked = await fetch(`${base}/badge/acme/rocket.svg`);
  assert.equal(ranked.status, 200);
  assert.equal(ranked.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.equal(ranked.headers.get('cache-control'), 'public, max-age=3600');
  const rankedSvg = await ranked.text();
  assert.ok(rankedSvg.startsWith('<svg'));
  assert.ok(rankedSvg.includes('#3 Python'));

  const missing = await fetch(`${base}/badge/a/b.svg`);
  assert.equal(missing.status, 200);
  assert.equal(missing.headers.get('cache-control'), 'public, max-age=3600');
  assert.ok((await missing.text()).includes('GitHub trend radar'));

  const before = calls.getRepo.length;
  const malformed = await fetch(`${base}/badge/bad_owner!/x.svg`);
  assert.equal(malformed.status, 200);
  assert.ok((await malformed.text()).includes('GitHub trend radar'));
  assert.equal(calls.getRepo.length, before);

  const failing = await fetch(`${base}/badge/boom/x.svg`);
  assert.equal(failing.status, 200);
  assert.equal(failing.headers.get('cache-control'), 'no-store');
  assert.ok((await failing.text()).includes('GitHub trend radar'));
});

test('rate limit applies to OG and badge paths only', async () => {
  const app = express();
  app.use(createPublicAssetsRouter({ data, og, rateLimit: createRateLimiter({ limit: 2 }), log: silent }));
  app.get('/elsewhere', (req, res) => res.send('ok'));
  const srv = app.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(`${url}/og/trending.png`)).status, 200);
    assert.equal((await fetch(`${url}/badge/a/b.svg`)).status, 200);
    const limited = await fetch(`${url}/badge/a/b.svg`);
    assert.equal(limited.status, 200);
    assert.ok(limited.headers.get('retry-after'));
    assert.equal(limited.headers.get('cache-control'), 'no-store');
    assert.match(limited.headers.get('content-type'), /^image\/svg\+xml/);
    assert.match(await limited.text(), /GitHub trend radar/);
    const limitedOg = await fetch(`${url}/og/trending.png`);
    assert.equal(limitedOg.status, 429);
    assert.match(limitedOg.headers.get('content-type'), /^text\/plain/);
    for (let i = 0; i < 3; i += 1) assert.equal((await fetch(`${url}/elsewhere`)).status, 200);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('unranked repo OG uses the generic image without rendering a personalized image', async () => {
  reset();
  const res = await fetch(`${base}/og/repo/unranked/rocket.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), FALLBACK);
  assert.equal(calls.render.length, 0);
});

test('the fresh-render budget spans different IPs and returns no-store generic PNG', async () => {
  const { mock } = await import('node:test');
  mock.method(Date, 'now', () => 4_000_000_000_000);
  let renders = 0;
  const app = express();
  app.use(createPublicAssetsRouter({
    data: {
      getRepo: async (owner, name) => ({ ...repoView, repo: { ...repoView.repo, full_name: `${owner}/${name}` } }),
    },
    og: createOgRenderer({
      renderPng: async () => { renders += 1; return RENDERED; },
      fallbackPng: FALLBACK,
      log: silent,
    }),
    rateLimit: createRateLimiter({ limit: 120, keyOf: (req) => req.get('x-test-ip') }),
    log: silent,
  }));
  const srv = app.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${url}/og/repo/acme/r${i}.png`, { headers: { 'x-test-ip': `ip${i % 3}` } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=600');
      await res.arrayBuffer();
    }
    const blocked = await fetch(`${url}/og/repo/acme/over-budget.png`, { headers: { 'x-test-ip': 'another-ip' } });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.headers.get('content-type'), 'image/png');
    assert.equal(blocked.headers.get('cache-control'), 'no-store');
    await blocked.arrayBuffer();
    assert.equal(renders, 6, 'five personalized renders plus one memoized generic render');
    const cached = await fetch(`${url}/og/repo/acme/r0.png`);
    assert.equal(cached.headers.get('cache-control'), 'public, max-age=600');
    await cached.arrayBuffer();
    assert.equal(renders, 6);
  } finally {
    mock.restoreAll();
    await new Promise((resolve) => srv.close(resolve));
  }
});
