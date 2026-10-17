import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appInfo,
  claudeProjectsList,
  hasTauriRuntime,
  NoTauriRuntimeError,
  projectOpenEditor,
  projectOpenFolder,
  projectPickFolder,
  projectRevealClaudeDir,
  projectsStatusGet,
  workspaceAddProjects,
  workspaceGet,
  workspaceMoveNode,
  workspaceRelayoutChildren,
  workspaceRemoveProject,
  workspaceSetExpanded,
  workspaceSetViewport,
  type ChildNode,
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
      branchId: null,
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
  });
});
