//! One transcript (`<claude_home>/projects/<dir>/<sessionId>.jsonl`) summarised into a
//! [`SessionSummary`]: what a session card shows. The file is streamed line by line and read
//! only; every record that is not one of the few we use is skipped, a line that is not JSON
//! (a half-written last line of a live session included) is skipped, and a transcript that
//! yields nothing still summarises (its mtime, `(untitled)`).

use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::IgnoredAny;
use serde::{Deserialize, Deserializer};

/// The title of a session with no title record and no usable prompt.
pub const UNTITLED: &str = "(untitled)";

/// A first prompt used as the title is cut to this many characters (plus `…`).
pub const TITLE_MAX_CHARS: usize = 60;

/// Name of the per-session file that may hold a `customTitle`, in `<dir>/<sessionId>/`.
pub const CUSTOM_TITLE_FILE: &str = "custom-title.json";

/// What one transcript says about its session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSummary {
    /// The session id: the transcript's file stem.
    pub id: String,
    pub title: String,
    /// Earliest record timestamp (ISO 8601 UTC, millisecond precision), else the file's mtime.
    pub started_at: String,
    /// Latest record timestamp, else the file's mtime. Same format as `started_at`, so the
    /// two order correctly as strings.
    pub last_active: String,
    /// The latest non-empty `gitBranch`; `None` when no record has one.
    pub branch: Option<String>,
    /// Prompts plus distinct assistant message ids, sidechain records not counted.
    pub messages: u32,
    /// The `cwd` of the first `user` record.
    pub cwd: Option<String>,
}

/// Summarise the transcript at `path`. `None` only when the file cannot be opened or stat'ed
/// (the caller skips it); a file with no usable record is a summary with the mtime and
/// [`UNTITLED`].
pub fn summarise(path: &Path) -> Option<SessionSummary> {
    summarise_from(path, None).map(|parsed| parsed.summary)
}

/// Where a parse of a transcript stopped: the byte offset just past the last complete line
/// and the state reached there. A transcript only ever grows, so the next parse can resume
/// from it instead of re-reading the file.
#[derive(Debug, Clone, Default)]
pub struct Progress {
    offset: u64,
    partial: Partial,
}

impl Progress {
    /// The byte offset just past the last complete (newline-terminated) line parsed.
    pub fn offset(&self) -> u64 {
        self.offset
    }
}

/// What [`summarise_from`] produced.
#[derive(Debug, Clone)]
pub struct Parsed {
    pub summary: SessionSummary,
    /// Where to resume next time.
    pub progress: Progress,
    /// How many bytes this parse read (from the resume offset, or from 0).
    pub bytes_read: u64,
}

/// [`summarise`], resuming from `resume` when the file is at least as long as its offset
/// (the caller passes it only when the file did not change in any other way); otherwise from
/// byte 0. Only complete lines advance the offset: a trailing line without its newline (a
/// record being written) counts for this summary but is read again next time.
pub fn summarise_from(path: &Path, resume: Option<&Progress>) -> Option<Parsed> {
    let id = path.file_stem()?.to_str()?.to_string();
    let mut file = fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
    let mut progress = match resume {
        Some(resume) if meta.len() >= resume.offset && file.seek(SeekFrom::Start(resume.offset)).is_ok() => resume.clone(),
        _ => Progress::default(),
    };
    let (complete, tail, bytes_read) = feed(BufReader::new(file), &mut progress.partial);
    progress.offset += complete;
    let mut current = progress.partial.clone();
    if let Some(record) = tail.as_deref().and_then(parse_line) {
        current.take(record);
    }
    if current.title_source < TitleSource::CustomFile
        && let Some(title) = custom_title_file(path, &id)
    {
        current.title = Some(title);
        current.title_source = TitleSource::CustomFile;
    }
    Some(Parsed {
        summary: current.finish(id, mtime),
        progress,
        bytes_read,
    })
}

/// The path of a transcript's `custom-title.json` (which may not exist).
pub fn custom_title_path(transcript: &Path) -> Option<PathBuf> {
    let id = transcript.file_stem()?;
    Some(transcript.parent()?.join(id).join(CUSTOM_TITLE_FILE))
}

