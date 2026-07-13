import { pool } from '../config/db.js';

export async function findAll(userId) {
  const [rows] = await pool.query(
    `SELECT q.id, q.query, q.query_type, q.is_active, q.created_at, COUNT(r.id) AS repo_count
     FROM watch_queries q LEFT JOIN repos r ON r.query_id = q.id
     WHERE q.user_id = ?
     GROUP BY q.id ORDER BY q.created_at DESC`,
    [userId]
  );
  return rows.map((r) => ({ ...r, is_active: Boolean(r.is_active), repo_count: Number(r.repo_count) }));
}

export async function create(userId, { query, query_type = 'keyword' }) {
  const [res] = await pool.query(
    'INSERT INTO watch_queries (user_id, query, query_type) VALUES (?, ?, ?)',
    [userId, query, query_type]
  );
  return { id: res.insertId, query, query_type, is_active: true, repo_count: 0, created_at: new Date().toISOString() };
}

export async function update(userId, id, fields) {
  const cols = ['query', 'query_type', 'is_active'];
  const sets = [], vals = [];
  for (const k of cols) if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  if (sets.length) {
    vals.push(id, userId);
    await pool.query(`UPDATE watch_queries SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, vals);
  }
  const [[r]] = await pool.query(
    `SELECT q.id, q.query, q.query_type, q.is_active, q.created_at, COUNT(r.id) AS repo_count
     FROM watch_queries q LEFT JOIN repos r ON r.query_id = q.id WHERE q.id = ? AND q.user_id = ? GROUP BY q.id`,
    [id, userId]
  );
  return r ? { ...r, is_active: Boolean(r.is_active), repo_count: Number(r.repo_count) } : null;
}

export async function remove(userId, id) {
  const [res] = await pool.query('DELETE FROM watch_queries WHERE id = ? AND user_id = ?', [id, userId]);
  return res.affectedRows > 0;
}

export async function countByUser(userId) {
  const [[{ c }]] = await pool.query('SELECT COUNT(*) AS c FROM watch_queries WHERE user_id = ?', [userId]);
  return Number(c);
}
