// The one place the frontend calls into Rust. Every command gets a typed
// wrapper here; nothing else imports `@tauri-apps/api/core` or `/event` directly.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/** Mirrors `ipc::AppInfo` in `src-tauri/src/ipc/mod.rs`. */
export type AppInfo = {
  name: string;
  version: string;
};

/** Mirrors `settings::Settings` (the on-disk `settings.json` schema, version 1). */
export type Settings = {
  version: number;
  claude: { path: string | null };
  git: { path: string | null };
  defaults: {
    model: string | null;
    effort: string | null;
    permission_mode: string | null;
  };
  worktrees_root: string | null;
  external_editor: string | null;
  shell: string | null;
  theme: string;
  poll: { agents_ms: number; git_ms: number };
};

/** Mirrors `settings::BinaryStatus`. */
export type BinaryStatus = "pending" | "found" | "missing" | "configured_missing" | "version_failed";

/** Mirrors `settings::Binary`. */
export type Binary = {
  name: string;
  path: string | null;
  version: string | null;
  status: BinaryStatus;
  /** True when the path came from `settings.json` rather than detection. */
  configured: boolean;
};

/** Mirrors `settings::Banner`: an ambient notice derived from state, gone when the cause is. */
export type Banner = {
  id: string;
  text: string;
};

/** Mirrors `settings::Snapshot`: what `settings_get` returns and `settings://changed` carries. */
export type SettingsSnapshot = {
  /** Absolute path of `settings.json`; `null` when no config dir could be determined. */
  path: string | null;
  settings: Settings;
  binaries: { claude: Binary; git: Binary };
  banners: Banner[];
};

/** Event name Rust emits with a fresh `SettingsSnapshot` on every change. */
export const SETTINGS_CHANGED_EVENT = "settings://changed";

// --- workspace (`src-tauri/src/graph/mod.rs`, architecture §5.1) ---------------------------

/** Mirrors `graph::Viewport`: the canvas pan offset in pixels and zoom factor. */
export type Viewport = { x: number; y: number; zoom: number };

/** Mirrors `graph::Position`: a node position in canvas (unzoomed) coordinates. */
export type Position = { x: number; y: number };

/** Mirrors `graph::LaunchDefaults`; `null` leaves the choice to `settings.json`. */
export type LaunchDefaults = {
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
};

/** Mirrors `graph::Project` (Story 2.2 fills these in). */
export type Project = {
  id: string;
  path: string;
  label: string;
  position: Position;
  expanded: boolean;
  color: string | null;
  launchDefaults: LaunchDefaults | null;
};

/** Mirrors `graph::BranchNode` (Epic 5). */
export type BranchNode = {
  id: string;
  projectId: string;
  name: string;
  worktreePath: string | null;
  position: Position | null;
};

/** Mirrors `graph::SessionRef` (Epic 3). */
export type SessionRef = {
  sessionId: string;
  projectId: string;
  branchId: string | null;
  label: string | null;
  pinned: boolean;
  position: Position | null;
};

/** Mirrors `graph::NodeRef`; `folder` is an ad-hoc path target that is not a node. */
export type NodeRef = { type: "project" | "branch" | "session" | "folder"; id: string };

/** Mirrors `graph::Edge` (Epic 6). */
export type Edge = {
  id: string;
  from: NodeRef;
  to: NodeRef;
  kind: "context" | "cooperate";
  label: string | null;
  createdAt: string;
};

/** Mirrors `graph::Workspace`: the on-disk `workspace.json` schema, version 1. */
export type Workspace = {
  version: number;
  viewport: Viewport;
  projects: Project[];
  branches: BranchNode[];
  sessions: SessionRef[];
  edges: Edge[];
  defaults: LaunchDefaults;
};

/** Mirrors `graph::ChildKind`. */
export type ChildKind = "session" | "branch";

/**
 * Mirrors `graph::SessionMeta`: what a discovered session's card shows besides its title.
 * Times are ISO 8601 UTC (`2026-10-16T14:33:02.138Z`).
 */
export type SessionMeta = {
  startedAt: string;
  lastActive: string;
  /** The latest `gitBranch` the transcript names; `null` when none. */
  branch: string | null;
  /** Prompts plus assistant replies, sidechains not counted. */
  messages: number;
};

/**
 * Mirrors `graph::ChildNode`: a child of a project as the canvas lays it out, derived by Rust
 * from the discovered sessions, `sessions` and `branches` (or the stub source). `position` is
 * relative to the parent card's top-left and `null` while the child sits in its column slot.
 */
