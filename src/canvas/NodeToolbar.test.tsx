import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider, type Node, type NodeProps } from "@xyflow/react";
import type { ChildNode, Project, WorkspaceSnapshot } from "../ipc";
import { registerBuiltins } from "../commands/builtins";
import { toolbarCommands } from "../commands/nodes";
import { clearCommands, registerCommand } from "../commands/registry";
import { useLaunchStore } from "../state/launch";
import { useReviewStore } from "../state/review";
import { EMPTY_LIVE, useLiveStore } from "../state/live";
import { usePaletteStore } from "../state/palette";
import { useStatusStore } from "../state/status";
import { useTerminalStore } from "../state/terminals";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { BranchNode, SessionNode } from "./ChildNode";
import { NodeToolbar, ToolbarRow } from "./NodeToolbar";
import type { BranchFlowNode, ProjectFlowNode, SessionFlowNode } from "./nodes";
import { ProjectNode } from "./ProjectNode";
import { ContextEdge, CooperateEdge } from "./Canvas";
import type { LinkFlowEdge } from "./edges";
import type { EdgeProps } from "@xyflow/react";

function project(id: string): Project {
  return { id, path: `/p/${id}`, label: id, position: { x: 0, y: 0 }, expanded: true, color: null, launchDefaults: null, showBranches: true };
}

const SESSION: ChildNode = {
  id: "s1",
  projectId: "a",
  kind: "session",
  label: "s1",
  detail: null,
  position: null,
  session: null,
  branchId: null,
  forkedFrom: null,
  hasTranscript: true,
  branch: null,
};

const BRANCH: ChildNode = {
  id: "a:feat",
  projectId: "a",
  kind: "branch",
  label: "feat",
  detail: null,
  position: null,
  session: null,
  branchId: null,
  forkedFrom: null,
  hasTranscript: false,
  branch: { head: false, upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree: null },
};

function snapshot(): WorkspaceSnapshot {
  return {
    path: null,
    workspace: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      projects: [project("a"), project("b")],
      branches: [],
      sessions: [],
      edges: [],
      defaults: { model: null, effort: null, permissionMode: null },
    },
    banners: [],
    revision: 1,
    branchErrors: {},
    children: [SESSION, BRANCH],
  };
}

/** Every element in a rendered tree (function components are not called). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children as ReactNode)];
}

/** The `onClick` of the button whose text is `word`. */
function clickOf(tree: ReactNode, word: string): (event: unknown) => void {
  const button = elements(tree).find((e) => e.type === "button" && e.props.children === word);
  if (button === undefined) throw new Error(`no button ${word}`);
  return button.props.onClick as (event: unknown) => void;
}

function click(command: string | undefined, rect = { left: 0, bottom: 0 }) {
  return { stopPropagation: vi.fn(), currentTarget: { dataset: { command }, getBoundingClientRect: () => rect } };
}

