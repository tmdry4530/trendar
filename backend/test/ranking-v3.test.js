// test/ranking-v3.test.js — 랭킹 v3: 윈도우 델타·점수(순수 함수)와 추적 레포 배치 갱신(octokit.graphql 모킹)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowDelta, rankingScore, computeRankingDelta, computeDelta, normalizeRepo } from '../src/etl/transform.js';
import { createEtlRunner, chunk, REFRESH_BATCH_SIZE, REFRESH_NODES_QUERY } from '../src/etl/pipeline.js';

const H = 3600;

// ── 순수 함수 ─────────────────────────────────────────────

test('windowDelta: 기준 스냅샷이 있으면 그대로 차이 (수집 간격과 무관)', () => {
  assert.equal(windowDelta(1500, { stars: 1200, age_sec: 30 * H }, { stars: 100, age_sec: 900 * H }, 24), 300);
});

test('windowDelta: 기준선 없음 → 가장 오래된 스냅샷으로 선형 환산 (24h/경과시간)', () => {
  // 6시간 전 1000 → 지금 1060: 60 * 24/6 = 240
  assert.equal(windowDelta(1060, null, { stars: 1000, age_sec: 6 * H }, 24), 240);
  // 7일 윈도우: 2일 전 1000 → 1100: 100 * 168/48 = 350
  assert.equal(windowDelta(1100, null, { stars: 1000, age_sec: 48 * H }, 168), 350);
});

test('windowDelta: 경과 시간 하한 1시간 (수동 수집 연타 시 과대 환산 방지)', () => {
  // 10분 전 스냅샷 대비 +5 → 1시간으로 간주 → 5 * 24 = 120 (10분 그대로면 720)
  assert.equal(windowDelta(105, null, { stars: 100, age_sec: 600 }, 24), 120);
  assert.equal(windowDelta(105, null, { stars: 100, age_sec: 0 }, 24), 120);
});

test('windowDelta: 현재 스냅샷만 있으면 0, 감소는 음수 유지', () => {
  assert.equal(windowDelta(500, null, null, 24), 0);
  assert.equal(windowDelta(990, { stars: 1000, age_sec: 25 * H }, null, 24), -10);
  assert.ok(Object.is(windowDelta(100, null, { stars: 100, age_sec: 3 * H }, 24), 0), '-0이 아닌 0');
});

test('rankingScore: delta_24h / sqrt(max(stars - delta_24h, 10))', () => {
  assert.equal(rankingScore(10100, 100), 100 / 100);
  assert.equal(rankingScore(15, 10), 10 / Math.sqrt(10), '분모 하한 10');
  // 순수 비율 편향 완화: 소형(50→100, +50) vs 대형(10000→10500, +500)
  // 비율로는 20배 차이(1.0 vs 0.05)지만 점수로는 1.5배 이내로 좁혀진다.
  const small = rankingScore(100, 50);
  const big = rankingScore(10500, 500);
  assert.ok(small / big < 1.5);
  assert.ok((50 / 50) / (500 / 10000) === 20);
  // 같은 증가량이면 작은 레포가 앞선다(초기 모멘텀은 여전히 반영)
  assert.ok(rankingScore(1100, 100) > rankingScore(10100, 100));
});

test('computeRankingDelta: 24h/7d 델타·growth_rate(24시간 전 기준)·score를 함께 계산', () => {
  const r = computeRankingDelta(1300, {
    base24h: { stars: 1200, age_sec: 25 * H },
    base7d: { stars: 600, age_sec: 170 * H },
    oldest: { stars: 500, age_sec: 400 * H },
  });
  assert.equal(r.delta_24h, 100);
  assert.equal(r.delta_7d, 700);
  assert.equal(r.growth_rate, 100 / 1200);
  assert.equal(r.score, 100 / Math.sqrt(1200));
});

test('computeRankingDelta: 7d 기준선만 없을 때 oldest로 7일 환산, 스냅샷 1개면 전부 0', () => {
  const r = computeRankingDelta(1300, { base24h: { stars: 1200, age_sec: 30 * H }, base7d: null, oldest: { stars: 1000, age_sec: 84 * H } });
  assert.equal(r.delta_24h, 100);
  assert.equal(r.delta_7d, 600); // 300 * 168/84
  const z = computeRankingDelta(1300, {});
  assert.deepEqual(z, { delta_24h: 0, delta_7d: 0, growth_rate: 0, score: 0 });
});

test('normalizeRepo: Search API node_id를 보존한다', () => {
  const r = normalizeRepo({ id: 1, node_id: 'R_kgDO1', full_name: 'o/r', name: 'r' }, 1, 1);
  assert.equal(r.node_id, 'R_kgDO1');
  assert.equal(normalizeRepo({ id: 2, full_name: 'o/r2', name: 'r2' }, 1, 1).node_id, null);
});

test('chunk: 100개 단위 분할', () => {
  const ids = Array.from({ length: 250 }, (_, i) => i);
  const parts = chunk(ids, REFRESH_BATCH_SIZE);
  assert.deepEqual(parts.map((p) => p.length), [100, 100, 50]);
  assert.deepEqual(chunk([], 100), []);
});

