import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOgRenderer, createResvgPngRenderer, feedOgSvg, OG_FONT_PATHS, repoOgSvg } from '../src/services/public-og.js';

const rows = [
  { rank: 1, full_name: 'acme/rocket', rate_24h: 1520, baseline_source: 'snapshot' },
  { rank: 2, full_name: 'evil/<script>alert(1)</script>', rate_24h: 820, baseline_source: 'snapshot' },
  { rank: 3, full_name: 'fresh/new-thing', rate_24h: 640, baseline_source: 'creation' },
  { rank: 4, full_name: 'half/known', rate_24h: 300, baseline_source: 'partial' },
  { rank: 5, full_name: 'five/fifth', rate_24h: 120, baseline_source: 'snapshot' },
  { rank: 6, full_name: 'six/sixth', rate_24h: 110, baseline_source: 'snapshot' },
];

test('feedOgSvg renders top 5 rows, escaped, without external references', () => {
  const svg = feedOgSvg({ feedName: 'Python', rows, updatedAt: new Date('2026-10-19T06:05:00Z') });
  assert.ok(svg.includes('width="1200" height="630"'));
  for (const name of ['acme/rocket', 'fresh/new-thing', 'half/known', 'five/fifth']) assert.ok(svg.includes(name), name);
  assert.ok(!svg.includes('six/sixth'));
  assert.ok(svg.includes('+1.5k/day'));
  assert.ok(svg.includes('+820/day'));
  assert.equal(svg.match(/est\./g).length, 2);
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(!svg.includes('<image'));
  assert.ok(!svg.includes('href="http'));
  assert.ok(svg.includes('Updated 2026-10-19 06:05 UTC'));
});

test('feedOgSvg truncates long names and handles empty feeds', () => {
  const long = feedOgSvg({ feedName: 'All', rows: [{ rank: 1, full_name: `owner/${'x'.repeat(80)}`, rate_24h: 200, baseline_source: 'snapshot' }] });
  assert.ok(long.includes('…'));
  assert.ok(!long.includes('x'.repeat(60)));
  assert.ok(feedOgSvg({ feedName: 'Rust', rows: [] }).includes('Collecting data'));
});

test('repoOgSvg shows name, total stars, daily rate and best label escaped', () => {
  const svg = repoOgSvg({ full_name: 'acme/<b>rocket</b>', stars: 12345, rate_24h: 640, baseline_source: 'creation', bestLabel: 'Trending #3 · C++ & <AI>' });
  assert.ok(svg.includes('width="1200" height="630"'));
  assert.ok(svg.includes('12,345'));
  assert.ok(svg.includes('+640/day'));
  assert.ok(svg.includes('est.'));
  assert.ok(!svg.includes('<b>') && !svg.includes('<AI>'));
  assert.ok(svg.includes('&lt;b&gt;rocket') && svg.includes('C++ &amp; &lt;AI&gt;'));
  assert.ok(repoOgSvg({ full_name: 'a/b', stars: 1, rate_24h: null }).includes('collecting data'));
});

