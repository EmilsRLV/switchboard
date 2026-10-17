//! Historic sessions per project (Story 3.1): every top-level transcript of every Claude
//! project dir whose `cwd` (as a transcript states it) is a project on the canvas, summarised
//! by [`summarise_from`] and cached in memory by a [`Stamp`]. A pass every [`INTERVAL`]
//! re-stats the transcripts, re-reads only what changed -- a grown transcript from where the
//! last parse stopped -- and hands the result to [`graph::set_discovered`], which bumps the
//! workspace revision and emits only when the list changed. Nothing under `claude_home` is
//! ever written; nothing here is persisted.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager, Runtime};

use super::discover::{PROJECTS_DIR, cwd_from_transcript, list_transcripts};
use super::transcript::{Progress, SessionSummary, custom_title_path, summarise_from};
use crate::graph::{self, same_path};
use crate::settings::AppState;

/// The time between passes.
pub const INTERVAL: Duration = Duration::from_secs(5);

/// What invalidates a cached entry: the transcript's `(len, mtime)` and the mtime of its
/// `custom-title.json` (`None` while there is none), so a rename there shows too.
type Stamp = (u64, SystemTime, Option<SystemTime>);

/// One transcript as last parsed.
#[derive(Debug, Clone)]
struct Cached {
    stamp: Stamp,
    summary: SessionSummary,
    /// Where that parse stopped, to resume from when the file grew.
    progress: Progress,
}

/// The memory-only cache behind the passes. Held behind a `Mutex` in `AppState`, locked only
/// while no file is being read.
#[derive(Debug, Default)]
pub struct SessionCache {
    /// Transcript path → its last parse.
    transcripts: HashMap<PathBuf, Cached>,
    /// Project dir → the newest transcript and its stamp when its `cwd` was read, and that
    /// `cwd`.
    dirs: HashMap<PathBuf, (PathBuf, Stamp, Option<String>)>,
    /// How many transcripts were parsed (cache misses), for tests and diagnostics.
    pub parses: u64,
    /// How many transcript bytes those parses read.
    pub bytes_read: u64,
}

/// One project dir as a pass sees it: its `cwd` and its transcripts.
struct DirScan {
    cwd: String,
    transcripts: Vec<(PathBuf, Stamp)>,
}

/// The sessions of one project folder: every transcript of every project dir whose `cwd` is
/// `project_path`, unordered (the graph orders them). Empty when nothing can be listed.
pub fn sessions_for(claude_home: &Path, project_path: &str, cache: &Mutex<SessionCache>) -> Vec<SessionSummary> {
    let projects = [("p".to_string(), project_path.to_string())];
    scan(claude_home, &projects, cache)
        .and_then(|mut found| found.remove("p"))
        .unwrap_or_default()
}

/// One pass: `(project id, project path)` → that project's sessions. A project with no
/// sessions has no entry. Cache entries for transcripts and dirs no longer seen are dropped.
/// `None` when `projects/` exists but cannot be listed: the caller keeps what it had.
pub fn scan(
    claude_home: &Path,
    projects: &[(String, String)],
    cache: &Mutex<SessionCache>,
) -> Option<HashMap<String, Vec<SessionSummary>>> {
    let dirs = scan_dirs(claude_home, cache)?;
    let mut out: HashMap<String, Vec<SessionSummary>> = HashMap::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for (id, path) in projects {
        let mut sessions: Vec<SessionSummary> = Vec::new();
        for dir in dirs.iter().filter(|d| same_path(&d.cwd, path)) {
            for (transcript, stamp) in &dir.transcripts {
                seen.insert(transcript.clone());
                if let Some(summary) = summary_of(transcript, *stamp, cache) {
                    sessions.push(summary);
                }
            }
        }
        if !sessions.is_empty() {
            // A stable order, so an unchanged folder compares equal pass after pass.
            sessions.sort_by(|a, b| a.id.cmp(&b.id).then_with(|| a.last_active.cmp(&b.last_active)));
            out.insert(id.clone(), sessions);
        }
    }
    lock(cache).transcripts.retain(|path, _| seen.contains(path));
    Some(out)
}

