import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildNode, Position, Project, Viewport, WorkspaceSnapshot } from "../ipc";
import { useCanvasStore, type CanvasInstance } from "../state/canvas";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import type { Timers } from "./projects";

vi.mock("../ipc", () => ({
  workspaceSetExpanded: vi.fn(),
  workspaceMoveNode: vi.fn(),
  workspaceRelayoutChildren: vi.fn(),
  workspaceRemoveProject: vi.fn(),
  projectOpenEditor: vi.fn(),
  projectOpenFolder: vi.fn(),
  projectRevealClaudeDir: vi.fn(),
}));

const ipc = await import("../ipc");
const workspaceSetExpanded = vi.mocked(ipc.workspaceSetExpanded);
const projectOpenEditor = vi.mocked(ipc.projectOpenEditor);
const projectOpenFolder = vi.mocked(ipc.projectOpenFolder);
const projectRevealClaudeDir = vi.mocked(ipc.projectRevealClaudeDir);

const {
  activateSelection,
  clickNode,
  moveSelection,
  notify,
  openProjectFolder,
  openProjectInEditor,
  revealClaudeProjectDir,
} = await import("./navigation");

function project(id: string, x: number, y: number, expanded = false): Project {
  return { id, path: `/p/${id}`, label: id, position: { x, y }, expanded, color: null, launchDefaults: null, showBranches: false };
}

function stub(index: number, projectId: string, position: Position | null = null): ChildNode {
  return { id: `stub-${index}-${projectId}`, projectId, kind: "session", label: `session ${index}`, detail: "stub", position, session: null, branchId: null, forkedFrom: null, hasTranscript: false, branch: null };
}

function snapshot(projects: Project[], children: ChildNode[], revision = 1): WorkspaceSnapshot {
  return {
    path: null,
    workspace: { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, projects, branches: [], sessions: [], edges: [], defaults: { model: null, effort: null, permissionMode: null } },
    banners: [],
    revision,
    branchErrors: {},
    children,
  };
}

