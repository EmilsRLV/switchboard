// The actions behind dragging, expanding, collapsing and re-laying-out nodes. Rust owns the
// model: each one ends in a workspace command whose snapshot is applied to the workspace
// store. Nothing rejects: `runCommand` has no error UI, so a failure lands in the workspace
// load-error banner.

import { flowIdOf } from "../canvas/nodes";
import {
  workspaceMoveNode,
  workspaceRelayoutChildren,
  workspaceSetExpanded,
  type NodeTarget,
  type Position,
  type WorkspaceSnapshot,
} from "../ipc";
import { useCanvasStore } from "../state/canvas";
import { useUiStore, type MenuPoint } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { listCommands, type RegisteredCommand } from "./registry";

/** The node context menu's rows: the enabled commands tagged `menu: "node"`, by title. */
export function nodeMenuCommands(): RegisteredCommand[] {
  return listCommands({ enabledOnly: true }).filter((command) => command.menu === "node");
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one mutation and apply what comes back. Resolves true when Rust accepted it; a
 * rejection (unknown id, no runtime) becomes the `workspace.load` banner and resolves false.
 */
async function mutate(what: string, send: () => Promise<WorkspaceSnapshot>): Promise<boolean> {
  let snapshot: WorkspaceSnapshot;
  try {
    snapshot = await send();
  } catch (err) {
    useWorkspaceStore.getState().setLoadError(`${what} failed: ${describe(err)}`);
    return false;
  }
  const store = useWorkspaceStore.getState();
  store.applySnapshot(snapshot);
  store.setLoadError(null); // the round trip works again
  return true;
}

/**
 * The end of a drag: store `position` for `target` (absolute for a project, relative to the
 * parent card for a child, as xyflow reports it). The snapshot is applied first and the drag
 * override cleared after, in one synchronous step, so there is never a frame in which the
 * node has no position. A failed write clears the override too: Rust's snapshot is the truth.
 * The override is cleared only while it is still the position this call sent: a newer drag
 * of the same node (replied to later) keeps its own.
 */
export async function moveNode(target: NodeTarget, position: Position): Promise<boolean> {
  try {
    return await mutate("node move", () => workspaceMoveNode(target, position));
  } finally {
    const canvas = useCanvasStore.getState();
    const id = flowIdOf(target);
    const current = Object.hasOwn(canvas.dragging, id) ? canvas.dragging[id] : undefined;
    if (current !== undefined && current.x === position.x && current.y === position.y) canvas.clearDrag(id);
  }
}

/** `project.expand` / `project.collapse`: persist `expanded` for the project. */
export function setExpanded(projectId: string, expanded: boolean): Promise<boolean> {
  return mutate(expanded ? "expand" : "collapse", () => workspaceSetExpanded(projectId, expanded));
}

/** `project.relayout`: put the project's children back into their column. */
export function relayoutChildren(projectId: string): Promise<boolean> {
  return mutate("re-layout", () => workspaceRelayoutChildren(projectId));
}

/** A right-click on a node: select it, then open the menu at the pointer. */
export function openContextMenuFor(target: NodeTarget, at: MenuPoint): void {
  const ui = useUiStore.getState();
  ui.select(target);
  ui.openContextMenu(at);
}
