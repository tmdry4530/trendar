import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPublicCollector } from '../src/etl/public-pipeline.js';
import { rankRising } from '../src/services/rising-score.js';
import { buildPublicSearchQuery, searchPublicRepos, createPacer } from '../src/etl/public-extract.js';
import { normalizeRepo } from '../src/etl/transform.js';
import { allFeeds, feedKey } from '../src/config/public-feeds.js';

const NOW = Date.parse('2026-10-19T10:00:00Z');
const FEEDS = allFeeds({});

function rawItem(id, extra = {}) {
  return {
    id, full_name: `octo/repo-${id}`, owner: { login: 'octo' }, name: `repo-${id}`,
    html_url: `https://github.com/octo/repo-${id}`, description: 'Public repository', language: 'Python',
    stargazers_count: 100, forks_count: 10, open_issues_count: 2, watchers_count: 5,
    created_at: '2026-10-10T00:00:00Z', private: false, ...extra,
  };
}

function fixture(overrides = {}) {
  let clock = NOW;
  const calls = { model: [], searches: [], sleeps: [], octokit: [], warnings: [], errors: [] };
  const feeds = overrides.feeds ?? FEEDS.slice(0, 3);
  const record = (method, ...args) => calls.model.push({ method, args });
  const model = {
    ensureFeeds: async (list) => {
      record('ensureFeeds', list);
      return new Map(list.map((feed, index) => [feedKey(feed.kind, feed.slug), index + 1]));
    },
    upsertPublicRepo: async (repo) => { record('upsertPublicRepo', repo); return repo.github_id + 1000; },
    insertPublicSnapshot: async (...args) => { record('insertPublicSnapshot', ...args); },
    upsertFeedMembership: async (...args) => { record('upsertFeedMembership', ...args); },
    markFeedAttempt: async (...args) => { record('markFeedAttempt', ...args); },
    markFeedResult: async (...args) => { record('markFeedResult', ...args); },
    feedCandidates: async (...args) => { record('feedCandidates', ...args); return overrides.candidates?.(args[0]) ?? []; },
    insertRankHistory: async (...args) => {
      record('insertRankHistory', ...args);
      if (overrides.insertRankHistory) await overrides.insertRankHistory(...args);
    },
  };
  const octokit = { rest: { search: { repos: async (options) => {
    calls.searches.push({ ...options, startedAt: clock });
    const items = await (overrides.search ?? (() => []))(calls.searches.length, options, (ms) => { clock += ms; });
    return { data: { items } };
  } } } };
  const deps = {
    token: 'tok-secret',
    createOctokit: (token) => { calls.octokit.push(token); return octokit; },
    feeds, model, normalizeRepo, searchRepos: searchPublicRepos, buildQuery: buildPublicSearchQuery,
    pacer: createPacer({ intervalMs: 2100, now: () => clock, sleep: async (ms) => {
      calls.sleeps.push(ms);
      clock += ms;
    } }),
    windowDays: 15, minStars: 20, now: () => new Date(clock),
    rankRising, risingConfig: { windowDays: 15, freshHours: 13, minRate: 100, minGrowth: 0.1, absPass: 500 },
    log: { warn: (...args) => calls.warnings.push(args), error: (...args) => calls.errors.push(args) },
    ...overrides.deps,
  };
  return { runner: createPublicCollector(deps), calls, model, deps };
}

function modelCalls(calls, method) {
  return calls.model.filter((call) => call.method === method).map((call) => call.args);
}

test('공개 수집: 기본 33개 피드를 설정 순서대로 검색하고 시작 간격은 2100ms 이상이다', async () => {
  const { runner, calls } = fixture({ feeds: FEEDS });
  const result = await runner.runPublicCollection();
  assert.deepEqual(result, {
    feeds_total: 33, feeds_ok: 33, feeds_failed: 0, repos_upserted: 0, snapshots_inserted: 0, ranks_recorded: 0, aborted: false,
  });
  assert.equal(calls.searches.length, 33);
  calls.searches.forEach((call, index) => {
    assert.equal(call.q, buildPublicSearchQuery(FEEDS[index], { createdAfter: '2026-10-04', minStars: 20 }));
    assert.equal(call.sort, 'stars');
    assert.equal(call.order, 'desc');
    assert.equal(call.per_page, 100);
    if (index > 0) assert.ok(call.startedAt - calls.searches[index - 1].startedAt >= 2100);
  });
  assert.equal(calls.sleeps.length, 32);
  assert.deepEqual(calls.octokit, ['tok-secret']);
  assert.equal(modelCalls(calls, 'markFeedAttempt').length, 33);
  assert.ok(modelCalls(calls, 'markFeedResult').every(([, result]) => result.status === 'ok' && result.errorCode === null));
  assert.equal(runner.isPublicCollectionRunning(), false);
});

