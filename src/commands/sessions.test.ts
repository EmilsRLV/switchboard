import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchRequest, Project, TermInfo, WorkspaceSnapshot } from "../ipc";
import { useLaunchStore } from "../state/launch";
import { useTerminalStore } from "../state/terminals";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { formFromPrefill } from "./launch";
import { canShowSessionTerminal, openLaunchSheet, pickAddDir, removeAddDir, startLaunch } from "./sessions";

function project(expanded: boolean): Project {
  return { id: "ide", path: "/p/ide", label: "ide", position: { x: 0, y: 0 }, expanded, color: null, launchDefaults: null };
}

function workspace(expanded: boolean): WorkspaceSnapshot {
  return {
    path: null,
    workspace: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      projects: [project(expanded)],
      branches: [],
      sessions: [],
      edges: [],
      defaults: { model: null, effort: null, permissionMode: null },
    },
    banners: [],
    revision: 1,
    children: [],
  };
}

const term: TermInfo = {
  id: "session:s1",
  kind: "session",
  project_id: "ide",
  title: "ide-3f2a",
  cwd: "/p/ide",
  exited: null,
  error: null,
  cols: 120,
  rows: 30,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** A Tauri runtime whose commands answer from `replies` (a function rejects with its throw). */
function runtime(replies: Record<string, (args: Record<string, unknown>) => unknown>) {
  const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    const reply = replies[cmd];
    if (reply === undefined) throw new Error(`unexpected ${cmd}`);
    return reply(args);
  });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  return invoke;
}

