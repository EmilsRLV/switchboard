import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildNode, LiveSession, LiveSnapshot, Project, SessionState, WorkspaceSnapshot } from "../ipc";
import { useCanvasStore } from "../state/canvas";
import { EMPTY_LIVE, isAcknowledging, unmarkAcknowledging, useLiveStore } from "../state/live";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { attentionTargets, canGoToAttention, goToNextAttention, revealFailedNotice, revealSession, revealToastSession } from "./attention";
import { clickNode } from "./navigation";

function project(id: string, expanded: boolean): Project {
  return { id, path: `/p/${id}`, label: id, position: { x: 0, y: 0 }, expanded, color: null, launchDefaults: null, showBranches: false };
}

function session(id: string, projectId: string): ChildNode {
  return { id, projectId, kind: "session", label: id, detail: null, position: null, session: null, branchId: null, forkedFrom: null, hasTranscript: false, branch: null };
}

function workspace(projects: Project[], children: ChildNode[], revision = 1): WorkspaceSnapshot {
  return {
    path: null,
    workspace: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      projects,
      branches: [],
      sessions: [],
      edges: [],
      defaults: { model: null, effort: null, permissionMode: null },
    },
    banners: [],
    revision,
    branchErrors: {},
    children,
  };
}

function live(states: Record<string, [SessionState, number | null]>, elsewhere: string[] = []): LiveSnapshot {
  const sessions: Record<string, LiveSession> = {};
  for (const [id, [state, since]] of Object.entries(states)) {
    sessions[id] = {
      state,
      source: "poll",
      pid: 1,
      kind: "interactive",
      name: id,
      project_id: elsewhere.includes(id) ? null : "ide",
      cwd: "/p/ide",
      started_at: 1,
      attention_since: since,
      last_line: null,
      detail: null,
    };
  }
  const rows = elsewhere.map((id) => ({ session_id: id, state: sessions[id]!.state, name: id, cwd: "/work/x", started_at: 1 }));
  return { sessions, elsewhere: rows, banner: null };
}

const FINISHED: SessionState = { kind: "finished" };
const IDLE: SessionState = { kind: "idle" };

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/**
 * A fake Rust behind `invoke`: `workspace_set_expanded` replies with the project expanded (or
 * runs `onExpand` first), `session_acknowledge` turns a session whose `attention_since`
 * matches idle and replies with the new snapshot (no event: the reply alone must clear it).
 */
function fakeRust(onExpand?: () => void) {
  const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "workspace_set_expanded") {
      onExpand?.();
      const current = useWorkspaceStore.getState().snapshot!;
      const projects = current.workspace.projects.map((p) => (p.id === args.projectId ? { ...p, expanded: args.expanded as boolean } : p));
      return workspace(projects, current.children, current.revision + 1);
    }
    if (cmd === "session_acknowledge") {
      const snap = useLiveStore.getState().snapshot;
      const id = args.sessionId as string;
      const s = snap.sessions[id];
      if (s === undefined || (s.state.kind !== "finished" && s.state.kind !== "waiting") || s.attention_since !== args.attentionSince) return null;
      const acked = { ...s, state: IDLE, source: "ack" as const, attention_since: null };
      return {
        ...snap,
        sessions: { ...snap.sessions, [id]: acked },
        elsewhere: snap.elsewhere.map((r) => (r.session_id === id ? { ...r, state: IDLE } : r)),
      };
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  return invoke;
}

