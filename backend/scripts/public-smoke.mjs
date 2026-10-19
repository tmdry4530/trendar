// 공개 트렌딩 스모크: 전용 MySQL(DB_NAME=trendar_public_smoke*)에 시드 후 실제 앱을 띄워 HTTP로 검증한다.
const SMOKE_DB_RE = /^trendar_public_smoke/;

if (!SMOKE_DB_RE.test(process.env.DB_NAME ?? '') || process.env.MYSQL_URL || process.env.DATABASE_URL) {
  console.error('[smoke] refused: DB_NAME must start with trendar_public_smoke and MYSQL_URL/DATABASE_URL must be unset');
  process.exit(2);
}

const { pool } = await import('../src/config/db.js');
const { initDb } = await import('../src/db/init.js');
const publicModel = await import('../src/models/public.model.js');
const users = await import('../src/models/user.model.js');
const sessions = await import('../src/models/session.model.js');
const { allFeeds } = await import('../src/config/public-feeds.js');
const { newSessionToken } = await import('../src/utils/crypto.js');
const { createTtlCache } = await import('../src/utils/ttl-cache.js');
const { createPublicDeps } = await import('../src/public-mount.js');
const { createApp } = await import('../src/app.js');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const REPO_COUNT = 1000;
const PERF_SAMPLES = 50;
const PERF_P95_LIMIT_MS = 300;
const USER_AGENT = 'trendar-smoke-bot/1.0';
const PUBLIC_TABLES = ['public_feeds', 'public_repos', 'public_repo_snapshots', 'public_feed_repos', 'public_daily_metrics'];

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

async function count(table) {
  const [[row]] = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(row.n);
}

