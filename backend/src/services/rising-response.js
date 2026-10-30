// @ts-check
// 대시보드 /api/rising 응답 매핑. 반환 타입을 shared/api-types.ts의 RisingRepo로 고정해서,
// 백엔드 응답 형태와 프론트 타입이 어긋나면 `npm run typecheck`에서 바로 잡히게 한다.
import { rankRising } from './rising-score.js';

/** @typedef {import('../../../shared/api-types.js').RisingRepo} RisingRepo */

const DAY_MS = 86_400_000;

/**
 * 기존 필드(star_delta_24h·growth_rate_24h·velocity 등)는 유지하고
 * v3 지표(rate_24h·baseline_source·span_hours·accel·score·rank·age_days)를 덧붙인다.
 * @param {any[]} candidates risingCandidates() 결과 (repos 행 + snapshots + earliest)
 * @param {Partial<import('./rising-score.js').RisingConfig>} config
 * @param {Date} [now]
 * @returns {RisingRepo[]}
 */
export function rankUserRising(candidates, config, now = new Date()) {
  const starDeltaById = new Map(candidates.map((c) => [c.id, Number(c.star_delta ?? 0)]));
  return rankRising(candidates, config, now).map((row) => {
    const createdAt = row.github_created_at ? new Date(row.github_created_at) : null;
    const ageDaysNow = createdAt ? (new Date(now).getTime() - createdAt.getTime()) / DAY_MS : null;
    return {
      id: row.id,
      github_id: row.github_id,
      full_name: row.full_name,
      owner: row.owner,
      name: row.name,
      html_url: row.html_url,
      description: row.description,
      language: row.language,
      stars: row.stars,
      star_delta: starDeltaById.get(row.id) ?? 0,
      github_created_at: createdAt ? createdAt.toISOString() : null,
      velocity: ageDaysNow == null ? 0 : row.stars / Math.max(ageDaysNow, 1),
      star_delta_24h: row.star_delta_24h,
      growth_rate_24h: row.growth_rate_24h,
      rate_24h: row.rate_24h,
      baseline_source: row.baseline_source,
      span_hours: row.span_hours,
      accel: row.accel,
      age_days: row.age_days,
      score: row.score,
      rank: row.rank,
      captured_at: row.captured_at ? new Date(row.captured_at).toISOString() : null,
    };
  });
}
