import { OWNER_RE, REPO_NAME_RE, SLUG_RE } from '../config/public-feeds.js';
import { routeTemplateOf } from '../utils/public-output.js';
import { renderFeedPage, renderLandingPage, renderNotFoundPage, renderRepoPage } from '../views/public-pages.js';

const HTML_TYPE = 'text/html; charset=utf-8';

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

  function notFound(req, res) {
    const locale = localeOf(res);
    send(res, 404, publicCache, 'not-found', () => renderNotFoundPage({ locale, feedIndex: staticFeedIndex, appUrl }));
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
      next(err);
    }
  }

  function feed(kind) {
    return async (req, res, next) => {
      try {
        const slug = kind === 'all' ? 'all' : req.params.slug;
        if (!SLUG_RE.test(slug)) return notFound(req, res);
        const view = await data.getFeed(kind, slug);
        if (!view) return notFound(req, res);
        const locale = localeOf(res);
        const feedIndex = await data.getFeedIndex();
        send(res, 200, publicCache, routeTemplateOf(kind), () => renderFeedPage({ locale, view, feedIndex, appUrl }));
      } catch (err) {
        next(err);
      }
    };
  }

  async function repo(req, res, next) {
    try {
      const { owner, name } = req.params;
      if (!OWNER_RE.test(owner) || !REPO_NAME_RE.test(name)) return notFound(req, res);
      const view = await data.getRepo(owner, name);
      if (!view) return notFound(req, res);
      const locale = localeOf(res);
      const feedIndex = await data.getFeedIndex();
      send(res, 200, publicCache, 'repo', () => renderRepoPage({ locale, view, feedIndex, appUrl }));
    } catch (err) {
      next(err);
    }
  }

  return { landing, feed, repo, notFound };
}
