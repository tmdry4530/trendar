---
feature: trend-discovery
status: approved
created: 2026-07-19
---

# 신생 트렌드 수집 (trend-discovery) — 기술 설계

## 1. 아키텍처 개요

수집 한 번(사용자 1명, 조건 1개)의 흐름이 이렇게 바뀐다:

```
현재:  검색(스타순) ─→ 레포 30개 ─→ 정규화→upsert→스냅샷
변경:  ┌ 슬라이스 A: 검색(스타순, min=ETL_MIN_STARS)        ┐
       └ 슬라이스 B: 검색(created:>90일전, min=TREND 하한)  ┘
              ↓ (사용자 실행 단위 dedup: 같은 github_id는 1회만)
       정규화(+github_created_at) → upsert → 스냅샷 1행
```

노출 흐름 (R4):

```
GET /api/rising → repo.model.risingRepos(userId)
  → WHERE github_created_at >= NOW() - 윈도우일
    ORDER BY stars / GREATEST(경과일, 1) DESC   ← velocity는 조회 시 계산
  → 대시보드 '신생 급상승' 패널 (Top Movers 아래)
```

핵심 아이디어 3가지:

- **표본 문제는 표본으로 푼다** — 델타 엔진은 그대로 두고, 수집 쿼리에 `created:` 한정자를 붙인 슬라이스를 하나 더 돌려 신생 레포를 표본에 넣는다 (R1).
- **velocity는 저장하지 않고 조회 시 계산** — 나이는 수집과 무관하게 매일 늘어나므로, 컬럼에 캐시하면 수집 전까지 값이 낡는다. `stars / 경과일`은 SQL 한 줄이라 읽기 비용도 무시 가능 ([ADR-0005](../adr/0005-trend-slice-and-velocity.md)).
- **dedup은 실행(run) 단위 Set** — 한 사용자의 수집 동안 처리한 `github_id`를 Set에 담아, 슬라이스·조건 간 중복을 두 번째부터 스킵한다. 스냅샷 오염(R3)이 사라지고, 기존에 있던 "같은 레포가 두 쿼리에 걸리면 스냅샷 2행" 잠재 버그도 함께 해결된다.

## 2. 기술 선택과 이유

| 기술/패턴 | 역할 (한 줄 풀이) | 왜 이것인가 (대안 대비) |
|---|---|---|
| `created:>YYYY-MM-DD` 검색 한정자 | GitHub Search가 지원하는 생성일 필터 | Trending 페이지 스크래핑(비공식·불안정) 대신 공식 API 문법만 사용 |
| 슬라이스 병행 (교체 아님) | 기존 스타순 + 신생 두 번 검색 | 거대 레포 베이스라인 유지 + 신생 진입. API 비용은 쿼리당 1회 추가 — 분당 30회 한도에 여유 (10조건 × 2 = 20회) |
| 슬라이스별 스타 하한 | base=`ETL_MIN_STARS`(1000), trend=`ETL_TREND_MIN_STARS`(50) | 신생 레포에 1000 하한이면 전부 걸러져 빈손 — 하한을 분리해야 슬라이스가 의미를 가짐 (R1.3) |
| velocity 조회 시 계산 | `stars / GREATEST(DATEDIFF(NOW(), github_created_at), 1)` | 저장 컬럼은 수집 전까지 낡음. SQL 표현식이면 항상 현재 나이 기준 (R2.2) |
| 실행 단위 dedup Set | `runPipelineForUser` 안의 `Set<github_id>` | DB 제약(`INSERT IGNORE` 등)은 스냅샷 중복을 못 막음 — 적재 전에 걸러야 함 (R3.1) |
| 멱등 ALTER 마이그레이션 | `repos.github_created_at DATETIME` 추가 | 기존 `migrateUsersColumns`와 동일 패턴 — INFORMATION_SCHEMA 확인 후 없을 때만 ALTER (R2.3) |
| 신규 API `GET /api/rising` | 신생 속도순 목록 | 기존 `/api/trends`(성장률순)와 정렬·필터가 달라 별도 엔드포인트가 명확 (R4) |

## 3. 컴포넌트와 인터페이스

### `backend/src/utils/limits.js` (확장)
- `trendWindowDays()` → `ETL_TREND_WINDOW_DAYS` 양의 정수 아니면 90 (R5.1, R5.3)
- `trendMinStars()` → `ETL_TREND_MIN_STARS` 0 이상 정수 아니면 50 (R5.2, R5.3)

### `backend/src/etl/extract.js` (개편)
- `extractRepos(wq, octokit, { minStars, createdAfter } = {})` — 옵션 주입형으로 변경.
  - `createdAfter`(YYYY-MM-DD)가 있으면 질의에 ` created:>${createdAfter}` 추가 (R1.1, R1.2)
  - `minStars > 0`이면 ` stars:>=${minStars}` 추가 (모듈 상수 MIN_STARS 의존 제거)
- **근거**: R1.1~R1.3