/** The matrix's canvas: `ide` at (80,80), `projects` at (480,80), two stubs under `ide`. */
function matrix(ideExpanded: boolean): WorkspaceSnapshot {
  return snapshot([project("ide", 80, 80, ideExpanded), project("projects", 480, 80)], [stub(1, "ide"), stub(2, "ide")]);
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

const selection = () => useUiStore.getState().selection;

describe("moveSelection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({ snapshot: matrix(false), loadError: null });
    useUiStore.setState({ pane: null, flashed: [], selection: null, contextMenu: null, notice: null });
    useCanvasStore.setState({ instance: null, element: null, dragging: {} });
  });

  it("→ moves from ide to projects, ← back; ↓ with ide expanded selects session 1; no candidate leaves it", () => {
    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(moveSelection("right")).toBe(true);
    expect(selection()).toEqual({ kind: "project", id: "projects" });
    expect(moveSelection("left")).toBe(true);
    expect(selection()).toEqual({ kind: "project", id: "ide" });
    expect(moveSelection("down")).toBe(false);
    expect(selection()).toEqual({ kind: "project", id: "ide" });

    useWorkspaceStore.setState({ snapshot: matrix(true) });
    expect(moveSelection("down")).toBe(true);
    expect(selection()).toEqual({ kind: "session", id: "stub-1-ide" });
    expect(moveSelection("down")).toBe(true);
    expect(selection()).toEqual({ kind: "session", id: "stub-2-ide" });
    expect(moveSelection("up")).toBe(true);
    expect(moveSelection("up")).toBe(true);
    expect(selection()).toEqual({ kind: "project", id: "ide" });
    expect(moveSelection("up")).toBe(false);
    expect(moveSelection("left")).toBe(false);
    expect(selection()).toEqual({ kind: "project", id: "ide" });
  });

  it("with nothing selected any arrow selects the node nearest the viewport centre; with no nodes nothing", () => {
    // The canvas element is 800×600 at the origin, so the centre is client (400,300); with the
    // view panned to (−400, −200) that is canvas (800, 500): `projects` (centre 600,120) is nearer.
    useCanvasStore.getState().setInstance(fakeCanvas({ x: -400, y: -200, zoom: 1 }));
    useCanvasStore.getState().setElement({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) });
    expect(moveSelection("down")).toBe(true);
    expect(selection()).toEqual({ kind: "project", id: "projects" });

    // Home viewport, 600 px wide: centre (300,300) is nearer `ide` (centre 200,120).
    useUiStore.getState().clearSelection();
    useCanvasStore.getState().setInstance(fakeCanvas({ x: 0, y: 0, zoom: 1 }));
    useCanvasStore.getState().setElement({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) });
    expect(moveSelection("left")).toBe(true);
    expect(selection()).toEqual({ kind: "project", id: "ide" });

    useUiStore.getState().clearSelection();
    useWorkspaceStore.setState({ snapshot: snapshot([], []) });
    expect(moveSelection("down")).toBe(false);
    expect(selection()).toBeNull();
    useWorkspaceStore.setState({ snapshot: null });
    expect(moveSelection("down")).toBe(false);
  });

  it("a selected node that is not drawn (a child of a collapsed project) is treated as no selection", () => {
    useUiStore.getState().select({ kind: "session", id: "stub-1-ide" });
    useCanvasStore.getState().setInstance(fakeCanvas());
    expect(moveSelection("right")).toBe(true);
    expect(selection()).toEqual({ kind: "project", id: "ide" });
  });

  it("pans by the smallest delta that shows an off-screen target, zoom unchanged, over 150 ms; not when it is in view", () => {
    const instance = fakeCanvas({ x: 0, y: 0, zoom: 1 });
    useCanvasStore.getState().setInstance(instance);
    // 500 px wide: `projects` (480..720 in canvas, at zoom 1 on screen) is off to the right.
    useCanvasStore.getState().setElement({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 600 }) });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(moveSelection("right")).toBe(true);
    // Right edge at 720; must end at 500 − 16 = 484: shift by −236.
    expect(instance.setViewport).toHaveBeenCalledWith({ x: -236, y: 0, zoom: 1 }, { duration: 150 });
    // Back to `ide`: now at screen 80 − 236 = −156 → shift right to the margin, by 172.
    expect(moveSelection("left")).toBe(true);
    expect(instance.setViewport).toHaveBeenLastCalledWith({ x: -64, y: 0, zoom: 1 }, { duration: 150 });
    expect(instance.setViewport).toHaveBeenCalledTimes(2);

    // Both in view: no pan.
    useCanvasStore.getState().setElement({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 600 }) });
    expect(moveSelection("right")).toBe(true);
    expect(instance.setViewport).toHaveBeenCalledTimes(2);
  });

  it("pans instantly when the OS asks for reduced motion", () => {
    const queries: string[] = [];
    vi.stubGlobal("matchMedia", (query: string) => {
      queries.push(query);
      return { matches: true };
    });
    try {
      const instance = fakeCanvas({ x: 0, y: 0, zoom: 1 });
      useCanvasStore.getState().setInstance(instance);
      useCanvasStore.getState().setElement({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 600 }) });
      useUiStore.getState().select({ kind: "project", id: "ide" });
      expect(moveSelection("right")).toBe(true);
      expect(instance.setViewport).toHaveBeenCalledWith({ x: -236, y: 0, zoom: 1 }, { duration: 0 });
      expect(queries).toEqual(["(prefers-reduced-motion: reduce)"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("without a canvas or a measurable size the selection still moves, without panning", () => {
    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(moveSelection("right")).toBe(true);
    expect(selection()).toEqual({ kind: "project", id: "projects" });
    // An instance but no element and no `window` (vitest's node environment): no size, no pan.
    const instance = fakeCanvas();
    useCanvasStore.getState().setInstance(instance);
    expect(moveSelection("left")).toBe(true);
    expect(instance.setViewport).not.toHaveBeenCalled();
  });
});

describe("activateSelection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({ snapshot: matrix(false), loadError: null });
    useUiStore.setState({ pane: null, flashed: [], selection: null, contextMenu: null, notice: null });
  });

  it("toggles a project with children: expand, then (on the new snapshot) collapse, persisted through Rust", async () => {
    const expanded = matrix(true);
    workspaceSetExpanded.mockResolvedValueOnce({ ...expanded, revision: 2 });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    await expect(activateSelection()).resolves.toBe(true);
    expect(workspaceSetExpanded).toHaveBeenCalledWith("ide", true);
    expect(useWorkspaceStore.getState().snapshot?.workspace.projects[0]?.expanded).toBe(true);

    workspaceSetExpanded.mockResolvedValueOnce({ ...matrix(false), revision: 3 });
    await expect(activateSelection()).resolves.toBe(true);
    expect(workspaceSetExpanded).toHaveBeenLastCalledWith("ide", false);
    expect(useWorkspaceStore.getState().snapshot?.workspace.projects[0]?.expanded).toBe(false);
  });

  it("does nothing for a childless project, a child card or no selection", async () => {
    useUiStore.getState().select({ kind: "project", id: "projects" });
    await expect(activateSelection()).resolves.toBe(false);
    useUiStore.getState().select({ kind: "session", id: "stub-1-ide" });
    await expect(activateSelection()).resolves.toBe(false);
    useUiStore.getState().clearSelection();
    await expect(activateSelection()).resolves.toBe(false);
    expect(workspaceSetExpanded).not.toHaveBeenCalled();
  });

  it("a rejected toggle is the workspace.load banner, as from the chevron", async () => {
    workspaceSetExpanded.mockRejectedValueOnce(new Error("unknown project"));
    useUiStore.getState().select({ kind: "project", id: "ide" });
    await expect(activateSelection()).resolves.toBe(false);
    expect(useWorkspaceStore.getState().loadError).toBe("expand failed: unknown project");
    expect(useUiStore.getState().notice).toBeNull();
  });
});

