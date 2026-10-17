//! Tauri IPC commands. Each command is thin: validate, then delegate.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_opener::OpenerExt;

use crate::claude::{self, ClaudeProject};
use crate::git::{self, ProjectStatus};
use crate::graph::{self, AddProjectsResult, NodeTarget, Position, Viewport, WorkspaceSnapshot};
use crate::process;
use crate::settings::detect::Search;
use crate::settings::{self, AppState, Snapshot};

/// The notice behind "Open in external editor" when `settings.external_editor` is unset.
pub const NO_EDITOR: &str = "No external editor configured — set external_editor in settings";

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
        let sessions_app = app.clone();
        tauri::async_runtime::spawn(async move {
            git::poll::refresh_ids(&app, &ids).await;
        });
        // The new cards' sessions fill in now, not at the next 5 s tick.
        tauri::async_runtime::spawn(async move {
            claude::sessions::refresh(&sessions_app).await;
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

/// Take a project off the canvas (`project.remove`): `graph::remove_project` drops it with
/// its session refs, branches and edges and emits `workspace://changed`; then its live git
/// status is forgotten and `projects://status` emitted. Replies with the workspace snapshot,
/// or `Err("unknown project")` with nothing changed.
#[tauri::command]
pub async fn workspace_remove_project<R: Runtime>(app: AppHandle<R>, project_id: String) -> Result<WorkspaceSnapshot, String> {
    let snapshot = graph::remove_project(&app, &project_id)?;
    git::poll::forget(&app, &project_id).await;
    // Drop the removed project's discovered sessions now, not at the next tick.
    let sessions_app = app.clone();
    tauri::async_runtime::spawn(async move {
        claude::sessions::refresh(&sessions_app).await;
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
    let expanded = settings::detect::expand_home(program);
    let path = Path::new(&expanded);
    if path.is_absolute() || path.components().count() > 1 {
        if path.is_file() {
            Ok(path.to_path_buf())
        } else {
            Err(format!("external editor {program} does not exist"))
        }
    } else {
        search
            .locate(program)
            .map(|located| located.path)
            .ok_or_else(|| format!("external editor {program} not found on PATH"))
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
}
