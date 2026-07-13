// middleware/requireAuth.js — 세션 쿠키 기반 인증 미들웨어
import { httpError } from './errorHandler.js';
import { hashSessionToken } from '../utils/crypto.js';
import { findValidByHash, deleteByHash } from '../models/session.model.js';

export const SESSION_COOKIE = 'sid';

export function createRequireAuth(deps) {
  const findSession = deps.findValidByHash;
  const dropSession = deps.deleteByHash;
  return async function requireAuth(req, res, next) {
    try {
      const token = req.cookies?.[SESSION_COOKIE];
      if (!token) {
        return next(httpError(401, 'UNAUTHORIZED', '로그인이 필요합니다'));
      }
      const hash = hashSessionToken(token);
      const session = await findSession(hash);
      if (!session) {
        if (dropSession) Promise.resolve(dropSession(hash)).catch(() => {});
        return next(httpError(401, 'UNAUTHORIZED', '로그인이 필요합니다'));
      }
      req.user = session.user;
      req.sessionTokenHash = hash;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireAuth = createRequireAuth({ findValidByHash, deleteByHash });