describe("notices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ pane: null, flashed: [], selection: null, contextMenu: null, notice: null });
    useWorkspaceStore.setState({ snapshot: matrix(false), loadError: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeTimers(): Timers & { pending: Map<unknown, () => void>; fire: () => void } {
    const pending = new Map<unknown, () => void>();
    let next = 1;
    return {
      pending,
      setTimeout: (fn) => {
        const handle = next++;
        pending.set(handle, fn);
        return handle;
      },
      clearTimeout: (handle) => {
        pending.delete(handle);
      },
      fire: () => {
        for (const [handle, fn] of [...pending]) {
          pending.delete(handle);
          fn();
        }
      },
    };
  }

  it("notify shows the text for 3 s; a newer notice replaces it and restarts the clock", () => {
    const timers = fakeTimers();
    notify("first", timers);
    expect(useUiStore.getState().notice).toEqual({ text: "first" });
    expect(timers.pending.size).toBe(1);
    notify("second", timers);
    expect(useUiStore.getState().notice).toEqual({ text: "second" });
    expect(timers.pending.size).toBe(1); // the first clock was cancelled
    timers.fire();
    expect(useUiStore.getState().notice).toBeNull();
    expect(timers.pending.size).toBe(0);
  });

  it("the default clock is the real one, at NOTICE_MS", () => {
    vi.useFakeTimers();
    notify("hello");
    expect(useUiStore.getState().notice).toEqual({ text: "hello" });
    vi.advanceTimersByTime(2999);
    expect(useUiStore.getState().notice).toEqual({ text: "hello" });
    vi.advanceTimersByTime(1);
    expect(useUiStore.getState().notice).toBeNull();
  });

  it("the three external actions call Rust with the project id and show nothing on success", async () => {
    vi.useFakeTimers();
    projectOpenEditor.mockResolvedValue(undefined);
    projectOpenFolder.mockResolvedValue(undefined);
    projectRevealClaudeDir.mockResolvedValue(undefined);
    await expect(openProjectInEditor("ide")).resolves.toBe(true);
    await expect(openProjectFolder("ide")).resolves.toBe(true);
    await expect(revealClaudeProjectDir("ide")).resolves.toBe(true);
    expect(projectOpenEditor).toHaveBeenCalledWith("ide");
    expect(projectOpenFolder).toHaveBeenCalledWith("ide");
    expect(projectRevealClaudeDir).toHaveBeenCalledWith("ide");
    expect(useUiStore.getState().notice).toBeNull();
    expect(useWorkspaceStore.getState().loadError).toBeNull();
  });

  it("a failure is a notice naming the cause (Rust's message verbatim), never a banner", async () => {
    vi.useFakeTimers();
    projectOpenEditor.mockRejectedValueOnce("No external editor configured — set external_editor in settings");
    await expect(openProjectInEditor("ide")).resolves.toBe(false);
    expect(useUiStore.getState().notice).toEqual({ text: "No external editor configured — set external_editor in settings" });

    projectRevealClaudeDir.mockRejectedValueOnce("No Claude project directory for this folder");
    await expect(revealClaudeProjectDir("ide")).resolves.toBe(false);
    expect(useUiStore.getState().notice).toEqual({ text: "No Claude project directory for this folder" });

    projectOpenFolder.mockRejectedValueOnce(new Error("could not open folder: boom"));
    await expect(openProjectFolder("ide")).resolves.toBe(false);
    expect(useUiStore.getState().notice).toEqual({ text: "could not open folder: boom" });
    expect(useWorkspaceStore.getState().loadError).toBeNull();
    vi.advanceTimersByTime(3000);
    expect(useUiStore.getState().notice).toBeNull();
  });
});

describe("show all from the keyboard", () => {
  const many = (count: number): ChildNode[] => Array.from({ length: count }, (_, i) => stub(i + 1, "ide"));

  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({ snapshot: snapshot([project("ide", 80, 80, true)], many(15)), loadError: null });
    useUiStore.setState({ pane: null, flashed: [], selection: null, contextMenu: null, notice: null, showAll: [] });
    useCanvasStore.setState({ instance: null, element: null, dragging: {} });
  });

  it("↓ from the tenth child reaches the more row; the hidden ones are skipped", () => {
    useUiStore.getState().select({ kind: "session", id: "stub-10-ide" });
    expect(moveSelection("down")).toBe(true);
    expect(selection()).toEqual({ kind: "more", id: "ide" });
    expect(moveSelection("down")).toBe(false);
  });

  it("Enter on the more row toggles show all, and again shows fewer; nothing is sent to Rust", async () => {
    useUiStore.getState().select({ kind: "more", id: "ide" });
    await expect(activateSelection()).resolves.toBe(true);
    expect(useUiStore.getState().showAll).toEqual(["ide"]);
    // Now every child is drawn and reachable, the row after the fifteenth.
    useUiStore.getState().select({ kind: "session", id: "stub-15-ide" });
    expect(moveSelection("down")).toBe(true);
    expect(selection()).toEqual({ kind: "more", id: "ide" });
    await expect(activateSelection()).resolves.toBe(true);
    expect(useUiStore.getState().showAll).toEqual([]);
    expect(workspaceSetExpanded).not.toHaveBeenCalled();
  });

  it("Enter on a session does nothing (Resume and Fork are menu commands)", async () => {
    useUiStore.getState().select({ kind: "session", id: "stub-1-ide" });
    await expect(activateSelection()).resolves.toBe(false);
    expect(useUiStore.getState().showAll).toEqual([]);
    expect(workspaceSetExpanded).not.toHaveBeenCalled();
  });

  it("Enter on a selection that is no longer drawn does nothing", async () => {
    // A more row whose project now has ten children (no row any more).
    useUiStore.getState().select({ kind: "more", id: "ide" });
    useWorkspaceStore.setState({ snapshot: snapshot([project("ide", 80, 80, true)], many(10)) });
    await expect(activateSelection()).resolves.toBe(false);
    expect(useUiStore.getState().showAll).toEqual([]);
    // A more row of a collapsed project.
    useWorkspaceStore.setState({ snapshot: snapshot([project("ide", 80, 80, false)], many(15)) });
    await expect(activateSelection()).resolves.toBe(false);
    expect(useUiStore.getState().showAll).toEqual([]);
    // A child hidden past the cut.
    useWorkspaceStore.setState({ snapshot: snapshot([project("ide", 80, 80, true)], many(15)) });
    useUiStore.getState().select({ kind: "session", id: "stub-12-ide" });
    await expect(activateSelection()).resolves.toBe(false);
    // A project that is gone.
    useUiStore.getState().select({ kind: "project", id: "gone" });
    await expect(activateSelection()).resolves.toBe(false);
    expect(workspaceSetExpanded).not.toHaveBeenCalled();
  });

  it("clickNode selects the node and closes the menu; on a more row it also toggles show all", () => {
    useUiStore.setState({ contextMenu: { x: 1, y: 1, menu: "node" } });
    clickNode("session:stub-1-ide");
    expect(selection()).toEqual({ kind: "session", id: "stub-1-ide" });
    expect(useUiStore.getState().contextMenu).toBeNull();
    expect(useUiStore.getState().showAll).toEqual([]);

    clickNode("more:ide");
    expect(selection()).toEqual({ kind: "more", id: "ide" });
    expect(useUiStore.getState().showAll).toEqual(["ide"]);
    clickNode("more:ide");
    expect(useUiStore.getState().showAll).toEqual([]);

    clickNode("ide");
    expect(selection()).toEqual({ kind: "project", id: "ide" });
  });
});
