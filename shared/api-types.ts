// shared/api-types.ts — 백엔드 응답과 프론트가 함께 쓰는 API 계약 타입.
//
// 타입 전용 파일이다(런타임 코드 없음). 프론트는 `import type`으로, 백엔드는 JSDoc
// `import('../../../shared/api-types.js')`로 참조한다. 백엔드 응답 형태를 바꾸면 여기부터 고친다.
// 백엔드 `npm run typecheck`와 프론트 `npm run typecheck`가 같은 정의로 양쪽을 검사한다.

/** rising-score-v3 기준선 종류. snapshot=실측(20~36h 구간), creation=생성 시각·0스타, partial=6h 이상 부분 구간 */
export type BaselineSource = 'snapshot' | 'creation' | 'partial';

/** GET /api/rising 항목 (신생 급상승, rising-score-v3) */
export interface RisingRepo {
  id: number;
  full_name: string;
  language: string | null;
  stars: number;
  /** 직전 수집 대비 증가 (repos.star_delta) */
  star_delta: number;
  /** ISO 8601 */
  github_created_at: string | null;
  /** 생성 후 하루 평균 스타 (stars / max(경과일, 1)) */
  velocity: number;
  /** 기준선~현재 실측 구간(span_hours)의 실제 증가량 */
  star_delta_24h: number;
  /** 기준선 스타가 0(creation 기준선)이면 null */
  growth_rate_24h: number | null;
  /** 하루 환산 증가 = star_delta_24h × 24 / max(span_hours, 12). 화면 표시·노출 판정 기준 */
  rate_24h: number;
  baseline_source: BaselineSource;
  /** 기준선~현재 실측 구간(시간) */
  span_hours: number;
  /** 이전 하루 대비 가속도 (0.5~2). 이전 기준선이 없으면 null */
  accel: number | null;
  /** 생성 후 경과일(최신 스냅샷 기준) */
  age_days: number;
  score: number;
  /** 1부터 */
  rank: number;
  github_id?: number;
  owner?: string | null;
  name?: string | null;
  html_url?: string | null;
  description?: string | null;
  /** 최신 스냅샷 시각 (ISO 8601) */
  captured_at?: string | null;
}
