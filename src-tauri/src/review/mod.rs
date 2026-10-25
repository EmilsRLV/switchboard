//! Review requests (Story 7.4): the `switchboard` MCP server's `request_review({summary, paths?})`
//! and each session's review flag.
//!
//! **The tool.** A session says "this is ready, look here". It never asks the operator (Emils'
//! decision; the tool is in the session's `permissions.allow`, so Claude Code does not prompt
//! either). The summary is required: control characters, U+2028 / U+2029 and the bidi
//! embeddings, overrides and isolates are stripped, it is trimmed and cut to
//! [`MAX_SUMMARY_CHARS`] characters (then `…`). At most [`MAX_PATHS`] paths, each cleaned the same
//! way: a relative one resolves against the caller's cwd, `.` and `..` are resolved on the text,
//! and every one must lie within the caller's cwd, its worktree, its project folder or one of its
//! add-dirs (the launcher's record and the context edges applied live, as `my_node` lists them).
//! The check is made on the real location: the deepest part of the path that exists, and each
//! allowed folder, are canonicalised (symlinks and junctions followed), so a link inside the cwd
//! that points elsewhere is outside. Any path outside refuses the whole call with
//! `outside this session's folders: <paths>` and nothing is flagged. A path that does not exist
//! is accepted and marked `missing`. Existence is checked; contents are never read. Returns
//! `{flagged: true, paths: N}`. Without paths the session's folders are not needed.
//!
//! **The flag.** Rust owns it: per session, the last request (its summary, its paths, when) and
//! whether it is still flagged, in memory only. A new request from the same session replaces the
//! summary and paths and flags it again. Opening the review ([`open`]) or "Clear review flag"
//! ([`clear`]) lowers the flag of the request the operator saw (its `seq`); a call for a request
//! since replaced changes nothing. The request stays, so the Review pane can still list it. Every
//! change goes out as [`EVENT`] with the full map, emitted outside the store's lock but in the
//! order of the changes. A session removed from the workspace (its ref, or its project) loses its
//! request ([`forget_sessions`]).
//!
//! **The notification.** While the main window is not focused and `notifications.review` is on,
//! one OS toast says `<name> asks for review` (`crate::notify::on_review`); a click on it opens the
//! review.

use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::graph;
use crate::settings::AppState;

/// The event that carries `{sessionId: ReviewRequest}` on every change.
pub const EVENT: &str = "review://requests";

/// The most paths one request lists.
pub const MAX_PATHS: usize = 50;

/// The longest summary kept, in characters (then `…`).
pub const MAX_SUMMARY_CHARS: usize = 500;

/// Why a path is refused (followed by `: <paths>`).
pub const OUTSIDE: &str = "outside this session's folders";

/// Why [`open`] / [`clear`] is refused for a session with no request.
pub const NO_REQUEST: &str = "no review request for this session";

/// Why [`open`] is refused for a request that was replaced since the operator saw it.
pub const REPLACED: &str = "the review request was replaced; open the new one";

/// One listed path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPath {
    /// The resolved absolute path (as named, `.` and `..` resolved).
    pub path: String,
    /// What the pane shows: the path relative to the session's folder (with `/`), or the
    /// absolute path when it lies outside it (an add-dir, the project folder of a worktree).
    pub display: String,
    /// Nothing exists at the path (checked at the request and again at each open).
    pub missing: bool,
}

/// A session's last review request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub session_id: String,
    /// The session's name as its peers know it, at the time of the request.
    pub name: String,
    pub summary: String,
    /// The session's folder (its cwd), the paths' base; empty when it is not known (a request
    /// with no paths).
    pub root: String,
    pub paths: Vec<ReviewPath>,
    /// When it was requested, ISO 8601 UTC.
    pub at: String,
    /// Rises with every request (any session), so the UI tells a replacement from the request it
    /// showed, and the newest from the rest.
    pub seq: u64,
    /// The node shows the `review` flag (until the review is opened or the flag cleared).
    pub flagged: bool,
}

#[derive(Debug, Default)]
struct Inner {
    requests: HashMap<String, ReviewRequest>,
    next_seq: u64,
}

