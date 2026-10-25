//! A branch against its base, and its commits (Story 8.2): what the Review pane's "vs base" and
//! "Commits" modes show. Read-only, like [`super::diff`]: every git call is prompt-less, lock-free
//! and in English ([`super::branches::git`]), and nothing is written to the repository.
//!
//! **The branch and its base.** Both are local branches of the repository at the project's folder
//! (a branch needs no worktree: its commits are read from the repository). A project's branch is
//! the one checked out in its folder (a detached HEAD is refused). The default base is the
//! repository's default branch ([`super::worktree::default_branch`]: `origin/HEAD`'s name, then
//! `main`, then `master`) when that is a local branch other than the one compared, else the first
//! other local branch by name; with no other local branch there is no base ([`NO_BASE`]). A base
//! asked for must be a local branch. Branch names that are not UTF-8 are skipped. Every ref is
//! passed to git in full (`refs/heads/<name>`), never as an option, and each read resolves the
//! branch's tip and the base to commit ids once, so a ref that moves mid-read cannot mix states.
//!
//! **Errors with choices.** Once the branch and the local branches are known, a failure (a base
//! that is not a local branch, no base, no common ancestor, a commit not in the list) comes back
//! in the reply's `error` with the bases, so the operator can always pick another base.
//!
//! **vs base** lists what the branch changed since it forked: `git diff --raw -z -M` (the whole
//! repository, so a rename into the project's folder from outside it is seen as one) and
//! `--numstat -z -M` (the folder, plus such renames' sources) between `git merge-base <base>
//! <branch>` and the branch tip, keeping the files inside the project's folder, paths relative to
//! it. A file renamed out of the folder is listed as deleted. The raw records carry the status and
//! the modes (a `160000` side is a submodule); the numstat records the counts. A file's sides are
//! `git show <merge-base>:<old path>` and `<tip>:<path>`, with 8.1's caps and decoding
//! ([`super::diff::content_of`]). One file's text diffs only that path (and, for an added file,
//! looks for a rename's source).
//!
//! **Commits** are `git log <base>..<branch>`, newest first, at most [`MAX_COMMITS`] (the rest
//! counted in `more`). A commit's files are its diff against its first parent (the empty tree for
//! a root commit), listed and shown like vs base. A commit is accepted only when it is one of the
//! commits the list gives (the newest [`MAX_COMMITS`] of the range).

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Serialize;

use super::GitError;
use super::branches::git;
use super::diff::{self, ChangedFile, Content, DIFF_TIMEOUT, FileStatus, FileText, NOT_CHANGED, NumstatEntry, Side};

/// The most commits one list sends; the rest are counted in `more`.
pub const MAX_COMMITS: usize = 200;

/// Why a base is refused (followed by `: <name>`).
pub const NOT_LOCAL_BRANCH: &str = "not a local branch";

/// Why a branch is refused (followed by `: <name>`).
pub const UNKNOWN_BRANCH: &str = "unknown branch";

/// Why a project's branch cannot be compared: HEAD names no branch.
pub const DETACHED: &str = "HEAD is detached: no branch to compare";

/// Why a commit is refused: it is not one of the listed commits.
pub const NOT_IN_RANGE: &str = "not a commit of this list";

/// Why vs base has nothing to compare (followed by ` with <base>`).
pub const NO_MERGE_BASE: &str = "no common ancestor";

/// Why nothing is compared: there is no other local branch to use as the base.
pub const NO_BASE: &str = "no base branch: pick one";

/// The branch compared, its base and the bases offered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bases {
    pub branch: String,
    /// The base used (the one asked for, else the default); `None` when there is none or the one
    /// asked for is not a local branch.
    pub base: Option<String>,
    /// The default base, `None` without another local branch.
    pub default_base: Option<String>,
    /// Every local branch, sorted by name.
    pub bases: Vec<String>,
}

/// What `review_range_list` returns: the files of vs base, or of one commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeList {
    /// The project's folder (canonical).
    pub root: String,
    #[serde(flatten)]
    pub bases: Bases,
    /// Why nothing is listed (the bases are still offered).
    pub error: Option<String>,
    /// The project's folder is a subfolder of the repository: only its files are listed.
    pub subfolder: bool,
    /// The commit whose files these are, or `None` for vs base.
    pub commit: Option<String>,
    /// Commits on the branch beyond the base (vs base only; 0 for a commit's files).
    pub ahead: usize,
    pub files: Vec<ChangedFile>,
    /// Files past [`diff::MAX_ROWS`], not sent.
    pub more: usize,
}

/// One commit of the list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    /// Author time, seconds since the epoch (0 when unreadable).
    pub at: i64,
    /// Its parents' ids; the first is the one it is diffed against (none: a root commit).
    pub parents: Vec<String>,
}

/// What `review_commits` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitLog {
    pub root: String,
    #[serde(flatten)]
    pub bases: Bases,
    /// Why nothing is listed (the bases are still offered).
    pub error: Option<String>,
    /// Newest first, at most [`MAX_COMMITS`].
    pub commits: Vec<Commit>,
    /// Commits of the range past [`MAX_COMMITS`], not sent.
    pub more: usize,
}

// -- parsing --------------------------------------------------------------------------------

/// One `git diff --raw -z` record; paths relative to the repository's top level.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEntry {
    /// The status letter (`A C D M R T U X`).
    pub status: char,
    pub path: String,
    /// A rename's (or copy's) source path.
    pub old_path: Option<String>,
    /// A side has mode `160000`.
    pub submodule: bool,
    /// A path was not valid UTF-8 and is lossy.
    pub bad_name: bool,
}

/// Parse `git diff --raw -z` output: `:<mode> <mode> <oid> <oid> <status>NUL<path>NUL`, or for a
/// rename or copy `…R<score>NUL<old>NUL<new>NUL`. Tolerant: a malformed record is skipped.
pub fn parse_raw_z(raw: &[u8]) -> Vec<RawEntry> {
    let mut out = Vec::new();
    let mut fields = raw.split(|b| *b == 0);
    while let Some(head) = fields.next() {
        let head = String::from_utf8_lossy(head);
        let Some(head) = head.trim_start_matches(['\n', '\r']).strip_prefix(':') else { continue };
        let parts: Vec<&str> = head.split(' ').collect();
        let [mode_a, mode_b, _, _, status] = parts.as_slice() else { continue };
        let Some(letter) = status.chars().next() else { continue };
        let two = matches!(letter, 'R' | 'C');
        let Some(first) = fields.next() else { break };
        let (path, old) = if two {
            let Some(second) = fields.next() else { break };
            (second, Some(first))
        } else {
            (first, None)
        };
        let (path, path_ok) = diff::name(path);
        let (old_path, old_ok) = match old {
            Some(o) => {
                let (o, ok) = diff::name(o);
                (Some(o), ok)
            }
            None => (None, true),
        };
        if path.is_empty() {
            continue;
        }
        out.push(RawEntry {
            status: letter,
            path,
            old_path,
            submodule: *mode_a == "160000" || *mode_b == "160000",
            bad_name: !path_ok || !old_ok,
        });
    }
    out
}

