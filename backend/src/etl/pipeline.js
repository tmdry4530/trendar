import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { Octokit } from '@octokit/rest';
import { pool } from '../config/db.js';
import * as usersModel from '../models/user.model.js';
import { decryptToken } from '../utils/crypto.js';
import { httpError } from '../middleware/errorHandler.js';
import { extractRepos } from './extract.js';
import { normalizeRepo, computeDelta, computeRankingDelta as defaultComputeRankingDelta } from './transform.js';
import {
  upsertRepo, updateRepoDelta, insertSnapshot, getLastSnapshot, getDeltaBaselines, findTrackedRepos,
} from './load.js';
import { trendWindowDays, trendMinStars, trackedRefreshDays } from '../utils/limits.js';

const MIN_STARS = Number(process.env.ETL_MIN_STARS) || 0;
const TOKEN_INVALID_MESSAGE = 'GitHub 연결이 유효하지 않습니다. 다시 로그인해 주세요.';
// GraphQL nodes(ids:) 한 번에 조회할 수 있는 최대 ID 수.
export const REFRESH_BATCH_SIZE = 100;

// 추적 레포 배치 갱신 쿼리 — open_issues는 REST open_issues_count와 맞추려 이슈+PR 합산.
export const REFRESH_NODES_QUERY = `query ($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Repository {
      id
      databaseId
      stargazerCount
      forkCount
      issues(states: OPEN) { totalCount }
      pullRequests(states: OPEN) { totalCount }
    }
  }
}`;

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function nodeToMetrics(node) {
  return {
    stars: node.stargazerCount ?? 0,
    forks: node.forkCount ?? 0,
    open_issues: (node.issues?.totalCount ?? 0) + (node.pullRequests?.totalCount ?? 0),
    // Preserve REST watchers_count semantics: stargazers, not subscribers.
    watchers: node.stargazerCount,
  };
}

// 수집 루프에 진입하기 전(=아직 아무 작업도 하지 않은) 거부임을 표시한다.
// 컨트롤러는 이 플래그를 보고서만 일일 한도를 환불한다 — 루프 도중 실패는 환불하지 않는다.
function preflightError(status, code, message) {
  const e = httpError(status, code, message);
  e.refundable = true;
  return e;
}

async function defaultQueryFn(userId, queryId) {
  const [rows] = queryId
    ? await pool.query('SELECT * FROM watch_queries WHERE id=? AND user_id=?', [queryId, userId])
    : await pool.query('SELECT * FROM watch_queries WHERE is_active=1 AND user_id=?', [userId]);
  return rows;
}

