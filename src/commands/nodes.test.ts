import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildNode, Project, WorkspaceSnapshot } from "../ipc";
import { useCanvasStore } from "../state/canvas";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import {
  canvasMenuCommands,
  menuGroup,
  moveNode,
  nodeMenuCommands,
  openContextMenuFor,
  relayoutChildren,
  removeProject,
  rightClickCanvas,
  rightClickNode,
  setExpanded,
} from "./nodes";
import { clearCommands, registerCommand, registerCommands } from "./registry";

vi.mock("../ipc", () => ({
  workspaceSetExpanded: vi.fn(),
  workspaceMoveNode: vi.fn(),
  workspaceRelayoutChildren: vi.fn(),
  workspaceRemoveProject: vi.fn(),
}));

const ipc = await import("../ipc");
const workspaceSetExpanded = vi.mocked(ipc.workspaceSetExpanded);
const workspaceMoveNode = vi.mocked(ipc.workspaceMoveNode);
const workspaceRelayoutChildren = vi.mocked(ipc.workspaceRelayoutChildren);
const workspaceRemoveProject = vi.mocked(ipc.workspaceRemoveProject);

const ide: Project = { id: "ide", path: "/p/ide", label: "ide", position: { x: 0, y: 0 }, expanded: false, color: null, launchDefaults: null, showBranches: false };

function stub(index: number, position: ChildNode["position"] = null): ChildNode {
  return { id: `stub-${index}-ide`, projectId: "ide", kind: "session", label: `session ${index}`, detail: "stub", position, session: null, branchId: null, forkedFrom: null, hasTranscript: false, branch: null };
}

function snapshot(revision: number, over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    path: "/cfg/workspace.json",
    workspace: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      projects: [ide],
      branches: [],
      sessions: [],
      edges: [],
      defaults: { model: null, effort: null, permissionMode: null },
    },
    banners: [],
    revision,
    children: [stub(1), stub(2), stub(3)],
    branchErrors: {},
    ...over,
  };
}

