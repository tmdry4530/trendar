// 급상승 알림 웹훅 발신: 본문·서명 생성, 검증한 주소로의 요청, 재시도와 자동 꺼짐.
import { createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import * as webhookModel from '../models/webhook.model.js';
import { decryptToken } from '../utils/crypto.js';
import { TargetError, allowPrivateTargets, parseTargetUrl, resolveTarget as resolveTargetAddress } from '../utils/webhook-target.js';

// n번째 시도가 실패한 뒤 기다리는 시간. 5번째 실패는 최종 실패다.
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000];
const LEASE_MS = 60_000;
const MAX_PER_TICK = 50;
const SEND_TIMEOUT_MS = 5000;
const RETENTION_MS = 30 * 86_400_000;
const DISCORD_CONTENT_MAX = 2000;

export function sign(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function buildEvent({ id, event, createdAt, repos = [] }) {
  return { id, event, created_at: new Date(createdAt).toISOString(), data: event === 'ping' ? {} : { repos } };
}

function chatLines(event) {
  if (event.event === 'ping') return ['Trendar webhook test — this endpoint is connected.'];
  const repos = event.data?.repos ?? [];
  return [
    `Trendar — ${repos.length} new rising ${repos.length === 1 ? 'repository' : 'repositories'}`,
    ...repos.map((repo) => `#${repo.rank} ${repo.full_name} ★${Number(repo.stars).toLocaleString('en-US')} +${Math.round(repo.rate_24h)}/day ${repo.html_url}`),
  ];
}

// Discord는 content 2,000자 제한이 있어 넘치는 줄은 개수로만 알린다.
function discordContent(lines) {
  let content = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const rest = `\n…and ${lines.length - i} more`;
    if (content.length + 1 + lines[i].length + (i < lines.length - 1 ? rest.length : 0) > DISCORD_CONTENT_MAX) return `${content}${rest}`.slice(0, DISCORD_CONTENT_MAX);
    content += `\n${lines[i]}`;
  }
  return content;
}

export function buildBody(format, event) {
  if (format === 'discord') return JSON.stringify({ content: discordContent(chatLines(event)) });
  if (format === 'slack') return JSON.stringify({ text: chatLines(event).join('\n') });
  return JSON.stringify(event);
}

function networkErrorCode(error) {
  const code = String(error?.code ?? '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE'].includes(code)) return 'CONNECT';
  if (/^(?:ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|UNABLE_TO|SELF_SIGNED)/.test(code)) return 'TLS';
  return 'NETWORK';
}

/**
 * 요청을 한 번 보낸다. 리다이렉트를 따라가지 않고 응답 본문은 읽지 않는다.
 * @param {{ url: URL, address: string, family: 4 | 6, headers: Record<string, string>, body: string, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, statusCode: number | null, errorCode: string | null }>}
 */
export function send({ url, address, family, headers, body, timeoutMs = SEND_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const request = (url.protocol === 'http:' ? http : https).request(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
      agent: false,
      // 검증한 주소로만 연결한다. 이름을 다시 풀지 않으므로 검증 뒤 DNS 응답이 바뀌어도 내부 주소로 가지 않는다.
      lookup: (hostname, options, callback) => (options?.all ? callback(null, [{ address, family }]) : callback(null, address, family)),
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      response.destroy();
      finish(statusCode >= 200 && statusCode < 300
        ? { ok: true, statusCode, errorCode: null }
        : { ok: false, statusCode, errorCode: `HTTP_${statusCode}` });
    });
    timer = setTimeout(() => {
      finish({ ok: false, statusCode: null, errorCode: 'TIMEOUT' });
      request.destroy();
    }, timeoutMs);
    request.on('error', (error) => finish({ ok: false, statusCode: null, errorCode: networkErrorCode(error) }));
    request.end(body);
  });
}

