// test/pipeline.test.js — ETL 파이프라인(createEtlRunner) 검증(스텁 주입, DB·네트워크 불필요)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEtlRunner } from '../src/etl/pipeline.js';
import { normalizeRepo, computeDelta } from '../src/etl/transform.js';

function makeUsers({ byId = {}, all = [] } = {}) {
  const calls = { setTokenInvalid: [], updateEtlResult: [] };
  return {
    calls,
    findById: async (id) => byId[id] ?? null,
    findAllWithValidToken: async () => all,
    setTokenInvalid: async (id) => { calls.setTokenInvalid.push(id); return true; },
    updateEtlResult: async (id, r) => { calls.updateEtlResult.push({ id, ...r }); },
  };
}

function makeLoaders() {
  const calls = { upsertRepo: [], insertSnapshot: [], updateRepoDelta: [], getLastSnapshot: [] };
  let nextId = 500;
  return {
    calls,
    upsertRepo: async (repo) => { calls.upsertRepo.push(repo); return nextId++; },
    updateRepoDelta: async (id, d) => { calls.updateRepoDelta.push({ id, d }); },
    insertSnapshot: async (id, m) => { calls.insertSnapshot.push({ id, m }); },
    getLastSnapshot: async (id) => { calls.getLastSnapshot.push(id); return null; },
  };
}

function rawItem(id, stars = 5) {
  return {
    id,
    full_name: `o/r${id}`,
    owner: { login: 'o' },
    name: `r${id}`,
    html_url: `https://example/${id}`,
    description: null,
    language: 'JS',
    stargazers_count: stars,
    forks_count: 1,
    open_issues_count: 0,
    watchers_count: 2,
  };
}

const validUser = (id, login) => ({ id, login, access_token_enc: `enc-tok-${id}`, token_invalid: false });

test('runPipelineAllUsers: A의 401은 A만 무효화하고 B 수집은 격리되어 계속된다', async () => {
  const users = makeUsers({
    byId: { 1: validUser(1, 'a'), 2: validUser(2, 'b') },
    all: [{ id: 1, login: 'a' }, { id: 2, login: 'b' }],
  });
  const loaders = makeLoaders();
  const runner = createEtlRunner({
    users,
    decryptToken: (enc) => enc.replace('enc-', ''),
    createOctokit: (token) => ({ token }),
    extractRepos: async (wq, octokit) => {
      if (octokit.token === 'tok-1') {
        const e = new Error('Bad credentials');
        e.status = 401;
        throw e;
      }
      return [rawItem(100)];
    },
    normalizeRepo,
    computeDelta,
    loaders,
    queryFn: async () => [{ id: 10, query: 'q', query_type: 'keyword' }],
  });

  const res = await runner.runPipelineAllUsers();

  assert.deepEqual(res, { users_total: 2, users_ok: 1, users_failed: 1 });
  assert.deepEqual(users.calls.setTokenInvalid, [1], 'A만 setTokenInvalid');
  const a = users.calls.updateEtlResult.find((c) => c.id === 1);
  const b = users.calls.updateEtlResult.find((c) => c.id === 2);
  assert.equal(a.status, 'token_invalid');
  assert.equal(b.status, 'ok');
  assert.equal(loaders.calls.upsertRepo.length, 1, 'B의 저장소만 upsert');
  assert.equal(loaders.calls.upsertRepo[0].user_id, 2, 'upsert 대상에 user_id=2 스코프');
});

test('정상 사용자: 아이템 수만큼 upsert/snapshot 호출 + updateEtlResult ok', async () => {
  const users = makeUsers({ byId: { 7: validUser(7, 'octo') } });
  const loaders = makeLoaders();
  const runner = createEtlRunner({
    users,
    decryptToken: (enc) => enc,
    createOctokit: (token) => ({ token }),
    extractRepos: async () => [rawItem(101), rawItem(102)],
    normalizeRepo,
    computeDelta,
    loaders,
    queryFn: async () => [{ id: 20, query: 'q', query_type: 'keyword' }],
  });

  const result = await runner.runPipelineForUser(7);

  assert.equal(result.repos_upserted, 2);
  assert.equal(result.snapshots_inserted, 2);
  assert.equal(result.queries_processed, 1);
  assert.equal(loaders.calls.upsertRepo.length, 2);
  assert.equal(loaders.calls.insertSnapshot.length, 2);
  assert.equal(users.calls.updateEtlResult.length, 1);
  assert.equal(users.calls.updateEtlResult[0].status, 'ok');
});

test('동시 실행: 같은 userId 두 번째 호출은 409 ETL_ALREADY_RUNNING', async () => {
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const users = makeUsers({ byId: { 3: validUser(3, 'c') } });
  const runner = createEtlRunner({
    users,
    decryptToken: (enc) => enc,
    createOctokit: (token) => ({ token }),
    extractRepos: async () => gate, // 첫 실행을 pending 상태로 붙잡아 둔다
    normalizeRepo,
    computeDelta,
    loaders: makeLoaders(),
    queryFn: async () => [{ id: 30, query: 'q', query_type: 'keyword' }],
  });

  const first = runner.runPipelineForUser(3);
  await assert.rejects(
    runner.runPipelineForUser(3),
    (e) => e.status === 409 && e.code === 'ETL_ALREADY_RUNNING'
  );

  releaseGate([]); // 첫 실행을 정상 종료시켜 락 해제
  await first;
  assert.equal(runner.isRunning(3), false);
});

test('토큰 없는 사용자: runPipelineForUser는 409 GITHUB_TOKEN_INVALID', async () => {
  const users = makeUsers({ byId: { 4: { id: 4, login: 'd', access_token_enc: null, token_invalid: false } } });
  const runner = createEtlRunner({
    users,
    decryptToken: (enc) => enc,
    createOctokit: (token) => ({ token }),
    extractRepos: async () => { throw new Error('호출되면 안 됨'); },
    normalizeRepo,
    computeDelta,
    loaders: makeLoaders(),
    queryFn: async () => [{ id: 40, query: 'q', query_type: 'keyword' }],
  });

  await assert.rejects(
    runner.runPipelineForUser(4),
    (e) => e.status === 409 && e.code === 'GITHUB_TOKEN_INVALID'
  );
});

test('비401 쿼리 오류: errors에 기록되고 나머지 쿼리는 계속, status error', async () => {
  const users = makeUsers({ byId: { 5: validUser(5, 'e') } });
  const loaders = makeLoaders();
  const runner = createEtlRunner({
    users,
    decryptToken: (enc) => enc,
    createOctokit: (token) => ({ token }),
    extractRepos: async (wq) => {
      if (wq.id === 10) throw new Error('boom');
      return [rawItem(200)];
    },
    normalizeRepo,
    computeDelta,
    loaders,
    queryFn: async () => [
      { id: 10, query: 'bad', query_type: 'keyword' },
      { id: 11, query: 'good', query_type: 'keyword' },
    ],
  });

  const result = await runner.runPipelineForUser(5);

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /query#10/);
  assert.equal(result.queries_processed, 1, '두 번째 쿼리는 계속 처리됨');
  assert.equal(result.repos_upserted, 1);
  assert.equal(users.calls.setTokenInvalid.length, 0, '비401은 토큰을 무효화하지 않음');
  assert.equal(users.calls.updateEtlResult[0].status, 'error');
});