describe("node actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({ snapshot: snapshot(1), loadError: "stale" });
    useUiStore.setState({ pane: null, flashed: [], selection: null, contextMenu: null, notice: null });
    useCanvasStore.setState({ instance: null, element: null, dragging: {} });
  });

  it("removeProject applies the snapshot and clears a selection that pointed at the project", async () => {
    const gone = snapshot(2, { workspace: { ...snapshot(2).workspace, projects: [] }, children: [] });
    workspaceRemoveProject.mockResolvedValue(gone);
    useUiStore.getState().select({ kind: "project", id: "ide" });
    await expect(removeProject("ide")).resolves.toBe(true);
    expect(workspaceRemoveProject).toHaveBeenCalledWith("ide");
    expect(useWorkspaceStore.getState().snapshot).toBe(gone);
    expect(useWorkspaceStore.getState().loadError).toBeNull();
    expect(useUiStore.getState().selection).toBeNull();
  });

  it("removeProject clears a selected child of the project too, but not another node", async () => {
    workspaceRemoveProject.mockResolvedValue(snapshot(2));
    useUiStore.getState().select({ kind: "session", id: "stub-2-ide" });
    await removeProject("ide");
    expect(useUiStore.getState().selection).toBeNull();

    useUiStore.getState().select({ kind: "project", id: "other" });
    await removeProject("ide");
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "other" });
  });

  it("removeProject clears the project's selected more row and forgets its show-all; a failure keeps both", async () => {
    workspaceRemoveProject.mockResolvedValue(snapshot(2));
    useUiStore.setState({ showAll: ["ide", "other"] });
    useUiStore.getState().select({ kind: "more", id: "ide" });
    await expect(removeProject("ide")).resolves.toBe(true);
    expect(useUiStore.getState().selection).toBeNull();
    expect(useUiStore.getState().showAll).toEqual(["other"]);

    workspaceRemoveProject.mockRejectedValueOnce(new Error("unknown project"));
    useUiStore.getState().select({ kind: "more", id: "other" });
    await expect(removeProject("other")).resolves.toBe(false);
    expect(useUiStore.getState().selection).toEqual({ kind: "more", id: "other" });
    expect(useUiStore.getState().showAll).toEqual(["other"]);
  });

  it("removeProject clears the project's selected branch-group more row and forgets both show-alls", async () => {
    workspaceRemoveProject.mockResolvedValue(snapshot(2));
    useUiStore.setState({ showAll: ["ide"], showAllBranches: ["ide", "other"] });
    useUiStore.getState().select({ kind: "more", id: "ide", group: "branches" });
    await expect(removeProject("ide")).resolves.toBe(true);
    expect(useUiStore.getState().selection).toBeNull();
    expect(useUiStore.getState().showAll).toEqual([]);
    expect(useUiStore.getState().showAllBranches).toEqual(["other"]);
  });

  it("removeProject leaves a node selected meanwhile alone, and a failure keeps the selection with the banner", async () => {
    let resolve: (s: WorkspaceSnapshot) => void = () => {};
    workspaceRemoveProject.mockReturnValueOnce(new Promise<WorkspaceSnapshot>((r) => (resolve = r)));
    useUiStore.getState().select({ kind: "project", id: "ide" });
    const pending = removeProject("ide");
    useUiStore.getState().select({ kind: "project", id: "other" });
    resolve(snapshot(2));
    await expect(pending).resolves.toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "other" });

    workspaceRemoveProject.mockRejectedValueOnce(new Error("unknown project"));
    useUiStore.getState().select({ kind: "project", id: "nope" });
    await expect(removeProject("nope")).resolves.toBe(false);
    expect(useWorkspaceStore.getState().loadError).toBe("remove failed: unknown project");
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "nope" });
  });

  it("menuGroup is the tens of menuOrder; a command without one is in the last group", () => {
    expect(menuGroup({ menuOrder: 10 })).toBe(1);
    expect(menuGroup({ menuOrder: 11 })).toBe(1);
    expect(menuGroup({ menuOrder: 22 })).toBe(2);
    expect(menuGroup({ menuOrder: 40 })).toBe(4);
    expect(menuGroup({})).toBeGreaterThan(menuGroup({ menuOrder: 99 }));
  });

  it("moveNode sends the target and position, applies the snapshot, then clears the drag override", async () => {
    const reply = snapshot(2, { children: [stub(1), stub(2, { x: 260, y: 40 }), stub(3)] });
    const order: string[] = [];
    workspaceMoveNode.mockImplementation(async () => {
      order.push("sent");
      return reply;
    });
    useCanvasStore.getState().setDragPosition("session:stub-2-ide", { x: 260, y: 40 });
    const unsubscribe = useWorkspaceStore.subscribe((s, previous) => {
      if (s.snapshot === reply && previous.snapshot !== reply) {
        order.push(`applied with override ${"session:stub-2-ide" in useCanvasStore.getState().dragging}`);
      }
    });

    await expect(moveNode({ kind: "session", id: "stub-2-ide" }, { x: 260, y: 40 })).resolves.toBe(true);

    unsubscribe();
    expect(workspaceMoveNode).toHaveBeenCalledWith({ kind: "session", id: "stub-2-ide" }, { x: 260, y: 40 });
    expect(order).toEqual(["sent", "applied with override true"]);
    expect(useWorkspaceStore.getState().snapshot).toBe(reply);
    expect(useWorkspaceStore.getState().loadError).toBeNull();
    expect(useCanvasStore.getState().dragging).toEqual({});
  });

  it("moveNode on a project clears the bare project flow id", async () => {
    workspaceMoveNode.mockResolvedValue(snapshot(2));
    useCanvasStore.getState().setDragPosition("ide", { x: 120, y: 0 });
    useCanvasStore.getState().setDragPosition("other", { x: 1, y: 1 });
    await moveNode({ kind: "project", id: "ide" }, { x: 120, y: 0 });
    expect(useCanvasStore.getState().dragging).toEqual({ other: { x: 1, y: 1 } });
  });

  it("a reply for an earlier drag leaves a newer override of the same node alone", async () => {
    let resolveFirst: (s: WorkspaceSnapshot) => void = () => {};
    workspaceMoveNode.mockReturnValueOnce(new Promise<WorkspaceSnapshot>((resolve) => (resolveFirst = resolve)));
    useCanvasStore.getState().setDragPosition("ide", { x: 120, y: 0 });
    const first = moveNode({ kind: "project", id: "ide" }, { x: 120, y: 0 });

    // A second drag starts before the first reply: its override replaces the first one.
    useCanvasStore.getState().setDragPosition("ide", { x: 300, y: 50 });
    resolveFirst(snapshot(2));
    await expect(first).resolves.toBe(true);
    expect(useCanvasStore.getState().dragging).toEqual({ ide: { x: 300, y: 50 } });

    // The second drop clears its own override as usual.
    workspaceMoveNode.mockResolvedValueOnce(snapshot(3));
    await moveNode({ kind: "project", id: "ide" }, { x: 300, y: 50 });
    expect(useCanvasStore.getState().dragging).toEqual({});
  });

  it("a rejected move is the workspace.load banner, keeps the snapshot and still clears the override", async () => {
    workspaceMoveNode.mockRejectedValue(new Error("unknown session"));
    const before = useWorkspaceStore.getState().snapshot;
    useCanvasStore.getState().setDragPosition("session:stub-9-ide", { x: 1, y: 1 });
    await expect(moveNode({ kind: "session", id: "stub-9-ide" }, { x: 1, y: 1 })).resolves.toBe(false);
    expect(useWorkspaceStore.getState().snapshot).toBe(before);
    expect(useWorkspaceStore.getState().loadError).toBe("node move failed: unknown session");
    expect(useCanvasStore.getState().dragging).toEqual({});
  });

  it("setExpanded and relayoutChildren apply what Rust replies and clear a stale load error", async () => {
    const expanded = snapshot(2, { workspace: { ...snapshot(2).workspace, projects: [{ ...ide, expanded: true }] } });
    workspaceSetExpanded.mockResolvedValue(expanded);
    await expect(setExpanded("ide", true)).resolves.toBe(true);
    expect(workspaceSetExpanded).toHaveBeenCalledWith("ide", true);
    expect(useWorkspaceStore.getState().snapshot).toBe(expanded);
    expect(useWorkspaceStore.getState().loadError).toBeNull();

    const relaid = snapshot(3);
    workspaceRelayoutChildren.mockResolvedValue(relaid);
    await expect(relayoutChildren("ide")).resolves.toBe(true);
    expect(workspaceRelayoutChildren).toHaveBeenCalledWith("ide");
    expect(useWorkspaceStore.getState().snapshot).toBe(relaid);
  });

  it("a rejected expand or re-layout lands in the banner with its cause", async () => {
    workspaceSetExpanded.mockRejectedValue("unknown project");
    await expect(setExpanded("nope", false)).resolves.toBe(false);
    expect(useWorkspaceStore.getState().loadError).toBe("collapse failed: unknown project");
    workspaceRelayoutChildren.mockRejectedValue(new Error("unknown project"));
    await expect(relayoutChildren("nope")).resolves.toBe(false);
    expect(useWorkspaceStore.getState().loadError).toBe("re-layout failed: unknown project");
  });

  it("a reply older than the shown snapshot is dropped, but the round trip still counts as working", async () => {
    useWorkspaceStore.setState({ snapshot: snapshot(5) });
    const shown = useWorkspaceStore.getState().snapshot;
    workspaceSetExpanded.mockResolvedValue(snapshot(4));
    await setExpanded("ide", true);
    expect(useWorkspaceStore.getState().snapshot).toBe(shown);
    expect(useWorkspaceStore.getState().loadError).toBeNull();
  });

  it("rightClickNode opens the menu only for a project or session card with enabled entries", () => {
    clearCommands();
    useUiStore.setState({ selection: null, contextMenu: null });
    // Nothing enabled (a historic session): selected, no menu at all.
    rightClickNode({ kind: "session", id: "historic" }, { x: 5, y: 6 });
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "historic" });
    expect(useUiStore.getState().contextMenu).toBeNull();

    registerCommand({
      id: "test.sessionOnly",
      title: "Session only",
      menu: "node",
      when: () => useUiStore.getState().selection?.id === "live",
      run: () => {},
    });
    rightClickNode({ kind: "session", id: "live" }, { x: 7, y: 8 });
    expect(useUiStore.getState().contextMenu).toEqual({ x: 7, y: 8, menu: "node" });
    useUiStore.getState().closeContextMenu();
    rightClickNode({ kind: "session", id: "historic" }, { x: 1, y: 1 });
    expect(useUiStore.getState().contextMenu).toBeNull();
    clearCommands();
  });

  it("openContextMenuFor selects the node and opens the menu at the point", () => {
    openContextMenuFor({ kind: "project", id: "ide" }, { x: 300, y: 120 });
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "ide" });
    expect(useUiStore.getState().contextMenu).toEqual({ x: 300, y: 120, menu: "node" });
  });
});

