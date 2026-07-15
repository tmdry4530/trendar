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
  last_etl_at       DATETIME,
  last_etl_status   ENUM('ok','error','token_invalid'),
  last_etl_message  VARCHAR(500),
  created_at        TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_github_id (github_id)
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
  note            TEXT,
  is_bookmarked   BOOLEAN        NOT NULL DEFAULT FALSE,
  first_seen_at   TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_github (user_id, github_id),
  KEY idx_query   (query_id),
  KEY idx_stars   (stars),
  KEY idx_growth  (growth_rate),        -- trends 정렬에 사용되는 인덱스
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