/// The `customTitle` of `<dir>/<id>/custom-title.json`, if that file exists and holds one.
fn custom_title_file(transcript: &Path, id: &str) -> Option<String> {
    let path = transcript.parent()?.join(id).join(CUSTOM_TITLE_FILE);
    let text = fs::read_to_string(path).ok()?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct File {
        #[serde(default, deserialize_with = "lenient_string")]
        custom_title: Option<String>,
    }
    let file: File = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    non_empty(file.custom_title)
}

/// Where the title came from, weakest first; a stronger source replaces a weaker one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
enum TitleSource {
    #[default]
    None,
    Prompt,
    AiTitle,
    CustomFile,
    CustomRecord,
}

/// The running state of one pass over a transcript.
#[derive(Debug, Clone, Default)]
struct Partial {
    title: Option<String>,
    title_source: TitleSource,
    started_ms: Option<i64>,
    last_ms: Option<i64>,
    branch: Option<String>,
    prompts: u32,
    assistant_ids: std::collections::HashSet<String>,
    cwd: Option<String>,
}

impl Partial {
    fn finish(self, id: String, mtime: SystemTime) -> SessionSummary {
        let mtime_ms = system_time_ms(mtime);
        let started = self.started_ms.unwrap_or(mtime_ms);
        let last = self.last_ms.unwrap_or(mtime_ms);
        SessionSummary {
            id,
            title: self.title.unwrap_or_else(|| UNTITLED.to_string()),
            started_at: format_iso_ms(started),
            last_active: format_iso_ms(last),
            branch: self.branch,
            messages: self.prompts.saturating_add(u32::try_from(self.assistant_ids.len()).unwrap_or(u32::MAX)),
            cwd: self.cwd,
        }
    }

    fn set_title(&mut self, source: TitleSource, title: Option<String>) {
        // `>=`: for the record sources the last one wins.
        if source >= self.title_source
            && let Some(title) = title
        {
            self.title = Some(title);
            self.title_source = source;
        }
    }

    fn take(&mut self, record: Record) {
        // Records are not written in timestamp order, so the earliest and the latest count,
        // not the first and the last.
        if let Some(ms) = record.timestamp.as_deref().and_then(parse_iso_ms) {
            self.started_ms = Some(self.started_ms.map_or(ms, |t| t.min(ms)));
            self.last_ms = Some(self.last_ms.map_or(ms, |t| t.max(ms)));
        }
        if let Some(branch) = non_empty(record.git_branch) {
            self.branch = Some(branch);
        }
        let sidechain = record.is_sidechain.unwrap_or(false);
        match record.kind.as_deref() {
            Some("custom-title") => self.set_title(TitleSource::CustomRecord, non_empty(record.custom_title)),
            Some("ai-title") => self.set_title(TitleSource::AiTitle, non_empty(record.ai_title)),
            Some("user") => {
                if self.cwd.is_none() {
                    self.cwd = non_empty(record.cwd);
                }
                if sidechain || record.is_meta.unwrap_or(false) || record.is_compact_summary.unwrap_or(false) {
                    return;
                }
                let Some(text) = record.message.and_then(|m| m.content).and_then(Content::prompt_text) else {
                    return;
                };
                if is_not_a_prompt(&text) {
                    return;
                }
                self.prompts = self.prompts.saturating_add(1);
                if self.title_source == TitleSource::None {
                    self.set_title(TitleSource::Prompt, prompt_title(&text));
                }
            }
            Some("assistant") if !sidechain => {
                if let Some(id) = record.message.and_then(|m| m.id) {
                    self.assistant_ids.insert(id);
                }
            }
            _ => {}
        }
    }
}

/// Text Claude Code writes as a non-meta `user` record that the operator did not type: a
/// slash-command wrapper, a local command's output, an interrupt marker.
const NOT_PROMPT_PREFIXES: [&str; 4] = ["<command-name>", "<command-message>", "<local-command-", "[Request interrupted"];

