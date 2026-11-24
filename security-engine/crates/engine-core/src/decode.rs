use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine;
use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct DecodedPayload {
    pub kind: &'static str,
    pub text: String,
}

fn ps_encoded_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Matches whitespace (including \t!) before -e / -ec / -en / -enc / -encodedcommand
        Regex::new(r#"(?i)\b(?:powershell|pwsh)(?:\.exe)?\b[^\n|;&]{0,200}?\s-(?:e|ec|en|enc|enco[a-z]*)\s+["']?([A-Za-z0-9+/]{16,}={0,2})"#).unwrap()
    })
}

fn no_exec_inline_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s(?:-n|--help|--version|-\?)(?:\s|$)").unwrap())
}

fn shell_b64_pipe_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)(?:echo|printf)\s+(?:-[ne]+\s+)*["']?([A-Za-z0-9+/=]{16,})["']?\s*\|\s*(?:openssl\s+base64\s+-d|base64\s+(?:-d|--decode|-D))\b"#).unwrap()
    })
}

fn shell_hex_pipe_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)(?:echo|printf)\s+(?:-[ne]+\s+)*["']?([0-9a-f]{24,})["']?\s*\|\s*xxd\s+(?:-[a-z]*r[a-z]*\s+-[a-z]*p|-[a-z]*p[a-z]*\s+-[a-z]*r|-rp|-pr)\b"#).unwrap()
    })
}

fn ps_from_b64_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)FromBase64String\(\s*["']([A-Za-z0-9+/]{16,}={0,2})["']\s*\)"#).unwrap()
    })
}

fn decode_b64_bytes(token: &str, max_chars: usize) -> Option<Vec<u8>> {
    let slice = if token.len() > max_chars {
        &token[..max_chars]
    } else {
        token
    };
    let trimmed = slice.trim_end_matches('=');
    let aligned_len = slice.len() - (slice.len() % 4);
    if aligned_len >= 4 {
        if let Ok(bytes) = STANDARD.decode(&slice[..aligned_len]) {
            return Some(bytes);
        }
    }
    STANDARD_NO_PAD.decode(trimmed).ok()
}

fn is_readable_text(s: &str) -> bool {
    let total = s.chars().count();
    if total < 8 {
        return false;
    }
    let readable = s
        .chars()
        .filter(|&c| {
            c == '\t'
                || c == '\n'
                || c == '\r'
                || ('\x20'..='\x7E').contains(&c)
                || ('\u{00A1}'..='\u{FFFC}').contains(&c)
        })
        .count();
    readable * 10 >= total * 9
}

fn decode_utf16le_or_utf8(bytes: &[u8], prefer_utf16: bool) -> Option<String> {
    let try_utf16 = |b: &[u8]| -> Option<String> {
        if b.len() < 16 {
            return None;
        }
        let u16s: Vec<u16> = b
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let text = String::from_utf16_lossy(&u16s);
        if is_readable_text(&text) {
            Some(text)
        } else {
            None
        }
    };
    let try_utf8 = |b: &[u8]| -> Option<String> {
        let text = String::from_utf8(b.to_vec()).ok()?;
        if is_readable_text(&text) {
            Some(text)
        } else {
            None
        }
    };

    if prefer_utf16 {
        try_utf16(bytes).or_else(|| try_utf8(bytes))
    } else {
        try_utf8(bytes).or_else(|| try_utf16(bytes))
    }
}

