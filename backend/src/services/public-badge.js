import { escapeXml } from '../utils/public-output.js';

const CHAR_WIDTH = 6.5;
const PADDING = 10;
const LABEL_COLOR = '#555';
const NEUTRAL_COLOR = '#555';
const ACCENT_COLOR = '#3ddc84';
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

function textWidth(text) {
  return Math.round([...text].length * CHAR_WIDTH) + PADDING;
}

export function formatCompact(value) {
  const n = Math.abs(Number(value) || 0);
  if (n < 1000) return String(Math.round(n));
  const digits = n >= 100000 ? 0 : 1;
  return `${(n / 1000).toFixed(digits).replace(/\.0$/, '')}k`;
}

export function formatDailyRate(rate) {
  return `${Number(rate) < 0 ? '-' : '+'}${formatCompact(rate)}/day`;
}

export function renderBadgeSvg({ label = 'Trendar', message = '', color = NEUTRAL_COLOR } = {}) {
  const labelText = String(label ?? '');
  const messageText = String(message ?? '');
  const fill = COLOR_RE.test(String(color)) ? color : NEUTRAL_COLOR;
  const labelWidth = textWidth(labelText);
  const messageWidth = textWidth(messageText);
  const width = labelWidth + messageWidth;
  const title = escapeXml(`${labelText}: ${messageText}`);
  const labelX = labelWidth / 2;
  const messageX = labelWidth + messageWidth / 2;
  const safeLabel = escapeXml(labelText);
  const safeMessage = escapeXml(messageText);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${title}"><title>${title}</title>`
    + '<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>'
    + `<clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>`
    + `<g clip-path="url(#r)"><rect width="${labelWidth}" height="20" fill="${LABEL_COLOR}"/><rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${escapeXml(fill)}"/><rect width="${width}" height="20" fill="url(#s)"/></g>`
    + '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">'
    + `<text x="${labelX}" y="15" fill="#010101" fill-opacity=".3">${safeLabel}</text><text x="${labelX}" y="14">${safeLabel}</text>`
    + `<text x="${messageX}" y="15" fill="#010101" fill-opacity=".3">${safeMessage}</text><text x="${messageX}" y="14">${safeMessage}</text>`
    + '</g></svg>';
}

export function badgeForRepo(view) {
  if (!view) return { label: 'Trendar', message: 'GitHub trend radar', color: NEUTRAL_COLOR };
  if (view.best) return { label: 'Trending on Trendar', message: `#${view.best.rank} ${view.best.name?.en ?? view.best.slug}`, color: ACCENT_COLOR };
  if (view.latest) return { label: 'Trendar', message: formatDailyRate(view.latest.rate_24h), color: ACCENT_COLOR };
  return { label: 'Trendar', message: 'collecting data', color: NEUTRAL_COLOR };
}
