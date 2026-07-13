import { pool } from '../config/db.js';

export async function create(userId, tokenHash, expiresAt) {
  await pool.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [userId, tokenHash, expiresAt]
  );
}

export async function findValidByHash(tokenHash) {
  const [[row]] = await pool.query(
    `SELECT s.id AS session_id, s.expires_at,
            u.id AS user_id, u.github_id, u.login, u.name, u.avatar_url, u.token_invalid
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > NOW()`,
    [tokenHash]
  );
  if (!row) return null;
  return {
    sessionId: row.session_id,
    expiresAt: row.expires_at,
    user: {
      id: row.user_id,
      github_id: row.github_id,
      login: row.login,
      name: row.name,
      avatar_url: row.avatar_url,
      token_invalid: Boolean(row.token_invalid),
    },
  };
}

export async function deleteByHash(tokenHash) {
  const [res] = await pool.query('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  return res.affectedRows > 0;
}

export async function deleteByUserId(userId) {
  const [res] = await pool.query('DELETE FROM sessions WHERE user_id = ?', [userId]);
  return res.affectedRows;
}

export async function deleteExpired() {
  const [res] = await pool.query('DELETE FROM sessions WHERE expires_at <= NOW()');
  return res.affectedRows;
}
