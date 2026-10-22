import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildNode, Edge, NodeRef, Project, WorkspaceSnapshot } from "../ipc";
import { paletteRows, runPaletteRow, usePaletteStore } from "../state/palette";
import { acknowledgeIfNeeded, followSelection, useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { registerBuiltins } from "./builtins";
import {
  canDeleteEdge,
  canRestartEdge,
  canRetryEdge,
  canSelectEdge,
  clickEdge,
  link,
  refuseDrop,
  restartedNotice,
  retryableSides,
  retryEdge,
  saveEdgeLabel,
  selectedEdge,
  startLink,
  startSelectEdge,
} from "./edges";
import { TYPING_DETAIL, useEdgesLiveStore } from "../state/edgesLive";
import { useTerminalStore } from "../state/terminals";
import { handleKeydown, type KeyEventLike } from "./keybindings";
import { clearCommands, listCommands, runCommand } from "./registry";

vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
  edgeAdd: vi.fn(),
  edgeRemove: vi.fn(),
  edgeSetLabel: vi.fn(),
  edgeLiveRetry: vi.fn(),
  edgeRestartWithFlags: vi.fn(),
}));

vi.mock("../terminal/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal/registry")>()),
  disposeView: vi.fn(),
  restore: vi.fn(() => Promise.resolve()),
}));

const ipc = await import("../ipc");
const edgeAdd = vi.mocked(ipc.edgeAdd);
const edgeRemove = vi.mocked(ipc.edgeRemove);
const edgeSetLabel = vi.mocked(ipc.edgeSetLabel);
const edgeLiveRetry = vi.mocked(ipc.edgeLiveRetry);
const edgeRestartWithFlags = vi.mocked(ipc.edgeRestartWithFlags);
const registry = await import("../terminal/registry");

function key(k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, preventDefault: () => {}, ...mods };
}

const project = (id: string): Project => ({
  id,
  path: `/p/${id}`,
  label: id,
  position: { x: 0, y: 0 },
  expanded: true,
  color: null,
  launchDefaults: null,
  showBranches: false,
});

const session = (id: string, projectId: string): ChildNode => ({
  id,
  projectId,
  kind: "session",
  label: `title ${id}`,
  detail: "stub",
  position: null,
  session: null,
  branchId: null,
  forkedFrom: null,
  hasTranscript: false,
  branch: null,
});

const ref = (type: NodeRef["type"], id: string): NodeRef => ({ type, id });

const storedEdge = (id: string, label: string | null = null): Edge => ({
  id,
  from: ref("session", "s1"),
  to: ref("project", "b"),
  kind: "context",
  label,
  createdAt: "2026-10-21T10:00:00.000Z",
});

