import { pool } from '../config/db.js';

export const PAGE_SIZE = 25;

export async function overview() {
  const [[users]] = await pool.query(`SELECT COUNT(*) AS total,
    COALESCE(SUM(plan = 'free'), 0) AS free,
    COALESCE(SUM(plan = 'pro'), 0) AS pro,
    COALESCE(SUM(last_etl_status IN ('error', 'token_invalid')), 0) AS etl_failed,
    COALESCE(SUM(token_invalid = 1), 0) AS token_invalid FROM users`);
  const [subscriptions] = await pool.query(`SELECT s.status, COUNT(*) AS count
    FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
    GROUP BY s.status ORDER BY s.status`);
  const [[repos]] = await pool.query('SELECT COUNT(*) AS total FROM public_repos');
  return { users, subscriptions, public_repos: repos.total };
}

export async function listUsers({ search, page }) {
  // Explicit '!' escape is independent of MySQL's NO_BACKSLASH_ESCAPES mode.
  const pattern = `%${search.replace(/[!%_]/g, '!$&')}%`;
  const [[count]] = await pool.query(
    "SELECT COUNT(*) AS total FROM users u WHERE u.login LIKE ? ESCAPE '!'", [pattern]
  );
  const [items] = await pool.query(`SELECT u.id, u.login, u.name, u.created_at, u.plan,
    s.status AS subscription_status, s.current_period_end,
    COALESCE(q.query_count, 0) AS query_count, COALESCE(r.repo_count, 0) AS repo_count,
    u.last_etl_at, u.last_etl_status, u.token_invalid
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id
    LEFT JOIN (SELECT user_id, COUNT(*) AS query_count FROM watch_queries GROUP BY user_id) q
      ON q.user_id = u.id
    LEFT JOIN (SELECT user_id, COUNT(*) AS repo_count FROM repos GROUP BY user_id) r
      ON r.user_id = u.id
    WHERE u.login LIKE ? ESCAPE '!'
    ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`,
  [pattern, PAGE_SIZE, (page - 1) * PAGE_SIZE]);
  return { items, total: count.total };
}

export async function listFeeds() {
  const [rows] = await pool.query(`SELECT f.kind, f.slug, f.last_attempt_at, f.last_success_at,
    f.last_status, f.last_error_code, COALESCE(m.repo_count, 0) AS repo_count
    FROM public_feeds f
    LEFT JOIN (SELECT feed_id, COUNT(*) AS repo_count FROM public_feed_repos GROUP BY feed_id) m
      ON m.feed_id = f.id`);
  return rows;
}
