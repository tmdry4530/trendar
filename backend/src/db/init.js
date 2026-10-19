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

// v2 users 테이블에 이후 추가된 컬럼을 채운다. 이미 있으면 아무것도 하지 않는다.
async function migrateUsersColumns() {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
  );
  if (rows.length === 0) return; // users 자체가 없으면 CREATE가 최신 스키마로 만든다
  const columns = new Set(rows.map((row) => row.COLUMN_NAME));
  if (!columns.has('manual_etl_date')) {
    await pool.query('ALTER TABLE users ADD COLUMN manual_etl_date DATE AFTER token_invalid');
  }
  if (!columns.has('manual_etl_count')) {
    await pool.query(
      'ALTER TABLE users ADD COLUMN manual_etl_count INT NOT NULL DEFAULT 0 AFTER manual_etl_date'
    );
  }
}

// v2 repos 테이블에 이후 추가된 컬럼을 채운다. 이미 있으면 아무것도 하지 않는다.
async function migrateReposColumns() {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'repos'`
  );
  if (rows.length === 0) return; // repos 자체가 없으면 CREATE가 최신 스키마로 만든다
  const columns = new Set(rows.map((row) => row.COLUMN_NAME));
  if (!columns.has('github_created_at')) {
    await pool.query('ALTER TABLE repos ADD COLUMN github_created_at DATETIME NULL AFTER growth_rate');
    await pool.query('ALTER TABLE repos ADD KEY idx_user_created (user_id, github_created_at)');
  }
}

// Paddle 구독 스키마: subscriptions + paddle_events 테이블, users.plan 컬럼.
// CREATE는 최신 스키마로, 기존 DB는 ALTER로 채운다.
async function migrateBillingSchema() {
  const [userCols] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
  );
  const columns = new Set(userCols.map((row) => row.COLUMN_NAME));
  if (columns.size > 0 && !columns.has('plan')) {
    await pool.query(
      `ALTER TABLE users ADD COLUMN plan ENUM('free','pro') NOT NULL DEFAULT 'free' AFTER manual_etl_count`
    );
  }

  await pool.query(`CREATE TABLE IF NOT EXISTS subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    paddle_subscription_id VARCHAR(64) NOT NULL,
    paddle_customer_id VARCHAR(64) NULL,
    status VARCHAR(32) NOT NULL,
    price_id VARCHAR(64) NULL,
    current_period_end DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_user (user_id),
    UNIQUE KEY uq_paddle_sub (paddle_subscription_id),
    CONSTRAINT fk_sub_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS paddle_events (
    event_id VARCHAR(64) PRIMARY KEY,
    received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
}

async function migratePublicSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS public_feeds (
    id INT AUTO_INCREMENT PRIMARY KEY,
    kind ENUM('all','language','topic') NOT NULL,
    slug VARCHAR(64) NOT NULL,
    last_attempt_at DATETIME NULL,
    last_success_at DATETIME NULL,
    last_status ENUM('ok','error') NULL,
    last_error_code VARCHAR(64) NULL,
    UNIQUE KEY uq_kind_slug (kind, slug)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS public_repos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    github_id BIGINT NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    owner VARCHAR(120) NOT NULL,
    name VARCHAR(160) NOT NULL,
    html_url VARCHAR(255),
    description TEXT,
    language VARCHAR(50),
    stars INT NOT NULL DEFAULT 0,
    github_created_at DATETIME NULL,
    first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_github (github_id),
    KEY idx_owner_name (owner, name),
    KEY idx_created (github_created_at)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS public_repo_snapshots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    repo_id INT NOT NULL,
    stars INT NOT NULL,
    forks INT, open_issues INT, watchers INT,
    captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_repo_time (repo_id, captured_at, id),
    CONSTRAINT fk_psnap_repo FOREIGN KEY (repo_id) REFERENCES public_repos(id) ON DELETE CASCADE
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS public_feed_repos (
    feed_id INT NOT NULL, repo_id INT NOT NULL,
    last_seen_at DATETIME NOT NULL,
    PRIMARY KEY (feed_id, repo_id), KEY idx_feed_seen (feed_id, last_seen_at), KEY idx_repo (repo_id),
    CONSTRAINT fk_pfr_feed FOREIGN KEY (feed_id) REFERENCES public_feeds(id) ON DELETE CASCADE,
    CONSTRAINT fk_pfr_repo FOREIGN KEY (repo_id) REFERENCES public_repos(id) ON DELETE CASCADE
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS public_daily_metrics (
    day DATE NOT NULL,
    event_kind ENUM('page_view','signup') NOT NULL,
    path_template VARCHAR(32) NOT NULL,
    locale CHAR(2) NOT NULL,
    referrer_domain VARCHAR(255) NOT NULL DEFAULT '',
    is_bot TINYINT(1) NOT NULL DEFAULT 0,
    event_count INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (day, event_kind, path_template, locale, referrer_domain, is_bot)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS public_rank_history (
    feed_id INT NOT NULL,
    repo_id INT NOT NULL,
    captured_at DATETIME NOT NULL,
    \`rank\` SMALLINT UNSIGNED NOT NULL,
    stars INT NOT NULL,
    rate_24h DOUBLE NOT NULL,
    baseline_source ENUM('snapshot','creation','partial') NOT NULL,
    PRIMARY KEY (feed_id, captured_at, repo_id),
    KEY idx_repo_rank (repo_id, \`rank\`, captured_at),
    CONSTRAINT fk_prh_feed FOREIGN KEY (feed_id) REFERENCES public_feeds(id) ON DELETE CASCADE,
    CONSTRAINT fk_prh_repo FOREIGN KEY (repo_id) REFERENCES public_repos(id) ON DELETE CASCADE
  )`);
}

export async function initDb() {
  await dropLegacySchema();
  await migrateUsersColumns();
  await migrateReposColumns();

  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    github_id BIGINT NOT NULL,
    login VARCHAR(100) NOT NULL,
    name VARCHAR(200),
    avatar_url VARCHAR(500),
    access_token_enc TEXT,
    token_invalid BOOLEAN NOT NULL DEFAULT FALSE,
    manual_etl_date DATE,
    manual_etl_count INT NOT NULL DEFAULT 0,
    plan ENUM('free','pro') NOT NULL DEFAULT 'free',
    last_etl_at DATETIME,
    last_etl_status ENUM('ok','error','token_invalid'),
    last_etl_message VARCHAR(500),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_github_id (github_id)
  )`);

  await migrateBillingSchema();

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
    github_created_at DATETIME NULL,
    note TEXT,
    is_bookmarked BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_user_github (user_id, github_id),
    KEY idx_query (query_id),
    KEY idx_stars (stars),
    KEY idx_growth (growth_rate),
    KEY idx_user_created (user_id, github_created_at),
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

  await migratePublicSchema();
}