function snapshot(edges: Edge[], revision = 1): WorkspaceSnapshot {
  return {
    path: null,
    workspace: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      projects: [project("a"), project("b")],
      branches: [],
      sessions: [],
      edges,
      defaults: { model: null, effort: null, permissionMode: null },
    },
    banners: [],
    revision,
    branchErrors: {},
    children: [session("s1", "a"), session("s2", "b")],
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("edge commands (Story 6.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCommands();
    registerBuiltins();
    useWorkspaceStore.setState({ snapshot: snapshot([storedEdge("e1", "API shape")]), loadError: null });
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, notice: null, elsewhereOpen: false });
    usePaletteStore.setState({ isOpen: false, pick: null, query: "", selected: 0 });
  });
  afterEach(() => clearCommands());

  it("Delete is unbound unless an edge is selected; then it deletes the edge and clears the selection", async () => {
    expect(handleKeydown(key("Delete"))).toBe(false);
    useUiStore.getState().select({ kind: "session", id: "s1" });
    expect(handleKeydown(key("Delete"))).toBe(false);
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).not.toContain("edge.delete");
    // A selected edge that is no longer stored: still nothing.
    useUiStore.getState().select({ kind: "edge", id: "gone" });
    expect(canDeleteEdge()).toBe(false);

    edgeRemove.mockResolvedValue(snapshot([], 2));
    useUiStore.getState().select({ kind: "edge", id: "e1" });
    expect(selectedEdge()?.id).toBe("e1");
    expect(handleKeydown(key("Delete"))).toBe(true);
    await flush();
    expect(edgeRemove).toHaveBeenCalledWith("e1");
    expect(useWorkspaceStore.getState().snapshot?.workspace.edges).toEqual([]);
    expect(useUiStore.getState().selection).toBeNull();
  });

  it("Delete typed in a text field (the label) is the field's", () => {
    useUiStore.getState().select({ kind: "edge", id: "e1" });
    expect(handleKeydown(key("Delete", { target: { tagName: "INPUT" } }))).toBe(false);
    expect(edgeRemove).not.toHaveBeenCalled();
  });

  it("e on a selected session opens the palette as a pick list of its valid targets; Enter links, Esc cancels", async () => {
    expect(handleKeydown(key("e"))).toBe(false);
    useUiStore.getState().select({ kind: "session", id: "s1" });
    expect(handleKeydown(key("e"))).toBe(true);
    const palette = usePaletteStore.getState();
    expect(palette.isOpen).toBe(true);
    // `s1 → b` (context) is already linked, so `b` is not offered.
    expect(palette.pick?.items.map((i) => i.title)).toEqual(["context: a (a)", "cooperate: title s2 (b)"]);

    // Esc: the palette closes, nothing is linked.
    expect(runCommand("palette.close")).toBe(true);
    expect(usePaletteStore.getState().pick).toBeNull();
    expect(edgeAdd).not.toHaveBeenCalled();

    // Picking a row links.
    edgeAdd.mockResolvedValue(storedEdge("e2"));
    expect(startLink()).toBe(true);
    usePaletteStore.getState().pick?.onPick("session:s2");
    await flush();
    expect(edgeAdd).toHaveBeenCalledWith(ref("session", "s1"), ref("session", "s2"));
  });

  it("Link to… is offered on a selected session or project, not on a branch, an edge or nothing", () => {
    const enabled = () => listCommands({ enabledOnly: true }).map((c) => c.id);
    expect(enabled()).not.toContain("edge.link");
    useUiStore.getState().select({ kind: "project", id: "a" });
    expect(enabled()).toContain("edge.link");
    useUiStore.getState().select({ kind: "branch", id: "a:main" });
    expect(enabled()).not.toContain("edge.link");
    useUiStore.getState().select({ kind: "edge", id: "e1" });
    expect(enabled()).not.toContain("edge.link");
  });

  it("with nothing left to link to, e says so instead of opening an empty list", () => {
    useWorkspaceStore.setState({
      snapshot: { ...snapshot([]), workspace: { ...snapshot([]).workspace, projects: [project("a")] }, children: [] },
    });
    useUiStore.getState().select({ kind: "project", id: "a" });
    expect(startLink()).toBe(false);
    expect(usePaletteStore.getState().isOpen).toBe(false);
    expect(useUiStore.getState().notice).toEqual({ text: "nothing to link to" });
  });

  it("a link Rust refuses shows its reason as the notice; a refused drop shows the local reason; a drop on empty canvas nothing", async () => {
    edgeAdd.mockRejectedValue("already linked");
    await expect(link(ref("session", "s2"), ref("session", "s1"))).resolves.toBeNull();
    expect(useUiStore.getState().notice).toEqual({ text: "already linked" });

    useUiStore.getState().clearNotice();
    refuseDrop("a", null);
    expect(useUiStore.getState().notice).toBeNull();
    refuseDrop("session:s1", "more:a");
    expect(useUiStore.getState().notice).toBeNull();
    refuseDrop("a", "session:s1");
    expect(useUiStore.getState().notice).toEqual({ text: "can't link a project to a session" });
    refuseDrop("session:s1", "session:s1");
    expect(useUiStore.getState().notice).toEqual({ text: "can't link a node to itself" });
    refuseDrop("session:s1", "b");
    expect(useUiStore.getState().notice).toEqual({ text: "already linked" });
  });

  it("a label is sent trimmed, blank as null, and not at all when unchanged", async () => {
    edgeSetLabel.mockResolvedValue(snapshot([storedEdge("e1", "API")], 2));
    await expect(saveEdgeLabel("e1", "API shape")).resolves.toBe(true);
    expect(edgeSetLabel).not.toHaveBeenCalled();
    await saveEdgeLabel("e1", "  API  ");
    expect(edgeSetLabel).toHaveBeenLastCalledWith("e1", "API");
    await saveEdgeLabel("e1", "   ");
    expect(edgeSetLabel).toHaveBeenLastCalledWith("e1", null);
    await expect(saveEdgeLabel("nope", "x")).resolves.toBe(false);
  });

  it("a click on an edge selects it and opens the inspector; selecting a node closes it; a deleted edge is deselected", () => {
    clickEdge("e1");
    expect(useUiStore.getState().selection).toEqual({ kind: "edge", id: "e1" });
    expect(useUiStore.getState().pane).toBe("edge");
    // Esc closes the inspector first and keeps the edge selected.
    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();
    expect(useUiStore.getState().selection).toEqual({ kind: "edge", id: "e1" });
    expect(runCommand("edge.inspect")).toBe(true);
    expect(useUiStore.getState().pane).toBe("edge");

    useUiStore.getState().select({ kind: "session", id: "s1" });
    expect(useUiStore.getState().pane).toBeNull();

    clickEdge("e1");
    useWorkspaceStore.getState().applySnapshot(snapshot([], 5));
    expect(useUiStore.getState().selection).toBeNull();
    expect(useUiStore.getState().pane).toBeNull();
  });

  it("arrow keys never visit an edge: from a selected edge they select the node nearest the middle of the view", () => {
    useUiStore.getState().select({ kind: "edge", id: "e1" });
    expect(runCommand("selection.move.right")).toBe(true);
    // No canvas: the middle is (0, 0); project `a` (listed first, same spot as `b`) is nearest.
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "a" });
  });

  it("followSelection and acknowledgeIfNeeded ignore an edge", () => {
    useUiStore.setState({ pane: "terminal", activeTerminal: null, openTerminals: [] });
    followSelection({ kind: "edge", id: "e1" });
    expect(useUiStore.getState().activeTerminal).toBeNull();
    expect(acknowledgeIfNeeded({ kind: "edge", id: "e1" })).toBe(false);
  });

  it("run from the palette, Link to… keeps it open as a pick list; a pick row links and closes it", async () => {
    useUiStore.getState().select({ kind: "session", id: "s1" });
    usePaletteStore.getState().open();
    runPaletteRow("edge.link");
    expect(usePaletteStore.getState().isOpen).toBe(true);
    const pick = usePaletteStore.getState().pick;
    expect(pick?.placeholder).toBe("Link to…");
    // The rows are the pick's, matched on titles only (the ids are internal).
    expect(paletteRows(pick ?? null, [], "").map((r) => r.title)).toEqual(["context: a (a)", "cooperate: title s2 (b)"]);
    expect(paletteRows(pick ?? null, [], "session:")).toEqual([]);
    expect(paletteRows(pick ?? null, [], "s2").map((r) => [r.id, r.binding])).toEqual([["session:s2", null]]);

    edgeAdd.mockResolvedValue(storedEdge("e2"));
    runPaletteRow("session:s2");
    await flush();
    expect(edgeAdd).toHaveBeenCalledWith(ref("session", "s1"), ref("session", "s2"));
    expect(usePaletteStore.getState()).toMatchObject({ isOpen: false, pick: null });

    // A plain command runs and closes the palette.
    usePaletteStore.getState().open();
    runPaletteRow("settings.open");
    expect(usePaletteStore.getState().isOpen).toBe(false);
    expect(useUiStore.getState().pane).toBe("settings");
  });

  it("Select edge… lists the selected node's drawn edges and picking one selects it and opens the inspector", () => {
    expect(canSelectEdge()).toBe(false);
    useUiStore.getState().select({ kind: "project", id: "b" });
    expect(canSelectEdge()).toBe(true);
    expect(listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.id)).toContain("edge.select");
    expect(startSelectEdge()).toBe(true);
    const pick = usePaletteStore.getState().pick;
    expect(pick?.items).toEqual([{ id: "e1", title: "context: title s1 (a) — API shape" }]);
    runPaletteRow("e1");
    expect(useUiStore.getState().selection).toEqual({ kind: "edge", id: "e1" });
    expect(useUiStore.getState().pane).toBe("edge");
    // A node without drawn edges: not offered.
    useUiStore.getState().select({ kind: "session", id: "s2" });
    expect(canSelectEdge()).toBe(false);
  });

  it("an edge click while a sheet is open only selects; Inspect edge, or Enter with no pane, opens the inspector", () => {
    useUiStore.setState({ pane: "launch" });
    clickEdge("e1");
    expect(useUiStore.getState().selection).toEqual({ kind: "edge", id: "e1" });
    expect(useUiStore.getState().pane).toBe("launch");
    expect(runCommand("edge.inspect")).toBe(true);
    expect(useUiStore.getState().pane).toBe("edge");

    useUiStore.setState({ pane: null });
    expect(handleKeydown(key("Enter"))).toBe(true);
    expect(useUiStore.getState().pane).toBe("edge");
  });

  it("a selected edge whose end is hidden (its project collapsed) is deselected and its inspector closes", () => {
    clickEdge("e1");
    const collapsed = snapshot([storedEdge("e1", "API shape")], 2);
    collapsed.workspace.projects = [{ ...project("a"), expanded: false }, project("b")];
    useWorkspaceStore.getState().applySnapshot(collapsed);
    expect(useUiStore.getState().selection).toBeNull();
    expect(useUiStore.getState().pane).toBeNull();
    expect(handleKeydown(key("Delete"))).toBe(false);
  });

  it("a label save Rust rejects because the edge is gone is dropped without a banner", async () => {
    edgeSetLabel.mockRejectedValue("unknown edge");
    await expect(saveEdgeLabel("e1", "new")).resolves.toBe(false);
    expect(useWorkspaceStore.getState().loadError).toBeNull();
    edgeSetLabel.mockRejectedValue("disk full");
    await saveEdgeLabel("e1", "new");
    expect(useWorkspaceStore.getState().loadError).toBe("label edge failed: disk full");
  });
});

