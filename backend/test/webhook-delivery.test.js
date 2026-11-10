// 발신 경로를 127.0.0.1 로컬 HTTP 서버에 실제 요청을 보내 확인한다(DB 불필요).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { RETRY_DELAYS_MS, buildBody, buildEvent, createDispatcher, send, sign } from '../src/services/webhook-delivery.js';
import { TargetError } from '../src/utils/webhook-target.js';

const SECRET = 'a'.repeat(64);
const T0 = new Date('2026-11-10T00:00:00Z');

async function receiver(handler = (req, res) => res.writeHead(204).end()) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      handler(req, res, requests.length);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    port: server.address().port,
    url: (path = '/hook') => `http://127.0.0.1:${server.address().port}${path}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

function repo(rank, extra = {}) {
  return {
    github_id: 1000 + rank, full_name: `octo/repo-${rank}`, html_url: `https://github.com/octo/repo-${rank}`, description: 'A tool',
    language: 'Go', stars: 1200 + rank, rate_24h: 310.4, growth_rate_24h: 0.4, age_days: 3.2, rank, estimated: false, ...extra,
  };
}

function delivery(id, extra = {}) {
  const event = extra.event ?? 'rising.new';
  return {
    id, user_id: 7, delivery_id: `d-${id}`, event, status: 'pending', attempts: 0, max_attempts: event === 'ping' ? 1 : 5,
    next_attempt_at: T0, last_status_code: null, last_error_code: null, completed_at: null,
    payload: JSON.stringify(buildEvent({ id: `d-${id}`, event, createdAt: T0, repos: event === 'ping' ? [] : [repo(1), repo(2)] })),
    ...extra,
  };
}

// webhook.model과 같은 계약을 메모리로 흉내 낸다.
function memory({ url, format = 'generic', enabled = true, deliveries = [] }) {
  const state = {
    endpoint: { user_id: 7, url_enc: url, secret_enc: SECRET, format, enabled, auto_disabled: false, consecutive_failures: 0 },
    deliveries,
    cancelled: [],
    claimSizes: [],
    pruneBefore: null,
  };
  const model = {
    getEndpoint: async () => (state.endpoint ? { ...state.endpoint } : null),
    finishDelivery: async (id, patch) => { Object.assign(state.deliveries.find((row) => row.id === id), patch); },
    recordOutcome: async (userId, { success, countsTowardDisable }) => {
      if (success) { state.endpoint.consecutive_failures = 0; return { auto_disabled: false }; }
      if (!countsTowardDisable) return { auto_disabled: false };
      state.endpoint.consecutive_failures++;
      if (state.endpoint.enabled && state.endpoint.consecutive_failures >= 3) {
        Object.assign(state.endpoint, { enabled: false, auto_disabled: true });
        return { auto_disabled: true };
      }
      return { auto_disabled: false };
    },
    cancelPending: async (userId, at) => {
      for (const row of state.deliveries.filter((item) => item.status === 'pending')) {
        Object.assign(row, { status: 'failed', last_error_code: 'DISABLED', next_attempt_at: null, completed_at: at });
        state.cancelled.push(row.id);
      }
    },
    // 실제 모델처럼 limit을 지킨다(dispatcher는 한 건씩 선점한다).
    claimDue: async (now, leaseUntil, limit = 20) => state.deliveries
      .filter((row) => row.status === 'pending' && row.next_attempt_at <= now)
      .slice(0, limit)
      .map((row) => { state.claimSizes.push(limit); const claimed = { ...row }; row.next_attempt_at = leaseUntil; return claimed; }),
    claimOne: async (deliveryId, now, leaseUntil) => {
      const row = state.deliveries.find((item) => item.delivery_id === deliveryId && item.status === 'pending' && item.next_attempt_at <= now);
      if (!row) return null;
      const claimed = { ...row };
      row.next_attempt_at = leaseUntil;
      return claimed;
    },
    pruneDeliveries: async (before) => { state.pruneBefore = before; return 0; },
  };
  return { state, model };
}

