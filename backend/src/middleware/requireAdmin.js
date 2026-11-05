import { isAdmin } from '../config/admin.js';
import { httpError } from './errorHandler.js';

export function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return next(httpError(403, 'FORBIDDEN', '관리자 권한이 필요합니다.'));
  next();
}
