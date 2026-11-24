use rayon::prelude::*;
use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;
use std::time::Instant;
use trendar_engine_core::{
    ClusterCandidate, ManifestInput, RepoMeta, ScanOptions, SecurityEngine,
};

#[derive(Serialize)]
struct DirScanSummary {
    rule_version: u32,
    ruleset_hash: String,
    total_files: usize,
    total_bytes: usize,
    elapsed_ms: f64,
    docs_per_sec: f64,
    mb_per_sec: f64,
    direct_malicious: usize,
    cluster_hidden: usize,
    protected_origins: usize,
    suspicious: usize,
}

fn print_usage() {
    eprintln!(
        "trendar-scan — Trendar Rust Security Analysis CLI\n\n\
         USAGE:\n\
         \ttrendar-scan validate-rules [--rules <dir>]\n\
         \ttrendar-scan scan-file <readme.md> [--owner <o>] [--name <n>] [--lang <l>] [--forks <n>] [--size <kb>] [--homepage <url>] [--desc <text>] [--rules <dir>]\n\
         \ttrendar-scan scan-dir <dir> [--rules <dir>] [--json]\n\
         \ttrendar-scan scan-manifest <input.json> [--rules <dir>]"
    );
}

fn load_engine(rules_dir: Option<&str>) -> SecurityEngine {
    let res = match rules_dir {
        Some(dir) => SecurityEngine::from_rules_dir(dir),
        None => SecurityEngine::default_engine(),
    };
    match res {
        Ok(e) => e,
        Err(err) => {
            eprintln!("error: {err}");
            process::exit(2);
        }
    }
}

fn collect_md_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_md_files(&p, out);
        } else if p.extension().is_some_and(|e| e == "md") {
            out.push(p);
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() || args[0] == "-h" || args[0] == "--help" {
        print_usage();
        return;
    }

    let get_opt = |flag: &str| -> Option<String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };

    let rules_dir = get_opt("--rules");

    match args[0].as_str() {
        "validate-rules" => {
            let eng = load_engine(rules_dir.as_deref());
            println!(
                "{}",
                serde_json::json!({
                    "ok": true,
                    "rule_version": eng.rule_version(),
                    "ruleset_id": eng.rules().ruleset_id,
                    "ruleset_hash": eng.ruleset_hash(),
                    "filehost_domains": eng.rules().filehost_domains.len(),
                    "lolbin_rules": eng.rules().lolbin_rules.len(),
                    "multilingual_rules": eng.rules().multilingual_rules.len(),
                })
            );
        }
        "scan-file" => {
            let Some(file_path) = args.get(1) else {
                eprintln!("error: missing <readme.md> path");
                process::exit(2);
            };
            let eng = load_engine(rules_dir.as_deref());
            let content = fs::read_to_string(file_path).unwrap_or_else(|e| {
                eprintln!("error: failed reading {file_path}: {e}");
                process::exit(2);
            });
            let meta = RepoMeta {
                owner: get_opt("--owner"),
                name: get_opt("--name"),
                language: get_opt("--lang"),
                forks: get_opt("--forks").and_then(|v| v.parse().ok()),
                size: get_opt("--size").and_then(|v| v.parse().ok()),
                homepage: get_opt("--homepage"),
                description: get_opt("--desc"),
                ..Default::default()
            };
            let report = eng.analyze_readme(Some(&content), Some(&meta), ScanOptions::default());
            println!("{}", serde_json::to_string_pretty(&report).unwrap());
        }
        "scan-dir" => {
            let Some(dir_path) = args.get(1) else {
                eprintln!("error: missing <dir> path");
                process::exit(2);
            };
            let eng = load_engine(rules_dir.as_deref());
            let mut files = Vec::new();
            collect_md_files(Path::new(dir_path), &mut files);
            files.sort();

            let docs: Vec<(i64, String, String, String)> = files
                .iter()
                .enumerate()
                .filter_map(|(i, p)| {
                    let text = fs::read_to_string(p).ok()?;
                    let stem = p.file_stem()?.to_string_lossy().to_string();
                    let (owner, name) = match stem.split_once('_') {
                        Some((o, n)) => (o.to_string(), n.to_string()),
                        None => ("unknown".to_string(), stem),
                    };
                    Some((i as i64 + 1, owner, name, text))
                })
                .collect();

            let total_bytes: usize = docs.iter().map(|d| d.3.len()).sum();
            let started = Instant::now();

            let results: Vec<(i64, String, trendar_engine_core::AnalysisReport)> = docs
                .par_iter()
                .map(|(gid, owner, name, text)| {
                    let meta = RepoMeta {
                        owner: Some(owner.clone()),
                        name: Some(name.clone()),
                        ..Default::default()
                    };
                    let report = eng.analyze_readme(Some(text), Some(&meta), ScanOptions::default());
                    (*gid, owner.clone(), report)
                })
                .collect();

            let candidates: Vec<ClusterCandidate> = results
                .iter()
                .map(|(gid, owner, r)| ClusterCandidate {
                    github_id: *gid,
                    owner_login: owner.to_lowercase(),
                    text_key: r.traits.text_key.clone(),
                    skeleton_key: r.traits.skeleton_key.clone(),
                    simhash: r.traits.simhash.clone(),
                    lure: r.traits.lure,
                    direct_malicious: r.verdict == "malicious",
                    language: None,
                    forks: None,
                    repo_age_days: None,
                })
                .collect();

            let clusters = eng.evaluate_clusters(&candidates);
            let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;

            let direct_malicious = results.iter().filter(|(_, _, r)| r.verdict == "malicious").count();
            let suspicious = results.iter().filter(|(_, _, r)| r.risk_level == "medium").count();

            let summary = DirScanSummary {
                rule_version: eng.rule_version(),
                ruleset_hash: eng.ruleset_hash().to_string(),
                total_files: docs.len(),
                total_bytes,
                elapsed_ms: (elapsed_ms * 100.0).round() / 100.0,
                docs_per_sec: ((docs.len() as f64 / (elapsed_ms / 1000.0)) * 10.0).round() / 10.0,
                mb_per_sec: (((total_bytes as f64 / (1024.0 * 1024.0)) / (elapsed_ms / 1000.0)) * 100.0).round() / 100.0,
                direct_malicious,
                cluster_hidden: clusters.hidden_ids.len(),
                protected_origins: clusters.protected_origin_ids.len(),
                suspicious,
            };
            println!("{}", serde_json::to_string_pretty(&summary).unwrap());
        }
        "scan-manifest" => {
            let Some(json_path) = args.get(1) else {
                eprintln!("error: missing <input.json> path");
                process::exit(2);
            };
            let eng = load_engine(rules_dir.as_deref());
            let raw = fs::read_to_string(json_path).unwrap_or_else(|e| {
                eprintln!("error: failed reading {json_path}: {e}");
                process::exit(2);
            });
            let input: ManifestInput = serde_json::from_str(&raw).unwrap_or_else(|e| {
                eprintln!("error: invalid manifest JSON: {e}");
                process::exit(2);
            });
            let report = eng.analyze_manifest(&input);
            println!("{}", serde_json::to_string_pretty(&report).unwrap());
        }
        other => {
            eprintln!("error: unknown subcommand '{other}'");
            print_usage();
            process::exit(2);
        }
    }
}
