# frontend/ — AgentRadar Frontend

AgentRadar 대시보드의 **React + Vite + TypeScript** 단일 페이지 앱(SPA). Express REST API(`http://localhost:4000/api`)를 소비한다. 설계 지침은 `../CLAUDE.md`, API 계약은 `../docs/API.md`.

## 실행

```bash
npm install
npm run dev        # http://localhost:5173 (/api 는 4000으로 프록시)
```

스크립트:
- `npm run dev` — Vite 개발 서버
- `npm run build` — 타입체크(`tsc --noEmit`) 후 프로덕션 번들
- `npm run typecheck` — 타입체크만
- `npm run preview` — 빌드 결과 미리보기

## 목 데이터 모드 (백엔드 없이 데모)

백엔드가 아직 준비되지 않았을 때, 인메모리 목 백엔드로 UI 전체를 단독 구동할 수 있다. **기본값은 실제 API 호출**이며, 목은 토글로만 켜진다:

```bash
echo "VITE_USE_MOCK=true" > .env.local   # 끌 때는 이 파일 삭제
npm run dev
```

목 모드에서는 조건/레포 CRUD, 북마크, 메모, ETL 실행(스타 증가 + 스냅샷 적재 시뮬레이션)이 상태를 유지한 채 실제처럼 동작한다. 상단 네비 우측 배지가 `live`/`mock` 으로 현재 모드를 표시한다.

## 화면 (4)

| 경로 | 화면 | API |
|------|------|-----|
| `/` | **Dashboard** — 통계 카드 4, 급상승 Top Movers, 언어 분포 | `GET /stats`, `/trends`, `/stats/languages` |
| `/queries` | **Queries** — 조건 CRUD + 활성토글 + 조건별/전체 ETL | `GET/POST/PATCH/DELETE /queries`, `POST /etl/run` |
| `/repos` | **Repos** — 검색(디바운스)·정렬·필터·북마크·페이지네이션·삭제 | `GET /repos`, `PATCH/DELETE /repos/:id` |
| `/repos/:id` | **Repo Detail** — 정보 + 스타 추이 차트 + 메모 + 북마크/삭제 | `GET /repos/:id`, `PATCH/DELETE` |

## 구조

```
src/
├── main.tsx · App.tsx          # 라우터 + 레이아웃(상단 네비)
├── api/
│   ├── client.ts               # fetch 래퍼: { ok, data } 언랩, 에러 throw, USE_MOCK 분기
│   ├── queries.ts repos.ts stats.ts
│   └── mock.ts                 # 인메모리 목 백엔드 (토글 시)
├── types.ts                    # API.md 기반 타입 (진실의 원천)
├── lib/
│   ├── useAsync.ts             # 로딩/에러/데이터 3상태 패칭 훅
│   └── format.ts               # 숫자(1.2k)/퍼센트/시간 포맷
├── components/
│   ├── TopNav · Toast · States · ConfirmDialog   # 공용
│   ├── StatCard · TrendTable · LanguageBars       # Dashboard
│   ├── QueryForm · RepoRow · StarChart            # 화면별
├── pages/                      # DashboardPage · QueriesPage · ReposPage · RepoDetailPage
└── styles/
    ├── tokens.css              # 디자인 토큰 (다크 / 포스포 그린 / IBM Plex Mono)
    └── global.css              # 리셋 + 재사용 클래스 키트
```

## 설계 방향

다크 "레이더 관제소" 무드. IBM Plex Mono(헤더/숫자/지표) + IBM Plex Sans(본문), 단일 강조색 포스포 그린(`#3ddc84`), 등폭 숫자(tabular-nums), 높은 정보 밀도와 테이블 1급. 모든 비동기 호출은 로딩/에러/빈 상태 3가지를 처리하며, 백엔드 미기동 시에도 크래시 없이 에러 토스트/상태로 안내한다.
