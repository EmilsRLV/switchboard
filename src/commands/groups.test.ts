// Story 12.3: the group commands, the runtime Go-to commands, Enter, the arrows, the reveal into a
// collapsed group, and the frame/card drag, against a fake Rust behind `invoke`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildNode, Edge, Group, LiveSnapshot, Position, Project, Viewport, WorkspaceSnapshot } from "../ipc";
import { CARD_HEIGHT, CARD_WIDTH, GROUP_LABEL_HEIGHT, GROUP_PADDING } from "../canvas/nodes";
import { useCanvasStore, type CanvasInstance } from "../state/canvas";
import { EMPTY_LIVE, unmarkAcknowledging, useLiveStore } from "../state/live";
import { paletteRows, runPaletteRow, submitPalettePrompt, usePaletteStore } from "../state/palette";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { revealAgent, revealSession } from "./attention";
import { registerBuiltins } from "./builtins";
import { dragGroupTo, dropGroup, NEW_GROUP_ROW, startGroupDrag } from "./groups";
import { handleKeydown, type KeyEventLike } from "./keybindings";
import { activateSelection, moveSelection } from "./navigation";
import { nodeMenuCommands } from "./nodes";
import { clearCommands, listCommands, runCommand } from "./registry";

function project(id: string, x: number, groupId: string | null = null, expanded = false): Project {
  return { id, path: `/p/${id}`, label: id, position: { x, y: 0 }, expanded, color: null, launchDefaults: null, showBranches: false, groupId };
}

function session(id: string, projectId: string): ChildNode {
  return { id, projectId, kind: "session", label: id, detail: null, position: null, session: null, branchId: null, forkedFrom: null, hasTranscript: false, branch: null };
}

function agentChild(id: string, projectId: string): ChildNode {
  return { ...session(id, projectId), kind: "agent", agent: { agent: "kimi", startedAt: "", exited: 0, attention: true } };
}

function edge(id: string, from: string, to: string): Edge {
  return { id, from: { type: "project", id: from }, to: { type: "project", id: to }, kind: "context", label: null, createdAt: "" };
}

function fakeCanvas(viewport: Viewport = { x: 0, y: 0, zoom: 1 }): CanvasInstance & { setViewport: ReturnType<typeof vi.fn> } {
  let current = viewport;
  return {
    getNodes: () => [],
    getViewport: () => current,
    setViewport: vi.fn(async (next: Viewport) => {
      current = next;
      return true;
    }),
    fitView: vi.fn(async () => true),
    screenToFlowPosition: (client: Position) => ({ x: (client.x - current.x) / current.zoom, y: (client.y - current.y) / current.zoom }),
  };
}

function snapshotOf(projects: Project[], groups: Group[], children: ChildNode[] = [], revision = 1, edges: Edge[] = []): WorkspaceSnapshot {
  return {
    path: null,
    workspace: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      projects,
      branches: [],
      sessions: [],
      edges,
      defaults: { model: null, effort: null, permissionMode: null },
      ...(groups.length === 0 ? {} : { groups }),
    },
    banners: [],
    revision,
    branchErrors: {},
    children,
  };
}