function dispatcherFor(model, { clock = { now: T0 }, warnings = [], ...deps } = {}) {
  return createDispatcher({
    model, decrypt: (value) => value, allowPrivate: () => true, now: () => clock.now,
    log: { warn: (message) => warnings.push(message) }, ...deps,
  });
}

test('sign은 HMAC-SHA256(키, "시각.본문")의 hex다', () => {
  assert.equal(sign('key', 1731196800, '{"a":1}'), createHmac('sha256', 'key').update('1731196800.{"a":1}').digest('hex'));
});

test('일반 형식: 실제 요청의 헤더·서명·본문이 계약과 같고 성공으로 기록된다', async (t) => {
  const target = await receiver();
  t.after(target.close);
  const { state, model } = memory({ url: target.url(), deliveries: [delivery(1)] });
  state.endpoint.consecutive_failures = 2;
  const outcome = await dispatcherFor(model).dispatchOne('d-1');

  assert.deepEqual(outcome, { status: 'success', statusCode: 204, errorCode: null });
  assert.equal(target.requests.length, 1);
  const [request] = target.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers['user-agent'], 'Trendar-Webhook/1');
  assert.equal(request.headers['x-trendar-event'], 'rising.new');
  assert.equal(request.headers['x-trendar-delivery'], 'd-1');
  const [, timestamp, signature] = request.headers['x-trendar-signature'].match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  assert.equal(Number(timestamp), T0.getTime() / 1000);
  assert.equal(signature, createHmac('sha256', SECRET).update(`${timestamp}.${request.body}`).digest('hex'));
  const body = JSON.parse(request.body);
  assert.deepEqual(Object.keys(body), ['id', 'event', 'created_at', 'data']);
  assert.equal(body.id, 'd-1');
  assert.equal(body.event, 'rising.new');
  assert.equal(body.created_at, T0.toISOString());
  assert.deepEqual(Object.keys(body.data.repos[0]), [
    'github_id', 'full_name', 'html_url', 'description', 'language', 'stars', 'rate_24h', 'growth_rate_24h', 'age_days', 'rank', 'estimated',
  ]);
  assert.equal(state.deliveries[0].status, 'success');
  assert.equal(state.deliveries[0].attempts, 1);
  assert.equal(state.deliveries[0].last_status_code, 204);
  assert.equal(state.endpoint.consecutive_failures, 0);
});

test('Discord는 2,000자 이하 content, Slack은 text 본문이고 ping의 data는 비어 있다', () => {
  const many = Array.from({ length: 8 }, (_, i) => repo(i + 1, { full_name: `owner-${'x'.repeat(120)}/repo-${'y'.repeat(120)}-${i}`, html_url: `https://github.com/${'z'.repeat(200)}/${i}` }));
  const event = buildEvent({ id: 'e1', event: 'rising.new', createdAt: T0, repos: many });
  const discord = JSON.parse(buildBody('discord', event));
  assert.deepEqual(Object.keys(discord), ['content']);
  assert.ok(discord.content.length <= 2000, String(discord.content.length));
  assert.match(discord.content, /^Trendar — 8 new rising repositories\n#1 /);
  assert.match(discord.content, /…and \d+ more$/);

  const small = buildEvent({ id: 'e2', event: 'rising.new', createdAt: T0, repos: [repo(1)] });
  assert.equal(JSON.parse(buildBody('discord', small)).content, 'Trendar — 1 new rising repository\n#1 octo/repo-1 ★1,201 +310/day https://github.com/octo/repo-1');
  assert.deepEqual(JSON.parse(buildBody('slack', small)), { text: 'Trendar — 1 new rising repository\n#1 octo/repo-1 ★1,201 +310/day https://github.com/octo/repo-1' });

  const ping = buildEvent({ id: 'p1', event: 'ping', createdAt: T0 });
  assert.deepEqual(ping.data, {});
  assert.deepEqual(JSON.parse(buildBody('generic', ping)), { id: 'p1', event: 'ping', created_at: T0.toISOString(), data: {} });
  assert.match(JSON.parse(buildBody('slack', ping)).text, /webhook test/);
});

test('2xx가 아니면 1분·5분·30분·2시간 뒤 다시 보내고 5번째 실패에서 끝낸다. 같은 delivery id와 본문으로 다시 간다', async (t) => {
  const target = await receiver((req, res) => res.writeHead(500).end('boom'));
  t.after(target.close);
  const clock = { now: T0 };
  const { state, model } = memory({ url: target.url(), deliveries: [delivery(1)] });
  const dispatcher = dispatcherFor(model, { clock });
  const row = state.deliveries[0];

  for (let attempt = 1; attempt <= 4; attempt++) {
    const started = clock.now;
    assert.deepEqual(await dispatcher.dispatchDue(), { attempted: 1 });
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, attempt);
    assert.equal(row.last_error_code, 'HTTP_500');
    assert.equal(row.next_attempt_at.getTime() - started.getTime(), RETRY_DELAYS_MS[attempt - 1]);
    // 아직 때가 안 됐으면 보내지 않는다.
    clock.now = new Date(row.next_attempt_at.getTime() - 1);
    assert.deepEqual(await dispatcher.dispatchDue(), { attempted: 0 });
    clock.now = row.next_attempt_at;
  }
  assert.deepEqual(RETRY_DELAYS_MS, [60_000, 300_000, 1_800_000, 7_200_000]);
  await dispatcher.dispatchDue();
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 5);
  assert.equal(row.next_attempt_at, null);
  assert.equal(state.endpoint.consecutive_failures, 1);
  assert.equal(target.requests.length, 5);
  assert.equal(new Set(target.requests.map((request) => request.headers['x-trendar-delivery'])).size, 1);
  assert.equal(new Set(target.requests.map((request) => request.body)).size, 1);
  assert.equal(new Set(target.requests.map((request) => request.headers['x-trendar-signature'])).size, 5, '시각은 시도마다 새로 찍는다');
});

