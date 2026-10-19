// test/public-analytics.test.js — 공개 페이지 조회·가입 전환 집계(메모리 버퍼, 일별 행) 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTE_TEMPLATES,
  referrerDomain,
  isBotUserAgent,
  createPageViewTracker,
  createSignupAttribution,
} from '../src/services/public-analytics.js';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const NOW = () => new Date('2026-10-19T15:30:00Z');

function silentLog() {
  const log = { errors: [], error: (...a) => log.errors.push(a) };
  return log;
}

test('ROUTE_TEMPLATES는 계약 순서 그대로', () => {
  assert.deepEqual(ROUTE_TEMPLATES, ['landing', 'trending', 'trending-language', 'trending-topic', 'repo', 'not-found']);
});

test('referrerDomain: hostname 소문자·www 제거, 파싱 실패·없음 → 빈 문자열', () => {
  assert.equal(referrerDomain('https://www.reddit.com/r/x?u=1'), 'reddit.com');
  assert.equal(referrerDomain('https://News.YCombinator.com/item?id=1'), 'news.ycombinator.com');
  assert.equal(referrerDomain('not a url'), '');
  assert.equal(referrerDomain(undefined), '');
  assert.equal(referrerDomain(''), '');
  const long = `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.example/`;
  assert.ok(referrerDomain(long).length <= 255);
});

test('referrerDomain: IP 리터럴 호스트는 주소 대신 고정 버킷 ip', () => {
  for (const ref of [
    'http://203.0.113.7/path',
    'https://127.0.0.1:8443/',
    'http://0x7f.1/',
    'http://[2001:db8::1]/x',
    'http://[::1]:3000/',
    'http://[::ffff:198.51.100.4]/',
  ]) {
    assert.equal(referrerDomain(ref), 'ip', ref);
  }
  assert.equal(referrerDomain('https://1.example.com/'), '1.example.com');
});

test('isBotUserAgent: 크롤러·CLI·빈 UA → true, 브라우저 → false', () => {
  assert.equal(isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
  assert.equal(isBotUserAgent('Twitterbot/1.0'), true);
  assert.equal(isBotUserAgent('curl/8.4.0'), true);
  assert.equal(isBotUserAgent(''), true);
  assert.equal(isBotUserAgent(undefined), true);
  assert.equal(isBotUserAgent(CHROME_UA), false);
});

test('track 4회 → flush 시 같은 키는 합산, KST 일자, page_view 행 2개', async () => {
  const calls = [];
  const tracker = createPageViewTracker({
    addDailyMetrics: async (rows) => { calls.push(rows); },
    flushMs: 60000,
    now: NOW,
    log: silentLog(),
  });
  const human = { template: 'trending-topic', locale: 'ko', referer: 'https://www.reddit.com/r/x', userAgent: CHROME_UA };
  tracker.track(human);
  tracker.track(human);
  tracker.track({ ...human, referer: 'https://reddit.com/other' });
  tracker.track({ ...human, userAgent: 'Googlebot/2.1' });
  assert.equal(tracker.pendingCount(), 2);

  await tracker.flush();
  assert.equal(calls.length, 1);
  const rows = calls[0];
  assert.equal(rows.length, 2);
  const humanRow = rows.find((r) => r.is_bot === 0);
  const botRow = rows.find((r) => r.is_bot === 1);
  assert.deepEqual(humanRow, {
    day: '2026-10-20',
    event_kind: 'page_view',
    path_template: 'trending-topic',
    locale: 'ko',
    referrer_domain: 'reddit.com',
    is_bot: 0,
    count: 3,
  });
  assert.equal(botRow.count, 1);
  assert.equal(botRow.event_kind, 'page_view');
  assert.equal(botRow.day, '2026-10-20');
  for (const row of rows) {
    for (const forbidden of ['ip', 'cookie', 'ua']) assert.equal(forbidden in row, false);
  }
  assert.equal(tracker.pendingCount(), 0);
});

test('알 수 없는 template은 무시, 비정상 locale은 en', async () => {
  const calls = [];
  const tracker = createPageViewTracker({
    addDailyMetrics: async (rows) => { calls.push(rows); },
    flushMs: 60000,
    now: NOW,
    log: silentLog(),
  });
  tracker.track({ template: '../admin', locale: 'en', userAgent: CHROME_UA });
  tracker.track({ template: 'landing', locale: 'xx', userAgent: CHROME_UA });
  await tracker.flush();
  assert.equal(calls[0].length, 1);
  assert.equal(calls[0][0].path_template, 'landing');
  assert.equal(calls[0][0].locale, 'en');
});

test('버퍼가 비어 있으면 flush는 addDailyMetrics를 호출하지 않는다', async () => {
  let called = 0;
  const tracker = createPageViewTracker({
    addDailyMetrics: async () => { called += 1; },
    flushMs: 60000,
    now: NOW,
    log: silentLog(),
  });
  await tracker.flush();
  assert.equal(called, 0);
});

test('addDailyMetrics throw → flush는 reject하지 않고 log.error 1회, 버퍼 비움', async () => {
  const log = silentLog();
  const tracker = createPageViewTracker({
    addDailyMetrics: async () => { throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }); },
    flushMs: 60000,
    now: NOW,
    log,
  });
  tracker.track({ template: 'repo', locale: 'en', userAgent: CHROME_UA });
  await tracker.flush();
  assert.equal(log.errors.length, 1);
  assert.equal(log.errors[0][0].startsWith('[public]'), true);
  assert.equal(tracker.pendingCount(), 0);
});

