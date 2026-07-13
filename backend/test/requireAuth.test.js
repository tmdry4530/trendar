// test/requireAuth.test.js — 세션 쿠키 인증 미들웨어(createRequireAuth) 검증(스텁 주입, DB 불필요)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequireAuth, SESSION_COOKIE } from '../src/middleware/requireAuth.js';
import { hashSessionToken } from '../src/utils/crypto.js';

function mockNext() {
  const next = (err) => next.calls.push(err);
  next.calls = [];
  return next;
}

const noopRes = {};

test('쿠키가 없으면 findValidByHash 호출 없이 401', async () => {
  const mw = createRequireAuth({
    findValidByHash: async () => { throw new Error('호출되면 안 됨'); },
    deleteByHash: async () => {},
  });
  const next = mockNext();
  await mw({ cookies: {} }, noopRes, next);
  assert.equal(next.calls.length, 1);
  assert.equal(next.calls[0].status, 401);
  assert.equal(next.calls[0].code, 'UNAUTHORIZED');
});

test('req.cookies가 undefined여도 throw 없이 401', async () => {
  const mw = createRequireAuth({ findValidByHash: async () => null, deleteByHash: async () => {} });
  const next = mockNext();
  await mw({}, noopRes, next);
  assert.equal(next.calls.length, 1);
  assert.equal(next.calls[0].status, 401);
});

test('알 수 없는 토큰이면 401', async () => {
  const mw = createRequireAuth({ findValidByHash: async () => null, deleteByHash: async () => {} });
  const next = mockNext();
  await mw({ cookies: { [SESSION_COOKIE]: 'unknown-token' } }, noopRes, next);
  assert.equal(next.calls.length, 1);
  assert.equal(next.calls[0].status, 401);
});

test('유효한 세션이면 req.user 부착 후 인자 없이 next', async () => {
  const user = { id: 7, github_id: 42, login: 'octocat', name: 'Octo', avatar_url: null, token_invalid: false };
  const mw = createRequireAuth({
    findValidByHash: async () => ({ sessionId: 1, expiresAt: new Date(), user }),
    deleteByHash: async () => {},
  });
  const next = mockNext();
  const req = { cookies: { [SESSION_COOKIE]: 'valid-token' } };
  await mw(req, noopRes, next);
  assert.equal(next.calls.length, 1);
  assert.equal(next.calls[0], undefined);
  assert.deepEqual(req.user, user);
  assert.equal(req.sessionTokenHash, hashSessionToken('valid-token'));
});

test('원본 토큰이 SHA-256 hex로 해시되어 조회된다', async () => {
  let received;
  const mw = createRequireAuth({
    findValidByHash: async (hash) => { received = hash; return null; },
    deleteByHash: async () => {},
  });
  const next = mockNext();
  const token = 'raw-session-token';
  await mw({ cookies: { [SESSION_COOKIE]: token } }, noopRes, next);
  assert.match(received, /^[0-9a-f]{64}$/);
  assert.equal(received, hashSessionToken(token));
  assert.notEqual(received, token);
});

test('deleteByHash 미제공이어도 miss 시 throw 없이 401', async () => {
  const mw = createRequireAuth({ findValidByHash: async () => null });
  const next = mockNext();
  await mw({ cookies: { [SESSION_COOKIE]: 'x' } }, noopRes, next);
  assert.equal(next.calls.length, 1);
  assert.equal(next.calls[0].status, 401);
});
