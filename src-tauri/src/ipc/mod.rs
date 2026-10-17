//! Tauri IPC commands. Each command is thin: validate, then delegate.

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_opener::OpenerExt;

use crate::claude::{self, ClaudeProject};
use crate::git::{self, ProjectStatus};
use crate::graph::{self, AddProjectsResult, NodeTarget, Position, Viewport, WorkspaceSnapshot};
use crate::settings::{self, AppState, Snapshot};

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
pub async fn project_pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    if cfg!(test) {
        return Ok(None);
    }
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title("Add project folder");
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
        tauri::async_runtime::spawn(async move {
            git::poll::refresh_ids(&app, &ids).await;
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

/// Put a project's children back into their column (`project.relayout`): clears their
/// stored positions and prunes session refs left bare. Replies with the snapshot, or
/// `Err("unknown project")`.
#[tauri::command]
pub async fn workspace_relayout_children<R: Runtime>(app: AppHandle<R>, project_id: String) -> Result<WorkspaceSnapshot, String> {
    graph::relayout_children(&app, &project_id)
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

/// Exit the app with status 0 (the `app.quit` command, `ctrl+q`). Under `cfg(test)` it only
/// returns, so the wire-name test can invoke it without ending the test process.
#[tauri::command]
pub fn app_quit<R: Runtime>(app: AppHandle<R>) {
    if !cfg!(test) {
        app.exit(0);
    }
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
}