/// Every session's review request (in `AppState`). Memory only.
#[derive(Debug, Default)]
pub struct Reviews {
    inner: Mutex<Inner>,
    /// Held across a change and its emit (taken before `inner`, never inside it), so the events go
    /// out in the order of the changes while `inner` is free during the emit.
    emitting: Mutex<()>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl Reviews {
    /// `{sessionId: request}` for every session with a request.
    pub fn snapshot(&self) -> BTreeMap<String, ReviewRequest> {
        map(&lock(&self.inner))
    }

    /// Whether session `id`'s node shows the review flag.
    pub fn flagged(&self, id: &str) -> bool {
        lock(&self.inner).requests.get(id).is_some_and(|r| r.flagged)
    }

    /// Session `id`'s request, if it has one.
    pub fn get(&self, id: &str) -> Option<ReviewRequest> {
        lock(&self.inner).requests.get(id).cloned()
    }
}

fn map(inner: &Inner) -> BTreeMap<String, ReviewRequest> {
    inner.requests.iter().map(|(id, r)| (id.clone(), r.clone())).collect()
}

/// Apply `change` to the store and emit the map when it says something changed: the change and
/// the snapshot under `inner`, the emit after `inner` is released (under `emitting`).
fn change<R: Runtime, T>(app: &AppHandle<R>, change: impl FnOnce(&mut Inner) -> (T, bool)) -> T {
    let state = app.state::<AppState>();
    let _order = lock(&state.review.emitting);
    let (out, snapshot) = {
        let mut inner = lock(&state.review.inner);
        let (out, changed) = change(&mut inner);
        (out, changed.then(|| map(&inner)))
    };
    if let Some(snapshot) = snapshot
        && let Err(err) = app.emit(EVENT, snapshot)
    {
        eprintln!("review: emit failed: {err}");
    }
    out
}

/// `text` without control characters, U+2028 / U+2029 and the bidi embeddings, overrides and
/// isolates (U+202A–U+202E, U+2066–U+2069), trimmed.
fn strip(text: &str) -> String {
    text.chars()
        .filter(|c| !(c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')))
        .collect::<String>()
        .trim()
        .to_string()
}

/// A summary as stored: [`strip`]ped and cut to [`MAX_SUMMARY_CHARS`] (then `…`).
pub fn clean_summary(raw: &str) -> String {
    crate::claude::hooks::cut(&strip(raw), MAX_SUMMARY_CHARS)
}

/// `path` with `.` and `..` resolved lexically (a `..` at the root stays at the root). Nothing on
/// disk is touched.
pub fn normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `wanted` resolved against `cwd` (a relative path) and normalised; `None` when the result is
/// not rooted (a drive-relative `C:foo` on Windows).
pub fn resolve(cwd: &str, wanted: &str) -> Option<PathBuf> {
    let joined = Path::new(cwd).join(wanted);
    let path = normalise(&joined);
    path.has_root().then_some(path)
}

/// Where `path` (normalised) really is: its deepest existing ancestor (itself included)
/// canonicalised, symlinks and junctions followed, with the rest appended. Existence is checked;
/// contents are never read. Unchanged when no ancestor can be canonicalised.
pub fn real_location(path: &Path) -> PathBuf {
    let mut base = path;
    let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        if base.exists()
            && let Ok(real) = dunce::canonicalize(base)
        {
            let mut out = real;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (base.parent(), base.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name);
                base = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// What the pane shows for `path` (resolved): relative to `root` with `/` between the parts
/// (`.` for the folder itself) when it lies within it, else the absolute path.
pub fn display_path(path: &Path, root: &str) -> String {
    let text = path.display().to_string();
    let root = normalise(Path::new(root));
    if root.as_os_str().is_empty() || !graph::path_within(&text, &root.display().to_string()) {
        return text;
    }
    let skip = root.components().count();
    let rest: Vec<String> = path.components().skip(skip).map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    if rest.is_empty() { ".".to_string() } else { rest.join("/") }
}

/// The folders session `id` may name: its cwd, its worktree, its project folder and its
/// add-dirs. `Err` when its cwd is not known.
fn folders(state: &AppState, id: &str, cwd: Option<String>) -> Result<(String, Vec<String>), String> {
    let cwd = cwd.ok_or_else(|| "this session's folder is not known".to_string())?;
    let facts = crate::mcp::session_facts(state, id);
    let mut roots = vec![cwd.clone()];
    if let Some(facts) = &facts {
        roots.extend(facts.worktree_path());
        roots.extend(facts.project_path());
    }
    roots.extend(crate::mcp::add_dir_paths(state, id));
    let roots = roots.into_iter().filter(|r| !r.trim().is_empty()).map(|r| r.trim().to_string()).collect();
    Ok((cwd, roots))
}

/// The paths of a request checked against `roots`: each resolved against `cwd` and checked at its
/// real location against the roots' real locations; listed once. `Err` names every path outside
/// the roots (as given).
pub fn check_paths(cwd: &str, roots: &[String], wanted: &[String]) -> Result<Vec<ReviewPath>, String> {
    let real_roots: Vec<String> = roots.iter().map(|r| real_location(&normalise(Path::new(r))).display().to_string()).collect();
    let mut outside = Vec::new();
    let mut out: Vec<ReviewPath> = Vec::new();
    for raw in wanted {
        let inside = resolve(cwd, raw).filter(|p| {
            let real = real_location(p).display().to_string();
            real_roots.iter().any(|root| graph::path_within(&real, root))
        });
        let Some(path) = inside else {
            outside.push(raw.clone());
            continue;
        };
        let text = path.display().to_string();
        if out.iter().any(|p| graph::same_path(&p.path, &text)) {
            continue;
        }
        out.push(ReviewPath {
            display: display_path(&path, cwd),
            missing: !path.exists(),
            path: text,
        });
    }
    if outside.is_empty() { Ok(out) } else { Err(format!("{OUTSIDE}: {}", outside.join(", "))) }
}

/// The arguments of `request_review`: the cleaned summary and the cleaned paths.
fn arguments(args: &Value) -> Result<(String, Vec<String>), String> {
    let summary = match args.get("summary") {
        Some(Value::String(text)) => clean_summary(text),
        None | Some(Value::Null) => String::new(),
        Some(_) => return Err("summary must be a string".to_string()),
    };
    if summary.is_empty() {
        return Err("summary is required".to_string());
    }
    let paths = match args.get("paths") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(list)) => {
            let mut paths = Vec::with_capacity(list.len());
            for item in list {
                match item.as_str().map(strip) {
                    Some(path) if !path.is_empty() => paths.push(path),
                    _ => return Err("paths must be non-empty strings".to_string()),
                }
            }
            paths
        }
        Some(_) => return Err("paths must be an array of strings".to_string()),
    };
    if paths.len() > MAX_PATHS {
        return Err(format!("at most {MAX_PATHS} paths"));
    }
    Ok((summary, paths))
}

/// `request_review({summary, paths?})`: no approval. Flags the caller's node (replacing an
/// earlier request of it), emits the map and, while the window is not focused, sends the OS
/// notification. Returns `{flagged: true, paths: N}`.
pub fn request_review<R: Runtime>(app: &AppHandle<R>, caller: &str, args: &Value) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let (summary, wanted) = arguments(args)?;
    let facts = crate::mcp::session_facts(&state, caller).ok_or_else(|| "this session is not on the canvas".to_string())?;
    let (root, paths) = if wanted.is_empty() {
        (facts.cwd().unwrap_or_default(), Vec::new())
    } else {
        let (cwd, roots) = folders(&state, caller, facts.cwd())?;
        let paths = check_paths(&cwd, &roots, &wanted)?;
        (cwd, paths)
    };
    let name = graph::name_peers(&state, vec![(caller.to_string(), None)])
        .into_iter()
        .next()
        .map_or_else(|| caller.to_string(), |p| p.name);
    let count = paths.len();
    let at = crate::claude::transcript::format_iso_ms(crate::claude::live::now_ms());
    change(app, |inner| {
        inner.next_seq += 1;
        let request = ReviewRequest {
            session_id: caller.to_string(),
            name: name.clone(),
            summary: summary.clone(),
            root,
            paths,
            at,
            seq: inner.next_seq,
            flagged: true,
        };
        inner.requests.insert(caller.to_string(), request);
        ((), true)
    });
    crate::notify::on_review(app, caller, &name, &summary);
    Ok(json!({ "flagged": true, "paths": count }))
}

/// The operator opens session `id`'s review, request `seq` (the one the UI showed): the flag goes,
/// the `missing` marks are checked again (outside the store's lock), and the request comes back for
/// the pane. `Err` for a session with no request, or one replaced since (nothing changes then).
pub fn open<R: Runtime>(app: &AppHandle<R>, id: &str, seq: u64) -> Result<ReviewRequest, String> {
    let state = app.state::<AppState>();
    let paths = {
        let inner = lock(&state.review.inner);
        let request = inner.requests.get(id).ok_or_else(|| NO_REQUEST.to_string())?;
        if request.seq != seq {
            return Err(REPLACED.to_string());
        }
        request.paths.iter().map(|p| p.path.clone()).collect::<Vec<_>>()
    };
    let missing: Vec<bool> = paths.iter().map(|p| !Path::new(p).exists()).collect();
    change(app, |inner| {
        let Some(request) = inner.requests.get_mut(id) else {
            return (Err(NO_REQUEST.to_string()), false);
        };
        if request.seq != seq {
            return (Err(REPLACED.to_string()), false);
        }
        request.flagged = false;
        for (path, missing) in request.paths.iter_mut().zip(missing) {
            path.missing = missing;
        }
        (Ok(request.clone()), true)
    })
}

/// "Clear review flag": session `id`'s flag goes without opening the review, when `seq` is still
/// its request (a replacement the operator never saw keeps its flag). `Err` for a session with no
/// request.
pub fn clear<R: Runtime>(app: &AppHandle<R>, id: &str, seq: u64) -> Result<(), String> {
    change(app, |inner| {
        let Some(request) = inner.requests.get_mut(id) else {
            return (Err(NO_REQUEST.to_string()), false);
        };
        let lower = request.seq == seq && request.flagged;
        if lower {
            request.flagged = false;
        }
        (Ok(()), lower)
    })
}

// -- Story 8.1: the diff pane's targets ------------------------------------------------------

/// What the Review pane reviews (Story 8.1): a project's folder, a branch's linked worktree, or a
/// session's cwd. The UI names the node; Rust finds the folder (never a path from the UI).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ReviewTarget {
    Project { project_id: String },
    Branch { project_id: String, branch: String },
    Session { session_id: String },
}

/// Why a branch cannot be reviewed: it has no linked worktree.
pub const NO_WORKTREE: &str = "no worktree";

/// Why the checked-out branch cannot be reviewed on its own: its folder is the project's.
pub const CHECKED_OUT: &str = "no worktree: the branch is checked out in the project's folder; review the project";

/// Why a session cannot be reviewed: its folder is not known.
pub const NO_FOLDER: &str = "this session's folder is not known";

/// Why a target cannot be reviewed: its folder is gone.
pub const FOLDER_MISSING: &str = "folder missing";

/// The folder a branch is reviewed in, from the project's latest branch list (Story 5.3's
/// resolution): its linked worktree; the checked-out branch and a branch without a worktree are
/// refused ([`CHECKED_OUT`], [`NO_WORKTREE`]), as is an unknown branch or a missing worktree.
pub fn branch_folder(list: Option<&[crate::git::BranchInfo]>, branch: &str) -> Result<String, String> {
    match crate::claude::launch::resolve_branch(list, branch)? {
        crate::claude::launch::BranchTarget::Worktree(folder) => Ok(folder),
        crate::claude::launch::BranchTarget::ProjectFolder => Err(CHECKED_OUT.to_string()),
        crate::claude::launch::BranchTarget::NeedsWorktree => Err(NO_WORKTREE.to_string()),
    }
}

/// The folder `target` reviews, canonical. `Err` for an unknown project, a refused branch, a
/// session whose folder is not known, or a folder that is gone.
pub fn target_folder(state: &AppState, target: &ReviewTarget) -> Result<PathBuf, String> {
    let folder = match target {
        ReviewTarget::Project { project_id } => state
            .read_workspace()
            .workspace
            .projects
            .iter()
            .find(|p| &p.id == project_id)
            .map(|p| p.path.clone())
            .ok_or_else(|| "unknown project".to_string())?,
        ReviewTarget::Branch { project_id, branch } => {
            let list = state.read_workspace().branches.get(project_id).cloned();
            branch_folder(list.as_deref(), branch)?
        }
        ReviewTarget::Session { session_id } => crate::mcp::session_facts(state, session_id)
            .and_then(|facts| facts.cwd())
            .filter(|cwd| !cwd.trim().is_empty())
            .ok_or_else(|| NO_FOLDER.to_string())?,
    };
    let path = Path::new(folder.trim());
    if !path.is_dir() {
        return Err(FOLDER_MISSING.to_string());
    }
    Ok(dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()))
}

