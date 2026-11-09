// README 텍스트만 읽어 판정한다. 링크·첨부·코드는 내려받거나 실행하지 않는다.
export const RULE_VERSION = 1;

const MAX_README_BYTES = 512 * 1024;
const MAX_EVIDENCE = 500;

// 모든 정규식은 한 지점에서 고정 길이 또는 서로 겹치지 않는 반복만 쓴다. 긴 줄에서 역추적이 폭증하지 않게 하기 위함이다.
const FETCH = /\b(?:irm|iwr|invoke-restmethod|invoke-webrequest|curl(?:\.exe)?|wget)\b/i;
const REMOTE_TARGET = /https?:\/\/|[\w-]\.[a-z]{2,}\//i;
const RUN_POWERSHELL = /^\s*(?:iex\b|invoke-expression\b|&\s*\(\s*(?:gcm|get-command)\s+i\S{0,4}x\s*\))/i;
const RUN_SHELL = /^\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da)?sh\b/i;
const INLINE_IEX = /\b(?:iex|invoke-expression)\b[\s(]*(?:irm|iwr|invoke-restmethod|invoke-webrequest|new-object\s+(?:system\.)?net\.webclient)\b/i;

const PROTECTION = String.raw`(?:real-?\s?time\s+protection|tamper\s+protection|(?:windows\s+|microsoft\s+)?defender|anti-?virus(?:\s+software)?|virus\s*(?:&|and)\s*threat\s+protection)`;
const QUOTE = String.raw`["'“”‘’*_\x60]`;
const FILLER = String.raw`(?:(?:the|your|any|all|temporarily|briefly|windows|microsoft|${QUOTE})\s*)*`;
// 보호 기능 자체를 끄는 지시만 인정한다. 알림 끄기·예외 등록·SmartScreen 통과 안내는 해당하지 않는다(R2.3).
const PROTECTION_OFF = [
  new RegExp(String.raw`\b(?:disable|turn\s+off|switch\s+off|pause|deactivate|stop|uninstall)\s+${FILLER}${PROTECTION}`, 'gi'),
  new RegExp(String.raw`${PROTECTION}${QUOTE}*\s*(?:is\s+|are\s+|must\s+be\s+|should\s+be\s+|needs\s+to\s+be\s+)?(?:turned\s+off|switched\s+off|off|disabled|paused)\b`, 'gi'),
  /\bSet-MpPreference\b[^\n]{0,200}?-Disable\w*\s+\$?true/gi,
];
const NEGATION = /\b(?:never|not|don't|do\s+not|doesn't|no\s+need\s+to|without)\s+(?:\w+\s+){0,2}$/i;
const EXCLUSION = /\b(?:exclusions?|exceptions?|whitelist|allow-?list)\b/i;
// "Defender notifications"처럼 보호 기능이 아닌 부속 대상을 끄는 안내는 제외한다.
const SIDE_TARGET = /^[\s"'“”‘’*_\x60]{0,3}(?:notifications?|alerts?|pop-?ups?|prompts?|warnings?|messages?|icons?|tray)\b/i;

const FENCE = /^(?:```|~~~)/;
const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/;
const BLOCK_START = /^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>)/;
const SENTENCE_END = /(?<=[.!?])\s+/;
const CONTINUES = /[|`\\]$/;

// 명령 단위: 줄 끝 파이프·백틱·역슬래시 또는 파이프로 시작하는 줄을 앞 명령에 잇는다. 코드블록 밖 Markdown 표는 건너뛴다.
// 문장 단위: 빈 줄·코드펜스·목록·제목에서 문단을 끊고, 문단 안 줄바꿈은 공백으로 이은 뒤 문장으로 나눈다.
function lineUnits(text) {
  const commands = [];
  const sentences = [];
  let pending = null;
  let paragraph = [];
  let inFence = false;
  let inTable = false;
  let previousCommandLine = false;
  const flushParagraph = () => {
    if (paragraph.length) for (const sentence of paragraph.join(' ').split(SENTENCE_END)) sentences.push(sentence);
    paragraph = [];
  };
  for (const line of text.split(/\r?\n/).map((value) => value.trim())) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      inTable = false;
      flushParagraph();
      continue;
    }
    if (line === '' || BLOCK_START.test(line)) flushParagraph();
    if (line !== '') paragraph.push(line);

    if (!inFence) {
      // 표는 빈 줄 또는 파이프가 없는 줄(제목·목록·문단)에서 끝난다.
      if (line === '' || !line.includes('|')) inTable = false;
      // 구분 행에 파이프가 있어야 표다. `---`만 있는 줄은 수평선이다.
      if (line.includes('|') && TABLE_SEPARATOR.test(line)) {
        if (previousCommandLine && pending === null) commands.pop();
        inTable = true;
      }
      if (inTable || (line.startsWith('|') && line.endsWith('|') && line.length > 1)) {
        previousCommandLine = false;
        continue;
      }
    }
    if (pending !== null) pending = /[`\\]$/.test(pending) ? `${pending.slice(0, -1)}${line}` : `${pending} ${line}`;
    else if (line.startsWith('|') && commands.length) pending = `${commands.pop()} ${line}`;
    else pending = line;
    previousCommandLine = true;
    if (line !== '' && CONTINUES.test(pending)) continue;
    commands.push(pending);
    pending = null;
  }
  if (pending !== null) commands.push(pending.replace(/[`\\]$/, ''));
  flushParagraph();
  return { commands, sentences };
}

