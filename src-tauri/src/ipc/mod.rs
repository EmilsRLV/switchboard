//! Tauri IPC commands. Each command is thin: validate, then delegate.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_opener::OpenerExt;

use crate::claude::hooks::{self, DiagnosticsSnapshot};
use crate::claude::launch::{self, LaunchPrefill, LaunchRequest};
use crate::claude::live::{self, LiveSnapshot};
use crate::claude::live_edges;
use crate::claude::{self, ClaudeProject};
use crate::git::{self, ProjectStatus};
use crate::graph::{self, AddProjectsResult, Edge, NodeRef, NodeTarget, Position, Viewport, WorkspaceSnapshot};
use crate::process;
use crate::pty::{self, EventSink, SessionHooks, SpawnSpec, TermBuffer, TermInfo, TermKind};
use crate::settings::detect::Search;
use crate::settings::{self, AppState, Snapshot};
use crate::windows;

/// The notice behind "Open in external editor" when `settings.external_editor` is unset.
pub const NO_EDITOR: &str = "No external editor configured — set external_editor in settings";

/// The folder picker's title unless the caller names one (the launch sheet's add-dir picker
/// says "Add folder for this session").
pub const PICK_FOLDER_TITLE: &str = "Add project folder";

/// The notice behind "Reveal Claude project dir" when discovery knows no dir for the folder.
pub const NO_CLAUDE_DIR: &str = "No Claude project directory for this folder";

/// Identity of the running app, as the Cargo package declares it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

/// Report the app name and version so the UI can prove the IPC round trip.
#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME").to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// The current settings snapshot: file path, effective settings, detected binaries, banners.
#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Snapshot {
    state.read().snapshot()
}

/// Open the config folder in the OS file manager with `settings.json` selected; when the
/// file is gone but its folder exists, open the folder (that is where the operator wants to
/// be to recreate it).
#[tauri::command]
pub fn settings_reveal<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> Result<(), String> {
    let path = state
        .read()
        .path
        .clone()
        .ok_or_else(|| "settings file location is unknown".to_string())?;
    let opener = app.opener();
    if path.is_file() {
        opener.reveal_item_in_dir(&path)
    } else if let Some(dir) = path.parent().filter(|d| d.is_dir()) {
        opener.open_path(dir.display().to_string(), None::<&str>)
    } else {
        return Err(format!("{} does not exist", path.display()));
    }
    .map_err(|err| err.to_string())
}

/// Re-run binary detection (`claude`, `git`). Also emits `settings://changed`.
#[tauri::command]
pub async fn binaries_redetect<R: Runtime>(app: AppHandle<R>) -> Snapshot {
    settings::redetect(app).await
}

/// The current workspace snapshot: file path, workspace (viewport, nodes, edges), banners.
#[tauri::command]
pub fn workspace_get(state: State<'_, AppState>) -> WorkspaceSnapshot {
    state.read_workspace().snapshot()
}

/// Persist a new canvas viewport (end of a pan/zoom gesture or Fit view). Writes
/// `workspace.json` atomically and emits `workspace://changed`; replies with the snapshot.
/// Async so the fsync + rename run on the async runtime, not the main thread.
#[tauri::command]
pub async fn workspace_set_viewport<R: Runtime>(app: AppHandle<R>, viewport: Viewport) -> WorkspaceSnapshot {
    graph::set_viewport(&app, viewport)
}

/// Open the native folder picker (the `project.add` command, `ctrl+o`) and reply with the
/// chosen folder, or `None` when the operator cancelled. The dialog blocks its own thread
/// only: it runs inside `spawn_blocking` on the async runtime, never on the main thread.
/// Under `cfg(test)` (no dialog plugin on the mock app) it replies `None` at once.
#[tauri::command]
pub async fn project_pick_folder<R: Runtime>(app: AppHandle<R>, title: Option<String>) -> Result<Option<String>, String> {
    if cfg!(test) {
        return Ok(None);
    }
    use tauri_plugin_dialog::DialogExt;
    let title = title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| PICK_FOLDER_TITLE.to_string());
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title(title);
        // Parented to the main window: modal to it, centred on it, never behind it.
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        dialog.blocking_pick_folder()
    })
    .await
    .map_err(|err| err.to_string())?;
    match picked {
        None => Ok(None),
        Some(file) => file
            .into_path()
            .map(|path| Some(path.display().to_string()))
            .map_err(|err| err.to_string()),
    }
}

/// Add folders as project nodes at `position` (fanned out when several). Delegates to
/// `graph::add_projects` on a blocking thread (it canonicalises paths and writes the file);
/// when something was added, a git status pass over just those ids is kicked off so the new
/// cards fill in without waiting for the poll or re-polling the rest.
#[tauri::command]
pub async fn workspace_add_projects<R: Runtime>(
    app: AppHandle<R>,
    paths: Vec<String>,
    position: Position,
) -> Result<AddProjectsResult, String> {
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || graph::add_projects(&handle, &paths, position))
        .await
        .map_err(|err| err.to_string())??;
    if !result.added.is_empty() {
        let ids = result.added.clone();
        let sessions_app = app.clone();
        tauri::async_runtime::spawn(async move {
            git::poll::refresh_ids(&app, &ids).await;
        });
        // The new cards' sessions fill in now, not at the next 5 s tick.
        tauri::async_runtime::spawn(async move {
            claude::sessions::refresh(&sessions_app).await;
            // Live rows in the new folders leave the Elsewhere tray now.
            claude::live::refresh(&sessions_app).await;
        });
    }
    Ok(result)
}

/// Expand or collapse a project (`project.expand` / `project.collapse`). Rust stores
/// `expanded`, writes `workspace.json` and emits `workspace://changed`; replies with the
/// snapshot, or `Err("unknown project")`.
#[tauri::command]
pub async fn workspace_set_expanded<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    expanded: bool,
) -> Result<WorkspaceSnapshot, String> {
    graph::set_expanded(&app, &project_id, expanded)
}

/// The "branches" toggle (`project.toggleBranches`, Story 5.1): store `showBranches` (turning
/// it on expands a collapsed card), then start or stop the project's branch watch and, when
/// on, read its branch list now (the branch cards follow as a `workspace://changed`). Replies
/// with the snapshot, or `Err("unknown project")` with nothing changed.
#[tauri::command]
pub async fn project_set_show_branches<R: Runtime>(app: AppHandle<R>, project_id: String, show: bool) -> Result<WorkspaceSnapshot, String> {
    let snapshot = graph::set_show_branches(&app, &project_id, show)?;
    let watch_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let sync_app = watch_app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || git::watch::sync(&sync_app)).await;
        if show {
            git::poll::refresh_branches(&watch_app, Some(std::slice::from_ref(&project_id))).await;
        }
    });
    Ok(snapshot)
}

/// The "New worktree" sheet's preview (Story 5.2), read-only: the project's local branches,
/// the ones free for a worktree, the default base, and the exact `git worktree add` command and
/// folder [`git::worktree::plan_add`] resolves for `request` -- or why nothing would run. The
/// submit goes through the same plan, so the preview is what runs. `Err` for an unknown
/// project, a folder that is not a repository, or a git that cannot run.
#[tauri::command]
pub async fn worktree_preview<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    request: git::worktree::WorktreeRequest,
) -> Result<git::worktree::WorktreePreview, String> {
    let state = app.state::<AppState>();
    let path = project_path(&state, &project_id)?;
    let (git_bin, root) = {
        let settings = state.read();
        (git::poll::git_binary(&settings), settings.settings.worktrees_root.clone())
    };
    blocking(move || git::worktree::preview(&git_bin, Path::new(&path), root.as_deref(), &request)).await?
}

/// What `worktree_add` replies: the snapshot once the branches were re-read, and the new
/// branch card's id (`<projectId>:<name>`) for the UI to select.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAdded {
    pub snapshot: WorkspaceSnapshot,
    pub branch_id: String,
}

/// Create a worktree (Story 5.2) on the sheet's explicit submit: under the project's branch
/// lock, plan (read-only checks; any refusal is the `Err` and nothing runs) and run
/// `git worktree add [-b <new>] <path> <base|branch>` from the project folder (30 s timeout;
/// git's first stderr line is the `Err`). Then the branch is recorded with its worktree path
/// (`graph::upsert_created_branch`), the project's branches are turned on when they were off
/// (which expands the card and starts the watch), and the list is re-read, so the reply's
/// snapshot already holds the new card and its chip. The status is re-polled too, so the dirty
/// count leaves the new worktree out at once.
#[tauri::command]
pub async fn worktree_add<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    request: git::worktree::WorktreeRequest,
) -> Result<WorktreeAdded, String> {
    add_worktree(&app, &project_id, &request).await.map(|(added, _)| added)
}

/// The work of [`worktree_add`], shared with a branch launch's "Create worktree here" (Story
/// 5.3): the reply and the new worktree's canonical path.
async fn add_worktree<R: Runtime>(
    app: &AppHandle<R>,
    project_id: &str,
    request: &git::worktree::WorktreeRequest,
) -> Result<(WorktreeAdded, String), String> {
    let (app, project_id, request) = (app.clone(), project_id.to_string(), request.clone());
    let state = app.state::<AppState>();
    let path = project_path(&state, &project_id)?;
    let (git_bin, root) = {
        let settings = state.read();
        (git::poll::git_binary(&settings), settings.settings.worktrees_root.clone())
    };
    let (name, worktree) = {
        let lock = state.branch_locks.of(&project_id);
        let _project = lock.lock().await;
        blocking(move || {
            let folder = Path::new(&path);
            let plan = git::worktree::plan_add(&git_bin, folder, root.as_deref(), &request)?;
            let made = git::worktree::add(&git_bin, folder, &plan)?;
            Ok::<_, String>((plan.branch, made))
        })
        .await??
    };
    // The worktree exists now: what follows is bookkeeping, and a failure there (the project
    // removed meanwhile) is logged, not reported as a refusal.
    if let Err(err) = graph::upsert_created_branch(&app, &project_id, &name, &worktree) {
        eprintln!("worktree: created {worktree} but could not record branch {name}: {err}");
    }
    let branches_on = state
        .read_workspace()
        .workspace
        .projects
        .iter()
        .any(|p| p.id == project_id && p.show_branches);
    // On (and expanded, so the new card shows); a no-op when both already are.
    if let Err(err) = graph::set_show_branches(&app, &project_id, true) {
        eprintln!("worktree: created {worktree} but could not turn branches on: {err}");
    }
    if !branches_on {
        let watch_app = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || git::watch::sync(&watch_app)).await;
    }
    git::poll::refresh_branches(&app, Some(std::slice::from_ref(&project_id))).await;
    let status_app = app.clone();
    let status_id = project_id.clone();
    tauri::async_runtime::spawn(async move {
        git::poll::refresh_ids(&status_app, &[status_id]).await;
    });
    let added = WorktreeAdded {
        snapshot: state.read_workspace().snapshot(),
        branch_id: graph::branch_child_id(&project_id, &name),
    };
    Ok((added, worktree))
}

/// `(cwd, name)` of what may hold a worktree open (Story 5.4): every live session the poll or the
/// app knows (its name, else its id) and the folder each app terminal still running started in
/// (its title). A terminal that later changed folder, or another program, is not seen.
fn running_cwds(state: &AppState) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = state
        .read_sessions_live()
        .sessions
        .iter()
        .filter(|(_, s)| s.state.is_live())
        .map(|(id, s)| (s.cwd.clone(), s.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| id.clone())))
        .collect();
    out.extend(state.terms.list().into_iter().filter(|t| t.exited.is_none()).map(|t| (t.cwd, t.title)));
    out
}

