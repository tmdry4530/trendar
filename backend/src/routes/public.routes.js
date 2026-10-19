import { Router } from 'express';

export function setLocale(locale) {
  return (req, res, next) => {
    res.locals.locale = locale;
    next();
  };
}

export function createPublicRouter({ controller }) {
  const router = Router();
  router.get('/', controller.landing);
  router.get('/trending', controller.feed('all'));
  router.get('/trending/language/:slug', controller.feed('language'));
  router.get('/trending/topic/:slug', controller.feed('topic'));
  router.get('/repo/:owner/:name', controller.repo);
  router.get(['/trending/*', '/repo/*'], controller.notFound);
  return router;
}