/// What a raw status letter is in the tree: a copy is a new file.
pub fn status_of(letter: char) -> FileStatus {
    match letter {
        'A' | 'C' => FileStatus::Added,
        'D' => FileStatus::Deleted,
        'R' => FileStatus::Renamed,
        _ => FileStatus::Modified,
    }
}

/// Fields of one log record (`%H %h %P %an %at %s`, each followed by `%x00`).
const LOG_FIELDS: usize = 6;

/// The `git log` format [`parse_log`] reads.
pub const LOG_FORMAT: &str = "--format=%H%x00%h%x00%P%x00%an%x00%at%x00%s%x00";

/// Parse `git log` output in [`LOG_FORMAT`]. Tolerant: an incomplete record is dropped.
pub fn parse_log(raw: &[u8]) -> Vec<Commit> {
    let fields: Vec<String> = raw.split(|b| *b == 0).map(|f| String::from_utf8_lossy(f).into_owned()).collect();
    fields
        .chunks_exact(LOG_FIELDS)
        .filter_map(|record| {
            let sha = record[0].trim_start_matches(['\n', '\r']).trim().to_string();
            if sha.is_empty() {
                return None;
            }
            Some(Commit {
                sha,
                short: record[1].trim().to_string(),
                parents: record[2].split_whitespace().map(str::to_string).collect(),
                author: record[3].clone(),
                at: record[4].trim().parse().unwrap_or(0),
                subject: record[5].clone(),
            })
        })
        .collect()
}

/// One row of a range with its top-relative paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeRow {
    pub file: ChangedFile,
    pub top_path: String,
    pub old_top: Option<String>,
}

/// Whether the top-relative `path` lies in the folder at `prefix` (`sub/dir/` or empty).
fn inside(path: &str, prefix: &str) -> bool {
    prefix.is_empty() || path.starts_with(prefix)
}

/// The rows of a range from its raw and numstat records: those inside the folder at `prefix`
/// (a rename out of it is the deletion of its source), counted, relative to the folder, one per
/// top-relative path, sorted by path.
pub fn range_rows(raw: &[RawEntry], numstat: &[NumstatEntry], prefix: &str) -> Vec<RangeRow> {
    let counts: HashMap<&str, &NumstatEntry> = numstat.iter().map(|n| (n.path.as_str(), n)).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for entry in raw {
        let (status, top, old_top) = match (status_of(entry.status), entry.old_path.as_deref()) {
            (FileStatus::Renamed, Some(old)) if inside(&entry.path, prefix) => (FileStatus::Renamed, entry.path.clone(), Some(old.to_string())),
            (FileStatus::Renamed, Some(old)) if inside(old, prefix) => (FileStatus::Deleted, old.to_string(), None),
            (status, _) if inside(&entry.path, prefix) => (status, entry.path.clone(), None),
            _ => continue,
        };
        if !seen.insert(top.clone()) {
            continue;
        }
        let mut file = ChangedFile {
            path: diff::relative_to_prefix(&top, prefix),
            old_path: old_top.as_deref().map(|o| diff::relative_to_prefix(o, prefix)),
            status,
            submodule: entry.submodule,
            unreadable_name: entry.bad_name,
            ..ChangedFile::default()
        };
        if let Some(n) = counts.get(top.as_str()) {
            match (n.added, n.removed) {
                (Some(a), Some(r)) => (file.added, file.removed) = (a, r),
                _ => file.binary = true,
            }
        }
        out.push(RangeRow { file, top_path: top, old_top });
    }
    out.sort_by(|a, b| a.file.path.cmp(&b.file.path));
    out
}

/// Whether `sha` looks like a full object id (40 or 64 hex digits).
pub fn is_full_sha(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64) && sha.bytes().all(|b| b.is_ascii_hexdigit())
}

// -- running git ----------------------------------------------------------------------------

fn head_ref(name: &str) -> String {
    format!("refs/heads/{name}")
}

fn text(out: Vec<u8>) -> String {
    String::from_utf8_lossy(&out).into_owned()
}

/// Why a finished git call failed, from its own exit (never a panic).
fn failed(done: &crate::process::Completed) -> String {
    diff::describe(GitError::Failed {
        code: done.status.code(),
        stderr: done.stderr_summary(),
    })
}

/// Every local branch of the repository at `folder` whose name is UTF-8, sorted by name.
pub fn local_branches(git_bin: &Path, folder: &Path) -> Result<Vec<String>, String> {
    let out = diff::run_ok(git(git_bin, folder, &["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"]))?;
    let mut names: Vec<String> = out
        .split(|b| *b == b'\n')
        .filter_map(|line| std::str::from_utf8(line).ok())
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .collect();
    names.sort();
    Ok(names)
}

/// The branch checked out in `folder`; `Err` ([`DETACHED`]) when HEAD names none.
pub fn checked_out(git_bin: &Path, folder: &Path) -> Result<String, String> {
    let done = crate::process::run(git(git_bin, folder, &["symbolic-ref", "--quiet", "HEAD"]), DIFF_TIMEOUT).map_err(diff::describe)?;
    if !done.status.success() {
        return Err(if done.stderr_summary().is_empty() { DETACHED.to_string() } else { failed(&done) });
    }
    done.stdout.trim().strip_prefix("refs/heads/").map(str::to_string).ok_or_else(|| DETACHED.to_string())
}

/// `refs/remotes/origin/HEAD`'s target, when set.
fn origin_head(git_bin: &Path, folder: &Path) -> Option<String> {
    crate::process::run(git(git_bin, folder, &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]), DIFF_TIMEOUT)
        .ok()
        .filter(|d| d.status.success())
        .map(|d| d.stdout.trim().to_string())
}

