// mock.ts — 인메모리 목 백엔드 (VITE_USE_MOCK=true 일 때만 사용).
// 백엔드가 아직 stub 상태이므로, UI 전체를 단독으로 데모/검증할 수 있도록
// 모든 엔드포인트(조회 + 변형 + ETL)를 상태를 가진 채로 흉내 낸다.
// 실제 호출 경로(client.ts 의 fetch)가 기본값이며, 이 파일은 토글 시에만 동작한다.
import { ApiError } from './client';
import type { OpenCheckoutOptions } from '../lib/paddle';
import type {
  WatchQuery,
  Repo,
  Snapshot,
  RepoListResult,
  RepoDetailResult,
  Stats,
  TrendRepo,
  RisingRepo,
  BookmarkRepo,
  LanguageStat,
  EtlRunResult,
  EtlStatus,
  DeletedResult,
  QueryType,
  RepoSort,
  Me,
  Plan,
  PlanLimits,
  BillingInfo,
  BillingSubscription,
  CheckoutResult,
  PortalResult,
} from '../types';

type MockRepo = Repo & { note: string | null; first_seen_at: string };

// ── 초기 시드 ───────────────────────────────────────────────────────────────
let queries: WatchQuery[] = [
  { id: 1, query: 'hermes agent', query_type: 'keyword', is_active: true, repo_count: 0, created_at: isoAgo(120) },
  { id: 2, query: 'ai agent skill', query_type: 'keyword', is_active: true, repo_count: 0, created_at: isoAgo(118) },
  { id: 3, query: 'ai-agents', query_type: 'topic', is_active: false, repo_count: 0, created_at: isoAgo(116) },
];

interface Seed {
  github_id: number;
  query_id: number;
  full_name: string;
  description: string | null;
  language: string | null;
  stars: number;
  star_delta: number;
  forks: number;
  issues: number;
  points: number;
  is_bookmarked?: boolean;
  note?: string | null;
}

const SEEDS: Seed[] = [
  // Q1 — hermes agent
  { github_id: 845210, query_id: 1, full_name: 'NousResearch/hermes-agent', description: 'Self-improving autonomous AI agent runtime with skill memory', language: 'Python', stars: 134000, star_delta: 1200, forks: 4100, issues: 205, points: 7, is_bookmarked: true, note: 'Paperclip 연동 살펴볼 것' },
  { github_id: 845233, query_id: 1, full_name: '0xNyk/awesome-hermes-agent', description: 'Curated skills, tools & prompts for the Hermes agent ecosystem', language: null, stars: 3100, star_delta: 420, forks: 180, issues: 12, points: 6 },
  { github_id: 845299, query_id: 1, full_name: 'schnetzlerjoe/hermes', description: 'Minimal Hermes-style ReAct agent in pure Python', language: 'Python', stars: 880, star_delta: 96, forks: 64, issues: 23, points: 5 },
  { github_id: 845712, query_id: 1, full_name: 'mudrii/hermes-agent-docs', description: 'Comprehensive Hermes Agent documentation & cookbook', language: 'MDX', stars: 640, star_delta: 140, forks: 30, issues: 8, points: 4 },
  { github_id: 846001, query_id: 1, full_name: 'hermes-labs/hermes-runtime', description: 'High-throughput agent runtime with tool sandboxing', language: 'Rust', stars: 2200, star_delta: 310, forks: 140, issues: 41, points: 6, is_bookmarked: true },
  // Q2 — ai agent skill
  { github_id: 902115, query_id: 2, full_name: 'agentkit/skill-registry', description: 'Open registry of composable agent skills', language: 'TypeScript', stars: 8900, star_delta: 540, forks: 610, issues: 88, points: 7 },
  { github_id: 902440, query_id: 2, full_name: 'openagents/skill-sdk', description: 'TypeScript SDK for authoring & publishing agent skills', language: 'TypeScript', stars: 5400, star_delta: 210, forks: 320, issues: 54, points: 6 },
  { github_id: 902501, query_id: 2, full_name: 'skillforge/agent-skills', description: 'Battle-tested skill packs for production agents', language: 'Python', stars: 1500, star_delta: 260, forks: 95, issues: 19, points: 5, note: '스킬 스펙 포맷 우리 것과 비교' },
  { github_id: 902777, query_id: 2, full_name: 'toolhouse-ai/agent-tools', description: 'Hosted tools & function-calling skills for agents', language: 'Go', stars: 760, star_delta: 44, forks: 38, issues: 11, points: 3 },
  { github_id: 903012, query_id: 2, full_name: 'langroid/agent-skills', description: 'Multi-agent skill orchestration primitives', language: 'Python', stars: 3300, star_delta: 130, forks: 210, issues: 47, points: 6 },
  // Q3 — ai-agents (topic)
  { github_id: 710044, query_id: 3, full_name: 'crewAIInc/crewAI', description: 'Framework for orchestrating role-playing autonomous AI agents', language: 'Python', stars: 21000, star_delta: 900, forks: 2700, issues: 312, points: 7, is_bookmarked: true },
  { github_id: 710099, query_id: 3, full_name: 'microsoft/autogen', description: 'A programming framework for agentic AI', language: 'Python', stars: 31000, star_delta: 700, forks: 4200, issues: 540, points: 7 },
  { github_id: 710210, query_id: 3, full_name: 'e2b-dev/awesome-ai-agents', description: 'A curated list of AI autonomous agents', language: null, stars: 12000, star_delta: 260, forks: 980, issues: 22, points: 5 },
  { github_id: 710512, query_id: 3, full_name: 'run-llama/llama-agents', description: 'Build & deploy multi-agent systems as microservices', language: 'Python', stars: 1800, star_delta: 180, forks: 120, issues: 33, points: 2 },
  { github_id: 710888, query_id: 3, full_name: 'agno-agi/agno', description: 'Lightweight library for building memory-augmented agents', language: 'Python', stars: 16000, star_delta: 1500, forks: 1100, issues: 176, points: 1 },
];

