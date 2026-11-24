import { pool } from '../config/db.js';
import { rankUserRising } from '../services/rising-response.js';
import {
  REPO_BOOKMARKS_DEFAULT_LIMIT,
  REPO_LIST_DEFAULT_LIMIT,
  REPO_LIST_MAX_LIMIT,
  REPO_LIST_MAX_OFFSET,
  REPO_RANK_MAX_LIMIT,
  REPO_SEARCH_MAX_LENGTH,
  REPO_TRENDS_DEFAULT_LIMIT,
  SNAPSHOT_DEFAULT_LIMIT,
  SNAPSHOT_MAX_DAYS,
  SNAPSHOT_MAX_LIMIT,
  clampBoundedInt,
} from '../utils/limits.js';

export { rankUserRising };
import { MALICIOUS_FILTER } from './security.model.js';

function toRepo(r) {
  return {
    ...r,
    is_bookmarked: Boolean(r.is_bookmarked),
    stars: Number(r.stars),
    star_delta: Number(r.star_delta),
    growth_rate: Number(r.growth_rate),
  };
}

export function buildFindManyQuery(userId, { query_id, bookmarked, search, sort = 'stars', limit = REPO_LIST_DEFAULT_LIMIT, offset = 0 } = {}) {
  const safeLimit = clampBoundedInt(limit, { defaultValue: REPO_LIST_DEFAULT_LIMIT, min: 1, max: REPO_LIST_MAX_LIMIT });
  const safeOffset = clampBoundedInt(offset, { defaultValue: 0, min: 0, max: REPO_LIST_MAX_OFFSET });
  const safeSearch = typeof search === 'string' && search.trim() ? search.trim().slice(0, REPO_SEARCH_MAX_LENGTH) : '';
  const where = ['user_id = ?'];
  const vals = [userId];
  if (query_id) { where.push('query_id = ?'); vals.push(Number(query_id)); }
  if (bookmarked) { where.push('is_bookmarked = 1'); }
  if (safeSearch) { where.push('(full_name LIKE ? OR description LIKE ?)'); vals.push(`%${safeSearch}%`, `%${safeSearch}%`); }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orderSql = sort === 'growth' ? 'growth_rate DESC' : sort === 'recent' ? 'first_seen_at DESC' : 'stars DESC';
  return {
    countSql: `SELECT COUNT(*) AS total FROM repos ${whereSql}`,
    countParams: vals,
    sql: `SELECT id, github_id, query_id, full_name, owner, name, html_url, description, language, stars, star_delta, growth_rate, is_bookmarked, note
     FROM repos ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
    params: [...vals, safeLimit, safeOffset],
  };
}

export async function findMany(userId, options = {}) {
  const { countSql, countParams, sql, params } = buildFindManyQuery(userId, options);
  const [[{ total }]] = await pool.query(countSql, countParams);
  const [rows] = await pool.query(sql, params);
  return { items: rows.map(toRepo), total: Number(total) };
}

export async function findById(userId, id) {
  const [[repo]] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [id, userId]);
  if (!repo) return null;
  return { repo: toRepo(repo), snapshots: await getSnapshots(userId, id) };
}

export function buildSnapshotsQuery(userId, repoId, { limit = SNAPSHOT_DEFAULT_LIMIT, days = null } = {}) {
  const safeLimit = clampBoundedInt(limit, { defaultValue: SNAPSHOT_DEFAULT_LIMIT, min: 1, max: SNAPSHOT_MAX_LIMIT });
  const hasDays = days !== undefined && days !== null && days !== '';
  const safeDays = hasDays ? clampBoundedInt(days, { defaultValue: SNAPSHOT_MAX_DAYS, min: 1, max: SNAPSHOT_MAX_DAYS }) : null;
  const params = [userId, repoId];
  const daysSql = safeDays ? ' AND s.captured_at >= DATE_SUB(NOW(), INTERVAL ? DAY)' : '';
  if (safeDays) params.push(safeDays);
  params.push(safeLimit);
  return {
    sql: `SELECT captured_at, stars, forks, open_issues, watchers
     FROM (
       SELECT s.id, s.captured_at, s.stars, s.forks, s.open_issues, s.watchers
       FROM repo_snapshots s JOIN repos r ON r.id = s.repo_id AND r.user_id = ?
       WHERE s.repo_id = ?${daysSql}
       ORDER BY s.captured_at DESC, s.id DESC
       LIMIT ?
     ) recent
     ORDER BY captured_at ASC, id ASC`,
    params,
  };
}

export async function getSnapshots(userId, repoId, options = {}) {
  const { sql, params } = buildSnapshotsQuery(userId, repoId, options);
  const [rows] = await pool.query(sql, params);
  return rows;
}

export async function update(userId, id, { note, is_bookmarked }) {
  const sets = [], vals = [];
  if (note !== undefined) { sets.push('note = ?'); vals.push(note); }
  if (is_bookmarked !== undefined) { sets.push('is_bookmarked = ?'); vals.push(is_bookmarked ? 1 : 0); }
  if (sets.length) {
    vals.push(id, userId);
    await pool.query(`UPDATE repos SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, vals);
  }
  const [[r]] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [id, userId]);
  return r ? toRepo(r) : null;
}