/// The default base for `branch` among the local branches `names` (sorted): the repository's
/// default branch when it is a local branch other than `branch`, else the first other local
/// branch; `None` without another.
pub fn default_base_for(names: &[String], branch: &str, origin_head: Option<&str>) -> Option<String> {
    super::worktree::default_branch(names, origin_head)
        .filter(|d| d != branch && names.contains(d))
        .or_else(|| names.iter().find(|n| *n != branch).cloned())
}

/// The branch (`None`: the one checked out in `folder`), the default base and the base (`None` or
/// blank: the default). `Err` when the branch cannot be known; a base that cannot be used is the
/// second value (the bases are still good to offer).
pub fn resolve(git_bin: &Path, folder: &Path, branch: Option<&str>, base: Option<&str>) -> Result<(Bases, Option<String>), String> {
    let names = local_branches(git_bin, folder)?;
    let has = |n: &str| names.iter().any(|b| b == n);
    let branch = match branch {
        Some(b) if has(b) => b.to_string(),
        Some(b) => return Err(format!("{UNKNOWN_BRANCH}: {b}")),
        None => {
            let b = checked_out(git_bin, folder)?;
            if !has(&b) {
                return Err(format!("{UNKNOWN_BRANCH}: {b} (no commits yet)"));
            }
            b
        }
    };
    let default_base = default_base_for(&names, &branch, origin_head(git_bin, folder).as_deref());
    let (base, error) = match base.map(str::trim).filter(|b| !b.is_empty()) {
        None => (default_base.clone(), default_base.is_none().then(|| NO_BASE.to_string())),
        Some(b) if has(b) => (Some(b.to_string()), None),
        Some(b) => (None, Some(format!("{NOT_LOCAL_BRANCH}: {b}"))),
    };
    Ok((
        Bases {
            branch,
            base,
            default_base,
            bases: names,
        },
        error,
    ))
}

/// A local branch's commit id, read once per review read.
fn tip(git_bin: &Path, folder: &Path, name: &str) -> Result<String, String> {
    let spec = format!("{}^{{commit}}", head_ref(name));
    let out = diff::run_ok(git(git_bin, folder, &["rev-parse", "--verify", "--quiet", &spec]))?;
    let id = text(out).trim().to_string();
    if id.is_empty() { Err(format!("{UNKNOWN_BRANCH}: {name}")) } else { Ok(id) }
}

/// The two commit ids one read compares from: the base's and the branch's.
struct Pinned {
    base: String,
    tip: String,
}

fn pin(git_bin: &Path, folder: &Path, bases: &Bases) -> Result<Pinned, String> {
    let base = bases.base.as_deref().ok_or_else(|| NO_BASE.to_string())?;
    Ok(Pinned {
        base: tip(git_bin, folder, base)?,
        tip: tip(git_bin, folder, &bases.branch)?,
    })
}

impl Pinned {
    fn range(&self) -> String {
        format!("{}..{}", self.base, self.tip)
    }
}

/// `git merge-base <base> <tip>`; `Err` ([`NO_MERGE_BASE`]) for unrelated histories.
fn merge_base(git_bin: &Path, folder: &Path, pinned: &Pinned, base_name: &str) -> Result<String, String> {
    let done = crate::process::run(git(git_bin, folder, &["merge-base", &pinned.base, &pinned.tip]), DIFF_TIMEOUT).map_err(diff::describe)?;
    let id = done.stdout.trim().to_string();
    if done.status.success() && !id.is_empty() {
        return Ok(id);
    }
    if done.status.success() || (done.status.code() == Some(1) && done.stderr_summary().is_empty()) {
        return Err(format!("{NO_MERGE_BASE} with {base_name}"));
    }
    Err(failed(&done))
}

/// Commits on the branch beyond the base.
fn ahead(git_bin: &Path, folder: &Path, pinned: &Pinned) -> Result<usize, String> {
    let out = diff::run_ok(git(git_bin, folder, &["rev-list", "--count", &pinned.range(), "--"]))?;
    Ok(text(out).trim().parse().unwrap_or(0))
}

/// The folder relative to the top level (`sub/dir/` or empty).
fn prefix(git_bin: &Path, folder: &Path) -> Result<String, String> {
    let out = diff::run_ok(git(git_bin, folder, &["rev-parse", "--show-prefix"]))?;
    Ok(text(out).trim().to_string())
}

/// `git diff <args> -z -M <old> <new> -- <pathspecs>` (no pathspec: the whole repository), raw bytes.
fn diff_out(git_bin: &Path, folder: &Path, args: &[&str], old: &str, new: &str, pathspecs: &[String]) -> Result<Vec<u8>, String> {
    let mut all = vec!["diff"];
    all.extend_from_slice(args);
    all.extend_from_slice(&["-z", "-M", "--no-ext-diff", "--no-textconv", "--no-relative", "--ignore-submodules=none", "--no-color", old, new]);
    let mut cmd = git(git_bin, folder, &all);
    cmd.arg("--").args(pathspecs);
    diff::run_ok(cmd)
}

/// The counts of `old`..`new` for `pathspecs`.
fn numstat(git_bin: &Path, folder: &Path, old: &str, new: &str, pathspecs: &[String]) -> Result<Vec<NumstatEntry>, String> {
    Ok(diff::parse_numstat_z(&diff_out(git_bin, folder, &["--numstat"], old, new, pathspecs)?))
}

/// The rows of `old`..`new` inside the folder at `prefix` (all of them, uncapped and counted).
fn rows_of(git_bin: &Path, folder: &Path, prefix: &str, old: &str, new: &str) -> Result<Vec<RangeRow>, String> {
    // The whole repository, so a rename into the folder from outside it pairs up.
    let raw = parse_raw_z(&diff_out(git_bin, folder, &["--raw"], old, new, &[])?);
    let mut specs = vec![".".to_string()];
    specs.extend(
        raw.iter()
            .filter(|e| e.status == 'R' && inside(&e.path, prefix))
            .filter_map(|e| e.old_path.as_deref())
            .filter(|old| !inside(old, prefix))
            .map(diff::literal),
    );
    let counts = numstat(git_bin, folder, old, new, &specs)?;
    Ok(range_rows(&raw, &counts, prefix))
}

