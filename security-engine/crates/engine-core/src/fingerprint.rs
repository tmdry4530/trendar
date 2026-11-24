use crate::markdown::MarkdownLink;
use crate::rules::CompiledRuleset;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::OnceLock;
use url::Url;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReadmeTraits {
    pub text_key: Option<String>,
    pub skeleton_key: Option<String>,
    pub simhash: Option<String>,
    pub lure: bool,
    pub archive_filehost_url: Option<String>,
    pub shortener_urls: Vec<String>,
    pub own_pages_lure: bool,
}

fn heading_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^ {0,3}(#{1,6})[ \t]+").unwrap())
}

fn fence_mark_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^ {0,3}(`{3,}|~{3,})").unwrap())
}

fn releases_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\breleases\b").unwrap())
}

fn url_token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)https?://[^\s"'<>()\[\]`]+"#).unwrap())
}

fn download_word_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\bdownload").unwrap())
}

fn archive_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)[A-Za-z0-9_.-]+\.(?:zip|rar|7z|exe|msi|scr|dmg|pkg|apk)(?:[^A-Za-z0-9_.-]|$)").unwrap()
    })
}

fn is_trailing_punct(c: char) -> bool {
    matches!(c, '.' | ',' | ';' | ':' | '!' | '?' | '*' | '_' | '~')
}

fn without_trailing_punct(value: &str) -> &str {
    value.trim_end_matches(is_trailing_punct)
}

pub fn has_archive_extension(path: &str, rules: &CompiledRuleset) -> bool {
    // Reject double extensions like tool.exe.manifest (check final segment extension only)
    let segment = path.rsplit('/').next().unwrap_or("");
    let Some((_, ext)) = segment.rsplit_once('.') else {
        return false;
    };
    rules.archive_extensions.contains(&ext.to_lowercase())
}

fn has_archive_name(text: &str, rules: &CompiledRuleset) -> bool {
    if !archive_name_re().is_match(text) {
        return false;
    }
    // Verify against ruleset extensions in case ruleset was customized
    for m in archive_name_re().find_iter(text) {
        let token = m.as_str().trim_end_matches(|c: char| !c.is_alphanumeric());
        if let Some((_, ext)) = token.rsplit_once('.') {
            if rules.archive_extensions.contains(&ext.to_lowercase()) {
                return true;
            }
        }
    }
    false
}

fn sha256_hex(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    hex::encode(hasher.finalize())
}

fn stripped_names(owner: Option<&str>, name: Option<&str>) -> Vec<String> {
    let mut set = HashSet::new();
    for raw in [owner, name].into_iter().flatten() {
        let lower = raw.to_lowercase();
        let spaced = lower.replace(['-', '_'], " ");
        for v in [lower, spaced] {
            if !v.trim().is_empty() {
                set.insert(v);
            }
        }
    }
    let mut list: Vec<String> = set.into_iter().collect();
    list.sort_by(|a, b| b.len().cmp(&a.len()));
    list
}

