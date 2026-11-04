import { useCallback, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  type Connection,
  type Edge,
  type EdgeMouseHandler,
  type EdgeProps,
  type EdgeTypes,
  type IsValidConnection,
  type NodeMouseHandler,
  type OnConnectEnd,
  type NodeTypes,
  type OnNodeDrag,
  type OnNodesChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { clickEdge, link, refuseDrop } from "../commands/edges";
import { clickNode } from "../commands/navigation";
import { moveNode, rightClickCanvas, rightClickNode } from "../commands/nodes";
import { dropProjects } from "../commands/projects";
import {
  hasTauriRuntime,
  onFileDrop,
  workspaceSetViewport,
  type ChildNode,
  type Edge as StoredEdge,
  type Position,
  type Project,
  type Viewport,
} from "../ipc";
import { HOME_VIEWPORT, clientToFlow, useCanvasStore, type CanvasElement } from "../state/canvas";
import { useEdgesLiveStore } from "../state/edgesLive";
import { useInboxStore } from "../state/inbox";
import { flaggedIds, useReviewStore } from "../state/review";
import { useLiveStore } from "../state/live";
import { useStatusStore } from "../state/status";
import { stoppingSessionIds, useTerminalStore } from "../state/terminals";
import { useUiStore } from "../state/ui";
import { persistViewport, useWorkspaceStore } from "../state/workspace";
import { reportFirstFrame } from "../perf";
import { isTourOn, tourFirstFrame } from "../state/tour";
import { BranchNode, MoreNode, SessionNode } from "./ChildNode";
import { FORK_HANDLE, checkFlowLink, linkFlowEdges, nodeRefOfFlowId, type LinkEdgeData, type LinkFlowEdge } from "./edges";
import { GhostCard } from "./GhostCard";
import { MAX_ZOOM, MIN_ZOOM } from "./limits";
import {
  DRAG_THRESHOLD,
  dropTarget,
  forkLinePath,
  forkLines,
  parseFlowId,
  physicalToClient,
  rightClickBackground,
  rightClickTarget,
  toFlowNodes,
  type CanvasFlowNode,
  type RightPress,
} from "./nodes";
import { ProjectNode } from "./ProjectNode";
import "./canvas.css";
import "./nodes.css";

// Stable collections: a fresh `[]` / `{}` per render would make xyflow diff every time.
const NO_PROJECTS: readonly Project[] = [];
const NO_CHILDREN: readonly ChildNode[] = [];
const NO_BRANCH_ERRORS: Readonly<Record<string, string>> = Object.freeze({});
const NO_STOPPING: readonly string[] = [];
const NO_EDGES: readonly StoredEdge[] = [];
const NODE_TYPES: NodeTypes = { project: ProjectNode, session: SessionNode, branch: BranchNode, more: MoreNode };

/**
 * The "forked from" line (Story 4.4): a thin, muted curve between the left edges of a fork's
 * card and its original's, with no arrowhead and no accent. Not interactive, and not an edge
 * kind: a rendering of the fork's `forkedFrom`.
 */
function ForkEdge({ sourceX, sourceY, targetX, targetY }: EdgeProps) {
  return <BaseEdge path={forkLinePath(sourceX, sourceY, targetX, targetY)} className="fork-line" interactionWidth={0} />;
}

/** How wide (flow px) the invisible stroke that takes a click on an edge is. */
const LINK_HIT_WIDTH = 12;

/**
 * A stored edge's label (Story 6.1): at the line's midpoint, muted `--text-xs`, cut with an
 * ellipsis (the full text on hover). A click on it selects the edge like a click on its line.
 */
function LinkLabel({ x, y, data }: { x: number; y: number; data: LinkEdgeData | undefined }) {
  if (data === undefined || data.label === null) return null;
  const { edgeId, label, selected } = data;
  return (
    <EdgeLabelRenderer>
      <div
        className={"link-label nodrag nopan" + (selected ? " is-selected" : "")}
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
        title={label}
        onClick={() => clickEdge(edgeId)}
      >
        {label}
      </div>
    </EdgeLabelRenderer>
  );
}

/**
 * A stored edge's tooltip (Story 11.5): an SVG `<title>` in the edge's own `<g>` (xyflow's edge
 * wrapper), so it shows on hover anywhere over the line, its hit width included.
 */
function EdgeTitle({ data }: { data: LinkEdgeData | undefined }) {
  return data === undefined ? null : <title>{data.hover}</title>;
}

/**
 * A context edge (Story 6.1): a dashed 1-px `--border-strong` curve; `--focus` while selected.
 * Story 6.3: muted while it is being applied to a running session (`is-pending` on the edge),
 * in the attention accent once that failed (the line carries `.attention`).
 */
export function ContextEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<LinkFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const failed = data?.live === "failed";
  return (
    <>
      <EdgeTitle data={data} />
      <BaseEdge path={path} className={failed ? "attention link-line link-context" : "link-line link-context"} interactionWidth={LINK_HIT_WIDTH} />
      <LinkLabel x={labelX} y={labelY} data={data} />
    </>
  );
}

