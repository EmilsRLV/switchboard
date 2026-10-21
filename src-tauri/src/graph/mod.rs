//! The workspace: the one app-written `workspace.json` beside `settings.json`, holding the
//! canvas viewport and (from Story 2.2 on) the nodes and edges placed on it. Rust is the
//! source of truth: every mutation is a thin command delegating here, and the webview sees a
//! [`WorkspaceSnapshot`] via `workspace_get` and the `workspace://changed` event.
//!
//! The complete v1 envelope (architecture §5.1) is defined now so later epics add no
//! migration; Stories 2.1 and 2.2 read and write `viewport` and `projects`.

pub mod store;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::claude::SessionSummary;
use crate::claude::transcript::format_iso_ms;
use crate::git::{BranchInfo, WorktreeChip};
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
    /// The "branches" toggle (Story 5.1): the project's local branches are listed as branch
    /// children. Off by default and in older files.
    pub show_branches: bool,
}

/// A branch node the operator placed under a project (Epic 5). Story 5.1 writes one only when
/// a discovered branch card is moved (its `id` is then `<projectId>:<name>`); it is matched to
/// the discovered branch by `(projectId, name)`.
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
    /// The session this one was forked from (Story 4.4): the canvas draws a thin line between
    /// the two cards. Absent in older files.
    pub forked_from: Option<String>,
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
/// Derived by [`children`] from the discovered sessions, `workspace.sessions` and
/// `workspace.branches` (plus the stub source), so later epics replace the derivation and keep
/// the layout. `position` is relative to the parent card's top-left and `None` for a child
/// still in its column slot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildNode {
    pub id: String,
    pub project_id: String,
    pub kind: ChildKind,
    pub label: String,
    pub detail: Option<String>,
    pub position: Option<Position>,
    /// What the session card shows besides the title; `None` for stubs and branches.
    pub session: Option<SessionMeta>,
    /// The branch a session belongs under: the branch whose `worktreePath` holds its `cwd`
    /// (else the one its ref names). `None` for the project root and for branch children.
    pub branch_id: Option<String>,
    /// The session this one was forked from (its ref's `forkedFrom`, Story 4.4); `None` for
    /// the rest.
    pub forked_from: Option<String>,
    /// A session discovered from its transcript (Resume and Fork need one, Story 4.4); false
    /// for a live-only session, a stub and a branch.
    pub has_transcript: bool,
    /// What a discovered branch card shows (Story 5.1); `None` for sessions and stubs.
    pub branch: Option<BranchMeta>,
}

/// The facts of a discovered branch a card shows (Story 5.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchMeta {
    /// Checked out in the project's own checkout (the card's `*`).
    pub head: bool,
    /// The configured upstream; `None` for a local-only branch (no counts are shown).
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The upstream is configured but its ref is missing.
    pub upstream_gone: bool,
    /// The linked worktree holding the branch (not the project's own checkout).
    pub worktree: Option<WorktreeChip>,
}

/// The id of a discovered branch child: `<projectId>:<branch name>`.
pub fn branch_child_id(project_id: &str, name: &str) -> String {
    format!("{project_id}:{name}")
}

/// The facts of a discovered session a card shows (Story 3.1). Times are ISO 8601 UTC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub started_at: String,
    pub last_active: String,
    pub branch: Option<String>,
    pub messages: u32,
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

/// A session the live poll (`crate::claude::live`, Story 3.2) places under a project: what
/// [`children`] needs to order it and, when no transcript has been discovered for it yet, to
/// draw it as a **live-only child**. `live` is false for a session that has exited this run;
/// it is kept (memory only) so a session that exited before its transcript was found stays on
/// the canvas as a historic node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveChild {
    pub id: String,
    /// The row's `name`; `None` when it had none.
    pub name: Option<String>,
    /// The row's `startedAt` (milliseconds since the epoch).
    pub started_at_ms: Option<i64>,
    pub cwd: String,
    pub live: bool,
}

/// The label of a live-only child that has no `name`.
pub const NEW_SESSION_LABEL: &str = "new session";

/// A linked worktree of a project's repository as the status poll last listed it (Story 5.4;
/// `git::branches::known_of`): not bare, not missing, not the project's own checkout. Memory
/// only, never persisted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownWorktree {
    /// Canonical.
    pub path: String,
    /// The branch checked out there; `None` when detached.
    pub branch: Option<String>,
}

/// The known worktrees by project id.
pub type KnownWorktrees = HashMap<String, Vec<KnownWorktree>>;

/// What maps a `cwd` to a branch of `project_id` (Story 5.4): its stored [`BranchNode`]s (a
/// `worktreePath` kept as history once its worktree is removed), then a node per worktree git
/// lists with a branch (`known`). [`branch_for_cwd`] takes the deepest; on a tie git's list wins.
fn branch_mapping(workspace: &Workspace, known: &KnownWorktrees, project_id: &str) -> Vec<BranchNode> {
    workspace
        .branches
        .iter()
        .filter(|b| b.project_id == project_id)
        .cloned()
        .chain(known.get(project_id).into_iter().flatten().filter_map(|w| {
            w.branch.as_ref().map(|name| BranchNode {
                id: branch_child_id(project_id, name),
                project_id: project_id.to_string(),
                name: name.clone(),
                worktree_path: Some(w.path.clone()),
                position: None,
            })
        }))
        .collect()
}

/// Every worktree path known for `project_id` (Story 5.4): the stored `worktreePath`s, then the
/// worktrees git lists (detached ones too), each once. A transcript whose `cwd` is one of them
/// is discovered under the project.
pub fn known_worktree_paths(workspace: &Workspace, known: &KnownWorktrees, project_id: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let stored = workspace
        .branches
        .iter()
        .filter(|b| b.project_id == project_id)
        .filter_map(|b| b.worktree_path.clone());
    let listed = known.get(project_id).into_iter().flatten().map(|w| w.path.clone());
    for path in stored.chain(listed) {
        if !path.trim().is_empty() && !out.iter().any(|p| same_path(p, &path)) {
            out.push(path);
        }
    }
    out
}

/// Every child of every project, collapsed ones included, in layout order: the project's
/// sessions -- discovered (`discovered`, by project id) and live-only (`live`, by project id:
/// a live row with no discovered transcript yet) -- ordered live first, then pinned, then
/// `startedAt` newest first, then id; then `stubs` stub sessions (`session 1..n`, detail
/// `stub`, only when asked for); then its branches. A session takes its position (and label,
/// pin) from the matching [`SessionRef`] -- same `sessionId` and `projectId` -- when one
/// exists; a ref whose session is neither discovered nor live yields nothing. A live-only
/// child is labelled with the row's name (else [`NEW_SESSION_LABEL`]) and carries a
/// [`SessionMeta`] with `startedAt` = the row's start (empty when it has none), an empty
/// `lastActive` (no activity known: the card shows no age), no branch, 0 messages;
/// it is not drawn when its id is discovered under any project (one node per session id).
/// No branch children: see [`children_with_branches`].
pub fn children(
    workspace: &Workspace,
    discovered: &HashMap<String, Vec<SessionSummary>>,
    live: &HashMap<String, Vec<LiveChild>>,
    stubs: usize,
) -> Vec<ChildNode> {
    children_with_branches(workspace, discovered, live, stubs, &HashMap::new())
}

/// [`children`], plus each project's discovered branches (`listed`, by project id, in the
/// order the git read gave them: current first, then newest commit, then name) after its
/// sessions and stubs, for a project with `showBranches` on only. A branch child's id is
/// [`branch_child_id`]; its position comes from the [`BranchNode`] with the same project and
/// name, when the operator moved it. A stored `BranchNode` whose branch is not listed (gone,
/// or not read yet) yields nothing.
pub fn children_with_branches(
    workspace: &Workspace,
    discovered: &HashMap<String, Vec<SessionSummary>>,
    live: &HashMap<String, Vec<LiveChild>>,
    stubs: usize,
    listed: &HashMap<String, Vec<BranchInfo>>,
) -> Vec<ChildNode> {
    children_with_worktrees(workspace, discovered, live, stubs, listed, &HashMap::new())
}

/// [`children_with_branches`], with a session's branch also found through the worktrees git
/// lists for its project (`known`, Story 5.4): the worktree holding its `cwd`, deepest first,
/// stored or listed.
pub fn children_with_worktrees(
    workspace: &Workspace,
    discovered: &HashMap<String, Vec<SessionSummary>>,
    live: &HashMap<String, Vec<LiveChild>>,
    stubs: usize,
    listed: &HashMap<String, Vec<BranchInfo>>,
    known: &KnownWorktrees,
) -> Vec<ChildNode> {
    let discovered_ids: HashSet<&str> = discovered.values().flatten().map(|s| s.id.as_str()).collect();
    // Live by session id, under whichever project the row's cwd maps to: a transcript under
    // one project and a live row under another still sort that card first.
    let live_ids: HashSet<&str> = live.values().flatten().filter(|l| l.live).map(|l| l.id.as_str()).collect();
    let mut out = Vec::new();
    for project in &workspace.projects {
        let session_ref = |id: &str| {
            workspace
                .sessions
                .iter()
                .find(|s| s.session_id == id && s.project_id == project.id)
        };
        let branches: Vec<&BranchNode> = workspace.branches.iter().filter(|b| b.project_id == project.id).collect();
        let mapping_nodes = branch_mapping(workspace, known, &project.id);
        let mapping: Vec<&BranchNode> = mapping_nodes.iter().collect();
        let live_here: &[LiveChild] = live.get(&project.id).map(Vec::as_slice).unwrap_or_default();
        let is_live = |id: &str| live_ids.contains(id);

        let mut real: Vec<&SessionSummary> = discovered.get(&project.id).map(|list| list.iter().collect()).unwrap_or_default();
        // One node per session id, even if two project dirs hold the same transcript: the
        // newer copy (later activity, then more messages) wins.
        real.sort_by(|a, b| {
            a.id.cmp(&b.id)
                .then_with(|| b.last_active.cmp(&a.last_active))
                .then_with(|| b.messages.cmp(&a.messages))
        });
        real.dedup_by(|a, b| a.id == b.id);

        let mut sessions: Vec<ChildNode> = real
            .into_iter()
            .map(|summary| {
                let session_ref = session_ref(&summary.id);
                let worktree_branch = summary.cwd.as_deref().and_then(|cwd| branch_for_cwd(cwd, &mapping));
                ChildNode {
                    id: summary.id.clone(),
                    project_id: project.id.clone(),
                    kind: ChildKind::Session,
                    label: session_ref
                        .and_then(|r| r.label.clone())
                        .unwrap_or_else(|| summary.title.clone()),
                    detail: None,
                    position: session_ref.and_then(|r| r.position),
                    session: Some(SessionMeta {
                        started_at: summary.started_at.clone(),
                        last_active: summary.last_active.clone(),
                        branch: summary.branch.clone(),
                        messages: summary.messages,
                    }),
                    branch_id: worktree_branch.or_else(|| session_ref.and_then(|r| r.branch_id.clone())),
                    forked_from: session_ref.and_then(|r| r.forked_from.clone()),
                    has_transcript: true,
                    branch: None,
                }
            })
            .collect();
        let mut live_only: Vec<&LiveChild> = live_here.iter().filter(|l| !discovered_ids.contains(l.id.as_str())).collect();
        live_only.sort_by(|a, b| a.id.cmp(&b.id));
        live_only.dedup_by(|a, b| a.id == b.id);
        for row in live_only {
            let session_ref = session_ref(&row.id);
            let started = row.started_at_ms.map(format_iso_ms).unwrap_or_default();
            sessions.push(ChildNode {
                id: row.id.clone(),
                project_id: project.id.clone(),
                kind: ChildKind::Session,
                label: session_ref
                    .and_then(|r| r.label.clone())
                    .or_else(|| row.name.clone().filter(|n| !n.trim().is_empty()))
                    .unwrap_or_else(|| NEW_SESSION_LABEL.to_string()),
                detail: None,
                position: session_ref.and_then(|r| r.position),
                session: Some(SessionMeta {
                    started_at: started,
                    // No activity is known for a session without a transcript: no age.
                    last_active: String::new(),
                    branch: None,
                    messages: 0,
                }),
                branch_id: branch_for_cwd(&row.cwd, &mapping).or_else(|| session_ref.and_then(|r| r.branch_id.clone())),
                forked_from: session_ref.and_then(|r| r.forked_from.clone()),
                has_transcript: false,
                branch: None,
            });
        }
        // Live first; then pinned; then started-at, not last activity: two running sessions
        // must not swap slots every pass.
        let pinned = |id: &str| session_ref(id).is_some_and(|r| r.pinned);
        let started = |c: &ChildNode| c.session.as_ref().map(|m| m.started_at.clone()).unwrap_or_default();
        sessions.sort_by(|a, b| {
            is_live(&b.id)
                .cmp(&is_live(&a.id))
                .then_with(|| pinned(&b.id).cmp(&pinned(&a.id)))
                .then_with(|| started(b).cmp(&started(a)))
                .then_with(|| a.id.cmp(&b.id))
        });
        out.extend(sessions);
        for i in 1..=stubs {
            let id = stub_session_id(i, &project.id);
            let position = session_ref(&id).and_then(|s| s.position);
            out.push(ChildNode {
                id,
                project_id: project.id.clone(),
                kind: ChildKind::Session,
                label: format!("session {i}"),
                detail: Some("stub".to_string()),
                position,
                session: None,
                branch_id: None,
                forked_from: None,
                has_transcript: false,
                branch: None,
            });
        }
        if !project.show_branches {
            continue;
        }
        for info in listed.get(&project.id).map(Vec::as_slice).unwrap_or_default() {
            let placed = branches.iter().find(|b| b.name == info.name);
            out.push(ChildNode {
                id: branch_child_id(&project.id, &info.name),
                project_id: project.id.clone(),
                kind: ChildKind::Branch,
                label: info.name.clone(),
                detail: None,
                position: placed.and_then(|b| b.position),
                session: None,
                branch_id: None,
                forked_from: None,
                has_transcript: false,
                branch: Some(BranchMeta {
                    head: info.head,
                    upstream: info.upstream.clone(),
                    ahead: info.ahead,
                    behind: info.behind,
                    upstream_gone: info.gone,
                    worktree: info.worktree.clone(),
                }),
            });
        }
    }
    out
}

/// The project a live row with working directory `cwd` belongs to: the project whose path is
/// `cwd` ([`same_path`]), else the project with a branch whose `worktreePath` holds `cwd`
/// (Story 3.1's worktree rule; the deepest worktree wins). `None` puts the row in the
/// Elsewhere tray.
pub fn project_for_cwd(workspace: &Workspace, cwd: &str) -> Option<String> {
    project_for_cwd_in(workspace, &HashMap::new(), cwd)
}

/// [`project_for_cwd`], with the worktrees git lists for each project (`known`, Story 5.4)
/// counted like stored ones: a live session in a worktree the app never stored (Claude's own
/// `.claude/worktrees/<name>`) maps to its project, not the Elsewhere tray. One rule, shared
/// with discovery (`claude::sessions::scan`): a cwd that is exactly a project's own folder is
/// that project's, whatever worktree lists claim it; otherwise the deepest worktree holding it
/// wins, and on an equal depth the first project in workspace order.
pub fn project_for_cwd_in(workspace: &Workspace, known: &KnownWorktrees, cwd: &str) -> Option<String> {
    // Project paths are canonical (`canonical_dir`); a row's cwd may differ in separators, a
    // trailing separator or a symlink. The raw cwd stands when it cannot be canonicalised.
    let canonical = dunce::canonicalize(cwd.trim())
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| cwd.to_string());
    // A project's own folder is matched exactly (a subfolder is elsewhere) and always wins.
    if let Some(project) = workspace
        .projects
        .iter()
        .find(|p| same_path(&p.path, &canonical) || same_path(&p.path, cwd))
    {
        return Some(project.id.clone());
    }
    let mut best: Option<(&str, usize)> = None;
    for project in &workspace.projects {
        let stored = workspace
            .branches
            .iter()
            .filter(|b| b.project_id == project.id)
            .filter_map(|b| b.worktree_path.as_deref());
        let listed = known.get(&project.id).into_iter().flatten().map(|w| w.path.as_str());
        for path in stored.chain(listed) {
            let depth = path_depth(path);
            if (path_within(&canonical, path) || path_within(cwd, path)) && best.is_none_or(|(_, d)| depth > d) {
                best = Some((project.id.as_str(), depth));
            }
        }
    }
    best.map(|(id, _)| id.to_string())
}

