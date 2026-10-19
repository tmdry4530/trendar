import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicData } from '../src/services/public-data.js';
import { measureCandidate, rankRising } from '../src/services/rising-score.js';
import { createTtlCache } from '../src/utils/ttl-cache.js';

const NOW = new Date('2026-10-19T12:00:00Z');
const feeds = [
  { kind: 'all', slug: 'all', name: { en: 'All', ko: '전체' }, query: '' },
  { kind: 'language', slug: 'javascript', name: { en: 'JavaScript', ko: '자바스크립트' }, query: 'language:JavaScript' },
  { kind: 'topic', slug: 'ai', name: { en: 'AI', ko: '인공지능' }, query: 'topic:ai' },
];
const repo = { id: 11, github_id: 111, full_name: 'Owner/Repo', owner: 'Owner', name: 'Repo', stars: 1000, description: 'Public repo', github_created_at: new Date('2026-10-15T12:00:00Z') };
const row = (id, rank, extra = {}) => ({ ...repo, id, name: id === 11 ? 'Repo' : `repo${id}`, rank, stars: 1000, rate_24h: 200, baseline_source: 'snapshot', ...extra });

function fixture({ configFeeds = feeds, rows = [[row(21, 1), row(11, 2)], [row(22, 1), row(11, 2)], [row(11, 1)]], rank = (candidates) => candidates, measure = () => ({ stars: 1000, rate_24h: 12, baseline_source: 'partial' }) } = {}) {
  let clock = NOW.getTime();
  const calls = {};
  const runs = configFeeds.map((feed, index) => ({ ...feed, id: index + 1, last_attempt_at: NOW, last_success_at: new Date(NOW.getTime() - index * 1000), last_status: 'ok', last_error_code: 'not-public' }));
  const record = (method, implementation) => async (...args) => {
    (calls[method] ??= []).push(args);
    return implementation(...args);
  };
  const model = {
    listFeedRuns: record('listFeedRuns', () => [...runs].reverse()),
    feedCandidates: record('feedCandidates', (id) => rows[id - 1] ?? []),
    findPublicRepo: record('findPublicRepo', () => repo),
    repoFeeds: record('repoFeeds', () => runs.map(({ id, kind, slug }) => ({ id, kind, slug }))),
    repoCandidate: record('repoCandidate', () => ({ ...repo, snapshots: [] })),
    repoSnapshots: record('repoSnapshots', () => [{ id: 1, stars: 100, forks: 5, captured_at: NOW }]),
  };
  const cache = createTtlCache({ ttlMs: 600_000, now: () => clock });
  const rankingCalls = [];
  const data = createPublicData({
    model, feeds: configFeeds, risingConfig: { windowDays: 15, minRate: 100, limit: 1 }, cache,
    rankRising: (...args) => { rankingCalls.push(args); return rank(...args); },
    measureCandidate: measure,
    now: () => new Date(clock),
  });
  return { data, model, cache, calls, runs, rankingCalls, advance: (ms) => { clock += ms; } };
}

test('feed index uses configuration order/names, null status before collection and caches runs', async () => {
  const { data, calls, runs } = fixture();
  runs.pop();
  const index = await data.getFeedIndex();
  assert.deepEqual(index.map(({ kind, slug }) => [kind, slug]), feeds.map(({ kind, slug }) => [kind, slug]));
  assert.deepEqual(index[0].name, feeds[0].name);
  assert.equal(index[2].last_status, null);
  assert.equal(index[2].last_success_at, null);
  assert.equal('id' in index[0], false);
  assert.equal('last_error_code' in index[0], false);
  assert.equal('query' in index[0], false);
  await data.getFeedIndex();
  assert.equal(calls.listFeedRuns.length, 1);
});

