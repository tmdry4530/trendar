export function normalizeRepo(raw, queryId, userId) {
  return {
    github_id: raw.id,
    query_id: queryId,
    user_id: userId,
    full_name: raw.full_name,
    owner: raw.owner?.login ?? raw.full_name.split('/')[0],
    name: raw.name,
    html_url: raw.html_url,
    description: raw.description ?? null,
    language: raw.language ?? null,
    node_id: raw.node_id ?? null, // GraphQL nodes(ids:) 배치 갱신용 전역 ID
    stars: raw.stargazers_count ?? 0,
    forks: raw.forks_count ?? 0,
    open_issues: raw.open_issues_count ?? 0,
    watchers: raw.watchers_count ?? 0,
    // ISO 문자열('...Z')을 그대로 DATETIME에 넣으면 strict 모드에서 거부될 수 있어 Date로 변환
    github_created_at: raw.created_at ? new Date(raw.created_at) : null,
  };
}

export function computeDelta(current, prevSnapshot) {
  const prev = prevSnapshot?.stars ?? current.stars;
  const star_delta = current.stars - prev;
  return { star_delta, growth_rate: star_delta / Math.max(prev, 1) };
}

export const HOUR_SEC = 3600;
export const WINDOW_24H = 24;
export const WINDOW_7D = 24 * 7;

// 시간 정규화 윈도우 델타 (랭킹 v3).
// - baseline: now-window 시점 이전의 가장 최근 스냅샷 {stars, age_sec} → 그대로 차이
// - 없으면 oldest(현재 스냅샷 제외 가장 오래된 스냅샷)로 window/경과시간 비율만큼 선형 환산 (경과 하한 1시간)
// - 현재 스냅샷뿐이면 0
export function windowDelta(currentStars, baseline, oldest, windowHours) {
  if (baseline) return currentStars - Number(baseline.stars ?? 0);
  if (!oldest) return 0;
  const elapsedHours = Math.max(Number(oldest.age_sec ?? 0) / HOUR_SEC, 1);
  const raw = currentStars - Number(oldest.stars ?? 0);
  const scaled = Math.round(raw * (windowHours / elapsedHours));
  return scaled === 0 ? 0 : scaled; // -0 방지
}

// 점수 = delta_24h / sqrt(max(stars - delta_24h, 10)) — 순수 비율의 소형 레포 편향을 완화한다.
export function rankingScore(stars, delta24h) {
  return delta24h / Math.sqrt(Math.max(stars - delta24h, 10));
}

// 스냅샷 삽입 후 호출 — 24h/7d 델타, 점수, (하위호환) growth_rate를 계산한다.
export function computeRankingDelta(currentStars, { base24h = null, base7d = null, oldest = null } = {}) {
  const delta_24h = windowDelta(currentStars, base24h, oldest, WINDOW_24H);
  const delta_7d = windowDelta(currentStars, base7d, oldest, WINDOW_7D);
  const stars24hAgo = currentStars - delta_24h;
  return {
    delta_24h,
    delta_7d,
    growth_rate: delta_24h / Math.max(stars24hAgo, 1),
    score: rankingScore(currentStars, delta_24h),
  };
}