export async function remove(userId, id) {
  const [res] = await pool.query('DELETE FROM repos WHERE id = ? AND user_id = ?', [id, userId]);
  return res.affectedRows > 0;
}

export async function stats(userId) {
  const [[[a]], [[b]], [[c]], [[d]]] = await Promise.all([
    pool.query('SELECT COUNT(*) AS c FROM repos WHERE user_id = ?', [userId]),
    pool.query('SELECT COUNT(*) AS c FROM watch_queries WHERE is_active = 1 AND user_id = ?', [userId]),
    pool.query('SELECT COUNT(*) AS c FROM repos WHERE is_bookmarked = 1 AND user_id = ?', [userId]),
    pool.query(
      'SELECT MAX(s.captured_at) AS t FROM repo_snapshots s JOIN repos r ON r.id = s.repo_id WHERE r.user_id = ?',
      [userId]
    ),
  ]);
  return {
    total_repos: Number(a.c),
    active_queries: Number(b.c),
    bookmarked: Number(c.c),
    last_etl_at: d.t ? new Date(d.t).toISOString() : null,
  };
}

// 성장률 상위 — 1,000스타 미만과 정체 레포는 제외한 뒤 증가율로 정렬한다.
export function buildTrendsQuery(userId, limit = REPO_TRENDS_DEFAULT_LIMIT) {
  const safeLimit = clampBoundedInt(limit, { defaultValue: REPO_TRENDS_DEFAULT_LIMIT, min: 1, max: REPO_RANK_MAX_LIMIT });
  return {
    sql: `SELECT r.id, r.full_name, r.stars, r.star_delta, r.growth_rate, r.language FROM repos r
          WHERE r.user_id = ? AND r.stars >= 1000 AND r.star_delta > 0 AND ${MALICIOUS_FILTER('r')}
          ORDER BY r.growth_rate DESC, r.star_delta DESC LIMIT ?`,
    params: [userId, safeLimit],
  };
}

export async function trends(userId, limit = 10) {
  const { sql, params } = buildTrendsQuery(userId, limit);
  const [rows] = await pool.query(sql, params);
  return rows.map((r) => ({ ...r, stars: Number(r.stars), star_delta: Number(r.star_delta), growth_rate: Number(r.growth_rate) }));
}

// ── 신생 급상승 (rising-score-v3) ──
// 공개 피드와 같은 순수 함수(rankRising)를 사용자 레포에 적용한다. 후보는 생성 windowDays일 이내 레포,
// 스냅샷은 최근 recentDays일치(기준선 cur−24h와 가속도용 이전 기준선까지 최대 72h 필요) + 가장 이른 스냅샷.
export function buildRisingCandidatesQuery(userId, windowDays) {
  return {
    sql: `SELECT r.id, r.github_id, r.full_name, r.owner, r.name, r.html_url, r.description, r.language, r.stars, r.star_delta, r.github_created_at
          FROM repos r
          WHERE r.user_id = ?
            AND r.github_created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            AND ${MALICIOUS_FILTER('r')}`,
    params: [Number(userId), Number(windowDays)],
  };
}

