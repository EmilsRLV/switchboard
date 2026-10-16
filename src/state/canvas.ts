// The canvas store holds the live xyflow instance so commands (`canvas.fitView`) can drive
// the viewport from outside the React tree. It is UI plumbing, not workspace data: the
// persisted viewport lives in the workspace store, mirrored from Rust.

import { create } from "zustand";
import type { Viewport } from "../ipc";

/**
 * The slice of xyflow's `ReactFlowInstance` the app uses. Structural, so tests pass a plain
 * object and nothing outside `src/canvas/` imports `@xyflow/react`.
 */
export type CanvasInstance = {
  getNodes(): readonly unknown[];
  getViewport(): Viewport;
  setViewport(viewport: Viewport, options?: { duration?: number }): Promise<boolean>;
  fitView(options?: { padding?: number; duration?: number }): Promise<boolean>;
};

/** Where an empty canvas goes home to: no pan, 1:1. */
export const HOME_VIEWPORT: Readonly<Viewport> = Object.freeze({ x: 0, y: 0, zoom: 1 });

export type CanvasState = {
  /** The mounted canvas, set from `onInit`; `null` before mount and after unmount. */
  instance: CanvasInstance | null;
  setInstance: (instance: CanvasInstance | null) => void;
  /**
   * Fit every node into view; with no nodes (xyflow's `fitView` is then a no-op) go home to
   * `{0,0,1}`. Either way the move ends in xyflow's `onMoveEnd`, which persists it. Resolves
   * false when there is no canvas.
   */
  fitView: () => Promise<boolean>;
};

export const useCanvasStore = create<CanvasState>()((set, get) => ({
  instance: null,
  setInstance: (instance) => set({ instance }),
  fitView: async () => {
    const instance = get().instance;
    if (instance === null) return false;
    if (instance.getNodes().length === 0) {
      return instance.setViewport({ ...HOME_VIEWPORT });
    }
    return instance.fitView();
  },
}));

/** True once the canvas has mounted: the `when` of `canvas.fitView`. */
export function isCanvasReady(): boolean {
  return useCanvasStore.getState().instance !== null;
}
