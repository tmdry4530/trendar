import { Router } from 'express';
import { OWNER_RE, REPO_NAME_RE, SLUG_RE } from '../config/public-feeds.js';
import { badgeForRepo, renderBadgeSvg } from '../services/public-badge.js';
import { feedOgSvg, repoOgSvg } from '../services/public-og.js';

const OG_CACHE = 'public, max-age=600';
const BADGE_CACHE = 'public, max-age=3600';

export function createPublicAssetsRouter({ data, og, rateLimit, log = console }) {
  const router = Router();
  router.use(['/og', '/badge'], (req, res, next) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  }, rateLimit);

  function sendPng(res, status, buffer, cacheControl) {
    res.status(status);
    res.type('png');
    res.set('Cache-Control', cacheControl);
    res.send(buffer);
  }

  async function sendGeneric(res, status, cacheControl) {
    return sendPng(res, status, await og.getFallbackPng(), cacheControl);
  }

  async function sendOg(res, load) {
    try {
      const target = await load();
      if (!target) return sendGeneric(res, 404, OG_CACHE);
      if (target.unranked) return sendGeneric(res, 200, 'no-store');
      const { buffer, fallback } = await og.render(target);
      return sendPng(res, 200, buffer, fallback ? 'no-store' : OG_CACHE);
    } catch (error) {
      log.error('[public] og request failed', { message: error?.message });
      return sendGeneric(res, 200, 'no-store');
    }
  }

  function feedOg(kind, slugOf) {
    return (req, res) => {
      const slug = slugOf(req);
      if (!SLUG_RE.test(slug)) return sendGeneric(res, 404, OG_CACHE);
      return sendOg(res, async () => {
        const view = await data.getFeed(kind, slug);
        if (!view) return null;
        return {
          key: `feed:${kind}:${slug}`,
          revision: view.revision,
          svg: feedOgSvg({ feedName: view.feed.name?.en ?? slug, rows: view.rows.slice(0, 5), updatedAt: view.feed.last_success_at }),
        };
      });
    };
  }

  router.get('/og/trending.png', feedOg('all', () => 'all'));
  router.get('/og/trending/language/:slug.png', feedOg('language', (req) => req.params.slug));
  router.get('/og/trending/topic/:slug.png', feedOg('topic', (req) => req.params.slug));

  router.get('/og/repo/:owner/:name.png', (req, res) => {
    const { owner, name } = req.params;
    if (!OWNER_RE.test(owner) || !REPO_NAME_RE.test(name)) return sendGeneric(res, 404, OG_CACHE);
    return sendOg(res, async () => {
      const view = await data.getRepo(owner, name);
      if (!view) return null;
      const { repo, latest, best } = view;
      if (!best) return { unranked: true };
      return {
        key: `repo:${owner}/${name}`.toLowerCase(),
        revision: view.revision,
        svg: repoOgSvg({
          full_name: repo.full_name,
          stars: latest?.stars ?? repo.stars,
          rate_24h: latest?.rate_24h ?? null,
          baseline_source: latest?.baseline_source ?? null,
          bestLabel: `Trending #${best.rank} · ${best.name?.en ?? best.slug}`,
        }),
      };
    });
  });

  router.get('/badge/:owner/:name.svg', async (req, res) => {
    const { owner, name } = req.params;
    let view = null;
    let cacheControl = BADGE_CACHE;
    if (OWNER_RE.test(owner) && REPO_NAME_RE.test(name)) {
      try {
        view = await data.getRepo(owner, name);
      } catch (error) {
        log.error('[public] badge lookup failed', { message: error?.message });
        cacheControl = 'no-store';
      }
    }
    res.set('Content-Type', 'image/svg+xml; charset=utf-8');
    res.set('Cache-Control', cacheControl);
    res.send(renderBadgeSvg(badgeForRepo(view)));
  });

  return router;
}
