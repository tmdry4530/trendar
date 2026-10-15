// controllers/billing.controller.js — Paddle 체크아웃 생성 + 웹훅 수신 + 플랜 조회.
import { httpError } from '../middleware/errorHandler.js';
import {
  createCheckoutTransaction,
  createCustomerPortalSession,
  isPaddleConfigured,
  verifyWebhookSignature,
} from '../utils/paddle.js';
import {
  findByUserId,
  isEventProcessed,
  markEventProcessed,
  setUserPlan,
  upsertSubscription,
} from '../models/subscription.model.js';
import { effectivePlan, planForSubscription } from '../services/billing.js';

function webhookSecret() {
  return process.env.PADDLE_WEBHOOK_SECRET || '';
}

// POST /api/billing/checkout — 호스티드 체크아웃 URL 발급 (로그인 필요).
export async function checkout(req, res, next) {
  try {
    if (!isPaddleConfigured()) {
      throw httpError(503, 'BILLING_NOT_CONFIGURED', '결제 설정이 아직 준비되지 않았습니다.');
    }
    const plan = await effectivePlan(req.user.id);
    if (plan === 'pro') {
      throw httpError(409, 'ALREADY_PRO', '이미 Pro를 이용 중입니다.');
    }
    const { checkoutUrl } = await createCheckoutTransaction({ userId: req.user.id });
    res.json({ ok: true, data: { checkout_url: checkoutUrl } });
  } catch (e) { next(e); }
}

// GET /api/billing/me — 현재 요금제 + 구독 상태 (로그인 필요).
export async function billingMe(req, res, next) {
  try {
    const sub = await findByUserId(req.user.id);
    const plan = planForSubscription(sub);
    res.json({
      ok: true,
      data: {
        plan,
        subscription: sub
          ? {
              status: sub.status,
              current_period_end: sub.current_period_end,
              price_id: sub.price_id,
            }
          : null,
        configured: isPaddleConfigured(),
      },
    });
  } catch (e) { next(e); }
}

// POST /api/billing/portal — Paddle 고객 포털 URL (구독 관리·취소, 로그인 필요).
export async function portal(req, res, next) {
  try {
    const sub = await findByUserId(req.user.id);
    if (!sub?.paddle_customer_id) {
      throw httpError(404, 'NO_SUBSCRIPTION', '관리할 구독이 없습니다.');
    }
    const { portalUrl } = await createCustomerPortalSession(sub.paddle_customer_id);
    res.json({ ok: true, data: { portal_url: portalUrl } });
  } catch (e) { next(e); }
}

// POST /api/billing/webhook — Paddle 알림 수신. 서명 검증 필수, 멱등 처리.
export async function webhook(req, res, next) {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '', 'utf8');
    const ok = verifyWebhookSignature(raw, req.headers['paddle-signature'], webhookSecret());
    if (!ok) {
      return res.status(401).json({ ok: false, error: 'INVALID_SIGNATURE' });
    }
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ ok: false, error: 'INVALID_JSON' });
    }
    const eventId = event.event_id;
    const eventType = event.event_type;
    if (!eventId || !eventType) {
      return res.status(400).json({ ok: false, error: 'INVALID_EVENT' });
    }
    // 멱등: 이미 처리한 이벤트는 200만 반환.
    if (await isEventProcessed(eventId)) {
      return res.json({ ok: true, data: { deduped: true } });
    }
    await handleEvent(eventType, event.data || {});
    await markEventProcessed(eventId);
    return res.json({ ok: true });
  } catch (e) { next(e); }
}

const SUBSCRIPTION_EVENTS = new Set([
  'subscription.created',
  'subscription.activated',
  'subscription.updated',
  'subscription.canceled',
  'subscription.paused',
  'subscription.resumed',
  'subscription.past_due',
]);

async function handleEvent(eventType, data) {
  if (!SUBSCRIPTION_EVENTS.has(eventType)) return; // 그 외 이벤트는 무시 (로그만)
  const paddleSubscriptionId = data.id;
  if (!paddleSubscriptionId) return;
  // 사용자 연결: custom_data.user_id 우선, 없으면 기존 레코드의 user_id.
  let userId = data.custom_data?.user_id ? Number(data.custom_data.user_id) : NaN;
  if (!Number.isInteger(userId)) {
    const existing = await findByPaddleSubscriptionId(paddleSubscriptionId);
    if (!existing) return;
    userId = existing.user_id;
  }
  const currentPeriodEnd = data.current_billing_period?.ends_at || null;
  await upsertSubscription({
    userId,
    paddleSubscriptionId,
    paddleCustomerId: data.customer_id || null,
    status: data.status || 'unknown',
    priceId: data.items?.[0]?.price?.id || null,
    currentPeriodEnd,
  });
  const sub = await findByUserId(userId);
  await setUserPlan(userId, planForSubscription(sub));
}

// paddle_subscription_id로 기존 레코드 조회 (custom_data가 없을 때 폴백).
async function findByPaddleSubscriptionId(paddleSubscriptionId) {
  const { pool } = await import('../config/db.js');
  const [[row]] = await pool.query(
    'SELECT * FROM subscriptions WHERE paddle_subscription_id = ? LIMIT 1',
    [paddleSubscriptionId]
  );
  return row || null;
}