/// The "Remove worktree" sheet's checks (Story 5.4), read-only: the worktree of `branch` that
/// git lists for the project, whether it is missing, locked, dirty (the count from `git status`
/// inside it) or held by a live session or a running terminal, and the exact commands Remove,
/// the force confirm and "Also delete branch" run ([`git::worktree::remove_check`]). `Err` for an
/// unknown project, a folder that is not a repository, or a branch without a linked worktree.
#[tauri::command]
pub async fn worktree_remove_preview<R: Runtime>(app: AppHandle<R>, project_id: String, branch: String) -> Result<git::worktree::RemoveCheck, String> {
    let state = app.state::<AppState>();
    let path = project_path(&state, &project_id)?;
    let git_bin = git::poll::git_binary(&state.read());
    let running = running_cwds(&state);
    blocking(move || git::worktree::remove_check(&git_bin, Path::new(&path), &branch, &running)).await?
}

/// What `worktree_remove` replies: the snapshot once the branches and status were re-read, and
/// how "Also delete branch" went (`deleteError` is git's refusal; the worktree stays removed).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoved {
    pub snapshot: WorkspaceSnapshot,
    pub branch_deleted: bool,
    pub delete_error: Option<String>,
}

/// Remove `branch`'s worktree on the sheet's explicit click (Story 5.4): under the project's
/// branch lock, the checks run again (a refusal -- locked, a live session -- is the `Err` and
/// nothing runs; so is a dirty worktree unless `force` comes with `dirty`, the count the second
/// confirm stated, and that is still the count); then `git worktree remove [--force] <path>` (a
/// missing folder too) runs from the project folder with a 30 s timeout (git's first stderr line
/// is the `Err`). Only once it succeeded is the worktree's path stored on its
/// [`graph::BranchNode`], so its past sessions keep their place. With `deleteBranch`,
/// `git branch -d <branch>` follows (never `-D`). The branches and status are re-read before
/// the reply.
#[tauri::command]
pub async fn worktree_remove<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    branch: String,
    force: bool,
    dirty: Option<u32>,
    delete_branch: Option<bool>,
) -> Result<WorktreeRemoved, String> {
    let state = app.state::<AppState>();
    let path = project_path(&state, &project_id)?;
    let git_bin = git::poll::git_binary(&state.read());
    let delete = delete_branch.unwrap_or(false);
    let delete_error = {
        let lock = state.branch_locks.of(&project_id);
        let _project = lock.lock().await;
        let running = running_cwds(&state);
        let (check_git, check_path, check_branch) = (git_bin.clone(), path.clone(), branch.clone());
        let check = blocking(move || git::worktree::remove_check(&check_git, Path::new(&check_path), &check_branch, &running)).await??;
        if let Some(refusal) = &check.refusal {
            return Err(refusal.clone());
        }
        let confirmed = if force { dirty } else { None };
        let removed_path = check.path.clone();
        let (run_git, run_path) = (git_bin.clone(), path.clone());
        blocking(move || git::worktree::run_remove(&run_git, Path::new(&run_path), &check, confirmed, git::worktree::REMOVE_TIMEOUT)).await??;
        // Removed: the path stays on the branch node as history, so the sessions stay listed
        // under it. The worktree is gone whatever this bookkeeping does.
        if let Err(err) = graph::upsert_created_branch(&app, &project_id, &branch, &removed_path) {
            eprintln!("worktree: removed {removed_path} but could not record it on branch {branch}: {err}");
        }
        if delete {
            let (run_git, run_path, run_branch) = (git_bin.clone(), path.clone(), branch.clone());
            blocking(move || git::worktree::delete_branch(&run_git, Path::new(&run_path), &run_branch).err()).await?
        } else {
            None
        }
    };
    git::poll::refresh_branches(&app, Some(std::slice::from_ref(&project_id))).await;
    git::poll::refresh_ids(&app, std::slice::from_ref(&project_id)).await;
    Ok(WorktreeRemoved {
        snapshot: state.read_workspace().snapshot(),
        branch_deleted: delete && delete_error.is_none(),
        delete_error,
    })
}

/// Store where a node was dropped (end of a drag). A project's position is absolute, a
/// child's relative to its parent card. Replies with the snapshot, or an `Err` for a
/// non-finite position or an unknown node.
#[tauri::command]
pub async fn workspace_move_node<R: Runtime>(
    app: AppHandle<R>,
    target: NodeTarget,
    position: Position,
) -> Result<WorkspaceSnapshot, String> {
    graph::move_node(&app, &target, position)
}

/// Draw an edge (Story 6.1): Rust picks the kind from the pair and refuses an invalid pair, a
/// duplicate or an unknown end with the notice to show (`"can't link a project to a session"`,
/// `"already linked"`, ...). Replies with the new edge; the snapshot follows as
/// `workspace://changed`.
///
/// Story 6.3: a context edge from a session running in a Switchboard terminal is applied to it
/// now (`/add-dir` once it is idle; its state follows on `edges://live`). Story 6.4: a cooperate
/// edge sends each end running in Switchboard one line naming the other.
#[tauri::command]
pub async fn edge_add<R: Runtime>(app: AppHandle<R>, from: NodeRef, to: NodeRef) -> Result<Edge, String> {
    let edge = graph::add_edge(&app, &from, &to)?;
    live_edges::edge_added(&app, &edge);
    Ok(edge)
}

/// Set an edge's label: trimmed, a blank one stored as `null`. Replies with the snapshot, or
/// `Err("unknown edge")`.
#[tauri::command]
pub async fn edge_set_label<R: Runtime>(app: AppHandle<R>, id: String, label: Option<String>) -> Result<WorkspaceSnapshot, String> {
    graph::set_edge_label(&app, &id, label.as_deref())
}

/// Delete an edge. Replies with the snapshot, or `Err("unknown edge")`. Its live state goes
/// too (Story 6.3); a folder already added to a running session stays until it restarts
/// (Claude has no `/remove-dir`).
#[tauri::command]
pub async fn edge_remove<R: Runtime>(app: AppHandle<R>, id: String) -> Result<WorkspaceSnapshot, String> {
    let snapshot = graph::remove_edge(&app, &id)?;
    live_edges::forget_edge(&app, &id);
    Ok(snapshot)
}

/// Story 7.2: set or clear an edge's `agentAllowed` (the inspector's Revoke clears it; the
/// approval toast's "Always for this edge" sets it from Rust). Replies with the snapshot, or
/// `Err("unknown edge")`.
#[tauri::command]
pub async fn edge_set_agent_allowed<R: Runtime>(app: AppHandle<R>, id: String, allowed: bool) -> Result<WorkspaceSnapshot, String> {
    graph::set_edge_agent_allowed(&app, &id, allowed)
}

/// Story 7.2: the workspace's policy for the agents' act tools (`ask` / `allowAll`, the palette's
/// "Agent actions: allow all" / "Agent actions: ask"). Persisted; replies with the snapshot.
#[tauri::command]
pub async fn workspace_set_agent_actions<R: Runtime>(app: AppHandle<R>, mode: graph::AgentActions) -> WorkspaceSnapshot {
    graph::set_agent_actions(&app, mode)
}

/// Story 7.2: the agents' act-tool requests waiting on the operator, oldest first
/// (`approvals://pending` carries the same list on every change). Memory only.
#[tauri::command]
pub fn approvals_get(state: State<'_, AppState>) -> Vec<crate::approvals::PendingRequest> {
    state.approvals.list()
}

/// Story 7.2: the operator's answer to a pending request (`allow`, `deny`, or `always`, which
/// also sets `agentAllowed` on the edge joining the caller and the target). The toast goes and
/// the waiting tool call resumes. `Err` for a request no longer pending, or `always` where it is
/// not offered.
#[tauri::command]
pub fn approval_answer<R: Runtime>(app: AppHandle<R>, id: String, answer: crate::approvals::Answer) -> Result<(), String> {
    crate::approvals::answer(&app, &id, answer)
}

/// The live state of the context edges applied to running sessions (Story 6.3), by edge id, and
/// of the cooperate sides (Story 6.4), by `<edgeId>#<sessionId>`;
/// `edges://live` carries the same map on every change. Memory only.
#[tauri::command]
pub fn edges_live_get(state: State<'_, AppState>) -> std::collections::BTreeMap<String, live_edges::EdgeLive> {
    state.live_edges.snapshot()
}

/// Retry (Story 6.3): run the `/add-dir` injection of a context edge from a running session
/// again (the operator says the prompt is clear). For a cooperate edge (Story 6.4) it sends the
/// peer line again to the side of `session_id`, which must be one of its ends and must have
/// failed or be held back by a draft. `Err` for an unknown edge, a project's context edge, a
/// cooperate edge without one of its sessions, a side whose line may already be on its way, or a
/// session not running in a Switchboard terminal.
#[tauri::command]
pub async fn edge_live_retry<R: Runtime>(app: AppHandle<R>, edge_id: String, session_id: Option<String>) -> Result<(), String> {
    live_edges::retry(&app, &edge_id, session_id.as_deref())
}

/// Restart with flags (Story 6.3): stop the edge's session the way Stop does, wait until it has
/// exited, and resume the same id, which passes its context edges as `--add-dir` (Story 6.2).
/// The edge is then `applied (restarted with flags)`, or `failed` when its target gives no
/// folder. A session with no discovered transcript is refused before anything is stopped.
#[tauri::command]
pub async fn edge_restart_with_flags<R: Runtime>(app: AppHandle<R>, edge_id: String) -> Result<LaunchResult, String> {
    blocking(move || restart_with_flags(&app, &edge_id)).await?
}

/// How long Restart with flags waits for the stopped session to exit, past Stop's kill.
pub const RESTART_EXIT_SLACK: std::time::Duration = std::time::Duration::from_secs(5);

/// Why Restart with flags gave up: the session did not exit.
pub const DID_NOT_STOP: &str = "the session did not stop";

