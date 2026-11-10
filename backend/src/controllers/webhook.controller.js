// 급상승 알림 웹훅 설정 API. 모든 처리는 세션 사용자(req.user.id) 범위다.
import { randomBytes, randomUUID } from 'node:crypto';
import { httpError } from '../middleware/errorHandler.js';
import * as webhookModel from '../models/webhook.model.js';
import { buildEvent, dispatcher as defaultDispatcher } from '../services/webhook-delivery.js';
import { seedSeen as defaultSeedSeen } from '../services/webhook-rising.js';
import { encryptToken } from '../utils/crypto.js';
import {
  MAX_URL_LENGTH, TargetError, allowPrivateTargets, formatOf, maskUrl, parseTargetUrl, resolveTarget as resolveTargetAddress,
} from '../utils/webhook-target.js';

const TEST_COOLDOWN_MS = 10_000;
// 다른 발신 작업이 테스트 ping을 먼저 집었을 때 결과를 기다리는 시간. 주소 확인(3초)과 발신 제한(5초)을 합친 것보다 길게 둔다.
const TEST_WAIT_MS = 9_000;
const TEST_POLL_MS = 200;

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function endpointView(row) {
  if (!row) return null;
  return {
    url_hint: row.url_hint, format: row.format, enabled: Boolean(row.enabled), auto_disabled: Boolean(row.auto_disabled),
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
  };
}

function deliveryView(row) {
  return {
    id: row.delivery_id, event: row.event, status: row.status, attempts: Number(row.attempts),
    status_code: row.last_status_code == null ? null : Number(row.last_status_code), error_code: row.last_error_code ?? null,
    created_at: iso(row.created_at), completed_at: iso(row.completed_at),
  };
}

