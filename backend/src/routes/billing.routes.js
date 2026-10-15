// routes/billing.routes.js
import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkout, billingMe, portal, webhook } from '../controllers/billing.controller.js';

const r = Router();

// 웹훅은 Paddle 서명으로 인증한다 (세션 불필요). raw body는 app.js에서 주입.
r.post('/webhook', webhook);

r.post('/checkout', requireAuth, checkout);
r.get('/me', requireAuth, billingMe);
r.post('/portal', requireAuth, portal);

export default r;