describe("the launch sheet commands", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ snapshot: workspace(false), loadError: null });
    useUiStore.setState({ pane: null, selection: { kind: "project", id: "ide" }, notice: null, activeTerminal: null });
    useLaunchStore.getState().reset();
    useTerminalStore.setState({ infos: {}, pendingExits: {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openSheet() {
    runtime({ launch_defaults: () => ({ sessionId: "3f2a-id", name: "ide-3f2a", model: "default", effort: "default", permissionMode: "default" }) });
    await expect(openLaunchSheet("ide")).resolves.toBe(true);
  }

  it("opens on the project with Rust's prefill", async () => {
    await openSheet();
    expect(useUiStore.getState().pane).toBe("launch");
    expect(useLaunchStore.getState()).toMatchObject({ projectId: "ide", projectPath: "/p/ide", projectLabel: "ide" });
    expect(useLaunchStore.getState().form?.name).toBe("ide-3f2a");
    await expect(openLaunchSheet("nope")).resolves.toBe(false);
  });

  it("starts in the foreground: the terminal is known, the pane opens on it, the child is selected and its project expanded", async () => {
    await openSheet();
    let sent: { request: LaunchRequest } | null = null;
    const invoke = runtime({
      session_launch: (args) => {
        sent = args as { request: LaunchRequest };
        return { session_id: "s1", term };
      },
      workspace_set_expanded: () => workspace(true),
    });
    useLaunchStore.getState().edit({ model: "opus", prompt: "hi" });
    await expect(startLaunch()).resolves.toBe(true);
    await flush();
    expect(sent).toEqual({
      request: { projectId: "ide", sessionId: "3f2a-id", name: "ide-3f2a", model: "opus", effort: "default", permissionMode: "default", addDirs: [], prompt: "hi", background: false },
      cols: null,
      rows: null,
    });
    expect(invoke).toHaveBeenCalledWith("workspace_set_expanded", { projectId: "ide", expanded: true }, undefined);
    expect(useTerminalStore.getState().infos["session:s1"]).toEqual(term);
    expect(useUiStore.getState().pane).toBe("terminal");
    expect(useUiStore.getState().activeTerminal).toBe("session:s1");
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s1" });
    expect(useLaunchStore.getState().form).toBeNull(); // the sheet went
    expect(canShowSessionTerminal()).toBe(true);
  });

  it("starts in the background: the sheet goes, the pane stays shut and the selection is unchanged", async () => {
    await openSheet();
    const invoke = runtime({ session_launch: () => ({ session_id: "s1", term }) });
    useLaunchStore.getState().edit({ background: true });
    await expect(startLaunch()).resolves.toBe(true);
    expect(useUiStore.getState().pane).toBeNull();
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "ide" });
    expect(useUiStore.getState().activeTerminal).toBeNull();
    expect(useTerminalStore.getState().infos["session:s1"]).toEqual(term);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("a refusal keeps the sheet with the reason under Start", async () => {
    await openSheet();
    runtime({
      session_launch: () => {
        throw "claude not found; set claude.path in settings";
      },
    });
    await expect(startLaunch()).resolves.toBe(false);
    expect(useUiStore.getState().pane).toBe("launch");
    expect(useLaunchStore.getState()).toMatchObject({ error: "claude not found; set claude.path in settings", starting: false, missingDirs: [] });
    expect(useTerminalStore.getState().infos).toEqual({});
    // Editing clears the error.
    useLaunchStore.getState().edit({ name: "x" });
    expect(useLaunchStore.getState().error).toBeNull();
  });

  it("every missing add-dir is marked on its row and blocks Start until removed; the project's own folder is never added", async () => {
    await openSheet();
    const picks = ["/work/gone", "/p/ide", "/work/a", "/work/old"];
    const invoke = runtime({
      project_pick_folder: (args) => {
        expect(args).toEqual({ title: "Add folder for this session" });
        return picks.shift() ?? null;
      },
      session_launch: () => {
        throw "add-dir does not exist: /work/gone\n/work/old";
      },
    });
    for (let i = 0; i < 4; i += 1) await pickAddDir();
    expect(useLaunchStore.getState().form?.addDirs).toEqual(["/work/gone", "/work/a", "/work/old"]);
    await expect(startLaunch()).resolves.toBe(false);
    expect(useLaunchStore.getState().missingDirs).toEqual(["/work/gone", "/work/old"]);
    await expect(startLaunch()).resolves.toBe(false);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "session_launch")).toHaveLength(1);
    removeAddDir(0);
    expect(useLaunchStore.getState().missingDirs).toEqual(["/work/old"]);
    removeAddDir(1);
    expect(useLaunchStore.getState().form?.addDirs).toEqual(["/work/a"]);
    expect(useLaunchStore.getState().missingDirs).toEqual([]);
  });

  it("a reply for a sheet that closed or reopened meanwhile touches only the sheet it was for", async () => {
    await openSheet();
    let answer: (value: unknown) => void = () => {};
    let refuse: (reason: unknown) => void = () => {};
    runtime({
      session_launch: () =>
        new Promise((resolve, reject) => {
          answer = resolve;
          refuse = reject;
        }),
      launch_defaults: () => ({ sessionId: "next-id", name: "ide-next", model: "opus", effort: "default", permissionMode: "default" }),
    });
    // A refusal after the sheet was reopened: the new sheet keeps no error; it is the notice.
    const first = startLaunch();
    await flush();
    await openLaunchSheet("ide");
    refuse("claude not found; set claude.path in settings");
    await expect(first).resolves.toBe(false);
    expect(useLaunchStore.getState()).toMatchObject({ sessionId: "next-id", error: null, starting: false });
    expect(useUiStore.getState().notice).toEqual({ text: "claude not found; set claude.path in settings" });

    // A success after the sheet closed: the terminal is known, nothing else moves.
    const second = startLaunch();
    await flush();
    useUiStore.setState({ pane: null });
    useLaunchStore.getState().reset();
    answer({ session_id: "s1", term });
    await expect(second).resolves.toBe(true);
    expect(useTerminalStore.getState().infos["session:s1"]).toEqual(term);
    expect(useUiStore.getState().pane).toBeNull();
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "ide" });
  });

  it("a folder picked after the sheet went is dropped", async () => {
    await openSheet();
    let answer: (value: unknown) => void = () => {};
    runtime({ project_pick_folder: () => new Promise((resolve) => (answer = resolve)) });
    const picking = pickAddDir();
    await flush();
    useLaunchStore.getState().reset();
    answer("/work/a");
    await expect(picking).resolves.toBe(false);
    expect(useLaunchStore.getState().form).toBeNull();
  });

  it("does not start with a blank name", async () => {
    useLaunchStore.getState().open({ id: "ide", path: "/p/ide", label: "ide" }, "sid", { ...formFromPrefill({ sessionId: "sid", name: " ", model: "default", effort: "default", permissionMode: "default" }) });
    const invoke = runtime({});
    await expect(startLaunch()).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