/// Every readable project dir with at least one transcript whose `cwd` a transcript confirms
/// (the lossy decoding of the dir name is never used here: it could attach sessions to the
/// wrong folder). `None` when `projects/` exists but cannot be listed; a missing one (Claude
/// never run) is an empty list.
fn scan_dirs(claude_home: &Path, cache: &Mutex<SessionCache>) -> Option<Vec<DirScan>> {
    let entries = match fs::read_dir(claude_home.join(PROJECTS_DIR)) {
        Ok(entries) => entries,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            lock(cache).dirs.clear();
            return Some(Vec::new());
        }
        Err(_) => return None,
    };
    let mut out = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for entry in entries.filter_map(Result::ok) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        let Some(mut listed) = list_transcripts(&dir) else {
            continue;
        };
        listed.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        let transcripts: Vec<(PathBuf, Stamp)> = listed
            .iter()
            .filter_map(|(_, path)| stamp_of(path).map(|stamp| (path.clone(), stamp)))
            .collect();
        let Some((newest, newest_stamp)) = transcripts.first().cloned() else {
            continue;
        };
        seen.insert(dir.clone());
        let memo = lock(cache).dirs.get(&dir).cloned();
        let cwd = match memo {
            Some((path, stamp, cwd)) if path == newest && stamp == newest_stamp => cwd,
            _ => {
                let cwd = listed.iter().find_map(|(_, path)| cwd_from_transcript(path));
                lock(cache).dirs.insert(dir.clone(), (newest, newest_stamp, cwd.clone()));
                cwd
            }
        };
        if let Some(cwd) = cwd {
            out.push(DirScan { cwd, transcripts });
        }
    }
    lock(cache).dirs.retain(|dir, _| seen.contains(dir));
    Some(out)
}

/// The cached summary when `stamp` still matches; else a parse (stored), resumed from where
/// the last one stopped when the file only grew. When the transcript cannot be read now, the
/// cached summary (if any) stands, so a transient failure does not drop the session.
fn summary_of(path: &Path, stamp: Stamp, cache: &Mutex<SessionCache>) -> Option<SessionSummary> {
    let cached = lock(cache).transcripts.get(path).cloned();
    if let Some(cached) = &cached
        && cached.stamp == stamp
    {
        return Some(cached.summary.clone());
    }
    let resume = cached
        .as_ref()
        .filter(|c| stamp.0 >= c.progress.offset() && stamp.1 >= c.stamp.1)
        .map(|c| &c.progress);
    // Parsed with the lock released.
    let Some(parsed) = summarise_from(path, resume) else {
        return cached.map(|c| c.summary);
    };
    let mut cache = lock(cache);
    cache.parses += 1;
    cache.bytes_read += parsed.bytes_read;
    cache.transcripts.insert(
        path.to_path_buf(),
        Cached {
            stamp,
            summary: parsed.summary.clone(),
            progress: parsed.progress,
        },
    );
    Some(parsed.summary)
}

fn stamp_of(path: &Path) -> Option<Stamp> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let custom = custom_title_path(path)
        .and_then(|p| fs::metadata(p).ok())
        .map(|m| m.modified().unwrap_or(SystemTime::UNIX_EPOCH));
    Some((meta.len(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), custom))
}

fn lock(cache: &Mutex<SessionCache>) -> std::sync::MutexGuard<'_, SessionCache> {
    cache.lock().unwrap_or_else(|e| e.into_inner())
}

// --- the timer --------------------------------------------------------------------------

/// Start the pass loop on Tauri's async runtime: a first pass right away, then one every
/// [`INTERVAL`]. Called once from `setup`; it runs for the life of the app.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        loop {
            refresh(&app).await;
            tokio::time::sleep(INTERVAL).await;
        }
    });
}

