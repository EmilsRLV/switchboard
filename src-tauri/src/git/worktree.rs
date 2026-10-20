//! Creating a linked worktree (Story 5.2): the one git write the app makes, run only on the
//! operator's explicit submit of the "New worktree" sheet.
//!
//! [`plan_add`] resolves everything first, read-only: the sheet's choices ([`options_of`]: the
//! local branches, the ones free for a worktree, the default base), the target folder
//! ([`worktree_path`]) and the argv; it refuses a bad or taken name, an unknown base, a branch
//! already checked out somewhere, a relative `worktrees_root` and a folder that already
//! exists. The sheet's preview and the run both go through it, so the previewed command is
//! exactly what [`add`] runs:
//!
//! ```text
//! git worktree add [-b <new>] <path> <base|branch>
//! ```
//!
//! Folders: with `worktrees_root` null, `<repo>/.worktrees/<branch>` (`<repo>` is the project's
//! `--show-toplevel`); with a root set, `<root>/<repo folder name>/<branch>`, so one root can
//! serve many projects. A `/` in the branch name becomes nested folders. Nothing is fetched,
//! no remote branch is ever a base, and an existing worktree is never moved.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::branches::{BRANCHES_TIMEOUT, BranchInfo, branches_with_timeout, canonical_or_raw, git};
use super::poll::branch_error;

/// How long `git worktree add` may take (a large checkout) before it is killed.
pub const ADD_TIMEOUT: Duration = Duration::from_secs(30);

/// The folder under the repository that holds app-made worktrees when `worktrees_root` is null.
pub const DEFAULT_ROOT_DIR: &str = ".worktrees";

/// Why nothing runs: the reasons the sheet shows inline.
pub const NAME_REQUIRED: &str = "branch name is required";
pub const BRANCH_EXISTS: &str = "branch already exists";
pub const FOLDER_EXISTS: &str = "folder already exists";
pub const ROOT_NOT_ABSOLUTE: &str = "worktrees_root must be an absolute path";
pub const NOT_A_REPO: &str = "not a git repository";

/// What the sheet asks for. `mode` is `new` (a new branch `branch` from `base`; `base` null
/// means the default base) or `existing` (a worktree for the local branch `branch`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRequest {
    pub mode: WorktreeMode,
    pub branch: String,
    #[serde(default)]
    pub base: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeMode {
    New,
    Existing,
}

/// What the sheet offers for a repository.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeOptions {
    /// Every local branch, in the card order (the base select).
    pub branches: Vec<String>,
    /// The local branches with no worktree and not checked out in any (the existing select).
    pub available: Vec<String>,
    /// The base a new branch starts from unless the operator picks another: the branch checked
    /// out in the project's folder, else the repo's default branch. `None` with no branches.
    pub default_base: Option<String>,
}

/// A resolved `git worktree add`: what runs, and where the worktree lands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// The arguments after `git` (`worktree add [-b <new>] <path> <base|branch>`).
    pub argv: Vec<String>,
    /// The worktree folder (absolute; does not exist yet).
    pub path: PathBuf,
    /// The branch the worktree checks out.
    pub branch: String,
}

impl Plan {
    /// The command as the sheet previews it: `git` and the argv, an argument with a space (or
    /// empty) in double quotes.
    pub fn command_line(&self) -> String {
        command_line(&self.argv)
    }
}

/// `git` and `argv` as a sheet shows them: an argument with a space (or empty) in double quotes.
pub fn command_line(argv: &[String]) -> String {
    std::iter::once("git".to_string())
        .chain(argv.iter().map(|a| quote(a)))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote(arg: &str) -> String {
    if arg.is_empty() || arg.chars().any(char::is_whitespace) {
        format!("\"{arg}\"")
    } else {
        arg.to_string()
    }
}

/// The preview the sheet shows: the options, and either the plan's command and folder or why
/// nothing would run (`error`). No branch named (a blank new name, or no existing branch picked):
/// neither (the sheet says why Create is disabled).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePreview {
    #[serde(flatten)]
    pub options: WorktreeOptions,
    pub command: Option<String>,
    pub path: Option<String>,
    pub error: Option<String>,
}

/// The default branch of a repository, offline: `refs/remotes/origin/HEAD`'s branch when a
/// local branch has its name, else `main`, else `master`, else the first listed. `origin_head`
/// is that symbolic ref's target (`refs/remotes/origin/main`) when set.
pub fn default_branch(names: &[String], origin_head: Option<&str>) -> Option<String> {
    let has = |n: &str| names.iter().any(|b| b == n);
    origin_head
        .and_then(|r| r.trim().strip_prefix("refs/remotes/origin/"))
        .filter(|n| has(n))
        .map(str::to_string)
        .or_else(|| ["main", "master"].into_iter().find(|n| has(n)).map(str::to_string))
        .or_else(|| names.first().cloned())
}