test('공개 수집: 느린 검색 뒤에는 추가 sleep 없이 다음 검색을 시작한다', async () => {
  const { runner, calls } = fixture({ search: (_index, _query, advance) => { advance(3000); return []; } });
  await runner.runPublicCollection();
  assert.deepEqual(calls.sleeps, []);
  assert.deepEqual(calls.searches.map((call) => call.startedAt), [NOW, NOW + 3000, NOW + 6000]);
});

test('공개 수집: 피드 간 스냅샷은 github_id로 중복 제거하고 멤버십은 각각 저장한다', async () => {
  const { runner, calls } = fixture({ feeds: FEEDS.slice(0, 2), search: () => [rawItem(7)] });
  const result = await runner.runPublicCollection();
  assert.equal(result.repos_upserted, 2);
  assert.equal(result.snapshots_inserted, 1);
  assert.equal(modelCalls(calls, 'upsertPublicRepo').length, 2);
  const snapshots = modelCalls(calls, 'insertPublicSnapshot');
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0][0], 1007);
  assert.equal(snapshots[0][1].stars, 100);
  assert.equal(snapshots[0][1].forks, 10);
  assert.equal(snapshots[0][1].open_issues, 2);
  assert.equal(snapshots[0][1].watchers, 5);
  assert.deepEqual(snapshots[0][1].github_created_at, new Date('2026-10-10T00:00:00Z'));
  assert.deepEqual(snapshots[0][2], new Date(NOW));
  assert.deepEqual(modelCalls(calls, 'upsertFeedMembership'), [[1, 1007, new Date(NOW)], [2, 1007, new Date(NOW)]]);
});

test('공개 수집: private:true 항목은 정규화·upsert·snapshot·membership 없이 제외한다', async () => {
  let normalized = 0;
  const { runner, calls } = fixture({ search: () => [rawItem(7, { private: true })], deps: {
    normalizeRepo: (raw) => { normalized++; return normalizeRepo(raw); },
  } });
  const result = await runner.runPublicCollection();
  assert.equal(normalized, 0);
  assert.equal(result.repos_upserted, 0);
  for (const method of ['upsertPublicRepo', 'insertPublicSnapshot', 'upsertFeedMembership']) {
    assert.deepEqual(modelCalls(calls, method), []);
  }
});

test('공개 수집: 두 번째 피드 500은 해당 피드만 실패로 기록하고 나머지는 계속한다', async () => {
  const { runner, calls } = fixture({ search: (index) => {
    if (index === 2) throw Object.assign(new Error('GitHub unavailable'), { status: 500 });
    return [];
  } });
  const result = await runner.runPublicCollection();
  assert.equal(result.feeds_ok, 2);
  assert.equal(result.feeds_failed, 1);
  assert.equal(result.aborted, false);
  assert.equal(calls.searches.length, 3);
  assert.deepEqual(modelCalls(calls, 'markFeedResult').map(([id, result]) => [id, result.status, result.errorCode]),
    [[1, 'ok', null], [2, 'error', '500'], [3, 'ok', null]]);
  assert.match(calls.errors[0][0], /^\[public-etl\] language:python status=500 name=Error message=GitHub unavailable$/);
});

test('공개 수집: 401은 남은 피드를 중단하고 로그의 토큰·Authorization을 제거한다', async () => {
  const { runner, calls } = fixture({ search: () => {
    throw Object.assign(new Error('tok-secret Authorization: Bearer other-secret'), {
      status: 401, name: 'tok-secret', request: { headers: { authorization: 'tok-secret' } },
    });
  } });
  const result = await runner.runPublicCollection();
  assert.equal(result.aborted, true);
  assert.equal(result.feeds_failed, 1);
  assert.equal(calls.searches.length, 1);
  assert.equal(modelCalls(calls, 'markFeedAttempt').length, 1);
  assert.equal(modelCalls(calls, 'markFeedResult')[0][1].errorCode, '401');
  assert.doesNotMatch(JSON.stringify(calls.errors), /tok-secret|Authorization|other-secret|headers|request/);
  assert.equal(runner.isPublicCollectionRunning(), false);
});

test('공개 수집: 오류 메시지는 200자로 제한하고 코드·이름도 원본 객체 없이 기록한다', async () => {
  const { runner, calls } = fixture({ feeds: FEEDS.slice(0, 1), search: () => {
    throw Object.assign(new Error('x'.repeat(300)), { code: 'ESEARCH' });
  } });
  await runner.runPublicCollection();
  assert.equal(calls.errors[0].length, 1);
  assert.equal(typeof calls.errors[0][0], 'string');
  assert.equal(calls.errors[0][0].split('message=')[1], 'x'.repeat(200));
  assert.equal(modelCalls(calls, 'markFeedResult')[0][1].errorCode, 'ESEARCH');
});