/// How deep a folder is: its path's component count (a trailing separator does not count).
pub(crate) fn path_depth(path: &str) -> usize {
    Path::new(path.trim()).components().count()
}

/// The id of the branch whose `worktreePath` holds `cwd` (the folder itself or anything in
/// it), in the branch child's form `<projectId>:<name>` ([`branch_child_id`]); the deepest one
/// when worktrees nest. `None` when no branch has a matching worktree.
pub fn branch_for_cwd(cwd: &str, branches: &[&BranchNode]) -> Option<String> {
    branches
        .iter()
        .filter_map(|b| b.worktree_path.as_deref().map(|w| (b, w)))
        .filter(|(_, worktree)| path_within(cwd, worktree))
        .max_by_key(|(_, worktree)| worktree.len())
        .map(|(b, _)| branch_child_id(&b.project_id, &b.name))
}

/// `path` is `root` or lies inside it, compared component by component (so `/a/bc` is not in
/// `/a/b`); on Windows ASCII case is ignored and `/` counts as `\`.
pub(crate) fn path_within(path: &str, root: &str) -> bool {
    if root.trim().is_empty() {
        return false;
    }
    if cfg!(windows) {
        let norm = |p: &str| p.replace('/', "\\").to_ascii_lowercase();
        Path::new(&norm(path)).starts_with(Path::new(&norm(root)))
    } else {
        Path::new(path).starts_with(Path::new(root))
    }
}

impl SessionRef {
    /// True when the ref records nothing any more: no label, pin, branch, position or fork
    /// origin. Such a ref is pruned by [`relayout_children`] (it only ever held a dragged
    /// position).
    pub fn is_bare(&self) -> bool {
        self.label.is_none() && !self.pinned && self.branch_id.is_none() && self.position.is_none() && self.forked_from.is_none()
    }
}

// ---------------------------------------------------------------------------------------
// State and snapshot
// ---------------------------------------------------------------------------------------

/// Everything the UI needs about the workspace, sent on request and on every change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    /// Absolute path of `workspace.json`; `None` when the config dir could not be determined.
    pub path: Option<String>,
    pub workspace: Workspace,
    pub banners: Vec<Banner>,
    /// Bumped on every mutation this session, so the UI can drop a reply that arrives after a
    /// newer snapshot (two adds in flight). Not persisted; starts at 0 on load.
    pub revision: u64,
    /// Every project's children ([`children_with_branches`]), collapsed ones too; the UI lays
    /// them out.
    pub children: Vec<ChildNode>,
    /// Why the last branch read of a project failed (Story 5.1), by project id: the card adds
    /// a muted `branches unavailable` line with this on hover, and the last good list stays.
    pub branch_errors: HashMap<String, String>,
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
    /// Sessions discovered from Claude's transcripts, by project id (`crate::claude::sessions`
    /// via [`set_discovered`]). Never persisted.
    pub discovered: HashMap<String, Vec<SessionSummary>>,
    /// Sessions the live poll placed under a project, by project id (`crate::claude::live`
    /// via [`set_live_children`]), each list ordered by id. Never persisted.
    pub live_children: HashMap<String, Vec<LiveChild>>,
    /// The last good branch list of each project with branches on, by project id
    /// (`crate::git::poll::refresh_branches` via [`set_branches`]). Never persisted.
    pub branches: HashMap<String, Vec<BranchInfo>>,
    /// The cause of each project's last failed branch read (cleared by a good one).
    pub branch_errors: HashMap<String, String>,
    /// Each project's linked worktrees as the status poll last listed them (Story 5.4,
    /// `crate::git::poll` via [`set_worktrees`]), whatever the branches toggle. Never persisted.
    pub worktrees: KnownWorktrees,
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
            children: self.children(),
            branch_errors: self.branch_errors.clone(),
        }
    }

    /// Every project's children as [`children_with_branches`] derives them from this state.
    pub fn children(&self) -> Vec<ChildNode> {
        children_with_worktrees(&self.workspace, &self.discovered, &self.live_children, self.stub_children, &self.branches, &self.worktrees)
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
                show_branches: false,
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

/// The "branches" toggle (`project.toggleBranches`, Story 5.1): store `showBranches`; turning
/// it on also expands a collapsed card, turning it off forgets the project's branch list and
/// error (memory only). Written and emitted like any mutation; the same value again (on and
/// already expanded, or off) changes nothing. An unknown id is an `Err` and nothing changes.
/// The caller starts or stops the watch and reads the list (`ipc::project_set_show_branches`).
pub fn set_show_branches<R: Runtime>(app: &AppHandle<R>, project_id: &str, show: bool) -> Result<WorkspaceSnapshot, String> {
    let state = app.state::<AppState>();
    let (target, workspace) = {
        let mut st = state.write_workspace();
        let project = st
            .workspace
            .projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or_else(|| "unknown project".to_string())?;
        if project.show_branches == show && (!show || project.expanded) {
            return Ok(st.snapshot());
        }
        project.show_branches = show;
        if show {
            project.expanded = true;
        } else {
            st.branches.remove(project_id);
            st.branch_errors.remove(project_id);
        }
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    Ok(persist_and_emit(app, target, &workspace))
}

/// What one branch read of a project gave: the list (`Ok(Some)`), "not a repository"
/// (`Ok(None)`: no list, no error), or why it failed.
pub type BranchOutcome = Result<Option<Vec<BranchInfo>>, String>;

/// Store the outcome of a branch read per project (`crate::git::poll::refresh_branches`): a
/// list replaces the stored one and clears the error; "not a repository" drops both; a
/// failure keeps the last good list and records the cause. A good list also prunes the
/// project's [`BranchNode`]s whose branch it no longer lists, unless an edge or a session's
/// `branchId` references them or they hold a `worktreePath` (Story 5.4); then the file is
/// written too. Projects no longer on the canvas
/// or with branches off are ignored (a read that raced a toggle). When anything changed the
/// revision is bumped and `workspace://changed` emitted; the file is not written. Returns the
/// snapshot, or `None` when nothing changed.
pub fn set_branches<R: Runtime>(app: &AppHandle<R>, outcomes: HashMap<String, BranchOutcome>) -> Option<WorkspaceSnapshot> {
    let state = app.state::<AppState>();
    let (snapshot, write) = {
        let mut st = state.write_workspace();
        let mut changed = false;
        let mut pruned = false;
        for (id, outcome) in outcomes {
            if !st.workspace.projects.iter().any(|p| p.id == id && p.show_branches) {
                continue;
            }
            let good = matches!(outcome, Ok(Some(_)));
            let (list, error) = match outcome {
                Ok(Some(list)) => (Some(list), None),
                Ok(None) => (None, None),
                Err(message) => (st.branches.get(&id).cloned(), Some(message)),
            };
            // A good read prunes the project's stored branch refs whose branch is gone, unless
            // something references them (an edge, a session's `branchId`).
            if good && let Some(list) = list.as_ref() {
                let referenced = referenced_branch_ids(&st.workspace);
                let before = st.workspace.branches.len();
                // A stored worktree path is history (Story 5.4): its sessions stay discovered,
                // so such a node is never pruned, even once its branch is deleted.
                st.workspace.branches.retain(|b| {
                    b.project_id != id
                        || b.worktree_path.is_some()
                        || list.iter().any(|info| info.name == b.name)
                        || is_referenced(b, &referenced)
                });
                pruned |= st.workspace.branches.len() != before;
            }
            if st.branches.get(&id) != list.as_ref() {
                changed = true;
                match list {
                    Some(list) => st.branches.insert(id.clone(), list),
                    None => st.branches.remove(&id),
                };
            }
            if st.branch_errors.get(&id) != error.as_ref() {
                changed = true;
                match error {
                    Some(error) => st.branch_errors.insert(id, error),
                    None => st.branch_errors.remove(&id),
                };
            }
        }
        if !changed && !pruned {
            return None;
        }
        st.revision += 1;
        let write = pruned.then(|| (st.write_target(), st.workspace.clone()));
        (st.snapshot(), write)
    };
    match write {
        // Pruned refs live in the file: written (and emitted) like any mutation.
        Some((target, workspace)) => Some(persist_and_emit(app, target, &workspace)),
        None => {
            emit(app, &snapshot);
            Some(snapshot)
        }
    }
}

/// Every branch id something in the workspace points at: an edge end of type `branch`, or a
/// session ref's `branchId`.
fn referenced_branch_ids(workspace: &Workspace) -> HashSet<String> {
    workspace
        .edges
        .iter()
        .flat_map(|e| [&e.from, &e.to])
        .filter(|n| n.kind == NodeType::Branch)
        .map(|n| n.id.clone())
        .chain(workspace.sessions.iter().filter_map(|s| s.branch_id.clone()))
        .collect()
}

/// A stored branch is referenced by its own id or by its child id (`<projectId>:<name>`).
fn is_referenced(branch: &BranchNode, referenced: &HashSet<String>) -> bool {
    referenced.contains(&branch.id) || referenced.contains(&branch_child_id(&branch.project_id, &branch.name))
}

/// Store where a node was dropped. A project's position is absolute; a child's is relative
/// to its parent card and goes where the schema keeps it: a session child upserts its
/// [`SessionRef`] (creating one holding just `sessionId`, `projectId`, `position` when the
/// session has no ref yet), a branch child upserts its [`BranchNode`] (matched by project and
/// name; created holding just `id`, `projectId`, `name` and `position`). A non-finite position
/// or an id that is not a known node (for a session or a branch: not a current child) is an
/// `Err` and nothing changes.
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
                let project_id = st
                    .children()
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
                let (project_id, name) = st
                    .children()
                    .into_iter()
                    .find(|c| c.kind == ChildKind::Branch && c.id == target.id)
                    .map(|c| (c.project_id, c.label))
                    .ok_or_else(|| "unknown branch".to_string())?;
                match st
                    .workspace
                    .branches
                    .iter_mut()
                    .find(|b| b.project_id == project_id && b.name == name)
                {
                    Some(existing) => existing.position = Some(position),
                    None => st.workspace.branches.push(BranchNode {
                        id: target.id.clone(),
                        project_id,
                        name,
                        worktree_path: None,
                        position: Some(position),
                    }),
                }
            }
        }
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    Ok(persist_and_emit(app, write_target, &workspace))
}

