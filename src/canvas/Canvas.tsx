import { useCallback, useEffect, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { hasTauriRuntime, workspaceSetViewport, type Viewport } from "../ipc";
import { HOME_VIEWPORT, useCanvasStore } from "../state/canvas";
import { persistViewport, useWorkspaceStore } from "../state/workspace";
import { MAX_ZOOM, MIN_ZOOM } from "./limits";
import "./canvas.css";

// Stable empty collections: a fresh `[]` per render would make xyflow diff nodes every time.
const NO_NODES: never[] = [];
const NO_EDGES: never[] = [];

/** Pan with the middle (1) or right (2) button; the left button pans only while Space is held. */
const PAN_BUTTONS = [1, 2];
const DOT_GAP = 24;
const DOT_SIZE = 1;

/**
 * The home surface: an infinite canvas with a dot grid. Pan with middle/right drag or
 * Space + left drag, zoom with the wheel, `ctrl+0` fits the view. The viewport is restored
 * from the workspace snapshot and written back at the end of every gesture that moved it.
 * Nodes arrive in Stories 2.2–2.4; until then an empty-state hint sits in the middle.
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
    <div className="canvas">
      <ReactFlowProvider>
        <Flow initialViewport={workspace?.viewport ?? HOME_VIEWPORT} />
      </ReactFlowProvider>
      {empty && (
        <p className="canvas-hint">
          Add a project — <kbd>ctrl+k</kbd>
        </p>
      )}
    </div>
  );
}

function Flow({ initialViewport }: { initialViewport: Viewport }) {
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

  const onInit = useCallback((instance: ReactFlowInstance) => {
    useCanvasStore.getState().setInstance(instance);
  }, []);

  // The instance dies with the flow; commands check `isCanvasReady` before using it.
  useEffect(() => () => useCanvasStore.getState().setInstance(null), []);

  return (
    <ReactFlow
      nodes={NO_NODES}
      edges={NO_EDGES}
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
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      onInit={onInit}
      onMoveEnd={onMoveEnd}
    >
      <Background variant={BackgroundVariant.Dots} gap={DOT_GAP} size={DOT_SIZE} color="var(--border)" />
    </ReactFlow>
  );
}