/// [`WorktreeOptions`] from a branch read (`branches_of`) and the default branch.
pub fn options_from(branches: &[BranchInfo], origin_head: Option<&str>) -> WorktreeOptions {
    let names: Vec<String> = branches.iter().map(|b| b.name.clone()).collect();
    let default_base = branches
        .iter()
        .find(|b| b.head)
        .map(|b| b.name.clone())
        .or_else(|| default_branch(&names, origin_head));
    WorktreeOptions {
        available: branches.iter().filter(|b| !b.head && b.worktree.is_none()).map(|b| b.name.clone()).collect(),
        branches: names,
        default_base,
    }
}

/// Where the worktree for `branch` goes. `top` is the project's top level (canonical);
/// `root` is `worktrees_root` (`None` or blank: `<top>/.worktrees`; else it must be absolute,
/// and the repo's folder name is added under it). Each `/`-separated part of the name is one
/// folder.
pub fn worktree_path(top: &Path, root: Option<&str>, branch: &str) -> Result<PathBuf, String> {
    let mut path = match root.map(str::trim).filter(|r| !r.is_empty()) {
        None => top.join(DEFAULT_ROOT_DIR),
        Some(root) => {
            let root = Path::new(root);
            // On Windows `\x` (no drive) is not absolute either.
            if !root.is_absolute() {
                return Err(format!("{ROOT_NOT_ABSOLUTE}: {}", root.display()));
            }
            let repo = top
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "repo".to_string());
            root.join(repo)
        }
    };
    for part in branch.split('/').filter(|p| !p.is_empty()) {
        path.push(part);
    }
    Ok(path)
}

/// Read-only checks of a new branch name: not blank, not starting with `-`, no `<>"|` on
/// Windows, then `git check-ref-format --branch` (its message when it refuses).
pub(crate) fn check_new_name(git_bin: &Path, dir: &Path, name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(NAME_REQUIRED.to_string());
    }
    if name.starts_with('-') {
        return Err("branch name must not start with -".to_string());
    }
    if cfg!(windows) && name.chars().any(|c| matches!(c, '<' | '>' | '"' | '|')) {
        return Err("branch name must not contain < > \" | on Windows".to_string());
    }
    let done = crate::process::run(git(git_bin, dir, &["check-ref-format", "--branch", name]), BRANCHES_TIMEOUT).map_err(|e| branch_error(&e))?;
    if done.status.success() {
        return Ok(());
    }
    let message = done.stderr_summary();
    Err(if message.is_empty() {
        format!("not a valid branch name: {name}")
    } else {
        message.strip_prefix("fatal: ").unwrap_or(&message).to_string()
    })
}

/// True when `refs/heads/<name>` exists (`git show-ref --verify --quiet`).
fn branch_exists(git_bin: &Path, dir: &Path, name: &str) -> Result<bool, String> {
    let reference = format!("refs/heads/{name}");
    let done = crate::process::run(git(git_bin, dir, &["show-ref", "--verify", "--quiet", &reference]), BRANCHES_TIMEOUT).map_err(|e| branch_error(&e))?;
    Ok(done.status.success())
}

/// The project's top level, canonical (`git rev-parse --show-toplevel`).
pub(crate) fn top_level(git_bin: &Path, dir: &Path) -> Result<PathBuf, String> {
    let done = crate::process::run(git(git_bin, dir, &["rev-parse", "--show-toplevel"]), BRANCHES_TIMEOUT)
        .map_err(|e| branch_error(&e))?
        .success()
        .map_err(|e| branch_error(&e))?;
    let raw = done.stdout.trim();
    if raw.is_empty() {
        return Err(NOT_A_REPO.to_string());
    }
    Ok(PathBuf::from(canonical_or_raw(raw)))
}

/// What the sheet offers for the repository at `project` (read-only).
pub fn options_of(git_bin: &Path, project: &Path) -> Result<WorktreeOptions, String> {
    let branches = branches_with_timeout(git_bin, project, BRANCHES_TIMEOUT)
        .map_err(|e| branch_error(&e))?
        .ok_or_else(|| NOT_A_REPO.to_string())?;
    // Unset is exit 1 with nothing printed: no origin HEAD.
    let origin_head = crate::process::run(git(git_bin, project, &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]), BRANCHES_TIMEOUT)
        .ok()
        .filter(|d| d.status.success())
        .map(|d| d.stdout.trim().to_string());
    Ok(options_from(&branches, origin_head.as_deref()))
}

