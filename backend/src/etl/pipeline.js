import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { pool } from '../config/db.js';
import { extractRepos } from './extract.js';
import { normalizeRepo, computeDelta } from './transform.js';
import { upsertRepo, updateRepoDelta, insertSnapshot, getLastSnapshot } from './load.js';

const MIN_STARS = Number(process.env.ETL_MIN_STARS) || 0;

export const etlState = { last_run_at: null, last_result: null };

export async function runPipeline({ queryId } = {}) {
  const startedAt = new Date();
  const result = { queries_processed: 0, repos_upserted: 0, snapshots_inserted: 0, repos_skipped: 0, errors: [] };

  const [queries] = queryId
    ? await pool.query('SELECT * FROM watch_queries WHERE id=?', [queryId])
    : await pool.query('SELECT * FROM watch_queries WHERE is_active=1');

  for (const wq of queries) {
    try {
      const raw = await extractRepos(wq);
      for (const item of raw) {
        const repo = normalizeRepo(item, wq.id);
        if (!repo.github_id) continue;
        if (repo.stars < MIN_STARS) { result.repos_skipped++; continue; }
        const repoId = await upsertRepo(repo);
        const prev = await getLastSnapshot(repoId);
        const delta = computeDelta(repo, prev);
        await insertSnapshot(repoId, repo);
        await updateRepoDelta(repoId, delta);
        result.repos_upserted++;
        result.snapshots_inserted++;
      }
      result.queries_processed++;
    } catch (e) {
      result.errors.push(`query#${wq.id} ${wq.query}: ${e.message}`);
    }
  }

  etlState.last_run_at = startedAt.toISOString();
  etlState.last_result = result;
  return { ran_at: etlState.last_run_at, ...result };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPipeline()
    .then((r) => { console.log('ETL done:', r); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
