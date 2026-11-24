use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct MarkdownLink {
    pub text: String,
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct ParsedDocument {
    /// Raw command units after line-continuation joining (before inert-command stripping).
    pub raw_commands: Vec<String>,
    /// Block ID for each command unit (increments on code fences).
    pub blocks: Vec<usize>,
    /// True if command is a real non-empty, non-comment command line.
    pub is_real_command: Vec<bool>,
    /// Prose & code sentences split on paragraph/block/sentence boundaries.
    pub sentences: Vec<String>,
    /// Lines inside fenced code blocks (for entropy / script inspection).
    pub code_lines: Vec<String>,
    /// All links extracted via pulldown-cmark AST (inline, reference-style `[text][1]`, autolinks).
    pub links: Vec<MarkdownLink>,
}

fn table_sep_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$").unwrap())
}

fn block_start_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>)").unwrap())
}

fn continues(last: Option<char>) -> bool {
    matches!(last, Some('|') | Some('`') | Some('\\'))
}

fn is_fence_open_or_close(trimmed: &str) -> Option<(char, usize, &str)> {
    let bytes = trimmed.as_bytes();
    if bytes.len() < 3 {
        return None;
    }
    let ch = bytes[0];
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let mut len = 0;
    while len < bytes.len() && bytes[len] == ch {
        len += 1;
    }
    if len >= 3 {
        Some((ch as char, len, &trimmed[len..]))
    } else {
        None
    }
}

/// Splits a paragraph into sentences on `[.!?]\s+` or CJK `[。！？]`, matching v3 behavior in O(n) without lookbehind.
fn split_sentences(paragraph: &str, out: &mut Vec<String>) {
    let mut start = 0usize;
    let mut iter = paragraph.char_indices().peekable();
    while let Some((idx, ch)) = iter.next() {
        let next_idx = idx + ch.len_utf8();
        if matches!(ch, '。' | '！' | '？') {
            out.push(paragraph[start..next_idx].to_string());
            start = next_idx;
        } else if matches!(ch, '.' | '!' | '?') {
            if let Some(&(_, next_ch)) = iter.peek() {
                if next_ch.is_whitespace() {
                    out.push(paragraph[start..next_idx].to_string());
                    // Consume consecutive whitespace
                    while let Some(&(ws_idx, ws_ch)) = iter.peek() {
                        if ws_ch.is_whitespace() {
                            iter.next();
                            start = ws_idx + ws_ch.len_utf8();
                        } else {
                            break;
                        }
                    }
                }
            }
        }
    }
    if start < paragraph.len() {
        out.push(paragraph[start..].to_string());
    }
}

/// Extracts all resolved links (including reference-style `[Download Setup.zip][1]`) using pulldown-cmark AST.
pub fn extract_ast_links(text: &str) -> Vec<MarkdownLink> {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);

    let parser = Parser::new_ext(text, opts);
    let mut links = Vec::new();
    let mut active_url: Option<String> = None;
    let mut active_text = String::new();

    for event in parser {
        match event {
            Event::Start(Tag::Link { dest_url, .. }) => {
                active_url = Some(dest_url.into_string());
                active_text.clear();
            }
            Event::Text(t) | Event::Code(t) => {
                if active_url.is_some() {
                    if !active_text.is_empty() {
                        active_text.push(' ');
                    }
                    active_text.push_str(&t);
                }
            }
            Event::End(TagEnd::Link) => {
                if let Some(url) = active_url.take() {
                    if url.len() <= 2048 {
                        links.push(MarkdownLink {
                            text: active_text.trim().to_string(),
                            url,
                        });
                    }
                    active_text.clear();
                }
            }
            _ => {}
        }
    }
    links
}

fn is_comment_or_empty_command(cmd: &str) -> bool {
    let t = cmd.trim();
    if t.is_empty() {
        return true;
    }
    // Shell/PowerShell comments (not markdown headings outside code blocks) or batch REM/::
    t.starts_with('#') || t.starts_with("::")
}

