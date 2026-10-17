//! Claude Code project discovery: every directory under `<claude_home>/projects/` is one
//! working directory Claude has been run in. The directory name is the `cwd` with `:`, `\`,
//! `/`, space and `.` replaced by `-` (lossy), so the real `cwd` is taken from the newest
//! transcript's first `user` record and the decoded name is only a fallback.
//!
//! Everything here is tolerant: an unreadable directory or transcript skips that entry, a
//! record that is not JSON is skipped, unknown record types are skipped. Nothing is written.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

/// Sub-directory of `claude_home` holding one directory per project.
pub const PROJECTS_DIR: &str = "projects";

/// How much of the newest transcript is read looking for the first `user` record. The
/// first one is normally within the first few KB (a handful of small records precede it).
pub const TRANSCRIPT_SCAN_BYTES: u64 = 64 * 1024;

/// One directory under `~/.claude/projects`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaudeProject {
    /// The directory name (`B--projects-ide`).
    pub dir: String,
    /// The working directory it stands for, from the transcript or decoded from the name.
    pub cwd: String,
    /// Whether `cwd` is a directory on this machine right now.
    pub exists: bool,
    /// Number of `*.jsonl` transcripts in the directory.
    pub sessions: usize,
    /// Already a project node on the canvas. Always `false` from [`list_projects`]; the
    /// `claude_projects_list` command fills it in against the workspace.
    pub on_canvas: bool,
}

/// List Claude's projects, newest activity first. A missing `projects/` directory (Claude
/// never run) is an empty list, not an error.
pub fn list_projects(claude_home: &Path) -> Vec<ClaudeProject> {
    let Ok(entries) = fs::read_dir(claude_home.join(PROJECTS_DIR)) else {
        return Vec::new();
    };
    let mut found: Vec<(Option<SystemTime>, ClaudeProject)> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|entry| scan_project_dir(&entry.path()))
        .collect();
    // Newest first; ties (and dirs with no transcript) by name so the order is total.
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.dir.cmp(&b.1.dir)));
    found.into_iter().map(|(_, project)| project).collect()
}

/// One project directory: count its transcripts, read the `cwd` from the newest one that
/// yields it (newest → oldest; a long first prompt can push the `user` record past the scan
/// window), decoding the name only when none does.
fn scan_project_dir(dir: &Path) -> Option<(Option<SystemTime>, ClaudeProject)> {
    let name = dir.file_name()?.to_str()?.to_string();
    let mut transcripts = list_transcripts(dir)?;
    transcripts.sort_by(|a, b| b.0.cmp(&a.0));
    let newest = transcripts.first().map(|(modified, _)| *modified);
    let cwd = transcripts
        .iter()
        .find_map(|(_, path)| cwd_from_transcript(path))
        .or_else(|| decode_dir_name(&name))?;
    let exists = Path::new(&cwd).is_dir();
    Some((
        newest,
        ClaudeProject {
            dir: name,
            cwd,
            exists,
            sessions: transcripts.len(),
            on_canvas: false,
        },
    ))
}

/// `(modified, path)` of every `*.jsonl` directly in `dir`; `None` when it cannot be read.
fn list_transcripts(dir: &Path) -> Option<Vec<(SystemTime, PathBuf)>> {
    let entries = fs::read_dir(dir).ok()?;
    Some(
        entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "jsonl"))
            .filter_map(|entry| {
                let meta = entry.metadata().ok()?;
                if !meta.is_file() {
                    return None;
                }
                Some((meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), entry.path()))
            })
            .collect(),
    )
}

/// The `cwd` of the first `user` record within the first [`TRANSCRIPT_SCAN_BYTES`] of a
/// transcript. `None` when the file cannot be read or no such record is found in that window.
pub fn cwd_from_transcript(path: &Path) -> Option<String> {
    let mut head = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(TRANSCRIPT_SCAN_BYTES)
        .read_to_end(&mut head)
        .ok()?;
    // Fewer bytes than the window means the whole file was read: its last line is complete
    // even without a trailing newline.
    let complete = (head.len() as u64) < TRANSCRIPT_SCAN_BYTES;
    cwd_from_transcript_head(&head, complete)
}

