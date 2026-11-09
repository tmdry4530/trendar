import { pool } from '../config/db.js';

// 판정은 github_id 기준이라 대시보드(repos)와 공개 풀(public_repos)이 같은 결과를 공유한다(D-007).
export function MALICIOUS_FILTER(alias) {
  return `NOT EXISTS (SELECT 1 FROM repo_security_verdicts v WHERE v.github_id = ${alias}.github_id AND v.verdict = 'malicious')`;
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

export async function upsertVerdict({ github_id, verdict, rule_version, evidence, repo_pushed_at, scanned_at }) {
  const params = [Number(github_id), verdict, rule_version, evidence, repo_pushed_at, scanned_at];
  // unknown은 조회 실패 기록이라 다른 수집이 먼저 저장한 판정을 덮지 않는다(D-008, 동시 수집 경쟁 포함).
  const sql = verdict === 'unknown'
    ? `INSERT IGNORE INTO repo_security_verdicts (github_id, verdict, rule_version, evidence, repo_pushed_at, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    : `INSERT INTO repo_security_verdicts (github_id, verdict, rule_version, evidence, repo_pushed_at, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE verdict = VALUES(verdict), rule_version = VALUES(rule_version), evidence = VALUES(evidence),
         repo_pushed_at = VALUES(repo_pushed_at), scanned_at = VALUES(scanned_at)`;
  await pool.query(sql, params);
}