/// The changed files between the commits `old` and `new` inside the folder at `prefix`: at most
/// [`diff::MAX_ROWS`] (the rest counted).
fn range_list(git_bin: &Path, folder: &Path, prefix: &str, old: &str, new: &str) -> Result<(Vec<ChangedFile>, usize), String> {
    let mut rows = rows_of(git_bin, folder, prefix, old, new)?;
    let more = diff::cap_rows(&mut rows);
    Ok((rows.into_iter().map(|r| r.file).collect(), more))
}

/// The row of one `path` (as [`range_list`] names it) between `old` and `new`: only that path is
/// diffed, and for an added file the renames of the range are looked up for its source.
fn one_row(git_bin: &Path, folder: &Path, prefix: &str, old: &str, new: &str, path: &str) -> Result<RangeRow, String> {
    if path.starts_with(":/") || path.is_empty() {
        return Err(NOT_CHANGED.to_string());
    }
    let top = format!("{prefix}{path}");
    let raw = parse_raw_z(&diff_out(git_bin, folder, &["--raw"], old, new, &[diff::literal(&top)])?);
    let mut entry = raw.into_iter().find(|e| e.path == top).ok_or_else(|| NOT_CHANGED.to_string())?;
    if entry.status == 'A' {
        let renames = parse_raw_z(&diff_out(git_bin, folder, &["--raw", "--diff-filter=R"], old, new, &[])?);
        if let Some(rename) = renames.into_iter().find(|e| e.path == top) {
            entry = rename;
        }
    }
    let mut specs = vec![diff::literal(&entry.path)];
    specs.extend(entry.old_path.as_deref().map(diff::literal));
    let counts = numstat(git_bin, folder, old, new, &specs)?;
    range_rows(std::slice::from_ref(&entry), &counts, prefix)
        .into_iter()
        .find(|r| r.file.path == path)
        .ok_or_else(|| NOT_CHANGED.to_string())
}

/// The two sides of `path` between `old` and `new`. `Err` ([`NOT_CHANGED`]) for a path that is
/// not in the list.
fn range_file(git_bin: &Path, folder: &Path, prefix: &str, old: &str, new: &str, path: &str) -> Result<FileText, String> {
    let row = one_row(git_bin, folder, prefix, old, new, path)?;
    let file = row.file;
    let content = if file.unreadable_name {
        Content::UnreadableName
    } else if file.submodule {
        Content::Submodule
    } else if file.binary {
        Content::Binary
    } else {
        let old_side = match file.status {
            FileStatus::Added => Side::Absent,
            _ => diff::show(git_bin, folder, &format!("{old}:{}", row.old_top.as_deref().unwrap_or(&row.top_path)))?,
        };
        let new_side = match file.status {
            FileStatus::Deleted => Side::Absent,
            _ => diff::show(git_bin, folder, &format!("{new}:{}", row.top_path))?,
        };
        diff::content_of(old_side, new_side, false)
    };
    Ok(FileText { file, content })
}

/// The newest [`MAX_COMMITS`] commits of the pinned range with their parents.
fn listed_commits(git_bin: &Path, folder: &Path, pinned: &Pinned) -> Result<Vec<(String, Vec<String>)>, String> {
    let max = format!("--max-count={MAX_COMMITS}");
    let out = diff::run_ok(git(git_bin, folder, &["rev-list", "--parents", &max, &pinned.range(), "--"]))?;
    Ok(text(out)
        .lines()
        .filter_map(|line| {
            let mut ids = line.split_whitespace().map(str::to_string);
            ids.next().map(|sha| (sha, ids.collect()))
        })
        .collect())
}

/// One listed commit's id and what it is diffed against (its first parent, or the empty tree).
fn commit_endpoints(git_bin: &Path, folder: &Path, pinned: &Pinned, sha: &str) -> Result<(String, String), String> {
    let sha = sha.trim();
    if !is_full_sha(sha) {
        return Err(NOT_IN_RANGE.to_string());
    }
    let (id, parents) = listed_commits(git_bin, folder, pinned)?
        .into_iter()
        .find(|(id, _)| id.eq_ignore_ascii_case(sha))
        .ok_or_else(|| NOT_IN_RANGE.to_string())?;
    let parent = match parents.into_iter().next() {
        Some(p) => p,
        None => diff::empty_tree(git_bin, folder)?,
    };
    Ok((parent, id))
}

/// The two commits a read compares: vs base (the merge-base and the tip) or one commit.
fn endpoints(git_bin: &Path, folder: &Path, bases: &Bases, pinned: &Pinned, commit: Option<&str>) -> Result<(String, String), String> {
    match commit {
        None => Ok((merge_base(git_bin, folder, pinned, bases.base.as_deref().unwrap_or_default())?, pinned.tip.clone())),
        Some(sha) => commit_endpoints(git_bin, folder, pinned, sha),
    }
}

/// vs base (`commit` `None`) or one commit's files, for `branch` (`None`: the one checked out in
/// `folder`) against `base` (`None`: the default base). A failure after the branch is known comes
/// back in `error`, with the bases.
pub fn list(git_bin: &Path, folder: &Path, branch: Option<&str>, base: Option<&str>, commit: Option<&str>) -> Result<RangeList, String> {
    let (bases, deferred) = resolve(git_bin, folder, branch, base)?;
    let prefix = prefix(git_bin, folder)?;
    let mut out = RangeList {
        root: folder.display().to_string(),
        bases,
        error: None,
        subfolder: !prefix.is_empty(),
        commit: None,
        ahead: 0,
        files: Vec::new(),
        more: 0,
    };
    let read = (|| -> Result<(usize, Option<String>, Vec<ChangedFile>, usize), String> {
        if let Some(error) = deferred {
            return Err(error);
        }
        let pinned = pin(git_bin, folder, &out.bases)?;
        let ahead = if commit.is_none() { ahead(git_bin, folder, &pinned)? } else { 0 };
        let (old, new) = endpoints(git_bin, folder, &out.bases, &pinned, commit)?;
        let (files, more) = range_list(git_bin, folder, &prefix, &old, &new)?;
        Ok((ahead, commit.is_some().then_some(new), files, more))
    })();
    match read {
        Ok((ahead, commit, files, more)) => (out.ahead, out.commit, out.files, out.more) = (ahead, commit, files, more),
        Err(error) => out.error = Some(error),
    }
    Ok(out)
}

