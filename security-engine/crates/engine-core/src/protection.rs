use crate::rules::CompiledRuleset;
use aho_corasick::{AhoCorasick, AhoCorasickBuilder};
use regex::Regex;
use std::sync::OnceLock;

/// Fast SIMD pre-filter: a sentence can ONLY match protection-off rules if it contains
/// at least one protection/antivirus/command trigger stem. Rejects ~99% of benign prose in ~5ns.
fn proff_prefilter() -> &'static AhoCorasick {
    static AC: OnceLock<AhoCorasick> = OnceLock::new();
    AC.get_or_init(|| {
        AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .build([
                "defender",
                "real-time",
                "realtime",
                "real time",
                "tamper",
                "antivirus",
                "anti-virus",
                "threat protection",
                "mppreference",
                "windefend",
                "disableantispyware",
                "disablerealtimemonitoring",
                "firewall",
                "security ",
                // Multilingual stems
                "디펜더",
                "실시간",
                "백신",
                "바이러스",
                "杀毒",
                "实时保护",
                "防病毒",
                "安全软件",
                "антивирус",
                "защит",
                "antivírus",
                "protección",
                "proteção",
            ])
            .unwrap()
    })
}

#[derive(Debug, Clone)]
pub struct ProtectionOffMatch {
    pub sentence: String,
    pub rule_id: String,
    pub kind: ProtectionOffKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtectionOffKind {
    Direct,
    Command,
    GenericCodeless,
    Multilingual,
}

fn negation_v1_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:never|not|don't|do\s+not|doesn't|no\s+need\s+to|without)\s+(?:\w+\s+){0,2}$").unwrap()
    })
}

fn negation_more_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:\b(?:cannot|never,?\s+ever|no\s+reason\s+to|unnecessary\s+to)|n['’]t)[\s,]+(?:\w+\s+){0,3}$").unwrap()
    })
}

fn negation_aside_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:never|not|don't|do\s+not|must\s+not|should\s+not|shouldn't|cannot|can't),\s*[^,.;:]{1,60},\s*(?:\w+\s+){0,2}$").unwrap()
    })
}

fn double_negative_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\b(?:forget|fail|neglect|hesitate)\s+to\s+(?:\w+\s+){0,2}$").unwrap())
}

fn not_instruction_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:if\s+you|when\s+you|(?:tries|tried|trying|attempts?|attempted|attempting)\s+to)\s+$").unwrap()
    })
}

fn coordinated_negation_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:never|do\s+not|don't|must\s+not|should\s+not|shouldn't|cannot|can't|no\s+need\s+to)\s+(?:disable|turn\s+off|switch\s+off|pause|deactivate|stop|uninstall)\b[^.;!?]{1,80}\b(?:or|nor)\s+(?:\w+\s+){0,2}$").unwrap()
    })
}

fn exclusion_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\b(?:exclusions?|exceptions?|whitelist|allow-?list)\b").unwrap())
}

fn exclusion_rejected_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:instead\s+of|rather\s+than|without|not\s+(?:just\s+)?(?:an?\s+)?(?:adding\s+)?)\s*(?:adding\s+|creating\s+|using\s+|needing\s+)?(?:an?\s+)?(?:exclusions?|exceptions?|whitelist|allow-?list)\b").unwrap()
    })
}

fn side_target_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"^(?i)[\s"'“”‘’*_`]{0,3}(?:[\w-]{1,20}\s+){0,3}(?:notifications?|alerts?|pop-?ups?|prompts?|warnings?|messages?|icons?|tray|telemetry)\b"#).unwrap()
    })
}

fn side_connector_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\b(?:and|or|then|to|before|after|if|when|while)\b").unwrap())
}

fn generic_hint_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)firewall|security\s").unwrap())
}

fn generic_negated_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:never|not|no|without|unnecessary|avoid|instead|rather|unless|if|whether)\b|n['’]t\b").unwrap()
    })
}

fn generic_side_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:notifications?|alerts?|pop-?ups?|prompts?|warnings?|rules?|logs?|logging)\b").unwrap()
    })
}

fn generic_sentence_start_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)^(?:[-*+>#\s"'“”‘’*_`]|\d+[.)])*(?:(?:please|first|then|next|now|also|temporarily|briefly|simply|just|step\s*\d+)[\s,:.)-]*)*(?:you\s+(?:must|should|need\s+to|have\s+to)\s+(?:first\s+|temporarily\s+)?)?$"#).unwrap()
    })
}

fn generic_after_ok_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^\s*(?:[.,;:!)]|$|(?:before|first|temporarily|while|during|then|until)\b|to\s+(?:install|run|continue|avoid|prevent|proceed)\b)").unwrap()
    })
}

fn slice_last_chars(s: &str, max_chars: usize) -> &str {
    let count = s.chars().count();
    if count <= max_chars {
        return s;
    }
    let skip = count - max_chars;
    match s.char_indices().nth(skip) {
        Some((idx, _)) => &s[idx..],
        None => s,
    }
}

