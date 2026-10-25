//! The working-tree diff behind the Review pane (Story 8.1): which files of a folder changed,
//! with their +/− counts, and the old and new text of one of them. Read-only: nothing is staged,
//! committed or written, and every git call is prompt-less, lock-free and in English
//! ([`super::branches::git`]).
//!
//! **The list** comes from two calls, both limited to the reviewed folder (pathspec `.`) and
//! leaving out the linked worktrees inside the repository, as the status poll does
//! ([`super::status::exclude_pathspec`]):
//!
//! - `git status --porcelain=v2 -z --untracked-files=all --find-renames`, whose records are
//!   (`git-status(1)`):
//!
//!   ```text
//!   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>                 ordinary changed entry
//!   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>NUL<origPath>   renamed or copied
//!   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>       unmerged
//!   ? <path>                                                     untracked
//!   ```
//!
//!   `X` is the index against HEAD (staged), `Y` the working tree against the index (unstaged);
//!   `<sub>` starts with `S` for a submodule.
//! - `git diff --numstat -z -M` for the [`Filter`]: HEAD against the working tree (`All`), HEAD
//!   against the index (`Staged`, `--cached`) or the index against the working tree (`Unstaged`).
//!   Records are `<added>TAB<removed>TAB<path>NUL`, or for a rename
//!   `<added>TAB<removed>TABNUL<old>NUL<new>NUL`; a binary file counts `-` and `-`. Both calls
//!   detect renames explicitly (whatever the user's `status.renames` / `diff.renames`), so the rows
//!   and their counts agree.
//!
//! An untracked file counts every line as added (read from disk, at most [`MAX_SIDE_BYTES`];
//! past that it is marked too large). `git rm --cached` (an index deletion whose file is still on
//! disk, so also untracked) is one row: deleted from the index, still on disk. A submodule is
//! listed with no text; a path that is not UTF-8 is listed lossily (`unreadable name`) with no
//! text. Paths are relative to the reviewed folder with `/`. At most [`MAX_ROWS`] rows are sent;
//! the rest are counted (`more`).
//!
//! **The text.** The old side is `git show --no-textconv <rev>:<path>` (`HEAD`, or `:0:<path>` for
//! the index); the new side is the index or the file on disk. `git show` of a blob runs no smudge
//! filter (nothing like LFS is fetched). Each side is read as bytes and capped before anything is
//! decoded: a side holding a NUL byte (or counted `-` by `--numstat`) is [`Content::Binary`]; a
//! side over [`MAX_SIDE_BYTES`] or [`MAX_SIDE_LINES`] lines is [`Content::TooLarge`]; text that is
//! not UTF-8 is decoded lossily and marked; CRLF line ends become LF on both sides (a blob stored
//! with LF and checked out with CRLF is not a change on every line). A file is read from disk
//! only when git listed it, and only inside the reviewed folder (its real location, links
//! followed: [`crate::review::within`]); a symbolic link is shown as its target text, as git
//! stores it, and never followed. `review_file` looks up the one row it shows; it never counts
//! the other files.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::GitError;
use super::branches::git;

/// How long one git call of the diff may take before it is killed.
pub const DIFF_TIMEOUT: Duration = Duration::from_secs(10);

/// The largest side shown, in bytes (2 MB).
pub const MAX_SIDE_BYTES: usize = 2 * 1024 * 1024;

/// The longest side shown, in lines.
pub const MAX_SIDE_LINES: usize = 50_000;

/// The most rows one list sends; the rest are counted in `more`.
pub const MAX_ROWS: usize = 5000;

/// How far into a file an untracked file's NUL test looks (git's own binary heuristic).
const BINARY_SNIFF: usize = 8000;

/// Why a folder cannot be reviewed: it is not inside a git work tree.
pub const NOT_A_REPO: &str = "not a git repository";

/// Why `review_file` refuses a path: it is not in the list of changed files (for this filter).
pub const NOT_CHANGED: &str = "unchanged";

/// Why a read is refused: the file's real location is outside the reviewed folder.
pub const OUTSIDE: &str = "outside the reviewed folder";

/// Which two states of the files the review compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Filter {
    /// HEAD against the working tree.
    #[default]
    All,
    /// HEAD against the index.
    Staged,
    /// The index against the working tree.
    Unstaged,
}

/// What happened to a file, for the filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    #[default]
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

/// One changed file, as the tree lists it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Relative to the reviewed folder, `/`-separated (lossy for an unreadable name).
    pub path: String,
    /// A rename's old path (relative to the folder; `:/<path>` when it lies outside it).
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub added: u32,
    pub removed: u32,
    /// `--numstat` counted it `-` (or, untracked, it holds a NUL byte): no counts, no text.
    pub binary: bool,
    /// A submodule: no text.
    pub submodule: bool,
    /// The path is not valid UTF-8: listed lossily, no text.
    pub unreadable_name: bool,
    /// An untracked file over [`MAX_SIDE_BYTES`]: not counted, no text.
    pub too_large: bool,
    /// Deleted from the index (`git rm --cached`) and still on disk.
    pub on_disk: bool,
}

/// A path of a session's review request (Story 7.4) as the reviewed folder sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestedKey {
    /// As the request names it (relative to the session's folder, else absolute).
    pub display: String,
    /// Relative to the reviewed folder with `/` (`""` for the folder itself), comparable with the
    /// list's paths; `None` when it lies outside the folder.
    pub key: Option<String>,
    /// Nothing is there.
    pub missing: bool,
    /// It lies outside the reviewed folder.
    pub outside: bool,
}

/// What `review_list` returns: the reviewed folder and its changed files, sorted by path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeList {
    /// The reviewed folder (canonical).
    pub root: String,
    pub filter: Filter,
    pub files: Vec<ChangedFile>,
    /// Changed files past [`MAX_ROWS`], not sent.
    pub more: usize,
    /// A session's review request's paths, keyed to this folder (empty otherwise).
    pub requested: Vec<RequestedKey>,
    /// Story 8.4: on a session target, the files its transcript says it edited, keyed like the
    /// list's paths (empty otherwise).
    pub touched: Vec<String>,
}

/// The two sides of one file, or why they are not shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Content {
    /// `old` / `new` are `None` where that side does not exist (an added or a deleted file).
    Text {
        old: Option<String>,
        new: Option<String>,
        /// A side was not valid UTF-8 and is shown lossily.
        #[serde(rename = "notUtf8")]
        not_utf8: bool,
    },
    Binary,
    TooLarge,
    Submodule,
    UnreadableName,
}

/// What `review_file` returns: the file's row (with its counts) and its text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub file: ChangedFile,
    pub content: Content,
}

// -- parsing --------------------------------------------------------------------------------

/// The kind of a porcelain v2 record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RecordKind {
    #[default]
    Ordinary,
    Renamed,
    Unmerged,
    Untracked,
}

/// One `git status --porcelain=v2 -z` record; paths relative to the repository's top level.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StatusEntry {
    pub kind: RecordKind,
    /// The index status (staged), `.` for unchanged; `?` for untracked.
    pub x: char,
    /// The working-tree status (unstaged), `.` for unchanged; `?` for untracked.
    pub y: char,
    pub path: String,
    /// A rename's (or copy's) original path.
    pub orig_path: Option<String>,
    /// The `<sub>` field starts with `S`.
    pub submodule: bool,
    /// The path (or the original path) was not valid UTF-8 and is lossy.
    pub bad_name: bool,
}

/// A path field: its text, and whether it was valid UTF-8.
pub(crate) fn name(bytes: &[u8]) -> (String, bool) {
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_string(), true),
        Err(_) => (String::from_utf8_lossy(bytes).into_owned(), false),
    }
}

