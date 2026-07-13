# ADR-0002: 인증 수단 — GitHub OAuth App (GitHub App 아님)

- **날짜**: 2026-07-13
- **상태**: 승인됨
- **관련 기능**: multi-tenant-auth

## 맥락

사용자별 GitHub 토큰으로 6시간 주기 cron ETL을 실행해야 한다. GitHub은 OAuth App과 GitHub App(user-to-server) 두 가지 방식을 제공하며 토큰 수명 모델이 다르다.

## 검토한 대안

1. **OAuth App** — access token이 만료되지 않음(사용자 revoke 또는 1년 미사용 시에만 무효). 장점: 리프레시 로직 없이 cron이 저장된 토큰을 그대로 사용, 구현 단순. 스코프 없이 발급하면 공개 데이터 접근만 가능. 단점: 토큰 탈취 시 장기 유효.
2. **GitHub App (user-to-server token)** — access token 8시간 만료 + refresh token(6개월). 장점: 탈취 시 피해 창이 짧음. 단점: cron마다 사용자별 refresh 플로우, refresh token 회전 실패 처리 등 복잡도가 크게 상승. 6시간 주기 배치와 궁합이 나쁨.

## 결정

**OAuth App**을 선택했다. 요청 스코프를 비움(공개 레포 검색 + 공개 프로필만 가능한 최소 권한)으로써 토큰 탈취 시에도 피해가 공개 데이터 조회에 한정되고, 장기 유효 토큰의 리스크는 DB 암호화 저장(AES-256-GCM)으로 보완한다.

## 결과

- ETL은 저장된 토큰을 복호화해 바로 사용하며 리프레시 로직이 없다.
- 토큰이 revoke되면 GitHub API가 401을 반환하는 시점에 감지해 `token_invalid` 처리하고 재로그인을 유도한다.
- 추후 비공개 레포 접근 등 민감 스코프가 필요해지면 GitHub App 전환을 재검토한다.