/// Why vs base and Commits are refused for a session (Story 8.2).
pub const NO_RANGE: &str = "vs base and Commits are for project and branch nodes";

/// Where vs base and Commits read `target` (Story 8.2): the project's folder (canonical) and the
/// branch, `None` for a project (the branch checked out in its folder, which git names). Unlike
/// [`branch_folder`], a branch needs no worktree: its commits are read from the repository. `Err`
/// for an unknown project, a session ([`NO_RANGE`]) or a folder that is gone.
pub fn range_target(state: &AppState, target: &ReviewTarget) -> Result<(PathBuf, Option<String>), String> {
    let (project_id, branch) = match target {
        ReviewTarget::Project { project_id } => (project_id, None),
        ReviewTarget::Branch { project_id, branch } => (project_id, Some(branch.clone())),
        ReviewTarget::Session { .. } => return Err(NO_RANGE.to_string()),
    };
    let folder = state
        .read_workspace()
        .workspace
        .projects
        .iter()
        .find(|p| &p.id == project_id)
        .map(|p| p.path.clone())
        .ok_or_else(|| "unknown project".to_string())?;
    let path = Path::new(folder.trim());
    if !path.is_dir() {
        return Err(FOLDER_MISSING.to_string());
    }
    Ok((dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()), branch))
}