export type ChildNode = {
  id: string;
  projectId: string;
  kind: ChildKind;
  label: string;
  detail: string | null;
  position: Position | null;
  /** A discovered session's facts; `null` for stubs and branches. */
  session: SessionMeta | null;
  /** The branch whose worktree holds the session's `cwd`; `null` under the project root. */
  branchId: string | null;
};

/** Mirrors `graph::NodeKind`: the node types a position can be written for. */
export type NodeKind = "project" | "session" | "branch";

/** Mirrors `graph::NodeTarget`: a node named by kind and id. */
export type NodeTarget = { kind: NodeKind; id: string };

/** Mirrors `graph::WorkspaceSnapshot`: what `workspace_get` returns and `workspace://changed` carries. */
export type WorkspaceSnapshot = {
  /** Absolute path of `workspace.json`; `null` when no config dir could be determined. */
  path: string | null;
  workspace: Workspace;
  banners: Banner[];
  /** Mutation counter for this session; a reply older than the stored snapshot is dropped. */
  revision: number;
  /** Every project's children, collapsed ones too, in layout order. */
  children: ChildNode[];
};

/** Event name Rust emits with a fresh `WorkspaceSnapshot` on every change. */
export const WORKSPACE_CHANGED_EVENT = "workspace://changed";

/** Mirrors `graph::AddProjectsResult`: what `workspace_add_projects` replies. */
export type AddProjectsResult = {
  snapshot: WorkspaceSnapshot;
  /** Ids of the projects this call created, in input order. */
  added: string[];
  /** Ids already on the canvas for a given path (highlighted instead of re-added). */
  existing: string[];
  /** Input paths that were not directories, ignored. */
  skipped: string[];
};

// --- git status (`src-tauri/src/git/`) -----------------------------------------------------

/** Mirrors `git::RepoStatus`: the facts a project card shows about a repository. */
export type RepoStatus = {
  /** Branch name, or the short commit when `detached`. */
  branch: string;
  detached: boolean;
  /** Changed entries: staged, unstaged, unmerged and untracked. */
  dirty: number;
  ahead: number;
  behind: number;
};

/** Mirrors `git::ProjectStatus` (internally tagged on `kind`). */
export type ProjectStatus =
  | ({ kind: "repo" } & RepoStatus)
  | { kind: "not_repo" }
  | { kind: "missing" }
  /** `git` could not be started. */
  | { kind: "git_unavailable" }
  /** `git` ran but failed; `message` is its first stderr line. */
  | { kind: "git_error"; message: string };

/** Project id → status, as `projects_status_get` returns and `projects://status` carries. */
export type ProjectStatusMap = Record<string, ProjectStatus>;

/** Event name Rust emits with the whole status map whenever any project's status changes. */
export const PROJECTS_STATUS_EVENT = "projects://status";

// --- Claude project discovery (`src-tauri/src/claude/discover.rs`) --------------------------

/** Mirrors `claude::ClaudeProject`: one directory under `~/.claude/projects`. */
export type ClaudeProject = {
  /** The directory name (`B--projects-ide`). */
  dir: string;
  /** The working directory it stands for (canonical when it exists). */
  cwd: string;
  /** Whether `cwd` is a directory on this machine right now. */
  exists: boolean;
  /** Number of transcripts in the directory. */
  sessions: number;
  /** Already a project node on the canvas (decided by Rust with its own path comparison). */
  on_canvas: boolean;
};

// --- live sessions (`src-tauri/src/claude/live.rs`, Story 3.2) -----------------------------

/**
 * Mirrors `live::SessionState` (internally tagged on `kind`). The poll gives `busy`, `idle`
 * and `other` (any other status, kept verbatim in `raw`); `exited` is a session that left the
 * poll this run. `waiting` and `finished` come only from hooks (Story 4.3).
 */
export type SessionState =
  | { kind: "busy" }
  | { kind: "idle" }
  | { kind: "waiting" }
  | { kind: "finished" }
  | { kind: "exited" }
  | { kind: "other"; raw: string };

/** Mirrors `live::LiveSession`: one session the poll has seen this run. */
export type LiveSession = {
  state: SessionState;
  /** Where the state came from; only `poll` until Epic 4. */
  source: "poll";
  pid: number | null;
  kind: string | null;
  name: string | null;
  /** The project whose folder is the session's `cwd`; `null` for an Elsewhere row. */
  project_id: string | null;
  cwd: string;
  /** Milliseconds since the epoch. */
  started_at: number | null;
};

/** Mirrors `live::ElsewhereRow`: a live session in a folder that is not on the canvas. */
export type ElsewhereRow = {
  session_id: string;
  state: SessionState;
  name: string | null;
  cwd: string;
  started_at: number | null;
};

