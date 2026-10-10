-- 랭킹 v3: 시간 정규화 델타(24h/7d)·점수 정렬·추적 레포 배치 갱신
-- 배포 전에 1회 실행한다. (서버 기동 시 backend/src/db/init.js도 누락 컬럼을 자동 추가하지만,
-- 운영 DB에는 이 파일을 명시적으로 적용하는 것을 권장한다.)
-- MySQL 8.0 기준. 이미 적용된 DB에서 재실행하면 Duplicate column 오류가 나므로 1회만 실행할 것.

-- Select the intended database explicitly in the mysql client; do not assume its name.
-- For partial/already migrated schemas use: cd backend && npm run migrate:ranking-v3

ALTER TABLE repos
  ADD COLUMN node_id           VARCHAR(100) NULL     AFTER github_id,          -- GraphQL 전역 ID (Search API node_id)
  ADD COLUMN delta_24h         INT          NOT NULL DEFAULT 0 AFTER growth_rate, -- 24시간 정규화 스타 증가량
  ADD COLUMN delta_7d          INT          NOT NULL DEFAULT 0 AFTER delta_24h,   -- 7일 정규화 스타 증가량
  ADD COLUMN score             DOUBLE       NOT NULL DEFAULT 0 AFTER delta_7d,    -- delta_24h / sqrt(max(stars - delta_24h, 10))
  ADD COLUMN last_refreshed_at DATETIME     NULL     AFTER score,                 -- 마지막 스냅샷 갱신 시각
  ADD KEY idx_user_score (user_id, score),
  ADD KEY idx_user_refreshed (user_id, last_refreshed_at);

-- 기존 레포의 last_refreshed_at을 마지막 스냅샷 시각으로 채운다.
-- (14일 이내 스냅샷이 있는 레포가 첫 실행부터 추적 갱신 대상이 되도록. node_id는 다음 검색 적중 때 채워진다.)
UPDATE repos r
  SET r.last_refreshed_at = (SELECT MAX(s.captured_at) FROM repo_snapshots s WHERE s.repo_id = r.id)
  WHERE r.last_refreshed_at IS NULL;