/**
 * A cooperate edge (Story 6.1): two parallel 1-px `--border-strong` lines -- a 3-px stroke with
 * its middle pixel drawn over in the canvas colour; `--focus` while selected. Story 6.4: muted
 * while a side's peer line is pending, in the attention accent once a side failed.
 */
export function CooperateEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<LinkFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const failed = data?.live === "failed";
  return (
    <>
      <EdgeTitle data={data} />
      <BaseEdge path={path} className={failed ? "attention link-line link-cooperate" : "link-line link-cooperate"} interactionWidth={LINK_HIT_WIDTH} />
      <path d={path} className="link-cooperate-gap" fill="none" />
      <LinkLabel x={labelX} y={labelY} data={data} />
    </>
  );
}

const EDGE_TYPES: EdgeTypes = { fork: ForkEdge, context: ContextEdge, cooperate: CooperateEdge };

/** Pan with the middle (1) or right (2) button; the left button pans only while Space is held. */
const PAN_BUTTONS = [1, 2];
const DOT_GAP = 24;
const DOT_SIZE = 1;

/**
 * The home surface: an infinite canvas with a dot grid holding one card per project and,
 * under an expanded project, a column of its children. Pan with middle/right drag or Space +
 * left drag, zoom with the wheel, `ctrl+0` fits the view. Drag any node to move it (a child
 * moves with its parent); click to select; right-click a project or session card for its menu.
 * Drag from a session or project card's handle onto another card to link them (Story 6.1); click
 * an edge to select it. The
 * viewport and every position come from Rust's snapshot and go back to it at the end of each
 * gesture. Projects come from Rust's snapshot (`ctrl+o`, a folder dropped from the OS, or
 * Import from Claude); their git lines from the status store.
 */
export function Canvas() {
  const snapshot = useWorkspaceStore((s) => s.snapshot);
  const loadError = useWorkspaceStore((s) => s.loadError);

  // xyflow reads `defaultViewport` once, at mount, so the flow mounts only after the
  // snapshot is in. When the read failed (banner says so) or there is no Tauri runtime
  // (plain browser), none will come: mount at home and keep the viewport in memory.
  if (snapshot === null && loadError === null && hasTauriRuntime()) {
    return <div className="canvas" aria-busy="true" />;
  }
  const workspace = snapshot?.workspace;
  const empty = (workspace?.projects.length ?? 0) === 0;

  return (
    // A stable callback ref: the store always holds the element that is actually mounted,
    // and React does not re-register it on every render. The pointer handlers are the
    // right-click guard (see `rightPress`); `contextmenu` itself is only ever suppressed, so
    // the webview's native menu never shows.
    <div
      className="canvas"
      data-tour="canvas"
      ref={setCanvasElement}
      onPointerDownCapture={onPointerDownCapture}
      onPointerUpCapture={onPointerUpCapture}
      onContextMenu={suppress}
    >
      <ReactFlowProvider>
        <Flow initialViewport={workspace?.viewport ?? HOME_VIEWPORT} />
      </ReactFlowProvider>
      {/* Story 11.3: the ghost card, centred in the canvas element while there is no project. */}
      {empty && <GhostCard />}
    </div>
  );
}