export function createWebhookController({
  model, seedSeen, dispatcher, encrypt, resolveTarget = resolveTargetAddress, allowPrivate = allowPrivateTargets,
  now = () => new Date(), newId = randomUUID, newSecret = () => randomBytes(32).toString('hex'),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const lastTestAt = new Map();
  // getaddrinfo는 취소할 수 없어 시간 제한 뒤에도 스레드를 잡고 있다. 사용자당 진행 중인 주소 확인은 1건만 받는다.
  const resolving = new Set();

  async function requireEndpoint(userId) {
    const endpoint = await model.getEndpoint(userId);
    if (!endpoint) throw httpError(404, 'NOT_FOUND', '등록된 수신 URL이 없습니다.');
    return endpoint;
  }

  async function validatedUrl(raw, userId) {
    if (typeof raw !== 'string' || raw.trim() === '' || raw.length > MAX_URL_LENGTH) {
      throw httpError(400, 'VALIDATION_ERROR', '수신 URL을 확인해 주세요.');
    }
    if (resolving.has(userId)) throw httpError(429, 'WEBHOOK_SAVE_IN_PROGRESS', '이전 저장 요청을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.');
    resolving.add(userId);
    try {
      const url = parseTargetUrl(raw, { allowPrivate: allowPrivate() });
      await resolveTarget(url, { allowPrivate: allowPrivate() });
      return url;
    } catch (error) {
      if (error instanceof TargetError) throw httpError(400, error.code, '수신 URL로 보낼 수 없습니다.');
      throw error;
    } finally {
      resolving.delete(userId);
    }
  }

  async function show(req, res, next) {
    try {
      const [endpoint, deliveries] = await Promise.all([model.getEndpoint(req.user.id), model.listDeliveries(req.user.id, 10)]);
      res.json({ ok: true, data: { endpoint: endpointView(endpoint), deliveries: deliveries.map(deliveryView) } });
    } catch (e) { next(e); }
  }

  async function save(req, res, next) {
    try {
      const userId = req.user.id;
      const url = await validatedUrl(req.body?.url, userId);
      const target = { url_enc: encrypt(url.href), url_hint: maskUrl(url), format: formatOf(url) };
      const existing = await model.getEndpoint(userId);
      if (existing) {
        // 꺼져 있던 것은 URL을 바꾸면 켜지므로, 그 시점 목록을 보낸 것으로 기록한다(R2.4).
        if (!existing.enabled) await seedSeen(userId);
        await model.updateEndpointUrl(userId, target);
        return res.json({ ok: true, data: { endpoint: endpointView(await model.getEndpoint(userId)) } });
      }
      const secret = newSecret();
      await seedSeen(userId);
      try {
        await model.createEndpoint(userId, { ...target, secret_enc: encrypt(secret) });
      } catch (e) {
        if (e.code !== 'ER_DUP_ENTRY') throw e;
        // 같은 사용자의 등록 요청이 겹쳤다. 먼저 만들어진 설정의 서명 키를 유지하고 URL만 바꾼다.
        await model.updateEndpointUrl(userId, target);
        return res.json({ ok: true, data: { endpoint: endpointView(await model.getEndpoint(userId)) } });
      }
      res.status(201).json({ ok: true, data: { endpoint: endpointView(await model.getEndpoint(userId)), secret } });
    } catch (e) { next(e); }
  }

  async function setEnabled(req, res, next) {
    try {
      const userId = req.user.id;
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') throw httpError(400, 'VALIDATION_ERROR', '사용 여부를 확인해 주세요.');
      const endpoint = await requireEndpoint(userId);
      if (enabled && !endpoint.enabled) await seedSeen(userId);
      await model.setEnabled(userId, enabled);
      if (!enabled) await model.cancelPending(userId, new Date(now()));
      res.json({ ok: true, data: { endpoint: endpointView(await model.getEndpoint(userId)) } });
    } catch (e) { next(e); }
  }

  async function rotateSecret(req, res, next) {
    try {
      await requireEndpoint(req.user.id);
      const secret = newSecret();
      await model.setSecret(req.user.id, encrypt(secret));
      res.json({ ok: true, data: { secret } });
    } catch (e) { next(e); }
  }

  async function test(req, res, next) {
    try {
      const userId = req.user.id;
      await requireEndpoint(userId);
      const at = new Date(now());
      const last = lastTestAt.get(userId);
      if (last !== undefined && at.getTime() - last < TEST_COOLDOWN_MS) {
        throw httpError(429, 'WEBHOOK_TEST_RATE_LIMITED', '테스트 발신은 10초에 한 번만 할 수 있습니다.');
      }
      lastTestAt.set(userId, at.getTime());
      const deliveryId = newId();
      await model.insertDelivery({
        user_id: userId, delivery_id: deliveryId, event: 'ping',
        payload: JSON.stringify(buildEvent({ id: deliveryId, event: 'ping', createdAt: at })),
        max_attempts: 1, next_attempt_at: at, created_at: at,
      });
      // 분 단위 발신이 먼저 선점했으면 그쪽이 끝날 때까지 기다려 실제 결과를 돌려준다.
      let outcome = await dispatcher.dispatchOne(deliveryId);
      let delivery;
      for (let waited = 0; ; waited += TEST_POLL_MS) {
        delivery = (await model.listDeliveries(userId, 10)).find((row) => row.delivery_id === deliveryId);
        if (outcome || !delivery || delivery.status !== 'pending' || waited >= TEST_WAIT_MS) break;
        await sleep(TEST_POLL_MS);
        outcome = null;
      }
      res.json({ ok: true, data: { delivery: delivery ? deliveryView(delivery) : null } });
    } catch (e) { next(e); }
  }

  async function remove(req, res, next) {
    try {
      if (!await model.deleteEndpoint(req.user.id)) throw httpError(404, 'NOT_FOUND', '등록된 수신 URL이 없습니다.');
      lastTestAt.delete(req.user.id);
      res.json({ ok: true, data: { deleted: true } });
    } catch (e) { next(e); }
  }

  return { show, save, setEnabled, rotateSecret, test, remove };
}

export const { show, save, setEnabled, rotateSecret, test, remove } = createWebhookController({
  model: webhookModel, seedSeen: defaultSeedSeen, dispatcher: defaultDispatcher, encrypt: encryptToken,
});
