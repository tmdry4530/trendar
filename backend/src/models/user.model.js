import { pool } from '../config/db.js';

function toUser(r) {
  if (!r) return null;
  return { ...r, token_invalid: Boolean(r.token_invalid) };
}

export async function upsertFromGithub({ githubId, login, name, avatarUrl, accessTokenEnc }) {
  await pool.query(
    `INSERT INTO users (github_id, login, name, avatar_url, access_token_enc, token_invalid)
     VALUES (?, ?, ?, ?, ?, FALSE)
     ON DUPLICATE KEY UPDATE
       login = VALUES(login),
       name = VALUES(name),
       avatar_url = VALUES(avatar_url),
       access_token_enc = VALUES(access_token_enc),
       token_invalid = FALSE`,
    [githubId, login, name, avatarUrl, accessTokenEnc]
  );
  const [[row]] = await pool.query('SELECT * FROM users WHERE github_id = ?', [githubId]);
  return toUser(row);
}

export async function findById(id) {
  const [[row]] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  return toUser(row);
}

export async function setTokenInvalid(id) {
  const [res] = await pool.query(
    'UPDATE users SET token_invalid = TRUE, access_token_enc = NULL WHERE id = ?',
    [id]
  );
  return res.affectedRows > 0;
}

export async function updateEtlResult(id, { status, message }) {
  const truncated = message == null ? null : String(message).slice(0, 500);
  await pool.query(
    'UPDATE users SET last_etl_at = NOW(), last_etl_status = ?, last_etl_message = ? WHERE id = ?',
    [status, truncated, id]
  );
}

export async function findAllWithValidToken() {
  const [rows] = await pool.query(
    'SELECT id, login, access_token_enc FROM users WHERE access_token_enc IS NOT NULL AND token_invalid = FALSE'
  );
  return rows;
}

export async function deleteById(id) {
  const [res] = await pool.query('DELETE FROM users WHERE id = ?', [id]);
  return res.affectedRows > 0;
}
