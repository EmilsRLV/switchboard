import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appInfo,
  claudeProjectsList,
  diagnosticsGet,
  hasTauriRuntime,
  launchDefaults,
  liveSessionsGet,
  NoTauriRuntimeError,
  onNotifyReveal,
  onTermData,
  onTermExit,
  onTermClosed,
  onTermInfo,
  onTermPopped,
  termPopOut,
  termPopped,
  termReturn,
  termBuffer,
  termKill,
  termList,
  termOpen,
  termResize,
  termRestart,
  termWrite,
  sessionAcknowledge,
  sessionFork,
  sessionLaunch,
  sessionResume,
  sessionStop,
  termClose,
  projectOpenEditor,
  projectOpenFolder,
  projectPickFolder,
  projectRevealClaudeDir,
  projectSetShowBranches,
  projectsStatusGet,
  workspaceAddProjects,
  workspaceGet,
  workspaceMoveNode,
  workspaceRelayoutChildren,
  edgeAdd,
  edgeLiveRetry,
  edgeRemove,
  edgeRestartWithFlags,
  edgeSetLabel,
  edgesLiveGet,
  EDGES_LIVE_EVENT,
  onEdgesLive,
  workspaceRemoveProject,
  workspaceSetExpanded,
  workspaceSetViewport,
  type ChildNode,
  type LaunchRequest,
  type SessionState,
  type WorkspaceSnapshot,
} from "./index";

// vitest runs these in a node environment: there is no `window` at all, which
// is the plain-browser-without-Tauri case taken to its extreme.
describe("ipc runtime guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports no runtime when window is absent", () => {
    expect(hasTauriRuntime()).toBe(false);
  });

  it("reports no runtime in a plain browser window", () => {
    vi.stubGlobal("window", {});
    expect(hasTauriRuntime()).toBe(false);
  });

  it("reports a runtime when Tauri has injected its internals", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(hasTauriRuntime()).toBe(true);
  });

  it("rejects commands with NoTauriRuntimeError instead of throwing from Tauri's invoke", async () => {
    vi.stubGlobal("window", {});
    await expect(appInfo()).rejects.toBeInstanceOf(NoTauriRuntimeError);
    await expect(appInfo()).rejects.toThrow('cannot invoke "app_info"');
  });
});

