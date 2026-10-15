// models/subscription.model.js — Paddle 구독 상태 저장 + 웹훅 멱등 처리.
import { pool } from '../config/db.js';

export async function upsertSubscription({
  userId,
  paddleSubscriptionId,
  paddleCustomerId,
  status,
  priceId,
  currentPeriodEnd,
}) {
  await pool.query(
    `INSERT INTO subscriptions
       (user_id, paddle_subscription_id, paddle_customer_id, status, price_id, current_period_end)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       paddle_customer_id = VALUES(paddle_customer_id),
       status = VALUES(status),
       price_id = VALUES(price_id),
       current_period_end = VALUES(current_period_end)`,
    [userId, paddleSubscriptionId, paddleCustomerId, status, priceId, currentPeriodEnd]
  );
}

export async function findByUserId(userId) {
  const [[row]] = await pool.query(
    'SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
    [userId]
  );
  return row || null;
}

export async function setUserPlan(userId, plan) {
  const [res] = await pool.query('UPDATE users SET plan = ? WHERE id = ?', [plan, userId]);
  return res.affectedRows > 0;
}

// 웹훅 멱등성: 처리한 event_id를 기록한다. 이미 있으면 true.
export async function isEventProcessed(eventId) {
  const [[row]] = await pool.query('SELECT event_id FROM paddle_events WHERE event_id = ?', [eventId]);
  return Boolean(row);
}

export async function markEventProcessed(eventId) {
  await pool.query('INSERT IGNORE INTO paddle_events (event_id) VALUES (?)', [eventId]);
}
