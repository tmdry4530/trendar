import * as adminModel from '../models/admin.model.js';
import { PAGE_SIZE } from '../models/admin.model.js';
import { allFeeds, feedKey } from '../config/public-feeds.js';
import { httpError } from '../middleware/errorHandler.js';

const SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'paused', 'canceled']);
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);
const ETL_STATUSES = new Set(['ok', 'error', 'token_invalid']);
const numeric = (value) => Number(value ?? 0);
const subscriptionStatus = (value) => value == null ? 'none'
  : SUBSCRIPTION_STATUSES.has(value) ? value : 'unknown';

function date(value) {
  if (value == null) return null;
  // mysql2 normally returns Date in UTC; also accept its UTC DATETIME string form.
  const input = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z` : value;
  const parsed = input instanceof Date ? input : new Date(input);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function errorCode(value) {
  if (value == null) return null;
  const code = String(value);
  return (code.length === 3 && /^[45]\d{2}$/.test(code)) || NETWORK_CODES.has(code) ? code : 'UNKNOWN_ERROR';
}

export function createAdminController({ model = adminModel, feeds = allFeeds, clock = () => new Date() } = {}) {
  async function overview(req, res, next) {
    try {
      const data = await model.overview();
      const subscriptions = new Map();
      for (const row of data.subscriptions) {
        const status = subscriptionStatus(row.status);
        subscriptions.set(status, (subscriptions.get(status) || 0) + numeric(row.count));
      }
      res.json({ ok: true, data: {
        users: {
          total: numeric(data.users.total), free: numeric(data.users.free), pro: numeric(data.users.pro),
          etl_failed: numeric(data.users.etl_failed), token_invalid: numeric(data.users.token_invalid),
        },
        subscriptions: [...subscriptions].map(([status, count]) => ({ status, count })),
        public_repos: numeric(data.public_repos), generated_at: date(clock()),
      } });
    } catch (err) { next(err); }
  }

  async function users(req, res, next) {
    try {
      const search = req.query.search ?? '';
      const rawPage = req.query.page ?? '1';
      if (typeof search !== 'string' || search.length > 100 || typeof rawPage !== 'string'
        || rawPage.length === 0 || /[^0-9]/.test(rawPage) || Number(rawPage) < 1 || Number(rawPage) > 100000) {
        throw httpError(400, 'VALIDATION_ERROR', '검색 조건을 확인해 주세요.');
      }
      const page = Number(rawPage);
      const result = await model.listUsers({ search, page });
      const items = result.items.map((row) => ({
        id: numeric(row.id), login: row.login, name: row.name ?? null,
        created_at: date(row.created_at), plan: row.plan === 'pro' ? 'pro' : 'free',
        subscription_status: subscriptionStatus(row.subscription_status),
        current_period_end: date(row.current_period_end),
        query_count: numeric(row.query_count), repo_count: numeric(row.repo_count),
        last_etl_at: date(row.last_etl_at),
        last_etl_status: ETL_STATUSES.has(row.last_etl_status) ? row.last_etl_status : null,
        token_invalid: row.token_invalid === true || row.token_invalid === 1 || row.token_invalid === '1',
      }));
      res.json({ ok: true, data: { items, total: numeric(result.total), page, page_size: PAGE_SIZE } });
    } catch (err) { next(err); }
  }

  async function publicFeeds(req, res, next) {
    try {
      const configured = feeds();
      const rows = await model.listFeeds();
      const byKey = new Map(rows.map((row) => [feedKey(row.kind, row.slug), row]));
      const items = configured.map(({ kind, slug, name }) => {
        const row = byKey.get(feedKey(kind, slug));
        return {
          kind, slug, name: { ko: name.ko, en: name.en },
          last_attempt_at: date(row?.last_attempt_at), last_success_at: date(row?.last_success_at),
          last_status: row?.last_status === 'ok' || row?.last_status === 'error' ? row.last_status : null,
          last_error_code: errorCode(row?.last_error_code), repo_count: numeric(row?.repo_count),
        };
      });
      res.json({ ok: true, data: { items } });
    } catch (err) { next(err); }
  }

  return { overview, users, feeds: publicFeeds };
}

export default createAdminController();