function key(k: string): KeyEventLike {
  return { key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, preventDefault: () => {} };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** The current snapshot with `change` applied and the revision bumped: what Rust would reply. */
function next(change: (projects: Project[], groups: Group[]) => [Project[], Group[]]): WorkspaceSnapshot {
  const current = useWorkspaceStore.getState().snapshot!;
  const [projects, groups] = change(current.workspace.projects, current.workspace.groups ?? []);
  const used = new Set(projects.map((p) => p.groupId));
  return snapshotOf(projects, groups.filter((g) => used.has(g.id)), current.children, current.revision + 1);
}

/** A fake Rust for the group IPCs (the label and colour rules as Rust applies them). */
function fakeRust(refuseMoves = false) {
  const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "group_create": {
        const label = String(args.label).replace(/\s*\p{Cc}+\s*/gu, " ").trim();
        if (label === "") throw "group label is blank";
        return next((ps, gs) => [ps.map((p) => (p.id === args.projectId ? { ...p, groupId: "new" } : p)), [...gs, { id: "new", label, color: null, collapsed: false }]]);
      }
      case "group_add":
        return next((ps, gs) => [ps.map((p) => (p.id === args.projectId ? { ...p, groupId: args.groupId as string } : p)), gs]);
      case "group_remove":
        return next((ps, gs) => [ps.map((p) => (p.id === args.projectId ? { ...p, groupId: null } : p)), gs]);
      case "group_rename":
        return next((ps, gs) => [ps, gs.map((g) => (g.id === args.groupId ? { ...g, label: args.label as string } : g))]);
      case "group_set_color":
        return next((ps, gs) => [ps, gs.map((g) => (g.id === args.groupId ? { ...g, color: args.color as string | null } : g))]);
      case "group_collapse":
        return next((ps, gs) => [ps, gs.map((g) => (g.id === args.groupId ? { ...g, collapsed: args.collapsed as boolean } : g))]);
      case "group_delete":
        return next((ps, gs) => [ps.map((p) => (p.groupId === args.groupId ? { ...p, groupId: null } : p)), gs.filter((g) => g.id !== args.groupId)]);
      case "workspace_move_nodes": {
        if (refuseMoves) throw "unknown project";
        const moves = args.moves as { target: { id: string }; position: { x: number; y: number } }[];
        return next((ps, gs) => [ps.map((p) => ({ ...p, position: moves.find((m) => m.target.id === p.id)?.position ?? p.position })), gs]);
      }
      case "workspace_set_expanded":
        return next((ps, gs) => [ps.map((p) => (p.id === args.projectId ? { ...p, expanded: args.expanded as boolean } : p)), gs]);
      case "session_acknowledge":
        return null;
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  return invoke;
}

const WEB: Group = { id: "gw", label: "web", color: null, collapsed: false };
const TOOLS: Group = { id: "gt", label: "tools", color: null, collapsed: false };

describe("group commands", () => {
  beforeEach(() => {
    clearCommands();
    useWorkspaceStore.setState({ snapshot: null, loadError: null });
    usePaletteStore.setState({ isOpen: false, pick: null, prompt: null, query: "", selected: 0 });
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, notice: null, showAll: [], showAllBranches: [], elsewhereOpen: false });
    useLiveStore.setState({ snapshot: EMPTY_LIVE, received: false, loadError: null });
    useCanvasStore.setState({ instance: null, element: null, dragging: {} });
  });
  afterEach(() => {
    clearCommands();
    vi.unstubAllGlobals();
  });

  it("lists one Go to group per group, following a rename", () => {
    const stop = registerBuiltins();
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw"), project("b", 300, "gt")], [WEB, TOOLS]) });
    const goTo = () => paletteRows(null, listCommands({ enabledOnly: true, visibleOnly: true }), "go to").map((r) => r.title).filter((t) => t.startsWith("Go to group"));
    expect(goTo()).toEqual(["Go to group: tools", "Go to group: web"]);
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw"), project("b", 300, "gt")], [{ ...WEB, label: "site" }, TOOLS], [], 2) });
    expect(goTo()).toEqual(["Go to group: site", "Go to group: tools"]);
    // A deleted group's command goes; stopping the watch takes the rest.
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0), project("b", 300, "gt")], [TOOLS], [], 3) });
    expect(goTo()).toEqual(["Go to group: tools"]);
    stop();
    expect(goTo()).toEqual([]);
  });

  it("Go to group selects the group", () => {
    registerBuiltins();
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw")], [WEB]) });
    expect(runCommand("group.goto.gw")).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "group", id: "gw" });
  });

  it("a selected group offers Rename, Set colour, Expand/Collapse and Delete; a selected project does not", () => {
    registerBuiltins();
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw")], [{ ...WEB, collapsed: true }]) });
    useUiStore.getState().select({ kind: "group", id: "gw" });
    const titles = () => listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.title);
    expect(titles()).toEqual(expect.arrayContaining(["Rename group…", "Set group colour…", "Expand group", "Delete group"]));
    expect(titles()).not.toContain("Collapse group");
    expect(nodeMenuCommands().map((c) => c.title)).toEqual(["Rename group…", "Set group colour…", "Expand group", "Delete group"]);

    useUiStore.getState().select({ kind: "project", id: "a" });
    for (const title of ["Rename group…", "Set group colour…", "Expand group", "Collapse group", "Delete group"]) expect(titles()).not.toContain(title);
    expect(titles()).toEqual(expect.arrayContaining(["Add to group…", "Remove from group"]));
  });

  it("g on a project lists the groups plus New group…; New group… prompts and creates", async () => {
    const invoke = fakeRust();
    registerBuiltins();
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0), project("b", 300, "gw")], [WEB]) });
    useUiStore.getState().select({ kind: "project", id: "a" });
    expect(handleKeydown(key("g"))).toBe(true);
    const palette = usePaletteStore.getState();
    expect(palette.pick?.items).toEqual([
      { id: "gw", title: "web" },
      { id: NEW_GROUP_ROW, title: "New group…" },
    ]);
    runPaletteRow(NEW_GROUP_ROW);
    expect(usePaletteStore.getState().prompt?.initial).toBe("");
    usePaletteStore.getState().setQuery("  web\u0007 apps ");
    submitPalettePrompt();
    await flush();
    expect(invoke).toHaveBeenCalledWith("group_create", { label: "  web\u0007 apps ", projectId: "a" }, undefined);
    expect(useWorkspaceStore.getState().snapshot?.workspace.projects[0]?.groupId).toBe("new");

    // A project already in a group: its own group is left out of the list.
    useUiStore.getState().select({ kind: "project", id: "b" });
    runCommand("group.add");
    expect(usePaletteStore.getState().pick?.items.map((i) => i.title)).toEqual(["web apps", "New group…"]);
  });

  it("a blank label is refused with the notice and creates nothing", async () => {
    fakeRust();
    registerBuiltins();
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0)], []) });
    useUiStore.getState().select({ kind: "project", id: "a" });
    runCommand("group.add");
    runPaletteRow(NEW_GROUP_ROW);
    usePaletteStore.getState().setQuery("   ");
    submitPalettePrompt();
    await flush();
    expect(useUiStore.getState().notice?.text).toBe("group label is blank");
    expect(useWorkspaceStore.getState().snapshot?.workspace.groups).toBeUndefined();
  });

  it("picking a group adds the project; Remove from group takes it out", async () => {
    const invoke = fakeRust();
    registerBuiltins();
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0), project("b", 300, "gw")], [WEB]) });
    useUiStore.getState().select({ kind: "project", id: "a" });
    runCommand("group.add");
    runPaletteRow("gw");
    await flush();
    expect(invoke).toHaveBeenCalledWith("group_add", { groupId: "gw", projectId: "a" }, undefined);
    runCommand("group.remove");
    await flush();
    expect(invoke).toHaveBeenCalledWith("group_remove", { projectId: "a" }, undefined);
  });

  it("Rename prompts prefilled; Set colour lists the five plus None; Delete clears the selection", async () => {
    const invoke = fakeRust();
    registerBuiltins();
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw")], [WEB]) });
    useUiStore.getState().select({ kind: "group", id: "gw" });
    runCommand("group.rename");
    expect(usePaletteStore.getState().prompt?.initial).toBe("web");
    usePaletteStore.getState().setQuery("site");
    submitPalettePrompt();
    await flush();
    expect(invoke).toHaveBeenCalledWith("group_rename", { groupId: "gw", label: "site" }, undefined);

    runCommand("group.setColor");
    expect(usePaletteStore.getState().pick?.items.map((i) => i.title)).toEqual(["slate", "sage", "sand", "rose", "sky", "None"]);
    runPaletteRow("sage");
    await flush();
    expect(invoke).toHaveBeenCalledWith("group_set_color", { groupId: "gw", color: "sage" }, undefined);
    runCommand("group.setColor");
    runPaletteRow("none");
    await flush();
    expect(invoke).toHaveBeenCalledWith("group_set_color", { groupId: "gw", color: null }, undefined);

    runCommand("group.delete");
    await flush();
    expect(invoke).toHaveBeenCalledWith("group_delete", { groupId: "gw" }, undefined);
    expect(useUiStore.getState().selection).toBeNull();
  });

  it("Enter on a selected group toggles its collapse, expanded or collapsed", async () => {
    const invoke = fakeRust();
    registerBuiltins();
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw")], [WEB]) });
    useUiStore.getState().select({ kind: "group", id: "gw" });
    expect(await activateSelection()).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("group_collapse", { groupId: "gw", collapsed: true }, undefined);
    expect(useWorkspaceStore.getState().snapshot?.workspace.groups?.[0]?.collapsed).toBe(true);
    expect(await activateSelection()).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("group_collapse", { groupId: "gw", collapsed: false }, undefined);
  });

  it("the arrows visit a collapsed group's card like a project card", () => {
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw"), project("b", 300, "gw"), project("c", 900)], [{ ...WEB, collapsed: true }]) });
    useUiStore.getState().select({ kind: "project", id: "c" });
    expect(moveSelection("left")).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "group", id: "gw" });
    expect(moveSelection("right")).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "c" });
  });

  it("dragging the frame moves every member live and writes them once on drop", async () => {
    const invoke = fakeRust();
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw"), project("b", 300, "gw"), project("c", 900)], [WEB]) });
    startGroupDrag("gw", { x: -16, y: -36 });
    expect(dragGroupTo("gw", { x: 34, y: -16 })).toBe(true);
    expect(useCanvasStore.getState().dragging).toEqual({ a: { x: 50, y: 20 }, b: { x: 350, y: 20 } });
    expect(await dropGroup("gw")).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "workspace_move_nodes",
      {
        moves: [
          { target: { kind: "project", id: "a" }, position: { x: 50, y: 20 } },
          { target: { kind: "project", id: "b" }, position: { x: 350, y: 20 } },
        ],
      },
      undefined,
    );
    expect(useCanvasStore.getState().dragging).toEqual({});
    expect(useWorkspaceStore.getState().snapshot?.workspace.projects.map((p) => p.position)).toEqual([
      { x: 50, y: 20 },
      { x: 350, y: 20 },
      { x: 900, y: 0 },
    ]);
    // A drag that went nowhere writes nothing.
    startGroupDrag("gw", { x: 0, y: 0 });
    expect(await dropGroup("gw")).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("ctrl+j into a collapsed group", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    unmarkAcknowledging("s1");
  });

  it("expands the group first, then the project, and selects the session", async () => {
    const invoke = fakeRust();
    useUiStore.setState({ selection: null, showAll: [], showAllBranches: [] });
    const live: LiveSnapshot = { ...EMPTY_LIVE };
    useLiveStore.setState({ snapshot: live, received: true, loadError: null });
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw", false)], [{ ...WEB, collapsed: true }], [session("s1", "a")]) });
    expect(await revealSession("s1")).toBe(true);
    const calls = invoke.mock.calls.map(([cmd]) => cmd);
    expect(calls.slice(0, 2)).toEqual(["group_collapse", "workspace_set_expanded"]);
    expect(invoke).toHaveBeenCalledWith("group_collapse", { groupId: "gw", collapsed: false }, undefined);
    expect(useWorkspaceStore.getState().snapshot?.workspace.groups?.[0]?.collapsed).toBe(false);
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s1" });
  });

  it("a toast for an agent in a collapsed group expands the group, then the project, and selects the agent", async () => {
    const invoke = fakeRust();
    useUiStore.setState({ selection: null, showAll: [], showAllBranches: [] });
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw", false)], [{ ...WEB, collapsed: true }], [agentChild("agent:1", "a")]) });
    expect(await revealAgent("agent:1")).toBe(true);
    expect(invoke.mock.calls.map(([cmd]) => cmd).slice(0, 2)).toEqual(["group_collapse", "workspace_set_expanded"]);
    expect(useWorkspaceStore.getState().snapshot?.workspace.groups?.[0]?.collapsed).toBe(false);
    expect(useUiStore.getState().selection).toEqual({ kind: "agent", id: "agent:1" });
  });
});