function pngSize(buffer) {
  const signature = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const ihdr = buffer.subarray(12, 16).toString('latin1') === 'IHDR';
  return { signature, ihdr, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function verifySchema() {
  await initDb();
  await initDb();
  const [tables] = await pool.query(
    `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'public\\_%' ORDER BY TABLE_NAME`
  );
  const names = tables.map((row) => row.name);
  check('initDb x2 creates 5 public tables', PUBLIC_TABLES.every((t) => names.includes(t)) && names.length === 5, names.join(','));
  const [[subscriptions]] = await pool.query(
    `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriptions'`
  );
  check('subscriptions table exists', Number(subscriptions.n) === 1);
  const userRefs = [];
  for (const table of PUBLIC_TABLES) {
    const [[row]] = await pool.query(`SHOW CREATE TABLE \`${table}\``);
    if (/REFERENCES `users`/.test(row['Create Table'])) userRefs.push(table);
  }
  check('public DDL has no REFERENCES `users`', userRefs.length === 0, userRefs.join(','));
}

async function seed(now) {
  await pool.query('DELETE FROM users');
  for (const table of ['public_daily_metrics', 'public_feed_repos', 'public_repo_snapshots', 'public_repos']) {
    await pool.query(`DELETE FROM ${table}`);
  }
  const feedIds = await publicModel.ensureFeeds(allFeeds());
  const allId = feedIds.get('all:all');
  const extraFeeds = ['language:python', 'topic:llm'].map((key) => feedIds.get(key)).filter((id) => id != null);

  const indexes = Array.from({ length: REPO_COUNT }, (_, i) => i);
  await inBatches(indexes, 20, async (i) => {
    const base = 500 + i;
    const delta = 100 + i;
    const repoId = await publicModel.upsertPublicRepo({
      github_id: 9000000 + i,
      full_name: `smoke-org/repo-${i}`,
      owner: 'smoke-org',
      name: `repo-${i}`,
      html_url: `https://github.com/smoke-org/repo-${i}`,
      description: `Smoke repository ${i}`,
      language: i % 2 ? 'Python' : 'TypeScript',
      stars: base + delta,
      github_created_at: new Date(now.getTime() - (2 + (i % 12)) * DAY - HOUR),
    });
    await publicModel.insertPublicSnapshot(repoId, { stars: base, forks: 10, open_issues: 1, watchers: base }, new Date(now.getTime() - DAY));
    await publicModel.insertPublicSnapshot(repoId, { stars: base + delta, forks: 11, open_issues: 1, watchers: base + delta }, now);
    await publicModel.upsertFeedMembership(allId, repoId, now);
    if (i < 60) for (const feedId of extraFeeds) await publicModel.upsertFeedMembership(feedId, repoId, now);
  });

  const rocketId = await publicModel.upsertPublicRepo({
    github_id: 8999999,
    full_name: 'acme/rocket',
    owner: 'acme',
    name: 'rocket',
    html_url: 'https://github.com/acme/rocket',
    description: 'x <b>&',
    language: 'Python',
    stars: 1500,
    github_created_at: new Date(now.getTime() - 20 * HOUR),
  });
  await publicModel.insertPublicSnapshot(rocketId, { stars: 1500, forks: 40, open_issues: 3, watchers: 1500 }, now);
  for (const feedId of [allId, ...extraFeeds]) {
    await publicModel.upsertFeedMembership(feedId, rocketId, now);
    await publicModel.markFeedResult(feedId, { status: 'ok', errorCode: null, at: now });
  }
  console.log(`[smoke] seeded repos=${await count('public_repos')} snapshots=${await count('public_repo_snapshots')} memberships=${await count('public_feed_repos')}`);
}

async function createSessions() {
  const user = await users.upsertFromGithub({ githubId: 77000001, login: 'smoke-user', name: 'Smoke', avatarUrl: null, accessTokenEnc: null });
  const valid = newSessionToken();
  const expired = newSessionToken();
  await sessions.create(user.id, valid.hash, new Date(Date.now() + DAY));
  await sessions.create(user.id, expired.hash, new Date(Date.now() - DAY));
  return { valid: valid.token, expired: expired.token };
}

async function httpChecks(get, tokens) {
  const production = process.env.NODE_ENV === 'production';

  let res = await get('/');
  let body = await res.text();
  check('GET / anonymous → SSR', res.status === 200 && /^text\/html/.test(res.headers.get('content-type')) && body.includes('acme/rocket'), `status=${res.status}`);
  check('GET / cache-control private, no-store', res.headers.get('cache-control') === 'private, no-store', res.headers.get('cache-control'));

  res = await get('/', { headers: { cookie: `sid=${tokens.valid}` } });
  body = await res.text();
  const spa = production ? res.status === 200 && body.includes('id="root"') && !body.includes('acme/rocket') : res.status === 404;
  check('GET / valid session → SPA', spa, `status=${res.status} root=${body.includes('id="root"')}`);

  for (const [label, token] of [['expired', tokens.expired], ['forged', 'forged-token']]) {
    res = await get('/', { headers: { cookie: `sid=${token}` } });
    body = await res.text();
    check(`GET / ${label} session → SSR`, res.status === 200 && body.includes('acme/rocket') && !body.includes('id="root"'), `status=${res.status}`);
  }

  res = await get('/trending');
  body = await res.text();
  check('GET /trending', res.status === 200 && res.headers.get('cache-control') === 'public, max-age=600' && body.includes('est.'), `status=${res.status} cache=${res.headers.get('cache-control')}`);

  res = await get('/ko/trending');
  body = await res.text();
  check('GET /ko/trending lang="ko"', res.status === 200 && body.includes('<html lang="ko">'), `status=${res.status}`);

  for (const path of ['/trending/language/python', '/trending/topic/llm']) {
    res = await get(path);
    body = await res.text();
    check(`GET ${path}`, res.status === 200 && body.includes('acme/rocket'), `status=${res.status}`);
  }

  res = await get('/repo/acme/rocket');
  body = await res.text();
  check('GET /repo/acme/rocket escapes description', res.status === 200 && body.includes('x &lt;b&gt;&amp;') && !body.includes('x <b>&'), `status=${res.status}`);

  for (const path of ['/trending/topic/nope', '/trending/language/cobol', '/repo/ghost/none']) {
    res = await get(path);
    body = await res.text();
    check(`GET ${path} → 404 html`, res.status === 404 && /^text\/html/.test(res.headers.get('content-type')) && body.includes('noindex'), `status=${res.status}`);
  }

  for (const path of ['/og/trending.png', '/og/repo/acme/rocket.png']) {
    res = await get(path);
    const png = Buffer.from(await res.arrayBuffer());
    const size = pngSize(png);
    check(`GET ${path} PNG 1200x630`, res.status === 200 && res.headers.get('content-type') === 'image/png' && size.signature && size.ihdr && size.width === 1200 && size.height === 630,
      `status=${res.status} bytes=${png.length} ${size.width}x${size.height}`);
  }

  res = await get('/badge/acme/rocket.svg');
  body = await res.text();
  check('GET /badge/acme/rocket.svg #1 All', res.status === 200 && body.includes('#1 All'), `status=${res.status}`);
  res = await get('/badge/none/none.svg');
  body = await res.text();
  check('GET /badge/none/none.svg neutral', res.status === 200 && body.includes('<svg'), `status=${res.status}`);

  res = await get('/sitemap.xml');
  body = await res.text();
  check('GET /sitemap.xml', res.status === 200 && /^application\/xml/.test(res.headers.get('content-type')) && body.includes('/ko/repo/acme/rocket'), `status=${res.status} urls=${(body.match(/<url>/g) || []).length}`);

  res = await get('/api/health');
  check('GET /api/health', res.status === 200, `status=${res.status} body=${await res.text()}`);
  res = await get('/api/repos');
  check('GET /api/repos unauthenticated → 401', res.status === 401, `status=${res.status} body=${await res.text()}`);
}

async function measureFeed(get) {
  const samples = [];
  for (let i = 0; i < PERF_SAMPLES; i += 1) {
    const started = performance.now();
    const res = await get('/trending');
    await res.text();
    samples.push(performance.now() - started);
    if (res.status !== 200) failures.push(`perf status ${res.status}`);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  const p50 = samples[Math.ceil(samples.length * 0.5) - 1];
  console.log(`[smoke] /trending cache-miss render: p95=${p95.toFixed(1)}ms p50=${p50.toFixed(1)}ms max=${samples.at(-1).toFixed(1)}ms samples=${samples.length} feed_repos=${REPO_COUNT + 1}`);
  check(`p95 < ${PERF_P95_LIMIT_MS}ms`, p95 < PERF_P95_LIMIT_MS, `p95=${p95.toFixed(1)}`);
}

async function rateLimitCheck(get) {
  let limited = 0;
  let retryAfter = null;
  for (let i = 0; i < 125; i += 1) {
    const res = await get('/badge/a/b.svg');
    await res.arrayBuffer();
    if (res.status === 429) {
      limited += 1;
      retryAfter ??= res.headers.get('retry-after');
    }
  }
  check('/badge 125 requests → 429 at least once', limited >= 1, `429=${limited} retry-after=${retryAfter}`);
}

async function main() {
  const now = new Date();
  await verifySchema();
  await seed(now);
  const tokens = await createSessions();

  const deps = createPublicDeps({ cache: createTtlCache({ ttlMs: 0 }) });
  const server = createApp({ publicDeps: deps }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { 'user-agent': USER_AGENT, ...init.headers } });

  try {
    await httpChecks(get, tokens);
    await measureFeed(get);
    await rateLimitCheck(get);

    await deps.tracker.flush();
    const [metrics] = await pool.query(
      `SELECT day, event_kind, path_template, locale, is_bot, event_count FROM public_daily_metrics ORDER BY path_template, locale`
    );
    for (const row of metrics) console.log(`[smoke] metric ${row.event_kind}|${row.path_template}|${row.locale}|${row.is_bot}|${row.event_count}`);
    check('public_daily_metrics has page_view|trending|en|1', metrics.some((row) => row.event_kind === 'page_view' && row.path_template === 'trending' && row.locale === 'en' && Number(row.is_bot) === 1 && row.event_count >= 1));

    const before = { repos: await count('public_repos'), snapshots: await count('public_repo_snapshots'), memberships: await count('public_feed_repos') };
    await pool.query('DELETE FROM users');
    const after = { repos: await count('public_repos'), snapshots: await count('public_repo_snapshots'), memberships: await count('public_feed_repos') };
    check('DELETE FROM users leaves public data intact', JSON.stringify(before) === JSON.stringify(after), `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  } finally {
    deps.tracker.stop();
    await new Promise((resolve) => server.close(resolve));
  }
}

let exitCode = 0;
try {
  await main();
  exitCode = failures.length ? 1 : 0;
} catch (error) {
  console.error('[smoke] error', error);
  exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
console.log(failures.length ? `[smoke] FAILED: ${failures.join('; ')}` : `[smoke] ${exitCode === 0 ? 'OK' : 'ERROR'}`);
process.exit(exitCode);