function setCanvasElement(element: HTMLDivElement | null): void {
  useCanvasStore.getState().setElement(element);
}

function suppress(event: { preventDefault(): void }): void {
  event.preventDefault();
}

/**
 * The right-click guard. A right button press is a pan (xyflow pans on button 2) or a
 * context-menu request; which one is known only at release (`rightClickTarget`): moved at
 * most `DRAG_THRESHOLD` since the press on a node, it selects the node and, for a project
 * or session card, opens its menu. Deciding at release also works where
 * the webview fires `contextmenu` on press (webkit2gtk), which a `contextmenu`-driven menu
 * would open at the start of every right-drag pan. Story 11.1: the same rule on the canvas
 * background (`rightClickBackground`: the pane or the ghost card, never a node, an edge
 * or a handle) opens the canvas menu instead, leaving the selection as it is.
 */
let rightPress: RightPress | null = null;

function onPointerDownCapture(event: ReactPointerEvent): void {
  if (event.button !== 2) return;
  rightPress = {
    x: event.clientX,
    y: event.clientY,
    flowId: nodeIdAt(event.target),
    onBackground: isBackground(event.target),
  };
}

function onPointerUpCapture(event: ReactPointerEvent): void {
  if (event.button !== 2) return;
  const release = { x: event.clientX, y: event.clientY };
  const press = rightPress;
  rightPress = null;
  if (rightClickBackground(press, release)) {
    rightClickCanvas(release);
    return;
  }
  const target = rightClickTarget(press, release);
  if (target === null) return;
  // A project or session card with enabled entries gets the menu (Attach for a live
  // session); anything else, a historic session included, is only selected.
  rightClickNode(target, release);
}

/**
 * Whether `target` is the canvas background: inside xyflow's pane (and not in a node, an edge
 * or a handle drawn over it) or the ghost card (Story 11.3).
 */
function isBackground(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".react-flow__node, .react-flow__edge, .react-flow__handle, .react-flow__edgelabel-renderer") !== null) return false;
  return target.closest(".react-flow__pane, .ghost-card") !== null;
}

/** The flow id of the node wrapper containing `target`, if any (xyflow's `data-id`). */
function nodeIdAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(".react-flow__node")?.dataset.id ?? null;
}

/**
 * Whether a drop at client `(x, y)` landed on the canvas itself: not on a pane over it (the
 * settings or import pane has class `pane`), and inside the canvas element. Tauri reports
 * drops anywhere on the webview.
 */
function dropHitsCanvas(client: Position, canvas: CanvasElement | null): boolean {
  const target = document.elementFromPoint(client.x, client.y);
  if (target === null || target.closest(".pane") !== null) return false;
  if (canvas === null) return true;
  const rect = canvas.getBoundingClientRect();
  return (
    client.x >= rect.left && client.x <= rect.left + rect.width && client.y >= rect.top && client.y <= rect.top + rect.height
  );
}

