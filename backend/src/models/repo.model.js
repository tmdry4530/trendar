import { pool } from '../config/db.js';
import { rankRising } from '../services/rising-score.js';

function toRepo(r) {
  return {
    ...r,
    is_bookmarked: Boolean(r.is_bookmarked),
    stars: Number(r.stars),
    star_delta: Number(r.star_delta),
    growth_rate: Number(r.growth_rate),
  };
}

export async function findMany(userId, { query_id, bookmarked, search, sort = 'stars', limit = 30, offset = 0 }) {
  const where = ['user_id = ?'], vals = [userId];
  if (query_id) { where.push('query_id = ?'); vals.push(Number(query_id)); }
  if (bookmarked) { where.push('is_bookmarked = 1'); }
  if (search) { where.push('(full_name LIKE ? OR description LIKE ?)'); vals.push(`%${search}%`, `%${search}%`); }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orderSql = sort === 'growth' ? 'growth_rate DESC' : sort === 'recent' ? 'first_seen_at DESC' : 'stars DESC';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM repos ${whereSql}`, vals);
  const [rows] = await pool.query(
    `SELECT id, github_id, query_id, full_name, owner, name, html_url, description, language, stars, star_delta, growth_rate, is_bookmarked, note
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

// 성장률 상위 — 1,000스타 미만과 정체 레포는 제외한 뒤 증가율로 정렬한다.
export function buildTrendsQuery(userId, limit = 10) {
  return {
    sql: 'SELECT id, full_name, stars, star_delta, growth_rate, language FROM repos WHERE user_id = ? AND stars >= 1000 AND star_delta > 0 ORDER BY growth_rate DESC, star_delta DESC LIMIT ?',
    params: [userId, Number(limit)],
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
    sql: `SELECT id, github_id, full_name, owner, name, html_url, description, language, stars, star_delta, github_created_at
          FROM repos
          WHERE user_id = ?
            AND github_created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
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

const DAY_MS = 86_400_000;

// /api/rising 응답 행. 기존 필드(star_delta_24h·growth_rate_24h·velocity 등)는 유지하고
// v3 지표(rate_24h·baseline_source·accel·score·rank·age_days)를 덧붙인다.
export function rankUserRising(candidates, config, now = new Date()) {
  const starDeltaById = new Map(candidates.map((c) => [c.id, Number(c.star_delta ?? 0)]));
  return rankRising(candidates, config, now).map((row) => {
    const createdAt = row.github_created_at ? new Date(row.github_created_at) : null;
    const ageDaysNow = createdAt ? (new Date(now).getTime() - createdAt.getTime()) / DAY_MS : null;
    return {
      id: row.id,
      github_id: row.github_id,
      full_name: row.full_name,
      owner: row.owner,
      name: row.name,
      html_url: row.html_url,
      description: row.description,
      language: row.language,
      stars: row.stars,
      star_delta: starDeltaById.get(row.id) ?? 0,
      github_created_at: createdAt ? createdAt.toISOString() : null,
      velocity: ageDaysNow == null ? 0 : row.stars / Math.max(ageDaysNow, 1),
      star_delta_24h: row.star_delta_24h,
      growth_rate_24h: row.growth_rate_24h,
      rate_24h: row.rate_24h,
      baseline_source: row.baseline_source,
      span_hours: row.span_hours,
      accel: row.accel,
      age_days: row.age_days,
      score: row.score,
      rank: row.rank,
      captured_at: row.captured_at ? new Date(row.captured_at).toISOString() : null,
    };
  });
}

export async function risingRepos(userId, { config, now = new Date() }) {
  const candidates = await risingCandidates(userId, { windowDays: config.windowDays });
  return rankUserRising(candidates, config, now);
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
