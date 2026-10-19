import { pool } from '../config/db.js';
import { feedKey } from '../config/public-feeds.js';

export async function ensureFeeds(feeds) {
  if (!feeds.length) return new Map();
  const params = feeds.flatMap(({ kind, slug }) => [kind, slug]);
  await pool.query(
    `INSERT IGNORE INTO public_feeds (kind, slug) VALUES ${feeds.map(() => '(?, ?)').join(', ')}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT id, kind, slug FROM public_feeds WHERE (kind, slug) IN (${feeds.map(() => '(?, ?)').join(', ')})`,
    params
  );
  return new Map(rows.map(({ id, kind, slug }) => [feedKey(kind, slug), id]));
}

export async function upsertPublicRepo(repo) {
  const [result] = await pool.query(
    `INSERT INTO public_repos
       (github_id, full_name, owner, name, html_url, description, language, stars, github_created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), full_name = VALUES(full_name),
       owner = VALUES(owner), name = VALUES(name), html_url = VALUES(html_url),
       description = VALUES(description), language = VALUES(language), stars = VALUES(stars),
       github_created_at = VALUES(github_created_at)`,
    [repo.github_id, repo.full_name, repo.owner, repo.name, repo.html_url ?? null,
      repo.description ?? null, repo.language ?? null, repo.stars, repo.github_created_at ?? null]
  );
  return result.insertId;
}

export async function insertPublicSnapshot(repoId, { stars, forks, open_issues, watchers }, capturedAt) {
  await pool.query(
    `INSERT INTO public_repo_snapshots (repo_id, stars, forks, open_issues, watchers, captured_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [repoId, stars, forks ?? null, open_issues ?? null, watchers ?? null, capturedAt]
  );
}

export async function upsertFeedMembership(feedId, repoId, seenAt) {
  await pool.query(
    `INSERT INTO public_feed_repos (feed_id, repo_id, last_seen_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at)`,
    [feedId, repoId, seenAt]
  );
}

export async function markFeedAttempt(feedId, at) {
  await pool.query('UPDATE public_feeds SET last_attempt_at = ? WHERE id = ?', [at, feedId]);
}

export async function markFeedResult(feedId, { status, errorCode, at }) {
  if (status === 'ok') {
    await pool.query(
      `UPDATE public_feeds SET last_status = ?, last_success_at = ?, last_error_code = NULL WHERE id = ?`,
      [status, at, feedId]
    );
  } else {
    await pool.query('UPDATE public_feeds SET last_status = ?, last_error_code = ? WHERE id = ?',
      [status, errorCode ?? null, feedId]);
  }
}

export async function listFeedRuns() {
  const [rows] = await pool.query(
    'SELECT id, kind, slug, last_attempt_at, last_success_at, last_status, last_error_code FROM public_feeds'
  );
  return rows;
}

export function buildFeedCandidatesQuery({ feedId, windowDays, membershipHours }) {
  return {
    sql: `SELECT r.* FROM public_feed_repos f FORCE INDEX (idx_feed_seen)
          JOIN public_repos r ON r.id = f.repo_id
          WHERE f.feed_id = ?
            AND f.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
            AND r.github_created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    params: [Number(feedId), Number(membershipHours), Number(windowDays)],
  };
}

export function buildSnapshotsRangeQuery(repoIds, recentDays) {
  return {
    sql: `SELECT repo_id, id, stars, captured_at FROM public_repo_snapshots FORCE INDEX (idx_repo_time)
          WHERE repo_id IN (${repoIds.map(() => '?').join(', ') || 'NULL'})
            AND captured_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          ORDER BY repo_id ASC, captured_at ASC, id ASC`,
    params: [...repoIds.map(Number), Number(recentDays)],
  };
}

export function buildEarliestSnapshotsQuery(repoIds) {
  return {
    sql: `SELECT s.repo_id, s.id, s.stars, s.captured_at FROM public_repos r
          JOIN public_repo_snapshots s ON s.id = (
            SELECT first.id FROM public_repo_snapshots first FORCE INDEX (idx_repo_time)
            WHERE first.repo_id = r.id ORDER BY first.captured_at ASC, first.id ASC LIMIT 1
          )
          WHERE r.id IN (${repoIds.map(() => '?').join(', ') || 'NULL'})`,
    params: repoIds.map(Number),
  };
}

