---
feature: trend-discovery
status: approved
created: 2026-07-19
---

# 신생 트렌드 수집 (trend-discovery) — 태스크

> 체크박스가 실행 상태의 단일 진실 공급원이다. 태스크 완료 = 완료 조건 + 연결된 인수 조건 충족 + 관련 테스트 통과.

- [x] **T1. 설정 + extract 옵션 주입형 개편 + 테스트**
  - 내용: `utils/limits.js`에 `trendWindowDays()`(기본 90)/`trendMinStars()`(기본 50) 추가. `extract.js`를 `extractRepos(wq, octokit, { minStars, createdAfter })`로 개편 — `created:>` 한정자, 슬라이스별 `stars:>=` 조립. `test/extract.test.js` 신규(질의 조립 케이스) + `kst.test.js`(limits 케이스 위치)에 trend 설정 테스트 추가
  - 요구사항: R1.1, R1.2, R1.3, R5.1~R5.3
  - 완료 조건: `npm test` 통과 (기존 52 + 신규), topic/keyword × createdAfter 유무 × minStars 조합 질의 문자열 검증

- [x] **T2. DB — repos.github_created_at 컬럼 + 마이그레이션 + 정규화·적재**
  - 내용: `db/schema.sql`·`db/schema.dbml`에 컬럼·인덱스(`idx_user_created`) 추가, `db/init.js`에 repos 멱등 ALTER 마이그레이션, `transform.js` `normalizeRepo`에 `github_created_at`, `load.js` `upsertRepo` 컬럼 반영
  - 요구사항: R2.1, R2.3
  - 완료 조건: `node -c` 전 파일 통과, 3곳(schema.sql/dbml/init.js) 컬럼 정의 일치, 기존 테스트 무회귀

- [x] **T3. pipeline — 슬라이스 루프 + 실행 단위 dedup + 테스트**
  - 내용: `runPipelineForUser`에 `seen Set` 도입, 조건 루프 안을 base/trend 슬라이스 루프로 개편(슬라이스별 minStars 가드), 슬라이스 실패 격리(errors[]), 401 특별 취급 유지. `pipeline.test.js` 확장 — design §6의 4개 시나리오(dedup 스냅샷 1회 / 첫 조건 귀속 / trend 슬라이스 실패 격리 / 슬라이스별 하한)
  - 요구사항: R1.1, R1.3, R1.4, R3.1, R3.2
  - 완료 조건: 신규 테스트 전부 통과 + 기존 테스트 무회귀

- [x] **T4. rising API — 모델·컨트롤러·라우트**
  - 내용: `repo.model.js`에 `risingRepos(userId, windowDays, limit)`(velocity SQL 계산), `repo.controller.js`에 `rising`, `stats.routes.js`에 `GET /rising` 등록(requireAuth 뒤)
  - 요구사항: R2.2, R4.1, R4.4, R5.1
  - 완료 조건: `node -c` 통과, SQL이 design §3 문장과 일치(GREATEST 0-나눗셈 방지 포함), limit·windowDays 파라미터화 확인

- [ ] **T5. 프론트 — '신생 급상승' 패널 + mock**
  - 내용: `types.ts` `RisingRepo`, `api/stats.ts` `getRising`, `api/mock.ts` `/rising` 핸들러(신생 샘플 데이터), `DashboardPage.tsx` Top Movers 아래 '신생 급상승' 패널(레포명·언어·스타·나이 배지, 빈 상태 처리)
  - 요구사항: R4.1, R4.2, R4.3
  - 완료 조건: `npm run build`(tsc+vite) 통과, VITE_USE_MOCK=true 헤드리스 스크린샷으로 패널 렌더·빈 상태 확인

- [ ] **T6. 배포 + 실서비스 검증**
  - 내용: 커밋·푸시 → Railway 자동 배포 → 부팅 로그 마이그레이션 확인 → 수동 수집 1회 실행 후 `/api/rising` 응답에 신생 레포 포함 확인
  - 요구사항: R2.3, 성공 기준 전체
  - 완료 조건: 배포 SUCCESS, rising 응답에 `github_created_at`·`velocity` 필드, 대시보드에 섹션 표시

- [ ] **T7. (수동 E2E — 사용자 확인) 신생 레포 발견 시나리오**
  - 내용: 라이브에서 본인 키워드로 수집 실행 → '신생 급상승'에 최근 생성 레포가 속도 순으로 뜨는지, 기존 Top Movers·언어 분포 무회귀 확인
  - 요구사항: 성공 기준
  - 완료 조건: 사용자 확인 코멘트
