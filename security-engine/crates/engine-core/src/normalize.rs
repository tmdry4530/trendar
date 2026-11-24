use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone)]
pub struct NormalizedText {
    /// Fully normalized text (HTML comments stripped, zero-width stripped, homoglyphs & fullwidth normalized)
    pub text: String,
    /// Lightly sanitized text (HTML comments & zero-width stripped, original URL characters preserved for exact evidence)
    pub raw_sanitized: String,
    pub zero_width_count: usize,
    pub homoglyph_count: usize,
    pub html_comments_stripped: usize,
}

/// Strictly truncate a UTF-8 string slice so its byte length never exceeds `max_bytes`,
/// respecting UTF-8 character boundaries.
pub fn truncate_utf8_bytes(input: &str, max_bytes: usize) -> &str {
    if input.len() <= max_bytes {
        return input;
    }
    let mut end = max_bytes;
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    &input[..end]
}

fn is_zero_width(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'
            | '\u{200C}'
            | '\u{200D}'
            | '\u{200E}'
            | '\u{200F}'
            | '\u{2060}'
            | '\u{FEFF}'
            | '\u{00AD}'
            | '\u{034F}'
            | '\u{180E}'
    )
}

/// Maps common Cyrillic & Greek homoglyphs to their ASCII Latin lookalikes.
fn map_confusable(c: char) -> Option<char> {
    match c {
        // Cyrillic lowercase
        '\u{0430}' => Some('a'), // а
        '\u{0435}' => Some('e'), // е
        '\u{043E}' => Some('o'), // о
        '\u{0440}' => Some('p'), // р
        '\u{0441}' => Some('c'), // с
        '\u{0443}' => Some('y'), // у
        '\u{0445}' => Some('x'), // х
        '\u{0456}' => Some('i'), // і
        '\u{0458}' => Some('j'), // ј
        '\u{0455}' => Some('s'), // ѕ
        // Cyrillic uppercase
        '\u{0410}' => Some('A'), // А
        '\u{0412}' => Some('B'), // В
        '\u{0415}' => Some('E'), // Е
        '\u{041A}' => Some('K'), // К
        '\u{041C}' => Some('M'), // М
        '\u{041D}' => Some('H'), // Н
        '\u{041E}' => Some('O'), // О
        '\u{0420}' => Some('P'), // Р
        '\u{0421}' => Some('C'), // С
        '\u{0422}' => Some('T'), // Т
        '\u{0425}' => Some('X'), // Х
        '\u{0406}' => Some('I'), // І
        // Greek lookalikes
        '\u{03B1}' => Some('a'), // α
        '\u{03BF}' => Some('o'), // ο
        '\u{03C1}' => Some('p'), // ρ
        '\u{0391}' => Some('A'), // Α
        '\u{0392}' => Some('B'), // Β
        '\u{0395}' => Some('E'), // Ε
        '\u{039F}' => Some('O'), // Ο
        '\u{03A1}' => Some('P'), // Ρ
        _ => None,
    }
}

