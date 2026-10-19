import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import { allFeeds, findFeedConfig } from '../src/config/public-feeds.js';
import { createPublicDeps, mountPublic } from '../src/public-mount.js';
import { createApp } from '../src/app.js';

const APP_URL = 'https://trendar.example';
const UPDATED = new Date('2026-10-19T06:00:00Z');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const feeds = allFeeds({});

const topRow = {
  id: 1,
  github_id: 101,
  full_name: 'acme/rocket',
  owner: 'acme',
  name: 'rocket',
  description: 'A fast rocket',
  language: 'Rust',
  github_created_at: new Date('2026-10-15T00:00:00Z'),
  stars: 12345,
  rate_24h: 1800,
  baseline_source: 'snapshot',
  span_hours: 24,
  age_days: 3.2,
  rank: 1,
};

function fakeData() {
  const feedIndex = feeds.map(({ kind, slug, name }) => ({ kind, slug, name, last_attempt_at: UPDATED, last_success_at: UPDATED, last_status: 'ok' }));
  async function getFeed(kind, slug) {
    const feed = findFeedConfig(feeds, kind, slug);
    if (!feed) return null;
    return {
      feed: { kind, slug, name: feed.name, last_attempt_at: UPDATED, last_success_at: UPDATED, last_status: 'ok' },
      rows: [topRow],
      revision: 'rev',
    };
  }
  return {
    getFeedIndex: async () => feedIndex,
    getFeed,
    async getRepo() {
      return {
        repo: { id: 1, full_name: 'a/b', owner: 'a', name: 'b', description: 'repo b', language: 'Go', stars: 900, github_created_at: new Date('2026-10-15T00:00:00Z') },
        latest: null,
        snapshots: [{ stars: 900, forks: 1, captured_at: UPDATED }],
        feeds: [{ kind: 'all', slug: 'all', name: { en: 'All', ko: '전체' }, rank: 1 }],
        best: { kind: 'all', slug: 'all', name: { en: 'All', ko: '전체' }, rank: 1 },
        revision: 'rev',
      };
    },
    async getSitemapEntries() {
      return { feeds: [{ kind: 'all', slug: 'all', lastmod: UPDATED }], repos: [{ owner: 'a', name: 'b', lastmod: UPDATED }] };
    },
  };
}

function fakeDeps({ authenticated = false } = {}) {
  const auth = { calls: 0 };
  const tracked = [];
  const deps = createPublicDeps({
    appUrl: APP_URL,
    feeds,
    data: fakeData(),
    model: {
      addDailyMetrics: async () => {
        throw new Error('model must not be used');
      },
    },
    og: { fallbackPng: PNG, render: async () => ({ buffer: PNG, fallback: false }) },
    isAuthenticated: async () => {
      auth.calls += 1;
      return authenticated;
    },
    tracker: {
      middleware(req, res, next) {
        res.locals.track = (template) => tracked.push(template);
        next();
      },
    },
  });
  return { deps, auth, tracked };
}

async function listen(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await run((path, init) => fetch(`${base}${path}`, init));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function withStubApp(options, run) {
  const { deps, auth, tracked } = fakeDeps(options);
  const app = express();
  app.use(cookieParser());
  mountPublic(app, deps);
  app.use((req, res) => res.send('SPA'));
  await listen(app, (get) => run({ get, auth, tracked }));
}

test('anonymous / renders the SSR landing with private cache headers', async () => {
  await withStubApp({ authenticated: false }, async ({ get, auth, tracked }) => {
    const response = await get('/');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(response.headers.get('vary') ?? '', /Cookie/);
    const html = await response.text();
    assert.ok(html.includes('acme/rocket'));
    assert.equal(auth.calls, 1);
    assert.deepEqual(tracked, ['landing']);
  });
});

test('authenticated / falls through to the SPA', async () => {
  await withStubApp({ authenticated: true }, async ({ get, auth }) => {
    const response = await get('/', { headers: { cookie: 'sid=valid' } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'SPA');
    assert.equal(auth.calls, 1);
  });
});

test('/ko renders Korean landing without an auth check', async () => {
  for (const authenticated of [false, true]) {
    await withStubApp({ authenticated }, async ({ get, auth }) => {
      const response = await get('/ko', { headers: { cookie: 'sid=whatever' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=600');
      assert.equal(response.headers.get('set-cookie'), null);
      const html = await response.text();
      assert.ok(html.includes('<html lang="ko">'));
      assert.equal(auth.calls, 0);
    });
  }
});

test('feed, repo, 404 and locale routes are mounted ahead of the SPA', async () => {
  await withStubApp({}, async ({ get, auth }) => {
    const trending = await get('/trending');
    assert.equal(trending.status, 200);
    assert.equal(trending.headers.get('cache-control'), 'public, max-age=600');
    assert.ok((await trending.text()).includes('<html lang="en">'));

    const ko = await get('/ko/trending');
    assert.equal(ko.status, 200);
    assert.ok((await ko.text()).includes('<html lang="ko">'));

    const missing = await get('/trending/topic/nope');
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type'), /^text\/html/);
    assert.ok((await missing.text()).includes('noindex'));

    const repo = await get('/repo/a/b');
    assert.equal(repo.status, 200);
    assert.ok((await repo.text()).includes('a/b'));
    assert.equal(auth.calls, 0);
  });
});

test('badge, OG and sitemap respond with their content types', async () => {
  await withStubApp({}, async ({ get }) => {
    const badge = await get('/badge/a/b.svg');
    assert.equal(badge.status, 200);
    assert.match(badge.headers.get('content-type'), /^image\/svg\+xml/);
    assert.match(badge.headers.get('cache-control'), /max-age=3600/);

    const og = await get('/og/trending.png');
    assert.equal(og.status, 200);
    assert.equal(og.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await og.arrayBuffer()), PNG);

    const sitemap = await get('/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers.get('content-type'), /^application\/xml/);
    assert.ok((await sitemap.text()).includes(`${APP_URL}/ko/repo/a/b`));
  });
});

test('unmatched paths reach the SPA fallback', async () => {
  await withStubApp({}, async ({ get }) => {
    for (const path of ['/anything-else', '/repos', '/repos/12', '/ko/settings']) {
      const response = await get(path);
      assert.equal(await response.text(), 'SPA', path);
    }
  });
});

test('the real app keeps /api behavior and mounts public routes', async () => {
  const { deps } = fakeDeps();
  await listen(createApp({ publicDeps: deps }), async (get) => {
    const health = await get('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const api = await get('/api/nope');
    assert.equal(api.status, 401);
    assert.equal((await api.json()).error.code, 'UNAUTHORIZED');

    const trending = await get('/trending');
    assert.equal(trending.status, 200);
    assert.equal(trending.headers.get('cache-control'), 'public, max-age=600');
    assert.match(trending.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  });
});
