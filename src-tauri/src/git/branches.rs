//! A repository's local branches and linked worktrees (Story 5.1), read through two
//! read-only git calls run from the project folder:
//!
//! ```text
//! git for-each-ref --format=%(refname:lstrip=2)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix) refs/heads
//! git worktree list --porcelain
//! ```
//!
//! [`parse_for_each_ref`] and [`parse_worktrees`] are pure; [`branches_of`] runs both and joins
//! them: a linked worktree is matched to its branch by its `branch refs/heads/<name>` line.
//! [`common_dir`] names the repository's shared git dir (what the branch watcher watches). No
//! ref, worktree or index is ever touched, and nothing is fetched: ahead/behind is against
//! the last-known upstream refs.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::GitError;

/// How long one branch or worktree listing may take before it is killed.
pub const BRANCHES_TIMEOUT: Duration = Duration::from_secs(5);

/// The `--format` of the branch listing: five fields split by NUL. `lstrip=2` (not `short`)
/// so a branch that shares its name with a tag keeps its own name (`short` would print
/// `heads/<name>` to disambiguate).
pub const FOR_EACH_REF_FORMAT: &str =
    "--format=%(refname:lstrip=2)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)";

/// A linked worktree that has a branch checked out: where it is, and whether its folder is
/// gone (git reports it `prunable`, or the folder no longer exists).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeChip {
    /// Canonical when the folder exists; as git printed it otherwise.
    pub path: String,
    pub missing: bool,
}

/// One local branch as the branch card shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchInfo {
    pub name: String,
    /// Checked out in the project's own checkout (`%(HEAD)` is `*`); false for every branch
    /// while HEAD is detached.
    pub head: bool,
    /// The configured upstream (`origin/main`); `None` for a local-only branch.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The upstream is configured but its ref is missing (`[gone]`).
    pub gone: bool,
    /// Last commit time, seconds since the epoch (0 when unknown).
    pub committed_at: i64,
    /// The linked worktree holding this branch, if any.
    pub worktree: Option<WorktreeChip>,
}

/// One record of `git worktree list --porcelain`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorktreeEntry {
    pub path: String,
    /// The short branch name (`refs/heads/` stripped); `None` when detached or bare.
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub prunable: bool,
    /// `git worktree lock`ed (Story 5.4: the remove sheet refuses it).
    pub locked: bool,
    /// The reason given to `git worktree lock --reason`, when one was.
    pub lock_reason: Option<String>,
}

/// Parse the branch listing (fields split by NUL, one branch per line). Tolerant: a line with
/// fewer fields is skipped, unknown track words are ignored. Not sorted (see [`sort_branches`]).
pub fn parse_for_each_ref(text: &str) -> Vec<BranchInfo> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let fields: Vec<&str> = line.split('\0').collect();
        if fields.len() < 5 || fields[0].is_empty() {
            continue;
        }
        let (ahead, behind, gone) = parse_track(fields[3]);
        let upstream = Some(fields[2].trim()).filter(|u| !u.is_empty()).map(str::to_string);
        out.push(BranchInfo {
            name: fields[0].to_string(),
            head: fields[1].trim() == "*",
            gone: gone && upstream.is_some(),
            upstream,
            ahead,
            behind,
            committed_at: fields[4].trim().parse().unwrap_or(0),
            worktree: None,
        });
    }
    out
}

/// `%(upstream:track,nobracket)`: `ahead 2, behind 1`, `ahead 2`, `behind 1`, `gone`, or
/// empty (in sync, or no upstream).
fn parse_track(track: &str) -> (u32, u32, bool) {
    let mut ahead = 0;
    let mut behind = 0;
    let mut gone = false;
    for part in track.split(',').map(str::trim) {
        let mut words = part.split_whitespace();
        match (words.next(), words.next()) {
            (Some("ahead"), Some(n)) => ahead = n.parse().unwrap_or(0),
            (Some("behind"), Some(n)) => behind = n.parse().unwrap_or(0),
            (Some("gone"), None) => gone = true,
            _ => {}
        }
    }
    (ahead, behind, gone)
}

