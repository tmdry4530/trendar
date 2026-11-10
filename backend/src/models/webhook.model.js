import { pool } from '../config/db.js';

const AUTO_DISABLE_AFTER = 3;

function toEndpoint(row) {
  if (!row) return null;
  return { ...row, enabled: Boolean(row.enabled), auto_disabled: Boolean(row.auto_disabled) };
}

// DATETIME 열은 초 단위라 MySQL이 밀리초를 반올림한다. 올림되면 방금 넣은 발신이 "아직 때가 안 됨"으로 보여
// 즉시 발신이 다음 주기로 밀리므로, 발신 예정 시각은 초 아래를 버리고 저장한다.
function wholeSecond(value) {
  return value == null ? null : new Date(Math.floor(new Date(value).getTime() / 1000) * 1000);
}

async function inTransaction(run) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await run(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getEndpoint(userId) {
  const [[row]] = await pool.query('SELECT * FROM webhook_endpoints WHERE user_id = ?', [userId]);
  return toEndpoint(row);
}

export async function createEndpoint(userId, { url_enc, secret_enc, url_hint, format }) {
  await pool.query(
    'INSERT INTO webhook_endpoints (user_id, url_enc, secret_enc, url_hint, format) VALUES (?, ?, ?, ?, ?)',
    [userId, url_enc, secret_enc, url_hint, format]
  );
}

export async function updateEndpointUrl(userId, { url_enc, url_hint, format }) {
  const [res] = await pool.query(
    `UPDATE webhook_endpoints SET url_enc = ?, url_hint = ?, format = ?, enabled = TRUE, auto_disabled = FALSE, consecutive_failures = 0
      WHERE user_id = ?`,
    [url_enc, url_hint, format, userId]
  );
  return res.affectedRows > 0;
}

export async function setEnabled(userId, enabled) {
  const [res] = await pool.query(
    enabled
      ? 'UPDATE webhook_endpoints SET enabled = TRUE, auto_disabled = FALSE, consecutive_failures = 0 WHERE user_id = ?'
      : 'UPDATE webhook_endpoints SET enabled = FALSE WHERE user_id = ?',
    [userId]
  );
  return res.affectedRows > 0;
}

export async function setSecret(userId, secretEnc) {
  const [res] = await pool.query('UPDATE webhook_endpoints SET secret_enc = ? WHERE user_id = ?', [secretEnc, userId]);
  return res.affectedRows > 0;
}

export async function deleteEndpoint(userId) {
  return inTransaction(async (connection) => {
    // 수집 중인 enqueueRising과 순서를 정하려고 설정 행부터 잠근다.
    await connection.query('SELECT user_id FROM webhook_endpoints WHERE user_id = ? FOR UPDATE', [userId]);
    await connection.query('DELETE FROM webhook_deliveries WHERE user_id = ?', [userId]);
    await connection.query('DELETE FROM webhook_notified_repos WHERE user_id = ?', [userId]);
    const [res] = await connection.query('DELETE FROM webhook_endpoints WHERE user_id = ?', [userId]);
    return res.affectedRows > 0;
  });
}

// 기본키 (user_id, github_id)가 중복을 막는다. 동시에 들어온 같은 저장소는 먼저 커밋한 쪽만 새것으로 본다.
async function markNotifiedWith(connection, userId, githubIds, at) {
  const fresh = [];
  for (const id of new Set(githubIds.map(Number))) {
    const [res] = await connection.query(
      'INSERT IGNORE INTO webhook_notified_repos (user_id, github_id, notified_at) VALUES (?, ?, ?)',
      [userId, id, at]
    );
    if (res.affectedRows === 1) fresh.push(id);
  }
  return fresh;
}

export async function markNotified(userId, githubIds, at) {
  return inTransaction((connection) => markNotifiedWith(connection, userId, githubIds, at));
}

// 보냄 기록과 발신 대기 행을 한 트랜잭션에 넣어, 기록만 남고 알림이 빠지거나 그 반대가 되지 않게 한다.
export async function enqueueRising(userId, { githubIds, buildPayload, deliveryId, at }) {
  return inTransaction(async (connection) => {
    // 수집이 켜짐을 확인한 뒤 설정이 삭제·꺼졌을 수 있어, 같은 트랜잭션에서 잠그고 다시 확인한다.
    const [[endpoint]] = await connection.query('SELECT enabled FROM webhook_endpoints WHERE user_id = ? FOR UPDATE', [userId]);
    if (!endpoint?.enabled) return null;
    const fresh = await markNotifiedWith(connection, userId, githubIds, at);
    if (!fresh.length) return null;
    await connection.query(
      `INSERT INTO webhook_deliveries (user_id, delivery_id, event, payload, max_attempts, next_attempt_at, created_at)
       VALUES (?, ?, 'rising.new', ?, 5, ?, ?)`,
      [userId, deliveryId, buildPayload(fresh), wholeSecond(at), at]
    );
    return { delivery_id: deliveryId, github_ids: fresh };
  });
}

export async function insertDelivery({ user_id, delivery_id, event, payload, max_attempts, next_attempt_at, created_at }) {
  await pool.query(
    `INSERT INTO webhook_deliveries (user_id, delivery_id, event, payload, max_attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [user_id, delivery_id, event, payload, max_attempts, wholeSecond(next_attempt_at), created_at]
  );
}

export async function listDeliveries(userId, limit = 10) {
  const [rows] = await pool.query(
    `SELECT delivery_id, event, status, attempts, last_status_code, last_error_code, created_at, completed_at
       FROM webhook_deliveries WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [userId, Number(limit)]
  );
  return rows;
}

// 대기 중인 행의 next_attempt_at을 lease 시각으로 미뤄 선점한다. 갱신에 성공한 쪽만 그 발신을 맡는다.
async function claim(row, now, leaseUntil) {
  const [res] = await pool.query(
    "UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?",
    [leaseUntil, row.id, now]
  );
  return res.affectedRows > 0;
}

export async function claimDue(now, leaseUntil, limit = 20) {
  const [rows] = await pool.query(
    "SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC, id ASC LIMIT ?",
    [now, Number(limit)]
  );
  const claimed = [];
  for (const row of rows) if (await claim(row, now, leaseUntil)) claimed.push(row);
  return claimed;
}

export async function claimOne(deliveryId, now, leaseUntil) {
  const [[row]] = await pool.query('SELECT * FROM webhook_deliveries WHERE delivery_id = ?', [deliveryId]);
  if (!row || !(await claim(row, now, leaseUntil))) return null;
  return row;
}

export async function finishDelivery(id, { status, attempts, last_status_code, last_error_code, next_attempt_at, completed_at }) {
  await pool.query(
    `UPDATE webhook_deliveries SET status = ?, attempts = ?, last_status_code = ?, last_error_code = ?, next_attempt_at = ?, completed_at = ?
      WHERE id = ?`,
    [status, attempts, last_status_code, last_error_code, next_attempt_at, completed_at, id]
  );
}

export async function cancelPending(userId, at) {
  const [res] = await pool.query(
    "UPDATE webhook_deliveries SET status = 'failed', last_error_code = 'DISABLED', next_attempt_at = NULL, completed_at = ? WHERE user_id = ? AND status = 'pending'",
    [at, userId]
  );
  return res.affectedRows;
}

// 성공하면 연속 실패 수를 지우고, 알림이 최종 실패하면 올린다. 3건째에 수신 URL을 자동으로 끈다.
export async function recordOutcome(userId, { success, countsTowardDisable }) {
  if (success) {
    await pool.query('UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE user_id = ?', [userId]);
    return { auto_disabled: false };
  }
  if (!countsTowardDisable) return { auto_disabled: false };
  await pool.query('UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1 WHERE user_id = ?', [userId]);
  const [res] = await pool.query(
    'UPDATE webhook_endpoints SET enabled = FALSE, auto_disabled = TRUE WHERE user_id = ? AND enabled = TRUE AND consecutive_failures >= ?',
    [userId, AUTO_DISABLE_AFTER]
  );
  return { auto_disabled: res.affectedRows > 0 };
}

export async function pruneDeliveries(before) {
  const [res] = await pool.query('DELETE FROM webhook_deliveries WHERE created_at < ?', [before]);
  return res.affectedRows;
}