test('createResvgPngRenderer renders a real 1200x630 PNG with bundled fonts', async () => {
  const renderPng = createResvgPngRenderer({});
  const buffer = await renderPng(feedOgSvg({ feedName: 'Python', rows, updatedAt: new Date() }));
  assert.ok(Buffer.isBuffer(buffer));
  assert.deepEqual([...buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(buffer.readUInt32BE(16), 1200);
  assert.equal(buffer.readUInt32BE(20), 630);
  const second = await renderPng(repoOgSvg({ full_name: 'acme/rocket', stars: 10, rate_24h: 5, baseline_source: 'snapshot', bestLabel: null }));
  assert.equal(second.readUInt32BE(16), 1200);
});

test('createResvgPngRenderer throws at creation when assets are missing', () => {
  assert.throws(() => createResvgPngRenderer({ fontPaths: [join(tmpdir(), 'trendar-missing-font.ttf')] }), /OG asset missing/);
  assert.throws(() => createResvgPngRenderer({ wasmPath: join(tmpdir(), 'trendar-missing.wasm'), fontPaths: OG_FONT_PATHS }), /OG asset missing/);
});

function fakeLog() {
  const errors = [];
  return { errors, error: (...args) => errors.push(args) };
}

test('createOgRenderer returns uncached fallback when rendering fails', async (t) => {
  t.mock.method(Date, 'now', () => 4_010_000_000_000);
  const fallbackPng = Buffer.from('fallback-png');
  const log = fakeLog();
  let calls = 0;
  const og = createOgRenderer({ renderPng: async () => { calls += 1; throw new Error('boom'); }, fallbackPng, log });
  const first = await og.render({ key: 'feed:all:all', revision: 'r1', svg: '<svg/>' });
  assert.equal(first.fallback, true);
  assert.ok(first.buffer.equals(fallbackPng));
  assert.equal(log.errors.length, 2, 'personalized and generic rendering both failed');
  await og.render({ key: 'feed:all:all', revision: 'r1', svg: '<svg/>' });
  assert.equal(calls, 3, 'retry personalized rendering, but never retry the failed generic image');
  assert.equal(og.fallbackPng, fallbackPng);
});

test('createOgRenderer caches by key and revision and shares in-flight renders', async (t) => {
  t.mock.method(Date, 'now', () => 4_020_000_000_000);
  let calls = 0;
  const og = createOgRenderer({ renderPng: async (svg) => { calls += 1; return Buffer.from(svg); }, fallbackPng: Buffer.from('f'), log: fakeLog() });
  const a = await og.render({ key: 'feed:all:all', revision: 'r1', svg: 'one' });
  const b = await og.render({ key: 'feed:all:all', revision: 'r1', svg: 'one' });
  assert.equal(calls, 1);
  assert.equal(a.fallback, false);
  assert.ok(b.buffer.equals(Buffer.from('one')));

  calls = 0;
  const [c, d] = await Promise.all([
    og.render({ key: 'repo:a/b', revision: 'x', svg: 'two' }),
    og.render({ key: 'repo:a/b', revision: 'x', svg: 'two' }),
  ]);
  assert.equal(calls, 1);
  assert.ok(c.buffer.equals(d.buffer));

  calls = 0;
  await og.render({ key: 'feed:all:all', revision: 'r2', svg: 'three' });
  await og.render({ key: 'feed:all:all', revision: 'r3', svg: 'four' });
  assert.equal(calls, 2);
});

test('createOgRenderer evicts beyond maxEntries', async (t) => {
  t.mock.method(Date, 'now', () => 4_030_000_000_000);
  let calls = 0;
  const og = createOgRenderer({ renderPng: async () => { calls += 1; return Buffer.from('p'); }, fallbackPng: Buffer.from('f'), maxEntries: 1, log: fakeLog() });
  await og.render({ key: 'a', revision: '1', svg: '' });
  await og.render({ key: 'b', revision: '1', svg: '' });
  await og.render({ key: 'a', revision: '1', svg: '' });
  assert.equal(calls, 3);
});

test('default OG cache retains all feeds and ranked repos across a full working set', async (t) => {
  let clock = 4_100_000_000_000;
  t.mock.method(Date, 'now', () => clock);
  let calls = 0;
  const og = createOgRenderer({
    renderPng: async () => { calls += 1; return Buffer.from('png'); },
    fallbackPng: Buffer.from('last-resort'),
    log: fakeLog(),
  });
  for (let i = 0; i < 1700; i += 1) {
    clock += 1000;
    const result = await og.render({ key: `repo:acme/r${i}`, revision: '1', svg: '<svg/>' });
    assert.equal(result.fallback, false);
  }
  const rendered = calls;
  await og.render({ key: 'repo:acme/r0', revision: '1', svg: '<svg/>' });
  assert.equal(calls, rendered);
});

test('fresh-render token bucket is process-wide, refills once per second, and caps bursts at five', async (t) => {
  let clock = 4_200_000_000_000;
  t.mock.method(Date, 'now', () => clock);
  const lastResort = Buffer.from('last-resort');
  const personalized = Buffer.from('personalized');
  let calls = 0;
  const make = () => createOgRenderer({
    renderPng: async () => { calls += 1; return personalized; },
    fallbackPng: lastResort,
    log: fakeLog(),
  });
  const first = make();
  const second = make();
  for (let i = 0; i < 5; i += 1) {
    const result = await (i % 2 ? first : second).render({ key: `repo:a/r${i}`, revision: '1', svg: '<svg/>' });
    assert.equal(result.fallback, false);
  }
  const blocked = await first.render({ key: 'over', revision: '1', svg: '<svg/>' });
  assert.equal(blocked.fallback, true);
  assert.equal(calls, 6, 'five personalized renders plus one memoized generic image');
  const again = await first.render({ key: 'over-again', revision: '1', svg: '<svg/>' });
  assert.equal(again.fallback, true);
  assert.equal(calls, 6);
  const cached = await first.render({ key: 'repo:a/r1', revision: '1', svg: '<svg/>' });
  assert.equal(cached.fallback, false);
  assert.equal(calls, 6);
  clock += 500;
  assert.equal((await first.render({ key: 'half-second', revision: '1', svg: '<svg/>' })).fallback, true);
  assert.equal(calls, 6);
  clock += 500;
  assert.equal((await first.render({ key: 'over', revision: '1', svg: '<svg/>' })).fallback, false);
  assert.equal(calls, 7, 'one second refills one token, and budget fallbacks were not cached');
  assert.equal((await first.render({ key: 'immediate-next', revision: '1', svg: '<svg/>' })).fallback, true);
  clock += 60_000;
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await second.render({ key: `refilled-${i}`, revision: '1', svg: '<svg/>' })).fallback, false);
  }
  assert.equal((await first.render({ key: 'no-minute-burst', revision: '1', svg: '<svg/>' })).fallback, true);
  assert.equal(calls, 12, 'even a full minute idle refills at most five tokens');
});

