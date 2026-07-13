---
feature: multi-tenant-auth
status: approved
created: 2026-07-13
---

# 멀티테넌트 전환 + GitHub OAuth 인증 — 태스크

> 체크박스가 실행 상태의 단일 진실 공급원이다. 태스크 완료 = 완료 조건 + 연결된 인수 조건 충족 + 관련 테스트 통과.
> 실행 환경 제약: 로컬에 MySQL/Docker 없음 → DB 결합 검증은 스텁 주입 단위 테스트로, 실 DB·실 OAuth 검증은 배포 후 수동 E2E 체크리스트로 수행.

- [x] **T1. 백엔드 테스트 인프라 + 암호화 유틸**
  - 내용: `backend/package.json`에 `"test": "node --test test/"` 추가. `backend/src/utils/crypto.js` 신규 — `encryptToken`/`decryptToken`(AES-256-GCM, env `TOKEN_ENCRYPTION_KEY` 64자 hex), `newSessionToken`/`hashSessionToken`(SHA-256). `backend/test/crypto.test.js` — 라운드트립, 변조 거부, 키 미설정 throw.
  - 요구사항: R3.1
  - 완료 조건: `cd backend && npm test` 통과

- [x] **T2. DB 스키마 v2 + 레거시 리셋**
  - 내용: `db/schema.sql`과 `backend/src/db/init.js`를 v2로 갱신(두 파일 동기) — `users`·`sessions` 신설, `watch_queries`·`repos`에 `user_id` FK(CASCADE) 추가, `UNIQUE(github_id)` → `UNIQUE(user_id, github_id)`, `UNIQUE(query, query_type)` → `UNIQUE(user_id, query, query_type)`. init.js에 레거시 감지(`users` 없음 && `repos` 존재) → 레거시 테이블 DROP. 시드 쿼리 삽입 제거.
  - 요구사항: R6.1, R5.1(CASCADE 경로), R2(스키마 기반)
  - 완료 조건: 두 파일의 DDL이 design §3과 일치, 기존 `npm test` 회귀 없음

- [x] **T3. user·session 모델 + requireAuth 미들웨어**
  - 내용: `backend/src/models/user.model.js`(upsertFromGithub, findById, setTokenInvalid, updateEtlResult, deleteById 등)·`session.model.js`(create, findValidByHash, deleteByHash, deleteExpired) 신규. `backend/src/middleware/requireAuth.js` — `sid` 쿠키 → 해시 → 세션·사용자 조회 → `req.user` 부착, 실패·만료 시 401(만료 행 삭제). `backend/test/requireAuth.test.js`(모델 스텁 주입).
  - 요구사항: R2.1, R1.5
  - 완료 조건: `npm test` 통과 (쿠키 없음/무효/만료 → 401, 유효 → `req.user`)

- [x] **T4. GitHub OAuth 라우트 + 계정 수명주기**
  - 내용: `backend/src/services/github-oauth.js`(내장 fetch로 authorize URL 생성·code 교환·`GET /user` 프로필 조회), `routes/auth.routes.js` + `controllers/auth.controller.js` — `GET /api/auth/github`(state 쿠키+리다이렉트, scope 빈 값), `GET /api/auth/github/callback`(state 검증→토큰 교환→upsert+토큰 암호화 저장+`token_invalid` 해제→세션 발급→`/`), 실패 시 `/login?error=<코드>`, `POST /api/auth/logout`, `GET /api/auth/me`, `DELETE /api/auth/account`. `app.js`에 cookie-parser(신규 의존성)·auth 라우트 마운트, 데이터 라우트에 requireAuth 적용. 프로덕션 필수 env(`GITHUB_CLIENT_ID/SECRET`, `TOKEN_ENCRYPTION_KEY`, `APP_URL`) 부팅 fail-fast.
  - 요구사항: R1.1–R1.6, R3.1, R5.1, R5.2, R6.2
  - 완료 조건: `npm test` 통과(콜백 성공/실패·me·탈퇴 컨트롤러 단위 테스트, 스텁 주입), 기존 테스트 회귀 없음

- [ ] **T5. 기존 API 전면 user_id 스코프 + 쿼리 상한**
  - 내용: `query.model.js`·`repo.model.js`·`stats.model.js`(+ 대응 컨트롤러) 전 함수에 `userId` 스코프(`WHERE user_id = ?`), id 단건은 `AND user_id = ?` miss 시 404. `query.model.create`에 `MAX_QUERIES_PER_USER`(기본 10) 상한 → 초과 시 400 `QUERY_LIMIT_EXCEEDED`(수정·삭제는 허용). `backend/test/query-limit.test.js`.
  - 요구사항: R2.2–R2.5, R4.1, R4.2
  - 완료 조건: `npm test` 통과, 모든 SQL에 user_id 조건 포함(diff 리뷰로 전수 확인)