/// One pass over every project on the canvas. The file I/O runs on a blocking thread with no
/// workspace lock held; passes are serialised by `AppState::sessions_lock`. Without a Claude
/// home (as in tests that set none) there is nothing to read and nothing changes.
pub async fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let Some(home) = state.claude_home.get().cloned() else {
        return;
    };
    let _pass = state.sessions_lock.lock().await;
    let projects: Vec<(String, String)> = state
        .read_workspace()
        .workspace
        .projects
        .iter()
        .map(|p| (p.id.clone(), p.path.clone()))
        .collect();
    let handle = app.clone();
    let found = tauri::async_runtime::spawn_blocking(move || scan(&home, &projects, &handle.state::<AppState>().sessions)).await;
    // A panicked pass, or one that could not list `projects/`, keeps the last list; the next
    // tick tries again.
    if let Ok(Some(found)) = found {
        graph::set_discovered(app, found);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn user_line(cwd: &str, ts: &str, prompt: &str) -> String {
        serde_json::json!({
            "type": "user", "isSidechain": false, "timestamp": ts, "cwd": cwd, "gitBranch": "main",
            "message": { "role": "user", "content": prompt }
        })
        .to_string()
            + "\n"
    }

    fn write(dir: &Path, id: &str, cwd: &str, ts: &str, prompt: &str) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(format!("{id}.jsonl"));
        fs::write(&path, user_line(cwd, ts, prompt)).unwrap();
        path
    }

    fn append(path: &Path, text: &str) {
        use std::io::Write;
        let mut file = fs::File::options().append(true).open(path).unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    /// Every file and dir under `root` with its bytes and mtime.
    fn tree(root: &Path) -> BTreeMap<PathBuf, (Option<Vec<u8>>, SystemTime)> {
        let mut out = BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                // Stat the path itself: on Windows a directory listing's cached metadata can
                // lag behind a directory's real mtime.
                let meta = fs::symlink_metadata(&path).unwrap();
                if meta.is_dir() {
                    stack.push(path.clone());
                    out.insert(path, (None, meta.modified().unwrap()));
                } else {
                    out.insert(path.clone(), (Some(fs::read(&path).unwrap()), meta.modified().unwrap()));
                }
            }
        }
        out
    }

    #[test]
    fn top_level_transcripts_of_every_matching_dir_count_and_nothing_else() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join(PROJECTS_DIR);
        let cwd = if cfg!(windows) { "B:\\work\\ide" } else { "/work/ide" };
        let a = projects.join("dir-a");
        write(&a, "s1", cwd, "2026-10-16T10:00:00.000Z", "one");
        write(&a, "s2", cwd, "2026-10-16T11:00:00.000Z", "two");
        // Per-session folders are not sessions.
        write(&a.join("s1").join("subagents"), "agent-x", cwd, "2026-10-16T12:00:00.000Z", "sub");
        fs::create_dir_all(a.join("s1").join("tool-results")).unwrap();
        fs::create_dir_all(a.join("memory")).unwrap();
        fs::write(a.join("memory").join("notes.jsonl"), "x").unwrap();
        // A second dir whose transcripts name the same cwd (another spelling on Windows).
        let spelled = if cfg!(windows) { "b:\\WORK\\ide" } else { cwd };
        write(&projects.join("dir-b"), "s3", spelled, "2026-10-16T09:00:00.000Z", "three");
        // A dir for another folder.
        write(&projects.join("dir-c"), "s4", "/elsewhere", "2026-10-16T09:00:00.000Z", "four");

        let cache = Mutex::new(SessionCache::default());
        let mut ids: Vec<String> = sessions_for(home.path(), cwd, &cache).into_iter().map(|s| s.id).collect();
        ids.sort();
        assert_eq!(ids, ["s1", "s2", "s3"]);
        assert!(sessions_for(home.path(), "/nowhere", &cache).is_empty());
        assert!(sessions_for(&home.path().join("absent"), cwd, &cache).is_empty(), "no projects dir");
    }

    #[test]
    fn the_cache_skips_unchanged_transcripts_and_reparses_changed_ones() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(PROJECTS_DIR).join("d");
        let s1 = write(&dir, "s1", "/w", "2026-10-16T10:00:00.000Z", "first");
        write(&dir, "s2", "/w", "2026-10-16T10:00:00.000Z", "second");
        let cache = Mutex::new(SessionCache::default());
        let projects = [("p".to_string(), "/w".to_string())];

        let first = scan(home.path(), &projects, &cache).unwrap();
        assert_eq!(first["p"].len(), 2);
        assert_eq!(cache.lock().unwrap().parses, 2);

        let again = scan(home.path(), &projects, &cache).unwrap();
        assert_eq!(cache.lock().unwrap().parses, 2, "cache hit: nothing re-parsed");
        assert_eq!(again, first);

        append(&s1, &user_line("/w", "2026-10-16T10:05:00.000Z", "more"));
        let changed = scan(home.path(), &projects, &cache).unwrap();
        assert_eq!(cache.lock().unwrap().parses, 3, "only the grown transcript is re-parsed");
        let s1_summary = changed["p"].iter().find(|s| s.id == "s1").unwrap();
        assert_eq!(s1_summary.messages, 2);
        assert_eq!(s1_summary.last_active, "2026-10-16T10:05:00.000Z");

        // A new transcript appears; a removed one disappears and leaves the cache.
        write(&dir, "s3", "/w", "2026-10-16T12:00:00.000Z", "third");
        fs::remove_file(dir.join("s2.jsonl")).unwrap();
        let mut ids: Vec<String> = scan(home.path(), &projects, &cache).unwrap()["p"].iter().map(|s| s.id.clone()).collect();
        ids.sort();
        assert_eq!(ids, ["s1", "s3"]);
        assert_eq!(cache.lock().unwrap().transcripts.len(), 2);
    }

    #[test]
    fn a_pass_leaves_the_claude_tree_byte_identical() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(PROJECTS_DIR).join("d");
        write(&dir, "s1", "/w", "2026-10-16T10:00:00.000Z", "first");
        fs::write(dir.join("s2.jsonl"), "not json\n{\"type\":\"user\",\"cwd\":\"/w\"").unwrap();
        fs::create_dir_all(dir.join("s1")).unwrap();
        fs::write(dir.join("s1").join("custom-title.json"), r#"{"customTitle":"Named"}"#).unwrap();
        fs::write(dir.join(".session-aliases"), "s1\n").unwrap();
        write(&home.path().join(PROJECTS_DIR).join("other"), "s9", "/other", "2026-10-16T10:00:00.000Z", "x");
        let before = tree(home.path());

        let cache = Mutex::new(SessionCache::default());
        let found = scan(home.path(), &[("p".into(), "/w".into()), ("q".into(), "/other".into())], &cache).unwrap();
        assert_eq!(found["p"].len(), 2);
        assert_eq!(found["p"].iter().find(|s| s.id == "s1").unwrap().title, "Named");
        assert_eq!(tree(home.path()), before, "nothing under the Claude home changed");
    }

    #[test]
    fn an_unreadable_or_odd_entry_is_skipped_never_fatal() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join(PROJECTS_DIR);
        write(&projects.join("good"), "s1", "/w", "2026-10-16T10:00:00.000Z", "ok");
        fs::write(projects.join("stray.jsonl"), "x").unwrap(); // a file at the projects level
        fs::create_dir_all(projects.join("empty")).unwrap();
        // A dir with a transcript but no cwd and an undecodable name.
        fs::create_dir_all(projects.join("memory")).unwrap();
        fs::write(projects.join("memory").join("m.jsonl"), "{}\n").unwrap();
        // A directory named like a transcript is not one.
        fs::create_dir_all(projects.join("good").join("fake.jsonl")).unwrap();
        let cache = Mutex::new(SessionCache::default());
        let ids: Vec<String> = sessions_for(home.path(), "/w", &cache).into_iter().map(|s| s.id).collect();
        assert_eq!(ids, ["s1"]);
    }

    #[test]
    fn the_dir_cwd_memo_follows_the_newest_transcript() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(PROJECTS_DIR).join("d");
        let s1 = write(&dir, "s1", "/old", "2026-10-16T10:00:00.000Z", "x");
        let cache = Mutex::new(SessionCache::default());
        assert_eq!(sessions_for(home.path(), "/old", &cache).len(), 1);
        // The newest transcript now names another cwd (the folder moved): the memo is redone.
        fs::write(&s1, user_line("/new", "2026-10-16T11:00:00.000Z", "a longer prompt")).unwrap();
        assert_eq!(sessions_for(home.path(), "/new", &cache).len(), 1);
        assert!(sessions_for(home.path(), "/old", &cache).is_empty());
    }

    #[test]
    fn a_grown_transcript_is_read_from_where_the_last_parse_stopped() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(PROJECTS_DIR).join("d");
        let s1 = write(&dir, "s1", "/w", "2026-10-16T10:00:00.000Z", "first");
        let cache = Mutex::new(SessionCache::default());
        let projects = [("p".to_string(), "/w".to_string())];
        scan(home.path(), &projects, &cache).unwrap();
        let after_first = cache.lock().unwrap().bytes_read;
        assert_eq!(after_first, fs::metadata(&s1).unwrap().len());

        let more = user_line("/w", "2026-10-16T10:05:00.000Z", "second") + &user_line("/w", "2026-10-16T10:06:00.000Z", "third");
        append(&s1, &more);
        let found = scan(home.path(), &projects, &cache).unwrap();
        let cache_now = cache.lock().unwrap();
        assert_eq!(cache_now.parses, 2);
        assert_eq!(cache_now.bytes_read - after_first, more.len() as u64, "only the appended lines were read");
        assert_eq!(found["p"][0], super::super::transcript::summarise(&s1).unwrap(), "same as a full parse");
        assert_eq!(found["p"][0].messages, 3);
    }

    #[test]
    fn a_transcript_that_cannot_be_read_keeps_its_cached_summary() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(PROJECTS_DIR).join("d");
        let s1 = write(&dir, "s1", "/w", "2026-10-16T10:00:00.000Z", "first");
        let cache = Mutex::new(SessionCache::default());
        let before = sessions_for(home.path(), "/w", &cache);
        let stamp = stamp_of(&s1).unwrap();
        // The stamp read but the open fails (simulated: the file is gone by the time it is opened).
        fs::remove_file(&s1).unwrap();
        let changed = (stamp.0 + 1, stamp.1, stamp.2);
        assert_eq!(summary_of(&s1, changed, &cache), Some(before[0].clone()));
        // With nothing cached there is nothing to keep.
        assert_eq!(summary_of(&dir.join("never.jsonl"), changed, &cache), None);
    }

    #[test]
    fn a_projects_dir_that_cannot_be_listed_keeps_the_previous_result() {
        let home = tempfile::tempdir().unwrap();
        // `projects` exists but is not a listable directory.
        fs::write(home.path().join(PROJECTS_DIR), "not a dir").unwrap();
        let cache = Mutex::new(SessionCache::default());
        assert_eq!(scan(home.path(), &[("p".into(), "/w".into())], &cache), None);
        // Missing altogether (Claude never run) is an empty result, not a failure.
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(scan(empty.path(), &[("p".into(), "/w".into())], &cache), Some(HashMap::new()));
    }

    #[test]
    fn a_dir_whose_transcripts_name_no_cwd_attaches_no_sessions_even_if_its_name_decodes() {
        let home = tempfile::tempdir().unwrap();
        // `-w` decodes to `/w`, but no transcript confirms it.
        let dir = home.path().join(PROJECTS_DIR).join("-w");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("s1.jsonl"), "{\"type\":\"mode\"}\n{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n").unwrap();
        let cache = Mutex::new(SessionCache::default());
        assert!(sessions_for(home.path(), "/w", &cache).is_empty());
    }

    #[test]
    fn editing_only_custom_title_json_refreshes_the_title() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(PROJECTS_DIR).join("d");
        write(&dir, "s1", "/w", "2026-10-16T10:00:00.000Z", "first");
        let cache = Mutex::new(SessionCache::default());
        assert_eq!(sessions_for(home.path(), "/w", &cache)[0].title, "first");

        let custom = dir.join("s1").join("custom-title.json");
        fs::create_dir_all(custom.parent().unwrap()).unwrap();
        fs::write(&custom, r#"{"customTitle":"Named"}"#).unwrap();
        assert_eq!(sessions_for(home.path(), "/w", &cache)[0].title, "Named");

        fs::write(&custom, r#"{"customTitle":"Renamed"}"#).unwrap();
        let later = SystemTime::now() + Duration::from_secs(60);
        fs::File::options().write(true).open(&custom).unwrap().set_modified(later).unwrap();
        assert_eq!(sessions_for(home.path(), "/w", &cache)[0].title, "Renamed");

        fs::remove_file(&custom).unwrap();
        assert_eq!(sessions_for(home.path(), "/w", &cache)[0].title, "first");
    }
}