/// The work of [`edge_restart_with_flags`].
pub fn restart_with_flags<R: Runtime>(app: &AppHandle<R>, edge_id: &str) -> Result<LaunchResult, String> {
    let state = app.state::<AppState>();
    let edge = live_edges::stored_edge(&state, edge_id).ok_or_else(|| live_edges::UNKNOWN_EDGE.to_string())?;
    if !live_edges::is_session_context(&edge) {
        return Err(live_edges::NOT_SESSION_CONTEXT.to_string());
    }
    let session_id = edge.from.id.clone();
    let project_id = session_project(&state, &session_id).ok_or_else(|| NO_TRANSCRIPT.to_string())?;
    // Resume needs a discovered transcript: without one nothing is stopped.
    source_session(&state, &project_id, &session_id)?;
    // One restart per session at a time; released on every path.
    let _restarting = live_edges::begin_restart(&state, &session_id)?;
    let term_id = pty::session_id(&session_id);
    let size = state.terms.get(&term_id).map_or((pty::DEFAULT_COLS, pty::DEFAULT_ROWS), |t| t.size());
    live_edges::cancel_session(app, &session_id);
    // From here on a failure leaves no edge of the session pending without a job.
    let fail = |message: String| -> Result<LaunchResult, String> {
        live_edges::fail_session(app, &session_id, edge_id, &message);
        Err(message)
    };
    let running = state.terms.get(&term_id).is_some_and(|t| t.kind == TermKind::Session && t.is_running());
    if running {
        if let Err(message) = stop_session(app, &session_id) {
            return fail(message);
        }
        let deadline = std::time::Instant::now() + launch::STOP_KILL_AFTER + RESTART_EXIT_SLACK;
        loop {
            let term_done = !state.terms.get(&term_id).is_some_and(|t| t.is_running());
            let live_done = state.read_sessions_live().sessions.get(&session_id).is_none_or(|s| !s.state.is_live());
            if term_done && live_done {
                break;
            }
            if std::time::Instant::now() > deadline {
                return fail(DID_NOT_STOP.to_string());
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    let result = match resume_session(app, &project_id, &session_id, size) {
        Ok(result) => result,
        Err(message) if running => return fail(format!("{STOPPED_NOT_RESUMED}{message}")),
        Err(message) => return fail(message),
    };
    // Every context edge of the session was passed as `--add-dir` (or skipped): each says so.
    for session_edge in live_edges::session_edges(&state, &session_id) {
        let (live, detail, path) = match live_edges::resolve(&state, &session_edge, &result.term.cwd) {
            Ok(path) => (live_edges::EdgeState::Applied, live_edges::RESTARTED.to_string(), path),
            Err(reason) => (live_edges::EdgeState::Failed, reason, None),
        };
        live_edges::mark(app, &session_edge.id, &session_id, live, Some(&detail), path);
    }
    Ok(result)
}

/// What a Restart with flags that stopped the session but could not resume it says first.
pub const STOPPED_NOT_RESUMED: &str = "stopped but not resumed: ";

/// The project a session belongs to: its session ref's, else the live map's, else the project
/// whose discovered sessions list it.
fn session_project(state: &AppState, session_id: &str) -> Option<String> {
    let ws = state.read_workspace();
    ws.workspace
        .sessions
        .iter()
        .find(|s| s.session_id == session_id)
        .map(|s| s.project_id.clone())
        .or_else(|| state.read_sessions_live().sessions.get(session_id).and_then(|s| s.project_id.clone()))
        .or_else(|| {
            ws.discovered
                .iter()
                .find(|(_, list)| list.iter().any(|s| s.id == session_id))
                .map(|(id, _)| id.clone())
        })
}

/// Put a project's children back into their column (`project.relayout`): clears their
/// stored positions and prunes session refs left bare. Replies with the snapshot, or
/// `Err("unknown project")`.
#[tauri::command]
pub async fn workspace_relayout_children<R: Runtime>(app: AppHandle<R>, project_id: String) -> Result<WorkspaceSnapshot, String> {
    graph::relayout_children(&app, &project_id)
}

/// Take a project off the canvas (`project.remove`): `graph::remove_project` drops it with
/// its session refs, branches and edges and emits `workspace://changed`; then its live git
/// status is forgotten and `projects://status` emitted. Replies with the workspace snapshot,
/// or `Err("unknown project")` with nothing changed.
#[tauri::command]
pub async fn workspace_remove_project<R: Runtime>(app: AppHandle<R>, project_id: String) -> Result<WorkspaceSnapshot, String> {
    let snapshot = graph::remove_project(&app, &project_id)?;
    // The live state of its edges goes with them (Story 6.3).
    live_edges::prune(&app);
    git::poll::forget(&app, &project_id).await;
    // Its branch watch stops and its branch lock goes (Story 5.1).
    let watch_app = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || git::watch::sync(&watch_app)).await;
    app.state::<AppState>().branch_locks.forget(&project_id);
    // Its terminals go too: their children are killed and the terminals forgotten.
    let terms_app = app.clone();
    let forget_id = project_id.clone();
    let forgotten = blocking(move || terms_app.state::<AppState>().terms.forget_project(&forget_id)).await?;
    // Their pop-out windows close (Story 4.5).
    for id in &forgotten {
        windows::return_to_pane(&app, id);
    }
    // Drop the removed project's discovered sessions now, not at the next tick.
    let sessions_app = app.clone();
    tauri::async_runtime::spawn(async move {
        claude::sessions::refresh(&sessions_app).await;
        // Its live sessions move to the Elsewhere tray now.
        claude::live::refresh(&sessions_app).await;
    });
    Ok(snapshot)
}

/// "Open in external editor": run the program named by the first token of
/// `settings.external_editor` with the project folder as its only argument (the
/// `{file}`/`{line}` form of the template is for Epic 7's file opens), detached. The program
/// is resolved like detection resolves binaries (PATH + `PATHEXT`, so `code` finds
/// `code.cmd`); a `.cmd`/`.bat` runs through `cmd.exe` (std) with no console window. Every failure
/// is an `Err` the UI shows as a notice: no editor configured, unknown project, program not
/// found, could not start.
#[tauri::command]
pub async fn project_open_editor<R: Runtime>(app: AppHandle<R>, project_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let folder = project_path(&state, &project_id)?;
    let template = state.read().settings.external_editor.clone();
    let program = editor_program(template.as_deref()).ok_or_else(|| NO_EDITOR.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let program = resolve_program(&program, &Search::from_env(Vec::new()))?;
        process::spawn_detached(editor_command(&program, &folder)).map_err(|err| format!("could not start external editor: {err}"))
    })
    .await
    .map_err(|err| err.to_string())?
}

/// "Open in file manager": open the project folder itself in Explorer / the desktop's file
/// manager. `Err` for an unknown project or an opener failure (shown as a notice).
#[tauri::command]
pub async fn project_open_folder<R: Runtime>(app: AppHandle<R>, project_id: String) -> Result<(), String> {
    let folder = project_path(&app.state::<AppState>(), &project_id)?;
    open_dir(&app, Path::new(&folder)).map_err(|err| format!("could not open folder: {err}"))
}

/// "Reveal Claude project dir": open `~/.claude/projects/<dir>` for the first discovered
/// Claude project whose cwd is the project's folder (the import pane's comparison). Only a
/// directory that already exists is opened; nothing under `~/.claude` is ever written.
/// `Err(NO_CLAUDE_DIR)` when there is none (or no Claude home, as in tests).
#[tauri::command]
pub async fn project_reveal_claude_dir<R: Runtime>(app: AppHandle<R>, project_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let folder = project_path(&state, &project_id)?;
    let Some(home) = state.claude_home.get().cloned() else {
        return Err(NO_CLAUDE_DIR.to_string());
    };
    let dir = tauri::async_runtime::spawn_blocking(move || claude_project_dir(&home, &folder))
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| NO_CLAUDE_DIR.to_string())?;
    open_dir(&app, &dir).map_err(|err| format!("could not open Claude project directory: {err}"))
}

/// The stored (canonical) path of the project with `id`, or `Err("unknown project")`.
fn project_path(state: &AppState, id: &str) -> Result<String, String> {
    state
        .read_workspace()
        .workspace
        .projects
        .iter()
        .find(|p| p.id == id)
        .map(|p| p.path.clone())
        .ok_or_else(|| "unknown project".to_string())
}

/// Open a directory with the opener plugin. Without the plugin (the mock app in tests) this
/// is an `Err` naming that, so no test ever opens a real file manager.
fn open_dir<R: Runtime>(app: &AppHandle<R>, dir: &Path) -> Result<(), String> {
    let Some(opener) = app.try_state::<tauri_plugin_opener::Opener<R>>() else {
        return Err("opener plugin not registered".to_string());
    };
    opener
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|err| err.to_string())
}

/// The program an editor template names: when the trimmed template starts with `"`, everything
/// up to the next `"` (a quoted path with spaces); else its first whitespace-separated token.
/// `None` for an unset or blank template (or an empty quoted program).
pub fn editor_program(template: Option<&str>) -> Option<String> {
    let trimmed = template?.trim();
    let program = match trimmed.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or(""),
        None => trimmed.split_whitespace().next().unwrap_or(""),
    };
    (!program.is_empty()).then(|| program.to_string())
}

/// Where the editor program is. A bare name is looked up like detection does (PATH, with
/// `PATHEXT` on Windows); anything with a directory in it (or a leading `~`) is used as given
/// and must be a file. The errors are the notices the UI shows.
pub fn resolve_program(program: &str, search: &Search) -> Result<PathBuf, String> {
    locate_program(program, search).map_err(|missing| match missing {
        Missing::File => format!("external editor {program} does not exist"),
        Missing::OnPath => format!("external editor {program} not found on PATH"),
    })
}

/// Why [`locate_program`] found nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Missing {
    /// A path was given and is not a file.
    File,
    /// A bare name is on no searched directory.
    OnPath,
}

/// A bare name searched like detection does; a path (or `~`) taken as given if it is a file.
pub fn locate_program(program: &str, search: &Search) -> Result<PathBuf, Missing> {
    let expanded = settings::detect::expand_home(program);
    let path = Path::new(&expanded);
    if path.is_absolute() || path.components().count() > 1 {
        if path.is_file() { Ok(path.to_path_buf()) } else { Err(Missing::File) }
    } else {
        search.locate(program).map(|located| located.path).ok_or(Missing::OnPath)
    }
}

/// The command that opens `folder` with `program`: the program with the folder as its only
/// argument. On Windows a `.cmd`/`.bat` (what `code` is on PATH) needs no special casing:
/// std (Rust ≥ 1.77) runs batch files through `cmd.exe` and escapes the arguments for it
/// (`%`, quotes, a trailing `\`), and `spawn_detached` sets `CREATE_NO_WINDOW`.
pub fn editor_command(program: &Path, folder: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.arg(folder);
    cmd
}

/// `<home>/projects/<dir>` of the first discovered Claude project whose cwd is `folder`
/// (same comparison as the import pane: existing folders canonicalised, then
/// `graph::same_path`), when that directory exists; else `None`.
pub fn claude_project_dir(home: &Path, folder: &str) -> Option<PathBuf> {
    claude::list_projects(home)
        .into_iter()
        .filter(|project| project.exists)
        .find(|project| {
            let cwd = dunce::canonicalize(&project.cwd)
                .map(|c| c.display().to_string())
                .unwrap_or_else(|_| project.cwd.clone());
            graph::same_path(folder, &cwd)
        })
        .map(|project| home.join(claude::discover::PROJECTS_DIR).join(project.dir))
        .filter(|dir| dir.is_dir())
}

/// List Claude Code's known projects (`~/.claude/projects`, read-only) for "Import from
/// Claude". Existing folders come back canonicalised and with `on_canvas` decided here, by
/// the same path comparison `add_projects` uses. Nothing to read (no home, as in tests) is
/// an empty list.
#[tauri::command]
pub async fn claude_projects_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<ClaudeProject>, String> {
    let state = app.state::<AppState>();
    let Some(home) = state.claude_home.get().cloned() else {
        return Ok(Vec::new());
    };
    let on_canvas: Vec<String> = state.read_workspace().workspace.projects.iter().map(|p| p.path.clone()).collect();
    tauri::async_runtime::spawn_blocking(move || {
        let mut projects = claude::list_projects(&home);
        for project in projects.iter_mut().filter(|p| p.exists) {
            if let Ok(canonical) = dunce::canonicalize(&project.cwd) {
                project.cwd = canonical.display().to_string();
            }
            project.on_canvas = on_canvas.iter().any(|path| graph::same_path(path, &project.cwd));
        }
        projects
    })
    .await
    .map_err(|err| err.to_string())
}

/// The last git status the poller stored for each project id (`projects://status` carries
/// the same map on every change).
#[tauri::command]
pub fn projects_status_get(state: State<'_, AppState>) -> HashMap<String, ProjectStatus> {
    state.read_live().statuses.clone()
}

/// The live-session map as the poller last stored it (`sessions://live` carries the same on
/// every change): every session seen this run by id, the Elsewhere rows and the poll banner.
#[tauri::command]
pub fn live_sessions_get(state: State<'_, AppState>) -> LiveSnapshot {
    state.read_sessions_live().snapshot()
}

/// The operator selected session `session_id`, which they saw needing attention since
/// `attention_since`: a session in `finished` or `waiting` with that same `attention_since`
/// turns `idle` (source `ack`) until it is next busy, and `sessions://live` is emitted.
/// Replies with the new live snapshot, or `None` when nothing changed (any other state, a
/// newer turn than the one seen, an unknown id).
#[tauri::command]
pub fn session_acknowledge<R: Runtime>(app: AppHandle<R>, session_id: String, attention_since: Option<i64>) -> Option<LiveSnapshot> {
    claude::live::acknowledge(&app, &session_id, attention_since)
}

/// Exit the app with status 0 (the `app.quit` command, `ctrl+q`). Under `cfg(test)` it only
/// returns, so the wire-name test can invoke it without ending the test process.
#[tauri::command]
pub fn app_quit<R: Runtime>(app: AppHandle<R>) {
    if !cfg!(test) {
        app.exit(0);
    }
}

// ---------------------------------------------------------------------------------------
// Terminals (Story 4.1)
// ---------------------------------------------------------------------------------------