test('feed queries once, shares concurrent miss, ranks with limit 50 and expires at 10 minutes', async () => {
  const { data, calls, rankingCalls, advance } = fixture();
  const [first, second] = await Promise.all([data.getFeed('all', 'all'), data.getFeed('all', 'all')]);
  assert.equal(first, second);
  assert.equal(await data.getFeed('all', 'all'), first);
  assert.equal(calls.feedCandidates.length, 1);
  assert.deepEqual(calls.feedCandidates[0], [1, { windowDays: 15 }]);
  assert.equal(rankingCalls[0][1].limit, 50);
  assert.equal(rankingCalls[0][1].minRate, 100);
  assert.deepEqual(rankingCalls[0][2], NOW);
  assert.match(first.revision, /^[a-f0-9]{12}$/);
  advance(600_000);
  await data.getFeed('all', 'all');
  assert.equal(calls.feedCandidates.length, 2);
  assert.equal(calls.listFeedRuns.length, 2);
});

test('unknown feeds return null without model access; uncollected configured feeds are empty', async () => {
  const { data, runs, calls } = fixture();
  assert.equal(await data.getFeed('topic', 'unknown'), null);
  assert.deepEqual(calls, {});
  runs.pop();
  assert.deepEqual((await data.getFeed('topic', 'ai')).rows, []);
  assert.equal(calls.feedCandidates, undefined);
});

test('repository best uses minimum rank, loads 30 days and measures without exposure filtering', async () => {
  const { data, calls } = fixture();
  const result = await data.getRepo('Owner', 'Repo');
  assert.deepEqual(result.best, { kind: 'topic', slug: 'ai', name: feeds[2].name, rank: 1 });
  assert.equal(result.latest.rate_24h, 12);
  assert.deepEqual(result.snapshots, [{ stars: 100, forks: 5, captured_at: NOW }]);
  assert.deepEqual(calls.repoSnapshots, [[11, { days: 30 }]]);
  assert.equal(await data.getRepo('owner', 'repo'), result);
  assert.equal(calls.findPublicRepo.length, 1);
});

test('best ties prefer all, then language, then topic, then lexical slug', async () => {
  const allTie = fixture({ rows: [[row(11, 1)], [row(11, 1)], [row(11, 1)]] });
  assert.equal((await allTie.data.getRepo('Owner', 'Repo')).best.kind, 'all');
  const languageTie = fixture({ rows: [[], [row(11, 1)], [row(11, 1)]] });
  assert.equal((await languageTie.data.getRepo('Owner', 'Repo')).best.kind, 'language');
  const configFeeds = [feeds[0], { ...feeds[2], slug: 'z-last' }, feeds[2]];
  const slugTie = fixture({ configFeeds, rows: [[], [row(11, 1)], [row(11, 1)]] });
  assert.equal((await slugTie.data.getRepo('Owner', 'Repo')).best.slug, 'ai');
});

test('unranked repository retains measurement and memberships; absent candidate gives null latest', async () => {
  const { data, model, cache } = fixture({ rows: [[], [], []], measure: measureCandidate });
  model.repoCandidate = async () => ({ ...repo, snapshots: [
    { id: 1, stars: 988, captured_at: new Date(NOW.getTime() - 24 * 3_600_000) },
    { id: 2, stars: 1000, captured_at: NOW },
  ] });
  const result = await data.getRepo('Owner', 'Repo');
  assert.equal(result.latest.rate_24h, 12);
  assert.equal(result.best, null);
  assert.deepEqual(result.feeds.map(({ rank }) => rank), [null, null, null]);
  cache.clear();
  model.repoCandidate = async () => null;
  assert.equal((await data.getRepo('Owner', 'Repo')).latest, null);
});

test('unknown repository is cached as null and ignores disabled feed memberships', async () => {
  const { data, model, calls, cache } = fixture();
  model.findPublicRepo = async () => null;
  assert.equal(await data.getRepo('absent', 'repo'), null);
  assert.equal(await data.getRepo('absent', 'repo'), null);
  assert.equal(calls.repoFeeds, undefined);
  cache.clear();
  model.findPublicRepo = async () => repo;
  model.repoFeeds = async () => [{ id: 99, kind: 'topic', slug: 'disabled' }];
  const result = await data.getRepo('Owner', 'Repo');
  assert.deepEqual(result.feeds, []);
  assert.equal(result.best, null);
});

