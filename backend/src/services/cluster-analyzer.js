// @ts-check
// Cluster analysis orchestration service — separates campaign clustering policy (exact + SimHash + Origin Protection)
// from DB persistence (security.model.js).
import { evaluateClusters } from './security-engine.js';

/**
 * Evaluates clusters across candidate verdict rows using the Rust engine
 * (exact text_key, exact skeleton_key, 64-bit SimHash Hamming <= 5, and Origin Repo Protection).
 *
 * @param {Array<{
 *   github_id: number,
 *   owner_login: string,
 *   text_key?: string | null,
 *   skeleton_key?: string | null,
 *   simhash?: string | null,
 *   lure: boolean,
 *   direct_malicious?: boolean,
 *   language?: string | null,
 *   forks?: number | null,
 *   repo_age_days?: number | null,
 * }>} candidates
 */
export function analyzeCampaignClusters(candidates) {
  const normalized = candidates.map((c) => ({
    github_id: Number(c.github_id),
    owner_login: String(c.owner_login ?? '').toLowerCase(),
    text_key: c.text_key ?? null,
    skeleton_key: c.skeleton_key ?? null,
    simhash: c.simhash ?? null,
    lure: Boolean(c.lure),
    direct_malicious: Boolean(c.direct_malicious),
    language: c.language ?? null,
    forks: typeof c.forks === 'number' ? c.forks : null,
    repo_age_days: typeof c.repo_age_days === 'number' ? c.repo_age_days : null,
  }));
  return evaluateClusters(normalized);
}
