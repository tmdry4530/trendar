import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSitemapXml, createSitemapHandler } from '../src/services/public-sitemap.js';

const appUrl = 'https://trendar.test';
const entries = {
  feeds: [
    { kind: 'all', slug: 'all', lastmod: new Date('2026-10-19T12:34:56Z') },
    { kind: 'language', slug: 'javascript', lastmod: null },
    { kind: 'topic', slug: 'ai', lastmod: new Date('2026-10-18T23:59:59Z') },
  ],
  repos: [{ owner: 'owner', name: 'repo', lastmod: new Date('2026-10-19T12:00:00Z') }],
};

function urls(xml) {
  return [...xml.matchAll(/<url>(.*?)<\/url>/gs)].map((match) => match[1]);
}

test('sitemap emits unique English/Korean roots, feeds and repos with three alternate languages', () => {
  const xml = buildSitemapXml({ appUrl, ...entries });
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<urlset'));
  assert.ok(xml.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'));
  assert.ok(xml.includes('xmlns:xhtml="http://www.w3.org/1999/xhtml"'));
  const blocks = urls(xml);
  assert.equal(blocks.length, 10);
  for (const path of ['/', '/ko', '/trending', '/ko/trending', '/trending/language/javascript', '/ko/trending/language/javascript', '/trending/topic/ai', '/ko/trending/topic/ai', '/repo/owner/repo', '/ko/repo/owner/repo']) {
    assert.equal(blocks.filter((block) => block.includes(`<loc>${appUrl}${path}</loc>`)).length, 1, path);
  }
  for (const block of blocks) {
    assert.equal((block.match(/<xhtml:link/g) ?? []).length, 3);
    for (const locale of ['en', 'ko', 'x-default']) assert.ok(block.includes(`hreflang="${locale}"`));
  }
  const korean = blocks.find((block) => block.includes(`<loc>${appUrl}/ko/trending</loc>`));
  assert.ok(korean.includes(`hreflang="en" href="${appUrl}/trending"`));
  assert.ok(korean.includes(`hreflang="ko" href="${appUrl}/ko/trending"`));
  assert.ok(korean.includes(`hreflang="x-default" href="${appUrl}/trending"`));
});

test('lastmod is UTC date only when supplied, including roots without invented timestamps', () => {
  const blocks = urls(buildSitemapXml({ appUrl, ...entries }));
  for (const block of blocks) {
    if (block.includes('/language/') || block.includes(`<loc>${appUrl}/</loc>`) || block.includes(`<loc>${appUrl}/ko</loc>`)) {
      assert.equal(block.includes('<lastmod>'), false);
    }
  }
  const feed = blocks.find((block) => block.includes(`<loc>${appUrl}/trending</loc>`));
  assert.ok(feed.includes('<lastmod>2026-10-19</lastmod>'));
  assert.equal(feed.includes('12:34'), false);
});

test('sitemap XML escapes ampersands in every location and alternate attribute', () => {
  const xml = buildSitemapXml({ appUrl: 'https://trendar.test/a&b', ...entries });
  assert.ok(xml.includes('a&amp;b/trending'));
  assert.equal(xml.includes('a&b'), false);
  assert.equal(xml.includes('&amp;amp;'), false);
});

test('duplicate inputs emit each localized page only once and empty input keeps both roots', () => {
  const xml = buildSitemapXml({ appUrl, feeds: [...entries.feeds, entries.feeds[0]], repos: [...entries.repos, entries.repos[0]] });
  assert.equal(urls(xml).length, 10);
  assert.equal(urls(buildSitemapXml({ appUrl, feeds: [], repos: [] })).length, 2);
});

test('sitemap handler sets XML content type/cache policy and sends generated data', async () => {
  let calls = 0;
  let error;
  const res = { headers: {}, set(name, value) { this.headers[name] = value; return this; }, send(value) { this.body = value; return this; } };
  const handler = createSitemapHandler({ appUrl, data: { getSitemapEntries: async () => { calls++; return entries; } } });
  await handler({}, res, (value) => { error = value; });
  assert.equal(calls, 1);
  assert.equal(error, undefined);
  assert.equal(res.headers['Content-Type'], 'application/xml; charset=utf-8');
  assert.equal(res.headers['Cache-Control'], 'public, max-age=600');
  assert.equal(res.body, buildSitemapXml({ appUrl, ...entries }));
});

test('sitemap handler forwards model failures without sending a partial response', async () => {
  const failure = new Error('model unavailable');
  const handler = createSitemapHandler({ appUrl, data: { getSitemapEntries: async () => { throw failure; } } });
  let forwarded;
  await handler({}, { send: () => assert.fail('must not send') }, (error) => { forwarded = error; });
  assert.equal(forwarded, failure);
});