/// Parse `git worktree list --porcelain`: records separated by blank lines, the first being
/// the main worktree. Unknown lines (`HEAD <oid>`, …) are skipped.
pub fn parse_worktrees(porcelain: &str) -> Vec<WorktreeEntry> {
    let mut out = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for line in porcelain.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            out.extend(current.take());
            continue;
        }
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        if key == "worktree" {
            out.extend(current.take());
            current = Some(WorktreeEntry {
                path: value.to_string(),
                ..WorktreeEntry::default()
            });
            continue;
        }
        let Some(entry) = current.as_mut() else { continue };
        match key {
            "branch" => entry.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_string()),
            "bare" => entry.bare = true,
            "detached" => entry.detached = true,
            "prunable" => entry.prunable = true,
            "locked" => {
                entry.locked = true;
                entry.lock_reason = Some(value.trim()).filter(|r| !r.is_empty()).map(str::to_string);
            }
            _ => {}
        }
    }
    out.extend(current);
    out
}

/// The card order: the checked-out branch first, then the newest last commit, then the name.
pub fn sort_branches(branches: &mut [BranchInfo]) {
    branches.sort_by(|a, b| {
        b.head
            .cmp(&a.head)
            .then_with(|| b.committed_at.cmp(&a.committed_at))
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// Put each other checkout's chip on its branch. `own` is the top level of the project's own
/// checkout (`git rev-parse --show-toplevel`, so a project in a subfolder is matched too): it
/// gives no chip, and neither do bare records. Every other worktree with a branch does --
/// linked worktrees, and the main checkout when the project is itself a linked worktree.
pub fn attach_worktrees(branches: &mut [BranchInfo], worktrees: &[WorktreeEntry], own: &Path) {
    let own = canonical_or_raw(&own.display().to_string());
    for entry in worktrees.iter().filter(|w| !w.bare) {
        let Some(name) = entry.branch.as_deref() else { continue };
        let path = canonical_or_raw(&entry.path);
        if crate::graph::same_path(&path, &own) {
            continue;
        }
        let missing = entry.prunable || !Path::new(&path).is_dir();
        if let Some(branch) = branches.iter_mut().find(|b| b.name == name) {
            branch.worktree = Some(WorktreeChip { path, missing });
        }
    }
}

/// `raw` canonicalised (`dunce`, no `\\?\`) when it exists, else as given.
pub(crate) fn canonical_or_raw(raw: &str) -> String {
    dunce::canonicalize(raw)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| raw.to_string())
}

/// A git command in `dir`, prompt-less, lock-free and in English.
pub(crate) fn git(git_bin: &Path, dir: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(git_bin);
    cmd.args(args)
        .current_dir(dir)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    cmd
}

/// True when git's stderr says the folder is not inside a repository.
pub(crate) fn says_not_a_repo(stderr: &str) -> bool {
    stderr.to_ascii_lowercase().contains("not a git repository")
}

/// Every local branch of the repository at `path`, sorted ([`sort_branches`]) and with its
/// worktree chip. `Ok(None)` when the folder is not a git repository; `Err` when a git call
/// fails (missing binary, timeout, any other non-zero exit).
pub fn branches_of(git_bin: &Path, path: &Path) -> Result<Option<Vec<BranchInfo>>, GitError> {
    branches_with_timeout(git_bin, path, BRANCHES_TIMEOUT)
}

pub fn branches_with_timeout(git_bin: &Path, path: &Path, timeout: Duration) -> Result<Option<Vec<BranchInfo>>, GitError> {
    let refs = crate::process::run(git(git_bin, path, &["for-each-ref", FOR_EACH_REF_FORMAT, "refs/heads"]), timeout)?;
    if !refs.status.success() {
        if refs.status.code() == Some(128) && says_not_a_repo(&refs.stderr) {
            return Ok(None);
        }
        return Err(refs.success().unwrap_err());
    }
    let top = crate::process::run(git(git_bin, path, &["rev-parse", "--show-toplevel"]), timeout)?.success()?;
    let own = Some(top.stdout.trim()).filter(|t| !t.is_empty()).map(PathBuf::from).unwrap_or_else(|| path.to_path_buf());
    let worktrees = crate::process::run(git(git_bin, path, &["worktree", "list", "--porcelain"]), timeout)?.success()?;
    let mut branches = parse_for_each_ref(&refs.stdout);
    attach_worktrees(&mut branches, &parse_worktrees(&worktrees.stdout), &own);
    sort_branches(&mut branches);
    Ok(Some(branches))
}

/// The worktrees of `entries` whose folder exists and lies strictly inside `top` (the
/// repository's top level, canonical), as paths relative to it with `/` separators: what the
/// dirty count leaves out (Story 5.2). Bare records and the checkout at `top` itself are skipped.
pub fn inside_of(entries: &[WorktreeEntry], top: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for entry in entries.iter().filter(|w| !w.bare) {
        let Ok(path) = dunce::canonicalize(&entry.path) else { continue };
        if !path.is_dir() || crate::graph::same_path(&path.display().to_string(), &top.display().to_string()) {
            continue;
        }
        let Ok(rel) = path.strip_prefix(top) else { continue };
        let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
        if !parts.is_empty() {
            out.push(parts.join("/"));
        }
    }
    out
}

/// [`inside_of`] the top level (`git rev-parse --show-toplevel`) of the checkout holding
/// `project`, from `git worktree list --porcelain`: relative to that top level, so a project in
/// a subfolder of its repository leaves out `<top>/.worktrees/…` too.
pub fn worktrees_inside(git_bin: &Path, project: &Path) -> Result<Vec<String>, GitError> {
    let (top, entries) = worktree_listing(git_bin, project)?;
    Ok(inside_of(&entries, &top))
}

/// The top level of the checkout holding `project` (canonical) and every record of
/// `git worktree list --porcelain`: the two read-only calls the status poll makes for the dirty
/// count's excludes, whose list also gives the project's known worktrees (Story 5.4).
pub fn worktree_listing(git_bin: &Path, project: &Path) -> Result<(PathBuf, Vec<WorktreeEntry>), GitError> {
    let top = crate::process::run(git(git_bin, project, &["rev-parse", "--show-toplevel"]), BRANCHES_TIMEOUT)?.success()?;
    let top = Some(top.stdout.trim()).filter(|t| !t.is_empty()).map(PathBuf::from).unwrap_or_else(|| project.to_path_buf());
    let top = dunce::canonicalize(&top).unwrap_or(top);
    let done = crate::process::run(git(git_bin, project, &["worktree", "list", "--porcelain"]), BRANCHES_TIMEOUT)?.success()?;
    Ok((top, parse_worktrees(&done.stdout)))
}

/// The project's known worktrees from git (Story 5.4): every linked worktree of `entries` (the
/// first record, the main checkout, never counts: a project that is itself a linked worktree
/// must not claim the main repository) that is not bare, not the checkout at `top` (the
/// project's own) and not missing (`prunable`, or its folder gone), with its canonical path and
/// branch (`None` when detached). Sessions whose `cwd` is one of them belong to the project, and
/// to that branch.
pub fn known_of(entries: &[WorktreeEntry], top: &Path) -> Vec<crate::graph::KnownWorktree> {
    let own = top.display().to_string();
    entries
        .iter()
        .skip(1)
        .filter(|w| !w.bare && !w.prunable)
        .filter_map(|w| {
            let path = dunce::canonicalize(&w.path).ok().filter(|p| p.is_dir())?.display().to_string();
            (!crate::graph::same_path(&path, &own)).then(|| crate::graph::KnownWorktree {
                path,
                branch: w.branch.clone(),
            })
        })
        .collect()
}

/// The repository's common git dir (`git rev-parse --git-common-dir`, resolved against `path`
/// and canonicalised): the shared `.git` with `refs`, `packed-refs` and `worktrees`, for a
/// main checkout and a linked worktree alike.
pub fn common_dir(git_bin: &Path, path: &Path) -> Result<PathBuf, GitError> {
    let done = crate::process::run(git(git_bin, path, &["rev-parse", "--git-common-dir"]), BRANCHES_TIMEOUT)?.success()?;
    let raw = done.stdout.trim();
    if raw.is_empty() {
        return Err(GitError::Failed {
            code: None,
            stderr: "git rev-parse printed no common dir".into(),
        });
    }
    let joined = path.join(raw);
    Ok(dunce::canonicalize(&joined).unwrap_or(joined))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn line(fields: [&str; 5]) -> String {
        fields.join("\0")
    }

    #[test]
    fn parse_for_each_ref_reads_head_upstream_track_and_date() {
        let text = [
            line(["master", "*", "origin/master", "ahead 2, behind 1", "1700000300"]),
            line(["feat", " ", "", "", "1700000200"]),
            line(["old", " ", "origin/old", "gone", "1700000100"]),
            line(["ahead-only", " ", "origin/a", "ahead 3", "1700000000"]),
            line(["behind-only", " ", "origin/b", "behind 4", "x"]),
            line(["synced", " ", "origin/s", "", "1"]),
            "broken\0line".to_string(),
            String::new(),
        ]
        .join("\n");
        let parsed = parse_for_each_ref(&text);
        type Row<'a> = (&'a str, bool, Option<&'a str>, u32, u32, bool, i64);
        let rows: Vec<Row<'_>> = parsed
            .iter()
            .map(|b| (b.name.as_str(), b.head, b.upstream.as_deref(), b.ahead, b.behind, b.gone, b.committed_at))
            .collect();
        assert_eq!(
            rows,
            [
                ("master", true, Some("origin/master"), 2, 1, false, 1_700_000_300),
                ("feat", false, None, 0, 0, false, 1_700_000_200),
                ("old", false, Some("origin/old"), 0, 0, true, 1_700_000_100),
                ("ahead-only", false, Some("origin/a"), 3, 0, false, 1_700_000_000),
                ("behind-only", false, Some("origin/b"), 0, 4, false, 0),
                ("synced", false, Some("origin/s"), 0, 0, false, 1),
            ]
        );
        assert!(parsed.iter().all(|b| b.worktree.is_none()));
    }

    #[test]
    fn parse_for_each_ref_tolerates_crlf_and_names_with_slashes() {
        let text = format!("{}\r\n", line(["feature/x", "*", "", "", "5"]));
        let parsed = parse_for_each_ref(&text);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "feature/x");
        assert_eq!(parsed[0].committed_at, 5);
        assert!(parsed[0].head);
    }

    const WORKTREES: &str = "worktree C:/repo\n\
                             HEAD 5ff9de9583839fc19457e65f728f20de79623ee3\n\
                             branch refs/heads/master\n\
                             \n\
                             worktree C:/wt\n\
                             HEAD 33b337f53873cdc58855411922edef910f6a61ab\n\
                             branch refs/heads/feat\n\
                             locked\n\
                             \n\
                             worktree C:/gone\n\
                             HEAD 33b337f53873cdc58855411922edef910f6a61ab\n\
                             branch refs/heads/feature/x\n\
                             prunable gitdir file points to non-existent location\n\
                             \n\
                             worktree C:/detached\n\
                             HEAD 33b337f53873cdc58855411922edef910f6a61ab\n\
                             detached\n\
                             \n";

    #[test]
    fn parse_worktrees_reads_each_record() {
        let parsed = parse_worktrees(WORKTREES);
        assert_eq!(
            parsed,
            [
                WorktreeEntry {
                    path: "C:/repo".into(),
                    branch: Some("master".into()),
                    ..WorktreeEntry::default()
                },
                WorktreeEntry {
                    path: "C:/wt".into(),
                    branch: Some("feat".into()),
                    locked: true,
                    ..WorktreeEntry::default()
                },
                WorktreeEntry {
                    path: "C:/gone".into(),
                    branch: Some("feature/x".into()),
                    prunable: true,
                    ..WorktreeEntry::default()
                },
                WorktreeEntry {
                    path: "C:/detached".into(),
                    detached: true,
                    ..WorktreeEntry::default()
                },
            ]
        );
        let bare = parse_worktrees("worktree /srv/repo.git\nbare\n");
        assert_eq!(bare.len(), 1, "no trailing blank line still ends the record");
        assert!(bare[0].bare);
        assert!(parse_worktrees("").is_empty());
    }

    #[test]
    fn a_lock_keeps_its_reason_and_the_main_checkout_is_never_a_known_worktree() {
        let parsed = parse_worktrees("worktree /a\nbranch refs/heads/main\n\nworktree /b\nbranch refs/heads/b\nlocked moving disks\n");
        assert!(parsed[1].locked);
        assert_eq!(parsed[1].lock_reason.as_deref(), Some("moving disks"));
        assert_eq!(parse_worktrees(WORKTREES)[1].lock_reason, None, "locked without a reason");

        // A project that is itself a linked worktree: the main checkout is not one of its
        // known worktrees, nor is its own checkout; the other linked one is.
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        for name in ["main", "wt", "other"] {
            std::fs::create_dir(root.join(name)).unwrap();
        }
        let entry = |name: &str, branch: &str| WorktreeEntry {
            path: root.join(name).display().to_string(),
            branch: Some(branch.into()),
            ..WorktreeEntry::default()
        };
        let entries = [entry("main", "main"), entry("wt", "feat"), entry("other", "o")];
        let known = known_of(&entries, &root.join("wt"));
        assert_eq!(
            known,
            [crate::graph::KnownWorktree {
                path: root.join("other").display().to_string(),
                branch: Some("o".into()),
            }]
        );
        assert_eq!(known_of(&entries, &root.join("main")).len(), 2, "from the main checkout: both linked ones");
    }

    fn info(name: &str, head: bool, committed_at: i64) -> BranchInfo {
        BranchInfo {
            name: name.into(),
            head,
            upstream: None,
            ahead: 0,
            behind: 0,
            gone: false,
            committed_at,
            worktree: None,
        }
    }

    #[test]
    fn sort_puts_head_first_then_newest_then_name() {
        let mut list = vec![info("b", false, 10), info("a", false, 10), info("old", false, 1), info("cur", true, 0), info("new", false, 99)];
        sort_branches(&mut list);
        let names: Vec<&str> = list.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, ["cur", "new", "a", "b", "old"]);
    }

    #[test]
    fn attach_worktrees_skips_the_own_checkout_and_bare_records_and_marks_missing_ones() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        std::fs::create_dir(&wt).unwrap();
        let wt_raw = wt.display().to_string().replace('\\', "/");
        let porcelain = format!(
            "worktree {main}\nbranch refs/heads/master\n\nworktree {wt_raw}\nbranch refs/heads/feat\n\n\
             worktree {gone}\nbranch refs/heads/old\n\nworktree {flagged}\nbranch refs/heads/flagged\nprunable x\n\n",
            main = dir.path().display(),
            gone = dir.path().join("gone").display(),
            flagged = wt_raw,
        );
        let mut list = vec![info("master", true, 0), info("feat", false, 0), info("old", false, 0), info("flagged", false, 0)];
        attach_worktrees(&mut list, &parse_worktrees(&porcelain), dir.path());
        let canonical = dunce::canonicalize(&wt).unwrap().display().to_string();
        assert_eq!(list[0].worktree, None, "the own checkout (here the main one) gives no chip");
        assert_eq!(
            list[1].worktree,
            Some(WorktreeChip {
                path: canonical.clone(),
                missing: false
            }),
            "canonicalised"
        );
        assert!(list[2].worktree.as_ref().unwrap().missing, "folder gone");
        assert!(list[3].worktree.as_ref().unwrap().missing, "prunable");

        // Run from the linked worktree itself: its own checkout gives no chip, the main one does.
        let mut list = vec![info("master", false, 0), info("feat", true, 0)];
        attach_worktrees(&mut list, &parse_worktrees(&porcelain), &wt);
        assert_eq!(list[1].worktree, None);
        assert_eq!(list[0].worktree.as_ref().map(|c| c.path.clone()), Some(dunce::canonicalize(dir.path()).unwrap().display().to_string()));
        // Bare records never chip.
        let mut list = vec![info("x", false, 0)];
        attach_worktrees(&mut list, &parse_worktrees("worktree /srv/r.git\nbare\nbranch refs/heads/x\n"), &wt);
        assert_eq!(list[0].worktree, None);
    }

    // -- the real binary (skipped when git is not on PATH) --------------------------------

    pub(crate) fn real_git() -> Option<PathBuf> {
        crate::settings::detect::Search::from_env(vec![]).locate("git").map(|g| g.path)
    }

    /// Run git in `dir` with an isolated config, asserting success; returns stdout.
    pub(crate) fn git_ok(git: &Path, dir: &Path, args: &[&str]) -> String {
        let out = Command::new(git)
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// A temp repo on `main` with one commit, identity set locally.
    pub(crate) fn temp_repo(git: &Path) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git_ok(git, repo, &["init", "-q", "-b", "main"]);
        git_ok(git, repo, &["config", "user.name", "Switchboard Test"]);
        git_ok(git, repo, &["config", "user.email", "test@example.invalid"]);
        git_ok(git, repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("a.txt"), "a").unwrap();
        git_ok(git, repo, &["add", "a.txt"]);
        git_ok(git, repo, &["commit", "-q", "-m", "first"]);
        dir
    }

    #[test]
    fn branches_of_a_real_repo_with_upstream_worktree_and_gone() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let holder = tempfile::tempdir().unwrap();
        let dir = temp_repo(&git);
        let repo = dir.path();
        // An upstream for `main` without any fetch: a configured `origin` whose tracking ref
        // is written locally at the first commit.
        git_ok(&git, repo, &["config", "remote.origin.url", &holder.path().join("nowhere.git").display().to_string()]);
        git_ok(&git, repo, &["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
        git_ok(&git, repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        git_ok(&git, repo, &["config", "branch.main.remote", "origin"]);
        git_ok(&git, repo, &["config", "branch.main.merge", "refs/heads/main"]);
        // main: 2 ahead after two local commits.
        for n in 0..2 {
            std::fs::write(repo.join("a.txt"), format!("{n}")).unwrap();
            git_ok(&git, repo, &["commit", "-q", "-am", "more"]);
        }
        // feat: local-only, with a linked worktree; old: upstream configured then deleted.
        git_ok(&git, repo, &["branch", "feat"]);
        git_ok(&git, repo, &["branch", "old"]);
        git_ok(&git, repo, &["config", "branch.old.remote", "origin"]);
        git_ok(&git, repo, &["config", "branch.old.merge", "refs/heads/old"]);
        let wt = holder.path().join("wt");
        git_ok(&git, repo, &["worktree", "add", "-q", &wt.display().to_string(), "feat"]);

        let list = branches_of(&git, repo).unwrap().expect("a repository");
        let names: Vec<&str> = list.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names[0], "main", "checked out first");
        let main = &list[0];
        assert!(main.head);
        assert_eq!(main.upstream.as_deref(), Some("origin/main"));
        assert_eq!((main.ahead, main.behind, main.gone), (2, 0, false));
        assert!(main.worktree.is_none(), "the project's own checkout");
        let feat = list.iter().find(|b| b.name == "feat").unwrap();
        assert!(!feat.head);
        assert_eq!(feat.upstream, None);
        let chip = feat.worktree.clone().expect("feat has a worktree");
        assert_eq!(chip.path, dunce::canonicalize(&wt).unwrap().display().to_string());
        assert!(!chip.missing);
        let old = list.iter().find(|b| b.name == "old").unwrap();
        assert!(old.gone, "upstream configured, ref missing");

        // From the linked worktree: feat is HEAD there and gives no chip of its own; the main
        // checkout's branch gets one with the main checkout's path.
        let from_wt = branches_of(&git, &wt).unwrap().unwrap();
        assert_eq!(from_wt[0].name, "feat");
        assert!(from_wt[0].head);
        assert!(from_wt[0].worktree.is_none());
        let main_chip = from_wt.iter().find(|b| b.name == "main").unwrap().worktree.clone().expect("main chipped");
        assert_eq!(main_chip.path, dunce::canonicalize(repo).unwrap().display().to_string());

        // A project in a subfolder of the main checkout: its own checkout is still the top level.
        let sub = repo.join("sub");
        std::fs::create_dir(&sub).unwrap();
        let from_sub = branches_of(&git, &sub).unwrap().unwrap();
        assert!(from_sub.iter().find(|b| b.name == "main").unwrap().worktree.is_none(), "no chip for its own branch");
        assert!(from_sub.iter().find(|b| b.name == "feat").unwrap().worktree.is_some());

        // A locked worktree still has its chip.
        git_ok(&git, repo, &["worktree", "lock", "--reason", "testing", &wt.display().to_string()]);
        let locked = branches_of(&git, repo).unwrap().unwrap();
        assert!(!locked.iter().find(|b| b.name == "feat").unwrap().worktree.as_ref().unwrap().missing);
        git_ok(&git, repo, &["worktree", "unlock", &wt.display().to_string()]);

        // A tag named like a branch: the branch keeps its own name (no `heads/` prefix).
        git_ok(&git, repo, &["tag", "feat"]);
        let tagged = branches_of(&git, repo).unwrap().unwrap();
        let names: Vec<&str> = tagged.iter().map(|b| b.name.as_str()).collect();
        assert!(names.contains(&"feat") && !names.iter().any(|n| n.starts_with("heads/")), "{names:?}");
        assert!(tagged.iter().find(|b| b.name == "feat").unwrap().worktree.is_some(), "still matched to its worktree");
        assert_eq!(
            dunce::canonicalize(common_dir(&git, &wt).unwrap()).unwrap(),
            dunce::canonicalize(repo.join(".git")).unwrap(),
            "both checkouts share one common dir"
        );
        assert_eq!(common_dir(&git, repo).unwrap(), dunce::canonicalize(repo.join(".git")).unwrap());

        // The worktree folder deleted: `missing`.
        std::fs::remove_dir_all(&wt).unwrap();
        let list = branches_of(&git, repo).unwrap().unwrap();
        assert!(list.iter().find(|b| b.name == "feat").unwrap().worktree.as_ref().unwrap().missing);

        // Detached HEAD: no branch is current.
        git_ok(&git, repo, &["checkout", "-q", "--detach"]);
        let list = branches_of(&git, repo).unwrap().unwrap();
        assert!(list.iter().all(|b| !b.head));
    }

    #[test]
    fn branches_of_a_plain_folder_is_none_and_a_missing_git_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = branches_of(&dir.path().join("no-git.exe"), dir.path()).unwrap_err();
        assert!(matches!(err, GitError::Spawn(_)), "{err:?}");
        let Some(git) = real_git() else { return };
        if super::super::status::tests::inside_work_tree(&git, dir.path()) {
            return; // the temp dir sits inside some repository on this machine
        }
        assert_eq!(branches_of(&git, dir.path()).unwrap(), None);
    }

    #[test]
    fn a_failing_git_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let fail = crate::process::fixtures::script(
            dir.path(),
            "fail",
            "@echo fatal: bad things 1>&2\n@exit /b 2\n",
            "echo 'fatal: bad things' >&2\nexit 2\n",
        );
        let err = branches_of(&fail, dir.path()).unwrap_err();
        assert_eq!(
            err,
            GitError::Failed {
                code: Some(2),
                stderr: "fatal: bad things".into()
            }
        );
    }
}
