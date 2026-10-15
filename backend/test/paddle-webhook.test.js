// test/paddle-webhook.test.js — Paddle 웹훅 서명 검증 (DB 불필요, 순수 함수).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyWebhookSignature } from '../src/utils/paddle.js';

const SECRET = 'pdl_ntf_test_secret_123';

function sign(ts, body) {
  const signed = Buffer.concat([Buffer.from(`${ts}:`, 'utf8'), Buffer.from(body, 'utf8')]);
  return crypto.createHmac('sha256', SECRET).update(signed).digest('hex');
}

function header(ts, body, secret = SECRET) {
  const h1 = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${ts}:`, 'utf8'), Buffer.from(body, 'utf8')]))
    .digest('hex');
  return `ts=${ts};h1=${h1}`;
}

test('올바른 서명은 통과', () => {
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ event_id: 'evt_1', event_type: 'subscription.created' });
  assert.equal(verifyWebhookSignature(Buffer.from(body), header(ts, body), SECRET), true);
});

test('잘못된 secret 서명은 거부', () => {
  const ts = Math.floor(Date.now() / 1000);
  const body = '{"event_id":"evt_1"}';
  assert.equal(verifyWebhookSignature(Buffer.from(body), header(ts, body, 'wrong'), SECRET), false);
});

test('body가 변조되면 거부', () => {
  const ts = Math.floor(Date.now() / 1000);
  const body = '{"event_id":"evt_1"}';
  const tampered = '{"event_id":"evt_2"}';
  assert.equal(verifyWebhookSignature(Buffer.from(tampered), header(ts, body), SECRET), false);
});

test('5분 이상 오래된 ts는 리플레이로 거부', () => {
  const ts = Math.floor(Date.now() / 1000) - 301;
  const body = '{"event_id":"evt_1"}';
  assert.equal(verifyWebhookSignature(Buffer.from(body), header(ts, body), SECRET), false);
});

test('헤더 형식이 깨지면 거부', () => {
  assert.equal(verifyWebhookSignature(Buffer.from('{}'), 'garbage', SECRET), false);
  assert.equal(verifyWebhookSignature(Buffer.from('{}'), '', SECRET), false);
  assert.equal(verifyWebhookSignature(null, 'ts=1;h1=abc', SECRET), false);
});