- [ ] **T6. ETL 사용자별 토큰 전환**
  - 내용: `etl/extract.js` 전역 Octokit 제거 → `extractRepos(query, octokit)` 주입. `etl/pipeline.js` — `runPipelineForUser(userId, {queryId})`(토큰 복호화→Octokit 생성→해당 사용자 쿼리 수집→`users.last_etl_*` 갱신, GitHub 401 시 `token_invalid=TRUE`·토큰 NULL), `runPipelineAllUsers()`(유효 토큰 사용자 순차 순회, 사용자 단위 try/catch), 인메모리 per-user 실행 락(중복 시 409), 전역 `etlState` 제거. `etl.controller.js` 본인 스코프로 수정, `server.js` cron을 `runPipelineAllUsers`로 교체, env `GITHUB_TOKEN` 의존 삭제. `backend/test/pipeline.test.js`(Octokit·모델 스텁 — 401 사용자 스킵 후 다음 사용자 계속).
  - 요구사항: R3.2–R3.6
  - 완료 조건: `npm test` 통과 (토큰 무효 격리 시나리오 포함)

- [ ] **T7. 프론트 인증 기반 (AuthContext·LoginPage·라우트 가드)**
  - 내용: `frontend/src/auth/AuthContext.tsx`(`GET /api/auth/me` 1회 → loading/authed/anon, logout·deleteAccount 제공), `pages/LoginPage.tsx`(`/login` — 서비스 소개 + `<a href="/api/auth/github">` 버튼, `?error=` 배너), `App.tsx` 라우트 가드(anon→`/login`, 로그인 상태의 `/login`→`/`, loading 스피너), `api/client.ts` 401 공통 처리 → `/login` 이동, mock 모드(`VITE_USE_MOCK`)에 가짜 me 추가.
  - 요구사항: R1.1, R1.2(리다이렉트 수신), R1.3, R1.5
  - 완료 조건: `cd frontend && npm run build` 통과, mock 모드로 가드·로그인 화면 수동 확인

- [ ] **T8. 프론트 사용자 메뉴 + 탈퇴 + 토큰 무효 배너**
  - 내용: `TopNav.tsx`에 아바타·login명·메뉴(로그아웃, 계정 삭제 — "모든 데이터가 영구 삭제됩니다" 확인 모달 후 `DELETE /api/auth/account`→`/login`). `tokenInvalid`면 전 화면 상단 재로그인 안내 배너(재로그인 링크 = `/api/auth/github`).
  - 요구사항: R1.7, R5.3, R3.4
  - 완료 조건: `npm run build` 통과, mock 모드 수동 확인

- [ ] **T9. env·문서·배포 설정 정리**
  - 내용: `backend/.env.example` 갱신(`GITHUB_CLIENT_ID/SECRET`, `TOKEN_ENCRYPTION_KEY`, `APP_URL`, `SESSION_TTL_DAYS`, `MAX_QUERIES_PER_USER` 추가, `GITHUB_TOKEN` 제거), README 갱신(OAuth App dev/prod 2개 등록 안내·콜백 URL·빠른 시작 반영), Dockerfile 영향 점검. 수동 E2E 체크리스트를 tasks.md 하단에 정리.
  - 요구사항: R6.2, R1.6(스코프 안내)
  - 완료 조건: 필수 env가 문서에 전부 명시, `npm test`·`npm run build` 최종 통과

## 수동 E2E 체크리스트 (배포 후, 실 GitHub 계정 필요)

- [ ] 비로그인 접근 → 로그인 페이지만 노출, 데이터 API 401 (R1.1, R2.1)
- [ ] GitHub 계정 A·B 각각 로그인 → 서로의 쿼리·레포·북마크 비노출 (성공 기준)
- [ ] 수동 ETL 실행 → 본인 데이터만 갱신, cron 로그에서 사용자별 토큰 사용 확인 (R3.2, R3.5)
- [ ] GitHub에서 앱 revoke → 다음 수집 스킵 + 배너 표시 → 재로그인으로 해제 (R3.3, R3.4)
- [ ] 쿼리 11개째 생성 시 상한 에러 (R4.1)
- [ ] 로그아웃·탈퇴 → 재로그인 시 빈 계정 (R1.4, R5.1, R5.2)
