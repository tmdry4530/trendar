// controllers/billing.controller.js — 신규 결제 차단 + 웹훅 수신 + 구독 조회·포털.
import { httpError } from '../middleware/errorHandler.js';
import { createCustomerPortalSession, verifyWebhookSignature } from '../utils/paddle.js';
import * as subscriptionsModel from '../models/subscription.model.js';
import { currentLimits, planForSubscription } from '../services/billing.js';
import * as queriesModel from '../models/query.model.js';
import * as usersModel from '../models/user.model.js';
import { kstToday, kstNextMidnight } from '../utils/kst.js';

function webhookSecret() {
  return process.env.PADDLE_WEBHOOK_SECRET || '';
}

export function createBillingController({
  paddle,
  subscriptions,
  queries,
  users,
  clock = () => new Date(),
}) {
  // 신규 판매 중지: 인증된 요청도 외부·DB 호출 없이 거부한다.
  async function checkout(req, res, next) {
    next(httpError(403, 'BILLING_DISABLED', '신규 결제는 받지 않습니다.'));
  }

  async function billingMe(req, res, next) {
    try {
      const now = clock();
      const [sub, queryRows, user] = await Promise.all([
        subscriptions.findByUserId(req.user.id),
        queries.findAll(req.user.id),
        users.findById(req.user.id),
      ]);
      const plan = planForSubscription(sub, now);
      const common = currentLimits();
      const limits = { free: common, pro: common };
      res.json({
        ok: true,
        data: {
          plan,
          subscription: sub
            ? {
                status: sub.status,
                current_period_end: sub.current_period_end ?? null,
                price_id: sub.price_id ?? null,
                has_customer: Boolean(sub.paddle_customer_id),
              }
            : null,
          configured: false,
          client: null,
          limits,
          usage: {
            queries_used: queryRows.length,
            queries_limit: common.queriesPerUser,
            manual_used_today: users.manualUsageFromRow(user, kstToday(now)),
            manual_limit: common.manualEtlPerDay,
            manual_reset_at: kstNextMidnight(now).toISOString(),
          },
        },
      });
    } catch (e) { next(e); }
  }

  async function portal(req, res, next) {
    try {
      const sub = await subscriptions.findByUserId(req.user.id);
      if (!sub?.paddle_customer_id) {
        throw httpError(404, 'NO_SUBSCRIPTION', '관리할 구독이 없습니다.');
      }
      const { portalUrl } = await paddle.createCustomerPortalSession(sub.paddle_customer_id);
      res.json({ ok: true, data: { portal_url: portalUrl } });
    } catch (e) { next(e); }
  }

  return { checkout, billingMe, portal };
}

export const { checkout, billingMe, portal } = createBillingController({
  paddle: { createCustomerPortalSession },
  subscriptions: subscriptionsModel,
  queries: queriesModel,
  users: usersModel,
});

const SUBSCRIPTION_EVENTS = new Set([
  'subscription.created',
  'subscription.activated',
  'subscription.updated',
  'subscription.canceled',
  'subscription.paused',
  'subscription.resumed',
  'subscription.past_due',
]);

export function createBillingWebhook({
  subscriptions,
  verifySignature = verifyWebhookSignature,
  secret = webhookSecret,
}) {
  async function handleEvent(eventType, data) {
    if (!SUBSCRIPTION_EVENTS.has(eventType)) return;
    const paddleSubscriptionId = data.id;
    if (!paddleSubscriptionId) return;
    let userId = data.custom_data?.user_id ? Number(data.custom_data.user_id) : NaN;
    if (!Number.isInteger(userId)) {
      const existing = await subscriptions.findByPaddleSubscriptionId(paddleSubscriptionId);
      if (!existing) return;
      userId = existing.user_id;
    }
    const existing = await subscriptions.findByUserId(userId);
    if (existing && existing.paddle_subscription_id !== paddleSubscriptionId
      && !['active', 'trialing', 'past_due'].includes(data.status)) return;

    const periodEnd = data.current_billing_period?.ends_at;
    const currentPeriodEnd = periodEnd ? new Date(periodEnd) : null;
    await subscriptions.upsertSubscription({
      userId,
      paddleSubscriptionId,
      paddleCustomerId: data.customer_id || null,
      status: data.status || 'unknown',
      priceId: data.items?.[0]?.price?.id || null,
      currentPeriodEnd: currentPeriodEnd && Number.isFinite(currentPeriodEnd.getTime())
        ? currentPeriodEnd
        : null,
    });
    const sub = await subscriptions.findByUserId(userId);
    await subscriptions.setUserPlan(userId, planForSubscription(sub));
  }

  return async function webhook(req, res, next) {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '', 'utf8');
      if (!verifySignature(raw, req.headers['paddle-signature'], secret())) {
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
      if (await subscriptions.isEventProcessed(eventId)) {
        return res.json({ ok: true, data: { deduped: true } });
      }
      await handleEvent(eventType, event.data || {});
      await subscriptions.markEventProcessed(eventId);
      return res.json({ ok: true });
    } catch (e) { next(e); }
  };
}

export const webhook = createBillingWebhook({ subscriptions: subscriptionsModel });
