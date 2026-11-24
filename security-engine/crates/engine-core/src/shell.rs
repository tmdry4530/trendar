use crate::rules::CompiledRuleset;
use aho_corasick::{AhoCorasick, AhoCorasickBuilder};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// Fast SIMD pre-filter: skips lines with zero command/exec/download/var triggers in ~5ns.
fn exec_line_prefilter() -> &'static AhoCorasick {
    static AC: OnceLock<AhoCorasick> = OnceLock::new();
    AC.get_or_init(|| {
        AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .build([
                "irm",
                "iwr",
                "invoke-",
                "curl",
                "wget",
                "iex",
                "scriptblock",
                "mshta",
                "regsvr32",
                "rundll32",
                "wmic",
                "certutil",
                "bitsadmin",
                "bitstransfer",
                "downloadfile",
                "downloadstring",
                "python",
                "node",
                "powershell",
                "pwsh",
                "http://",
                "https://",
                "`",
                " -f ",
                "\"+\"",
                "'+'",
            ])
            .unwrap()
    })
}

#[derive(Debug, Clone)]
pub struct ExecMatch {
    pub evidence: String,
    pub rule_id: String,
    pub obfuscated: bool,
}

fn fetch_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:irm|iwr|invoke-restmethod|invoke-webrequest|curl(?:\.exe)?|wget)\b").unwrap()
    })
}

fn remote_target_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)https?://|[\w-]\.[a-z]{2,}/").unwrap())
}

fn run_ps_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)^\s*(?:iex\b|invoke-expression\b|(?:pwsh|powershell)(?:\.exe)?\b|&\s*\(\s*(?:gcm|get-command|gal|get-alias)\s+i\S{0,4}x\s*\)|&\s*\(?\s*["']?(?:iex|invoke-expression)["']?\s*\)?)"#).unwrap()
    })
}

fn run_shell_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^\s*(?:sudo\s+(?:-\S+\s+)*)?(?:(?:ba|z|da|k)?sh|python3?|perl|ruby|node)\b").unwrap()
    })
}

fn inline_iex_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)\b(?:iex|invoke-expression)\b[\s("'$&{]*(?:irm|iwr|invoke-restmethod|invoke-webrequest|new-object\s+(?:system\.)?net\.webclient)\b"#).unwrap()
    })
}

fn subst_shell_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)(?:\b(?:ba|z|da)?sh|\bsource|\beval|(?:^|[\s;&|(])\.)\s+(?:--?[\w-]+\s+){0,6}["']?[<$]\(\s*(?:sudo\s+)?(?:curl|wget)\b([^)\n]{0,300})\)"#).unwrap()
    })
}

fn subst_ps_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\[scriptblock\]::create\([^\n]{0,40}?\b(?:irm|iwr|invoke-restmethod|invoke-webrequest|downloadstring)\b").unwrap()
    })
}

fn scriptblock_direct_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)&[\s(]*\[scriptblock\]::create\(|\b(?:icm|invoke-command)\b[^\n;|\[]{0,60}\[scriptblock\]::create\(|\[scriptblock\]::create\([^\n]{0,400}?\)\s*\)?\.invoke").unwrap()
    })
}

fn scriptblock_assigned_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(?:^|[;\s])\$(\w{1,60})\s*=\s*\[scriptblock\]::create\(").unwrap())
}

fn inner_cmd_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)^\s*(?:\S*[\\/])?(?:(?:ba|z|da)?sh\s+(?:-[a-z]+\s+){0,4}-[a-z]*c|(?:powershell|pwsh)(?:\.exe)?\s+(?:-[a-z]+\s+){0,4}-c(?:ommand)?|cmd(?:\.exe)?\s+/[ck])\s+(?:"([^"\n]+)"|'([^'\n]+)')"#).unwrap()
    })
}

fn script_arg_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)[\\/]|\.(?:sh|bash|zsh|ksh|py|pl|rb|ps1|bat|cmd|js)$").unwrap())
}

fn reads_stdin_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^(?:-|\/dev\/stdin|-[a-z]*s[a-z]*)$").unwrap())
}