let repos: MockRepo[] = [];
const snapshots: Record<number, Snapshot[]> = {};
let lastEtlAt: string | null = isoAgo(2 * 60); // 2시간 전
let repoSeq = 0;
let querySeq = 3;

(function seed() {
  for (const s of SEEDS) {
    const id = ++repoSeq;
    const [owner, name] = s.full_name.split('/');
    repos.push({
      id,
      github_id: s.github_id,
      query_id: s.query_id,
      full_name: s.full_name,
      owner,
      name,
      html_url: `https://github.com/${s.full_name}`,
      description: s.description,
      language: s.language,
      stars: s.stars,
      star_delta: s.star_delta,
      growth_rate: s.star_delta / Math.max(s.stars - s.star_delta, 1),
      is_bookmarked: Boolean(s.is_bookmarked),
      note: s.note ?? null,
      first_seen_at: isoAgo(110 - id),
    });
    snapshots[id] = genSeries(s.stars, s.forks, s.issues, s.star_delta, s.points);
  }
})();

// ── 라우터 ──────────────────────────────────────────────────────────────────
export async function mockFetch<T>(
  method: string,
  path: string,
  query?: Record<string, unknown>,
  body?: unknown,
): Promise<T> {
  await delay(280); // 로딩 상태를 보이게 하는 인위적 지연
  const m = method.toUpperCase();

  syncMockBillingParam();

  if (path === '/auth/me' && m === 'GET') return meResponse() as T;
  if (path === '/auth/logout' && m === 'POST') return null as T;
  if (path === '/auth/account' && m === 'DELETE') return null as T;

  if (path === '/billing/me' && m === 'GET') {
    if (billingStalled) return new Promise<T>(() => {}); // stall: 응답 없는 요청 흉내
    return billingMe() as T;
  }
  if (path === '/billing/checkout' && m === 'POST') return createMockCheckout() as T;
  if (path === '/billing/portal' && m === 'POST') return mockPortal() as T;

  if (path === '/queries' && m === 'GET') return listQueries() as T;
  if (path === '/queries' && m === 'POST') return createQuery(body) as T;
  const qId = path.match(/^\/queries\/(\d+)$/);
  if (qId) {
    const id = Number(qId[1]);
    if (m === 'PATCH') return updateQuery(id, body) as T;
    if (m === 'DELETE') return deleteQuery(id) as T;
  }

  if (path === '/repos' && m === 'GET') return listRepos(query) as T;
  const rSnap = path.match(/^\/repos\/(\d+)\/snapshots$/);
  if (rSnap && m === 'GET') return snapshotsOf(Number(rSnap[1])) as T;
  const rId = path.match(/^\/repos\/(\d+)$/);
  if (rId) {
    const id = Number(rId[1]);
    if (m === 'GET') return repoDetail(id) as T;
    if (m === 'PATCH') return updateRepo(id, body) as T;
    if (m === 'DELETE') return deleteRepo(id) as T;
  }

  if (path === '/etl/run' && m === 'POST') return runEtl(query) as T;
  if (path === '/etl/status' && m === 'GET') return etlStatus() as T;

  if (path === '/stats' && m === 'GET') return stats() as T;
  if (path === '/stats/languages' && m === 'GET') return languages() as T;
  if (path === '/trends' && m === 'GET') return trends(query) as T;
  if (path === '/rising' && m === 'GET') return risingRepos(query) as T;
  if (path === '/bookmarks' && m === 'GET') return bookmarks(query) as T;

  throw new ApiError('NOT_FOUND', 404);
}