/// Parse `git status --porcelain=v2 -z` output. Tolerant: headers, ignored entries and unknown
/// record types are skipped; a directory entry (`dir/`, a nested repository) is skipped too.
pub fn parse_status_z(raw: &[u8]) -> Vec<StatusEntry> {
    let mut out = Vec::new();
    let mut fields = raw.split(|b| *b == 0);
    while let Some(record) = fields.next() {
        let (kind, field_count) = match record.get(..2) {
            Some(b"1 ") => (RecordKind::Ordinary, 9),
            Some(b"2 ") => (RecordKind::Renamed, 10),
            Some(b"u ") => (RecordKind::Unmerged, 11),
            Some(b"? ") => (RecordKind::Untracked, 2),
            _ => continue,
        };
        let parts: Vec<&[u8]> = record.splitn(field_count, |b| *b == b' ').collect();
        let orig = if kind == RecordKind::Renamed { fields.next() } else { None };
        if parts.len() != field_count {
            continue;
        }
        let Some(path) = parts.last() else { continue };
        let (path, path_ok) = name(path);
        let (orig_path, orig_ok) = match orig.filter(|o| !o.is_empty()) {
            Some(o) => {
                let (o, ok) = name(o);
                (Some(o), ok)
            }
            None => (None, true),
        };
        let (x, y) = if kind == RecordKind::Untracked {
            ('?', '?')
        } else {
            let xy = parts.get(1).copied().unwrap_or(b"..");
            (char::from(*xy.first().unwrap_or(&b'.')), char::from(*xy.get(1).unwrap_or(&b'.')))
        };
        let submodule = kind != RecordKind::Untracked && parts.get(2).is_some_and(|s| s.first() == Some(&b'S'));
        if path.is_empty() || path.ends_with('/') {
            continue;
        }
        out.push(StatusEntry {
            kind,
            x,
            y,
            path,
            orig_path,
            submodule,
            bad_name: !path_ok || !orig_ok,
        });
    }
    out
}

/// One `git diff --numstat -z` record; `None` counts for a binary file (`-`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumstatEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

/// Parse `git diff --numstat -z` output. Tolerant: a malformed record is skipped.
pub fn parse_numstat_z(raw: &[u8]) -> Vec<NumstatEntry> {
    let mut out = Vec::new();
    let mut fields = raw.split(|b| *b == 0).map(|f| String::from_utf8_lossy(f).into_owned());
    while let Some(record) = fields.next() {
        let record = record.trim_start_matches(['\n', '\r']);
        let mut parts = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let count = |n: &str| if n == "-" { None } else { n.trim().parse::<u32>().ok() };
        let (path, old_path) = if path.is_empty() {
            let old = fields.next().unwrap_or_default();
            let new = fields.next().unwrap_or_default();
            (new, Some(old).filter(|o| !o.is_empty()))
        } else {
            (path.to_string(), None)
        };
        if path.is_empty() {
            continue;
        }
        out.push(NumstatEntry {
            path,
            old_path,
            added: count(added),
            removed: count(removed),
        });
    }
    out
}

/// What `entry` is under `filter`; `None` when the filter does not list it.
pub fn classify(entry: &StatusEntry, filter: Filter) -> Option<FileStatus> {
    match entry.kind {
        RecordKind::Untracked => (filter != Filter::Staged).then_some(FileStatus::Untracked),
        RecordKind::Unmerged => (filter != Filter::Staged).then_some(FileStatus::Conflicted),
        RecordKind::Ordinary | RecordKind::Renamed => {
            let (x, y) = (entry.x, entry.y);
            match filter {
                Filter::Staged => match x {
                    '.' => None,
                    'A' | 'C' => Some(FileStatus::Added),
                    'D' => Some(FileStatus::Deleted),
                    'R' => Some(FileStatus::Renamed),
                    _ => Some(FileStatus::Modified),
                },
                Filter::Unstaged => match y {
                    '.' => None,
                    // Intent to add (`git add -N`): a new file the index only names.
                    'A' => Some(FileStatus::Added),
                    'D' => Some(FileStatus::Deleted),
                    _ => Some(FileStatus::Modified),
                },
                Filter::All => match (x, y) {
                    ('.', '.') => None,
                    // Added to the index, then deleted from disk: nothing on either side.
                    ('A' | 'C', 'D') => None,
                    ('A' | 'C', _) | ('.', 'A') => Some(FileStatus::Added),
                    (_, 'D') | ('D', _) => Some(FileStatus::Deleted),
                    ('R', _) => Some(FileStatus::Renamed),
                    _ => Some(FileStatus::Modified),
                },
            }
        }
    }
}

/// The path a row shows for `entry` (top-relative): a staged rename deleted from disk is the
/// deletion of its original path.
fn row_path(entry: &StatusEntry, status: FileStatus, filter: Filter) -> String {
    if filter == Filter::All && status == FileStatus::Deleted && entry.x == 'R' {
        return entry.orig_path.clone().unwrap_or_else(|| entry.path.clone());
    }
    entry.path.clone()
}

/// `path` (top-relative) relative to the folder at `prefix` (`git rev-parse --show-prefix`,
/// `sub/dir/` or empty); `:/<path>` when it lies outside it.
pub fn relative_to_prefix(path: &str, prefix: &str) -> String {
    match path.strip_prefix(prefix) {
        Some(rest) if !rest.is_empty() => rest.to_string(),
        _ if prefix.is_empty() => path.to_string(),
        _ => format!(":/{path}"),
    }
}

/// Lines in `bytes`: newlines, plus one for a last line without one.
pub fn line_count(bytes: &[u8]) -> usize {
    let newlines = bytes.iter().filter(|b| **b == b'\n').count();
    newlines + usize::from(bytes.last().is_some_and(|b| *b != b'\n'))
}

/// One row of the list with where it comes from: its status entry and its top-relative path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub file: ChangedFile,
    pub top_path: String,
    pub entry: StatusEntry,
}

/// The rows `status` gives under `filter` (counts still 0), relative to the folder at `prefix`,
/// sorted by path. Under `All`, an index deletion whose file is also untracked (`git rm
/// --cached`) is one row, deleted and still on disk.
pub fn rows(status: &[StatusEntry], filter: Filter, prefix: &str) -> Vec<Row> {
    let untracked: HashSet<&str> = status.iter().filter(|e| e.kind == RecordKind::Untracked).map(|e| e.path.as_str()).collect();
    let kept: HashSet<&str> = status
        .iter()
        .filter(|e| e.kind == RecordKind::Ordinary && e.x == 'D' && untracked.contains(e.path.as_str()))
        .map(|e| e.path.as_str())
        .collect();
    let mut out = Vec::new();
    for entry in status {
        let Some(status) = classify(entry, filter) else { continue };
        if filter == Filter::All && status == FileStatus::Untracked && kept.contains(entry.path.as_str()) {
            continue;
        }
        let top_path = row_path(entry, status, filter);
        out.push(Row {
            file: ChangedFile {
                path: relative_to_prefix(&top_path, prefix),
                old_path: (status == FileStatus::Renamed)
                    .then(|| entry.orig_path.as_deref().map(|o| relative_to_prefix(o, prefix)))
                    .flatten(),
                status,
                submodule: entry.submodule,
                unreadable_name: entry.bad_name,
                on_disk: status == FileStatus::Deleted && entry.x == 'D' && kept.contains(entry.path.as_str()),
                ..ChangedFile::default()
            },
            top_path,
            entry: entry.clone(),
        });
    }
    out.sort_by(|a, b| a.file.path.cmp(&b.file.path));
    out.dedup_by(|a, b| a.file.path == b.file.path);
    out
}

/// What an untracked file counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Untracked {
    pub lines: u32,
    pub binary: bool,
    /// Over [`MAX_SIDE_BYTES`]: counting stopped.
    pub too_large: bool,
}