/// Resolve the request into a [`Plan`], read-only. `options` are [`options_of`] the project.
pub fn plan_with(
    git_bin: &Path,
    project: &Path,
    worktrees_root: Option<&str>,
    options: &WorktreeOptions,
    request: &WorktreeRequest,
) -> Result<Plan, String> {
    let name = request.branch.trim();
    let mut argv: Vec<String> = vec!["worktree".into(), "add".into()];
    let target = match request.mode {
        WorktreeMode::New => {
            check_new_name(git_bin, project, name)?;
            if branch_exists(git_bin, project, name)? {
                return Err(format!("{BRANCH_EXISTS}: {name}"));
            }
            let base = request
                .base
                .as_deref()
                .map(str::trim)
                .filter(|b| !b.is_empty())
                .map(str::to_string)
                .or_else(|| options.default_base.clone())
                .ok_or_else(|| "no base branch: the repository has no branches yet".to_string())?;
            if !options.branches.contains(&base) {
                return Err(format!("base is not a local branch: {base}"));
            }
            argv.push("-b".into());
            argv.push(name.to_string());
            base
        }
        WorktreeMode::Existing => {
            if name.is_empty() {
                return Err("pick a branch".to_string());
            }
            if !options.branches.iter().any(|b| b == name) {
                return Err(format!("not a local branch: {name}"));
            }
            if !options.available.iter().any(|b| b == name) {
                return Err(format!("branch is already checked out in a worktree: {name}"));
            }
            name.to_string()
        }
    };
    let top = top_level(git_bin, project)?;
    let path = worktree_path(&top, worktrees_root, name)?;
    if path.exists() {
        return Err(format!("{FOLDER_EXISTS}: {}", path.display()));
    }
    argv.push(path.display().to_string());
    argv.push(target);
    Ok(Plan {
        argv,
        path,
        branch: name.to_string(),
    })
}

/// [`options_of`] then [`plan_with`].
pub fn plan_add(git_bin: &Path, project: &Path, worktrees_root: Option<&str>, request: &WorktreeRequest) -> Result<Plan, String> {
    let options = options_of(git_bin, project)?;
    plan_with(git_bin, project, worktrees_root, &options, request)
}

/// The sheet's preview: the options, and the plan's command and folder or why nothing runs.
/// `Err` only when there are no options (not a repository, git unavailable).
pub fn preview(git_bin: &Path, project: &Path, worktrees_root: Option<&str>, request: &WorktreeRequest) -> Result<WorktreePreview, String> {
    let options = options_of(git_bin, project)?;
    // Nothing named yet (a blank new name, or no existing branch picked): options only.
    if request.branch.trim().is_empty() {
        return Ok(WorktreePreview {
            options,
            ..WorktreePreview::default()
        });
    }
    let plan = plan_with(git_bin, project, worktrees_root, &options, request);
    Ok(match plan {
        Ok(plan) => WorktreePreview {
            command: Some(plan.command_line()),
            path: Some(plan.path.display().to_string()),
            error: None,
            options,
        },
        Err(error) => WorktreePreview {
            error: Some(error),
            options,
            ..WorktreePreview::default()
        },
    })
}

/// Run the plan from the project folder (the one write). Returns the new worktree's canonical
/// path; `Err` is git's first stderr line (or why it could not run).
pub fn add(git_bin: &Path, project: &Path, plan: &Plan) -> Result<String, String> {
    add_with_timeout(git_bin, project, plan, ADD_TIMEOUT)
}

pub fn add_with_timeout(git_bin: &Path, project: &Path, plan: &Plan, timeout: Duration) -> Result<String, String> {
    let args: Vec<&str> = plan.argv.iter().map(String::as_str).collect();
    crate::process::run(git(git_bin, project, &args), timeout)
        .map_err(|e| branch_error(&e))?
        .success()
        .map_err(|e| branch_error(&e))?;
    Ok(canonical_or_raw(&plan.path.display().to_string()))
}

// --- removing a worktree (Story 5.4) ------------------------------------------------------

/// How long `git worktree remove` or `git branch -d` may take before it is killed.
pub const REMOVE_TIMEOUT: Duration = Duration::from_secs(30);

/// Why the remove sheet refuses.
pub const LOCKED: &str = "locked";
pub const LIVE_IN_WORKTREE: &str = "a session is running in this worktree: ";
pub const NO_WORKTREE: &str = "this branch has no worktree";
pub const MAIN_CHECKOUT: &str = "the main checkout cannot be removed";

/// What the "Remove worktree" sheet shows, read-only (Rust owns the checks and the command text):
/// the worktree, what it holds, the exact commands, and why nothing may run (`refusal`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveCheck {
    pub branch: String,
    /// The worktree folder (canonical when it exists, else as git printed it).
    pub path: String,
    /// Its folder is gone (or git calls it `prunable`): Remove clears that one stale record
    /// (`git worktree remove <path>` exits 0 for a missing folder and leaves other records alone).
    pub missing: bool,
    pub locked: bool,
    /// Modified and untracked files inside it (`git status` run there); 0 when missing or locked.
    pub dirty: u32,
    /// What **Remove** runs: `git worktree remove <path>` (a missing folder too).
    pub command: String,
    /// What the second, explicit confirm runs while dirty: `git worktree remove --force <path>`.
    pub force_command: Option<String>,
    /// What runs after a successful remove when "Also delete branch" is ticked.
    pub delete_command: String,
    /// Why nothing may run: `locked` (`locked: <reason>` when git has one), a session running
    /// in it, a status git could not read.
    pub refusal: Option<String>,
}