/// The record shape we read; everything else in the line is ignored.
#[derive(Deserialize)]
struct Record<'a> {
    #[serde(rename = "type")]
    kind: Option<&'a str>,
    cwd: Option<String>,
}

/// [`cwd_from_transcript`] on bytes already read. Unless `whole_file` (the bytes are the
/// entire file), a trailing partial line (the window cut a record in two) is not parsed.
pub fn cwd_from_transcript_head(head: &[u8], whole_file: bool) -> Option<String> {
    let text = String::from_utf8_lossy(head);
    let complete: &str = if whole_file {
        &text
    } else {
        match text.rfind('\n') {
            Some(end) => &text[..end],
            None => return None,
        }
    };
    complete
        .lines()
        .filter_map(|line| serde_json::from_str::<Record>(line).ok())
        .find(|record| record.kind == Some("user"))
        .and_then(|record| record.cwd)
        .filter(|cwd| !cwd.is_empty())
}

/// Best-effort inverse of Claude's directory-name encoding, for a project with no readable
/// transcript. `B--projects-ide` → `B:\projects\ide`; `-home-emils-src` → `/home/emils/src`.
/// Lossy: a `-` that was in a folder name comes back as a separator. `None` for a name in
/// neither shape.
pub fn decode_dir_name(name: &str) -> Option<String> {
    let mut chars = name.chars();
    match (chars.next(), chars.next(), chars.next()) {
        (Some(drive), Some('-'), Some('-')) if drive.is_ascii_alphabetic() => {
            let rest = &name[3..];
            Some(format!("{drive}:\\{}", rest.replace('-', "\\")))
        }
        (Some('-'), _, _) => Some(name.replace('-', "/")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real-shaped transcript lines (Claude Code 2.1.301): a few small records precede the
    /// first `user` one, which carries `cwd`.
    fn transcript(cwd: &str, session: &str) -> String {
        let cwd_json = serde_json::to_string(cwd).unwrap();
        format!(
            concat!(
                "{{\"type\":\"mode\",\"mode\":\"normal\",\"sessionId\":\"{s}\"}}\n",
                "{{\"type\":\"permission-mode\",\"permissionMode\":\"auto\",\"sessionId\":\"{s}\"}}\n",
                "{{\"type\":\"atis-latch\",\"atis\":\"\",\"sessionId\":\"{s}\"}}\n",
                "{{\"type\":\"file-history-snapshot\",\"messageId\":\"47be9cfe\",\"snapshot\":{{\"messageId\":\"47be9cfe\",\"trackedFileBackups\":{{}},\"timestamp\":\"2026-10-16T14:33:02.140Z\"}},\"isSnapshotUpdate\":false}}\n",
                "{{\"parentUuid\":null,\"isSidechain\":false,\"promptId\":\"6e6cbed0\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"hello\"}},\"uuid\":\"u1\",\"timestamp\":\"2026-10-16T14:33:02.138Z\",\"permissionMode\":\"auto\",\"origin\":{{\"kind\":\"user\"}},\"userType\":\"external\",\"cwd\":{cwd},\"sessionId\":\"{s}\",\"version\":\"2.1.301\",\"gitBranch\":\"HEAD\"}}\n",
                "{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[]}},\"cwd\":\"/somewhere/else\",\"sessionId\":\"{s}\"}}\n",
            ),
            s = session,
            cwd = cwd_json,
        )
    }

    fn write_transcript(dir: &Path, session: &str, cwd: &str) -> PathBuf {
        let path = dir.join(format!("{session}.jsonl"));
        fs::write(&path, transcript(cwd, session)).unwrap();
        path
    }

    /// Set a file's mtime so "newest" is deterministic without sleeping.
    fn set_mtime(path: &Path, secs_after_epoch: u64) {
        let time = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs_after_epoch);
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(time)
            .unwrap();
    }

    #[test]
    fn decode_dir_name_handles_windows_drives_and_unix_roots() {
        assert_eq!(decode_dir_name("B--projects-ide").as_deref(), Some("B:\\projects\\ide"));
        assert_eq!(
            decode_dir_name("C--Users-emils-Documents-Novels-AI").as_deref(),
            Some("C:\\Users\\emils\\Documents\\Novels\\AI")
        );
        assert_eq!(decode_dir_name("-home-emils-src").as_deref(), Some("/home/emils/src"));
        assert_eq!(decode_dir_name("memory"), None);
        assert_eq!(decode_dir_name(""), None);
        assert_eq!(decode_dir_name("B-projects"), None, "a single dash is not a drive");
    }

    #[test]
    fn cwd_comes_from_the_first_user_record_not_an_earlier_or_later_one() {
        let head = transcript("B:\\projects\\ide", "s1");
        assert_eq!(cwd_from_transcript_head(head.as_bytes(), false).as_deref(), Some("B:\\projects\\ide"));
    }

    #[test]
    fn cwd_scan_skips_junk_lines_and_a_cut_trailing_record() {
        let mut text = String::from("not json at all\n{\"type\":\"mode\"}\n");
        text.push_str(&transcript("/home/me/x", "s1"));
        assert_eq!(cwd_from_transcript_head(text.as_bytes(), false).as_deref(), Some("/home/me/x"));

        // Only a partial line in the window: nothing complete to parse.
        let cut = "{\"type\":\"user\",\"cwd\":\"/home/me/x\"";
        assert_eq!(cwd_from_transcript_head(cut.as_bytes(), false), None);
        assert_eq!(cwd_from_transcript_head(cut.as_bytes(), true), None, "whole file, but not valid JSON");
        // A complete user record followed by a cut one: the complete one wins.
        let mut both = String::from("{\"type\":\"user\",\"cwd\":\"/first\"}\n");
        both.push_str(cut);
        assert_eq!(cwd_from_transcript_head(both.as_bytes(), false).as_deref(), Some("/first"));
        // A user record without cwd, or an empty one, does not count.
        assert_eq!(
            cwd_from_transcript_head(b"{\"type\":\"user\"}\n{\"type\":\"user\",\"cwd\":\"\"}\n", false),
            None
        );
    }

    #[test]
    fn a_whole_file_without_a_trailing_newline_still_yields_its_last_record() {
        let last = b"{\"type\":\"mode\"}\n{\"type\":\"user\",\"cwd\":\"/last\"}";
        assert_eq!(cwd_from_transcript_head(last, false), None, "a window may have cut it");
        assert_eq!(cwd_from_transcript_head(last, true).as_deref(), Some("/last"));

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no-newline.jsonl");
        fs::write(&path, last).unwrap();
        assert_eq!(cwd_from_transcript(&path).as_deref(), Some("/last"), "read to EOF: complete");
    }

    #[test]
    fn list_projects_falls_through_to_an_older_transcript_when_the_newest_hides_its_cwd() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("projects").join("B--projects-guild-auth");
        fs::create_dir_all(&dir).unwrap();
        // Newest: a prompt so long the first `user` record sits past the 64 KiB window.
        let filler = "{\"type\":\"file-history-delta\",\"data\":\"".to_string() + &"x".repeat(1000) + "\"}\n";
        let mut big = filler.repeat(70);
        big.push_str(&transcript("/real/guild-auth", "big"));
        let newest = dir.join("big.jsonl");
        fs::write(&newest, big).unwrap();
        set_mtime(&newest, 3_000);
        // Older: a normal transcript naming the real cwd.
        set_mtime(&write_transcript(&dir, "older", "/real/guild-auth"), 2_000);

        let listed = list_projects(home.path());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].cwd, "/real/guild-auth", "not the lossy decode of the dir name");
        assert_eq!(listed[0].sessions, 2);
        assert!(!listed[0].on_canvas);
    }

    #[test]
    fn cwd_from_transcript_reads_only_the_first_64_kib() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.jsonl");
        // 70 KB of filler records, then the user record: outside the window.
        let filler = "{\"type\":\"file-history-delta\",\"data\":\"".to_string() + &"x".repeat(1000) + "\"}\n";
        let mut text = filler.repeat(70);
        text.push_str(&transcript("/late", "s"));
        fs::write(&path, &text).unwrap();
        assert_eq!(cwd_from_transcript(&path), None);

        let path2 = dir.path().join("small.jsonl");
        fs::write(&path2, transcript("/early", "s")).unwrap();
        assert_eq!(cwd_from_transcript(&path2).as_deref(), Some("/early"));
        assert_eq!(cwd_from_transcript(&dir.path().join("absent.jsonl")), None);
    }

    #[test]
    fn list_projects_reads_cwd_sessions_and_existence_newest_first() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let real = tempfile::tempdir().unwrap();
        let real_cwd = real.path().display().to_string();

        // Project A: two transcripts; the newest names the real cwd, the older a stale one.
        let a = projects.join("X--real");
        fs::create_dir_all(&a).unwrap();
        set_mtime(&write_transcript(&a, "old", "/stale"), 1_000);
        set_mtime(&write_transcript(&a, "new", &real_cwd), 2_000);
        fs::create_dir(a.join("memory")).unwrap(); // not a transcript
        fs::write(a.join(".session-aliases"), "new\n").unwrap();

        // Project B: cwd gone.
        let b = projects.join("C--Users-nobody-gone");
        fs::create_dir_all(&b).unwrap();
        set_mtime(&write_transcript(&b, "s", "C:\\Users\\nobody\\gone"), 3_000);

        // Project C: no transcripts at all -> decoded from the name, 0 sessions.
        fs::create_dir_all(projects.join("D--decoded-only")).unwrap();

        // Project D: an undecodable name and no transcript -> skipped.
        fs::create_dir_all(projects.join("memory")).unwrap();

        // A stray file at the projects level is ignored.
        fs::write(projects.join("notes.txt"), "x").unwrap();

        let listed = list_projects(home.path());
        let dirs: Vec<&str> = listed.iter().map(|p| p.dir.as_str()).collect();
        assert_eq!(dirs, ["C--Users-nobody-gone", "X--real", "D--decoded-only"]);

        let a = &listed[1];
        assert_eq!(a.cwd, real_cwd);
        assert!(a.exists);
        assert_eq!(a.sessions, 2);

        let b = &listed[0];
        assert_eq!(b.cwd, "C:\\Users\\nobody\\gone");
        assert!(!b.exists);
        assert_eq!(b.sessions, 1);

        let c = &listed[2];
        assert_eq!(c.cwd, "D:\\decoded\\only");
        assert!(!c.exists);
        assert_eq!(c.sessions, 0);
    }

    #[test]
    fn list_projects_falls_back_to_the_name_when_the_transcript_has_no_cwd() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("projects").join("E--fallback");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("s.jsonl"), "{\"type\":\"mode\"}\nnot json\n").unwrap();
        let listed = list_projects(home.path());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].cwd, "E:\\fallback");
        assert_eq!(listed[0].sessions, 1);
    }

    #[test]
    fn list_projects_without_a_projects_dir_is_empty_and_touches_nothing() {
        let home = tempfile::tempdir().unwrap();
        assert!(list_projects(home.path()).is_empty());
        assert!(list_projects(&home.path().join("does-not-exist")).is_empty());
        assert_eq!(fs::read_dir(home.path()).unwrap().count(), 0, "nothing created");
    }
}