/// Fill in `row`'s counts: from `numstat` (by path), or for an untracked file from `untracked`.
pub fn count_row(row: &mut Row, numstat: &HashMap<&str, &NumstatEntry>, untracked: impl FnOnce(&str) -> Untracked) {
    if row.file.status == FileStatus::Untracked {
        let counted = untracked(&row.top_path);
        row.file.binary = counted.binary;
        row.file.too_large = counted.too_large;
        row.file.added = if counted.binary || counted.too_large { 0 } else { counted.lines };
        return;
    }
    if let Some(n) = numstat.get(row.top_path.as_str()) {
        match (n.added, n.removed) {
            (Some(a), Some(r)) => (row.file.added, row.file.removed) = (a, r),
            _ => row.file.binary = true,
        }
    }
}

/// Keep the first [`MAX_ROWS`] rows; how many went.
pub fn cap_rows<T>(rows: &mut Vec<T>) -> usize {
    let more = rows.len().saturating_sub(MAX_ROWS);
    rows.truncate(MAX_ROWS);
    more
}

/// The rows of the list from parsed status and numstat output, with every row counted
/// (`untracked_counts` for an untracked file's top-relative path).
pub fn build_list(
    status: &[StatusEntry],
    numstat: &[NumstatEntry],
    filter: Filter,
    prefix: &str,
    mut untracked_counts: impl FnMut(&str) -> Untracked,
) -> Vec<ChangedFile> {
    let counts: HashMap<&str, &NumstatEntry> = numstat.iter().map(|n| (n.path.as_str(), n)).collect();
    let mut out = rows(status, filter, prefix);
    for row in &mut out {
        count_row(row, &counts, &mut untracked_counts);
    }
    out.into_iter().map(|r| r.file).collect()
}

// -- running git ----------------------------------------------------------------------------

/// The repository facts the list needs, from the reviewed folder.
#[derive(Debug, Clone)]
struct Repo {
    /// The repository's top level (canonical).
    top: PathBuf,
    /// The folder relative to `top` (`git rev-parse --show-prefix`): `sub/dir/` or empty.
    prefix: String,
    /// HEAD names a commit (false in a repository with no commit yet).
    has_head: bool,
    /// `:(top,exclude,literal)` pathspecs for the linked worktrees inside `top`.
    excludes: Vec<String>,
}

pub(crate) fn describe(err: GitError) -> String {
    match err {
        GitError::Failed { stderr, .. } if super::branches::says_not_a_repo(&stderr) => NOT_A_REPO.to_string(),
        GitError::Failed { stderr, code } if stderr.is_empty() => {
            format!("git exited with code {}", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()))
        }
        GitError::Failed { stderr, .. } => stderr,
        other => format!("git: {other}"),
    }
}

fn repo(git_bin: &Path, folder: &Path) -> Result<Repo, String> {
    let done = crate::process::run(git(git_bin, folder, &["rev-parse", "--show-toplevel", "--show-prefix"]), DIFF_TIMEOUT)
        .and_then(|d| d.success())
        .map_err(describe)?;
    let mut lines = done.stdout.lines();
    let top = lines.next().map(str::trim).filter(|t| !t.is_empty()).ok_or_else(|| NOT_A_REPO.to_string())?;
    let prefix = lines.next().map(str::trim).unwrap_or("").to_string();
    let top = dunce::canonicalize(top).unwrap_or_else(|_| PathBuf::from(top));
    let has_head = crate::process::run(git(git_bin, folder, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]), DIFF_TIMEOUT)
        .map(|d| d.status.success())
        .unwrap_or(false);
    let excludes = super::branches::worktree_listing(git_bin, folder)
        .map(|(top, entries)| super::branches::inside_of(&entries, &top))
        .unwrap_or_default()
        .iter()
        .map(|rel| super::status::exclude_pathspec(rel))
        .collect();
    Ok(Repo {
        top,
        prefix,
        has_head,
        excludes,
    })
}

/// A git command in `folder` with `args`, then `--`, the `pathspecs` and the excludes.
fn scoped(git_bin: &Path, folder: &Path, args: &[&str], pathspecs: &[String], repo: &Repo) -> std::process::Command {
    let mut cmd = git(git_bin, folder, args);
    cmd.arg("--").args(pathspecs).args(&repo.excludes);
    cmd
}

/// The pathspec of the whole reviewed folder.
fn whole_folder() -> Vec<String> {
    vec![".".to_string()]
}

pub(crate) fn run_ok(cmd: std::process::Command) -> Result<Vec<u8>, String> {
    crate::process::run_bytes(cmd, DIFF_TIMEOUT, usize::MAX)
        .and_then(|d| d.success())
        .map(|d| d.stdout)
        .map_err(describe)
}

/// The empty tree's id in this repository (`git hash-object -t tree --stdin` on no input): the
/// base of `All` before the first commit.
pub(crate) fn empty_tree(git_bin: &Path, folder: &Path) -> Result<String, String> {
    let out = run_ok(git(git_bin, folder, &["hash-object", "-t", "tree", "--stdin"]))?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

fn numstat(git_bin: &Path, folder: &Path, filter: Filter, repo: &Repo, pathspecs: &[String]) -> Result<Vec<NumstatEntry>, String> {
    let mut args: Vec<String> = ["diff", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", "--no-relative", "--ignore-submodules=none"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    match filter {
        Filter::Staged => args.push("--cached".into()),
        Filter::All => args.push(if repo.has_head { "HEAD".into() } else { empty_tree(git_bin, folder)? }),
        Filter::Unstaged => {}
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    Ok(parse_numstat_z(&run_ok(scoped(git_bin, folder, &refs, pathspecs, repo))?))
}

fn status(git_bin: &Path, folder: &Path, repo: &Repo) -> Result<Vec<StatusEntry>, String> {
    let args = ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--find-renames"];
    Ok(parse_status_z(&run_ok(scoped(git_bin, folder, &args, &whole_folder(), repo))?))
}

/// An untracked file's counts, read from disk in chunks (never more than one chunk held) and at
/// most [`MAX_SIDE_BYTES`] (then it is too large); a link counts one line. Nothing when it cannot
/// be read or lies outside `folder`.
fn count_untracked(path: &Path, folder: &Path) -> Untracked {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return Untracked::default() };
    if meta.file_type().is_symlink() {
        return Untracked { lines: 1, ..Untracked::default() };
    }
    if !meta.is_file() || !crate::review::within(path, folder) {
        return Untracked::default();
    }
    if meta.len() > MAX_SIDE_BYTES as u64 {
        return Untracked { too_large: true, ..Untracked::default() };
    }
    let Ok(mut file) = std::fs::File::open(path) else { return Untracked::default() };
    let mut chunk = vec![0u8; 64 * 1024];
    let (mut lines, mut seen, mut last) = (0usize, 0usize, b'\n');
    loop {
        match file.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                let part = &chunk[..n];
                if seen < BINARY_SNIFF && part[..n.min(BINARY_SNIFF - seen)].contains(&0) {
                    return Untracked { binary: true, ..Untracked::default() };
                }
                seen += n;
                if seen > MAX_SIDE_BYTES {
                    return Untracked { too_large: true, ..Untracked::default() };
                }
                lines += part.iter().filter(|b| **b == b'\n').count();
                last = part[n - 1];
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    let lines = lines + usize::from(seen > 0 && last != b'\n');
    Untracked {
        lines: u32::try_from(lines).unwrap_or(u32::MAX),
        ..Untracked::default()
    }
}

/// The changed files of the work tree holding `folder`, under `filter`: at most [`MAX_ROWS`]
/// (counted; the rest in `more`). `Err` names why git could not tell (`not a git repository`,
/// git's own message, a timeout).
pub fn list(git_bin: &Path, folder: &Path, filter: Filter) -> Result<ChangeList, String> {
    let repo = repo(git_bin, folder)?;
    let entries = status(git_bin, folder, &repo)?;
    let mut rows = rows(&entries, filter, &repo.prefix);
    let more = cap_rows(&mut rows);
    let counts = numstat(git_bin, folder, filter, &repo, &whole_folder())?;
    let counts: HashMap<&str, &NumstatEntry> = counts.iter().map(|n| (n.path.as_str(), n)).collect();
    for row in &mut rows {
        count_row(row, &counts, |top| count_untracked(&repo.top.join(top), folder));
    }
    Ok(ChangeList {
        root: folder.display().to_string(),
        filter,
        files: rows.into_iter().map(|r| r.file).collect(),
        more,
        requested: Vec::new(),
        touched: Vec::new(),
    })
}

/// One side of a file, read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Side {
    /// No such side (an added file's old side, a deleted file's new side).
    Absent,
    Bytes(Vec<u8>),
    /// Over [`MAX_SIDE_BYTES`].
    Over,
}

/// `git show --no-textconv <spec>`, capped. A blob's `show` runs no smudge filter.
pub(crate) fn show(git_bin: &Path, folder: &Path, spec: &str) -> Result<Side, String> {
    let done = crate::process::run_bytes(git(git_bin, folder, &["--no-pager", "show", "--no-textconv", spec]), DIFF_TIMEOUT, MAX_SIDE_BYTES)
        .and_then(|d| d.success())
        .map_err(describe)?;
    Ok(if done.over_cap { Side::Over } else { Side::Bytes(done.stdout) })
}

/// The file at `path` on disk, inside `folder`: a link is its target text (never followed), a
/// file over the cap is [`Side::Over`] without being read, a missing one is [`Side::Absent`].
pub fn read_disk(path: &Path, folder: &Path) -> Result<Side, String> {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return Ok(Side::Absent) };
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(path).map_err(|e| e.to_string())?;
        return Ok(Side::Bytes(target.to_string_lossy().replace('\\', "/").into_bytes()));
    }
    if !meta.is_file() {
        return Ok(Side::Absent);
    }
    if !crate::review::within(path, folder) {
        return Err(OUTSIDE.to_string());
    }
    if meta.len() > MAX_SIDE_BYTES as u64 {
        return Ok(Side::Over);
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(if bytes.len() > MAX_SIDE_BYTES { Side::Over } else { Side::Bytes(bytes) })
}

