import { pool } from '../config/db.js';

export async function findAll() {
  const [rows] = await pool.query(
    `SELECT q.id, q.query, q.query_type, q.is_active, q.created_at, COUNT(r.id) AS repo_count
     FROM watch_queries q LEFT JOIN repos r ON r.query_id = q.id
     GROUP BY q.id ORDER BY q.created_at DESC`
  );
  return rows.map((r) => ({ ...r, is_active: Boolean(r.is_active), repo_count: Number(r.repo_count) }));
}

export async function create({ query, query_type = 'keyword' }) {
  const [res] = await pool.query('INSERT INTO watch_queries (query, query_type) VALUES (?, ?)', [query, query_type]);
  return { id: res.insertId, query, query_type, is_active: true, repo_count: 0, created_at: new Date().toISOString() };
}

export async function update(id, fields) {
  const cols = ['query', 'query_type', 'is_active'];
  const sets = [], vals = [];
  for (const k of cols) if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  if (sets.length) { vals.push(id); await pool.query(`UPDATE watch_queries SET ${sets.join(', ')} WHERE id = ?`, vals); }
  const [[r]] = await pool.query(
    `SELECT q.id, q.query, q.query_type, q.is_active, q.created_at, COUNT(r.id) AS repo_count
     FROM watch_queries q LEFT JOIN repos r ON r.query_id = q.id WHERE q.id = ? GROUP BY q.id`, [id]
  );
  return r ? { ...r, is_active: Boolean(r.is_active), repo_count: Number(r.repo_count) } : null;
}

export async function remove(id) {
  const [res] = await pool.query('DELETE FROM watch_queries WHERE id = ?', [id]);
  return res.affectedRows > 0;
}
