//! Bounded static recognition of a packed download page. Never runs JavaScript or fetches URLs.
use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use std::sync::LazyLock;
use url::Url;

const MAX_HTML: usize = 256 * 1024;
const MAX_SCRIPT: usize = 48 * 1024;
const MAX_TOKENS: usize = 12_000;
const MAX_PARTS: usize = 32;

static COMMENTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<!--.*?(?:-->|$)").unwrap());
static MARKUP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]*>").unwrap());
static SCRIPTS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<script\b([^<>]*)>(.*?)</script\s*>").unwrap());
static DATA_TAGS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<(?:div|span|p)\b([^<>]*)>").unwrap());
static BUTTONS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<button\b([^<>]*)>(.*?)</button\s*>").unwrap());
static ATTRS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)([a-z_:][a-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?"#)
        .unwrap()
});

pub(crate) fn attributes(tag: &str) -> impl Iterator<Item = (&str, &str)> {
    ATTRS.captures_iter(tag).map(|c| {
        let value = (2..=4).find_map(|i| c.get(i)).map_or("", |m| m.as_str());
        (c.get(1).unwrap().as_str(), value)
    })
}

fn inline_scripts(html: &str) -> impl Iterator<Item = (usize, &str)> {
    SCRIPTS.captures_iter(html).take(16).filter_map(|c| {
        for (key, value) in attributes(c.get(1)?.as_str()) {
            if key.eq_ignore_ascii_case("src") {
                return None;
            }
            if key.eq_ignore_ascii_case("type") {
                let mime = value.split(';').next()?.trim().to_ascii_lowercase();
                if !matches!(
                    mime.as_str(),
                    "" | "module" | "application/javascript" | "text/javascript"
                ) {
                    return None;
                }
            }
        }
        Some((c.get(0)?.start(), c.get(2)?.as_str()))
    })
}

fn quoted(token: &str) -> Option<&str> {
    let bytes = token.as_bytes();
    (bytes.len() >= 2 && matches!(bytes[0], b'\'' | b'"') && bytes.last() == bytes.first())
        .then(|| &token[1..token.len() - 1])
}

fn id(token: &str) -> bool {
    token
        .as_bytes()
        .first()
        .is_some_and(|b| b.is_ascii_alphabetic() || matches!(b, b'_' | b'$'))
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'$'))
}

// Keep strings and regex literals opaque. Only a small set of token sequences below is recognized.
fn js_tokens(source: &str) -> Option<Vec<&str>> {
    if source.len() > MAX_SCRIPT {
        return None;
    }
    let mut tokens = Vec::new();
    let bytes = source.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        let b = bytes[i];
        i += 1;
        match b {
            b if b.is_ascii_whitespace() => continue,
            b'/' if bytes.get(i) == Some(&b'/') => {
                i = source[i..].find('\n').map_or(bytes.len(), |n| i + n);
                continue;
            }
            b'/' if bytes.get(i) == Some(&b'*') => {
                i += 1;
                i += source[i..].find("*/")? + 2;
                continue;
            }
            b'\'' | b'"' | b'`' => loop {
                match *bytes.get(i)? {
                    b'\\' => i += 2,
                    c if c == b => {
                        i += 1;
                        break;
                    }
                    _ => i += 1,
                }
            },
            b'/' if matches!(
                tokens.last().copied(),
                Some("(" | "=" | "!" | "," | "return" | ":")
            ) =>
            {
                let mut in_class = false;
                loop {
                    match *bytes.get(i)? {
                        b'\\' => {
                            i += 2;
                            continue;
                        }
                        b'[' => in_class = true,
                        b']' => in_class = false,
                        b'/' if !in_class => {
                            i += 1;
                            break;
                        }
                        b'\r' | b'\n' => return None,
                        _ => {}
                    }
                    i += 1;
                }
                while bytes.get(i).is_some_and(u8::is_ascii_alphabetic) {
                    i += 1;
                }
            }
            b if b.is_ascii_alphanumeric() || matches!(b, b'_' | b'$') => {
                while bytes
                    .get(i)
                    .is_some_and(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'$'))
                {
                    i += 1;
                }
            }
            b if !b.is_ascii() => i = start + source[start..].chars().next()?.len_utf8(),
            _ => {}
        }
        if tokens.len() >= MAX_TOKENS {
            return None;
        }
        tokens.push(&source[start..i]);
    }
    Some(tokens)
}