/// The content shown for two sides already read (`binary`: `--numstat` counted the file `-`).
/// Text is decoded (lossily when it is not UTF-8) with CRLF line ends turned into LF.
pub fn content_of(old: Side, new: Side, binary: bool) -> Content {
    let is_binary = |s: &Side| matches!(s, Side::Bytes(b) if b.contains(&0));
    if binary || is_binary(&old) || is_binary(&new) {
        return Content::Binary;
    }
    let too_large = |s: &Side| match s {
        Side::Over => true,
        Side::Bytes(b) => line_count(b) > MAX_SIDE_LINES,
        Side::Absent => false,
    };
    if too_large(&old) || too_large(&new) {
        return Content::TooLarge;
    }
    let mut not_utf8 = false;
    let mut text = |s: Side| match s {
        Side::Bytes(bytes) => {
            let text = match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(err) => {
                    not_utf8 = true;
                    String::from_utf8_lossy(err.as_bytes()).into_owned()
                }
            };
            Some(if text.contains('\r') { text.replace("\r\n", "\n") } else { text })
        }
        _ => None,
    };
    let old = text(old);
    let new = text(new);
    Content::Text { old, new, not_utf8 }
}

/// Where each side of a row comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Absent,
    /// A `git show` spec: `HEAD:<path>` or `:0:<path>` (the index, stage 0).
    Git(String),
    /// The file on disk (top-relative path).
    Disk(String),
}

/// The sources of the two sides of `file` (whose status entry is `entry`) under `filter`; paths
/// top-relative. `has_head` false: nothing is read from HEAD. A conflict where a side added the
/// file (`AA`, `AU`, `UA`) has no HEAD side.
pub fn sources(entry: &StatusEntry, file: &ChangedFile, top_path: &str, filter: Filter, has_head: bool) -> (Source, Source) {
    let old_top = if file.status == FileStatus::Renamed {
        entry.orig_path.clone().unwrap_or_else(|| top_path.to_string())
    } else {
        top_path.to_string()
    };
    let head = |path: &str| if has_head { Source::Git(format!("HEAD:{path}")) } else { Source::Absent };
    let old = match (file.status, filter) {
        (FileStatus::Added | FileStatus::Untracked, _) => Source::Absent,
        (FileStatus::Conflicted, _) if entry.x == 'A' || entry.y == 'A' => Source::Absent,
        (FileStatus::Conflicted, _) => head(&old_top),
        (_, Filter::Unstaged) => Source::Git(format!(":0:{old_top}")),
        _ => head(&old_top),
    };
    let new = match (file.status, filter) {
        (FileStatus::Deleted, Filter::All) if file.on_disk => Source::Disk(top_path.to_string()),
        (FileStatus::Deleted, _) => Source::Absent,
        (_, Filter::Staged) => Source::Git(format!(":0:{top_path}")),
        _ => Source::Disk(top_path.to_string()),
    };
    (old, new)
}

/// The literal, top-anchored pathspec of one top-relative path.
pub(crate) fn literal(top_path: &str) -> String {
    format!(":(top,literal){top_path}")
}