/** Mirrors `live::LiveSnapshot`: what `live_sessions_get` returns and `sessions://live` carries. */
export type LiveSnapshot = {
  /** Every session seen this run, by id; exited ones have state `exited`. */
  sessions: Record<string, LiveSession>;
  /** Live sessions in no project's folder, newest first. */
  elsewhere: ElsewhereRow[];
  /** Why live status is unavailable, after three failed polls in a row; `null` otherwise. */
  banner: string | null;
};

/** Event name Rust emits with a fresh `LiveSnapshot` whenever it changes. */
export const LIVE_SESSIONS_EVENT = "sessions://live";

/** Return type of every command, keyed by command name. */
type Commands = {
  app_info: AppInfo;
  settings_get: SettingsSnapshot;
  settings_reveal: void;
  binaries_redetect: SettingsSnapshot;
  workspace_get: WorkspaceSnapshot;
  workspace_set_viewport: WorkspaceSnapshot;
  project_pick_folder: string | null;
  workspace_add_projects: AddProjectsResult;
  workspace_set_expanded: WorkspaceSnapshot;
  workspace_move_node: WorkspaceSnapshot;
  workspace_relayout_children: WorkspaceSnapshot;
  claude_projects_list: ClaudeProject[];
  projects_status_get: ProjectStatusMap;
  live_sessions_get: LiveSnapshot;
  workspace_remove_project: WorkspaceSnapshot;
  project_open_editor: void;
  project_open_folder: void;
  project_reveal_claude_dir: void;
  app_quit: void;
};

declare global {
  interface Window {
    /** Injected by Tauri into its webview; absent in a plain browser. */
    __TAURI_INTERNALS__?: unknown;
  }
}

/** True when the UI is running inside the Tauri webview rather than a plain browser. */
export function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

export class NoTauriRuntimeError extends Error {
  constructor(command: string) {
    super(`no Tauri runtime: cannot invoke "${command}"`);
    this.name = "NoTauriRuntimeError";
  }
}

async function call<K extends keyof Commands>(
  command: K,
  args?: Record<string, unknown>,
): Promise<Commands[K]> {
  if (!hasTauriRuntime()) {
    throw new NoTauriRuntimeError(command);
  }
  return invoke<Commands[K]>(command, args);
}

/** `ipc::app_info` -- the Cargo package name and version. */
export function appInfo(): Promise<AppInfo> {
  return call("app_info");
}

/** `ipc::settings_get` -- the current snapshot (path, settings, binaries, banners). */
export function settingsGet(): Promise<SettingsSnapshot> {
  return call("settings_get");
}

/** `ipc::settings_reveal` -- open the config folder with `settings.json` selected. */
export function settingsReveal(): Promise<void> {
  return call("settings_reveal");
}

/** `ipc::binaries_redetect` -- re-run `claude`/`git` detection; resolves with the new snapshot. */
export function binariesRedetect(): Promise<SettingsSnapshot> {
  return call("binaries_redetect");
}

/** `ipc::workspace_get` -- the current snapshot (path, workspace, banners). */
export function workspaceGet(): Promise<WorkspaceSnapshot> {
  return call("workspace_get");
}

/**
 * `ipc::workspace_set_viewport` -- persist the viewport at the end of a pan/zoom gesture or
 * Fit view. Rust writes `workspace.json` and emits `workspace://changed`; resolves with the
 * new snapshot.
 */
export function workspaceSetViewport(viewport: Viewport): Promise<WorkspaceSnapshot> {
  return call("workspace_set_viewport", { viewport });
}

/**
 * `ipc::project_pick_folder` -- open the native folder picker. Resolves with the chosen
 * folder, or `null` when the picker was cancelled.
 */
export function projectPickFolder(): Promise<string | null> {
  return call("project_pick_folder");
}

/**
 * `ipc::workspace_add_projects` -- add folders as project nodes at `position` (fanned out
 * when several). Rejects with `"not a directory"` when nothing given is a folder. Rust writes
 * `workspace.json`, emits `workspace://changed` and refreshes git status for the new nodes.
 */
export function workspaceAddProjects(paths: string[], position: Position): Promise<AddProjectsResult> {
  return call("workspace_add_projects", { paths, position });
}

/**
 * `ipc::workspace_set_expanded` -- expand or collapse a project. Rust persists `expanded`
 * and emits `workspace://changed`; rejects with `"unknown project"`.
 */
export function workspaceSetExpanded(projectId: string, expanded: boolean): Promise<WorkspaceSnapshot> {
  return call("workspace_set_expanded", { projectId, expanded });
}

