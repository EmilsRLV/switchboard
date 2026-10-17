// The canvas store holds the live xyflow instance so commands (`canvas.fitView`,
// `project.add`) can drive the viewport from outside the React tree, and the transient
// positions of nodes being dragged. It is UI plumbing, not workspace data: the persisted
// viewport and every settled position live in the workspace store, mirrored from Rust.

import { create } from "zustand";
import type { Position, Viewport } from "../ipc";

/**
 * The slice of xyflow's `ReactFlowInstance` the app uses. Structural, so tests pass a plain
 * object and nothing outside `src/canvas/` imports `@xyflow/react`.
 */
export type CanvasInstance = {
  getNodes(): readonly unknown[];
  getViewport(): Viewport;
  setViewport(viewport: Viewport, options?: { duration?: number }): Promise<boolean>;
  fitView(options?: { padding?: number; duration?: number }): Promise<boolean>;
  /** Client (CSS pixel, page-relative) coordinates → canvas coordinates. */
  screenToFlowPosition(client: Position): Position;
};

/** The slice of the canvas's DOM element the store reads: where it is on the page. */
export type CanvasElement = {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
};

/** Where an empty canvas goes home to: no pan, 1:1. */
export const HOME_VIEWPORT: Readonly<Viewport> = Object.freeze({ x: 0, y: 0, zoom: 1 });

/** Flow-node id → position, for the nodes a drag is moving right now. */
export type DragOverrides = Readonly<Record<string, Position>>;

const NO_DRAG: DragOverrides = Object.freeze({});

export type CanvasState = {
  /** The mounted canvas, set from `onInit`; `null` before mount and after unmount. */
  instance: CanvasInstance | null;
  /** The canvas's element, for its on-page rectangle; `null` while unmounted. */
  element: CanvasElement | null;
  /**
   * Positions xyflow reported for nodes mid-drag (relative to the parent for a child, as
   * xyflow reports them). They override the snapshot's positions until the drop has gone
   * through Rust and come back, so a snapshot arriving mid-drag cannot snap the node back.
   * Reference-stable (the shared empty object) while nothing is dragged.
   */
  dragging: DragOverrides;
  setInstance: (instance: CanvasInstance | null) => void;
  setElement: (element: CanvasElement | null) => void;
  /** Record where a drag has moved the node with flow id `id`. */
  setDragPosition: (id: string, position: Position) => void;
  /** Forget the override of `id` (the drop has been applied); a no-op when there is none. */
  clearDrag: (id: string) => void;
  /**
   * Fit every node into view; with no nodes (xyflow's `fitView` is then a no-op) go home to
   * `{0,0,1}`. Either way the move ends in xyflow's `onMoveEnd`, which persists it. Resolves
   * false when there is no canvas.
   */
  fitView: () => Promise<boolean>;
};

export const useCanvasStore = create<CanvasState>()((set, get) => ({
  instance: null,
  element: null,
  dragging: NO_DRAG,
  setInstance: (instance) => set({ instance }),
  setElement: (element) => set({ element }),
  setDragPosition: (id, position) =>
    set((s) => ({ dragging: { ...s.dragging, [id]: { x: position.x, y: position.y } } })),
  clearDrag: (id) =>
    set((s) => {
      if (!(id in s.dragging)) return {};
      const { [id]: _dropped, ...rest } = s.dragging;
      return { dragging: Object.keys(rest).length === 0 ? NO_DRAG : rest };
    }),
  fitView: async () => {
    const instance = get().instance;
    if (instance === null) return false;
    if (instance.getNodes().length === 0) {
      return instance.setViewport({ ...HOME_VIEWPORT });
    }
    return instance.fitView();
  },
}));

/** True once the canvas has mounted: the `when` of `canvas.fitView` and `project.add`. */
export function isCanvasReady(): boolean {
  return useCanvasStore.getState().instance !== null;
}

/**
 * The canvas coordinate at the middle of what is on screen: where the picker and the import
 * put new nodes. `null` without a mounted canvas. Without the element's rectangle (not yet
 * measured) the middle of the viewport is computed from the transform alone, as if the
 * canvas filled the window at (0,0).
 */
export function viewportCentre(): Position | null {
  const { instance, element } = useCanvasStore.getState();
  if (instance === null) return null;
  const rect = element?.getBoundingClientRect();
  if (rect === undefined) {
    const { x, y, zoom } = instance.getViewport();
    const w = typeof window === "undefined" ? 0 : window.innerWidth;
    const h = typeof window === "undefined" ? 0 : window.innerHeight;
    return { x: (w / 2 - x) / zoom, y: (h / 2 - y) / zoom };
  }
  return instance.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
}

/** Client coordinates (CSS pixels) → canvas coordinates; `null` without a mounted canvas. */
export function clientToFlow(client: Position): Position | null {
  const instance = useCanvasStore.getState().instance;
  return instance === null ? null : instance.screenToFlowPosition(client);
}