export function createEtlRunner(deps) {
  const {
    users,
    decryptToken,
    createOctokit,
    extractRepos,
    normalizeRepo,
    computeDelta,
    computeRankingDelta = defaultComputeRankingDelta,
    loaders: { upsertRepo, updateRepoDelta, insertSnapshot, getLastSnapshot, getDeltaBaselines, findTrackedRepos },
    queryFn,
  } = deps;

  const running = new Set();

  function isRunning(userId) {
    return running.has(userId);
  }

  // 스냅샷 1행 적재 + 델타 재계산. 레거시 star_delta는 직전 스냅샷 대비, 나머지는 시간 정규화 (랭킹 v3).
  async function recordSnapshot(repoId, metrics, { updateStars = false } = {}) {
    const prev = await getLastSnapshot(repoId);
    const legacy = computeDelta(metrics, prev);
    await insertSnapshot(repoId, metrics);
    const baselines = getDeltaBaselines ? await getDeltaBaselines(repoId) : {};
    const ranking = computeRankingDelta(metrics.stars, baselines);
    await updateRepoDelta(repoId, {
      star_delta: legacy.star_delta,
      ...ranking,
      ...(updateStars ? { stars: metrics.stars } : {}),
    });
  }

  // 검색 top-N에서 빠진 추적 레포를 GraphQL nodes(ids:)로 100개씩 갱신한다.
  // node_id가 없는 레포는 건너뛰고(다음 검색 적중 시 저장됨), 401은 호출자에게 그대로 던진다.
  async function refreshTrackedRepos(userId, octokit, seen, result) {
    if (!findTrackedRepos) return;
    const tracked = await findTrackedRepos(userId, trackedRefreshDays());
    const targets = [];
    for (const r of tracked) {
      if (seen.has(Number(r.github_id))) continue; // 이번 실행에서 이미 적재됨
      if (!r.node_id) { result.refresh_skipped_no_node_id++; continue; }
      targets.push(r);
    }
    for (const batch of chunk(targets, REFRESH_BATCH_SIZE)) {
      let nodes;
      try {
        const data = await octokit.graphql(REFRESH_NODES_QUERY, { ids: batch.map((r) => r.node_id) });
        nodes = data?.nodes ?? [];
      } catch (e) {
        if (e.status === 401) throw e;
        // 일부 ID가 삭제·비공개 전환되면 GraphQL은 errors와 함께 부분 data를 준다 — 남은 노드는 살린다.
        if (Array.isArray(e.data?.nodes)) {
          nodes = e.data.nodes;
        } else {
          console.error(`[etl] user#${userId} 추적 레포 갱신 실패:`, e);
          result.errors.push('추적 중인 프로젝트를 갱신하지 못했습니다.');
          continue;
        }
      }
      const byNodeId = new Map(nodes.filter((n) => n && n.id).map((n) => [n.id, n]));
      for (const r of batch) {
        const node = byNodeId.get(r.node_id);
        if (!node) continue; // 삭제·접근 불가 레포
        if (!Number.isInteger(node.stargazerCount) || node.stargazerCount < 0) {
          result.errors.push('추적 중인 프로젝트의 스타 수를 확인하지 못했습니다.');
          continue; // Partial GraphQL data must not turn a missing metric into zero stars.
        }
        try {
          await recordSnapshot(r.id, nodeToMetrics(node), { updateStars: true });
          seen.add(Number(r.github_id));
          result.repos_refreshed++;
          result.snapshots_inserted++;
        } catch (e) {
          console.error(`[etl] user#${userId} repo#${r.id} 추적 레포 저장 실패:`, e);
          result.errors.push('추적 중인 프로젝트를 갱신하지 못했습니다.');
        }
      }
    }
  }

  async function failTokenInvalid(userId) {
    await users.setTokenInvalid(userId);
    await users.updateEtlResult(userId, { status: 'token_invalid', message: TOKEN_INVALID_MESSAGE });
    throw httpError(409, 'GITHUB_TOKEN_INVALID', TOKEN_INVALID_MESSAGE);
  }

  async function runPipelineForUser(userId, { queryId } = {}) {
    if (running.has(userId)) {
      throw preflightError(409, 'ETL_ALREADY_RUNNING', '이미 수집이 진행 중입니다.');
    }
    running.add(userId);
    try {
      const user = await users.findById(userId);
      if (!user || !user.access_token_enc || user.token_invalid) {
        throw preflightError(409, 'GITHUB_TOKEN_INVALID', TOKEN_INVALID_MESSAGE);
      }

      let token;
      try {
        token = decryptToken(user.access_token_enc);
      } catch (e) {
        console.error(`[etl] user#${userId} 토큰 복호화 실패:`, e.message);
        await users.setTokenInvalid(userId);
        await users.updateEtlResult(userId, { status: 'token_invalid', message: TOKEN_INVALID_MESSAGE });
        throw preflightError(409, 'GITHUB_TOKEN_INVALID', TOKEN_INVALID_MESSAGE);
      }

      const octokit = createOctokit(token);
      const result = {
        queries_processed: 0, repos_upserted: 0, snapshots_inserted: 0, repos_skipped: 0,
        repos_refreshed: 0, refresh_skipped_no_node_id: 0, errors: [],
      };
      const queries = await queryFn(userId, queryId);

      // 실행(run) 단위 dedup — 슬라이스·조건 간 같은 github_id는 1회만 적재해 스냅샷 오염을 막는다 (R3).
      const seen = new Set();
      // 신생 슬라이스의 created:> 하한. 나이는 실행 시점 기준이면 충분하므로 실행당 1회만 계산해 재사용한다.
      const createdAfter = new Date(Date.now() - trendWindowDays() * 86400000).toISOString().slice(0, 10);

      for (const wq of queries) {
        // base=스타순 베이스라인, trend=신생(created:>) 슬라이스. 슬라이스별 스타 하한이 다르다 (R1).
        const slices = [
          { label: 'base', minStars: MIN_STARS },
          { label: 'trend', minStars: trendMinStars(), createdAfter },
        ];
        for (const slice of slices) {
          try {
            const raw = await extractRepos(wq, octokit, { minStars: slice.minStars, createdAfter: slice.createdAfter });
            for (const item of raw) {
              const repo = normalizeRepo(item, wq.id, userId);
              if (!repo.github_id) continue;
              if (seen.has(repo.github_id)) continue; // 이미 적재된 레포 — 카운트 증가 없이 스킵 (R3.1/R3.2)
              if (repo.stars < slice.minStars) { result.repos_skipped++; continue; }
              const repoId = await upsertRepo(repo);
              await recordSnapshot(repoId, repo); // last_refreshed_at=NOW() 포함
              seen.add(repo.github_id);
              result.repos_upserted++;
              result.snapshots_inserted++;
            }
          } catch (e) {
            console.error(`[etl] user#${userId} query#${wq.id} [${slice.label}] 수집 실패:`, e);
            if (e.status === 401) await failTokenInvalid(userId);
            result.errors.push('수집 조건을 처리하지 못했습니다.');
          }
        }
        result.queries_processed++;
      }

      // 검색 슬라이스 밖으로 밀려난 추적 레포 갱신 — 오래된 델타가 계속 노출되는 것을 막는다.
      try {
        await refreshTrackedRepos(userId, octokit, seen, result);
      } catch (e) {
        if (e.status === 401) await failTokenInvalid(userId);
        console.error(`[etl] user#${userId} 추적 레포 갱신 실패:`, e);
        result.errors.push('추적 중인 프로젝트를 갱신하지 못했습니다.');
      }

      const status = result.errors.length ? 'error' : 'ok';
      const message = result.errors.length
        ? `수집 조건 ${result.queries_processed}개를 처리하는 중 일부 항목을 수집하지 못했습니다.`
        : `수집 조건 ${result.queries_processed}개에서 프로젝트 ${result.repos_upserted}개를 수집했습니다.`
          + (result.repos_refreshed ? ` 추적 중인 프로젝트 ${result.repos_refreshed}개도 갱신했습니다.` : '');
      await users.updateEtlResult(userId, { status, message });
      return result;
    } finally {
      running.delete(userId);
    }
  }

  async function runPipelineAllUsers() {
    const list = await users.findAllWithValidToken();
    let users_ok = 0;
    let users_failed = 0;
    for (const u of list) {
      try {
        const r = await runPipelineForUser(u.id);
        users_ok++;
        console.log(`[etl] user#${u.id} ${u.login}: ok — queries=${r.queries_processed} upserted=${r.repos_upserted} refreshed=${r.repos_refreshed} snapshots=${r.snapshots_inserted} skipped=${r.repos_skipped} errors=${r.errors.length}`);
      } catch (e) {
        users_failed++;
        console.log(`[etl] user#${u.id} ${u.login}: failed — ${e.code || e.message}`);
      }
    }
    return { users_total: list.length, users_ok, users_failed };
  }

  return { runPipelineForUser, runPipelineAllUsers, isRunning };
}

export const { runPipelineForUser, runPipelineAllUsers, isRunning } = createEtlRunner({
  users: usersModel,
  decryptToken,
  createOctokit: (token) => new Octokit({ auth: token }),
  extractRepos,
  normalizeRepo,
  computeDelta,
  loaders: { upsertRepo, updateRepoDelta, insertSnapshot, getLastSnapshot, getDeltaBaselines, findTrackedRepos },
  queryFn: defaultQueryFn,
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPipelineAllUsers()
    .then((r) => { console.log('ETL done:', r); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
