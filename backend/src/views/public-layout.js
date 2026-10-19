import { absoluteUrl, escapeHtml, feedPath, localizedPath, serializeJsonLd } from '../utils/public-output.js';
import { t } from './public-messages.js';

const OG_LOCALE = { en: 'en_US', ko: 'ko_KR' };
const FONT_HREF = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap';
const GITHUB_ICON = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';

const STYLE = `
:root{--bg:#0d0f12;--bg-grid:rgba(255,255,255,.018);--surface:#14171c;--surface-2:#181c22;--surface-3:#1d222a;--line:#232830;--line-soft:#1b2027;--text:#e6e9ef;--muted:#8b93a1;--faint:#5b6472;--up:#3ddc84;--down:#e0a458;--accent:#3ddc84;--accent-dim:#2aa563;--accent-soft:rgba(61,220,132,.12);--cat-keyword:#6ea8fe;--cat-keyword-soft:rgba(110,168,254,.12);--cat-topic:#b58cff;--cat-topic-soft:rgba(181,140,255,.12);--glow-up:0 0 14px rgba(61,220,132,.30);--glow-soft:0 0 0 1px rgba(61,220,132,.25);--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;--radius:7px;--radius-sm:5px;--radius-pill:999px;--gap:14px;--pad:16px;--maxw:1120px;--ease:cubic-bezier(.2,.7,.2,1)}
*,*::before,*::after{box-sizing:border-box}
*{margin:0}
html{scrollbar-gutter:stable}
body{font-family:var(--sans);background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
html[lang="ko"] body{word-break:keep-all;overflow-wrap:break-word}
a{color:inherit;text-decoration:none}
::selection{background:var(--accent-soft);color:var(--text)}
:focus-visible{outline:2px solid var(--accent-dim);outline-offset:2px}
.shell{min-height:100vh;display:flex;flex-direction:column;background:radial-gradient(1100px 520px at 78% -8%,var(--accent-soft),transparent 60%),linear-gradient(var(--bg-grid) 1px,transparent 1px) 0 0/100% 38px,linear-gradient(90deg,var(--bg-grid) 1px,transparent 1px) 0 0/38px 100%,var(--bg);background-attachment:fixed}
.container{width:100%;max-width:var(--maxw);margin:0 auto;padding:26px 24px 64px;flex:1;animation:fade-up .4s var(--ease) both}
.mono,.num{font-family:var(--mono)}
.num{font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
.faint{color:var(--faint)}
.up{color:var(--up)}
.down{color:var(--down)}
.link{color:var(--accent);border-bottom:1px solid transparent;transition:border-color .15s}
.link:hover{border-color:var(--accent-dim)}
.kicker{font-family:var(--mono);font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:10px;margin-bottom:12px}
.kicker::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:var(--glow-up)}
.label{font-family:var(--mono);font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:var(--muted);font-weight:500}
.panel{background:linear-gradient(180deg,var(--surface-2),var(--surface));border:1px solid var(--line);border-radius:var(--radius);padding:var(--pad)}
.panel--flush{padding:0;overflow:hidden}
.panel__head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:14px var(--pad);border-bottom:1px solid var(--line)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);border-radius:var(--radius-sm);padding:8px 13px;font-size:13px;font-family:var(--mono);letter-spacing:.3px;white-space:nowrap;transition:border-color .15s var(--ease),background .15s var(--ease),color .15s var(--ease)}
.btn:hover{border-color:var(--accent-dim);background:var(--surface-3)}
.btn--primary{background:var(--accent-soft);border-color:var(--accent-dim);color:var(--accent)}
.btn--primary:hover{background:rgba(61,220,132,.18);box-shadow:var(--glow-soft)}
.btn--lg{padding:12px 22px;font-size:14px}
.btn--sm{padding:5px 9px;font-size:12px}
.icon{flex:0 0 auto}
.tag{font-family:var(--mono);font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:var(--radius-sm);padding:2px 7px;white-space:nowrap}
.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:var(--radius-pill);padding:4px 11px;font-size:12px;font-family:var(--mono);color:var(--muted);background:var(--surface);white-space:nowrap;transition:color .15s var(--ease),border-color .15s var(--ease)}
.pill:hover{color:var(--text);border-color:var(--accent-dim)}
.pill[aria-current="page"]{border-color:var(--accent-dim);color:var(--accent);background:var(--accent-soft)}
.pill--rank{color:var(--accent);border-color:var(--accent-dim);background:var(--accent-soft)}
.est{font-family:var(--mono);font-size:10px;letter-spacing:.5px;color:var(--down);border:1px solid rgba(224,164,88,.35);border-radius:var(--radius-pill);padding:0 5px;margin-left:5px;vertical-align:1px}
.nav{position:sticky;top:0;z-index:50;background:rgba(13,15,18,.82);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.nav__inner{max-width:var(--maxw);margin:0 auto;padding:0 24px;min-height:56px;display:flex;align-items:center;gap:20px}
.brand{display:flex;align-items:center;gap:9px;font-family:var(--mono);white-space:nowrap}
.brand__logo{color:var(--accent);font-size:17px;text-shadow:var(--glow-up)}
.brand__name{font-weight:600;letter-spacing:1px;font-size:15px}
.brand__tagline{color:var(--faint);font-size:11px;letter-spacing:.3px}
.nav__links{display:flex;align-items:center;gap:4px;margin-right:auto}
.nav__link{font-family:var(--mono);font-size:13px;letter-spacing:.4px;color:var(--muted);padding:7px 12px;border-radius:var(--radius-sm);border:1px solid transparent;white-space:nowrap;cursor:pointer;list-style:none;transition:color .15s var(--ease),background .15s var(--ease)}
.nav__link::-webkit-details-marker{display:none}
.nav__link:hover{color:var(--text);background:var(--surface-2)}
.nav__link[aria-current="page"],.menu[data-active] > .nav__link{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-dim)}
.menu{position:relative}
.menu > summary::after{content:"▾";margin-left:6px;font-size:10px;color:var(--faint)}
.menu[open] > summary{color:var(--text);background:var(--surface-2)}
.menu__panel{position:absolute;top:calc(100% + 8px);left:0;min-width:220px;max-height:min(70vh,520px);overflow:auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px;padding:8px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 18px 40px rgba(0,0,0,.45)}
.menu__panel--wide{min-width:420px}
.menu__panel a{font-size:13px;color:var(--muted);padding:6px 10px;border-radius:var(--radius-sm);white-space:nowrap}
.menu__panel a:hover{color:var(--text);background:var(--surface-2)}
.menu__panel a[aria-current="page"]{color:var(--accent);background:var(--accent-soft)}
.nav__lang{font-family:var(--mono);font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:var(--radius-pill);padding:4px 11px;white-space:nowrap}
.nav__lang:hover{color:var(--text);border-color:var(--accent-dim)}
.page-head{display:flex;flex-direction:column;gap:10px;margin:10px 0 22px}
.page-head h1{font-size:clamp(24px,3.6vw,34px);line-height:1.2;font-weight:700;letter-spacing:-.4px}
.page-head .lead{color:var(--muted);font-size:15px;line-height:1.65;max-width:720px}
.meta-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px;color:var(--muted);font-family:var(--mono);font-size:12px}
.notice{border:1px solid var(--line);border-left:3px solid var(--down);background:var(--surface);border-radius:var(--radius-sm);padding:12px 14px;color:var(--muted);font-size:13px;line-height:1.55}
.notice--empty{border-left-color:var(--accent-dim);padding:22px 18px;font-size:14px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.section{margin-top:34px}
.section__title{margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.table-wrap{overflow-x:auto}
.table{width:100%;border-collapse:collapse;font-size:13px}
.table th{text-align:left;font-family:var(--mono);font-weight:500;font-size:10.5px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
.table td{padding:12px;border-bottom:1px solid var(--line-soft);vertical-align:top}
.table tbody tr:last-child td{border-bottom:none}
.table tbody tr{transition:background .12s var(--ease)}
.table tbody tr:hover{background:var(--surface-2)}
.table .col-num,.table th.col-num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
.col-rank{width:44px;color:var(--faint);font-family:var(--mono);font-variant-numeric:tabular-nums}
.rank-top{color:var(--accent);text-shadow:var(--glow-up)}
.repo-cell{min-width:240px}
.repo-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.repo-name{font-family:var(--mono);font-weight:600;color:var(--text);word-break:break-word}
.repo-name:hover{color:var(--accent)}
.ext{color:var(--faint);display:inline-flex;padding:2px;border-radius:4px}
.ext:hover{color:var(--text)}
.repo-desc{color:var(--muted);font-size:12.5px;line-height:1.5;margin-top:4px;max-width:620px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.rate{color:var(--up)}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--gap)}
.stat{padding:14px 16px}
.stat__value{font-family:var(--mono);font-size:22px;font-weight:600;margin:4px 0 2px;font-variant-numeric:tabular-nums;word-break:break-word}
.stat__hint{color:var(--faint);font-size:11.5px;line-height:1.45}
.spark{display:block;width:100%;height:auto;max-height:180px}
.spark__line{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.spark__area{fill:var(--accent-soft)}
.spark__dot{fill:var(--accent)}
.spark-axis{display:flex;justify-content:space-between;color:var(--faint);font-family:var(--mono);font-size:11px;margin-top:6px}
.split{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:var(--gap);align-items:start}
.feed-list{list-style:none;padding:0;display:flex;flex-direction:column;gap:8px}
.feed-list li{display:flex;align-items:center;justify-content:space-between;gap:10px}
.badge-preview{display:flex;align-items:center;gap:10px;margin:12px 0}
.code{display:block;background:var(--bg);border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px;font-family:var(--mono);font-size:12px;line-height:1.6;color:var(--text);white-space:pre-wrap;word-break:break-all;user-select:all;-webkit-user-select:all}
.hero{text-align:center;max-width:680px;margin:0 auto;padding:40px 0 24px}
.hero h1{font-size:clamp(28px,4.5vw,42px);line-height:1.15;font-weight:700;letter-spacing:-.5px;margin-bottom:16px}
.accent{color:var(--accent);text-shadow:var(--glow-up)}
.hero .lead{color:var(--muted);font-size:15px;line-height:1.65;max-width:560px;margin:0 auto 26px}
.hero__actions{display:flex;justify-content:center;gap:10px;flex-wrap:wrap}
.trust{color:var(--faint);font-size:12px;margin-top:14px}
.how{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--gap)}
.how h3{font-size:14.5px;font-weight:600;margin-bottom:6px}
.how p{color:var(--muted);font-size:13px;line-height:1.55}
.feed-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}
.feed-card{display:flex;flex-direction:column;gap:2px;padding:12px 14px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);transition:border-color .15s var(--ease),background .15s var(--ease)}
.feed-card:hover{border-color:var(--accent-dim);background:var(--surface-2)}
.feed-card b{font-weight:600;font-size:13.5px}
.feed-card span{color:var(--faint);font-family:var(--mono);font-size:11px}
.group + .group{margin-top:18px}
.group .label{display:block;margin-bottom:10px}
.cta-band{margin-top:40px;padding:24px 28px;display:flex;align-items:center;justify-content:space-between;gap:20px;border:1px solid var(--accent-dim);border-radius:var(--radius);background:radial-gradient(600px 200px at 20% 0%,var(--accent-soft),transparent 70%),var(--surface)}
.cta-band h2{font-size:18px;font-weight:700;margin-bottom:4px}
.cta-band p{color:var(--muted);font-size:13.5px;line-height:1.5}
.cta-band .btn{flex:0 0 auto}
.footer{border-top:1px solid var(--line);background:rgba(13,15,18,.6)}
.footer__inner{max-width:var(--maxw);margin:0 auto;padding:30px 24px 36px;display:flex;flex-direction:column;gap:22px}
.footer__feeds{display:grid;grid-template-columns:minmax(120px,.6fr) minmax(0,1fr) minmax(0,2fr);gap:20px}
.footer__feeds ul{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:4px 14px}
.footer__feeds a{color:var(--muted);font-size:12.5px}
.footer__feeds a:hover{color:var(--accent)}
.footer__feeds .label{display:block;margin-bottom:8px}
.footer__bottom{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border-top:1px solid var(--line-soft);padding-top:16px;color:var(--faint);font-size:12px}
.footer__legal{display:flex;gap:16px}
.footer__legal a{color:var(--muted)}
.footer__legal a:hover{color:var(--text)}
.not-found{max-width:760px;margin:30px auto 0;text-align:center}
.not-found .code-404{font-family:var(--mono);font-size:56px;font-weight:700;color:var(--accent);text-shadow:var(--glow-up);line-height:1}
.not-found h1{font-size:24px;margin:14px 0 8px}
.not-found p{color:var(--muted);margin-bottom:24px}
.not-found .group{text-align:left}
.feed-switch{margin:0 0 18px}
.notice--spaced{margin-bottom:14px}
.method{color:var(--faint);margin-top:12px;font-size:12.5px;line-height:1.55}
.daily{margin-top:16px;max-height:340px;overflow-y:auto}
.section-label{display:block;margin-bottom:14px}
.side{display:flex;flex-direction:column;gap:var(--gap)}
.badge-hint{color:var(--muted);font-size:12.5px;margin-bottom:10px}
.hero .kicker{justify-content:center}
.more{margin-top:12px}
.home-link{margin-top:26px}
.kicker a:hover{color:var(--accent)}
pre{margin:0}
@keyframes fade-up{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media (max-width:1024px){.brand__tagline{display:none}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:820px){.split,.how{grid-template-columns:1fr}.footer__feeds{grid-template-columns:1fr}.hide-md{display:none}.menu__panel--wide{min-width:300px}}
@media (max-width:640px){.nav__inner{flex-wrap:wrap;gap:8px 12px;padding:10px 16px}.nav__links{order:3;width:100%;margin-right:0;overflow-x:auto}.nav__cta-text{display:none}.brand{margin-right:auto}.container{padding:20px 16px 48px}.hide-sm{display:none}.repo-cell{min-width:0}.table td,.table th{padding:10px 8px}.stats{grid-template-columns:1fr 1fr}.stat__value{font-size:18px}.cta-band{flex-direction:column;text-align:center;padding:22px 18px}.menu{position:static}.menu__panel,.menu__panel--wide{left:16px;right:16px;min-width:0;top:auto;margin-top:8px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

export function githubIcon() {
  return GITHUB_ICON;
}

export function ctaHref({ template, locale }) {
  return `/api/auth/github?from=${encodeURIComponent(template)}&locale=${encodeURIComponent(locale)}`;
}

export function feedName(locale, feed) {
  return feed.name?.[locale] ?? feed.name?.en ?? feed.slug;
}

export function feedHref(locale, feed) {
  return localizedPath(locale, feedPath(feed.kind, feed.slug));
}

export function groupFeeds(feedIndex = []) {
  return {
    all: feedIndex.filter((feed) => feed.kind === 'all'),
    language: feedIndex.filter((feed) => feed.kind === 'language'),
    topic: feedIndex.filter((feed) => feed.kind === 'topic'),
  };
}

function current(href, currentHref) {
  return href === currentHref ? ' aria-current="page"' : '';
}

function menu(locale, label, feeds, currentHref, wide) {
  if (!feeds.length) return '';
  const links = feeds.map((feed) => {
    const href = feedHref(locale, feed);
    return `<a href="${escapeHtml(href)}"${current(href, currentHref)}>${escapeHtml(feedName(locale, feed))}</a>`;
  }).join('');
  const active = feeds.some((feed) => feedHref(locale, feed) === currentHref) ? ' data-active' : '';
  return `<details class="menu"${active}><summary class="nav__link">${escapeHtml(label)}</summary><div class="menu__panel${wide ? ' menu__panel--wide' : ''}">${links}</div></details>`;
}

function renderNav({ locale, path, feedIndex, cta }) {
  const groups = groupFeeds(feedIndex);
  const currentHref = path == null ? null : localizedPath(locale, path);
  const allHref = localizedPath(locale, feedPath('all', 'all'));
  const otherLocale = locale === 'ko' ? 'en' : 'ko';
  const switchHref = localizedPath(otherLocale, path ?? feedPath('all', 'all'));
  return `<header class="nav"><div class="nav__inner">`
    + `<a class="brand" href="${escapeHtml(localizedPath(locale, '/'))}"><span class="brand__logo" aria-hidden="true">◎</span><span class="brand__name">Trendar</span><span class="brand__tagline">${escapeHtml(t(locale, 'site.tagline'))}</span></a>`
    + `<nav class="nav__links" aria-label="${escapeHtml(t(locale, 'nav.trending'))}">`
    + `<a class="nav__link" href="${escapeHtml(allHref)}"${current(allHref, currentHref)}>${escapeHtml(t(locale, 'nav.trending'))}</a>`
    + menu(locale, t(locale, 'nav.languages'), groups.language, currentHref, false)
    + menu(locale, t(locale, 'nav.topics'), groups.topic, currentHref, true)
    + `</nav>`
    + `<a class="nav__lang" href="${escapeHtml(switchHref)}" lang="${otherLocale}" title="${escapeHtml(t(locale, 'nav.switchLanguageLabel'))}">${escapeHtml(t(locale, 'nav.switchLanguage'))}</a>`
    + `<a class="btn btn--primary btn--sm" href="${ctaHref(cta)}">${GITHUB_ICON}<span class="nav__cta-text">${escapeHtml(t(locale, 'cta.track'))}</span></a>`
    + `</div></header>`;
}

function footerList(locale, feeds) {
  return `<ul>${feeds.map((feed) => `<li><a href="${escapeHtml(feedHref(locale, feed))}">${escapeHtml(feedName(locale, feed))}</a></li>`).join('')}</ul>`;
}

function renderFooter({ locale, feedIndex }) {
  const groups = groupFeeds(feedIndex);
  const allHref = localizedPath(locale, feedPath('all', 'all'));
  return `<footer class="footer"><div class="footer__inner">`
    + `<nav class="footer__feeds" aria-label="${escapeHtml(t(locale, 'footer.allFeeds'))}">`
    + `<div><span class="label">${escapeHtml(t(locale, 'footer.allFeeds'))}</span><ul><li><a href="${escapeHtml(allHref)}">${escapeHtml(t(locale, 'nav.trending'))}</a></li></ul></div>`
    + `<div><span class="label">${escapeHtml(t(locale, 'nav.languages'))}</span>${footerList(locale, groups.language)}</div>`
    + `<div><span class="label">${escapeHtml(t(locale, 'nav.topics'))}</span>${footerList(locale, groups.topic)}</div>`
    + `</nav>`
    + `<div class="footer__bottom"><span>${escapeHtml(t(locale, 'footer.note'))} © 2026 Appflow (앱플로우)</span>`
    + `<nav class="footer__legal"><a href="/pricing">${escapeHtml(t(locale, 'footer.pricing'))}</a><a href="/terms">${escapeHtml(t(locale, 'footer.terms'))}</a><a href="/privacy">${escapeHtml(t(locale, 'footer.privacy'))}</a></nav></div>`
    + `</div></footer>`;
}

export function renderLayout({ locale, title, description, path, ogImagePath, jsonLd, body, appUrl, feedIndex, cta, noindex = false }) {
  const otherLocale = locale === 'ko' ? 'en' : 'ko';
  const canonical = path == null ? null : absoluteUrl(appUrl, localizedPath(locale, path));
  const ogImage = absoluteUrl(appUrl, ogImagePath);
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark">',
    '<meta name="theme-color" content="#0d0f12">',
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    noindex ? '<meta name="robots" content="noindex">' : '',
    canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : '',
    canonical ? `<link rel="alternate" hreflang="en" href="${escapeHtml(absoluteUrl(appUrl, localizedPath('en', path)))}">` : '',
    canonical ? `<link rel="alternate" hreflang="ko" href="${escapeHtml(absoluteUrl(appUrl, localizedPath('ko', path)))}">` : '',
    canonical ? `<link rel="alternate" hreflang="x-default" href="${escapeHtml(absoluteUrl(appUrl, localizedPath('en', path)))}">` : '',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Trendar">',
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}">` : '',
    `<meta property="og:image" content="${escapeHtml(ogImage)}">`,
    '<meta property="og:image:type" content="image/png">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:locale" content="${OG_LOCALE[locale]}">`,
    `<meta property="og:locale:alternate" content="${OG_LOCALE[otherLocale]}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:image" content="${escapeHtml(ogImage)}">`,
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    `<link rel="stylesheet" href="${escapeHtml(FONT_HREF)}">`,
    `<style>${STYLE}</style>`,
    jsonLd ? `<script type="application/ld+json">${serializeJsonLd(jsonLd)}</script>` : '',
  ].filter(Boolean).join('\n');
  return `<!doctype html>\n<html lang="${locale}">\n<head>\n${head}\n</head>\n<body>\n<div class="shell">\n`
    + `${renderNav({ locale, path, feedIndex, cta })}\n<main class="container">\n${body}\n</main>\n${renderFooter({ locale, feedIndex })}\n</div>\n</body>\n</html>\n`;
}
