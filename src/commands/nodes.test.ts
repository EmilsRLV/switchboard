import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildNode, Project, WorkspaceSnapshot } from "../ipc";
import { useCanvasStore } from "../state/canvas";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { moveNode, openContextMenuFor, relayoutChildren, setExpanded } from "./nodes";

vi.mock("../ipc", () => ({
  workspaceSetExpanded: vi.fn(),
  workspaceMoveNode: vi.fn(),
  workspaceRelayoutChildren: vi.fn(),
}));

const ipc = await import("../ipc");
const workspaceSetExpanded = vi.mocked(ipc.workspaceSetExpanded);
const workspaceMoveNode = vi.mocked(ipc.workspaceMoveNode);
const workspaceRelayoutChildren = vi.mocked(ipc.workspaceRelayoutChildren);

const ide: Project = { id: "ide", path: "/p/ide", label: "ide", position: { x: 0, y: 0 }, expanded: false, color: null, launchDefaults: null };

function stub(index: number, position: ChildNode["position"] = null): ChildNode {
  return { id: `stub-${index}-ide`, projectId: "ide", kind: "session", label: `session ${index}`, detail: "stub", position };
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
    ...over,
  };
}

describe("node actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({ snapshot: snapshot(1), loadError: "stale" });
    useUiStore.setState({ pane: null, flashed: [], selection: null, contextMenu: null });
    useCanvasStore.setState({ instance: null, element: null, dragging: {} });
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

  it("openContextMenuFor selects the node and opens the menu at the point", () => {
    openContextMenuFor({ kind: "project", id: "ide" }, { x: 300, y: 120 });
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "ide" });
    expect(useUiStore.getState().contextMenu).toEqual({ x: 300, y: 120 });
  });
});
