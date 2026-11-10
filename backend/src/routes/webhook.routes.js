import { Router } from 'express';
import * as c from '../controllers/webhook.controller.js';

// 서명 키와 발신 기록이 중간 캐시에 남지 않게 한다. 401 응답에도 붙도록 인증보다 먼저 건다.
export function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

export function createWebhookRouter(handlers = c) {
  const r = Router();
  r.get('/', handlers.show);
  r.put('/', handlers.save);
  r.patch('/', handlers.setEnabled);
  r.post('/secret', handlers.rotateSecret);
  r.post('/test', handlers.test);
  r.delete('/', handlers.remove);
  return r;
}

export default createWebhookRouter();