describe("workspace command wrappers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const snapshot: WorkspaceSnapshot = {
    path: null,
    workspace: {
      version: 1,
      viewport: { x: -120, y: 40, zoom: 1.5 },
      projects: [],
      branches: [],
      sessions: [],
      edges: [],
      defaults: { model: null, effort: null, permissionMode: null },
    },
    banners: [],
    revision: 0,
    branchErrors: {},
    children: [],
  };

  it("the 2.3 wrappers invoke their wire names with camelCase arguments", async () => {
    const invoke = vi.fn().mockResolvedValue(snapshot);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await expect(workspaceSetExpanded("p1", true)).resolves.toBe(snapshot);
    expect(invoke).toHaveBeenCalledWith("workspace_set_expanded", { projectId: "p1", expanded: true }, undefined);
    const target = { kind: "session", id: "stub-2-p1" } as const;
    const position = { x: 260, y: 40 };
    await expect(workspaceMoveNode(target, position)).resolves.toBe(snapshot);
    expect(invoke).toHaveBeenCalledWith("workspace_move_node", { target, position }, undefined);
    await expect(workspaceRelayoutChildren("p1")).resolves.toBe(snapshot);
    expect(invoke).toHaveBeenCalledWith("workspace_relayout_children", { projectId: "p1" }, undefined);
  });

  it("the 6.1 edge wrappers invoke their wire names with { from, to }, { id, label } and { id }", async () => {
    const invoke = vi.fn().mockResolvedValue(snapshot);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    const from = { type: "session", id: "s1" } as const;
    const to = { type: "project", id: "p1" } as const;
    await edgeAdd(from, to);
    expect(invoke).toHaveBeenCalledWith("edge_add", { from, to }, undefined);
    await expect(edgeSetLabel("e1", null)).resolves.toBe(snapshot);
    expect(invoke).toHaveBeenCalledWith("edge_set_label", { id: "e1", label: null }, undefined);
    await expect(edgeRemove("e1")).resolves.toBe(snapshot);
    expect(invoke).toHaveBeenCalledWith("edge_remove", { id: "e1" }, undefined);
  });

  it("the 6.3 live edge wrappers invoke their wire names with {}, { edgeId } and { edgeId }", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await expect(edgesLiveGet()).resolves.toEqual({});
    expect(invoke).toHaveBeenCalledWith("edges_live_get", {}, undefined);
    await edgeLiveRetry("e1");
    expect(invoke).toHaveBeenCalledWith("edge_live_retry", { edgeId: "e1" }, undefined);
    await edgeRestartWithFlags("e1");
    expect(invoke).toHaveBeenCalledWith("edge_restart_with_flags", { edgeId: "e1" }, undefined);
    expect(EDGES_LIVE_EVENT).toBe("edges://live");
  });

  it("onEdgesLive is a no-op without the Tauri runtime", async () => {
    const callback = vi.fn();
    const unlisten = await onEdgesLive(callback);
    unlisten();
    expect(callback).not.toHaveBeenCalled();
  });

  it("the 5.1 toggle invokes project_set_show_branches with { projectId, show }", async () => {
    const invoke = vi.fn().mockResolvedValue(snapshot);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await expect(projectSetShowBranches("p1", true)).resolves.toBe(snapshot);
    expect(invoke).toHaveBeenCalledWith("project_set_show_branches", { projectId: "p1", show: true }, undefined);
  });

  it("the 2.4 wrappers invoke their wire names with { projectId }", async () => {
    const invoke = vi.fn().mockResolvedValue(snapshot);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await expect(workspaceRemoveProject("p1")).resolves.toBe(snapshot);
    expect(invoke).toHaveBeenCalledWith("workspace_remove_project", { projectId: "p1" }, undefined);
    invoke.mockResolvedValue(undefined);
    await expect(projectOpenEditor("p1")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("project_open_editor", { projectId: "p1" }, undefined);
    await expect(projectOpenFolder("p1")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("project_open_folder", { projectId: "p1" }, undefined);
    await expect(projectRevealClaudeDir("p1")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("project_reveal_claude_dir", { projectId: "p1" }, undefined);
    // Rust's `Err(String)` arrives as the rejection value: the notice text.
    invoke.mockRejectedValueOnce("No external editor configured — set external_editor in settings");
    await expect(projectOpenEditor("p1")).rejects.toBe("No external editor configured — set external_editor in settings");
  });

  it("workspaceSetViewport invokes workspace_set_viewport with a { viewport } argument", async () => {
    // `@tauri-apps/api/core`'s `invoke(cmd, args = {}, options)` forwards to this.
    const invoke = vi.fn().mockResolvedValue(snapshot);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    const viewport = { x: -120, y: 40, zoom: 1.5 };
    await expect(workspaceSetViewport(viewport)).resolves.toBe(snapshot);
    expect(invoke).toHaveBeenCalledWith("workspace_set_viewport", { viewport }, undefined);
  });

  it("a session child carries its meta and branch id as Rust serialises them", async () => {
    const child: ChildNode = {
      id: "0b7c",
      projectId: "p1",
      kind: "session",
      label: "Fix the login bug",
      detail: null,
      position: null,
      session: { startedAt: "2026-10-16T10:00:00.000Z", lastActive: "2026-10-16T11:00:00.000Z", branch: "main", messages: 4 },
      branchId: null, forkedFrom: null, hasTranscript: false, branch: null,
    };
    const withChild: WorkspaceSnapshot = { ...snapshot, children: [child] };
    const invoke = vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(withChild)));
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    const got = await workspaceGet();
    expect(got.children[0]?.session).toEqual(child.session);
    expect(got.children[0]?.branchId).toBeNull();
  });

  it("workspaceGet invokes workspace_get with no arguments of its own", async () => {
    const invoke = vi.fn().mockResolvedValue(snapshot);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await expect(workspaceGet()).resolves.toBe(snapshot);
    // The api fills in `{}` for a missing args object before forwarding.
    expect(invoke).toHaveBeenCalledWith("workspace_get", {}, undefined);
  });

  it("workspaceAddProjects invokes workspace_add_projects with { paths, position }", async () => {
    const result = { snapshot, added: ["p1"], existing: [], skipped: [] };
    const invoke = vi.fn().mockResolvedValue(result);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    const paths = ["B:\\projects\\ide"];
    const position = { x: 10, y: 20 };
    await expect(workspaceAddProjects(paths, position)).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledWith("workspace_add_projects", { paths, position }, undefined);
  });

  it("the argument-less wrappers invoke their wire names with no arguments of their own", async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await expect(projectPickFolder()).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith("project_pick_folder", {}, undefined);
    invoke.mockResolvedValue([]);
    await expect(claudeProjectsList()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith("claude_projects_list", {}, undefined);
    invoke.mockResolvedValue({});
    await expect(projectsStatusGet()).resolves.toEqual({});
    expect(invoke).toHaveBeenCalledWith("projects_status_get", {}, undefined);
    const live = { sessions: {}, elsewhere: [], banner: null };
    invoke.mockResolvedValue(live);
    await expect(liveSessionsGet()).resolves.toEqual(live);
    expect(invoke).toHaveBeenCalledWith("live_sessions_get", {}, undefined);
  });

  it("sessionAcknowledge invokes session_acknowledge with { sessionId, attentionSince }", async () => {
    const live = { sessions: {}, elsewhere: [], banner: null };
    const invoke = vi.fn().mockResolvedValue(live);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await expect(sessionAcknowledge("s1", 42)).resolves.toBe(live);
    expect(invoke).toHaveBeenCalledWith("session_acknowledge", { sessionId: "s1", attentionSince: 42 }, undefined);
  });

  it("diagnosticsGet invokes diagnostics_get with no arguments", async () => {
    const diagnostics = {
      endpoint: "127.0.0.1:4242",
      endpoint_error: null,
      hook_events: 3,
      refused: 1,
      session_mismatches: 0,
      poll_overrides: 0,
    };
    const invoke = vi.fn().mockResolvedValue(diagnostics);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await expect(diagnosticsGet()).resolves.toBe(diagnostics);
    expect(invoke).toHaveBeenCalledWith("diagnostics_get", {}, undefined);
  });

  it("the toast-click subscription is a no-op without a runtime", async () => {
    const unlisten = await onNotifyReveal(() => {});
    expect(() => unlisten()).not.toThrow();
  });
});

