import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as publicModel from './models/public.model.js';
import { hasValidByHash } from './models/session.model.js';
import { allFeeds } from './config/public-feeds.js';
import { createPublicController } from './controllers/public.controller.js';
import { SESSION_COOKIE } from './middleware/requireAuth.js';
import { createRateLimiter } from './middleware/public-rate-limit.js';
import { createPublicAssetsRouter } from './routes/public-assets.routes.js';
import { createPublicRouter, setLocale } from './routes/public.routes.js';
import { createPageViewTracker } from './services/public-analytics.js';
import { createPublicData } from './services/public-data.js';
import { createOgRenderer, createResvgPngRenderer, OG_FONT_PATHS, RESVG_WASM_PATH } from './services/public-og.js';
import { createSitemapHandler } from './services/public-sitemap.js';
import { measureCandidate, rankRising } from './services/rising-score.js';
import { hashSessionToken } from './utils/crypto.js';
import { publicAnalyticsFlushMs, publicImageRateLimitPerMin, publicRisingConfig } from './utils/limits.js';
import { createTtlCache } from './utils/ttl-cache.js';

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');

function fallbackPngPath() {
  return path.join(FRONTEND_DIR, process.env.NODE_ENV === 'production' ? 'dist' : 'public', 'og-v2.png');
}

function createIsAuthenticated(hasValidSession) {
  return async function isAuthenticated(req) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return false;
    try {
      return await hasValidSession(hashSessionToken(token));
    } catch {
      return false;
    }
  };
}

export function createPublicDeps(overrides = {}) {
  const pick = (key, build) => (Object.hasOwn(overrides, key) ? overrides[key] : build());

  const model = pick('model', () => publicModel);
  const feeds = pick('feeds', () => allFeeds());
  const appUrl = pick('appUrl', () => process.env.APP_URL || 'http://localhost:5173');
  const cache = pick('cache', () => createTtlCache({ ttlMs: 600000 }));
  const data = pick('data', () => createPublicData({
    model,
    feeds,
    rankRising,
    measureCandidate,
    risingConfig: publicRisingConfig(),
    cache,
  }));
  const og = pick('og', () => createOgRenderer({
    renderPng: createResvgPngRenderer({ wasmPath: RESVG_WASM_PATH, fontPaths: OG_FONT_PATHS }),
    fallbackPng: readFileSync(fallbackPngPath()),
  }));
  const tracker = pick('tracker', () => {
    const created = createPageViewTracker({ addDailyMetrics: model.addDailyMetrics, flushMs: publicAnalyticsFlushMs() });
    created.start();
    return created;
  });
  const rateLimit = pick('rateLimit', () => createRateLimiter({ limit: publicImageRateLimitPerMin() }));
  const isAuthenticated = pick('isAuthenticated', () => createIsAuthenticated(hasValidByHash));
  const sitemapHandler = pick('sitemapHandler', () => createSitemapHandler({ data, appUrl }));
  const pagesRouter = pick('pagesRouter', () => createPublicRouter({
    controller: createPublicController({ data, feeds, appUrl, isAuthenticated }),
  }));
  const assetsRouter = pick('assetsRouter', () => createPublicAssetsRouter({ data, og, rateLimit }));

  return { cache, data, og, tracker, rateLimit, isAuthenticated, appUrl, sitemapHandler, pagesRouter, assetsRouter };
}

export function mountPublic(app, deps) {
  app.use(deps.tracker.middleware);
  app.get('/sitemap.xml', deps.sitemapHandler);
  app.use(deps.assetsRouter);
  app.use('/ko', setLocale('ko'), deps.pagesRouter);
  app.use(setLocale('en'), deps.pagesRouter);
}