// ── auth ────────────────────────────────────────────────────────────────────
// ?mockAuth=anon 이면 비로그인 상태(/pricing 등 공개 화면 확인용).
function meResponse(): Me {
  if (new URLSearchParams(window.location.search).get('mockAuth') === 'anon') {
    throw new ApiError('UNAUTHORIZED', 401);
  }
  return { user: { login: 'demo', name: 'Demo User', avatarUrl: null }, tokenInvalid: false, plan: mockPlan() };
}

// ── billing ─────────────────────────────────────────────────────────────────
// 목 전용 상태 전환: ?mockBilling=free|unconfigured|pro|trialing|past_due|canceled|canceled_expired|paused
// (localStorage 에 유지). 결제 시뮬레이션: ?mockCheckout=complete(기본)|delayed|closed|fail|fail_once|stall
// (fail_once: 이 페이지에서 첫 시도만 로드 실패, stall: 결제 완료 후 /billing/me 가 응답하지 않음)
const MOCK_BILLING_STATES = [
  'free', 'unconfigured', 'pro', 'trialing', 'past_due', 'canceled', 'canceled_expired', 'paused',
] as const;
type MockBillingState = (typeof MOCK_BILLING_STATES)[number];
const MOCK_BILLING_KEY = 'trendar.mockBilling';
const MOCK_LIMITS: Record<Plan, PlanLimits> = {
  free: { manualEtlPerDay: 10, queriesPerUser: 10 },
  pro: { manualEtlPerDay: 100, queriesPerUser: 50 },
};
// [status, 기간 종료까지 남은 일수(null=없음)]
const MOCK_SUBSCRIPTIONS: Partial<Record<MockBillingState, [string, number | null]>> = {
  pro: ['active', 21],
  trialing: ['trialing', 7],
  past_due: ['past_due', 2],
  canceled: ['canceled', 12],
  canceled_expired: ['canceled', -5],
  paused: ['paused', null],
};
const DAY_MS = 24 * 60 * 60 * 1000;

function isMockBillingState(value: unknown): value is MockBillingState {
  return MOCK_BILLING_STATES.includes(value as MockBillingState);
}

let billingState: MockBillingState = (() => {
  try {
    const stored = window.localStorage.getItem(MOCK_BILLING_KEY);
    if (isMockBillingState(stored)) return stored;
  } catch {
    // localStorage 차단 시 기본값
  }
  return 'free';
})();
let appliedBillingParam: string | null = null;