describe("terminal command wrappers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const info = { id: "plain-p1", kind: "plain" as const, project_id: "p1", title: "ide", cwd: "/p/ide", exited: null, error: null, cols: 80, rows: 24 };

  it("invoke their wire names with camelCase arguments", async () => {
    const invoke = vi.fn().mockResolvedValue(info);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await expect(termOpen("p1", 100, 30)).resolves.toBe(info);
    expect(invoke).toHaveBeenCalledWith("term_open", { kind: "plain", projectId: "p1", cols: 100, rows: 30 }, undefined);
    await expect(termRestart("plain-p1")).resolves.toBe(info);
    expect(invoke).toHaveBeenCalledWith("term_restart", { id: "plain-p1" }, undefined);
    invoke.mockResolvedValue(undefined);
    await termWrite("plain-p1", "ls\r");
    expect(invoke).toHaveBeenCalledWith("term_write", { id: "plain-p1", data: "ls\r" }, undefined);
    await termResize("plain-p1", 80, 24);
    expect(invoke).toHaveBeenCalledWith("term_resize", { id: "plain-p1", cols: 80, rows: 24 }, undefined);
    await termKill("plain-p1");
    expect(invoke).toHaveBeenCalledWith("term_kill", { id: "plain-p1" }, undefined);
    invoke.mockResolvedValue({ data: "output", offset: 6 });
    await expect(termBuffer("plain-p1")).resolves.toEqual({ data: "output", offset: 6 });
    expect(invoke).toHaveBeenCalledWith("term_buffer", { id: "plain-p1" }, undefined);
    invoke.mockResolvedValue([info]);
    await expect(termList()).resolves.toEqual([info]);
    expect(invoke).toHaveBeenCalledWith("term_list", {}, undefined);
  });

  it("a size the pane could not measure goes as null (Rust uses 120 x 30)", async () => {
    const invoke = vi.fn().mockResolvedValue(info);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await termOpen("p1", null, null);
    expect(invoke).toHaveBeenCalledWith("term_open", { kind: "plain", projectId: "p1", cols: null, rows: null }, undefined);
  });

  it("the event subscriptions are no-ops without a runtime", async () => {
    const data = await onTermData(() => {});
    const exit = await onTermExit(() => {});
    const popped = await onTermPopped(() => {});
    const info = await onTermInfo(() => {});
    const closed = await onTermClosed(() => {});
    expect(() => {
      data();
      exit();
      popped();
      info();
      closed();
    }).not.toThrow();
  });

  it("the pop-out wrappers invoke their wire names (Story 4.5)", async () => {
    const invoke = vi.fn().mockResolvedValue("term-1");
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await expect(termPopOut("session:s1")).resolves.toBe("term-1");
    expect(invoke).toHaveBeenCalledWith("term_pop_out", { id: "session:s1" }, undefined);
    invoke.mockResolvedValue(undefined);
    await termReturn("session:s1");
    expect(invoke).toHaveBeenCalledWith("term_return", { id: "session:s1" }, undefined);
    invoke.mockResolvedValue([{ id: "session:s1", label: "term-1" }]);
    await expect(termPopped()).resolves.toEqual([{ id: "session:s1", label: "term-1" }]);
    expect(invoke).toHaveBeenCalledWith("term_popped", {}, undefined);
  });
});