// -- Story 8.3: Files mode and `o` -----------------------------------------------------------

/// The Review pane's mode, as `o` (Open in editor) names it (Story 8.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewMode {
    Changes,
    Files,
    Base,
    Commits,
}

/// Why `o` is refused in vs base or Commits for a branch with no worktree, not checked out in the
/// project's folder.
pub const NOT_CHECKED_OUT: &str = "this branch is not checked out anywhere";

/// Where `o` finds a vs base / Commits path for a branch (paths relative to the project's folder,
/// which sits at `prefix` in its repository): its linked worktree (at the same `prefix`), else the
/// project's folder when the branch is checked out there; else [`NOT_CHECKED_OUT`].
pub fn branch_editor_folder(resolved: crate::claude::launch::BranchTarget, project_folder: &Path, prefix: &str) -> Result<PathBuf, String> {
    match resolved {
        crate::claude::launch::BranchTarget::Worktree(folder) => {
            let mut path = PathBuf::from(folder);
            for part in prefix.split('/').filter(|p| !p.is_empty()) {
                path.push(part);
            }
            Ok(path)
        }
        crate::claude::launch::BranchTarget::ProjectFolder => Ok(project_folder.to_path_buf()),
        crate::claude::launch::BranchTarget::NeedsWorktree => Err(NOT_CHECKED_OUT.to_string()),
    }
}

