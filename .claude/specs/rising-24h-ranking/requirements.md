---
feature: rising-24h-ranking
status: superseded
created: 2026-08-09
related:
  - .claude/specs/trend-ranking-v2/requirements.md
  - .claude/specs/adr/0006-coverage-depth-and-hot-score.md
---

# 신생 급상승 24시간 랭킹 (rising-24h-ranking) — 요구사항

> **Superseded (2026-10-30):** 대시보드 신생 급상승은 공개 피드와 같은 `rising-score-v3` 규칙(`backend/src/services/rising-score.js`의 `rankRising`)으로 통일했다. `RISING_MIN_DELTA` 하드컷과 `buildRisingQuery`는 제거됐다. 현재 규칙은 README의 '랭킹' 절을 따른다.

## 1. Overview

### 문제 정의

현재 신생 급상승은 `repos.star_delta`, 즉 직전 수집 대비 증가량을 사용한다. 자동 수집은 기본 6시간 주기지만 수동 수집이 끼어들 수 있어 레포마다 비교 구간이 달라지고, 동일 목록 안에서도 증가량을 공정하게 비교하기 어렵다. 또한 명시적인 노출 스타 하한이 없어 초기 신호가 약한 레포가 신생 급상승 목록을 채울 수 있다.

### 목표

- 수집 주기는 6시간으로 유지하면서 신생 급상승의 비교 구간을 최근 24시간으로 고정한다.
- 생성 30일 이내이면서 총 500스타 이상인 레포만 신생 급상승에 노출한다.
- 최근 24시간 절대 증가량을 우선해 "오늘 실제로 뜨는 신생 레포"를 보여준다.

### Non-goals

- ETL 수집 주기 또는 신생 슬라이스 수집 하한(`ETL_TREND_MIN_STARS`, 기본 50) 변경
- Top Movers와 관심 레포의 기존 랭킹 변경
- 12시간 랭킹 또는 사용자가 시간 창을 선택하는 기능
- 스냅샷 집계 테이블·캐시·보존 정책 추가

### 성공 기준

- 수동 수집 여부와 무관하게 신생 급상승이 동일한 24시간 기준으로 비교된다.
- 생성 30일 초과 또는 총 500스타 미만인 레포는 목록에 나타나지 않는다.
- 24시간 기준 스냅샷이 없거나 24시간 증가량이 0 이하인 레포는 나타나지 않는다.
- 화면의 증가량과 정렬 결과가 API의 24시간 지표와 일치한다.

## 2. 요구사항

### R1. 24시간 기준선 산출

**유저스토리:** 사용자로서, 수집 실행 시점에 흔들리지 않는 기준으로 지금 뜨는 레포를 비교하고 싶다.

**인수 조건:**

- R1.1 WHEN 신생 급상승을 조회하면, THE SYSTEM SHALL 현재 시각에서 24시간 이전인 스냅샷 중 가장 최근 스냅샷을 기준선으로 선택한다.
- R1.2 WHEN 기준선이 존재하면, THE SYSTEM SHALL `star_delta_24h = 현재 stars - 기준선 stars`로 최근 24시간 증가량을 계산한다.
- R1.3 WHEN 24시간 성장률을 계산하면, THE SYSTEM SHALL `growth_rate_24h = star_delta_24h / max(기준선 stars, 1)`을 사용한다.
- R1.4 IF 24시간 이전 기준선이 없으면, THEN THE SYSTEM SHALL 해당 레포를 신생 급상승에서 제외한다.
- R1.5 WHILE 자동·수동 수집이 추가 스냅샷을 생성하더라도, THE SYSTEM SHALL R1.1의 고정 기준선 규칙을 동일하게 적용한다.

### R2. 신생·최소 스타·활동 필터

**유저스토리:** 사용자로서, 의미 있는 반응을 확보했고 오늘도 성장 중인 신생 레포만 보고 싶다.

**인수 조건:**

- R2.1 WHEN 신생 급상승을 조회하면, THE SYSTEM SHALL 생성 후 `RISING_WINDOW_DAYS`(기본 30)일 이내인 레포만 대상으로 한다.
- R2.2 WHEN 신생 급상승을 조회하면, THE SYSTEM SHALL 현재 총 스타가 `RISING_MIN_STARS`(기본 500) 이상인 레포만 대상으로 한다.
- R2.3 IF `star_delta_24h`가 0 이하이면, THEN THE SYSTEM SHALL 해당 레포를 제외한다.
- R2.4 IF 모든 후보가 제외되면, THEN THE SYSTEM SHALL 에러가 아닌 빈 배열을 반환하고 화면은 기존 빈 상태를 표시한다.

### R3. 랭킹과 API 표현

**유저스토리:** 사용자로서, 지난 하루 동안 가장 많은 관심을 받은 신생 레포부터 보고 싶다.

**인수 조건:**

- R3.1 WHEN 후보를 정렬하면, THE SYSTEM SHALL `star_delta_24h` 내림차순을 1차 기준으로 사용한다.
- R3.2 IF `star_delta_24h`가 같으면, THEN THE SYSTEM SHALL `growth_rate_24h` 내림차순을 2차 기준으로 사용한다.
- R3.3 WHEN `/api/rising`이 항목을 반환하면, THE SYSTEM SHALL `star_delta_24h`와 `growth_rate_24h`를 명시적인 필드로 제공한다.
- R3.4 WHEN 대시보드가 신생 급상승을 표시하면, THE SYSTEM SHALL 증가 열에 `star_delta_24h`를 표시하고 24시간 기준임을 사용자가 식별할 수 있게 한다.

### R4. 설정

**유저스토리:** 운영자로서, 코드 배포 없이 신생 급상승의 최소 스타 기준을 조정하고 싶다.

**인수 조건:**

- R4.1 WHEN `RISING_MIN_STARS`를 양의 정수로 설정하면, THE SYSTEM SHALL 해당 값을 신생 급상승 노출 하한에 적용한다.
- R4.2 IF `RISING_MIN_STARS`가 없거나 0 이하 또는 정수가 아니면, THEN THE SYSTEM SHALL 기본값 500을 사용한다.
- R4.3 THE SYSTEM SHALL `backend/.env.example`에 `RISING_MIN_STARS`와 기본 목적을 문서화한다.

## 3. 프로젝트 제약과 검증 경계

- 명령: 백엔드 `npm test`, 프론트엔드 `npm run typecheck` 및 `npm run build`.
- 구조: 백엔드 조회·계산은 기존 `backend/src/models`와 `backend/src/utils`, UI 계약은 `frontend/src/types.ts`와 기존 신생 급상승 컴포넌트를 따른다.
- 스타일: 기존 JavaScript ESM·TypeScript 관례와 의존성 주입형 `node:test` 패턴을 유지한다.
- 항상: 사용자 `user_id` 격리를 유지하고, 시간 기준선·환경변수 폴백·UI 표시를 자동 테스트한다.
- 먼저 승인: 스키마 변경, 신규 의존성, API 필드 제거.
- 금지: 현재 `star_delta`의 저장 의미 변경, 기존 스냅샷 재작성, 실패 테스트 비활성화.

## 4. Open Questions

- 없음. R1.4의 기준선 없는 레포 제외 정책은 requirements 승인 시 함께 확정한다.