/// Strips HTML comments (`<!-- ... -->`) outside of fenced code blocks in guaranteed O(n) time.
pub fn strip_html_comments(input: &str) -> (String, usize) {
    if !input.contains("<!--") {
        return (input.to_string(), 0);
    }
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len);
    let mut i = 0;
    let mut stripped = 0;
    let mut in_fence = false;
    let mut at_line_start = true;

    while i < len {
        if at_line_start {
            let mut j = i;
            while j < len && (bytes[j] == b' ' || bytes[j] == b'\t') {
                j += 1;
            }
            if j + 3 <= len && (&bytes[j..j + 3] == b"```" || &bytes[j..j + 3] == b"~~~") {
                in_fence = !in_fence;
            }
        }
        if !in_fence && i + 4 <= len && &bytes[i..i + 4] == b"<!--" {
            if let Some(rel_end) = input[i + 4..].find("-->") {
                let end = i + 4 + rel_end + 3;
                stripped += 1;
                // Preserve a single space/newline boundary so adjacent words don't glue together.
                if input[i..end].contains('\n') {
                    out.push('\n');
                    at_line_start = true;
                } else {
                    out.push(' ');
                    at_line_start = false;
                }
                i = end;
                continue;
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        at_line_start = ch == '\n';
        i += ch.len_utf8();
    }

    (out, stripped)
}

/// Anti-evasion normalizer:
/// 1. Strict byte-length truncation
/// 2. Strip HTML comments (prevents decoder padding DoS & hash-busting comments)
/// 3. Strip zero-width invisible characters
/// 4. Map Cyrillic/Greek homoglyphs ONLY when mixed with ASCII Latin letters in the same token
///    (so genuine Russian/Greek prose remains intact for multilingual rules!)
pub fn normalize_anti_evasion(input: &str, max_bytes: usize) -> NormalizedText {
    let capped = truncate_utf8_bytes(input, max_bytes);

    // Fast path for pure ASCII without HTML comments
    if capped.is_ascii() && !capped.contains("<!--") {
        let s = capped.to_string();
        return NormalizedText {
            raw_sanitized: s.clone(),
            text: s,
            zero_width_count: 0,
            homoglyph_count: 0,
            html_comments_stripped: 0,
        };
    }

    let (no_comments, html_comments_stripped) = strip_html_comments(capped);

    // Strip zero-width chars first
    let mut zw_stripped = String::with_capacity(no_comments.len());
    let mut zero_width_count = 0usize;
    let mut has_non_ascii = false;
    for ch in no_comments.chars() {
        if is_zero_width(ch) {
            zero_width_count += 1;
            continue;
        }
        if !ch.is_ascii() {
            has_non_ascii = true;
        }
        zw_stripped.push(ch);
    }

    if !has_non_ascii {
        return NormalizedText {
            raw_sanitized: zw_stripped.clone(),
            text: zw_stripped,
            zero_width_count,
            homoglyph_count: 0,
            html_comments_stripped,
        };
    }

    // Apply mixed-script homoglyph normalization per alphanumeric word token,
    // and NFKC for fullwidth Latin characters (e.g. ｄｒｏｐｂｏｘ -> dropbox) while preserving newlines/punctuation.
    let mut out = String::with_capacity(zw_stripped.len());
    let mut homoglyph_count = 0usize;
    let mut word = String::new();

    let flush_word = |word: &mut String, out: &mut String, homoglyph_count: &mut usize| {
        if word.is_empty() {
            return;
        }
        let has_ascii_latin = word.chars().any(|c| c.is_ascii_alphabetic());
        let has_confusable = word.chars().any(|c| map_confusable(c).is_some());
        if has_ascii_latin && has_confusable {
            for c in word.chars() {
                if let Some(mapped) = map_confusable(c) {
                    out.push(mapped);
                    *homoglyph_count += 1;
                } else {
                    out.push(c);
                }
            }
        } else {
            // Check for fullwidth Latin/digits (U+FF01..=U+FF5E) and normalize via NFKC
            let has_fullwidth = word.chars().any(|c| ('\u{FF01}'..='\u{FF5E}').contains(&c));
            if has_fullwidth {
                for nc in word.nfkc() {
                    out.push(nc);
                }
            } else {
                out.push_str(word);
            }
        }
        word.clear();
    };

    for ch in zw_stripped.chars() {
        if ch.is_alphanumeric() {
            word.push(ch);
        } else {
            flush_word(&mut word, &mut out, &mut homoglyph_count);
            out.push(ch);
        }
    }
    flush_word(&mut word, &mut out, &mut homoglyph_count);

    NormalizedText {
        text: out,
        raw_sanitized: zw_stripped,
        zero_width_count,
        homoglyph_count,
        html_comments_stripped,
    }
}
