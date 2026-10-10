// Additive and resumable: a failed DDL/backfill can be retried without duplicate-column errors.
// The caller must serialize migrations (do not start multiple migrators concurrently).
export async function migrateRankingV3(db) {
  const [rows] = await db.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'repos'`);
  if (!rows.length) return;
  const columns = new Set(rows.map((row) => row.COLUMN_NAME));
  const definitions = {
    node_id: 'VARCHAR(100) NULL AFTER github_id',
    delta_24h: 'INT NOT NULL DEFAULT 0 AFTER growth_rate',
    delta_7d: 'INT NOT NULL DEFAULT 0 AFTER delta_24h',
    score: 'DOUBLE NOT NULL DEFAULT 0 AFTER delta_7d',
    last_refreshed_at: 'DATETIME NULL AFTER score',
  };
  for (const [name, definition] of Object.entries(definitions)) {
    if (!columns.has(name)) await db.query(`ALTER TABLE repos ADD COLUMN ${name} ${definition}`);
  }
  const [indexes] = await db.query(`SELECT DISTINCT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'repos'`);
  const existing = new Set(indexes.map((row) => row.INDEX_NAME));
  for (const [name, fields] of Object.entries({
    idx_user_score: 'user_id, score',
    idx_user_refreshed: 'user_id, last_refreshed_at',
  })) {
    if (!existing.has(name)) await db.query(`ALTER TABLE repos ADD KEY ${name} (${fields})`);
  }
  // Also retry backfill after an interrupted migration; never overwrite fresher collection times.
  await db.query(`UPDATE repos r
    SET r.last_refreshed_at = (SELECT MAX(s.captured_at) FROM repo_snapshots s WHERE s.repo_id = r.id)
    WHERE r.last_refreshed_at IS NULL`);
}