test('sitemap contains all configured feeds and case-insensitive repo union with newest success', async () => {
  const { data, runs } = fixture({ rows: [[row(11, 1)], [row(11, 1, { owner: 'owner', name: 'repo' }), row(22, 2)], []] });
  const result = await data.getSitemapEntries();
  assert.equal(result.feeds.length, 3);
  assert.equal(result.repos.length, 2);
  assert.deepEqual(result.repos[0], { owner: 'Owner', name: 'Repo', lastmod: runs[0].last_success_at });
  assert.equal(result.repos[1].lastmod, runs[1].last_success_at);
});

test('revision is stable, tracks rendered ranking fields and ignores non-rendered metadata', async () => {
  const { data } = fixture();
  const view = await data.getFeed('all', 'all');
  const before = data.revisionOf(view);
  assert.equal(data.revisionOf(structuredClone(view)), before);
  assert.equal(data.revisionOf({ ...view, internal: 'ignored', revision: 'ignored' }), before);
  const changed = structuredClone(view);
  changed.rows[0].rank++;
  assert.notEqual(data.revisionOf(changed), before);
  for (const [field, value] of [['stars', 5000], ['rate_24h', 500], ['baseline_source', 'creation']]) {
    const next = structuredClone(view);
    next.rows[0][field] = value;
    assert.notEqual(data.revisionOf(next), before);
  }
  const next = structuredClone(view);
  next.feed.last_success_at = new Date(NOW.getTime() + 1000);
  assert.notEqual(data.revisionOf(next), before);
  const repoView = await data.getRepo('Owner', 'Repo');
  const alteredRepo = structuredClone(repoView);
  alteredRepo.latest.rate_24h++;
  assert.notEqual(data.revisionOf(alteredRepo), data.revisionOf(repoView));
});

test('repository revision tracks best feed and each membership identity even when ranks match', async () => {
  const { data } = fixture({ rows: [[row(11, 1)], [row(11, 1)], [row(11, 1)]] });
  const view = await data.getRepo('Owner', 'Repo');
  const before = data.revisionOf(view);
  assert.equal(data.revisionOf(structuredClone(view)), before);
  for (const best of [view.feeds[1], { ...view.best, slug: 'other' }, null]) {
    const changed = structuredClone(view);
    changed.best = best;
    assert.notEqual(data.revisionOf(changed), before);
  }
  for (const [field, value] of [['kind', 'topic'], ['slug', 'other']]) {
    const changed = structuredClone(view);
    changed.feeds[1][field] = value;
    assert.notEqual(data.revisionOf(changed), before);
  }
});

test('model errors propagate, are not cached and can be retried', async () => {
  for (const method of ['listFeedRuns', 'feedCandidates', 'findPublicRepo', 'repoFeeds', 'repoCandidate', 'repoSnapshots']) {
    const { data, model } = fixture();
    const original = model[method];
    const failure = new Error(method);
    model[method] = async () => { throw failure; };
    const load = ['listFeedRuns', 'feedCandidates'].includes(method) ? () => data.getFeed('all', 'all') : () => data.getRepo('Owner', 'Repo');
    await assert.rejects(load(), (error) => error === failure);
    model[method] = original;
    assert.ok(await load());
  }
});

test('real shared ranking functions work through the injected data service', async () => {
  const candidate = { ...repo, snapshots: [
    { id: 1, stars: 800, captured_at: new Date(NOW.getTime() - 24 * 3_600_000) },
    { id: 2, stars: 1000, captured_at: NOW },
  ] };
  const { data } = fixture({ rows: [[candidate], [], []], rank: rankRising, measure: measureCandidate });
  const view = await data.getFeed('all', 'all');
  assert.equal(view.rows[0].rank, 1);
  assert.equal(view.rows[0].rate_24h, 200);
});
