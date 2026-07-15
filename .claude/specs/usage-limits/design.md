---
feature: usage-limits
status: approved
created: 2026-07-15
---

# 사용량 한도 (수동 수집 일일 한도) — 기술 설계

## 1. 아키텍처 개요

수동 수집 요청 한 건의 흐름 (R1.1~R1.4):

```
POST /api/etl/run
  → requireAuth (기존)
  → etl.controller.run
      ① kstToday() 로 "오늘"(KST) 계산
      ② users 행에서 원자적 소비 시도  ── 실패(한도 도달) → 429 ETL_DAILY_LIMIT_EXCEEDED
      ③ runPipelineForUser(...) 실행
           └ 시작 전 거부(409: 중복 실행/토큰 무효) → ④ 소비 환불(-1) 후 에러 그대로 전달
      ⑤ 결과 반환
```

핵심 아이디어 두 가지:

- **리셋 배치가 없다** (R1.3): 카운터를 지우는 스케줄러를 두지 않는다. users 행에 `(마지막 사용 날짜, 그날의 횟수)`를 저장해두고, 요청이 올 때 "저장된 날짜 == 오늘(KST)?"만 본다. 날짜가 다르면 1부터 다시 센다. 지울 것이 없으니 실패할 배치도 없다.
- **검사와 증가가 한 문장** (동시성): "지금 몇 회지?" 조회 후 "+1" 하는 2단계로 나누면, 동시에 두 요청이 들어왔을 때 둘 다 검사를 통과하는 틈이 생긴다. UPDATE 한 문장 안에서 조건 검사와 증가를 같이 처리해(아래 §4) 이 틈을 원천 제거한다. MySQL이 한 문장의 원자성을 보장한다.

잔여 표시 흐름 (R2, R3): `GET /api/etl/status` 응답에 `manual_*` 필드 4개를 얹고, QueriesPage가 로드 시·수집 후에 이를 읽어 "오늘 N/10회" 배지와 버튼 비활성을 그린다.

## 2. 기술 선택과 이유

| 기술/패턴 | 역할 (한 줄 풀이) | 왜 이것인가 (대안 대비) |
|---|---|---|
| users 행 카운터 컬럼 2개 | 사용자별 오늘 사용량 저장 | 사용자당 1행이라 조인·정리 불필요. 대안(별도 이력 테이블, Redis)은 [ADR-0004](../adr/0004-daily-quota-in-users-row.md) 참조 |
| 조건부 원자 UPDATE | 한도 검사+증가를 한 번에 | SELECT 후 UPDATE 2단계의 동시성 틈을 제거. 락·트랜잭션 불필요 |
| 환불(refund) 방식 | 시작 못 한 실행의 횟수 복구 | "소비 먼저, 못 시작하면 -1"이 "검사 먼저, 시작하면 +1"보다 동시성에 안전 (후자는 검사~증가 사이 틈 존재). R1.4 충족 |
| KST 날짜 유틸 (자체 구현 ~15줄) | UTC 서버에서 "한국 기준 오늘" 계산 | 서버(Railway)는 UTC. `now + 9시간`의 날짜부가 곧 KST 날짜 — 라이브러리(dayjs 등) 없이 충분, 의존성 0 유지 |
| `GET /api/etl/status` 확장 | 잔여 한도 전달 통로 | 새 엔드포인트 대신 기존 status에 필드 추가 — 프론트 호출 지점 재사용, API 표면 최소화 (R3.1) |
| controller DI 팩토리화 | etl.controller를 테스트 가능하게 | 기존 `createAuthController`/`createEtlRunner`와 같은 패턴. 가짜 quota/pipeline 주입으로 DB 없이 단위 테스트 |

## 3. 컴포넌트와 인터페이스

### `backend/src/utils/kst.js` (신규)
- **책임**: KST 기준 날짜 계산. 테스트를 위해 `now`를 인자로 받을 수 있게.
- **인터페이스**:
  - `kstToday(now = new Date())` → `'2026-07-15'` (KST 기준 오늘의 날짜 문자열)
  - `kstNextMidnight(now = new Date())` → 다음 KST 자정의 `Date` (= 429/status의 `manual_reset_at`)
- **근거 요구사항**: R1.3, R1.2, R2.3

### `backend/src/utils/limits.js` (확장)
- **책임**: 한도 상수. 기존 `maxQueriesPerUser()`와 나란히.
- **인터페이스**: `maxManualEtlPerDay()` → env `MAX_MANUAL_ETL_PER_DAY` 정수(양수) 아니면 기본 10
- **근거 요구사항**: R1.6

### `backend/src/models/user.model.js` (확장)
- **책임**: 카운터 SQL 3종. HTTP를 모르는 층 유지.
- **인터페이스**:
  - `consumeManualEtl(userId, today, limit)` → boolean (§4의 원자 UPDATE, affectedRows=0이면 false=한도 도달)
  - `refundManualEtl(userId, today)` → 오늘 카운터를 -1 (0 미만 방지, 날짜가 이미 바뀌었으면 no-op)
  - `getManualEtlUsage(userId, today)` → 오늘 사용 횟수 (저장된 날짜 ≠ today면 0)
- **근거 요구사항**: R1.1, R1.4, R1.7, R3.2

