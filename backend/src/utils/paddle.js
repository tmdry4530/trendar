// utils/paddle.js — Paddle Billing API 클라이언트(고객 포털) + 웹훅 서명 검증.
// 신규 결제는 받지 않는다. 기존 고객의 포털 세션과 서명 웹훅만 처리한다.
import crypto from 'node:crypto';

const API_BASE = {
  sandbox: 'https://sandbox-api.paddle.com',
  production: 'https://api.paddle.com',
};

export function paddleEnv() {
  return process.env.PADDLE_ENV === 'production' ? 'production' : 'sandbox';
}

export function paddleApiBase() {
  return API_BASE[paddleEnv()];
}

export function paddleApiKey() {
  return process.env.PADDLE_API_KEY || '';
}

function safeErrorDetail(value) {
  if (typeof value !== 'string') return null;
  for (const secret of [paddleApiKey(), process.env.PADDLE_WEBHOOK_SECRET]) {
    if (secret) value = value.replaceAll(secret, '[redacted]');
  }
  return value;
}

async function paddleFetch(path, { method = 'GET', body } = {}) {
  const key = paddleApiKey();
  if (!key) throw new Error('PADDLE_API_KEY is not set');
  const res = await fetch(`${paddleApiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[paddle] API request failed', {
      status: res.status,
      code: safeErrorDetail(data?.error?.code),
      detail: safeErrorDetail(data?.error?.detail || data?.error?.message),
    });
    throw new Error('Paddle API request failed');
  }
  return data.data;
}

// 고객 포털 세션 생성 (구독 관리·취소용).
export async function createCustomerPortalSession(customerId) {
  const data = await paddleFetch(`/customers/${customerId}/portal-sessions`, {
    method: 'POST',
    body: {},
  });
  const url =
    data?.urls?.general?.overview || data?.urls?.general || data?.url;
  if (!url || typeof url !== 'string') throw new Error('Paddle did not return a portal URL');
  return { portalUrl: url };
}

// 웹훅 서명 검증. Paddle-Signature: "ts=<unix>;h1=<hex hmac-sha256(ts + ':' + rawBody)>".
// 성공 시 true, 실패 시 false (예외를 던지지 않는다 — 호출 측에서 401 처리).
export function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  try {
    if (!rawBody || !signatureHeader || !secret) return false;
    const parts = String(signatureHeader).split(';');
    const tsPart = parts.find((p) => p.trim().startsWith('ts='));
    const h1Part = parts.find((p) => p.trim().startsWith('h1='));
    if (!tsPart || !h1Part) return false;
    const ts = Number(tsPart.trim().slice(3));
    const h1 = h1Part.trim().slice(3);
    if (!Number.isFinite(ts)) return false;
    // 5분 이상 오래된 요청은 리플레이로 간주.
    if (Math.abs(Date.now() / 1000 - ts) > 300) return false;
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    const signed = Buffer.concat([Buffer.from(`${ts}:`, 'utf8'), body]);
    const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
    const a = Buffer.from(h1, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
