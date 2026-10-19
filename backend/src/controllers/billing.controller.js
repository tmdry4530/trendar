// controllers/billing.controller.js — Paddle 체크아웃 생성 + 웹훅 수신 + 플랜 조회.
import { httpError } from '../middleware/errorHandler.js';
import {
  createCheckoutTransaction,
  createCustomerPortalSession,
  isPaddleConfigured,
  paddleClientToken,
  paddleEnv,
  verifyWebhookSignature,
} from '../utils/paddle.js';
import * as subscriptionsModel from '../models/subscription.model.js';
import { limitsForPlan, planForSubscription } from '../services/billing.js';
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
  async function checkout(req, res, next) {
    try {
      if (!paddle.isPaddleConfigured()) {
        throw httpError(503, 'BILLING_NOT_CONFIGURED', '결제 설정이 아직 준비되지 않았습니다.');
      }
      const sub = await subscriptions.findByUserId(req.user.id);
      if (planForSubscription(sub, clock()) === 'pro') {
        throw httpError(409, 'ALREADY_PRO', '이미 Pro를 이용 중입니다.');
      }
      const { transactionId } = await paddle.createCheckoutTransaction({
        userId: req.user.id,
        customerId: sub?.paddle_customer_id,
      });
      res.json({ ok: true, data: { transaction_id: transactionId } });
    } catch (e) { next(e); }
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
      const limits = { free: limitsForPlan('free'), pro: limitsForPlan('pro') };
      const configured = paddle.isPaddleConfigured();
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
          configured,
          client: configured
            ? { token: paddle.paddleClientToken(), environment: paddle.paddleEnv() }
            : null,
          limits,
          usage: {
            queries_used: queryRows.length,
            queries_limit: limits[plan].queriesPerUser,
            manual_used_today: users.manualUsageFromRow(user, kstToday(now)),
            manual_limit: limits[plan].manualEtlPerDay,
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
  paddle: {
    createCheckoutTransaction,
    createCustomerPortalSession,
    isPaddleConfigured,
    paddleClientToken,
    paddleEnv,
  },
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
