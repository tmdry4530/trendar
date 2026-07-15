import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEtlController } from '../src/controllers/etl.controller.js';
import { httpError } from '../src/middleware/errorHandler.js';

// KST 2026-07-15 낮 시간대 고정
const NOW = new Date('2026-07-15T03:00:00Z');

function makeDeps(overrides = {}) {
  const calls = { consume: [], refund: [], run: [] };
  const deps = {
    pipeline: {
      runPipelineForUser: async (userId, opts) => {
        calls.run.push([userId, opts]);
        return { queries_processed: 1, repos_upserted: 2, snapshots_inserted: 2, repos_skipped: 0, errors: [] };
      },
      isRunning: () => false,
    },
    users: {
      consumeManualEtl: async (...args) => { calls.consume.push(args); return true; },
      refundManualEtl: async (...args) => { calls.refund.push(args); },
      getManualEtlUsage: async () => 3,
      findById: async () => ({ last_etl_at: null, last_etl_status: null, last_etl_message: null }),
    },
    limit: () => 10,
    clock: () => NOW,
    ...overrides,
  };
  return { deps, calls };
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const req = { user: { id: 7 }, query: {} };

test('run — 잔여 있으면 소비 1회 후 파이프라인 실행 (R1.1)', async () => {
  const { deps, calls } = makeDeps();
  const c = createEtlController(deps);
  const res = makeRes();
  await c.run(req, res, (e) => { throw e; });
  assert.equal(calls.consume.length, 1);
  assert.deepEqual(calls.consume[0], [7, '2026-07-15', 10]);
  assert.equal(calls.run.length, 1);
  assert.equal(res.body.ok, true);
  assert.equal(calls.refund.length, 0);
});

test('run — 한도 도달이면 429 + 파이프라인 미호출 (R1.2)', async () => {
  const { deps, calls } = makeDeps();
  deps.users.consumeManualEtl = async () => false;
  const c = createEtlController(deps);
  let err;
  await c.run(req, makeRes(), (e) => { err = e; });
  assert.equal(err.status, 429);
  assert.equal(err.code, 'ETL_DAILY_LIMIT_EXCEEDED');
  assert.match(err.message, /10회/);
  assert.equal(calls.run.length, 0);
});

for (const code of ['ETL_ALREADY_RUNNING', 'GITHUB_TOKEN_INVALID']) {
  test(`run — 시작 전 거부(${code})는 환불 후 에러 그대로 (R1.4)`, async () => {
    const { deps, calls } = makeDeps();
    deps.pipeline.runPipelineForUser = async () => { throw httpError(409, code, 'blocked'); };
    const c = createEtlController(deps);
    let err;
    await c.run(req, makeRes(), (e) => { err = e; });
    assert.equal(err.code, code);
    assert.equal(calls.refund.length, 1);
    assert.deepEqual(calls.refund[0], [7, '2026-07-15']);
  });
}

test('run — 실행 도중 일반 에러는 환불하지 않음', async () => {
  const { deps, calls } = makeDeps();
  deps.pipeline.runPipelineForUser = async () => { throw new Error('mid-run failure'); };
  const c = createEtlController(deps);
  let err;
  await c.run(req, makeRes(), (e) => { err = e; });
  assert.equal(err.message, 'mid-run failure');
  assert.equal(calls.refund.length, 0);
});

test('status — manual_* 4필드 포함, 잔여는 한도-사용 (R3.1)', async () => {
  const { deps } = makeDeps();
  const c = createEtlController(deps);
  const res = makeRes();
  await c.status(req, res, (e) => { throw e; });
  const d = res.body.data;
  assert.equal(d.manual_used_today, 3);
  assert.equal(d.manual_limit, 10);
  assert.equal(d.manual_remaining, 7);
  assert.equal(d.manual_reset_at, '2026-07-15T15:00:00.000Z');
});

test('status — 날짜가 바뀌면 usage 0 기준으로 응답 (R3.2)', async () => {
  const { deps } = makeDeps();
  deps.users.getManualEtlUsage = async (id, today) => (today === '2026-07-15' ? 0 : 99);
  const c = createEtlController(deps);
  const res = makeRes();
  await c.status(req, res, (e) => { throw e; });
  assert.equal(res.body.data.manual_used_today, 0);
  assert.equal(res.body.data.manual_remaining, 10);
});

test('status — 사용량이 한도를 넘어도 잔여는 0 미만이 되지 않음', async () => {
  const { deps } = makeDeps();
  deps.users.getManualEtlUsage = async () => 12;
  const c = createEtlController(deps);
  const res = makeRes();
  await c.status(req, res, (e) => { throw e; });
  assert.equal(res.body.data.manual_remaining, 0);
});
