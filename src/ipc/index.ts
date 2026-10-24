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
  /** Which attention states send an OS toast while the window is unfocused (Story 3.3). */
  notifications: { finished: boolean; waiting: boolean };
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
  /** The "branches" toggle (Story 5.1): its local branches are listed as branch children. */
  showBranches: boolean;
};

/**
 * Mirrors `graph::BranchNode` (Epic 5): a branch the operator moved (Story 5.1, id
 * `<projectId>:<name>`) or created; matched to the discovered branch by project and name.
 */
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
  /** The session this one was forked from (Story 4.4); `null` for the rest. */
  forkedFrom: string | null;
};

/** Mirrors `graph::NodeRef`; `folder` is an ad-hoc path target that is not a node. */
export type NodeRef = { type: "project" | "branch" | "session" | "folder"; id: string };

/** Mirrors `graph::EdgeKind`: `context` (dashed) or `cooperate` (a double line, undirected). */
export type EdgeKind = "context" | "cooperate";

/** Mirrors `graph::Edge` (Epic 6). */
export type Edge = {
  id: string;
  from: NodeRef;
  to: NodeRef;
  kind: EdgeKind;
  label: string | null;
  createdAt: string;
};

/** Mirrors `live_edges::EdgeState` (Story 6.3; `notified` is a cooperate side's, Story 6.4). */
export type EdgeLiveState = "pending" | "applied" | "notified" | "failed";

/**
 * Mirrors `live_edges::EdgeLive`: what a context edge from a running session does now, or (Story
 * 6.4) one side of a cooperate edge. Runtime only; after an app restart no edge has one.
 */
export type EdgeLive = {
  state: EdgeLiveState;
  /** Why, or what it waits for (`waiting for idle`, `no worktree`, Claude's stdout, ...). */
  detail: string | null;
  /** The edge the entry belongs to. */
  edgeId: string;
  /** The session the edge runs from; a cooperate side's session. */
  sessionId: string;
  /** The folder the edge grants, once resolved. */
  path: string | null;
};

/**
 * What `edges_live_get` returns and `edges://live` carries: every context edge's live state by
 * edge id, and every cooperate side's by `<edgeId>#<sessionId>` (`live_edges::side_key`).
 */
export type EdgesLiveMap = Record<string, EdgeLive>;

/** Event name Rust emits with the whole `EdgesLiveMap` whenever an edge's live state changes. */
export const EDGES_LIVE_EVENT = "edges://live";

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
  /** The session this one was forked from (its ref's `forkedFrom`, Story 4.4); `null` otherwise. */
  forkedFrom: string | null;
  /** Discovered from its transcript (Resume and Fork need one); false for live-only sessions, stubs, branches. */
  hasTranscript: boolean;
  /** A discovered branch's facts (Story 5.1); `null` for sessions and stubs. */
  branch: BranchMeta | null;
};

/** Mirrors `git::WorktreeChip`: the linked worktree holding a branch. */
export type WorktreeChip = {
  /** Canonical when the folder exists; as git printed it otherwise. */
  path: string;
  /** The folder is gone (git reports it prunable, or it no longer exists). */
  missing: boolean;
};