function setBillingState(next: MockBillingState) {
  billingState = next;
  try {
    window.localStorage.setItem(MOCK_BILLING_KEY, next);
  } catch {
    // 메모리 상태만 유지
  }
}

// URL 파라미터는 처음 보였을 때만 적용해, 결제 시뮬레이션으로 바뀐 상태를 되돌리지 않는다.
function syncMockBillingParam() {
  const param = new URLSearchParams(window.location.search).get('mockBilling');
  if (param === appliedBillingParam || !isMockBillingState(param)) return;
  appliedBillingParam = param;
  setBillingState(param);
}

function mockSubscription(): BillingSubscription | null {
  const entry = MOCK_SUBSCRIPTIONS[billingState];
  if (!entry) return null;
  const [status, days] = entry;
  return {
    status,
    current_period_end: days === null ? null : new Date(Date.now() + days * DAY_MS).toISOString(),
    price_id: 'pri_mock_pro',
    has_customer: true,
  };
}

// backend services/billing.js planForSubscription 과 같은 규칙
function mockPlan(): Plan {
  const sub = mockSubscription();
  if (!sub) return 'free';
  if (['active', 'trialing', 'past_due'].includes(sub.status)) return 'pro';
  if (sub.status === 'canceled' && sub.current_period_end && new Date(sub.current_period_end) > new Date()) {
    return 'pro';
  }
  return 'free';
}

function billingMe(): BillingInfo {
  const plan = mockPlan();
  const configured = billingState !== 'unconfigured';
  return {
    plan,
    subscription: mockSubscription(),
    configured,
    client: configured ? { token: 'test_mock_client_token', environment: 'sandbox' } : null,
    limits: MOCK_LIMITS,
    usage: {
      queries_used: queries.length,
      queries_limit: MOCK_LIMITS[plan].queriesPerUser,
      manual_used_today: manualUsed,
      manual_limit: MOCK_LIMITS[plan].manualEtlPerDay,
      manual_reset_at: nextKstMidnight(),
    },
  };
}

function createMockCheckout(): CheckoutResult {
  if (billingState === 'unconfigured') throw new ApiError('BILLING_NOT_CONFIGURED', 503);
  if (mockPlan() === 'pro') throw new ApiError('ALREADY_PRO', 409);
  return { transaction_id: `txn_mock_${Date.now()}` };
}

function mockPortal(): PortalResult {
  if (!mockSubscription()?.has_customer) throw new ApiError('NO_SUBSCRIPTION', 404);
  return { portal_url: `${window.location.origin}/account/billing` };
}

let billingStalled = false;
let failedOnce = false;

/** 목 모드에서 Paddle.js 대신 결제창 이벤트를 흉내 낸다. 웹훅 반영은 지연 후 Pro 로 전환. */
export async function mockOpenCheckout({ transactionId, onEvent, signal }: OpenCheckoutOptions): Promise<boolean> {
  const mode = new URLSearchParams(window.location.search).get('mockCheckout') ?? 'complete';
  await delay(400);
  if (mode === 'fail' || (mode === 'fail_once' && !failedOnce)) {
    failedOnce = true;
    throw new Error('Mock Paddle.js load failure');
  }
  if (signal?.aborted) return false;
  console.info(`[mock] Checkout.open ${transactionId}`);
  onEvent({ name: 'checkout.loaded' });
  if (mode === 'closed') {
    setTimeout(() => onEvent({ name: 'checkout.closed' }), 800);
    return true;
  }
  setTimeout(() => {
    onEvent({ name: 'checkout.completed' });
    if (mode === 'stall') billingStalled = true;
    else setTimeout(() => setBillingState('pro'), mode === 'delayed' ? 65_000 : 4_000);
    setTimeout(() => onEvent({ name: 'checkout.closed' }), 1_500);
  }, 800);
  return true;
}

