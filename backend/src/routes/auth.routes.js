// routes/auth.routes.js
import { Router } from 'express';
import authController from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';

const r = Router();
r.get('/github', authController.login);
r.get('/github/callback', authController.callback);
r.post('/logout', authController.logout);
r.get('/me', requireAuth, authController.me);
r.delete('/account', requireAuth, authController.deleteAccount);
export default r;
