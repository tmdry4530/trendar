// @ts-check

/**
 * @typedef {{ id?: number | string, stars: number | string, captured_at: string | Date }} Snapshot
 * @typedef {{ windowDays: number, freshHours: number, minRate: number, minGrowth: number, absPass: number, limit: number }} RisingConfig
 * @typedef {import('../../../shared/api-types.js').BaselineSource} BaselineSource
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_RISING_CONFIG = Object.freeze({
  windowDays: 15,
  freshHours: 13,
  minRate: 100,
  minGrowth: 0.10,
  absPass: 500,
  limit: 50,
});

export function normalizeLimit(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.length > 0 && !/\D/.test(value))) return 8;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : 8;
}

function time(snapshot) {
  return new Date(snapshot.captured_at).getTime();
}

function closestBaseline(snapshots, current) {
  const currentTime = time(current);
  const target = currentTime - 24 * HOUR_MS;
  let best = null;
  let distance = Infinity;
  for (const snapshot of snapshots) {
    const captured = time(snapshot);
    if (captured < currentTime - 36 * HOUR_MS || captured > currentTime - 20 * HOUR_MS) continue;
    const nextDistance = Math.abs(captured - target);
    if (nextDistance < distance || (nextDistance === distance && Number(snapshot.id) > Number(best?.id))) {
      best = snapshot;
      distance = nextDistance;
    }
  }
  return best;
}

/**
 * @param {Snapshot[]} snapshots
 * @param {{ createdAt?: string | Date | null, earliest?: Snapshot | null }} [opts]
 * @returns {{ cur: Snapshot, base: Snapshot, source: BaselineSource, prev: Snapshot | null } | null}
 */
export function selectBaseline(snapshots, { createdAt, earliest } = {}) {
  if (!snapshots.length) return null;
  let cur = snapshots[0];
  let first = snapshots[0];
  for (const snapshot of snapshots) {
    if (time(snapshot) > time(cur) || (time(snapshot) === time(cur) && Number(snapshot.id) > Number(cur.id))) cur = snapshot;
    if (time(snapshot) < time(first) || (time(snapshot) === time(first) && Number(snapshot.id) < Number(first.id))) first = snapshot;
  }
  const base = closestBaseline(snapshots, cur);
  if (base) return { cur, base, source: 'snapshot', prev: closestBaseline(snapshots, base) };
  // createdAt이 없으면(Invalid Date와 같은 의미) creation 기준선을 쓰지 않는다.
  if (createdAt && time(cur) - new Date(createdAt).getTime() <= 36 * HOUR_MS) {
    return { cur, base: { stars: 0, captured_at: createdAt }, source: 'creation', prev: null };
  }
  const partial = earliest ?? first;
  if (time(partial) <= time(cur) - 6 * HOUR_MS) {
    return { cur, base: partial, source: 'partial', prev: null };
  }
  return null;
}

export function measureCandidate(candidate, cfg = DEFAULT_RISING_CONFIG, now = new Date()) {
  const config = { ...DEFAULT_RISING_CONFIG, ...cfg };
  const baseline = selectBaseline(candidate.snapshots, {
    createdAt: candidate.github_created_at,
    earliest: candidate.earliest,
  });
  if (!baseline) return null;
  const { cur, base, source, prev } = baseline;
  if (time(cur) < new Date(now).getTime() - config.freshHours * HOUR_MS) return null;
  const delta = Number(cur.stars) - Number(base.stars);
  const span = (time(cur) - time(base)) / HOUR_MS;
  const rate = delta * 24 / Math.max(span, 12);
  let accel = null;
  if (prev) {
    const previousSpan = (time(base) - time(prev)) / HOUR_MS;
    const previousRate = (Number(base.stars) - Number(prev.stars)) * 24 / Math.max(previousSpan, 12);
    accel = Math.min(2, Math.max(0.5, rate / Math.max(previousRate, 1)));
  }
  return {
    stars: Number(cur.stars),
    star_delta_24h: delta,
    growth_rate_24h: Number(base.stars) === 0 ? null : delta / Number(base.stars),
    rate_24h: rate,
    baseline_source: source,
    span_hours: span,
    accel,
    age_days: (time(cur) - new Date(candidate.github_created_at).getTime()) / DAY_MS,
    captured_at: cur.captured_at,
  };
}

export function scoreCandidate(candidate, cfg = DEFAULT_RISING_CONFIG, now = new Date()) {
  const config = { ...DEFAULT_RISING_CONFIG, ...cfg };
  if (new Date(candidate.github_created_at).getTime() < new Date(now).getTime() - config.windowDays * DAY_MS) return null;
  const measure = measureCandidate(candidate, config, now);
  if (!measure || measure.rate_24h < config.minRate) return null;
  // growth_rate_24h가 null(creation 기준선)이면 증가율 조건은 불통과 — creation 분기가 따로 통과시킨다.
  if (!((measure.growth_rate_24h ?? -Infinity) >= config.minGrowth || measure.rate_24h >= config.absPass || measure.baseline_source === 'creation')) return null;
  const { id, github_id, full_name, owner, name, html_url, description, language, github_created_at } = candidate;
  return {
    id, github_id, full_name, owner, name, html_url, description, language, github_created_at,
    ...measure,
    score: measure.rate_24h / Math.sqrt(measure.age_days + 1) * Math.sqrt(measure.accel ?? 1),
  };
}

export function rankRising(candidates, cfg = {}, now = new Date()) {
  const config = { ...DEFAULT_RISING_CONFIG, ...cfg };
  const rows = [];
  for (const candidate of candidates) {
    const row = scoreCandidate(candidate, config, now);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => b.score - a.score || b.rate_24h - a.rate_24h || Number(a.id) - Number(b.id));
  return rows.slice(0, normalizeLimit(config.limit)).map((row, index) => ({ ...row, rank: index + 1 }));
}
