import { Router } from 'express';
import controller from '../controllers/admin.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

export function createAdminRouter({ authenticate = requireAuth, authorize = requireAdmin, handlers = controller } = {}) {
  const router = Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(authenticate, authorize);
  router.use((req, res, next) => {
    if (req.method === 'GET') return next();
    res.set('Allow', 'GET');
    res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '조회만 가능합니다.' } });
  });
  router.get('/overview', handlers.overview);
  router.get('/users', handlers.users);
  router.get('/feeds', handlers.feeds);
  router.use((req, res) => {
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '요청한 항목을 찾지 못했습니다.' } });
  });
  // DB/driver errors can carry arbitrary codes. Never forward those to API consumers.
  router.use((err, req, res, next) => {
    const errors = {
      UNAUTHORIZED: [401, '로그인이 필요합니다.'],
      FORBIDDEN: [403, '이 작업을 할 권한이 없습니다.'],
      VALIDATION_ERROR: [400, '입력한 내용을 확인해 주세요.'],
    };
    const known = Object.hasOwn(errors, err.code) && errors[err.code][0] === err.status;
    const code = known ? err.code : 'INTERNAL_ERROR';
    const [status, message] = known ? errors[code] : [500, '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'];
    res.status(status).json({ ok: false, error: { code, message } });
  });
  return router;
}

export default createAdminRouter();
