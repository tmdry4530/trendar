CREATE DATABASE IF NOT EXISTS trendar
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE trendar;

DROP TABLE IF EXISTS repo_snapshots;
DROP TABLE IF EXISTS repos;
DROP TABLE IF EXISTS watch_queries;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id                INT            NOT NULL AUTO_INCREMENT,
  github_id         BIGINT         NOT NULL,
  login             VARCHAR(100)   NOT NULL,
  name              VARCHAR(200),
  avatar_url        VARCHAR(500),
  access_token_enc  TEXT,
  token_invalid     BOOLEAN        NOT NULL DEFAULT FALSE,
  manual_etl_date   DATE,                            -- 마지막 수동 수집의 KST 날짜
  manual_etl_count  INT            NOT NULL DEFAULT 0, -- 그 날짜의 사용 횟수
  plan              ENUM('free','pro') NOT NULL DEFAULT 'free', -- 표시용 캐시 (정확한 판정은 subscriptions 기준)
  last_etl_at       DATETIME,
  last_etl_status   ENUM('ok','error','token_invalid'),
  last_etl_message  VARCHAR(500),
  created_at        TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_github_id (github_id)
);

CREATE TABLE subscriptions (
  id                    INT            NOT NULL AUTO_INCREMENT,
  user_id               INT            NOT NULL,              -- 구독 소유자
  paddle_subscription_id VARCHAR(64)   NOT NULL,              -- Paddle sub_xxx
  paddle_customer_id    VARCHAR(64),                          -- Paddle ctm_xxx
  status                VARCHAR(32)    NOT NULL,              -- active/trialing/past_due/canceled/...
  price_id              VARCHAR(64),                         -- Paddle pri_xxx
  current_period_end    DATETIME,                            -- canceled여도 이 시점까지 Pro 유지
  created_at            TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user (user_id),
  UNIQUE KEY uq_paddle_sub (paddle_subscription_id),
  CONSTRAINT fk_sub_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE paddle_events (
  event_id    VARCHAR(64)  NOT NULL, -- 웹훅 멱등 키
  received_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id)
);

CREATE TABLE sessions (
  id          INT       NOT NULL AUTO_INCREMENT,
  user_id     INT       NOT NULL,
  token_hash  CHAR(64)  NOT NULL,
  expires_at  DATETIME  NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_token_hash (token_hash),
  KEY idx_expires (expires_at),
  CONSTRAINT fk_session_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE watch_queries (
  id          INT            NOT NULL AUTO_INCREMENT,
  user_id     INT            NOT NULL,
  query       VARCHAR(200)   NOT NULL,
  query_type  ENUM('topic','keyword') NOT NULL DEFAULT 'keyword',
  is_active   BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_query (user_id, query, query_type),
  CONSTRAINT fk_query_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE repos (
  id              INT            NOT NULL AUTO_INCREMENT,
  user_id         INT            NOT NULL,
  github_id       BIGINT         NOT NULL,
  query_id        INT            NOT NULL,
  full_name       VARCHAR(255)   NOT NULL,
  owner           VARCHAR(120),
  name            VARCHAR(160),
  html_url        VARCHAR(255),
  description     TEXT,
  language        VARCHAR(50),
  stars           INT            DEFAULT 0,
  star_delta      INT            DEFAULT 0,
  growth_rate     DOUBLE         DEFAULT 0,
  github_created_at DATETIME     NULL,  -- GitHub 레포 생성 시각 (Search API created_at)
  note            TEXT,
  is_bookmarked   BOOLEAN        NOT NULL DEFAULT FALSE,
  first_seen_at   TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_github (user_id, github_id),
  KEY idx_query   (query_id),
  KEY idx_stars   (stars),
  KEY idx_growth  (growth_rate),        -- trends 정렬에 사용되는 인덱스
  KEY idx_user_created (user_id, github_created_at), -- rising 조회(사용자+생성일 범위 스캔)
  CONSTRAINT fk_repo_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_repo_query
    FOREIGN KEY (query_id) REFERENCES watch_queries(id) ON DELETE CASCADE
);

CREATE TABLE repo_snapshots (
  id          INT       NOT NULL AUTO_INCREMENT,
  repo_id     INT       NOT NULL,
  stars       INT,
  forks       INT,
  open_issues INT,
  watchers    INT,
  captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_repo_time (repo_id, captured_at),
  CONSTRAINT fk_snap_repo
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public_feeds (
  id INT AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('all','language','topic') NOT NULL,
  slug VARCHAR(64) NOT NULL,
  last_attempt_at DATETIME NULL,
  last_success_at DATETIME NULL,
  last_status ENUM('ok','error') NULL,
  last_error_code VARCHAR(64) NULL,
  UNIQUE KEY uq_kind_slug (kind, slug)
);

CREATE TABLE IF NOT EXISTS public_repos (
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
);

CREATE TABLE IF NOT EXISTS public_repo_snapshots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  repo_id INT NOT NULL,
  stars INT NOT NULL,
  forks INT, open_issues INT, watchers INT,
  captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_repo_time (repo_id, captured_at, id),
  CONSTRAINT fk_psnap_repo FOREIGN KEY (repo_id) REFERENCES public_repos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public_feed_repos (
  feed_id INT NOT NULL, repo_id INT NOT NULL,
  last_seen_at DATETIME NOT NULL,
  PRIMARY KEY (feed_id, repo_id), KEY idx_feed_seen (feed_id, last_seen_at), KEY idx_repo (repo_id),
  CONSTRAINT fk_pfr_feed FOREIGN KEY (feed_id) REFERENCES public_feeds(id) ON DELETE CASCADE,
  CONSTRAINT fk_pfr_repo FOREIGN KEY (repo_id) REFERENCES public_repos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public_daily_metrics (
  day DATE NOT NULL,
  event_kind ENUM('page_view','signup') NOT NULL,
  path_template VARCHAR(32) NOT NULL,
  locale CHAR(2) NOT NULL,
  referrer_domain VARCHAR(255) NOT NULL DEFAULT '',
  is_bot TINYINT(1) NOT NULL DEFAULT 0,
  event_count INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event_kind, path_template, locale, referrer_domain, is_bot)
);

CREATE TABLE IF NOT EXISTS public_rank_history (
  feed_id INT NOT NULL,
  repo_id INT NOT NULL,
  captured_at DATETIME NOT NULL,
  `rank` SMALLINT UNSIGNED NOT NULL,
  stars INT NOT NULL,
  rate_24h DOUBLE NOT NULL,
  baseline_source ENUM('snapshot','creation','partial') NOT NULL,
  PRIMARY KEY (feed_id, captured_at, repo_id),
  KEY idx_repo_rank (repo_id, `rank`, captured_at),
  CONSTRAINT fk_prh_feed FOREIGN KEY (feed_id) REFERENCES public_feeds(id) ON DELETE CASCADE,
  CONSTRAINT fk_prh_repo FOREIGN KEY (repo_id) REFERENCES public_repos(id) ON DELETE CASCADE
);
