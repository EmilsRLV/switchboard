//! Tauri IPC commands. Each command is thin: validate, then delegate.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_opener::OpenerExt;

use crate::claude::hooks::{self, DiagnosticsSnapshot};
use crate::claude::launch::{self, LaunchPrefill, LaunchRequest};
use crate::claude::live::{self, LiveSnapshot};
use crate::claude::{self, ClaudeProject};
use crate::git::{self, ProjectStatus};
use crate::graph::{self, AddProjectsResult, NodeTarget, Position, Viewport, WorkspaceSnapshot};
use crate::process;
use crate::pty::{self, EventSink, SessionHooks, SpawnSpec, TermBuffer, TermInfo, TermKind};
use crate::settings::detect::Search;
use crate::settings::{self, AppState, Snapshot};

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
    // Its terminals go too: their children are killed and the terminals forgotten.
    let terms_app = app.clone();
    let forget_id = project_id.clone();
    blocking(move || terms_app.state::<AppState>().terms.forget_project(&forget_id)).await?;
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
    app.state::<AppState>().terms.write(&id, data.as_bytes())?;
    if let Some(session_id) = id.strip_prefix(pty::SESSION_PREFIX) {
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
        state.terms.restart(&id, move || plain_spec(&spec_app, &cwd), sink(&app))
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
    blocking(move || app.state::<AppState>().terms.close(&id)).await?
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
}

/// The launch sheet's prefill for a project: its last choices, else `settings.defaults`, else
/// `default`, and the default name `<label>-<4 hex>` of the fresh session id the next launch
/// from this project will use.
#[tauri::command]
pub fn launch_defaults(state: State<'_, AppState>, project_id: String) -> Result<LaunchPrefill, String> {
    let (label, project_defaults) = {
        let ws = state.read_workspace();
        let project = ws
            .workspace
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .ok_or_else(|| "unknown project".to_string())?;
        (project.label.clone(), project.launch_defaults.clone())
    };
    let settings = state.read().settings.defaults.clone();
    let session_id = state.launcher.propose(&project_id);
    let name = launch::default_name(&label, &session_id);
    Ok(launch::prefill(project_defaults.as_ref(), &settings, session_id, name))
}

/// Start a Claude session from the launch sheet: Rust assigns the id, writes the settings
/// file, builds the argv and runs `claude` in a session terminal (`session:<id>`, titled with
/// the name, in the project folder) at `cols` × `rows` (else 120 × 30). The session is a
/// `starting` live child at once and turns `idle` on its first output; its exit turns it
/// `exited` and deletes the settings file. The project remembers the choices. Every refusal is
/// an `Err` the sheet shows, with nothing started.
#[tauri::command]
pub async fn session_launch<R: Runtime>(
    app: AppHandle<R>,
    request: LaunchRequest,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<LaunchResult, String> {
    let size = (cols.unwrap_or(pty::DEFAULT_COLS), rows.unwrap_or(pty::DEFAULT_ROWS));
    blocking(move || launch_session(&app, request, size)).await?
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

/// The work of [`session_launch`], on a blocking thread. Everything that can be checked
/// without side effects is checked first; then the sheet's session id is claimed (atomically,
/// once), and a failure after that undoes only what this call created and gives the id back.
pub fn launch_session<R: Runtime>(app: &AppHandle<R>, request: LaunchRequest, size: (u16, u16)) -> Result<LaunchResult, String> {
    let state = app.state::<AppState>();
    let (path, label) = {
        let ws = state.read_workspace();
        let project = ws
            .workspace
            .projects
            .iter()
            .find(|p| p.id == request.project_id)
            .ok_or_else(|| "unknown project".to_string())?;
        (project.path.clone(), project.label.clone())
    };
    let (program, leading) = launch_program(&state)?;
    let extensions = if cfg!(windows) { settings::detect::platform_extensions() } else { Vec::new() };
    launch::refuse_batch(&launch::pathext_target(&program, &extensions), cfg!(windows))?;
    let name = launch::validate_name(&request.name)?;
    let request = LaunchRequest {
        add_dirs: launch::normalise_add_dirs(&request.add_dirs, &path)?,
        ..request
    };
    let dir = state.launcher.dir().ok_or_else(|| "no folder for session settings files".to_string())?;
    let session_id = request.session_id.clone();
    let branch = match state.read_live().statuses.get(&request.project_id) {
        Some(git::ProjectStatus::Repo(repo)) if !repo.detached => Some(repo.branch.clone()),
        _ => None,
    };
    let context = launch::system_prompt(&label, &path, branch.as_deref(), &name, &session_id);
    let mut args = leading;
    args.extend(launch::build_args(&request, &session_id, &launch::settings_path(&dir, &session_id), &context)?);

    // The id the sheet showed, once: a stale sheet or a second start is refused here.
    state.launcher.claim(&request.project_id, &session_id)?;
    let give_back = || state.launcher.unclaim(&request.project_id, &session_id);
    let term_id = pty::session_id(&session_id);
    if state.terms.get(&term_id).is_some() {
        give_back();
        return Err(launch::ID_IN_USE.to_string());
    }
    // In the live map before the spawn, so the first output always finds it; an id the map
    // already knows is refused (it is someone else's).
    {
        let mut map = state.write_sessions_live();
        if map.sessions.contains_key(&session_id) {
            drop(map);
            give_back();
            return Err(launch::ID_IN_USE.to_string());
        }
        map.launched(&session_id, Some(request.project_id.clone()), &path, &name, live::now_ms());
    }
    let forget = || {
        state.hooks.drop_session(&session_id);
        live::update_and_emit(app, |map| {
            map.forget(&session_id);
            true
        });
    };
    // Hooks (Story 4.3) while the endpoint is up: a token for this session, the hooks block in
    // its settings file, its port in the env. Otherwise `{}` and no port, as in Story 4.2.
    let port = state.hooks.port();
    let content = match port {
        Some(port) => {
            // The session counts as hooked only once its first hook event is accepted.
            let token = state.hooks.register(&session_id);
            serde_json::to_string_pretty(&hooks::settings_json(port, &token)).unwrap_or_else(|_| launch::SETTINGS_CONTENT.to_string())
        }
        None => launch::SETTINGS_CONTENT.to_string(),
    };
    if let Err(message) = state.launcher.write_settings_with(&session_id, &content) {
        forget();
        give_back();
        return Err(message);
    }
    let mut spec = SpawnSpec::new(program, args, &path);
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
                // The token dies with the session: a later POST with it is 401.
                exit_app.state::<AppState>().hooks.drop_session(&exit_id);
                live::update_and_emit(&exit_app, |map| map.process_exited(&exit_id));
                exit_app.state::<AppState>().launcher.remove_settings(&exit_id);
            }),
        }
    };
    let term = match state.terms.open_session(&term_id, &request.project_id, &name, &path, size, spec, sink(app), hooks) {
        Ok(term) => term,
        Err(message) => {
            forget();
            state.launcher.remove_settings(&session_id);
            give_back();
            return Err(message);
        }
    };
    // A `starting` live-only child on the canvas now, before any poll.
    live::update_and_emit(app, |_| true);
    if let Err(err) = graph::set_launch_defaults(app, &request.project_id, launch::remembered(&request)) {
        eprintln!("launch: could not remember the choices: {err}");
    }
    Ok(LaunchResult { session_id, term })
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
