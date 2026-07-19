// test/extract.test.js — extractRepos 질의 조립 검증 (옵션 주입형 시그니처)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRepos } from '../src/etl/extract.js';

function makeOctokit() {
  let captured = null;
  return {
    get captured() { return captured; },
    rest: { search: { repos: async (params) => { captured = params; return { data: { items: [] } }; } } },
  };
}

const keywordWq = { query: 'agents', query_type: 'keyword' };
const topicWq = { query: 'llm', query_type: 'topic' };

test('keyword: 옵션 없음 — MIN_STARS/created 절 없이 기본 질의만', async () => {
  const octokit = makeOctokit();
  await extractRepos(keywordWq, octokit);
  assert.equal(octokit.captured.q, 'agents in:name,description,readme');
  assert.equal(octokit.captured.sort, 'stars');
  assert.equal(octokit.captured.order, 'desc');
});

test('topic: 옵션 없음 — topic: 질의만, created/stars 절 없음', async () => {
  const octokit = makeOctokit();
  await extractRepos(topicWq, octokit);
  assert.equal(octokit.captured.q, 'topic:llm');
});

test('minStars=0 명시 — stars 절 붙지 않음', async () => {
  const octokit = makeOctokit();
  await extractRepos(keywordWq, octokit, { minStars: 0 });
  assert.equal(octokit.captured.q, 'agents in:name,description,readme');
});

test('minStars 양수 — stars:>= 절이 붙는다', async () => {
  const octokit = makeOctokit();
  await extractRepos(keywordWq, octokit, { minStars: 100 });
  assert.equal(octokit.captured.q, 'agents in:name,description,readme stars:>=100');
});

test('createdAfter만 — created:> 절이 붙는다 (keyword)', async () => {
  const octokit = makeOctokit();
  await extractRepos(keywordWq, octokit, { createdAfter: '2026-04-20' });
  assert.equal(octokit.captured.q, 'agents in:name,description,readme created:>2026-04-20');
});

test('createdAfter만 — created:> 절이 붙는다 (topic)', async () => {
  const octokit = makeOctokit();
  await extractRepos(topicWq, octokit, { createdAfter: '2026-04-20' });
  assert.equal(octokit.captured.q, 'topic:llm created:>2026-04-20');
});

test('createdAfter + minStars 함께 — created 뒤에 stars 절', async () => {
  const octokit = makeOctokit();
  await extractRepos(keywordWq, octokit, { minStars: 50, createdAfter: '2026-04-20' });
  assert.equal(octokit.captured.q, 'agents in:name,description,readme created:>2026-04-20 stars:>=50');
});

test('per_page는 ETL_PER_QUERY(미설정 시 기본 30)를 유지한다', async () => {
  const octokit = makeOctokit();
  await extractRepos(keywordWq, octokit, { minStars: 10 });
  assert.equal(octokit.captured.per_page, 30);
});

test('minStars 미지정 + env ETL_MIN_STARS — 기존처럼 env로 폴백한다', async () => {
  const orig = process.env.ETL_MIN_STARS;
  try {
    process.env.ETL_MIN_STARS = '200';
    // 모듈 상단 상수는 import 시점에 env를 읽으므로, 캐시를 우회해 새로 로드해야 반영된다.
    const mod = await import(`../src/etl/extract.js?envtest=${Date.now()}`);
    const octokit = makeOctokit();
    await mod.extractRepos(keywordWq, octokit);
    assert.equal(octokit.captured.q, 'agents in:name,description,readme stars:>=200');
  } finally {
    if (orig === undefined) delete process.env.ETL_MIN_STARS;
    else process.env.ETL_MIN_STARS = orig;
  }
});
