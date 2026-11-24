use crate::decode::{decode_encoded_payloads, find_high_entropy_tokens};
use crate::fingerprint::{extract_traits, has_archive_extension, ReadmeTraits};
use crate::markdown::parse_document;
use crate::normalize::normalize_anti_evasion;
use crate::protection::{is_security_research_context, match_protection_off_sentence, ProtectionOffKind};
use crate::rules::CompiledRuleset;
use crate::shell::find_remote_exec;
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RepoMeta {
    pub owner: Option<String>,
    pub name: Option<String>,
    pub language: Option<String>,
    pub forks: Option<i64>,
    pub size: Option<i64>,
    pub stars: Option<i64>,
    pub homepage: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub topics: Vec<String>,
    pub owner_account_age_days: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ScanOptions {
    pub enable_multilingual: bool,
    pub enable_metadata_scoring: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            enable_multilingual: true,
            enable_metadata_scoring: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalHit {
    pub rule_id: String,
    pub category: String,
    pub weight: i32,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisReport {
    pub verdict: String,       // "malicious" | "clean"
    pub risk_level: String,    // "high" | "medium" | "low"
    pub score: i32,
    pub rule_version: u32,
    pub ruleset_hash: String,
    pub evidence: Option<String>,
    pub signals: Vec<SignalHit>,
    pub traits: ReadmeTraits,
}

pub fn is_codeless(meta: Option<&RepoMeta>, max_size_kb: i64) -> bool {
    let Some(m) = meta else {
        return false;
    };
    if let Some(ref lang) = m.language {
        if !lang.is_empty() {
            return false;
        }
    }
    let (Some(forks), Some(size)) = (m.forks, m.size) else {
        return false;
    };
    forks == 0 && size >= 0 && size <= max_size_kb
}

/// Computes bounded Levenshtein edit distance (O(n*m), only called on short repo names <= 64 chars).
pub fn levenshtein(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let m = a_chars.len();
    let n = b_chars.len();
    if m == 0 {
        return n;
    }
    if n == 0 {
        return m;
    }
    let mut prev: Vec<usize> = (0..=n).collect();
    let mut curr = vec![0usize; n + 1];
    for i in 1..=m {
        curr[0] = i;
        for j in 1..=n {
            let cost = usize::from(a_chars[i - 1] != b_chars[j - 1]);
            curr[j] = (prev[j] + 1)
                .min(curr[j - 1] + 1)
                .min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[n]
}

fn normalize_repo_slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_dash = false;
    for ch in s.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Checks if a repository name impersonates or typosquats a known high-value brand target.
pub fn detect_brand_typosquat(repo_name: &str, rules: &CompiledRuleset) -> Option<String> {
    let slug = normalize_repo_slug(repo_name);
    if slug.len() < 5 || slug.len() > 64 {
        return None;
    }
    let compact: String = slug.chars().filter(|&c| c != '-').collect();
    for brand in &rules.brand_targets {
        let brand_compact: String = brand.chars().filter(|&c| c != '-').collect();
        // Substring match with crack/free/bypass suffix or exact impersonation
        if slug == *brand
            || slug.starts_with(&format!("{brand}-"))
            || compact == brand_compact
        {
            return Some(brand.clone());
        }
        // Typo match (Levenshtein <= 2 on similar lengths >= 7)
        if brand_compact.len() >= 7
            && compact.len().abs_diff(brand_compact.len()) <= 2
            && levenshtein(&compact, &brand_compact) <= 2
        {
            return Some(brand.clone());
        }
    }
    None
}

fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((idx, _)) => s[..idx].to_string(),
        None => s.to_string(),
    }
}

pub fn analyze_readme_full(
    text: Option<&str>,
    meta: Option<&RepoMeta>,
    options: ScanOptions,
    rules: &CompiledRuleset,
) -> AnalysisReport {
    let raw_text = text.unwrap_or("");
    let codeless = is_codeless(meta, rules.limits.codeless_max_size_kb);
    let mut signals: Vec<SignalHit> = Vec::new();
    let mut score: i32 = 0;

    if raw_text.is_empty() && meta.is_none() {
        return AnalysisReport {
            verdict: "clean".into(),
            risk_level: "low".into(),
            score: 0,
            rule_version: rules.version,
            ruleset_hash: rules.ruleset_hash.clone(),
            evidence: None,
            signals,
            traits: ReadmeTraits::default(),
        };
    }

    // Stage 1: Anti-evasion normalization
    let norm = normalize_anti_evasion(raw_text, rules.limits.max_readme_bytes);

    // Stage 2: Structural Markdown + command/sentence parsing
    let primary_doc = parse_document(&norm.text, true);

    // Stage 2b: Extract campaign traits using raw_sanitized text (preserves original URL text while IDNA-matching) + resolved AST links
    let traits = extract_traits(
        &norm.raw_sanitized,
        meta.and_then(|m| m.owner.as_deref()),
        meta.and_then(|m| m.name.as_deref()),
        &primary_doc.links,
        rules,
    );

    // Stage 3: Primary + decoded payload inspection (PowerShell -enc, shell base64, hex, FromBase64String)
    let (primary_cmds, mut exec_hit) = find_remote_exec(
        &primary_doc.raw_commands,
        &primary_doc.blocks,
        &primary_doc.is_real_command,
        rules,
    );

    let mut proff_hit = primary_doc.sentences.iter().find_map(|s| {
        match_protection_off_sentence(s, codeless, options.enable_multilingual, rules)
    });

    let decoded_payloads = decode_encoded_payloads(
        &primary_cmds,
        &primary_doc.raw_commands,
        rules.limits.max_decodes,
        rules.limits.max_encoded_chars,
    );

    let mut decoded_triggered = false;
    for payload in &decoded_payloads {
        if exec_hit.is_some() && proff_hit.is_some() {
            break;
        }
        let sub_doc = parse_document(&payload.text, false);
        if exec_hit.is_none() {
            let (_, sub_exec) = find_remote_exec(
                &sub_doc.raw_commands,
                &sub_doc.blocks,
                &sub_doc.is_real_command,
                rules,
            );
            if let Some(mut hit) = sub_exec {
                hit.obfuscated = true;
                exec_hit = Some(hit);
                decoded_triggered = true;
            }
        }
        if proff_hit.is_none() {
            if let Some(hit) = sub_doc.sentences.iter().find_map(|s| {
                match_protection_off_sentence(s, codeless, options.enable_multilingual, rules)
            }) {
                proff_hit = Some(hit);
                decoded_triggered = true;
            }
        }
    }

    // Entropy check on code blocks
    let high_entropy = find_high_entropy_tokens(
        &primary_doc.code_lines,
        rules.limits.entropy_min_token_len,
        rules.limits.entropy_threshold,
    );

    // Stage 4: Score accumulation
    let w = &rules.scoring.weights;

    if let Some(ref ex) = exec_hit {
        let weight = if ex.rule_id.starts_with("EXEC-LOLBIN") {
            w.lolbin_exec
        } else {
            w.remote_exec
        };
        score += weight;
        signals.push(SignalHit {
            rule_id: ex.rule_id.clone(),
            category: "remote_exec".into(),
            weight,
            detail: truncate_chars(&ex.evidence, 180),
        });
        if ex.obfuscated || decoded_triggered {
            score += w.obfuscated_exec_bonus;
            signals.push(SignalHit {
                rule_id: "OBF-EXEC".into(),
                category: "obfuscation".into(),
                weight: w.obfuscated_exec_bonus,
                detail: "obfuscated or encoded execution payload".into(),
            });
        }
    }

    if let Some(ref po) = proff_hit {
        let weight = match po.kind {
            ProtectionOffKind::Direct => w.protection_off_direct,
            ProtectionOffKind::Command => w.protection_off_command,
            ProtectionOffKind::GenericCodeless => w.protection_off_generic_codeless,
            ProtectionOffKind::Multilingual => w.protection_off_multilingual,
        };
        score += weight;
        signals.push(SignalHit {
            rule_id: po.rule_id.clone(),
            category: "protection_off".into(),
            weight,
            detail: truncate_chars(&po.sentence, 180),
        });
    }

    let has_evasion_chars = norm.homoglyph_count > 0 || norm.zero_width_count > 0;
    if has_evasion_chars && (exec_hit.is_some() || proff_hit.is_some()) {
        score += w.homoglyph_or_zerowidth;
        signals.push(SignalHit {
            rule_id: "OBF-UNICODE".into(),
            category: "obfuscation".into(),
            weight: w.homoglyph_or_zerowidth,
            detail: format!(
                "zero_width={} homoglyphs={}",
                norm.zero_width_count, norm.homoglyph_count
            ),
        });
    }

    if !high_entropy.is_empty() {
        score += w.high_entropy_payload;
        signals.push(SignalHit {
            rule_id: "OBF-HIGH-ENTROPY".into(),
            category: "entropy".into(),
            weight: w.high_entropy_payload,
            detail: format!("entropy={:.2} sample={}...", high_entropy[0].1, high_entropy[0].0),
        });
    }

    // Security research / blue-team context mitigation (prevents FP on Sigma/YARA/MITRE docs with real code)
    let has_real_code = meta.is_some_and(|m| {
        m.language.as_deref().is_some_and(|l| !l.is_empty()) && m.forks.unwrap_or(0) > 0
    });
    let research_context = is_security_research_context(
        &norm.text,
        meta.and_then(|m| m.description.as_deref()),
        has_real_code,
        rules,
    );
    if research_context && (exec_hit.is_some() || proff_hit.is_some()) {
        score += w.security_research_penalty;
        signals.push(SignalHit {
            rule_id: "CTX-SECURITY-RESEARCH".into(),
            category: "mitigation".into(),
            weight: w.security_research_penalty,
            detail: "blue-team/research indicators with real source code".into(),
        });
    }

    // Stage 5: Metadata & Typosquatting signals (homepage, description, brand impersonation, star anomaly)
    let mut homepage_archive_lure = false;
    let mut crack_lure_found = false;
    let mut typosquat_hit: Option<String> = None;
    let mut homepage_evidence: Option<String> = None;

    if options.enable_metadata_scoring {
        if let Some(m) = meta {
            // Homepage URL check (free Search API metadata)
            if let Some(ref hp) = m.homepage {
                if let Ok(parsed) = Url::parse(hp.trim()) {
                    if matches!(parsed.scheme(), "http" | "https") {
                        if let Some(host) = parsed.host_str() {
                            let is_fh = rules.is_filehost(host);
                            let is_arch = has_archive_extension(parsed.path(), rules);
                            if (is_fh && is_arch) || is_fh {
                                homepage_archive_lure = true;
                                homepage_evidence = Some(truncate_chars(hp.trim(), 200));
                                score += w.homepage_filehost_archive;
                                signals.push(SignalHit {
                                    rule_id: "META-HOMEPAGE-FILEHOST".into(),
                                    category: "metadata".into(),
                                    weight: w.homepage_filehost_archive,
                                    detail: format!("homepage filehost: {}", truncate_chars(hp.trim(), 120)),
                                });
                            }
                        }
                    }
                }
            }

            // Description crack/piracy lure keywords
            if let Some(ref desc) = m.description {
                if let Some(mat) = rules.crack_lure_ac.find(desc) {
                    crack_lure_found = true;
                    let phrase = &rules.crack_lure_phrases[mat.pattern().as_usize()];
                    score += w.description_crack_lure;
                    signals.push(SignalHit {
                        rule_id: "META-DESC-CRACK-LURE".into(),
                        category: "metadata".into(),
                        weight: w.description_crack_lure,
                        detail: format!("description contains '{phrase}'"),
                    });
                }
            }

            // Brand typosquatting / impersonation
            if let Some(ref rname) = m.name {
                if let Some(brand) = detect_brand_typosquat(rname, rules) {
                    typosquat_hit = Some(brand.clone());
                    score += w.typosquat_brand;
                    signals.push(SignalHit {
                        rule_id: "META-TYPOSQUAT-BRAND".into(),
                        category: "metadata".into(),
                        weight: w.typosquat_brand,
                        detail: format!("repo name '{rname}' impersonates '{brand}'"),
                    });
                }
            }

            if codeless {
                score += w.codeless_meta;
                signals.push(SignalHit {
                    rule_id: "META-CODELESS".into(),
                    category: "metadata".into(),
                    weight: w.codeless_meta,
                    detail: "no language, 0 forks, size <= 100KB".into(),
                });
                if m.stars.unwrap_or(0) >= 100 {
                    score += w.star_anomaly_codeless;
                    signals.push(SignalHit {
                        rule_id: "META-STAR-ANOMALY".into(),
                        category: "metadata".into(),
                        weight: w.star_anomaly_codeless,
                        detail: format!("codeless repo with {} stars", m.stars.unwrap_or(0)),
                    });
                }
            }

            if let Some(age) = m.owner_account_age_days {
                if age >= 0 && (age as u64) <= rules.limits.new_account_days {
                    score += w.new_account;
                    signals.push(SignalHit {
                        rule_id: "META-NEW-ACCOUNT".into(),
                        category: "metadata".into(),
                        weight: w.new_account,
                        detail: format!("owner account age {age} days"),
                    });
                }
            }
        }
    }

    if let Some(ref url) = traits.archive_filehost_url {
        score += w.filehost_archive_url;
        signals.push(SignalHit {
            rule_id: "TRAIT-FILEHOST-ARCHIVE".into(),
            category: "lure".into(),
            weight: w.filehost_archive_url,
            detail: truncate_chars(url, 160),
        });
    }

    if !traits.shortener_urls.is_empty() {
        score += w.shortener_url;
        signals.push(SignalHit {
            rule_id: "TRAIT-URL-SHORTENER".into(),
            category: "lure".into(),
            weight: w.shortener_url,
            detail: traits.shortener_urls[0].clone(),
        });
    }

    let clamped_score = score.clamp(0, 100);

    // Anti-FP Decision Gate:
    // 1. Classic & Evasion README combo: remote_exec + protection_off (respecting security-research mitigation)
    let combo_exec_proff =
        exec_hit.is_some() && proff_hit.is_some() && clamped_score >= rules.scoring.malicious_threshold;

    // 2. Delivery lure combo: (filehost archive in README or homepage) + codeless + (new account OR crack lure OR typosquat)
    let has_new_account = meta
        .and_then(|m| m.owner_account_age_days)
        .is_some_and(|age| age >= 0 && (age as u64) <= rules.limits.new_account_days);
    let combo_delivery_lure = codeless
        && (homepage_archive_lure || traits.archive_filehost_url.is_some())
        && (has_new_account || (crack_lure_found && (homepage_archive_lure || typosquat_hit.is_some())));

    let is_malicious = combo_exec_proff || combo_delivery_lure;

    let evidence = if combo_exec_proff {
        let ex = exec_hit.as_ref().unwrap();
        let po = proff_hit.as_ref().unwrap();
        Some(truncate_chars(
            &format!("{} || {}", ex.evidence, po.sentence),
            rules.limits.max_evidence_chars,
        ))
    } else if combo_delivery_lure {
        let mut parts = Vec::new();
        if let Some(ref hp) = homepage_evidence {
            parts.push(format!("homepage={hp}"));
        } else if let Some(ref fh) = traits.archive_filehost_url {
            parts.push(format!("filehost={fh}"));
        }
        if let Some(ref b) = typosquat_hit {
            parts.push(format!("brand={b}"));
        }
        if crack_lure_found {
            parts.push("crack_lure=true".into());
        }
        if has_new_account {
            parts.push(format!(
                "account_age={}d",
                meta.and_then(|m| m.owner_account_age_days).unwrap_or(0)
            ));
        }
        Some(truncate_chars(
            &parts.join(" · "),
            rules.limits.max_evidence_chars,
        ))
    } else {
        None
    };

    let verdict = if is_malicious { "malicious" } else { "clean" };
    let risk_level = if is_malicious {
        "high"
    } else if clamped_score >= rules.scoring.suspicious_threshold {
        "medium"
    } else {
        "low"
    };

    AnalysisReport {
        verdict: verdict.into(),
        risk_level: risk_level.into(),
        score: clamped_score,
        rule_version: rules.version,
        ruleset_hash: rules.ruleset_hash.clone(),
        evidence,
        signals,
        traits,
    }
}