/// The folder whose files `o` opens for `target` in `mode` (the paths the pane shows are relative
/// to it): in Changes and Files the reviewed folder ([`target_folder`]); in vs base and Commits the
/// file in the branch's checkout ([`branch_editor_folder`]; a project's branch is the one checked
/// out in its folder).
pub fn editor_folder(state: &AppState, git_bin: &Path, target: &ReviewTarget, mode: ReviewMode) -> Result<PathBuf, String> {
    match (mode, target) {
        (ReviewMode::Changes | ReviewMode::Files, _) | (_, ReviewTarget::Session { .. }) => target_folder(state, target),
        (_, ReviewTarget::Project { .. }) => range_target(state, target).map(|(folder, _)| folder),
        (_, ReviewTarget::Branch { project_id, branch }) => {
            let (project_folder, _) = range_target(state, target)?;
            let list = state.read_workspace().branches.get(project_id).cloned();
            // A branch the last branch read does not list yet has no known checkout either.
            let resolved = crate::claude::launch::resolve_branch(list.as_deref(), branch).map_err(|err| {
                if err == crate::claude::launch::BRANCH_NOT_FOUND { NOT_CHECKED_OUT.to_string() } else { err }
            })?;
            let prefix = match &resolved {
                crate::claude::launch::BranchTarget::Worktree(_) => crate::git::range::prefix(git_bin, &project_folder)?,
                _ => String::new(),
            };
            branch_editor_folder(resolved, &project_folder, &prefix)
        }
    }
}