export function buildRisingSnapshotsQuery(repoIds, recentDays) {
  return {
    sql: `SELECT repo_id, id, stars, captured_at FROM repo_snapshots
          WHERE repo_id IN (${repoIds.map(() => '?').join(', ') || 'NULL'})
            AND captured_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          ORDER BY repo_id ASC, captured_at ASC, id ASC`,
    params: [...repoIds.map(Number), Number(recentDays)],
  };
}

export function buildRisingEarliestQuery(repoIds) {
  return {
    sql: `SELECT s.repo_id, s.id, s.stars, s.captured_at FROM repos r
          JOIN repo_snapshots s ON s.id = (
            SELECT first.id FROM repo_snapshots first
            WHERE first.repo_id = r.id ORDER BY first.captured_at ASC, first.id ASC LIMIT 1
          )
          WHERE r.id IN (${repoIds.map(() => '?').join(', ') || 'NULL'})`,
    params: repoIds.map(Number),
  };
}

// rankRising 입력 계약(snapshots 배열 + earliest)으로 후보를 조립한다.
export function assembleRisingCandidates(repos, snapshots, earliest) {
  const candidates = repos.map((repo) => ({ ...repo, snapshots: [], earliest: null }));
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const { repo_id, id, stars, captured_at } of snapshots) {
    byId.get(repo_id)?.snapshots.push({ id, stars, captured_at });
  }
  for (const { repo_id, id, stars, captured_at } of earliest) {
    const candidate = byId.get(repo_id);
    if (candidate) candidate.earliest = { id, stars, captured_at };
  }
  return candidates;
}

export async function risingCandidates(userId, { windowDays, recentDays = 4 }) {
  const base = buildRisingCandidatesQuery(userId, windowDays);
  const [repos] = await pool.query(base.sql, base.params);
  if (!repos.length) return [];
  const repoIds = repos.map(({ id }) => id);
  const range = buildRisingSnapshotsQuery(repoIds, recentDays);
  const [snapshots] = await pool.query(range.sql, range.params);
  const first = buildRisingEarliestQuery(repoIds);
  const [earliest] = await pool.query(first.sql, first.params);
  return assembleRisingCandidates(repos, snapshots, earliest);
}

export async function risingRepos(userId, { config, now = new Date() }) {
  const candidates = await risingCandidates(userId, { windowDays: config.windowDays });
  return rankUserRising(candidates, config, now);
}

// 관심 레포(북마크) — 대시보드 노출용. 최근 증가 순 (trend-ranking-v2 R4).
export function buildBookmarkedReposQuery(userId, limit = REPO_BOOKMARKS_DEFAULT_LIMIT) {
  const safeLimit = clampBoundedInt(limit, { defaultValue: REPO_BOOKMARKS_DEFAULT_LIMIT, min: 1, max: REPO_RANK_MAX_LIMIT });
  return {
    sql: `SELECT id, full_name, language, stars, star_delta
     FROM repos WHERE user_id = ? AND is_bookmarked = 1
     ORDER BY star_delta DESC, stars DESC
     LIMIT ?`,
    params: [userId, safeLimit],
  };
}

export async function bookmarkedRepos(userId, limit = REPO_BOOKMARKS_DEFAULT_LIMIT) {
  const { sql, params } = buildBookmarkedReposQuery(userId, limit);
  const [rows] = await pool.query(sql, params);
  return rows.map((r) => ({ ...r, stars: Number(r.stars), star_delta: Number(r.star_delta) }));
}

export async function languageDist(userId) {
  const [rows] = await pool.query(
    "SELECT language, COUNT(*) AS count FROM repos WHERE user_id = ? AND language IS NOT NULL AND language <> '' GROUP BY language ORDER BY count DESC",
    [userId]
  );
  return rows.map((r) => ({ language: r.language, count: Number(r.count) }));
}
