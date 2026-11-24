use aho_corasick::{AhoCorasick, AhoCorasickBuilder};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::path::Path;

const DEFAULT_RULESET_YAML: &str = include_str!("../../../../rules/ruleset.yaml");
const DEFAULT_EXEC_YAML: &str = include_str!("../../../../rules/exec-patterns.yaml");
const DEFAULT_PROFF_YAML: &str = include_str!("../../../../rules/protection-off.yaml");
const DEFAULT_DOMAINS_YAML: &str = include_str!("../../../../rules/domains-and-lures.yaml");
const DEFAULT_MANIFEST_YAML: &str = include_str!("../../../../rules/manifest-threats.yaml");

#[derive(Debug)]
pub enum RuleError {
    Io(String),
    Parse(String),
    Regex(String),
    Validation(String),
}

impl fmt::Display for RuleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RuleError::Io(e) => write!(f, "rule I/O error: {e}"),
            RuleError::Parse(e) => write!(f, "rule parse error: {e}"),
            RuleError::Regex(e) => write!(f, "rule regex compile error: {e}"),
            RuleError::Validation(e) => write!(f, "rule validation error: {e}"),
        }
    }
}

impl std::error::Error for RuleError {}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LimitsConfig {
    pub max_readme_bytes: usize,
    pub max_segment_chars: usize,
    pub max_decodes: usize,
    pub max_encoded_chars: usize,
    pub max_evidence_chars: usize,
    pub run_window: usize,
    pub max_saved_names: usize,
    pub max_runner_depth: usize,
    pub min_text_key_chars: usize,
    pub min_skeleton_headings: usize,
    pub max_lure_url_chars: usize,
    pub new_account_days: u64,
    pub codeless_max_size_kb: i64,
    pub cluster_min_owners: usize,
    pub simhash_max_distance: u32,
    pub entropy_min_token_len: usize,
    pub entropy_threshold: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WeightsConfig {
    pub remote_exec: i32,
    pub lolbin_exec: i32,
    pub obfuscated_exec_bonus: i32,
    pub protection_off_direct: i32,
    pub protection_off_command: i32,
    pub protection_off_generic_codeless: i32,
    pub protection_off_multilingual: i32,
    pub homoglyph_or_zerowidth: i32,
    pub high_entropy_payload: i32,
    pub filehost_archive_url: i32,
    pub homepage_filehost_archive: i32,
    pub description_crack_lure: i32,
    pub typosquat_brand: i32,
    pub codeless_meta: i32,
    pub new_account: i32,
    pub star_anomaly_codeless: i32,
    pub shortener_url: i32,
    pub security_research_penalty: i32,
    pub manifest_malicious_script: i32,
    pub manifest_autorun_task: i32,
    pub manifest_binary_decoy_tree: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ScoringConfig {
    pub malicious_threshold: i32,
    pub suspicious_threshold: i32,
    #[serde(default)]
    pub require_hard_combo_for_readme_only: bool,
    pub weights: WeightsConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MasterRulesetYaml {
    pub version: u32,
    pub ruleset_id: String,
    pub description: String,
    #[serde(default)]
    pub includes: Vec<String>,
    pub limits: LimitsConfig,
    pub scoring: ScoringConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PatternRuleYaml {
    pub id: String,
    pub description: String,
    pub pattern: String,
    #[serde(default)]
    pub weight: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PipeInterpretersYaml {
    pub powershell: Vec<String>,
    pub shell: Vec<String>,
    pub scripting: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ExecPatternsYaml {
    pub fetch_tools: Vec<String>,
    pub save_tools: Vec<String>,
    pub pipe_interpreters: PipeInterpretersYaml,
    pub runners: Vec<String>,
    pub inert_commands: Vec<String>,
    pub wrappers: Vec<String>,
    pub readers: Vec<String>,
    pub lolbin_patterns: Vec<PatternRuleYaml>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MultilingualRuleYaml {
    pub id: String,
    pub lang: String,
    pub positive: String,
    pub negation: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProtectionOffYaml {
    pub direct_patterns: Vec<PatternRuleYaml>,
    pub command_patterns: Vec<PatternRuleYaml>,
    pub generic_codeless_pattern: String,
    pub multilingual_rules: Vec<MultilingualRuleYaml>,
    pub security_research_indicators: Vec<String>,
    pub state_description_patterns: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DomainsAndLuresYaml {
    pub archive_extensions: Vec<String>,
    pub filehost_domains: Vec<String>,
    pub shortener_domains: Vec<String>,
    pub crack_lure_phrases: Vec<String>,
    pub brand_targets: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ManifestThreatsYaml {
    pub npm_dangerous_hooks: Vec<String>,
    pub manifest_command_patterns: Vec<PatternRuleYaml>,
    pub vscode_autorun_weight: i32,
    pub binary_extensions: Vec<String>,
    pub source_extensions: Vec<String>,
}

pub struct CompiledPatternRule {
    pub id: String,
    pub description: String,
    pub regex: Regex,
    pub weight: i32,
}

pub struct CompiledMultilingualRule {
    pub id: String,
    pub lang: String,
    pub positive: Regex,
    pub negation: Regex,
}

pub struct CompiledRuleset {
    pub version: u32,
    pub ruleset_id: String,
    pub ruleset_hash: String,
    pub limits: LimitsConfig,
    pub scoring: ScoringConfig,

    // Exec
    pub fetch_tools: HashSet<String>,
    pub save_tools: HashSet<String>,
    pub ps_interpreters: HashSet<String>,
    pub shell_interpreters: HashSet<String>,
    pub script_interpreters: HashSet<String>,
    pub runners: HashSet<String>,
    pub inert_commands: HashSet<String>,
    pub wrappers: HashSet<String>,
    pub readers: HashSet<String>,
    pub lolbin_rules: Vec<CompiledPatternRule>,

    // Protection off
    pub direct_proff_rules: Vec<CompiledPatternRule>,
    pub command_proff_rules: Vec<CompiledPatternRule>,
    pub generic_codeless_regex: Regex,
    pub multilingual_rules: Vec<CompiledMultilingualRule>,
    pub security_research_regexes: Vec<Regex>,
    pub state_description_regexes: Vec<Regex>,

    // Domains & Lures
    pub archive_extensions: HashSet<String>,
    pub filehost_domains: Vec<String>,
    pub shortener_domains: Vec<String>,
    pub crack_lure_ac: AhoCorasick,
    pub crack_lure_phrases: Vec<String>,
    pub brand_targets: Vec<String>,

    // Manifest (opt-in)
    pub npm_dangerous_hooks: HashSet<String>,
    pub manifest_command_rules: Vec<CompiledPatternRule>,
    pub vscode_autorun_weight: i32,
    pub binary_extensions: HashSet<String>,
    pub source_extensions: HashSet<String>,
}

fn compile_regex(pattern: &str, label: &str) -> Result<Regex, RuleError> {
    RegexBuilder::new(pattern)
        .size_limit(10 * 1024 * 1024)
        .dfa_size_limit(10 * 1024 * 1024)
        .build()
        .map_err(|e| RuleError::Regex(format!("{label}: {e}")))
}

impl CompiledRuleset {
    pub fn default_embedded() -> Result<Self, RuleError> {
        Self::from_yaml_parts(
            DEFAULT_RULESET_YAML,
            DEFAULT_EXEC_YAML,
            DEFAULT_PROFF_YAML,
            DEFAULT_DOMAINS_YAML,
            DEFAULT_MANIFEST_YAML,
        )
    }

    pub fn load_from_dir<P: AsRef<Path>>(dir: P) -> Result<Self, RuleError> {
        let dir = dir.as_ref();
        let read = |name: &str| -> Result<String, RuleError> {
            let p = dir.join(name);
            fs::read_to_string(&p)
                .map_err(|e| RuleError::Io(format!("failed reading {}: {e}", p.display())))
        };
        let master = read("ruleset.yaml")?;
        let exec = read("exec-patterns.yaml")?;
        let proff = read("protection-off.yaml")?;
        let domains = read("domains-and-lures.yaml")?;
        let manifest = read("manifest-threats.yaml")?;
        Self::from_yaml_parts(&master, &exec, &proff, &domains, &manifest)
    }

    pub fn from_yaml_parts(
        master_yaml: &str,
        exec_yaml: &str,
        proff_yaml: &str,
        domains_yaml: &str,
        manifest_yaml: &str,
    ) -> Result<Self, RuleError> {
        let master: MasterRulesetYaml =
            serde_yaml::from_str(master_yaml).map_err(|e| RuleError::Parse(format!("ruleset.yaml: {e}")))?;
        let exec: ExecPatternsYaml =
            serde_yaml::from_str(exec_yaml).map_err(|e| RuleError::Parse(format!("exec-patterns.yaml: {e}")))?;
        let proff: ProtectionOffYaml =
            serde_yaml::from_str(proff_yaml).map_err(|e| RuleError::Parse(format!("protection-off.yaml: {e}")))?;
        let domains: DomainsAndLuresYaml =
            serde_yaml::from_str(domains_yaml).map_err(|e| RuleError::Parse(format!("domains-and-lures.yaml: {e}")))?;
        let manifest: ManifestThreatsYaml =
            serde_yaml::from_str(manifest_yaml).map_err(|e| RuleError::Parse(format!("manifest-threats.yaml: {e}")))?;

        if master.limits.max_readme_bytes == 0 || master.limits.max_decodes == 0 {
            return Err(RuleError::Validation("limits must be positive".into()));
        }
        if master.scoring.malicious_threshold <= 0 {
            return Err(RuleError::Validation("malicious_threshold must be > 0".into()));
        }

        let mut hasher = Sha256::new();
        for part in [master_yaml, exec_yaml, proff_yaml, domains_yaml, manifest_yaml] {
            hasher.update(part.as_bytes());
            hasher.update(b"\n---\n");
        }
        let ruleset_hash = hex::encode(hasher.finalize())[..16].to_string();

        let compile_list = |list: Vec<PatternRuleYaml>| -> Result<Vec<CompiledPatternRule>, RuleError> {
            list.into_iter()
                .map(|r| {
                    let regex = compile_regex(&r.pattern, &r.id)?;
                    Ok(CompiledPatternRule {
                        id: r.id,
                        description: r.description,
                        regex,
                        weight: r.weight,
                    })
                })
                .collect()
        };

        let lolbin_rules = compile_list(exec.lolbin_patterns)?;
        let direct_proff_rules = compile_list(proff.direct_patterns)?;
        let command_proff_rules = compile_list(proff.command_patterns)?;
        let generic_codeless_regex = compile_regex(&proff.generic_codeless_pattern, "generic_codeless_pattern")?;

        let multilingual_rules = proff
            .multilingual_rules
            .into_iter()
            .map(|r| {
                let positive = compile_regex(&r.positive, &format!("{}:positive", r.id))?;
                let negation = compile_regex(&r.negation, &format!("{}:negation", r.id))?;
                Ok(CompiledMultilingualRule {
                    id: r.id,
                    lang: r.lang,
                    positive,
                    negation,
                })
            })
            .collect::<Result<Vec<_>, RuleError>>()?;

        let security_research_regexes = proff
            .security_research_indicators
            .iter()
            .enumerate()
            .map(|(i, p)| compile_regex(p, &format!("security_research_indicators[{i}]")))
            .collect::<Result<Vec<_>, RuleError>>()?;

        let state_description_regexes = proff
            .state_description_patterns
            .iter()
            .enumerate()
            .map(|(i, p)| compile_regex(p, &format!("state_description_patterns[{i}]")))
            .collect::<Result<Vec<_>, RuleError>>()?;

        let manifest_command_rules = compile_list(manifest.manifest_command_patterns)?;

        let crack_lure_phrases: Vec<String> = domains
            .crack_lure_phrases
            .into_iter()
            .map(|s| s.to_lowercase())
            .collect();
        let crack_lure_ac = AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .build(&crack_lure_phrases)
            .map_err(|e| RuleError::Regex(format!("crack_lure_ac: {e}")))?;

        let to_set = |v: Vec<String>| -> HashSet<String> {
            v.into_iter().map(|s| s.to_lowercase()).collect()
        };

        Ok(Self {
            version: master.version,
            ruleset_id: master.ruleset_id,
            ruleset_hash,
            limits: master.limits,
            scoring: master.scoring,
            fetch_tools: to_set(exec.fetch_tools),
            save_tools: to_set(exec.save_tools),
            ps_interpreters: to_set(exec.pipe_interpreters.powershell),
            shell_interpreters: to_set(exec.pipe_interpreters.shell),
            script_interpreters: to_set(exec.pipe_interpreters.scripting),
            runners: to_set(exec.runners),
            inert_commands: to_set(exec.inert_commands),
            wrappers: to_set(exec.wrappers),
            readers: to_set(exec.readers),
            lolbin_rules,
            direct_proff_rules,
            command_proff_rules,
            generic_codeless_regex,
            multilingual_rules,
            security_research_regexes,
            state_description_regexes,
            archive_extensions: to_set(domains.archive_extensions),
            filehost_domains: domains.filehost_domains.into_iter().map(|s| s.to_lowercase()).collect(),
            shortener_domains: domains.shortener_domains.into_iter().map(|s| s.to_lowercase()).collect(),
            crack_lure_ac,
            crack_lure_phrases,
            brand_targets: domains.brand_targets.into_iter().map(|s| s.to_lowercase()).collect(),
            npm_dangerous_hooks: to_set(manifest.npm_dangerous_hooks),
            manifest_command_rules,
            vscode_autorun_weight: manifest.vscode_autorun_weight,
            binary_extensions: to_set(manifest.binary_extensions),
            source_extensions: to_set(manifest.source_extensions),
        })
    }

    pub fn is_filehost(&self, host: &str) -> bool {
        let lower = host.to_lowercase();
        self.filehost_domains
            .iter()
            .any(|d| lower == *d || lower.ends_with(&format!(".{d}")))
    }

    pub fn is_shortener(&self, host: &str) -> bool {
        let lower = host.to_lowercase();
        self.shortener_domains
            .iter()
            .any(|d| lower == *d || lower.ends_with(&format!(".{d}")))
    }
}