/// Whether `path` really lies inside `folder` (7.4's check): both at their real location, links
/// and junctions followed, so a link inside the folder that points elsewhere is outside.
pub fn within(path: &Path, folder: &Path) -> bool {
    let real = real_location(&normalise(path)).display().to_string();
    let root = real_location(&normalise(folder)).display().to_string();
    graph::path_within(&real, &root)
}

/// A review request's paths keyed to the reviewed `folder` (Story 8.1): each path's real location
/// relative to the folder's, with `/` (`""` for the folder itself), comparable with the list's
/// paths; a path outside the folder has no key and is `outside`. `missing` is checked again.
pub fn request_keys(folder: &Path, paths: &[ReviewPath]) -> Vec<crate::git::diff::RequestedKey> {
    let root = real_location(&normalise(folder));
    paths
        .iter()
        .map(|p| {
            let real = real_location(&normalise(Path::new(&p.path)));
            let key = graph::path_within(&real.display().to_string(), &root.display().to_string()).then(|| {
                real.components()
                    .skip(root.components().count())
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/")
            });
            crate::git::diff::RequestedKey {
                display: p.display.clone(),
                outside: key.is_none(),
                key,
                missing: !Path::new(&p.path).exists(),
            }
        })
        .collect()
}

/// Sessions removed from the workspace (their ref, or their project): their requests go, and the
/// map is emitted.
pub fn forget_sessions<'a, R: Runtime>(app: &AppHandle<R>, ids: impl IntoIterator<Item = &'a str>) {
    change(app, |inner| {
        let mut removed = false;
        for id in ids {
            removed |= inner.requests.remove(id).is_some();
        }
        ((), removed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_summary_is_cleaned_and_cut() {
        assert_eq!(clean_summary("  token\u{2028} refresh\n done\u{202E} \u{1b}[2J "), "token refresh done [2J");
        let long = clean_summary(&"x".repeat(900));
        assert_eq!(long.chars().count(), MAX_SUMMARY_CHARS + 1);
        assert!(long.ends_with('…'));
        assert_eq!(clean_summary(" \n\t "), "");
    }

    #[test]
    fn a_review_target_names_a_node_never_a_path() {
        let target: ReviewTarget = serde_json::from_value(json!({ "kind": "branch", "projectId": "p1", "branch": "feat" })).unwrap();
        assert_eq!(target, ReviewTarget::Branch { project_id: "p1".into(), branch: "feat".into() });
        let target: ReviewTarget = serde_json::from_value(json!({ "kind": "session", "sessionId": "s1" })).unwrap();
        assert_eq!(target, ReviewTarget::Session { session_id: "s1".into() });
        assert!(serde_json::from_value::<ReviewTarget>(json!({ "kind": "path", "path": "/etc" })).is_err());
    }

    #[test]
    fn a_branch_is_reviewed_in_its_worktree_only() {
        let dir = tempfile::tempdir().unwrap();
        let info = |name: &str, head: bool, worktree: Option<(String, bool)>| crate::git::BranchInfo {
            name: name.into(),
            head,
            upstream: None,
            ahead: 0,
            behind: 0,
            gone: false,
            committed_at: 0,
            worktree: worktree.map(|(path, missing)| crate::git::WorktreeChip { path, missing }),
        };
        let wt = dir.path().display().to_string();
        let list = vec![
            info("main", true, None),
            info("feat", false, Some((wt.clone(), false))),
            info("bare", false, None),
            info("lost", false, Some((format!("{wt}/gone"), true))),
        ];
        assert_eq!(branch_folder(Some(&list), "feat"), Ok(dunce::canonicalize(dir.path()).unwrap().display().to_string()));
        assert_eq!(branch_folder(Some(&list), "main"), Err(CHECKED_OUT.to_string()));
        assert_eq!(branch_folder(Some(&list), "bare"), Err(NO_WORKTREE.to_string()));
        assert_eq!(branch_folder(Some(&list), "lost"), Err(crate::claude::launch::WORKTREE_MISSING.to_string()));
        assert_eq!(branch_folder(Some(&list), "nope"), Err(crate::claude::launch::BRANCH_NOT_FOUND.to_string()));
    }

    #[test]
    fn o_in_vs_base_opens_the_branch_checkout_or_is_refused() {
        use crate::claude::launch::BranchTarget;
        let project = if cfg!(windows) { "C:\\w\\api" } else { "/w/api" };
        let wt = if cfg!(windows) { "C:\\w\\api-feat" } else { "/w/api-feat" };
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(branch_editor_folder(BranchTarget::Worktree(wt.into()), Path::new(project), ""), Ok(PathBuf::from(wt)));
        assert_eq!(
            branch_editor_folder(BranchTarget::Worktree(wt.into()), Path::new(project), "web/app/").unwrap().display().to_string(),
            format!("{wt}{sep}web{sep}app")
        );
        assert_eq!(branch_editor_folder(BranchTarget::ProjectFolder, Path::new(project), "web/"), Ok(PathBuf::from(project)));
        assert_eq!(branch_editor_folder(BranchTarget::NeedsWorktree, Path::new(project), ""), Err(NOT_CHECKED_OUT.to_string()));
        let mode: ReviewMode = serde_json::from_value(json!("files")).unwrap();
        assert_eq!(mode, ReviewMode::Files);
        assert_eq!(serde_json::from_value::<ReviewMode>(json!("base")).unwrap(), ReviewMode::Base);
    }

    #[test]
    fn within_checks_the_real_location() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let folder = base.join("repo");
        std::fs::create_dir_all(folder.join("src")).unwrap();
        assert!(within(&folder.join("src/a.ts"), &folder));
        assert!(within(&folder.join("src/../b.ts"), &folder));
        assert!(!within(&folder.join("../other/x"), &folder));
        assert!(!within(&base.join("repository/x"), &folder), "a sibling sharing the prefix");
    }

    #[test]
    fn request_paths_are_keyed_to_the_reviewed_folder() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let folder = base.join("repo");
        std::fs::create_dir_all(folder.join("src")).unwrap();
        std::fs::write(folder.join("src").join("a.ts"), "a").unwrap();
        let path = |p: &Path, display: &str| ReviewPath { path: p.display().to_string(), display: display.into(), missing: false };
        let keys = request_keys(
            &folder,
            &[
                path(&folder.join("src").join("a.ts"), "src/a.ts"),
                path(&folder.join("src").join("gone.ts"), "src/gone.ts"),
                path(&folder, "."),
                path(&base.join("other").join("x.md"), "/elsewhere/x.md"),
            ],
        );
        let got: Vec<_> = keys.iter().map(|k| (k.display.as_str(), k.key.as_deref(), k.missing, k.outside)).collect();
        assert_eq!(
            got,
            [
                ("src/a.ts", Some("src/a.ts"), false, false),
                ("src/gone.ts", Some("src/gone.ts"), true, false),
                (".", Some(""), false, false),
                ("/elsewhere/x.md", None, true, true),
            ]
        );
    }

    #[test]
    fn paths_are_cleaned_like_the_summary() {
        let (_, paths) = arguments(&json!({ "summary": "s", "paths": [" src/\u{202E}a\u{2066}.ts\u{2028}\n", "b\u{7}.ts"] })).unwrap();
        assert_eq!(paths, ["src/a.ts", "b.ts"]);
        assert_eq!(arguments(&json!({ "summary": "s", "paths": ["\u{202E}\n"] })), Err("paths must be non-empty strings".to_string()));
    }

    #[test]
    fn paths_resolve_lexically_and_never_climb_past_the_root() {
        let sep = std::path::MAIN_SEPARATOR;
        let root = if cfg!(windows) { "C:\\w\\api" } else { "/w/api" };
        let got = resolve(root, "src/./auth/../auth/refresh.ts").unwrap();
        assert_eq!(got.display().to_string(), format!("{root}{sep}src{sep}auth{sep}refresh.ts"));
        assert_eq!(display_path(&got, root), "src/auth/refresh.ts");
        assert_eq!(display_path(&resolve(root, ".").unwrap(), root), ".");
        let up = resolve(root, "../../../../etc").unwrap();
        assert!(!graph::path_within(&up.display().to_string(), root));
        assert_eq!(up.components().count(), if cfg!(windows) { 3 } else { 2 }, "stops at the root: {}", up.display());
        if cfg!(windows) {
            assert!(resolve(root, "D:foo").is_none(), "a drive-relative path is not rooted");
            assert_eq!(resolve(root, "C:/Windows/win.ini").unwrap().display().to_string(), "C:\\Windows\\win.ini");
        }
    }

    #[test]
    fn a_path_outside_every_folder_refuses_the_whole_call() {
        let cwd = if cfg!(windows) { "C:\\w\\api-feat" } else { "/w/api-feat" };
        let other = if cfg!(windows) { "C:\\w\\docs" } else { "/w/docs" };
        let roots = vec![cwd.to_string(), other.to_string()];
        let ok = check_paths(cwd, &roots, &["a.ts".into(), format!("{other}/x.md"), "./a.ts".into()]).unwrap();
        assert_eq!(ok.len(), 2, "listed once");
        assert_eq!(ok[0].display, "a.ts");
        assert!(ok[0].missing);
        assert_eq!(ok[1].display, normalise(Path::new(&format!("{other}/x.md"))).display().to_string(), "outside the cwd: absolute");
        let outside = if cfg!(windows) { "C:/Windows/win.ini" } else { "/etc/passwd" };
        assert_eq!(
            check_paths(cwd, &roots, &["a.ts".into(), outside.into(), "../api/x".into()]),
            Err(format!("{OUTSIDE}: {outside}, ../api/x"))
        );
        // `/w/api-feature` is not inside `/w/api-feat`.
        assert!(check_paths(cwd, &roots, &[format!("{cwd}ure/x")]).is_err());
    }

    /// A link inside the cwd that points outside is outside, whether or not its target exists;
    /// a link pointing inside another allowed folder is fine. Skipped where links cannot be made.
    #[test]
    fn a_link_inside_the_cwd_pointing_outside_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let cwd = base.join("web");
        let outside = base.join("secret");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("key.txt"), "k").unwrap();
        let link = cwd.join("out");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&outside, &link).is_ok()
            || std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .output()
                .is_ok_and(|o| o.status.success());
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(&outside, &link).is_ok();
        if !made {
            eprintln!("skipped: cannot create a link here");
            return;
        }
        let cwd_text = cwd.display().to_string();
        let roots = vec![cwd_text.clone()];
        for wanted in ["out/key.txt", "out/missing.txt", "out"] {
            assert_eq!(check_paths(&cwd_text, &roots, &[wanted.to_string()]), Err(format!("{OUTSIDE}: {wanted}")), "{wanted}");
        }
        // The same link with its target allowed too.
        let both = vec![cwd_text.clone(), outside.display().to_string()];
        let ok = check_paths(&cwd_text, &both, &["out/key.txt".to_string()]).unwrap();
        assert_eq!((ok[0].display.as_str(), ok[0].missing), ("out/key.txt", false));
    }
}