/** Mirrors `graph::BranchMeta`: what a branch card shows besides its name (Story 5.1). */
export type BranchMeta = {
  /** Checked out in the project's own checkout: the card's `*`. */
  head: boolean;
  /** The configured upstream; `null` for a local-only branch (no counts). */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The upstream is configured but its ref is missing. */
  upstreamGone: boolean;
  /** The linked worktree holding the branch (never the project's own checkout). */
  worktree: WorktreeChip | null;
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
  /** Why a project's last branch read failed (Story 5.1), by project id; the last list is kept. */
  branchErrors: Record<string, string>;
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
 * poll this run; `finished` is a session the poll saw go busy → idle (Story 3.3). `waiting`
 * comes only from hooks (Story 4.3). `starting` is a session the app just launched, before its
 * first output or poll row (Story 4.2).
 */
export type SessionState =
  | { kind: "starting" }
  | { kind: "busy" }
  | { kind: "idle" }
  | { kind: "waiting" }
  | { kind: "finished" }
  | { kind: "exited" }
  | { kind: "other"; raw: string };

/** Mirrors `live::LiveSession`: one session the poll has seen this run. */
export type LiveSession = {
  state: SessionState;
  /**
   * Where the state came from: the poll, the operator's acknowledgement (`ack`), or the app
   * itself (`app`: a launch, its first output, its exit; Story 4.2), or a Claude Code hook
   * (`hook`, Story 4.3; also the keypress that answers a prompt in the session's terminal).
   */
  source: "poll" | "ack" | "app" | "hook";
  pid: number | null;
  kind: string | null;
  name: string | null;
  /** The project whose folder is the session's `cwd`; `null` for an Elsewhere row. */
  project_id: string | null;
  cwd: string;
  /** Milliseconds since the epoch. */
  started_at: number | null;
  /** When it entered `finished` / `waiting` (ms since the epoch); `null` in other states. */
  attention_since: number | null;
  /** A `finished` session's last assistant line (the `Stop` hook), cut to 200 chars; `null` otherwise. */
  last_line: string | null;
  /** A `waiting` session's reason (the hook's message), the card's tooltip; `null` otherwise. */
  detail: string | null;
};

/** Mirrors `hooks::DiagnosticsSnapshot`: what `diagnostics_get` returns (Settings → Diagnostics). */
export type DiagnosticsSnapshot = {
  /** `127.0.0.1:<port>` while the hooks endpoint is up. */
  endpoint: string | null;
  /** Why the endpoint is not up, when it failed. */
  endpoint_error: string | null;
  hook_events: number;
  refused: number;
  session_mismatches: number;
  poll_overrides: number;
  /** `/mcp` requests refused with a 401 (Story 7.1). */
  mcp_refused: number;
  /** The last 20 of them, newest first. */
  mcp_refusals: McpRefusal[];
};

/** Mirrors `hooks::McpRefusal`: one refused `/mcp` request (never any part of the token). */
export type McpRefusal = {
  /** Milliseconds since the epoch. */
  at: number;
  path: string;
  /** `missing token` or `unknown token`. */
  reason: string;
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

// --- toasts (`src-tauri/src/notify.rs`, Story 3.3) ------------------------------------------

/** Mirrors `notify::RevealRequest`: the session of a toast the operator clicked. */
export type RevealRequest = {
  session_id: string;
  /** The session's project; `null` for an Elsewhere session. */
  project_id: string | null;
};

/** Event name Rust emits with a `RevealRequest` when a toast was clicked (the window is already focused). */
export const NOTIFY_REVEAL_EVENT = "notify://reveal";

// --- terminals (`src-tauri/src/pty/mod.rs`, Story 4.1) --------------------------------------

/** Mirrors `pty::TermKind`: a plain shell, or a Claude session the app launched (never restarted). */
export type TermKind = "plain" | "session";

/** Mirrors `pty::TermInfo`: one terminal and whether its child still runs. */
export type TermInfo = {
  id: string;
  kind: TermKind;
  project_id: string;
  /** The project's label (plain), or the session's name (session). */
  title: string;
  cwd: string;
  /** `null` while the child runs; its exit code after (`-1`: it never started). */
  exited: number | null;
  /** `could not start <shell>: <cause>` when the shell could not be started. */
  error: string | null;
  /** The PTY's size; a view made while hidden is made at it. */
  cols: number;
  rows: number;
  /** A Stop is under way (Story 4.4): from the Stop until the child exits. */
  stopping: boolean;
};

/**
 * Mirrors `pty::DataPayload`: coalesced output (UTF-8 text) of one terminal. `offset` (added
 * to the spec's `{ id, data }`) is the terminal's output byte count at the end of `data`, the
 * count `term_buffer` reports too, so a replayed view drops what it already has.
 */
export type TermData = { id: string; data: string; offset: number };

/** Mirrors `pty::TermBuffer`: the kept output and the byte offset it ends at. */
export type TermBuffer = { data: string; offset: number };

/** Mirrors `pty::ExitPayload`: a terminal's child exited. */
export type TermExit = { id: string; code: number | null };

/** Event name Rust emits with a `TermData`, at most once per 8 ms per terminal. */
export const TERM_DATA_EVENT = "term://data";

/** Event name Rust emits with a `TermExit` when a terminal's child exits. */
export const TERM_EXIT_EVENT = "term://exit";

/** Mirrors `windows::PoppedPayload`: terminal `id` is in pop-out window `label`, or back in the pane (`null`). */
export type TermPopped = { id: string; label: string | null };

/** Mirrors `pty::ClosedPayload`: terminal `id` was closed (`term_close`) and is gone. */
export type TermClosed = { id: string };

/** Event name Rust emits with a `TermPopped` whenever a terminal pops out or returns (Story 4.5). */
export const TERM_POPPED_EVENT = "term://popped";

/** Event name Rust emits with a `TermInfo` when a terminal is restarted (every window learns it runs again). */
export const TERM_INFO_EVENT = "term://info";

/** Event name Rust emits with a `TermClosed` when a terminal is closed (every window forgets it). */
export const TERM_CLOSED_EVENT = "term://closed";

// --- launching sessions (`src-tauri/src/claude/launch.rs`, Story 4.2) ------------------------

/**
 * Mirrors `launch::LaunchRequest`: what the launch sheet sends. `model`, `effort` and
 * `permissionMode` are the sheet's choices; `default` leaves the flag out.
 */
export type LaunchRequest = {
  projectId: string;
  /** The session id `launch_defaults` gave this sheet; Rust refuses any other (a stale or doubled start). */
  sessionId: string;
  name: string;
  model: string;
  effort: string;
  permissionMode: string;
  addDirs: string[];
  /** The first prompt; `null` (or blank) for none. */
  prompt: string | null;
  background: boolean;
  /** Story 5.3: the branch card the sheet was opened on; Rust resolves its folder. `null` on the project's sheet. */
  branch: string | null;
  /** A branch without a worktree: the Start creates it first (Story 5.2's plan), then starts in it. */
  createWorktree: boolean;
  /** The project's sheet only: `claude --worktree <name>` from the repo's top level; `null` for none. */
  worktreeName: string | null;
};

/** Mirrors `launch::WorktreePlanPreview`: the `git worktree add` a branch sheet's Start runs first, or why it would not. */
export type WorktreePlanPreview = { command: string | null; path: string | null; error: string | null };

/** Mirrors `launch::LaunchPrefill`: the sheet's prefill for a project. */
export type LaunchPrefill = {
  /** The fresh session id proposed for this sheet; the launch sends it back. */
  sessionId: string;
  /** `<project label>-<4 hex of the session id the launch will use>`. */
  name: string;
  /** A named model, `default`, or custom text. */
  model: string;
  effort: string;
  permissionMode: string;
  /** Story 5.3: the branch the sheet starts on; `null` (or absent) on the project's sheet. */
  branch?: string | null;
  /** The folder the session would run in, as Rust resolved it; `null` while a worktree plan is refused. */
  targetPath?: string | null;
  /** A branch without a worktree: the command its Start runs first. */
  worktreePlan?: WorktreePlanPreview | null;
  /** The project's sheet of a git project: its top level (`--worktree` runs there); `null` otherwise. */
  repoTop?: string | null;
  /** Story 6.2: the folders the project's outgoing context edges grant (Rust resolved them); the sheet prefills its add-dirs. */
  addDirs?: EdgeDir[];
  /** The project's context edges whose target gives no folder (the sheet's `not added:` line). */
  skipped?: SkippedEdge[];
};

/** Mirrors `graph::EdgeDir`: a folder a context edge grants, and the label of the edge's target (`via edge → <via>`). */
export type EdgeDir = { path: string; via: string };

/** Mirrors `graph::SkippedEdge`: a context edge whose target gives no folder, and why (`no worktree`, `folder missing`, `not found`). */
export type SkippedEdge = { label: string; reason: string };

/** Mirrors `ipc::LaunchChoices`: the model, effort and permission mode a launch used (`default`: no flag). */
export type LaunchChoices = { model: string; effort: string; permission_mode: string };

/**
 * Mirrors `ipc::LaunchResult`: the new session, the terminal it runs in and the choices it used;
 * for Resume and Fork (Story 6.2) the context edges whose target gave no folder.
 */
export type LaunchResult = { session_id: string; term: TermInfo; choices: LaunchChoices; skipped?: SkippedEdge[] };

// --- worktrees (`src-tauri/src/git/worktree.rs`, Story 5.2) ---------------------------------

/** Mirrors `worktree::WorktreeMode`: a new branch from a base, or an existing local branch. */
export type WorktreeMode = "new" | "existing";

/** Mirrors `worktree::WorktreeRequest`: what the "New worktree" sheet asks for. */
export type WorktreeRequest = {
  mode: WorktreeMode;
  /** The new branch's name (`new`) or the existing branch (`existing`). */
  branch: string;
  /** The base of a new branch; `null` means the default base. Ignored for `existing`. */
  base: string | null;
};

/**
 * Mirrors `worktree::WorktreePreview`: the sheet's choices and, for the request, the exact
 * command and folder Rust would run -- or why nothing would run. Both `null` and no error for a
 * blank new-branch name.
 */
export type WorktreePreview = {
  /** Every local branch (the base select), in card order. */
  branches: string[];
  /** Local branches with no worktree and not checked out anywhere (the existing select). */
  available: string[];
  /** The checked-out branch, else the repo's default branch; `null` with no branches. */
  defaultBase: string | null;
  command: string | null;
  path: string | null;
  error: string | null;
};

/** Mirrors `ipc::WorktreeAdded`: the snapshot once the branches were re-read, and the new card's id. */
export type WorktreeAdded = { snapshot: WorkspaceSnapshot; branchId: string };

/**
 * Mirrors `worktree::RemoveCheck` (Story 5.4): what the "Remove worktree" sheet shows, read-only.
 * Rust owns the checks and every command's text.
 */
export type RemoveWorktreeCheck = {
  branch: string;
  /** The worktree folder (canonical when it exists). */
  path: string;
  /** The folder is gone: Remove clears that one stale record. */
  missing: boolean;
  locked: boolean;
  /** Modified and untracked files inside it; 0 when missing or locked. */
  dirty: number;
  /** What Remove runs: `git worktree remove <path>` (a missing folder too). */
  command: string;
  /** What the second confirm runs while dirty: `git worktree remove --force <path>`. */
  forceCommand: string | null;
  /** What runs after the remove when "Also delete branch" is ticked: `git branch -d <name>`. */
  deleteCommand: string;
  /** Why nothing may run (`locked` or `locked: <reason>`, a session running in it); `null` when it may. */
  refusal: string | null;
};

/** Mirrors `ipc::WorktreeRemoved`: the snapshot once re-read, and how the branch delete went. */
export type WorktreeRemoved = { snapshot: WorkspaceSnapshot; branchDeleted: boolean; deleteError: string | null };

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
  project_set_show_branches: WorkspaceSnapshot;
  worktree_preview: WorktreePreview;
  worktree_add: WorktreeAdded;
  worktree_remove_preview: RemoveWorktreeCheck;
  worktree_remove: WorktreeRemoved;
  workspace_move_node: WorkspaceSnapshot;
  workspace_relayout_children: WorkspaceSnapshot;
  edge_add: Edge;
  edge_set_label: WorkspaceSnapshot;
  edge_remove: WorkspaceSnapshot;
  edges_live_get: EdgesLiveMap;
  edge_live_retry: void;
  edge_restart_with_flags: LaunchResult;
  claude_projects_list: ClaudeProject[];
  projects_status_get: ProjectStatusMap;
  live_sessions_get: LiveSnapshot;
  session_acknowledge: LiveSnapshot | null;
  workspace_remove_project: WorkspaceSnapshot;
  project_open_editor: void;
  project_open_folder: void;
  project_reveal_claude_dir: void;
  app_quit: void;
  term_open: TermInfo;
  term_write: void;
  term_resize: void;
  term_buffer: TermBuffer;
  term_restart: TermInfo;
  term_kill: void;
  term_list: TermInfo[];
  launch_defaults: LaunchPrefill;
  session_launch: LaunchResult;
  session_resume: LaunchResult;
  session_fork: LaunchResult;
  session_stop: TermInfo;
  term_close: void;
  term_pop_out: string;
  term_return: void;
  term_popped: TermPopped[];
  diagnostics_get: DiagnosticsSnapshot;
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
 * folder, or `null` when the picker was cancelled. `title` replaces "Add project folder"
 * (the launch sheet's add-dir picker says "Add folder for this session").
 */
export function projectPickFolder(title?: string): Promise<string | null> {
  return title === undefined ? call("project_pick_folder") : call("project_pick_folder", { title });
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
 * `ipc::project_set_show_branches` -- the "branches" toggle (Story 5.1). Rust persists
 * `showBranches` (turning it on expands a collapsed card), starts or stops the branch watch and
 * reads the list; the branch cards follow as `workspace://changed`. Rejects with `"unknown project"`.
 */
export function projectSetShowBranches(projectId: string, show: boolean): Promise<WorkspaceSnapshot> {
  return call("project_set_show_branches", { projectId, show });
}

/**
 * `ipc::worktree_preview` (Story 5.2) -- read-only: the sheet's options and the exact
 * `git worktree add` command and folder for `request`, or why nothing would run. Rejects for an
 * unknown project or a folder that is not a repository.
 */
export function worktreePreview(projectId: string, request: WorktreeRequest): Promise<WorktreePreview> {
  return call("worktree_preview", { projectId, request });
}

/**
 * `ipc::worktree_add` (Story 5.2) -- the sheet's submit: Rust re-plans, runs `git worktree add`,
 * stores the branch with its worktree, turns the project's branches on and re-reads them.
 * Rejects with the validation message or git's first stderr line; nothing runs then.
 */
export function worktreeAdd(projectId: string, request: WorktreeRequest): Promise<WorktreeAdded> {
  return call("worktree_add", { projectId, request });
}

/**
 * `ipc::worktree_remove_preview` (Story 5.4) -- read-only: the "Remove worktree" sheet's checks
 * (missing, locked, the dirty count, a live session in it) and the exact commands. Rejects for an
 * unknown project or a branch without a linked worktree.
 */
export function worktreeRemovePreview(projectId: string, branch: string): Promise<RemoveWorktreeCheck> {
  return call("worktree_remove_preview", { projectId, branch });
}

/**
 * `ipc::worktree_remove` (Story 5.4) -- the sheet's click: Rust checks again and runs
 * `git worktree remove [--force] <path>` (a missing folder too), then, with `deleteBranch`,
 * `git branch -d <branch>`. A force carries `dirty`, the count the second confirm stated; Rust
 * refuses when the worktree's count is not that any more. Rejects with the refusal or git's
 * first stderr line.
 */
export function worktreeRemove(
  projectId: string,
  branch: string,
  force: boolean,
  dirty: number | null,
  deleteBranch: boolean,
): Promise<WorktreeRemoved> {
  return call("worktree_remove", { projectId, branch, force, dirty, deleteBranch });
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
 * `ipc::edge_add` (Story 6.1) -- draw an edge from `from` to `to`. Rust picks the kind from the
 * pair and rejects an invalid pair, a duplicate or an unknown end with the notice to show
 * (`"can't link a project to a session"`, `"already linked"`, ...). Resolves with the new edge;
 * the snapshot follows as `workspace://changed`.
 */
export function edgeAdd(from: NodeRef, to: NodeRef): Promise<Edge> {
  return call("edge_add", { from, to });
}

/**
 * `ipc::edge_set_label` (Story 6.1) -- set an edge's label (trimmed; blank or `null` clears it).
 * Rejects with `"unknown edge"`.
 */
export function edgeSetLabel(id: string, label: string | null): Promise<WorkspaceSnapshot> {
  return call("edge_set_label", { id, label });
}

/** `ipc::edge_remove` (Story 6.1) -- delete an edge. Rejects with `"unknown edge"`. */
export function edgeRemove(id: string): Promise<WorkspaceSnapshot> {
  return call("edge_remove", { id });
}

/** `ipc::edges_live_get` (Story 6.3) -- the live state of the context edges on running sessions. */
export function edgesLiveGet(): Promise<EdgesLiveMap> {
  return call("edges_live_get");
}

/**
 * `ipc::edge_live_retry` (Story 6.3) -- run a context edge's `/add-dir` injection again; for a
 * cooperate edge (Story 6.4), send the peer line again to the side of `sessionId`. Rejects when
 * the edge is gone, is a project's context edge, a cooperate edge is given none of its sessions,
 * or the session is not running.
 */
export function edgeLiveRetry(edgeId: string, sessionId?: string): Promise<void> {
  return call("edge_live_retry", sessionId === undefined ? { edgeId } : { edgeId, sessionId });
}

/**
 * `ipc::edge_restart_with_flags` (Story 6.3) -- stop the edge's session as Stop does, wait for
 * its exit and resume the same id with its context edges as `--add-dir`. Resolves with the
 * resumed run; rejects (nothing stopped) for a session with no transcript.
 */
export function edgeRestartWithFlags(edgeId: string): Promise<LaunchResult> {
  return call("edge_restart_with_flags", { edgeId });
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

/**
 * `ipc::session_acknowledge` -- the operator selected this session, seen needing attention
 * since `attentionSince`: a `finished` / `waiting` one with that same `attention_since` turns
 * `idle` (source `ack`) until it is next busy, and `sessions://live` follows. Resolves with
 * the new live snapshot, or `null` when nothing changed (a newer turn than the one seen too).
 */
export function sessionAcknowledge(sessionId: string, attentionSince: number | null): Promise<LiveSnapshot | null> {
  return call("session_acknowledge", { sessionId, attentionSince });
}

/**
 * `ipc::diagnostics_get` -- the hooks endpoint (or why it is down) and the counters: hook
 * events received, refused requests, session-id mismatches, poll overrides (Story 4.3).
 */
export function diagnosticsGet(): Promise<DiagnosticsSnapshot> {
  return call("diagnostics_get");
}

/** `ipc::app_quit` -- exit the app with status 0. Resolves only if the exit did not happen. */
export function appQuit(): Promise<void> {
  return call("app_quit");
}

/**
 * `ipc::term_open` -- open the project's plain terminal (its folder, the configured shell) at
 * `cols` × `rows`, or get the one already open (running or exited).
 */
export function termOpen(projectId: string, cols: number | null, rows: number | null): Promise<TermInfo> {
  return call("term_open", { kind: "plain", projectId, cols, rows });
}

/** `ipc::term_write` -- send input (keys, a paste) to a terminal. */
export function termWrite(id: string, data: string): Promise<void> {
  return call("term_write", { id, data });
}

/** `ipc::term_resize` -- resize a terminal's PTY (Rust clamps to at least 2 × 1). */
export function termResize(id: string, cols: number, rows: number): Promise<void> {
  return call("term_resize", { id, cols, rows });
}

/** `ipc::term_buffer` -- the last 2 MiB of a terminal's output, for a view created late. */
export function termBuffer(id: string): Promise<TermBuffer> {
  return call("term_buffer", { id });
}

/** `ipc::term_restart` -- respawn an exited terminal in place. */
export function termRestart(id: string): Promise<TermInfo> {
  return call("term_restart", { id });
}

/** `ipc::term_kill` -- kill a terminal's child; it turns exited and keeps its output. */
export function termKill(id: string): Promise<void> {
  return call("term_kill", { id });
}

/** `ipc::term_close` -- forget an exited session terminal (its output goes). */
export function termClose(id: string): Promise<void> {
  return call("term_close", { id });
}

/**
 * `ipc::term_pop_out` (Story 4.5) -- pop a terminal out into its own window (`term-<n>`), or
 * focus the window it is already in. Resolves the window's label.
 */
export function termPopOut(id: string): Promise<string> {
  return call("term_pop_out", { id });
}

/** `ipc::term_return` -- close a terminal's pop-out window; it returns to the pane. */
export function termReturn(id: string): Promise<void> {
  return call("term_return", { id });
}

/** `ipc::term_popped` -- every popped-out terminal and its window (after a reload). */
export function termPopped(): Promise<TermPopped[]> {
  return call("term_popped");
}

/** `ipc::term_list` -- every terminal, in the order opened. */
export function termList(): Promise<TermInfo[]> {
  return call("term_list");
}

/**
 * `ipc::launch_defaults` -- the launch sheet's prefill for a project (its last choices, else
 * `settings.defaults`, else `default`) and the default name of the session it would start.
 * With `branch` (Story 5.3, `n` on a branch card) Rust also resolves where the session runs:
 * the branch's worktree, the project folder for the checked-out branch, or the worktree a Start
 * would create (`worktreePlan`). Rejects with `branch not found` / `worktree folder missing`.
 */
export function launchDefaults(projectId: string, branch: string | null = null): Promise<LaunchPrefill> {
  return branch === null ? call("launch_defaults", { projectId }) : call("launch_defaults", { projectId, branch });
}

/**
 * `ipc::session_launch` -- start a Claude session from the sheet in a session terminal at
 * `cols` × `rows` (`null`: Rust's 120 × 30). Rejects with the reason nothing was started.
 */
export function sessionLaunch(request: LaunchRequest, cols: number | null, rows: number | null): Promise<LaunchResult> {
  return call("session_launch", { request, cols, rows });
}

/**
 * `ipc::session_resume` (Story 4.4) -- `claude --resume <id>` for the historic session the card
 * under project `projectId` shows (Rust checks it is discovered there), in its
 * transcript's folder, under the same id and terminal id; no sheet. Rejects with the reason
 * (it is running, no transcript, no folder, …) and starts nothing then.
 */
export function sessionResume(projectId: string, sessionId: string, cols: number | null, rows: number | null): Promise<LaunchResult> {
  return call("session_resume", { projectId, sessionId, cols, rows });
}

/**
 * `ipc::session_fork` (Story 4.4) -- `--resume <id> --fork-session --session-id <new>`: a new
 * session (the reply's `session_id`) forked from `sessionId`; no sheet.
 */
export function sessionFork(projectId: string, sessionId: string, cols: number | null, rows: number | null): Promise<LaunchResult> {
  return call("session_fork", { projectId, sessionId, cols, rows });
}

/**
 * `ipc::session_stop` (Story 4.4) -- stop a session running in a Switchboard terminal (`/exit`
 * at its prompt, else Ctrl+C twice; killed after 5 s; a second Stop kills at once). Replies with
 * the terminal's info, `stopping` set.
 */
export function sessionStop(sessionId: string): Promise<TermInfo> {
  return call("session_stop", { sessionId });
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

/** Subscribe to `edges://live` (Story 6.3); same contract as {@link onSettingsChanged}. */
export async function onEdgesLive(callback: (entries: EdgesLiveMap) => void): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<EdgesLiveMap>(EDGES_LIVE_EVENT, (event) => callback(event.payload));
}

/** Subscribe to `notify://reveal` (a toast was clicked); same contract as {@link onSettingsChanged}. */
export async function onNotifyReveal(callback: (request: RevealRequest) => void): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<RevealRequest>(NOTIFY_REVEAL_EVENT, (event) => callback(event.payload));
}

/** Subscribe to `term://data`; same contract as {@link onSettingsChanged}. */
export async function onTermData(callback: (data: TermData) => void): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<TermData>(TERM_DATA_EVENT, (event) => callback(event.payload));
}

/** Subscribe to `term://exit`; same contract as {@link onSettingsChanged}. */
export async function onTermExit(callback: (exit: TermExit) => void): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<TermExit>(TERM_EXIT_EVENT, (event) => callback(event.payload));
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

/** Subscribe to `term://popped`; same contract as {@link onSettingsChanged}. */
export async function onTermPopped(callback: (popped: TermPopped) => void): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<TermPopped>(TERM_POPPED_EVENT, (event) => callback(event.payload));
}

/** Subscribe to `term://info`; same contract as {@link onSettingsChanged}. */
export async function onTermInfo(callback: (info: TermInfo) => void): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<TermInfo>(TERM_INFO_EVENT, (event) => callback(event.payload));
}

/** Subscribe to `term://closed`; same contract as {@link onSettingsChanged}. */
export async function onTermClosed(callback: (closed: TermClosed) => void): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<TermClosed>(TERM_CLOSED_EVENT, (event) => callback(event.payload));
}
