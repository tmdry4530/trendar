import assert from 'node:assert/strict';
import test from 'node:test';
import { allFeeds } from '../src/config/public-feeds.js';
import { formatAgeDays, formatRate, formatStars, formatUtcDateTime } from '../src/utils/public-format.js';
import { badgePath, feedPath, localizedPath, repoPath } from '../src/utils/public-output.js';
import { t } from '../src/views/public-messages.js';
import { renderFeedPage, renderLandingPage, renderNotFoundPage, renderRepoPage } from '../src/views/public-pages.js';

const APP_URL = 'https://trendar.example';
const UPDATED = new Date('2026-10-19T06:00:00Z');
const MALICIOUS = '<script>alert(1)</script>&"<img onerror=x>';

const feedIndex = allFeeds({}).map(({ kind, slug, name }) => ({
  kind,
  slug,
  name,
  last_attempt_at: UPDATED,
  last_success_at: UPDATED,
  last_status: 'ok',
}));

function row(overrides) {
  return {
    id: 1,
    github_id: 101,
    full_name: 'acme/rocket',
    owner: 'acme',
    name: 'rocket',
    html_url: 'https://github.com/acme/rocket',
    description: 'A fast rocket',
    language: 'Rust',
    github_created_at: new Date('2026-10-15T00:00:00Z'),
    stars: 12345,
    star_delta_24h: 1800,
    growth_rate_24h: 0.17,
    rate_24h: 1800,
    baseline_source: 'snapshot',
    span_hours: 24,
    accel: 1.2,
    age_days: 3.2,
    captured_at: UPDATED,
    score: 900,
    rank: 1,
    ...overrides,
  };
}

function feedView(rows = [
  row({ description: MALICIOUS }),
  row({ id: 2, github_id: 102, full_name: 'nova/spark', owner: 'nova', name: 'spark', language: 'Go', stars: 950, rate_24h: 950.4, baseline_source: 'creation', span_hours: 14.5, age_days: 0.6, rank: 2 }),
], feed = {}) {
  return {
    feed: { kind: 'all', slug: 'all', name: { en: 'All', ko: '전체' }, last_attempt_at: UPDATED, last_success_at: UPDATED, last_status: 'ok', ...feed },
    rows,
    revision: 'abc123',
  };
}

function repoView(overrides = {}) {
  return {
    repo: {
      id: 1,
      github_id: 101,
      full_name: 'acme/rocket',
      owner: 'acme',
      name: 'rocket',
      html_url: 'https://github.com/acme/rocket',
      description: 'A fast rocket',
      language: 'Rust',
      stars: 12345,
      github_created_at: new Date('2026-10-15T00:00:00Z'),
      updated_at: UPDATED,
    },
    latest: { stars: 12345, star_delta_24h: 1800, growth_rate_24h: 0.17, rate_24h: 1800, baseline_source: 'snapshot', span_hours: 24, accel: 1.2, age_days: 3.2, captured_at: UPDATED },
    snapshots: [
      { stars: 9000, forks: 10, captured_at: new Date('2026-10-16T00:00:00Z') },
      { stars: 10000, forks: 11, captured_at: new Date('2026-10-17T00:00:00Z') },
      { stars: 11000, forks: 12, captured_at: new Date('2026-10-18T00:00:00Z') },
      { stars: 12345, forks: 13, captured_at: new Date('2026-10-19T00:00:00Z') },
    ],
    feeds: [
      { kind: 'all', slug: 'all', name: { en: 'All', ko: '전체' }, rank: 3 },
      { kind: 'language', slug: 'rust', name: { en: 'Rust', ko: 'Rust' }, rank: null },
    ],
    best: { kind: 'all', slug: 'all', name: { en: 'All', ko: '전체' }, rank: 3 },
    revision: 'def456',
    ...overrides,
  };
}

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => match[1]);
}

function count(html, needle) {
  return html.split(needle).length - 1;
}

