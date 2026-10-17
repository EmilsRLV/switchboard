import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appInfo,
  claudeProjectsList,
  hasTauriRuntime,
  NoTauriRuntimeError,
  projectPickFolder,
  projectsStatusGet,
  workspaceAddProjects,
  workspaceGet,
  workspaceSetViewport,
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
  };

  it("workspaceSetViewport invokes workspace_set_viewport with a { viewport } argument", async () => {
    // `@tauri-apps/api/core`'s `invoke(cmd, args = {}, options)` forwards to this.
    const invoke = vi.fn().mockResolvedValue(snapshot);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    const viewport = { x: -120, y: 40, zoom: 1.5 };
    await expect(workspaceSetViewport(viewport)).resolves.toBe(snapshot);
    expect(invoke).toHaveBeenCalledWith("workspace_set_viewport", { viewport }, undefined);
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
