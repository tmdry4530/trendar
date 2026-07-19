import { pool } from '../config/db.js';

export async function upsertRepo(repo) {
  const [res] = await pool.query(
    `INSERT INTO repos (github_id, query_id, user_id, full_name, owner, name, html_url, description, language, stars, github_created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       query_id=VALUES(query_id), full_name=VALUES(full_name), owner=VALUES(owner),
       name=VALUES(name), html_url=VALUES(html_url), description=VALUES(description),
       language=VALUES(language), stars=VALUES(stars), github_created_at=VALUES(github_created_at)`,
    [repo.github_id, repo.query_id, repo.user_id, repo.full_name, repo.owner, repo.name,
     repo.html_url, repo.description, repo.language, repo.stars, repo.github_created_at ?? null]
  );
  if (res.insertId) return res.insertId;
  const [[row]] = await pool.query('SELECT id FROM repos WHERE github_id=? AND user_id=?', [repo.github_id, repo.user_id]);
  return row.id;
}

export async function updateRepoDelta(repoId, { star_delta, growth_rate }) {
  await pool.query('UPDATE repos SET star_delta=?, growth_rate=? WHERE id=?', [star_delta, growth_rate, repoId]);
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
