import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { Octokit } from '@octokit/rest';
import { pool } from '../config/db.js';
import * as publicModel from '../models/public.model.js';
import { allFeeds, feedKey, PUBLIC_MIN_STARS } from '../config/public-feeds.js';
import { publicRisingConfig, risingWindowDays, searchIntervalMs } from '../utils/limits.js';
import { rankRising } from '../services/rising-score.js';
import { createReadmeScanner } from '../services/readme-scan.js';
import * as securityModel from '../models/security.model.js';
import { normalizeRepo } from './transform.js';
import { buildPublicSearchQuery, searchPublicRepos, createPacer } from './public-extract.js';

let running = false;

function safeLogValue(value, token) {
  const text = String(value ?? '-');
  return (token ? text.replaceAll(token, '[redacted]') : text)
    .replace(/authorization[^\r\n]*/gi, '[redacted]')
    .replace(/[\r\n]/g, ' ')
    .slice(0, 200);
}

function logFailure(log, key, error, token) {
  log.error(`[public-etl] ${key} status=${safeLogValue(error?.status ?? error?.code, token)} name=${safeLogValue(error?.name, token)} message=${safeLogValue(error?.message, token)}`);
}

// 판정에 넘기는 메타는 검색 응답에 이미 있는 값만 쓴다(추가 API 호출 없음).
function scanTarget(item) {
  return {
    github_id: item.id, owner: item.owner?.login ?? item.full_name?.split('/')[0], name: item.name, pushed_at: item.pushed_at ?? null,
    language: item.language ?? null, forks: item.forks_count ?? null, size: item.size ?? null,
  };
}

export function createPublicCollector({
  token, createOctokit, feeds, model, normalizeRepo, searchRepos, buildQuery, pacer,
  windowDays, minStars, rankRising, risingConfig, scanRepos, now = () => new Date(), log = console,
}) {
  function isPublicCollectionRunning() {
    return running;
  }

  async function runPublicCollection() {
    if (!token) {
      log.warn('[public-etl] PUBLIC_GITHUB_TOKEN 미설정 — 공개 수집 건너뜀');
      return { skipped: true, reason: 'no_token' };
    }
    if (running) return { skipped: true, reason: 'running' };
    running = true;
    try {
      let configuredFeeds;
      try {
        configuredFeeds = typeof feeds === 'function' ? feeds() : feeds;
      } catch (error) {
        logFailure(log, 'config', error, token);
        return { skipped: true, reason: 'invalid_config' };
      }
      const runStartedAt = new Date(now());
      const createdAfter = new Date(runStartedAt.getTime() - windowDays * 86400000).toISOString().slice(0, 10);
      const feedIds = await model.ensureFeeds(configuredFeeds);
      const octokit = createOctokit(token);
      const seen = new Set();
      const scanTargets = new Map();
      const result = {
        feeds_total: configuredFeeds.length, feeds_ok: 0, feeds_failed: 0,
        repos_upserted: 0, snapshots_inserted: 0, ranks_recorded: 0, aborted: false,
      };
      const collectedFeedIds = [];

      for (const feed of configuredFeeds) {
        const key = feedKey(feed.kind, feed.slug);
        const feedId = feedIds.get(key);
        try {
          await model.markFeedAttempt(feedId, new Date(now()));
          const query = buildQuery(feed, { createdAfter, minStars });
          await pacer.pace();
          const items = await searchRepos(octokit, query);
          for (const item of items) {
            if (item.private === true) continue;
            const repo = normalizeRepo(item);
            const repoId = await model.upsertPublicRepo(repo);
            if (!scanTargets.has(repo.github_id)) scanTargets.set(repo.github_id, scanTarget(item));
            result.repos_upserted++;
            if (!seen.has(repo.github_id)) {
              await model.insertPublicSnapshot(repoId, repo, new Date(now()));
              seen.add(repo.github_id);
              result.snapshots_inserted++;
            }
            await model.upsertFeedMembership(feedId, repoId, runStartedAt);
          }
          await model.markFeedResult(feedId, { status: 'ok', errorCode: null, at: new Date(now()) });
          result.feeds_ok++;
          collectedFeedIds.push(feedId);
        } catch (error) {
          result.feeds_failed++;
          logFailure(log, key, error, token);
          try {
            await model.markFeedResult(feedId, {
              status: 'error',
              errorCode: safeLogValue(error?.status ?? error?.code ?? error?.name, token).slice(0, 64),
              at: new Date(now()),
            });
          } catch (recordError) {
            logFailure(log, `${key} record`, recordError, token);
          }
          if (error?.status === 401) {
            result.aborted = true;
            break;
          }
        }
      }
      if (!result.aborted) {
        await scanCollected(octokit, [...scanTargets.values()]);
        await recordRanks(collectedFeedIds, runStartedAt, result);
      }
      return result;
    } finally {
      running = false;
    }
  }

  // 판정 실패는 수집·순위 기록을 막지 않는다(R4.2). 순위 기록 전에 판정해 malicious를 기록에서 뺀다.
  async function scanCollected(octokit, targets) {
    if (!scanRepos || !targets.length) return;
    try {
      await scanRepos(octokit, targets);
    } catch (error) {
      log.error(`[public-etl] readme-scan failed name=${safeLogValue(error?.name, token)} code=${safeLogValue(error?.code ?? error?.status, token)}`);
    }
  }

  // 순위는 나중에 소급할 수 없으므로 수집 직후의 피드별 상위 50을 실행 시각과 함께 남긴다.
  async function recordRanks(feedIdList, capturedAt, result) {
    for (const feedId of feedIdList) {
      try {
        const candidates = await model.feedCandidates(feedId, { windowDays });
        const rows = rankRising(candidates, { ...risingConfig, limit: 50 }, new Date(now()));
        await model.insertRankHistory(feedId, capturedAt, rows);
        result.ranks_recorded += rows.length;
      } catch (error) {
        logFailure(log, `rank feed=${feedId}`, error, token);
      }
    }
  }

  return { runPublicCollection, isPublicCollectionRunning };
}

export const { runPublicCollection, isPublicCollectionRunning } = createPublicCollector({
  token: process.env.PUBLIC_GITHUB_TOKEN,
  createOctokit: (token) => new Octokit({ auth: token, log: { debug() {}, info() {}, warn() {}, error() {} } }),
  feeds: allFeeds,
  model: publicModel,
  normalizeRepo,
  searchRepos: searchPublicRepos,
  buildQuery: buildPublicSearchQuery,
  pacer: createPacer({ intervalMs: searchIntervalMs() }),
  windowDays: risingWindowDays(),
  minStars: PUBLIC_MIN_STARS,
  rankRising,
  risingConfig: publicRisingConfig(),
  scanRepos: createReadmeScanner({ model: securityModel }).scanRepos,
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log('[public-etl] done', await runPublicCollection());
  } catch (error) {
    logFailure(console, 'collection', error, process.env.PUBLIC_GITHUB_TOKEN);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
