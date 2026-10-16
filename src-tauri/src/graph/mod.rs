//! The workspace: the one app-written `workspace.json` beside `settings.json`, holding the
//! canvas viewport and (from Story 2.2 on) the nodes and edges placed on it. Rust is the
//! source of truth: every mutation is a thin command delegating here, and the webview sees a
//! [`WorkspaceSnapshot`] via `workspace_get` and the `workspace://changed` event.
//!
//! The complete v1 envelope (architecture §5.1) is defined now so later epics add no
//! migration; this story reads and writes only `viewport`.

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
// State and snapshot
// ---------------------------------------------------------------------------------------

/// Everything the UI needs about the workspace, sent on request and on every change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceSnapshot {
    /// Absolute path of `workspace.json`; `None` when the config dir could not be determined.
    pub path: Option<String>,
    pub workspace: Workspace,
    pub banners: Vec<Banner>,
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
        (st.write_target(), st.workspace.clone())
    };
    let outcome = target.map(|path| store::write(&path, &workspace));
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
        };
        assert_eq!(
            serde_json::to_value(st.snapshot()).unwrap(),
            serde_json::json!({
                "path": "C:/cfg/switchboard/workspace.json",
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
}
