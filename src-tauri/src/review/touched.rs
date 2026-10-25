//! Session-touched files (Story 8.4): the files a session's own transcript says it edited.
//!
//! **What is read.** The session's transcript (`<claude_home>/projects/*/<id>.jsonl`, found by
//! [`crate::claude::live_edges::find_transcript`]), read-only and leniently: a line that is not
//! JSON (a half-written last line included) or not shaped as expected is skipped. Every assistant
//! record's `tool_use` blocks named `Edit`, `Write` or `MultiEdit` give `input.file_path`, and
//! `NotebookEdit` gives `input.notebook_path`. Sidechain records in the same file count; separate
//! subagent transcript files are never read.
//!
//! **Keys.** The absolute paths are mapped to the reviewed folder's relative keys (`/` between
//! the parts) with 7.4's canonical rule ([`super::request_keys`]), and also lexically (a file
//! reached through a link inside the folder keeps the key it was named by); a path outside the
//! folder (or the folder itself), and a path that is not absolute on this OS, are left out.
//!
//! **Cost.** A transcript only grows, so each one's scan is kept (in memory) with the offset just
//! past its last complete line and resumed from there. The scan is keyed on the file's length and
//! modified time (unchanged: nothing is read) and a fingerprint of its start and of the bytes
//! before the offset; a file that shrank or whose fingerprint changed (rewritten) is read again from
//! the start. Lines without `"tool_use"` are skipped before they are parsed. A removed session's
//! scan goes ([`forget`]).

use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use serde_json::Value;

use super::{ReviewPath, normalise, request_keys};
use crate::settings::AppState;

/// The tools whose `input.file_path` names an edited file.
pub const FILE_TOOLS: [&str; 3] = ["Edit", "Write", "MultiEdit"];

/// The tool whose `input.notebook_path` names an edited notebook.
pub const NOTEBOOK_TOOL: &str = "NotebookEdit";

