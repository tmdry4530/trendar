import { pool } from '../config/db.js';

// 레거시(단일 테넌트) 스키마 감지 시 격리 전 테이블을 정리한다.
// users 테이블이 없는데 repos 테이블이 이미 존재하면 v1 레거시로 간주한다.
async function dropLegacySchema() {
  const [rows] = await pool.query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('users', 'repos')`
  );
  const tableNames = new Set(rows.map((row) => row.TABLE_NAME));
  const isLegacy = !tableNames.has('users') && tableNames.has('repos');
  if (!isLegacy) return;

  await pool.query('DROP TABLE IF EXISTS repo_snapshots');
  await pool.query('DROP TABLE IF EXISTS repos');
  await pool.query('DROP TABLE IF EXISTS watch_queries');
}

export async function initDb() {
  await dropLegacySchema();

  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    github_id BIGINT NOT NULL,
    login VARCHAR(100) NOT NULL,
    name VARCHAR(200),
    avatar_url VARCHAR(500),
    access_token_enc TEXT,
    token_invalid BOOLEAN NOT NULL DEFAULT FALSE,
    last_etl_at DATETIME,
    last_etl_status ENUM('ok','error','token_invalid'),
    last_etl_message VARCHAR(500),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_github_id (github_id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_token_hash (token_hash),
    KEY idx_expires (expires_at),
    CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS watch_queries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    query VARCHAR(200) NOT NULL,
    query_type ENUM('topic','keyword') NOT NULL DEFAULT 'keyword',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_user_query (user_id, query, query_type),
    CONSTRAINT fk_query_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS repos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
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
    UNIQUE KEY uq_user_github (user_id, github_id),
    KEY idx_query (query_id),
    KEY idx_stars (stars),
    KEY idx_growth (growth_rate),
    CONSTRAINT fk_repo_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
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
}