/**
 * `ipc::workspace_move_node` -- store where a node was dropped: absolute for a project,
 * relative to the parent card for a child. Rejects for a non-finite position or an unknown node.
 */
export function workspaceMoveNode(target: NodeTarget, position: Position): Promise<WorkspaceSnapshot> {
  return call("workspace_move_node", { target, position });
}

/**
 * `ipc::workspace_relayout_children` -- put a project's children back into their column
 * (clears stored child positions, prunes bare session refs). Rejects with `"unknown project"`.
 */
export function workspaceRelayoutChildren(projectId: string): Promise<WorkspaceSnapshot> {
  return call("workspace_relayout_children", { projectId });
}

/**
 * `ipc::workspace_remove_project` -- take a project off the canvas with its session refs,
 * branches, edges and live status. Rust writes `workspace.json`, emits `workspace://changed`
 * and `projects://status`; rejects with `"unknown project"`.
 */
export function workspaceRemoveProject(projectId: string): Promise<WorkspaceSnapshot> {
  return call("workspace_remove_project", { projectId });
}

/**
 * `ipc::project_open_editor` -- launch the program named by the first token of
 * `settings.external_editor` with the project folder as its only argument, detached.
 * Rejects with the notice to show: no editor configured, program not found, spawn failure.
 */
export function projectOpenEditor(projectId: string): Promise<void> {
  return call("project_open_editor", { projectId });
}

/** `ipc::project_open_folder` -- open the project folder in the OS file manager. Rejects with the cause. */
export function projectOpenFolder(projectId: string): Promise<void> {
  return call("project_open_folder", { projectId });
}

/**
 * `ipc::project_reveal_claude_dir` -- open the `~/.claude/projects/<dir>` directory whose cwd
 * is the project folder. Rejects with the notice to show when there is none.
 */
export function projectRevealClaudeDir(projectId: string): Promise<void> {
  return call("project_reveal_claude_dir", { projectId });
}

/** `ipc::claude_projects_list` -- Claude Code's known projects (read-only), newest first. */
export function claudeProjectsList(): Promise<ClaudeProject[]> {
  return call("claude_projects_list");
}

/** `ipc::projects_status_get` -- the poller's last git status per project id. */
export function projectsStatusGet(): Promise<ProjectStatusMap> {
  return call("projects_status_get");
}

/** `ipc::live_sessions_get` -- the live-session poller's last snapshot. */
export function liveSessionsGet(): Promise<LiveSnapshot> {
  return call("live_sessions_get");
}

/** `ipc::app_quit` -- exit the app with status 0. Resolves only if the exit did not happen. */
export function appQuit(): Promise<void> {
  return call("app_quit");
}

/**
 * Subscribe to `settings://changed`. Resolves with the unlisten function; without a Tauri
 * runtime it resolves with a no-op so callers need no branch.
 */
export async function onSettingsChanged(
  callback: (snapshot: SettingsSnapshot) => void,
): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<SettingsSnapshot>(SETTINGS_CHANGED_EVENT, (event) => callback(event.payload));
}

/** Subscribe to `workspace://changed`; same contract as {@link onSettingsChanged}. */
export async function onWorkspaceChanged(
  callback: (snapshot: WorkspaceSnapshot) => void,
): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<WorkspaceSnapshot>(WORKSPACE_CHANGED_EVENT, (event) => callback(event.payload));
}

/** Subscribe to `projects://status`; same contract as {@link onSettingsChanged}. */
export async function onProjectsStatus(callback: (statuses: ProjectStatusMap) => void): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<ProjectStatusMap>(PROJECTS_STATUS_EVENT, (event) => callback(event.payload));
}

/** Subscribe to `sessions://live`; same contract as {@link onSettingsChanged}. */
export async function onLiveSessions(callback: (snapshot: LiveSnapshot) => void): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<LiveSnapshot>(LIVE_SESSIONS_EVENT, (event) => callback(event.payload));
}

/**
 * Something the OS dropped on the webview: the paths and where, in physical pixels relative
 * to the webview's top-left corner (divide by `devicePixelRatio` for CSS pixels).
 */
export type FileDrop = {
  paths: string[];
  position: { x: number; y: number };
};

/**
 * Subscribe to Tauri's native drag-and-drop and get the `drop` events only (enter/over/leave
 * are not needed: nothing is drawn while dragging). Same contract as {@link onSettingsChanged}.
 * Tauri's native drop replaces HTML5 drag-and-drop in the webview (and disables it on Windows).
 */
export async function onFileDrop(callback: (drop: FileDrop) => void): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      const { paths, position } = event.payload;
      callback({ paths, position: { x: position.x, y: position.y } });
    }
  });
}
