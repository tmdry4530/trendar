CREATE DATABASE IF NOT EXISTS agent_radar
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE agent_radar;

DROP TABLE IF EXISTS repo_snapshots;
DROP TABLE IF EXISTS repos;
DROP TABLE IF EXISTS watch_queries;

CREATE TABLE watch_queries (
  id          INT            NOT NULL AUTO_INCREMENT,
  query       VARCHAR(200)   NOT NULL,
  query_type  ENUM('topic','keyword') NOT NULL DEFAULT 'keyword',
  is_active   BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_query (query, query_type)
);

CREATE TABLE repos (
  id              INT            NOT NULL AUTO_INCREMENT,
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
  first_seen_at   TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_github_id (github_id),
  KEY idx_query   (query_id),
  KEY idx_stars   (stars),
  KEY idx_growth  (growth_rate),        -- trends 정렬에 사용되는 인덱스
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
  captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_repo_time (repo_id, captured_at),
  CONSTRAINT fk_snap_repo
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

INSERT INTO watch_queries (query, query_type, is_active)
VALUES
  ('hermes agent',    'keyword', TRUE),
  ('ai agent skill',  'keyword', TRUE),
  ('ai-agents',       'topic',   TRUE);