### `backend/src/etl/pipeline.js` (개편)
- 조건 루프 내부를 **슬라이스 루프**로:
  ```
  slices = [
    { minStars: ETL_MIN_STARS },                          // base
    { minStars: trendMinStars(), createdAfter: 윈도우 계산 } // trend
  ]
  for slice of slices: extract → (dedup 체크) → 정규화 → 적재
  ```
- `runPipelineForUser` 시작 시 `const seen = new Set()` — `repo.github_id`가 있으면 스킵 (R3.1). 먼저 처리된 조건이 `query_id` 귀속을 가짐 (R3.2)
- 슬라이스 실패는 기존 조건 실패와 같은 방식으로 `errors[]` 격리 (R1.4). 401 특별 취급(토큰 무효)은 유지
- 적재 가드 `repo.stars < MIN_STARS`를 **슬라이스별 minStars**로 교체
- **근거**: R1, R3

### `backend/src/etl/transform.js` (확장)
- `normalizeRepo`에 `github_created_at: raw.created_at ?? null` 추가 (R2.1)

### `backend/src/etl/load.js` + `db/` (확장)
- `upsertRepo` INSERT/UPDATE 컬럼에 `github_created_at` 추가
- `db/init.js` `migrateUsersColumns` 옆에 repos 컬럼 마이그레이션 추가 (기존 함수를 `migrateColumns`로 일반화하거나 나란히), `db/schema.sql`·`db/schema.dbml` 동기화 (R2.3)

### `backend/src/models/repo.model.js` + routes (신규 조회)
- `risingRepos(userId, windowDays, limit = 8)`:
  ```sql
  SELECT id, full_name, language, stars, github_created_at,
         stars / GREATEST(DATEDIFF(NOW(), github_created_at), 1) AS velocity
  FROM repos
  WHERE user_id = ? AND github_created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
  ORDER BY velocity DESC LIMIT ?
  ```
- `stats.routes.js`에 `r.get('/rising', c.rising)` 추가 — requireAuth 뒤 (R4.1, R4.4)

### 프론트엔드
- `types.ts`: `RisingRepo { id, full_name, language, stars, github_created_at, velocity }`
- `api/stats.ts`: `getRising(limit?)`
- `api/mock.ts`: `/rising` 핸들러 (신생 샘플 포함)
- `DashboardPage.tsx`: Top Movers 아래(왼쪽 컬럼)에 '신생 급상승' 패널 — 레포명·언어·스타·나이("3주 전", 기존 `formatRelativeTime` 재사용) (R4.2), 빈 상태는 기존 `EmptyState` 톤 (R4.3)

## 4. 데이터 모델

`repos`에 컬럼 1개 추가:

```sql
github_created_at  DATETIME NULL   -- GitHub 레포 생성 시각 (Search API created_at)
```

- NULL 허용 — 마이그레이션 이전 수집분은 값이 없고, rising 조회의 `WHERE github_created_at >= ...`가 자연히 제외한다. 다음 수집에서 upsert로 채워짐.
- 인덱스: `KEY idx_user_created (user_id, github_created_at)` — rising 조회가 사용자+생성일 범위 스캔이므로.

## 5. 에러 처리

| 시나리오 | 처리 | 근거 |
|---|---|---|
| 신생 슬라이스 검색 실패 | 그 슬라이스만 `errors[]`에 기록, base 슬라이스·다음 조건 계속 | R1.4 |
| 슬라이스 도중 401 | 기존과 동일 — token_invalid 마킹 후 그 사용자 중단 | 기존 R 유지 |
| `created_at` 없는 응답 | `github_created_at = NULL` 저장, rising에서 자연 제외 | R2.1 방어 |
| 신생 레포 0건 | `/api/rising`이 빈 배열 반환 → 프론트 빈 상태 표시 | R4.3 |
| 비정상 환경변수 | 기본값 90일/50스타 폴백 | R5.3 |

## 6. 테스트 전략

기존 node:test + DI 패턴.

- `extract` 질의 조립 (신규 케이스): `createdAfter` 있으면 `created:>` 포함, `minStars` 슬라이스별 반영, topic/keyword 각각
- `pipeline.test` 확장:
  - 두 슬라이스가 같은 github_id 반환 → upsert·스냅샷 각 1회 (R3.1)
  - 두 조건이 같은 레포 반환 → 첫 조건 query_id 귀속 (R3.2)
  - 신생 슬라이스 throw → base 결과는 저장되고 errors에 기록 (R1.4)
  - 슬라이스별 minStars 가드 적용 (R1.3)
- `limits.test` 확장: trendWindowDays/trendMinStars 기본값·env·비정상값 (R5)
- `risingRepos` SQL은 실DB 필요 → 시연 체크리스트로. velocity 식은 조회 SQL 한 곳에 고정
- 프론트: `tsc`+`vite build`, 목 모드에서 '신생 급상승' 렌더·빈 상태 확인 (R4)

## 7. 결정 기록

- [ADR-0005: 트렌드 표본 — 병행 슬라이스 수집 + velocity 조회 시 계산](../adr/0005-trend-slice-and-velocity.md)
