# Ranking v3 rollout

## Scope

24-hour / 7-day snapshot deltas, size-adjusted ranking score, tracked-repository GraphQL refresh, and a 48-hour freshness gate on `/trends`. `star_delta` remains the previous-collection delta for compatibility; `growth_rate` now uses the 24-hour estimate. The ranking/list/detail UI displays `delta_24h` alongside this rate; bookmarks keep their existing previous-collection metric. Demo mock values are synthetic, with score sorting and freshness filtering matching v3 defaults.

## Preflight (requires deployment authorization)

1. Back up the intended MySQL database and verify restore access. Record the current application commit and selected database (`SELECT DATABASE(), VERSION()`). Never infer the database name from `schema.sql`.
2. Test against a disposable MySQL 8 staging copy. Confirm `users`, `repos`, and `repo_snapshots` exist; inspect the five v3 columns and two indexes. Check free space and DDL lock implications on the real table sizes.
3. Stop ETL writers and run migrations from only one process. MySQL DDL is not a transactional rollback boundary. Take care with multiple application replicas: startup migration checks are resumable, not concurrency-safe.
4. Preferred migration: from `backend`, configure the intended staging/approved production database and run `npm run migrate:ranking-v3`. This adds each missing column/index independently and backfills only null `last_refreshed_at` values. Rerun after partial failure. The one-shot SQL file is only for a verified, completely unmigrated schema; select the database explicitly in the client. Do not run that SQL on a partially migrated schema.
5. Verify `node_id`, `delta_24h`, `delta_7d`, `score`, `last_refreshed_at`, `idx_user_score`, and `idx_user_refreshed`. Confirm backfilled timestamps match latest snapshots. Deltas are initially zero, so trends can be empty until successful collection.
6. Deploy backend and frontend together. Test one authorized staging collection with controlled fixtures first, then check `/repos?sort=growth`, `/trends`, and tracked refresh counts. Monitor ETL errors, GraphQL rate limits, DB latency, and snapshot counts. No production credential/API/DB verification has been performed in the cloud checkout.

## Rollback

Stop v3 ETL, restore the previous application version, and leave the additive v3 columns/indexes in place. Older code ignores them. Existing `growth_rate` values retain v3 semantics until older ETL recomputes them; an immediate exact data rollback requires the verified backup or controlled recomputation. Do not drop columns or delete snapshots as a routine rollback. Restore the backup only if necessary and with explicit approval, accounting for writes since backup.

## Known algorithm boundaries

- The proposed algorithm is preserved: an available baseline at/before 24h or 7d is subtracted directly, even if much older than the window. A collection after a long gap can therefore attribute multi-day growth to a 24h delta. The 48h freshness filter does not prevent this once that repo is refreshed. Addressing it needs a product choice (age tolerance, interpolation, or scaling).
- If history is shorter than a window, linear extrapolation uses a minimum elapsed time of one hour. Estimates can exceed current stars and amplify rates for very short histories.
- Repositories without `node_id` cannot be batch-refreshed until rediscovered through search. Repositories last refreshed more than 14 days ago are outside default tracking; each successful refresh renews this window.
- No live MySQL server or GitHub GraphQL calls were exercised. Migration tests mock SQL execution and verify resumability, not MySQL execution plans/locking. Typecheck and production build do not replace interactive UI checks.

## Hardening beyond the supplied patch

- Snapshot-table creation precedes migration backfill, allowing recovery from interrupted initial setup.
- Resumable per-column/index startup and explicit CLI migration; removed the hardcoded `USE trendar` from the one-shot SQL; null-only backfill preserves fresher timestamps.
- UI types, 24-hour gain display, explanatory text, and mock ranking aligned with the new API.
- Partial GraphQL nodes lacking a valid star count are skipped rather than stored as zero. A per-repo write error no longer prevents processing remaining refresh targets.
- GraphQL snapshot `watchers` preserves existing REST `watchers_count` semantics (stargazers), rather than switching the same time series to subscribers.

## Cloud checkout verification

- Supplied patch, before hardening: backend 108 tests passed.
- Final code: backend 115 tests passed, 0 failed (`npm test`). New coverage includes partially applied schema, repeated migration, interrupted backfill retry, invalid GraphQL star data, isolated per-repo write failures, and interrupted initialization with a missing snapshots table.
- Frontend `npm run build`: TypeScript `--noEmit` and Vite production build passed. Vite reports the existing >500 kB bundle-size warning; installed Recharts 2.x also reports deprecation. No dependency upgrades were made.
- `git diff --check`: passed. Explicit migration entrypoint syntax check: passed.
- Dependencies installed from committed lockfiles with npm ci and lifecycle scripts disabled. A writable temporary npm cache was used after the default cache path failed. Neither lockfile changed.