function bodyOf(html) {
  return html.slice(html.indexOf('<body>'));
}

function hasEventHandlerAttribute(html) {
  return [...html.matchAll(/<[a-zA-Z][^>]*>/g)].some(([tag]) => /\son[a-z]+\s*=/i.test(tag.replace(/"[^"]*"/g, '""')));
}

function internalLinks(html) {
  return [...html.matchAll(/\s(?:href|src)="(\/[^"]*)"/g)].map((match) => match[1]);
}

function allowedLinks(locale, extra = []) {
  const allowed = new Set([localizedPath(locale, '/'), localizedPath(locale === 'ko' ? 'en' : 'ko', '/'), '/favicon.svg', '/pricing', '/terms', '/privacy', ...extra]);
  for (const target of ['en', 'ko']) {
    for (const feed of feedIndex) allowed.add(localizedPath(target, feedPath(feed.kind, feed.slug)));
  }
  for (const template of ['landing', 'trending', 'trending-language', 'trending-topic', 'repo', 'not-found']) {
    allowed.add(`/api/auth/github?from=${template}&locale=${locale}`);
  }
  return allowed;
}

test('formatters render stars, rates, ages and UTC timestamps', () => {
  assert.equal(formatStars(999), '999');
  assert.equal(formatStars(1234), '1.2k');
  assert.equal(formatStars(134000), '134k');
  assert.equal(formatStars(999_950), '1M');
  assert.equal(formatStars(2_500_000), '2.5M');
  assert.equal(formatRate(1234, 'en'), '+1,234/day');
  assert.equal(formatRate(1234.4, 'ko'), '+1,234/일');
  assert.equal(formatRate(-12, 'en'), '−12/day');
  assert.equal(formatAgeDays(3.9, 'en'), '3 days');
  assert.equal(formatAgeDays(1.2, 'en'), '1 day');
  assert.equal(formatAgeDays(0.4, 'en'), '<1 day');
  assert.equal(formatAgeDays(5, 'ko'), '5일');
  assert.equal(formatUtcDateTime(new Date('2026-10-19T06:00:00Z')), '2026-10-19 06:00 UTC');
  assert.equal(formatUtcDateTime(null), '—');
});

test('messages resolve per locale with interpolation and English fallback', () => {
  assert.equal(t('en', 'cta.track'), 'Track my keywords');
  assert.equal(t('ko', 'cta.track'), '내 키워드 추적하기');
  assert.equal(t('ko', 'feed.title.language', { name: 'Go' }), '급상승 Go 신규 프로젝트');
  assert.equal(t('xx', 'nav.trending'), 'Trending');
});

test('feed page carries title, canonical, hreflang, OG image and an ItemList JSON-LD', () => {
  const html = renderFeedPage({ locale: 'en', view: feedView(), feedIndex, appUrl: APP_URL });
  assert.match(html, /^<!doctype html>\n<html lang="en">/);
  assert.match(html, /<title>Trending new GitHub repositories \| Trendar<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]+">/);
  assert.ok(html.includes(`<link rel="canonical" href="${APP_URL}/trending">`));
  assert.equal(count(html, 'hreflang="en"'), 1);
  assert.equal(count(html, 'hreflang="ko"'), 1);
  assert.equal(count(html, 'hreflang="x-default"'), 1);
  assert.ok(html.includes(`<link rel="alternate" hreflang="x-default" href="${APP_URL}/trending">`));
  assert.ok(html.includes(`<link rel="alternate" hreflang="ko" href="${APP_URL}/ko/trending">`));
  assert.ok(html.includes(`<meta property="og:image" content="${APP_URL}/og/trending.png">`));
  assert.ok(html.includes('<meta property="og:image:width" content="1200">'));
  assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
  assert.ok(!html.includes('name="robots"'));
  const blocks = jsonLdBlocks(html);
  assert.equal(blocks.length, 1);
  const jsonLd = JSON.parse(blocks[0]);
  assert.equal(jsonLd['@type'], 'ItemList');
  assert.equal(jsonLd.itemListElement[0]['@type'], 'ListItem');
  assert.equal(jsonLd.itemListElement[0].position, 1);
  assert.equal(jsonLd.itemListElement[0].item['@type'], 'SoftwareSourceCode');
  assert.equal(jsonLd.itemListElement[0].item.url, `${APP_URL}/repo/acme/rocket`);
  assert.equal(jsonLd.itemListElement[0].item.description, MALICIOUS);
});

test('feed page escapes GitHub strings in HTML and JSON-LD', () => {
  const html = renderFeedPage({ locale: 'en', view: feedView(), feedIndex, appUrl: APP_URL });
  const body = bodyOf(html);
  assert.ok(!body.includes('<script>alert'));
  assert.ok(!body.includes('<img onerror'));
  assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&lt;img onerror=x&gt;'));
  assert.ok(jsonLdBlocks(html)[0].includes('\\u003cscript'));
  assert.ok(!jsonLdBlocks(html)[0].includes('<'));
  assert.equal(count(html, '<script'), 1);
  assert.ok(!/javascript:/i.test(html));
  assert.equal(hasEventHandlerAttribute(html), false);
});

test('feed rows show rank, name, stars, daily rate with estimate marker, age and last update', () => {
  const html = renderFeedPage({ locale: 'en', view: feedView(), feedIndex, appUrl: APP_URL });
  assert.match(html, /<td class="col-rank rank-top">1<\/td>/);
  assert.ok(html.includes(`<a class="repo-name" href="${repoPath('acme', 'rocket')}">acme/rocket</a>`));
  assert.ok(html.includes('href="https://github.com/acme/rocket"'));
  assert.ok(html.includes('★ 12.3k'));
  assert.ok(html.includes('+1,800/day'));
  assert.ok(html.includes('+950/day</span><span class="est">est.</span>'));
  assert.equal(count(html, '<span class="est">'), 1);
  assert.ok(html.includes('title="Estimated from 15 hours since the repository was created"'));
  assert.ok(html.includes('title="Measured over the last 24 hours of snapshots"'));
  assert.ok(html.includes('3 days'));
  assert.ok(html.includes('&lt;1 day'));
  assert.ok(html.includes('2026-10-19 06:00 UTC'));
  assert.ok(html.includes('<time datetime="2026-10-19T06:00:00.000Z">'));
});

test('empty feed shows a collection notice without sample repositories', () => {
  const pending = renderFeedPage({ locale: 'en', view: feedView([], { last_success_at: null }), feedIndex, appUrl: APP_URL });
  assert.ok(pending.includes(t('en', 'feed.emptyPending')));
  assert.ok(pending.includes(t('en', 'feed.neverUpdated')));
  const none = renderFeedPage({ locale: 'en', view: feedView([]), feedIndex, appUrl: APP_URL });
  assert.ok(none.includes(t('en', 'feed.emptyNone')));
  for (const html of [pending, none]) {
    assert.ok(!html.includes('<table'));
    assert.ok(!html.includes('/repo/'));
    assert.ok(!html.includes('acme'));
    assert.equal(JSON.parse(jsonLdBlocks(html)[0]).numberOfItems, 0);
  }
  const failed = renderFeedPage({ locale: 'en', view: feedView([], { last_status: 'error' }), feedIndex, appUrl: APP_URL });
  assert.ok(failed.includes(t('en', 'feed.lastFailed')));
});

test('Korean feed page is localized with /ko canonical and an English switch link', () => {
  const view = feedView(undefined, { kind: 'language', slug: 'python', name: { en: 'Python', ko: 'Python' } });
  const html = renderFeedPage({ locale: 'ko', view, feedIndex, appUrl: APP_URL });
  assert.match(html, /<html lang="ko">/);
  assert.ok(html.includes('<title>급상승 Python 신규 프로젝트 | Trendar</title>'));
  assert.ok(html.includes(`<link rel="canonical" href="${APP_URL}/ko/trending/language/python">`));
  assert.ok(html.includes('<a class="nav__lang" href="/trending/language/python" lang="en"'));
  assert.ok(html.includes(`<meta property="og:image" content="${APP_URL}/og/trending/language/python.png">`));
  assert.ok(html.includes('+1,800/일'));
  assert.ok(html.includes('<span class="est">추정</span>'));
  assert.ok(html.includes('href="/ko/repo/acme/rocket"'));
  assert.ok(html.includes('href="/api/auth/github?from=trending-language&locale=ko"'));
  assert.ok(html.includes('내 키워드 추적하기'));
  assert.ok(html.includes('<meta property="og:locale" content="ko_KR">'));
});

test('repo page shows sparkline, daily table, feeds with ranks, GitHub link and badge Markdown', () => {
  const html = renderRepoPage({ locale: 'en', view: repoView(), feedIndex, appUrl: APP_URL });
  assert.ok(html.includes('<title>acme/rocket — GitHub star growth | Trendar</title>'));
  assert.ok(html.includes(`<link rel="canonical" href="${APP_URL}/repo/acme/rocket">`));
  assert.ok(html.includes(`<meta property="og:image" content="${APP_URL}/og/repo/acme/rocket.png">`));
  assert.match(html, /<svg class="spark" viewBox="0 0 720 160" role="img" aria-label="Stars went from 9,000 to 12,345 over the last 30 days">/);
  assert.ok(html.includes('<td class="num">2026-10-19</td><td class="col-num">12,345</td><td class="col-num up">+1,345</td>'));
  assert.ok(html.includes('<a class="link" href="/trending">All</a><span class="pill pill--rank">#3</span>'));
  assert.ok(html.includes('<a class="link" href="/trending/language/rust">Rust</a><span class="faint num">Not in top 50</span>'));
  assert.ok(html.includes('href="https://github.com/acme/rocket"'));
  assert.ok(html.includes(`<img src="${badgePath('acme', 'rocket')}"`));
  assert.ok(html.includes(`<pre><code class="code">[![Trending on Trendar](${APP_URL}/badge/acme/rocket.svg)](${APP_URL}/repo/acme/rocket)</code></pre>`));
  const jsonLd = JSON.parse(jsonLdBlocks(html)[0]);
  assert.equal(jsonLd['@type'], 'SoftwareSourceCode');
  assert.equal(jsonLd.codeRepository, 'https://github.com/acme/rocket');
  assert.equal(jsonLd.dateCreated, '2026-10-15T00:00:00.000Z');
  assert.ok(html.includes('href="/api/auth/github?from=repo&locale=en"'));
});

test('repo page without a measurement says it cannot be measured', () => {
  const ko = renderRepoPage({ locale: 'ko', view: repoView({ latest: null, best: null, feeds: [], snapshots: [] }), feedIndex, appUrl: APP_URL });
  assert.ok(ko.includes('측정 불가'));
  assert.ok(ko.includes(t('ko', 'repo.historyEmpty')));
  assert.ok(ko.includes(t('ko', 'repo.feedsEmpty')));
  assert.ok(!ko.includes('class="spark"'));
  const en = renderRepoPage({ locale: 'en', view: repoView({ latest: null }), feedIndex, appUrl: APP_URL });
  assert.ok(en.includes('Not measurable yet'));
  assert.ok(en.includes('★ 12,345'));
});

test('repo page escapes a hostile description everywhere', () => {
  const view = repoView();
  view.repo = { ...view.repo, description: MALICIOUS };
  const html = renderRepoPage({ locale: 'en', view, feedIndex, appUrl: APP_URL });
  assert.equal(count(html, '<script'), 1);
  assert.ok(!html.includes('<img onerror'));
  assert.ok(jsonLdBlocks(html)[0].includes('\\u003cscript'));
  assert.equal(hasEventHandlerAttribute(html), false);
});

test('landing page shows the real top 10, feed links, CTA and WebSite + ItemList JSON-LD', () => {
  const rows = Array.from({ length: 12 }, (_, index) => row({ id: index + 1, full_name: `owner${index}/repo${index}`, owner: `owner${index}`, name: `repo${index}`, rank: index + 1 }));
  const html = renderLandingPage({ locale: 'en', view: feedView(rows), feedIndex, appUrl: APP_URL });
  assert.ok(html.includes('<title>Trendar — Find fast-growing GitHub projects</title>'));
  assert.ok(html.includes(`<link rel="canonical" href="${APP_URL}/">`));
  assert.ok(html.includes(`<link rel="alternate" hreflang="ko" href="${APP_URL}/ko">`));
  assert.ok(html.includes('owner9/repo9'));
  assert.ok(!html.includes('owner10/repo10'));
  assert.ok(html.includes('href="/api/auth/github?from=landing&locale=en"'));
  assert.ok(html.includes('class="feed-card" href="/trending/topic/mcp"'));
  const graph = JSON.parse(jsonLdBlocks(html)[0])['@graph'];
  assert.deepEqual(graph.map((node) => node['@type']), ['WebSite', 'ItemList']);
  assert.equal(graph[1].itemListElement.length, 10);
  const empty = renderLandingPage({ locale: 'ko', view: null, feedIndex, appUrl: APP_URL });
  assert.ok(empty.includes(t('ko', 'feed.emptyPending')));
});

test('not-found page is noindex and links to every feed', () => {
  const html = renderNotFoundPage({ locale: 'en', feedIndex, appUrl: APP_URL });
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  assert.ok(html.includes('href="/trending/language/python"'));
  assert.ok(html.includes('href="/trending/topic/llm"'));
  assert.ok(!html.includes('rel="canonical"'));
  assert.equal(count(html, '<script'), 0);
  const ko = renderNotFoundPage({ locale: 'ko', feedIndex, appUrl: APP_URL });
  assert.ok(ko.includes('href="/ko/trending/language/python"'));
  assert.ok(ko.includes('href="/api/auth/github?from=not-found&locale=ko"'));
});

test('render functions are pure and every internal link comes from the public-output helpers', () => {
  const cases = [
    ['en', () => feedView(), (view) => renderFeedPage({ locale: 'en', view, feedIndex, appUrl: APP_URL }), [repoPath('acme', 'rocket'), repoPath('nova', 'spark')]],
    ['ko', () => feedView(), (view) => renderFeedPage({ locale: 'ko', view, feedIndex, appUrl: APP_URL }), [localizedPath('ko', repoPath('acme', 'rocket')), localizedPath('ko', repoPath('nova', 'spark'))]],
    ['en', () => repoView(), (view) => renderRepoPage({ locale: 'en', view, feedIndex, appUrl: APP_URL }), [badgePath('acme', 'rocket'), repoPath('acme', 'rocket'), localizedPath('ko', repoPath('acme', 'rocket'))]],
    ['en', () => feedView(), (view) => renderLandingPage({ locale: 'en', view, feedIndex, appUrl: APP_URL }), [repoPath('acme', 'rocket'), repoPath('nova', 'spark')]],
    ['ko', () => null, () => renderNotFoundPage({ locale: 'ko', feedIndex, appUrl: APP_URL }), []],
  ];
  for (const [locale, makeView, render, extra] of cases) {
    const view = makeView();
    const before = structuredClone(view);
    const indexBefore = structuredClone(feedIndex);
    const first = render(view);
    assert.equal(typeof first, 'string');
    assert.equal(render(view), first);
    assert.deepEqual(view, before);
    assert.deepEqual(feedIndex, indexBefore);
    const allowed = allowedLinks(locale, extra);
    for (const link of internalLinks(first)) assert.ok(allowed.has(link), `unexpected internal link ${link}`);
  }
});
