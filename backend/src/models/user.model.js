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

// 오늘(today, KST 날짜 문자열) 사용 횟수를 원자적으로 1 소비한다.
// 검사와 증가가 한 문장이라 동시 요청이 한도를 넘길 틈이 없다.
// 반환 false = 한도 도달로 소비 실패.
export async function consumeManualEtl(id, today, limit) {
  const [res] = await pool.query(
    `UPDATE users SET
       manual_etl_count = IF(manual_etl_date = ?, manual_etl_count + 1, 1),
       manual_etl_date = ?
     WHERE id = ?
       AND (manual_etl_date IS NULL OR manual_etl_date <> ? OR manual_etl_count < ?)`,
    [today, today, id, today, limit]
  );
  return res.affectedRows > 0;
}

// 시작 전 거부(중복 실행·토큰 무효)된 소비를 되돌린다. 날짜가 바뀌었으면 no-op.
export async function refundManualEtl(id, today) {
  await pool.query(
    `UPDATE users SET manual_etl_count = GREATEST(manual_etl_count - 1, 0)
     WHERE id = ? AND manual_etl_date = ?`,
    [id, today]
  );
}

// 사용자 행 + 오늘(KST) 날짜로 수동 수집 사용 횟수를 계산. 저장된 날짜가 today가
// 아니면 0 (조회에도 리셋 반영). findById 결과에 이미 두 컬럼이 있어 재조회가 필요 없다.
export function manualUsageFromRow(row, today) {
  if (!row || !row.manual_etl_date) return 0;
  const stored = row.manual_etl_date instanceof Date
    ? kstDateString(row.manual_etl_date)
    : String(row.manual_etl_date).slice(0, 10);
  return stored === today ? row.manual_etl_count : 0;
}

// mysql2가 DATE를 Date 객체(로컬 자정)로 돌려줄 때 'YYYY-MM-DD'로 복원
function kstDateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