/// The sheet's line for a dirty worktree.
pub fn dirty_line(count: u32) -> String {
    let files = if count == 1 { "file" } else { "files" };
    format!("{count} changed {files} (modified or untracked)")
}

/// `running` is `(cwd, name)` of every live session and of the folder each running app terminal
/// started in: the first whose cwd lies inside `path` names who holds the worktree. A terminal
/// that later changed folder, or another program, is not seen.
pub fn running_in(path: &str, running: &[(String, String)]) -> Option<String> {
    let canonical = canonical_or_raw(path);
    running
        .iter()
        .find(|(cwd, _)| {
            let cwd_canonical = canonical_or_raw(cwd.trim());
            crate::graph::path_within(&cwd_canonical, &canonical) || crate::graph::path_within(cwd, path)
        })
        .map(|(_, name)| name.clone())
}

/// The argv of the remove (a missing folder too: git then drops just that record), `--force`
/// only when asked and dirty.
fn remove_argv(check: &RemoveCheck, force: bool) -> Vec<String> {
    let mut argv: Vec<String> = vec!["worktree".into(), "remove".into()];
    if force && check.dirty > 0 {
        argv.push("--force".into());
    }
    argv.push(check.path.clone());
    argv
}

fn delete_argv(branch: &str) -> Vec<String> {
    vec!["branch".into(), "-d".into(), branch.to_string()]
}

/// Check, read-only, what removing `branch`'s linked worktree would do, from `git worktree list`
/// run in `project`: locked or missing, the dirty count from `git status` inside the worktree
/// (its own nested worktrees left out, as the project's poll does), and whether a session or
/// terminal in `running` has its cwd inside it. `Err` when the project is not a repository or
/// the branch has no linked worktree (the project's own checkout never counts).
pub fn remove_check(git_bin: &Path, project: &Path, branch: &str, running: &[(String, String)]) -> Result<RemoveCheck, String> {
    let (top, entries) = super::branches::worktree_listing(git_bin, project).map_err(|e| branch_error(&e))?;
    let own = top.display().to_string();
    let (index, entry) = entries
        .iter()
        .enumerate()
        .filter(|(_, w)| !w.bare && w.branch.as_deref() == Some(branch))
        .find(|(_, w)| !crate::graph::same_path(&canonical_or_raw(&w.path), &own))
        .ok_or_else(|| NO_WORKTREE.to_string())?;
    // The first record is the main checkout (the chip a project that is itself a linked
    // worktree shows for the main branch): never removed, never stored as history.
    if index == 0 {
        return Err(MAIN_CHECKOUT.to_string());
    }
    let path = canonical_or_raw(&entry.path);
    let missing = entry.prunable || !Path::new(&path).is_dir();
    let mut check = RemoveCheck {
        branch: branch.to_string(),
        path: path.clone(),
        missing,
        locked: entry.locked,
        delete_command: command_line(&delete_argv(branch)),
        ..RemoveCheck::default()
    };
    if entry.locked {
        check.refusal = Some(match &entry.lock_reason {
            Some(reason) => format!("{LOCKED}: {reason}"),
            None => LOCKED.to_string(),
        });
    } else if let Some(name) = running_in(&path, running) {
        check.refusal = Some(format!("{LIVE_IN_WORKTREE}{name}"));
    } else if !missing {
        let wt = PathBuf::from(&path);
        let excludes = super::branches::inside_of(&entries, &wt);
        match super::status::repo_status_with_timeout(git_bin, &wt, super::status::STATUS_TIMEOUT, &excludes) {
            Ok(status) => check.dirty = status.map(|s| s.dirty).unwrap_or(0),
            Err(err) => check.refusal = Some(format!("could not read the worktree's status: {}", branch_error(&err))),
        }
    }
    check.command = command_line(&remove_argv(&check, false));
    check.force_command = (check.dirty > 0).then(|| command_line(&remove_argv(&check, true)));
    Ok(check)
}

/// Remove `branch`'s worktree on the sheet's click: [`remove_check`] again (any refusal is the
/// `Err` and nothing runs), then the command it names, from the project folder. `force` is the
/// dirty count the operator confirmed discarding: a dirty worktree runs `--force` only when its
/// count now is exactly that (else the `Err` is the current dirty line). `Err` is git's first
/// stderr line. Returns the check it ran.
pub fn remove(git_bin: &Path, project: &Path, branch: &str, force: Option<u32>, running: &[(String, String)]) -> Result<RemoveCheck, String> {
    let check = remove_check(git_bin, project, branch, running)?;
    run_remove(git_bin, project, &check, force, REMOVE_TIMEOUT)?;
    Ok(check)
}