/// The edited paths named by one transcript line (as written, in order); none for a line that is
/// not an assistant record with edit `tool_use` blocks.
pub fn line_paths(line: &[u8]) -> Vec<String> {
    let bytes = line.trim_ascii();
    if bytes.is_empty() || !contains(bytes, b"\"tool_use\"") {
        return Vec::new();
    }
    let Ok(record) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    if record.get("type").and_then(Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    let Some(blocks) = record.get("message").and_then(|m| m.get("content")).and_then(Value::as_array) else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter_map(|b| {
            let name = b.get("name").and_then(Value::as_str)?;
            let field = if FILE_TOOLS.contains(&name) {
                "file_path"
            } else if name == NOTEBOOK_TOOL {
                "notebook_path"
            } else {
                return None;
            };
            b.get("input")?.get(field)?.as_str().map(str::to_string)
        })
        .filter(|p| !p.trim().is_empty())
        .collect()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// One transcript's scan so far.
#[derive(Debug, Clone, Default)]
struct Scan {
    /// Just past the last complete line read.
    offset: u64,
    /// The edited paths, each once, in the order first seen.
    paths: Vec<String>,
    /// The file's length and modified time when it was read.
    len: u64,
    modified: Option<SystemTime>,
    /// [`fingerprint`] at `offset`.
    print: u64,
}

/// How many bytes of the start, and before the offset, the fingerprint covers.
const PRINT_HEAD: u64 = 4096;
const PRINT_TAIL: u64 = 256;

/// A hash of the file's first [`PRINT_HEAD`] bytes and the [`PRINT_TAIL`] bytes before `offset`
/// (both cut at `offset`): a rewrite that keeps or grows the length still changes it.
fn fingerprint(file: &mut fs::File, offset: u64) -> Option<u64> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut read = |from: u64, len: u64| -> Option<()> {
        file.seek(SeekFrom::Start(from)).ok()?;
        let mut bytes = Vec::new();
        file.by_ref().take(len).read_to_end(&mut bytes).ok()?;
        (bytes.len() as u64 == len).then_some(())?;
        bytes.hash(&mut hasher);
        Some(())
    };
    read(0, offset.min(PRINT_HEAD))?;
    let tail = offset.min(PRINT_TAIL);
    read(offset - tail, tail)?;
    Some(hasher.finish())
}

fn cache() -> &'static Mutex<HashMap<PathBuf, Scan>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Scan>>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

/// The edited paths of the transcript at `path` (each once, in the order first seen), resuming the
/// kept scan when the file only grew. Empty when the file cannot be read.
pub fn edited_paths(path: &Path) -> Vec<String> {
    let Ok(mut file) = fs::File::open(path) else {
        return Vec::new();
    };
    let meta = file.metadata().ok();
    let len = meta.as_ref().map_or(0, fs::Metadata::len);
    let modified = meta.and_then(|m| m.modified().ok());
    let kept = cache().lock().unwrap_or_else(|e| e.into_inner()).get(path).cloned();
    if let Some(kept) = &kept
        && kept.len == len
        && kept.modified == modified
        && modified.is_some()
    {
        return kept.paths.clone();
    }
    // Resumed only when the file grew from where the scan stopped: shorter, or a different start
    // or end of what was read (rewritten), is read from the start.
    let mut scan = kept
        .filter(|s| s.offset <= len && fingerprint(&mut file, s.offset) == Some(s.print))
        .unwrap_or_default();
    if file.seek(SeekFrom::Start(scan.offset)).is_err() {
        scan = Scan::default();
        if file.seek(SeekFrom::Start(0)).is_err() {
            return Vec::new();
        }
    }
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                // A line still being written is read again next time.
                if line.last() != Some(&b'\n') {
                    break;
                }
                scan.offset += n as u64;
                for found in line_paths(&line) {
                    if !scan.paths.contains(&found) {
                        scan.paths.push(found);
                    }
                }
            }
        }
    }
    let mut file = reader.into_inner();
    scan.print = fingerprint(&mut file, scan.offset).unwrap_or_default();
    scan.len = len;
    scan.modified = modified;
    let paths = scan.paths.clone();
    cache().lock().unwrap_or_else(|e| e.into_inner()).insert(path.to_path_buf(), scan);
    paths
}

/// Sessions removed from the workspace: their transcripts' kept scans go.
pub fn forget<'a>(ids: impl IntoIterator<Item = &'a str>) {
    let ids: Vec<&str> = ids.into_iter().collect();
    cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|path, _| !path.file_stem().and_then(|s| s.to_str()).is_some_and(|stem| ids.contains(&stem)));
}

/// Whether `path`'s scan is kept (tests).
#[cfg(test)]
fn is_kept(path: &Path) -> bool {
    cache().lock().unwrap_or_else(|e| e.into_inner()).contains_key(path)
}

/// `path` relative to `folder`, compared on the text (nothing is resolved): `None` outside it or
/// for the folder itself.
fn lexical_key(folder: &Path, path: &Path) -> Option<String> {
    let root = normalise(folder);
    let path = normalise(path);
    if !crate::graph::path_within(&path.display().to_string(), &root.display().to_string()) {
        return None;
    }
    let rest: Vec<String> = path.components().skip(root.components().count()).map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    (!rest.is_empty()).then(|| rest.join("/"))
}