test('middleware: res.locals.track만 설정, 호출 시점 locale 사용, IP·쿠키 미접근', async () => {
  const calls = [];
  const tracker = createPageViewTracker({
    addDailyMetrics: async (rows) => { calls.push(rows); },
    flushMs: 60000,
    now: NOW,
    log: silentLog(),
  });
  const headers = { referer: 'https://www.google.com/search?q=x', 'user-agent': CHROME_UA };
  const req = {
    get: (name) => headers[name.toLowerCase()],
    get ip() { throw new Error('IP 접근 금지'); },
    get ips() { throw new Error('IP 접근 금지'); },
    get cookies() { throw new Error('쿠키 접근 금지'); },
    get headers() { throw new Error('원본 헤더 접근 금지'); },
  };
  const res = { locals: {} };
  let nextCalls = 0;
  tracker.middleware(req, res, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.equal(typeof res.locals.track, 'function');
  assert.equal(tracker.pendingCount(), 0);

  res.locals.locale = 'ko';
  res.locals.track('trending');
  await tracker.flush();
  assert.equal(calls[0][0].locale, 'ko');
  assert.equal(calls[0][0].referrer_domain, 'google.com');
  assert.equal(calls[0][0].path_template, 'trending');
});

test('start/stop: 중복 start 무해, stop 후 타이머 해제', () => {
  const tracker = createPageViewTracker({
    addDailyMetrics: async () => {},
    flushMs: 60000,
    now: NOW,
    log: silentLog(),
  });
  tracker.start();
  tracker.start();
  tracker.stop();
  tracker.stop();
});

test('start: 쓰기가 진행 중이면 주기 flush는 건너뛰고 버퍼에 누적', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls = [];
  let release;
  const tracker = createPageViewTracker({
    addDailyMetrics: (rows) => {
      calls.push(rows);
      return calls.length === 1 ? new Promise((r) => { release = r; }) : Promise.resolve();
    },
    flushMs: 1000,
    now: NOW,
    log: silentLog(),
  });
  const view = (template) => tracker.track({ template, locale: 'en', userAgent: CHROME_UA });
  tracker.start();

  view('landing');
  t.mock.timers.tick(1000);
  assert.equal(calls.length, 1, '첫 주기에서 쓰기 시작');

  view('trending');
  t.mock.timers.tick(1000);
  view('repo');
  t.mock.timers.tick(1000);
  assert.equal(calls.length, 1, '진행 중에는 추가 쓰기 없음');
  assert.equal(tracker.pendingCount(), 2, '건너뛴 주기 동안 버퍼 누적');

  release();
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(1000);
  assert.equal(calls.length, 2, '완료 후 다음 주기에 재개');
  assert.deepEqual(calls[1].map((r) => r.path_template).sort(), ['repo', 'trending']);
  assert.equal(tracker.pendingCount(), 0);
  tracker.stop();
});

function cookieRes() {
  const res = {
    cookies: {},
    cleared: [],
    cookie(name, value, options) { res.cookies[name] = { value, options }; return res; },
    clearCookie(name) { res.cleared.push(name); return res; },
  };
  return res;
}

test('signup attribution: 유효한 from·locale만 10분 httpOnly 쿠키로 기억', () => {
  const attribution = createSignupAttribution({ addDailyMetrics: async () => {}, now: NOW });
  assert.equal(attribution.COOKIE, 'entry_route');

  const res = cookieRes();
  attribution.remember(res, { from: 'trending-topic', locale: 'ko' });
  assert.equal(res.cookies.entry_route.value, 'ko|trending-topic');
  assert.equal(res.cookies.entry_route.options.httpOnly, true);
  assert.equal(res.cookies.entry_route.options.sameSite, 'lax');
  assert.equal(res.cookies.entry_route.options.maxAge, 600000);

  for (const bad of [
    { from: '../etc', locale: 'ko' },
    { from: 'https://evil', locale: 'en' },
    { from: 'trending', locale: 'fr' },
    { from: undefined, locale: undefined },
    { from: ['trending'], locale: 'en' },
  ]) {
    const r = cookieRes();
    attribution.remember(r, bad);
    assert.equal('entry_route' in r.cookies, false, JSON.stringify(bad));
  }
});

test('signup attribution: consume은 항상 쿠키를 지우고 유효 값만 반환', () => {
  const attribution = createSignupAttribution({ addDailyMetrics: async () => {}, now: NOW });
  const cases = [
    [{ entry_route: 'en|repo' }, { template: 'repo', locale: 'en' }],
    [{ entry_route: 'ko|../etc' }, null],
    [{ entry_route: 'ko|repo|x' }, null],
    [{}, null],
    [undefined, null],
  ];
  for (const [cookies, expected] of cases) {
    const res = cookieRes();
    assert.deepEqual(attribution.consume({ cookies }, res), expected);
    assert.deepEqual(res.cleared, ['entry_route']);
  }
});

test('signup attribution: record는 signup 행 1개를 KST 일자로 기록', async () => {
  const calls = [];
  const attribution = createSignupAttribution({ addDailyMetrics: async (rows) => { calls.push(rows); }, now: NOW });
  await attribution.record({ template: 'trending-topic', locale: 'ko' });
  assert.deepEqual(calls, [[{
    day: '2026-10-20',
    event_kind: 'signup',
    path_template: 'trending-topic',
    locale: 'ko',
    referrer_domain: '',
    is_bot: 0,
    count: 1,
  }]]);
});
