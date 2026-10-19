import {
  absoluteUrl,
  badgePath,
  escapeHtml,
  feedPath,
  localizedPath,
  ogFeedPath,
  ogRepoPath,
  repoPath,
  routeTemplateOf,
} from '../utils/public-output.js';
import { formatAgeDays, formatInt, formatRate, formatStars, formatUtcDate, formatUtcDateTime } from '../utils/public-format.js';
import { t } from './public-messages.js';
import { ctaHref, feedHref, feedName, githubIcon, groupFeeds, renderLayout } from './public-layout.js';

const LANDING_ROWS = 10;
const SPARK_WIDTH = 720;
const SPARK_HEIGHT = 160;
const SPARK_PAD = 10;
const EXTERNAL_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 2h5v5M14 2 7 9M12 9.5V14H2V4h4.5"/></svg>';

function toDate(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoOf(value) {
  return toDate(value)?.toISOString() ?? null;
}

function githubUrl(owner, name) {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function signed(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n > 0) return `+${formatInt(n)}`;
  if (n < 0) return `−${formatInt(-n)}`;
  return '0';
}

function timeTag(value) {
  const iso = isoOf(value);
  return iso ? `<time datetime="${iso}">${escapeHtml(formatUtcDateTime(value))}</time>` : '';
}

function updatedText(locale, value) {
  return toDate(value) ? escapeHtml(t(locale, 'feed.updated')).replace('{time}', timeTag(value)) : escapeHtml(t(locale, 'feed.neverUpdated'));
}

function rateTitle(locale, measure) {
  const hours = Math.round(measure.span_hours ?? 0);
  if (measure.baseline_source === 'creation') return t(locale, 'rate.creationTitle', { hours });
  if (measure.baseline_source === 'partial') return t(locale, 'rate.partialTitle', { hours });
  return t(locale, 'rate.measuredTitle', { hours });
}

function rateHtml(locale, measure) {
  const estimated = measure.baseline_source !== 'snapshot'
    ? `<span class="est">${escapeHtml(t(locale, 'rate.estimated'))}</span>`
    : '';
  return `<span class="rate" title="${escapeHtml(rateTitle(locale, measure))}">${escapeHtml(formatRate(measure.rate_24h, locale))}</span>${estimated}`;
}

function ctaBand(locale, template) {
  return `<section class="cta-band"><div><h2>${escapeHtml(t(locale, 'cta.title'))}</h2><p>${escapeHtml(t(locale, 'cta.sub'))}</p></div>`
    + `<a class="btn btn--primary btn--lg" href="${ctaHref({ template, locale })}">${githubIcon()}${escapeHtml(t(locale, 'cta.track'))}</a></section>`;
}

function repoRowHtml(locale, row) {
  const href = localizedPath(locale, repoPath(row.owner, row.name));
  const description = row.description ? `<p class="repo-desc">${escapeHtml(row.description)}</p>` : '';
  const language = row.language ? `<span class="tag">${escapeHtml(row.language)}</span>` : '<span class="faint">—</span>';
  return `<tr>`
    + `<td class="col-rank${row.rank <= 3 ? ' rank-top' : ''}">${escapeHtml(row.rank)}</td>`
    + `<td class="repo-cell"><div class="repo-line"><a class="repo-name" href="${escapeHtml(href)}">${escapeHtml(row.full_name)}</a>`
    + `<a class="ext" href="${escapeHtml(githubUrl(row.owner, row.name))}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(`${t(locale, 'repo.viewOnGithub')}: ${row.full_name}`)}">${EXTERNAL_ICON}</a></div>${description}</td>`
    + `<td class="hide-sm">${language}</td>`
    + `<td class="col-num" title="${escapeHtml(formatInt(row.stars))}">★ ${escapeHtml(formatStars(row.stars))}</td>`
    + `<td class="col-num">${rateHtml(locale, row)}</td>`
    + `<td class="col-num hide-md">${escapeHtml(formatAgeDays(row.age_days, locale))}</td>`
    + `</tr>`;
}

function feedTableHtml(locale, rows) {
  const head = `<thead><tr><th class="col-rank">${escapeHtml(t(locale, 'table.rank'))}</th><th>${escapeHtml(t(locale, 'table.project'))}</th>`
    + `<th class="hide-sm">${escapeHtml(t(locale, 'table.language'))}</th><th class="col-num">${escapeHtml(t(locale, 'table.stars'))}</th>`
    + `<th class="col-num">${escapeHtml(t(locale, 'table.perDay'))}</th><th class="col-num hide-md">${escapeHtml(t(locale, 'table.age'))}</th></tr></thead>`;
  return `<div class="panel panel--flush"><div class="table-wrap"><table class="table">${head}<tbody>${rows.map((row) => repoRowHtml(locale, row)).join('')}</tbody></table></div></div>`;
}

function emptyFeedHtml(locale, feed) {
  const key = toDate(feed?.last_success_at) ? 'feed.emptyNone' : 'feed.emptyPending';
  return `<p class="notice notice--empty">${escapeHtml(t(locale, key))}</p>`;
}

function itemListJsonLd({ appUrl, locale, name, url, rows }) {
  return {
    '@type': 'ItemList',
    name,
    url,
    numberOfItems: rows.length,
    itemListElement: rows.map((row) => {
      const item = {
        '@type': 'SoftwareSourceCode',
        name: row.full_name,
        url: absoluteUrl(appUrl, localizedPath(locale, repoPath(row.owner, row.name))),
        codeRepository: githubUrl(row.owner, row.name),
      };
      if (row.description) item.description = row.description;
      if (row.language) item.programmingLanguage = row.language;
      return { '@type': 'ListItem', position: row.rank, item };
    }),
  };
}

function feedTitle(locale, feed) {
  return t(locale, `feed.title.${feed.kind}`, { name: feedName(locale, feed) });
}

function feedKicker(locale, kind) {
  return kind === 'all' ? t(locale, 'feed.kind.all') : `${t(locale, 'nav.trending')} · ${t(locale, `feed.kind.${kind}`)}`;
}

function chipsHtml(locale, feeds, currentHref) {
  return `<div class="chips">${feeds.map((feed) => {
    const href = feedHref(locale, feed);
    return `<a class="pill" href="${escapeHtml(href)}"${href === currentHref ? ' aria-current="page"' : ''}>${escapeHtml(feedName(locale, feed))}</a>`;
  }).join('')}</div>`;
}

export function renderFeedPage({ locale, view, feedIndex, appUrl }) {
  const { feed, rows } = view;
  const path = feedPath(feed.kind, feed.slug);
  const href = localizedPath(locale, path);
  const heading = feedTitle(locale, feed);
  const description = t(locale, `feed.description.${feed.kind}`, { name: feedName(locale, feed) });
  const groups = groupFeeds(feedIndex);
  const siblings = [...groups.all, ...(feed.kind === 'topic' ? groups.topic : groups.language)];
  const body = `<section class="page-head"><div class="kicker">${escapeHtml(feedKicker(locale, feed.kind))}</div>`
    + `<h1>${escapeHtml(heading)}</h1><p class="lead">${escapeHtml(description)}</p>`
    + `<div class="meta-row"><span>${updatedText(locale, feed.last_success_at)}</span>${rows.length ? `<span>${escapeHtml(t(locale, 'feed.count', { count: rows.length }))}</span>` : ''}</div></section>`
    + `<nav class="feed-switch" aria-label="${escapeHtml(t(locale, 'feed.otherFeeds'))}">${chipsHtml(locale, siblings, href)}</nav>`
    + (feed.last_status === 'error' ? `<p class="notice notice--spaced">${escapeHtml(t(locale, 'feed.lastFailed'))}</p>` : '')
    + (rows.length ? feedTableHtml(locale, rows) : emptyFeedHtml(locale, feed))
    + `<p class="method">${escapeHtml(t(locale, 'feed.method'))}</p>`
    + ctaBand(locale, routeTemplateOf(feed.kind));
  return renderLayout({
    locale,
    title: `${heading} | Trendar`,
    description,
    path,
    ogImagePath: ogFeedPath(feed.kind, feed.slug),
    jsonLd: {
      '@context': 'https://schema.org',
      ...itemListJsonLd({ appUrl, locale, name: heading, url: absoluteUrl(appUrl, href), rows }),
    },
    body,
    appUrl,
    feedIndex,
    cta: { template: routeTemplateOf(feed.kind), locale },
  });
}

function sparklineHtml(locale, snapshots) {
  const points = snapshots
    .map((snapshot) => ({ time: toDate(snapshot.captured_at)?.getTime(), stars: Number(snapshot.stars) }))
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.stars));
  if (!points.length) return `<p class="notice notice--empty">${escapeHtml(t(locale, 'repo.historyEmpty'))}</p>`;
  const first = points[0];
  const last = points[points.length - 1];
  const span = last.time - first.time;
  const min = Math.min(...points.map((point) => point.stars));
  const max = Math.max(...points.map((point) => point.stars));
  const innerWidth = SPARK_WIDTH - SPARK_PAD * 2;
  const innerHeight = SPARK_HEIGHT - SPARK_PAD * 2;
  const coords = points.map((point) => {
    const x = span > 0 ? SPARK_PAD + ((point.time - first.time) / span) * innerWidth : SPARK_WIDTH / 2;
    const y = max > min ? SPARK_PAD + (1 - (point.stars - min) / (max - min)) * innerHeight : SPARK_HEIGHT / 2;
    return [x.toFixed(1), y.toFixed(1)];
  });
  const line = coords.map(([x, y], index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ');
  const [lastX, lastY] = coords[coords.length - 1];
  const area = `${line} L${lastX} ${SPARK_HEIGHT} L${coords[0][0]} ${SPARK_HEIGHT} Z`;
  const label = t(locale, 'repo.sparkLabel', { from: formatInt(first.stars), to: formatInt(last.stars) });
  return `<svg class="spark" viewBox="0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}" role="img" aria-label="${escapeHtml(label)}">`
    + `<path class="spark__area" d="${area}"/><path class="spark__line" d="${line}"/><circle class="spark__dot" cx="${lastX}" cy="${lastY}" r="4"/></svg>`
    + `<div class="spark-axis"><span>${escapeHtml(formatUtcDate(first.time))} · ★ ${escapeHtml(formatInt(first.stars))}</span><span>${escapeHtml(formatUtcDate(last.time))} · ★ ${escapeHtml(formatInt(last.stars))}</span></div>`;
}

function dailyRows(snapshots) {
  const byDay = new Map();
  for (const snapshot of snapshots) {
    const date = toDate(snapshot.captured_at);
    if (!date) continue;
    byDay.set(formatUtcDate(date), Number(snapshot.stars));
  }
  const days = [...byDay.entries()];
  return days.map(([day, stars], index) => ({ day, stars, change: index ? stars - days[index - 1][1] : null })).reverse();
}

function dailyTableHtml(locale, snapshots) {
  const rows = dailyRows(snapshots);
  if (!rows.length) return '';
  return `<div class="table-wrap daily"><table class="table"><thead><tr><th>${escapeHtml(t(locale, 'repo.date'))}</th>`
    + `<th class="col-num">${escapeHtml(t(locale, 'table.stars'))}</th><th class="col-num">${escapeHtml(t(locale, 'repo.change'))}</th></tr></thead><tbody>`
    + rows.map((row) => `<tr><td class="num">${escapeHtml(row.day)}</td><td class="col-num">${escapeHtml(formatInt(row.stars))}</td>`
      + `<td class="col-num${row.change > 0 ? ' up' : row.change < 0 ? ' down' : ' faint'}">${escapeHtml(row.change == null ? '—' : signed(row.change))}</td></tr>`).join('')
    + `</tbody></table></div>`;
}

function statHtml(label, value, hint) {
  return `<div class="panel stat"><div class="label">${escapeHtml(label)}</div><div class="stat__value">${value}</div>${hint ? `<div class="stat__hint">${hint}</div>` : ''}</div>`;
}

function repoFeedsHtml(locale, feeds) {
  if (!feeds.length) return `<p class="muted">${escapeHtml(t(locale, 'repo.feedsEmpty'))}</p>`;
  return `<ul class="feed-list">${feeds.map((feed) => {
    const rank = feed.rank == null
      ? `<span class="faint num">${escapeHtml(t(locale, 'repo.feedUnranked'))}</span>`
      : `<span class="pill pill--rank">${escapeHtml(t(locale, 'repo.feedRank', { rank: feed.rank }))}</span>`;
    return `<li><a class="link" href="${escapeHtml(feedHref(locale, feed))}">${escapeHtml(feedName(locale, feed))}</a>${rank}</li>`;
  }).join('')}</ul>`;
}

export function renderRepoPage({ locale, view, feedIndex, appUrl }) {
  const { repo, latest, snapshots, feeds, best } = view;
  const path = repoPath(repo.owner, repo.name);
  const pageUrl = absoluteUrl(appUrl, localizedPath(locale, path));
  const repoGithubUrl = githubUrl(repo.owner, repo.name);
  const summary = t(locale, 'repo.description', { name: repo.full_name });
  const description = truncate(repo.description ? `${summary} ${repo.description}` : summary, 300);
  const markdown = `[![Trending on Trendar](${absoluteUrl(appUrl, badgePath(repo.owner, repo.name))})](${absoluteUrl(appUrl, path)})`;
  const rate = latest
    ? statHtml(t(locale, 'repo.perDay'), rateHtml(locale, latest), escapeHtml(rateTitle(locale, latest)))
    : statHtml(t(locale, 'repo.perDay'), `<span class="muted">${escapeHtml(t(locale, 'repo.notMeasurable'))}</span>`, escapeHtml(t(locale, 'repo.notMeasurableHint')));
  const created = statHtml(
    t(locale, 'repo.created'),
    escapeHtml(formatUtcDate(repo.github_created_at)),
    latest ? escapeHtml(t(locale, 'repo.createdAgo', { age: formatAgeDays(latest.age_days, locale) })) : '',
  );
  const bestStat = best
    ? statHtml(t(locale, 'repo.bestRank'), `<span class="up">#${escapeHtml(best.rank)}</span>`, `<a class="link" href="${escapeHtml(feedHref(locale, best))}">${escapeHtml(t(locale, 'repo.bestRankValue', { rank: best.rank, feed: feedName(locale, best) }))}</a>`)
    : statHtml(t(locale, 'repo.bestRank'), '<span class="faint">—</span>', escapeHtml(t(locale, 'repo.unranked')));
  const body = `<section class="page-head"><div class="kicker"><a href="${escapeHtml(localizedPath(locale, feedPath('all', 'all')))}">${escapeHtml(t(locale, 'nav.trending'))}</a></div>`
    + `<h1 class="mono">${escapeHtml(repo.full_name)}</h1>`
    + (repo.description ? `<p class="lead">${escapeHtml(repo.description)}</p>` : '')
    + `<div class="meta-row">${repo.language ? `<span class="tag">${escapeHtml(repo.language)}</span>` : ''}`
    + `<a class="btn btn--sm" href="${escapeHtml(repoGithubUrl)}" target="_blank" rel="noopener noreferrer">${githubIcon()}${escapeHtml(t(locale, 'repo.viewOnGithub'))}</a></div></section>`
    + `<section class="stats">${statHtml(t(locale, 'repo.totalStars'), `★ ${escapeHtml(formatInt(latest?.stars ?? repo.stars))}`)}${rate}${created}${bestStat}</section>`
    + `<div class="split section">`
    + `<section class="panel"><h2 class="label section-label">${escapeHtml(t(locale, 'repo.history'))}</h2>${sparklineHtml(locale, snapshots)}${dailyTableHtml(locale, snapshots)}</section>`
    + `<div class="side">`
    + `<section class="panel"><h2 class="label section-label">${escapeHtml(t(locale, 'repo.feeds'))}</h2>${repoFeedsHtml(locale, feeds)}</section>`
    + `<section class="panel"><h2 class="label">${escapeHtml(t(locale, 'repo.badge'))}</h2>`
    + `<div class="badge-preview"><img src="${escapeHtml(badgePath(repo.owner, repo.name))}" alt="${escapeHtml(t(locale, 'repo.badgeAlt'))}" height="20"></div>`
    + `<p class="badge-hint">${escapeHtml(t(locale, 'repo.badgeHint'))}</p>`
    + `<pre><code class="code">${escapeHtml(markdown)}</code></pre></section>`
    + `</div></div>`
    + ctaBand(locale, 'repo');
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareSourceCode',
    name: repo.full_name,
    url: pageUrl,
    codeRepository: repoGithubUrl,
  };
  if (repo.description) jsonLd.description = repo.description;
  if (repo.language) jsonLd.programmingLanguage = repo.language;
  const createdIso = isoOf(repo.github_created_at);
  if (createdIso) jsonLd.dateCreated = createdIso;
  return renderLayout({
    locale,
    title: `${t(locale, 'repo.title', { name: repo.full_name })} | Trendar`,
    description,
    path,
    ogImagePath: ogRepoPath(repo.owner, repo.name),
    jsonLd,
    body,
    appUrl,
    feedIndex,
    cta: { template: 'repo', locale },
  });
}