function isRemoteExec(unit) {
  if (INLINE_IEX.test(unit) && REMOTE_TARGET.test(unit)) return true;
  const parts = unit.split('|');
  for (let i = 1; i < parts.length; i++) {
    const left = parts[i - 1];
    if (FETCH.test(left) && REMOTE_TARGET.test(left) && (RUN_POWERSHELL.test(parts[i]) || RUN_SHELL.test(parts[i]))) return true;
  }
  return false;
}

function isProtectionOff(sentence) {
  if (EXCLUSION.test(sentence)) return false;
  for (const pattern of PROTECTION_OFF) {
    for (const match of sentence.matchAll(pattern)) {
      const before = sentence.slice(Math.max(0, match.index - 30), match.index).replace(/[*_~`]/g, '');
      if (NEGATION.test(before)) continue;
      if (SIDE_TARGET.test(sentence.slice(match.index + match[0].length, match.index + match[0].length + 20))) continue;
      return true;
    }
  }
  return false;
}

export function classifyReadme(text) {
  if (typeof text !== 'string' || text === '') return { verdict: 'clean', evidence: null };
  const { commands, sentences } = lineUnits(text);
  const exec = commands.find(isRemoteExec);
  if (!exec) return { verdict: 'clean', evidence: null };
  const off = sentences.find(isProtectionOff);
  if (!off) return { verdict: 'clean', evidence: null };
  return { verdict: 'malicious', evidence: `${exec} || ${off}`.slice(0, MAX_EVIDENCE) };
}

export async function fetchReadme(octokit, owner, name) {
  try {
    const { data } = await octokit.rest.repos.getReadme({ owner, repo: name, mediaType: { format: 'raw' } });
    const text = typeof data === 'string' ? data : Buffer.from(data ?? '').toString('utf8');
    return text.length > MAX_README_BYTES ? text.slice(0, MAX_README_BYTES) : text;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

function timeOf(value) {
  if (value == null) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function needsScan(previous, pushedAt) {
  if (!previous) return true;
  if (previous.verdict === 'unknown') return true;
  if (Number(previous.rule_version) !== RULE_VERSION) return true;
  return timeOf(previous.repo_pushed_at) !== timeOf(pushedAt);
}

function isRateLimited(error) {
  if (error?.status === 429) return true;
  if (error?.status !== 403) return false;
  const headers = error.response?.headers ?? {};
  return Boolean(headers['retry-after']) || headers['x-ratelimit-remaining'] === '0' || /rate limit/i.test(String(error.message));
}

// GitHub REST 2차 한도(분당 약 900회)를 넘지 않도록 요청 시작 간격을 둔다. 한도에 걸리면 남은 검사는 다음 수집으로 넘긴다.
export function createReadmeScanner({
  model, fetchReadme: fetch = fetchReadme, log = console, now = () => new Date(), concurrency = 4,
  minIntervalMs = 100, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), clock = Date.now,
}) {
  async function scanRepos(octokit, repos) {
    const result = { scanned: 0, malicious: 0, unknown: 0, skipped: 0 };
    let nextStart = 0;
    let halted = false;
    const pace = async () => {
      const at = Math.max(clock(), nextStart);
      nextStart = at + minIntervalMs;
      const wait = at - clock();
      if (wait > 0) await sleep(wait);
    };
    const unique = new Map();
    for (const repo of repos) {
      const id = Number(repo?.github_id);
      if (Number.isSafeInteger(id) && id > 0 && !unique.has(id)) unique.set(id, repo);
    }
    if (!unique.size) return result;
    const existing = await model.findVerdicts([...unique.keys()]);
    const queue = [];
    for (const [id, repo] of unique) {
      if (needsScan(existing.get(id), repo.pushed_at)) queue.push([id, repo]);
      else result.skipped++;
    }

    async function scanOne([id, repo]) {
      if (!halted) await pace();
      if (halted) {
        result.skipped++;
        return;
      }
      let text;
      try {
        text = await fetch(octokit, repo.owner, repo.name);
      } catch (error) {
        // 한도에 걸린 요청도 조회 실패라 아래 R2.2 처리를 따르고, 아직 요청하지 않은 저장소만 판정 없이 다음 수집으로 넘긴다.
        if (isRateLimited(error)) {
          if (!halted) log.warn(`[readme-scan] rate limited status=${error.status} — 남은 검사는 다음 수집에서 재시도`);
          halted = true;
        } else {
          log.warn(`[readme-scan] github_id=${id} status=${error?.status ?? 'error'}`);
        }
        // 기존 판정은 성공한 재검사로만 바뀐다(D-008). push 시각을 갱신하지 않아 다음 수집에서 다시 시도한다.
        if (!existing.has(id)) {
          await model.upsertVerdict({
            github_id: id, verdict: 'unknown', rule_version: RULE_VERSION, evidence: null, repo_pushed_at: null, scanned_at: new Date(now()),
          });
          result.unknown++;
        }
        return;
      }
      const { verdict, evidence } = classifyReadme(text);
      await model.upsertVerdict({
        github_id: id, verdict, rule_version: RULE_VERSION, evidence,
        repo_pushed_at: repo.pushed_at ? new Date(repo.pushed_at) : null, scanned_at: new Date(now()),
      });
      result.scanned++;
      if (verdict === 'malicious') result.malicious++;
    }

    // 한 저장소의 저장 실패가 다른 판정을 끊거나 순위 기록을 앞질러 진행시키지 않도록 저장소 단위로 격리한다.
    async function scanSafely(entry) {
      try {
        await scanOne(entry);
      } catch (error) {
        log.warn(`[readme-scan] github_id=${entry[0]} store=${error?.code ?? error?.name ?? 'error'}`);
      }
    }

    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (next < queue.length) await scanSafely(queue[next++]);
    });
    await Promise.all(workers);
    return result;
  }

  return { scanRepos };
}