/// The text of `path` in vs base (`commit` `None`) or in one commit.
pub fn file(git_bin: &Path, folder: &Path, branch: Option<&str>, base: Option<&str>, commit: Option<&str>, path: &str) -> Result<FileText, String> {
    let (bases, deferred) = resolve(git_bin, folder, branch, base)?;
    if let Some(error) = deferred {
        return Err(error);
    }
    let pinned = pin(git_bin, folder, &bases)?;
    let (old, new) = endpoints(git_bin, folder, &bases, &pinned, commit)?;
    range_file(git_bin, folder, &prefix(git_bin, folder)?, &old, &new, path)
}

/// `git log <base>..<branch>`, newest first, at most [`MAX_COMMITS`] (the rest counted). A
/// failure after the branch is known comes back in `error`, with the bases.
pub fn commits(git_bin: &Path, folder: &Path, branch: Option<&str>, base: Option<&str>) -> Result<CommitLog, String> {
    let (bases, deferred) = resolve(git_bin, folder, branch, base)?;
    let read = (|| -> Result<(Vec<Commit>, usize), String> {
        if let Some(error) = deferred {
            return Err(error);
        }
        let pinned = pin(git_bin, folder, &bases)?;
        let total = ahead(git_bin, folder, &pinned)?;
        let max = format!("--max-count={MAX_COMMITS}");
        let out = diff::run_ok(git(git_bin, folder, &["log", "--no-color", "--no-show-signature", LOG_FORMAT, &max, &pinned.range(), "--"]))?;
        let commits = parse_log(&out);
        let more = total.saturating_sub(commits.len());
        Ok((commits, more))
    })();
    let (commits, more, error) = match read {
        Ok((commits, more)) => (commits, more, None),
        Err(error) => (Vec::new(), 0, Some(error)),
    };
    Ok(CommitLog {
        root: folder.display().to_string(),
        bases,
        error,
        commits,
        more,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{git_cmd, git_ok, real_git, temp_repo};

    fn z(records: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for r in records {
            out.extend_from_slice(r);
            out.push(0);
        }
        out
    }

    const OID: &str = "45b983be36b73c0788dc9cbcb76cbb80fc7bb057";

    fn entry(status: char, path: &str, old: Option<&str>) -> RawEntry {
        RawEntry { status, path: path.into(), old_path: old.map(str::to_string), submodule: false, bad_name: false }
    }

    #[test]
    fn raw_records_hold_status_renames_and_submodules() {
        let raw = z(&[
            format!(":100644 100644 {OID} {OID} M").as_bytes(),
            b"src/a.rs",
            format!(":100644 100644 {OID} {OID} R087").as_bytes(),
            b"old name.ts",
            b"new name.ts",
            format!(":000000 100644 {OID} {OID} A").as_bytes(),
            b"caf\xe9.txt",
            format!(":160000 160000 {OID} {OID} M").as_bytes(),
            b"sub",
            b"garbage",
            format!(":100644 000000 {OID} {OID} D").as_bytes(),
            b"gone.txt",
        ]);
        let got = parse_raw_z(&raw);
        let rows: Vec<_> = got.iter().map(|e| (e.status, e.path.as_str(), e.old_path.as_deref(), e.submodule, e.bad_name)).collect();
        assert_eq!(
            rows,
            [
                ('M', "src/a.rs", None, false, false),
                ('R', "new name.ts", Some("old name.ts"), false, false),
                ('A', "caf\u{FFFD}.txt", None, false, true),
                ('M', "sub", None, true, false),
                ('D', "gone.txt", None, false, false),
            ]
        );
        assert!(parse_raw_z(b"").is_empty());
        assert_eq!(status_of('C'), FileStatus::Added);
        assert_eq!(status_of('T'), FileStatus::Modified);
    }

    #[test]
    fn range_rows_keep_the_folder_count_from_numstat_and_dedup_on_the_top_path() {
        let raw = vec![
            entry('R', "web/b.ts", Some("web/a.ts")),
            entry('M', "web/img.png", None),
            entry('A', "web/n.md", None),
            entry('R', "web/in.ts", Some("lib/in.ts")),
            entry('R', "lib/out.ts", Some("web/out.ts")),
            entry('M', "lib/x.ts", None),
            entry('M', "web/n.md", None),
        ];
        let numstat = vec![
            NumstatEntry { path: "web/b.ts".into(), old_path: Some("web/a.ts".into()), added: Some(1), removed: Some(2) },
            NumstatEntry { path: "web/img.png".into(), old_path: None, added: None, removed: None },
            NumstatEntry { path: "web/n.md".into(), old_path: None, added: Some(3), removed: Some(0) },
            NumstatEntry { path: "web/out.ts".into(), old_path: None, added: Some(0), removed: Some(4) },
        ];
        let rows = range_rows(&raw, &numstat, "web/");
        let got: Vec<_> = rows.iter().map(|r| (r.file.path.as_str(), r.file.old_path.as_deref(), r.file.status, r.file.added, r.file.removed, r.file.binary)).collect();
        assert_eq!(
            got,
            [
                ("b.ts", Some("a.ts"), FileStatus::Renamed, 1, 2, false),
                ("img.png", None, FileStatus::Modified, 0, 0, true),
                ("in.ts", Some(":/lib/in.ts"), FileStatus::Renamed, 0, 0, false),
                ("n.md", None, FileStatus::Added, 3, 0, false),
                ("out.ts", None, FileStatus::Deleted, 0, 4, false),
            ]
        );
        assert_eq!(rows[0].old_top.as_deref(), Some("web/a.ts"));
        // Two lossy names that read the same are still two rows (dedup is on the top path).
        let lossy = vec![entry('A', "web/caf\u{FFFD}.txt", None), entry('A', "web/caf\u{FFFD}.txt", None), entry('A', "web/b\u{FFFD}", None)];
        assert_eq!(range_rows(&lossy, &[], "web/").len(), 2);
    }

    #[test]
    fn log_records_are_nul_separated_fields_with_parents() {
        let raw = format!("{OID}\0abc1234\0\0Ann\x001700000000\0first\0\n{OID}\0def5678\0{OID} {OID}\0Bob\x001700000100\0Merge x\0\n");
        let got = parse_log(raw.as_bytes());
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].short.as_str(), got[0].author.as_str(), got[0].at, got[0].subject.as_str()), ("abc1234", "Ann", 1_700_000_000, "first"));
        assert!(got[0].parents.is_empty(), "a root commit");
        assert_eq!(got[1].parents.len(), 2);
        assert_eq!(got[1].sha, OID);
        assert!(parse_log(b"").is_empty());
        assert!(parse_log(b"x\0y\0").is_empty(), "an incomplete record");
        assert!(is_full_sha(OID));
        assert!(!is_full_sha("abc1234"));
        assert!(!is_full_sha(&"g".repeat(40)));
    }

    #[test]
    fn the_default_base_is_another_local_branch() {
        let names = |n: &[&str]| n.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let all = names(&["develop", "feat", "main"]);
        assert_eq!(default_base_for(&all, "feat", None).as_deref(), Some("main"));
        assert_eq!(default_base_for(&all, "main", None).as_deref(), Some("develop"), "never the branch itself");
        assert_eq!(default_base_for(&all, "feat", Some("refs/remotes/origin/develop")).as_deref(), Some("develop"));
        assert_eq!(default_base_for(&all, "feat", Some("refs/remotes/origin/trunk")).as_deref(), Some("main"), "origin/HEAD not local");
        assert_eq!(default_base_for(&names(&["a", "b", "main"]), "main", Some("refs/remotes/origin/main")).as_deref(), Some("a"));
        assert_eq!(default_base_for(&names(&["main"]), "main", None), None);
    }

    #[test]
    fn the_wire_shape_is_flat() {
        let bases = Bases { branch: "feat".into(), base: Some("main".into()), default_base: Some("main".into()), bases: vec!["feat".into(), "main".into()] };
        let list = RangeList { root: "/r".into(), bases, error: None, subfolder: false, commit: None, ahead: 2, files: vec![], more: 0 };
        assert_eq!(
            serde_json::to_value(list).unwrap(),
            serde_json::json!({ "root": "/r", "branch": "feat", "base": "main", "defaultBase": "main", "bases": ["feat", "main"],
                "error": null, "subfolder": false, "commit": null, "ahead": 2, "files": [], "more": 0 })
        );
    }

    // -- the real binary, in temp repos (skipped when git is not on PATH) -------------------

    fn text_of(content: &Content) -> (Option<&str>, Option<&str>) {
        match content {
            Content::Text { old, new, .. } => (old.as_deref(), new.as_deref()),
            other => panic!("not text: {other:?}"),
        }
    }

    fn paths(files: &[ChangedFile]) -> Vec<&str> {
        files.iter().map(|f| f.path.as_str()).collect()
    }

    fn commit(git: &Path, repo: &Path, file: &str, body: &str, message: &str) {
        if let Some(parent) = repo.join(file).parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(repo.join(file), body).unwrap();
        git_ok(git, repo, &["add", "-A"]);
        git_ok(git, repo, &["commit", "-q", "-m", message]);
    }

    fn ok_list(git: &Path, repo: &Path, branch: Option<&str>, base: Option<&str>, commit: Option<&str>) -> RangeList {
        let list = super::list(git, repo, branch, base, commit).unwrap();
        assert_eq!(list.error, None, "{list:?}");
        list
    }

    fn list_error(git: &Path, repo: &Path, branch: Option<&str>, base: Option<&str>, commit: Option<&str>) -> String {
        super::list(git, repo, branch, base, commit).unwrap().error.expect("an error in the reply")
    }

    const TS_OLD: &str = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\nexport const f = 6;\n";
    const TS_NEW: &str = "export const a = 1;\nexport const b = 20;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\nexport const f = 6;\n";

    #[test]
    fn vs_base_lists_only_what_the_branch_changed_since_it_forked() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let repo = dunce::canonicalize(dir.path()).unwrap();
        commit(&git, &repo, "old.ts", TS_OLD, "ts");
        git_ok(&git, &repo, &["branch", "develop"]);
        git_ok(&git, &repo, &["checkout", "-q", "-b", "feat"]);
        commit(&git, &repo, "f.txt", "one\n", "feat 1");
        git_ok(&git, &repo, &["mv", "old.ts", "new.ts"]);
        std::fs::write(repo.join("new.ts"), TS_NEW).unwrap();
        commit(&git, &repo, "f.txt", "one\ntwo\n", "feat 2");
        // main moves on.
        git_ok(&git, &repo, &["checkout", "-q", "main"]);
        commit(&git, &repo, "m.txt", "main only\n", "main moves");
        commit(&git, &repo, "a.txt", "changed on main\n", "main again");

        let list = ok_list(&git, &repo, Some("feat"), None, None);
        assert_eq!((list.bases.branch.as_str(), list.bases.base.as_deref(), list.bases.default_base.as_deref()), ("feat", Some("main"), Some("main")));
        assert_eq!(list.bases.bases, ["develop", "feat", "main"]);
        assert_eq!((list.ahead, list.subfolder), (2, false));
        assert_eq!(paths(&list.files), ["f.txt", "new.ts"], "the merge-base against feat: nothing of main's");
        let renamed = &list.files[1];
        assert_eq!((renamed.status, renamed.old_path.as_deref(), renamed.added, renamed.removed), (FileStatus::Renamed, Some("old.ts"), 1, 1));
        let f = super::file(&git, &repo, Some("feat"), None, None, "f.txt").unwrap();
        assert_eq!(text_of(&f.content), (None, Some("one\ntwo\n")));
        let r = super::file(&git, &repo, Some("feat"), None, None, "new.ts").unwrap();
        assert_eq!(text_of(&r.content), (Some(TS_OLD), Some(TS_NEW)), "the old side is old.ts at the merge-base");
        assert_eq!((r.file.status, r.file.old_path.as_deref(), r.file.added), (FileStatus::Renamed, Some("old.ts"), 1));
        assert_eq!(super::file(&git, &repo, Some("feat"), None, None, "m.txt"), Err(NOT_CHANGED.to_string()));

        // Another base: develop forked at the same point; still the same files.
        let develop = ok_list(&git, &repo, Some("feat"), Some("develop"), None);
        assert_eq!(develop.bases.base.as_deref(), Some("develop"));
        assert_eq!(paths(&develop.files), ["f.txt", "new.ts"]);
        // Not a local branch: an error in the reply, the bases still offered.
        let bad = super::list(&git, &repo, Some("feat"), Some("origin/main"), None).unwrap();
        assert_eq!(bad.error, Some(format!("{NOT_LOCAL_BRANCH}: origin/main")));
        assert_eq!((bad.bases.base, bad.bases.bases.len()), (None, 3));
        assert_eq!(list_error(&git, &repo, Some("feat"), Some("--all"), None), format!("{NOT_LOCAL_BRANCH}: --all"));
        assert_eq!(super::list(&git, &repo, Some("nope"), None, None).unwrap_err(), format!("{UNKNOWN_BRANCH}: nope"));
        assert_eq!(commits(&git, &repo, Some("feat"), Some("origin/main")).unwrap().error, Some(format!("{NOT_LOCAL_BRANCH}: origin/main")));

        // The project on main: the default base is another branch, never main itself.
        let project = ok_list(&git, &repo, None, None, None);
        assert_eq!((project.bases.branch.as_str(), project.bases.base.as_deref()), ("main", Some("develop")));
        assert_eq!(project.ahead, 2);
        // main against main, asked for: nothing beyond.
        let same = ok_list(&git, &repo, None, Some("main"), None);
        assert_eq!((same.ahead, same.files.len()), (0, 0));
        let log = commits(&git, &repo, None, Some("main")).unwrap();
        assert!(log.commits.is_empty() && log.error.is_none());
        // origin/HEAD names the default.
        git_ok(&git, &repo, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
        assert_eq!(ok_list(&git, &repo, Some("feat"), None, None).bases.default_base.as_deref(), Some("develop"));
        git_ok(&git, &repo, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
        assert_eq!(ok_list(&git, &repo, Some("feat"), None, None).bases.default_base.as_deref(), Some("main"), "origin/HEAD is not local");
    }

    #[test]
    fn a_lone_branch_has_no_base_to_pick() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let list = super::list(&git, dir.path(), None, None, None).unwrap();
        assert_eq!((list.error.as_deref(), list.bases.base.as_deref(), list.bases.default_base.as_deref()), (Some(NO_BASE), None, None));
        assert!(list.files.is_empty());
        assert_eq!(commits(&git, dir.path(), None, None).unwrap().error.as_deref(), Some(NO_BASE));
        assert_eq!(super::file(&git, dir.path(), None, None, None, "a.txt").unwrap_err(), NO_BASE);
    }

    #[test]
    fn a_subfolder_project_sees_only_its_files_relative_to_it() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let repo = dunce::canonicalize(dir.path()).unwrap();
        commit(&git, &repo, "web/w.ts", "w1\n", "web");
        commit(&git, &repo, "lib/moved.ts", TS_OLD, "lib");
        git_ok(&git, &repo, &["checkout", "-q", "-b", "feat"]);
        commit(&git, &repo, "web/w.ts", "w1\nw2\n", "touch web");
        commit(&git, &repo, "lib/l.ts", "outside\n", "touch lib only");
        git_ok(&git, &repo, &["mv", "lib/moved.ts", "web/moved.ts"]);
        std::fs::write(repo.join("web/moved.ts"), TS_NEW).unwrap();
        git_ok(&git, &repo, &["commit", "-q", "-am", "move into web"]);
        let web = repo.join("web");

        let list = ok_list(&git, &web, Some("feat"), Some("main"), None);
        assert!(list.subfolder);
        assert_eq!(paths(&list.files), ["moved.ts", "w.ts"], "nothing outside web/");
        let moved = &list.files[0];
        assert_eq!((moved.status, moved.old_path.as_deref(), moved.added, moved.removed), (FileStatus::Renamed, Some(":/lib/moved.ts"), 1, 1));
        let w = super::file(&git, &web, Some("feat"), Some("main"), None, "w.ts").unwrap();
        assert_eq!(text_of(&w.content), (Some("w1\n"), Some("w1\nw2\n")), "both sides read");
        let m = super::file(&git, &web, Some("feat"), Some("main"), None, "moved.ts").unwrap();
        assert_eq!(text_of(&m.content), (Some(TS_OLD), Some(TS_NEW)), "the old side from outside the folder");
        assert_eq!((m.file.status, m.file.old_path.as_deref()), (FileStatus::Renamed, Some(":/lib/moved.ts")));
        assert_eq!(super::file(&git, &web, Some("feat"), Some("main"), None, ":/lib/l.ts"), Err(NOT_CHANGED.to_string()));
        assert_eq!(super::file(&git, &web, Some("feat"), Some("main"), None, "../lib/l.ts"), Err(NOT_CHANGED.to_string()));

        let log = commits(&git, &web, Some("feat"), Some("main")).unwrap();
        assert_eq!(log.commits.len(), 3, "every commit of the branch is listed");
        let only_lib = log.commits.iter().find(|c| c.subject == "touch lib only").unwrap();
        let none = ok_list(&git, &web, Some("feat"), Some("main"), Some(&only_lib.sha));
        assert!(none.files.is_empty() && none.subfolder, "a commit touching nothing in the folder");
        let touch = log.commits.iter().find(|c| c.subject == "touch web").unwrap();
        let files = ok_list(&git, &web, Some("feat"), Some("main"), Some(&touch.sha));
        assert_eq!(paths(&files.files), ["w.ts"]);
        let w = super::file(&git, &web, Some("feat"), Some("main"), Some(&touch.sha), "w.ts").unwrap();
        assert_eq!(text_of(&w.content), (Some("w1\n"), Some("w1\nw2\n")));
    }

    #[test]
    fn commits_are_newest_first_and_each_is_diffed_against_its_first_parent() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let repo = dunce::canonicalize(dir.path()).unwrap();
        git_ok(&git, &repo, &["checkout", "-q", "-b", "feat"]);
        commit(&git, &repo, "one.txt", "1\n", "c1");
        commit(&git, &repo, "two.txt", "2\n", "c2");
        // A side branch merged into feat.
        git_ok(&git, &repo, &["checkout", "-q", "-b", "side"]);
        commit(&git, &repo, "side.txt", "s\n", "side work");
        git_ok(&git, &repo, &["checkout", "-q", "feat"]);
        commit(&git, &repo, "three.txt", "3\n", "c3");
        git_ok(&git, &repo, &["merge", "-q", "--no-ff", "-m", "merge side", "side"]);

        let log = commits(&git, &repo, Some("feat"), None).unwrap();
        let subjects: Vec<_> = log.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects.first(), Some(&"merge side"));
        assert_eq!(subjects.len(), 5);
        assert!(subjects.contains(&"side work"));
        assert_eq!(log.more, 0);
        let c1 = log.commits.iter().find(|c| c.subject == "c1").unwrap();
        assert_eq!(c1.author, "Switchboard Test");
        assert!(c1.at > 0 && c1.short.len() >= 7 && c1.sha.starts_with(&c1.short));

        let files = ok_list(&git, &repo, Some("feat"), None, Some(&c1.sha));
        assert_eq!(paths(&files.files), ["one.txt"]);
        assert_eq!((files.commit.as_deref(), files.ahead), (Some(c1.sha.as_str()), 0));
        let one = super::file(&git, &repo, Some("feat"), None, Some(&c1.sha), "one.txt").unwrap();
        assert_eq!(text_of(&one.content), (None, Some("1\n")));

        // The merge against its first parent (feat at c3): only what side brought.
        let merge = &log.commits[0];
        assert_eq!(merge.parents.len(), 2);
        let merged = ok_list(&git, &repo, Some("feat"), None, Some(&merge.sha));
        assert_eq!(paths(&merged.files), ["side.txt"]);

        // A hash not in the range: main's commit, a short hash, garbage.
        let main_sha = git_ok(&git, &repo, &["rev-parse", "main"]).trim().to_string();
        assert_eq!(list_error(&git, &repo, Some("feat"), None, Some(&main_sha)), NOT_IN_RANGE);
        assert_eq!(list_error(&git, &repo, Some("feat"), None, Some(&c1.short)), NOT_IN_RANGE);
        assert_eq!(super::file(&git, &repo, Some("feat"), None, Some("--all"), "one.txt").unwrap_err(), NOT_IN_RANGE);
    }

    #[test]
    fn a_merge_whose_first_parent_is_the_base_is_diffed_against_it() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let repo = dunce::canonicalize(dir.path()).unwrap();
        // feat starts at main; its first commit is a merge whose first parent (main's tip) is
        // outside the range main..feat.
        git_ok(&git, &repo, &["checkout", "-q", "-b", "side"]);
        commit(&git, &repo, "s.txt", "s\n", "side work");
        git_ok(&git, &repo, &["checkout", "-q", "main"]);
        git_ok(&git, &repo, &["checkout", "-q", "-b", "feat"]);
        git_ok(&git, &repo, &["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
        let log = commits(&git, &repo, Some("feat"), Some("main")).unwrap();
        assert_eq!(log.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["merge side", "side work"]);
        let main_sha = git_ok(&git, &repo, &["rev-parse", "main"]).trim().to_string();
        assert_eq!(log.commits[0].parents[0], main_sha);
        let merged = ok_list(&git, &repo, Some("feat"), Some("main"), Some(&log.commits[0].sha));
        assert_eq!(paths(&merged.files), ["s.txt"]);
        let s = super::file(&git, &repo, Some("feat"), Some("main"), Some(&log.commits[0].sha), "s.txt").unwrap();
        assert_eq!(text_of(&s.content), (None, Some("s\n")));
    }

    #[test]
    fn a_root_commit_is_diffed_against_the_empty_tree() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let repo = dunce::canonicalize(dir.path()).unwrap();
        // An orphan branch: its first commit is a root; the base shares no history with it.
        git_ok(&git, &repo, &["checkout", "-q", "--orphan", "fresh"]);
        git_ok(&git, &repo, &["rm", "-q", "-rf", "--cached", "."]);
        std::fs::remove_file(repo.join("a.txt")).unwrap();
        commit(&git, &repo, "root.txt", "r\n", "root");
        let log = commits(&git, &repo, Some("fresh"), Some("main")).unwrap();
        assert_eq!(log.commits.len(), 1);
        assert!(log.commits[0].parents.is_empty());
        let sha = log.commits[0].sha.clone();
        let files = ok_list(&git, &repo, Some("fresh"), Some("main"), Some(&sha));
        assert_eq!(paths(&files.files), ["root.txt"]);
        assert_eq!(files.files[0].status, FileStatus::Added);
        let root = super::file(&git, &repo, Some("fresh"), Some("main"), Some(&sha), "root.txt").unwrap();
        assert_eq!(text_of(&root.content), (None, Some("r\n")));
        // vs base has no merge-base: an error in the reply, the bases still offered.
        let unrelated = super::list(&git, &repo, Some("fresh"), Some("main"), None).unwrap();
        assert_eq!(unrelated.error, Some(format!("{NO_MERGE_BASE} with main")));
        assert_eq!(unrelated.bases.bases, ["fresh", "main"]);
    }

    #[test]
    fn more_than_two_hundred_commits_are_capped_with_the_rest_counted() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let repo = dunce::canonicalize(dir.path()).unwrap();
        git_ok(&git, &repo, &["checkout", "-q", "-b", "long"]);
        // 250 empty commits through one fast-import stream (cheap).
        let mut stream = String::new();
        for i in 0..250 {
            stream.push_str(&format!(
                "commit refs/heads/long\ncommitter T <t@example.invalid> {} +0000\ndata {}\nc{i:03}\n{}",
                1_700_000_000 + i,
                format!("c{i:03}\n").len(),
                if i == 0 { "from refs/heads/main\n" } else { "" }
            ));
            stream.push('\n');
        }
        let mut child = git_cmd(&git, &repo, &["fast-import", "--quiet", "--force"]).stdin(std::process::Stdio::piped()).spawn().unwrap();
        {
            use std::io::Write;
            child.stdin.take().unwrap().write_all(stream.as_bytes()).unwrap();
        }
        assert!(child.wait().unwrap().success());
        let log = commits(&git, &repo, Some("long"), Some("main")).unwrap();
        assert_eq!(log.commits.len(), MAX_COMMITS);
        assert_eq!(log.more, 50);
        assert_eq!(log.commits[0].subject, "c249", "newest first");
        // The oldest commit is beyond the list: refused.
        let oldest = git_ok(&git, &repo, &["rev-list", "--reverse", "main..long"]).lines().next().unwrap().to_string();
        assert_eq!(list_error(&git, &repo, Some("long"), Some("main"), Some(&oldest)), NOT_IN_RANGE);
    }

    #[test]
    fn a_detached_head_has_no_branch_to_compare() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        git_ok(&git, dir.path(), &["checkout", "-q", "--detach"]);
        assert_eq!(super::list(&git, dir.path(), None, None, None).unwrap_err(), DETACHED);
    }
}
