import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import queryRoutes from './routes/query.routes.js';
import repoRoutes from './routes/repo.routes.js';
import etlRoutes from './routes/etl.routes.js';
import statsRoutes from './routes/stats.routes.js';
import authRoutes from './routes/auth.routes.js';
import localizationRoutes from './routes/localization.routes.js';
import billingRoutes from './routes/billing.routes.js';
import { requireAuth } from './middleware/requireAuth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createPublicDeps, mountPublic } from './public-mount.js';
import { trustProxyHops } from './utils/limits.js';

export function createApp({ publicDeps = createPublicDeps() } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxyHops());
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        scriptSrc: ["'self'", 'https://cdn.paddle.com'],
        frameSrc: ['https://buy.paddle.com', 'https://sandbox-buy.paddle.com'],
        connectSrc: ["'self'", 'https://*.paddle.com'],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
  }));
  // Paddle 웹훅 서명 검증에는 raw body가 필요하므로, JSON 파서보다 먼저 등록한다.
  app.use('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
  app.use(express.json());
  app.use(cookieParser());

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.use('/api/localization', localizationRoutes);
  app.use('/api/auth', authRoutes);
  // Paddle 웹훅은 세션이 아닌 Paddle-Signature로 인증한다.
  app.use('/api/billing', billingRoutes);
  app.use('/api/queries', requireAuth, queryRoutes);
  app.use('/api/repos', requireAuth, repoRoutes);
  app.use('/api/etl', requireAuth, etlRoutes);
  app.use('/api', requireAuth, statsRoutes);

  // 공개 SSR·이미지 라우트는 SPA 정적 서빙보다 먼저 응답해야 한다(`/`, `/sitemap.xml` 포함).
  mountPublic(app, publicDeps);

  if (process.env.NODE_ENV === 'production') {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const dist = path.resolve(__dirname, '../../frontend/dist');
    app.use(express.static(dist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use(errorHandler);

  return app;
}

export default createApp();