/// The text of `path` (as the list gives it, relative to `folder`) under `filter`: only that row
/// is looked up and counted. `Err`: [`NOT_CHANGED`] when the path is not in the list, [`OUTSIDE`]
/// for a file whose real location is not inside the folder, or why git could not tell.
pub fn file_text(git_bin: &Path, folder: &Path, path: &str, filter: Filter) -> Result<FileText, String> {
    let repo = repo(git_bin, folder)?;
    let entries = status(git_bin, folder, &repo)?;
    let mut row = rows(&entries, filter, &repo.prefix)
        .into_iter()
        .find(|r| r.file.path == path)
        .ok_or_else(|| NOT_CHANGED.to_string())?;
    let no_text = if row.file.unreadable_name {
        Some(Content::UnreadableName)
    } else if row.file.submodule {
        Some(Content::Submodule)
    } else {
        None
    };
    if let Some(content) = no_text {
        return Ok(FileText { file: row.file, content });
    }
    // This row's counts only.
    let mut specs = vec![literal(&row.top_path)];
    specs.extend(row.entry.orig_path.as_deref().map(literal));
    let counts = if row.file.status == FileStatus::Untracked { Vec::new() } else { numstat(git_bin, folder, filter, &repo, &specs)? };
    let counts: HashMap<&str, &NumstatEntry> = counts.iter().map(|n| (n.path.as_str(), n)).collect();
    count_row(&mut row, &counts, |top| count_untracked(&repo.top.join(top), folder));
    if row.file.binary || row.file.too_large {
        let content = if row.file.binary { Content::Binary } else { Content::TooLarge };
        return Ok(FileText { file: row.file, content });
    }
    let (old, new) = sources(&row.entry, &row.file, &row.top_path, filter, repo.has_head);
    let read = |source: Source| -> Result<Side, String> {
        match source {
            Source::Absent => Ok(Side::Absent),
            Source::Git(spec) => show(git_bin, folder, &spec),
            Source::Disk(top_rel) => read_disk(&repo.top.join(top_rel), folder),
        }
    };
    let content = content_of(read(old)?, read(new)?, false);
    Ok(FileText { file: row.file, content })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn z(records: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for r in records {
            out.extend_from_slice(r);
            out.push(0);
        }
        out
    }

    const OID: &str = "45b983be36b73c0788dc9cbcb76cbb80fc7bb057";

    fn ordinary(xy: &str, path: &str) -> String {
        format!("1 {xy} N... 100644 100644 100644 {OID} {OID} {path}")
    }

    fn entry(kind: RecordKind, x: char, y: char, path: &str, orig: Option<&str>) -> StatusEntry {
        StatusEntry {
            kind,
            x,
            y,
            path: path.into(),
            orig_path: orig.map(str::to_string),
            ..StatusEntry::default()
        }
    }

    fn untracked_lines(lines: u32) -> Untracked {
        Untracked { lines, ..Untracked::default() }
    }

    #[test]
    fn status_records_of_every_kind_are_parsed_with_paths_that_hold_spaces() {
        let raw = z(&[
            ordinary(".M", "src/lib file.rs").as_bytes(),
            ordinary("A.", "new.txt").as_bytes(),
            format!("2 R. N... 100644 100644 100644 {OID} {OID} R100 b.ts").as_bytes(),
            b"a.ts",
            format!("u UU N... 100644 100644 100644 100644 {OID} {OID} {OID} conflict.txt").as_bytes(),
            b"? untracked.md",
            b"? nested/",
            b"! ignored.log",
            b"z something new",
            format!("1 .M SC.. 160000 160000 160000 {OID} {OID} sub").as_bytes(),
            b"? caf\xe9.txt",
        ]);
        let got = parse_status_z(&raw);
        assert_eq!(got.len(), 7, "{got:?}");
        assert_eq!((got[0].kind, got[0].x, got[0].y, got[0].path.as_str()), (RecordKind::Ordinary, '.', 'M', "src/lib file.rs"));
        assert_eq!((got[1].x, got[1].y), ('A', '.'));
        assert_eq!(got[2].kind, RecordKind::Renamed);
        assert_eq!((got[2].path.as_str(), got[2].orig_path.as_deref()), ("b.ts", Some("a.ts")));
        assert_eq!((got[3].kind, got[3].path.as_str()), (RecordKind::Unmerged, "conflict.txt"));
        assert_eq!((got[4].kind, got[4].path.as_str()), (RecordKind::Untracked, "untracked.md"));
        assert!(got[5].submodule && !got[0].submodule, "the sub field S… is a submodule");
        assert!(got[6].bad_name, "a name that is not UTF-8");
        assert_eq!(got[6].path, "caf\u{FFFD}.txt");
        assert!(parse_status_z(b"").is_empty());
    }

    #[test]
    fn numstat_records_hold_counts_renames_and_binary_dashes() {
        let raw = z(&[b"3\t1\tsrc/a.rs", b"-\t-\timg.png", b"2\t0\t", b"old/a.ts", b"new/b.ts", b"garbage"]);
        let got = parse_numstat_z(&raw);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], NumstatEntry { path: "src/a.rs".into(), old_path: None, added: Some(3), removed: Some(1) });
        assert_eq!((got[1].added, got[1].removed), (None, None));
        assert_eq!((got[2].path.as_str(), got[2].old_path.as_deref(), got[2].added), ("new/b.ts", Some("old/a.ts"), Some(2)));
    }

    #[test]
    fn the_filter_decides_what_a_status_entry_is() {
        let e = |x: char, y: char| entry(RecordKind::Ordinary, x, y, "p", None);
        // Staged only.
        assert_eq!(classify(&e('M', '.'), Filter::All), Some(FileStatus::Modified));
        assert_eq!(classify(&e('M', '.'), Filter::Staged), Some(FileStatus::Modified));
        assert_eq!(classify(&e('M', '.'), Filter::Unstaged), None);
        // Unstaged only.
        assert_eq!(classify(&e('.', 'M'), Filter::Staged), None);
        assert_eq!(classify(&e('.', 'M'), Filter::Unstaged), Some(FileStatus::Modified));
        // Added and deleted.
        assert_eq!(classify(&e('A', 'M'), Filter::All), Some(FileStatus::Added));
        assert_eq!(classify(&e('A', 'M'), Filter::Unstaged), Some(FileStatus::Modified));
        assert_eq!(classify(&e('A', 'D'), Filter::All), None, "nothing on either side");
        assert_eq!(classify(&e('.', 'D'), Filter::All), Some(FileStatus::Deleted));
        assert_eq!(classify(&e('D', '.'), Filter::Staged), Some(FileStatus::Deleted));
        // Intent to add.
        assert_eq!(classify(&e('.', 'A'), Filter::All), Some(FileStatus::Added));
        assert_eq!(classify(&e('.', 'A'), Filter::Unstaged), Some(FileStatus::Added));
        assert_eq!(classify(&e('.', 'A'), Filter::Staged), None);
        // Untracked and conflicted are never staged.
        let u = entry(RecordKind::Untracked, '?', '?', "u", None);
        assert_eq!(classify(&u, Filter::All), Some(FileStatus::Untracked));
        assert_eq!(classify(&u, Filter::Staged), None);
        let c = entry(RecordKind::Unmerged, 'U', 'U', "c", None);
        assert_eq!(classify(&c, Filter::Unstaged), Some(FileStatus::Conflicted));
        assert_eq!(classify(&c, Filter::Staged), None);
    }

    #[test]
    fn a_staged_rename_then_deleted_from_disk() {
        let rd = entry(RecordKind::Renamed, 'R', 'D', "b.ts", Some("a.ts"));
        let all = rows(std::slice::from_ref(&rd), Filter::All, "");
        assert_eq!((all[0].file.path.as_str(), all[0].file.status, all[0].file.old_path.as_deref()), ("a.ts", FileStatus::Deleted, None));
        let (old, new) = sources(&rd, &all[0].file, &all[0].top_path, Filter::All, true);
        assert_eq!((old, new), (Source::Git("HEAD:a.ts".into()), Source::Absent));
        let staged = rows(std::slice::from_ref(&rd), Filter::Staged, "");
        assert_eq!((staged[0].file.path.as_str(), staged[0].file.status, staged[0].file.old_path.as_deref()), ("b.ts", FileStatus::Renamed, Some("a.ts")));
        let unstaged = rows(std::slice::from_ref(&rd), Filter::Unstaged, "");
        assert_eq!((unstaged[0].file.path.as_str(), unstaged[0].file.status), ("b.ts", FileStatus::Deleted));
        let (old, _) = sources(&rd, &unstaged[0].file, "b.ts", Filter::Unstaged, true);
        assert_eq!(old, Source::Git(":0:b.ts".into()));
    }

    #[test]
    fn git_rm_cached_is_one_row_deleted_from_the_index_and_still_on_disk() {
        let status = vec![entry(RecordKind::Ordinary, 'D', '.', "a.txt", None), entry(RecordKind::Untracked, '?', '?', "a.txt", None)];
        let all = rows(&status, Filter::All, "");
        assert_eq!(all.len(), 1);
        assert_eq!((all[0].file.status, all[0].file.on_disk), (FileStatus::Deleted, true));
        assert_eq!(sources(&all[0].entry, &all[0].file, "a.txt", Filter::All, true).1, Source::Disk("a.txt".into()));
        let staged = rows(&status, Filter::Staged, "");
        assert_eq!((staged[0].file.status, staged[0].file.on_disk), (FileStatus::Deleted, true));
        assert_eq!(sources(&staged[0].entry, &staged[0].file, "a.txt", Filter::Staged, true).1, Source::Absent);
        let unstaged = rows(&status, Filter::Unstaged, "");
        assert_eq!((unstaged.len(), unstaged[0].file.status), (1, FileStatus::Untracked));
    }

    #[test]
    fn a_list_takes_counts_from_numstat_untracked_lines_from_disk_and_paths_from_the_prefix() {
        let status = vec![
            entry(RecordKind::Ordinary, '.', 'M', "web/src/a.ts", None),
            entry(RecordKind::Renamed, 'R', 'M', "web/b.ts", Some("web/old.ts")),
            entry(RecordKind::Ordinary, 'M', '.', "web/img.png", None),
            entry(RecordKind::Untracked, '?', '?', "web/notes.md", None),
        ];
        let numstat = vec![
            NumstatEntry { path: "web/src/a.ts".into(), old_path: None, added: Some(2), removed: Some(1) },
            NumstatEntry { path: "web/b.ts".into(), old_path: Some("web/old.ts".into()), added: Some(1), removed: Some(0) },
            NumstatEntry { path: "web/img.png".into(), old_path: None, added: None, removed: None },
        ];
        let all = build_list(&status, &numstat, Filter::All, "web/", |p| {
            assert_eq!(p, "web/notes.md");
            untracked_lines(7)
        });
        let rows: Vec<_> = all.iter().map(|f| (f.path.as_str(), f.old_path.as_deref(), f.status, f.added, f.removed, f.binary)).collect();
        assert_eq!(
            rows,
            [
                ("b.ts", Some("old.ts"), FileStatus::Renamed, 1, 0, false),
                ("img.png", None, FileStatus::Modified, 0, 0, true),
                ("notes.md", None, FileStatus::Untracked, 7, 0, false),
                ("src/a.ts", None, FileStatus::Modified, 2, 1, false),
            ]
        );
        let unstaged = build_list(&status, &[], Filter::Unstaged, "web/", |_| untracked_lines(1));
        assert_eq!(unstaged.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["b.ts", "notes.md", "src/a.ts"]);
        assert_eq!(unstaged[0].old_path, None, "the working tree against the index is no rename");
        let staged = build_list(&status, &[], Filter::Staged, "web/", |_| unreachable!());
        assert_eq!(staged.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["b.ts", "img.png"]);
        assert_eq!(relative_to_prefix("lib/x.rs", "web/"), ":/lib/x.rs");
        assert_eq!(relative_to_prefix("lib/x.rs", ""), "lib/x.rs");
    }

    #[test]
    fn the_list_is_capped_with_the_rest_counted() {
        let mut many: Vec<u32> = (0..5003).collect();
        assert_eq!(cap_rows(&mut many), 3);
        assert_eq!(many.len(), MAX_ROWS);
        let mut few = vec![1, 2];
        assert_eq!(cap_rows(&mut few), 0);
    }

    #[test]
    fn content_is_binary_too_large_or_lossy_text_with_lf_line_ends() {
        let b = |s: &[u8]| Side::Bytes(s.to_vec());
        assert_eq!(content_of(b(b"a\0b"), b(b"x"), false), Content::Binary);
        assert_eq!(content_of(b(b"a"), b(b"b"), true), Content::Binary);
        assert_eq!(content_of(Side::Over, b(b"x"), false), Content::TooLarge);
        let many = "x\n".repeat(MAX_SIDE_LINES + 1);
        assert_eq!(content_of(Side::Absent, b(many.as_bytes()), false), Content::TooLarge);
        assert_eq!(
            content_of(Side::Absent, b(b"new\n"), false),
            Content::Text { old: None, new: Some("new\n".into()), not_utf8: false }
        );
        assert_eq!(
            content_of(b(b"caf\xe9\n"), b(b"cafe\n"), false),
            Content::Text { old: Some("caf\u{FFFD}\n".into()), new: Some("cafe\n".into()), not_utf8: true }
        );
        assert_eq!(
            content_of(b(b"a\nb\n"), b(b"a\r\nB\r\n"), false),
            Content::Text { old: Some("a\nb\n".into()), new: Some("a\nB\n".into()), not_utf8: false }
        );
        assert_eq!(line_count(b""), 0);
        assert_eq!(line_count(b"a"), 1);
        assert_eq!(line_count(b"a\nb\n"), 2);
    }

    #[test]
    fn the_wire_tags_are_pinned() {
        let tag = |c: Content| serde_json::to_value(c).unwrap();
        assert_eq!(tag(Content::Binary), serde_json::json!({ "kind": "binary" }));
        assert_eq!(tag(Content::TooLarge), serde_json::json!({ "kind": "too_large" }));
        assert_eq!(tag(Content::Submodule), serde_json::json!({ "kind": "submodule" }));
        assert_eq!(tag(Content::UnreadableName), serde_json::json!({ "kind": "unreadable_name" }));
        assert_eq!(
            tag(Content::Text { old: None, new: Some("x".into()), not_utf8: true }),
            serde_json::json!({ "kind": "text", "old": null, "new": "x", "notUtf8": true })
        );
        let file = serde_json::to_value(ChangedFile { path: "a".into(), ..ChangedFile::default() }).unwrap();
        assert_eq!(
            file,
            serde_json::json!({ "path": "a", "oldPath": null, "status": "modified", "added": 0, "removed": 0, "binary": false,
                "submodule": false, "unreadableName": false, "tooLarge": false, "onDisk": false })
        );
    }

    #[test]
    fn sides_come_from_head_the_index_or_disk_by_filter() {
        let e = entry(RecordKind::Renamed, 'R', 'M', "b.ts", Some("a.ts"));
        let file = |status| ChangedFile { path: "b.ts".into(), status, ..ChangedFile::default() };
        assert_eq!(
            sources(&e, &file(FileStatus::Renamed), "b.ts", Filter::All, true),
            (Source::Git("HEAD:a.ts".into()), Source::Disk("b.ts".into()))
        );
        assert_eq!(
            sources(&e, &file(FileStatus::Renamed), "b.ts", Filter::Staged, true),
            (Source::Git("HEAD:a.ts".into()), Source::Git(":0:b.ts".into()))
        );
        assert_eq!(
            sources(&e, &file(FileStatus::Modified), "b.ts", Filter::Unstaged, true),
            (Source::Git(":0:b.ts".into()), Source::Disk("b.ts".into()))
        );
        assert_eq!(sources(&e, &file(FileStatus::Deleted), "b.ts", Filter::All, true).1, Source::Absent);
        assert_eq!(sources(&e, &file(FileStatus::Untracked), "b.ts", Filter::All, true).0, Source::Absent);
        assert_eq!(sources(&e, &file(FileStatus::Modified), "b.ts", Filter::All, false).0, Source::Absent, "no commit yet");
        // A conflict where a side added the file has no HEAD side.
        for xy in [('A', 'A'), ('A', 'U'), ('U', 'A')] {
            let c = entry(RecordKind::Unmerged, xy.0, xy.1, "c.ts", None);
            assert_eq!(sources(&c, &file(FileStatus::Conflicted), "c.ts", Filter::All, true).0, Source::Absent, "{xy:?}");
        }
        let uu = entry(RecordKind::Unmerged, 'U', 'U', "c.ts", None);
        assert_eq!(sources(&uu, &file(FileStatus::Conflicted), "c.ts", Filter::All, true).0, Source::Git("HEAD:c.ts".into()));
    }

    /// A link is shown as its target text; a file whose real location is outside is refused.
    /// Skipped where links cannot be made.
    #[test]
    fn read_disk_shows_a_link_as_text_and_refuses_outside() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let folder = base.join("repo");
        let outside = base.join("secret");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("key.txt"), "k").unwrap();
        assert_eq!(read_disk(&outside.join("key.txt"), &folder), Err(OUTSIDE.to_string()));
        assert_eq!(read_disk(&folder.join("gone.txt"), &folder), Ok(Side::Absent));
        let link = folder.join("link.txt");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(outside.join("key.txt"), &link).is_ok();
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(outside.join("key.txt"), &link).is_ok();
        if !made {
            eprintln!("skipped: cannot create a link here");
            return;
        }
        match read_disk(&link, &folder).unwrap() {
            Side::Bytes(text) => {
                let text = String::from_utf8(text).unwrap();
                assert!(text.ends_with("secret/key.txt"), "{text}");
            }
            other => panic!("not the link's text: {other:?}"),
        }
        // The link's target text, never what it points at.
        assert_eq!(count_untracked(&link, &folder), Untracked { lines: 1, ..Untracked::default() });
    }

    // -- the real binary, in temp repos (skipped when git is not on PATH) -------------------

    use crate::git::branches::tests::{git_ok, real_git, temp_repo};

    fn text(content: &Content) -> (Option<&str>, Option<&str>) {
        match content {
            Content::Text { old, new, .. } => (old.as_deref(), new.as_deref()),
            other => panic!("not text: {other:?}"),
        }
    }

    fn paths(list: &ChangeList) -> Vec<&str> {
        list.files.iter().map(|f| f.path.as_str()).collect()
    }

    fn row<'a>(list: &'a ChangeList, path: &str) -> &'a ChangedFile {
        list.files.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path} not listed: {:?}", paths(list)))
    }

    const TS_OLD: &str = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\nexport const f = 6;\n";
    const TS_NEW: &str = "export const a = 1;\nexport const b = 20;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\nexport const f = 6;\n";

    #[test]
    fn a_dirty_repo_lists_modified_staged_renamed_untracked_binary_and_large_files() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let repo = dunce::canonicalize(dir.path()).unwrap();
        std::fs::write(repo.join("m.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(repo.join("old.ts"), TS_OLD).unwrap();
        std::fs::write(repo.join("img.png"), b"\x89PNG\0\0\x01").unwrap();
        std::fs::write(repo.join("big.txt"), "x\n").unwrap();
        std::fs::write(repo.join("gone.txt"), "bye\n").unwrap();
        std::fs::write(repo.join("long.txt"), "x\n").unwrap();
        git_ok(&git, &repo, &["add", "."]);
        git_ok(&git, &repo, &["commit", "-q", "-m", "second"]);

        // Unstaged: m.txt modified. Staged: a.txt modified. Renamed + edited: old.ts -> new.ts.
        std::fs::write(repo.join("m.txt"), "one\n2\nthree\nfour\n").unwrap();
        std::fs::write(repo.join("a.txt"), "staged\n").unwrap();
        git_ok(&git, &repo, &["add", "a.txt"]);
        git_ok(&git, &repo, &["mv", "old.ts", "new.ts"]);
        std::fs::write(repo.join("new.ts"), TS_NEW).unwrap();
        std::fs::write(repo.join("untracked.md"), "# hi\n\nthere\n").unwrap();
        std::fs::write(repo.join("img.png"), b"\x89PNG\0\0\x02").unwrap();
        std::fs::write(repo.join("big.txt"), "y".repeat(3 * 1024 * 1024)).unwrap();
        std::fs::remove_file(repo.join("gone.txt")).unwrap();
        // Too large by its line count alone (well under 2 MB).
        std::fs::write(repo.join("long.txt"), "x\n".repeat(MAX_SIDE_LINES + 10)).unwrap();
        std::fs::write(repo.join("blob.bin"), b"un\0tracked").unwrap();
        std::fs::write(repo.join("huge.log"), "z".repeat(MAX_SIDE_BYTES + 10)).unwrap();

        let all = list(&git, &repo, Filter::All).unwrap();
        let rows: Vec<_> = all.files.iter().map(|f| (f.path.as_str(), f.status, f.added, f.removed, f.binary)).collect();
        assert_eq!(
            rows,
            [
                ("a.txt", FileStatus::Modified, 1, 1, false),
                ("big.txt", FileStatus::Modified, 1, 1, false),
                ("blob.bin", FileStatus::Untracked, 0, 0, true),
                ("gone.txt", FileStatus::Deleted, 0, 1, false),
                ("huge.log", FileStatus::Untracked, 0, 0, false),
                ("img.png", FileStatus::Modified, 0, 0, true),
                ("long.txt", FileStatus::Modified, MAX_SIDE_LINES as u32 + 9, 0, false),
                ("m.txt", FileStatus::Modified, 2, 1, false),
                ("new.ts", FileStatus::Renamed, 1, 1, false),
                ("untracked.md", FileStatus::Untracked, 3, 0, false),
            ]
        );
        assert_eq!(row(&all, "new.ts").old_path.as_deref(), Some("old.ts"));
        assert!(row(&all, "huge.log").too_large, "an untracked file past 2 MB is not counted");
        assert_eq!(all.more, 0);

        let staged = list(&git, &repo, Filter::Staged).unwrap();
        assert_eq!(paths(&staged), ["a.txt", "new.ts"]);
        let unstaged = list(&git, &repo, Filter::Unstaged).unwrap();
        assert_eq!(
            paths(&unstaged),
            ["big.txt", "blob.bin", "gone.txt", "huge.log", "img.png", "long.txt", "m.txt", "new.ts", "untracked.md"]
        );

        // The text of each.
        let m = file_text(&git, &repo, "m.txt", Filter::All).unwrap();
        assert_eq!(text(&m.content), (Some("one\ntwo\nthree\n"), Some("one\n2\nthree\nfour\n")));
        assert_eq!((m.file.added, m.file.removed), (2, 1), "the row is counted");
        let renamed = file_text(&git, &repo, "new.ts", Filter::All).unwrap();
        assert_eq!(text(&renamed.content), (Some(TS_OLD), Some(TS_NEW)), "the old side is old.ts");
        assert_eq!((renamed.file.added, renamed.file.removed), (1, 1));
        let staged_a = file_text(&git, &repo, "a.txt", Filter::Staged).unwrap();
        assert_eq!(text(&staged_a.content), (Some("a"), Some("staged\n")));
        let unstaged_a = file_text(&git, &repo, "new.ts", Filter::Unstaged).unwrap();
        assert_eq!(text(&unstaged_a.content), (Some(TS_OLD), Some(TS_NEW)), "the index (stage 0) against the disk");
        let untracked = file_text(&git, &repo, "untracked.md", Filter::All).unwrap();
        assert_eq!(text(&untracked.content), (None, Some("# hi\n\nthere\n")));
        assert_eq!(untracked.file.added, 3);
        let gone = file_text(&git, &repo, "gone.txt", Filter::All).unwrap();
        assert_eq!(text(&gone.content), (Some("bye\n"), None));
        assert_eq!(file_text(&git, &repo, "img.png", Filter::All).unwrap().content, Content::Binary);
        assert_eq!(file_text(&git, &repo, "blob.bin", Filter::All).unwrap().content, Content::Binary);
        let big = file_text(&git, &repo, "big.txt", Filter::All).unwrap();
        assert_eq!(big.content, Content::TooLarge);
        assert_eq!((big.file.added, big.file.removed), (1, 1), "counts are still shown");
        assert_eq!(file_text(&git, &repo, "long.txt", Filter::All).unwrap().content, Content::TooLarge);
        assert_eq!(file_text(&git, &repo, "huge.log", Filter::All).unwrap().content, Content::TooLarge);
        assert_eq!(file_text(&git, &repo, "a.txt", Filter::Unstaged), Err(NOT_CHANGED.to_string()));
        assert_eq!(file_text(&git, &repo, "../outside.txt", Filter::All), Err(NOT_CHANGED.to_string()));
    }

    #[test]
    fn edge_entries_intent_to_add_rm_cached_and_a_non_utf8_head_side() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let repo = dunce::canonicalize(dir.path()).unwrap();
        std::fs::write(repo.join("latin.txt"), b"caf\xe9\n").unwrap();
        git_ok(&git, &repo, &["add", "latin.txt"]);
        git_ok(&git, &repo, &["commit", "-q", "-m", "latin"]);
        std::fs::write(repo.join("latin.txt"), "café\n").unwrap();
        // Intent to add.
        std::fs::write(repo.join("n.txt"), "new\n").unwrap();
        git_ok(&git, &repo, &["add", "-N", "n.txt"]);
        // Deleted from the index, still on disk.
        git_ok(&git, &repo, &["rm", "-q", "--cached", "a.txt"]);

        let all = list(&git, &repo, Filter::All).unwrap();
        assert_eq!(paths(&all), ["a.txt", "latin.txt", "n.txt"], "rm --cached is one row");
        assert_eq!((row(&all, "n.txt").status, row(&all, "n.txt").added), (FileStatus::Added, 1));
        assert_eq!((row(&all, "a.txt").status, row(&all, "a.txt").on_disk), (FileStatus::Deleted, true));
        let unstaged = list(&git, &repo, Filter::Unstaged).unwrap();
        assert_eq!(row(&unstaged, "n.txt").status, FileStatus::Added);
        assert_eq!(row(&unstaged, "a.txt").status, FileStatus::Untracked);
        let staged = list(&git, &repo, Filter::Staged).unwrap();
        assert_eq!(paths(&staged), ["a.txt"]);

        let n = file_text(&git, &repo, "n.txt", Filter::All).unwrap();
        assert_eq!(text(&n.content), (None, Some("new\n")));
        let a = file_text(&git, &repo, "a.txt", Filter::All).unwrap();
        assert_eq!(text(&a.content), (Some("a"), Some("a")), "HEAD against the file still on disk");
        let latin = file_text(&git, &repo, "latin.txt", Filter::All).unwrap();
        assert_eq!(latin.content, Content::Text { old: Some("caf\u{FFFD}\n".into()), new: Some("café\n".into()), not_utf8: true });
    }

    #[test]
    fn with_autocrlf_only_the_changed_line_differs() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let repo = dunce::canonicalize(dir.path()).unwrap();
        git_ok(&git, &repo, &["config", "core.autocrlf", "true"]);
        std::fs::write(repo.join("w.txt"), "one\r\ntwo\r\nthree\r\n").unwrap();
        git_ok(&git, &repo, &["add", "w.txt"]);
        git_ok(&git, &repo, &["commit", "-q", "-m", "crlf"]);
        std::fs::write(repo.join("w.txt"), "one\r\n2\r\nthree\r\n").unwrap();
        let all = list(&git, &repo, Filter::All).unwrap();
        assert_eq!((row(&all, "w.txt").added, row(&all, "w.txt").removed), (1, 1));
        let w = file_text(&git, &repo, "w.txt", Filter::All).unwrap();
        assert_eq!(text(&w.content), (Some("one\ntwo\nthree\n"), Some("one\n2\nthree\n")));
    }

    #[test]
    fn conflicts_show_the_merge_markers_and_an_added_on_both_sides_file_has_no_head_side() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let repo = dunce::canonicalize(dir.path()).unwrap();
        git_ok(&git, &repo, &["checkout", "-q", "-b", "other"]);
        std::fs::write(repo.join("a.txt"), "theirs\n").unwrap();
        std::fs::write(repo.join("both.txt"), "theirs\n").unwrap();
        git_ok(&git, &repo, &["add", "."]);
        git_ok(&git, &repo, &["commit", "-q", "-m", "theirs"]);
        git_ok(&git, &repo, &["checkout", "-q", "main"]);
        std::fs::write(repo.join("a.txt"), "ours\n").unwrap();
        std::fs::write(repo.join("both.txt"), "ours\n").unwrap();
        git_ok(&git, &repo, &["add", "."]);
        git_ok(&git, &repo, &["commit", "-q", "-m", "ours"]);
        let merge = std::process::Command::new(&git)
            .args(["merge", "-q", "other"])
            .current_dir(&repo)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(!merge.status.success(), "the merge conflicts");

        let all = list(&git, &repo, Filter::All).unwrap();
        assert_eq!(row(&all, "a.txt").status, FileStatus::Conflicted);
        assert_eq!(row(&all, "both.txt").status, FileStatus::Conflicted);
        assert!(list(&git, &repo, Filter::Staged).unwrap().files.is_empty());
        let a = file_text(&git, &repo, "a.txt", Filter::All).unwrap();
        let (old, new) = text(&a.content);
        assert_eq!(old, Some("ours\n"), "HEAD");
        assert!(new.unwrap().contains("<<<<<<<"), "the markers on disk: {new:?}");
        let both = file_text(&git, &repo, "both.txt", Filter::All).unwrap();
        assert_eq!(text(&both.content).0, None, "added on both sides: no HEAD side");
    }

    #[test]
    fn a_submodule_is_listed_with_no_text() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let sub = temp_repo(&git);
        let dir = temp_repo(&git);
        let repo = dunce::canonicalize(dir.path()).unwrap();
        // A local-path submodule; file transport allowed for this one command in the temp repo.
        let source = sub.path().display().to_string().replace('\\', "/");
        let added = std::process::Command::new(&git)
            .args(["-c", "protocol.file.allow=always", "submodule", "add", "-q", &source, "sub"])
            .current_dir(&repo)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        if !added.status.success() {
            eprintln!("skipped: no submodule here: {}", String::from_utf8_lossy(&added.stderr));
            return;
        }
        git_ok(&git, &repo, &["commit", "-q", "-m", "sub"]);
        let inner = repo.join("sub");
        git_ok(&git, &inner, &["config", "user.name", "Switchboard Test"]);
        git_ok(&git, &inner, &["config", "user.email", "test@example.invalid"]);
        git_ok(&git, &inner, &["config", "commit.gpgsign", "false"]);
        std::fs::write(inner.join("a.txt"), "moved on\n").unwrap();
        git_ok(&git, &repo.join("sub"), &["commit", "-q", "-am", "moved"]);

        let all = list(&git, &repo, Filter::All).unwrap();
        let sub_row = row(&all, "sub");
        assert!(sub_row.submodule, "{sub_row:?}");
        assert_eq!(file_text(&git, &repo, "sub", Filter::All).unwrap().content, Content::Submodule);
    }

    #[test]
    fn a_clean_repo_lists_nothing_and_a_plain_folder_is_not_a_repo() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        assert!(list(&git, dir.path(), Filter::All).unwrap().files.is_empty());
        let plain = tempfile::tempdir().unwrap();
        if !crate::git::status::tests::inside_work_tree(&git, plain.path()) {
            assert_eq!(list(&git, plain.path(), Filter::All).unwrap_err(), NOT_A_REPO);
        }
    }

    #[test]
    fn a_repo_without_commits_lists_staged_and_untracked_files() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git_ok(&git, repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "a\nb\n").unwrap();
        std::fs::write(repo.join("u.txt"), "u\n").unwrap();
        git_ok(&git, repo, &["add", "a.txt"]);
        let all = list(&git, repo, Filter::All).unwrap();
        assert_eq!(
            all.files.iter().map(|f| (f.path.as_str(), f.status, f.added)).collect::<Vec<_>>(),
            [("a.txt", FileStatus::Added, 2), ("u.txt", FileStatus::Untracked, 1)]
        );
        let a = file_text(&git, repo, "a.txt", Filter::All).unwrap();
        assert_eq!(text(&a.content), (None, Some("a\nb\n")));
    }

    #[test]
    fn a_subfolder_project_lists_only_its_files_and_leaves_out_linked_worktrees() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let repo = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(repo.join("web/src")).unwrap();
        std::fs::write(repo.join("web/src/x.ts"), "x\n").unwrap();
        std::fs::write(repo.join("a.txt"), "changed\n").unwrap();
        git_ok(&git, &repo, &["worktree", "add", "-q", "-b", "feat", ".worktrees/feat"]);
        std::fs::write(repo.join(".worktrees/feat/f.txt"), "in the worktree\n").unwrap();

        let web = list(&git, &repo.join("web"), Filter::All).unwrap();
        assert_eq!(paths(&web), ["src/x.ts"]);
        let x = file_text(&git, &repo.join("web"), "src/x.ts", Filter::All).unwrap();
        assert_eq!(text(&x.content), (None, Some("x\n")));

        let top = list(&git, &repo, Filter::All).unwrap();
        assert_eq!(paths(&top), ["a.txt", "web/src/x.ts"], "the linked worktree inside is left out");
        // The worktree reviewed on its own.
        let feat = list(&git, &repo.join(".worktrees/feat"), Filter::All).unwrap();
        assert_eq!(paths(&feat), ["f.txt"]);
    }

    #[test]
    fn invalid_utf8_on_disk_is_shown_lossily_and_marked() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        std::fs::write(dir.path().join("a.txt"), b"caf\xe9\n").unwrap();
        let a = file_text(&git, dir.path(), "a.txt", Filter::All).unwrap();
        assert_eq!(a.content, Content::Text { old: Some("a".into()), new: Some("caf\u{FFFD}\n".into()), not_utf8: true });
    }
}