/// `paths` (as a transcript names them; only absolute ones on this OS count) as the reviewed
/// `folder`'s relative keys, sorted, each once: the canonical key ([`request_keys`], links
/// followed) and the lexical one ([`lexical_key`]) where it lies inside; paths outside the folder,
/// and the folder itself, are left out.
pub fn touched_keys(folder: &Path, paths: &[String]) -> Vec<String> {
    let absolute: Vec<&Path> = paths.iter().map(Path::new).filter(|p| p.is_absolute()).collect();
    let listed: Vec<ReviewPath> = absolute
        .iter()
        .map(|p| ReviewPath {
            path: normalise(p).display().to_string(),
            display: String::new(),
            missing: false,
        })
        .collect();
    let mut keys: Vec<String> = request_keys(folder, &listed)
        .into_iter()
        .filter_map(|k| k.key)
        .chain(absolute.iter().filter_map(|p| lexical_key(folder, p)))
        .filter(|k| !k.is_empty())
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

/// Whether `id` can name a transcript file (no separators or dots that could climb out).
fn plain_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The files session `id` touched, keyed to the reviewed `folder`; empty without a claude home or
/// a transcript yet.
pub fn session_touched(state: &AppState, id: &str, folder: &Path) -> Vec<String> {
    if !plain_id(id) {
        return Vec::new();
    }
    let Some(home) = state.claude_home.get() else {
        return Vec::new();
    };
    let Some(transcript) = crate::claude::live_edges::find_transcript(home, id) else {
        return Vec::new();
    };
    touched_keys(folder, &edited_paths(&transcript))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool_use(name: &str, input: Value) -> Value {
        json!({ "type": "tool_use", "id": "t", "name": name, "input": input })
    }

    fn assistant(blocks: Vec<Value>, sidechain: bool) -> String {
        json!({ "type": "assistant", "isSidechain": sidechain, "message": { "id": "m", "role": "assistant", "content": blocks } }).to_string()
    }

    #[test]
    fn edit_tools_name_their_files_and_other_tools_do_not() {
        let line = assistant(
            vec![
                json!({ "type": "text", "text": "editing" }),
                tool_use("Edit", json!({ "file_path": "/w/a.ts", "old_string": "x", "new_string": "y" })),
                tool_use("Write", json!({ "file_path": "/w/b.md", "content": "" })),
                tool_use("MultiEdit", json!({ "file_path": "/w/c.rs", "edits": [] })),
                tool_use("NotebookEdit", json!({ "notebook_path": "/w/n.ipynb", "new_source": "" })),
                tool_use("Read", json!({ "file_path": "/w/read.ts" })),
                tool_use("Edit", json!({ "file_path": 7 })),
                tool_use("Write", json!({})),
            ],
            false,
        );
        assert_eq!(line_paths(line.as_bytes()), ["/w/a.ts", "/w/b.md", "/w/c.rs", "/w/n.ipynb"]);
        let user = json!({ "type": "user", "message": { "content": [tool_use("Edit", json!({ "file_path": "/w/u.ts" }))] } }).to_string();
        assert!(line_paths(user.as_bytes()).is_empty(), "only assistant records");
        assert!(line_paths(b"{not json \"tool_use\"").is_empty());
        assert!(line_paths(b"").is_empty());
    }

    #[test]
    fn a_transcript_is_scanned_leniently_and_resumed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let first = assistant(vec![tool_use("Edit", json!({ "file_path": "/w/a.ts" }))], false);
        let side = assistant(vec![tool_use("Write", json!({ "file_path": "/w/side.md" }))], true);
        fs::write(&path, format!("{first}\n{{broken\n\n{side}\n{first}\n")).unwrap();
        assert_eq!(edited_paths(&path), ["/w/a.ts", "/w/side.md"], "sidechain records count; a path once");
        // Grown, with a half-written last line: it is read once complete.
        let more = assistant(vec![tool_use("MultiEdit", json!({ "file_path": "/w/c.rs" }))], false);
        let mut text = fs::read_to_string(&path).unwrap();
        text.push_str(&more[..10]);
        fs::write(&path, &text).unwrap();
        assert_eq!(edited_paths(&path), ["/w/a.ts", "/w/side.md"]);
        text.push_str(&more[10..]);
        text.push('\n');
        fs::write(&path, &text).unwrap();
        assert_eq!(edited_paths(&path), ["/w/a.ts", "/w/side.md", "/w/c.rs"]);
        // Shrunk (rewritten): read from the start.
        fs::write(&path, format!("{more}\n")).unwrap();
        assert_eq!(edited_paths(&path), ["/w/c.rs"]);
        // Rewritten at a greater length with other content: read from the start too.
        let other = assistant(vec![tool_use("Write", json!({ "file_path": "/w/zz.md" }))], false);
        fs::write(&path, format!("{other}\n{other}\n")).unwrap();
        assert_eq!(edited_paths(&path), ["/w/zz.md"]);
        // Rewritten at the same length: still noticed.
        let same = other.replace("zz.md", "yy.md");
        fs::write(&path, format!("{same}\n{same}\n")).unwrap();
        // (A clock tick later, as a real rewrite would be.)
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(10))
            .unwrap();
        assert_eq!(edited_paths(&path), ["/w/yy.md"]);
        assert!(edited_paths(&dir.path().join("none.jsonl")).is_empty());
    }

    #[test]
    fn a_removed_sessions_scan_is_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f0f0f0f0-forget.jsonl");
        let keep = dir.path().join("f1f1f1f1-keep.jsonl");
        let line = assistant(vec![tool_use("Edit", json!({ "file_path": "/w/a.ts" }))], false);
        fs::write(&path, format!("{line}\n")).unwrap();
        fs::write(&keep, format!("{line}\n")).unwrap();
        edited_paths(&path);
        edited_paths(&keep);
        assert!(is_kept(&path) && is_kept(&keep));
        forget(["f0f0f0f0-forget"]);
        assert!(!is_kept(&path));
        assert!(is_kept(&keep), "another session's scan stays");
    }

    #[test]
    fn paths_are_keyed_to_the_folder_and_outside_ones_left_out() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let folder = base.join("repo");
        fs::create_dir_all(folder.join("src")).unwrap();
        fs::write(folder.join("src").join("a.ts"), "a").unwrap();
        let sep = std::path::MAIN_SEPARATOR;
        let root = folder.display().to_string();
        let paths = vec![
            format!("{root}{sep}src{sep}a.ts"),
            format!("{root}{sep}b.md"),
            format!("{root}/src/a.ts"),
            base.join("other").join("x.md").display().to_string(),
            format!("{root}ository{sep}y.md"),
            root.clone(),
            "rel/c.txt".to_string(),
        ];
        assert_eq!(touched_keys(&folder, &paths), ["b.md", "src/a.ts"], "relative paths are not counted");
        if cfg!(windows) {
            // A Windows path in another case and with forward slashes names the same file.
            let upper = format!("{}/SRC/A.TS", root.to_uppercase());
            assert!(touched_keys(&folder, &[upper]).contains(&"src/a.ts".to_string()));
        }
    }

    /// A `C:\…` transcript path: keyed on Windows, not an absolute path (so outside) elsewhere.
    #[test]
    fn a_windows_style_path_is_keyed_on_windows_only() {
        let folder = Path::new("C:\\w\\api");
        let keys = touched_keys(folder, &["C:\\w\\api\\src\\a.ts".to_string(), "C:\\w\\other\\b.ts".to_string()]);
        if cfg!(windows) {
            assert_eq!(keys, ["src/a.ts"]);
        } else {
            assert!(keys.is_empty(), "{keys:?}");
        }
    }

    /// A file named through a link inside the folder keeps the key it was named by, wherever the
    /// link points. Skipped where links cannot be made.
    #[test]
    fn a_path_through_a_link_keeps_its_lexical_key() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let folder = base.join("repo");
        let target = base.join("shared");
        fs::create_dir_all(&folder).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("x.md"), "x").unwrap();
        let link = folder.join("docs");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&target, &link).is_ok()
            || std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&target)
                .output()
                .is_ok_and(|o| o.status.success());
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(&target, &link).is_ok();
        if !made {
            eprintln!("skipped: cannot create a link here");
            return;
        }
        assert_eq!(touched_keys(&folder, &[link.join("x.md").display().to_string()]), ["docs/x.md"]);
    }

    #[test]
    fn a_session_id_never_climbs_out_of_the_projects_folder() {
        assert!(plain_id("a1a1a1a1-5b7d-4e8f-9a0b-1c2d3e4f5a6b"));
        assert!(!plain_id("../x"));
        assert!(!plain_id(""));
        assert!(!plain_id("a/b"));
    }
}