fn is_not_a_prompt(text: &str) -> bool {
    let text = text.trim_start();
    NOT_PROMPT_PREFIXES.iter().any(|prefix| text.starts_with(prefix))
}

/// Feed every complete line of `reader` into `partial`. Returns the bytes those complete
/// lines took, the trailing line without a newline (if any, not fed) and the bytes read.
fn feed(mut reader: impl BufRead, partial: &mut Partial) -> (u64, Option<Vec<u8>>, u64) {
    let mut complete = 0u64;
    let mut read = 0u64;
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = match reader.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Ok(n) => n as u64,
            // A read error mid-file (the file shrank, a network share went away): keep what
            // was read so far.
            Err(_) => break,
        };
        read += n;
        if line.last() != Some(&b'\n') {
            return (complete, Some(std::mem::take(&mut line)), read);
        }
        complete += n;
        if let Some(record) = parse_line(&line) {
            partial.take(record);
        }
    }
    (complete, None, read)
}

/// One line as a record; `None` for a blank line or one that is not a JSON object we read.
fn parse_line(line: &[u8]) -> Option<Record> {
    let bytes = line.trim_ascii();
    if bytes.is_empty() {
        return None;
    }
    serde_json::from_slice::<Record>(bytes).ok()
}

/// The prompt as a title: whitespace collapsed, cut to [`TITLE_MAX_CHARS`] with `…`; `None`
/// when nothing but whitespace is left.
fn prompt_title(text: &str) -> Option<String> {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    if collapsed.chars().count() <= TITLE_MAX_CHARS {
        return Some(collapsed);
    }
    let cut: String = collapsed.chars().take(TITLE_MAX_CHARS).collect();
    Some(format!("{}…", cut.trim_end()))
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

// --- record shapes -----------------------------------------------------------------------

/// The fields of a transcript line we read; every other field is ignored, and a field of an
/// unexpected type reads as absent rather than failing the line.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    #[serde(rename = "type", default, deserialize_with = "lenient_string")]
    kind: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    timestamp: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    cwd: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    git_branch: Option<String>,
    #[serde(default, deserialize_with = "lenient_bool")]
    is_sidechain: Option<bool>,
    #[serde(default, deserialize_with = "lenient_bool")]
    is_meta: Option<bool>,
    #[serde(default, deserialize_with = "lenient_bool")]
    is_compact_summary: Option<bool>,
    #[serde(default, deserialize_with = "lenient_message")]
    message: Option<Message>,
    #[serde(default, deserialize_with = "lenient_string")]
    custom_title: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    ai_title: Option<String>,
}

#[derive(Deserialize)]
struct Message {
    #[serde(default, deserialize_with = "lenient_string")]
    id: Option<String>,
    #[serde(default)]
    content: Option<Content>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Content {
    Text(String),
    Blocks(Vec<Block>),
    Other(IgnoredAny),
}

impl Content {
    /// The prompt text: the string itself, or the first `text` block's text. `None` for
    /// content with neither (tool results, images only).
    fn prompt_text(self) -> Option<String> {
        match self {
            Content::Text(text) => Some(text),
            Content::Blocks(blocks) => blocks
                .into_iter()
                .find(|b| b.kind.as_deref() == Some("text") && b.text.is_some())
                .and_then(|b| b.text),
            Content::Other(_) => None,
        }
    }
}

#[derive(Deserialize)]
struct Block {
    #[serde(rename = "type", default, deserialize_with = "lenient_string")]
    kind: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    text: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Lenient<T> {
    Value(T),
    Other(IgnoredAny),
}

fn lenient_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Option::<Lenient<String>>::deserialize(d)? {
        Some(Lenient::Value(v)) => Some(v),
        _ => None,
    })
}

fn lenient_bool<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
    Ok(match Option::<Lenient<bool>>::deserialize(d)? {
        Some(Lenient::Value(v)) => Some(v),
        _ => None,
    })
}