// @ matches an identifier, ' a quoted literal, and ? any one token.
fn matches_pattern(tokens: &[&str], pattern: &[&str]) -> bool {
    tokens.len() == pattern.len()
        && pattern.iter().zip(tokens).all(|(p, t)| match *p {
            "@" => id(t),
            "'" => quoted(t).is_some(),
            "?" => true,
            _ => p == t,
        })
}

fn find<'a, 's>(tokens: &'a [&'s str], pattern: &[&str]) -> Option<&'a [&'s str]> {
    tokens
        .windows(pattern.len())
        .find(|w| matches_pattern(w, pattern))
}

fn delimited<'a, 's>(tokens: &'a [&'s str], open: &str, close: &str) -> Option<&'a [&'s str]> {
    let mut depth = 1;
    for (i, &token) in tokens.iter().enumerate() {
        if token == open {
            depth += 1;
        }
        if token == close {
            depth -= 1;
            if depth == 0 {
                return Some(&tokens[..i]);
            }
        }
    }
    None
}

fn read_payload(html: &str, prefix: &str, attr: &str, count: usize) -> Option<Vec<u8>> {
    if prefix.is_empty() || !attr.starts_with("data-") || !(1..=MAX_PARTS).contains(&count) {
        return None;
    }
    let mut parts = vec![None; count];
    for c in DATA_TAGS.captures_iter(html) {
        let (mut element_id, mut data, mut hidden) = (None, None, false);
        for (key, value) in attributes(c.get(1)?.as_str()) {
            if key.eq_ignore_ascii_case("id") {
                element_id = Some(value);
            }
            if key.eq_ignore_ascii_case(attr) {
                data = Some(value);
            }
            if key.eq_ignore_ascii_case("hidden") {
                hidden = true;
            }
            if key.eq_ignore_ascii_case("style") {
                let css: String = value
                    .chars()
                    .filter(|c| !c.is_ascii_whitespace())
                    .collect::<String>()
                    .to_ascii_lowercase();
                let has = |declaration| {
                    css.split(';')
                        .any(|d| d.trim_end_matches("!important") == declaration)
                };
                hidden |= has("display:none")
                    || has("visibility:hidden")
                    || (has("width:0") && has("height:0") && has("overflow:hidden"));
            }
        }
        let Some(index) = element_id.and_then(|v| v.strip_prefix(prefix)) else {
            continue;
        };
        let Ok(n) = index.parse::<usize>() else {
            continue;
        };
        if n >= count || n.to_string() != index {
            continue;
        }
        if !hidden || parts[n].replace(data?).is_some() {
            return None;
        }
    }
    // Fragment boundaries can bisect a Unicode escape.
    let escaped = parts.into_iter().collect::<Option<Vec<_>>>()?.concat();
    if escaped.len() % 6 != 0 {
        return None;
    }
    let mut encoded = Vec::with_capacity(escaped.len() / 6);
    for escape in escaped.as_bytes().chunks_exact(6) {
        if &escape[..4] != b"\\u00" {
            return None;
        }
        encoded.push(u8::from_str_radix(std::str::from_utf8(&escape[4..]).ok()?, 16).ok()?);
    }
    STANDARD.decode(&encoded).ok()
}

