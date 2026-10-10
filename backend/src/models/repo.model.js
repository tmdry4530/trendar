import { pool } from '../config/db.js';
import { trendRankMinStars, trendRankMinDelta } from '../utils/limits.js';

function toRepo(r) {
  return {
    ...r,
    is_bookmarked: Boolean(r.is_bookmarked),
    stars: Number(r.stars),
    star_delta: Number(r.star_delta),
    growth_rate: Number(r.growth_rate),
    delta_24h: Number(r.delta_24h ?? 0),
    delta_7d: Number(r.delta_7d ?? 0),
    score: Number(r.score ?? 0),
  };
}

// 정렬 키 → ORDER BY. 'growth'는 순수 비율 편향을 피하려 랭킹 v3 점수로 매핑한다.
export function orderByForSort(sort) {
  if (sort === 'score' || sort === 'growth') return 'score DESC, delta_24h DESC';
  if (sort === 'recent') return 'first_seen_at DESC';
  return 'stars DESC';
}

export async function findMany(userId, { query_id, bookmarked, search, sort = 'stars', limit = 30, offset = 0 }) {
  const where = ['user_id = ?'], vals = [userId];
  if (query_id) { where.push('query_id = ?'); vals.push(Number(query_id)); }
  if (bookmarked) { where.push('is_bookmarked = 1'); }
  if (search) { where.push('(full_name LIKE ? OR description LIKE ?)'); vals.push(`%${search}%`, `%${search}%`); }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orderSql = orderByForSort(sort);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM repos ${whereSql}`, vals);
  const [rows] = await pool.query(
    `SELECT id, github_id, query_id, full_name, owner, name, html_url, description, language, stars, star_delta, growth_rate,
            delta_24h, delta_7d, score, last_refreshed_at, is_bookmarked, note
     FROM repos ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
    [...vals, Number(limit), Number(offset)]
  );
  return { items: rows.map(toRepo), total: Number(total) };
}

export async function findById(userId, id) {
  const [[repo]] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [id, userId]);
  if (!repo) return null;
  return { repo: toRepo(repo), snapshots: await getSnapshots(userId, id) };
}

export async function getSnapshots(userId, repoId) {
  const [rows] = await pool.query(
    `SELECT s.captured_at, s.stars, s.forks, s.open_issues, s.watchers
     FROM repo_snapshots s JOIN repos r ON r.id = s.repo_id AND r.user_id = ?
     WHERE s.repo_id = ? ORDER BY s.captured_at ASC, s.id ASC`,
    [userId, repoId]
  );
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

// 빠르게 성장 중 (랭킹 v3) — 24시간 정규화 증가량 기반 점수로 정렬한다.
// 48시간 넘게 갱신되지 않은 레포는 델타가 낡았으므로 제외한다.
// acceleration = 오늘 증가량 / 지난 7일 일평균 (1 미만 분모는 1로 고정).
export function buildTrendsQuery(userId, limit = 10, { minStars = trendRankMinStars(), minDelta = trendRankMinDelta() } = {}) {
  return {
    sql: `SELECT id, full_name, stars, star_delta, growth_rate, delta_24h, delta_7d, score,
                 delta_24h / GREATEST(delta_7d / 7, 1) AS acceleration, language
          FROM repos
          WHERE user_id = ?
            AND stars >= ?
            AND delta_24h >= ?
            AND last_refreshed_at >= DATE_SUB(NOW(), INTERVAL 48 HOUR)
          ORDER BY score DESC, delta_24h DESC
          LIMIT ?`,
    params: [userId, Number(minStars), Number(minDelta), Number(limit)],
  };
}

export async function trends(userId, limit = 10) {
  const { sql, params } = buildTrendsQuery(userId, limit);
  const [rows] = await pool.query(sql, params);
  return rows.map((r) => ({
    ...r,
    stars: Number(r.stars),
    star_delta: Number(r.star_delta),
    growth_rate: Number(r.growth_rate),
    delta_24h: Number(r.delta_24h),
    delta_7d: Number(r.delta_7d),
    score: Number(r.score),
    acceleration: Number(r.acceleration),
  }));
}

export function buildRisingQuery(userId, { windowDays, minDelta, limit }) {
  return {
    sql: `SELECT r.id, r.full_name, r.language, r.stars, r.star_delta, r.github_created_at,
                 r.stars / GREATEST(DATEDIFF(NOW(), r.github_created_at), 1) AS velocity,
                 r.stars - baseline.stars AS star_delta_24h,
                 (r.stars - baseline.stars) / GREATEST(baseline.stars, 1) AS growth_rate_24h
          FROM repos r
          JOIN repo_snapshots baseline ON baseline.id = (
            SELECT s.id
            FROM repo_snapshots s
            WHERE s.repo_id = r.id
              AND s.captured_at <= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            ORDER BY s.captured_at DESC, s.id DESC
            LIMIT 1
          )
          WHERE r.user_id = ?
            AND r.github_created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            AND r.stars - baseline.stars >= ?
          ORDER BY star_delta_24h DESC, growth_rate_24h DESC
          LIMIT ?`,
    params: [Number(userId), Number(windowDays), Number(minDelta), Number(limit)],
  };
}

// 신생 레포를 동일한 24시간 기준 증가량으로 비교한다. 기준선이 없는 레포는 JOIN에서 제외된다.
export async function risingRepos(userId, windowDays, limit = 8, minDelta = 500) {
  const { sql, params } = buildRisingQuery(userId, { windowDays, minDelta, limit });
  const [rows] = await pool.query(sql, params);
  return rows.map((r) => ({
    ...r,
    stars: Number(r.stars),
    star_delta: Number(r.star_delta),
    velocity: Number(r.velocity),
    star_delta_24h: Number(r.star_delta_24h),
    growth_rate_24h: Number(r.growth_rate_24h),
    github_created_at: r.github_created_at ? new Date(r.github_created_at).toISOString() : null,
  }));
}

// 관심 레포(북마크) — 대시보드 노출용. 최근 증가 순 (trend-ranking-v2 R4).
export async function bookmarkedRepos(userId, limit = 8) {
  const [rows] = await pool.query(
    `SELECT id, full_name, language, stars, star_delta
     FROM repos WHERE user_id = ? AND is_bookmarked = 1
     ORDER BY star_delta DESC, stars DESC
     LIMIT ?`,
    [userId, Number(limit)]
  );
  return rows.map((r) => ({ ...r, stars: Number(r.stars), star_delta: Number(r.star_delta) }));
}

export async function languageDist(userId) {
  const [rows] = await pool.query(
    "SELECT language, COUNT(*) AS count FROM repos WHERE user_id = ? AND language IS NOT NULL AND language <> '' GROUP BY language ORDER BY count DESC",
    [userId]
  );
  return rows.map((r) => ({ language: r.language, count: Number(r.count) }));
}