/// Record a branch the operator just gave a worktree (Story 5.2, after `git worktree add`):
/// upsert its [`BranchNode`] (matched by project and name; created as `id`
/// `<projectId>:<name>`, `projectId`, `name`, no position) with `worktreePath` set and any
/// stored position kept; written and emitted like any mutation. The card itself, and its chip,
/// still come from the next branch read. An unknown project is an `Err` and nothing changes.
pub fn upsert_created_branch<R: Runtime>(app: &AppHandle<R>, project_id: &str, name: &str, worktree_path: &str) -> Result<WorkspaceSnapshot, String> {
    let state = app.state::<AppState>();
    let (target, workspace) = {
        let mut st = state.write_workspace();
        if !st.workspace.projects.iter().any(|p| p.id == project_id) {
            return Err("unknown project".to_string());
        }
        match st
            .workspace
            .branches
            .iter_mut()
            .find(|b| b.project_id == project_id && b.name == name)
        {
            Some(existing) => existing.worktree_path = Some(worktree_path.to_string()),
            None => st.workspace.branches.push(BranchNode {
                id: branch_child_id(project_id, name),
                project_id: project_id.to_string(),
                name: name.to_string(),
                worktree_path: Some(worktree_path.to_string()),
                position: None,
            }),
        }
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    Ok(persist_and_emit(app, target, &workspace))
}

/// Remember the launch sheet's last choices for a project (`Project.launchDefaults`, Story
/// 4.2): stored, the file written and `workspace://changed` emitted, through the same path as
/// every mutation. The same choices again change nothing (no revision, write or emit). An
/// unknown id is an `Err` and nothing changes.
pub fn set_launch_defaults<R: Runtime>(app: &AppHandle<R>, project_id: &str, defaults: LaunchDefaults) -> Result<WorkspaceSnapshot, String> {
    let state = app.state::<AppState>();
    let (target, workspace) = {
        let mut st = state.write_workspace();
        let project = st
            .workspace
            .projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or_else(|| "unknown project".to_string())?;
        if project.launch_defaults.as_ref() == Some(&defaults) {
            return Ok(st.snapshot());
        }
        project.launch_defaults = Some(defaults);
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    Ok(persist_and_emit(app, target, &workspace))
}

/// Record that session `session_id` (under `project_id`) was forked from `from` (Story 4.4):
/// its [`SessionRef`] (created when it has none) gets `forkedFrom`, the file is written and
/// `workspace://changed` emitted. The same origin again changes nothing. An unknown project is
/// an `Err` and nothing changes.
pub fn set_forked_from<R: Runtime>(app: &AppHandle<R>, project_id: &str, session_id: &str, from: &str) -> Result<WorkspaceSnapshot, String> {
    let state = app.state::<AppState>();
    let (target, workspace) = {
        let mut st = state.write_workspace();
        if !st.workspace.projects.iter().any(|p| p.id == project_id) {
            return Err("unknown project".to_string());
        }
        match st
            .workspace
            .sessions
            .iter_mut()
            .find(|s| s.session_id == session_id && s.project_id == project_id)
        {
            Some(existing) if existing.forked_from.as_deref() == Some(from) => return Ok(st.snapshot()),
            Some(existing) => existing.forked_from = Some(from.to_string()),
            None => st.workspace.sessions.push(SessionRef {
                session_id: session_id.to_string(),
                project_id: project_id.to_string(),
                forked_from: Some(from.to_string()),
                ..SessionRef::default()
            }),
        }
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    let outcome = target.map(|path| store::write(&path, &workspace));
    if let Some(Err(err)) = outcome {
        // Not saved: the link is taken back (the file keeps what it had), with the banner.
        state.write_workspace().file_banner = Some(write_banner(&err));
        clear_forked_from(app, project_id, session_id);
        return Err(format!("could not save the fork link: {err}"));
    }
    let snapshot = {
        let mut st = state.write_workspace();
        if outcome.is_some() {
            st.file_banner = None;
        }
        st.snapshot()
    };
    emit(app, &snapshot);
    Ok(snapshot)
}

/// Record the branch a session was started on (Story 5.3): its [`SessionRef`] (created when it
/// has none) gets `branchId` (`<projectId>:<name>`, [`branch_child_id`]), so the card is drawn
/// under that branch card, and a [`BranchNode`] it names is not pruned while git does not list
/// the branch yet (`claude --worktree`). Written before the spawn, as [`set_forked_from`] is: a
/// write that fails takes the ref back and is the `Err`. The same branch again changes nothing.
/// An unknown project is an `Err` and nothing changes.
pub fn set_session_branch<R: Runtime>(app: &AppHandle<R>, session_id: &str, project_id: &str, branch_id: &str) -> Result<WorkspaceSnapshot, String> {
    let state = app.state::<AppState>();
    let (target, workspace) = {
        let mut st = state.write_workspace();
        if !st.workspace.projects.iter().any(|p| p.id == project_id) {
            return Err("unknown project".to_string());
        }
        match st
            .workspace
            .sessions
            .iter_mut()
            .find(|s| s.session_id == session_id && s.project_id == project_id)
        {
            Some(existing) if existing.branch_id.as_deref() == Some(branch_id) => return Ok(st.snapshot()),
            Some(existing) => existing.branch_id = Some(branch_id.to_string()),
            None => st.workspace.sessions.push(SessionRef {
                session_id: session_id.to_string(),
                project_id: project_id.to_string(),
                branch_id: Some(branch_id.to_string()),
                ..SessionRef::default()
            }),
        }
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    let outcome = target.map(|path| store::write(&path, &workspace));
    if let Some(Err(err)) = outcome {
        state.write_workspace().file_banner = Some(write_banner(&err));
        clear_session_branch(app, project_id, session_id);
        return Err(format!("could not save the session's branch: {err}"));
    }
    let snapshot = {
        let mut st = state.write_workspace();
        if outcome.is_some() {
            st.file_banner = None;
        }
        st.snapshot()
    };
    emit(app, &snapshot);
    Ok(snapshot)
}

/// Take back a [`BranchNode`] a launch recorded before a spawn that failed (Story 5.3): the
/// project's stored branch `name` goes; written and emitted. Nothing stored changes nothing.
pub fn remove_branch_node<R: Runtime>(app: &AppHandle<R>, project_id: &str, name: &str) {
    let state = app.state::<AppState>();
    let (target, workspace) = {
        let mut st = state.write_workspace();
        let before = st.workspace.branches.len();
        st.workspace.branches.retain(|b| !(b.project_id == project_id && b.name == name));
        if st.workspace.branches.len() == before {
            return;
        }
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    persist_and_emit(app, target, &workspace);
}

/// Take back a session's `branchId` (a launch that did not start, Story 5.3): the ref loses
/// it, and goes when nothing else is left in it; written and emitted. Nothing to take back
/// changes nothing.
pub fn clear_session_branch<R: Runtime>(app: &AppHandle<R>, project_id: &str, session_id: &str) {
    let state = app.state::<AppState>();
    let (target, workspace) = {
        let mut st = state.write_workspace();
        let Some(existing) = st
            .workspace
            .sessions
            .iter_mut()
            .find(|s| s.session_id == session_id && s.project_id == project_id && s.branch_id.is_some())
        else {
            return;
        };
        existing.branch_id = None;
        let linked = edge_session_ids(&st.workspace);
        st.workspace
            .sessions
            .retain(|s| !(s.session_id == session_id && s.project_id == project_id && s.is_bare() && !linked.contains(&s.session_id)));
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    persist_and_emit(app, target, &workspace);
}

/// Take back a fork link (a fork that did not start, Story 4.4): the session's ref loses its
/// `forkedFrom`, and goes when nothing else is left in it; written and emitted. Nothing to
/// take back changes nothing.
pub fn clear_forked_from<R: Runtime>(app: &AppHandle<R>, project_id: &str, session_id: &str) {
    let state = app.state::<AppState>();
    let (target, workspace) = {
        let mut st = state.write_workspace();
        let Some(existing) = st
            .workspace
            .sessions
            .iter_mut()
            .find(|s| s.session_id == session_id && s.project_id == project_id && s.forked_from.is_some())
        else {
            return;
        };
        existing.forked_from = None;
        let linked = edge_session_ids(&st.workspace);
        st.workspace
            .sessions
            .retain(|s| !(s.session_id == session_id && s.project_id == project_id && s.is_bare() && !linked.contains(&s.session_id)));
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    persist_and_emit(app, target, &workspace);
}

/// Fork refs (`forkedFrom` set) whose fork session is neither discovered nor a live child of
/// any project, nor a fork still starting (`pending`): their sessions are gone. The ids go;
/// `true` when any went. A missing *original* is not a reason: it only hides the line.
fn prune_fork_refs(st: &mut WorkspaceState, pending: &HashSet<String>) -> bool {
    let known: HashSet<&str> = st
        .discovered
        .values()
        .flatten()
        .map(|s| s.id.as_str())
        .chain(st.live_children.values().flatten().map(|l| l.id.as_str()))
        .collect();
    let gone: Vec<usize> = st
        .workspace
        .sessions
        .iter()
        .enumerate()
        .filter(|(_, s)| s.forked_from.is_some() && !known.contains(s.session_id.as_str()) && !pending.contains(&s.session_id))
        .map(|(i, _)| i)
        .collect();
    for i in gone.iter().rev() {
        st.workspace.sessions.remove(*i);
    }
    !gone.is_empty()
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
        let linked = edge_session_ids(&st.workspace);
        st.workspace
            .sessions
            .retain(|s| s.project_id != project_id || !s.is_bare() || linked.contains(&s.session_id));
        for branch in st.workspace.branches.iter_mut().filter(|b| b.project_id == project_id) {
            branch.position = None;
        }
        // A branch ref that only held a dragged position (Story 5.1) goes with it, unless an
        // edge or a session's `branchId` references it.
        let referenced = referenced_branch_ids(&st.workspace);
        st.workspace
            .branches
            .retain(|b| b.project_id != project_id || b.worktree_path.is_some() || is_referenced(b, &referenced));
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    Ok(persist_and_emit(app, target, &workspace))
}

/// Take a project off the canvas (`project.remove`): drop the project, every [`SessionRef`]
/// and [`BranchNode`] of it, and every edge touching any of them (the project itself, any of
/// its session children -- refs and stubs alike -- or its branches); other projects' refs
/// and edges are untouched. Immediate and final: no confirmation, no undo. The file is
/// written (outside the lock) and `workspace://changed` emitted. An unknown id is an `Err`
/// and nothing changes. The live git status is pruned by the caller (`git::poll::forget`).
pub fn remove_project<R: Runtime>(app: &AppHandle<R>, project_id: &str) -> Result<WorkspaceSnapshot, String> {
    let state = app.state::<AppState>();
    let (target, workspace) = {
        let mut st = state.write_workspace();
        if !st.workspace.projects.iter().any(|p| p.id == project_id) {
            return Err("unknown project".to_string());
        }
        let session_ids: HashSet<String> = st
            .children()
            .into_iter()
            .filter(|c| c.project_id == project_id && c.kind == ChildKind::Session)
            .map(|c| c.id)
            .chain(
                st.workspace
                    .sessions
                    .iter()
                    .filter(|s| s.project_id == project_id)
                    .map(|s| s.session_id.clone()),
            )
            .collect();
        let branch_ids: HashSet<String> = st
            .workspace
            .branches
            .iter()
            .filter(|b| b.project_id == project_id)
            .map(|b| b.id.clone())
            .chain(
                st.children()
                    .into_iter()
                    .filter(|c| c.project_id == project_id && c.kind == ChildKind::Branch)
                    .map(|c| c.id),
            )
            .collect();
        // Branch card ids are `<projectId>:<name>`: an edge to one goes even while the
        // project's branches are off (no child lists it then).
        let branch_prefix = format!("{project_id}:");
        let touches = |node: &NodeRef| match node.kind {
            NodeType::Project => node.id == project_id,
            NodeType::Session => session_ids.contains(&node.id),
            NodeType::Branch => branch_ids.contains(&node.id) || node.id.starts_with(&branch_prefix),
            NodeType::Folder => false,
        };
        st.workspace.edges.retain(|e| !touches(&e.from) && !touches(&e.to));
        st.workspace.projects.retain(|p| p.id != project_id);
        st.workspace.sessions.retain(|s| s.project_id != project_id);
        st.workspace.branches.retain(|b| b.project_id != project_id);
        st.branches.remove(project_id);
        st.branch_errors.remove(project_id);
        st.worktrees.remove(project_id);
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    Ok(persist_and_emit(app, target, &workspace))
}

// ---------------------------------------------------------------------------------------
// Edges (Story 6.1): Rust picks the kind, refuses invalid pairs and owns the list
// ---------------------------------------------------------------------------------------

/// Refusal: both ends are the same node.
pub const REFUSE_SELF: &str = "can't link a node to itself";
/// Refusal: a branch is never the source of an edge.
pub const REFUSE_FROM_BRANCH: &str = "can't link from a branch";
/// Refusal: context runs from a project to a project or a branch, never to a session.
pub const REFUSE_PROJECT_TO_SESSION: &str = "can't link a project to a session";
/// Refusal: folder targets come with Story 6.2.
pub const REFUSE_FOLDER: &str = "can't link a folder yet";
/// Refusal: the same kind between the same two ends already exists.
pub const REFUSE_DUPLICATE: &str = "already linked";

/// The kind of an edge drawn from `from` to `to`, or why the pair is refused (the notice the
/// UI shows): `cooperate` between two sessions; `context` from a session or a project to a
/// project or a branch. A branch as the source, a project to a session, a node to itself and
/// (for now) a folder at either end are refused. Mirrored by `src/canvas/edges.ts`.
pub fn edge_kind(from: &NodeRef, to: &NodeRef) -> Result<EdgeKind, &'static str> {
    if from.kind == NodeType::Folder || to.kind == NodeType::Folder {
        return Err(REFUSE_FOLDER);
    }
    if from == to {
        return Err(REFUSE_SELF);
    }
    match (from.kind, to.kind) {
        (NodeType::Branch, _) => Err(REFUSE_FROM_BRANCH),
        (NodeType::Session, NodeType::Session) => Ok(EdgeKind::Cooperate),
        (NodeType::Project, NodeType::Session) => Err(REFUSE_PROJECT_TO_SESSION),
        (NodeType::Session | NodeType::Project, NodeType::Project | NodeType::Branch) => Ok(EdgeKind::Context),
        // Folders are refused above.
        (NodeType::Folder, _) | (_, NodeType::Folder) => Err(REFUSE_FOLDER),
    }
}

/// True when `edges` already holds an edge of `kind` between `from` and `to`: same direction,
/// or either direction for an (undirected) cooperate edge.
pub fn is_duplicate_edge(edges: &[Edge], kind: EdgeKind, from: &NodeRef, to: &NodeRef) -> bool {
    edges.iter().any(|e| {
        e.kind == kind && ((e.from == *from && e.to == *to) || (kind == EdgeKind::Cooperate && e.from == *to && e.to == *from))
    })
}

/// Whether `node` names a node of the workspace: a project on the canvas; a session child
/// (stubs included) or a stored session ref of a project on the canvas; a listed branch child
/// or a stored branch node (by its id or its `<projectId>:<name>` child id).
fn edge_end_exists(workspace: &Workspace, children: &[ChildNode], node: &NodeRef) -> bool {
    let on_canvas = |project_id: &str| workspace.projects.iter().any(|p| p.id == project_id);
    match node.kind {
        NodeType::Project => on_canvas(&node.id),
        NodeType::Session => {
            children.iter().any(|c| c.kind == ChildKind::Session && c.id == node.id)
                || workspace.sessions.iter().any(|s| s.session_id == node.id && on_canvas(&s.project_id))
        }
        NodeType::Branch => {
            children.iter().any(|c| c.kind == ChildKind::Branch && c.id == node.id)
                || workspace
                    .branches
                    .iter()
                    .any(|b| on_canvas(&b.project_id) && (b.id == node.id || branch_child_id(&b.project_id, &b.name) == node.id))
        }
        NodeType::Folder => false,
    }
}

fn node_type_word(kind: NodeType) -> &'static str {
    match kind {
        NodeType::Project => "project",
        NodeType::Branch => "branch",
        NodeType::Session => "session",
        NodeType::Folder => "folder",
    }
}

/// A branch end as stored: always the card's `<projectId>:<name>` id, so a stored branch node
/// named by its own id is the same end (for the self and duplicate checks, and for drawing).
/// Any other end, or a branch not found, comes back unchanged.
fn canonical_end(workspace: &Workspace, children: &[ChildNode], node: &NodeRef) -> NodeRef {
    if node.kind != NodeType::Branch || children.iter().any(|c| c.kind == ChildKind::Branch && c.id == node.id) {
        return node.clone();
    }
    workspace
        .branches
        .iter()
        .find(|b| b.id == node.id || branch_child_id(&b.project_id, &b.name) == node.id)
        .map(|b| NodeRef {
            kind: NodeType::Branch,
            id: branch_child_id(&b.project_id, &b.name),
        })
        .unwrap_or_else(|| node.clone())
}

/// Session ids some edge ends on: their refs are kept even when bare, so
/// [`remove_project`] can still find (and prune) the edge once the session is unlisted.
fn edge_session_ids(workspace: &Workspace) -> HashSet<String> {
    workspace
        .edges
        .iter()
        .flat_map(|e| [&e.from, &e.to])
        .filter(|n| n.kind == NodeType::Session)
        .map(|n| n.id.clone())
        .collect()
}

/// Draw an edge from `from` to `to` (`edge_add`): the kind comes from the pair
/// ([`edge_kind`]); a branch end is stored by its card id ([`canonical_end`]); both ends must be
/// nodes of the workspace (`Err("unknown <type>")`) and the edge must not exist yet
/// ([`is_duplicate_edge`], `Err("already linked")`). A session end without a [`SessionRef`] gets
/// one (just `sessionId` and `projectId`, as a drag does), so the edge goes with its project.
/// The new edge gets a UUID v4, no label and `createdAt` now; it is written and emitted like any
/// mutation. A refusal changes nothing.
pub fn add_edge<R: Runtime>(app: &AppHandle<R>, from: &NodeRef, to: &NodeRef) -> Result<Edge, String> {
    let kind = edge_kind(from, to).map_err(str::to_string)?;
    let state = app.state::<AppState>();
    let (target, workspace, edge) = {
        let mut st = state.write_workspace();
        let children = st.children();
        let from = canonical_end(&st.workspace, &children, from);
        let to = canonical_end(&st.workspace, &children, to);
        if from == to {
            return Err(REFUSE_SELF.to_string());
        }
        for end in [&from, &to] {
            if !edge_end_exists(&st.workspace, &children, end) {
                return Err(format!("unknown {}", node_type_word(end.kind)));
            }
        }
        if is_duplicate_edge(&st.workspace.edges, kind, &from, &to) {
            return Err(REFUSE_DUPLICATE.to_string());
        }
        for end in [&from, &to] {
            if end.kind != NodeType::Session || st.workspace.sessions.iter().any(|s| s.session_id == end.id) {
                continue;
            }
            if let Some(child) = children.iter().find(|c| c.kind == ChildKind::Session && c.id == end.id) {
                st.workspace.sessions.push(SessionRef {
                    session_id: end.id.clone(),
                    project_id: child.project_id.clone(),
                    ..SessionRef::default()
                });
            }
        }
        let edge = Edge {
            id: uuid::Uuid::new_v4().to_string(),
            from,
            to,
            kind,
            label: None,
            created_at: format_iso_ms(crate::claude::live::now_ms()),
        };
        st.workspace.edges.push(edge.clone());
        st.revision += 1;
        (st.write_target(), st.workspace.clone(), edge)
    };
    persist_and_emit(app, target, &workspace);
    Ok(edge)
}

/// The longest label stored, in characters.
pub const MAX_EDGE_LABEL_CHARS: usize = 200;

/// A label as stored: every run of control characters (newlines, tabs, ...) becomes one space,
/// then it is trimmed and cut to [`MAX_EDGE_LABEL_CHARS`] characters; `None` when that leaves
/// nothing.
pub fn normalise_edge_label(label: Option<&str>) -> Option<String> {
    let raw = label?;
    let mut clean = String::with_capacity(raw.len());
    let mut in_control = false;
    for c in raw.chars() {
        if c.is_control() {
            if !in_control {
                clean.push(' ');
            }
            in_control = true;
        } else {
            clean.push(c);
            in_control = false;
        }
    }
    let cut: String = clean.trim().chars().take(MAX_EDGE_LABEL_CHARS).collect();
    let cut = cut.trim_end();
    (!cut.is_empty()).then(|| cut.to_string())
}

/// Set an edge's label (`edge_set_label`): trimmed, a blank one stored as `None`. Written and
/// emitted like any mutation; the same label again changes nothing. An unknown id is an `Err`
/// and nothing changes.
pub fn set_edge_label<R: Runtime>(app: &AppHandle<R>, id: &str, label: Option<&str>) -> Result<WorkspaceSnapshot, String> {
    let label = normalise_edge_label(label);
    let state = app.state::<AppState>();
    let (target, workspace) = {
        let mut st = state.write_workspace();
        let edge = st
            .workspace
            .edges
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| "unknown edge".to_string())?;
        if edge.label == label {
            return Ok(st.snapshot());
        }
        edge.label = label;
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    Ok(persist_and_emit(app, target, &workspace))
}

/// Delete an edge (`edge_remove`): written and emitted like any mutation. An unknown id is an
/// `Err` and nothing changes.
pub fn remove_edge<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<WorkspaceSnapshot, String> {
    let state = app.state::<AppState>();
    let (target, workspace) = {
        let mut st = state.write_workspace();
        let before = st.workspace.edges.len();
        st.workspace.edges.retain(|e| e.id != id);
        if st.workspace.edges.len() == before {
            return Err("unknown edge".to_string());
        }
        st.revision += 1;
        (st.write_target(), st.workspace.clone())
    };
    Ok(persist_and_emit(app, target, &workspace))
}

/// Store what a status pass listed of each project's linked worktrees (Story 5.4,
/// `crate::git::poll`): `Some(list)` replaces the project's known list (an empty one drops it),
/// `None` keeps it. Ids not on the canvas are ignored. When anything changed the revision is
/// bumped and `workspace://changed` emitted (a session may now sit under another branch); the
/// file is not written. Returns the snapshot, or `None` when nothing changed.
pub fn set_worktrees<R: Runtime>(app: &AppHandle<R>, updates: HashMap<String, Option<Vec<KnownWorktree>>>) -> Option<WorkspaceSnapshot> {
    let state = app.state::<AppState>();
    let snapshot = {
        let mut st = state.write_workspace();
        let mut changed = false;
        for (id, list) in updates {
            let Some(list) = list else { continue };
            if !st.workspace.projects.iter().any(|p| p.id == id) {
                continue;
            }
            let before = st.worktrees.get(&id).map(Vec::as_slice).unwrap_or_default();
            if before == list.as_slice() {
                continue;
            }
            changed = true;
            if list.is_empty() {
                st.worktrees.remove(&id);
            } else {
                st.worktrees.insert(id, list);
            }
        }
        if !changed {
            return None;
        }
        st.revision += 1;
        st.snapshot()
    };
    emit(app, &snapshot);
    Some(snapshot)
}

/// Store what the latest discovery pass found (project id → its sessions). When it differs
/// from what is stored, the revision is bumped and `workspace://changed` emitted with the new
/// children; the file is not written (discovered sessions are not persisted). Fork refs whose
/// sessions are gone are pruned too, and then the file is written. Returns the new snapshot,
/// or `None` when nothing changed.
pub fn set_discovered<R: Runtime>(app: &AppHandle<R>, discovered: HashMap<String, Vec<SessionSummary>>) -> Option<WorkspaceSnapshot> {
    let state = app.state::<AppState>();
    let (snapshot, pruned) = {
        let mut st = state.write_workspace();
        let changed = st.discovered != discovered;
        st.discovered = discovered;
        // A pass also drops the refs of forks whose sessions are gone (Story 4.4).
        let pending = state.launcher.pending_forks();
        let pruned = prune_fork_refs(&mut st, &pending);
        if !changed && !pruned {
            return None;
        }
        st.revision += 1;
        let pruned = pruned.then(|| (st.write_target(), st.workspace.clone()));
        (st.snapshot(), pruned)
    };
    match pruned {
        // The refs live in the file: written (and emitted) like any mutation.
        Some((target, workspace)) => Some(persist_and_emit(app, target, &workspace)),
        None => {
            emit(app, &snapshot);
            Some(snapshot)
        }
    }
}

/// Store which sessions the live poll places under which project (project id → its live
/// children, each list ordered by id). When that differs from what is stored -- a session
/// went live or exited, moved project, or a live-only child's name changed -- the revision is
/// bumped and `workspace://changed` emitted; the file is not written. A busy ↔ idle flip does
/// not reach here (it travels as `sessions://live`). Returns the new snapshot, or `None` when
/// nothing changed.
pub fn set_live_children<R: Runtime>(app: &AppHandle<R>, live: HashMap<String, Vec<LiveChild>>) -> Option<WorkspaceSnapshot> {
    let state = app.state::<AppState>();
    let snapshot = {
        let mut st = state.write_workspace();
        if st.live_children == live {
            return None;
        }
        st.live_children = live;
        st.revision += 1;
        st.snapshot()
    };
    emit(app, &snapshot);
    Some(snapshot)
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
pub fn folder_label(path: &str) -> String {
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
            discovered: HashMap::new(),
            live_children: HashMap::new(),
            branches: HashMap::new(),
            branch_errors: HashMap::from([("p1".to_string(), "fatal: bad".to_string())]),
            worktrees: HashMap::new(),
        };
        assert_eq!(
            serde_json::to_value(st.snapshot()).unwrap(),
            serde_json::json!({
                "path": "C:/cfg/switchboard/workspace.json",
                "revision": 3,
                "children": [],
                "branchErrors": { "p1": "fatal: bad" },
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
                show_branches: true,
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
                forked_from: Some("s0".into()),
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
            "\"showBranches\": true",
            "\"projectId\"",
            "\"worktreePath\"",
            "\"sessionId\"",
            "\"branchId\"",
            "\"forkedFrom\": \"s0\"",
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
            projects: vec![
                Project {
                    show_branches: true,
                    ..project_with("a")
                },
                project_with("b"),
            ],
            branches: vec![
                // `b` has branches off: its stored branch yields nothing.
                BranchNode {
                    id: "br-b".into(),
                    project_id: "b".into(),
                    name: "feature".into(),
                    worktree_path: Some("/p/b/.worktrees/feature".into()),
                    position: Some(Position { x: 300.0, y: 10.0 }),
                },
                // A moved branch of `a`: matched by name, its position kept.
                BranchNode {
                    id: "a:feat".into(),
                    project_id: "a".into(),
                    name: "feat".into(),
                    position: Some(Position { x: 400.0, y: 0.0 }),
                    ..BranchNode::default()
                },
                // A stored branch git no longer lists: nothing.
                BranchNode {
                    id: "a:deleted".into(),
                    project_id: "a".into(),
                    name: "deleted".into(),
                    position: Some(Position { x: 1.0, y: 1.0 }),
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
        let listed = HashMap::from([
            ("a".to_string(), vec![listed_branch("main", true), listed_branch("feat", false)]),
            ("b".to_string(), vec![listed_branch("feature", true)]),
        ]);
        let kids = children_with_branches(&ws, &HashMap::new(), &HashMap::new(), 2, &listed);
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
                ("a:main", "a", ChildKind::Branch, "main", None, None),
                ("a:feat", "a", ChildKind::Branch, "feat", None, Some(Position { x: 400.0, y: 0.0 })),
                ("stub-1-b", "b", ChildKind::Session, "session 1", Some("stub"), None),
                ("stub-2-b", "b", ChildKind::Session, "session 2", Some("stub"), None),
            ]
        );
        let main = &kids[2];
        assert_eq!(main.session, None);
        let meta = main.branch.as_ref().expect("branch facts");
        assert!(meta.head);
        assert_eq!((meta.ahead, meta.behind, meta.upstream_gone), (2, 1, false));
        assert_eq!(meta.upstream.as_deref(), Some("origin/main"));
        assert!(kids.iter().filter(|c| c.kind == ChildKind::Session).all(|c| c.branch.is_none()));
        assert!(
            children_with_branches(&ws, &HashMap::new(), &HashMap::new(), 0, &listed)
                .iter()
                .all(|c| c.kind == ChildKind::Branch),
            "no stubs unless asked"
        );
        assert!(
            children(&ws, &HashMap::new(), &HashMap::new(), 0).is_empty(),
            "no listed branches, no branch children: a stored BranchNode alone shows nothing"
        );
        assert!(children(&Workspace::default(), &HashMap::new(), &HashMap::new(), 3).is_empty(), "no projects, no children");
    }

    /// A listed branch: `main`-like ones have an upstream two ahead, one behind.
    fn listed_branch(name: &str, head: bool) -> BranchInfo {
        BranchInfo {
            name: name.into(),
            head,
            upstream: head.then(|| format!("origin/{name}")),
            ahead: if head { 2 } else { 0 },
            behind: if head { 1 } else { 0 },
            gone: false,
            committed_at: 0,
            worktree: None,
        }
    }

    /// `ide` with branches on and `names` listed (the first one current).
    fn with_listed_branches(app: &tauri::App<MockRuntime>, names: &[&str]) {
        let state = app.state::<AppState>();
        let mut st = state.write_workspace();
        st.workspace.projects.iter_mut().find(|p| p.id == "ide").unwrap().show_branches = true;
        let list = names.iter().enumerate().map(|(i, n)| listed_branch(n, i == 0)).collect();
        st.branches.insert("ide".into(), list);
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
            session: None,
            branch_id: None,
            forked_from: None,
            has_transcript: false,
            branch: None,
        };
        assert_eq!(
            serde_json::to_value(&child).unwrap(),
            serde_json::json!({
                "id": "stub-1-p", "projectId": "p", "kind": "session",
                "label": "session 1", "detail": "stub", "position": null,
                "session": null, "branchId": null, "forkedFrom": null, "hasTranscript": false,
                "branch": null
            })
        );
        let branch = ChildNode {
            id: "p:feat".into(),
            kind: ChildKind::Branch,
            label: "feat".into(),
            detail: None,
            branch: Some(BranchMeta {
                head: true,
                upstream: Some("origin/feat".into()),
                ahead: 2,
                behind: 1,
                upstream_gone: false,
                worktree: Some(WorktreeChip {
                    path: "/w/feat".into(),
                    missing: true,
                }),
            }),
            ..child.clone()
        };
        assert_eq!(
            serde_json::to_value(&branch).unwrap()["branch"],
            serde_json::json!({
                "head": true, "upstream": "origin/feat", "ahead": 2, "behind": 1,
                "upstreamGone": false, "worktree": { "path": "/w/feat", "missing": true }
            })
        );
        let real = ChildNode {
            session: Some(SessionMeta {
                started_at: "2026-10-16T10:00:00.000Z".into(),
                last_active: "2026-10-16T11:00:00.000Z".into(),
                branch: None,
                messages: 3,
            }),
            branch_id: Some("b1".into()),
            ..child
        };
        assert_eq!(
            serde_json::to_value(&real).unwrap()["session"],
            serde_json::json!({
                "startedAt": "2026-10-16T10:00:00.000Z", "lastActive": "2026-10-16T11:00:00.000Z",
                "branch": null, "messages": 3
            })
        );
        assert_eq!(serde_json::to_value(&real).unwrap()["branchId"], "b1");
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
        assert_eq!(children(&disk, &HashMap::new(), &HashMap::new(), 3)[1].position, Some(Position { x: 260.0, y: 40.0 }), "survives a reload");

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
    fn upsert_created_branch_stores_the_worktree_and_keeps_a_position() {
        let (app, _cfg, path) = app_with_ide(0);
        with_listed_branches(&app, &["main", "feat"]);
        // A new branch: created with the id the card uses, no position.
        let snapshot = upsert_created_branch(app.handle(), "ide", "auth", "/r/.worktrees/auth").unwrap();
        assert_eq!(
            snapshot.workspace.branches,
            [BranchNode {
                id: "ide:auth".into(),
                project_id: "ide".into(),
                name: "auth".into(),
                worktree_path: Some("/r/.worktrees/auth".into()),
                position: None,
            }]
        );
        assert_eq!(on_disk(&path).branches, snapshot.workspace.branches);
        // A moved branch: its ref keeps the position and gains the path.
        let branch = NodeTarget {
            kind: NodeKind::Branch,
            id: "ide:feat".into(),
        };
        move_node(app.handle(), &branch, Position { x: 5.0, y: 6.0 }).unwrap();
        let snapshot = upsert_created_branch(app.handle(), "ide", "feat", "/r/.worktrees/feat").unwrap();
        let feat = snapshot.workspace.branches.iter().find(|b| b.name == "feat").unwrap();
        assert_eq!(feat.position, Some(Position { x: 5.0, y: 6.0 }));
        assert_eq!(feat.worktree_path.as_deref(), Some("/r/.worktrees/feat"));
        assert_eq!(snapshot.workspace.branches.len(), 2, "upserted, not duplicated");
        // A re-layout keeps refs with a worktree (they are not only positions).
        let snapshot = relayout_children(app.handle(), "ide").unwrap();
        assert_eq!(snapshot.workspace.branches.len(), 2);
        let feat = snapshot.workspace.branches.iter().find(|b| b.name == "feat").unwrap();
        assert_eq!(feat.worktree_path.as_deref(), Some("/r/.worktrees/feat"), "the worktree path stays");
        assert_eq!(feat.position, None, "the position is reset");
        assert_eq!(upsert_created_branch(app.handle(), "nope", "x", "/x"), Err("unknown project".to_string()));
    }

    #[test]
    fn move_node_sets_a_branch_position_and_rejects_unknown_or_non_finite() {
        let (app, _cfg, path) = app_with_ide(1);
        with_listed_branches(&app, &["main", "feat"]);
        let branch = NodeTarget {
            kind: NodeKind::Branch,
            id: "ide:feat".into(),
        };
        // First move: a ref holding just id, project, name and position is written.
        let snapshot = move_node(app.handle(), &branch, Position { x: 5.0, y: 6.0 }).unwrap();
        assert_eq!(
            snapshot.workspace.branches,
            [BranchNode {
                id: "ide:feat".into(),
                project_id: "ide".into(),
                name: "feat".into(),
                worktree_path: None,
                position: Some(Position { x: 5.0, y: 6.0 }),
            }]
        );
        let positions: Vec<(&str, Option<Position>)> = snapshot.children.iter().map(|c| (c.id.as_str(), c.position)).collect();
        assert_eq!(
            positions,
            [("stub-1-ide", None), ("ide:main", None), ("ide:feat", Some(Position { x: 5.0, y: 6.0 }))]
        );
        assert_eq!(on_disk(&path).branches[0].position, Some(Position { x: 5.0, y: 6.0 }));
        // Second move: the same ref is updated.
        let snapshot = move_node(app.handle(), &branch, Position { x: 7.0, y: 8.0 }).unwrap();
        assert_eq!(snapshot.workspace.branches.len(), 1);
        assert_eq!(snapshot.workspace.branches[0].position, Some(Position { x: 7.0, y: 8.0 }));

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
            move_node(app.handle(), &unknown(NodeKind::Branch, "ide:nope"), Position::default()),
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
        assert_eq!(app.state::<AppState>().read_workspace().revision, 2);

        // Branches off: the branch is no child, so it cannot be moved.
        app.state::<AppState>().write_workspace().workspace.projects[0].show_branches = false;
        assert_eq!(
            move_node(app.handle(), &branch, Position::default()),
            Err("unknown branch".to_string())
        );
    }

    #[test]
    fn relayout_children_clears_positions_and_prunes_bare_refs_of_that_project_only() {
        let (app, _cfg, path) = app_with_ide(3);
        {
            let state = app.state::<AppState>();
            let mut st = state.write_workspace();
            st.workspace.projects.push(project_with("other"));
            st.workspace.projects[0].show_branches = true;
            st.branches.insert("ide".into(), vec![listed_branch("main", true)]);
            // A moved branch's ref holds only its position: it goes. One with a worktree
            // path holds more: it stays, its position cleared.
            st.workspace.branches.push(BranchNode {
                id: "ide:main".into(),
                project_id: "ide".into(),
                name: "main".into(),
                position: Some(Position { x: 9.0, y: 9.0 }),
                ..BranchNode::default()
            });
            st.workspace.branches.push(BranchNode {
                id: "ide:wt".into(),
                project_id: "ide".into(),
                name: "wt".into(),
                worktree_path: Some("/p/ide/.worktrees/wt".into()),
                position: Some(Position { x: 9.0, y: 9.0 }),
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
        let branch_refs: Vec<(&str, Option<Position>)> = snapshot.workspace.branches.iter().map(|b| (b.id.as_str(), b.position)).collect();
        assert_eq!(branch_refs, [("ide:wt", None)], "the bare branch ref is gone");
        assert_eq!(on_disk(&path).sessions.len(), 2);
        assert_eq!(rx.try_recv().expect("one event"), snapshot);

        assert_eq!(relayout_children(app.handle(), "nope"), Err("unknown project".to_string()));
        assert!(rx.try_recv().is_err());
    }

    // -- branches (Story 5.1) -----------------------------------------------------------

    #[test]
    fn set_show_branches_persists_expands_a_collapsed_card_and_off_forgets_the_list() {
        let (app, _cfg, path) = app_with_ide(0);
        let rx = listen(&app);

        let snapshot = set_show_branches(app.handle(), "ide", true).unwrap();
        let project = &snapshot.workspace.projects[0];
        assert!(project.show_branches && project.expanded, "on, and the collapsed card expands");
        assert_eq!(snapshot.revision, 1);
        let disk = on_disk(&path);
        assert!(disk.projects[0].show_branches && disk.projects[0].expanded);
        assert_eq!(rx.try_recv().expect("one event"), snapshot);
        assert!(std::fs::read_to_string(&path).unwrap().contains("\"showBranches\": true"));

        // On again while expanded: nothing.
        let same = set_show_branches(app.handle(), "ide", true).unwrap();
        assert_eq!(same.revision, 1);
        assert!(rx.try_recv().is_err());

        // A list and an error are in memory; turning off forgets both, the card stays expanded.
        {
            let state = app.state::<AppState>();
            let mut st = state.write_workspace();
            st.branches.insert("ide".into(), vec![listed_branch("main", true)]);
            st.branch_errors.insert("ide".into(), "boom".into());
        }
        let snapshot = set_show_branches(app.handle(), "ide", false).unwrap();
        assert!(!snapshot.workspace.projects[0].show_branches);
        assert!(snapshot.workspace.projects[0].expanded);
        assert!(snapshot.children.is_empty());
        assert!(snapshot.branch_errors.is_empty());
        assert!(app.state::<AppState>().read_workspace().branches.is_empty());
        assert!(!on_disk(&path).projects[0].show_branches);

        assert_eq!(set_show_branches(app.handle(), "nope", true), Err("unknown project".to_string()));
    }

    #[test]
    fn an_older_file_without_show_branches_loads_with_branches_off() {
        let ws = store::parse(r#"{ "projects": [ { "id": "p", "path": "/p", "label": "p" } ] }"#).unwrap();
        assert!(!ws.projects[0].show_branches);
    }

    #[test]
    fn set_branches_stores_lists_keeps_the_last_good_one_on_failure_and_ignores_projects_with_branches_off() {
        let (app, _cfg, path) = app_with_ide(0);
        {
            let state = app.state::<AppState>();
            let mut st = state.write_workspace();
            st.workspace.projects[0].show_branches = true;
            st.workspace.projects.push(project_with("off"));
        }
        let before = std::fs::read_to_string(&path).unwrap();
        let rx = listen(&app);
        let list = vec![listed_branch("main", true), listed_branch("feat", false)];

        let snapshot = set_branches(
            app.handle(),
            HashMap::from([
                ("ide".to_string(), Ok(Some(list.clone()))),
                ("off".to_string(), Ok(Some(list.clone()))),
            ]),
        )
        .expect("changed");
        let ids: Vec<&str> = snapshot.children.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["ide:main", "ide:feat"], "the project with branches off gets none");
        assert_eq!(rx.try_recv().expect("emitted"), snapshot);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "never written");
        assert!(!app.state::<AppState>().read_workspace().branches.contains_key("off"));

        // The same list again: nothing.
        assert!(set_branches(app.handle(), HashMap::from([("ide".to_string(), Ok(Some(list.clone())))])).is_none());
        assert!(rx.try_recv().is_err());

        // A failure keeps the last list and records the cause.
        let snapshot = set_branches(app.handle(), HashMap::from([("ide".to_string(), Err("fatal: x".to_string()))])).expect("changed");
        assert_eq!(snapshot.children.len(), 2, "last good list kept");
        assert_eq!(snapshot.branch_errors.get("ide").map(String::as_str), Some("fatal: x"));
        assert_eq!(serde_json::to_value(&snapshot).unwrap()["branchErrors"]["ide"], "fatal: x");

        // A good read clears the error; "not a repository" drops the list.
        let snapshot = set_branches(app.handle(), HashMap::from([("ide".to_string(), Ok(Some(list)))])).expect("changed");
        assert!(snapshot.branch_errors.is_empty());
        let snapshot = set_branches(app.handle(), HashMap::from([("ide".to_string(), Ok(None))])).expect("changed");
        assert!(snapshot.children.is_empty());
    }

    #[test]
    fn a_good_read_prunes_stored_branches_that_are_gone_unless_referenced_and_writes_the_file() {
        let (app, _cfg, path) = app_with_ide(0);
        {
            let state = app.state::<AppState>();
            let mut st = state.write_workspace();
            st.workspace.projects[0].show_branches = true;
            st.workspace.projects.push(project_with("other"));
            let stored = |id: &str, project: &str, name: &str| BranchNode {
                id: id.into(),
                project_id: project.into(),
                name: name.into(),
                position: Some(Position { x: 1.0, y: 1.0 }),
                ..BranchNode::default()
            };
            st.workspace.branches = vec![
                stored("ide:main", "ide", "main"),
                stored("ide:gone", "ide", "gone"),
                stored("ide:edged", "ide", "edged"),
                stored("old-id", "ide", "sessioned"),
                stored("other:gone", "other", "gone"),
            ];
            st.workspace.edges.push(edge("e", (NodeType::Branch, "ide:edged"), (NodeType::Folder, "/x")));
            st.workspace.sessions.push(SessionRef {
                session_id: "s".into(),
                project_id: "ide".into(),
                branch_id: Some("ide:sessioned".into()),
                ..SessionRef::default()
            });
        }
        let ids = |ws: &Workspace| ws.branches.iter().map(|b| b.id.clone()).collect::<Vec<_>>();

        // A failure prunes nothing.
        set_branches(app.handle(), HashMap::from([("ide".to_string(), Err("x".to_string()))]));
        assert_eq!(ids(&app.state::<AppState>().read_workspace().workspace).len(), 5);

        let snapshot = set_branches(app.handle(), HashMap::from([("ide".to_string(), Ok(Some(vec![listed_branch("main", true)])))])).unwrap();
        assert_eq!(
            ids(&snapshot.workspace),
            ["ide:main", "ide:edged", "old-id", "other:gone"],
            "gone and unreferenced: pruned; listed, referenced or another project's: kept"
        );
        assert_eq!(ids(&on_disk(&path)), ids(&snapshot.workspace), "written");

        // Re-layout keeps the referenced refs too.
        let snapshot = relayout_children(app.handle(), "ide").unwrap();
        assert_eq!(ids(&snapshot.workspace), ["ide:edged", "old-id", "other:gone"]);
    }

    #[test]
    fn remove_project_drops_edges_to_its_branch_cards_even_with_branches_off() {
        let (app, _cfg, _path) = app_with_ide(0);
        {
            let state = app.state::<AppState>();
            let mut st = state.write_workspace();
            st.workspace.projects.push(project_with("ide2"));
            st.workspace.edges.push(edge("mine", (NodeType::Branch, "ide:feat"), (NodeType::Folder, "/x")));
            st.workspace.edges.push(edge("theirs", (NodeType::Branch, "ide2:feat"), (NodeType::Folder, "/x")));
        }
        let snapshot = remove_project(app.handle(), "ide").unwrap();
        let left: Vec<&str> = snapshot.workspace.edges.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(left, ["theirs"]);
    }

    #[test]
    fn remove_project_drops_its_branch_list_and_edges_to_its_branch_cards() {
        let (app, _cfg, _path) = app_with_ide(0);
        with_listed_branches(&app, &["main"]);
        {
            let state = app.state::<AppState>();
            let mut st = state.write_workspace();
            st.branch_errors.insert("ide".into(), "x".into());
            st.workspace.edges.push(edge("e", (NodeType::Branch, "ide:main"), (NodeType::Folder, "/x")));
        }
        let snapshot = remove_project(app.handle(), "ide").unwrap();
        assert!(snapshot.workspace.edges.is_empty());
        let state = app.state::<AppState>();
        let st = state.read_workspace();
        assert!(st.branches.is_empty() && st.branch_errors.is_empty());
    }

    // -- launch defaults (Story 4.2) ---------------------------------------------------

    #[test]
    fn set_launch_defaults_stores_writes_and_emits_once_per_change() {
        let (app, _cfg, path) = app_with_ide(0);
        let rx = listen(&app);
        let chosen = LaunchDefaults {
            model: Some("opus".into()),
            effort: Some("high".into()),
            permission_mode: Some("plan".into()),
        };
        let snapshot = set_launch_defaults(app.handle(), "ide", chosen.clone()).unwrap();
        assert_eq!(snapshot.workspace.projects[0].launch_defaults, Some(chosen.clone()));
        assert_eq!(snapshot.revision, 1);
        assert_eq!(on_disk(&path).projects[0].launch_defaults, Some(chosen.clone()));
        assert_eq!(rx.try_recv().expect("workspace://changed"), snapshot);
        let on_file: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            on_file["projects"][0]["launchDefaults"],
            serde_json::json!({ "model": "opus", "effort": "high", "permissionMode": "plan" })
        );

        // The same choices again: nothing.
        assert_eq!(set_launch_defaults(app.handle(), "ide", chosen.clone()).unwrap().revision, 1);
        assert!(rx.try_recv().is_err());
        assert_eq!(set_launch_defaults(app.handle(), "nope", chosen), Err("unknown project".to_string()));
    }

    // -- fork link (Story 4.4) ---------------------------------------------------------

    #[test]
    fn set_forked_from_is_persisted_exposed_on_the_child_and_survives_a_relayout() {
        let (app, _cfg, path) = app_with_ide(0);
        let rx = listen(&app);
        let snapshot = set_forked_from(app.handle(), "ide", "fork-1", "orig").unwrap();
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.workspace.sessions[0].forked_from.as_deref(), Some("orig"));
        assert_eq!(rx.try_recv().expect("workspace://changed"), snapshot);
        let on_file: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_file["sessions"][0]["sessionId"], "fork-1");
        assert_eq!(on_file["sessions"][0]["forkedFrom"], "orig");
        // Read back (an app restart): kept.
        assert_eq!(on_disk(&path).sessions[0].forked_from.as_deref(), Some("orig"));
        // The same origin again: nothing; an unknown project: an error.
        assert_eq!(set_forked_from(app.handle(), "ide", "fork-1", "orig").unwrap().revision, 1);
        assert!(rx.try_recv().is_err());
        assert_eq!(set_forked_from(app.handle(), "nope", "x", "orig"), Err("unknown project".to_string()));
        // A relayout keeps the ref: it is not bare.
        let snapshot = relayout_children(app.handle(), "ide").unwrap();
        assert_eq!(snapshot.workspace.sessions.len(), 1);
    }

    // -- session on a branch (Story 5.3) ----------------------------------------------

    #[test]
    fn set_session_branch_is_persisted_puts_the_live_child_under_its_branch_and_keeps_the_branch_node() {
        let (app, _cfg, path) = app_with_ide(0);
        let rx = listen(&app);
        let snapshot = set_session_branch(app.handle(), "s1", "ide", "ide:worktree-spike").unwrap();
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.workspace.sessions[0].branch_id.as_deref(), Some("ide:worktree-spike"));
        assert_eq!(rx.try_recv().expect("workspace://changed"), snapshot);
        assert_eq!(on_disk(&path).sessions[0].branch_id.as_deref(), Some("ide:worktree-spike"));
        // The same again: nothing; an unknown project: an error.
        assert_eq!(set_session_branch(app.handle(), "s1", "ide", "ide:worktree-spike").unwrap().revision, 1);
        assert!(rx.try_recv().is_err());
        assert_eq!(set_session_branch(app.handle(), "s1", "nope", "x"), Err("unknown project".to_string()));

        // A live-only child takes the ref's branch when its cwd is in no stored worktree.
        let live = HashMap::from([(
            "ide".to_string(),
            vec![LiveChild {
                id: "s1".into(),
                name: Some("ide-ab12".into()),
                started_at_ms: Some(1),
                cwd: "/p/ide".into(),
                live: true,
            }],
        )]);
        set_live_children(app.handle(), live);
        let children = app.state::<AppState>().read_workspace().children();
        assert_eq!(children[0].branch_id.as_deref(), Some("ide:worktree-spike"));

        // The ref keeps a stored branch git does not list yet from being pruned.
        upsert_created_branch(app.handle(), "ide", "worktree-spike", "/p/ide/.claude/worktrees/spike").unwrap();
        set_show_branches(app.handle(), "ide", true).unwrap();
        set_branches(app.handle(), HashMap::from([("ide".to_string(), Ok(Some(Vec::new())))]));
        assert_eq!(app.state::<AppState>().read_workspace().workspace.branches.len(), 1, "referenced: kept");

        // Taken back: the ref goes when nothing else is in it.
        clear_session_branch(app.handle(), "ide", "s1");
        assert!(app.state::<AppState>().read_workspace().workspace.sessions.is_empty());
        assert!(on_disk(&path).sessions.is_empty());
        clear_session_branch(app.handle(), "ide", "s1");
    }

    #[test]
    fn a_discovery_pass_prunes_fork_refs_whose_session_is_gone_but_not_a_missing_original() {
        let (app, _cfg, path) = app_with_ide(0);
        set_forked_from(app.handle(), "ide", "fork-kept", "orig-gone").unwrap();
        set_forked_from(app.handle(), "ide", "fork-gone", "orig").unwrap();
        set_forked_from(app.handle(), "ide", "fork-starting", "orig").unwrap();
        let state = app.state::<AppState>();
        let _starting = state.launcher.begin_fork("orig", "fork-starting").unwrap();
        // `fork-kept` is discovered (its original is not: that only hides the line).
        let snapshot = set_discovered(app.handle(), discovered_of("ide", vec![summary("fork-kept", "2026-10-18T10:00:00.000Z")])).unwrap();
        let ids: Vec<&str> = snapshot.workspace.sessions.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(ids, ["fork-kept", "fork-starting"]);
        assert_eq!(on_disk(&path).sessions.len(), 2, "the pruned ref left the file");
        // A live child keeps its ref too.
        state.write_workspace().live_children = HashMap::from([("ide".to_string(), vec![live("fork-starting", None, None, false)])]);
        drop(_starting);
        assert!(set_discovered(app.handle(), discovered_of("ide", vec![summary("fork-kept", "2026-10-18T10:00:00.000Z")])).is_none(), "nothing changed");
        assert_eq!(state.read_workspace().workspace.sessions.len(), 2);
    }

    #[test]
    fn a_fork_child_carries_its_origin_and_an_older_ref_has_none() {
        let mut ws = Workspace {
            projects: vec![project_with("a")],
            ..Workspace::default()
        };
        ws.sessions.push(SessionRef {
            session_id: "fork".into(),
            project_id: "a".into(),
            forked_from: Some("orig".into()),
            ..SessionRef::default()
        });
        let found = discovered_of("a", vec![summary("orig", "2026-10-18T10:00:00.000Z")]);
        let live_fork = HashMap::from([("a".to_string(), vec![live("fork", Some("a-fork-1234"), Some(1_792_160_868_400), true)])]);
        let kids = children(&ws, &found, &live_fork, 0);
        let fork = kids.iter().find(|c| c.id == "fork").unwrap();
        assert_eq!(fork.forked_from.as_deref(), Some("orig"), "a live-only fork");
        assert!(!fork.has_transcript, "live-only: no transcript yet");
        assert!(kids.iter().find(|c| c.id == "orig").unwrap().has_transcript);
        assert_eq!(kids.iter().find(|c| c.id == "orig").unwrap().forked_from, None);
        let both = discovered_of("a", vec![summary("orig", "2026-10-18T10:00:00.000Z"), summary("fork", "2026-10-18T11:00:00.000Z")]);
        let kids = children(&ws, &both, &HashMap::new(), 0);
        assert_eq!(kids.iter().find(|c| c.id == "fork").unwrap().forked_from.as_deref(), Some("orig"), "a discovered fork");
        assert_eq!(serde_json::to_value(kids.iter().find(|c| c.id == "fork").unwrap()).unwrap()["forkedFrom"], "orig");
        let old: SessionRef = serde_json::from_value(serde_json::json!({ "sessionId": "s", "projectId": "a", "pinned": true })).unwrap();
        assert_eq!(old.forked_from, None);
        assert!(!SessionRef { forked_from: Some("x".into()), ..SessionRef::default() }.is_bare());
    }

    #[test]
    fn an_app_launched_session_is_one_node_before_and_after_its_transcript_appears() {
        let ws = Workspace {
            projects: vec![project_with("a")],
            ..Workspace::default()
        };
        let id = "3f2a9c1e-0000-4000-8000-000000000001";
        let launched = HashMap::from([("a".to_string(), vec![live(id, Some("a-3f2a"), Some(1_792_160_868_400), true)])]);
        let before = children(&ws, &HashMap::new(), &launched, 0);
        assert_eq!(before.len(), 1);
        assert_eq!((before[0].id.as_str(), before[0].label.as_str()), (id, "a-3f2a"));
        assert_eq!(before[0].session.as_ref().unwrap().messages, 0);

        let found = discovered_of("a", vec![summary(id, "2026-10-18T10:00:00.000Z")]);
        let after = children(&ws, &found, &launched, 0);
        assert_eq!(after.len(), 1, "the transcript is matched by session id: no duplicate");
        assert_eq!(after[0].id, id);
        assert_eq!(after[0].label, format!("title {id}"), "now with the transcript's facts");
        assert_eq!(after[0].session.as_ref().unwrap().messages, 2);
    }

    // -- remove_project ---------------------------------------------------------------

    fn edge(id: &str, from: (NodeType, &str), to: (NodeType, &str)) -> Edge {
        Edge {
            id: id.into(),
            from: NodeRef {
                kind: from.0,
                id: from.1.into(),
            },
            to: NodeRef {
                kind: to.0,
                id: to.1.into(),
            },
            ..Edge::default()
        }
    }

    /// `ide` (expanded, a dragged stub, a branch) and `other` with refs and edges of its own,
    /// plus edges between the two and one from `ide` to a folder.
    fn app_with_ide_and_other() -> (tauri::App<MockRuntime>, PathBuf, tempfile::TempDir) {
        let (app, cfg, path) = app_with_ide(2);
        {
            let state = app.state::<AppState>();
            let mut st = state.write_workspace();
            st.workspace.projects[0].expanded = true;
            st.workspace.projects.push(project_with("other"));
            st.workspace.branches.push(BranchNode {
                id: "br-ide".into(),
                project_id: "ide".into(),
                name: "main".into(),
                ..BranchNode::default()
            });
            st.workspace.branches.push(BranchNode {
                id: "br-other".into(),
                project_id: "other".into(),
                name: "main".into(),
                ..BranchNode::default()
            });
            st.workspace.sessions.push(SessionRef {
                session_id: "pinned-ide".into(),
                project_id: "ide".into(),
                pinned: true,
                ..SessionRef::default()
            });
            st.workspace.edges = vec![
                edge("e-ide-other", (NodeType::Project, "ide"), (NodeType::Project, "other")),
                edge("e-stub", (NodeType::Session, "stub-1-ide"), (NodeType::Project, "other")),
                edge("e-pinned", (NodeType::Project, "other"), (NodeType::Session, "pinned-ide")),
                edge("e-branch", (NodeType::Branch, "br-ide"), (NodeType::Branch, "br-other")),
                edge("e-folder", (NodeType::Project, "ide"), (NodeType::Folder, "/elsewhere")),
                edge("e-other", (NodeType::Project, "other"), (NodeType::Session, "stub-1-other")),
                edge("e-other-br", (NodeType::Branch, "br-other"), (NodeType::Folder, "/p/ide")),
            ];
        }
        let dragged = |id: &str| NodeTarget {
            kind: NodeKind::Session,
            id: id.into(),
        };
        move_node(app.handle(), &dragged("stub-2-ide"), Position { x: 260.0, y: 40.0 }).unwrap();
        move_node(app.handle(), &dragged("stub-1-other"), Position { x: -5.0, y: -5.0 }).unwrap();
        (app, path, cfg)
    }

    #[test]
    fn remove_project_drops_the_project_its_refs_branches_and_edges_writes_and_emits() {
        let (app, path, _cfg) = app_with_ide_and_other();
        let rx = listen(&app);

        let snapshot = remove_project(app.handle(), "ide").unwrap();

        assert_eq!(snapshot.revision, 3);
        assert_eq!(snapshot.workspace.projects.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["other"]);
        assert_eq!(
            snapshot.workspace.sessions.iter().map(|s| s.session_id.as_str()).collect::<Vec<_>>(),
            ["stub-1-other"],
            "the dragged stub's ref and the pinned ref are gone; the other project's survives"
        );
        assert_eq!(snapshot.workspace.branches.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), ["br-other"]);
        assert_eq!(
            snapshot.workspace.edges.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["e-other", "e-other-br"],
            "every edge touching the project, its sessions or its branches is gone; a folder edge naming its path is not a node edge"
        );
        assert!(snapshot.children.iter().all(|c| c.project_id == "other"), "{:?}", snapshot.children);
        assert_eq!(snapshot.children[0].position, Some(Position { x: -5.0, y: -5.0 }), "the other project's drag survives");

        let disk = on_disk(&path);
        assert_eq!(disk.projects, snapshot.workspace.projects);
        assert_eq!(disk.sessions, snapshot.workspace.sessions);
        assert_eq!(disk.branches, snapshot.workspace.branches);
        assert_eq!(disk.edges, snapshot.workspace.edges);
        assert_eq!(rx.try_recv().expect("one event"), snapshot);
        assert!(rx.try_recv().is_err(), "exactly one");
        assert_eq!(app.state::<AppState>().read_workspace().snapshot(), snapshot);

        // Gone means gone: a second removal is the unknown-project error.
        assert_eq!(remove_project(app.handle(), "ide"), Err("unknown project".to_string()));
    }

    #[test]
    fn remove_project_rejects_an_unknown_id_without_writing_or_emitting() {
        let (app, path, _cfg) = app_with_ide_and_other();
        let before = std::fs::read_to_string(&path).unwrap();
        let rx = listen(&app);
        assert_eq!(remove_project(app.handle(), "nope"), Err("unknown project".to_string()));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        assert!(rx.try_recv().is_err());
        assert_eq!(app.state::<AppState>().read_workspace().revision, 2);
        assert_eq!(app.state::<AppState>().read_workspace().workspace.projects.len(), 2);
    }

    #[test]
    fn remove_project_on_a_read_only_file_changes_memory_only() {
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        let path = cfg.path().join("workspace.json");
        let original = r#"{ "version": 2, "projects": [{ "id": "ide", "path": "/p/ide", "label": "ide" }, { "id": "other", "path": "/p/other", "label": "other" }] }"#;
        std::fs::write(&path, original).unwrap();
        initialise_at(app.handle(), Some(path.clone()));
        let rx = listen(&app);

        let snapshot = remove_project(app.handle(), "ide").unwrap();

        assert_eq!(snapshot.workspace.projects.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["other"]);
        assert_eq!(snapshot.revision, 1);
        let ids: Vec<&str> = snapshot.banners.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["workspace.version"]);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original, "file untouched");
        assert_eq!(rx.try_recv().expect("the in-memory change is announced"), snapshot);
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

    // -- discovered sessions (Story 3.1) ---------------------------------------------------

    fn summary(id: &str, last_active: &str) -> SessionSummary {
        SessionSummary {
            id: id.into(),
            title: format!("title {id}"),
            started_at: "2026-10-01T00:00:00.000Z".into(),
            last_active: last_active.into(),
            branch: Some("main".into()),
            messages: 2,
            cwd: Some("/p/a".into()),
        }
    }

    fn discovered_of(project: &str, list: Vec<SessionSummary>) -> HashMap<String, Vec<SessionSummary>> {
        HashMap::from([(project.to_string(), list)])
    }

    #[test]
    fn children_orders_discovered_sessions_pinned_then_newest_start_then_id_and_appends_stubs() {
        let ws = Workspace {
            projects: vec![project_with("a")],
            sessions: vec![
                SessionRef {
                    session_id: "old".into(),
                    project_id: "a".into(),
                    pinned: true,
                    label: Some("my label".into()),
                    position: Some(Position { x: 5.0, y: 6.0 }),
                    ..SessionRef::default()
                },
                // Pinned, but under another project: no effect here.
                SessionRef {
                    session_id: "mid".into(),
                    project_id: "b".into(),
                    pinned: true,
                    ..SessionRef::default()
                },
            ],
            ..Workspace::default()
        };
        let started = |id: &str, started_at: &str, last_active: &str| SessionSummary {
            started_at: started_at.into(),
            ..summary(id, last_active)
        };
        let found = discovered_of(
            "a",
            vec![
                // Started earliest but active latest: it still sorts by its start.
                started("mid", "2026-10-02T00:00:00.000Z", "2026-10-17T10:00:00.000Z"),
                started("old", "2026-10-01T00:00:00.000Z", "2026-10-01T10:00:00.000Z"),
                started("new-b", "2026-10-16T00:00:00.000Z", "2026-10-16T12:00:00.000Z"),
                started("new-a", "2026-10-16T00:00:00.000Z", "2026-10-16T11:00:00.000Z"),
            ],
        );
        let kids = children(&ws, &found, &HashMap::new(), 1);
        let ids: Vec<&str> = kids.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["old", "new-a", "new-b", "mid", "stub-1-a"]);
        assert_eq!(kids[0].label, "my label", "the ref's label wins over the title");
        assert_eq!(kids[0].position, Some(Position { x: 5.0, y: 6.0 }));
        assert_eq!(kids[1].label, "title new-a");
        assert_eq!(kids[1].detail, None);
        assert_eq!(
            kids[1].session,
            Some(SessionMeta {
                started_at: "2026-10-16T00:00:00.000Z".into(),
                last_active: "2026-10-16T11:00:00.000Z".into(),
                branch: Some("main".into()),
                messages: 2,
            })
        );
        assert_eq!(kids[4].session, None, "stubs carry no meta");
        assert!(kids.iter().all(|c| c.kind == ChildKind::Session && c.branch_id.is_none()));
        assert_eq!(children(&ws, &found, &HashMap::new(), 0).len(), 4, "no stubs unless asked");
        assert_eq!(children(&ws, &discovered_of("zzz", vec![summary("x", "")]), &HashMap::new(), 0).len(), 0, "unknown project ids are ignored");
    }

    #[test]
    fn a_session_inside_a_worktree_gets_that_branch() {
        let sep = std::path::MAIN_SEPARATOR;
        let root = if cfg!(windows) { "C:\\p\\a".to_string() } else { "/p/a".to_string() };
        let wt = format!("{root}{sep}.worktrees{sep}feature");
        let nested = format!("{wt}{sep}deeper");
        let branches = [
            BranchNode {
                id: "br-feature".into(),
                project_id: "a".into(),
                name: "feature".into(),
                worktree_path: Some(wt.clone()),
                position: None,
            },
            BranchNode {
                id: "br-deeper".into(),
                project_id: "a".into(),
                name: "deeper".into(),
                worktree_path: Some(nested.clone()),
                position: None,
            },
            BranchNode {
                id: "br-none".into(),
                project_id: "a".into(),
                name: "none".into(),
                worktree_path: None,
                position: None,
            },
        ];
        let refs: Vec<&BranchNode> = branches.iter().collect();
        assert_eq!(branch_for_cwd(&wt, &refs).as_deref(), Some("a:feature"), "the worktree itself");
        assert_eq!(branch_for_cwd(&format!("{wt}{sep}src"), &refs).as_deref(), Some("a:feature"), "inside it");
        assert_eq!(branch_for_cwd(&format!("{nested}{sep}x"), &refs).as_deref(), Some("a:deeper"), "the deepest");
        assert_eq!(branch_for_cwd(&format!("{wt}-other"), &refs), None, "a sibling with the same prefix");
        assert_eq!(branch_for_cwd(&root, &refs), None, "the project root");
        if cfg!(windows) {
            assert_eq!(branch_for_cwd(&wt.to_uppercase().replace('\\', "/"), &refs).as_deref(), Some("a:feature"));
        }

        // Through `children`: the session's cwd places it; the node stays under the project.
        let ws = Workspace {
            projects: vec![project_with("a")],
            branches: branches.to_vec(),
            ..Workspace::default()
        };
        let mut inside = summary("s-in", "2026-10-16T10:00:00.000Z");
        inside.cwd = Some(format!("{wt}{sep}src"));
        let mut outside = summary("s-out", "2026-10-16T09:00:00.000Z");
        outside.cwd = Some(root.clone());
        let kids = children(&ws, &discovered_of("a", vec![inside, outside]), &HashMap::new(), 0);
        assert_eq!(kids[0].branch_id.as_deref(), Some("a:feature"));
        assert_eq!(kids[0].project_id, "a");
        assert_eq!(kids[1].branch_id, None);
    }

    #[test]
    fn set_discovered_bumps_the_revision_and_emits_without_writing_and_only_on_change() {
        let (app, _cfg, path) = app_with_ide(0);
        let before = std::fs::read_to_string(&path).unwrap();
        let rx = listen(&app);
        let found = discovered_of("ide", vec![summary("s1", "2026-10-16T10:00:00.000Z")]);

        let snapshot = set_discovered(app.handle(), found.clone()).expect("changed");
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.children.len(), 1);
        assert_eq!(snapshot.children[0].id, "s1");
        assert_eq!(rx.try_recv().expect("one event"), snapshot);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "not written");

        assert_eq!(set_discovered(app.handle(), found.clone()), None, "same list: nothing");
        assert!(rx.try_recv().is_err());
        assert_eq!(app.state::<AppState>().read_workspace().revision, 1);

        let mut grown = found;
        grown.get_mut("ide").unwrap()[0].messages = 3;
        let snapshot = set_discovered(app.handle(), grown).expect("changed");
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.children[0].session.as_ref().unwrap().messages, 3);
        assert_eq!(rx.try_recv().expect("one event"), snapshot);
    }

    #[test]
    fn a_discovered_session_can_be_dragged_and_keeps_its_position_on_disk() {
        let (app, _cfg, path) = app_with_ide(0);
        set_discovered(
            app.handle(),
            discovered_of("ide", vec![summary("s1", "2026-10-16T10:00:00.000Z"), summary("s2", "2026-10-16T09:00:00.000Z")]),
        );
        let target = NodeTarget {
            kind: NodeKind::Session,
            id: "s2".into(),
        };
        let snapshot = move_node(app.handle(), &target, Position { x: 300.0, y: 20.0 }).unwrap();
        assert_eq!(snapshot.children[1].position, Some(Position { x: 300.0, y: 20.0 }));
        let disk = on_disk(&path);
        assert_eq!(disk.sessions.len(), 1);
        assert_eq!(disk.sessions[0].session_id, "s2");
        assert_eq!(disk.sessions[0].project_id, "ide");
        let unknown = NodeTarget {
            kind: NodeKind::Session,
            id: "gone".into(),
        };
        assert_eq!(move_node(app.handle(), &unknown, Position::default()), Err("unknown session".to_string()));
    }

    #[test]
    fn remove_project_prunes_an_edge_to_a_discovered_session_without_a_ref() {
        let (app, _cfg, _path) = app_with_ide(0);
        {
            let state = app.state::<AppState>();
            let mut st = state.write_workspace();
            st.workspace.projects.push(project_with("other"));
            st.workspace.edges = vec![
                edge("e-found", (NodeType::Project, "other"), (NodeType::Session, "found-1")),
                edge("e-keep", (NodeType::Project, "other"), (NodeType::Session, "elsewhere")),
            ];
        }
        set_discovered(app.handle(), discovered_of("ide", vec![summary("found-1", "2026-10-16T10:00:00.000Z")]));
        assert!(app.state::<AppState>().read_workspace().workspace.sessions.is_empty(), "no ref for it");

        let snapshot = remove_project(app.handle(), "ide").unwrap();
        let ids: Vec<&str> = snapshot.workspace.edges.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["e-keep"]);
    }

    #[test]
    fn a_session_in_two_dirs_keeps_the_newer_copy() {
        let (app, _cfg, _path) = app_with_ide(0);
        let rx = listen(&app);
        let older = SessionSummary {
            started_at: "2026-10-16T09:00:00.000Z".into(),
            messages: 2,
            ..summary("dup", "2026-10-16T10:00:00.000Z")
        };
        let newer = SessionSummary {
            started_at: "2026-10-16T08:00:00.000Z".into(),
            messages: 7,
            ..summary("dup", "2026-10-16T12:00:00.000Z")
        };
        for list in [vec![older.clone(), newer.clone()], vec![newer.clone(), older.clone()]] {
            let kids = children(&app.state::<AppState>().read_workspace().workspace, &discovered_of("ide", list), &HashMap::new(), 0);
            assert_eq!(kids.len(), 1);
            assert_eq!(kids[0].session.as_ref().unwrap().messages, 7, "whatever the input order");
        }
        set_discovered(app.handle(), discovered_of("ide", vec![older, newer]));
        let emitted = rx.try_recv().expect("one event");
        assert_eq!(
            emitted.children[0].session,
            Some(SessionMeta {
                started_at: "2026-10-16T08:00:00.000Z".into(),
                last_active: "2026-10-16T12:00:00.000Z".into(),
                branch: Some("main".into()),
                messages: 7,
            })
        );
    }

    #[test]
    fn set_discovered_emits_when_only_a_sessions_worktree_branch_changes() {
        let (app, _cfg, _path) = app_with_ide(0);
        let wt = if cfg!(windows) { "C:\\p\\ide\\.worktrees\\f" } else { "/p/ide/.worktrees/f" };
        app.state::<AppState>().write_workspace().workspace.branches.push(BranchNode {
            id: "br-f".into(),
            project_id: "ide".into(),
            name: "f".into(),
            worktree_path: Some(wt.into()),
            position: None,
        });
        let at_root = summary("s1", "2026-10-16T10:00:00.000Z");
        set_discovered(app.handle(), discovered_of("ide", vec![at_root.clone()]));
        let rx = listen(&app);
        let in_worktree = SessionSummary {
            cwd: Some(wt.into()),
            ..at_root
        };
        let snapshot = set_discovered(app.handle(), discovered_of("ide", vec![in_worktree])).expect("changed");
        assert_eq!(snapshot.children[0].branch_id.as_deref(), Some("ide:f"));
        assert_eq!(rx.try_recv().expect("one event"), snapshot);
    }

    // -- live sessions (Story 3.2) ---------------------------------------------------------

    fn live(id: &str, name: Option<&str>, started_at_ms: Option<i64>, live: bool) -> LiveChild {
        LiveChild {
            id: id.into(),
            name: name.map(str::to_string),
            started_at_ms,
            cwd: "/p/a".into(),
            live,
        }
    }

    #[test]
    fn live_sessions_sort_first_and_a_live_row_without_a_transcript_is_a_live_only_child() {
        let ws = Workspace {
            projects: vec![project_with("a")],
            sessions: vec![SessionRef {
                session_id: "pinned".into(),
                project_id: "a".into(),
                pinned: true,
                ..SessionRef::default()
            }],
            ..Workspace::default()
        };
        let started = |id: &str, started_at: &str| SessionSummary {
            started_at: started_at.into(),
            ..summary(id, started_at)
        };
        let found = discovered_of(
            "a",
            vec![
                started("pinned", "2026-10-01T00:00:00.000Z"),
                started("newest", "2026-10-17T00:00:00.000Z"),
                started("running", "2026-10-02T00:00:00.000Z"),
                started("gone", "2026-10-03T00:00:00.000Z"),
            ],
        );
        let live_rows = HashMap::from([(
            "a".to_string(),
            vec![
                live("gone", Some("x"), None, false),
                live("new-1", Some("ide-6e"), Some(1_792_160_868_400), true),
                live("new-2", None, Some(1_792_160_000_000), true),
                live("running", Some("ignored"), Some(1), true),
            ],
        )]);
        let kids = children(&ws, &found, &live_rows, 0);
        let ids: Vec<&str> = kids.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["new-1", "new-2", "running", "pinned", "newest", "gone"]);
        assert_eq!(kids[0].label, "ide-6e");
        assert_eq!(
            kids[0].session,
            Some(SessionMeta {
                started_at: "2026-10-16T14:27:48.400Z".into(),
                last_active: String::new(),
                branch: None,
                messages: 0,
            })
        );
        assert_eq!(kids[1].label, NEW_SESSION_LABEL);
        assert_eq!(kids[2].label, "title running", "a discovered session keeps its transcript title");
        assert_eq!(kids[2].session.as_ref().unwrap().messages, 2);
        assert_eq!(kids.iter().filter(|c| c.id == "gone").count(), 1, "one node per id");

        // An exited session that never got a transcript stays as a historic child.
        let exited = HashMap::from([("a".to_string(), vec![live("left", Some("left"), Some(1_792_160_868_400), false)])]);
        let kids = children(&ws, &found, &exited, 0);
        let ids: Vec<&str> = kids.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["pinned", "newest", "left", "gone", "running"]);

        // Discovered under another project: no second node here.
        let elsewhere_found = discovered_of("zzz", vec![summary("new-1", "2026-10-16T10:00:00.000Z")]);
        let kids = children(&ws, &elsewhere_found, &live_rows, 0);
        assert!(!kids.iter().any(|c| c.id == "new-1"));

        // A transcript under `a` whose live row maps to another project still sorts first in `a`.
        let ws2 = Workspace {
            projects: vec![project_with("a"), project_with("b")],
            ..ws.clone()
        };
        let live_in_b = HashMap::from([("b".to_string(), vec![live("gone", None, None, true)])]);
        let kids = children(&ws2, &found, &live_in_b, 0);
        assert_eq!(kids[0].id, "gone");
        assert_eq!(kids[0].project_id, "a");
        assert_eq!(kids.iter().filter(|c| c.id == "gone").count(), 1, "no live-only twin under b");

        // A row without a start: empty times.
        let no_start = HashMap::from([("a".to_string(), vec![live("bare", None, None, true)])]);
        let kids = children(&ws, &HashMap::new(), &no_start, 0);
        assert_eq!(kids[0].session.as_ref().map(|m| (m.started_at.as_str(), m.last_active.as_str())), Some(("", "")));
    }

    #[test]
    fn project_for_cwd_matches_the_project_path_then_a_branch_worktree() {
        let sep = std::path::MAIN_SEPARATOR;
        let root = if cfg!(windows) { r"C:\p\a".to_string() } else { "/p/a".to_string() };
        let wt = format!("{root}-wt{sep}feature");
        let ws = Workspace {
            projects: vec![Project {
                path: root.clone(),
                ..project_with("a")
            }],
            branches: vec![BranchNode {
                id: "br".into(),
                project_id: "a".into(),
                name: "feature".into(),
                worktree_path: Some(wt.clone()),
                position: None,
            }],
            ..Workspace::default()
        };
        assert_eq!(project_for_cwd(&ws, &root).as_deref(), Some("a"));
        if cfg!(windows) {
            assert_eq!(project_for_cwd(&ws, &root.to_uppercase()).as_deref(), Some("a"), "case-insensitive on Windows");
        }
        assert_eq!(project_for_cwd(&ws, &format!("{wt}{sep}src")).as_deref(), Some("a"), "inside a worktree");
        assert_eq!(project_for_cwd(&ws, &format!("{root}{sep}sub")), None, "a subfolder of the project is elsewhere");
        assert_eq!(project_for_cwd(&ws, "/somewhere/else"), None);

        // A real folder spelled differently (trailing separator, `.` segment) still matches.
        let dir = tempfile::tempdir().unwrap();
        let canonical = dunce::canonicalize(dir.path()).unwrap().display().to_string();
        let real = Workspace {
            projects: vec![Project {
                path: canonical.clone(),
                ..project_with("r")
            }],
            ..Workspace::default()
        };
        assert_eq!(project_for_cwd(&real, &format!("{canonical}{sep}")).as_deref(), Some("r"));
        assert_eq!(project_for_cwd(&real, &format!("{canonical}{sep}.")).as_deref(), Some("r"));
        assert_eq!(project_for_cwd(&real, &dir.path().display().to_string()).as_deref(), Some("r"));

        // A live-only child in the worktree takes that branch.
        let rows = HashMap::from([(
            "a".to_string(),
            vec![LiveChild {
                cwd: wt.clone(),
                ..live("s", None, None, true)
            }],
        )]);
        assert_eq!(children(&ws, &HashMap::new(), &rows, 0)[0].branch_id.as_deref(), Some("a:feature"));
    }

    fn known_of(project: &str, list: &[(&str, Option<&str>)]) -> KnownWorktrees {
        HashMap::from([(
            project.to_string(),
            list.iter()
                .map(|(path, branch)| KnownWorktree {
                    path: path.to_string(),
                    branch: branch.map(str::to_string),
                })
                .collect(),
        )])
    }

    #[test]
    fn worktrees_git_lists_map_sessions_and_live_rows_like_stored_ones() {
        let sep = std::path::MAIN_SEPARATOR;
        let root = if cfg!(windows) { r"C:\p\a".to_string() } else { "/p/a".to_string() };
        let claude_wt = format!("{root}{sep}.claude{sep}worktrees{sep}x");
        let detached = format!("{root}{sep}.worktrees{sep}det");
        let stored_wt = format!("{root}{sep}.worktrees{sep}feat");
        let ws = Workspace {
            projects: vec![Project {
                path: root.clone(),
                ..project_with("a")
            }],
            // A path kept as history after its worktree was removed.
            branches: vec![BranchNode {
                id: "a:feat".into(),
                project_id: "a".into(),
                name: "feat".into(),
                worktree_path: Some(stored_wt.clone()),
                position: None,
            }],
            ..Workspace::default()
        };
        let known = known_of("a", &[(&claude_wt, Some("worktree-x")), (&detached, None)]);

        // Live rows: Claude's own worktree (never stored) maps to the project, not Elsewhere.
        assert_eq!(project_for_cwd(&ws, &claude_wt), None, "without the list: Elsewhere");
        assert_eq!(project_for_cwd_in(&ws, &known, &claude_wt).as_deref(), Some("a"));
        assert_eq!(project_for_cwd_in(&ws, &known, &format!("{detached}{sep}src")).as_deref(), Some("a"), "detached too");
        assert_eq!(project_for_cwd_in(&ws, &known, &stored_wt).as_deref(), Some("a"), "a stored path still maps");
        assert_eq!(project_for_cwd_in(&ws, &known_of("gone", &[(&claude_wt, None)]), &claude_wt), None, "not on the canvas");

        // Discovery's paths: stored, then listed, once each.
        let paths = known_worktree_paths(&ws, &known, "a");
        assert_eq!(paths, [stored_wt.clone(), claude_wt.clone(), detached.clone()]);
        let twice = known_of("a", &[(&stored_wt, Some("feat"))]);
        assert_eq!(known_worktree_paths(&ws, &twice, "a"), std::slice::from_ref(&stored_wt));

        // Branch mapping: by branch name; a detached worktree gives none; the stored path counts.
        let mut in_claude = summary("s-claude", "2026-10-16T12:00:00.000Z");
        in_claude.cwd = Some(claude_wt.clone());
        let mut in_detached = summary("s-det", "2026-10-16T11:00:00.000Z");
        in_detached.cwd = Some(detached.clone());
        let mut in_removed = summary("s-feat", "2026-10-16T10:00:00.000Z");
        in_removed.cwd = Some(stored_wt.clone());
        let rows = HashMap::from([(
            "a".to_string(),
            vec![LiveChild {
                cwd: format!("{claude_wt}{sep}src"),
                ..live("live-x", None, None, true)
            }],
        )]);
        let kids = children_with_worktrees(
            &ws,
            &discovered_of("a", vec![in_claude, in_detached, in_removed]),
            &rows,
            0,
            &HashMap::new(),
            &known,
        );
        let branch = |id: &str| kids.iter().find(|c| c.id == id).unwrap().branch_id.clone();
        assert_eq!(branch("s-claude").as_deref(), Some("a:worktree-x"));
        assert_eq!(branch("live-x").as_deref(), Some("a:worktree-x"));
        assert_eq!(branch("s-det"), None);
        assert_eq!(branch("s-feat").as_deref(), Some("a:feat"));
        // Without the list only the stored path maps.
        let plain = children(&ws, &discovered_of("a", vec![summary("s", "x")]), &HashMap::new(), 0);
        assert_eq!(plain[0].branch_id, None);
    }

    #[test]
    fn two_projects_on_one_repo_share_one_rule_deepest_then_workspace_order() {
        let sep = std::path::MAIN_SEPARATOR;
        let root = if cfg!(windows) { r"C:\p\r".to_string() } else { "/p/r".to_string() };
        let sub = format!("{root}{sep}sub");
        let wt = format!("{root}{sep}.worktrees{sep}feat");
        let nested = format!("{wt}{sep}inner");
        let ws = Workspace {
            projects: vec![
                Project {
                    path: sub.clone(),
                    ..project_with("sub")
                },
                Project {
                    path: root.clone(),
                    ..project_with("top")
                },
            ],
            ..Workspace::default()
        };
        // Both projects list the same worktree: an equal depth, the first project wins (as
        // discovery's `scan` gives it), whatever the order of the map.
        let mut known = known_of("sub", &[(&wt, Some("feat"))]);
        known.extend(known_of("top", &[(&wt, Some("feat"))]));
        assert_eq!(project_for_cwd_in(&ws, &known, &format!("{wt}{sep}src")).as_deref(), Some("sub"));
        // A deeper worktree known only to the second project wins inside it.
        known.get_mut("top").unwrap().push(KnownWorktree {
            path: nested.clone(),
            branch: Some("inner".into()),
        });
        assert_eq!(project_for_cwd_in(&ws, &known, &nested).as_deref(), Some("top"));
        // A project's own folder is still matched exactly.
        assert_eq!(project_for_cwd_in(&ws, &known, &root).as_deref(), Some("top"));
        assert_eq!(project_for_cwd_in(&ws, &known, &sub).as_deref(), Some("sub"));
    }

    #[test]
    fn a_project_on_another_projects_worktree_keeps_its_own_sessions_in_discovery_and_live() {
        let sep = std::path::MAIN_SEPARATOR;
        let repo = if cfg!(windows) { r"C:\p\r".to_string() } else { "/p/r".to_string() };
        let wt = format!("{repo}{sep}.worktrees{sep}feat");
        // A = the repo (knows the worktree), B = that worktree's folder; A first on the canvas.
        let ws = Workspace {
            projects: vec![
                Project {
                    path: repo.clone(),
                    ..project_with("a")
                },
                Project {
                    path: wt.clone(),
                    ..project_with("b")
                },
            ],
            ..Workspace::default()
        };
        let known = known_of("a", &[(&wt, Some("feat"))]);
        // Live mapping: B's own folder is B's; inside it, A's worktree is the only match.
        assert_eq!(project_for_cwd_in(&ws, &known, &wt).as_deref(), Some("b"));
        assert_eq!(project_for_cwd_in(&ws, &known, &format!("{wt}{sep}src")).as_deref(), Some("a"));
        // Discovery, with the paths `sessions::refresh` builds: B's session is B's.
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(crate::claude::discover::PROJECTS_DIR).join("b");
        std::fs::create_dir_all(&dir).unwrap();
        let line = serde_json::json!({ "type": "user", "cwd": wt, "timestamp": "2026-10-16T10:00:00.000Z", "message": { "content": "x" } });
        std::fs::write(dir.join("s-b.jsonl"), format!("{line}\n")).unwrap();
        let projects: Vec<(String, Vec<String>)> = ws
            .projects
            .iter()
            .map(|p| {
                let mut paths = vec![p.path.clone()];
                paths.extend(known_worktree_paths(&ws, &known, &p.id));
                (p.id.clone(), paths)
            })
            .collect();
        let cache = std::sync::Mutex::new(crate::claude::sessions::SessionCache::default());
        let found = crate::claude::sessions::scan(home.path(), &projects, &cache).unwrap();
        assert!(!found.contains_key("a"));
        assert_eq!(found["b"].iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["s-b"]);
    }

    #[test]
    fn a_listed_worktree_on_a_stored_path_gives_the_branch_git_lists() {
        let sep = std::path::MAIN_SEPARATOR;
        let root = if cfg!(windows) { r"C:\p\a".to_string() } else { "/p/a".to_string() };
        let wt = format!("{root}{sep}.worktrees{sep}one");
        let ws = Workspace {
            projects: vec![Project {
                path: root.clone(),
                ..project_with("a")
            }],
            branches: vec![BranchNode {
                id: "a:old".into(),
                project_id: "a".into(),
                name: "old".into(),
                worktree_path: Some(wt.clone()),
                position: None,
            }],
            ..Workspace::default()
        };
        let mut session = summary("s", "2026-10-16T10:00:00.000Z");
        session.cwd = Some(wt.clone());
        let known = known_of("a", &[(&wt, Some("new"))]);
        let kids = children_with_worktrees(&ws, &discovered_of("a", vec![session]), &HashMap::new(), 0, &HashMap::new(), &known);
        assert_eq!(kids[0].branch_id.as_deref(), Some("a:new"));
    }

    #[test]
    fn set_worktrees_stores_replaces_keeps_on_none_and_emits_only_on_change() {
        let (app, _cfg, path) = app_with_ide(0);
        let rx = listen(&app);
        let before = std::fs::read_to_string(&path).unwrap();
        let list = vec![KnownWorktree {
            path: "/p/ide/.worktrees/a".into(),
            branch: Some("a".into()),
        }];
        let snapshot = set_worktrees(app.handle(), HashMap::from([("ide".to_string(), Some(list.clone())), ("nope".to_string(), Some(list.clone()))])).unwrap();
        assert_eq!(rx.try_recv().unwrap().revision, snapshot.revision);
        {
            let state = app.state::<AppState>();
            let st = state.read_workspace();
            assert_eq!(st.worktrees.get("ide"), Some(&list));
            assert!(!st.worktrees.contains_key("nope"), "not on the canvas");
        }
        assert_eq!(set_worktrees(app.handle(), HashMap::from([("ide".to_string(), Some(list.clone()))])), None, "unchanged");
        assert_eq!(set_worktrees(app.handle(), HashMap::from([("ide".to_string(), None)])), None, "a timed-out listing keeps it");
        assert!(rx.try_recv().is_err());
        assert!(set_worktrees(app.handle(), HashMap::from([("ide".to_string(), Some(Vec::new()))])).is_some());
        assert!(!app.state::<AppState>().read_workspace().worktrees.contains_key("ide"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "never written");

        // Removing the project forgets its list.
        set_worktrees(app.handle(), HashMap::from([("ide".to_string(), Some(list))]));
        remove_project(app.handle(), "ide").unwrap();
        assert!(app.state::<AppState>().read_workspace().worktrees.is_empty());
    }

    #[test]
    fn a_stored_branch_with_a_worktree_path_is_never_pruned() {
        let (app, _cfg, _path) = app_with_ide(0);
        {
            let state = app.state::<AppState>();
            let mut st = state.write_workspace();
            st.workspace.projects[0].show_branches = true;
            st.workspace.branches = vec![BranchNode {
                id: "ide:feat".into(),
                project_id: "ide".into(),
                name: "feat".into(),
                worktree_path: Some("/p/ide/.worktrees/feat".into()),
                position: None,
            }];
        }
        // The branch is deleted: git no longer lists it, the node (and its path) stays.
        let snapshot = set_branches(app.handle(), HashMap::from([("ide".to_string(), Ok(Some(vec![listed_branch("main", true)])))])).unwrap();
        assert_eq!(snapshot.workspace.branches.len(), 1);
        assert!(!snapshot.children.iter().any(|c| c.id == "ide:feat"), "no card for a deleted branch");
    }

    #[test]
    fn set_live_children_bumps_the_revision_and_emits_without_writing_and_only_on_change() {
        let (app, _cfg, path) = app_with_ide(0);
        let before = std::fs::read_to_string(&path).unwrap();
        let rx = listen(&app);
        let rows = HashMap::from([("ide".to_string(), vec![live("s1", Some("n"), Some(0), true)])]);

        let snapshot = set_live_children(app.handle(), rows.clone()).expect("changed");
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.children[0].id, "s1");
        assert_eq!(rx.try_recv().expect("one event"), snapshot);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "not written");

        assert_eq!(set_live_children(app.handle(), rows.clone()), None, "same set: nothing");
        assert!(rx.try_recv().is_err());

        let mut exited = rows;
        exited.get_mut("ide").unwrap()[0].live = false;
        let snapshot = set_live_children(app.handle(), exited).expect("changed");
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.children.len(), 1, "an exited live-only child stays");
        // A live-only child can be dragged like any session.
        let target = NodeTarget {
            kind: NodeKind::Session,
            id: "s1".into(),
        };
        assert!(move_node(app.handle(), &target, Position { x: 1.0, y: 2.0 }).is_ok());
    }

    // -- edges (Story 6.1) ------------------------------------------------------------

    fn end(kind: NodeType, id: &str) -> NodeRef {
        NodeRef { kind, id: id.into() }
    }

    #[test]
    fn edge_kind_picks_the_kind_from_the_pair_and_refuses_the_rest() {
        use NodeType::*;
        let kind = |a: NodeType, b: NodeType| edge_kind(&end(a, "x"), &end(b, "y"));
        assert_eq!(kind(Session, Project), Ok(EdgeKind::Context));
        assert_eq!(kind(Session, Branch), Ok(EdgeKind::Context));
        assert_eq!(kind(Project, Project), Ok(EdgeKind::Context), "Emils' decision: project→project is context");
        assert_eq!(kind(Project, Branch), Ok(EdgeKind::Context));
        assert_eq!(kind(Session, Session), Ok(EdgeKind::Cooperate));
        assert_eq!(kind(Project, Session), Err(REFUSE_PROJECT_TO_SESSION));
        assert_eq!(REFUSE_PROJECT_TO_SESSION, "can't link a project to a session");
        for to in [Project, Branch, Session] {
            assert_eq!(kind(Branch, to), Err(REFUSE_FROM_BRANCH));
        }
        for other in [Project, Branch, Session, Folder] {
            assert_eq!(kind(Folder, other), Err(REFUSE_FOLDER));
            assert_eq!(kind(other, Folder), Err(REFUSE_FOLDER));
        }
        for same in [Project, Session] {
            assert_eq!(edge_kind(&end(same, "a"), &end(same, "a")), Err(REFUSE_SELF));
        }
        assert_eq!(edge_kind(&end(Branch, "a"), &end(Branch, "a")), Err(REFUSE_SELF));
        assert_eq!(REFUSE_DUPLICATE, "already linked");
    }

    #[test]
    fn duplicates_match_the_same_kind_and_ends_and_either_direction_for_cooperate() {
        let mut coop = edge("c", (NodeType::Session, "b"), (NodeType::Session, "a"));
        coop.kind = EdgeKind::Cooperate;
        let ctx = edge("x", (NodeType::Project, "p"), (NodeType::Project, "q"));
        let edges = [coop, ctx];
        let s = |id: &str| end(NodeType::Session, id);
        let p = |id: &str| end(NodeType::Project, id);
        assert!(is_duplicate_edge(&edges, EdgeKind::Cooperate, &s("a"), &s("b")), "B→A exists: A→B is a duplicate");
        assert!(is_duplicate_edge(&edges, EdgeKind::Cooperate, &s("b"), &s("a")));
        assert!(!is_duplicate_edge(&edges, EdgeKind::Cooperate, &s("a"), &s("c")));
        assert!(is_duplicate_edge(&edges, EdgeKind::Context, &p("p"), &p("q")));
        assert!(!is_duplicate_edge(&edges, EdgeKind::Context, &p("q"), &p("p")), "context is directed");
    }

    /// `ide` (two stubs, branches on with `main` listed, a stored branch `br-old`, a ref
    /// `ref-only`) and `other` (two stubs).
    fn app_for_edges() -> (tauri::App<MockRuntime>, tempfile::TempDir, PathBuf) {
        let (app, cfg, path) = app_with_ide(2);
        with_listed_branches(&app, &["main"]);
        {
            let state = app.state::<AppState>();
            let mut st = state.write_workspace();
            st.workspace.projects.push(project_with("other"));
            st.workspace.branches.push(BranchNode {
                id: "br-old".into(),
                project_id: "ide".into(),
                name: "old".into(),
                ..BranchNode::default()
            });
            st.workspace.sessions.push(SessionRef {
                session_id: "ref-only".into(),
                project_id: "ide".into(),
                pinned: true,
                ..SessionRef::default()
            });
        }
        (app, cfg, path)
    }

    #[test]
    fn add_edge_creates_each_valid_pair_persists_and_emits() {
        let (app, _cfg, path) = app_for_edges();
        let rx = listen(&app);
        let cases = [
            (end(NodeType::Session, "stub-1-ide"), end(NodeType::Project, "other"), EdgeKind::Context),
            (end(NodeType::Session, "stub-1-ide"), end(NodeType::Session, "stub-1-other"), EdgeKind::Cooperate),
            (end(NodeType::Project, "ide"), end(NodeType::Project, "other"), EdgeKind::Context),
            (end(NodeType::Project, "other"), end(NodeType::Project, "ide"), EdgeKind::Context),
            (end(NodeType::Project, "other"), end(NodeType::Branch, "ide:main"), EdgeKind::Context),
            (end(NodeType::Session, "stub-2-ide"), end(NodeType::Branch, "br-old"), EdgeKind::Context),
            (end(NodeType::Session, "ref-only"), end(NodeType::Branch, "ide:old"), EdgeKind::Context),
        ];
        for (i, (from, to, kind)) in cases.iter().enumerate() {
            let edge = add_edge(app.handle(), from, to).unwrap_or_else(|e| panic!("case {i}: {e}"));
            // A stored branch named by its own id is stored by its card id.
            let stored_to = if to.id == "br-old" { end(NodeType::Branch, "ide:old") } else { to.clone() };
            assert_eq!((&edge.from, &edge.to, edge.kind, edge.label.as_deref()), (from, &stored_to, *kind, None), "case {i}");
            assert!(is_uuid_v4(&edge.id), "{}", edge.id);
            assert!(edge.created_at.ends_with('Z') && edge.created_at.len() == 24, "{}", edge.created_at);
            let snapshot = rx.try_recv().expect("workspace://changed");
            assert_eq!(snapshot.revision, i as u64 + 1);
            assert_eq!(snapshot.workspace.edges.last(), Some(&edge));
        }
        let disk = on_disk(&path);
        assert_eq!(disk.edges, app.state::<AppState>().read_workspace().workspace.edges);
        let on_file: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let first = &on_file["edges"][0];
        assert_eq!(first["from"], serde_json::json!({ "type": "session", "id": "stub-1-ide" }));
        assert_eq!(first["kind"], "context");
        assert_eq!(first["label"], serde_json::Value::Null);
        assert!(first["createdAt"].is_string());
        assert_eq!(on_file["edges"][1]["kind"], "cooperate");
    }

    #[test]
    fn add_edge_refuses_invalid_pairs_duplicates_and_unknown_ends_without_storing() {
        let (app, _cfg, path) = app_for_edges();
        let s = |id: &str| end(NodeType::Session, id);
        let p = |id: &str| end(NodeType::Project, id);
        add_edge(app.handle(), &s("stub-2-other"), &s("stub-1-ide")).unwrap();
        add_edge(app.handle(), &s("stub-1-ide"), &p("other")).unwrap();
        let before = std::fs::read_to_string(&path).unwrap();
        let rx = listen(&app);
        let refused = [
            (p("ide"), s("stub-1-ide"), "can't link a project to a session"),
            (end(NodeType::Branch, "ide:main"), p("ide"), "can't link from a branch"),
            (s("stub-1-ide"), s("stub-1-ide"), "can't link a node to itself"),
            (p("ide"), p("ide"), "can't link a node to itself"),
            (s("stub-1-ide"), end(NodeType::Folder, "/x"), "can't link a folder yet"),
            (s("stub-1-ide"), s("stub-2-other"), "already linked"),
            (s("stub-2-other"), s("stub-1-ide"), "already linked"),
            (s("stub-1-ide"), p("other"), "already linked"),
            (p("nope"), p("ide"), "unknown project"),
            (s("stub-1-ide"), p("nope"), "unknown project"),
            (s("nope"), p("ide"), "unknown session"),
            (s("stub-1-ide"), end(NodeType::Branch, "ide:gone"), "unknown branch"),
            (s("stub-1-ide"), end(NodeType::Branch, "other:main"), "unknown branch"),
        ];
        for (from, to, why) in refused {
            assert_eq!(add_edge(app.handle(), &from, &to), Err(why.to_string()), "{from:?} → {to:?}");
        }
        assert!(rx.try_recv().is_err(), "nothing emitted");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "nothing written");
        let state = app.state::<AppState>();
        let st = state.read_workspace();
        assert_eq!(st.workspace.edges.len(), 2);
        assert_eq!(st.revision, 2);
    }

    #[test]
    fn a_stored_branch_is_one_end_under_both_its_ids() {
        let (app, _cfg, _path) = app_for_edges();
        let s = end(NodeType::Session, "stub-1-ide");
        let edge = add_edge(app.handle(), &s, &end(NodeType::Branch, "br-old")).unwrap();
        assert_eq!(edge.to, end(NodeType::Branch, "ide:old"), "stored by the card id, so it is drawn");
        assert_eq!(add_edge(app.handle(), &s, &end(NodeType::Branch, "ide:old")), Err("already linked".to_string()));
        assert_eq!(add_edge(app.handle(), &s, &end(NodeType::Branch, "br-old")), Err("already linked".to_string()));
    }

    #[test]
    fn an_edge_to_a_session_without_a_ref_pins_one_and_goes_with_its_project() {
        let (app, _cfg, path) = app_with_ide(0);
        app.state::<AppState>().write_workspace().workspace.projects.push(project_with("other"));
        set_discovered(app.handle(), discovered_of("ide", vec![summary("d1", "2026-10-18T10:00:00.000Z")])).unwrap();
        let edge = add_edge(app.handle(), &end(NodeType::Session, "d1"), &end(NodeType::Project, "other")).unwrap();
        let refs = on_disk(&path).sessions;
        assert_eq!(refs.len(), 1);
        assert_eq!((refs[0].session_id.as_str(), refs[0].project_id.as_str()), ("d1", "ide"));
        // A re-layout keeps the bare ref: an edge ends on it.
        relayout_children(app.handle(), "ide").unwrap();
        assert_eq!(on_disk(&path).sessions.len(), 1);
        // The session is no longer listed; removing its project still drops the edge.
        set_discovered(app.handle(), HashMap::new()).unwrap();
        assert_eq!(on_disk(&path).edges, [edge]);
        let snapshot = remove_project(app.handle(), "ide").unwrap();
        assert!(snapshot.workspace.edges.is_empty());
        assert!(snapshot.workspace.sessions.is_empty());
    }

    #[test]
    fn set_edge_label_trims_turns_blank_into_null_and_persists() {
        let (app, _cfg, path) = app_for_edges();
        let edge = add_edge(app.handle(), &end(NodeType::Session, "stub-1-ide"), &end(NodeType::Project, "other")).unwrap();
        let rx = listen(&app);

        let snapshot = set_edge_label(app.handle(), &edge.id, Some("  API shape \n")).unwrap();
        assert_eq!(snapshot.workspace.edges[0].label.as_deref(), Some("API shape"));
        assert_eq!(snapshot.revision, 2);
        assert_eq!(rx.try_recv().expect("workspace://changed"), snapshot);
        assert_eq!(on_disk(&path).edges[0].label.as_deref(), Some("API shape"));

        // The same label again: nothing.
        assert_eq!(set_edge_label(app.handle(), &edge.id, Some("API shape")).unwrap().revision, 2);
        assert!(rx.try_recv().is_err());

        // Blank and absent both clear it.
        assert_eq!(set_edge_label(app.handle(), &edge.id, Some("   ")).unwrap().workspace.edges[0].label, None);
        assert_eq!(on_disk(&path).edges[0].label, None);
        set_edge_label(app.handle(), &edge.id, Some("x")).unwrap();
        assert_eq!(set_edge_label(app.handle(), &edge.id, None).unwrap().workspace.edges[0].label, None);

        assert_eq!(set_edge_label(app.handle(), "nope", Some("x")), Err("unknown edge".to_string()));
        assert_eq!(normalise_edge_label(Some(" a b ")), Some("a b".to_string()));
        assert_eq!(normalise_edge_label(Some("a\r\n\tb\u{7}c")), Some("a b c".to_string()), "control runs become one space");
        assert_eq!(normalise_edge_label(Some("\n\t ")), None);
        let long = "é".repeat(MAX_EDGE_LABEL_CHARS + 5);
        assert_eq!(normalise_edge_label(Some(&long)).unwrap().chars().count(), MAX_EDGE_LABEL_CHARS, "cut on a char boundary");
        assert_eq!(normalise_edge_label(Some("")), None);
        assert_eq!(normalise_edge_label(None), None);
    }

    #[test]
    fn remove_edge_deletes_persists_emits_and_rejects_an_unknown_id() {
        let (app, _cfg, path) = app_for_edges();
        let a = add_edge(app.handle(), &end(NodeType::Session, "stub-1-ide"), &end(NodeType::Project, "other")).unwrap();
        let b = add_edge(app.handle(), &end(NodeType::Project, "ide"), &end(NodeType::Project, "other")).unwrap();
        let rx = listen(&app);
        let snapshot = remove_edge(app.handle(), &a.id).unwrap();
        assert_eq!(snapshot.workspace.edges, std::slice::from_ref(&b));
        assert_eq!(rx.try_recv().expect("workspace://changed"), snapshot);
        assert_eq!(on_disk(&path).edges, [b]);
        let before = std::fs::read_to_string(&path).unwrap();
        assert_eq!(remove_edge(app.handle(), &a.id), Err("unknown edge".to_string()));
        assert!(rx.try_recv().is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn edges_with_their_labels_survive_a_restart_and_a_hidden_end_keeps_its_edge() {
        let (app, _cfg, path) = app_for_edges();
        let edge = add_edge(app.handle(), &end(NodeType::Session, "stub-1-ide"), &end(NodeType::Session, "stub-2-ide")).unwrap();
        set_edge_label(app.handle(), &edge.id, Some("API shape")).unwrap();
        // Collapsing the project hides both ends; the edge stays stored.
        set_expanded(app.handle(), "ide", false).unwrap();
        assert_eq!(on_disk(&path).edges.len(), 1);

        initialise_at(app.handle(), Some(path.clone()));
        let state = app.state::<AppState>();
        let st = state.read_workspace();
        assert_eq!(st.workspace.edges.len(), 1);
        let loaded = &st.workspace.edges[0];
        assert_eq!(
            (loaded.id.as_str(), loaded.kind, loaded.label.as_deref()),
            (edge.id.as_str(), EdgeKind::Cooperate, Some("API shape"))
        );
        assert_eq!(loaded.created_at, edge.created_at);
    }

    #[test]
    fn edge_mutations_respect_the_read_only_guard() {
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        let path = cfg.path().join("workspace.json");
        let original = r#"{ "version": 2, "projects": [{ "id": "a", "path": "/p/a", "label": "a" }, { "id": "b", "path": "/p/b", "label": "b" }] }"#;
        std::fs::write(&path, original).unwrap();
        initialise_at(app.handle(), Some(path.clone()));
        let edge = add_edge(app.handle(), &end(NodeType::Project, "a"), &end(NodeType::Project, "b")).unwrap();
        set_edge_label(app.handle(), &edge.id, Some("x")).unwrap();
        let snapshot = remove_edge(app.handle(), &edge.id).unwrap();
        assert_eq!(snapshot.revision, 3);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original, "file untouched");
    }
}