fn lenient_message<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Message>, D::Error> {
    Ok(match Option::<Lenient<Message>>::deserialize(d)? {
        Some(Lenient::Value(v)) => Some(v),
        _ => None,
    })
}

// --- time --------------------------------------------------------------------------------

/// Milliseconds since the Unix epoch of `time` (negative before it).
pub fn system_time_ms(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(e) => -i64::try_from(e.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The inverse of [`days_from_civil`]: `(year, month, day)`.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 }, m, d)
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC) for milliseconds since the epoch.
pub fn format_iso_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    )
}

/// Milliseconds since the epoch of an ISO 8601 / RFC 3339 date-time
/// (`2026-10-16T14:33:02.138Z`, fraction optional, `Z` or `±HH:MM`). `None` for anything else.
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    let b = text.trim().as_bytes();
    let num = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = b.get(range)?;
        if part.is_empty() || !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let mut i = 19;
    let mut millis = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return None;
        }
        let digits = &b[start..i.min(start + 3)];
        let mut value: i64 = std::str::from_utf8(digits).ok()?.parse().ok()?;
        for _ in digits.len()..3 {
            value *= 10;
        }
        millis = value;
    }
    let offset_min = match b.get(i) {
        Some(b'Z' | b'z') if i + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) if b.len() == i + 6 && b[i + 3] == b':' => {
            let minutes = num(i + 1..i + 3)? * 60 + num(i + 4..i + 6)?;
            if *sign == b'+' { minutes } else { -minutes }
        }
        _ => return None,
    };
    let days = days_from_civil(y, mo, d);
    Some(((days * 24 + h) * 60 + mi - offset_min) * 60_000 + s * 1000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Every line of `reader`, the unterminated last one too, fed into a fresh state.
    fn summarise_reader(reader: impl BufRead) -> Partial {
        let mut partial = Partial::default();
        let (_, tail, _) = feed(reader, &mut partial);
        if let Some(record) = tail.as_deref().and_then(parse_line) {
            partial.take(record);
        }
        partial
    }

    fn mtime() -> SystemTime {
        UNIX_EPOCH + std::time::Duration::from_millis(1_760_000_000_123)
    }

    fn run(lines: &[&str]) -> SessionSummary {
        let text = lines.join("\n");
        summarise_reader(Cursor::new(text.into_bytes())).finish("s".into(), mtime())
    }

    // Real-shaped lines (Claude Code 2.1.30x): field names as seen on disk, content made up.
    const MODE: &str = r#"{"type":"mode","mode":"normal","sessionId":"s"}"#;
    const PERMISSION: &str = r#"{"type":"permission-mode","permissionMode":"auto","sessionId":"s"}"#;
    const LATCH: &str = r#"{"type":"atis-latch","atis":"","sessionId":"s"}"#;
    const SNAPSHOT: &str = r#"{"type":"file-history-snapshot","messageId":"m0","snapshot":{"messageId":"m0","trackedFileBackups":{},"timestamp":"2026-10-16T14:00:00.000Z"},"isSnapshotUpdate":false}"#;
    const SYSTEM: &str = r#"{"parentUuid":null,"isSidechain":false,"type":"system","subtype":"x","content":"c","level":"info","timestamp":"2026-10-16T14:33:02.000Z","uuid":"y0","isMeta":false,"cwd":"/work/ide","sessionId":"s","version":"2.1.301","gitBranch":"main"}"#;
    const META_USER: &str = r#"{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"<local-command-caveat>meta</local-command-caveat>"},"isMeta":true,"uuid":"u0","timestamp":"2026-10-16T14:33:02.100Z","cwd":"/work/ide","sessionId":"s","gitBranch":"main"}"#;
    const PROMPT: &str = r#"{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"Fix   the\n\tlogin  bug"},"uuid":"u1","timestamp":"2026-10-16T14:33:02.138Z","cwd":"/work/ide","sessionId":"s","version":"2.1.301","gitBranch":"main"}"#;
    const ASSIST_1A: &str = r#"{"parentUuid":"u1","isSidechain":false,"type":"assistant","message":{"model":"m","id":"msg_1","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"t"}]},"uuid":"a1","timestamp":"2026-10-16T14:33:05.000Z","cwd":"/work/ide","sessionId":"s","gitBranch":"main"}"#;
    const ASSIST_1B: &str = r#"{"parentUuid":"a1","isSidechain":false,"type":"assistant","message":{"model":"m","id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"done"}]},"uuid":"a2","timestamp":"2026-10-16T14:33:06.000Z","cwd":"/work/ide","sessionId":"s","gitBranch":"main"}"#;
    const TOOL_RESULT: &str = r#"{"parentUuid":"a2","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"uuid":"u2","timestamp":"2026-10-16T14:33:07.000Z","cwd":"/work/ide","sessionId":"s","gitBranch":"main"}"#;
    const BLOCK_PROMPT: &str = r#"{"parentUuid":"u2","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"image","source":{}},{"type":"text","text":"second prompt"}]},"uuid":"u3","timestamp":"2026-10-16T14:40:00.000Z","cwd":"/work/ide","sessionId":"s","gitBranch":"feature/x"}"#;
    const SIDE_USER: &str = r#"{"isSidechain":true,"type":"user","message":{"role":"user","content":"sidechain prompt"},"timestamp":"2026-10-16T14:41:00.000Z","sessionId":"s"}"#;
    const SIDE_ASSIST: &str = r#"{"isSidechain":true,"type":"assistant","message":{"id":"msg_side","content":[]},"timestamp":"2026-10-16T14:41:01.000Z","sessionId":"s"}"#;
    const ASSIST_2: &str = r#"{"parentUuid":"u3","isSidechain":false,"type":"assistant","message":{"id":"msg_2","role":"assistant","content":[]},"uuid":"a3","timestamp":"2026-10-16T14:42:00.000Z","sessionId":"s","gitBranch":""}"#;
    const AI_TITLE_1: &str = r#"{"type":"ai-title","aiTitle":"Fixing login","sessionId":"s"}"#;
    const AI_TITLE_2: &str = r#"{"type":"ai-title","aiTitle":"Fixing the login bug","sessionId":"s"}"#;
    const CUSTOM: &str = r#"{"type":"custom-title","customTitle":"My login fix","sessionId":"s"}"#;
    const LAST_PROMPT: &str = r#"{"type":"last-prompt","lastPrompt":"second prompt","leafUuid":"u3","sessionId":"s"}"#;
    const ATTACHMENT: &str = r#"{"parentUuid":"u1","isSidechain":false,"attachment":{"type":"x"},"type":"attachment","uuid":"at","timestamp":"2026-10-16T14:33:03.000Z","sessionId":"s"}"#;
    const QUEUE: &str = r#"{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-16T14:33:04.000Z","sessionId":"s","content":"x"}"#;
    const COST: &str = r#"{"type":"cost-state","sessionId":"s","totalCostUSD":1.5,"modelUsage":{}}"#;
    const PR_LINK: &str = r#"{"type":"pr-link","sessionId":"s","url":"u"}"#;
    const FOO: &str = r#"{"type":"foo","sessionId":"s","timestamp":"2026-10-16T14:43:00.000Z","message":{"id":"msg_foo","content":"foo prompt"}}"#;

    fn full_session() -> Vec<&'static str> {
        vec![
            MODE, PERMISSION, LATCH, SNAPSHOT, SYSTEM, META_USER, PROMPT, ATTACHMENT, QUEUE, ASSIST_1A, ASSIST_1B, TOOL_RESULT,
            BLOCK_PROMPT, SIDE_USER, SIDE_ASSIST, ASSIST_2, LAST_PROMPT, COST, PR_LINK,
        ]
    }

    #[test]
    fn a_full_session_yields_times_branch_cwd_count_and_the_first_prompt_as_title() {
        let s = run(&full_session());
        assert_eq!(s.title, "Fix the login bug", "whitespace collapsed");
        assert_eq!(s.started_at, "2026-10-16T14:33:02.000Z", "the earliest timestamp");
        assert_eq!(s.last_active, "2026-10-16T14:42:00.000Z");
        assert_eq!(s.branch.as_deref(), Some("feature/x"), "latest non-empty");
        assert_eq!(s.cwd.as_deref(), Some("/work/ide"), "from the first user record");
        // Prompts: PROMPT, BLOCK_PROMPT (meta, tool result, sidechain skipped); assistant ids:
        // msg_1 (twice), msg_2 (sidechain msg_side skipped).
        assert_eq!(s.messages, 4);
    }

    #[test]
    fn title_precedence_custom_record_then_file_then_ai_then_prompt() {
        let mut lines = full_session();
        lines.extend([AI_TITLE_1, AI_TITLE_2]);
        assert_eq!(run(&lines).title, "Fixing the login bug", "the last ai-title");
        lines.insert(2, CUSTOM);
        assert_eq!(run(&lines).title, "My login fix", "custom wins even before later ai-titles");
        let custom2 = r#"{"type":"custom-title","customTitle":"Renamed","sessionId":"s"}"#;
        lines.push(custom2);
        assert_eq!(run(&lines).title, "Renamed", "the last custom-title");
        let empty_custom = r#"{"type":"custom-title","customTitle":"  ","sessionId":"s"}"#;
        lines.push(empty_custom);
        assert_eq!(run(&lines).title, "Renamed", "an empty title is no title");
    }

    #[test]
    fn a_long_prompt_is_cut_at_sixty_characters_with_an_ellipsis() {
        let long = "word ".repeat(30);
        let line = serde_json::json!({ "type": "user", "message": { "content": long } }).to_string();
        let title = run(&[&line]).title;
        assert!(title.ends_with('…'));
        assert_eq!(title.chars().count(), 60, "59 kept (trailing space trimmed) + …: {title}");
        let exact = "x".repeat(60);
        let line = serde_json::json!({ "type": "user", "message": { "content": exact } }).to_string();
        assert_eq!(run(&[&line]).title, exact, "60 fits");
        let over = "y".repeat(61);
        let line = serde_json::json!({ "type": "user", "message": { "content": over } }).to_string();
        assert_eq!(run(&[&line]).title, format!("{}…", "y".repeat(60)));
    }

    #[test]
    fn no_prompt_and_no_title_record_is_untitled() {
        let s = run(&[MODE, META_USER, TOOL_RESULT, SIDE_USER]);
        assert_eq!(s.title, UNTITLED);
        assert_eq!(s.messages, 0);
        assert_eq!(s.cwd.as_deref(), Some("/work/ide"), "a meta user record still gives the cwd");
    }

    #[test]
    fn unknown_record_types_are_skipped_and_change_nothing() {
        let plain = run(&full_session());
        let mut lines = full_session();
        lines.insert(7, FOO);
        lines.insert(3, COST);
        lines.insert(1, LATCH);
        let with_unknown = run(&lines);
        // FOO carries a timestamp, which counts as activity; strip that to compare the rest.
        assert_eq!(with_unknown.title, plain.title);
        assert_eq!(with_unknown.messages, plain.messages);
        assert_eq!(with_unknown.branch, plain.branch);
        assert_eq!(with_unknown.cwd, plain.cwd);
        assert_eq!(with_unknown.started_at, plain.started_at);
    }

    #[test]
    fn corrupt_and_truncated_lines_are_skipped_and_the_rest_parses() {
        let mut lines = vec!["not json at all", "", "{\"type\":"];
        lines.extend(full_session());
        lines.insert(8, "\u{0}\u{1}garbage");
        // A live session's half-written last line.
        let truncated = &ASSIST_2[..ASSIST_2.len() / 2];
        lines.push(truncated);
        let s = run(&lines);
        assert_eq!(s.title, "Fix the login bug");
        assert_eq!(s.messages, 4);

        // Non-UTF-8 bytes on a line do not stop the stream.
        let mut bytes = b"\xff\xfe\n".to_vec();
        bytes.extend_from_slice(PROMPT.as_bytes());
        let s = summarise_reader(Cursor::new(bytes)).finish("s".into(), mtime());
        assert_eq!(s.title, "Fix the login bug");
    }

    #[test]
    fn a_field_of_an_unexpected_type_reads_as_absent_not_as_a_lost_line() {
        let odd = r#"{"type":"user","isSidechain":"no","isMeta":null,"gitBranch":42,"timestamp":7,"cwd":["x"],"message":{"id":5,"content":"odd prompt"}}"#;
        let s = run(&[odd]);
        assert_eq!(s.title, "odd prompt");
        assert_eq!(s.messages, 1);
        assert_eq!(s.branch, None);
        assert_eq!(s.cwd, None);
        let weird_message = r#"{"type":"user","message":"just a string"}"#;
        assert_eq!(run(&[weird_message, PROMPT]).title, "Fix the login bug");
    }

    #[test]
    fn a_transcript_with_no_record_takes_its_mtime_and_is_untitled() {
        let s = run(&[]);
        assert_eq!(s.title, UNTITLED);
        assert_eq!(s.started_at, "2025-10-09T08:53:20.123Z");
        assert_eq!(s.last_active, s.started_at);
        assert_eq!(s.branch, None);
        assert_eq!(s.messages, 0);
        assert_eq!(s.cwd, None);
    }

    #[test]
    fn summarise_reads_the_file_its_stem_and_the_custom_title_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("abc-123.jsonl");
        let mut text = full_session().join("\n");
        text.push('\n');
        text.push_str(AI_TITLE_1);
        fs::write(&path, &text).unwrap();
        let s = summarise(&path).unwrap();
        assert_eq!(s.id, "abc-123");
        assert_eq!(s.title, "Fixing login");

        // custom-title.json beats an ai-title, loses to a custom-title record.
        fs::create_dir_all(dir.path().join("abc-123")).unwrap();
        fs::write(dir.path().join("abc-123").join(CUSTOM_TITLE_FILE), r#"{"customTitle":"From the file"}"#).unwrap();
        assert_eq!(summarise(&path).unwrap().title, "From the file");
        text.push('\n');
        text.push_str(CUSTOM);
        fs::write(&path, &text).unwrap();
        assert_eq!(summarise(&path).unwrap().title, "My login fix");

        // A broken custom-title.json is ignored.
        fs::write(&path, full_session().join("\n")).unwrap();
        fs::write(dir.path().join("abc-123").join(CUSTOM_TITLE_FILE), "{ broken").unwrap();
        assert_eq!(summarise(&path).unwrap().title, "Fix the login bug");

        assert_eq!(summarise(&dir.path().join("absent.jsonl")), None);
    }

    fn user(content: serde_json::Value) -> String {
        serde_json::json!({ "type": "user", "isSidechain": false, "message": { "role": "user", "content": content } }).to_string()
    }

    #[test]
    fn command_wrappers_output_interrupts_and_compact_summaries_are_not_prompts() {
        let shapes = [
            user(serde_json::json!("<command-name>/clear</command-name>\n<command-message>clear</command-message>")),
            user(serde_json::json!("<command-message>review is running…</command-message>\n<command-name>/review</command-name>")),
            user(serde_json::json!("<local-command-stdout>done</local-command-stdout>")),
            user(serde_json::json!("  <local-command-stderr>oops</local-command-stderr>")),
            user(serde_json::json!("[Request interrupted by user]")),
            user(serde_json::json!([{ "type": "text", "text": "[Request interrupted by user for tool use]" }])),
            serde_json::json!({ "type": "user", "isCompactSummary": true, "message": { "content": "This session is being continued…" } }).to_string(),
        ];
        for shape in &shapes {
            let s = run(&[shape.as_str()]);
            assert_eq!(s.title, UNTITLED, "{shape}");
            assert_eq!(s.messages, 0, "{shape}");
            // Before a real prompt they change neither the title nor the count.
            let s = run(&[shape.as_str(), PROMPT]);
            assert_eq!(s.title, "Fix the login bug", "{shape}");
            assert_eq!(s.messages, 1, "{shape}");
        }
    }

    #[test]
    fn a_whitespace_only_first_prompt_counts_but_the_next_one_titles() {
        let blank = user(serde_json::json!("   \n\t "));
        let s = run(&[blank.as_str(), PROMPT]);
        assert_eq!(s.title, "Fix the login bug");
        assert_eq!(s.messages, 2);
    }

    #[test]
    fn started_and_last_active_are_the_earliest_and_latest_timestamps_not_the_first_and_last() {
        let at = |ts: &str| serde_json::json!({ "type": "system", "timestamp": ts }).to_string();
        let lines = [
            at("2026-10-16T10:05:00.000Z"),
            at("2026-10-16T10:00:00.000Z"),
            at("2026-10-16T10:30:00.000Z"),
            at("2026-10-16T10:10:00.000Z"),
        ];
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let s = run(&refs);
        assert_eq!(s.started_at, "2026-10-16T10:00:00.000Z");
        assert_eq!(s.last_active, "2026-10-16T10:30:00.000Z");
    }

    #[test]
    fn a_resumed_parse_reads_only_the_appended_bytes_and_equals_a_full_parse() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let head = [MODE, PROMPT, ASSIST_1A].join("\n") + "\n";
        fs::write(&path, &head).unwrap();
        let first = summarise_from(&path, None).unwrap();
        assert_eq!(first.bytes_read, head.len() as u64);
        assert_eq!(first.progress.offset(), head.len() as u64);

        // A record being written: counted now, but the offset stays before it.
        let half = &ASSIST_1B[..ASSIST_1B.len() / 2];
        fs::File::options().append(true).open(&path).unwrap().write_all(half.as_bytes()).unwrap();
        let partial = summarise_from(&path, Some(&first.progress)).unwrap();
        assert_eq!(partial.bytes_read, half.len() as u64);
        assert_eq!(partial.progress.offset(), head.len() as u64);

        let rest = format!("{}\n{}\n{}\n", &ASSIST_1B[ASSIST_1B.len() / 2..], BLOCK_PROMPT, ASSIST_2);
        fs::File::options().append(true).open(&path).unwrap().write_all(rest.as_bytes()).unwrap();
        let resumed = summarise_from(&path, Some(&partial.progress)).unwrap();
        assert_eq!(resumed.bytes_read, (half.len() + rest.len()) as u64, "only from the last complete line on");
        assert_eq!(resumed.summary, summarise(&path).unwrap(), "same as a parse from byte 0");
        assert_eq!(resumed.summary.messages, 4);

        // A file shorter than the offset (rewritten) is parsed from 0.
        fs::write(&path, PROMPT).unwrap();
        let restarted = summarise_from(&path, Some(&resumed.progress)).unwrap();
        assert_eq!(restarted.bytes_read, PROMPT.len() as u64);
        assert_eq!(restarted.summary.messages, 1);
    }

    #[test]
    fn iso_timestamps_parse_and_format_round_trip() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(parse_iso_ms("2026-10-16T14:33:02.138Z"), Some(1_792_161_182_138));
        assert_eq!(parse_iso_ms("2026-10-16T16:33:02.138+02:00"), Some(1_792_161_182_138));
        assert_eq!(parse_iso_ms("2026-10-16T14:33:02.1381234Z"), Some(1_792_161_182_138));
        assert_eq!(parse_iso_ms("1969-12-31T23:59:59.000Z"), Some(-1000));
        for bad in ["", "yesterday", "2026-10-16", "2026-13-01T00:00:00Z", "2026-10-16T14:33:02", "2026-10-16T14:33:02.Z", "2026-10-16T14:33:02Zjunk"] {
            assert_eq!(parse_iso_ms(bad), None, "{bad}");
        }
        for ms in [0, 1_792_161_182_138, 951_782_400_000 /* 2000-02-29 */, -1000, 4_102_444_800_000] {
            assert_eq!(parse_iso_ms(&format_iso_ms(ms)), Some(ms));
        }
        assert_eq!(format_iso_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(system_time_ms(UNIX_EPOCH - std::time::Duration::from_secs(1)), -1000);
    }
}
