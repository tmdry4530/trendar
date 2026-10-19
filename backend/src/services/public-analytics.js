// services/public-analytics.js — 공개 페이지 조회·가입 전환을 일별 집계로만 기록한다(IP·쿠키·UA 원문 미저장).
import { isIP } from 'node:net';
import { kstToday } from '../utils/kst.js';

export const ROUTE_TEMPLATES = ['landing', 'trending', 'trending-language', 'trending-topic', 'repo', 'not-found'];

const LOCALES = ['en', 'ko'];
const ENTRY_COOKIE = 'entry_route';
const ENTRY_TTL_MS = 10 * 60 * 1000;
const MAX_DOMAIN_LENGTH = 255;
const IP_HOST_BUCKET = 'ip';
const BOT_UA_RE =
  /bot|crawl|spider|slurp|facebookexternalhit|twitterbot|discordbot|slackbot|telegrambot|whatsapp|linkedinbot|embedly|pinterest|preview|curl|wget|python-requests|go-http-client|httpclient|java\//i;

export function referrerDomain(header) {
  if (typeof header !== 'string' || header === '') return '';
  let host;
  try {
    host = new URL(header).hostname.toLowerCase();
  } catch {
    return '';
  }
  // IP 리터럴 호스트(IPv4·IPv6·IPv4-mapped)는 주소 대신 고정 버킷으로 기록한다.
  if (isIP(host.replace(/^\[|\]$/g, ''))) return IP_HOST_BUCKET;
  if (host.startsWith('www.')) host = host.slice(4);
  return host.slice(0, MAX_DOMAIN_LENGTH);
}

export function isBotUserAgent(ua) {
  if (typeof ua !== 'string' || ua.trim() === '') return true;
  return BOT_UA_RE.test(ua);
}

function normalizeLocale(locale) {
  return locale === 'ko' ? 'ko' : 'en';
}

export function createPageViewTracker({
  addDailyMetrics,
  flushMs,
  now = () => new Date(),
  dayOf = kstToday,
  log = console,
  maxKeys = 5000,
}) {
  let pending = new Map();
  let timer = null;
  let inFlight = 0;

  function track({ template, locale, referer, userAgent }) {
    if (!ROUTE_TEMPLATES.includes(template)) return;
    const day = dayOf(now());
    const loc = normalizeLocale(locale);
    const isBot = isBotUserAgent(userAgent) ? 1 : 0;
    let domain = referrerDomain(referer);
    let key = `${day}|${template}|${loc}|${domain}|${isBot}`;
    // 임의 Referer로 인한 메모리 증가를 막기 위해 한도 초과 시 새 도메인은 빈 도메인으로 합산한다.
    if (!pending.has(key) && pending.size >= maxKeys) {
      domain = '';
      key = `${day}|${template}|${loc}|${domain}|${isBot}`;
    }
    const row = pending.get(key);
    if (row) {
      row.count += 1;
      return;
    }
    pending.set(key, {
      day,
      event_kind: 'page_view',
      path_template: template,
      locale: loc,
      referrer_domain: domain,
      is_bot: isBot,
      count: 1,
    });
  }

  async function flush() {
    if (pending.size === 0) return;
    const rows = [...pending.values()];
    pending = new Map();
    inFlight += 1;
    try {
      await addDailyMetrics(rows);
    } catch (err) {
      log.error('[public] analytics flush failed', err?.code ?? err?.message);
    } finally {
      inFlight -= 1;
    }
  }

  function middleware(req, res, next) {
    res.locals.track = (template) =>
      track({
        template,
        locale: res.locals.locale ?? 'en',
        referer: req.get('referer'),
        userAgent: req.get('user-agent'),
      });
    next();
  }

  function start() {
    if (timer) return;
    // 이전 쓰기가 끝나지 않았으면 이번 주기는 건너뛰고 버퍼에 계속 누적한다(maxKeys로 상한).
    timer = setInterval(() => {
      if (inFlight === 0) flush();
    }, flushMs);
    timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { middleware, track, flush, start, stop, pendingCount: () => pending.size };
}

export function createSignupAttribution({
  addDailyMetrics,
  dayOf = kstToday,
  now = () => new Date(),
  cookieOpts = {},
}) {
  function parse(value) {
    if (typeof value !== 'string') return null;
    const [locale, template, ...rest] = value.split('|');
    if (rest.length || !LOCALES.includes(locale) || !ROUTE_TEMPLATES.includes(template)) return null;
    return { template, locale };
  }

  function remember(res, { from, locale }) {
    if (!ROUTE_TEMPLATES.includes(from) || !LOCALES.includes(locale)) return;
    res.cookie(ENTRY_COOKIE, `${locale}|${from}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: ENTRY_TTL_MS,
      path: '/',
      ...cookieOpts,
    });
  }

  function consume(req, res) {
    const value = req.cookies?.[ENTRY_COOKIE];
    res.clearCookie(ENTRY_COOKIE);
    return parse(value);
  }

  async function record({ template, locale }) {
    await addDailyMetrics([
      {
        day: dayOf(now()),
        event_kind: 'signup',
        path_template: template,
        locale,
        referrer_domain: '',
        is_bot: 0,
        count: 1,
      },
    ]);
  }

  return { COOKIE: ENTRY_COOKIE, remember, consume, record };
}