/// Run what `check` names. Its refusal is the `Err`; so is a dirty worktree unless `force` is
/// its exact dirty count (what the second confirm stated).
pub fn run_remove(git_bin: &Path, project: &Path, check: &RemoveCheck, force: Option<u32>, timeout: Duration) -> Result<(), String> {
    if let Some(refusal) = &check.refusal {
        return Err(refusal.clone());
    }
    if check.dirty > 0 && force != Some(check.dirty) {
        return Err(dirty_line(check.dirty));
    }
    let argv = remove_argv(check, force.is_some());
    let args: Vec<&str> = argv.iter().map(String::as_str).collect();
    crate::process::run(git(git_bin, project, &args), timeout)
        .map_err(|e| branch_error(&e))?
        .success()
        .map_err(|e| branch_error(&e))?;
    Ok(())
}

/// `git branch -d <branch>` from the project folder (never `-D`): `Err` is git's refusal
/// (not fully merged, checked out elsewhere), its first stderr line.
pub fn delete_branch(git_bin: &Path, project: &Path, branch: &str) -> Result<(), String> {
    let argv = delete_argv(branch);
    let args: Vec<&str> = argv.iter().map(String::as_str).collect();
    crate::process::run(git(git_bin, project, &args), REMOVE_TIMEOUT)
        .map_err(|e| branch_error(&e))?
        .success()
        .map_err(|e| branch_error(&e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::branches::tests::{git_ok, real_git, temp_repo};
    use super::*;

    fn info(name: &str, head: bool, worktree: bool) -> BranchInfo {
        BranchInfo {
            name: name.into(),
            head,
            upstream: None,
            ahead: 0,
            behind: 0,
            gone: false,
            committed_at: 0,
            worktree: worktree.then(|| super::super::WorktreeChip {
                path: "/x".into(),
                missing: false,
            }),
        }
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn default_branch_prefers_origin_head_then_main_then_master_then_the_first() {
        let all = names(&["dev", "master", "main", "trunk"]);
        assert_eq!(default_branch(&all, Some("refs/remotes/origin/trunk\n")).as_deref(), Some("trunk"));
        assert_eq!(default_branch(&all, Some("refs/remotes/origin/gone")).as_deref(), Some("main"), "no local branch of that name");
        assert_eq!(default_branch(&all, None).as_deref(), Some("main"));
        assert_eq!(default_branch(&names(&["dev", "master"]), None).as_deref(), Some("master"));
        assert_eq!(default_branch(&names(&["dev", "x"]), None).as_deref(), Some("dev"));
        assert_eq!(default_branch(&[], None), None);
    }

    #[test]
    fn options_offer_free_branches_and_default_to_head_or_the_default_branch() {
        let list = vec![info("feat", true, false), info("main", false, false), info("wt", false, true), info("free", false, false)];
        let options = options_from(&list, None);
        assert_eq!(options.branches, names(&["feat", "main", "wt", "free"]));
        assert_eq!(options.available, names(&["main", "free"]), "not checked out, no worktree");
        assert_eq!(options.default_base.as_deref(), Some("feat"), "the checked-out branch");
        let detached = vec![info("feat", false, false), info("main", false, false)];
        assert_eq!(options_from(&detached, None).default_base.as_deref(), Some("main"), "detached: the default branch");
    }

    #[test]
    fn worktree_path_follows_the_root_rule() {
        let dir = tempfile::tempdir().unwrap();
        let top = dir.path().join("r");
        assert_eq!(worktree_path(&top, None, "auth-refresh").unwrap(), top.join(".worktrees").join("auth-refresh"));
        assert_eq!(worktree_path(&top, Some("  "), "a").unwrap(), top.join(".worktrees").join("a"), "blank is the default");
        assert_eq!(worktree_path(&top, None, "feat/x").unwrap(), top.join(".worktrees").join("feat").join("x"), "nested folders");
        let root = dir.path().join("wts");
        assert_eq!(
            worktree_path(&top, Some(&root.display().to_string()), "feat/x").unwrap(),
            root.join("r").join("feat").join("x"),
            "custom root: <root>/<repo folder>/<branch>"
        );
        let err = worktree_path(&top, Some("rel/wts"), "a").unwrap_err();
        assert!(err.starts_with(ROOT_NOT_ABSOLUTE), "{err}");
    }

    #[test]
    fn the_command_line_quotes_arguments_with_spaces() {
        let plan = Plan {
            argv: names(&["worktree", "add", "-b", "x", "C:\\my repo\\.worktrees\\x", "main"]),
            path: PathBuf::from("C:\\my repo\\.worktrees\\x"),
            branch: "x".into(),
        };
        assert_eq!(plan.command_line(), "git worktree add -b x \"C:\\my repo\\.worktrees\\x\" main");
    }

    fn new(name: &str, base: Option<&str>) -> WorktreeRequest {
        WorktreeRequest {
            mode: WorktreeMode::New,
            branch: name.into(),
            base: base.map(str::to_string),
        }
    }

    fn existing(name: &str) -> WorktreeRequest {
        WorktreeRequest {
            mode: WorktreeMode::Existing,
            branch: name.into(),
            base: None,
        }
    }

    #[test]
    fn plan_and_add_on_a_temp_repo() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let repo = dir.path();
        let top = dunce::canonicalize(repo).unwrap();
        git_ok(&git, repo, &["branch", "feat"]);

        // New from main: the exact argv and folder.
        let plan = plan_add(&git, repo, None, &new("auth-refresh", Some("main"))).unwrap();
        let path = top.join(".worktrees").join("auth-refresh");
        assert_eq!(plan.path, path);
        assert_eq!(plan.argv, names(&["worktree", "add", "-b", "auth-refresh", &path.display().to_string(), "main"]));
        assert_eq!(plan.command_line(), format!("git worktree add -b auth-refresh {} main", path.display()));
        // Base left out: the checked-out branch.
        assert_eq!(plan_add(&git, repo, None, &new("auth-refresh", None)).unwrap().argv.last().unwrap(), "main");
        let made = add(&git, repo, &plan).unwrap();
        assert_eq!(made, path.display().to_string());
        assert!(path.join("a.txt").is_file(), "checked out");
        let list = git_ok(&git, repo, &["worktree", "list", "--porcelain"]);
        assert!(list.contains("branch refs/heads/auth-refresh"), "{list}");

        // Existing branch.
        let plan = plan_add(&git, repo, None, &existing("feat")).unwrap();
        assert_eq!(plan.argv, names(&["worktree", "add", &top.join(".worktrees").join("feat").display().to_string(), "feat"]));
        add(&git, repo, &plan).unwrap();
        // Now taken: it has a worktree; main is checked out here.
        assert!(plan_add(&git, repo, None, &existing("feat")).unwrap_err().contains("already checked out"));
        assert!(plan_add(&git, repo, None, &existing("main")).unwrap_err().contains("already checked out"));

        // A slash name nests.
        let plan = plan_add(&git, repo, None, &new("team/x", None)).unwrap();
        assert_eq!(plan.path, top.join(".worktrees").join("team").join("x"));

        // Refusals: nothing runs.
        assert_eq!(plan_add(&git, repo, None, &new("main", None)).unwrap_err(), format!("{BRANCH_EXISTS}: main"));
        let bad = plan_add(&git, repo, None, &new("a..b", None)).unwrap_err();
        assert!(bad.contains("a..b"), "{bad}");
        assert_eq!(plan_add(&git, repo, None, &new(" ", None)).unwrap_err(), NAME_REQUIRED);
        assert!(plan_add(&git, repo, None, &new("-x", None)).is_err());
        assert!(plan_add(&git, repo, None, &new("ok", Some("origin/main"))).unwrap_err().contains("not a local branch"));
        if cfg!(windows) {
            assert!(plan_add(&git, repo, None, &new("a|b", None)).unwrap_err().contains("Windows"));
        }
        std::fs::create_dir_all(top.join(".worktrees").join("taken")).unwrap();
        let taken = plan_add(&git, repo, None, &new("taken", None)).unwrap_err();
        assert_eq!(taken, format!("{FOLDER_EXISTS}: {}", top.join(".worktrees").join("taken").display()));
        assert!(plan_add(&git, repo, Some("relative/root"), &new("y", None)).unwrap_err().starts_with(ROOT_NOT_ABSOLUTE));

        // A custom root, then a changed one: new worktrees go under the new root, old ones stay.
        let roots = tempfile::tempdir().unwrap();
        let first = roots.path().join("one");
        let second = roots.path().join("two");
        let repo_name = top.file_name().unwrap();
        let plan = plan_add(&git, repo, Some(&first.display().to_string()), &new("c1", None)).unwrap();
        assert_eq!(plan.path, first.join(repo_name).join("c1"));
        let c1 = add(&git, repo, &plan).unwrap();
        let plan = plan_add(&git, repo, Some(&second.display().to_string()), &new("c2", None)).unwrap();
        assert_eq!(plan.path, second.join(repo_name).join("c2"));
        add(&git, repo, &plan).unwrap();
        assert!(Path::new(&c1).join("a.txt").is_file(), "the first one was not moved");

        // git itself refuses (a ref that conflicts with an existing one): its first stderr line.
        let plan = Plan {
            argv: names(&["worktree", "add", "-b", "feat/sub", &top.join(".worktrees").join("feat-sub").display().to_string(), "main"]),
            path: top.join(".worktrees").join("feat-sub"),
            branch: "feat/sub".into(),
        };
        let err = add(&git, repo, &plan).unwrap_err();
        assert!(!err.is_empty() && !err.contains('\n'), "{err}");

        // The preview: blank name gives options only; a valid one the command.
        let preview_blank = preview(&git, repo, None, &new("", None)).unwrap();
        assert!(preview_blank.command.is_none() && preview_blank.error.is_none());
        assert_eq!(preview_blank.options.default_base.as_deref(), Some("main"));
        assert!(!preview_blank.options.available.contains(&"feat".to_string()));
        let none_picked = preview(&git, repo, None, &existing("")).unwrap();
        assert!(none_picked.command.is_none() && none_picked.error.is_none(), "existing, none picked: options only");
        assert_eq!(none_picked.options, preview_blank.options);
        let shown = preview(&git, repo, None, &new("z", None)).unwrap();
        assert_eq!(shown.command, Some(plan_add(&git, repo, None, &new("z", None)).unwrap().command_line()));
        assert_eq!(preview(&git, repo, None, &new("main", None)).unwrap().error, Some(format!("{BRANCH_EXISTS}: main")));
    }

    #[test]
    fn a_plain_folder_has_no_options() {
        let dir = tempfile::tempdir().unwrap();
        let Some(git) = real_git() else { return };
        if super::super::status::tests::inside_work_tree(&git, dir.path()) {
            return;
        }
        assert_eq!(options_of(&git, dir.path()).unwrap_err(), NOT_A_REPO);
        assert_eq!(options_of(&dir.path().join("no-git.exe"), dir.path()).unwrap_err(), "git unavailable");
    }

    #[test]
    fn the_dirty_line_and_the_running_check() {
        assert_eq!(dirty_line(1), "1 changed file (modified or untracked)");
        assert_eq!(dirty_line(3), "3 changed files (modified or untracked)");
        let dir = tempfile::tempdir().unwrap();
        let wt = dunce::canonicalize(dir.path()).unwrap().join("wt");
        std::fs::create_dir_all(wt.join("src")).unwrap();
        let wt_s = wt.display().to_string();
        let sibling = format!("{wt_s}-other");
        let running = vec![(sibling.clone(), "elsewhere".to_string()), (wt.join("src").display().to_string(), "spike".to_string())];
        assert_eq!(running_in(&wt_s, &running).as_deref(), Some("spike"), "a cwd inside it");
        assert_eq!(running_in(&wt_s, &running[..1]), None, "a sibling with the same prefix is not inside");
        if cfg!(windows) {
            let upper = vec![(wt_s.to_uppercase().replace('\\', "/"), "x".to_string())];
            assert_eq!(running_in(&wt_s, &upper).as_deref(), Some("x"));
        }
    }

    fn count_worktrees(git: &Path, repo: &Path) -> usize {
        git_ok(git, repo, &["worktree", "list", "--porcelain"]).lines().filter(|l| l.starts_with("worktree ")).count()
    }

    #[test]
    fn remove_checks_and_runs_on_a_temp_repo() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let repo = dir.path();
        let top = dunce::canonicalize(repo).unwrap();
        let add = |name: &str| {
            let path = top.join(".worktrees").join(name);
            git_ok(&git, repo, &["worktree", "add", "-q", "-b", name, &path.display().to_string(), "main"]);
            path
        };
        let none: &[(String, String)] = &[];

        // The project's own checkout, and a branch without a worktree: nothing to remove.
        assert_eq!(remove_check(&git, repo, "main", none).unwrap_err(), NO_WORKTREE);
        git_ok(&git, repo, &["branch", "plain"]);
        assert_eq!(remove_check(&git, repo, "plain", none).unwrap_err(), NO_WORKTREE);

        // Clean: one command, no force; the branch survives the removal.
        let clean = add("clean");
        let check = remove_check(&git, repo, "clean", none).unwrap();
        let path = clean.display().to_string();
        assert_eq!(check.path, path);
        assert_eq!((check.missing, check.locked, check.dirty, check.refusal.clone()), (false, false, 0, None));
        assert_eq!(check.command, format!("git worktree remove {path}"));
        assert_eq!(check.force_command, None);
        assert_eq!(check.delete_command, "git branch -d clean");
        let before = count_worktrees(&git, repo);
        remove(&git, repo, "clean", None, none).unwrap();
        assert!(!clean.exists(), "the folder went");
        assert_eq!(count_worktrees(&git, repo), before - 1);
        git_ok(&git, repo, &["show-ref", "--verify", "--quiet", "refs/heads/clean"]);
        // Merged into main: `-d` deletes it.
        delete_branch(&git, repo, "clean").unwrap();
        assert!(git_ok(&git, repo, &["branch", "--list", "clean"]).trim().is_empty());

        // Dirty: 2 modified + 1 untracked is 3; Remove is refused, force runs `--force`.
        let feat = add("feat");
        std::fs::write(feat.join("b.txt"), "b").unwrap();
        git_ok(&git, &feat, &["add", "b.txt"]);
        git_ok(&git, &feat, &["commit", "-q", "-m", "b on feat"]);
        std::fs::write(feat.join("a.txt"), "changed").unwrap();
        std::fs::write(feat.join("b.txt"), "changed").unwrap();
        std::fs::write(feat.join("c.txt"), "new").unwrap();
        let check = remove_check(&git, repo, "feat", none).unwrap();
        assert_eq!(check.dirty, 3);
        assert_eq!(check.refusal, None);
        let path = feat.display().to_string();
        assert_eq!(check.command, format!("git worktree remove {path}"));
        assert_eq!(check.force_command.as_deref(), Some(format!("git worktree remove --force {path}").as_str()));
        assert_eq!(remove(&git, repo, "feat", None, none).unwrap_err(), dirty_line(3));
        // A force confirmed for another count (the sheet showed 2): refused with the current line.
        assert_eq!(remove(&git, repo, "feat", Some(2), none).unwrap_err(), dirty_line(3));
        assert!(feat.join("c.txt").is_file(), "nothing ran");
        // A session running in it: refused, named, even with force.
        let running = vec![(feat.join("sub").display().to_string(), "spike".to_string())];
        let check = remove_check(&git, repo, "feat", &running).unwrap();
        assert_eq!(check.refusal.as_deref(), Some("a session is running in this worktree: spike"));
        assert_eq!(remove(&git, repo, "feat", Some(3), &running).unwrap_err(), "a session is running in this worktree: spike");
        assert!(feat.is_dir());
        remove(&git, repo, "feat", Some(3), none).unwrap();
        assert!(!feat.exists(), "forced");
        git_ok(&git, repo, &["show-ref", "--verify", "--quiet", "refs/heads/feat"]);
        // Not merged: `-d` refuses with git's message, the branch stays.
        let err = delete_branch(&git, repo, "feat").unwrap_err();
        assert!(err.contains("not fully merged"), "{err}");
        git_ok(&git, repo, &["show-ref", "--verify", "--quiet", "refs/heads/feat"]);

        // Locked: refused with git's reason, no force; without a reason just `locked`.
        let locked = add("locked");
        git_ok(&git, repo, &["worktree", "lock", "--reason", "testing", &locked.display().to_string()]);
        let check = remove_check(&git, repo, "locked", none).unwrap();
        assert!(check.locked);
        assert_eq!(check.refusal.as_deref(), Some("locked: testing"));
        assert_eq!(remove(&git, repo, "locked", Some(0), none).unwrap_err(), "locked: testing");
        assert!(locked.is_dir());
        git_ok(&git, repo, &["worktree", "unlock", &locked.display().to_string()]);
        git_ok(&git, repo, &["worktree", "lock", &locked.display().to_string()]);
        assert_eq!(remove_check(&git, repo, "locked", none).unwrap().refusal.as_deref(), Some(LOCKED));
        git_ok(&git, repo, &["worktree", "unlock", &locked.display().to_string()]);

        // The main checkout, seen from a project that is itself a linked worktree: refused.
        assert_eq!(remove_check(&git, &locked, "main", none).unwrap_err(), MAIN_CHECKOUT);

        // Two missing folders: Remove clears only the selected record.
        let gone = add("gone");
        let other = add("other-gone");
        std::fs::remove_dir_all(&gone).unwrap();
        std::fs::remove_dir_all(&other).unwrap();
        let check = remove_check(&git, repo, "gone", none).unwrap();
        assert!(check.missing);
        assert_eq!(check.dirty, 0);
        assert_eq!(check.command, format!("git worktree remove {}", check.path));
        let before = count_worktrees(&git, repo);
        remove(&git, repo, "gone", None, none).unwrap();
        assert_eq!(count_worktrees(&git, repo), before - 1);
        assert_eq!(remove_check(&git, repo, "gone", none).unwrap_err(), NO_WORKTREE);
        assert!(remove_check(&git, repo, "other-gone", none).unwrap().missing, "the other stale record stays");

        // git itself refuses (here: the worktree is not a worktree any more): its first line.
        let stale = RemoveCheck {
            path: top.join(".worktrees").join("never").display().to_string(),
            ..RemoveCheck::default()
        };
        let err = run_remove(&git, repo, &stale, None, REMOVE_TIMEOUT).unwrap_err();
        assert!(!err.is_empty() && !err.contains('\n'), "{err}");
    }
}