/// The shell `settings.shell` names (`None` or blank: the platform default), split into the
/// program and its arguments by [`split_command_line`]. An empty program (`""`) is the
/// default shell, with no arguments.
pub fn shell_command(configured: Option<&str>) -> (String, Vec<String>) {
    let mut words = split_command_line(configured.unwrap_or("")).into_iter();
    match words.next() {
        Some(program) if !program.is_empty() => (program, words.collect()),
        _ => (default_shell(), Vec::new()),
    }
}

/// Split a command line into words at whitespace; a double-quoted part (anywhere in a word)
/// keeps its spaces and loses its quotes, so `"C:\Program Files\x.exe" -Command "a b"` is
/// three words. An unterminated quote runs to the end; backslashes are literal (Windows paths).
pub fn split_command_line(line: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut quoted = false;
    for c in line.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                in_word = true;
            }
            c if c.is_whitespace() && !quoted => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            c => {
                word.push(c);
                in_word = true;
            }
        }
    }
    if in_word {
        words.push(word);
    }
    words
}

/// The shell when none is configured: `pwsh` if on PATH else `powershell` (Windows), `$SHELL`
/// else `/bin/sh` (elsewhere).
fn default_shell() -> String {
    if cfg!(windows) {
        let pwsh = Search::from_env(Vec::new()).locate("pwsh").is_some();
        if pwsh { "pwsh" } else { "powershell" }.to_string()
    } else {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".to_string())
    }
}

/// What a plain terminal in `cwd` spawns: the configured shell, resolved like the editor. The
/// error is the line the pane shows: `could not start <shell>: <cause>`.
pub fn shell_spec(configured: Option<&str>, search: &Search, cwd: &str) -> Result<SpawnSpec, String> {
    let (program, args) = shell_command(configured);
    let path = locate_program(&program, search).map_err(|missing| match missing {
        Missing::File => format!("could not start {program}: it does not exist"),
        Missing::OnPath => format!("could not start {program}: not found on PATH"),
    })?;
    Ok(SpawnSpec::new(path, args, cwd))
}

fn plain_spec<R: Runtime>(app: &AppHandle<R>, cwd: &str) -> Result<SpawnSpec, String> {
    let shell = app.state::<AppState>().read().settings.shell.clone();
    shell_spec(shell.as_deref(), &Search::from_env(Vec::new()), cwd)
}

fn sink<R: Runtime>(app: &AppHandle<R>) -> std::sync::Arc<dyn pty::Sink> {
    std::sync::Arc::new(EventSink(app.clone()))
}

/// Run blocking PTY work off the main thread and the async workers.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|err| err.to_string())
}

/// Open a project's plain terminal in its folder with the configured shell, at `cols` × `rows`
/// (else 120 × 30). One per project: opening again returns the existing one, running or exited.
/// A shell that cannot start still opens the terminal, exited, with the reason in `error`.
#[tauri::command]
pub async fn term_open<R: Runtime>(
    app: AppHandle<R>,
    kind: TermKind,
    project_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<TermInfo, String> {
    if kind != TermKind::Plain {
        return Err("a session terminal is opened by session_launch".to_string());
    }
    let state = app.state::<AppState>();
    let cwd = project_path(&state, &project_id)?;
    let title = state
        .read_workspace()
        .workspace
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .map(|p| p.label.clone())
        .unwrap_or_default();
    let size = (cols.unwrap_or(pty::DEFAULT_COLS), rows.unwrap_or(pty::DEFAULT_ROWS));
    blocking(move || {
        let id = pty::plain_id(&project_id);
        let spec_app = app.clone();
        let spec_cwd = cwd.clone();
        app.state::<AppState>()
            .terms
            .open(&id, &project_id, &title, &cwd, size, move || plain_spec(&spec_app, &spec_cwd), sink(&app))
    })
    .await
}

/// Send input (typed keys, a paste) to a terminal. Synchronous on purpose: it only queues the
/// bytes for the terminal's writer thread (never blocking on the PTY), and sync commands run
/// in the order they were invoked, so keystrokes are never reordered. A write to a session
/// terminal that answers a waiting session's prompt turns it busy at once (Story 4.3).
#[tauri::command]
pub fn term_write<R: Runtime>(app: AppHandle<R>, id: String, data: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.terms.write(&id, data.as_bytes())?;
    if let Some(session_id) = id.strip_prefix(pty::SESSION_PREFIX) {
        // A draft in the prompt holds back a context edge's `/add-dir` (Story 6.3).
        live_edges::note_input(&state, session_id, &data);
        live::terminal_input_and_emit(&app, session_id, &data);
    }
    Ok(())
}

/// Settings → Diagnostics (Story 4.3): the hooks endpoint (or why it is down), hook events
/// received, refused requests, session-id mismatches and poll overrides.
#[tauri::command]
pub fn diagnostics_get(state: State<'_, AppState>) -> DiagnosticsSnapshot {
    let overrides = state.read_sessions_live().poll_overrides;
    state.hooks.diagnostics(overrides)
}

/// Resize a terminal's PTY (clamped to at least 2 × 1).
#[tauri::command]
pub async fn term_resize<R: Runtime>(app: AppHandle<R>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    blocking(move || app.state::<AppState>().terms.resize(&id, cols, rows)).await?
}

/// The terminal's ring buffer (the last 2 MiB of output) and the byte offset it ends at, for a
/// view created after output began.
#[tauri::command]
pub async fn term_buffer<R: Runtime>(app: AppHandle<R>, id: String) -> Result<TermBuffer, String> {
    blocking(move || app.state::<AppState>().terms.buffer(&id)).await?
}

/// Respawn an exited terminal under the same id, in the same folder, with the shell configured now.
#[tauri::command]
pub async fn term_restart<R: Runtime>(app: AppHandle<R>, id: String) -> Result<TermInfo, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let cwd = state.terms.get(&id).map(|t| t.cwd.clone()).unwrap_or_default();
        let spec_app = app.clone();
        let info = state.terms.restart(&id, move || plain_spec(&spec_app, &cwd), sink(&app))?;
        // The other windows showing it (a pop-out, the pane) learn it runs again (Story 4.5).
        let _ = app.emit(pty::INFO_EVENT, &info);
        windows::retitle(&app, &info.id, &info.title);
        Ok(info)
    })
    .await?
}

/// Kill a terminal's child; it turns exited and keeps its buffer.
#[tauri::command]
pub async fn term_kill<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    blocking(move || app.state::<AppState>().terms.kill(&id)).await?
}

/// Close an exited session terminal: it leaves the list and its output goes (the pane's
/// "Close", `terminal.close`). A running or plain terminal is an `Err`.
#[tauri::command]
pub async fn term_close<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let close_app = app.clone();
    let close_id = id.clone();
    blocking(move || close_app.state::<AppState>().terms.close(&close_id)).await??;
    // Its pop-out goes with it, and every window forgets it (a pop-out's Close, Story 4.5).
    windows::return_to_pane(&app, &id);
    let _ = app.emit(pty::CLOSED_EVENT, pty::ClosedPayload { id });
    Ok(())
}

/// Pop a terminal out into its own window (`term-<n>`, Story 4.5), or focus the window it is
/// already in. Replies with the window's label; `term://popped` tells every webview. Async on
/// purpose: building a window from a sync command deadlocks on Windows.
#[tauri::command]
pub async fn term_pop_out<R: Runtime>(app: AppHandle<R>, id: String) -> Result<String, String> {
    windows::pop_out(&app, &id)
}

/// Return a popped-out terminal to the pane: its window closes and `term://popped` says so.
/// A terminal that is not popped out is left alone.
#[tauri::command]
pub async fn term_return<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    windows::return_to_pane(&app, &id);
    Ok(())
}

/// Every popped-out terminal and its window (a reloaded main window picks them up).
#[tauri::command]
pub fn term_popped(state: State<'_, AppState>) -> Vec<windows::PoppedPayload> {
    state.popouts.list()
}

/// Every terminal, in the order they were opened.
#[tauri::command]
pub async fn term_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<TermInfo>, String> {
    blocking(move || app.state::<AppState>().terms.list()).await
}

// ---------------------------------------------------------------------------------------
// Sessions (Story 4.2)
// ---------------------------------------------------------------------------------------

/// What `session_launch` replies: the new session's id and its terminal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LaunchResult {
    pub session_id: String,
    pub term: TermInfo,
    /// The model, effort and permission mode the session was started with (`default`: the
    /// flag was left out). Resume and Fork name them in their notice (Story 4.4).
    pub choices: LaunchChoices,
    /// Story 6.2, Resume and Fork: the context edges whose target gave no folder (the notice
    /// names them, `resumed without: …`). Empty for a sheet launch.
    pub skipped: Vec<graph::SkippedEdge>,
}

/// The three choices a launch used, as `LaunchResult.choices` carries them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LaunchChoices {
    pub model: String,
    pub effort: String,
    pub permission_mode: String,
}

impl LaunchChoices {
    fn of(request: &LaunchRequest) -> Self {
        let remembered = launch::remembered(request);
        let value = |v: Option<String>| v.unwrap_or_else(|| launch::DEFAULT_CHOICE.to_string());
        Self {
            model: value(remembered.model),
            effort: value(remembered.effort),
            permission_mode: value(remembered.permission_mode),
        }
    }
}

/// The launch sheet's prefill for a project: its last choices, else `settings.defaults`, else
/// `default`, and the default name `<label>-<4 hex>` of the fresh session id the next launch
/// from this project will use. With `branch` (Story 5.3, `n` on a branch card) Rust resolves
/// where the session would run from its latest branch list: the branch's worktree, the project
/// folder for the checked-out branch, or -- a branch without a worktree -- the exact
/// `git worktree add` the Start runs first (Story 5.2's plan for `{ existing, branch }`, read-only;
/// a refusal is the section's error). An unknown branch or a missing worktree folder is the `Err`.
/// On the project's sheet of a git project the reply carries its top level, for `--worktree`.
/// Story 6.2: `addDirs` are the folders the project's outgoing context edges grant (both sheets;
/// the folder the session runs in is left out), `skipped` the edges that grant none.
#[tauri::command]
pub async fn launch_defaults<R: Runtime>(app: AppHandle<R>, project_id: String, branch: Option<String>) -> Result<LaunchPrefill, String> {
    let state = app.state::<AppState>();
    let (label, path, project_defaults, list) = {
        let ws = state.read_workspace();
        let project = ws
            .workspace
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .ok_or_else(|| "unknown project".to_string())?;
        (
            project.label.clone(),
            project.path.clone(),
            project.launch_defaults.clone(),
            ws.branches.get(&project_id).cloned(),
        )
    };
    let branch = branch.map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    let (git_bin, root) = {
        let settings = state.read();
        (git::poll::git_binary(&settings), settings.settings.worktrees_root.clone())
    };
    let (target_path, worktree_plan, repo_top) = match &branch {
        Some(name) => match launch::resolve_branch(list.as_deref(), name)? {
            launch::BranchTarget::Worktree(worktree) => (Some(worktree), None, None),
            launch::BranchTarget::ProjectFolder => (Some(path.clone()), None, None),
            launch::BranchTarget::NeedsWorktree => {
                let request = existing_branch(name);
                let folder = path.clone();
                let plan = blocking(move || git::worktree::plan_add(&git_bin, Path::new(&folder), root.as_deref(), &request)).await?;
                match plan {
                    Ok(plan) => {
                        let planned = plan.path.display().to_string();
                        let preview = launch::WorktreePlanPreview {
                            command: Some(plan.command_line()),
                            path: Some(planned.clone()),
                            error: None,
                        };
                        (Some(planned), Some(preview), None)
                    }
                    Err(error) => (
                        None,
                        Some(launch::WorktreePlanPreview {
                            command: None,
                            path: None,
                            error: Some(error),
                        }),
                        None,
                    ),
                }
            }
        },
        None => {
            let repo = matches!(state.read_live().statuses.get(&project_id), Some(git::ProjectStatus::Repo(_)));
            let folder = path.clone();
            let top = if repo {
                blocking(move || git::worktree::top_level(&git_bin, Path::new(&folder)).ok())
                    .await?
                    .map(|top| top.display().to_string())
            } else {
                None
            };
            (Some(path.clone()), None, top)
        }
    };
    let edges_app = app.clone();
    let source = [graph::NodeRef {
        kind: graph::NodeType::Project,
        id: project_id.clone(),
    }];
    let own = target_path.clone().unwrap_or_else(|| path.clone());
    let (add_dirs, skipped) = blocking(move || edge_add_dirs(&edges_app.state::<AppState>(), &source, &own)).await?;
    let settings = state.read().settings.defaults.clone();
    let session_id = state.launcher.propose(&project_id);
    let name = launch::default_name(&label, &session_id);
    Ok(LaunchPrefill {
        branch,
        target_path,
        worktree_plan,
        repo_top,
        add_dirs,
        skipped,
        ..launch::prefill(project_defaults.as_ref(), &settings, session_id, name)
    })
}