// ── queries ─────────────────────────────────────────────────────────────────
function withCount(q: WatchQuery): WatchQuery {
  return { ...q, repo_count: repos.filter((r) => r.query_id === q.id).length };
}
function listQueries(): WatchQuery[] {
  return queries.map(withCount);
}
function createQuery(body: unknown): WatchQuery {
  const b = (body ?? {}) as { query?: string; query_type?: QueryType };
  const text = (b.query ?? '').trim();
  const type: QueryType = b.query_type === 'topic' ? 'topic' : 'keyword';
  if (text.length < 1 || text.length > 200) {
    throw new ApiError('VALIDATION_ERROR', 400);
  }
  if (queries.length >= MOCK_LIMITS[mockPlan()].queriesPerUser) {
    throw new ApiError('QUERY_LIMIT_EXCEEDED', 400);
  }
  if (queries.some((q) => q.query === text && q.query_type === type)) {
    throw new ApiError('DUPLICATE', 409);
  }
  const created: WatchQuery = {
    id: ++querySeq,
    query: text,
    query_type: type,
    is_active: true,
    repo_count: 0,
    created_at: new Date().toISOString(),
  };
  queries = [...queries, created];
  return created;
}
function updateQuery(id: number, body: unknown): WatchQuery {
  const idx = queries.findIndex((q) => q.id === id);
  if (idx < 0) throw new ApiError('NOT_FOUND', 404);
  const b = (body ?? {}) as Partial<Pick<WatchQuery, 'query' | 'query_type' | 'is_active'>>;
  const next = { ...queries[idx] };
  if (typeof b.query === 'string') next.query = b.query.trim();
  if (b.query_type === 'topic' || b.query_type === 'keyword') next.query_type = b.query_type;
  if (typeof b.is_active === 'boolean') next.is_active = b.is_active;
  queries = queries.map((q) => (q.id === id ? next : q));
  return withCount(next);
}
function deleteQuery(id: number): DeletedResult {
  if (!queries.some((q) => q.id === id)) {
    throw new ApiError('NOT_FOUND', 404);
  }
  queries = queries.filter((q) => q.id !== id);
  const removed = repos.filter((r) => r.query_id === id);
  removed.forEach((r) => delete snapshots[r.id]);
  repos = repos.filter((r) => r.query_id !== id);
  return { deleted: true };
}

// ── repos ───────────────────────────────────────────────────────────────────
function listRepos(query?: Record<string, unknown>): RepoListResult {
  const q = query ?? {};
  const queryId = q.query_id != null && q.query_id !== '' ? Number(q.query_id) : undefined;
  const bookmarked = q.bookmarked === true || q.bookmarked === 'true';
  const search = typeof q.search === 'string' ? q.search.trim().toLowerCase() : '';
  const sort = (q.sort as RepoSort) || 'stars';
  const limit = q.limit != null ? Number(q.limit) : 30;
  const offset = q.offset != null ? Number(q.offset) : 0;

  let list = repos.slice();
  if (queryId) list = list.filter((r) => r.query_id === queryId);
  if (bookmarked) list = list.filter((r) => r.is_bookmarked);
  if (search) {
    list = list.filter(
      (r) =>
        r.full_name.toLowerCase().includes(search) ||
        (r.description ?? '').toLowerCase().includes(search),
    );
  }
  list.sort((a, b) => {
    if (sort === 'growth') return b.growth_rate - a.growth_rate;
    if (sort === 'recent') return cmp(b.first_seen_at, a.first_seen_at);
    return b.stars - a.stars;
  });
  const total = list.length;
  const items = list.slice(offset, offset + limit);
  return { items, total };
}
function repoDetail(id: number): RepoDetailResult {
  const repo = repos.find((r) => r.id === id);
  if (!repo) throw new ApiError('NOT_FOUND', 404);
  return { repo: { ...repo }, snapshots: snapshotsOf(id) };
}
function snapshotsOf(id: number): Snapshot[] {
  return (snapshots[id] ?? []).map((s) => ({ ...s }));
}
function updateRepo(id: number, body: unknown): Repo {
  const idx = repos.findIndex((r) => r.id === id);
  if (idx < 0) throw new ApiError('NOT_FOUND', 404);
  const b = (body ?? {}) as { note?: string; is_bookmarked?: boolean };
  const next = { ...repos[idx] };
  if (typeof b.note === 'string') next.note = b.note;
  if (typeof b.is_bookmarked === 'boolean') next.is_bookmarked = b.is_bookmarked;
  next.updated_at = new Date().toISOString();
  repos = repos.map((r) => (r.id === id ? next : r));
  return { ...next };
}
function deleteRepo(id: number): DeletedResult {
  if (!repos.some((r) => r.id === id)) {
    throw new ApiError('NOT_FOUND', 404);
  }
  repos = repos.filter((r) => r.id !== id);
  delete snapshots[id];
  return { deleted: true };
}

