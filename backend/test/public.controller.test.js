import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { allFeeds, findFeedConfig } from '../src/config/public-feeds.js';
import { createPublicController } from '../src/controllers/public.controller.js';
import { createPublicRouter, setLocale } from '../src/routes/public.routes.js';

const APP_URL = 'https://trendar.example';
const UPDATED = new Date('2026-10-19T06:00:00Z');
const feeds = allFeeds({});

function rankedRow(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function fakeData({ failFeed = false } = {}) {
  const calls = { getFeed: [], getRepo: [], getFeedIndex: 0 };
  const feedIndex = feeds.map(({ kind, slug, name }) => ({ kind, slug, name, last_attempt_at: UPDATED, last_success_at: UPDATED, last_status: 'ok' }));
  return {
    calls,
    async getFeedIndex() {
      calls.getFeedIndex += 1;
      return feedIndex;
    },
    async getFeed(kind, slug) {
      calls.getFeed.push(`${kind}:${slug}`);
      if (failFeed) throw new Error('db down');
      const feed = findFeedConfig(feeds, kind, slug);
      if (!feed) return null;
      return {
        feed: { kind, slug, name: feed.name, last_attempt_at: UPDATED, last_success_at: UPDATED, last_status: 'ok' },
        rows: [rankedRow()],
        revision: 'rev',
      };
    },
    async getRepo(owner, name) {
      calls.getRepo.push(`${owner}/${name}`);
      if (owner !== 'acme' || name !== 'rocket') return null;
      return {
        repo: { id: 1, full_name: 'acme/rocket', owner: 'acme', name: 'rocket', description: 'A fast rocket', language: 'Rust', stars: 12345, github_created_at: new Date('2026-10-15T00:00:00Z') },
        latest: null,
        snapshots: [{ stars: 12000, forks: 1, captured_at: new Date('2026-10-18T00:00:00Z') }, { stars: 12345, forks: 1, captured_at: UPDATED }],
        feeds: [{ kind: 'all', slug: 'all', name: { en: 'All', ko: '전체' }, rank: 1 }],
        best: { kind: 'all', slug: 'all', name: { en: 'All', ko: '전체' }, rank: 1 },
        revision: 'rev',
      };
    },
  };
}

async function withServer({ data = fakeData(), authenticated = false, spaDist = null } = {}, run) {
  const auth = { calls: 0 };
  const tracked = [];
  const controller = createPublicController({
    data,
    feeds,
    appUrl: APP_URL,
    now: () => UPDATED,
    isAuthenticated: async () => {
      auth.calls += 1;
      return authenticated;
    },
  });
  const router = createPublicRouter({ controller });
  const app = express();
  app.use((req, res, next) => {
    res.locals.track = (template) => tracked.push(template);
    next();
  });
  app.use('/ko', setLocale('ko'), router);
  app.use(setLocale('en'), router);
  if (spaDist) {
    app.use(express.static(spaDist));
    app.get('*', (req, res) => res.sendFile(path.join(spaDist, 'index.html')));
  } else {
    app.use((req, res) => res.status(299).type('text/plain').send('spa'));
  }
  app.use((err, req, res, next) => res.status(500).type('text/plain').send(err.message));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await run({ get: (path, init) => fetch(`${base}${path}`, init), data, auth, tracked });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('feed pages respond with public cache headers and HTML', async () => {
  await withServer({}, async ({ get, tracked }) => {
    for (const [path, template] of [['/trending', 'trending'], ['/trending/language/python', 'trending-language'], ['/trending/topic/llm', 'trending-topic']]) {
      const response = await get(path, { headers: { cookie: 'sid=someone-else' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(response.headers.get('cache-control'), 'public, max-age=600');
      assert.equal(response.headers.get('set-cookie'), null);
      const html = await response.text();
      assert.ok(html.includes(`<link rel="canonical" href="${APP_URL}${path}">`));
      assert.ok(html.includes('acme/rocket'));
      assert.equal(tracked.at(-1), template);
    }
  });
});

test('unknown or malformed feeds and repositories return the 404 page', async () => {
  await withServer({}, async ({ get, data, tracked }) => {
    for (const path of ['/trending/language/cobol', '/trending/topic/nope', '/trending/language/Bad_Slug', '/trending/elsewhere', '/trending/language/python/extra', '/repo/ghost/missing', '/repo/acme/rocket/extra', '/repo/bad%20owner/x', '/ko/trending/language/cobol']) {
      const response = await get(path);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(response.headers.get('cache-control'), 'public, max-age=600');
      const html = await response.text();
      assert.ok(html.includes('<meta name="robots" content="noindex">'), path);
      assert.ok(html.includes(path.startsWith('/ko') ? 'href="/ko/trending/language/python"' : 'href="/trending/language/python"'), path);
      assert.equal(tracked.at(-1), 'not-found');
    }
    assert.deepEqual(data.calls.getFeed, ['language:cobol', 'topic:nope', 'language:cobol']);
    assert.deepEqual(data.calls.getRepo, ['ghost/missing']);
    assert.equal(data.calls.getFeedIndex, 0);
  });
});

test('malformed owner is rejected without querying the repository', async () => {
  await withServer({}, async ({ get, data }) => {
    const response = await get('/repo/bad%20owner/x');
    assert.equal(response.status, 404);
    assert.equal(data.calls.getRepo.length, 0);
  });
});

test('repo page renders with public caching', async () => {
  await withServer({}, async ({ get, tracked }) => {
    const response = await get('/repo/acme/rocket');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=600');
    const html = await response.text();
    assert.ok(html.includes('<svg class="spark"'));
    assert.ok(html.includes('Not measurable yet'));
    assert.ok(html.includes('[![Trending on Trendar]('));
    assert.equal(tracked.at(-1), 'repo');
  });
});

test('English landing hands signed-in visitors to the SPA', async () => {
  await withServer({ authenticated: true }, async ({ get, auth, data, tracked }) => {
    const response = await get('/');
    assert.equal(response.status, 299);
    assert.equal(await response.text(), 'spa');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('vary'), 'Cookie');
    assert.equal(auth.calls, 1);
    assert.equal(data.calls.getFeed.length, 0);
    assert.deepEqual(tracked, []);
  });
});

test('signed-in English landing keeps private, no-store and Vary: Cookie through the production SPA fallback', async () => {
  const dist = await mkdtemp(path.join(tmpdir(), 'trendar-spa-'));
  try {
    await writeFile(path.join(dist, 'index.html'), '<!doctype html><div id="root">spa</div>');
    await withServer({ authenticated: true, spaDist: dist }, async ({ get, auth }) => {
      for (const target of ['/', '/?ref=x']) {
        const response = await get(target);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), '<!doctype html><div id="root">spa</div>');
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.equal(response.headers.get('vary'), 'Cookie');
      }
      assert.equal(auth.calls, 2);
    });
    await withServer({ spaDist: dist }, async ({ get }) => {
      const anonymous = await get('/');
      assert.equal(anonymous.headers.get('cache-control'), 'private, no-store');
      assert.equal(anonymous.headers.get('vary'), 'Cookie');
      assert.ok((await anonymous.text()).includes('acme/rocket'));
      const korean = await get('/ko');
      assert.equal(korean.headers.get('cache-control'), 'public, max-age=600');
      assert.equal(korean.headers.get('vary'), null);
    });
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test('English landing renders privately for anonymous visitors', async () => {
  await withServer({}, async ({ get, auth, tracked }) => {
    const response = await get('/');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('vary'), 'Cookie');
    const html = await response.text();
    assert.ok(html.includes('acme/rocket'));
    assert.ok(html.includes('href="/api/auth/github?from=landing&locale=en"'));
    assert.equal(auth.calls, 1);
    assert.deepEqual(tracked, ['landing']);
  });
});

test('Korean landing never checks authentication and is publicly cacheable', async () => {
  await withServer({ authenticated: true }, async ({ get, auth }) => {
    for (const path of ['/ko', '/ko/']) {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=600');
      assert.equal(response.headers.get('vary'), null);
      const html = await response.text();
      assert.match(html, /<html lang="ko">/);
      assert.ok(html.includes('href="/api/auth/github?from=landing&locale=ko"'));
    }
    assert.equal(auth.calls, 0);
  });
});

test('Korean mount localizes feed pages', async () => {
  await withServer({}, async ({ get }) => {
    const response = await get('/ko/trending');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<html lang="ko">/);
    assert.ok(html.includes('<title>급상승 신규 GitHub 프로젝트 | Trendar</title>'));
    assert.ok(html.includes(`<link rel="canonical" href="${APP_URL}/ko/trending">`));
    assert.ok(html.includes('<a class="nav__lang" href="/trending" lang="en"'));
    assert.ok(html.includes('href="/ko/repo/acme/rocket"'));
  });
});

test('other /ko paths fall through to the SPA', async () => {
  await withServer({}, async ({ get }) => {
    const response = await get('/ko/dashboard');
    assert.equal(response.status, 299);
  });
});

test('public page data failures return uncacheable HTML 503 without internal details', async () => {
  const data = fakeData({ failFeed: true });
  data.getRepo = async () => { throw new Error('db down: secret connection details'); };
  await withServer({ data }, async ({ get }) => {
    for (const path of ['/', '/ko', '/trending', '/trending/language/python', '/trending/topic/llm', '/repo/acme/rocket', '/ko/trending', '/ko/repo/acme/rocket']) {
      const response = await get(path);
      assert.equal(response.status, 503, path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
      assert.match(response.headers.get('content-type'), /^text\/html/, path);
      const html = await response.text();
      assert.match(html, /<!doctype html>/i, path);
      assert.match(html, /Trendar/, path);
      assert.doesNotMatch(html, /db down|secret connection/, path);
    }
  });
});

test('public HTML rendering errors return 503 rather than forwarding JSON failures', async () => {
  const data = fakeData();
  data.getFeedIndex = async () => ({ not: 'an iterable feed index' });
  await withServer({ data }, async ({ get }) => {
    const response = await get('/trending');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type'), /^text\/html/);
  });
});

test('public page client errors preserve status/statusCode while unknown and server errors become 503', async () => {
  for (const [properties, expected] of [
    [{ status: 400 }, 400],
    [{ statusCode: 403 }, 403],
    [{ status: 404 }, 404],
    [{ status: 429 }, 429],
    [{ status: 500 }, 503],
    [{ statusCode: 502 }, 503],
    [{}, 503],
  ]) {
    const data = fakeData();
    data.getFeed = async () => { throw Object.assign(new Error('private exception details'), properties); };
    await withServer({ data }, async ({ get }) => {
      const response = await get('/trending');
      assert.equal(response.status, expected, JSON.stringify(properties));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.headers.get('content-type'), /^text\/html/);
      const html = await response.text();
      assert.match(html, /<meta name="robots" content="noindex">/);
      assert.doesNotMatch(html, /private exception details/);
      if (expected < 500) {
        assert.match(html, new RegExp(String(expected)));
        assert.doesNotMatch(html, /temporarily unavailable/);
      }
    });
  }
});

test('public page URIError without an explicit status becomes HTML 400', async () => {
  const data = fakeData();
  data.getFeed = async () => { throw new URIError('private decoding details'); };
  await withServer({ data }, async ({ get }) => {
    const response = await get('/trending');
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type'), /^text\/html/);
    const html = await response.text();
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.doesNotMatch(html, /private decoding details|temporarily unavailable/);
  });
});
