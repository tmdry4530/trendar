import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_MIN_STARS, SLUG_RE, OWNER_RE, REPO_NAME_RE,
  LANGUAGE_CATALOG, TOPIC_CATALOG, allFeeds, findFeedConfig, feedKey,
} from '../src/config/public-feeds.js';

test('기본 피드는 전체·언어 8개·주제 24개이며 slug와 표시 이름이 유효하다', () => {
  const feeds = allFeeds({});
  assert.equal(PUBLIC_MIN_STARS, 20);
  assert.deepEqual(feeds[0], { kind: 'all', slug: 'all', name: { en: 'All', ko: '전체' }, query: '' });
  assert.equal(LANGUAGE_CATALOG.length, 8);
  assert.equal(TOPIC_CATALOG.length, 24);
  assert.equal(feeds.length, 33);
  assert.equal(new Set(feeds.map(({ slug }) => slug)).size, 33);
  for (const feed of feeds) {
    assert.match(feed.slug, SLUG_RE);
    assert.ok(feed.name.en);
    assert.ok(feed.name.ko);
    assert.equal(typeof feed.query, 'string');
  }
  for (const feed of LANGUAGE_CATALOG) assert.match(feed.query, /^language:/);
  for (const feed of TOPIC_CATALOG) assert.equal(feed.query, `topic:${feed.slug}`);
  assert.equal(findFeedConfig(feeds, 'language', 'cpp').query, 'language:cpp');
  assert.equal(findFeedConfig(feeds, 'language', 'csharp').query, 'language:csharp');
});

test('피드 선택은 공백을 제거하고 카탈로그 순서·고유 항목을 유지한다', () => {
  const feeds = allFeeds({ PUBLIC_TOPICS: 'llm, rag', PUBLIC_LANGUAGES: 'rust, python, rust' });
  assert.deepEqual(feeds.filter(({ kind }) => kind === 'topic').map(({ slug }) => slug), ['llm', 'rag']);
  assert.deepEqual(feeds.filter(({ kind }) => kind === 'language').map(({ slug }) => slug), ['python', 'rust']);
  assert.equal(feeds[0].kind, 'all');
});

test('빈 선택은 기본 목록이고 미지 slug는 설정명·slug를 포함한 오류다', () => {
  assert.deepEqual(allFeeds({ PUBLIC_TOPICS: '', PUBLIC_LANGUAGES: ' , ' }), allFeeds({}));
  assert.throws(() => allFeeds({ PUBLIC_LANGUAGES: 'nope' }), /PUBLIC_LANGUAGES: unknown slug nope/);
  assert.throws(() => allFeeds({ PUBLIC_TOPICS: 'llm, nope' }), /PUBLIC_TOPICS: unknown slug nope/);
});

test('findFeedConfig는 kind까지 확인하고 feedKey는 공개 키 형식이다', () => {
  const feeds = allFeeds({});
  assert.equal(findFeedConfig(feeds, 'topic', 'llm'), TOPIC_CATALOG[0]);
  assert.equal(findFeedConfig(feeds, 'language', 'llm'), null);
  assert.equal(findFeedConfig(feeds, 'topic', 'missing'), null);
  assert.equal(feedKey('topic', 'llm'), 'topic:llm');
});

test('slug·GitHub owner·repo 형식은 계약의 길이와 문자 범위를 지킨다', () => {
  assert.ok(SLUG_RE.test('a'.repeat(64)));
  assert.ok(!SLUG_RE.test('a'.repeat(65)));
  assert.ok(!SLUG_RE.test('TypeScript'));
  assert.ok(!SLUG_RE.test('../repo'));
  assert.ok(OWNER_RE.test('Some-Owner'));
  assert.ok(OWNER_RE.test('a'.repeat(39)));
  assert.ok(!OWNER_RE.test('a'.repeat(40)));
  assert.ok(!OWNER_RE.test('owner_name'));
  assert.ok(REPO_NAME_RE.test('some.repo_v1-test'));
  assert.ok(REPO_NAME_RE.test('a'.repeat(100)));
  assert.ok(!REPO_NAME_RE.test('a'.repeat(101)));
  assert.ok(!REPO_NAME_RE.test('owner/repo'));
});
