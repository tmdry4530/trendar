// controllers/auth.controller.js — GitHub OAuth 로그인 플로우 + 계정 수명주기
import { randomBytes } from 'node:crypto';
import * as oauthService from '../services/github-oauth.js';
import * as usersModel from '../models/user.model.js';
import * as sessionsModel from '../models/session.model.js';
import { encryptToken, newSessionToken, hashSessionToken } from '../utils/crypto.js';
import { SESSION_COOKIE } from '../middleware/requireAuth.js';

const OAUTH_STATE_COOKIE = 'oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000;

const isProd = () => process.env.NODE_ENV === 'production';

function ttlDays() {
  const n = Number(process.env.SESSION_TTL_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function cookieOpts(maxAge) {
  return { httpOnly: true, sameSite: 'lax', secure: isProd(), maxAge, path: '/' };
}

export function createAuthController(deps) {
  const { oauth, users, sessions, crypto } = deps;

  function login(req, res) {
    const state = randomBytes(32).toString('hex');
    res.cookie(OAUTH_STATE_COOKIE, state, cookieOpts(STATE_TTL_MS));
    res.redirect(oauth.buildAuthorizeUrl({ state }));
  }

  async function callback(req, res, next) {
    // state 쿠키는 결과와 무관하게 1회성으로 소비한다.
    const stateCookie = req.cookies?.[OAUTH_STATE_COOKIE];
    res.clearCookie(OAUTH_STATE_COOKIE);

    if (req.query.error) return res.redirect('/login?error=denied');

    const { state, code } = req.query;
    if (!state || !stateCookie || state !== stateCookie) {
      return res.redirect('/login?error=state');
    }

    let accessToken;
    try {
      accessToken = await oauth.exchangeCode(code);
    } catch (err) {
      console.error('[auth] 토큰 교환 실패:', err.message);
      return res.redirect('/login?error=exchange');
    }

    let profile;
    try {
      profile = await oauth.fetchGithubUser(accessToken);
    } catch (err) {
      console.error('[auth] 프로필 조회 실패:', err.message);
      return res.redirect('/login?error=profile');
    }

    try {
      const user = await users.upsertFromGithub({
        githubId: profile.id,
        login: profile.login,
        name: profile.name,
        avatarUrl: profile.avatar_url,
        accessTokenEnc: crypto.encryptToken(accessToken),
      });
      const { token, hash } = crypto.newSessionToken();
      const ttlMs = ttlDays() * 24 * 60 * 60 * 1000;
      const expiresAt = new Date(Date.now() + ttlMs);
      await sessions.create(user.id, hash, expiresAt);
      res.cookie(SESSION_COOKIE, token, cookieOpts(ttlMs));
      return res.redirect('/');
    } catch (err) {
      return next(err);
    }
  }

  async function logout(req, res, next) {
    try {
      const token = req.cookies?.[SESSION_COOKIE];
      if (token) {
        await sessions.deleteByHash(crypto.hashSessionToken(token));
      }
      res.clearCookie(SESSION_COOKIE);
      res.json({ ok: true, data: null });
    } catch (err) {
      next(err);
    }
  }

  function me(req, res) {
    res.json({
      ok: true,
      data: {
        user: {
          login: req.user.login,
          name: req.user.name,
          avatarUrl: req.user.avatar_url,
        },
        tokenInvalid: req.user.token_invalid,
      },
    });
  }

  async function deleteAccount(req, res, next) {
    try {
      await users.deleteById(req.user.id);
      res.clearCookie(SESSION_COOKIE);
      res.json({ ok: true, data: null });
    } catch (err) {
      next(err);
    }
  }

  return { login, callback, logout, me, deleteAccount };
}

export default createAuthController({
  oauth: oauthService,
  users: usersModel,
  sessions: sessionsModel,
  crypto: { encryptToken, newSessionToken, hashSessionToken },
});
