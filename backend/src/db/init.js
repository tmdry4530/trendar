import { pool } from '../config/db.js';

export async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS watch_queries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    query VARCHAR(200) NOT NULL,
    query_type ENUM('topic','keyword') NOT NULL DEFAULT 'keyword',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_query (query, query_type)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS repos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    github_id BIGINT NOT NULL,
    query_id INT NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    owner VARCHAR(120),
    name VARCHAR(160),
    html_url VARCHAR(255),
    description TEXT,
    language VARCHAR(50),
    stars INT DEFAULT 0,
    star_delta INT DEFAULT 0,
    growth_rate DOUBLE DEFAULT 0,
    note TEXT,
    is_bookmarked BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_github_id (github_id),
    KEY idx_query (query_id),
    KEY idx_stars (stars),
    KEY idx_growth (growth_rate),
    CONSTRAINT fk_repo_query FOREIGN KEY (query_id) REFERENCES watch_queries(id) ON DELETE CASCADE
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS repo_snapshots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    repo_id INT NOT NULL,
    stars INT,
    forks INT,
    open_issues INT,
    watchers INT,
    captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_repo_time (repo_id, captured_at),
    CONSTRAINT fk_snap_repo FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
  )`);

  const [[{ c }]] = await pool.query('SELECT COUNT(*) AS c FROM watch_queries');
  if (c === 0) {
    await pool.query(`INSERT INTO watch_queries (query, query_type, is_active) VALUES
      ('hermes agent','keyword',TRUE),
      ('ai agent skill','keyword',TRUE),
      ('ai-agents','topic',TRUE)`);
  }
}