describe("attention", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ snapshot: null, loadError: null });
    useUiStore.setState({ pane: null, flashed: [], selection: null, contextMenu: null, notice: null, showAll: [], elsewhereOpen: false });
    useLiveStore.setState({ snapshot: EMPTY_LIVE, received: false, loadError: null });
    useCanvasStore.setState({ instance: null, element: null, dragging: {} });
    for (const id of ["s1", "s2", "s3", "e1", "k11"]) unmarkAcknowledging(id);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("is enabled only while a session on a canvas project needs attention", () => {
    expect(canGoToAttention()).toBe(false);
    useWorkspaceStore.setState({ snapshot: workspace([project("ide", false)], [session("s1", "ide")]) });
    useLiveStore.getState().applySnapshot(live({ s1: [IDLE, null], e1: [FINISHED, 1] }, ["e1"]));
    expect(canGoToAttention(), "an Elsewhere session is not on the canvas").toBe(false);
    useLiveStore.getState().applySnapshot(live({ s1: [FINISHED, 1] }));
    expect(canGoToAttention()).toBe(true);
  });

  it("goes to the longest-waiting session: expands its collapsed project, selects and acknowledges it; again → the other", async () => {
    const invoke = fakeRust();
    useWorkspaceStore.setState({ snapshot: workspace([project("ide", false)], [session("s1", "ide"), session("s2", "ide")]) });
    useLiveStore.getState().applySnapshot(live({ s1: [FINISHED, 20], s2: [FINISHED, 10] }));
    expect(attentionTargets().map((t) => t.sessionId)).toEqual(["s2", "s1"]);

    const first = goToNextAttention();
    // Marked before the expand is awaited: a second press now moves on.
    expect(attentionTargets().map((t) => t.sessionId)).toEqual(["s1"]);
    await expect(first).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("workspace_set_expanded", { projectId: "ide", expanded: true }, undefined);
    expect(useWorkspaceStore.getState().snapshot?.workspace.projects[0]?.expanded).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s2" });
    expect(invoke).toHaveBeenCalledWith("session_acknowledge", { sessionId: "s2", attentionSince: 10 }, undefined);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "session_acknowledge")).toHaveLength(1);

    await expect(goToNextAttention()).resolves.toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s1" });
    await flush();
    // The replies alone (no event) cleared both.
    expect(useLiveStore.getState().snapshot.sessions.s1?.state).toEqual(IDLE);
    expect(useLiveStore.getState().snapshot.sessions.s2?.state).toEqual(IDLE);
    expect(canGoToAttention()).toBe(false);
    await expect(goToNextAttention()).resolves.toBe(false);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "workspace_set_expanded")).toHaveLength(1);
  });

  it("a session past the cut turns show-all on, and never off when it already is", async () => {
    fakeRust();
    const kids = Array.from({ length: 12 }, (_, i) => session(`k${i}`, "ide"));
    useWorkspaceStore.setState({ snapshot: workspace([project("ide", true)], kids) });
    useLiveStore.getState().applySnapshot(live({ k11: [FINISHED, 1] }));
    await expect(revealSession("k11")).resolves.toBe(true);
    expect(useUiStore.getState().showAll).toEqual(["ide"]);
    await flush();
    useLiveStore.getState().applySnapshot(live({ k11: [FINISHED, 2] }));
    useUiStore.getState().clearSelection();
    await expect(revealSession("k11")).resolves.toBe(true);
    expect(useUiStore.getState().showAll, "still on").toEqual(["ide"]);
  });

  it("an already-selected session is acknowledged by the reveal too", async () => {
    const invoke = fakeRust();
    useWorkspaceStore.setState({ snapshot: workspace([project("ide", true)], [session("s1", "ide")]) });
    useLiveStore.getState().applySnapshot(live({ s1: [IDLE, null] }));
    useUiStore.getState().select({ kind: "session", id: "s1" });
    // It finishes while selected: the selection does not change, the reveal still acknowledges.
    useLiveStore.getState().applySnapshot(live({ s1: [FINISHED, 2] }));
    await expect(revealSession("s1")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("session_acknowledge", { sessionId: "s1", attentionSince: 2 }, undefined);
  });

  it("a session or project gone while the expand was awaited fails, unmarks and shows a notice", async () => {
    vi.useFakeTimers();
    fakeRust(() => useWorkspaceStore.setState({ snapshot: workspace([project("ide", false)], []) }));
    useWorkspaceStore.setState({ snapshot: workspace([project("ide", false)], [session("s1", "ide")]) });
    useLiveStore.getState().applySnapshot(live({ s1: [FINISHED, 1] }));
    await expect(goToNextAttention()).resolves.toBe(false);
    expect(isAcknowledging("s1")).toBe(false);
    expect(useUiStore.getState().selection).toBeNull();
    expect(useUiStore.getState().notice?.text).toBe(revealFailedNotice("s1"));
  });

  it("a click on the selected session that needs attention acknowledges it; selecting a project acknowledges nothing", async () => {
    const invoke = fakeRust();
    useWorkspaceStore.setState({ snapshot: workspace([project("ide", true)], [session("s1", "ide")]) });
    useLiveStore.getState().applySnapshot(live({ s1: [IDLE, null] }));
    clickNode("session:s1");
    expect(invoke).not.toHaveBeenCalled();
    useLiveStore.getState().applySnapshot(live({ s1: [FINISHED, 1] }));
    clickNode("ide");
    expect(invoke).not.toHaveBeenCalled();
    clickNode("session:s1");
    expect(invoke).toHaveBeenCalledWith("session_acknowledge", { sessionId: "s1", attentionSince: 1 }, undefined);
    await flush();
    expect(useLiveStore.getState().snapshot.sessions.s1?.state).toEqual(IDLE);
  });

  it("a toast click reveals and selects its session while it still needs you", async () => {
    fakeRust();
    useWorkspaceStore.setState({ snapshot: workspace([project("ide", false)], [session("s1", "ide")]) });
    useLiveStore.getState().applySnapshot(live({ s1: [IDLE, null] }));
    await expect(revealToastSession({ session_id: "s1", project_id: "ide" })).resolves.toBe(false);
    expect(useUiStore.getState().selection).toBeNull();
    expect(useWorkspaceStore.getState().snapshot?.workspace.projects[0]?.expanded).toBe(false);

    useLiveStore.getState().applySnapshot(live({ s1: [FINISHED, 1] }));
    await expect(revealToastSession({ session_id: "s1", project_id: "ide" })).resolves.toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s1" });
    expect(useWorkspaceStore.getState().snapshot?.workspace.projects[0]?.expanded).toBe(true);
    await flush();
    expect(useLiveStore.getState().snapshot.sessions.s1?.state).toEqual(IDLE);
  });

  it("a toast click on an Elsewhere session opens the tray, which acknowledges it", async () => {
    const invoke = fakeRust();
    useWorkspaceStore.setState({ snapshot: workspace([project("ide", false)], []) });
    useLiveStore.getState().applySnapshot(live({ e1: [FINISHED, 1] }, ["e1"]));
    await expect(revealToastSession({ session_id: "e1", project_id: null })).resolves.toBe(true);
    expect(useUiStore.getState().elsewhereOpen).toBe(true);
    expect(useUiStore.getState().selection).toBeNull();
    expect(invoke).toHaveBeenCalledWith("session_acknowledge", { sessionId: "e1", attentionSince: 1 }, undefined);
    await flush();
    expect(useLiveStore.getState().snapshot.elsewhere[0]?.state).toEqual(IDLE);
  });
});
