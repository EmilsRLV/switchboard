//! The workspace: the one app-written `workspace.json` beside `settings.json`, holding the
//! canvas viewport and (from Story 2.2 on) the nodes and edges placed on it. Rust is the
//! source of truth: every mutation is a thin command delegating here, and the webview sees a
//! [`WorkspaceSnapshot`] via `workspace_get` and the `workspace://changed` event.
//!
//! The complete v1 envelope (architecture §5.1) is defined now so later epics add no
//! migration; Stories 2.1 and 2.2 read and write `viewport` and `projects`.

pub mod store;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::persist::{self, LoadError};
use crate::settings::{AppState, Banner, paths};

/// Event name carrying a [`WorkspaceSnapshot`] to the webview whenever the workspace or its
/// banners change.
pub const CHANGED_EVENT: &str = "workspace://changed";

/// Schema version written to `workspace.json`.
pub const SCHEMA_VERSION: u32 = 1;

/// Zoom limits of the canvas; mirrored by `src/canvas/limits.ts`. A viewport outside them
/// cannot have come from the canvas.
pub const MIN_ZOOM: f64 = 0.1;
pub const MAX_ZOOM: f64 = 4.0;

/// Appended to the banner that explains why the file is left alone.
const NOT_SAVED: &str = "; changes are kept in memory and not saved";

/// Several projects added at once (a multi-folder drop, an import) are placed this many
/// canvas pixels apart on both axes, so none hides another.
pub const FAN_OUT_STEP: f64 = 24.0;

/// Upper bound for `SWITCHBOARD_STUB_CHILDREN`: stub session children per project (Story
/// 2.3 proves layout, drag and persistence with them; Epics 3/5 bring the real ones).
pub const MAX_STUB_CHILDREN: usize = 50;

// ---------------------------------------------------------------------------------------
// Schema (architecture §5.1); keys are camelCase on disk, as the TS types there spell them
// ---------------------------------------------------------------------------------------

/// The workspace file. Every field has a default so missing keys are filled in, and serde
/// ignores unknown keys, so older/newer files both load.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Workspace {
    pub version: u32,
    pub viewport: Viewport,
    pub projects: Vec<Project>,
    /// Only the branches the operator placed or created.
    pub branches: Vec<BranchNode>,
    /// Pins, labels and positions; discovery fills in the rest at runtime.
    pub sessions: Vec<SessionRef>,
    pub edges: Vec<Edge>,
    pub defaults: LaunchDefaults,
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            viewport: Viewport::default(),
            projects: Vec::new(),
            branches: Vec::new(),
            sessions: Vec::new(),
            edges: Vec::new(),
            defaults: LaunchDefaults::default(),
        }
    }
}

/// The canvas transform: pan offset in pixels and zoom factor.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        }
    }
}

impl Viewport {
    /// A viewport fit to store: `None` when any component is NaN or infinite (serde_json
    /// would write those as `null`, which the next launch could not parse), otherwise the
    /// same viewport with `zoom` clamped into `[MIN_ZOOM, MAX_ZOOM]`.
    pub fn sanitised(self) -> Option<Viewport> {
        if !(self.x.is_finite() && self.y.is_finite() && self.zoom.is_finite()) {
            return None;
        }
        Some(Viewport {
            zoom: self.zoom.clamp(MIN_ZOOM, MAX_ZOOM),
            ..self
        })
    }

    /// True when the viewport can be shown as-is: finite, with `zoom` inside the limits.
    pub fn is_usable(self) -> bool {
        self.sanitised() == Some(self)
    }
}

/// A node position on the canvas, in canvas (unzoomed) coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

/// A folder on the canvas (Story 2.2).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub path: String,
    pub label: String,
    pub position: Position,
    pub expanded: bool,
    pub color: Option<String>,
    pub launch_defaults: Option<LaunchDefaults>,
}

/// A branch node the operator placed under a project (Epic 5).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BranchNode {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub worktree_path: Option<String>,
    pub position: Option<Position>,
}

/// What the operator pinned or labelled about a discovered session (Epic 3).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionRef {
    pub session_id: String,
    pub project_id: String,
    pub branch_id: Option<String>,
    pub label: Option<String>,
    pub pinned: bool,
    pub position: Option<Position>,
}

/// A relation drawn between two nodes (Epic 6).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Edge {
    pub id: String,
    pub from: NodeRef,
    pub to: NodeRef,
    pub kind: EdgeKind,
    pub label: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    #[default]
    Context,
    Cooperate,
}

/// One end of an edge. `folder` is an ad-hoc path target that is not a node.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NodeRef {
    #[serde(rename = "type")]
    pub kind: NodeType,
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeType {
    #[default]
    Project,
    Branch,
    Session,
    Folder,
}

/// Launch-sheet defaults for this workspace (Epic 4); `None` leaves it to `settings.json`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LaunchDefaults {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
}

// ---------------------------------------------------------------------------------------
// Children (Story 2.3): derived, type-independent, never persisted as such
// ---------------------------------------------------------------------------------------

/// What kind of child a [`ChildNode`] is. The layout does not care; Epics 3 and 5 do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChildKind {
    Session,
    Branch,
}

/// A child of a project as the canvas lays it out: one row of the column under the card.
/// Derived by [`children`] from `workspace.sessions` and `workspace.branches` (plus the stub
/// source), so later epics replace the derivation and keep the layout. `position` is
/// relative to the parent card's top-left and `None` for a child still in its column slot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildNode {
    pub id: String,
    pub project_id: String,
    pub kind: ChildKind,
    pub label: String,
    pub detail: Option<String>,
    pub position: Option<Position>,
}

/// The node types a position can be written for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Project,
    Session,
    Branch,
}

/// A node named by kind and id: the argument of [`move_node`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeTarget {
    pub kind: NodeKind,
    pub id: String,
}

/// Id of the `i`-th (1-based) stub session of `project_id`.
pub fn stub_session_id(index: usize, project_id: &str) -> String {
    format!("stub-{index}-{project_id}")
}

/// Every child of every project, collapsed ones included, in layout order: the project's
/// sessions in list order, then its branches. With no real sessions yet, the sessions are
/// `stubs` per project (`session 1..n`, detail `stub`), each taking its position from the
/// matching [`SessionRef`] when one exists; a ref whose session is not discovered yields
/// nothing. Branch children carry the worktree path as detail.
pub fn children(workspace: &Workspace, stubs: usize) -> Vec<ChildNode> {
    let mut out = Vec::new();
    for project in &workspace.projects {
        for i in 1..=stubs {
            let id = stub_session_id(i, &project.id);
            let position = workspace
                .sessions
                .iter()
                .find(|s| s.session_id == id && s.project_id == project.id)
                .and_then(|s| s.position);
            out.push(ChildNode {
                id,
                project_id: project.id.clone(),
                kind: ChildKind::Session,
                label: format!("session {i}"),
                detail: Some("stub".to_string()),
                position,
            });
        }
        for branch in workspace.branches.iter().filter(|b| b.project_id == project.id) {
            out.push(ChildNode {
                id: branch.id.clone(),
                project_id: project.id.clone(),
                kind: ChildKind::Branch,
                label: branch.name.clone(),
                detail: branch.worktree_path.clone(),
                position: branch.position,
            });
        }
    }
    out
}

impl SessionRef {
    /// True when the ref records nothing any more: no label, pin, branch or position. Such
    /// a ref is pruned by [`relayout_children`] (it only ever held a dragged position).
    pub fn is_bare(&self) -> bool {
        self.label.is_none() && !self.pinned && self.branch_id.is_none() && self.position.is_none()
    }
}

// ---------------------------------------------------------------------------------------
// State and snapshot
// ---------------------------------------------------------------------------------------

/// Everything the UI needs about the workspace, sent on request and on every change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceSnapshot {
    /// Absolute path of `workspace.json`; `None` when the config dir could not be determined.
    pub path: Option<String>,
    pub workspace: Workspace,
    pub banners: Vec<Banner>,
    /// Bumped on every mutation this session, so the UI can drop a reply that arrives after a
    /// newer snapshot (two adds in flight). Not persisted; starts at 0 on load.
    pub revision: u64,
    /// Every project's children ([`children`]), collapsed ones too; the UI lays them out.
    pub children: Vec<ChildNode>,
}

/// Reply of [`add_projects`]: the snapshot after the call plus which ids it concerns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AddProjectsResult {
    pub snapshot: WorkspaceSnapshot,
    /// Ids of the projects created by this call, in input order.
    pub added: Vec<String>,
    /// Ids of projects that were already on the canvas for a given path (the UI highlights
    /// them instead of adding a second node).
    pub existing: Vec<String>,
    /// Input paths that are not directories (a file dropped along with folders), ignored.
    pub skipped: Vec<String>,
}