/// Parses a Markdown/README document into line/command units, sentences, code lines, and AST links.
pub fn parse_document(text: &str, extract_links: bool) -> ParsedDocument {
    let mut raw_commands: Vec<Vec<String>> = Vec::new();
    let mut blocks: Vec<usize> = Vec::new();
    let mut sentences: Vec<String> = Vec::new();
    let mut code_lines: Vec<String> = Vec::new();

    let mut pending: Option<Vec<String>> = None;
    let mut pending_last: Option<char> = None;
    let mut paragraph: Vec<String> = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut in_table = false;
    let mut previous_command_line = false;
    let mut block = 0usize;

    let flush_paragraph = |paragraph: &mut Vec<String>, sentences: &mut Vec<String>| {
        if !paragraph.is_empty() {
            let joined = paragraph.join(" ");
            split_sentences(&joined, sentences);
            paragraph.clear();
        }
    };

    for raw_line in text.split('\n') {
        let line = raw_line.trim_end_matches('\r').trim();
        if let Some((fch, flen, rest)) = is_fence_open_or_close(line) {
            match fence {
                None => {
                    fence = Some((fch, flen));
                    in_table = false;
                    block += 1;
                    flush_paragraph(&mut paragraph, &mut sentences);
                    continue;
                }
                Some((open_ch, open_len))
                    if open_ch == fch && flen >= open_len && rest.trim().is_empty() =>
                {
                    fence = None;
                    in_table = false;
                    block += 1;
                    flush_paragraph(&mut paragraph, &mut sentences);
                    continue;
                }
                _ => {}
            }
        }

        if fence.is_some() && !line.is_empty() {
            code_lines.push(line.to_string());
        }

        if line.is_empty() || block_start_re().is_match(line) {
            flush_paragraph(&mut paragraph, &mut sentences);
        }
        if !line.is_empty() {
            paragraph.push(line.to_string());
        }

        if fence.is_none() {
            if line.is_empty() || !line.contains('|') {
                in_table = false;
            }
            if line.contains('|') && table_sep_re().is_match(line) {
                if previous_command_line && pending.is_none() {
                    blocks.pop();
                    raw_commands.pop();
                }
                in_table = true;
            }
            if in_table || (line.starts_with('|') && line.ends_with('|') && line.len() > 1) {
                previous_command_line = false;
                continue;
            }
        }

        if let Some(ref mut parts) = pending {
            if matches!(pending_last, Some('`') | Some('\\')) {
                if let Some(mut last_part) = parts.pop() {
                    last_part.pop();
                    parts.push(last_part);
                }
                parts.push(line.to_string());
            } else {
                parts.push(" ".to_string());
                parts.push(line.to_string());
            }
        } else if line.starts_with('|') && !raw_commands.is_empty() {
            blocks.pop();
            let mut prev = raw_commands.pop().unwrap();
            prev.push(" ".to_string());
            prev.push(line.to_string());
            pending = Some(prev);
        } else {
            pending = Some(vec![line.to_string()]);
        }

        pending_last = line.chars().last();
        previous_command_line = true;

        if continues(pending_last) {
            continue;
        }
        if let Some(parts) = pending.take() {
            raw_commands.push(parts);
            blocks.push(block);
        }
    }

    if let Some(mut parts) = pending.take() {
        if matches!(pending_last, Some('`') | Some('\\')) {
            if let Some(mut last_part) = parts.pop() {
                last_part.pop();
                parts.push(last_part);
            }
        }
        raw_commands.push(parts);
        blocks.push(block);
    }

    flush_paragraph(&mut paragraph, &mut sentences);

    let joined_commands: Vec<String> = raw_commands.into_iter().map(|p| p.concat()).collect();
    let is_real_command: Vec<bool> = joined_commands
        .iter()
        .map(|c| !is_comment_or_empty_command(c))
        .collect();

    // Run full pulldown-cmark AST link resolution only when reference-style link definitions (`]:`) exist;
    // inline `[text](url)` and raw URLs are already extracted in the single-pass line scanner.
    let links = if extract_links && text.contains("]:") {
        extract_ast_links(text)
    } else {
        Vec::new()
    };

    ParsedDocument {
        raw_commands: joined_commands,
        blocks,
        is_real_command,
        sentences,
        code_lines,
        links,
    }
}
