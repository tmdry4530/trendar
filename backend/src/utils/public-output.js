const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

export function escapeXml(value) {
  return escapeHtml(value);
}

export function serializeJsonLd(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function feedPath(kind, slug) {
  return kind === 'all' ? '/trending' : `/trending/${kind}/${encodeURIComponent(slug)}`;
}

export function repoPath(owner, name) {
  return `/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function ogFeedPath(kind, slug) {
  return `/og${feedPath(kind, slug)}.png`;
}

export function ogRepoPath(owner, name) {
  return `/og${repoPath(owner, name)}.png`;
}

export function badgePath(owner, name) {
  return `/badge/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.svg`;
}

export function localizedPath(locale, path) {
  return locale === 'ko' ? `/ko${path === '/' ? '' : path}` : path;
}

export function absoluteUrl(appUrl, path) {
  return `${appUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function routeTemplateOf(kind) {
  return kind === 'all' ? 'trending' : `trending-${kind}`;
}
