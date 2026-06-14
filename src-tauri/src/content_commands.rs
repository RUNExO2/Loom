// Reader View + Web Clipper backend.
//
// fetch_readable_article: pulls a page over HTTP (server-side, so no browser CORS),
// strips chrome (scripts, styles, nav, headers, footers, ads), and keeps a whitelist
// of content tags. This is a genuine readability transform — nothing is faked. The
// frontend Reader View renders the cleaned html; the Web Clipper persists it.

use serde::Serialize;
use regex::Regex;
use std::time::Duration;

#[derive(Serialize, Debug)]
pub struct ReadableArticle {
    pub url: String,
    pub title: String,
    pub byline: Option<String>,
    pub site_name: Option<String>,
    pub html: String,   // cleaned, whitelisted article HTML
    pub text: String,   // plain-text version
    pub word_count: usize,
    pub excerpt: String,
}

fn first_capture(re: &Regex, hay: &str) -> Option<String> {
    re.captures(hay).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_string())
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

/// Remove an element AND its content for each tag in `tags` (case-insensitive, spans newlines).
fn strip_elements(html: &str, tags: &[&str]) -> String {
    let mut out = html.to_string();
    for tag in tags {
        let re = Regex::new(&format!(r"(?is)<{tag}\b[^>]*>.*?</{tag}>", tag = tag)).unwrap();
        out = re.replace_all(&out, " ").to_string();
        // self-closing / unclosed variants
        let re2 = Regex::new(&format!(r"(?is)<{tag}\b[^>]*/?>", tag = tag)).unwrap();
        out = re2.replace_all(&out, " ").to_string();
    }
    out
}

const ALLOWED_TAGS: &[&str] = &[
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote",
    "pre", "code", "img", "a", "strong", "em", "b", "i", "br", "figure", "figcaption",
];

/// Drop every tag not in the whitelist, keeping inner text. Whitelisted tags keep only
/// a minimal, safe set of attributes (href on <a>, src/alt on <img>).
fn whitelist_tags(html: &str) -> String {
    let tag_re = Regex::new(r"(?is)<(/?)([a-zA-Z0-9]+)([^>]*)>").unwrap();
    let href_re = Regex::new(r#"(?is)href\s*=\s*["']([^"']*)["']"#).unwrap();
    let src_re = Regex::new(r#"(?is)src\s*=\s*["']([^"']*)["']"#).unwrap();
    let alt_re = Regex::new(r#"(?is)alt\s*=\s*["']([^"']*)["']"#).unwrap();

    tag_re.replace_all(html, |caps: &regex::Captures| {
        let closing = &caps[1];
        let name = caps[2].to_lowercase();
        let attrs = &caps[3];
        if !ALLOWED_TAGS.contains(&name.as_str()) {
            return String::new();
        }
        if !closing.is_empty() {
            return format!("</{}>", name);
        }
        match name.as_str() {
            "a" => {
                if let Some(h) = first_capture(&href_re, attrs) {
                    format!("<a href=\"{}\" target=\"_blank\" rel=\"noopener\">", h)
                } else {
                    "<a>".to_string()
                }
            }
            "img" => {
                let src = first_capture(&src_re, attrs).unwrap_or_default();
                if src.is_empty() || src.starts_with("data:") {
                    return String::new();
                }
                let alt = first_capture(&alt_re, attrs).unwrap_or_default();
                format!("<img src=\"{}\" alt=\"{}\" loading=\"lazy\" />", src, alt)
            }
            _ => format!("<{}>", name),
        }
    }).to_string()
}

/// Collapse whitespace and drop empty block tags left over after stripping.
fn tidy(html: &str) -> String {
    let ws = Regex::new(r"[ \t\r\n]+").unwrap();
    let mut out = ws.replace_all(html, " ").to_string();
    let empty = Regex::new(r"(?is)<(p|li|blockquote|h[1-6])>\s*</\s*\1>").unwrap();
    // run a few passes to clear nested emptiness
    for _ in 0..3 {
        out = empty.replace_all(&out, "").to_string();
    }
    out.trim().to_string()
}

fn to_plain_text(html: &str) -> String {
    let tag_re = Regex::new(r"(?is)<[^>]+>").unwrap();
    let stripped = tag_re.replace_all(html, " ");
    let ws = Regex::new(r"\s+").unwrap();
    decode_entities(&ws.replace_all(&stripped, " ")).trim().to_string()
}

fn extract_article(url: &str, raw: &str) -> ReadableArticle {
    let title_re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap();
    let og_title_re = Regex::new(r#"(?is)<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']"#).unwrap();
    let og_site_re = Regex::new(r#"(?is)<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']"#).unwrap();
    let author_re = Regex::new(r#"(?is)<meta[^>]+name=["']author["'][^>]+content=["']([^"']*)["']"#).unwrap();
    let h1_re = Regex::new(r"(?is)<h1[^>]*>(.*?)</h1>").unwrap();
    let body_re = Regex::new(r"(?is)<body[^>]*>(.*?)</body>").unwrap();
    let article_re = Regex::new(r"(?is)<article[^>]*>(.*?)</article>").unwrap();

    let title = og_title_re.captures(raw).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
        .or_else(|| first_capture(&title_re, raw))
        .or_else(|| first_capture(&h1_re, raw).map(|h| to_plain_text(&h)))
        .map(|t| decode_entities(&t))
        .unwrap_or_else(|| url.to_string());

    let byline = first_capture(&author_re, raw).map(|b| decode_entities(&b)).filter(|b| !b.is_empty());
    let site_name = first_capture(&og_site_re, raw).map(|s| decode_entities(&s)).filter(|s| !s.is_empty());

    // Prefer an <article> region if the page has one; else the <body>; else the whole doc.
    let region = first_capture(&article_re, raw)
        .or_else(|| first_capture(&body_re, raw))
        .unwrap_or_else(|| raw.to_string());

    let stripped = strip_elements(&region, &[
        "script", "style", "noscript", "iframe", "svg", "nav", "header", "footer",
        "aside", "form", "button", "input", "select", "template", "head",
    ]);
    let cleaned = tidy(&whitelist_tags(&stripped));
    let text = to_plain_text(&cleaned);
    let word_count = text.split_whitespace().count();
    let excerpt: String = {
        let mut e: String = text.chars().take(280).collect();
        if text.chars().count() > 280 { e.push('…'); }
        e
    };

    ReadableArticle { url: url.to_string(), title, byline, site_name, html: cleaned, text, word_count, excerpt }
}

#[tauri::command]
pub async fn fetch_readable_article(url: String) -> Result<ReadableArticle, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http(s) URLs are supported.".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; LOOM-Reader/1.0)")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    // One retry on transient network failure.
    let mut last_err = String::new();
    for attempt in 0..2 {
        match client.get(&url).send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    return Err(format!("The site returned HTTP {}.", resp.status().as_u16()));
                }
                let ctype = resp.headers().get("content-type")
                    .and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
                if !ctype.is_empty() && !ctype.contains("html") && !ctype.contains("text") {
                    return Err(format!("That link isn't an article (content-type: {}).", ctype));
                }
                let body = resp.text().await.map_err(|e| e.to_string())?;
                let article = extract_article(&url, &body);
                if article.text.trim().is_empty() {
                    return Err("Couldn't extract any readable text from this page.".into());
                }
                return Ok(article);
            }
            Err(e) => {
                last_err = e.to_string();
                if attempt == 0 {
                    // one immediate retry on transient failure
                    continue;
                }
            }
        }
    }
    Err(format!("Couldn't reach the page: {}", last_err))
}