/// Long-lived workspace state. `workspace` is always usable: a broken file on disk leaves
/// the defaults in memory and adds `file_banner`.
#[derive(Debug, Default)]
pub struct WorkspaceState {
    pub path: Option<PathBuf>,
    pub workspace: Workspace,
    /// Parse, read or write error for the file itself, if any.
    pub file_banner: Option<Banner>,
    /// Soft problems in the loaded workspace (`store::validate`).
    pub validation_banners: Vec<Banner>,
    /// Why the file must not be written this session: it exists but could not be read (it
    /// may well be valid), or it is from a newer build (writing v1 would lose its fields).
    /// Changes still apply in memory. The reason is for logs; the banner explains it to the
    /// operator.
    pub read_only: Option<&'static str>,
    /// Mutation counter for this session (see [`WorkspaceSnapshot::revision`]).
    pub revision: u64,
    /// Stub session children per project (`SWITCHBOARD_STUB_CHILDREN`, copied from
    /// `AppState` on load so `snapshot` stays pure); 0 unless the operator asked for them.
    pub stub_children: usize,
}

impl WorkspaceState {
    pub fn snapshot(&self) -> WorkspaceSnapshot {
        WorkspaceSnapshot {
            path: self.path.as_ref().map(|p| p.display().to_string()),
            workspace: self.workspace.clone(),
            banners: self
                .file_banner
                .iter()
                .chain(self.validation_banners.iter())
                .cloned()
                .collect(),
            revision: self.revision,
            children: children(&self.workspace, self.stub_children),
        }
    }

    /// Replace the workspace with a freshly parsed, validated one.
    fn accept(&mut self, mut workspace: Workspace) {
        self.validation_banners = store::validate(&mut workspace);
        self.read_only = (workspace.version > SCHEMA_VERSION).then_some("newer schema version");
        self.workspace = workspace;
        self.file_banner = None;
    }

    /// Where the next write goes: `None` when there is no path or the file is read-only.
    fn write_target(&self) -> Option<PathBuf> {
        if self.read_only.is_some() {
            return None;
        }
        self.path.clone()
    }
}

// ---------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------

/// Load (or create) the workspace file into the managed state and announce it. Called once
/// from Tauri's `setup`, after `settings::initialise`. Unlike settings there is no watcher:
/// the file is app-written, not hand-edited.
pub fn initialise<R: Runtime>(app: &AppHandle<R>) {
    initialise_at(app, paths::workspace_path());
    announce(app);
}

/// Emit the current snapshot as `workspace://changed`.
pub fn announce<R: Runtime>(app: &AppHandle<R>) {
    emit(app, &app.state::<AppState>().read_workspace().snapshot());
}

/// The loading half of [`initialise`]: read `path` (or create it with the defaults) into the
/// managed state. A broken file leaves the defaults in memory and is not rewritten until the
/// next viewport write; an unreadable or newer file is never written this session.
pub fn initialise_at<R: Runtime>(app: &AppHandle<R>, path: Option<PathBuf>) {
    let state = app.state::<AppState>();
    let mut st = state.write_workspace();
    *st = WorkspaceState {
        path: path.clone(),
        stub_children: state.stub_children.get().copied().unwrap_or(0),
        ..WorkspaceState::default()
    };

    let Some(path) = path else {
        st.file_banner = Some(Banner::new(
            "workspace.write",
            "cannot write workspace: no platform config directory",
        ));
        return;
    };
    // A crash between writing the temp file and renaming it leaves `.workspace.json-*.tmp`
    // behind; nothing else ever cleans those up.
    if let Err(err) = persist::sweep_temp_files(&path) {
        eprintln!("workspace: cannot sweep temp files beside {}: {err}", path.display());
    }
    match store::load_or_init(&path) {
        Ok(loaded) => st.accept(loaded.into_inner()),
        Err(LoadError::Parse(err)) => st.file_banner = Some(parse_banner(&path, &err)),
        Err(LoadError::Read(err)) => {
            st.read_only = Some("unreadable file");
            st.file_banner = Some(Banner::new(
                "workspace.read",
                format!("cannot read workspace: {err}{NOT_SAVED}"),
            ));
        }
        Err(LoadError::Write(err)) => st.file_banner = Some(write_banner(&err)),
    }
}

