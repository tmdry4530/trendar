import { absoluteUrl, escapeXml, feedPath, localizedPath, repoPath } from '../utils/public-output.js';

export function buildSitemapXml({ appUrl, feeds, repos }) {
  const pages = new Map([['/', null]]);
  for (const feed of feeds) pages.set(feedPath(feed.kind, feed.slug), feed.lastmod ?? null);
  for (const repo of repos) pages.set(repoPath(repo.owner, repo.name), repo.lastmod ?? null);
  const urls = [];
  for (const [path, lastmod] of pages) {
    const english = escapeXml(absoluteUrl(appUrl, path));
    const korean = escapeXml(absoluteUrl(appUrl, localizedPath('ko', path)));
    const alternates = `<xhtml:link rel="alternate" hreflang="en" href="${english}"/><xhtml:link rel="alternate" hreflang="ko" href="${korean}"/><xhtml:link rel="alternate" hreflang="x-default" href="${english}"/>`;
    const modified = lastmod == null ? '' : `<lastmod>${escapeXml(new Date(lastmod).toISOString().slice(0, 10))}</lastmod>`;
    for (const location of [english, korean]) urls.push(`<url><loc>${location}</loc>${modified}${alternates}</url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>`;
}

export function createSitemapHandler({ data, appUrl }) {
  return async (req, res, next) => {
    try {
      const entries = await data.getSitemapEntries();
      const xml = buildSitemapXml({ appUrl, ...entries });
      res.set('Content-Type', 'application/xml; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=600');
      res.send(xml);
    } catch (error) {
      next(error);
    }
  };
}