test('리다이렉트는 따라가지 않고 실패로 기록한다', async (t) => {
  const inner = await receiver();
  const outer = await receiver((req, res) => res.writeHead(302, { Location: inner.url('/internal') }).end());
  t.after(inner.close);
  t.after(outer.close);
  const { state, model } = memory({ url: outer.url(), deliveries: [delivery(1)] });
  const outcome = await dispatcherFor(model).dispatchOne('d-1');
  assert.deepEqual(outcome, { status: 'pending', statusCode: 302, errorCode: 'HTTP_302' });
  assert.equal(outer.requests.length, 1);
  assert.equal(inner.requests.length, 0);
  assert.equal(state.deliveries[0].last_status_code, 302);
});

test('응답이 제한 시간 안에 오지 않으면 TIMEOUT, 연결할 수 없으면 CONNECT다', async (t) => {
  const slow = await receiver(() => {});
  t.after(slow.close);
  const started = performance.now();
  const result = await send({ url: new URL(slow.url()), address: '127.0.0.1', family: 4, headers: {}, body: '{}', timeoutMs: 150 });
  assert.deepEqual(result, { ok: false, statusCode: null, errorCode: 'TIMEOUT' });
  assert.ok(performance.now() - started < 2000);

  const closed = await receiver();
  const deadUrl = new URL(closed.url());
  await closed.close();
  assert.deepEqual(await send({ url: deadUrl, address: '127.0.0.1', family: 4, headers: {}, body: '{}' }), { ok: false, statusCode: null, errorCode: 'CONNECT' });
});

test('연결은 검증한 주소로만 간다: 시스템 DNS로는 풀리지 않는 이름이어도 검증 결과 주소로 붙고 Host는 원래 이름이다', async (t) => {
  const target = await receiver();
  t.after(target.close);
  const resolved = [];
  const { model } = memory({ url: `http://pinned.invalid:${target.port}/hook`, deliveries: [delivery(1)] });
  const dispatcher = dispatcherFor(model, {
    resolveTarget: async (url, options) => { resolved.push([url.hostname, options.allowPrivate]); return { address: '127.0.0.1', family: 4 }; },
  });
  assert.equal((await dispatcher.dispatchOne('d-1')).status, 'success');
  assert.deepEqual(resolved, [['pinned.invalid', true]]);
  assert.equal(target.requests[0].headers.host, `pinned.invalid:${target.port}`);
});