describe("session launch wrappers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("launchDefaults invokes launch_defaults with { projectId }", async () => {
    const prefill = { name: "ide-3f2a", model: "default", effort: "default", permissionMode: "default" };
    const invoke = vi.fn().mockResolvedValue(prefill);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await expect(launchDefaults("p1")).resolves.toBe(prefill);
    expect(invoke).toHaveBeenCalledWith("launch_defaults", { projectId: "p1" }, undefined);
    await launchDefaults("p1", "feat");
    expect(invoke).toHaveBeenLastCalledWith("launch_defaults", { projectId: "p1", branch: "feat" }, undefined);
  });

  it("sessionLaunch invokes session_launch with { request, cols, rows }", async () => {
    const request: LaunchRequest = {
      projectId: "p1",
      sessionId: "3f2a-id",
      name: "ide-3f2a",
      model: "opus",
      effort: "high",
      permissionMode: "plan",
      addDirs: ["/work/a"],
      prompt: "hi",
      background: false,
      branch: "feat",
      createWorktree: true,
      worktreeName: null,
    };
    const term = { id: "session:s1", kind: "session" as const, project_id: "p1", title: "ide-3f2a", cwd: "/p/ide", exited: null, error: null, cols: 120, rows: 30 };
    const invoke = vi.fn().mockResolvedValue({ session_id: "s1", term });
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await expect(sessionLaunch(request, null, null)).resolves.toEqual({ session_id: "s1", term });
    expect(invoke).toHaveBeenCalledWith("session_launch", { request, cols: null, rows: null }, undefined);
    invoke.mockRejectedValueOnce("claude not found; set claude.path in settings");
    await expect(sessionLaunch(request, 80, 24)).rejects.toBe("claude not found; set claude.path in settings");
  });

  it("sessionResume, sessionFork and sessionStop invoke their wire names with { projectId, sessionId }", async () => {
    const term = { id: "session:s1", kind: "session" as const, project_id: "p1", title: "ide-59cd", cwd: "/p/ide", exited: null, error: null, cols: 120, rows: 30, stopping: false };
    const invoke = vi.fn().mockResolvedValue({ session_id: "s1", term });
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await expect(sessionResume("p1", "s1", null, null)).resolves.toEqual({ session_id: "s1", term });
    expect(invoke).toHaveBeenCalledWith("session_resume", { projectId: "p1", sessionId: "s1", cols: null, rows: null }, undefined);
    await sessionFork("p1", "s1", 100, 30);
    expect(invoke).toHaveBeenCalledWith("session_fork", { projectId: "p1", sessionId: "s1", cols: 100, rows: 30 }, undefined);
    invoke.mockResolvedValue({ ...term, stopping: true });
    await expect(sessionStop("s1")).resolves.toEqual({ ...term, stopping: true });
    expect(invoke).toHaveBeenCalledWith("session_stop", { sessionId: "s1" }, undefined);
    invoke.mockRejectedValueOnce("that session is already running");
    await expect(sessionResume("p1", "s1", null, null)).rejects.toBe("that session is already running");
  });

  it("termClose and the titled folder picker invoke their wire names", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await termClose("session:s1");
    expect(invoke).toHaveBeenCalledWith("term_close", { id: "session:s1" }, undefined);
    invoke.mockResolvedValue(null);
    await projectPickFolder("Add folder for this session");
    expect(invoke).toHaveBeenCalledWith("project_pick_folder", { title: "Add folder for this session" }, undefined);
  });

  it("the starting state is a session state", () => {
    const starting: SessionState = { kind: "starting" };
    expect(starting.kind).toBe("starting");
  });
});