/// The add-dirs the context edges leaving `from` grant, for a session running in `cwd`, and the
/// edges skipped: branch ends resolve against the latest branch lists, the worktrees the status
/// poll listed and the branch checked out in each project's folder. The targets are read under
/// the workspace lock ([`graph::context_targets`]); the folders are checked and canonicalised
/// after it is released ([`graph::resolve_context_targets`]). Blocking: call it off the async
/// runtime.
fn edge_add_dirs(state: &AppState, from: &[graph::NodeRef], cwd: &str) -> (Vec<graph::EdgeDir>, Vec<graph::SkippedEdge>) {
    let heads = graph::checked_out_heads(state);
    let targets = graph::context_targets(&state.read_workspace(), from, &heads);
    graph::resolve_context_targets(targets, cwd)
}

/// A resumed or forked session's add-dirs (Story 6.2): its own context edges (`session_id`, the
/// original's for a fork) plus its project's, resolved against `cwd`.
fn resume_add_dirs(state: &AppState, project_id: &str, session_id: &str, cwd: &str) -> (Vec<String>, Vec<graph::SkippedEdge>) {
    let from = [
        graph::NodeRef {
            kind: graph::NodeType::Session,
            id: session_id.to_string(),
        },
        graph::NodeRef {
            kind: graph::NodeType::Project,
            id: project_id.to_string(),
        },
    ];
    let (dirs, skipped) = edge_add_dirs(state, &from, cwd);
    (dirs.into_iter().map(|d| d.path).collect(), skipped)
}

/// The Story 5.2 request for a worktree of the existing local branch `name`.
fn existing_branch(name: &str) -> git::worktree::WorktreeRequest {
    git::worktree::WorktreeRequest {
        mode: git::worktree::WorktreeMode::Existing,
        branch: name.to_string(),
        base: None,
    }
}

/// Start a Claude session from the launch sheet: Rust assigns the id, writes the settings
/// file, builds the argv and runs `claude` in a session terminal (`session:<id>`, titled with
/// the name) at `cols` × `rows` (else 120 × 30). It runs in the project folder; on a branch
/// (Story 5.3) in the folder Rust resolves for it ([`new_launch`]), and with `--worktree` from
/// the repo's top level. The session is a `starting` live child at once and turns `idle` on
/// its first output; its exit turns it `exited` and deletes the settings file. The project
/// remembers the choices. Every refusal is an `Err` the sheet shows, with nothing started.
///
/// A branch without a worktree, with `createWorktree`: after every side-effect-free check and
/// the id's claim, the worktree is created exactly as `worktree_add` does (branch lock, path
/// stored, branches on, re-read); a refusal or git error there starts nothing and gives the id
/// back. Once the worktree exists it stays, whatever the start does next.
#[tauri::command]
pub async fn session_launch<R: Runtime>(
    app: AppHandle<R>,
    request: LaunchRequest,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<LaunchResult, String> {
    let size = (cols.unwrap_or(pty::DEFAULT_COLS), rows.unwrap_or(pty::DEFAULT_ROWS));
    let check_app = app.clone();
    let (mut launch, create) = blocking(move || -> Result<(Launch, Option<String>), String> {
        let state = check_app.state::<AppState>();
        let (launch, create) = new_launch(&state, request)?;
        // The program, the session dir and the flags, before anything is written.
        prepare_launch(&state, &launch)?;
        // The id the sheet showed, once: a stale sheet or a second start is refused here.
        state.launcher.claim(&launch.project_id, &launch.session_id)?;
        Ok((launch, create))
    })
    .await??;
    if let Some(branch) = create {
        let added = add_worktree(&app, &launch.project_id, &existing_branch(&branch)).await;
        match added {
            Ok((_, worktree)) => {
                launch.cwd = worktree.clone();
                launch.worktree = Some((branch, worktree));
            }
            Err(message) => {
                app.state::<AppState>().launcher.unclaim(&launch.project_id, &launch.session_id);
                return Err(message);
            }
        }
    }
    blocking(move || {
        let state = app.state::<AppState>();
        let (project_id, session_id) = (launch.project_id.clone(), launch.session_id.clone());
        let give_back = || state.launcher.unclaim(&project_id, &session_id);
        // A created worktree is the folder now: an add-dir equal to it goes.
        let add_dirs = match launch::normalise_add_dirs(&launch.request.add_dirs, &launch.cwd) {
            Ok(dirs) => dirs,
            Err(message) => {
                give_back();
                return Err(message);
            }
        };
        launch.request.add_dirs = add_dirs;
        let (program, args) = match prepare_launch(&state, &launch) {
            Ok(prepared) => prepared,
            Err(message) => {
                give_back();
                return Err(message);
            }
        };
        start_claimed(&app, launch, program, args, size)
    })
    .await?
}

/// The program a launch runs and its leading arguments: `claude` as detection found it (only
/// while `found`); tests may put a fixture in its place.
fn launch_program(state: &AppState) -> Result<(PathBuf, Vec<String>), String> {
    #[cfg(test)]
    if let Some(program) = state.launcher.program.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return Ok(program);
    }
    live::claude_binary(&state.read())
        .map(|path| (path, Vec::new()))
        .ok_or_else(|| launch::NO_CLAUDE.to_string())
}

/// Why Resume is refused while the session runs (in Switchboard, or elsewhere).
pub const SESSION_RUNNING: &str = "that session is already running";

/// Why Resume or Fork is refused for a session with no transcript on the canvas.
pub const NO_TRANSCRIPT: &str = "that session has no transcript to resume";

/// Why Stop is refused: only a session running in a Switchboard terminal can be stopped.
pub const NOT_STOPPABLE: &str = "only a session running in a Switchboard terminal can be stopped";

/// A launch once its kind's specifics are resolved: what [`run_launch`] starts.
struct Launch {
    kind: launch::LaunchKind,
    project_id: String,
    /// The project's folder (the system prompt's "Project folder").
    project_path: String,
    label: String,
    /// The folder the session runs in.
    cwd: String,
    /// The id the session runs under: its node, its terminal (`session:<id>`), its env.
    session_id: String,
    /// The terminal's title and the live entry's name.
    name: String,
    /// The flags (model, effort, permission mode, add-dirs; the prompt for New only).
    request: LaunchRequest,
    /// Resume and Fork (Story 6.2): the context edges whose target gave no folder.
    skipped: Vec<graph::SkippedEdge>,
    /// The system prompt's branch (Story 5.3): the branch the session starts on; `None` takes
    /// the project's checked-out branch from the status poll.
    branch: Option<String>,
    /// The branch card the session is drawn under (`<projectId>:<name>`), written to its
    /// session ref before the spawn.
    branch_id: Option<String>,
    /// A branch and the worktree folder to record for it before the spawn (`BranchNode.
    /// worktreePath`), so the live session's cwd maps to that branch.
    worktree: Option<(String, String)>,
    /// `claude --worktree <name>` (the project's sheet only).
    worktree_flag: Option<String>,
}

/// The side-effect-free half of a sheet launch: the project, the name, where the session runs
/// and the add-dirs (normalised against that folder). Where it runs (Story 5.3):
/// - no branch: the project folder;
/// - a branch: what [`launch::resolve_branch`] finds in the latest branch list -- its linked
///   worktree (recorded as the branch's `worktreePath`), the project folder for the checked-out
///   branch, or, for a branch without a worktree and `createWorktree`, a worktree to create
///   first (the second value; the caller creates it and sets the folder). Never a path sent by
///   the UI. Not listed: [`launch::BRANCH_NOT_FOUND`]; a missing folder:
///   [`launch::WORKTREE_MISSING`]; no worktree and none asked for: [`launch::NO_WORKTREE`];
/// - `worktreeName` (not with a branch): the repo's top level, with `--worktree <name>`; the
///   name must pass `git check-ref-format --branch worktree-<name>`, and the branch
///   `worktree-<name>` is recorded with `<top>/.claude/worktrees/<name>`.
fn new_launch(state: &AppState, request: LaunchRequest) -> Result<(Launch, Option<String>), String> {
    let (path, label, list) = {
        let ws = state.read_workspace();
        let project = ws
            .workspace
            .projects
            .iter()
            .find(|p| p.id == request.project_id)
            .ok_or_else(|| "unknown project".to_string())?;
        (project.path.clone(), project.label.clone(), ws.branches.get(&project.id).cloned())
    };
    let name = launch::validate_name(&request.name)?;
    let branch = request.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()).map(str::to_string);
    let worktree_name = request.worktree_name.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(str::to_string);
    let project_id = request.project_id.clone();
    let mut create = None;
    let mut worktree = None;
    let mut worktree_flag = None;
    let (cwd, branch) = match (branch, worktree_name) {
        (Some(_), Some(_)) => return Err(launch::WORKTREE_FLAG_ON_BRANCH.to_string()),
        (None, None) => (path.clone(), None),
        (Some(branch), None) => match launch::resolve_branch(list.as_deref(), &branch)? {
            launch::BranchTarget::Worktree(folder) => {
                worktree = Some((branch.clone(), folder.clone()));
                (folder, Some(branch))
            }
            launch::BranchTarget::ProjectFolder => (path.clone(), Some(branch)),
            launch::BranchTarget::NeedsWorktree if request.create_worktree => {
                create = Some(branch.clone());
                // Set once the worktree exists.
                (String::new(), Some(branch))
            }
            launch::BranchTarget::NeedsWorktree => return Err(launch::NO_WORKTREE.to_string()),
        },
        (None, Some(raw)) => {
            let flag = launch::validate_worktree_name(&raw)?;
            let git_bin = git::poll::git_binary(&state.read());
            let folder = Path::new(&path);
            let claude_branch = format!("{}{flag}", launch::CLAUDE_WORKTREE_BRANCH_PREFIX);
            git::worktree::check_new_name(&git_bin, folder, &claude_branch)?;
            let top = git::worktree::top_level(&git_bin, folder)?;
            worktree = Some((claude_branch.clone(), launch::claude_worktree_path(&top, &flag).display().to_string()));
            worktree_flag = Some(flag);
            (top.display().to_string(), Some(claude_branch))
        }
    };
    let add_dirs = if create.is_some() {
        // The folder does not exist yet: checked now, compared with it once it does.
        launch::normalise_add_dirs(&request.add_dirs, &path)?;
        request.add_dirs.clone()
    } else {
        launch::normalise_add_dirs(&request.add_dirs, &cwd)?
    };
    let branch_id = branch.as_deref().map(|b| graph::branch_child_id(&project_id, b));
    let launch = Launch {
        kind: launch::LaunchKind::New,
        project_id,
        project_path: path,
        label,
        cwd,
        session_id: request.session_id.clone(),
        name,
        request: LaunchRequest { add_dirs, ..request },
        skipped: Vec::new(),
        branch,
        branch_id,
        worktree,
        worktree_flag,
    };
    Ok((launch, create))
}