test('발신 직전 재검증에서 차단 대역이면 요청을 보내지 않고 BLOCKED_TARGET으로 기록한다', async (t) => {
  const target = await receiver();
  t.after(target.close);
  let sent = 0;
  const { state, model } = memory({ url: target.url(), deliveries: [delivery(1)] });
  const dispatcher = dispatcherFor(model, {
    allowPrivate: () => false,
    send: async () => { sent++; return { ok: true, statusCode: 200, errorCode: null }; },
  });
  // 허용 플래그가 꺼져 있으면 http 주소는 파싱 단계에서 거부된다.
  assert.deepEqual(await dispatcher.dispatchOne('d-1'), { status: 'pending', statusCode: null, errorCode: 'CONFIG' });

  state.deliveries.push(delivery(2));
  state.endpoint.url_enc = 'https://rebind.example/hook';
  const rebinding = dispatcherFor(model, {
    allowPrivate: () => false,
    resolveTarget: async () => { throw new TargetError('WEBHOOK_URL_BLOCKED'); },
    send: async () => { sent++; return { ok: true, statusCode: 200, errorCode: null }; },
  });
  assert.deepEqual(await rebinding.dispatchOne('d-2'), { status: 'pending', statusCode: null, errorCode: 'BLOCKED_TARGET' });
  assert.equal(sent, 0);
  assert.equal(target.requests.length, 0);
});

test('알림 3건이 연속으로 최종 실패하면 자동으로 끄고 남은 대기를 취소한다. 성공은 연속 실패 수를 지운다', async (t) => {
  let fail = true;
  const target = await receiver((req, res) => res.writeHead(fail ? 503 : 200).end());
  t.after(target.close);
  const warnings = [];
  const last = { attempts: 4 };
  const { state, model } = memory({
    url: target.url('/secret-path-token'),
    deliveries: [delivery(1, last), delivery(2, last), delivery(3, last), delivery(4, last), delivery(5, { next_attempt_at: new Date(T0.getTime() + 3_600_000) })],
  });
  const dispatcher = dispatcherFor(model, { warnings });

  await dispatcher.dispatchOne('d-1');
  await dispatcher.dispatchOne('d-2');
  assert.equal(state.endpoint.consecutive_failures, 2);
  assert.equal(state.endpoint.enabled, true);
  fail = false;
  await dispatcher.dispatchOne('d-3');
  assert.equal(state.endpoint.consecutive_failures, 0);

  fail = true;
  state.deliveries.push(delivery(6, last), delivery(7, last));
  await dispatcher.dispatchOne('d-4');
  await dispatcher.dispatchOne('d-6');
  assert.equal(state.endpoint.enabled, true);
  await dispatcher.dispatchOne('d-7');
  assert.equal(state.endpoint.enabled, false);
  assert.equal(state.endpoint.auto_disabled, true);
  assert.deepEqual(state.cancelled, [5]);
  assert.equal(state.deliveries.find((row) => row.id === 5).last_error_code, 'DISABLED');

  // 로그에는 사용자 id만 남고 수신 URL·서명 키·본문은 남지 않는다(R3.8).
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /user#7/);
  assert.doesNotMatch(warnings.join('\n'), /secret-path-token|127\.0\.0\.1|aaaaaaaa|octo\/repo/);
});

test('꺼진 수신 URL의 알림은 보내지 않고 DISABLED로 끝내지만, 테스트 발신은 꺼져 있어도 보내고 실패해도 연속 실패에 넣지 않는다', async (t) => {
  const target = await receiver((req, res) => res.writeHead(500).end());
  t.after(target.close);
  const { state, model } = memory({ url: target.url(), enabled: false, deliveries: [delivery(1), delivery(2, { event: 'ping' })] });
  const dispatcher = dispatcherFor(model);

  assert.deepEqual(await dispatcher.dispatchOne('d-1'), { status: 'failed', statusCode: null, errorCode: 'DISABLED' });
  assert.equal(target.requests.length, 0);
  assert.equal(state.deliveries[0].attempts, 0);

  assert.deepEqual(await dispatcher.dispatchOne('d-2'), { status: 'failed', statusCode: 500, errorCode: 'HTTP_500' });
  assert.equal(target.requests.length, 1);
  assert.equal(target.requests[0].headers['x-trendar-event'], 'ping');
  assert.equal(state.deliveries[1].attempts, 1);
  assert.equal(state.endpoint.consecutive_failures, 0);
});

