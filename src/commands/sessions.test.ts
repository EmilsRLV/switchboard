import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildNode, LaunchRequest, LiveSession, Project, SessionState, TermInfo, WorkspaceSnapshot } from "../ipc";
import { EMPTY_LIVE, useLiveStore } from "../state/live";
import { useLaunchStore } from "../state/launch";
import { useTerminalStore } from "../state/terminals";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { formFromPrefill } from "./launch";
import {
  canForkSession,
  canResumeSession,
  canShowSessionTerminal,
  canStopSession,
  forkSelectedSession,
  hasTranscript,
  openLaunchSheet,
  pickAddDir,
  removeAddDir,
  resumeSelectedSession,
  startLaunch,
  startedNotice,
  stopSelectedSession,
} from "./sessions";

function project(expanded: boolean): Project {
  return { id: "ide", path: "/p/ide", label: "ide", position: { x: 0, y: 0 }, expanded, color: null, launchDefaults: null, showBranches: false };
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
    branchErrors: {},
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
  stopping: false,
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
      request: {
        projectId: "ide",
        sessionId: "3f2a-id",
        name: "ide-3f2a",
        model: "opus",
        effort: "default",
        permissionMode: "default",
        addDirs: [],
        prompt: "hi",
        background: false,
        branch: null,
        createWorktree: false,
        worktreeName: null,
      },
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

  it("on a branch card the sheet targets Rust's folder, drops an add-dir equal to it and sends the branch", async () => {
    const plan = { command: "git worktree add /p/ide/.worktrees/free free", path: "/p/ide/.worktrees/free", error: null };
    let asked: Record<string, unknown> | null = null;
    runtime({
      launch_defaults: (args) => {
        asked = args;
        return { sessionId: "3f2a-id", name: "ide-3f2a", model: "default", effort: "default", permissionMode: "default", branch: "free", targetPath: plan.path, worktreePlan: plan, repoTop: null };
      },
    });
    await expect(openLaunchSheet("ide", "free")).resolves.toBe(true);
    expect(asked).toEqual({ projectId: "ide", branch: "free" });
    expect(useLaunchStore.getState()).toMatchObject({ branch: "free", targetPath: plan.path, worktreePlan: plan, repoTop: null });
    let sent: { request: LaunchRequest } | null = null;
    const picks = [plan.path, "/p/ide"];
    runtime({
      project_pick_folder: () => picks.shift() ?? null,
      session_launch: (args) => {
        sent = args as { request: LaunchRequest };
        return { session_id: "s1", term };
      },
      workspace_set_expanded: () => workspace(true),
    });
    await pickAddDir();
    await pickAddDir();
    // The worktree is the folder now; the project folder is an ordinary extra folder.
    expect(useLaunchStore.getState().form?.addDirs).toEqual(["/p/ide"]);
    await expect(startLaunch()).resolves.toBe(true);
    expect(sent!.request).toMatchObject({ branch: "free", createWorktree: true, worktreeName: null, addDirs: ["/p/ide"] });

    // A plan Rust refused blocks Start.
    runtime({
      launch_defaults: () => ({
        sessionId: "4b5c-id",
        name: "ide-4b5c",
        model: "default",
        effort: "default",
        permissionMode: "default",
        branch: "free",
        targetPath: null,
        worktreePlan: { command: null, path: null, error: "folder already exists: /p/ide/.worktrees/free" },
        repoTop: null,
      }),
    });
    await expect(openLaunchSheet("ide", "free")).resolves.toBe(true);
    await expect(startLaunch()).resolves.toBe(false);

    // The project's sheet keeps the project folder and gets the repo's top level.
    runtime({ launch_defaults: () => ({ sessionId: "5c6d-id", name: "ide-5c6d", model: "default", effort: "default", permissionMode: "default", repoTop: "/p/ide" }) });
    await expect(openLaunchSheet("ide")).resolves.toBe(true);
    expect(useLaunchStore.getState()).toMatchObject({ branch: null, targetPath: "/p/ide", worktreePlan: null, repoTop: "/p/ide" });
  });

  it("a failed start whose worktree was made re-reads the branch: the new folder, no plan, the form and error kept", async () => {
    const plan = { command: "git worktree add /p/ide/.worktrees/free free", path: "/p/ide/.worktrees/free", error: null };
    runtime({
      launch_defaults: () => ({ sessionId: "3f2a-id", name: "ide-3f2a", model: "default", effort: "default", permissionMode: "default", branch: "free", targetPath: plan.path, worktreePlan: plan, repoTop: null }),
    });
    await openLaunchSheet("ide", "free");
    useLaunchStore.getState().edit({ prompt: "hi" });
    const invoke = runtime({
      session_launch: () => {
        throw "could not start no-claude.exe";
      },
      launch_defaults: () => ({ sessionId: "4b5c-id", name: "ide-4b5c", model: "default", effort: "default", permissionMode: "default", branch: "free", targetPath: plan.path, worktreePlan: null, repoTop: null }),
    });
    await expect(startLaunch()).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledWith("launch_defaults", { projectId: "ide", branch: "free" }, undefined);
    expect(useLaunchStore.getState()).toMatchObject({
      branch: "free",
      targetPath: plan.path,
      worktreePlan: null,
      sessionId: "4b5c-id",
      error: "could not start no-claude.exe",
      starting: false,
    });
    expect(useLaunchStore.getState().form).toMatchObject({ name: "ide-3f2a", prompt: "hi" });
    // A retry no longer asks for a worktree, under the new id.
    let sent: { request: LaunchRequest } | null = null;
    runtime({
      session_launch: (args) => {
        sent = args as { request: LaunchRequest };
        return { session_id: "4b5c-id", term };
      },
      workspace_set_expanded: () => workspace(true),
    });
    await expect(startLaunch()).resolves.toBe(true);
    expect(sent!.request).toMatchObject({ sessionId: "4b5c-id", branch: "free", createWorktree: false });
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

describe("resume, fork and stop (Story 4.4)", () => {
  const historic: ChildNode = {
    id: "orig",
    projectId: "ide",
    kind: "session",
    label: "ide-59cd",
    detail: null,
    position: null,
    session: { startedAt: "2026-10-18T10:00:00.000Z", lastActive: "2026-10-18T10:05:00.000Z", branch: null, messages: 4 },
    branchId: null,
    forkedFrom: null,
    hasTranscript: true, branch: null,
  };
  const choices = { model: "opus", effort: "default", permission_mode: "plan" };
  const liveOnly: ChildNode = { ...historic, id: "fresh", hasTranscript: false, branch: null, session: { startedAt: "", lastActive: "", branch: null, messages: 0 } };

  function live(states: Record<string, SessionState>): void {
    const sessions = Object.fromEntries(
      Object.entries(states).map(([id, state]) => [
        id,
        { state, source: "poll", pid: null, kind: null, name: null, project_id: "ide", cwd: "/p/ide", started_at: null, attention_since: null, last_line: null, detail: null } as LiveSession,
      ]),
    );
    useLiveStore.getState().applySnapshot({ sessions, elsewhere: [], banner: null });
  }

  function sessionTerm(id: string, overrides: Partial<TermInfo> = {}): TermInfo {
    return { ...term, id: `session:${id}`, title: id, ...overrides };
  }

  beforeEach(() => {
    const snapshot = workspace(true);
    useWorkspaceStore.setState({ snapshot: { ...snapshot, children: [historic, liveOnly] }, loadError: null });
    useUiStore.setState({ pane: null, selection: { kind: "session", id: "orig" }, notice: null, activeTerminal: null, openTerminals: [], poppedOut: {} });
    useTerminalStore.setState({ infos: {}, pendingExits: {} });
    useLiveStore.setState({ snapshot: EMPTY_LIVE, received: false, loadError: null });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Resume is offered for a session with a transcript that is not live; Fork for any with a transcript", () => {
    expect(hasTranscript(historic)).toBe(true);
    expect(hasTranscript(liveOnly)).toBe(false);
    // Historic (never seen this run), then exited: Resume and Fork.
    expect([canResumeSession(), canForkSession(), canStopSession()]).toEqual([true, true, false]);
    live({ orig: { kind: "exited" } });
    expect([canResumeSession(), canForkSession()]).toEqual([true, true]);
    // Live (here or elsewhere, starting included): Fork only.
    for (const state of [{ kind: "starting" }, { kind: "busy" }, { kind: "idle" }, { kind: "other", raw: "compacting" }] as SessionState[]) {
      live({ orig: state });
      expect([canResumeSession(), canForkSession()], state.kind).toEqual([false, true]);
    }
    // A running Switchboard terminal: Stop, and never Resume.
    live({ orig: { kind: "exited" } });
    useTerminalStore.getState().upsert(sessionTerm("orig"));
    expect([canResumeSession(), canStopSession()]).toEqual([false, true]);
    useTerminalStore.getState().markExited("session:orig", 0);
    expect([canResumeSession(), canStopSession()]).toEqual([true, false]);
    // No transcript (a live-only child), or no session selected: neither.
    useUiStore.setState({ selection: { kind: "session", id: "fresh" } });
    expect([canResumeSession(), canForkSession()]).toEqual([false, false]);
    useUiStore.setState({ selection: { kind: "project", id: "ide" } });
    expect([canResumeSession(), canForkSession(), canStopSession()]).toEqual([false, false, false]);
  });

  it("Resume starts at once: the old exited terminal is replaced, the node selected, the pane open on it", async () => {
    useTerminalStore.getState().upsert(sessionTerm("orig", { exited: 0 }));
    const invoke = runtime({ session_resume: () => ({ session_id: "orig", term: sessionTerm("orig"), choices }) });
    await expect(resumeSelectedSession()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("session_resume", { projectId: "ide", sessionId: "orig", cols: null, rows: null }, undefined);
    expect(useUiStore.getState().notice).toEqual({ text: "resumed with model opus, effort default, mode plan" });
    expect(useTerminalStore.getState().infos["session:orig"]?.exited).toBeNull();
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "orig" });
    expect(useUiStore.getState().pane).toBe("terminal");
    expect(useUiStore.getState().activeTerminal).toBe("session:orig");
  });

  it("Resume over a popped-out terminal returns it to the pane only once the resume succeeded (Story 4.5)", async () => {
    useTerminalStore.getState().upsert(sessionTerm("orig", { exited: 0 }));
    useUiStore.setState({ poppedOut: { "session:orig": "term-1" }, openTerminals: [] });
    const order: string[] = [];
    runtime({
      session_resume: () => {
        order.push("session_resume");
        return { session_id: "orig", term: sessionTerm("orig"), choices };
      },
      term_return: () => {
        order.push("term_return");
      },
    });
    await expect(resumeSelectedSession()).resolves.toBe(true);
    expect(order).toEqual(["session_resume", "term_return"]);
    expect(useUiStore.getState().poppedOut).toEqual({});
  });

  it("a refused Resume over a popped-out terminal leaves it in its window", async () => {
    useTerminalStore.getState().upsert(sessionTerm("orig", { exited: 0 }));
    useUiStore.setState({ poppedOut: { "session:orig": "term-1" } });
    const invoke = runtime({
      session_resume: () => {
        throw "that session is already running";
      },
      term_buffer: () => ({ data: "", offset: 0 }),
    });
    await expect(resumeSelectedSession()).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalledWith("term_return", expect.anything(), undefined);
    expect(useUiStore.getState().poppedOut).toEqual({ "session:orig": "term-1" });
    useUiStore.setState({ poppedOut: {} });
  });

  it("a refused Resume is the notice, and the earlier run's terminal stays known", async () => {
    const old = sessionTerm("orig", { exited: 0 });
    useTerminalStore.getState().upsert(old);
    runtime({
      session_resume: () => {
        throw "that session is already running";
      },
      term_buffer: () => ({ data: "", offset: 0 }),
    });
    await expect(resumeSelectedSession()).resolves.toBe(false);
    expect(useUiStore.getState().notice).toEqual({ text: "that session is already running" });
    expect(useTerminalStore.getState().infos["session:orig"]).toEqual(old);
    expect(useUiStore.getState().pane).toBeNull();
  });

  it("Fork starts a new session at once and selects it", async () => {
    const invoke = runtime({ session_fork: () => ({ session_id: "fork-1", term: sessionTerm("fork-1"), choices }) });
    await expect(forkSelectedSession()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("session_fork", { projectId: "ide", sessionId: "orig", cols: null, rows: null }, undefined);
    expect(useUiStore.getState().notice).toEqual({ text: "forked with model opus, effort default, mode plan" });
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "fork-1" });
    expect(useUiStore.getState().activeTerminal).toBe("session:fork-1");
  });

  it("a second Fork of the same session while the first is in flight is refused with a notice", async () => {
    let release: (value: unknown) => void = () => {};
    const invoke = runtime({
      session_fork: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const first = forkSelectedSession();
    await flush();
    await expect(forkSelectedSession()).resolves.toBe(false);
    expect(useUiStore.getState().notice).toEqual({ text: "a fork of that session is already starting" });
    expect(invoke).toHaveBeenCalledTimes(1);
    release({ session_id: "fork-1", term: sessionTerm("fork-1"), choices });
    await expect(first).resolves.toBe(true);
    expect(startedNotice("forked", { model: "default", effort: "high", permission_mode: "default" })).toBe(
      "forked with model default, effort high, mode default",
    );
  });

  it("Stop marks the terminal stopping, keeps an exit that overtook the reply, and a refusal is the notice", async () => {
    useTerminalStore.getState().upsert(sessionTerm("orig"));
    const invoke = runtime({ session_stop: () => sessionTerm("orig", { stopping: true }) });
    await expect(stopSelectedSession()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("session_stop", { sessionId: "orig" }, undefined);
    expect(useTerminalStore.getState().infos["session:orig"]?.stopping).toBe(true);

    runtime({
      session_stop: () => {
        useTerminalStore.getState().markExited("session:orig", 1);
        return sessionTerm("orig", { stopping: true });
      },
    });
    await expect(stopSelectedSession()).resolves.toBe(true);
    expect(useTerminalStore.getState().infos["session:orig"]?.exited).toBe(1);

    runtime({
      session_stop: () => {
        throw "only a session running in a Switchboard terminal can be stopped";
      },
    });
    await expect(stopSelectedSession()).resolves.toBe(false);
    expect(useUiStore.getState().notice).toEqual({ text: "only a session running in a Switchboard terminal can be stopped" });
  });
});