// ── etl ─────────────────────────────────────────────────────────────────────
let manualUsed = 0;

function nextKstMidnight(): string {
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const shifted = new Date(Date.now() + KST_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1) - KST_OFFSET_MS,
  ).toISOString();
}

function runEtl(query?: Record<string, unknown>): EtlRunResult {
  if (manualUsed >= MOCK_LIMITS[mockPlan()].manualEtlPerDay) {
    throw new ApiError('ETL_DAILY_LIMIT_EXCEEDED', 429);
  }
  manualUsed++;
  const queryId = query?.query_id != null && query.query_id !== '' ? Number(query.query_id) : undefined;
  const targets = queryId
    ? repos.filter((r) => r.query_id === queryId)
    : repos.filter((r) => {
        const wq = queries.find((q) => q.id === r.query_id);
        return wq?.is_active;
      });
  const ranAt = new Date().toISOString();
  let snapsInserted = 0;
  for (const r of targets) {
    const delta = Math.max(5, Math.round(r.stars * 0.012));
    r.stars += delta;
    r.star_delta = delta;
    r.growth_rate = delta / Math.max(r.stars - delta, 1);
    const prev = snapshots[r.id]?.[snapshots[r.id].length - 1];
    snapshots[r.id] = [
      ...(snapshots[r.id] ?? []),
      {
        captured_at: ranAt,
        stars: r.stars,
        forks: prev ? prev.forks + Math.round(delta * 0.04) : Math.round(r.stars * 0.03),
        open_issues: prev?.open_issues ?? 0,
        watchers: Math.round(r.stars * 0.4),
      },
    ];
    snapsInserted++;
  }
  repos = repos.slice(); // 참조 갱신
  lastEtlAt = ranAt;
  const queriesProcessed = queryId ? 1 : queries.filter((q) => q.is_active).length;
  return {
    queries_processed: queriesProcessed,
    repos_upserted: targets.length,
    snapshots_inserted: snapsInserted,
    repos_skipped: 0,
    errors: [],
  };
}
function etlStatus(): EtlStatus {
  return {
    last_etl_at: lastEtlAt,
    last_etl_status: lastEtlAt ? 'ok' : null,
    last_etl_message: lastEtlAt ? `쿼리 ${queries.filter((q) => q.is_active).length}건 수집` : null,
    running: false,
    cron: '0 */6 * * *',
    manual_used_today: manualUsed,
    manual_limit: MOCK_LIMITS[mockPlan()].manualEtlPerDay,
    manual_remaining: Math.max(MOCK_LIMITS[mockPlan()].manualEtlPerDay - manualUsed, 0),
    manual_reset_at: nextKstMidnight(),
  };
}

