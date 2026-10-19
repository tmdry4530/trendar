import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, escapeXml, serializeJsonLd, feedPath, repoPath, ogFeedPath, ogRepoPath, badgePath, localizedPath, absoluteUrl, routeTemplateOf } from '../src/utils/public-output.js';

test('HTML and XML escape all five markup characters', () => {
  for (const escape of [escapeHtml, escapeXml]) {
    assert.equal(escape('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    assert.equal(escape('a & b'), 'a &amp; b');
    assert.equal(escape(null), '');
    assert.equal(escape(123), '123');
  }
});

test('JSON-LD is valid JSON without raw script terminators or line separators', () => {
  const input = { a: '</script>\u2028', b: '&\u2029', nested: ['<', '>'] };
  const output = serializeJsonLd(input);
  assert.equal(output.includes('</script>'), false);
  assert.ok(output.includes('\\u003c/script\\u003e'));
  assert.ok(output.includes('\\u2028'));
  assert.ok(output.includes('\\u2029'));
  assert.ok(output.includes('\\u0026'));
  assert.deepEqual(JSON.parse(output), input);
});

test('feed, repository, OG and badge helpers share encoded route paths', () => {
  assert.equal(feedPath('all', 'all'), '/trending');
  assert.equal(feedPath('language', 'typescript'), '/trending/language/typescript');
  assert.equal(feedPath('topic', 'ai'), '/trending/topic/ai');
  assert.equal(repoPath('some owner', 'a/b'), '/repo/some%20owner/a%2Fb');
  assert.equal(ogFeedPath('all', 'all'), '/og/trending.png');
  assert.equal(ogFeedPath('language', 'go'), '/og/trending/language/go.png');
  assert.equal(ogFeedPath('topic', 'ai'), '/og/trending/topic/ai.png');
  assert.equal(ogRepoPath('owner', 'a b'), '/og/repo/owner/a%20b.png');
  assert.equal(badgePath('owner', 'a b'), '/badge/owner/a%20b.svg');
});

test('locale paths and absolute URLs do not create duplicate slashes', () => {
  assert.equal(localizedPath('ko', '/'), '/ko');
  assert.equal(localizedPath('ko', '/trending'), '/ko/trending');
  assert.equal(localizedPath('en', '/'), '/');
  assert.equal(localizedPath('en', '/repo/o/n'), '/repo/o/n');
  assert.equal(absoluteUrl('http://x', '/a'), 'http://x/a');
  assert.equal(absoluteUrl('http://x///', '///a'), 'http://x/a');
  assert.equal(absoluteUrl('https://x/', '/'), 'https://x/');
  assert.equal(absoluteUrl('https://x', localizedPath('ko', '/')), 'https://x/ko');
});

test('feed kinds map to the fixed analytics route templates', () => {
  assert.equal(routeTemplateOf('all'), 'trending');
  assert.equal(routeTemplateOf('language'), 'trending-language');
  assert.equal(routeTemplateOf('topic'), 'trending-topic');
});