fn save_tool_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(curl|wget|irm|iwr|invoke-restmethod|invoke-webrequest|certutil|bitsadmin|start-bitstransfer|downloadfile)\b").unwrap()
    })
}

fn save_at_start_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^(?:curl|wget|irm|iwr|invoke-restmethod|invoke-webrequest|certutil|bitsadmin|start-bitstransfer)(?:\.exe)?$").unwrap()
    })
}

fn redirect_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#">\s*["']?([^\s"'<>|;&()]+)"#).unwrap())
}

fn url_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)(?:https?://)?[A-Za-z0-9_.-]+\.[a-z]{2,}/(?:[^\s"'<>|;&()?#]*/)?([^\s"'<>|;&()?#/]+)"#).unwrap()
    })
}

fn out_curl_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\s(?:-[a-zA-Z]*o|--output)\s+["']?([^\s"']+)"#).unwrap())
}
fn out_wget_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\s(?:-[a-zA-Z]*O|--output-document)(?:\s+|=)?["']?([^\s"']+)"#).unwrap())
}
fn out_ps_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)\s-o(?:ut(?:file)?)?\s+["']?([^\s"';|]+)"#).unwrap())
}
fn out_certutil_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)-urlcache\b[^\n]{0,80}?https?://\S+\s+["']?([^\s"']+)"#).unwrap())
}
fn out_bitsadmin_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)/transfer\b[^\n]{0,120}?https?://\S+\s+["']?([^\s"']+)"#).unwrap())
}
fn out_bitstransfer_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)-destination\s+["']?([^\s"']+)"#).unwrap())
}
fn out_downloadfile_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)downloadfile\(\s*["'][^"'\n]+["']\s*,\s*["']([^"'\n]+)["']"#).unwrap())
}

fn remote_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s(?:-[a-zA-Z]*O\b|--remote-name\b)").unwrap())
}

fn prompt_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^(?:[$>#%]|PS>?)$").unwrap())
}

fn wrapper_flag_val_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(?:-[ugUhpCDRTfo]|--(?:user|group|host|prompt|chdir|unset|format|output|role|type|other-user|chroot|close-from))$").unwrap()
    })
}

fn env_assign_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_]\w*=").unwrap())
}

fn inert_hint_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\b(?:echo|printf|rem|write-host|write-output|true|false)\b|(?:^|[;&|]\s*):\s").unwrap())
}

fn token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#""[^"]*"|'[^']*'|\S+"#).unwrap())
}

fn run_flag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^(?:-|//|/[a-z]{1,8}$)").unwrap())
}

fn flag_with_val_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^-(?:ex(?:ec(?:utionpolicy)?)?|ep|w(?:indowstyle)?|inputformat|if|outputformat|of|version|workingdirectory|wd|configurationname|config|psconsolefile|settingsfile|settings|custompipename)$").unwrap()
    })
}

fn no_exec_flag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?:-n|-V|-h|-\?|/\?|--help|--version|--syntax-check)$").unwrap())
}

fn no_exec_inline_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s(?:-n|--help|--version|-\?)(?:\s|$)").unwrap())
}

fn ps_var_url_assign_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)(?:^|[;\s])(?:\$|\bexport\s+|\bset\s+)?([A-Za-z_]\w{0,40})\s*=\s*["']?(https?://[^\s"'`;|&]+)"#).unwrap()
    })
}

fn var_ref_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:\$\{?([A-Za-z_]\w{0,40})\}?|%([A-Za-z_]\w{0,40})%)").unwrap())
}

fn ps_concat_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?:"([A-Za-z0-9_-]{1,30})"|'([A-Za-z0-9_-]{1,30})')(\s*\+\s*(?:"([A-Za-z0-9_-]{1,30})"|'([A-Za-z0-9_-]{1,30})')){1,8}"#).unwrap()
    })
}

fn ps_format_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)["']((?:\{\d+\}){2,8})["']\s*-f\s*((?:["'][A-Za-z0-9_-]{1,30}["']\s*,?\s*){2,8})"#).unwrap()
    })
}

fn quoted_lit_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"["']([A-Za-z0-9_-]{1,30})["']"#).unwrap())
}

