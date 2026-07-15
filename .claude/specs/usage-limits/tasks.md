---
feature: usage-limits
status: approved
created: 2026-07-15
---

# 사용량 한도 (수동 수집 일일 한도) — 태스크

> 체크박스가 실행 상태의 단일 진실 공급원이다. 태스크 완료 = 완료 조건 + 연결된 인수 조건 충족 + 관련 테스트 통과.

- [x] **T1. KST 날짜 유틸 + 한도 상수 + 테스트**
  - 내용: `utils/kst.js` 신규 (`kstToday`/`kstNextMidnight`, `now` 주입 가능), `utils/limits.js`에 `maxManualEtlPerDay()` 추가, `test/kst.test.js` (UTC 15:00 = KST 자정 경계 케이스 포함)
  - 요구사항: R1.3, R1.6
  - 완료 조건: `npm test` 통과 (기존 32개 + 신규), 자정 직전/직후 날짜 전환 테스트 존재

- [x] **T2. DB 컬럼 + 멱등 마이그레이션 + 모델 함수**
  - 내용: `users`에 `manual_etl_date DATE`, `manual_etl_count INT NOT NULL DEFAULT 0` — `db/schema.sql`·`db/schema.dbml`·`db/init.js`(CREATE) 3곳 동기화 + init.js에 컬럼 부재 시 `ALTER TABLE` 멱등 마이그레이션. `user.model.js`에 `consumeManualEtl`(조건부 원자 UPDATE)/`refundManualEtl`/`getManualEtlUsage`
  - 요구사항: R1.1, R1.4, R1.7, R3.2
  - 완료 조건: `node -c` 전 파일 통과, 마이그레이션이 컬럼 있을 때 no-op임을 코드로 확인, SQL이 design §4 문장과 일치

- [x] **T3. etl.controller DI 팩토리화 + 429/환불 + status 확장 + 테스트**
  - 내용: `createEtlController({ pipeline, users, quota })` 전환. `run`: 소비 실패 → 429 `ETL_DAILY_LIMIT_EXCEEDED`(한도·리셋 안내 메시지), pipeline의 `ETL_ALREADY_RUNNING`/`GITHUB_TOKEN_INVALID` → 환불 후 rethrow, 그 외 에러는 환불 없음. `status`: `manual_used_today/limit/remaining/reset_at` 추가. `test/etl-quota.test.js` (design §6의 5개 시나리오)
  - 요구사항: R1.1, R1.2, R1.4, R1.5, R3.1, R3.2
  - 완료 조건: 신규 테스트 전부 통과 + 기존 테스트 무회귀

- [x] **T4. 프론트 — 잔여 배지 + 버튼 비활성 + mock**
  - 내용: `types.ts` EtlStatus 4필드 확장, `QueriesPage`에 status 로드 → 헤더에 "오늘 N/10회" 배지, `manual_remaining === 0`이면 전체·행별 실행 버튼 비활성 + "KST 자정에 초기화됩니다" 툴팁, 수집 후·429 후 status 재조회. `mock.ts` etlStatus 동일 형태 반영
  - 요구사항: R2.1, R2.2, R2.3, R2.4
  - 완료 조건: `npm run build`(tsc + vite) 통과, VITE_USE_MOCK=true에서 배지 렌더 확인

- [x] **T5. 배포 + 실서비스 검증**
  - 내용: 커밋·푸시 → Railway 자동 배포 → 부팅 로그에서 마이그레이션 정상 확인 → 라이브 검증
  - 요구사항: R1.7, 성공 기준 전체
  - 완료 조건: `GET /api/etl/status`에 manual_* 필드 응답, 수동 수집 1회 후 used 증가 확인

- [ ] **T6. (수동 E2E — 사용자 확인) 한도 소진 시나리오**
  - 내용: 라이브에서 수집 10회 소진 → 배지 0/10 + 버튼 비활성 + 11번째 429 토스트 확인, 다음날 자동 리셋 확인
  - 요구사항: 성공 기준
  - 완료 조건: 사용자 확인 코멘트