export function createDispatcher({
  model, decrypt, resolveTarget = resolveTargetAddress, send: sendRequest = send,
  allowPrivate = allowPrivateTargets, now = () => new Date(), log = console,
}) {
  let running = null;

  // 요청을 보내지 못한 이유도 발신 실패와 같은 형태로 돌려준다.
  async function deliver(endpoint, delivery, at) {
    let url;
    let secret;
    try {
      url = parseTargetUrl(decrypt(endpoint.url_enc), { allowPrivate: allowPrivate() });
      secret = decrypt(endpoint.secret_enc);
    } catch {
      return { ok: false, statusCode: null, errorCode: 'CONFIG' };
    }
    let target;
    try {
      target = await resolveTarget(url, { allowPrivate: allowPrivate() });
    } catch (error) {
      const blocked = error instanceof TargetError && error.code === 'WEBHOOK_URL_BLOCKED';
      return { ok: false, statusCode: null, errorCode: blocked ? 'BLOCKED_TARGET' : 'DNS' };
    }
    const body = buildBody(endpoint.format, JSON.parse(delivery.payload));
    const timestamp = Math.floor(at.getTime() / 1000);
    return sendRequest({
      url, ...target, body,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Trendar-Webhook/1',
        'X-Trendar-Event': delivery.event,
        'X-Trendar-Delivery': delivery.delivery_id,
        'X-Trendar-Signature': `t=${timestamp},v1=${sign(secret, timestamp, body)}`,
      },
    });
  }

  // 결과를 이미 기록한 발신. 그 뒤 단계(연속 실패 집계 등)에서 오류가 나도 기록한 결과를 덮어쓰지 않는다.
  const settled = new Set();
  async function finish(delivery, fields) {
    await model.finishDelivery(delivery.id, fields);
    settled.add(delivery.id);
  }

  async function attempt(delivery) {
    const at = new Date(now());
    const isPing = delivery.event === 'ping';
    const endpoint = await model.getEndpoint(delivery.user_id);
    if (!endpoint || (!endpoint.enabled && !isPing)) {
      await finish(delivery, {
        status: 'failed', attempts: delivery.attempts, last_status_code: null, last_error_code: 'DISABLED', next_attempt_at: null, completed_at: at,
      });
      return { status: 'failed', statusCode: null, errorCode: 'DISABLED' };
    }
    const result = await deliver(endpoint, delivery, at);
    const attempts = delivery.attempts + 1;
    const done = new Date(now());
    if (result.ok) {
      await finish(delivery, {
        status: 'success', attempts, last_status_code: result.statusCode, last_error_code: null, next_attempt_at: null, completed_at: done,
      });
      if (!isPing) await model.recordOutcome(delivery.user_id, { success: true, countsTowardDisable: false });
      return { status: 'success', statusCode: result.statusCode, errorCode: null };
    }
    if (attempts < delivery.max_attempts) {
      await finish(delivery, {
        status: 'pending', attempts, last_status_code: result.statusCode, last_error_code: result.errorCode,
        next_attempt_at: new Date(done.getTime() + RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1]), completed_at: null,
      });
      return { status: 'pending', statusCode: result.statusCode, errorCode: result.errorCode };
    }
    await finish(delivery, {
      status: 'failed', attempts, last_status_code: result.statusCode, last_error_code: result.errorCode, next_attempt_at: null, completed_at: done,
    });
    if (!isPing) {
      const { auto_disabled: autoDisabled } = await model.recordOutcome(delivery.user_id, { success: false, countsTowardDisable: true });
      if (autoDisabled) {
        await model.cancelPending(delivery.user_id, done);
        log.warn(`[webhook] user#${delivery.user_id} endpoint auto-disabled after repeated failures`);
      }
    }
    return { status: 'failed', statusCode: result.statusCode, errorCode: result.errorCode };
  }

  // 한 건의 내부 오류가 나머지 발신을 막지 않게 한다. 내부 오류도 시도 한 번으로 세어, 같은 행이 끝없이 다시 집히지 않게 한다.
  async function attemptSafely(delivery) {
    try {
      return await attempt(delivery);
    } catch (error) {
      log.warn(`[webhook] user#${delivery.user_id} delivery=${delivery.delivery_id} error=${error?.code ?? error?.name ?? 'error'}`);
      if (settled.has(delivery.id)) return null;
      const attempts = delivery.attempts + 1;
      const done = new Date(now());
      const final = attempts >= delivery.max_attempts;
      await model.finishDelivery(delivery.id, {
        status: final ? 'failed' : 'pending', attempts, last_status_code: null, last_error_code: 'INTERNAL',
        next_attempt_at: final ? null : new Date(done.getTime() + RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1]),
        completed_at: final ? done : null,
      }).catch(() => {});
      return null;
    } finally {
      settled.delete(delivery.id);
    }
  }

  function lease(at) {
    return new Date(at.getTime() + LEASE_MS);
  }

  // 한 건씩 선점해 보낸다. 묶음을 한꺼번에 선점하면 앞 건이 느릴 때 뒤 건의 lease가 먼저 끝나 다른 서버가 다시 집는다.
  function dispatchDue() {
    running ??= (async () => {
      let attempted = 0;
      while (attempted < MAX_PER_TICK) {
        const at = new Date(now());
        const due = await model.claimDue(at, lease(at), 1);
        if (!due.length) break;
        for (const delivery of due) await attemptSafely(delivery);
        attempted += due.length;
      }
      return { attempted };
    })().finally(() => { running = null; });
    return running;
  }

  async function dispatchOne(deliveryId) {
    const at = new Date(now());
    const delivery = await model.claimOne(deliveryId, at, lease(at));
    return delivery ? attemptSafely(delivery) : null;
  }

  function prune() {
    return model.pruneDeliveries(new Date(new Date(now()).getTime() - RETENTION_MS));
  }

  return { attempt, dispatchDue, dispatchOne, prune };
}

export const dispatcher = createDispatcher({ model: webhookModel, decrypt: decryptToken });