/// Run a sheet launch whose id is claimed: a failure gives the id back; a start remembers the
/// project's choices.
fn start_claimed<R: Runtime>(app: &AppHandle<R>, launch: Launch, program: PathBuf, args: Vec<String>, size: (u16, u16)) -> Result<LaunchResult, String> {
    let state = app.state::<AppState>();
    let (project_id, session_id) = (launch.project_id.clone(), launch.session_id.clone());
    let give_back = || state.launcher.unclaim(&project_id, &session_id);
    let remembered = launch::remembered(&launch.request);
    let result = run_launch(app, launch, program, args, size, &give_back)?;
    if let Err(err) = graph::set_launch_defaults(app, &project_id, remembered) {
        eprintln!("launch: could not remember the choices: {err}");
    }
    Ok(result)
}

/// Resume (Story 4.4): `claude --resume <id>` for a session with a transcript that is not live,
/// in its transcript's folder (else its project's), with the standard app flags; the same node
/// becomes live. No sheet: the choices are the project's last ones, else settings. The add-dirs
/// are the session's own context edges plus its project's (Story 6.2); the reply's `skipped`
/// names the edges that gave no folder.
#[tauri::command]
pub async fn session_resume<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    session_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<LaunchResult, String> {
    let size = (cols.unwrap_or(pty::DEFAULT_COLS), rows.unwrap_or(pty::DEFAULT_ROWS));
    blocking(move || resume_session(&app, &project_id, &session_id, size)).await?
}

/// Fork (Story 4.4): `--resume <id> --fork-session --session-id <new>` for any session with a
/// transcript, live or not; a new node appears, joined to its original by a "forked from" line.
#[tauri::command]
pub async fn session_fork<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    session_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<LaunchResult, String> {
    let size = (cols.unwrap_or(pty::DEFAULT_COLS), rows.unwrap_or(pty::DEFAULT_ROWS));
    blocking(move || fork_session(&app, &project_id, &session_id, size)).await?
}

/// Stop (Story 4.4) a session running in a Switchboard terminal: Ctrl+U, `/exit` + Enter while
/// it is `idle` or `finished`, else Ctrl+C, 300 ms, Ctrl+C; still running 5 s later, it
/// is killed. A Stop while one is under way kills at once. Replies with the terminal's info
/// (`stopping` set); the node turns `exited` through the PTY exit as usual.
#[tauri::command]
pub async fn session_stop<R: Runtime>(app: AppHandle<R>, session_id: String) -> Result<TermInfo, String> {
    blocking(move || stop_session(&app, &session_id)).await?
}

/// The work of [`session_stop`]. Sessions started elsewhere have no Switchboard terminal and
/// are never signalled.
pub fn stop_session<R: Runtime>(app: &AppHandle<R>, session_id: &str) -> Result<TermInfo, String> {
    let state = app.state::<AppState>();
    let term_id = pty::session_id(session_id);
    state
        .terms
        .get(&term_id)
        .filter(|term| term.kind == TermKind::Session && term.is_running())
        .ok_or_else(|| NOT_STOPPABLE.to_string())?;
    let current = state.read_sessions_live().sessions.get(session_id).map(|s| s.state.clone());
    // A session the map does not know is not known to be idle: interrupted.
    let plan = current.map_or(launch::StopPlan::Interrupt, |s| launch::stop_plan(&s));
    // A child that exited between the check and the stop is the same refusal.
    state
        .terms
        .stop(&term_id, launch::stop_writes(plan), launch::STOP_KILL_AFTER)
        .map_err(|_| NOT_STOPPABLE.to_string())
}

/// What Resume and Fork start from: a session with a discovered transcript, its project, and
/// the name it goes by (the live entry's, else the transcript's title, else the project's
/// label).
struct Source {
    project: graph::Project,
    cwd: Option<String>,
    name: String,
}

/// The session `session_id` as discovered under project `project_id` (the card the operator
/// chose): `unknown project` when the project is gone, [`NO_TRANSCRIPT`] when no transcript of
/// that id is discovered under it.
fn source_session(state: &AppState, project_id: &str, session_id: &str) -> Result<Source, String> {
    let (project, summary) = {
        let ws = state.read_workspace();
        let project = ws
            .workspace
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .cloned()
            .ok_or_else(|| "unknown project".to_string())?;
        let summary = ws
            .discovered
            .get(project_id)
            .and_then(|list| list.iter().find(|s| s.id == session_id))
            .cloned()
            .ok_or_else(|| NO_TRANSCRIPT.to_string())?;
        (project, summary)
    };
    let live_name = state
        .read_sessions_live()
        .sessions
        .get(session_id)
        .and_then(|s| s.name.clone())
        .filter(|n| !n.trim().is_empty());
    let title = Some(summary.title.clone()).filter(|t| !t.trim().is_empty() && t != claude::transcript::UNTITLED);
    let name = live_name.or(title).unwrap_or_else(|| project.label.clone());
    Ok(Source {
        cwd: summary.cwd.clone(),
        name,
        project,
    })
}

/// The flags of a sheetless launch: the project's last choices, else settings (the 4.2 prefill).
fn sheetless_request(state: &AppState, project: &graph::Project, session_id: &str, name: &str) -> LaunchRequest {
    let settings = state.read().settings.defaults.clone();
    let prefill = launch::prefill(project.launch_defaults.as_ref(), &settings, session_id.to_string(), name.to_string());
    LaunchRequest {
        project_id: project.id.clone(),
        session_id: session_id.to_string(),
        name: name.to_string(),
        model: Some(prefill.model),
        effort: Some(prefill.effort),
        permission_mode: Some(prefill.permission_mode),
        ..LaunchRequest::default()
    }
}