function Flow({ initialViewport }: { initialViewport: Viewport }) {
  const projects = useWorkspaceStore((s) => s.snapshot?.workspace.projects ?? NO_PROJECTS);
  const children = useWorkspaceStore((s) => s.snapshot?.children ?? NO_CHILDREN);
  const branchErrors = useWorkspaceStore((s) => s.snapshot?.branchErrors ?? NO_BRANCH_ERRORS);
  // Story 7.3: unread peer messages per session, for the `N new` badge.
  const unread = useInboxStore((s) => s.unread);
  // Story 7.4: the flagged sessions, for the `review` flag.
  const reviewRequests = useReviewStore((s) => s.requests);
  const review = useMemo(() => flaggedIds(reviewRequests), [reviewRequests]);
  const storedEdges = useWorkspaceStore((s) => s.snapshot?.workspace.edges ?? NO_EDGES);
  const edgesLive = useEdgesLiveStore((s) => s.entries);
  const statuses = useStatusStore((s) => s.statuses);
  const live = useLiveStore((s) => s.snapshot.sessions);
  const flashed = useUiStore((s) => s.flashed);
  const selection = useUiStore((s) => s.selection);
  const showAll = useUiStore((s) => s.showAll);
  const showAllBranches = useUiStore((s) => s.showAllBranches);
  const dragging = useCanvasStore((s) => s.dragging);
  const terminals = useTerminalStore((s) => s.infos);
  // Sessions whose Switchboard terminal is being stopped: their word reads `stopping`.
  const stopping = useMemo(() => {
    const ids = stoppingSessionIds(terminals);
    return ids.length === 0 ? NO_STOPPING : ids;
  }, [terminals]);

  // The previous derivation, so unchanged nodes keep their identity (and skip re-rendering).
  const previousRef = useRef<CanvasFlowNode[]>([]);
  const nodes = useMemo(() => {
    const next = toFlowNodes(
      { projects, statuses, flashed, children, selection, dragging, showAll, showAllBranches, live, stopping, branchErrors, unread, review },
      previousRef.current,
    );
    previousRef.current = next;
    return next;
  }, [projects, statuses, flashed, children, selection, dragging, showAll, showAllBranches, live, stopping, branchErrors, unread, review]);

  // The "forked from" lines between drawn cards (Story 4.4), inert; then the stored edges whose
  // two ends are drawn (Story 6.1).
  const edges = useMemo<Edge[]>(
    () => [
      ...forkLines(nodes).map((line) => ({
        ...line,
        sourceHandle: FORK_HANDLE,
        targetHandle: FORK_HANDLE,
        type: "fork",
        selectable: false,
        focusable: false,
        deletable: false,
        interactionWidth: 0,
      })),
      ...linkFlowEdges(storedEdges, nodes, selection, edgesLive),
    ],
    [nodes, storedEdges, selection, edgesLive],
  );

  // The viewport most recently sent to Rust, acknowledged or not: a gesture that ends where
  // an in-flight write is going is skipped; one that comes back to the stored viewport goes.
  const lastSentRef = useRef<Viewport | null>(null);

  // End of a pan/zoom (gesture or programmatic): persist, unless it landed where the canvas
  // already is. No timer; the gesture's end is the moment.
  const onMoveEnd = useCallback((_event: unknown, viewport: Viewport) => {
    const store = useWorkspaceStore.getState();
    void persistViewport(viewport, {
      lastSent: lastSentRef.current,
      stored: store.snapshot?.workspace.viewport,
      hasRuntime: hasTauriRuntime(),
      send: (next) => {
        lastSentRef.current = next;
        return workspaceSetViewport(next);
      },
      apply: (snapshot) => {
        store.applySnapshot(snapshot);
        store.setLoadError(null); // the round trip works again
      },
      fail: store.setLoadError,
    });
  }, []);

  // xyflow's node changes: only the positions of a drag in progress are taken, as transient
  // overrides. Selection changes are never applied (selection is the ui store's), and
  // dimension changes are xyflow's own bookkeeping.
  const onNodesChange = useCallback<OnNodesChange<CanvasFlowNode>>((changes) => {
    const canvas = useCanvasStore.getState();
    for (const change of changes) {
      if (change.type === "position" && change.position !== undefined) {
        canvas.setDragPosition(change.id, change.position);
      }
    }
  }, []);

  // Dragging selects (and dismisses the menu); dropping writes the position once, where the
  // override says the node is (xyflow's `node` may lag a frame behind the last change).
  const onNodeDragStart = useCallback<OnNodeDrag<CanvasFlowNode>>((_event, node) => {
    const ui = useUiStore.getState();
    ui.closeContextMenu();
    ui.select(parseFlowId(node.id));
  }, []);

  const onNodeDragStop = useCallback<OnNodeDrag<CanvasFlowNode>>((_event, node) => {
    const [target, position] = dropTarget(node.id, useCanvasStore.getState().dragging, node.position);
    // A `more` row is not draggable and has no position to store.
    if (target.kind === "more" || target.kind === "edge") return;
    void moveNode(target, position);
  }, []);

  // A click selects; on a `more` row it also shows all (or fewer) of the project's children.
  const onNodeClick = useCallback<NodeMouseHandler<CanvasFlowNode>>((_event, node) => {
    clickNode(node.id);
  }, []);

  // Story 6.1: a click on a stored edge selects it and opens its inspector; fork lines are inert.
  const onEdgeClick = useCallback<EdgeMouseHandler>((_event, edge) => {
    const target = parseFlowId(edge.id);
    if (target.kind === "edge") clickEdge(target.id);
  }, []);

  // Dragging from a card's handle: a card the pair is refused for shows the not-allowed state
  // (Rust decides on the drop); a valid drop asks Rust for the edge; a refused one says why.
  const isValidConnection = useCallback<IsValidConnection>((connection) => {
    const edges = useWorkspaceStore.getState().snapshot?.workspace.edges ?? NO_EDGES;
    return checkFlowLink(edges, connection.source, connection.target).kind !== null;
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    const from = nodeRefOfFlowId(connection.source);
    const to = nodeRefOfFlowId(connection.target);
    if (from !== null && to !== null) void link(from, to);
  }, []);

  const onConnectEnd = useCallback<OnConnectEnd>((_event, state) => {
    if (state.isValid === true || state.fromNode === null) return;
    refuseDrop(state.fromNode.id, state.toNode?.id ?? null);
  }, []);

  const onPaneClick = useCallback(() => {
    const ui = useUiStore.getState();
    ui.closeContextMenu();
    ui.clearSelection();
  }, []);

  const onInit = useCallback((instance: ReactFlowInstance<CanvasFlowNode>) => {
    useCanvasStore.getState().setInstance(instance);
  }, []);

  // The instance dies with the flow; commands check `isCanvasReady` before using it.
  useEffect(() => () => useCanvasStore.getState().setInstance(null), []);

  // Story 9.3: the flow mounts only once the workspace snapshot is in, so its first painted frame
  // is the end of startup (Rust holds the clock; only the first report counts).
  // Story 11.6: the first-run tour starts after that frame too (when due; also without Tauri,
  // from the loaded flags).
  useEffect(() => {
    if (hasTauriRuntime()) reportFirstFrame();
    tourFirstFrame();
  }, []);

  // Folders dropped from the OS (Tauri's native drag-drop; HTML5 DnD is off in the webview):
  // the drop point comes in physical pixels, goes to CSS pixels, then to canvas coordinates.
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | null = null;
    onFileDrop((drop) => {
      // Story 11.6: nothing changes under the tour's dim.
      if (isTourOn()) return;
      const client = physicalToClient(drop.position, window.devicePixelRatio);
      if (!dropHitsCanvas(client, useCanvasStore.getState().element)) return;
      const position = clientToFlow(client);
      if (position !== null) void dropProjects(drop.paths, position);
    })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      .catch((err: unknown) => console.error("drag-drop listener failed:", err));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      edgesFocusable={false}
      edgesReconnectable={false}
      defaultViewport={initialViewport}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      panOnDrag={PAN_BUTTONS}
      panActivationKeyCode="Space"
      zoomOnDoubleClick={false}
      selectionOnDrag={false}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      deleteKeyCode={null}
      nodesDraggable
      nodeDragThreshold={DRAG_THRESHOLD}
      selectNodesOnDrag={false}
      nodesConnectable
      connectionRadius={0}
      nodesFocusable={false}
      disableKeyboardA11y
      elementsSelectable={false}
      onInit={onInit}
      onMoveEnd={onMoveEnd}
      onNodesChange={onNodesChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={onNodeClick}
      onEdgeClick={onEdgeClick}
      isValidConnection={isValidConnection}
      onConnect={onConnect}
      onConnectEnd={onConnectEnd}
      onPaneClick={onPaneClick}
    >
      <Background variant={BackgroundVariant.Dots} gap={DOT_GAP} size={DOT_SIZE} color="var(--fg-faint)" />
    </ReactFlow>
  );
}
