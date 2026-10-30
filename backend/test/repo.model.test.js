import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleRisingCandidates,
  buildRisingCandidatesQuery,
  buildRisingEarliestQuery,
  buildRisingSnapshotsQuery,
  buildTrendsQuery,
  rankUserRising,
} from '../src/models/repo.model.js';

const HOUR = 3_600_000;
const NOW = new Date('2026-10-30T00:00:00Z');
const at = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
const CONFIG = { windowDays: 15, freshHours: 13, minRate: 100, minGrowth: 0.10, absPass: 500, limit: 8 };

function candidate(id, { ageDays, series, star_delta = 0 }) {
  // series: [[hoursAgo, stars], ...]
  const snapshots = series.map(([h, stars], i) => ({ id: id * 100 + i, stars, captured_at: at(h) }));
  return {
    id,
    github_id: 9000 + id,
    full_name: `o/r${id}`,
    owner: 'o',
    name: `r${id}`,
    html_url: `https://github.com/o/r${id}`,
    description: null,
    language: 'Python',
    stars: snapshots.at(-1).stars,
    star_delta,
    github_created_at: new Date(NOW.getTime() - ageDays * 24 * HOUR),
    snapshots,
    earliest: snapshots[0],
  };
}

test('신생 급상승 후보 쿼리 — 사용자 격리 + 생성 windowDays일 이내', () => {
  const { sql, params } = buildRisingCandidatesQuery(42, 15);
  const compactSql = sql.replace(/\s+/g, ' ').trim();
  assert.match(compactSql, /FROM repos WHERE user_id = \? AND github_created_at >= DATE_SUB\(NOW\(\), INTERVAL \? DAY\)/);
  assert.deepEqual(params, [42, 15]);
});

test('신생 급상승 스냅샷 쿼리 — 최근 recentDays일, 레포·시간 순 / 가장 이른 스냅샷', () => {
  const range = buildRisingSnapshotsQuery([3, 5], 4);
  assert.match(range.sql, /repo_id IN \(\?, \?\)/);
  assert.match(range.sql, /ORDER BY repo_id ASC, captured_at ASC, id ASC/);
  assert.deepEqual(range.params, [3, 5, 4]);
  const first = buildRisingEarliestQuery([3, 5]);
  assert.match(first.sql, /ORDER BY first\.captured_at ASC, first\.id ASC LIMIT 1/);
  assert.deepEqual(first.params, [3, 5]);
});

test('assembleRisingCandidates — 스냅샷·earliest를 레포별로 묶는다', () => {
  const out = assembleRisingCandidates(
    [{ id: 1 }, { id: 2 }],
    [{ repo_id: 1, id: 10, stars: 5, captured_at: 'a' }, { repo_id: 1, id: 11, stars: 9, captured_at: 'b' }],
    [{ repo_id: 1, id: 10, stars: 5, captured_at: 'a' }],
  );
  assert.equal(out[0].snapshots.length, 2);
  assert.deepEqual(out[0].earliest, { id: 10, stars: 5, captured_at: 'a' });
  assert.deepEqual(out[1].snapshots, []);
  assert.equal(out[1].earliest, null);
});

test('rankUserRising — 구형 500 하드컷에 떨어지던 고성장 소형 레포도 노출한다', () => {
  const rows = rankUserRising([
    // +195/24h, 증가율 33% — 구형 규칙(≥500)에서는 제외되던 케이스
    candidate(1, { ageDays: 5.7, series: [[48, 300], [24, 583], [0, 778]], star_delta: 44 }),
    // +1,637/24h — 큰 레포
    candidate(2, { ageDays: 12.7, series: [[48, 41814], [24, 43827], [0, 45464]] }),
    // +40/24h — rate_24h < 100 이라 제외
    candidate(3, { ageDays: 3, series: [[24, 200], [0, 240]] }),
  ], CONFIG, NOW);

  assert.deepEqual(rows.map((r) => r.id).sort(), [1, 2]);
  const small = rows.find((r) => r.id === 1);
  assert.equal(small.star_delta_24h, 195);
  assert.equal(small.baseline_source, 'snapshot');
  assert.equal(small.star_delta, 44, '기존 star_delta(직전 수집 대비) 필드 유지');
  assert.equal(typeof small.velocity, 'number');
  assert.equal(small.github_created_at, new Date(NOW.getTime() - 5.7 * 24 * HOUR).toISOString());
  for (const key of ['rate_24h', 'growth_rate_24h', 'accel', 'score', 'rank', 'age_days']) {
    assert.ok(key in small, `${key} 필드 존재`);
  }
  assert.deepEqual(rows.map((r) => r.rank), [1, 2]);
});

test('rankUserRising — 최신 스냅샷이 13시간보다 오래된(수집에서 빠진) 레포는 제외한다', () => {
  const rows = rankUserRising([
    candidate(1, { ageDays: 5, series: [[44, 100], [20, 2000]] }),
  ], CONFIG, NOW);
  assert.deepEqual(rows, []);
});

test('rankUserRising — 24h 기준선이 없어도 부분 구간(6h 이상)으로 추정해 평가한다', () => {
  const rows = rankUserRising([
    candidate(1, { ageDays: 9, series: [[12, 1000], [6, 1150], [0, 1300]] }),
  ], CONFIG, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].baseline_source, 'partial');
  assert.equal(rows[0].star_delta_24h, 300);
  assert.equal(Math.round(rows[0].rate_24h), 600);
});

test('빠르게 성장 중 쿼리 — 1,000스타 이상만 증가율로 정렬한다', () => {
  const { sql, params } = buildTrendsQuery(42, 10);
  assert.match(sql, /stars >= 1000 AND star_delta > 0 ORDER BY growth_rate DESC/);
  assert.deepEqual(params, [42, 10]);
});