export function buildRepoSnapshotsQuery(repoId, days) {
  return {
    sql: `SELECT id, stars, forks, captured_at FROM public_repo_snapshots FORCE INDEX (idx_repo_time)
          WHERE repo_id = ? AND captured_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          ORDER BY captured_at ASC, id ASC`,
    params: [Number(repoId), Number(days)],
  };
}

async function candidatesFor(repos, recentDays) {
  if (!repos.length) return [];
  const repoIds = repos.map(({ id }) => id);
  const range = buildSnapshotsRangeQuery(repoIds, recentDays);
  const [snapshots] = await pool.query(range.sql, range.params);
  const first = buildEarliestSnapshotsQuery(repoIds);
  const [earliest] = await pool.query(first.sql, first.params);
  const candidates = repos.map((repo) => ({ ...repo, snapshots: [], earliest: null }));
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const { repo_id, id, stars, captured_at } of snapshots) {
    byId.get(repo_id).snapshots.push({ id, stars, captured_at });
  }
  for (const { repo_id, id, stars, captured_at } of earliest) {
    byId.get(repo_id).earliest = { id, stars, captured_at };
  }
  return candidates;
}

export async function feedCandidates(feedId, { windowDays, recentDays = 4, membershipHours = 48 }) {
  const { sql, params } = buildFeedCandidatesQuery({ feedId, windowDays, membershipHours });
  const [repos] = await pool.query(sql, params);
  return candidatesFor(repos, recentDays);
}

export async function findPublicRepo(owner, name) {
  const [[repo]] = await pool.query(
    'SELECT * FROM public_repos WHERE owner = ? AND name = ? ORDER BY updated_at DESC, id DESC LIMIT 1',
    [owner, name]
  );
  return repo || null;
}

export async function repoSnapshots(repoId, { days = 30 } = {}) {
  const { sql, params } = buildRepoSnapshotsQuery(repoId, days);
  const [rows] = await pool.query(sql, params);
  return rows;
}

export async function repoFeeds(repoId, { withinHours = 48 } = {}) {
  const [rows] = await pool.query(
    `SELECT f.id, f.kind, f.slug, m.last_seen_at FROM public_feed_repos m
     JOIN public_feeds f ON f.id = m.feed_id
     WHERE m.repo_id = ? AND m.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [repoId, withinHours]
  );
  return rows;
}

export async function repoCandidate(repoId, { recentDays = 4 } = {}) {
  const [repos] = await pool.query('SELECT * FROM public_repos WHERE id = ?', [repoId]);
  const [candidate] = await candidatesFor(repos, recentDays);
  return candidate || null;
}

export async function addDailyMetrics(rows) {
  if (!rows.length) return;
  await pool.query(
    `INSERT INTO public_daily_metrics
       (day, event_kind, path_template, locale, referrer_domain, is_bot, event_count)
     VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}
     ON DUPLICATE KEY UPDATE event_count = event_count + VALUES(event_count)`,
    rows.flatMap(({ day, event_kind, path_template, locale, referrer_domain, is_bot, count }) =>
      [day, event_kind, path_template, locale, referrer_domain, is_bot, count])
  );
}

export function buildRankHistoryInsert(feedId, capturedAt, rows) {
  return {
    sql: `INSERT IGNORE INTO public_rank_history
            (feed_id, repo_id, captured_at, \`rank\`, stars, rate_24h, baseline_source)
          VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
    params: rows.flatMap((row) =>
      [feedId, row.id, capturedAt, row.rank, row.stars, row.rate_24h, row.baseline_source]),
  };
}

export async function insertRankHistory(feedId, capturedAt, rows) {
  if (!rows.length) return;
  const { sql, params } = buildRankHistoryInsert(feedId, capturedAt, rows);
  await pool.query(sql, params);
}
