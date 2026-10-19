import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RISING_CONFIG, normalizeLimit, selectBaseline, measureCandidate, scoreCandidate, rankRising } from '../src/services/rising-score.js';

const NOW = new Date('2026-10-19T12:00:00Z');
const HOUR = 3_600_000;
const ago = (hours) => new Date(NOW.getTime() - hours * HOUR);
const snapshot = (id, hours, stars) => ({ id, captured_at: ago(hours), stars });
function candidate(id, ageHours = 120, snapshots = [snapshot(1, 24, 100), snapshot(2, 0, 300)]) {
  return { id, github_id: id + 1000, full_name: `owner/repo${id}`, owner: 'owner', name: `repo${id}`, html_url: `https://github.com/owner/repo${id}`, description: null, language: 'JavaScript', stars: 999999, github_created_at: ago(ageHours), snapshots, earliest: snapshots[0] ?? null };
}

function scenarios() {
  return [
    { ...candidate(6, 168, [snapshot(1, 64, 1000), snapshot(2, 20, 2000)]), full_name: 'F/dropped-out' },
    { ...candidate(1, 120, [snapshot(1, 72, 1000), snapshot(2, 0, 1600)]), full_name: 'A/stale-gap' },
    { ...candidate(5, 96, [snapshot(1, 30, 1000), snapshot(2, 0, 1520)]), full_name: 'E/30h-span' },
    { ...candidate(2, 20, [snapshot(1, 0, 1500)]), full_name: 'B/cold-start' },
    { ...candidate(3, 168, [snapshot(1, 24, 100), snapshot(2, 0, 260)]), full_name: 'C/niche-fast' },
    { ...candidate(7, 96, [snapshot(1, 48, 1000), snapshot(2, 24, 1100), snapshot(3, 0, 1700)]), full_name: 'G/accelerating' },
    { ...candidate(4, 336, [snapshot(1, 24, 19400), snapshot(2, 0, 20000)]), full_name: 'D/big-young' },
  ];
}

test('proposal scenarios rank B, G, E, D, A, C and exclude dropped-out F', () => {
  const input = scenarios();
  const before = structuredClone(input);
  const rows = rankRising(input, {}, NOW);
  assert.deepEqual(rows.map((row) => row.full_name.split('/')[0]), ['B', 'G', 'E', 'D', 'A', 'C']);
  assert.deepEqual(rows.map((row) => row.rank), [1, 2, 3, 4, 5, 6]);
  assert.equal(rows[0].baseline_source, 'creation');
  assert.equal(rows[0].rate_24h, 1800);
  assert.notEqual(rows[0].score, rows[0].rate_24h);
  assert.equal(rows[1].accel, 2);
  assert.equal(rows[2].rate_24h, 416);
  assert.equal(rows[4].baseline_source, 'partial');
  assert.equal(rows[4].rate_24h, 200);
  assert.equal(rows[0].stars, 1500);
  assert.equal(rows[0].star_delta_24h, 1500);
  assert.equal('snapshots' in rows[0], false);
  assert.deepEqual(input, before);
});

test('latest snapshot time and id determine current, not repository stars or input order', () => {
  const snapshots = [snapshot(4, 0, 450), snapshot(2, 24, 100), snapshot(3, 0, 400)];
  const before = structuredClone(snapshots);
  const result = measureCandidate(candidate(1, 120, snapshots), {}, NOW);
  assert.equal(result.stars, 450);
  assert.equal(result.star_delta_24h, 350);
  assert.deepEqual(snapshots, before);
});

test('freshness includes exactly 13 hours, excludes anything older and rejects missing current', () => {
  assert.ok(measureCandidate(candidate(1, 120, [snapshot(1, 37, 100), snapshot(2, 13, 300)]), {}, NOW));
  assert.equal(measureCandidate(candidate(1, 120, [snapshot(1, 37, 100), snapshot(2, 13 + 1 / HOUR, 300)]), {}, NOW), null);
  assert.equal(measureCandidate(candidate(1, 120, []), {}, NOW), null);
});

test('snapshot window includes 20h and 36h boundaries and excludes just outside', () => {
  for (const hours of [20, 36]) {
    const base = snapshot(1, hours, 100);
    const result = selectBaseline([base, snapshot(2, 0, 300)], { createdAt: ago(120) });
    assert.equal(result.source, 'snapshot');
    assert.equal(result.base, base);
  }
  for (const hours of [20 - 1 / HOUR, 36 + 1 / HOUR]) {
    const result = selectBaseline([snapshot(1, hours, 100), snapshot(2, 0, 300)], { createdAt: ago(120) });
    assert.equal(result.source, 'partial');
  }
});

test('closest baseline to 24h wins; equal distance and time use larger id', () => {
  const selected = snapshot(9, 26, 100);
  assert.equal(selectBaseline([snapshot(1, 36, 50), selected, snapshot(8, 22, 150), snapshot(10, 0, 400)], { createdAt: ago(120) }).base, selected);
  const duplicate = snapshot(11, 24, 160);
  assert.equal(selectBaseline([snapshot(1, 24, 100), duplicate, snapshot(12, 0, 400)], { createdAt: ago(120) }).base, duplicate);
});