/** A card's props for a static render: only `data` and `dragging` are read. */
function nodeProps<N extends Node>(props: { data: unknown; dragging: boolean }): NodeProps<N> {
  return props as unknown as NodeProps<N>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("the node toolbar (Story 11.2)", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltins();
    usePaletteStore.setState({ isOpen: false, pick: null, query: "", selected: 0 });
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, elsewhereOpen: false, openTerminals: [], activeTerminal: null });
    useLiveStore.setState({ snapshot: EMPTY_LIVE, received: false, loadError: null });
    useTerminalStore.setState({ infos: {}, pendingExits: {} });
    useStatusStore.setState({ statuses: { a: { kind: "repo" } } } as never);
    useWorkspaceStore.setState({ snapshot: snapshot(), loadError: null });
    useLaunchStore.getState().reset();
    useReviewStore.setState({ target: null });
  });
  afterEach(() => {
    clearCommands();
    vi.unstubAllGlobals();
    useStatusStore.setState({ statuses: {} } as never);
    useWorkspaceStore.setState({ snapshot: null });
  });

  it("renders the buttons and ⋯ with commandHint titles, out of the Tab order", () => {
    const html = renderToStaticMarkup(<NodeToolbar target={{ kind: "project", id: "a" }} shown />);
    expect(html).toContain('<div class="node-toolbar nodrag nopan"><div class="node-toolbar-row">');
    expect(html).toContain(
      '<button type="button" class="node-toolbar-button" data-command="project.newSession" tabindex="-1" aria-label="New session…" title="New session… · n">new</button>',
    );
    expect(html).toContain('title="Plain terminal…">term</button>');
    expect(html).toContain('aria-label="Link to…" title="Link to… · e">link</button>');
    expect(html).toContain('aria-label="Review changes" title="Review changes · r">review</button>');
    expect(html).toContain(
      '<button type="button" class="node-toolbar-button node-toolbar-menu" tabindex="-1" aria-label="Menu" title="Menu · right-click">⋯</button>',
    );
    expect(html.match(/<button /g)).toHaveLength(5);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(5);
  });

  it("renders nothing when the card is neither hovered nor selected", () => {
    expect(renderToStaticMarkup(<NodeToolbar target={{ kind: "project", id: "a" }} shown={false} />)).toBe("");
  });

  it("renders nothing with no button and no menu row; only ⋯ with a menu row alone", () => {
    const gone = { kind: "branch", id: "a:vanished" } as const;
    expect(renderToStaticMarkup(<NodeToolbar target={gone} shown />)).toBe("");
    registerCommand({ id: "test.menuOnly", title: "Only in the menu", menu: "node", run: () => {} });
    const html = renderToStaticMarkup(<NodeToolbar target={gone} shown />);
    expect(html.match(/<button /g)).toHaveLength(1);
    expect(html).toContain(">⋯</button>");
  });

  it("a button selects the card, then runs its command", () => {
    useUiStore.getState().select({ kind: "project", id: "b" });
    const target = { kind: "branch", id: "a:feat" } as const;
    const tree = ToolbarRow({ target, commands: toolbarCommands(target), menu: true });
    const event = click("review.changes");
    clickOf(tree, "review")(event);
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(useUiStore.getState().selection).toEqual(target);
    expect(useUiStore.getState().pane).toBe("review");
  });

  it("with the terminal pane open, review closes it and opens the Review pane on the card", () => {
    useUiStore.setState({ pane: "terminal" });
    const target = { kind: "project", id: "a" } as const;
    const tree = ToolbarRow({ target, commands: toolbarCommands(target), menu: true });
    expect(elements(tree).filter((e) => e.type === "button").map((e) => e.props.children)).toEqual(["new", "term", "link", "review", "⋯"]);
    clickOf(tree, "review")(click("review.changes"));
    expect(useUiStore.getState().selection).toEqual(target);
    expect(useUiStore.getState().pane).toBe("review");
  });

  it("with the launch sheet open for A, new on project B reopens it for B", async () => {
    const invoke = vi.fn().mockResolvedValue({ name: "b-1", model: "opus", effort: "high", permissionMode: "plan" });
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    useUiStore.setState({ pane: "launch", selection: { kind: "project", id: "a" } });
    const target = { kind: "project", id: "b" } as const;
    const tree = ToolbarRow({ target, commands: toolbarCommands(target), menu: true });
    clickOf(tree, "new")(click("project.newSession"));
    await flush();
    expect(useUiStore.getState().selection).toEqual(target);
    expect(invoke).toHaveBeenCalledWith("launch_defaults", { projectId: "b" }, undefined);
    expect(useUiStore.getState().pane).toBe("launch");
    expect(useLaunchStore.getState().projectId).toBe("b");
  });

  it("⋯ selects the card and opens the node menu at its bottom-left", () => {
    const target = { kind: "session", id: "s1" } as const;
    const tree = ToolbarRow({ target, commands: toolbarCommands(target), menu: true });
    const event = click(undefined, { left: 40, bottom: 72 });
    clickOf(tree, "⋯")(event);
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(useUiStore.getState().selection).toEqual(target);
    expect(useUiStore.getState().contextMenu).toEqual({ x: 40, y: 72, menu: "node" });
  });

  const rowOf = (target: { kind: "project" | "session" | "branch"; id: string }) => ToolbarRow({ target, commands: toolbarCommands(target), menu: true });

  it("a pane that does not disable the command stays open (link with the Review pane open elsewhere)", () => {
    useReviewStore.setState({ target: { kind: "session", sessionId: "s1" } });
    useUiStore.setState({ pane: "review" });
    clickOf(rowOf({ kind: "project", id: "a" }), "link")(click("edge.link"));
    expect(useUiStore.getState().pane).toBe("review");
    expect(useReviewStore.getState().target).toEqual({ kind: "session", sessionId: "s1" });
    usePaletteStore.getState().close();
  });

  it("Help over the terminal pane: review closes both and opens the Review pane", () => {
    useUiStore.setState({ pane: "help", helpReturn: "terminal", openTerminals: ["plain:a"] });
    clickOf(rowOf({ kind: "project", id: "a" }), "review")(click("review.changes"));
    expect(useUiStore.getState().pane).toBe("review");
    expect(useReviewStore.getState().target).toEqual({ kind: "project", projectId: "a" });
  });

  it("the launch sheet already open for this card: new leaves it as it is", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    const form = { name: "typed" };
    useLaunchStore.setState({ projectId: "a", branch: null, form: form as never });
    useUiStore.setState({ pane: "launch", selection: { kind: "project", id: "a" } });
    clickOf(rowOf({ kind: "project", id: "a" }), "new")(click("project.newSession"));
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(useUiStore.getState().pane).toBe("launch");
    expect(useLaunchStore.getState().form).toBe(form);
  });

  it("the Review pane already open on this card: review leaves it as it is", () => {
    const target = { kind: "project", projectId: "a" } as const;
    useReviewStore.setState({ target });
    useUiStore.setState({ pane: "review" });
    clickOf(rowOf({ kind: "project", id: "a" }), "review")(click("review.changes"));
    expect(useUiStore.getState().pane).toBe("review");
    expect(useReviewStore.getState().target).toBe(target);
  });

  it("a toolbar click closes an open context menu", () => {
    useUiStore.getState().openContextMenu({ x: 1, y: 1 });
    clickOf(rowOf({ kind: "project", id: "a" }), "review")(click("review.changes"));
    expect(useUiStore.getState().contextMenu).toBeNull();
    expect(useUiStore.getState().pane).toBe("review");
  });

  describe("on the cards", () => {
    const render = (node: ReactNode) => renderToStaticMarkup(<ReactFlowProvider>{node}</ReactFlowProvider>);
    const projectData = (selected: boolean) => ({
      project: project("a"),
      status: null,
      flashed: false,
      selected,
      childCount: 0,
      liveCount: 0,
      attention: false,
      branchesError: null,
    });
    const childData = (child: ChildNode, selected: boolean) => ({
      child,
      selected,
      state: null,
      attention: false,
      lastLine: null,
      detail: null,
      stopping: false,
      forkedFromTitle: null,
    });

    it("a project card shows its toolbar when selected, not otherwise, and not while dragged", () => {
      const selected = render(<ProjectNode {...nodeProps<ProjectFlowNode>({ data: projectData(true), dragging: false })} />);
      expect(selected).toContain('<div class="node-toolbar nodrag nopan">');
      expect(selected).toContain('data-command="project.newSession"');
      expect(selected).toContain('aria-label="Project a"');
      expect(render(<ProjectNode {...nodeProps<ProjectFlowNode>({ data: projectData(false), dragging: false })} />)).not.toContain("node-toolbar");
      expect(render(<ProjectNode {...nodeProps<ProjectFlowNode>({ data: projectData(true), dragging: true })} />)).not.toContain("node-toolbar");
    });

    it("a session card shows the session's commands when selected", () => {
      const selected = render(<SessionNode {...nodeProps<SessionFlowNode>({ data: childData(SESSION, true), dragging: false })} />);
      expect(selected).toContain('data-command="session.resume"');
      expect(selected).toContain('data-command="session.fork"');
      expect(selected).not.toContain("project.newSession");
      expect(render(<SessionNode {...nodeProps<SessionFlowNode>({ data: childData(SESSION, false), dragging: false })} />)).not.toContain("node-toolbar");
      expect(render(<SessionNode {...nodeProps<SessionFlowNode>({ data: childData(SESSION, true), dragging: true })} />)).not.toContain("node-toolbar");
    });

    it("Story 11.5: a glowing, collapsed project card says what its glow, live badge and count mean", () => {
      const data = { ...projectData(false), project: { ...project("a"), expanded: false }, attention: true, attentionText: "fix login is waiting", liveCount: 3, childCount: 5 };
      const html = render(<ProjectNode {...nodeProps<ProjectFlowNode>({ data, dragging: false })} />);
      expect(html).toContain('aria-label="Project a, 3 sessions running, fix login is waiting" title="fix login is waiting"');
      expect(html).toContain('<span class="project-node-live" title="3 sessions running">3 live</span>');
      expect(html).toContain('<span class="project-node-badge" title="5 children, collapsed">5</span>');
      expect(html).toContain('aria-label="Expand, 5 children, collapsed"');
    });

    it("Story 11.5: a session asking for review shows the flag's meaning", () => {
      const child = { ...SESSION, label: "fix login", session: { startedAt: "", lastActive: "", branch: null, messages: 1 } };
      const data = { ...childData(child, false), review: true, state: { kind: "waiting" as const }, attention: true };
      const html = render(<SessionNode {...nodeProps<SessionFlowNode>({ data, dragging: false })} />);
      expect(html).toContain('title="asks for review · click to open" aria-label="fix login asks for review · click to open"');
      expect(html).toContain('title="waiting — Claude needs an answer; enter opens its terminal');
    });

    it("Story 11.5: an edge line carries its hover text as an SVG title", () => {
      const edgeProps = (hover: string) =>
        ({ sourceX: 0, sourceY: 0, targetX: 100, targetY: 0, sourcePosition: "right", targetPosition: "left", data: { edgeId: "e1", label: null, selected: false, live: null, hover } }) as unknown as EdgeProps<LinkFlowEdge>;
      expect(render(<svg><ContextEdge {...edgeProps("context edge · pending (waiting for idle)")} /></svg>)).toContain("<title>context edge · pending (waiting for idle)</title>");
      expect(render(<svg><CooperateEdge {...edgeProps("cooperate edge")} /></svg>)).toContain("<title>cooperate edge</title>");
    });

    it("a branch card shows the branch's commands when selected", () => {
      const selected = render(<BranchNode {...nodeProps<BranchFlowNode>({ data: childData(BRANCH, true), dragging: false })} />);
      expect(selected).toContain('data-command="branch.newSession"');
      expect(selected).toContain('data-command="branch.newWorktree"');
      expect(selected).not.toContain("session.resume");
      expect(render(<BranchNode {...nodeProps<BranchFlowNode>({ data: childData(BRANCH, false), dragging: false })} />)).not.toContain("node-toolbar");
      expect(render(<BranchNode {...nodeProps<BranchFlowNode>({ data: childData(BRANCH, true), dragging: true })} />)).not.toContain("node-toolbar");
    });
  });
});
