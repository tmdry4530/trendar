import { OWNER_RE, REPO_NAME_RE, SLUG_RE } from '../config/public-feeds.js';
import { routeTemplateOf } from '../utils/public-output.js';
import { renderFeedPage, renderLandingPage, renderNotFoundPage, renderRepoPage } from '../views/public-pages.js';

const HTML_TYPE = 'text/html; charset=utf-8';
const UNAVAILABLE_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Trendar temporarily unavailable</title></head><body><h1>Trendar is temporarily unavailable</h1><p>Please try again shortly.</p></body></html>';

// Public documents must not fall through to the API's JSON error handler.
// Also handles routing/decoding errors before a controller can run.
export function publicErrorHandler(error, req, res, next) {
  if (res.headersSent || !['GET', 'HEAD'].includes(req.method)) return next(error);
  const reportedStatus = error?.status ?? error?.statusCode;
  const status = error instanceof URIError ? 400
    : Number.isInteger(reportedStatus) && reportedStatus >= 400 && reportedStatus < 500 ? reportedStatus : 503;
  if (/^\/sitemap\.xml\/?$/i.test(req.path)) {
    const message = status === 503 ? 'Trendar is temporarily unavailable. Please try again shortly.' : `Trendar could not process this request (${status}).`;
    return res.status(status).set('Cache-Control', 'no-store').type('text/plain').send(message);
  }
  const path = req.path.replace(/^\/ko(?=\/|$)/i, '') || '/';
  if (path !== '/' && !/^\/(?:trending|repo)(?:\/|$)/i.test(path)) return next(error);
  const html = status === 503 ? UNAVAILABLE_HTML
    : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${status} | Trendar</title></head><body><h1>${status} — Trendar could not process this request</h1><p>Please check the requested URL.</p></body></html>`;
  return res.status(status).set('Content-Type', HTML_TYPE).set('Cache-Control', 'no-store').send(html);
}

function localeOf(res) {
  return res.locals.locale === 'ko' ? 'ko' : 'en';
}

export function createPublicController({ data, feeds, appUrl, isAuthenticated, maxAge = 600 }) {
  const publicCache = `public, max-age=${maxAge}`;
  const staticFeedIndex = feeds.map(({ kind, slug, name }) => ({ kind, slug, name }));

  function send(res, status, cacheControl, template, html) {
    res.locals.track?.(template);
    res.status(status).set('Content-Type', HTML_TYPE).set('Cache-Control', cacheControl).send(html());
  }

  function notFound(req, res, next) {
    try {
      const locale = localeOf(res);
      send(res, 404, publicCache, 'not-found', () => renderNotFoundPage({ locale, feedIndex: staticFeedIndex, appUrl }));
    } catch (error) {
      publicErrorHandler(error, req, res, next);
    }
  }

  async function landing(req, res, next) {
    try {
      const locale = localeOf(res);
      let cacheControl = publicCache;
      if (locale === 'en') {
        cacheControl = 'private, no-store';
        res.set('Cache-Control', cacheControl);
        res.vary('Cookie');
        if (await isAuthenticated(req)) return next();
      }
      const [view, feedIndex] = await Promise.all([data.getFeed('all', 'all'), data.getFeedIndex()]);
      send(res, 200, cacheControl, 'landing', () => renderLandingPage({ locale, view, feedIndex, appUrl }));
    } catch (err) {
      publicErrorHandler(err, req, res, next);
    }
  }

  function feed(kind) {
    return async (req, res, next) => {
      try {
        const slug = kind === 'all' ? 'all' : req.params.slug;
        if (!SLUG_RE.test(slug)) return notFound(req, res, next);
        const view = await data.getFeed(kind, slug);
        if (!view) return notFound(req, res, next);
        const locale = localeOf(res);
        const feedIndex = await data.getFeedIndex();
        send(res, 200, publicCache, routeTemplateOf(kind), () => renderFeedPage({ locale, view, feedIndex, appUrl }));
      } catch (err) {
        publicErrorHandler(err, req, res, next);
      }
    };
  }

  async function repo(req, res, next) {
    try {
      const { owner, name } = req.params;
      if (!OWNER_RE.test(owner) || !REPO_NAME_RE.test(name)) return notFound(req, res, next);
      const view = await data.getRepo(owner, name);
      if (!view) return notFound(req, res, next);
      const locale = localeOf(res);
      const feedIndex = await data.getFeedIndex();
      send(res, 200, publicCache, 'repo', () => renderRepoPage({ locale, view, feedIndex, appUrl }));
    } catch (err) {
      publicErrorHandler(err, req, res, next);
    }
  }

  return { landing, feed, repo, notFound };
}
