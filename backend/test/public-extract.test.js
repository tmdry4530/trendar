import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublicSearchQuery, searchPublicRepos, createPacer } from '../src/etl/public-extract.js';

test('공개 검색: 전체·언어·주제 qualifier와 공백을 정규화한다', () => {
  const options = { createdAfter: '2026-10-04', minStars: 20 };
  assert.equal(buildPublicSearchQuery({ query: 'language:Python' }, options),
    'is:public language:Python created:>2026-10-04 stars:>=20');
  assert.equal(buildPublicSearchQuery({ query: '' }, options),
    'is:public created:>2026-10-04 stars:>=20');
  assert.equal(buildPublicSearchQuery({ query: '  topic:ai-agents \n topic:llm  ' }, options),
    'is:public topic:ai-agents topic:llm created:>2026-10-04 stars:>=20');
});

test('공개 검색: stars 내림차순·100개 고정으로 items를 반환한다', async () => {
  const calls = [];
  const items = [{ id: 1 }];
  const octokit = { rest: { search: { repos: async (options) => {
    calls.push(options);
    return { data: { items } };
  } } } };
  assert.equal(await searchPublicRepos(octokit, 'is:public'), items);
  assert.deepEqual(calls, [{ q: 'is:public', sort: 'stars', order: 'desc', per_page: 100 }]);
});

test('pacer: 첫 호출은 즉시, 짧은 요청 뒤에는 시작 간격의 나머지만 대기한다', async () => {
  let clock = 0;
  const sleeps = [];
  const pacer = createPacer({ intervalMs: 2100, now: () => clock, sleep: async (ms) => {
    sleeps.push(ms);
    clock += ms;
  } });
  await pacer.pace();
  assert.deepEqual(sleeps, []);
  clock += 500;
  await pacer.pace();
  assert.deepEqual(sleeps, [1600]);
  assert.equal(clock, 2100);
  await pacer.pace();
  assert.deepEqual(sleeps, [1600, 2100]);
});

test('pacer: 3000ms 요청 뒤에는 불필요한 추가 대기가 없다', async () => {
  let clock = 100;
  const sleeps = [];
  const pacer = createPacer({ intervalMs: 2100, now: () => clock, sleep: async (ms) => {
    sleeps.push(ms);
    clock += ms;
  } });
  await pacer.pace();
  clock += 3000;
  await pacer.pace();
  assert.deepEqual(sleeps, []);
  assert.equal(clock, 3100);
});

test('pacer: sleep이 1ms 일찍 끝나도 시작 간격을 다시 확인한다', async () => {
  let clock = 0;
  const sleeps = [];
  const pacer = createPacer({ intervalMs: 2100, now: () => clock, sleep: async (ms) => {
    sleeps.push(ms);
    clock += sleeps.length === 1 ? ms - 1 : ms;
  } });
  await pacer.pace();
  await pacer.pace();
  assert.deepEqual(sleeps, [2100, 1]);
  assert.equal(clock, 2100);
});
