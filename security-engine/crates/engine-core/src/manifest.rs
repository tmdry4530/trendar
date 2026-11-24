use crate::rules::CompiledRuleset;
use crate::scoring::SignalHit;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ManifestFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TreeEntry {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ManifestInput {
    #[serde(default)]
    pub files: Vec<ManifestFile>,
    #[serde(default)]
    pub tree: Vec<TreeEntry>,
    /// Expected host of a GitHub Pages setup/download link for this repository.
    #[serde(default, rename = "pagesHost", alias = "pages_host")]
    pub pages_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestReport {
    pub verdict: String,
    pub score: i32,
    pub evidence: Option<String>,
    pub signals: Vec<SignalHit>,
}

fn setup_py_danger_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?is)\bcmdclass\b.{0,800}(?:os\.system|subprocess\.(?:Popen|run|call|check_output)|urllib|requests\.get|exec\s*\()").unwrap()
    })
}

fn csproj_build_event_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?is)<(?:PreBuildEvent|PostBuildEvent|Exec\s+Command)[^>]*>.{0,400}(?:powershell|pwsh|cmd\.exe|mshta|certutil|curl|wget|http://|https://)").unwrap()
    })
}

fn analyze_package_json(path: &str, content: &str, rules: &CompiledRuleset, signals: &mut Vec<SignalHit>) -> i32 {
    let Ok(val) = serde_json::from_str::<Value>(content) else {
        return 0;
    };
    let Some(scripts) = val.get("scripts").and_then(|s| s.as_object()) else {
        return 0;
    };
    let mut score = 0i32;
    for (hook, cmd_val) in scripts {
        if !rules.npm_dangerous_hooks.contains(&hook.to_lowercase()) {
            continue;
        }
        let Some(cmd) = cmd_val.as_str() else {
            continue;
        };
        for rule in &rules.manifest_command_rules {
            if rule.regex.is_match(cmd) {
                score += rule.weight;
                signals.push(SignalHit {
                    rule_id: rule.id.clone(),
                    category: "manifest".into(),
                    weight: rule.weight,
                    detail: format!(
                        "{path} scripts.{hook}: {}",
                        crate::normalize::truncate_utf8_bytes(cmd, 120)
                    ),
                });
                break;
            }
        }
    }
    score
}