test('공개 수집: 모듈 guard는 같은 인스턴스·다른 인스턴스의 중복 실행을 건너뛴다', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = fixture({ search: () => gate });
  const second = fixture();
  const pending = first.runner.runPublicCollection();
  try {
    assert.equal(first.runner.isPublicCollectionRunning(), true);
    assert.equal(second.runner.isPublicCollectionRunning(), true);
    assert.deepEqual(await first.runner.runPublicCollection(), { skipped: true, reason: 'running' });
    assert.deepEqual(await second.runner.runPublicCollection(), { skipped: true, reason: 'running' });
    assert.deepEqual(second.calls.model, []);
    assert.deepEqual(second.calls.octokit, []);
  } finally {
    release([]);
    await pending;
  }
  assert.equal(first.runner.isPublicCollectionRunning(), false);
  assert.equal((await second.runner.runPublicCollection()).feeds_ok, 3);
});

test('공개 수집: ensureFeeds 예외 후 guard를 해제해 다음 실행이 가능하다', async () => {
  const { runner, model } = fixture();
  const ensureFeeds = model.ensureFeeds;
  model.ensureFeeds = async () => { throw new Error('DB unavailable'); };
  await assert.rejects(runner.runPublicCollection(), /DB unavailable/);
  assert.equal(runner.isPublicCollectionRunning(), false);
  model.ensureFeeds = ensureFeeds;
  assert.equal((await runner.runPublicCollection()).feeds_ok, 3);
});

test('공개 수집: Octokit 생성 예외 후에도 guard가 해제된다', async () => {
  const { runner } = fixture({ deps: { createOctokit: () => { throw new Error('client unavailable'); } } });
  await assert.rejects(runner.runPublicCollection(), /client unavailable/);
  assert.equal(runner.isPublicCollectionRunning(), false);
  assert.equal((await fixture().runner.runPublicCollection()).feeds_ok, 3);
});

test('공개 수집: 토큰 없음은 경고 1회, DB·GitHub·pacer 접근 없이 건너뛴다', async () => {
  const { runner, calls } = fixture({ deps: { token: undefined } });
  assert.deepEqual(await runner.runPublicCollection(), { skipped: true, reason: 'no_token' });
  assert.deepEqual(calls.warnings, [['[public-etl] PUBLIC_GITHUB_TOKEN 미설정 — 공개 수집 건너뜀']]);
  assert.deepEqual(calls.model, []);
  assert.deepEqual(calls.octokit, []);
  assert.deepEqual(calls.searches, []);
  assert.deepEqual(calls.sleeps, []);
  assert.equal(runner.isPublicCollectionRunning(), false);
});

test('공개 수집: 다른 실행에서도 같은 레포의 새 스냅샷을 다시 적재한다', async () => {
  const { runner, calls } = fixture({ feeds: FEEDS.slice(0, 1), search: () => [rawItem(9)] });
  await runner.runPublicCollection();
  await runner.runPublicCollection();
  assert.equal(modelCalls(calls, 'insertPublicSnapshot').length, 2);
});

test('공개 수집: 설정 오류는 실행 시점에 기록하고 DB·GitHub 없이 건너뛴다', async () => {
  const { runner, calls } = fixture({ deps: {
    feeds: () => allFeeds({ PUBLIC_TOPICS: 'tok-secret' }),
  } });
  assert.deepEqual(await runner.runPublicCollection(), { skipped: true, reason: 'invalid_config' });
  assert.match(calls.errors[0][0], /config.*PUBLIC_TOPICS: unknown slug \[redacted\]/);
  assert.doesNotMatch(JSON.stringify(calls.errors), /tok-secret/);
  assert.deepEqual(calls.model, []);
  assert.deepEqual(calls.octokit, []);
  assert.equal(runner.isPublicCollectionRunning(), false);
});

