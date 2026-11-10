import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RISING_NOTIFY_LIMIT, createRisingNotifier } from '../src/services/webhook-rising.js';

const NOW = new Date('2026-11-10T06:00:00Z');

function row(rank, extra = {}) {
  return {
    id: rank, github_id: 100 + rank, full_name: `octo/repo-${rank}`, html_url: `https://github.com/octo/repo-${rank}`, description: `repo ${rank}`,
    language: 'Go', stars: 900 + rank, rate_24h: 400 - rank, growth_rate_24h: 0.5, age_days: 2.5, rank, baseline_source: 'snapshot',
    score: 500 - rank, star_delta: 10, velocity: 100, ...extra,
  };
}

// webhook.model의 보냄 기록·대기열 계약을 메모리로 흉내 낸다.
function fixture({ rising = [], enabled = true, endpoint = true } = {}) {
  const state = { rising, notified: new Set(), deliveries: [], dispatched: [], limits: [], endpoint: endpoint ? { enabled } : null };
  const mark = (ids) => {
    const fresh = [];
    for (const id of ids.map(Number)) if (!state.notified.has(id)) { state.notified.add(id); fresh.push(id); }
    return fresh;
  };
  const notifier = createRisingNotifier({
    repos: {
      risingRepos: async (userId, { config, now }) => {
        state.limits.push([userId, config.limit, config.windowDays, now]);
        return state.rising.slice(0, config.limit);
      },
    },
    model: {
      getEndpoint: async () => state.endpoint,
      markNotified: async (userId, ids) => mark(ids),
      enqueueRising: async (userId, { githubIds, buildPayload, deliveryId, at }) => {
        const fresh = mark(githubIds);
        if (!fresh.length) return null;
        state.deliveries.push({ userId, deliveryId, at, payload: JSON.parse(buildPayload(fresh)) });
        return { delivery_id: deliveryId, github_ids: fresh };
      },
    },
    config: () => ({ windowDays: 15, freshHours: 13, minRate: 100, minGrowth: 0.1, absPass: 500, limit: 50 }),
    dispatcher: { dispatchOne: async (id) => { state.dispatched.push(id); } },
    now: () => NOW,
    newId: () => `evt-${state.deliveries.length + 1}`,
    log: { warn() {} },
  });
  return { state, notifier };
}

test('대시보드와 같은 상위 8개에서 아직 보내지 않은 저장소만 rising.new 1건으로 묶는다', async () => {
  const { state, notifier } = fixture({ rising: Array.from({ length: 10 }, (_, i) => row(i + 1)) });
  state.notified.add(102);
  state.notified.add(105);

  assert.equal(RISING_NOTIFY_LIMIT, 8);
  assert.deepEqual(await notifier.notifyRising(7), { queued: 6 });
  assert.deepEqual(state.limits, [[7, 8, 15, NOW]]);
  assert.equal(state.deliveries.length, 1);
  const { payload, deliveryId, userId } = state.deliveries[0];
  assert.equal(userId, 7);
  assert.equal(payload.id, deliveryId);
  assert.equal(payload.event, 'rising.new');
  assert.equal(payload.created_at, NOW.toISOString());
  // 순위순이며 9·10위와 이미 보낸 저장소는 없다.
  assert.deepEqual(payload.data.repos.map((repo) => repo.rank), [1, 3, 4, 6, 7, 8]);
  assert.deepEqual(payload.data.repos[0], {
    github_id: 101, full_name: 'octo/repo-1', html_url: 'https://github.com/octo/repo-1', description: 'repo 1', language: 'Go',
    stars: 901, rate_24h: 399, growth_rate_24h: 0.5, age_days: 2.5, rank: 1, estimated: false,
  });
  assert.deepEqual(state.dispatched, [deliveryId]);
});

test('같은 저장소는 다시 알리지 않는다. 새 저장소가 없으면 대기열에 넣지도 발신하지도 않는다', async () => {
  const { state, notifier } = fixture({ rising: [row(1), row(2)] });
  assert.deepEqual(await notifier.notifyRising(7), { queued: 2 });
  assert.deepEqual(await notifier.notifyRising(7), { queued: 0 });
  state.rising = [row(1), row(3, { baseline_source: 'creation', growth_rate_24h: null }), row(2)];
  assert.deepEqual(await notifier.notifyRising(7), { queued: 1 });
  assert.equal(state.deliveries.length, 2);
  assert.deepEqual(state.deliveries[1].payload.data.repos.map((repo) => [repo.github_id, repo.estimated, repo.growth_rate_24h]), [[103, true, null]]);
  assert.equal(state.dispatched.length, 2);

  state.rising = [];
  assert.deepEqual(await notifier.notifyRising(7), { queued: 0 });
  assert.equal(state.deliveries.length, 2);
});

test('수신 URL이 없거나 꺼져 있으면 급상승을 조회하지도 보냄 기록을 남기지도 않는다', async () => {
  for (const options of [{ endpoint: false }, { enabled: false }]) {
    const { state, notifier } = fixture({ rising: [row(1)], ...options });
    assert.deepEqual(await notifier.notifyRising(7), { queued: 0 });
    assert.equal(state.limits.length, 0);
    assert.equal(state.notified.size, 0);
    assert.equal(state.deliveries.length, 0);
  }
});

test('seedSeen은 그 시점 상위 8개를 보낸 것으로 기록해, 이어지는 수집에서 그 저장소를 알리지 않는다', async () => {
  const { state, notifier } = fixture({ rising: Array.from({ length: 9 }, (_, i) => row(i + 1)) });
  assert.equal(await notifier.seedSeen(7), 8);
  assert.equal(state.deliveries.length, 0);
  assert.deepEqual(await notifier.notifyRising(7), { queued: 0 });
  // 9위였던 저장소가 8위 안으로 올라오면 그때 알린다.
  state.rising = [row(9), ...state.rising.slice(0, 7)];
  assert.deepEqual(await notifier.notifyRising(7), { queued: 1 });
  assert.deepEqual(state.deliveries[0].payload.data.repos.map((repo) => repo.github_id), [109]);
});

test('발신 시작이 실패해도 대기열 적재 결과는 그대로 돌려준다', async () => {
  const warnings = [];
  const notifier = createRisingNotifier({
    repos: { risingRepos: async () => [row(1)] },
    model: {
      getEndpoint: async () => ({ enabled: true }),
      enqueueRising: async (userId, { deliveryId }) => ({ delivery_id: deliveryId, github_ids: [101] }),
    },
    config: () => ({ limit: 50 }),
    dispatcher: { dispatchOne: async () => { throw Object.assign(new Error('pool closed secret-url'), { code: 'POOL_CLOSED' }); } },
    now: () => NOW,
    newId: () => 'evt-1',
    log: { warn: (message) => warnings.push(message) },
  });
  assert.deepEqual(await notifier.notifyRising(7), { queued: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(warnings, ['[webhook] user#7 dispatch error=POOL_CLOSED']);
});