fn unpack(html: &str, t: &[&str]) -> Option<String> {
    let node = find(
        t,
        &[
            "@",
            "=",
            "document",
            ".",
            "getElementById",
            "(",
            "'",
            "+",
            "@",
            ")",
        ],
    )?;
    let index = node[8];
    let count = find(t, &["for", "(", index, "=", "0", ";", index, "<", "?", ";"])?[8]
        .parse()
        .ok()?;
    let parts = find(
        t,
        &[
            "@",
            ".",
            "push",
            "(",
            node[0],
            ".",
            "getAttribute",
            "(",
            "'",
            ")",
            ")",
        ],
    )?;
    let joined = find(t, &["@", "=", parts[0], ".", "join", "(", "'", ")"])?;
    if quoted(joined[6])? != "" {
        return None;
    }
    let transform = find(t, &[joined[0], "=", "@", "(", joined[0], ")"])?[2];
    let func = find(
        t,
        &[
            "function", transform, "(", "@", ")", "{", "return", "@", ".", "replace", "(", "?",
        ],
    )?;
    if func[3] != func[7] || !func[11].starts_with(r"/\\u") {
        return None;
    }
    find(
        t,
        &[
            "String",
            ".",
            "fromCharCode",
            "(",
            "parseInt",
            "(",
            "@",
            ",",
            "16",
            ")",
            ")",
        ],
    )?;
    let text = find(t, &["@", "=", "atob", "(", joined[0], ")"])?[0];
    let buffer = find(
        t,
        &[
            "@",
            "[",
            index,
            "]",
            "=",
            text,
            ".",
            "charCodeAt",
            "(",
            index,
            ")",
        ],
    )?[0];
    let key_assign = find(
        t,
        &[
            "@",
            "=",
            "Uint8Array",
            ".",
            "from",
            "(",
            "atob",
            "(",
            "'",
            ")",
        ],
    )?;
    let key_id = key_assign[0];
    find(
        t,
        &[
            buffer, "[", index, "]", "^", "=", key_id, "[", index, "%", key_id, ".", "length", "]",
        ],
    )?;
    let plain = find(
        t,
        &[
            "@",
            "=",
            "new",
            "TextDecoder",
            "(",
            "'",
            ")",
            ".",
            "decode",
            "(",
            buffer,
            ")",
        ],
    )?;
    if !quoted(plain[5])?.eq_ignore_ascii_case("utf-8") {
        return None;
    }
    find(t, &["document", ".", "write", "(", plain[0], ")"])?;

    let key = STANDARD.decode(quoted(key_assign[8])?).ok()?;
    if key.is_empty() || key.len() > 256 {
        return None;
    }
    let mut bytes = read_payload(html, quoted(node[6])?, quoted(parts[8])?, count)?;
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte ^= key[i % key.len()];
    }
    String::from_utf8(bytes).ok()
}

fn navigates(tokens: &[&str], param: &str) -> bool {
    tokens.iter().enumerate().any(|(i, &name)| {
        if name != "location"
            || (i > 0 && tokens[i - 1] == "." && !tokens[..i].ends_with(&["window", "."]))
        {
            return false;
        }
        let tail = &tokens[i + 1..];
        tail.starts_with(&[".", "assign", "(", param, ")"])
            || tail.starts_with(&[".", "replace", "(", param, ")"])
            || (tail.starts_with(&[".", "href", "=", param])
                && matches!(tail.get(4), None | Some(&";") | Some(&"}")))
    })
}

fn callback_body<'a, 's>(args: &'a [&'s str]) -> Option<&'a [&'s str]> {
    // The supported packer emits inline function callbacks. Limit the match to the callback body.
    let params = args.strip_prefix(&["function", "("])?;
    let params_len = delimited(params, "(", ")")?.len();
    let body = params.get(params_len + 1..)?.strip_prefix(&["{"])?;
    delimited(body, "{", "}")
}