fn analyze_vscode_tasks(path: &str, content: &str, rules: &CompiledRuleset, signals: &mut Vec<SignalHit>) -> i32 {
    let Ok(val) = serde_json::from_str::<Value>(content) else {
        return 0;
    };
    let Some(tasks) = val.get("tasks").and_then(|t| t.as_array()) else {
        return 0;
    };
    let mut score = 0i32;
    for task in tasks {
        let run_on = task
            .get("runOptions")
            .and_then(|r| r.get("runOn"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !run_on.eq_ignore_ascii_case("folderOpen") {
            continue;
        }
        let cmd = task.get("command").and_then(|v| v.as_str()).unwrap_or("");
        let suspicious = rules.manifest_command_rules.iter().any(|r| r.regex.is_match(cmd))
            || cmd.to_lowercase().contains("powershell")
            || cmd.to_lowercase().contains("curl")
            || cmd.to_lowercase().contains("wget")
            || cmd.to_lowercase().contains("bash")
            || cmd.to_lowercase().contains("cmd");
        if suspicious {
            score += rules.vscode_autorun_weight;
            signals.push(SignalHit {
                rule_id: "MAN-VSCODE-FOLDEROPEN".into(),
                category: "manifest".into(),
                weight: rules.vscode_autorun_weight,
                detail: format!(
                    "{path} folderOpen task: {}",
                    crate::normalize::truncate_utf8_bytes(cmd, 120)
                ),
            });
        }
    }
    score
}

fn analyze_git_tree(tree: &[TreeEntry], rules: &CompiledRuleset, signals: &mut Vec<SignalHit>) -> i32 {
    if tree.is_empty() {
        return 0;
    }
    let mut source_count = 0usize;
    let mut binary_hits: Vec<&str> = Vec::new();
    let mut total_binary_bytes = 0u64;

    for entry in tree {
        let lower = entry.path.to_lowercase();
        let filename = lower.rsplit('/').next().unwrap_or(&lower);
        if let Some((_, ext)) = filename.rsplit_once('.') {
            if rules.source_extensions.contains(ext) {
                source_count += 1;
            } else if rules.binary_extensions.contains(ext) {
                binary_hits.push(&entry.path);
                total_binary_bytes = total_binary_bytes.saturating_add(entry.size);
            }
        }
    }

    // Decoy binary-only repo: zero source code files + executable/archive payloads present
    if source_count == 0 && !binary_hits.is_empty() && total_binary_bytes >= 10_000 {
        let w = rules.scoring.weights.manifest_binary_decoy_tree;
        signals.push(SignalHit {
            rule_id: "MAN-TREE-BINARY-DECOY".into(),
            category: "manifest_tree".into(),
            weight: w,
            detail: format!(
                "0 source files, {} binary/archive files ({} bytes): {}",
                binary_hits.len(),
                total_binary_bytes,
                binary_hits[..binary_hits.len().min(3)].join(", ")
            ),
        });
        return w;
    }
    0
}

fn github_pages_host(host: &str) -> Option<String> {
    if host.len() > 63 + ".github.io".len() {
        return None;
    }
    let host = host.to_ascii_lowercase();
    let owner = host.strip_suffix(".github.io")?;
    if owner.is_empty() || owner.starts_with('-') || owner.ends_with('-')
        || !owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return None;
    }
    Some(host)
}

/// Opt-in static analysis for repository manifests, Git trees, and README-linked Pages entry points.
pub fn analyze_manifest(input: &ManifestInput, rules: &CompiledRuleset) -> ManifestReport {
    let mut signals = Vec::new();
    let mut score = 0i32;
    let mut pages_host = input.pages_host.as_deref().and_then(github_pages_host);

    for file in &input.files {
        let lower_path = file.path.to_lowercase();
        let capped = crate::normalize::truncate_utf8_bytes(&file.content, rules.limits.max_readme_bytes);
        if matches!(file.path.as_str(), "index.html" | "docs/index.html") {
            let weight = rules.scoring.weights.pages_obfuscated_redirect;
            if let Some(host) = pages_host.as_deref().filter(|_| weight > 0) {
                if let Some(detail) = crate::web::analyze_web_landing(capped, host) {
                    score += weight;
                    signals.push(SignalHit {
                        rule_id: "WEB-OBFUSCATED-DOWNLOAD-REDIRECT".into(),
                        category: "web_landing".into(),
                        weight,
                        detail: format!("{}: {detail}", file.path),
                    });
                    // Duplicate entry points for one landing page count as one signal.
                    pages_host = None;
                }
            }
        } else if lower_path == "package.json" || lower_path.ends_with("/package.json") {
            score += analyze_package_json(&file.path, capped, rules, &mut signals);
        } else if lower_path.ends_with(".vscode/tasks.json") {
            score += analyze_vscode_tasks(&file.path, capped, rules, &mut signals);
        } else if lower_path == "setup.py" || lower_path.ends_with("/setup.py") {
            if setup_py_danger_re().is_match(capped) {
                let w = rules.scoring.weights.manifest_malicious_script;
                score += w;
                signals.push(SignalHit {
                    rule_id: "MAN-SETUPPY-CMDCLASS".into(),
                    category: "manifest".into(),
                    weight: w,
                    detail: format!("{} defines cmdclass with shell/network execution", file.path),
                });
            }
        } else if lower_path.ends_with(".csproj") && csproj_build_event_re().is_match(capped) {
            let w = rules.scoring.weights.manifest_malicious_script;
            score += w;
            signals.push(SignalHit {
                rule_id: "MAN-CSPROJ-BUILDEVENT".into(),
                category: "manifest".into(),
                weight: w,
                detail: format!("{} build event executes shell/network command", file.path),
            });
        }
    }

    score += analyze_git_tree(&input.tree, rules, &mut signals);

    let clamped = score.clamp(0, 100);
    let malicious = clamped >= rules.scoring.malicious_threshold;
    let evidence = if malicious {
        Some(
            signals
                .iter()
                .map(|s| format!("[{}] {}", s.rule_id, s.detail))
                .collect::<Vec<_>>()
                .join(" | "),
        )
    } else {
        None
    };

    ManifestReport {
        verdict: if malicious { "malicious" } else { "clean" }.into(),
        score: clamped,
        evidence,
        signals,
    }
}