describe("groups and the selection, the canvas and drops", () => {
  beforeEach(() => {
    clearCommands();
    useWorkspaceStore.setState({ snapshot: null, loadError: null });
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, notice: null, showAll: [], showAllBranches: [], elsewhereOpen: false });
    useCanvasStore.setState({ instance: null, element: null, dragging: {} });
  });
  afterEach(() => {
    clearCommands();
    vi.unstubAllGlobals();
  });

  it("a group collapsing moves a selection inside it to the group's card", () => {
    const children = [session("s1", "a")];
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw", true), project("c", 900)], [WEB], children) });
    for (const target of [
      { kind: "project", id: "a" },
      { kind: "session", id: "s1" },
      { kind: "more", id: "a" },
    ] as const) {
      useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw", true), project("c", 900)], [WEB], children, 1) });
      useUiStore.getState().select(target);
      useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw", true), project("c", 900)], [{ ...WEB, collapsed: true }], children, 2) });
      expect(useUiStore.getState().selection, target.kind).toEqual({ kind: "group", id: "gw" });
    }
    // A project outside the group keeps its selection.
    useUiStore.getState().select({ kind: "project", id: "c" });
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw", true), project("c", 900)], [{ ...WEB, collapsed: true }], children, 3) });
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "c" });
  });

  it("a group collapsing clears a selected edge to one of its members", () => {
    const edges = [edge("e1", "a", "c")];
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw"), project("c", 900)], [WEB], [], 1, edges) });
    useUiStore.getState().select({ kind: "edge", id: "e1" });
    expect(useUiStore.getState().selection).toEqual({ kind: "edge", id: "e1" });
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw"), project("c", 900)], [{ ...WEB, collapsed: true }], [], 2, edges) });
    expect(useUiStore.getState().selection).toBeNull();
  });

  it("Go to group centres the canvas on the frame, or on the collapsed card", () => {
    registerBuiltins();
    const canvas = fakeCanvas();
    useCanvasStore.getState().setInstance(canvas);
    useCanvasStore.getState().setElement({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) });
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw")], [WEB]) });
    // Frame: x -16, y -36, 272 × 132; centre (120, 30).
    const frame = { x: -GROUP_PADDING, y: -GROUP_PADDING - GROUP_LABEL_HEIGHT, width: CARD_WIDTH + 2 * GROUP_PADDING, height: CARD_HEIGHT + 2 * GROUP_PADDING + GROUP_LABEL_HEIGHT };
    expect(runCommand("group.goto.gw")).toBe(true);
    expect(canvas.setViewport).toHaveBeenLastCalledWith(
      { x: 400 - (frame.x + frame.width / 2), y: 300 - (frame.y + frame.height / 2), zoom: 1 },
      expect.anything(),
    );
    // Collapsed: the project-sized card at the frame's top-left.
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw")], [{ ...WEB, collapsed: true }], [], 2) });
    expect(runCommand("group.goto.gw")).toBe(true);
    expect(canvas.setViewport).toHaveBeenLastCalledWith(
      { x: 400 - (frame.x + CARD_WIDTH / 2), y: 300 - (frame.y + CARD_HEIGHT / 2), zoom: 1 },
      expect.anything(),
    );
    expect(useUiStore.getState().selection).toEqual({ kind: "group", id: "gw" });
  });

  it("the arrows start from a selected expanded group's frame", () => {
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw"), project("c", 600)], [WEB]) });
    useUiStore.getState().select({ kind: "group", id: "gw" });
    expect(moveSelection("right")).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "c" });
  });

  it("a refused group drop is the notice, clears the overrides and moves nothing", async () => {
    fakeRust(true);
    useWorkspaceStore.setState({ snapshot: snapshotOf([project("a", 0, "gw"), project("b", 300, "gw")], [WEB]) });
    startGroupDrag("gw", { x: 0, y: 0 });
    dragGroupTo("gw", { x: 50, y: 20 });
    expect(await dropGroup("gw")).toBe(false);
    expect(useUiStore.getState().notice?.text).toBe("unknown project");
    expect(useCanvasStore.getState().dragging).toEqual({});
    expect(useWorkspaceStore.getState().snapshot?.workspace.projects.map((p) => p.position)).toEqual([
      { x: 0, y: 0 },
      { x: 300, y: 0 },
    ]);
  });
});