/// Store a new viewport, write the file atomically and emit `workspace://changed`. Returns
/// the resulting snapshot (also the command's reply). A viewport that cannot be stored (NaN
/// or infinite) is ignored: the current snapshot comes back and nothing is written. The disk
/// write happens with the lock released, so `workspace_get` never waits on an fsync.
pub fn set_viewport<R: Runtime>(app: &AppHandle<R>, viewport: Viewport) -> WorkspaceSnapshot {
    let state = app.state::<AppState>();
    let Some(viewport) = viewport.sanitised() else {
        return state.read_workspace().snapshot();
    };
    let (target, workspace) = {
        let mut st = state.write_workspace();
        st.workspace.viewport = viewport;
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    persist_and_emit(app, target, &workspace)
}

/// Add folders to the canvas as project nodes. Each path is canonicalised (`dunce`, so no
/// `\\?\` prefix on Windows); a path already on the canvas (same canonical path,
/// case-insensitive on Windows) is reported in `existing` rather than added again; a path
/// that is not a directory is reported in `skipped` (a lone dropped file is thus an `Ok`
/// that adds nothing). New nodes get a UUID v4, the given folder's own name as label (a
/// symlink keeps its name, its target becomes `path`) and `position` fanned out by
/// [`FAN_OUT_STEP`] per node, then nudged by the same step while an existing node sits
/// within one step of it on both axes. When something was added the file is written
/// (outside the lock) and `workspace://changed` emitted; otherwise the snapshot comes back
/// unchanged with nothing written or emitted. Only a non-finite position is an `Err`.
pub fn add_projects<R: Runtime>(
    app: &AppHandle<R>,
    paths: &[String],
    position: Position,
) -> Result<AddProjectsResult, String> {
    if !(position.x.is_finite() && position.y.is_finite()) {
        return Err("position is not finite".to_string());
    }
    let mut resolved: Vec<(String, String)> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for raw in paths {
        match canonical_dir(raw) {
            Some(path) => resolved.push((folder_label(raw.trim()), path)),
            None => skipped.push(raw.clone()),
        }
    }

    let state = app.state::<AppState>();
    let (target, workspace, added, existing) = {
        let mut st = state.write_workspace();
        let mut added: Vec<String> = Vec::new();
        let mut existing: Vec<String> = Vec::new();
        for (label, path) in resolved {
            if let Some(present) = st.workspace.projects.iter().find(|p| same_path(&p.path, &path)) {
                if !added.contains(&present.id) && !existing.contains(&present.id) {
                    existing.push(present.id.clone());
                }
                continue;
            }
            let index = added.len() as f64;
            let wanted = Position {
                x: position.x + index * FAN_OUT_STEP,
                y: position.y + index * FAN_OUT_STEP,
            };
            let project = Project {
                id: uuid::Uuid::new_v4().to_string(),
                label,
                path,
                position: free_position(wanted, &st.workspace.projects),
                expanded: false,
                color: None,
                launch_defaults: None,
            };
            added.push(project.id.clone());
            st.workspace.projects.push(project);
        }
        if !added.is_empty() {
            st.revision += 1;
        }
        if added.is_empty() {
            return Ok(AddProjectsResult {
                snapshot: st.snapshot(),
                added,
                existing,
                skipped,
            });
        }
        (st.write_target(), st.workspace.clone(), added, existing)
    };
    let snapshot = persist_and_emit(app, target, &workspace);
    Ok(AddProjectsResult {
        snapshot,
        added,
        existing,
        skipped,
    })
}

/// Expand or collapse a project: store `expanded`, bump the revision, write the file (outside
/// the lock) and emit `workspace://changed`. An unknown id is an `Err` and nothing changes.
pub fn set_expanded<R: Runtime>(app: &AppHandle<R>, project_id: &str, expanded: bool) -> Result<WorkspaceSnapshot, String> {
    let state = app.state::<AppState>();
    let (target, workspace) = {
        let mut st = state.write_workspace();
        let project = st
            .workspace
            .projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or_else(|| "unknown project".to_string())?;
        project.expanded = expanded;
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    Ok(persist_and_emit(app, target, &workspace))
}

/// Store where a node was dropped. A project's position is absolute; a child's is relative
/// to its parent card and goes where the schema keeps it: a session child upserts its
/// [`SessionRef`] (creating one holding just `sessionId`, `projectId`, `position` when the
/// session has no ref yet), a branch child sets `BranchNode.position`. A non-finite position
/// or an id that is not a known node (for a session: not a current child) is an `Err` and
/// nothing changes.
pub fn move_node<R: Runtime>(app: &AppHandle<R>, target: &NodeTarget, position: Position) -> Result<WorkspaceSnapshot, String> {
    if !(position.x.is_finite() && position.y.is_finite()) {
        return Err("position is not finite".to_string());
    }
    let state = app.state::<AppState>();
    let (write_target, workspace) = {
        let mut st = state.write_workspace();
        match target.kind {
            NodeKind::Project => {
                let project = st
                    .workspace
                    .projects
                    .iter_mut()
                    .find(|p| p.id == target.id)
                    .ok_or_else(|| "unknown project".to_string())?;
                project.position = position;
            }
            NodeKind::Session => {
                let project_id = children(&st.workspace, st.stub_children)
                    .into_iter()
                    .find(|c| c.kind == ChildKind::Session && c.id == target.id)
                    .map(|c| c.project_id)
                    .ok_or_else(|| "unknown session".to_string())?;
                // Both fields, exactly as `children()` matches a ref to its child: a same-id ref
                // under another project (hand-edited file) must not take the position.
                match st
                    .workspace
                    .sessions
                    .iter_mut()
                    .find(|s| s.session_id == target.id && s.project_id == project_id)
                {
                    Some(existing) => existing.position = Some(position),
                    None => st.workspace.sessions.push(SessionRef {
                        session_id: target.id.clone(),
                        project_id,
                        position: Some(position),
                        ..SessionRef::default()
                    }),
                }
            }
            NodeKind::Branch => {
                let branch = st
                    .workspace
                    .branches
                    .iter_mut()
                    .find(|b| b.id == target.id)
                    .ok_or_else(|| "unknown branch".to_string())?;
                branch.position = Some(position);
            }
        }
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    Ok(persist_and_emit(app, write_target, &workspace))
}

/// Put every child of a project back into its column slot: clear the stored positions of
/// its sessions and branches and drop the session refs left with nothing in them. An
/// unknown id is an `Err` and nothing changes.
pub fn relayout_children<R: Runtime>(app: &AppHandle<R>, project_id: &str) -> Result<WorkspaceSnapshot, String> {
    let state = app.state::<AppState>();
    let (target, workspace) = {
        let mut st = state.write_workspace();
        if !st.workspace.projects.iter().any(|p| p.id == project_id) {
            return Err("unknown project".to_string());
        }
        for session in st.workspace.sessions.iter_mut().filter(|s| s.project_id == project_id) {
            session.position = None;
        }
        st.workspace.sessions.retain(|s| s.project_id != project_id || !s.is_bare());
        for branch in st.workspace.branches.iter_mut().filter(|b| b.project_id == project_id) {
            branch.position = None;
        }
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    Ok(persist_and_emit(app, target, &workspace))
}

/// The canonical form of `raw` when it is an existing directory, as stored in `Project.path`.
fn canonical_dir(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = dunce::canonicalize(trimmed).ok()?;
    path.is_dir().then(|| path.display().to_string())
}

/// Two stored paths name the same folder: byte-equal, or equal ignoring ASCII case on
/// Windows (whose file systems are case-insensitive).
pub(crate) fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// The node label: the folder's own name; for a root (`C:\`, `/`) the whole path.
fn folder_label(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| path.to_string())
}

/// At most this many [`FAN_OUT_STEP`] nudges away from the wanted position.
const MAX_NUDGES: u32 = 50;

/// `wanted`, moved by [`FAN_OUT_STEP`] on both axes while an existing project lies within one
/// step of it on both axes (so a second `ctrl+o` does not land exactly on the first card),
/// giving up after [`MAX_NUDGES`].
fn free_position(wanted: Position, projects: &[Project]) -> Position {
    let mut position = wanted;
    for _ in 0..MAX_NUDGES {
        let crowded = projects
            .iter()
            .any(|p| (p.position.x - position.x).abs() < FAN_OUT_STEP && (p.position.y - position.y).abs() < FAN_OUT_STEP);
        if !crowded {
            break;
        }
        position.x += FAN_OUT_STEP;
        position.y += FAN_OUT_STEP;
    }
    position
}

/// The second half of every mutation: write `workspace` to `target` (if any) with the lock
/// released, record the outcome as the file banner, emit and return the snapshot.
fn persist_and_emit<R: Runtime>(app: &AppHandle<R>, target: Option<PathBuf>, workspace: &Workspace) -> WorkspaceSnapshot {
    let state = app.state::<AppState>();
    let outcome = target.map(|path| store::write(&path, workspace));
    let snapshot = {
        let mut st = state.write_workspace();
        match outcome {
            // The file is good now, whatever it was before (a parse banner clears).
            Some(Ok(())) => st.file_banner = None,
            Some(Err(err)) => st.file_banner = Some(write_banner(&err)),
            None => {} // no path or read-only: the explaining banner stays
        }
        st.snapshot()
    };
    emit(app, &snapshot);
    snapshot
}

fn parse_banner(path: &Path, err: &persist::ParseError) -> Banner {
    let file = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| paths::WORKSPACE_FILE_NAME.to_string());
    Banner::new("workspace.parse", format!("{file}:{err}"))
}

fn write_banner(err: &std::io::Error) -> Banner {
    Banner::new("workspace.write", format!("cannot write workspace: {err}"))
}

fn emit<R: Runtime>(app: &AppHandle<R>, snapshot: &WorkspaceSnapshot) {
    if let Err(err) = app.emit(CHANGED_EVENT, snapshot.clone()) {
        eprintln!("workspace: emit failed: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use tauri::Listener;
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

    fn mock_app() -> tauri::App<MockRuntime> {
        crate::with_commands(mock_builder())
            .build(mock_context(noop_assets()))
            .expect("mock app should build")
    }

    /// Collect every `workspace://changed` payload emitted after this call.
    fn listen(app: &tauri::App<MockRuntime>) -> mpsc::Receiver<WorkspaceSnapshot> {
        let (tx, rx) = mpsc::channel();
        app.listen_any(CHANGED_EVENT, move |event| {
            let _ = tx.send(serde_json::from_str(event.payload()).expect("snapshot payload"));
        });
        rx
    }

    const BROKEN: &str = "{\n  \"version\": 1,\n  \"viewport\": }\n";

    fn moved() -> Viewport {
        Viewport {
            x: -120.0,
            y: 40.0,
            zoom: 1.5,
        }
    }

    fn with_zoom(zoom: f64) -> Viewport {
        Viewport { zoom, ..moved() }
    }

    #[test]
    fn defaults_match_the_recorded_decisions() {
        let ws = Workspace::default();
        assert_eq!(ws.version, 1);
        assert_eq!(ws.viewport, Viewport { x: 0.0, y: 0.0, zoom: 1.0 });
        assert!(ws.projects.is_empty());
        assert!(ws.branches.is_empty());
        assert!(ws.sessions.is_empty());
        assert!(ws.edges.is_empty());
        assert_eq!(ws.defaults, LaunchDefaults::default());
        assert_eq!(ws.defaults.permission_mode, None, "workspace defaults inherit from settings");
        assert_eq!((MIN_ZOOM, MAX_ZOOM), (0.1, 4.0));
    }

    #[test]
    fn sanitised_rejects_non_finite_components_and_clamps_zoom() {
        assert_eq!(moved().sanitised(), Some(moved()), "a normal viewport is unchanged");
        assert_eq!(with_zoom(f64::NAN).sanitised(), None);
        assert_eq!(with_zoom(f64::INFINITY).sanitised(), None);
        assert_eq!(Viewport { x: f64::NEG_INFINITY, ..moved() }.sanitised(), None);
        assert_eq!(Viewport { y: f64::NAN, ..moved() }.sanitised(), None);
        assert_eq!(with_zoom(0.0).sanitised(), Some(with_zoom(MIN_ZOOM)));
        assert_eq!(with_zoom(-3.0).sanitised(), Some(with_zoom(MIN_ZOOM)));
        assert_eq!(with_zoom(9.0).sanitised(), Some(with_zoom(MAX_ZOOM)));
        assert_eq!(with_zoom(MAX_ZOOM).sanitised(), Some(with_zoom(MAX_ZOOM)));

        assert!(moved().is_usable());
        assert!(!with_zoom(0.0).is_usable());
        assert!(!with_zoom(9.0).is_usable());
        assert!(!with_zoom(f64::NAN).is_usable());
    }

    #[test]
    fn snapshot_serialises_with_the_keys_the_ui_reads() {
        let st = WorkspaceState {
            path: Some(PathBuf::from("C:/cfg/switchboard/workspace.json")),
            workspace: Workspace {
                viewport: moved(),
                ..Workspace::default()
            },
            file_banner: Some(Banner::new("workspace.parse", "workspace.json:3:15 expected value")),
            validation_banners: vec![Banner::new("workspace.version", "newer")],
            read_only: None,
            revision: 3,
            stub_children: 0,
        };
        assert_eq!(
            serde_json::to_value(st.snapshot()).unwrap(),
            serde_json::json!({
                "path": "C:/cfg/switchboard/workspace.json",
                "revision": 3,
                "children": [],
                "workspace": {
                    "version": 1,
                    "viewport": { "x": -120.0, "y": 40.0, "zoom": 1.5 },
                    "projects": [],
                    "branches": [],
                    "sessions": [],
                    "edges": [],
                    "defaults": { "model": null, "effort": null, "permissionMode": null }
                },
                "banners": [
                    { "id": "workspace.parse", "text": "workspace.json:3:15 expected value" },
                    { "id": "workspace.version", "text": "newer" }
                ]
            })
        );
    }

    #[test]
    fn full_model_round_trips_in_camel_case() {
        let ws = Workspace {
            projects: vec![Project {
                id: "p1".into(),
                path: "B:/projects/ide".into(),
                label: "ide".into(),
                position: Position { x: 10.0, y: 20.0 },
                expanded: true,
                color: None,
                launch_defaults: Some(LaunchDefaults {
                    model: Some("opus".into()),
                    ..LaunchDefaults::default()
                }),
            }],
            branches: vec![BranchNode {
                id: "b1".into(),
                project_id: "p1".into(),
                name: "main".into(),
                worktree_path: Some("B:/projects/ide/.worktrees/x".into()),
                position: None,
            }],
            sessions: vec![SessionRef {
                session_id: "s1".into(),
                project_id: "p1".into(),
                branch_id: Some("b1".into()),
                label: None,
                pinned: true,
                position: Some(Position { x: 1.0, y: 2.0 }),
            }],
            edges: vec![Edge {
                id: "e1".into(),
                from: NodeRef {
                    kind: NodeType::Session,
                    id: "s1".into(),
                },
                to: NodeRef {
                    kind: NodeType::Folder,
                    id: "C:/elsewhere".into(),
                },
                kind: EdgeKind::Cooperate,
                label: Some("pairs".into()),
                created_at: "2026-10-16T00:00:00Z".into(),
            }],
            ..Workspace::default()
        };
        let text = store::to_json(&ws);
        for key in [
            "\"launchDefaults\"",
            "\"projectId\"",
            "\"worktreePath\"",
            "\"sessionId\"",
            "\"branchId\"",
            "\"createdAt\"",
            "\"type\": \"session\"",
            "\"type\": \"folder\"",
            "\"kind\": \"cooperate\"",
        ] {
            assert!(text.contains(key), "{key} missing from:\n{text}");
        }
        assert_eq!(store::parse(&text).unwrap(), ws);
    }

    #[test]
    fn parse_banner_names_file_line_and_column() {
        let err = persist::ParseError {
            line: 3,
            col: 15,
            msg: "expected value".into(),
        };
        let banner = parse_banner(Path::new("C:/x/switchboard/workspace.json"), &err);
        assert_eq!(banner.id, "workspace.parse");
        assert_eq!(banner.text, "workspace.json:3:15 expected value");
    }

    // -- initialise_at ----------------------------------------------------------------

    #[test]
    fn initialise_at_creates_the_file_with_defaults_on_first_launch() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("switchboard").join("workspace.json");

        initialise_at(app.handle(), Some(path.clone()));

        assert!(path.is_file());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), store::to_json(&Workspace::default()));
        let st = app.state::<AppState>();
        let st = st.read_workspace();
        assert_eq!(st.path.as_deref(), Some(path.as_path()));
        assert_eq!(st.workspace, Workspace::default());
        assert!(st.snapshot().banners.is_empty());
        assert_eq!(st.read_only, None);
    }

    #[test]
    fn initialise_at_applies_an_existing_file() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let original = r#"{ "viewport": { "x": -120, "y": 40, "zoom": 1.5 }, "unknown": true }"#;
        std::fs::write(&path, original).unwrap();

        initialise_at(app.handle(), Some(path.clone()));

        let st = app.state::<AppState>();
        let st = st.read_workspace();
        assert_eq!(st.workspace.viewport, moved());
        assert_eq!(st.file_banner, None);
        assert!(st.validation_banners.is_empty());
        assert_eq!(st.read_only, None);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original, "never rewritten on load");
    }

    #[test]
    fn initialise_at_sweeps_orphaned_temp_files_but_not_the_file() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, r#"{ "viewport": { "zoom": 2 } }"#).unwrap();
        std::fs::write(dir.path().join(".workspace.json-abc123.tmp"), "half").unwrap();
        std::fs::write(dir.path().join("settings.json"), "{}").unwrap();

        initialise_at(app.handle(), Some(path));

        let mut names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["settings.json", "workspace.json"]);
        assert_eq!(app.state::<AppState>().read_workspace().workspace.viewport.zoom, 2.0);
    }

    #[test]
    fn initialise_at_tolerates_a_bom_and_missing_keys() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, "\u{feff}{ \"viewport\": { \"zoom\": 2 } }").unwrap();

        initialise_at(app.handle(), Some(path));

        let st = app.state::<AppState>();
        let st = st.read_workspace();
        assert_eq!(st.workspace.viewport, Viewport { x: 0.0, y: 0.0, zoom: 2.0 });
        assert_eq!(st.workspace.version, 1);
        assert!(st.snapshot().banners.is_empty());
    }

    #[test]
    fn initialise_at_resets_an_unusable_viewport_with_a_banner() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, r#"{ "viewport": { "x": 5, "y": 5, "zoom": 0 } }"#).unwrap();

        initialise_at(app.handle(), Some(path.clone()));

        let st = app.state::<AppState>();
        let st = st.read_workspace();
        assert_eq!(st.workspace.viewport, Viewport::default());
        assert_eq!(
            st.validation_banners,
            [Banner::new("workspace.viewport", "workspace.json had an unusable viewport; reset to the home view")]
        );
        assert_eq!(st.read_only, None, "the next viewport write repairs the file");
    }

    #[test]
    fn initialise_at_with_a_broken_file_keeps_defaults_shows_the_banner_and_leaves_the_file() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, BROKEN).unwrap();

        initialise_at(app.handle(), Some(path.clone()));

        let st = app.state::<AppState>();
        let st = st.read_workspace();
        assert_eq!(st.workspace, Workspace::default());
        assert_eq!(
            st.file_banner,
            Some(Banner::new("workspace.parse", "workspace.json:3:15 expected value"))
        );
        assert_eq!(st.read_only, None);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), BROKEN, "not overwritten on load");
    }

    #[test]
    fn initialise_at_reports_a_newer_schema_version_loads_it_and_goes_read_only() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, r#"{ "version": 2, "viewport": { "x": 5 } }"#).unwrap();

        initialise_at(app.handle(), Some(path));

        let st = app.state::<AppState>();
        let st = st.read_workspace();
        assert_eq!(st.workspace.version, 2);
        assert_eq!(st.workspace.viewport.x, 5.0);
        assert_eq!(
            st.validation_banners,
            [Banner::new(
                "workspace.version",
                "workspace.json is version 2; this build understands 1; changes are kept in memory and not saved"
            )]
        );
        assert_eq!(st.read_only, Some("newer schema version"));
    }

    #[test]
    fn initialise_at_with_an_unreadable_file_shows_the_read_banner_and_goes_read_only() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        // A directory where the file should be: it exists, so it is not "missing", but it
        // cannot be read.
        let path = dir.path().join("workspace.json");
        std::fs::create_dir(&path).unwrap();

        initialise_at(app.handle(), Some(path.clone()));

        let st = app.state::<AppState>();
        let st = st.read_workspace();
        assert_eq!(st.workspace, Workspace::default());
        let banner = st.file_banner.clone().unwrap();
        assert_eq!(banner.id, "workspace.read");
        assert!(banner.text.starts_with("cannot read workspace: "), "{}", banner.text);
        assert!(banner.text.ends_with(NOT_SAVED), "{}", banner.text);
        assert_eq!(st.read_only, Some("unreadable file"));
        assert!(path.is_dir(), "nothing was written over it");
    }

    #[test]
    fn initialise_at_with_an_unwritable_dir_shows_the_write_banner() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("switchboard");
        std::fs::write(&blocker, b"not a directory").unwrap();

        initialise_at(app.handle(), Some(blocker.join("workspace.json")));

        let st = app.state::<AppState>();
        let st = st.read_workspace();
        assert_eq!(st.workspace, Workspace::default());
        let banner = st.file_banner.clone().unwrap();
        assert_eq!(banner.id, "workspace.write");
        assert!(banner.text.starts_with("cannot write workspace: "), "{}", banner.text);
        assert_eq!(st.read_only, None, "the next write may well succeed");
    }

    #[test]
    fn initialise_at_without_a_config_dir_shows_the_write_banner() {
        let app = mock_app();
        initialise_at(app.handle(), None);
        let st = app.state::<AppState>();
        let st = st.read_workspace();
        assert_eq!(st.path, None);
        assert_eq!(
            st.file_banner,
            Some(Banner::new("workspace.write", "cannot write workspace: no platform config directory"))
        );
    }

    #[test]
    fn announce_emits_exactly_one_event_carrying_the_loaded_snapshot() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, r#"{ "viewport": { "x": -120, "y": 40, "zoom": 1.5 } }"#).unwrap();
        let rx = listen(&app);

        initialise_at(app.handle(), Some(path.clone()));
        assert!(rx.try_recv().is_err(), "loading alone emits nothing");
        announce(app.handle());

        let payload = rx.try_recv().expect("one event");
        assert_eq!(payload.workspace.viewport, moved());
        assert_eq!(payload.path.as_deref(), Some(path.display().to_string().as_str()));
        assert!(payload.banners.is_empty());
        assert_eq!(payload, app.state::<AppState>().read_workspace().snapshot());
        assert!(rx.try_recv().is_err(), "exactly one");
    }

    // -- set_viewport -----------------------------------------------------------------

    #[test]
    fn set_viewport_writes_the_file_atomically_and_emits_the_snapshot() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        initialise_at(app.handle(), Some(path.clone()));
        let rx = listen(&app);

        let snapshot = set_viewport(app.handle(), moved());

        assert_eq!(snapshot.workspace.viewport, moved());
        assert!(snapshot.banners.is_empty());
        let on_disk = store::parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk.viewport, moved());
        assert_eq!(on_disk.version, 1);
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, ["workspace.json"], "no temp files left behind");

        assert_eq!(rx.try_recv().expect("one event"), snapshot);
        assert_eq!(app.state::<AppState>().read_workspace().snapshot(), snapshot);
    }

    #[test]
    fn set_viewport_clamps_zoom_into_the_canvas_limits() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        initialise_at(app.handle(), Some(path.clone()));

        assert_eq!(set_viewport(app.handle(), with_zoom(0.0)).workspace.viewport, with_zoom(MIN_ZOOM));
        assert_eq!(set_viewport(app.handle(), with_zoom(9.0)).workspace.viewport, with_zoom(MAX_ZOOM));
        let on_disk = store::parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk.viewport, with_zoom(MAX_ZOOM));
    }

    #[test]
    fn set_viewport_ignores_a_non_finite_viewport_without_writing_or_emitting() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        initialise_at(app.handle(), Some(path.clone()));
        let before = set_viewport(app.handle(), moved());
        let on_disk_before = std::fs::read_to_string(&path).unwrap();
        let rx = listen(&app);

        for bad in [
            with_zoom(f64::NAN),
            with_zoom(f64::INFINITY),
            Viewport { x: f64::NAN, ..moved() },
            Viewport { y: f64::NEG_INFINITY, ..moved() },
        ] {
            let snapshot = set_viewport(app.handle(), bad);
            assert_eq!(snapshot, before, "unchanged for {bad:?}");
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), on_disk_before, "no write");
        assert!(rx.try_recv().is_err(), "no event");
        assert_eq!(app.state::<AppState>().read_workspace().workspace.viewport, moved());
    }

    #[test]
    fn set_viewport_after_a_broken_file_overwrites_it_and_clears_the_parse_banner() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, BROKEN).unwrap();
        initialise_at(app.handle(), Some(path.clone()));
        assert!(app.state::<AppState>().read_workspace().file_banner.is_some());

        let snapshot = set_viewport(app.handle(), moved());

        assert!(snapshot.banners.is_empty(), "{:?}", snapshot.banners);
        let on_disk = store::parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            on_disk,
            Workspace {
                viewport: moved(),
                ..Workspace::default()
            }
        );
    }

    #[test]
    fn set_viewport_after_an_unusable_viewport_repairs_the_file_and_keeps_the_banner() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, r#"{ "viewport": { "zoom": 0 } }"#).unwrap();
        initialise_at(app.handle(), Some(path.clone()));

        let snapshot = set_viewport(app.handle(), moved());

        let ids: Vec<&str> = snapshot.banners.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["workspace.viewport"], "validation banners describe the load, not the file");
        assert_eq!(store::parse(&std::fs::read_to_string(&path).unwrap()).unwrap().viewport, moved());
    }

    #[test]
    fn set_viewport_on_a_newer_file_changes_memory_only_and_leaves_the_file_untouched() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let original = r#"{ "version": 2, "viewport": { "x": 5 }, "future": { "kept": true } }"#;
        std::fs::write(&path, original).unwrap();
        initialise_at(app.handle(), Some(path.clone()));
        let rx = listen(&app);

        let snapshot = set_viewport(app.handle(), moved());

        assert_eq!(snapshot.workspace.viewport, moved());
        assert_eq!(snapshot.workspace.version, 2);
        let ids: Vec<&str> = snapshot.banners.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["workspace.version"]);
        assert!(snapshot.banners[0].text.ends_with(NOT_SAVED));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original, "file untouched");
        assert_eq!(rx.try_recv().expect("the in-memory change is announced"), snapshot);
    }

    #[test]
    fn set_viewport_on_an_unreadable_file_changes_memory_only_and_keeps_the_read_banner() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::create_dir(&path).unwrap();
        initialise_at(app.handle(), Some(path.clone()));

        let snapshot = set_viewport(app.handle(), moved());

        assert_eq!(snapshot.workspace.viewport, moved());
        let ids: Vec<&str> = snapshot.banners.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["workspace.read"]);
        assert!(path.is_dir(), "file (here: the directory in its place) untouched");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, ["workspace.json"], "no temp files either");
    }

    #[test]
    fn set_viewport_without_a_writable_file_keeps_the_viewport_in_memory_with_a_write_banner() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("switchboard");
        std::fs::write(&blocker, b"not a directory").unwrap();
        initialise_at(app.handle(), Some(blocker.join("workspace.json")));

        let snapshot = set_viewport(app.handle(), moved());

        assert_eq!(snapshot.workspace.viewport, moved());
        let ids: Vec<&str> = snapshot.banners.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["workspace.write"]);

        let app = mock_app();
        initialise_at(app.handle(), None);
        let snapshot = set_viewport(app.handle(), moved());
        assert_eq!(snapshot.workspace.viewport, moved());
        assert_eq!(snapshot.banners[0].id, "workspace.write");
    }

    // -- add_projects -----------------------------------------------------------------

    fn is_uuid_v4(id: &str) -> bool {
        let parts: Vec<&str> = id.split('-').collect();
        parts.len() == 5
            && parts.iter().map(|p| p.len()).collect::<Vec<_>>() == [8, 4, 4, 4, 12]
            && id.chars().all(|c| c == '-' || c.is_ascii_hexdigit())
            && parts[2].starts_with('4')
    }

    fn display(path: &Path) -> String {
        path.display().to_string()
    }

    fn canonical(path: &Path) -> String {
        dunce::canonicalize(path).unwrap().display().to_string()
    }

    #[test]
    fn add_projects_creates_labelled_fanned_out_nodes_persists_and_emits_once() {
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        let file = cfg.path().join("workspace.json");
        initialise_at(app.handle(), Some(file.clone()));
        let a = tempfile::tempdir().unwrap();
        let b = a.path().join("guild-auth");
        std::fs::create_dir(&b).unwrap();
        let rx = listen(&app);

        let result = add_projects(
            app.handle(),
            &[display(a.path()), display(&b)],
            Position { x: 100.0, y: 50.0 },
        )
        .unwrap();

        assert_eq!(result.added.len(), 2);
        assert!(result.existing.is_empty());
        assert!(result.skipped.is_empty());
        assert_eq!(result.snapshot.revision, 1, "one mutation since load");
        let projects = &result.snapshot.workspace.projects;
        assert_eq!(projects.len(), 2);
        assert_eq!(projects.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), result.added);
        assert!(projects.iter().all(|p| is_uuid_v4(&p.id)), "{projects:?}");
        assert_ne!(projects[0].id, projects[1].id);
        assert_eq!(projects[0].path, canonical(a.path()));
        assert_eq!(projects[1].path, canonical(&b));
        assert_eq!(projects[1].label, "guild-auth");
        assert_eq!(projects[0].label, a.path().file_name().unwrap().to_string_lossy());
        assert_eq!(projects[0].position, Position { x: 100.0, y: 50.0 });
        assert_eq!(projects[1].position, Position { x: 124.0, y: 74.0 });
        assert!(!projects[0].expanded);
        assert_eq!(projects[0].color, None);
        assert_eq!(projects[0].launch_defaults, None);
        #[cfg(windows)]
        assert!(!projects[0].path.starts_with(r"\\?\"), "no UNC prefix: {}", projects[0].path);

        let on_disk = store::parse(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(on_disk.projects, *projects);
        assert_eq!(rx.try_recv().expect("one event"), result.snapshot);
        assert!(rx.try_recv().is_err(), "exactly one");
        assert_eq!(app.state::<AppState>().read_workspace().snapshot(), result.snapshot);
    }

    #[test]
    fn add_projects_reports_a_duplicate_as_existing_without_writing_or_emitting() {
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        let file = cfg.path().join("workspace.json");
        initialise_at(app.handle(), Some(file.clone()));
        let a = tempfile::tempdir().unwrap();
        let first = add_projects(app.handle(), &[display(a.path())], Position::default()).unwrap();
        let id = first.added[0].clone();
        let on_disk_before = std::fs::read_to_string(&file).unwrap();
        let rx = listen(&app);

        // The same folder spelled differently: trailing separator, and (Windows) other case.
        let mut spellings = vec![format!("{}{}", display(a.path()), std::path::MAIN_SEPARATOR)];
        if cfg!(windows) {
            spellings.push(display(a.path()).to_ascii_uppercase());
        }
        for raw in spellings {
            let again = add_projects(app.handle(), std::slice::from_ref(&raw), Position { x: 9.0, y: 9.0 }).unwrap();
            assert!(again.added.is_empty(), "{raw}");
            assert_eq!(again.existing, std::slice::from_ref(&id), "{raw}");
            assert_eq!(again.snapshot, first.snapshot, "{raw}");
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), on_disk_before, "no write");
        assert!(rx.try_recv().is_err(), "no event");

        // Within one batch the same folder twice is one node.
        let other = tempfile::tempdir().unwrap();
        let batch = add_projects(
            app.handle(),
            &[display(other.path()), display(other.path()), display(a.path())],
            Position::default(),
        )
        .unwrap();
        assert_eq!(batch.added.len(), 1);
        assert_eq!(batch.existing, [id]);
        assert_eq!(batch.snapshot.workspace.projects.len(), 2);
    }

    #[test]
    fn add_projects_skips_non_directories_adding_nothing_for_them() {
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        let ws_file = cfg.path().join("workspace.json");
        initialise_at(app.handle(), Some(ws_file.clone()));
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, "x").unwrap();
        let on_disk_before = std::fs::read_to_string(&ws_file).unwrap();
        let rx = listen(&app);

        // A lone file, a missing path, a blank: Ok, nothing added, the input reported as skipped.
        for raw in [display(&file), display(&dir.path().join("missing")), "   ".to_string()] {
            let result = add_projects(app.handle(), std::slice::from_ref(&raw), Position::default()).unwrap();
            assert!(result.added.is_empty(), "{raw}");
            assert!(result.existing.is_empty(), "{raw}");
            assert_eq!(result.skipped, std::slice::from_ref(&raw));
            assert_eq!(result.snapshot.revision, 0, "{raw}: no mutation");
        }
        assert!(rx.try_recv().is_err(), "no event");
        assert_eq!(std::fs::read_to_string(&ws_file).unwrap(), on_disk_before, "no write");
        assert!(app.state::<AppState>().read_workspace().workspace.projects.is_empty());

        // An empty list is a no-op, not an error.
        let none = add_projects(app.handle(), &[], Position::default()).unwrap();
        assert!(none.added.is_empty() && none.existing.is_empty() && none.skipped.is_empty());

        // A file dropped together with a folder: the folder is added, the file skipped.
        let mixed = add_projects(app.handle(), &[display(&file), display(dir.path())], Position::default()).unwrap();
        assert_eq!(mixed.added.len(), 1);
        assert_eq!(mixed.skipped, [display(&file)]);
        assert_eq!(mixed.snapshot.workspace.projects[0].path, canonical(dir.path()));
    }

    #[test]
    fn add_projects_rejects_a_non_finite_position() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        for bad in [
            Position { x: f64::NAN, y: 0.0 },
            Position { x: 0.0, y: f64::INFINITY },
        ] {
            assert_eq!(
                add_projects(app.handle(), &[display(dir.path())], bad),
                Err("position is not finite".to_string())
            );
        }
    }

    #[test]
    fn add_projects_on_a_read_only_file_changes_memory_only() {
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        let file = cfg.path().join("workspace.json");
        let original = r#"{ "version": 2, "future": { "kept": true } }"#;
        std::fs::write(&file, original).unwrap();
        initialise_at(app.handle(), Some(file.clone()));
        let dir = tempfile::tempdir().unwrap();
        let rx = listen(&app);

        let result = add_projects(app.handle(), &[display(dir.path())], Position::default()).unwrap();

        assert_eq!(result.added.len(), 1);
        assert_eq!(result.snapshot.workspace.projects.len(), 1);
        let ids: Vec<&str> = result.snapshot.banners.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["workspace.version"]);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original, "file untouched");
        assert_eq!(rx.try_recv().expect("the in-memory change is announced"), result.snapshot);
    }

    #[test]
    fn add_projects_without_a_config_dir_keeps_the_node_in_memory_with_the_write_banner() {
        let app = mock_app();
        initialise_at(app.handle(), None);
        let dir = tempfile::tempdir().unwrap();
        let result = add_projects(app.handle(), &[display(dir.path())], Position::default()).unwrap();
        assert_eq!(result.snapshot.workspace.projects.len(), 1);
        assert_eq!(result.snapshot.banners[0].id, "workspace.write");
    }

    #[test]
    fn folder_label_is_the_last_component_or_the_whole_root() {
        assert_eq!(folder_label("/home/emils/src"), "src");
        // A backslash is a separator only on Windows; paths reach `folder_label` canonicalised
        // by the host OS, so a Windows-style path is only ever seen there.
        if cfg!(windows) {
            assert_eq!(folder_label(r"B:\projects\guild-auth"), "guild-auth");
            assert_eq!(folder_label(r"C:\"), r"C:\");
        } else {
            assert_eq!(folder_label("/"), "/");
        }
    }

    #[test]
    fn add_projects_nudges_a_new_node_off_an_existing_one() {
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        initialise_at(app.handle(), Some(cfg.path().join("workspace.json")));
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let c = tempfile::tempdir().unwrap();
        let centre = Position { x: 100.0, y: 50.0 };

        let first = add_projects(app.handle(), &[display(a.path())], centre).unwrap();
        assert_eq!(first.snapshot.workspace.projects[0].position, centre);
        // Second `ctrl+o` with the view unmoved: one step away, not on top of the first.
        let second = add_projects(app.handle(), &[display(b.path())], centre).unwrap();
        assert_eq!(second.snapshot.workspace.projects[1].position, Position { x: 124.0, y: 74.0 });
        // Almost on top of the second (within a step on both axes): nudged past it too.
        let third = add_projects(app.handle(), &[display(c.path())], Position { x: 110.0, y: 60.0 }).unwrap();
        assert_eq!(third.snapshot.workspace.projects[2].position, Position { x: 158.0, y: 108.0 });
        assert_eq!(third.snapshot.revision, 3);

        // Far enough on one axis is not a collision.
        let empty: Vec<Project> = vec![];
        assert_eq!(free_position(centre, &empty), centre);
        let placed = vec![Project {
            position: centre,
            ..Project::default()
        }];
        assert_eq!(free_position(Position { x: 124.0, y: 50.0 }, &placed), Position { x: 124.0, y: 50.0 });
        assert_eq!(free_position(Position { x: 123.0, y: 73.0 }, &placed), Position { x: 147.0, y: 97.0 });
    }

    #[test]
    fn free_position_gives_up_after_fifty_nudges() {
        let crowd: Vec<Project> = (0..=MAX_NUDGES)
            .map(|i| Project {
                position: Position {
                    x: i as f64 * FAN_OUT_STEP,
                    y: i as f64 * FAN_OUT_STEP,
                },
                ..Project::default()
            })
            .collect();
        let step = MAX_NUDGES as f64 * FAN_OUT_STEP;
        assert_eq!(free_position(Position::default(), &crowd), Position { x: step, y: step });
    }

    #[test]
    fn add_projects_labels_a_symlink_by_its_own_name_and_stores_its_target() {
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        initialise_at(app.handle(), Some(cfg.path().join("workspace.json")));
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("real-target");
        std::fs::create_dir(&target).unwrap();
        let link = dir.path().join("my-link");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&target, &link);
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&target, &link);
        if made.is_err() {
            eprintln!("cannot create a directory symlink here (privilege); skipping");
            return;
        }

        let result = add_projects(app.handle(), &[display(&link)], Position::default()).unwrap();
        let project = &result.snapshot.workspace.projects[0];
        assert_eq!(project.label, "my-link");
        assert_eq!(project.path, canonical(&target));
        // The target itself is then a duplicate of the link's node.
        let again = add_projects(app.handle(), &[display(&target)], Position::default()).unwrap();
        assert_eq!(again.existing, std::slice::from_ref(&project.id));
    }

    #[test]
    fn revision_increments_on_every_mutation_and_not_otherwise() {
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        initialise_at(app.handle(), Some(cfg.path().join("workspace.json")));
        assert_eq!(app.state::<AppState>().read_workspace().snapshot().revision, 0);
        assert_eq!(set_viewport(app.handle(), moved()).revision, 1);
        assert_eq!(set_viewport(app.handle(), with_zoom(f64::NAN)).revision, 1, "ignored viewport: no mutation");
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(add_projects(app.handle(), &[display(dir.path())], Position::default()).unwrap().snapshot.revision, 2);
        assert_eq!(
            add_projects(app.handle(), &[display(dir.path())], Position::default()).unwrap().snapshot.revision,
            2,
            "duplicate: no mutation"
        );
        assert_eq!(set_viewport(app.handle(), Viewport::default()).revision, 3);
        // A reload starts over.
        initialise_at(app.handle(), Some(cfg.path().join("workspace.json")));
        assert_eq!(app.state::<AppState>().read_workspace().revision, 0);
    }

    #[test]
    fn same_path_is_case_insensitive_only_on_windows() {
        assert!(same_path("/a/b", "/a/b"));
        assert!(!same_path("/a/b", "/a/c"));
        assert_eq!(same_path(r"C:\Repo", r"c:\repo"), cfg!(windows));
    }

    // -- children / set_expanded / move_node / relayout_children ------------------------

    fn project_with(id: &str) -> Project {
        Project {
            id: id.into(),
            path: format!("/p/{id}"),
            label: id.into(),
            ..Project::default()
        }
    }

    /// A mock app with `stubs` stub children per project, one project `ide` on the canvas
    /// and the file at `path`.
    fn app_with_ide(stubs: usize) -> (tauri::App<MockRuntime>, tempfile::TempDir, PathBuf) {
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        let path = cfg.path().join("workspace.json");
        app.state::<AppState>().stub_children.set(stubs).unwrap();
        initialise_at(app.handle(), Some(path.clone()));
        {
            let state = app.state::<AppState>();
            let mut st = state.write_workspace();
            st.workspace.projects.push(project_with("ide"));
        }
        (app, cfg, path)
    }

    fn on_disk(path: &Path) -> Workspace {
        store::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn children_lists_stub_sessions_then_branches_per_project_in_order() {
        let ws = Workspace {
            projects: vec![project_with("a"), project_with("b")],
            branches: vec![
                BranchNode {
                    id: "br-b".into(),
                    project_id: "b".into(),
                    name: "feature".into(),
                    worktree_path: Some("/p/b/.worktrees/feature".into()),
                    position: Some(Position { x: 300.0, y: 10.0 }),
                },
                BranchNode {
                    id: "br-a".into(),
                    project_id: "a".into(),
                    name: "main".into(),
                    ..BranchNode::default()
                },
            ],
            sessions: vec![
                // A dragged stub of `a` keeps its position; a ref for a session nobody
                // discovered yields no child; a ref on the wrong project is not matched.
                SessionRef {
                    session_id: "stub-2-a".into(),
                    project_id: "a".into(),
                    position: Some(Position { x: -40.0, y: 200.0 }),
                    ..SessionRef::default()
                },
                SessionRef {
                    session_id: "real-session".into(),
                    project_id: "a".into(),
                    pinned: true,
                    ..SessionRef::default()
                },
                SessionRef {
                    session_id: "stub-1-b".into(),
                    project_id: "a".into(),
                    position: Some(Position { x: 1.0, y: 1.0 }),
                    ..SessionRef::default()
                },
            ],
            ..Workspace::default()
        };
        let kids = children(&ws, 2);
        type Row<'a> = (&'a str, &'a str, ChildKind, &'a str, Option<&'a str>, Option<Position>);
        let summary: Vec<Row<'_>> = kids
            .iter()
            .map(|c| (c.id.as_str(), c.project_id.as_str(), c.kind, c.label.as_str(), c.detail.as_deref(), c.position))
            .collect();
        assert_eq!(
            summary,
            [
                ("stub-1-a", "a", ChildKind::Session, "session 1", Some("stub"), None),
                ("stub-2-a", "a", ChildKind::Session, "session 2", Some("stub"), Some(Position { x: -40.0, y: 200.0 })),
                ("br-a", "a", ChildKind::Branch, "main", None, None),
                ("stub-1-b", "b", ChildKind::Session, "session 1", Some("stub"), None),
                ("stub-2-b", "b", ChildKind::Session, "session 2", Some("stub"), None),
                (
                    "br-b",
                    "b",
                    ChildKind::Branch,
                    "feature",
                    Some("/p/b/.worktrees/feature"),
                    Some(Position { x: 300.0, y: 10.0 })
                ),
            ]
        );
        assert!(children(&ws, 0).iter().all(|c| c.kind == ChildKind::Branch), "no stubs unless asked");
        assert!(children(&Workspace::default(), 3).is_empty(), "no projects, no children");
    }

    #[test]
    fn child_node_serialises_in_camel_case_with_null_position() {
        let child = ChildNode {
            id: "stub-1-p".into(),
            project_id: "p".into(),
            kind: ChildKind::Session,
            label: "session 1".into(),
            detail: Some("stub".into()),
            position: None,
        };
        assert_eq!(
            serde_json::to_value(&child).unwrap(),
            serde_json::json!({
                "id": "stub-1-p", "projectId": "p", "kind": "session",
                "label": "session 1", "detail": "stub", "position": null
            })
        );
        let target: NodeTarget = serde_json::from_value(serde_json::json!({ "kind": "branch", "id": "b1" })).unwrap();
        assert_eq!(
            target,
            NodeTarget {
                kind: NodeKind::Branch,
                id: "b1".into()
            }
        );
    }

    #[test]
    fn snapshot_carries_every_child_collapsed_or_not_and_initialise_copies_the_stub_count() {
        let (app, _cfg, _path) = app_with_ide(3);
        let state = app.state::<AppState>();
        assert_eq!(state.read_workspace().stub_children, 3);
        let snapshot = state.read_workspace().snapshot();
        assert!(!snapshot.workspace.projects[0].expanded);
        assert_eq!(
            snapshot.children.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["stub-1-ide", "stub-2-ide", "stub-3-ide"]
        );
        assert!(snapshot.children.iter().all(|c| c.position.is_none()));
        assert!(snapshot.workspace.sessions.is_empty(), "stubs are not persisted");
    }

    #[test]
    fn set_expanded_persists_bumps_the_revision_and_emits() {
        let (app, _cfg, path) = app_with_ide(3);
        let rx = listen(&app);

        let snapshot = set_expanded(app.handle(), "ide", true).unwrap();
        assert!(snapshot.workspace.projects[0].expanded);
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.children.len(), 3, "the child list does not depend on expansion");
        assert!(on_disk(&path).projects[0].expanded);
        assert_eq!(rx.try_recv().expect("one event"), snapshot);

        let snapshot = set_expanded(app.handle(), "ide", false).unwrap();
        assert!(!snapshot.workspace.projects[0].expanded);
        assert_eq!(snapshot.revision, 2);
        assert!(!on_disk(&path).projects[0].expanded);
        assert_eq!(rx.try_recv().expect("one event"), snapshot);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn set_expanded_rejects_an_unknown_project_without_writing_or_emitting() {
        let (app, _cfg, path) = app_with_ide(3);
        let before = std::fs::read_to_string(&path).unwrap();
        let rx = listen(&app);
        assert_eq!(set_expanded(app.handle(), "nope", true), Err("unknown project".to_string()));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        assert!(rx.try_recv().is_err());
        assert_eq!(app.state::<AppState>().read_workspace().revision, 0);
    }

    #[test]
    fn move_node_writes_a_project_position_once() {
        let (app, _cfg, path) = app_with_ide(0);
        let rx = listen(&app);
        let target = NodeTarget {
            kind: NodeKind::Project,
            id: "ide".into(),
        };
        let snapshot = move_node(app.handle(), &target, Position { x: 120.0, y: -8.5 }).unwrap();
        assert_eq!(snapshot.workspace.projects[0].position, Position { x: 120.0, y: -8.5 });
        assert_eq!(snapshot.revision, 1);
        assert_eq!(on_disk(&path).projects[0].position, Position { x: 120.0, y: -8.5 });
        assert_eq!(rx.try_recv().expect("one event"), snapshot);
        assert!(rx.try_recv().is_err(), "exactly one");
    }

    #[test]
    fn move_node_upserts_a_session_ref_for_a_dragged_stub_child() {
        let (app, _cfg, path) = app_with_ide(3);
        let target = NodeTarget {
            kind: NodeKind::Session,
            id: "stub-2-ide".into(),
        };

        // First drag: a ref holding just the three fields appears.
        let snapshot = move_node(app.handle(), &target, Position { x: 260.0, y: 40.0 }).unwrap();
        assert_eq!(
            snapshot.workspace.sessions,
            [SessionRef {
                session_id: "stub-2-ide".into(),
                project_id: "ide".into(),
                position: Some(Position { x: 260.0, y: 40.0 }),
                ..SessionRef::default()
            }]
        );
        let positions: Vec<Option<Position>> = snapshot.children.iter().map(|c| c.position).collect();
        assert_eq!(positions, [None, Some(Position { x: 260.0, y: 40.0 }), None], "the other two keep their slots");
        let disk = on_disk(&path);
        assert_eq!(disk.sessions.len(), 1);
        assert_eq!(disk.sessions[0].position, Some(Position { x: 260.0, y: 40.0 }));
        assert_eq!(children(&disk, 3)[1].position, Some(Position { x: 260.0, y: 40.0 }), "survives a reload");

        // Second drag: the same ref is updated, not duplicated.
        let snapshot = move_node(app.handle(), &target, Position { x: 10.0, y: 10.0 }).unwrap();
        assert_eq!(snapshot.workspace.sessions.len(), 1);
        assert_eq!(snapshot.workspace.sessions[0].position, Some(Position { x: 10.0, y: 10.0 }));
        assert_eq!(snapshot.revision, 2);
    }

    #[test]
    fn move_node_ignores_a_same_id_session_ref_under_another_project() {
        let (app, _cfg, path) = app_with_ide(2);
        {
            let state = app.state::<AppState>();
            state.write_workspace().workspace.sessions.push(SessionRef {
                session_id: "stub-1-ide".into(),
                project_id: "other".into(),
                pinned: true,
                position: Some(Position { x: 999.0, y: 999.0 }),
                ..SessionRef::default()
            });
        }
        let target = NodeTarget {
            kind: NodeKind::Session,
            id: "stub-1-ide".into(),
        };

        let snapshot = move_node(app.handle(), &target, Position { x: 50.0, y: 60.0 }).unwrap();

        assert_eq!(snapshot.children[0].position, Some(Position { x: 50.0, y: 60.0 }), "the child shows the drag");
        let refs: Vec<(&str, &str, Option<Position>)> = snapshot
            .workspace
            .sessions
            .iter()
            .map(|s| (s.session_id.as_str(), s.project_id.as_str(), s.position))
            .collect();
        assert_eq!(
            refs,
            [
                ("stub-1-ide", "other", Some(Position { x: 999.0, y: 999.0 })),
                ("stub-1-ide", "ide", Some(Position { x: 50.0, y: 60.0 })),
            ],
            "the foreign ref is untouched; a ref for the right project is created"
        );
        // A second drag updates the right-project ref, not the foreign one.
        let snapshot = move_node(app.handle(), &target, Position { x: 7.0, y: 8.0 }).unwrap();
        assert_eq!(snapshot.workspace.sessions.len(), 2);
        assert_eq!(snapshot.workspace.sessions[1].position, Some(Position { x: 7.0, y: 8.0 }));
        assert_eq!(snapshot.workspace.sessions[0].position, Some(Position { x: 999.0, y: 999.0 }));
        assert_eq!(on_disk(&path).sessions.len(), 2);
    }

    #[test]
    fn move_node_sets_a_branch_position_and_rejects_unknown_or_non_finite() {
        let (app, _cfg, path) = app_with_ide(1);
        {
            let state = app.state::<AppState>();
            state.write_workspace().workspace.branches.push(BranchNode {
                id: "br".into(),
                project_id: "ide".into(),
                name: "main".into(),
                ..BranchNode::default()
            });
        }
        let branch = NodeTarget {
            kind: NodeKind::Branch,
            id: "br".into(),
        };
        let snapshot = move_node(app.handle(), &branch, Position { x: 5.0, y: 6.0 }).unwrap();
        assert_eq!(snapshot.workspace.branches[0].position, Some(Position { x: 5.0, y: 6.0 }));
        assert_eq!(snapshot.children[1].position, Some(Position { x: 5.0, y: 6.0 }));
        assert_eq!(on_disk(&path).branches[0].position, Some(Position { x: 5.0, y: 6.0 }));

        let before = std::fs::read_to_string(&path).unwrap();
        let rx = listen(&app);
        let unknown = |kind, id: &str| NodeTarget { kind, id: id.into() };
        assert_eq!(
            move_node(app.handle(), &unknown(NodeKind::Project, "nope"), Position::default()),
            Err("unknown project".to_string())
        );
        assert_eq!(
            move_node(app.handle(), &unknown(NodeKind::Session, "stub-9-ide"), Position::default()),
            Err("unknown session".to_string()),
            "a stub beyond the configured count is not a child"
        );
        assert_eq!(
            move_node(app.handle(), &unknown(NodeKind::Branch, "nope"), Position::default()),
            Err("unknown branch".to_string())
        );
        for bad in [
            Position { x: f64::NAN, y: 0.0 },
            Position { x: 0.0, y: f64::NEG_INFINITY },
        ] {
            assert_eq!(
                move_node(app.handle(), &unknown(NodeKind::Project, "ide"), bad),
                Err("position is not finite".to_string())
            );
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "no write");
        assert!(rx.try_recv().is_err(), "no event");
        assert_eq!(app.state::<AppState>().read_workspace().revision, 1);
    }

    #[test]
    fn relayout_children_clears_positions_and_prunes_bare_refs_of_that_project_only() {
        let (app, _cfg, path) = app_with_ide(3);
        {
            let state = app.state::<AppState>();
            let mut st = state.write_workspace();
            st.workspace.projects.push(project_with("other"));
            st.workspace.branches.push(BranchNode {
                id: "br".into(),
                project_id: "ide".into(),
                name: "main".into(),
                position: Some(Position { x: 9.0, y: 9.0 }),
                ..BranchNode::default()
            });
            // A ref that carries more than a position stays, with the position cleared.
            st.workspace.sessions.push(SessionRef {
                session_id: "stub-3-ide".into(),
                project_id: "ide".into(),
                label: Some("kept".into()),
                position: Some(Position { x: 1.0, y: 2.0 }),
                ..SessionRef::default()
            });
        }
        let dragged = |id: &str| NodeTarget {
            kind: NodeKind::Session,
            id: id.into(),
        };
        move_node(app.handle(), &dragged("stub-2-ide"), Position { x: 260.0, y: 40.0 }).unwrap();
        move_node(app.handle(), &dragged("stub-1-other"), Position { x: -5.0, y: -5.0 }).unwrap();
        let rx = listen(&app);

        let snapshot = relayout_children(app.handle(), "ide").unwrap();

        assert_eq!(snapshot.revision, 3);
        let ide_children: Vec<Option<Position>> = snapshot
            .children
            .iter()
            .filter(|c| c.project_id == "ide")
            .map(|c| c.position)
            .collect();
        assert_eq!(ide_children, [None, None, None, None], "three stubs and the branch, all in their slots");
        let refs: Vec<(&str, Option<&str>, Option<Position>)> = snapshot
            .workspace
            .sessions
            .iter()
            .map(|s| (s.session_id.as_str(), s.label.as_deref(), s.position))
            .collect();
        assert_eq!(
            refs,
            [
                ("stub-3-ide", Some("kept"), None),
                ("stub-1-other", None, Some(Position { x: -5.0, y: -5.0 })),
            ],
            "the bare ref is gone, the labelled one stays, the other project's is untouched"
        );
        assert_eq!(snapshot.workspace.branches[0].position, None);
        assert_eq!(on_disk(&path).sessions.len(), 2);
        assert_eq!(rx.try_recv().expect("one event"), snapshot);

        assert_eq!(relayout_children(app.handle(), "nope"), Err("unknown project".to_string()));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn the_new_mutations_respect_the_read_only_guard() {
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        let path = cfg.path().join("workspace.json");
        let original = r#"{ "version": 2, "projects": [{ "id": "ide", "path": "/p/ide", "label": "ide" }] }"#;
        std::fs::write(&path, original).unwrap();
        app.state::<AppState>().stub_children.set(2).unwrap();
        initialise_at(app.handle(), Some(path.clone()));
        let rx = listen(&app);

        let snapshot = set_expanded(app.handle(), "ide", true).unwrap();
        assert!(snapshot.workspace.projects[0].expanded);
        let target = NodeTarget {
            kind: NodeKind::Session,
            id: "stub-1-ide".into(),
        };
        let snapshot = move_node(app.handle(), &target, Position { x: 1.0, y: 1.0 }).unwrap();
        assert_eq!(snapshot.children[0].position, Some(Position { x: 1.0, y: 1.0 }));
        let snapshot = relayout_children(app.handle(), "ide").unwrap();
        assert!(snapshot.workspace.sessions.is_empty());
        assert_eq!(snapshot.revision, 3);
        let ids: Vec<&str> = snapshot.banners.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["workspace.version"]);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original, "file untouched");
        assert_eq!(rx.iter().take(3).count(), 3, "each in-memory change is announced");
    }

    #[test]
    fn add_projects_result_serialises_with_the_keys_the_ui_reads() {
        let result = AddProjectsResult {
            snapshot: WorkspaceState::default().snapshot(),
            added: vec!["a".into()],
            existing: vec![],
            skipped: vec!["x.txt".into()],
        };
        let json = serde_json::to_value(&result).unwrap();
        let keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["added", "existing", "skipped", "snapshot"]);
        assert_eq!(json["added"], serde_json::json!(["a"]));
        assert_eq!(json["skipped"], serde_json::json!(["x.txt"]));
    }
}