describe("the canvas menu (Story 11.1)", () => {
  it("lists the enabled canvas commands in menuOrder, apart from the node menu's", () => {
    clearCommands();
    let ready = true;
    registerCommands([
      { id: "settings.open", title: "Open settings", menu: "canvas", menuOrder: 31, run: () => {} },
      { id: "project.add", title: "Add project folder…", menu: "canvas", menuOrder: 10, run: () => {} },
      { id: "canvas.fitView", title: "Fit view", menu: "canvas", menuOrder: 20, when: () => ready, run: () => {} },
      { id: "help.open", title: "Help", menu: "canvas", menuOrder: 30, run: () => {} },
      { id: "project.import", title: "Import from Claude…", menu: "canvas", menuOrder: 11, run: () => {} },
      { id: "project.remove", title: "Remove", menu: "node", menuOrder: 90, run: () => {} },
    ]);
    const ids = () => canvasMenuCommands().map((command) => command.id);
    expect(ids()).toEqual(["project.add", "project.import", "canvas.fitView", "help.open", "settings.open"]);
    expect(nodeMenuCommands().map((command) => command.id)).toEqual(["project.remove"]);
    ready = false;
    expect(ids()).toEqual(["project.add", "project.import", "help.open", "settings.open"]);
    clearCommands();
  });

  it("rightClickCanvas opens the canvas menu at the point and keeps the selection", () => {
    useUiStore.setState({ selection: { kind: "project", id: "ide" }, contextMenu: null });
    rightClickCanvas({ x: 40, y: 50 });
    expect(useUiStore.getState().contextMenu).toEqual({ x: 40, y: 50, menu: "canvas" });
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "ide" });
    useUiStore.getState().closeContextMenu();
  });
});
