import { useCallback, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  type NodeMouseHandler,
  type NodeTypes,
  type OnNodeDrag,
  type OnNodesChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { clickNode } from "../commands/navigation";
import { moveNode, rightClickNode } from "../commands/nodes";
import { dropProjects } from "../commands/projects";
import {
  hasTauriRuntime,
  onFileDrop,
  workspaceSetViewport,
  type ChildNode,
  type Position,
  type Project,
  type Viewport,
} from "../ipc";
import { HOME_VIEWPORT, clientToFlow, useCanvasStore, type CanvasElement } from "../state/canvas";
import { useLiveStore } from "../state/live";
import { useStatusStore } from "../state/status";
import { useUiStore } from "../state/ui";
import { persistViewport, useWorkspaceStore } from "../state/workspace";
import { BranchNode, MoreNode, SessionNode } from "./ChildNode";
import { MAX_ZOOM, MIN_ZOOM } from "./limits";
import {
  DRAG_THRESHOLD,
  dropTarget,
  parseFlowId,
  physicalToClient,
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
const NO_EDGES: never[] = [];
const NODE_TYPES: NodeTypes = { project: ProjectNode, session: SessionNode, branch: BranchNode, more: MoreNode };

/** Pan with the middle (1) or right (2) button; the left button pans only while Space is held. */
const PAN_BUTTONS = [1, 2];
const DOT_GAP = 24;
const DOT_SIZE = 1;

/**
 * The home surface: an infinite canvas with a dot grid holding one card per project and,
 * under an expanded project, a column of its children. Pan with middle/right drag or Space +
 * left drag, zoom with the wheel, `ctrl+0` fits the view. Drag any node to move it (a child
 * moves with its parent); click to select; right-click a project or session card for its menu. The
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
      ref={setCanvasElement}
      onPointerDownCapture={onPointerDownCapture}
      onPointerUpCapture={onPointerUpCapture}
      onContextMenu={suppress}
    >
      <ReactFlowProvider>
        <Flow initialViewport={workspace?.viewport ?? HOME_VIEWPORT} />
      </ReactFlowProvider>
      {empty && (
        <p className="canvas-hint">
          Add a project — <kbd>ctrl+o</kbd>, drop a folder, or <kbd>ctrl+k</kbd>
        </p>
      )}
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
 * would open at the start of every right-drag pan.
 */
let rightPress: RightPress | null = null;

function onPointerDownCapture(event: ReactPointerEvent): void {
  if (event.button !== 2) return;
  rightPress = { x: event.clientX, y: event.clientY, flowId: nodeIdAt(event.target) };
}

function onPointerUpCapture(event: ReactPointerEvent): void {
  if (event.button !== 2) return;
  const release = { x: event.clientX, y: event.clientY };
  const target = rightClickTarget(rightPress, release);
  rightPress = null;
  if (target === null) return;
  // A project or session card with enabled entries gets the menu (Attach for a live
  // session); anything else, a historic session included, is only selected.
  rightClickNode(target, release);
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
  const statuses = useStatusStore((s) => s.statuses);
  const live = useLiveStore((s) => s.snapshot.sessions);
  const flashed = useUiStore((s) => s.flashed);
  const selection = useUiStore((s) => s.selection);
  const showAll = useUiStore((s) => s.showAll);
  const dragging = useCanvasStore((s) => s.dragging);

  // The previous derivation, so unchanged nodes keep their identity (and skip re-rendering).
  const previousRef = useRef<CanvasFlowNode[]>([]);
  const nodes = useMemo(() => {
    const next = toFlowNodes({ projects, statuses, flashed, children, selection, dragging, showAll, live }, previousRef.current);
    previousRef.current = next;
    return next;
  }, [projects, statuses, flashed, children, selection, dragging, showAll, live]);

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
    if (target.kind === "more") return;
    void moveNode(target, position);
  }, []);

  // A click selects; on a `more` row it also shows all (or fewer) of the project's children.
  const onNodeClick = useCallback<NodeMouseHandler<CanvasFlowNode>>((_event, node) => {
    clickNode(node.id);
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

  // Folders dropped from the OS (Tauri's native drag-drop; HTML5 DnD is off in the webview):
  // the drop point comes in physical pixels, goes to CSS pixels, then to canvas coordinates.
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | null = null;
    onFileDrop((drop) => {
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
      edges={NO_EDGES}
      nodeTypes={NODE_TYPES}
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
      nodesConnectable={false}
      nodesFocusable={false}
      disableKeyboardA11y
      elementsSelectable={false}
      onInit={onInit}
      onMoveEnd={onMoveEnd}
      onNodesChange={onNodesChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
    >
      <Background variant={BackgroundVariant.Dots} gap={DOT_GAP} size={DOT_SIZE} color="var(--fg-faint)" />
    </ReactFlow>
  );
}