fn base_name_valid_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9_.+-]{1,100}$").unwrap())
}

/// Deobfuscates PowerShell inline backticks (e.g. `i`rm -> irm`, `i`ex -> iex`),
/// string concatenation (`"i"+"ex"` -> `"iex"`), and `-f` format operators (`"{1}{0}" -f 'ex','i'` -> `"iex"`).
/// Returns `(deobfuscated, was_obfuscated)`.
pub fn deobfuscate_command(cmd: &str) -> (String, bool) {
    let mut s = cmd.to_string();
    let mut obfuscated = false;

    // 1. PowerShell inline backticks between ASCII letters: i`rm, i`ex, Se`t-MpPreference
    if s.contains('`') {
        let bytes = s.as_bytes();
        let mut out = String::with_capacity(s.len());
        let mut i = 0;
        let mut changed = false;
        while i < bytes.len() {
            if bytes[i] == b'`'
                && i > 0
                && i + 1 < bytes.len()
                && bytes[i - 1].is_ascii_alphabetic()
                && bytes[i + 1].is_ascii_alphabetic()
            {
                changed = true;
                i += 1;
                continue;
            }
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
        if changed {
            s = out;
            obfuscated = true;
        }
    }

    // 2. PowerShell format operator constant folding: "{1}{0}" -f 'ex','i' -> "iex"
    if s.contains("-f") || s.contains("-F") {
        let replaced = ps_format_re().replace_all(&s, |caps: &regex::Captures| {
            let fmt = &caps[1];
            let args: Vec<String> = quoted_lit_re()
                .captures_iter(&caps[2])
                .map(|c| c[1].to_string())
                .collect();
            let mut folded = String::new();
            let mut idx_str = String::new();
            let mut in_brace = false;
            for ch in fmt.chars() {
                if ch == '{' {
                    in_brace = true;
                    idx_str.clear();
                } else if ch == '}' && in_brace {
                    in_brace = false;
                    if let Ok(idx) = idx_str.parse::<usize>() {
                        if let Some(arg) = args.get(idx) {
                            folded.push_str(arg);
                        }
                    }
                } else if in_brace {
                    idx_str.push(ch);
                }
            }
            if !folded.is_empty() {
                obfuscated = true;
                format!("\"{folded}\"")
            } else {
                caps[0].to_string()
            }
        });
        if obfuscated {
            s = replaced.into_owned();
        }
    }

    // 3. String concatenation constant folding: "i"+"ex" -> "iex"
    if s.contains('+') && (s.contains('"') || s.contains('\'')) {
        let mut concat_hit = false;
        let replaced = ps_concat_re().replace_all(&s, |caps: &regex::Captures| {
            let mut folded = String::new();
            for lit in quoted_lit_re().captures_iter(&caps[0]) {
                folded.push_str(&lit[1]);
            }
            if !folded.is_empty() {
                concat_hit = true;
                format!("\"{folded}\"")
            } else {
                caps[0].to_string()
            }
        });
        if concat_hit {
            s = replaced.into_owned();
            obfuscated = true;
        }
    }

    (s, obfuscated)
}

fn split_top_level(text: &str, pipes: bool, ignore_quotes: bool) -> Vec<String> {
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut pieces = Vec::new();
    let mut start = 0usize;
    let mut quote: u8 = 0;
    let mut i = 0usize;

    while i < len {
        let ch = bytes[i];
        if quote != 0 {
            if ch == quote {
                quote = 0;
            }
            i += 1;
            continue;
        }
        if !ignore_quotes
            && (ch == b'"'
                || (ch == b'\''
                    && (i == 0
                        || matches!(bytes[i - 1], b' ' | b'\t' | b'\r' | b'\n' | b'=' | b'('))))
        {
            quote = ch;
            i += 1;
            continue;
        }
        let width = if pipes {
            if ch == b'|'
                && (i + 1 >= len || bytes[i + 1] != b'|')
                && (i == 0 || bytes[i - 1] != b'|')
            {
                1
            } else {
                0
            }
        } else if ch == b';' {
            1
        } else if (ch == b'&' && i + 1 < len && bytes[i + 1] == b'&')
            || (ch == b'|' && i + 1 < len && bytes[i + 1] == b'|')
        {
            2
        } else if ch == b'&'
            && i > 0
            && i + 1 < len
            && bytes[i - 1].is_ascii_whitespace()
            && bytes[i + 1].is_ascii_whitespace()
        {
            1
        } else {
            0
        };
        if width == 0 {
            i += 1;
            continue;
        }
        pieces.push(text[start..i].to_string());
        start = i + width;
        i += width;
    }

    if quote != 0 && !ignore_quotes {
        return split_top_level(text, pipes, true);
    }
    pieces.push(text[start..].to_string());
    pieces
}

fn slice_chars(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

fn command_tokens(segment: &str, max_segment_chars: usize) -> Vec<String> {
    let capped = slice_chars(segment, max_segment_chars);
    let mut tokens = Vec::new();
    for m in token_re().find_iter(capped) {
        let trimmed = m
            .as_str()
            .trim_start_matches(|c| matches!(c, '`' | '"' | '\'' | '('))
            .trim_end_matches(|c| matches!(c, '`' | '"' | '\'' | ')'));
        tokens.push(trimmed.to_string());
        if tokens.len() == 40 {
            break;
        }
    }
    tokens
}

fn command_start(tokens: &[String], rules: &CompiledRuleset) -> usize {
    let mut at = 0usize;
    if let Some(first) = tokens.first() {
        if prompt_re().is_match(first) {
            at = if first.eq_ignore_ascii_case("ps")
                && tokens.get(1).is_some_and(|t| t.ends_with('>'))
            {
                2
            } else {
                1
            };
        }
    }
    while let Some(tok) = tokens.get(at) {
        let base = tok.rsplit('/').next().unwrap_or(tok).to_lowercase();
        if !rules.wrappers.contains(&base) {
            break;
        }
        at += 1;
        while let Some(arg) = tokens.get(at) {
            if arg.starts_with('-') || env_assign_re().is_match(arg) {
                at += if wrapper_flag_val_re().is_match(arg) { 2 } else { 1 };
            } else {
                break;
            }
        }
    }
    at
}

pub fn without_inert(unit: &str, rules: &CompiledRuleset) -> String {
    if !inert_hint_re().is_match(unit) {
        return unit.to_string();
    }
    let mut kept = Vec::new();
    for statement in split_top_level(unit, false, false) {
        let mut stages = split_top_level(&statement, true, false);
        if let Some(first_stage) = stages.first() {
            let tokens = command_tokens(first_stage, rules.limits.max_segment_chars);
            let start = command_start(&tokens, rules);
            if let Some(cmd) = tokens.get(start) {
                if rules.inert_commands.contains(&cmd.to_lowercase()) {
                    stages.remove(0);
                }
            }
        }
        if !stages.is_empty() {
            kept.push(stages.join(" | "));
        }
    }
    kept.join(" ; ")
}

fn command_segments(unit: &str, nested: bool) -> Vec<String> {
    let mut result = Vec::new();
    for statement in split_top_level(unit, false, false) {
        for segment in split_top_level(&statement, true, false) {
            if !nested {
                if let Some(caps) = inner_cmd_re().captures(&segment) {
                    let inner = caps.get(1).or_else(|| caps.get(2)).map(|m| m.as_str()).unwrap_or("");
                    result.extend(command_segments(inner, true));
                    continue;
                }
            }
            result.push(segment);
        }
    }
    result
}

fn shell_reads_stdin(part: &str, rules: &CompiledRuleset) -> bool {
    let tokens = command_tokens(part, rules.limits.max_segment_chars);
    let start = command_start(&tokens, rules);
    for tok in tokens.iter().skip(start + 1) {
        if no_exec_flag_re().is_match(tok) {
            return false;
        }
        // -c / -ec etc.
        let lower = tok.to_lowercase();
        if lower.starts_with('-')
            && lower.len() >= 2
            && lower[1..].bytes().all(|b| b.is_ascii_alphabetic())
            && lower.ends_with('c')
        {
            return false;
        }
        if reads_stdin_re().is_match(tok) {
            return true;
        }
        if tok.starts_with('-') {
            continue;
        }
        return !script_arg_re().is_match(tok);
    }
    true
}

fn strip_exe(s: &str) -> &str {
    s.strip_suffix(".exe").unwrap_or(s)
}

fn is_runner(token: Option<&String>, rules: &CompiledRuleset) -> bool {
    let Some(tok) = token else { return false };
    let lower = tok.to_lowercase();
    if rules.runners.contains(strip_exe(&lower)) {
        return true;
    }
    let base = lower.rsplit(['/', '\\']).next().unwrap_or(&lower);
    rules.runners.contains(strip_exe(base))
}

fn invoked_token(segment: &str, rules: &CompiledRuleset) -> Option<String> {
    let tokens = command_tokens(segment, rules.limits.max_segment_chars);
    let mut at = command_start(&tokens, rules);
    for _ in 0..rules.limits.max_runner_depth {
        if !is_runner(tokens.get(at), rules) {
            break;
        }
        let lower = tokens[at].to_lowercase();
        let is_python = lower.ends_with("python") || lower.ends_with("python3");
        at += 1;
        while let Some(tok) = tokens.get(at) {
            if tok.is_empty() || run_flag_re().is_match(tok) {
                if no_exec_flag_re().is_match(tok)
                    || (is_python && (tok == "-m" || tok == "-c"))
                {
                    return None;
                }
                at += if flag_with_val_re().is_match(tok) { 2 } else { 1 };
            } else {
                break;
            }
        }
    }
    tokens.get(at).cloned()
}

fn base_name(value: &str) -> Option<String> {
    let cleaned = value
        .trim_start_matches(|c| matches!(c, '`' | '"' | '\'' | '('))
        .trim_end_matches(|c| matches!(c, '`' | '"' | '\'' | ')' | ';' | ','));
    let name = cleaned.rsplit(['/', '\\']).next().unwrap_or("").to_lowercase();
    if base_name_valid_re().is_match(&name)
        && name.bytes().any(|b| b.is_ascii_alphanumeric())
        && name != "null"
    {
        Some(name)
    } else {
        None
    }
}

fn has_remote_target(s: &str, tainted_vars: &HashSet<String>) -> (bool, bool) {
    if remote_target_re().is_match(s) {
        return (true, false);
    }
    if !tainted_vars.is_empty() {
        for caps in var_ref_re().captures_iter(s) {
            let name = caps
                .get(1)
                .or_else(|| caps.get(2))
                .map(|m| m.as_str().to_lowercase())
                .unwrap_or_default();
            if tainted_vars.contains(&name) {
                return (true, true);
            }
        }
    }
    (false, false)
}

fn saved_file(full_segment: &str, tainted_vars: &HashSet<String>, rules: &CompiledRuleset) -> Option<String> {
    let segment = slice_chars(full_segment, rules.limits.max_segment_chars);
    let tool = save_tool_re().captures(segment)?[1].to_lowercase();
    let (has_remote, _) = has_remote_target(segment, tainted_vars);
    if !has_remote {
        return None;
    }

    let invoked = invoked_token(segment, rules)
        .unwrap_or_default()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_lowercase();

    if tool == "downloadfile" {
        if rules.readers.contains(&invoked) {
            return None;
        }
    } else if !save_at_start_re().is_match(&invoked) {
        return None;
    }

    let pattern = match tool.as_str() {
        "curl" => out_curl_re(),
        "wget" => out_wget_re(),
        "certutil" => out_certutil_re(),
        "bitsadmin" => out_bitsadmin_re(),
        "start-bitstransfer" => out_bitstransfer_re(),
        "downloadfile" => out_downloadfile_re(),
        _ => out_ps_re(),
    };

    let named = pattern
        .captures(segment)
        .or_else(|| if tool == "downloadfile" { None } else { redirect_re().captures(segment) });

    if let Some(caps) = named {
        let full_m = caps.get(0).unwrap();
        let val_m = caps.get(1).unwrap();
        let prefix = &segment[full_m.start()..val_m.start()];
        let opened = prefix.ends_with('"') || prefix.ends_with('\'');
        if opened {
            if let Some(next_ch) = segment[full_m.end()..].chars().next() {
                if next_ch.is_whitespace() {
                    return None;
                }
            }
        }
        return base_name(val_m.as_str());
    }

    if tool == "wget" || (tool == "curl" && remote_name_re().is_match(segment)) {
        if let Some(caps) = url_name_re().captures(segment) {
            return base_name(&caps[1]);
        }
    }
    None
}

fn ran_file(segment: &str, rules: &CompiledRuleset) -> Option<String> {
    let tok = invoked_token(segment, rules)?;
    base_name(&tok)
}

fn is_remote_exec(unit: &str, tainted_vars: &HashSet<String>, rules: &CompiledRuleset) -> Option<(String, bool)> {
    let (has_remote, via_var) = has_remote_target(unit, tainted_vars);
    if inline_iex_re().is_match(unit) && has_remote {
        return Some(("EXEC-INLINE-IEX".into(), via_var));
    }
    if let Some(caps) = subst_shell_re().captures(unit) {
        if !no_exec_inline_re().is_match(&caps[0]) {
            let (inner_remote, inner_var) = has_remote_target(&caps[1], tainted_vars);
            if inner_remote {
                return Some(("EXEC-SUBST-SHELL".into(), inner_var));
            }
        }
    }
    for rule in &rules.lolbin_rules {
        if rule.regex.is_match(unit) {
            return Some((rule.id.clone(), false));
        }
    }
    let parts: Vec<&str> = unit.split('|').collect();
    for i in 1..parts.len() {
        let left = parts[i - 1];
        let (left_remote, left_var) = has_remote_target(left, tainted_vars);
        if !fetch_re().is_match(left) || !left_remote {
            continue;
        }
        let right = parts[i];
        if run_ps_re().is_match(right) {
            return Some(("EXEC-PIPE-PS".into(), left_var));
        }
        if run_shell_re().is_match(right) && shell_reads_stdin(right, rules) {
            return Some(("EXEC-PIPE-SHELL".into(), left_var));
        }
    }
    None
}

fn scriptblock_runs(
    commands: &[String],
    raw_commands: &[String],
    blocks: &[usize],
    is_real: &[bool],
    index: usize,
    tainted_vars: &HashSet<String>,
    run_window: usize,
) -> Option<String> {
    let unit = &commands[index];
    let (has_remote, _) = has_remote_target(unit, tainted_vars);
    if !subst_ps_re().is_match(unit) || !has_remote {
        return None;
    }
    let Some(caps) = scriptblock_assigned_re().captures(unit) else {
        return if scriptblock_direct_re().is_match(unit) {
            Some(unit.clone())
        } else {
            None
        };
    };
    let name = regex::escape(&caps[1]);
    let invoked_pat = format!(
        r"(?i)(?:^|[;\s(])[&.]\s*\${name}(?:[^A-Za-z0-9_.]|$)|\${name}\.invoke|\b(?:icm|invoke-command)\b[^\n]{{0,80}}?\${name}(?:[^A-Za-z0-9_]|$)"
    );
    let Ok(invoked) = Regex::new(&invoked_pat) else {
        return None;
    };
    if invoked.is_match(unit) {
        return Some(unit.clone());
    }
    let mut seen_real = 0usize;
    for next in (index + 1)..commands.len() {
        if blocks[next] != blocks[index] {
            break;
        }
        if is_real[next] {
            seen_real += 1;
        }
        if seen_real > run_window {
            break;
        }
        let candidate = if !commands[next].is_empty() {
            commands[next].as_str()
        } else {
            raw_commands[next].as_str()
        };
        if invoked.is_match(candidate) {
            return Some(format!("{unit} ; {candidate}"));
        }
    }
    None
}

fn saved_then_run(
    commands: &[String],
    raw_commands: &[String],
    blocks: &[usize],
    is_real: &[bool],
    index: usize,
    tainted_vars: &HashSet<String>,
    rules: &CompiledRuleset,
) -> Option<String> {
    if !save_tool_re().is_match(&commands[index]) {
        return None;
    }
    let mut names: Vec<String> = Vec::new();
    for segment in command_segments(&commands[index], false) {
        if !names.is_empty() {
            if let Some(ran) = ran_file(&segment, rules) {
                if names.contains(&ran) {
                    return Some(commands[index].clone());
                }
            }
        }
        if let Some(saved) = saved_file(&segment, tainted_vars, rules) {
            names.push(saved);
            if names.len() > rules.limits.max_saved_names {
                names.remove(0);
            }
        }
    }
    if names.is_empty() {
        return None;
    }
    let mut seen_real = 0usize;
    for next in (index + 1)..commands.len() {
        if blocks[next] != blocks[index] {
            break;
        }
        if !is_real[next] {
            continue;
        }
        seen_real += 1;
        if seen_real > rules.limits.run_window {
            break;
        }
        // Notice: `commands[next]` might have been skipped by the exec pre-filter (e.g. `./install.sh`, `start s.exe`),
        // so fall back to `without_inert(raw_commands[next])` for the tiny 3-line follow-up window!
        let next_cmd = if !commands[next].is_empty() {
            commands[next].clone()
        } else {
            without_inert(&raw_commands[next], rules)
        };
        if next_cmd.is_empty() {
            continue;
        }
        for seg in command_segments(&next_cmd, false) {
            if let Some(ran) = ran_file(&seg, rules) {
                if names.contains(&ran) {
                    return Some(format!("{} ; {}", commands[index], next_cmd));
                }
            }
        }
    }
    None
}

/// Prepares deobfuscated, inert-stripped command units and detects remote execution signals.
pub fn find_remote_exec(
    raw_commands: &[String],
    blocks: &[usize],
    is_real: &[bool],
    rules: &CompiledRuleset,
) -> (Vec<String>, Option<ExecMatch>) {
    let mut commands = Vec::with_capacity(raw_commands.len());
    let mut cmd_obfuscated = Vec::with_capacity(raw_commands.len());
    let mut block_vars: HashMap<usize, HashSet<String>> = HashMap::new();

    let pf = exec_line_prefilter();
    for (idx, raw) in raw_commands.iter().enumerate() {
        if raw.is_empty() || !pf.is_match(raw) {
            commands.push(String::new());
            cmd_obfuscated.push(false);
            continue;
        }
        let stripped = without_inert(raw, rules);
        let (deobf, was_obf) = deobfuscate_command(&stripped);
        // Track variable-to-URL assignments inside each block
        if deobf.contains("http") || deobf.contains("HTTP") {
            let entry = block_vars.entry(blocks[idx]).or_default();
            for caps in ps_var_url_assign_re().captures_iter(&deobf) {
                entry.insert(caps[1].to_lowercase());
            }
        }
        commands.push(deobf);
        cmd_obfuscated.push(was_obf);
    }

    let empty_vars = HashSet::new();
    for i in 0..commands.len() {
        if commands[i].is_empty() {
            continue;
        }
        let vars = block_vars.get(&blocks[i]).unwrap_or(&empty_vars);
        if let Some((rule_id, via_var)) = is_remote_exec(&commands[i], vars, rules) {
            return (
                commands,
                Some(ExecMatch {
                    evidence: raw_commands[i].clone(),
                    rule_id,
                    obfuscated: cmd_obfuscated[i] || via_var,
                }),
            );
        }
        if commands[i].contains("create(") || commands[i].contains("Create(") || commands[i].contains("CREATE(") {
            if let Some(ev) = scriptblock_runs(
                &commands,
                raw_commands,
                blocks,
                is_real,
                i,
                vars,
                rules.limits.run_window,
            ) {
                return (
                    commands,
                    Some(ExecMatch {
                        evidence: ev,
                        rule_id: "EXEC-SCRIPTBLOCK".into(),
                        obfuscated: cmd_obfuscated[i],
                    }),
                );
            }
        }
        if let Some(ev) = saved_then_run(
            &commands,
            raw_commands,
            blocks,
            is_real,
            i,
            vars,
            rules,
        ) {
            return (
                commands,
                Some(ExecMatch {
                    evidence: ev,
                    rule_id: "EXEC-SAVE-AND-RUN".into(),
                    obfuscated: cmd_obfuscated[i],
                }),
            );
        }
    }

    (commands, None)
}
