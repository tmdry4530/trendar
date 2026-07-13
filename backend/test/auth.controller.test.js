// test/auth.controller.test.js — OAuth 컨트롤러(createAuthController) 검증(스텁 주입, DB·fetch 불필요)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthController } from '../src/controllers/auth.controller.js';

function mockRes() {
  const res = {
    cookies: {},
    cleared: [],
    statusCode: null,
    body: null,
    redirectedTo: null,
    cookie(name, value, options) {
      res.cookies[name] = { value, options };
      return res;
    },
    clearCookie(name) {
      res.cleared.push(name);
      return res;
    },
    redirect(url) {
      res.redirectedTo = url;
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function stubCrypto() {
  return {
    encryptToken: (plain) => `ENC:${plain}`,
    newSessionToken: () => ({ token: 'session-token', hash: 'session-hash' }),
    hashSessionToken: (t) => `H:${t}`,
  };
}

function failNext(err) {
  throw err || new Error('next()가 예기치 않게 호출됨');
}

test('callback: state 불일치 → /login?error=state, 세션 미생성', async () => {
  let sessionCreated = false;
  const ctrl = createAuthController({
    oauth: {
      buildAuthorizeUrl: () => '',
      exchangeCode: async () => { throw new Error('호출되면 안 됨'); },
      fetchGithubUser: async () => { throw new Error('호출되면 안 됨'); },
    },
    users: { upsertFromGithub: async () => ({ id: 1 }), deleteById: async () => true },
    sessions: { create: async () => { sessionCreated = true; }, deleteByHash: async () => {} },
    crypto: stubCrypto(),
  });
  const req = { query: { state: 'abc', code: 'x' }, cookies: { oauth_state: 'DIFFERENT' } };
  const res = mockRes();
  await ctrl.callback(req, res, failNext);
  assert.equal(res.redirectedTo, '/login?error=state');
  assert.equal(sessionCreated, false);
  assert.ok(res.cleared.includes('oauth_state'));
});

test('callback: exchangeCode throw → /login?error=exchange', async () => {
  const ctrl = createAuthController({
    oauth: {
      buildAuthorizeUrl: () => '',
      exchangeCode: async () => { throw new Error('boom'); },
      fetchGithubUser: async () => { throw new Error('호출되면 안 됨'); },
    },
    users: { upsertFromGithub: async () => ({ id: 1 }), deleteById: async () => true },
    sessions: { create: async () => {}, deleteByHash: async () => {} },
    crypto: stubCrypto(),
  });
  const req = { query: { state: 'match', code: 'x' }, cookies: { oauth_state: 'match' } };
  const res = mockRes();
  await ctrl.callback(req, res, failNext);
  assert.equal(res.redirectedTo, '/login?error=exchange');
  assert.ok(res.cleared.includes('oauth_state'));
});

test('callback 성공: 암호화 토큰 저장 + sid httpOnly 쿠키 + / 리다이렉트', async () => {
  const PLAIN = 'gho_plaintext_access_token';
  let upsertArg;
  let sessionArgs;
  const ctrl = createAuthController({
    oauth: {
      buildAuthorizeUrl: () => '',
      exchangeCode: async () => PLAIN,
      fetchGithubUser: async () => ({ id: 123, login: 'octocat', name: 'Octo', avatar_url: 'http://a/x.png' }),
    },
    users: { upsertFromGithub: async (arg) => { upsertArg = arg; return { id: 7 }; }, deleteById: async () => true },
    sessions: { create: async (...a) => { sessionArgs = a; }, deleteByHash: async () => {} },
    crypto: stubCrypto(),
  });
  const req = { query: { state: 'match', code: 'code123' }, cookies: { oauth_state: 'match' } };
  const res = mockRes();
  await ctrl.callback(req, res, failNext);

  assert.ok(upsertArg, 'upsertFromGithub 호출됨');
  assert.notEqual(upsertArg.accessTokenEnc, PLAIN, '평문 토큰이 그대로 저장되면 안 됨');
  assert.equal(upsertArg.accessTokenEnc, `ENC:${PLAIN}`);
  assert.equal(upsertArg.githubId, 123);
  assert.equal(upsertArg.avatarUrl, 'http://a/x.png');

  assert.equal(sessionArgs[0], 7, 'sessions.create가 user.id를 받음');
  assert.equal(sessionArgs[1], 'session-hash', 'sessions.create가 토큰 해시를 받음');
  assert.ok(sessionArgs[2] instanceof Date, 'expiresAt은 Date');

  assert.ok(res.cookies.sid, 'sid 쿠키 설정됨');
  assert.equal(res.cookies.sid.value, 'session-token');
  assert.equal(res.cookies.sid.options.httpOnly, true);
  assert.equal(res.redirectedTo, '/');
  assert.ok(res.cleared.includes('oauth_state'));
});

test('logout: deleteByHash 호출 + sid 쿠키 삭제', async () => {
  let deletedHash;
  const ctrl = createAuthController({
    oauth: {},
    users: {},
    sessions: { create: async () => {}, deleteByHash: async (h) => { deletedHash = h; } },
    crypto: stubCrypto(),
  });
  const req = { cookies: { sid: 'raw-token' } };
  const res = mockRes();
  await ctrl.logout(req, res, failNext);
  assert.equal(deletedHash, 'H:raw-token');
  assert.ok(res.cleared.includes('sid'));
  assert.deepEqual(res.body, { ok: true, data: null });
});

test('logout: 세션 쿠키가 없어도 200 (무세션)', async () => {
  let deleteCalled = false;
  const ctrl = createAuthController({
    oauth: {},
    users: {},
    sessions: { create: async () => {}, deleteByHash: async () => { deleteCalled = true; } },
    crypto: stubCrypto(),
  });
  const req = { cookies: {} };
  const res = mockRes();
  await ctrl.logout(req, res, failNext);
  assert.equal(deleteCalled, false);
  assert.ok(res.cleared.includes('sid'));
  assert.deepEqual(res.body, { ok: true, data: null });
});

test('deleteAccount: users.deleteById(req.user.id) 호출 + sid 삭제', async () => {
  let deletedId;
  const ctrl = createAuthController({
    oauth: {},
    users: { deleteById: async (id) => { deletedId = id; return true; } },
    sessions: {},
    crypto: stubCrypto(),
  });
  const req = { user: { id: 99 }, cookies: {} };
  const res = mockRes();
  await ctrl.deleteAccount(req, res, failNext);
  assert.equal(deletedId, 99);
  assert.ok(res.cleared.includes('sid'));
  assert.deepEqual(res.body, { ok: true, data: null });
});

test('me: { user: { login, name, avatarUrl }, tokenInvalid } 형태로 응답', () => {
  const ctrl = createAuthController({ oauth: {}, users: {}, sessions: {}, crypto: stubCrypto() });
  const req = { user: { login: 'octocat', name: 'Octo', avatar_url: 'http://a/x.png', token_invalid: true } };
  const res = mockRes();
  ctrl.me(req, res);
  assert.deepEqual(res.body, {
    ok: true,
    data: {
      user: { login: 'octocat', name: 'Octo', avatarUrl: 'http://a/x.png' },
      tokenInvalid: true,
    },
  });
});