function feedCardsHtml(locale, feeds) {
  return `<div class="feed-grid">${feeds.map((feed) => {
    const updated = toDate(feed.last_success_at) ? formatUtcDate(feed.last_success_at) : t(locale, 'feed.neverUpdated');
    return `<a class="feed-card" href="${escapeHtml(feedHref(locale, feed))}"><b>${escapeHtml(feedName(locale, feed))}</b><span>${escapeHtml(updated)}</span></a>`;
  }).join('')}</div>`;
}

export function renderLandingPage({ locale, view, feedIndex, appUrl }) {
  const rows = (view?.rows ?? []).slice(0, LANDING_ROWS);
  const groups = groupFeeds(feedIndex);
  const allHref = localizedPath(locale, feedPath('all', 'all'));
  const rootUrl = absoluteUrl(appUrl, localizedPath(locale, '/'));
  const title = t(locale, 'landing.title');
  const description = t(locale, 'landing.description');
  const how = [1, 2, 3].map((n) => `<div class="panel"><h3>${escapeHtml(t(locale, `landing.how${n}Title`))}</h3><p>${escapeHtml(t(locale, `landing.how${n}`))}</p></div>`).join('');
  const body = `<section class="hero"><div class="kicker">${escapeHtml(t(locale, 'site.tagline'))}</div>`
    + `<h1>${escapeHtml(t(locale, 'landing.headline'))} <span class="accent">${escapeHtml(t(locale, 'landing.headlineAccent'))}</span>.</h1>`
    + `<p class="lead">${escapeHtml(t(locale, 'landing.intro'))}</p>`
    + `<div class="hero__actions"><a class="btn btn--primary btn--lg" href="${ctaHref({ template: 'landing', locale })}">${githubIcon()}${escapeHtml(t(locale, 'cta.track'))}</a>`
    + `<a class="btn btn--lg" href="${escapeHtml(allHref)}">${escapeHtml(t(locale, 'landing.browse'))}</a></div>`
    + `<p class="trust">${escapeHtml(t(locale, 'cta.trust'))}</p></section>`
    + `<section class="section"><div class="section__title"><h2 class="label">${escapeHtml(t(locale, 'landing.rising'))}</h2><span class="meta-row">${updatedText(locale, view?.feed?.last_success_at)}</span></div>`
    + (rows.length ? feedTableHtml(locale, rows) : emptyFeedHtml(locale, view?.feed))
    + `<p class="more"><a class="link" href="${escapeHtml(allHref)}">${escapeHtml(t(locale, 'landing.seeAll'))} →</a></p></section>`
    + `<section class="section how">${how}</section>`
    + `<section class="section"><h2 class="label section-label">${escapeHtml(t(locale, 'landing.feeds'))}</h2>`
    + (groups.language.length ? `<div class="group"><span class="label faint">${escapeHtml(t(locale, 'nav.languages'))}</span>${feedCardsHtml(locale, groups.language)}</div>` : '')
    + (groups.topic.length ? `<div class="group"><span class="label faint">${escapeHtml(t(locale, 'nav.topics'))}</span>${feedCardsHtml(locale, groups.topic)}</div>` : '')
    + `</section>`
    + ctaBand(locale, 'landing');
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${rootUrl}#website`, name: 'Trendar', url: rootUrl, inLanguage: locale, description },
      itemListJsonLd({ appUrl, locale, name: t(locale, 'landing.rising'), url: absoluteUrl(appUrl, allHref), rows }),
    ],
  };
  return renderLayout({
    locale,
    title,
    description,
    path: '/',
    ogImagePath: ogFeedPath('all', 'all'),
    jsonLd,
    body,
    appUrl,
    feedIndex,
    cta: { template: 'landing', locale },
  });
}

export function renderNotFoundPage({ locale, feedIndex, appUrl }) {
  const groups = groupFeeds(feedIndex);
  const section = (label, feeds) => (feeds.length ? `<div class="group"><span class="label">${escapeHtml(label)}</span>${chipsHtml(locale, feeds, null)}</div>` : '');
  const body = `<section class="not-found"><div class="code-404">404</div><h1>${escapeHtml(t(locale, 'notFound.title'))}</h1><p>${escapeHtml(t(locale, 'notFound.body'))}</p>`
    + section(t(locale, 'nav.trending'), groups.all)
    + section(t(locale, 'nav.languages'), groups.language)
    + section(t(locale, 'nav.topics'), groups.topic)
    + `<p class="home-link"><a class="link" href="${escapeHtml(localizedPath(locale, '/'))}">${escapeHtml(t(locale, 'notFound.home'))}</a></p></section>`;
  return renderLayout({
    locale,
    title: `${t(locale, 'notFound.title')} | Trendar`,
    description: t(locale, 'notFound.body'),
    path: null,
    ogImagePath: ogFeedPath('all', 'all'),
    jsonLd: null,
    body,
    appUrl,
    feedIndex,
    cta: { template: 'not-found', locale },
    noindex: true,
  });
}