### `backend/src/controllers/etl.controller.js` (개편 — DI 팩토리)
- **책임**: §1의 ①~⑤ 조율. `createEtlController({ pipeline, users, quota })` 팩토리로 전환.
- **인터페이스 (동작 변경)**:
  - `run` — 소비 실패 시 `httpError(429, 'ETL_DAILY_LIMIT_EXCEEDED', ...)` (메시지에 한도·리셋 안내 포함). `runPipelineForUser`가 `ETL_ALREADY_RUNNING`/`GITHUB_TOKEN_INVALID`로 거부하면 환불 후 rethrow. 그 외 에러(실행 도중 실패)는 환불하지 않는다 — 실행이 시작돼 자원을 썼기 때문.
  - `status` — 기존 응답에 추가: `manual_used_today`, `manual_limit`, `manual_remaining`, `manual_reset_at`(ISO 문자열)
- **근거 요구사항**: R1.1, R1.2, R1.4, R1.5(cron은 이 컨트롤러를 거치지 않으므로 자동 충족), R3.1

### `frontend/src/types.ts` + `api/mock.ts` (확장)
- `EtlStatus`에 `manual_used_today: number; manual_limit: number; manual_remaining: number; manual_reset_at: string` 추가. mock도 동일 형태 반환.

### `frontend/src/pages/QueriesPage.tsx` (확장)
- **책임**: 잔여 표시와 버튼 게이트.
- **동작**:
  - 로드 시 `getEtlStatus()`를 함께 호출해 헤더의 "전체 ETL 실행" 버튼 옆에 `오늘 N/10회` 배지 표시 (R2.1)
  - `manual_remaining === 0`이면 전체·행별 실행 버튼 모두 비활성 + title 툴팁 "KST 자정에 초기화됩니다" (R2.3)
  - 수집 성공/실패 후 status 재조회로 배지 갱신 (R2.2), 429 수신 시 토스트 + 재조회로 0 동기화 (R2.4)
- **근거 요구사항**: R2.1~R2.4

## 4. 데이터 모델

`users` 테이블에 컬럼 2개 추가:

```sql
manual_etl_date   DATE          -- 마지막 수동 수집의 KST 날짜
manual_etl_count  INT NOT NULL DEFAULT 0   -- 그 날짜의 사용 횟수
```

원자적 소비 (consumeManualEtl):

```sql
UPDATE users SET
  manual_etl_count = IF(manual_etl_date = :today, manual_etl_count + 1, 1),
  manual_etl_date  = :today
WHERE id = :userId
  AND (manual_etl_date IS NULL OR manual_etl_date <> :today OR manual_etl_count < :limit)
```

- 날짜가 오늘이 아니면 → 1로 시작하며 날짜 갱신 (리셋의 실체, R1.3)
- 오늘이고 한도 미만이면 → +1
- 오늘이고 한도 도달이면 → WHERE 불일치로 0행 갱신 → 429 (R1.2)

**마이그레이션**: 운영 DB의 users 테이블엔 이 컬럼이 없다. `db/init.js`는 `CREATE TABLE IF NOT EXISTS`라 기존 테이블을 건드리지 않으므로, `dropLegacySchema()`와 같은 자리에 멱등 마이그레이션 함수를 추가한다 — INFORMATION_SCHEMA에서 컬럼 존재를 확인하고 없을 때만 `ALTER TABLE users ADD COLUMN ...`. `db/schema.sql`·`db/schema.dbml`에도 동일 컬럼 반영.

## 5. 에러 처리

| 시나리오 | 처리 | 근거 |
|---|---|---|
| 한도 도달 상태의 수동 수집 | 429 `ETL_DAILY_LIMIT_EXCEEDED`, 메시지에 "하루 N회, KST 자정 초기화" 안내 | R1.2 |
| 소비 후 중복 실행 감지(409) | 환불(-1) 후 `ETL_ALREADY_RUNNING` 그대로 반환 | R1.4 |
| 소비 후 토큰 무효(409) | 환불(-1) 후 `GITHUB_TOKEN_INVALID` 그대로 반환 | R1.4 |
| 실행 도중 실패(수집 에러 등) | 환불하지 않음 — 실행은 시작됐고 자원을 소비함 | R1.1의 경계 |
| 환불 시점에 KST 날짜가 바뀜 | no-op (WHERE에 날짜 조건) — 어제 카운터를 오늘 것에서 깎지 않음 | R1.3 |
| 프론트 표시가 뒤처진 채 429 수신 | 토스트 안내 + status 재조회로 잔여 0 동기화 | R2.4 |

## 6. 테스트 전략

기존 node:test + DI 패턴 유지. DB·실서버 없이 실행.

- `test/kst.test.js` (신규) — `kstToday`/`kstNextMidnight`: UTC 15:00(=KST 자정) 전후 경계, 자정 직전/직후 날짜 전환 (R1.3)
- `test/etl-quota.test.js` (신규) — `createEtlController`에 가짜 pipeline/users/quota 주입:
  - 잔여 있음 → 소비 1회 + 실행 (R1.1)
  - 한도 도달(consume false) → 429 + pipeline 미호출 (R1.2)
  - pipeline이 `ETL_ALREADY_RUNNING`/`GITHUB_TOKEN_INVALID` throw → refund 호출됨 (R1.4)
  - pipeline이 일반 에러 throw → refund 미호출
  - status 응답에 manual_* 4필드 (R3.1, 날짜 바뀐 뒤 0 반환 R3.2)
- `consumeManualEtl` SQL은 단위 테스트 불가(실DB 필요) → 문장 자체의 조건 로직은 위 원자 UPDATE 한 개로 고정하고, 배포 후 시연 체크리스트(tasks.md)에서 실DB로 확인
- 프론트는 `npm run build`(tsc) 타입 검증 + 수동 시연: 10회 소진 → 배지 0/10 + 버튼 비활성 → 429 토스트 (성공 기준)

## 7. 결정 기록

- [ADR-0004: 일일 한도 카운터 — users 행 + 조건부 원자 UPDATE](../adr/0004-daily-quota-in-users-row.md)
