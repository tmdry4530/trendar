const INT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function trimDecimal(n) {
  return String(n).replace(/\.0$/, '');
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function isNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function toDate(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function formatInt(n) {
  return isNumber(n) ? INT_FORMAT.format(Math.round(n)) : '—';
}

export function formatStars(n) {
  if (!isNumber(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1000) return INT_FORMAT.format(Math.round(n));
  const k = n / 1000;
  const kValue = Math.abs(k) >= 100 ? Math.round(k) : round1(k);
  if (Math.abs(kValue) < 1000) return `${trimDecimal(kValue)}k`;
  return `${trimDecimal(round1(n / 1_000_000))}M`;
}

export function formatRate(n, locale) {
  if (!isNumber(n)) return '—';
  const rounded = Math.round(n);
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
  return `${sign}${INT_FORMAT.format(Math.abs(rounded))}${locale === 'ko' ? '/일' : '/day'}`;
}

export function formatAgeDays(days, locale) {
  if (!isNumber(days)) return '—';
  const whole = Math.floor(Math.max(days, 0));
  if (locale === 'ko') return whole < 1 ? '1일 미만' : `${whole}일`;
  if (whole < 1) return '<1 day';
  return `${whole} ${whole === 1 ? 'day' : 'days'}`;
}

export function formatUtcDate(value) {
  const date = toDate(value);
  if (!date) return '—';
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function formatUtcDateTime(value) {
  const date = toDate(value);
  if (!date) return '—';
  return `${formatUtcDate(date)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}