test('공개 수집: 잘못된 피드 환경변수로 모듈을 import해도 HTTP 서버 기동을 막지 않는다', () => {
  const moduleUrl = new URL('../src/etl/public-pipeline.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    const { runPublicCollection } = await import(${JSON.stringify(moduleUrl)});
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    assert.ok(server.address().port > 0);
    assert.deepEqual(await runPublicCollection(), { skipped: true, reason: 'invalid_config' });
    await new Promise(resolve => server.close(resolve));
    console.log('server-like start ok');
  `;
  for (const key of ['PUBLIC_TOPICS', 'PUBLIC_LANGUAGES']) {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, PUBLIC_GITHUB_TOKEN: 'tok-secret', PUBLIC_TOPICS: '', PUBLIC_LANGUAGES: '', [key]: 'unknown-slug' },
      encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.match(stdout, /server-like start ok/);
    assert.doesNotMatch(stdout, /tok-secret/);
  }
});

test('공개 수집: 저장 오류 코드는 64자로 제한해 나머지 피드를 계속한다', async () => {
  const { runner, calls } = fixture({ search: (index) => {
    if (index === 2) throw Object.assign(new Error('search failed'), { code: 'E'.repeat(100) });
    return [];
  } });
  const result = await runner.runPublicCollection();
  assert.equal(result.feeds_ok, 2);
  assert.equal(result.feeds_failed, 1);
  assert.equal(modelCalls(calls, 'markFeedResult')[1][1].errorCode, 'E'.repeat(64));
  assert.equal(calls.searches.length, 3);
});

test('공개 수집: 실패 기록 DB 오류도 격리하고 로그의 비밀을 제거한다', async () => {
  const { runner, calls, model } = fixture({ search: (index) => {
    if (index === 2) throw Object.assign(new Error('search failed'), { status: 500 });
    return [];
  } });
  const markFeedResult = model.markFeedResult;
  model.markFeedResult = async (feedId, result) => {
    await markFeedResult(feedId, result);
    if (result.status === 'error') throw Object.assign(new Error('tok-secret Authorization: Bearer hidden'), { code: 'EDB' });
  };
  const result = await runner.runPublicCollection();
  assert.equal(result.feeds_ok, 2);
  assert.equal(result.feeds_failed, 1);
  assert.equal(result.aborted, false);
  assert.equal(calls.searches.length, 3);
  assert.match(calls.errors[1][0], /language:python record status=EDB/);
  assert.doesNotMatch(JSON.stringify(calls.errors), /tok-secret|Authorization|hidden/);
});

test('공개 수집: 401 실패 기록이 실패해도 남은 피드를 중단하고 guard를 해제한다', async () => {
  const { runner, calls, model } = fixture({ search: () => {
    throw Object.assign(new Error('Bad credentials'), { status: 401 });
  } });
  model.markFeedResult = async () => { throw new Error('DB unavailable'); };
  const result = await runner.runPublicCollection();
  assert.equal(result.aborted, true);
  assert.equal(result.feeds_failed, 1);
  assert.equal(calls.searches.length, 1);
  assert.equal(calls.errors.length, 2);
  assert.equal(runner.isPublicCollectionRunning(), false);
});

function candidate(id, stars) {
  return {
    id, github_id: id, full_name: `octo/repo-${id}`, owner: 'octo', name: `repo-${id}`,
    github_created_at: new Date(NOW - 20 * 3600000),
    snapshots: [{ id: id * 10, stars, captured_at: new Date(NOW) }],
    earliest: { id: id * 10, stars, captured_at: new Date(NOW) },
  };
}

test('순위 기록: 성공한 피드마다 실행 시작 시각으로 상위 순위를 저장한다', async () => {
  const { runner, calls } = fixture({
    feeds: FEEDS.slice(0, 2),
    search: (index) => {
      if (index === 2) throw Object.assign(new Error('search failed'), { status: 500 });
      return [];
    },
    candidates: () => [candidate(2, 200), candidate(1, 1500)],
  });
  const result = await runner.runPublicCollection();
  const inserts = modelCalls(calls, 'insertRankHistory');
  assert.equal(inserts.length, 1);
  const [feedId, capturedAt, rows] = inserts[0];
  assert.equal(feedId, 1);
  assert.equal(capturedAt.getTime(), NOW);
  assert.deepEqual(rows.map((row) => [row.id, row.rank, row.baseline_source]), [[1, 1, 'creation'], [2, 2, 'creation']]);
  assert.equal(result.ranks_recorded, 2);
});

test('순위 기록: 한 피드의 저장 실패는 다른 피드 기록과 수집 결과를 막지 않는다', async () => {
  const { runner, calls } = fixture({
    feeds: FEEDS.slice(0, 2),
    candidates: () => [candidate(1, 1500)],
    insertRankHistory: async (feedId) => { if (feedId === 1) throw new Error('DB unavailable'); },
  });
  const result = await runner.runPublicCollection();
  assert.equal(result.feeds_ok, 2);
  assert.equal(result.ranks_recorded, 1);
  assert.equal(modelCalls(calls, 'insertRankHistory').length, 2);
  assert.equal(calls.errors.length, 1);
  assert.equal(runner.isPublicCollectionRunning(), false);
});

test('순위 기록: 401로 중단된 실행은 순위를 남기지 않는다', async () => {
  const { runner, calls } = fixture({
    search: (index) => {
      if (index === 2) throw Object.assign(new Error('Bad credentials'), { status: 401 });
      return [];
    },
    candidates: () => [candidate(1, 1500)],
  });
  const result = await runner.runPublicCollection();
  assert.equal(result.aborted, true);
  assert.equal(modelCalls(calls, 'insertRankHistory').length, 0);
});