fn redirects(tokens: &[&str], function: &str, arg: &str, button: &str) -> bool {
    let call = [function, "(", arg, ")"];
    let (mut click, mut timer) = (false, false);
    let mut i = 0;
    while i < tokens.len() {
        let tail = &tokens[i..];
        i += 1;
        let is_click = matches_pattern(
            tail.get(..6).unwrap_or(&[]),
            &[button, ".", "addEventListener", "(", "'", ","],
        ) && quoted(tail[4]) == Some("click");
        let is_timer = matches!(tail[0], "setInterval" | "setTimeout") && tail.get(1) == Some(&"(");
        if !is_click && !is_timer {
            continue;
        }
        let offset = if is_click { 4 } else { 2 };
        let Some(args) = delimited(&tail[offset..], "(", ")") else {
            return false;
        };
        let callback = if is_click { &args[2..] } else { args };
        if callback_body(callback).is_some_and(|body| find(body, &call).is_some()) {
            click |= is_click;
            timer |= is_timer;
            if click && timer {
                return true;
            }
        }
        // A timer registered inside a click is not an independent automatic redirect.
        i += offset + args.len();
    }
    false
}

fn external_target(t: &[&str], button_id: &str, pages_host: &str) -> Option<String> {
    let button = t.windows(8).find(|w| {
        matches_pattern(
            w,
            &["@", "=", "document", ".", "getElementById", "(", "'", ")"],
        ) && quoted(w[6]) == Some(button_id)
    })?[0];
    let mut destinations = t.windows(4).filter(|w| {
        matches!(w[0], "var" | "let" | "const")
            && id(w[1])
            && w[2] == "="
            && quoted(w[3]).is_some_and(|v| v.starts_with("https://") || v.starts_with("http://"))
    });
    let dest = destinations.next()?;
    if destinations.next().is_some() {
        return None;
    }
    let url = Url::parse(quoted(dest[3])?).ok()?;
    let host = url.host_str()?;
    if host
        .trim_end_matches('.')
        .eq_ignore_ascii_case(pages_host.trim_end_matches('.'))
        || matches!(host.trim_end_matches('.'), "github.com" | "www.github.com")
    {
        return None;
    }

    // Follow the URL literal directly or through the page's trim and URL normalization.
    let raw = find(
        t,
        &[
            "@", "=", "(", dest[1], "|", "|", "'", ")", ".", "trim", "(", ")",
        ],
    )
    .filter(|w| quoted(w[6]) == Some(""))
    .map(|w| w[0])
    .unwrap_or(dest[1]);
    let arg = find(
        t,
        &[
            "@", "=", "new", "URL", "(", raw, ",", "document", ".", "baseURI", ")", ".", "href",
        ],
    )
    .map(|w| w[0])
    .unwrap_or(raw);
    let mut functions = 0;
    for (i, w) in t.windows(6).enumerate() {
        if matches_pattern(w, &["function", "@", "(", "@", ")", "{"]) {
            functions += 1;
            if functions > 16 {
                return None;
            }
            let body = delimited(&t[i + 6..], "{", "}")?;
            if navigates(body, w[3]) && redirects(t, w[1], arg, button) {
                return Some(host.to_owned());
            }
        }
    }
    None
}