fn slice_first_chars(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

fn strip_emphasis(s: &str) -> String {
    s.chars()
        .filter(|&c| !matches!(c, '*' | '_' | '~' | '`'))
        .collect()
}

fn is_negated(sentence: &str, match_start_byte: usize) -> bool {
    let prefix = &sentence[..match_start_byte];
    let before30 = strip_emphasis(slice_last_chars(prefix, 30));
    if negation_v1_re().is_match(&before30) {
        return true;
    }
    let before100 = strip_emphasis(slice_last_chars(prefix, 100));
    let before100_last30 = slice_last_chars(&before100, 30);
    if not_instruction_re().is_match(before100_last30) {
        return true;
    }
    if double_negative_re().is_match(&before100) {
        return false;
    }
    negation_more_re().is_match(&before100)
        || negation_aside_re().is_match(&before100)
        || coordinated_negation_re().is_match(&before100)
}

fn is_side_target(after: &str) -> bool {
    let window = slice_first_chars(after, 80);
    let Some(m) = side_target_re().find(window) else {
        return false;
    };
    // Ensure intervening modifier words (before the final side-target noun) do not contain clause connectors like `and`/`or`/`then`
    let matched = m.as_str();
    let last_space = matched.trim_end().rfind(char::is_whitespace);
    if let Some(pos) = last_space {
        if side_connector_re().is_match(&matched[..pos]) {
            return false;
        }
    }
    true
}

fn is_legitimate_exclusion_sentence(sentence: &str) -> bool {
    if !exclusion_re().is_match(sentence) {
        return false;
    }
    // Smuggling defense: "Disable Windows Defender instead of adding an exclusion." is NOT a legitimate exclusion exemption!
    !exclusion_rejected_re().is_match(sentence)
}

/// Checks if a single sentence instructs disabling antivirus / Defender / real-time protection.
pub fn match_protection_off_sentence(
    sentence: &str,
    codeless: bool,
    enable_multilingual: bool,
    rules: &CompiledRuleset,
) -> Option<ProtectionOffMatch> {
    if sentence.len() < 4 || !proff_prefilter().is_match(sentence) {
        return None;
    }
    if sentence.chars().count() < 4 || is_legitimate_exclusion_sentence(sentence) {
        return None;
    }

    // Filter out benign state descriptions like "Windows Defender is disabled only in the screenshot VM"
    if rules.state_description_regexes.iter().any(|re| re.is_match(sentence)) {
        return None;
    }

    // 1. Direct English protection-off patterns
    for rule in &rules.direct_proff_rules {
        for m in rule.regex.find_iter(sentence) {
            if is_negated(sentence, m.start()) {
                continue;
            }
            if is_side_target(&sentence[m.end()..]) {
                continue;
            }
            return Some(ProtectionOffMatch {
                sentence: sentence.to_string(),
                rule_id: rule.id.clone(),
                kind: ProtectionOffKind::Direct,
            });
        }
    }

    // 2. Defender-disabling command patterns (Set-MpPreference, sc stop WinDefend, etc.)
    for rule in &rules.command_proff_rules {
        for m in rule.regex.find_iter(sentence) {
            if is_negated(sentence, m.start()) {
                continue;
            }
            return Some(ProtectionOffMatch {
                sentence: sentence.to_string(),
                rule_id: rule.id.clone(),
                kind: ProtectionOffKind::Command,
            });
        }
    }

    // 3. Generic codeless patterns ("disable security software / firewall")
    if codeless
        && generic_hint_re().is_match(sentence)
        && !generic_negated_re().is_match(sentence)
        && !generic_side_re().is_match(sentence)
    {
        for m in rules.generic_codeless_regex.find_iter(sentence) {
            let lead_chars = sentence[..m.start()].chars().count();
            if lead_chars <= 60
                && generic_sentence_start_re().is_match(&sentence[..m.start()])
                && generic_after_ok_re().is_match(&sentence[m.end()..])
            {
                return Some(ProtectionOffMatch {
                    sentence: sentence.to_string(),
                    rule_id: "PROFF-GENERIC-CODELESS".into(),
                    kind: ProtectionOffKind::GenericCodeless,
                });
            }
        }
    }

    // 4. Safe multilingual protection-off rules (guarded by language-specific negation filters)
    if enable_multilingual && !sentence.is_ascii() {
        for rule in &rules.multilingual_rules {
            if rule.positive.is_match(sentence) && !rule.negation.is_match(sentence) {
                return Some(ProtectionOffMatch {
                    sentence: sentence.to_string(),
                    rule_id: rule.id.clone(),
                    kind: ProtectionOffKind::Multilingual,
                });
            }
        }
    }

    None
}

/// Checks whether the full README + description indicates blue-team / security research documentation
/// (e.g. MITRE ATT&CK, CVE, YARA/Sigma rules) with real source code.
pub fn is_security_research_context(text: &str, description: Option<&str>, has_real_code: bool, rules: &CompiledRuleset) -> bool {
    if !has_real_code {
        return false;
    }
    let mut hits = 0usize;
    for re in &rules.security_research_regexes {
        if re.is_match(text) || description.is_some_and(|d| re.is_match(d)) {
            hits += 1;
            if hits >= 2 {
                return true;
            }
        }
    }
    false
}