test('설정이 없거나 복호화에 실패하면 요청 없이 끝내고, 한 건의 내부 오류가 다음 발신을 막지 않는다', async (t) => {
  const target = await receiver();
  t.after(target.close);
  const warnings = [];
  const { state, model } = memory({ url: target.url(), deliveries: [delivery(1), delivery(2)] });
  const dispatcher = dispatcherFor(model, {
    warnings,
    decrypt: (value) => { if (value === SECRET) throw new Error('bad key material'); return value; },
  });
  assert.equal((await dispatcher.dispatchOne('d-1')).errorCode, 'CONFIG');
  assert.equal(target.requests.length, 0);

  let calls = 0;
  const flaky = dispatcherFor(model, {
    warnings,
    send: async () => { if (++calls === 1) throw Object.assign(new Error('socket exploded at http://x/secret'), { code: 'EBOOM' }); return { ok: true, statusCode: 200, errorCode: null }; },
  });
  state.deliveries[0].next_attempt_at = T0;
  assert.deepEqual(await flaky.dispatchDue(), { attempted: 2 });
  assert.equal(state.deliveries[1].status, 'success');
  assert.deepEqual(warnings, ['[webhook] user#7 delivery=d-1 error=EBOOM']);
  // 내부 오류도 시도 한 번으로 세고 재시도를 예약한다(같은 행이 끝없이 다시 집히지 않는다).
  assert.deepEqual([state.deliveries[0].status, state.deliveries[0].attempts, state.deliveries[0].last_error_code], ['pending', 2, 'INTERNAL']);
  assert.equal(state.deliveries[0].next_attempt_at.getTime() - T0.getTime(), RETRY_DELAYS_MS[1]);
  assert.deepEqual(state.claimSizes, [1, 1], '한 건씩 선점한다');

  state.endpoint = null;
  state.deliveries.push(delivery(3));
  assert.deepEqual(await dispatcher.dispatchOne('d-3'), { status: 'failed', statusCode: null, errorCode: 'DISABLED' });
});

test('전달이 기록된 뒤의 집계 오류는 그 발신을 다시 대기로 돌리지 않는다', async (t) => {
  const target = await receiver();
  t.after(target.close);
  const warnings = [];
  const { state, model } = memory({ url: target.url(), deliveries: [delivery(1)] });
  const recordOutcome = model.recordOutcome;
  let failures = 1;
  model.recordOutcome = async (...args) => {
    if (failures-- > 0) throw Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' });
    return recordOutcome(...args);
  };
  const dispatcher = dispatcherFor(model, { warnings });
  assert.deepEqual(await dispatcher.dispatchDue(), { attempted: 1 });
  assert.deepEqual([state.deliveries[0].status, state.deliveries[0].attempts, state.deliveries[0].last_error_code], ['success', 1, null]);
  assert.deepEqual(warnings, ['[webhook] user#7 delivery=d-1 error=ER_LOCK_DEADLOCK']);
  assert.deepEqual(await dispatcher.dispatchDue(), { attempted: 0 });
  assert.equal(target.requests.length, 1);
});

test('dispatchDue는 겹쳐 돌지 않고, prune은 30일 전 시각을 기준으로 지운다', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const target = await receiver(async (req, res) => { await gate; res.writeHead(200).end(); });
  t.after(target.close);
  const { state, model } = memory({ url: target.url(), deliveries: [delivery(1)] });
  const dispatcher = dispatcherFor(model);
  const first = dispatcher.dispatchDue();
  const second = dispatcher.dispatchDue();
  assert.equal(first, second);
  release();
  assert.deepEqual(await first, { attempted: 1 });
  assert.equal(target.requests.length, 1);

  await dispatcher.prune();
  assert.equal(state.pruneBefore.toISOString(), '2026-10-11T00:00:00.000Z');
});
