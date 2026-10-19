import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Public from '../src/models/public.model.js';
import { pool } from '../src/config/db.js';

const PRIVATE_TABLES = /\b(FROM|JOIN|INTO|UPDATE)\s+(repos|repo_snapshots|users|sessions|watch_queries|subscriptions)\b/i;
const compact = (sql) => sql.replace(/\s+/g, ' ').trim();

async function withQueries(results, fn) {
  const original = pool.query;
  const calls = [];
  pool.query = async (sql, params) => {
    assert.doesNotMatch(sql, PRIVATE_TABLES);
    calls.push({ sql: compact(sql), params });
    assert.ok(results.length, `Unexpected query: ${sql}`);
    return [results.shift(), []];
  };
  try {
    const result = await fn(calls);
    assert.equal(results.length, 0);
    return { result, calls };
  } finally {
    pool.query = original;
  }
}

const NOW = new Date('2026-10-19T00:00:00Z');
const REPO = { id: 7, github_id: 100, full_name: 'owner/repo', owner: 'owner', name: 'repo', stars: 900 };
const SNAPSHOT = { id: 11, stars: 900, captured_at: NOW };

test('공개 SQL 빌더는 사용자 테이블을 참조하지 않고 파라미터를 순서대로 바인딩한다', () => {
  const queries = [
    [Public.buildFeedCandidatesQuery({ feedId: 3, windowDays: 15, membershipHours: 48 }), [3, 48, 15]],
    [Public.buildSnapshotsRangeQuery([7, 8], 4), [7, 8, 4]],
    [Public.buildEarliestSnapshotsQuery([7, 8]), [7, 8]],
    [Public.buildRepoSnapshotsQuery(7, 30), [7, 30]],
  ];
  for (const [{ sql, params }, expected] of queries) {
    assert.doesNotMatch(sql, PRIVATE_TABLES);
    assert.deepEqual(params, expected);
    const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)].map((match) => match[1]);
    assert.ok(tables.length);
    assert.ok(tables.every((table) => table.startsWith('public_')));
  }
});

test('피드 후보는 멤버십·생성일 범위를 적용하고 랭킹 전 LIMIT을 적용하지 않는다', () => {
  const { sql } = Public.buildFeedCandidatesQuery({ feedId: 3, windowDays: 15, membershipHours: 48 });
  assert.match(sql, /last_seen_at >= DATE_SUB\(NOW\(\), INTERVAL \? HOUR\)/);
  assert.match(sql, /github_created_at >= DATE_SUB\(NOW\(\), INTERVAL \? DAY\)/);
  assert.match(sql, /FORCE INDEX \(idx_feed_seen\)/);
  assert.doesNotMatch(sql, /\bLIMIT\b/i);
});

test('스냅샷 범위는 인덱스·시각 및 id 순서를 사용하고 최초 스냅샷도 같은 인덱스로 고른다', () => {
  const range = compact(Public.buildSnapshotsRangeQuery([7], 4).sql);
  assert.match(range, /FORCE INDEX \(idx_repo_time\)/);
  assert.match(range, /captured_at >= DATE_SUB\(NOW\(\), INTERVAL \? DAY\)/);
  assert.match(range, /ORDER BY repo_id ASC, captured_at ASC, id ASC/);
  const earliest = compact(Public.buildEarliestSnapshotsQuery([7]).sql);
  assert.match(earliest, /FORCE INDEX \(idx_repo_time\)/);
  assert.match(earliest, /ORDER BY first.captured_at ASC, first.id ASC LIMIT 1/);
  const history = compact(Public.buildRepoSnapshotsQuery(7, 30).sql);
  assert.match(history, /ORDER BY captured_at ASC, id ASC/);
  assert.match(Public.buildSnapshotsRangeQuery([], 4).sql, /IN \(NULL\)/);
  assert.match(Public.buildEarliestSnapshotsQuery([]).sql, /IN \(NULL\)/);
});

test('ensureFeeds는 INSERT IGNORE 후 조회한 id를 피드 키 Map으로 반환한다', async () => {
  const { result, calls } = await withQueries([{}, [{ id: 3, kind: 'all', slug: 'all' }, { id: 4, kind: 'topic', slug: 'llm' }]],
    () => Public.ensureFeeds([{ kind: 'all', slug: 'all' }, { kind: 'topic', slug: 'llm' }]));
  assert.deepEqual(result, new Map([['all:all', 3], ['topic:llm', 4]]));
  assert.match(calls[0].sql, /^INSERT IGNORE INTO public_feeds/);
  assert.deepEqual(calls.map(({ params }) => params), [['all', 'all', 'topic', 'llm'], ['all', 'all', 'topic', 'llm']]);
  await withQueries([], async () => assert.deepEqual(await Public.ensureFeeds([]), new Map()));
});

test('레포 upsert는 메타데이터를 갱신하고 삽입·중복 모두 안정적인 repo id를 반환한다', async () => {
  const repo = { ...REPO, html_url: 'https://github.com/owner/repo', description: 'desc', language: 'Go', github_created_at: NOW };
  const { result, calls } = await withQueries([{ insertId: 7 }], () => Public.upsertPublicRepo(repo));
  assert.equal(result, 7);
  assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID\(id\)/);
  assert.match(calls[0].sql, /stars = VALUES\(stars\)/);
  assert.match(calls[0].sql, /github_created_at = VALUES\(github_created_at\)/);
  assert.deepEqual(calls[0].params, [100, 'owner/repo', 'owner', 'repo', repo.html_url, 'desc', 'Go', 900, NOW]);
});

