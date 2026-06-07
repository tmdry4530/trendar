import { pool } from '../config/db.js';

function toRepo(r) {
  return {
    ...r,
    is_bookmarked: Boolean(r.is_bookmarked),
    stars: Number(r.stars),
    star_delta: Number(r.star_delta),
    growth_rate: Number(r.growth_rate),
  };
}

export async function findMany({ query_id, bookmarked, search, sort = 'stars', limit = 30, offset = 0 }) {
  const where = [], vals = [];
  if (query_id) { where.push('query_id = ?'); vals.push(Number(query_id)); }
  if (bookmarked) { where.push('is_bookmarked = 1'); }
  if (search) { where.push('(full_name LIKE ? OR description LIKE ?)'); vals.push(`%${search}%`, `%${search}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = sort === 'growth' ? 'growth_rate DESC' : sort === 'recent' ? 'first_seen_at DESC' : 'stars DESC';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM repos ${whereSql}`, vals);
  const [rows] = await pool.query(
    `SELECT id, github_id, query_id, full_name, owner, name, html_url, description, language, stars, star_delta, growth_rate, is_bookmarked, note
     FROM repos ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
    [...vals, Number(limit), Number(offset)]
  );
  return { items: rows.map(toRepo), total: Number(total) };
}

export async function findById(id) {
  const [[repo]] = await pool.query('SELECT * FROM repos WHERE id = ?', [id]);
  if (!repo) return null;
  return { repo: toRepo(repo), snapshots: await getSnapshots(id) };
}

export async function getSnapshots(id) {
  const [rows] = await pool.query(
    'SELECT captured_at, stars, forks, open_issues, watchers FROM repo_snapshots WHERE repo_id = ? ORDER BY captured_at ASC, id ASC',
    [id]
  );
  return rows;
}

export async function update(id, { note, is_bookmarked }) {
  const sets = [], vals = [];
  if (note !== undefined) { sets.push('note = ?'); vals.push(note); }
  if (is_bookmarked !== undefined) { sets.push('is_bookmarked = ?'); vals.push(is_bookmarked ? 1 : 0); }
  if (sets.length) { vals.push(id); await pool.query(`UPDATE repos SET ${sets.join(', ')} WHERE id = ?`, vals); }
  const [[r]] = await pool.query('SELECT * FROM repos WHERE id = ?', [id]);
  return r ? toRepo(r) : null;
}

export async function remove(id) {
  const [res] = await pool.query('DELETE FROM repos WHERE id = ?', [id]);
  return res.affectedRows > 0;
}

export async function stats() {
  const [[a]] = await pool.query('SELECT COUNT(*) AS c FROM repos');
  const [[b]] = await pool.query('SELECT COUNT(*) AS c FROM watch_queries WHERE is_active = 1');
  const [[c]] = await pool.query('SELECT COUNT(*) AS c FROM repos WHERE is_bookmarked = 1');
  const [[d]] = await pool.query('SELECT MAX(captured_at) AS t FROM repo_snapshots');
  return {
    total_repos: Number(a.c),
    active_queries: Number(b.c),
    bookmarked: Number(c.c),
    last_etl_at: d.t ? new Date(d.t).toISOString() : null,
  };
}

export async function trends(limit = 10) {
  const [rows] = await pool.query(
    'SELECT id, full_name, stars, star_delta, growth_rate, language FROM repos ORDER BY growth_rate DESC, star_delta DESC LIMIT ?',
    [Number(limit)]
  );
  return rows.map((r) => ({ ...r, stars: Number(r.stars), star_delta: Number(r.star_delta), growth_rate: Number(r.growth_rate) }));
}

export async function languageDist() {
  const [rows] = await pool.query(
    "SELECT language, COUNT(*) AS count FROM repos WHERE language IS NOT NULL AND language <> '' GROUP BY language ORDER BY count DESC"
  );
  return rows.map((r) => ({ language: r.language, count: Number(r.count) }));
}