test('generic fallback is a real PNG under 100KB, rendered once and shared concurrently', async () => {
  const renderPng = createResvgPngRenderer({});
  let calls = 0;
  const og = createOgRenderer({
    renderPng: (svg) => { calls += 1; return renderPng(svg); },
    fallbackPng: Buffer.from('last-resort'),
    log: fakeLog(),
  });
  const [first, second] = await Promise.all([og.getFallbackPng(), og.getFallbackPng()]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(await og.getFallbackPng(), first);
  assert.ok(first.length < 100_000, `generic fallback is ${first.length} bytes`);
  assert.deepEqual([...first.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(first.readUInt32BE(16), 1200);
  assert.equal(first.readUInt32BE(20), 630);
});

test('generic render failure memoizes the static last resort instead of retrying on every request', async () => {
  let calls = 0;
  const fallbackPng = Buffer.from('static-last-resort');
  const og = createOgRenderer({
    renderPng: async () => { calls += 1; throw new Error('resvg failed'); },
    fallbackPng,
    log: fakeLog(),
  });
  assert.equal(await og.getFallbackPng(), fallbackPng);
  assert.equal(await og.getFallbackPng(), fallbackPng);
  assert.equal(calls, 1);
});

test('personalized render failure uses the small generic image before the static last resort', async (t) => {
  t.mock.method(Date, 'now', () => 4_300_000_000_000);
  const generic = Buffer.from('generic-png');
  const og = createOgRenderer({
    renderPng: async (svg) => {
      if (svg === 'broken personalized svg') throw new Error('bad target');
      return generic;
    },
    fallbackPng: Buffer.from('static-last-resort'),
    log: fakeLog(),
  });
  const result = await og.render({ key: 'broken', revision: '1', svg: 'broken personalized svg' });
  assert.equal(result.fallback, true);
  assert.equal(result.buffer, generic);
});

test('fresh personalized and generic renders yield to the event loop first', async (t) => {
  t.mock.method(Date, 'now', () => 4_400_000_000_000);
  const events = [];
  const og = createOgRenderer({
    renderPng: async () => { events.push('render'); return Buffer.from('png'); },
    fallbackPng: Buffer.from('last-resort'),
    log: fakeLog(),
  });
  const personalized = og.render({ key: 'yield', revision: '1', svg: '<svg/>' });
  const immediate = new Promise((resolve) => setImmediate(() => { events.push('immediate'); resolve(); }));
  await Promise.all([personalized, immediate]);
  assert.deepEqual(events, ['immediate', 'render']);
  events.length = 0;
  const genericImmediate = new Promise((resolve) => setImmediate(() => { events.push('immediate'); resolve(); }));
  await Promise.all([og.getFallbackPng(), genericImmediate]);
  assert.deepEqual(events, ['immediate', 'render']);
});
