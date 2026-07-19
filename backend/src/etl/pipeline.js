import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { Octokit } from '@octokit/rest';
import { pool } from '../config/db.js';
import * as usersModel from '../models/user.model.js';
import { decryptToken } from '../utils/crypto.js';
import { httpError } from '../middleware/errorHandler.js';
import { extractRepos } from './extract.js';
import { normalizeRepo, computeDelta } from './transform.js';
import { upsertRepo, updateRepoDelta, insertSnapshot, getLastSnapshot } from './load.js';
import { trendWindowDays, trendMinStars } from '../utils/limits.js';

const MIN_STARS = Number(process.env.ETL_MIN_STARS) || 0;
const TOKEN_INVALID_MESSAGE = 'GitHub 연결이 유효하지 않습니다. 다시 로그인해 주세요.';

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
    loaders: { upsertRepo, updateRepoDelta, insertSnapshot, getLastSnapshot },
    queryFn,
  } = deps;

  const running = new Set();

  function isRunning(userId) {
    return running.has(userId);
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
        await users.updateEtlResult(userId, { status: 'token_invalid', message: 'GitHub 토큰 복호화에 실패했습니다.' });
        throw preflightError(409, 'GITHUB_TOKEN_INVALID', TOKEN_INVALID_MESSAGE);
      }

      const octokit = createOctokit(token);
      const result = { queries_processed: 0, repos_upserted: 0, snapshots_inserted: 0, repos_skipped: 0, errors: [] };
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
              const prev = await getLastSnapshot(repoId);
              const delta = computeDelta(repo, prev);
              await insertSnapshot(repoId, repo);
              await updateRepoDelta(repoId, delta);
              seen.add(repo.github_id);
              result.repos_upserted++;
              result.snapshots_inserted++;
            }
          } catch (e) {
            console.error(`[etl] user#${userId} query#${wq.id} [${slice.label}] 수집 실패:`, e);
            if (e.status === 401) {
              await users.setTokenInvalid(userId);
              await users.updateEtlResult(userId, { status: 'token_invalid', message: 'GitHub 인증에 실패했습니다 (401).' });
              throw httpError(409, 'GITHUB_TOKEN_INVALID', TOKEN_INVALID_MESSAGE);
            }
            result.errors.push(`query#${wq.id} ${wq.query} [${slice.label}]: ${e.message}`);
          }
        }
        result.queries_processed++;
      }

      const status = result.errors.length ? 'error' : 'ok';
      const message = result.errors.length
        ? result.errors.join('; ')
        : `쿼리 ${result.queries_processed}건, 저장소 ${result.repos_upserted}건 수집`;
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
        console.log(`[etl] user#${u.id} ${u.login}: ok — queries=${r.queries_processed} upserted=${r.repos_upserted} snapshots=${r.snapshots_inserted} skipped=${r.repos_skipped} errors=${r.errors.length}`);
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
  loaders: { upsertRepo, updateRepoDelta, insertSnapshot, getLastSnapshot },
  queryFn: defaultQueryFn,
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPipelineAllUsers()
    .then((r) => { console.log('ETL done:', r); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