/// Lowercases, strips owner/repo name variants, and collapses non-alphanumeric sequences to single spaces.
fn normalize_text(text: &str, names: &[String]) -> String {
    let mut value = text.to_lowercase();
    for name in names {
        if value.contains(name.as_str()) {
            value = value.replace(name.as_str(), " ");
        }
    }
    let mut out = String::with_capacity(value.len());
    let mut in_space = true;
    for ch in value.chars() {
        if ch.is_alphanumeric() {
            out.push(ch);
            in_space = false;
        } else if !in_space {
            out.push(' ');
            in_space = true;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

#[inline]
fn finalize_splitmix64(mut h: u64) -> u64 {
    h ^= h >> 30;
    h = h.wrapping_mul(0xbf58476d1ce4e5b9);
    h ^= h >> 27;
    h = h.wrapping_mul(0x94d049bb133111eb);
    h ^ (h >> 31)
}

/// Zero-allocation 64-bit FNV-1a + SplitMix64 hash for single word.
#[inline]
fn hash64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in s.as_bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    finalize_splitmix64(h)
}

/// Zero-allocation 64-bit FNV-1a + SplitMix64 hash for a word bigram `a + " " + b`.
#[inline]
fn hash64_pair(a: &str, b: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &byte in a.as_bytes() {
        h ^= byte as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h ^= b' ' as u64;
    h = h.wrapping_mul(0x100000001b3);
    for &byte in b.as_bytes() {
        h ^= byte as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    finalize_splitmix64(h)
}

/// Computes a 64-bit SimHash over alphabetic unigrams & bigrams of normalized text (zero heap allocs per shingle!).
pub fn compute_simhash(normalized_spaced: &str) -> Option<String> {
    let words: Vec<&str> = normalized_spaced
        .split_whitespace()
        .filter(|w| w.len() >= 3 && w.chars().any(|c| c.is_alphabetic()))
        .collect();
    if words.len() < 15 {
        return None;
    }
    let mut acc = [0i32; 64];
    for &w in &words {
        let h = hash64(w);
        for bit in 0..64 {
            acc[bit] += if (h >> bit) & 1 == 1 { 1 } else { -1 };
        }
    }
    for win in words.windows(2) {
        let h = hash64_pair(win[0], win[1]);
        for bit in 0..64 {
            acc[bit] += if (h >> bit) & 1 == 1 { 2 } else { -2 };
        }
    }
    let mut fp: u64 = 0;
    for (bit, &v) in acc.iter().enumerate() {
        if v >= 0 {
            fp |= 1u64 << bit;
        }
    }
    Some(format!("{fp:016x}"))
}

/// Hamming distance between two 16-char hex 64-bit SimHash strings.
pub fn simhash_distance(a: &str, b: &str) -> Option<u32> {
    let xa = u64::from_str_radix(a, 16).ok()?;
    let xb = u64::from_str_radix(b, 16).ok()?;
    Some((xa ^ xb).count_ones())
}

fn slice_first_chars(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

/// Extracts campaign traits (`text_key`, `skeleton_key`, `simhash`, `lure`, `archive_filehost_url`, `shortener_urls`).
/// Uses both raw line URL parsing and `pulldown-cmark` AST links (which resolves reference-style links `[Setup.zip][1]`).
pub fn extract_traits(
    text: &str,
    owner: Option<&str>,
    name: Option<&str>,
    ast_links: &[MarkdownLink],
    rules: &CompiledRuleset,
) -> ReadmeTraits {
    if text.is_empty() {
        return ReadmeTraits::default();
    }

    let names = stripped_names(owner, name);
    let normalized_spaced = normalize_text(text, &names);
    let body: String = normalized_spaced.chars().filter(|&c| c != ' ').collect();
    // Avoid 1-char owner/repo substring corruption in SimHash
    let simhash_names: Vec<String> = names.iter().filter(|n| n.len() >= 2).cloned().collect();
    let simhash_spaced = if simhash_names.len() == names.len() {
        normalized_spaced.as_str()
    } else {
        // Rare 1-char owner/repo case
        ""
    };
    let simhash_owned;
    let simhash_input = if simhash_names.len() == names.len() {
        simhash_spaced
    } else {
        simhash_owned = normalize_text(text, &simhash_names);
        simhash_owned.as_str()
    };

    let own_pages_host = owner
        .filter(|o| !o.is_empty())
        .map(|o| format!("{}.github.io", o.to_lowercase()));

    let mut headings: Vec<String> = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut lure = false;
    let mut own_pages = false;
    let mut archive_filehost_url: Option<String> = None;
    let mut shortener_set: HashSet<String> = HashSet::new();

    let inspect_url = |raw_url: &str,
                       context_archive_named: bool,
                       lure: &mut bool,
                       own_pages: &mut bool,
                       archive_filehost_url: &mut Option<String>,
                       shortener_set: &mut HashSet<String>| {
        let capped_url = slice_first_chars(raw_url, 2000);
        let raw = without_trailing_punct(capped_url);
        let Ok(parsed) = Url::parse(raw) else {
            return;
        };
        if !matches!(parsed.scheme(), "http" | "https") {
            return;
        }
        let Some(host_str) = parsed.host_str() else {
            return;
        };
        let host = host_str.to_lowercase();
        let path = parsed.path();

        let archive_path = has_archive_extension(path, rules);
        let filehost = rules.is_filehost(&host);
        if archive_path || filehost {
            *lure = true;
        }
        if filehost && archive_filehost_url.is_none() && (archive_path || context_archive_named) {
            *archive_filehost_url = Some(slice_first_chars(raw, rules.limits.max_lure_url_chars).to_string());
        }
        if rules.is_shortener(&host) && shortener_set.len() < 10 {
            shortener_set.insert(slice_first_chars(raw, rules.limits.max_lure_url_chars).to_string());
        }
        if let Some(ref own_host) = own_pages_host {
            if host == *own_host {
                *own_pages = true;
            }
        }
    };

    for raw_line in text.split('\n') {
        let line = raw_line.trim_end_matches('\r');
        if let Some(caps) = fence_mark_re().captures(line) {
            let mark = &caps[1];
            let mch = mark.chars().next().unwrap();
            let mlen = mark.len();
            if fence.is_none() {
                fence = Some((mch, mlen));
                continue;
            }
            if let Some((fch, flen)) = fence {
                if mch == fch && mlen >= flen && line[caps.get(0).unwrap().end()..].trim().is_empty() {
                    fence = None;
                    continue;
                }
            }
        }
        if fence.is_none() {
            if let Some(hcap) = heading_re().captures(line) {
                let hashes = &hcap[1];
                let rest = &line[hcap.get(0).unwrap().end()..];
                let norm = normalize_text(rest, &names);
                let alpha: String = norm
                    .chars()
                    .filter(|c| c.is_ascii_lowercase() || *c == ' ')
                    .collect();
                headings.push(format!("{hashes}{}", alpha.trim()));
            }
        }
        let archive_named = has_archive_name(line, rules);
        if archive_named && releases_re().is_match(line) {
            lure = true;
        }
        if line.contains("http") || line.contains("HTTP") || line.contains("Http") {
            for m in url_token_re().find_iter(line) {
                inspect_url(
                    m.as_str(),
                    archive_named,
                    &mut lure,
                    &mut own_pages,
                    &mut archive_filehost_url,
                    &mut shortener_set,
                );
            }
        }
    }

    // Also inspect Markdown AST links (resolves reference-style links `[Download Setup.zip][1]` across lines!)
    for link in ast_links {
        let link_archive_named = has_archive_name(&link.text, rules);
        if link_archive_named && (releases_re().is_match(&link.url) || releases_re().is_match(&link.text)) {
            lure = true;
        }
        inspect_url(
            &link.url,
            link_archive_named,
            &mut lure,
            &mut own_pages,
            &mut archive_filehost_url,
            &mut shortener_set,
        );
    }

    let own_pages_lure = own_pages && download_word_re().is_match(text);
    if own_pages_lure {
        lure = true;
    }

    let skeleton: Vec<&str> = headings
        .iter()
        .skip(1)
        .map(|h| h.as_str())
        .filter(|h| !h.trim_start_matches('#').is_empty())
        .collect();

    let text_key = if body.chars().count() >= rules.limits.min_text_key_chars {
        Some(sha256_hex(&body))
    } else {
        None
    };

    let skeleton_key = if skeleton.len() >= rules.limits.min_skeleton_headings {
        Some(sha256_hex(&skeleton.join("|")))
    } else {
        None
    };

    let simhash = compute_simhash(simhash_input);

    ReadmeTraits {
        text_key,
        skeleton_key,
        simhash,
        lure,
        archive_filehost_url,
        shortener_urls: shortener_set.into_iter().collect(),
        own_pages_lure,
    }
}
