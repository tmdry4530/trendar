import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeForRepo, formatDailyRate, renderBadgeSvg } from '../src/services/public-badge.js';

test('renderBadgeSvg escapes text and emits a sized flat badge', () => {
  const svg = renderBadgeSvg({ label: 'Trendar', message: '#1 C++ <AI> & "x"', color: '#3ddc84' });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(!svg.includes('<AI>'));
  assert.ok(svg.includes('&lt;AI&gt; &amp; &quot;x&quot;'));
  assert.match(svg, /^<svg[^>]* width="\d+(\.\d+)?" height="20"/);
  assert.match(svg, /role="img"/);
  assert.match(svg, /<title>Trendar: #1 C\+\+ &lt;AI&gt;/);
});

test('renderBadgeSvg widens with longer text and rejects non-hex colors', () => {
  const width = (svg) => Number(svg.match(/width="(\d+)"/)[1]);
  assert.ok(width(renderBadgeSvg({ label: 'Trendar', message: 'a much longer message' })) > width(renderBadgeSvg({ label: 'Trendar', message: 'x' })));
  const svg = renderBadgeSvg({ label: 'a', message: 'b', color: 'red" onload="x' });
  assert.ok(!svg.includes('onload'));
  assert.ok(svg.includes('fill="#555"'));
});

test('badgeForRepo covers missing, ranked, measured and collecting states', () => {
  assert.deepEqual(badgeForRepo(null), { label: 'Trendar', message: 'GitHub trend radar', color: '#555' });
  const ranked = badgeForRepo({ best: { kind: 'language', slug: 'python', name: { en: 'Python', ko: 'Python' }, rank: 3 }, latest: { rate_24h: 900 } });
  assert.equal(ranked.label, 'Trending on Trendar');
  assert.equal(ranked.message, '#3 Python');
  assert.equal(ranked.color, '#3ddc84');
  const measured = badgeForRepo({ best: null, latest: { rate_24h: 1520, baseline_source: 'snapshot' } });
  assert.equal(measured.label, 'Trendar');
  assert.ok(measured.message.includes('/day'));
  assert.equal(measured.message, '+1.5k/day');
  assert.equal(badgeForRepo({ best: null, latest: null }).message, 'collecting data');
});

test('formatDailyRate compacts and signs rates', () => {
  assert.equal(formatDailyRate(340.4), '+340/day');
  assert.equal(formatDailyRate(1000), '+1k/day');
  assert.equal(formatDailyRate(123456), '+123k/day');
  assert.equal(formatDailyRate(-12), '-12/day');
});