/// The branch a session was started on (Story 5.3): its session ref's `branchId`
/// (`<projectId>:<name>`) without the project prefix; `None` without one.
fn ref_branch(state: &AppState, project_id: &str, session_id: &str) -> Option<String> {
    let prefix = format!("{project_id}:");
    state
        .read_workspace()
        .workspace
        .sessions
        .iter()
        .find(|s| s.session_id == session_id && s.project_id == project_id)
        .and_then(|s| s.branch_id.as_deref())
        .and_then(|id| id.strip_prefix(&prefix))
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// The work of [`session_resume`].
pub fn resume_session<R: Runtime>(app: &AppHandle<R>, project_id: &str, session_id: &str, size: (u16, u16)) -> Result<LaunchResult, String> {
    let state = app.state::<AppState>();
    let source = source_session(&state, project_id, session_id)?;
    let cwd = launch::resume_cwd(source.cwd.as_deref(), &source.project.path)?;
    let (add_dirs, skipped) = resume_add_dirs(&state, &source.project.id, session_id, &cwd);
    let launch = Launch {
        kind: launch::LaunchKind::Resume { id: session_id.to_string() },
        request: LaunchRequest {
            add_dirs,
            ..sheetless_request(&state, &source.project, session_id, &source.name)
        },
        skipped,
        project_id: source.project.id.clone(),
        project_path: source.project.path.clone(),
        label: source.project.label.clone(),
        cwd,
        session_id: session_id.to_string(),
        name: source.name,
        branch: ref_branch(&state, project_id, session_id),
        branch_id: None,
        worktree: None,
        worktree_flag: None,
    };
    let (program, args) = prepare_launch(&state, &launch)?;
    run_launch(app, launch, program, args, size, &|| {})
}

/// The work of [`session_fork`]: a fresh v4 id, named `<original name>-fork-<4 hex>`; the
/// workspace records which session it was forked from before the spawn (see [`run_launch`]).
/// A second fork of the same session is refused while this one starts.
pub fn fork_session<R: Runtime>(app: &AppHandle<R>, project_id: &str, from: &str, size: (u16, u16)) -> Result<LaunchResult, String> {
    let state = app.state::<AppState>();
    let source = source_session(&state, project_id, from)?;
    let cwd = launch::resume_cwd(source.cwd.as_deref(), &source.project.path)?;
    let (add_dirs, skipped) = resume_add_dirs(&state, &source.project.id, from, &cwd);
    let new_id = uuid::Uuid::new_v4().to_string();
    let _forking = state.launcher.begin_fork(from, &new_id)?;
    let name = launch::fork_name(&source.name, &new_id);
    let launch = Launch {
        kind: launch::LaunchKind::Fork { from: from.to_string() },
        request: LaunchRequest {
            add_dirs,
            ..sheetless_request(&state, &source.project, &new_id, &name)
        },
        skipped,
        project_id: source.project.id.clone(),
        project_path: source.project.path.clone(),
        label: source.project.label.clone(),
        cwd,
        session_id: new_id.clone(),
        name,
        branch: ref_branch(&state, project_id, from),
        branch_id: None,
        worktree: None,
        worktree_flag: None,
    };
    let (program, args) = prepare_launch(&state, &launch)?;
    run_launch(app, launch, program, args, size, &|| {})
}

/// The checks of a launch that have no side effects, and its program and argv: the claude
/// binary (never a batch file on Windows), the session dir, the system prompt and the flags.
fn prepare_launch(state: &AppState, launch: &Launch) -> Result<(PathBuf, Vec<String>), String> {
    prepare_launch_with(state, launch, &[])
}

/// [`prepare_launch`] with `extra` peers in the system prompt after the stored ones: Story 7.2
/// builds the argv a `start_session` with `cooperateWithMe` will run, before the operator allows
/// it and so before its cooperate edge is stored.
fn prepare_launch_with(state: &AppState, launch: &Launch, extra: &[launch::Peer]) -> Result<(PathBuf, Vec<String>), String> {
    let (program, leading) = launch_program(state)?;
    let extensions = if cfg!(windows) { settings::detect::platform_extensions() } else { Vec::new() };
    launch::refuse_batch(&launch::pathext_target(&program, &extensions), cfg!(windows))?;
    let dir = state.launcher.dir().ok_or_else(|| "no folder for session settings files".to_string())?;
    // The branch the session starts on (Story 5.3), else the one checked out in the project.
    let branch = match (&launch.branch, state.read_live().statuses.get(&launch.project_id)) {
        (Some(branch), _) => Some(branch.clone()),
        (None, Some(git::ProjectStatus::Repo(repo))) if !repo.detached => Some(repo.branch.clone()),
        _ => None,
    };
    // Story 6.4: the launching id's own cooperate peers. A fork launches under its new id, which
    // no edge names, so it inherits none; a New session has no edges yet.
    let mut peers = graph::session_peers(state, &launch.session_id);
    peers.extend(extra.iter().cloned());
    let context = launch::system_prompt(&launch.label, &launch.project_path, branch.as_deref(), &launch.name, &launch.session_id, &peers);
    let mut built = launch::build_args(
        &launch.kind,
        &launch.request,
        &launch.session_id,
        &launch::settings_path(&dir, &launch.session_id),
        &context,
    )?;
    if let Some(name) = &launch.worktree_flag {
        built = launch::with_worktree_flag(built, name);
    }
    let mut args = leading;
    args.extend(built);
    Ok((program, args))
}

/// Story 7.1: a launch's add-dirs as `my_node()` reports them, each with where it came from: a
/// folder one of the context edges the launch draws on grants (the project's for New; the
/// session's own -- the original's for a fork -- and its project's for Resume and Fork) is
/// `edge → <target>`, anything else was typed on the sheet. Blocking (the folders are checked).
fn launch_add_dirs(state: &AppState, launch: &Launch) -> Vec<graph::EdgeDir> {
    let project = graph::NodeRef {
        kind: graph::NodeType::Project,
        id: launch.project_id.clone(),
    };
    let from = match &launch.kind {
        launch::LaunchKind::New => vec![project],
        launch::LaunchKind::Resume { id: source } | launch::LaunchKind::Fork { from: source } => vec![
            graph::NodeRef {
                kind: graph::NodeType::Session,
                id: source.clone(),
            },
            project,
        ],
    };
    let granted = if launch.request.add_dirs.is_empty() { Vec::new() } else { edge_add_dirs(state, &from, &launch.cwd).0 };
    launch
        .request
        .add_dirs
        .iter()
        .map(|path| graph::EdgeDir {
            path: path.clone(),
            via: granted
                .iter()
                .find(|d| graph::same_path(&d.path, path))
                .map_or_else(|| launch::VIA_SHEET.to_string(), |d| launch::via_edge(&d.via)),
        })
        .collect()
}

/// Start a prepared launch: the live entry (`starting`), the hooks token and settings file (and,
/// Story 7.1, the MCP config and `--mcp-config`), the session terminal. A failure undoes what
/// this call created and runs `give_back`.
fn run_launch<R: Runtime>(
    app: &AppHandle<R>,
    launch: Launch,
    program: PathBuf,
    mut args: Vec<String>,
    size: (u16, u16),
    give_back: &dyn Fn(),
) -> Result<LaunchResult, String> {
    let state = app.state::<AppState>();
    let resume = matches!(launch.kind, launch::LaunchKind::Resume { .. });
    let session_id = launch.session_id.clone();
    let term_id = pty::session_id(&session_id);
    if let Some(term) = state.terms.get(&term_id) {
        // A resume reuses the id: its exited terminal is replaced when the new one opens.
        if !resume || term.is_running() {
            give_back();
            return Err(if resume { SESSION_RUNNING } else { launch::ID_IN_USE }.to_string());
        }
    }
    // In the live map before the spawn, so the first output always finds it. A new id the map
    // already knows is refused (it is someone else's); a resume is refused while the session
    // is live (starting or running, here or elsewhere), atomically with taking the entry.
    let saved = {
        let mut map = state.write_sessions_live();
        if let Some(known) = map.sessions.get(&session_id)
            && (!resume || known.state.is_live())
        {
            drop(map);
            give_back();
            return Err(if resume { SESSION_RUNNING } else { launch::ID_IN_USE }.to_string());
        }
        // Everything the map held for the id, so a failure puts it back exactly.
        let saved = map.save(&session_id);
        map.launched(&session_id, Some(launch.project_id.clone()), &launch.cwd, &launch.name, live::now_ms());
        saved
    };
    let forget = || {
        state.hooks.drop_session(&session_id);
        state.launcher.forget_add_dirs(&session_id);
        // A launch that failed leaves the id as it was: unknown (new, fork), or exited /
        // historic with all its marks (resume).
        live::update_and_emit(app, |map| {
            map.restore(&session_id, saved.clone());
            true
        });
    };
    // Hooks (Story 4.3) while the endpoint is up: a token for this session, the hooks block in
    // its settings file, its port in the env. Otherwise `{}` and no port, as in Story 4.2.
    let port = state.hooks.port();
    // The session counts as hooked only once its first hook event is accepted.
    let token = port.map(|_| state.hooks.register(&session_id));
    let content = match (port, &token) {
        (Some(port), Some(token)) => {
            serde_json::to_string_pretty(&hooks::settings_json(port, token)).unwrap_or_else(|_| launch::SETTINGS_CONTENT.to_string())
        }
        _ => launch::SETTINGS_CONTENT.to_string(),
    };
    // Story 7.1: what this run's add-dirs are, and where each came from (`my_node().addDirs`);
    // only `/mcp` reads it, so with the endpoint down the folder checks are skipped.
    if port.is_some() {
        state.launcher.record_add_dirs(&session_id, launch_add_dirs(&state, &launch));
    }
    if resume {
        // A settings file or MCP config left by an earlier run of this session (an app that
        // crashed; this run's own are deleted before its exit shows): the session is not live,
        // so they go.
        if let Some(dir) = state.launcher.dir() {
            let _ = std::fs::remove_file(launch::settings_path(&dir, &session_id));
            let _ = std::fs::remove_file(launch::mcp_path(&dir, &session_id));
        }
    }
    if let Err(message) = state.launcher.write_settings_with(&session_id, &content) {
        forget();
        give_back();
        return Err(message);
    }
    // Story 7.1, while the endpoint is up: the `switchboard` MCP server on this session's token,
    // in `<id>.mcp.json` beside the settings file, passed as `--mcp-config`. Down: neither.
    if let (Some(port), Some(token)) = (port, &token) {
        match state.launcher.write_mcp(&session_id, &crate::mcp::config_json(port, token).to_string()) {
            Ok(path) => args = launch::with_mcp_config(args, &path),
            Err(message) => {
                forget();
                state.launcher.remove_settings(&session_id);
                give_back();
                return Err(message);
            }
        }
    }
    // A fork's link to its original is saved before the spawn, so its node is emitted once,
    // already linked; a link that cannot be saved refuses the fork.
    let fork_of = match &launch.kind {
        launch::LaunchKind::Fork { from } => Some(from.clone()),
        _ => None,
    };
    if let Some(from) = &fork_of
        && let Err(message) = graph::set_forked_from(app, &launch.project_id, &session_id, from)
    {
        forget();
        state.launcher.remove_settings(&session_id);
        give_back();
        return Err(message);
    }
    // Story 5.3, before the spawn: the branch's worktree folder is recorded (a worktree made
    // outside the app maps too), then the session's branch, so the live row's cwd resolves to
    // the project and branch and the node is drawn under its branch card from the start.
    // A branch node this launch created goes again when the start fails; one stored before stays.
    let mut created_node: Option<String> = None;
    let undo_mapping = |created_node: &Option<String>| {
        if launch.branch_id.is_some() {
            graph::clear_session_branch(app, &launch.project_id, &session_id);
        }
        if let Some(name) = created_node {
            graph::remove_branch_node(app, &launch.project_id, name);
        }
    };
    let fail_before_spawn = |message: String, created_node: &Option<String>| {
        forget();
        state.launcher.remove_settings(&session_id);
        if fork_of.is_some() {
            graph::clear_forked_from(app, &launch.project_id, &session_id);
        }
        undo_mapping(created_node);
        give_back();
        Err(message)
    };
    if let Some((name, folder)) = &launch.worktree {
        let (existed, known) = {
            let ws = state.read_workspace();
            let stored = ws.workspace.branches.iter().find(|b| b.project_id == launch.project_id && b.name == *name);
            (
                stored.is_some(),
                stored.is_some_and(|b| b.worktree_path.as_deref().is_some_and(|w| graph::same_path(w, folder))),
            )
        };
        if !known {
            if let Err(err) = graph::upsert_created_branch(app, &launch.project_id, name, folder) {
                return fail_before_spawn(format!("could not record the worktree of branch {name}: {err}"), &created_node);
            }
            if !existed {
                created_node = Some(name.clone());
            }
        }
    }
    if let Some(branch_id) = &launch.branch_id
        && let Err(message) = graph::set_session_branch(app, &session_id, &launch.project_id, branch_id)
    {
        return fail_before_spawn(message, &created_node);
    }
    let mut spec = SpawnSpec::new(program, args, &launch.cwd);
    spec.env.push((launch::NODE_ENV.to_string(), session_id.clone()));
    if let Some(port) = port {
        spec.env.push((hooks::PORT_ENV.to_string(), port.to_string()));
    }
    let hooks = {
        let (output_app, exit_app) = (app.clone(), app.clone());
        let (output_id, exit_id) = (session_id.clone(), session_id.clone());
        SessionHooks {
            first_output: Box::new(move || {
                live::update_and_emit(&output_app, |map| map.first_output(&output_id));
            }),
            exit: Box::new(move |_code| {
                // The token dies with the session (a later POST with it is 401) and its settings
                // file goes, both before the node shows `exited`: once it does, a resume of the
                // same id can issue its own.
                exit_app.state::<AppState>().hooks.drop_session(&exit_id);
                exit_app.state::<AppState>().launcher.remove_settings(&exit_id);
                exit_app.state::<AppState>().launcher.forget_add_dirs(&exit_id);
                // Its context edges' live state goes before the node shows `exited`, so a Restart
                // with flags waiting for that exit marks the resumed run's edges after it (6.3).
                live_edges::session_exited(&exit_app, &exit_id);
                live::update_and_emit(&exit_app, |map| map.process_exited(&exit_id));
                // Its agent requests still waiting on the operator go (Story 7.2), after it is
                // marked exited: `approvals::ask` refuses an exited caller under the same lock.
                crate::approvals::caller_exited(&exit_app, &exit_id);
            }),
        }
    };
    let term = match state
        .terms
        .open_session(&term_id, &launch.project_id, &launch.name, &launch.cwd, size, spec, sink(app), hooks)
    {
        Ok(term) => term,
        Err(message) => {
            forget();
            state.launcher.remove_settings(&session_id);
            if fork_of.is_some() {
                graph::clear_forked_from(app, &launch.project_id, &session_id);
            }
            undo_mapping(&created_node);
            give_back();
            return Err(message);
        }
    };
    // A resumed session's terminal may still be in a pop-out showing the earlier run (Story 4.5):
    // now that the new run started, it returns to the pane, before its first output goes out
    // (the pane's view answers the new program's queries).
    windows::return_to_pane(app, &term.id);
    // A `starting` child on the canvas now, before any poll.
    live::update_and_emit(app, |_| true);
    Ok(LaunchResult {
        session_id,
        term,
        choices: LaunchChoices::of(&launch.request),
        skipped: launch.skipped.clone(),
    })
}

// ---------------------------------------------------------------------------------------
// Agent launches (Story 7.2): `start_session` from the `switchboard` MCP server
// ---------------------------------------------------------------------------------------

/// What an agent's `start_session` asks for, parsed (`crate::mcp::act`). `None` choices take the
/// launch sheet's prefill (the project's last choices, else settings, else `default`).
#[derive(Debug, Clone, Default)]
pub struct AgentStart {
    pub project_id: String,
    /// A branch launch (Story 5.3): the branch must have a worktree (or be checked out in the
    /// project's folder); none is ever created for an agent.
    pub branch: Option<String>,
    pub prompt: Option<String>,
    pub name: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub add_dirs: Vec<String>,
    /// `cooperateWithMe`: the caller's session id, to be joined to the new session by a
    /// cooperate edge before its system prompt is built.
    pub cooperate_with: Option<String>,
}

/// An agent launch, built and checked but not started: the toast shows [`AgentLaunch::argv`],
/// and [`start_agent_launch`] runs exactly that or nothing.
pub struct AgentLaunch {
    launch: Launch,
    argv: Vec<String>,
    cooperate_with: Option<String>,
}

impl AgentLaunch {
    /// The exact argv the start runs: the program, then every argument (`--mcp-config` included
    /// while the endpoint is up).
    pub fn argv(&self) -> &[String] {
        &self.argv
    }

    pub fn session_id(&self) -> &str {
        &self.launch.session_id
    }

    pub fn name(&self) -> &str {
        &self.launch.name
    }
}

/// The argv a launch with `program` and `args` runs: with the endpoint up, `run_launch` adds
/// `--mcp-config <dir>/<id>.mcp.json` (Story 7.1).
fn full_argv(state: &AppState, program: &Path, args: Vec<String>, session_id: &str) -> Vec<String> {
    let args = match (state.hooks.port(), state.launcher.dir()) {
        (Some(_), Some(dir)) => launch::with_mcp_config(args, &launch::mcp_path(&dir, session_id)),
        _ => args,
    };
    std::iter::once(program.display().to_string()).chain(args).collect()
}

/// Build an agent's launch through the launch sheet's path (Story 7.2): a fresh session id, the
/// default name `<label>-<4 hex>` unless one is given, the sheet's prefilled choices, the folders
/// the project's context edges grant then the agent's add-dirs (normalised against the folder the
/// session runs in), `bypassPermissions` refused, and the exact argv. A branch without a worktree
/// is [`launch::NO_WORKTREE`]. Nothing is written or started. Blocking (folders are checked).
pub fn plan_agent_launch(state: &AppState, start: AgentStart) -> Result<AgentLaunch, String> {
    let (label, project_defaults) = {
        let ws = state.read_workspace();
        let project = ws
            .workspace
            .projects
            .iter()
            .find(|p| p.id == start.project_id)
            .ok_or_else(|| "unknown project".to_string())?;
        (project.label.clone(), project.launch_defaults.clone())
    };
    // `cooperateWithMe` needs the caller on the canvas (an edge must end on it): checked now, not
    // after the operator allowed it.
    if let Some(caller) = &start.cooperate_with {
        let end = graph::NodeRef {
            kind: graph::NodeType::Session,
            id: caller.clone(),
        };
        if !graph::is_edge_end(&state.read_workspace(), &end) {
            return Err(NOT_AN_EDGE_END.to_string());
        }
    }
    let session_id = uuid::Uuid::new_v4().to_string();
    let name = start
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map_or_else(|| launch::default_name(&label, &session_id), str::to_string);
    let settings = state.read().settings.defaults.clone();
    let prefill = launch::prefill(project_defaults.as_ref(), &settings, session_id.clone(), name.clone());
    let choice = |given: &Option<String>, prefilled: String| Some(given.clone().filter(|v| !v.trim().is_empty()).unwrap_or(prefilled));
    let request = LaunchRequest {
        project_id: start.project_id.clone(),
        session_id: session_id.clone(),
        name,
        model: choice(&start.model, prefill.model),
        effort: choice(&start.effort, prefill.effort),
        permission_mode: choice(&start.permission_mode, prefill.permission_mode),
        add_dirs: start.add_dirs.clone(),
        prompt: start.prompt.clone().filter(|p| !p.trim().is_empty()),
        background: true,
        branch: start.branch.clone(),
        create_worktree: false,
        worktree_name: None,
    };
    let (mut launch, create) = new_launch(state, request)?;
    if create.is_some() {
        return Err(launch::NO_WORKTREE.to_string());
    }
    // The sheet prefills the folders the project's context edges grant: so does an agent's start.
    let source = [graph::NodeRef {
        kind: graph::NodeType::Project,
        id: launch.project_id.clone(),
    }];
    let granted: Vec<String> = edge_add_dirs(state, &source, &launch.cwd).0.into_iter().map(|d| d.path).collect();
    let wanted: Vec<String> = granted.into_iter().chain(launch.request.add_dirs.iter().cloned()).collect();
    launch.request.add_dirs = launch::normalise_add_dirs(&wanted, &launch.cwd)?;
    let extra = match &start.cooperate_with {
        Some(caller) => graph::name_peers(state, vec![(caller.clone(), None)]),
        None => Vec::new(),
    };
    let (program, args) = prepare_launch_with(state, &launch, &extra)?;
    let argv = full_argv(state, &program, args, &launch.session_id);
    Ok(AgentLaunch {
        launch,
        argv,
        cooperate_with: start.cooperate_with,
    })
}

/// Why `cooperateWithMe` is refused before any toast: the caller is not a node an edge can end on.
pub const NOT_AN_EDGE_END: &str = "cooperateWithMe needs this session on the canvas; it is not";

/// Why an allowed agent launch did not start: what it would run changed while the toast waited
/// (the caller was renamed, an edge changed the add-dirs, ...).
pub const LAUNCH_CHANGED: &str = "the launch changed while it waited for the operator; nothing was started";

/// Start an allowed agent launch (Story 7.2), in the background (no terminal is focused). With
/// `cooperateWithMe`, the new session's [`graph::SessionRef`] and the cooperate edge between the
/// caller and it are stored first, so its system prompt names the caller as a peer. The argv is
/// built again and must be the one the operator saw ([`LAUNCH_CHANGED`] otherwise); any failure
/// takes the edge and the ref back. The project's choices are not remembered (they are the
/// agent's, not the operator's). Blocking.
pub fn start_agent_launch<R: Runtime>(app: &AppHandle<R>, plan: AgentLaunch, size: (u16, u16)) -> Result<LaunchResult, String> {
    let state = app.state::<AppState>();
    let AgentLaunch { launch, argv, cooperate_with } = plan;
    let (project_id, session_id) = (launch.project_id.clone(), launch.session_id.clone());
    let mut created_ref = false;
    let mut edge_id: Option<String> = None;
    if let Some(caller) = &cooperate_with {
        created_ref = graph::add_session_ref(app, &session_id, &project_id, launch.branch_id.as_deref())?;
        let caller_end = graph::NodeRef {
            kind: graph::NodeType::Session,
            id: caller.clone(),
        };
        let new_end = graph::NodeRef {
            kind: graph::NodeType::Session,
            id: session_id.clone(),
        };
        match graph::add_edge(app, &caller_end, &new_end) {
            Ok(edge) => edge_id = Some(edge.id),
            Err(message) => {
                if created_ref {
                    graph::remove_session_ref(app, &session_id, &project_id);
                }
                return Err(message);
            }
        }
    }
    let undo = || {
        if let Some(id) = &edge_id {
            let _ = graph::remove_edge(app, id);
        }
        if created_ref {
            graph::remove_session_ref(app, &session_id, &project_id);
        }
    };
    let (program, args) = match prepare_launch(&state, &launch) {
        Ok(prepared) => prepared,
        Err(message) => {
            undo();
            return Err(message);
        }
    };
    if full_argv(&state, &program, args.clone(), &session_id) != argv {
        undo();
        return Err(LAUNCH_CHANGED.to_string());
    }
    run_launch(app, launch, program, args, size, &undo)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_reports_cargo_package_name_and_version() {
        let info = app_info();
        assert_eq!(info.name, env!("CARGO_PKG_NAME"));
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.name, "switchboard");
        assert!(!info.version.is_empty());
    }

    #[test]
    fn app_info_serialises_to_the_shape_the_ui_expects() {
        let json = serde_json::to_value(app_info()).unwrap();
        assert_eq!(json["name"], "switchboard");
        assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn editor_program_is_the_templates_first_token_or_none() {
        assert_eq!(editor_program(Some("code -g {file}:{line}")).as_deref(), Some("code"));
        assert_eq!(editor_program(Some("  subl  ")).as_deref(), Some("subl"));
        assert_eq!(editor_program(Some("C:\\Tools\\code.cmd")).as_deref(), Some("C:\\Tools\\code.cmd"));
        assert_eq!(
            editor_program(Some("\"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd\" -g {file}:{line}")).as_deref(),
            Some("C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd")
        );
        assert_eq!(editor_program(Some("  \"/opt/my editor/bin/ed\"")).as_deref(), Some("/opt/my editor/bin/ed"));
        assert_eq!(editor_program(Some("\"unterminated path")).as_deref(), Some("unterminated path"));
        assert_eq!(editor_program(Some("\"\" -g")), None);
        assert_eq!(editor_program(Some("   ")), None);
        assert_eq!(editor_program(Some("")), None);
        assert_eq!(editor_program(None), None);
    }

    #[test]
    fn resolve_program_searches_a_bare_name_and_takes_a_path_as_given() {
        let dir = tempfile::tempdir().unwrap();
        let code = crate::settings::detect::fixtures::fake_binary(dir.path(), "code");
        let search = Search {
            path_dirs: vec![dir.path().to_path_buf()],
            extra_dirs: vec![],
            extensions: crate::settings::detect::platform_extensions(),
        };
        assert_eq!(resolve_program("code", &search), Ok(code.clone()));
        assert_eq!(
            resolve_program("subl", &search),
            Err("external editor subl not found on PATH".to_string())
        );
        let spelled = code.display().to_string();
        assert_eq!(resolve_program(&spelled, &search), Ok(code));
        let missing = dir.path().join("nope.exe").display().to_string();
        assert_eq!(
            resolve_program(&missing, &search),
            Err(format!("external editor {missing} does not exist"))
        );
    }

    #[test]
    fn editor_command_spawns_the_program_with_the_folder_as_its_only_argument() {
        let direct = editor_command(Path::new("/usr/bin/code"), "/home/me/src");
        assert_eq!(direct.get_program(), "/usr/bin/code");
        assert_eq!(direct.get_args().collect::<Vec<_>>(), ["/home/me/src"]);

        // A batch file too: std routes it through cmd.exe and escapes the argument itself.
        let batch = editor_command(Path::new("C:\\Tools\\code.CMD"), "B:\\");
        assert_eq!(batch.get_program(), "C:\\Tools\\code.CMD");
        assert_eq!(batch.get_args().collect::<Vec<_>>(), ["B:\\"]);
    }

    #[test]
    fn claude_project_dir_finds_the_dir_whose_cwd_is_the_folder() {
        let home = tempfile::tempdir().unwrap();
        let real = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        for (name, cwd) in [("X--one", real.path()), ("X--two", other.path())] {
            let dir = home.path().join("projects").join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("s.jsonl"),
                format!("{{\"type\":\"user\",\"cwd\":{}}}\n", serde_json::to_string(&cwd.display().to_string()).unwrap()),
            )
            .unwrap();
        }
        let canonical = dunce::canonicalize(real.path()).unwrap().display().to_string();
        assert_eq!(
            claude_project_dir(home.path(), &canonical),
            Some(home.path().join("projects").join("X--one"))
        );
        // The comparison is the import pane's: case-insensitive on Windows only.
        assert_eq!(
            claude_project_dir(home.path(), &canonical.to_ascii_uppercase()).is_some(),
            cfg!(windows) || canonical == canonical.to_ascii_uppercase()
        );
        let elsewhere = tempfile::tempdir().unwrap();
        assert_eq!(claude_project_dir(home.path(), &elsewhere.path().display().to_string()), None);
        assert_eq!(claude_project_dir(&home.path().join("no-such-home"), &canonical), None);
    }

    #[test]
    fn shell_command_splits_the_setting_or_falls_back_to_the_platform_default() {
        assert_eq!(shell_command(Some("pwsh -NoLogo")), ("pwsh".to_string(), vec!["-NoLogo".to_string()]));
        assert_eq!(
            shell_command(Some("\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -NoLogo -NoProfile")),
            (
                "C:\\Program Files\\PowerShell\\7\\pwsh.exe".to_string(),
                vec!["-NoLogo".to_string(), "-NoProfile".to_string()]
            )
        );
        assert_eq!(shell_command(Some("  /bin/bash  ")), ("/bin/bash".to_string(), vec![]));
        // Quoted arguments keep their spaces; an empty program is the default shell.
        assert_eq!(
            shell_command(Some("pwsh -NoLogo -Command \"Write-Host 'a b'\" x")),
            (
                "pwsh".to_string(),
                vec!["-NoLogo".to_string(), "-Command".to_string(), "Write-Host 'a b'".to_string(), "x".to_string()]
            )
        );
        assert_eq!(shell_command(Some("\"\" -l")).1, Vec::<String>::new());
        assert_eq!(shell_command(Some("\"\" -l")).0, shell_command(None).0);
        assert_eq!(split_command_line("a\"b c\"d  \"unterminated x"), vec!["ab cd".to_string(), "unterminated x".to_string()]);
        assert_eq!(split_command_line("   "), Vec::<String>::new());
        let (default, args) = shell_command(Some("   "));
        assert!(args.is_empty());
        assert_eq!(shell_command(None).0, default);
        if cfg!(windows) {
            assert!(default == "pwsh" || default == "powershell", "{default}");
        } else {
            assert!(!default.is_empty());
        }
    }

    #[test]
    fn shell_spec_resolves_like_the_editor_and_names_the_shell_when_it_cannot() {
        let dir = tempfile::tempdir().unwrap();
        let sh = crate::settings::detect::fixtures::fake_binary(dir.path(), "fakesh");
        let search = Search {
            path_dirs: vec![dir.path().to_path_buf()],
            extra_dirs: vec![],
            extensions: crate::settings::detect::platform_extensions(),
        };
        let spec = shell_spec(Some("fakesh -l"), &search, "/work").unwrap();
        assert_eq!(spec.program, sh);
        assert_eq!(spec.args, vec!["-l".to_string()]);
        assert_eq!(spec.cwd, PathBuf::from("/work"));
        assert_eq!(
            shell_spec(Some("zsh"), &search, "/work"),
            Err("could not start zsh: not found on PATH".to_string())
        );
        let gone = dir.path().join("gone-sh").display().to_string();
        assert_eq!(
            shell_spec(Some(&gone), &search, "/work"),
            Err(format!("could not start {gone}: it does not exist"))
        );
    }
}
