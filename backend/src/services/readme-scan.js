// I/O 및 오케스트레이션 어댑터 — 순수 정적 분석·룰 평가·지문 추출은 Rust NAPI-RS 엔진(security-engine.js)에 위임한다.
// README 텍스트, 검색 응답 메타, 소유자 계정 생성일만 읽어 판정하며 링크·첨부·코드는 내려받거나 실행하지 않는다.
import {
  analyzeManifest,
  analyzeReadme,
  analyzeReadmeAsync,
  engineInfo,
  loadRulesDir,
  readmeTraits as extractTraitsFull,
  simhashDistance,
} from './security-engine.js';

export const RULE_VERSION = engineInfo().ruleVersion;
export const NEW_ACCOUNT_DAYS = 90;

const MAX_README_BYTES = 512 * 1024;
const MAX_EVIDENCE = 500;
const CODELESS_MAX_SIZE_KB = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export { analyzeManifest, analyzeReadme, analyzeReadmeAsync, engineInfo, loadRulesDir, simhashDistance };

function truncateUtf8Bytes(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  // Avoid cutting in the middle of a multi-byte UTF-8 sequence (drop trailing incomplete continuation bytes).
  let end = buf.length;
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end--;
  if (end > 0 && (buf[end - 1] & 0x80) !== 0) {
    const lead = buf[end - 1];
    const expected = (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : 4;
    if (buf.length - (end - 1) < expected) end--;
  }
  return buf.subarray(0, end).toString('utf8');
}

function isCodeless(meta) {
  if (!meta || (meta.language != null && meta.language !== '')) return false;
  if (typeof meta.forks !== 'number' || typeof meta.size !== 'number') return false;
  return meta.forks === 0 && meta.size >= 0 && meta.size <= CODELESS_MAX_SIZE_KB;
}

/**
 * 하위 호환 분류 API — 기존 계약({ verdict, evidence })을 엄격히 유지한다.
 * 전체 v4 리스크 스코어링·신호 목록·다국어 규칙은 `analyzeReadme` / `analyzeReadmeAsync`를 사용한다.
 * @param {string | null} text
 * @param {{ language?: string | null, forks?: number | null, size?: number | null, homepage?: string | null, description?: string | null, stars?: number | null }} [meta]
 * @param {{ enableMultilingual?: boolean, enableMetadataScoring?: boolean }} [options]
 */
export function classifyReadme(text, meta, options = {}) {
  if (typeof text !== 'string' || text === '') return { verdict: 'clean', evidence: null };
  const report = analyzeReadme(text, meta, {
    enableMultilingual: options.enableMultilingual ?? false,
    enableMetadataScoring: options.enableMetadataScoring ?? true,
  });
  return { verdict: report.verdict, evidence: report.evidence };
}

/**
 * 하위 호환 캠페인 특성 추출 API — 기존 계약({ textKey, skeletonKey, lure, archiveFilehostUrl })을 유지한다.
 * 64-bit SimHash와 단축 URL 신호까지 필요하면 `extractTraits`를 사용한다.
 * @param {string | null} text
 * @param {{ owner?: string, name?: string }} repo
 */
export function readmeTraits(text, repo) {
  if (typeof text !== 'string' || text === '') {
    return { textKey: null, skeletonKey: null, lure: false, archiveFilehostUrl: null };
  }
  const full = extractTraitsFull(text, repo);
  return {
    textKey: full.textKey,
    skeletonKey: full.skeletonKey,
    lure: full.lure,
    archiveFilehostUrl: full.archiveFilehostUrl,
  };
}

export function extractTraits(text, repo) {
  return extractTraitsFull(text, repo);
}

async function withTimeout(promise, timeoutMs, code) {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchReadme(octokit, owner, name, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  try {
    const { data } = await withTimeout(
      octokit.rest.repos.getReadme({ owner, repo: name, mediaType: { format: 'raw' } }),
      timeoutMs,
      'README_FETCH_TIMEOUT',
    );
    const text = typeof data === 'string' ? data : Buffer.from(data ?? '').toString('utf8');
    return truncateUtf8Bytes(text, MAX_README_BYTES);
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

// 미끼 링크 규칙(D-015)에서만 부른다. 생성일을 읽을 수 없으면 조회 실패로 다룬다.
export async function fetchOwnerCreatedAt(octokit, login, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const { data } = await withTimeout(
    octokit.rest.users.getByUsername({ username: login }),
    timeoutMs,
    'OWNER_FETCH_TIMEOUT',
  );
  const createdAt = typeof data?.created_at === 'string' ? new Date(data.created_at) : null;
  if (!createdAt || !Number.isFinite(createdAt.getTime())) {
    throw Object.assign(new Error('owner created_at unavailable'), { code: 'OWNER_CREATED_AT_UNAVAILABLE' });
  }
  return createdAt;
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

// GitHub REST 2차 한도(분당 약 900회)를 넘지 않도록 요청 시작 간격을 둔다.
// Rust NAPI-RS AsyncTask로 비동기 판정해 Express 이벤트 루프를 블로킹하지 않는다.
export function createReadmeScanner({
  model, fetchReadme: fetch = fetchReadme, fetchOwnerCreatedAt: fetchOwner = fetchOwnerCreatedAt, log = console,
  now = () => new Date(), concurrency = 4, minIntervalMs = 100, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = Date.now, enableMultilingual = true, enableManifest = false, fetchManifest = null,
}) {
  async function scanRepos(octokit, repos) {
    const result = { scanned: 0, malicious: 0, unknown: 0, skipped: 0, cluster_hidden: null };
    let nextStart = 0;
    let halted = false;
    // 실행 단위 소유자 계정 생성일 캐시 — 동일 공격자 계정의 다수 저장소 스캔 시 중복 API 호출을 제거한다.
    const ownerCreatedCache = new Map();

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

    async function recordFailure(id, error) {
      if (isRateLimited(error)) {
        if (!halted) log.warn(`[readme-scan] rate limited status=${error.status} — 남은 검사는 다음 수집에서 재시도`);
        halted = true;
      } else {
        log.warn(`[readme-scan] github_id=${id} status=${error?.status ?? error?.code ?? 'error'}`);
      }
      if (!existing.has(id)) {
        await model.upsertVerdict({
          github_id: id, verdict: 'unknown', rule_version: RULE_VERSION, evidence: null, repo_pushed_at: null, scanned_at: new Date(now()),
        });
        result.unknown++;
      }
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
        await recordFailure(id, error);
        return;
      }

      // Rust NAPI-RS AsyncTask로 비블로킹 분석 (분류 + 특성 + SimHash 단일 패스)
      const report = await analyzeReadmeAsync(text, repo, {
        enableMultilingual,
        enableMetadataScoring: true,
      });
      let verdict = report.verdict;
      let evidence = report.evidence;
      const traits = report.traits;

      // 미끼 링크 규칙(D-014·D-015): 압축·실행 파일 파일호스팅 링크 + 코드 없음 + 신생 소유자 계정.
      if (verdict === 'clean' && traits.archiveFilehostUrl && isCodeless(repo)) {
        const ownerKey = typeof repo.owner === 'string' ? repo.owner.toLowerCase() : '';
        let createdAt = ownerKey ? ownerCreatedCache.get(ownerKey) : null;
        if (!createdAt) {
          if (!halted) await pace();
          if (halted) {
            result.skipped++;
            return;
          }
          try {
            createdAt = await fetchOwner(octokit, repo.owner);
            if (ownerKey) ownerCreatedCache.set(ownerKey, createdAt);
          } catch (error) {
            await recordFailure(id, error);
            return;
          }
        }
        if (new Date(now()).getTime() - createdAt.getTime() <= NEW_ACCOUNT_DAYS * 86_400_000) {
          verdict = 'malicious';
          evidence = `파일호스팅 링크 ${traits.archiveFilehostUrl} · 소유자 계정 생성 ${createdAt.toISOString().slice(0, 10)}`.slice(0, MAX_EVIDENCE);
        }
      }

      // Opt-in 매니페스트 정적 분석 (기본 OFF — enableManifest=true 및 fetchManifest 주입 시에만 실행)
      if (verdict === 'clean' && enableManifest && typeof fetchManifest === 'function') {
        try {
          const manifestInput = await fetchManifest(octokit, repo.owner, repo.name);
          if (manifestInput) {
            const manifestReport = analyzeManifest(manifestInput);
            if (manifestReport.verdict === 'malicious') {
              verdict = 'malicious';
              evidence = String(manifestReport.evidence ?? 'manifest threat detected').slice(0, MAX_EVIDENCE);
            }
          }
        } catch (error) {
          log.warn(`[readme-scan] github_id=${id} manifest=${error?.code ?? error?.status ?? 'error'}`);
        }
      }

      await model.upsertVerdict({
        github_id: id, verdict, rule_version: RULE_VERSION, evidence,
        repo_pushed_at: repo.pushed_at ? new Date(repo.pushed_at) : null, scanned_at: new Date(now()),
        owner_login: typeof repo.owner === 'string' ? repo.owner.toLowerCase() : null,
        text_key: traits.textKey, skeleton_key: traits.skeletonKey, lure: traits.lure,
      });
      result.scanned++;
      if (verdict === 'malicious') result.malicious++;
    }

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

    try {
      result.cluster_hidden = await model.refreshClusters();
    } catch (error) {
      log.warn(`[readme-scan] cluster refresh=${error?.code ?? error?.name ?? 'error'}`);
    }
    return result;
  }

  return { scanRepos };
}