// ── 추적 레포 배치 갱신 ─────────────────────────────────────

function makeUsers(byId) {
  const calls = { setTokenInvalid: [], updateEtlResult: [] };
  return {
    calls,
    findById: async (id) => byId[id] ?? null,
    findAllWithValidToken: async () => [],
    setTokenInvalid: async (id) => { calls.setTokenInvalid.push(id); },
    updateEtlResult: async (id, r) => { calls.updateEtlResult.push({ id, ...r }); },
  };
}

function makeLoaders(tracked) {
  const calls = { upsertRepo: [], insertSnapshot: [], updateRepoDelta: [], findTrackedRepos: [] };
  return {
    calls,
    upsertRepo: async (repo) => { calls.upsertRepo.push(repo); return 9000 + repo.github_id; },
    updateRepoDelta: async (id, d) => { calls.updateRepoDelta.push({ id, d }); },
    insertSnapshot: async (id, m) => { calls.insertSnapshot.push({ id, m }); },
    getLastSnapshot: async () => ({ stars: 100 }),
    getDeltaBaselines: async () => ({ base24h: { stars: 100, age_sec: 30 * H }, base7d: null, oldest: { stars: 100, age_sec: 30 * H } }),
    findTrackedRepos: async (userId, days) => { calls.findTrackedRepos.push({ userId, days }); return tracked; },
  };
}

function node(nodeId, stars) {
  return {
    id: nodeId, databaseId: 1, stargazerCount: stars, forkCount: 3,
    watchers: { totalCount: 4 }, issues: { totalCount: 5 }, pullRequests: { totalCount: 2 },
  };
}

function rawItem(id, stars = 120) {
  return { id, node_id: `N${id}`, full_name: `o/r${id}`, owner: { login: 'o' }, name: `r${id}`, stargazers_count: stars };
}

function makeRunner({ users, loaders, graphql, extract = async () => [] }) {
  return createEtlRunner({
    users,
    decryptToken: (enc) => enc,
    createOctokit: () => ({ graphql }),
    extractRepos: extract,
    normalizeRepo,
    computeDelta,
    loaders,
    queryFn: async () => [{ id: 1, query: 'q', query_type: 'keyword' }],
  });
}

const user = { 1: { id: 1, login: 'u', access_token_enc: 'tok', token_invalid: false } };

test('추적 갱신: 이번 실행에서 본 레포·node_id 없는 레포는 제외하고 100개씩 nodes(ids:) 호출', async () => {
  // github_id 1은 검색 적중(이미 seen), 2는 node_id 없음, 3..252는 갱신 대상(250개)
  const tracked = [
    { id: 11, github_id: 1, node_id: 'N1', stars: 100 },
    { id: 12, github_id: 2, node_id: null, stars: 100 },
    ...Array.from({ length: 250 }, (_, i) => ({ id: 100 + i, github_id: String(3 + i), node_id: `N${3 + i}`, stars: 100 })),
  ];
  const graphqlCalls = [];
  const graphql = async (query, vars) => {
    graphqlCalls.push({ query, vars });
    return { nodes: vars.ids.map((id) => node(id, 150)) };
  };
  const users = makeUsers(user);
  const loaders = makeLoaders(tracked);
  const runner = makeRunner({ users, loaders, graphql, extract: async () => [rawItem(1)] });

  const result = await runner.runPipelineForUser(1);

  assert.deepEqual(loaders.calls.findTrackedRepos, [{ userId: 1, days: 14 }], '기본 14일 창');
  assert.equal(graphqlCalls.length, 3);
  assert.deepEqual(graphqlCalls.map((c) => c.vars.ids.length), [100, 100, 50]);
  assert.equal(graphqlCalls[0].query, REFRESH_NODES_QUERY);
  assert.ok(!graphqlCalls.flatMap((c) => c.vars.ids).includes('N1'), '검색 적중 레포는 재조회하지 않음');
  assert.equal(result.repos_upserted, 1);
  assert.equal(result.repos_refreshed, 250);
  assert.equal(result.refresh_skipped_no_node_id, 1);
  assert.equal(result.snapshots_inserted, 251);
  assert.equal(users.calls.updateEtlResult[0].status, 'ok');

  // 갱신 레포: 스냅샷 지표 매핑 + stars 동반 갱신 + 시간 정규화 델타
  const snap = loaders.calls.insertSnapshot.find((c) => c.id === 100);
  assert.deepEqual(snap.m, { stars: 150, forks: 3, open_issues: 7, watchers: 150 });
  const upd = loaders.calls.updateRepoDelta.find((c) => c.id === 100);
  assert.equal(upd.d.stars, 150);
  assert.equal(upd.d.delta_24h, 50);
  assert.equal(upd.d.star_delta, 50);
  assert.equal(upd.d.score, 50 / Math.sqrt(100));
  // 검색 적중 레포는 stars를 upsert로 갱신하므로 updateRepoDelta에 stars를 넘기지 않는다
  const hit = loaders.calls.updateRepoDelta.find((c) => c.id === 9001);
  assert.equal(hit.d.stars, undefined);
  assert.equal(hit.d.delta_24h, 20);
});

