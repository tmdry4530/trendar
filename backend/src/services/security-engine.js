// @ts-check
// Thin Node.js wrapper over the Rust NAPI-RS native security engine (trendar-engine-napi).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_ADDON_PATH = path.resolve(__dirname, '../../native/trendar_engine.node');
const DEFAULT_RULES_DIR = path.resolve(__dirname, '../../../rules');

const require = createRequire(import.meta.url);

let nativeAddon = null;
let loadError = null;

function loadNative() {
  if (nativeAddon) return nativeAddon;
  if (loadError) throw loadError;
  try {
    if (!fs.existsSync(NATIVE_ADDON_PATH)) {
      throw new Error(
        `Rust native addon missing at ${NATIVE_ADDON_PATH}. Run "npm run build:engine" in backend/.`,
      );
    }
    const addon = require(NATIVE_ADDON_PATH);
    // Load external YAML ruleset if TRENDAR_RULES_DIR is set or default rules/ directory exists.
    const rulesDir = process.env.TRENDAR_RULES_DIR || (fs.existsSync(DEFAULT_RULES_DIR) ? DEFAULT_RULES_DIR : null);
    if (rulesDir) {
      addon.loadRulesDir(rulesDir);
    }
    nativeAddon = addon;
    return nativeAddon;
  } catch (err) {
    loadError = err;
    throw err;
  }
}

export function isNativeLoaded() {
  try {
    return Boolean(loadNative());
  } catch {
    return false;
  }
}

/**
 * Sanitize JS repo meta into strict NAPI-RS types (non-numeric forks/size rejected cleanly).
 * @param {any} meta
 */
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const str = (v) => (typeof v === 'string' && v.length > 0 ? v : undefined);
  return {
    owner: str(meta.owner),
    name: str(meta.name),
    language: str(meta.language),
    forks: num(meta.forks),
    size: num(meta.size),
    stars: num(meta.stars),
    homepage: str(meta.homepage),
    description: str(meta.description),
    topics: Array.isArray(meta.topics) ? meta.topics.filter((t) => typeof t === 'string') : undefined,
    ownerAccountAgeDays: num(meta.ownerAccountAgeDays ?? meta.owner_account_age_days),
  };
}

/**
 * @param {{ enableMultilingual?: boolean, enableMetadataScoring?: boolean } | undefined} options
 */
function sanitizeOptions(options) {
  if (!options || typeof options !== 'object') return null;
  return {
    enableMultilingual: typeof options.enableMultilingual === 'boolean' ? options.enableMultilingual : undefined,
    enableMetadataScoring: typeof options.enableMetadataScoring === 'boolean' ? options.enableMetadataScoring : undefined,
  };
}

function normalizeTraits(raw) {
  return {
    textKey: raw.textKey ?? null,
    skeletonKey: raw.skeletonKey ?? null,
    simhash: raw.simhash ?? null,
    lure: Boolean(raw.lure),
    archiveFilehostUrl: raw.archiveFilehostUrl ?? null,
    shortenerUrls: Array.isArray(raw.shortenerUrls) ? raw.shortenerUrls : [],
    ownPagesLure: Boolean(raw.ownPagesLure),
  };
}

function normalizeReport(raw) {
  return {
    verdict: raw.verdict,
    riskLevel: raw.riskLevel,
    score: raw.score,
    ruleVersion: raw.ruleVersion,
    rulesetHash: raw.rulesetHash,
    evidence: raw.evidence ?? null,
    signals: Array.isArray(raw.signals) ? raw.signals : [],
    traits: normalizeTraits(raw.traits ?? {}),
  };
}

export function engineInfo() {
  return loadNative().engineInfo();
}

/** @param {string} dir */
export function loadRulesDir(dir) {
  return loadNative().loadRulesDir(dir);
}

/**
 * Synchronous full v4 analysis (Rust DFA + Markdown AST + Shell Lexer + Scoring + Traits).
 * @param {string | null | undefined} text
 * @param {any} [meta]
 * @param {{ enableMultilingual?: boolean, enableMetadataScoring?: boolean }} [options]
 */
export function analyzeReadme(text, meta, options) {
  const input = typeof text === 'string' ? text : null;
  const raw = loadNative().analyzeReadme(input, sanitizeMeta(meta), sanitizeOptions(options));
  return normalizeReport(raw);
}

/**
 * Non-blocking async analysis executed on libuv worker threads so Express HTTP is never stalled.
 * @param {string | null | undefined} text
 * @param {any} [meta]
 * @param {{ enableMultilingual?: boolean, enableMetadataScoring?: boolean }} [options]
 */
export async function analyzeReadmeAsync(text, meta, options) {
  const input = typeof text === 'string' ? text : null;
  const raw = await loadNative().analyzeReadmeAsync(input, sanitizeMeta(meta), sanitizeOptions(options));
  return normalizeReport(raw);
}

/**
 * Full v4 classification (used by benchmarks and new callers).
 * @param {string | null | undefined} text
 * @param {any} [meta]
 * @param {{ enableMultilingual?: boolean, enableMetadataScoring?: boolean }} [options]
 */
export function classifyReadme(text, meta, options) {
  return analyzeReadme(text, meta, options);
}

/**
 * Campaign fingerprint & lure traits extraction (includes 64-bit SimHash).
 * @param {string | null | undefined} text
 * @param {{ owner?: string, name?: string }} [repo]
 */
export function readmeTraits(text, repo) {
  const input = typeof text === 'string' ? text : null;
  const owner = typeof repo?.owner === 'string' ? repo.owner : null;
  const name = typeof repo?.name === 'string' ? repo.name : null;
  return normalizeTraits(loadNative().extractTraits(input, owner, name));
}

/**
 * Hamming distance between two 64-bit SimHash hex strings.
 * @param {string} a
 * @param {string} b
 * @returns {number | null}
 */
export function simhashDistance(a, b) {
  const d = loadNative().simhashDistance(String(a), String(b));
  return typeof d === 'number' ? d : null;
}

/**
 * Batch campaign cluster evaluation (exact textKey + skeletonKey + fuzzy SimHash + Origin Repo Protection).
 * @param {Array<Record<string, any>>} candidates
 */
export function evaluateClusters(candidates) {
  const json = loadNative().evaluateClustersJson(JSON.stringify(candidates ?? []));
  return JSON.parse(json);
}

/**
 * Opt-in static manifest & Git tree threat analysis (package.json, setup.py, .vscode/tasks.json, .csproj, decoy binaries).
 * Default OFF in the standard README scan pipeline; invoke explicitly when enabled.
 * @param {{ files?: Array<{ path: string, content: string }>, tree?: Array<{ path: string, size: number }> }} input
 */
export function analyzeManifest(input) {
  const json = loadNative().analyzeManifestJson(JSON.stringify(input ?? { files: [], tree: [] }));
  return JSON.parse(json);
}
