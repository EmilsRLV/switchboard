// The actions behind dragging, expanding, collapsing, re-laying-out and removing nodes. Rust
// owns the model: each one ends in a workspace command whose snapshot is applied to the
// workspace store. Nothing rejects: `runCommand` has no error UI, so a failure lands in the
// workspace load-error banner.

import { flowIdOf } from "../canvas/nodes";
import {
  workspaceMoveNode,
  workspaceRelayoutChildren,
  workspaceRemoveProject,
  workspaceSetExpanded,
  type NodeTarget,
  type Position,
  type WorkspaceSnapshot,
} from "../ipc";
import { useCanvasStore } from "../state/canvas";
import { sameTarget, useUiStore, type MenuPoint } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { listCommands, type Command, type RegisteredCommand } from "./registry";

/** Commands without a `menuOrder` sort after every command with one. */
const UNORDERED = Number.MAX_SAFE_INTEGER;

/**
 * The node context menu's rows: the enabled commands tagged `menu: "node"`, in `menuOrder`
 * (then title, which `listCommands` already provides and the stable sort keeps).
 */
export function nodeMenuCommands(): RegisteredCommand[] {
  return listCommands({ enabledOnly: true })
    .filter((command) => command.menu === "node")
    .sort((a, b) => (a.menuOrder ?? UNORDERED) - (b.menuOrder ?? UNORDERED));
}

/** The menu group of a command (its `menuOrder`'s tens); a separator goes between groups. */
export function menuGroup(command: Pick<Command, "menuOrder">): number {
  return Math.floor((command.menuOrder ?? UNORDERED) / 10);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one mutation and apply what comes back. Resolves true when Rust accepted it; a
 * rejection (unknown id, no runtime) becomes the `workspace.load` banner and resolves false.
 */
export async function mutate(what: string, send: () => Promise<WorkspaceSnapshot>): Promise<boolean> {
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

/**
 * `project.remove`: take the project off the canvas, immediately (no confirmation, no undo).
 * Rust drops it with its children's refs, branches, edges and live status and emits both
 * snapshots; here the selection is cleared when it pointed at the removed project or one of
 * its children -- and still does once the reply is in (a node selected meanwhile stays).
 */
export async function removeProject(projectId: string): Promise<boolean> {
  const selection = useUiStore.getState().selection;
  const children = useWorkspaceStore.getState().snapshot?.children ?? [];
  const pointedAtIt =
    selection !== null &&
    (selection.kind === "project" || selection.kind === "more"
      ? selection.id === projectId
      : children.some((child) => child.projectId === projectId && child.kind === selection.kind && child.id === selection.id));
  const removed = await mutate("remove", () => workspaceRemoveProject(projectId));
  if (removed) {
    const ui = useUiStore.getState();
    if (pointedAtIt && sameTarget(ui.selection, selection)) ui.clearSelection();
    if (ui.showAll.includes(projectId)) ui.toggleShowAll(projectId);
  }
  return removed;
}

/** A right-click on a node: select it, then open the menu at the pointer. */
export function openContextMenuFor(target: NodeTarget, at: MenuPoint): void {
  const ui = useUiStore.getState();
  ui.select(target);
  ui.openContextMenu(at);
}