test('추적 갱신: 삭제된 노드(null)·부분 오류 응답은 남은 노드만 갱신', async () => {
  const tracked = [
    { id: 21, github_id: 21, node_id: 'A', stars: 100 },
    { id: 22, github_id: 22, node_id: 'B', stars: 100 },
  ];
  const graphql = async () => {
    const e = new Error('Could not resolve to a node with the global id of B');
    e.data = { nodes: [node('A', 130), null] };
    throw e;
  };
  const users = makeUsers(user);
  const loaders = makeLoaders(tracked);
  const result = await makeRunner({ users, loaders, graphql }).runPipelineForUser(1);

  assert.equal(result.repos_refreshed, 1);
  assert.deepEqual(loaders.calls.insertSnapshot.map((c) => c.id), [21]);
  assert.equal(result.errors.length, 0);
});

test('추적 갱신: 비401 오류는 errors에 기록하고 다음 배치 계속', async () => {
  const tracked = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, github_id: i + 1, node_id: `N${i}`, stars: 100 }));
  let n = 0;
  const graphql = async (q, vars) => {
    n++;
    if (n === 1) throw Object.assign(new Error('server error'), { status: 502 });
    return { nodes: vars.ids.map((id) => node(id, 110)) };
  };
  const users = makeUsers(user);
  const loaders = makeLoaders(tracked);
  const result = await makeRunner({ users, loaders, graphql }).runPipelineForUser(1);

  assert.equal(n, 2);
  assert.equal(result.repos_refreshed, 50);
  assert.deepEqual(result.errors, ['추적 중인 프로젝트를 갱신하지 못했습니다.']);
  assert.doesNotMatch(result.errors.join(' '), /server error|502/);
  assert.equal(users.calls.updateEtlResult[0].status, 'error');
  assert.equal(users.calls.setTokenInvalid.length, 0);
});

test('추적 갱신: GraphQL 401 → 토큰 무효화 + 409 GITHUB_TOKEN_INVALID', async () => {
  const tracked = [{ id: 1, github_id: 1, node_id: 'N1', stars: 100 }];
  const graphql = async () => { throw Object.assign(new Error('Bad credentials'), { status: 401 }); };
  const users = makeUsers(user);
  const loaders = makeLoaders(tracked);
  const runner = makeRunner({ users, loaders, graphql });

  await assert.rejects(runner.runPipelineForUser(1), (e) => e.status === 409 && e.code === 'GITHUB_TOKEN_INVALID');
  assert.deepEqual(users.calls.setTokenInvalid, [1]);
  assert.equal(users.calls.updateEtlResult[0].status, 'token_invalid');
  assert.equal(runner.isRunning(1), false, '락 해제');
});

test('추적 갱신: TRACKED_REFRESH_DAYS 환경변수, 대상 없으면 graphql 미호출', async () => {
  const prev = process.env.TRACKED_REFRESH_DAYS;
  process.env.TRACKED_REFRESH_DAYS = '7';
  try {
    let called = false;
    const loaders = makeLoaders([]);
    await makeRunner({ users: makeUsers(user), loaders, graphql: async () => { called = true; } }).runPipelineForUser(1);
    assert.deepEqual(loaders.calls.findTrackedRepos, [{ userId: 1, days: 7 }]);
    assert.equal(called, false);
  } finally {
    if (prev === undefined) delete process.env.TRACKED_REFRESH_DAYS; else process.env.TRACKED_REFRESH_DAYS = prev;
  }
});


test('추적 갱신: 부분 응답의 누락된 스타 수는 0으로 저장하지 않는다', async () => {
  const tracked = [{ id: 1, github_id: 1, node_id: 'N1' }, { id: 2, github_id: 2, node_id: 'N2' }];
  const loaders = makeLoaders(tracked);
  const graphql = async () => ({ nodes: [{ id: 'N1', stargazerCount: null }, node('N2', 130)] });
  const result = await makeRunner({ users: makeUsers(user), loaders, graphql }).runPipelineForUser(1);
  assert.deepEqual(loaders.calls.insertSnapshot.map(c => c.id), [2]);
  assert.equal(result.repos_refreshed, 1);
  assert.equal(result.errors.length, 1);
});

test('추적 갱신: 개별 저장 실패 후 나머지 레포 갱신을 계속한다', async () => {
  const tracked = [{ id: 1, github_id: 1, node_id: 'N1' }, { id: 2, github_id: 2, node_id: 'N2' }];
  const loaders = makeLoaders(tracked);
  const insert = loaders.insertSnapshot;
  loaders.insertSnapshot = async (id, metrics) => {
    if (id === 1) throw new Error('simulated write failure');
    return insert(id, metrics);
  };
  const graphql = async () => ({ nodes: [node('N1', 120), node('N2', 130)] });
  const result = await makeRunner({ users: makeUsers(user), loaders, graphql }).runPipelineForUser(1);
  assert.deepEqual(loaders.calls.insertSnapshot.map(c => c.id), [2]);
  assert.equal(result.repos_refreshed, 1);
  assert.equal(result.errors.length, 1);
});