// ── dashboard ────────────────────────────────────────────────────────────────
function stats(): Stats {
  return {
    total_repos: repos.length,
    active_queries: queries.filter((q) => q.is_active).length,
    bookmarked: repos.filter((r) => r.is_bookmarked).length,
    last_etl_at: lastEtlAt,
  };
}
function trends(query?: Record<string, unknown>): TrendRepo[] {
  const limit = query?.limit != null ? Number(query.limit) : 10;
  return repos
    .slice()
    .filter((r) => r.stars >= 1000 && r.star_delta > 0)
    .sort((a, b) => b.growth_rate - a.growth_rate)
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      full_name: r.full_name,
      stars: r.stars,
      star_delta: r.star_delta,
      growth_rate: r.growth_rate,
      language: r.language,
    }));
}
// 신생 급상승 샘플 — 기존 시드 레포 중 일부를 "최근 생성"으로 가장한다 (ids: seed() 순번 기준).
const RISING_SAMPLE: { id: number; ageDays: number }[] = [
  { id: 3, ageDays: 14 }, // schnetzlerjoe/hermes — 2주 전 생성
  { id: 14, ageDays: 63 }, // run-llama/llama-agents — 9주 전 생성
  { id: 4, ageDays: 28 }, // mudrii/hermes-agent-docs — 4주 전 생성
  { id: 9, ageDays: 42 }, // toolhouse-ai/agent-tools — 6주 전 생성
];
const RISING_WINDOW_DAYS = 15;
// rising-score-v3 노출 규칙 근사: rate ≥ 100 그리고 (증가율 ≥ 10% 또는 rate ≥ 500), 점수 = rate / √(나이+1)
const RISING_MIN_RATE = 100;
const RISING_MIN_GROWTH = 0.1;
const RISING_ABS_PASS = 500;
function risingRepos(query?: Record<string, unknown>): RisingRepo[] {
  const limit = query?.limit != null ? Number(query.limit) : 8;
  return RISING_SAMPLE.filter(({ ageDays }) => ageDays <= RISING_WINDOW_DAYS)
    .map(({ id, ageDays }): RisingRepo | null => {
      const r = repos.find((repo) => repo.id === id);
      if (!r) return null;
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const baseline = snapshots[id]
        ?.filter((snapshot) => new Date(snapshot.captured_at).getTime() <= cutoff)
        .at(-1);
      if (!baseline) return null;
      const starDelta24h = r.stars - baseline.stars;
      const growth = starDelta24h / Math.max(baseline.stars, 1);
      if (starDelta24h < RISING_MIN_RATE) return null;
      if (!(growth >= RISING_MIN_GROWTH || starDelta24h >= RISING_ABS_PASS)) return null;
      return {
        id: r.id,
        full_name: r.full_name,
        language: r.language,
        stars: r.stars,
        star_delta: r.star_delta,
        star_delta_24h: starDelta24h,
        growth_rate_24h: growth,
        github_created_at: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString(),
        velocity: Math.round((r.stars / ageDays) * 10) / 10,
        rate_24h: starDelta24h,
        baseline_source: 'snapshot',
        accel: null,
        age_days: ageDays,
        score: starDelta24h / Math.sqrt(ageDays + 1),
      };
    })
    .filter((x): x is RisingRepo => x !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
}
function bookmarks(query?: Record<string, unknown>): BookmarkRepo[] {
  const limit = query?.limit != null ? Number(query.limit) : 8;
  return repos
    .filter((r) => r.is_bookmarked)
    .slice()
    .sort((a, b) => b.stars - a.stars)
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      full_name: r.full_name,
      language: r.language,
      stars: r.stars,
      star_delta: r.star_delta,
    }));
}
function languages(): LanguageStat[] {
  const counts = new Map<string, number>();
  for (const r of repos) {
    if (!r.language) continue;
    counts.set(r.language, (counts.get(r.language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count);
}

// ── utils ───────────────────────────────────────────────────────────────────
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function isoAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function genSeries(
  latestStars: number,
  latestForks: number,
  latestIssues: number,
  perStep: number,
  points: number,
): Snapshot[] {
  const out: Snapshot[] = [];
  const now = Date.now();
  const stepMs = 18 * 60 * 60 * 1000; // ~18h 간격
  for (let ago = points - 1; ago >= 0; ago--) {
    const stars = Math.max(0, latestStars - perStep * ago);
    const forks = Math.max(0, latestForks - Math.round(perStep * 0.04) * ago);
    const issues = Math.max(0, latestIssues - (ago % 2 === 0 ? 0 : 3));
    out.push({
      captured_at: new Date(now - ago * stepMs).toISOString(),
      stars,
      forks,
      open_issues: issues,
      watchers: Math.round(stars * 0.4),
    });
  }
  return out;
}
