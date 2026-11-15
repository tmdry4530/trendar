import { pool } from '../config/db.js';

// 판정은 github_id 기준이라 대시보드(repos)와 공개 풀(public_repos)이 같은 결과를 공유한다(D-007).
// README 판정 malicious와 배포형 캠페인 군집 표시(cluster_hidden, D-014)를 조회에서만 뺀다.
export function MALICIOUS_FILTER(alias) {
  return `NOT EXISTS (SELECT 1 FROM repo_security_verdicts v WHERE v.github_id = ${alias}.github_id AND (v.verdict = 'malicious' OR v.cluster_hidden = 1))`;
}

export async function findVerdicts(githubIds) {
  if (!githubIds.length) return new Map();
  const [rows] = await pool.query(
    `SELECT github_id, verdict, rule_version, repo_pushed_at FROM repo_security_verdicts
      WHERE github_id IN (${githubIds.map(() => '?').join(', ')})`,
    githubIds.map(Number)
  );
  return new Map(rows.map((row) => [Number(row.github_id), row]));
}

export async function upsertVerdict({
  github_id, verdict, rule_version, evidence, repo_pushed_at, scanned_at, owner_login = null, text_key = null, skeleton_key = null, lure = false,
}) {
  // unknown은 조회 실패 기록이라 다른 수집이 먼저 저장한 판정을 덮지 않는다(D-008, 동시 수집 경쟁 포함).
  if (verdict === 'unknown') {
    await pool.query(
      `INSERT IGNORE INTO repo_security_verdicts (github_id, verdict, rule_version, evidence, repo_pushed_at, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [Number(github_id), verdict, rule_version, evidence, repo_pushed_at, scanned_at]
    );
    return;
  }
  // cluster_hidden은 refreshClusters만 바꾼다.
  await pool.query(
    `INSERT INTO repo_security_verdicts
       (github_id, verdict, rule_version, evidence, repo_pushed_at, scanned_at, owner_login, text_key, skeleton_key, lure)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE verdict = VALUES(verdict), rule_version = VALUES(rule_version), evidence = VALUES(evidence),
       repo_pushed_at = VALUES(repo_pushed_at), scanned_at = VALUES(scanned_at), owner_login = VALUES(owner_login),
       text_key = VALUES(text_key), skeleton_key = VALUES(skeleton_key), lure = VALUES(lure)`,
    [Number(github_id), verdict, rule_version, evidence, repo_pushed_at, scanned_at, owner_login, text_key, skeleton_key, lure ? 1 : 0]
  );
}

// 군집(D-014·D-015): 미끼 표시가 있는 판정 중 같은 본문 키나 골격 키를 서로 다른 소유자 3명 이상이 쓰면 표시한다.
// 저장된 판정 전체에서 매번 다시 계산해 군집이 해체되면 표시도 풀린다. 표시가 바뀌는 행만 쓴다.
const CLUSTER_MIN_OWNERS = 3;

export async function refreshClusters() {
  await pool.query(
    `UPDATE repo_security_verdicts v
     LEFT JOIN (SELECT text_key AS k FROM repo_security_verdicts WHERE lure = 1 AND text_key IS NOT NULL
                GROUP BY text_key HAVING COUNT(DISTINCT owner_login) >= ?) t ON t.k = v.text_key
     LEFT JOIN (SELECT skeleton_key AS k FROM repo_security_verdicts WHERE lure = 1 AND skeleton_key IS NOT NULL
                GROUP BY skeleton_key HAVING COUNT(DISTINCT owner_login) >= ?) s ON s.k = v.skeleton_key
     SET v.cluster_hidden = (v.lure = 1 AND (t.k IS NOT NULL OR s.k IS NOT NULL))
     WHERE v.cluster_hidden <> (v.lure = 1 AND (t.k IS NOT NULL OR s.k IS NOT NULL))`,
    [CLUSTER_MIN_OWNERS, CLUSTER_MIN_OWNERS]
  );
  const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM repo_security_verdicts WHERE cluster_hidden = 1');
  return Number(row.n);
}
