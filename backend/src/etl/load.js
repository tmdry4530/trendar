import { pool } from '../config/db.js';

export async function upsertRepo(repo) {
  const [res] = await pool.query(
    `INSERT INTO repos (github_id, query_id, user_id, full_name, owner, name, html_url, description, language, stars, github_created_at, node_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       query_id=VALUES(query_id), full_name=VALUES(full_name), owner=VALUES(owner),
       name=VALUES(name), html_url=VALUES(html_url), description=VALUES(description),
       language=VALUES(language), stars=VALUES(stars), github_created_at=VALUES(github_created_at),
       node_id=COALESCE(VALUES(node_id), node_id)`,
    [repo.github_id, repo.query_id, repo.user_id, repo.full_name, repo.owner, repo.name,
     repo.html_url, repo.description, repo.language, repo.stars, repo.github_created_at ?? null, repo.node_id ?? null]
  );
  if (res.insertId) return res.insertId;
  const [[row]] = await pool.query('SELECT id FROM repos WHERE github_id=? AND user_id=?', [repo.github_id, repo.user_id]);
  return row.id;
}

// 델타·점수 갱신 + last_refreshed_at=NOW(). stars를 넘기면(추적 레포 배치 갱신) 현재 스타도 함께 갱신한다.
export async function updateRepoDelta(repoId, { star_delta, growth_rate, delta_24h = 0, delta_7d = 0, score = 0, stars }) {
  await pool.query(
    `UPDATE repos SET star_delta=?, growth_rate=?, delta_24h=?, delta_7d=?, score=?,
       stars=COALESCE(?, stars), last_refreshed_at=NOW()
     WHERE id=?`,
    [star_delta, growth_rate, delta_24h, delta_7d, score, stars ?? null, repoId]
  );
}

export async function insertSnapshot(repoId, m) {
  await pool.query(
    'INSERT INTO repo_snapshots (repo_id, stars, forks, open_issues, watchers) VALUES (?,?,?,?,?)',
    [repoId, m.stars, m.forks, m.open_issues, m.watchers]
  );
}

export async function getLastSnapshot(repoId) {
  const [rows] = await pool.query(
    'SELECT stars, forks, open_issues, watchers, captured_at FROM repo_snapshots WHERE repo_id=? ORDER BY captured_at DESC, id DESC LIMIT 1',
    [repoId]
  );
  return rows[0] ?? null;
}

const BASELINE_SQL = `SELECT stars, TIMESTAMPDIFF(SECOND, captured_at, NOW()) AS age_sec
  FROM repo_snapshots
  WHERE repo_id=? AND captured_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)
  ORDER BY captured_at DESC, id DESC LIMIT 1`;

// 윈도우 델타 기준 스냅샷 — 24h/7d 기준선과, 기준선이 없을 때 환산에 쓸 가장 오래된 스냅샷.
// 경과 시간은 DB NOW() 기준 초(age_sec)로 받아 앱/DB 시계·타임존 차이를 피한다.
// oldest는 스냅샷이 1개(=방금 삽입한 현재 스냅샷)뿐이면 null.
export async function getDeltaBaselines(repoId) {
  const [[b24], [b7], [old]] = await Promise.all([
    pool.query(BASELINE_SQL, [repoId, 24]),
    pool.query(BASELINE_SQL, [repoId, 24 * 7]),
    pool.query(
      `SELECT s.stars, TIMESTAMPDIFF(SECOND, s.captured_at, NOW()) AS age_sec,
              (SELECT COUNT(*) FROM repo_snapshots c WHERE c.repo_id = s.repo_id) AS n
       FROM repo_snapshots s WHERE s.repo_id=? ORDER BY s.captured_at ASC, s.id ASC LIMIT 1`,
      [repoId]
    ),
  ]);
  const toBase = (r) => (r ? { stars: Number(r.stars), age_sec: Number(r.age_sec) } : null);
  const oldest = old[0] && Number(old[0].n) > 1 ? toBase(old[0]) : null;
  return { base24h: toBase(b24[0]), base7d: toBase(b7[0]), oldest };
}

// 검색 결과 밖 추적 레포 후보 — 최근 N일 내 갱신된 사용자 레포.
export async function findTrackedRepos(userId, days) {
  const [rows] = await pool.query(
    `SELECT id, github_id, node_id, stars FROM repos
     WHERE user_id=? AND last_refreshed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [userId, Number(days)]
  );
  return rows;
}