/// Decodes PowerShell `-enc`, `FromBase64String`, shell `echo ... | base64 -d`, and `xxd -r -p` hex payloads.
/// Bounded by `max_decodes` and `max_encoded_chars` for strict O(n) worst-case safety.
pub fn decode_encoded_payloads(
    commands: &[String],
    raw_lines: &[String],
    max_decodes: usize,
    max_encoded_chars: usize,
) -> Vec<DecodedPayload> {
    let mut decoded = Vec::new();
    let mut attempts = 0usize;

    // 1. PowerShell -enc (handles both space and tab before -enc)
    for command in commands {
        if !(command.contains(" -") || command.contains("\t-")) {
            continue;
        }
        for caps in ps_encoded_re().captures_iter(command) {
            attempts += 1;
            if attempts > max_decodes {
                return decoded;
            }
            if no_exec_inline_re().is_match(&caps[0]) {
                continue;
            }
            if let Some(bytes) = decode_b64_bytes(&caps[1], max_encoded_chars) {
                if let Some(text) = decode_utf16le_or_utf8(&bytes, true) {
                    decoded.push(DecodedPayload {
                        kind: "ps_enc",
                        text,
                    });
                }
            }
        }
    }

    // 2. Shell base64 / hex pipes & FromBase64String (from raw lines before inert stripping removed `echo`)
    for line in raw_lines {
        if attempts >= max_decodes {
            break;
        }
        let lower_hint = line.contains("base64")
            || line.contains("BASE64")
            || line.contains("xxd")
            || line.contains("FromBase64")
            || line.contains("frombase64");
        if !lower_hint {
            continue;
        }

        for caps in shell_b64_pipe_re().captures_iter(line) {
            attempts += 1;
            if attempts > max_decodes {
                return decoded;
            }
            if let Some(bytes) = decode_b64_bytes(&caps[1], max_encoded_chars) {
                if let Some(text) = decode_utf16le_or_utf8(&bytes, false) {
                    decoded.push(DecodedPayload {
                        kind: "shell_base64",
                        text,
                    });
                }
            }
        }

        for caps in shell_hex_pipe_re().captures_iter(line) {
            attempts += 1;
            if attempts > max_decodes {
                return decoded;
            }
            let raw_hex = &caps[1];
            let capped = if raw_hex.len() > max_encoded_chars {
                &raw_hex[..max_encoded_chars - (max_encoded_chars % 2)]
            } else if raw_hex.len() % 2 == 1 {
                &raw_hex[..raw_hex.len() - 1]
            } else {
                raw_hex
            };
            if let Ok(bytes) = hex::decode(capped) {
                if let Some(text) = decode_utf16le_or_utf8(&bytes, false) {
                    decoded.push(DecodedPayload {
                        kind: "shell_hex",
                        text,
                    });
                }
            }
        }

        for caps in ps_from_b64_re().captures_iter(line) {
            attempts += 1;
            if attempts > max_decodes {
                return decoded;
            }
            if let Some(bytes) = decode_b64_bytes(&caps[1], max_encoded_chars) {
                if let Some(text) = decode_utf16le_or_utf8(&bytes, false) {
                    decoded.push(DecodedPayload {
                        kind: "ps_from_base64",
                        text,
                    });
                }
            }
        }
    }

    decoded
}

/// Fast byte-level Shannon entropy (bits per byte, range 0.0..=8.0).
pub fn shannon_entropy(s: &str) -> f64 {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return 0.0;
    }
    let mut counts = [0u32; 256];
    for &b in bytes {
        counts[b as usize] += 1;
    }
    let len = bytes.len() as f64;
    let mut entropy = 0.0f64;
    for &c in &counts {
        if c > 0 {
            let p = (c as f64) / len;
            entropy -= p * p.log2();
        }
    }
    entropy
}

fn is_benign_high_entropy_token(token: &str) -> bool {
    let lower = token.to_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("sha256-")
        || lower.starts_with("sha384-")
        || lower.starts_with("sha512-")
        || lower.starts_with("ssh-")
        || lower.starts_with("ecdsa-")
        || lower.starts_with("data:image/")
    {
        return true;
    }
    // Pure hex checksum (SHA-256 / SHA-512)
    if (token.len() == 64 || token.len() == 128) && token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return true;
    }
    // Path-like or flag-like tokens with many slashes/dashes
    if token.matches('/').count() >= 3 || token.matches('-').count() >= 4 {
        return true;
    }
    false
}

/// Finds high-entropy obfuscated tokens inside code blocks.
pub fn find_high_entropy_tokens(
    code_lines: &[String],
    min_len: usize,
    threshold: f64,
) -> Vec<(String, f64)> {
    let mut hits = Vec::new();
    for line in code_lines {
        if hits.len() >= 5 {
            break;
        }
        // Only inspect code lines that look like execution or encoding contexts
        let lower = line.to_lowercase();
        let suspicious_ctx = lower.contains("powershell")
            || lower.contains("pwsh")
            || lower.contains("base64")
            || lower.contains("eval")
            || lower.contains("exec")
            || lower.contains("iex")
            || lower.contains("frombase64")
            || lower.contains("xxd");
        if !suspicious_ctx {
            continue;
        }
        for raw in line.split_whitespace().take(40) {
            let token = raw.trim_matches(|c| matches!(c, '"' | '\'' | '`' | '(' | ')' | ';' | ','));
            if token.len() < min_len || token.len() > 8192 {
                continue;
            }
            if is_benign_high_entropy_token(token) {
                continue;
            }
            let ent = shannon_entropy(token);
            if ent >= threshold {
                hits.push((crate::normalize::truncate_utf8_bytes(token, 48).to_string(), ent));
                break;
            }
        }
    }
    hits
}