test('스냅샷과 멤버십을 명시한 시각으로 저장한다', async () => {
  const { calls } = await withQueries([{}, {}], async () => {
    await Public.insertPublicSnapshot(7, { stars: 900, forks: 10, open_issues: 2, watchers: 4 }, NOW);
    await Public.upsertFeedMembership(3, 7, NOW);
  });
  assert.deepEqual(calls[0].params, [7, 900, 10, 2, 4, NOW]);
  assert.deepEqual(calls[1].params, [3, 7, NOW]);
  assert.match(calls[1].sql, /ON DUPLICATE KEY UPDATE last_seen_at = VALUES\(last_seen_at\)/);
});

test('피드 시도·성공·실패를 기록하고 실패 시 기존 성공 시각을 유지한다', async () => {
  const { calls } = await withQueries([{}, {}, {}], async () => {
    await Public.markFeedAttempt(3, NOW);
    await Public.markFeedResult(3, { status: 'ok', errorCode: 'old', at: NOW });
    await Public.markFeedResult(3, { status: 'error', errorCode: 'HTTP_500', at: NOW });
  });
  assert.deepEqual(calls[0].params, [NOW, 3]);
  assert.deepEqual(calls[1].params, ['ok', NOW, 3]);
  assert.match(calls[1].sql, /last_success_at = \?, last_error_code = NULL/);
  assert.deepEqual(calls[2].params, ['error', 'HTTP_500', 3]);
  assert.doesNotMatch(calls[2].sql, /last_success_at/);
});

test('피드 후보는 정확히 3쿼리로 최근 스냅샷과 최초 스냅샷을 조립한다', async () => {
  const earliest = { id: 1, stars: 1, captured_at: new Date('2026-10-01') };
  const { result, calls } = await withQueries([
    [REPO, { ...REPO, id: 8 }], [{ repo_id: 7, ...SNAPSHOT }], [{ repo_id: 7, ...earliest }],
  ], () => Public.feedCandidates(3, { windowDays: 15 }));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(({ params }) => params), [[3, 48, 15], [7, 8, 4], [7, 8]]);
  assert.deepEqual(result, [
    { ...REPO, snapshots: [SNAPSHOT], earliest },
    { ...REPO, id: 8, snapshots: [], earliest: null },
  ]);
});

test('후보가 없으면 스냅샷 쿼리를 실행하지 않는다', async () => {
  const { result, calls } = await withQueries([[]], () => Public.feedCandidates(3, { windowDays: 15 }));
  assert.deepEqual(result, []);
  assert.equal(calls.length, 1);
});

test('레포 후보는 id 조회와 스냅샷 2쿼리를 사용하고 미존재면 null이다', async () => {
  const { result, calls } = await withQueries([[REPO], [{ repo_id: 7, ...SNAPSHOT }], [{ repo_id: 7, ...SNAPSHOT }]],
    () => Public.repoCandidate(7, { recentDays: 2 }));
  assert.deepEqual(result, { ...REPO, snapshots: [SNAPSHOT], earliest: SNAPSHOT });
  assert.deepEqual(calls.map(({ params }) => params), [[7], [7, 2], [7]]);
  const missing = await withQueries([[]], () => Public.repoCandidate(99));
  assert.equal(missing.result, null);
});

test('공개 레포 조회는 최근 갱신 행을 선택하고 미존재면 null이다', async () => {
  const { result, calls } = await withQueries([[REPO]], () => Public.findPublicRepo('owner', 'repo'));
  assert.deepEqual(result, REPO);
  assert.match(calls[0].sql, /ORDER BY updated_at DESC, id DESC LIMIT 1/);
  assert.deepEqual(calls[0].params, ['owner', 'repo']);
  assert.equal((await withQueries([[]], () => Public.findPublicRepo('none', 'none'))).result, null);
});

test('공개 이력·소속 피드·수집 상태 조회가 기본 범위를 사용한다', async () => {
  const runs = [{ id: 3, kind: 'all', slug: 'all' }];
  const { calls } = await withQueries([[SNAPSHOT], runs, runs], async () => {
    assert.deepEqual(await Public.repoSnapshots(7), [SNAPSHOT]);
    assert.deepEqual(await Public.repoFeeds(7), runs);
    assert.deepEqual(await Public.listFeedRuns(), runs);
  });
  assert.deepEqual(calls[0].params, [7, 30]);
  assert.deepEqual(calls[1].params, [7, 48]);
  assert.match(calls[1].sql, /last_seen_at >= DATE_SUB\(NOW\(\), INTERVAL \? HOUR\)/);
  assert.match(calls[2].sql, /last_attempt_at, last_success_at, last_status, last_error_code/);
});

test('일별 집계는 다중 행 INSERT 1회로 누적하고 빈 배치는 조회하지 않는다', async () => {
  const rows = [
    { day: '2026-10-19', event_kind: 'page_view', path_template: 'trending', locale: 'en', referrer_domain: 'github.com', is_bot: 0, count: 4 },
    { day: '2026-10-19', event_kind: 'signup', path_template: 'repo', locale: 'ko', referrer_domain: '', is_bot: 0, count: 2 },
  ];
  const { calls } = await withQueries([{}], () => Public.addDailyMetrics(rows));
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /VALUES \(\?, \?, \?, \?, \?, \?, \?\), \(\?, \?, \?, \?, \?, \?, \?\)/);
  assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE event_count = event_count \+ VALUES\(event_count\)/);
  assert.deepEqual(calls[0].params, ['2026-10-19', 'page_view', 'trending', 'en', 'github.com', 0, 4, '2026-10-19', 'signup', 'repo', 'ko', '', 0, 2]);
  await withQueries([], () => Public.addDailyMetrics([]));
});