describe("edge commands on live sessions (Story 6.3)", () => {
  const projectEdge: Edge = { ...storedEdge("p1"), from: ref("project", "a") };
  const cooperate: Edge = { ...storedEdge("c1"), to: ref("session", "s2"), kind: "cooperate" };

  beforeEach(() => {
    vi.clearAllMocks();
    clearCommands();
    registerBuiltins();
    useWorkspaceStore.setState({ snapshot: snapshot([storedEdge("e1"), projectEdge, cooperate]), loadError: null });
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, notice: null, elsewhereOpen: false });
    useEdgesLiveStore.setState({ entries: {}, received: true, loadError: null });
    useTerminalStore.setState({ infos: {}, pendingExits: {} });
  });
  afterEach(() => clearCommands());

  const live = (state: "pending" | "applied" | "failed", detail: string | null = null) => ({
    e1: { state, detail, edgeId: "e1", sessionId: "s1", path: "/p/b" },
  });
  const side = (session: string, state: "pending" | "notified" | "failed", detail: string | null = null) => ({
    [`c1#${session}`]: { state, detail, edgeId: "c1", sessionId: session, path: null },
  });

  it("Restart with flags is offered for every context edge from a session; Retry only after a failure or a draft", () => {
    expect(canRestartEdge()).toBe(false);
    useUiStore.getState().select({ kind: "edge", id: "e1" });
    expect(canRestartEdge()).toBe(true);
    expect(canRetryEdge()).toBe(false);
    useEdgesLiveStore.setState({ entries: live("pending", "waiting for idle") });
    expect(canRetryEdge()).toBe(false);
    useEdgesLiveStore.setState({ entries: live("pending", TYPING_DETAIL) });
    expect(canRetryEdge()).toBe(true);
    useEdgesLiveStore.setState({ entries: live("failed", "not confirmed") });
    expect(canRetryEdge()).toBe(true);
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).toEqual(expect.arrayContaining(["edge.retry", "edge.restartWithFlags"]));
    useEdgesLiveStore.setState({ entries: live("applied") });
    expect(canRetryEdge()).toBe(false);
    // A project's edge (a launch default): neither. A cooperate edge: no Restart with flags.
    useUiStore.getState().select({ kind: "edge", id: "p1" });
    expect(canRestartEdge()).toBe(false);
    expect(canRetryEdge()).toBe(false);
    useUiStore.getState().select({ kind: "edge", id: "c1" });
    expect(canRestartEdge()).toBe(false);
  });

  it("Retry is offered for a cooperate edge with a failed or draft-held side and retries each such side (Story 6.4)", async () => {
    useUiStore.getState().select({ kind: "edge", id: "c1" });
    expect(canRetryEdge()).toBe(false);
    useEdgesLiveStore.setState({ entries: { ...side("s1", "notified"), ...side("s2", "pending", "waiting for idle") } });
    expect(canRetryEdge()).toBe(false);
    useEdgesLiveStore.setState({ entries: { ...side("s1", "failed", "not confirmed"), ...side("s2", "pending", TYPING_DETAIL) } });
    expect(canRetryEdge()).toBe(true);
    expect(retryableSides(cooperate)).toEqual(["s1", "s2"]);
    edgeLiveRetry.mockResolvedValue(undefined);
    expect(runCommand("edge.retry")).toBe(true);
    await flush();
    expect(edgeLiveRetry).toHaveBeenCalledWith("c1", "s1");
    expect(edgeLiveRetry).toHaveBeenCalledWith("c1", "s2");
    expect(useUiStore.getState().notice).toBeNull();
    edgeLiveRetry.mockRejectedValue("the session is not running in Switchboard");
    await expect(retryEdge("c1", "s1")).resolves.toBe(false);
    expect(useUiStore.getState().notice).toEqual({ text: "the session is not running in Switchboard" });
  });

  it("Retry edge calls Rust; a refusal is the notice", async () => {
    useUiStore.getState().select({ kind: "edge", id: "e1" });
    useEdgesLiveStore.setState({ entries: live("failed", "not confirmed") });
    edgeLiveRetry.mockResolvedValue(undefined);
    expect(runCommand("edge.retry")).toBe(true);
    await flush();
    expect(edgeLiveRetry).toHaveBeenCalledWith("e1");
    expect(useUiStore.getState().notice).toBeNull();
    edgeLiveRetry.mockRejectedValue("the session is not running in Switchboard");
    runCommand("edge.retry");
    await flush();
    expect(useUiStore.getState().notice).toEqual({ text: "the session is not running in Switchboard" });
  });

  it("Restart with flags calls Rust, starts the terminal's view afresh and names what it ran without", async () => {
    useUiStore.getState().select({ kind: "edge", id: "e1" });
    const term = { id: "session:s1", kind: "session", project_id: "a", title: "s1", cwd: "/p/a", exited: null, error: null, cols: 80, rows: 24, stopping: false } as const;
    useTerminalStore.getState().upsert({ ...term, exited: 0 });
    edgeRestartWithFlags.mockResolvedValue({
      session_id: "s1",
      term,
      choices: { model: "default", effort: "default", permission_mode: "default" },
      skipped: [{ label: "ui:feat", reason: "no worktree" }],
    });
    expect(runCommand("edge.restartWithFlags")).toBe(true);
    await flush();
    expect(edgeRestartWithFlags).toHaveBeenCalledWith("e1");
    expect(registry.disposeView).toHaveBeenCalledWith("session:s1");
    expect(registry.restore).toHaveBeenCalledWith("session:s1");
    expect(useTerminalStore.getState().infos["session:s1"]?.exited).toBeNull();
    expect(useUiStore.getState().notice).toEqual({ text: "restarted without: ui:feat (no worktree) · restarted with flags" });

    edgeRestartWithFlags.mockRejectedValue("that session has no transcript to resume");
    runCommand("edge.restartWithFlags");
    await flush();
    expect(useUiStore.getState().notice).toEqual({ text: "that session has no transcript to resume" });
    expect(restartedNotice([])).toBe("restarted with flags");
  });
});