test('snapshot takes priority over creation; creation includes age 36h and has zero baseline', () => {
  assert.equal(selectBaseline([snapshot(1, 24, 100), snapshot(2, 0, 300)], { createdAt: ago(30) }).source, 'snapshot');
  const current = snapshot(1, 0, 300);
  const baseline = selectBaseline([current], { createdAt: ago(36) });
  assert.equal(baseline.source, 'creation');
  assert.deepEqual(baseline.base, { stars: 0, captured_at: ago(36) });
  assert.equal(measureCandidate(candidate(1, 36, [current]), {}, NOW).growth_rate_24h, null);
  assert.equal(selectBaseline([current], { createdAt: ago(36 + 1 / HOUR) }), null);
});

test('partial uses all-time earliest, includes 6h boundary and floors denominator at 12h', () => {
  const current = snapshot(3, 0, 300);
  const earliest = snapshot(1, 72, 100);
  assert.equal(selectBaseline([snapshot(2, 2, 250), current], { createdAt: ago(120), earliest }).base, earliest);
  const row = candidate(1, 120, [snapshot(1, 6, 100), current]);
  const result = measureCandidate(row, {}, NOW);
  assert.equal(result.baseline_source, 'partial');
  assert.equal(result.span_hours, 6);
  assert.equal(result.rate_24h, 400);
  assert.equal(result.accel, null);
  assert.equal(selectBaseline([snapshot(1, 6 - 1 / HOUR, 100), current], { createdAt: ago(120) }), null);
});

test('acceleration uses the same previous snapshot window and clamps to 0.5 and 2', () => {
  for (const [priorStars, baseStars, currentStars, accel] of [[0, 1000, 1100, 0.5], [1000, 1100, 1700, 2], [1000, 1000, 1600, 2]]) {
    const row = candidate(1, 120, [snapshot(1, 48, priorStars), snapshot(2, 24, baseStars), snapshot(3, 0, currentStars)]);
    assert.equal(measureCandidate(row, {}, NOW).accel, accel);
  }
  assert.equal(measureCandidate(candidate(1), {}, NOW).accel, null);
  const missingPrevious = candidate(1, 120, [snapshot(1, 61, 0), snapshot(2, 24, 100), snapshot(3, 0, 300)]);
  assert.equal(measureCandidate(missingPrevious, {}, NOW).accel, null);
});

test('exposure enforces rate floor, growth or absolute pass, creation and age window', () => {
  assert.equal(scoreCandidate(candidate(1, 120, [snapshot(1, 24, 1), snapshot(2, 0, 100)]), {}, NOW), null);
  assert.equal(scoreCandidate(candidate(1, 120, [snapshot(1, 24, 2400), snapshot(2, 0, 2520)]), {}, NOW), null);
  assert.ok(scoreCandidate(candidate(1, 24, [snapshot(1, 0, 120)]), {}, NOW));
  const absolute = scoreCandidate(candidate(1, 120, [snapshot(1, 24, 50000), snapshot(2, 0, 50500)]), {}, NOW);
  assert.equal(absolute.growth_rate_24h, 0.01);
  assert.equal(absolute.rate_24h, 500);
  assert.ok(scoreCandidate(candidate(1, 360), {}, NOW));
  assert.equal(scoreCandidate(candidate(1, 360 + 1 / HOUR), {}, NOW), null);
  assert.equal(scoreCandidate(candidate(1), { minRate: 201 }, NOW), null);
  assert.equal(scoreCandidate(candidate(1), { minGrowth: 3, absPass: 300 }, NOW), null);
  assert.ok(measureCandidate(candidate(1, 1000), {}, NOW));
});

test('limits normalize invalid values to 8, preserve valid integers and apply after sorting', () => {
  for (const value of ['abc', 0, 99, -1, 1.2, NaN, Infinity, undefined, null, '', true, false, '0x10', '1e1', [5], {}, ' 5 ', '+5', '5.0', '5\n']) assert.equal(normalizeLimit(value), 8);
  for (const value of [1, 7, 50]) assert.equal(normalizeLimit(value), value);
  assert.equal(normalizeLimit('7'), 7);
  assert.equal(normalizeLimit('005'), 5);
  assert.equal(DEFAULT_RISING_CONFIG.limit, 50);
  assert.deepEqual(rankRising([], {}, NOW), []);
  assert.equal(rankRising(scenarios(), { limit: 2 }, NOW).length, 2);
  assert.equal(rankRising(Array.from({ length: 55 }, (_, index) => candidate(index + 1)), {}, NOW).length, 50);
  assert.equal(rankRising(Array.from({ length: 10 }, (_, index) => candidate(index + 1)), { limit: 'abc' }, NOW).length, 8);
});

test('score ties break on rate descending then id ascending', () => {
  const lowRate = candidate(1, 0, [snapshot(1, 0, 50)]);
  const highRate = candidate(3, 72);
  const equalRate = candidate(2, 72);
  const rows = rankRising([highRate, lowRate, equalRate], {}, NOW);
  assert.deepEqual(rows.map((row) => row.id), [2, 3, 1]);
  assert.deepEqual(rows.map((row) => row.score), [100, 100, 100]);
  assert.deepEqual(rows.map((row) => row.rate_24h), [200, 200, 100]);
});
