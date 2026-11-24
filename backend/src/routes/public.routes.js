import { Router } from 'express';

export function setLocale(locale) {
  return (req, res, next) => {
    res.locals.locale = locale;
    next();
  };
}

export function createPublicRouter({ controller, rateLimit } = {}) {
  const router = Router();
  const limit = rateLimit ? [rateLimit] : [];
  router.get('/', ...limit, controller.landing);
  router.get('/trending', ...limit, controller.feed('all'));
  router.get('/trending/language/:slug', ...limit, controller.feed('language'));
  router.get('/trending/topic/:slug', ...limit, controller.feed('topic'));
  router.get('/repo/:owner/:name', ...limit, controller.repo);
  router.get(['/trending/*', '/repo/*'], ...limit, controller.notFound);
  return router;
}