pub fn analyze_web_landing(content: &str, pages_host: &str) -> Option<String> {
    if content.len() > MAX_HTML {
        return None;
    }
    let content = COMMENTS.replace_all(content, " ");
    for (offset, script) in inline_scripts(&content).take(8) {
        let Some(wrapper) = js_tokens(script) else {
            continue;
        };
        let Some(html) = unpack(&content[..offset], &wrapper) else {
            continue;
        };
        let html = COMMENTS.replace_all(&html, " ");
        let download = BUTTONS.captures_iter(&html).take(8).find_map(|button| {
            let label = MARKUP.replace_all(button.get(2)?.as_str(), " ");
            if !label
                .split(|c: char| !c.is_ascii_alphabetic())
                .any(|w| w.eq_ignore_ascii_case("download"))
            {
                return None;
            }
            attributes(button.get(1)?.as_str())
                .find(|(n, _)| n.eq_ignore_ascii_case("id"))
                .map(|(_, v)| v)
        });
        let Some(button) = download else { continue };
        for (_, script) in inline_scripts(&html).take(8) {
            if let Some(host) =
                js_tokens(script).and_then(|t| external_target(&t, button, pages_host))
            {
                return Some(format!("Hidden Unicode/Base64/XOR data reconstructs a download page whose timer and button navigate to {host}"));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ManifestFile, ManifestInput, SecurityEngine};

    const FIXTURE: &str = include_str!("../../../../benchmarks/fixtures/packed-download-page.txt");
    const PAGES_HOST: &str = "example.github.io";

    #[test]
    fn manifest_recognizes_the_reconstructed_landing_at_pages_entry_points() {
        let engine = SecurityEngine::default_engine().unwrap();
        for (path, host, expected) in [
            ("index.html", Some(PAGES_HOST), 80),
            ("docs/index.html", Some(PAGES_HOST), 80),
            ("samples/index.html", Some(PAGES_HOST), 0),
            ("index.html", None, 0),
        ] {
            let report = engine.analyze_manifest(&ManifestInput {
                files: vec![ManifestFile {
                    path: path.into(),
                    content: FIXTURE.into(),
                }],
                pages_host: host.map(str::to_owned),
                ..Default::default()
            });
            assert_eq!(report.score, expected, "{path}: {report:?}");
            if expected != 0 {
                assert_eq!(
                    report.signals[0].rule_id,
                    "WEB-OBFUSCATED-DOWNLOAD-REDIRECT"
                );
                assert!(report.signals[0].detail.contains("fixture.invalid"));
            }
        }
    }

    #[test]
    fn incomplete_inert_or_malformed_wrappers_do_not_match() {
        for page in [
            format!("<!--{}-->", COMMENTS.replace_all(FIXTURE, "")),
            FIXTURE.replace("<script>", "<script type='application/json'>"),
            FIXTURE.replace("<script>", "<script type='text/plain'>"),
            FIXTURE.replace("document.write(result)", "document.write(other)"),
            FIXTURE.replace("key[i%key.length]", "key[0]"),
            FIXTURE.replace("i<2", "i<3"),
            FIXTURE.replace("id=\"x0\" hidden", "id=\"x0\""),
            FIXTURE.replace("EyE=", "bad!"),
            FIXTURE.replace("\\u00", "x"),
            " ".repeat(MAX_HTML + 1),
        ] {
            assert!(analyze_web_landing(&page, PAGES_HOST).is_none());
        }
    }

    #[test]
    fn timer_and_button_must_navigate_to_the_same_external_destination() {
        const JS: &str = r#"
            const dest="https://downloads.invalid/item";
            function go(u) { window.location.replace(u); }
            const button=document.getElementById("download");
            button.addEventListener('click', function () { go(dest); });
            setInterval(function () { go(dest); }, 1000);
        "#;
        let analyze =
            |source: &str| external_target(&js_tokens(source).unwrap(), "download", PAGES_HOST);
        assert_eq!(analyze(JS).as_deref(), Some("downloads.invalid"));
        for source in [
            JS.replace("setInterval", "onReady"),
            JS.replace(
                "function () { go(dest); }, 1000",
                "function () {}, 1000, go(dest)",
            ),
            JS.replace("}, 1000);", "}, 1000); });")
                .replace("go(dest); });", ""),
            JS.replace("window.location", "custom.location"),
            JS.replace("'click'", "'hover'"),
            JS.replace("function () { go(dest); },", "function () { go(other); },"),
            JS.replace("window.location.replace(u)", "logger.replace(u)"),
            JS.replace(
                "https://downloads.invalid/item",
                "https://example.github.io/download",
            ),
            JS.replace(
                "https://downloads.invalid/item",
                "https://github.com/org/repo/releases",
            ),
            JS.replace("https://downloads.invalid/item", "/releases"),
            format!("/* {JS} */"),
        ] {
            assert!(analyze(&source).is_none(), "{source}");
        }
    }
}
