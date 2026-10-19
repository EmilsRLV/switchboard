// The actions behind dragging, expanding, collapsing, re-laying-out and removing nodes. Rust
// owns the model: each one ends in a workspace command whose snapshot is applied to the
// workspace store. Nothing rejects: `runCommand` has no error UI, so a failure lands in the
// workspace load-error banner.

import { forgetProjectTerminals } from "./terminal";
import { branchesChipShown, flowIdOf, rightClickAction, type CanvasTarget } from "../canvas/nodes";
import {
  projectSetShowBranches,
  workspaceMoveNode,
  workspaceRelayoutChildren,
  workspaceRemoveProject,
  workspaceSetExpanded,
  type NodeTarget,
  type Position,
  type WorkspaceSnapshot,
} from "../ipc";
import { useCanvasStore } from "../state/canvas";
import { useStatusStore } from "../state/status";
import { sameTarget, selectedProject, useUiStore, type MenuPoint } from "../state/ui";
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

/**
 * The `when` of `project.toggleBranches` (Story 5.1): the selected project is a git repo (by
 * the status poll), or has branches on (so they can always be turned off, even once the
 * folder stopped being a repo). A plain folder with branches off has no chip and no command.
 */
export function canToggleBranches(): boolean {
  const project = selectedProject();
  return project !== null && branchesChipShown(project, useStatusStore.getState().statuses[project.id]?.kind === "repo");
}

/** The title of `project.toggleBranches` for the selected project: `Show branches` or `Hide branches`. */
export function toggleBranchesTitle(): string {
  return selectedProject()?.showBranches === true ? "Hide branches" : "Show branches";
}

/**
 * `project.toggleBranches` (the card's "branches" chip): show or hide the project's branch
 * children. Rust persists the toggle (turning it on expands a collapsed card) and reads the
 * list; turning it off also drops the branch group's `show all`. (The command runs on the
 * selected project, so no branch card can be selected then.) Resolves whether Rust accepted it.
 */
export async function toggleBranches(projectId: string): Promise<boolean> {
  const project = useWorkspaceStore.getState().snapshot?.workspace.projects.find((p) => p.id === projectId);
  if (project === undefined) return false;
  const show = !project.showBranches;
  const done = await mutate(show ? "show branches" : "hide branches", () => projectSetShowBranches(projectId, show));
  if (done && !show) {
    const ui = useUiStore.getState();
    if (ui.showAllBranches.includes(projectId)) ui.toggleShowAll(projectId, "branches");
  }
  return done;
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
    (selection.kind === "project"
      ? selection.id === projectId
      : selection.kind === "more"
        ? selection.id === projectId
        : children.some((child) => child.projectId === projectId && child.kind === selection.kind && child.id === selection.id));
  const removed = await mutate("remove", () => workspaceRemoveProject(projectId));
  if (removed) {
    const ui = useUiStore.getState();
    if (pointedAtIt && sameTarget(ui.selection, selection)) ui.clearSelection();
    if (ui.showAll.includes(projectId)) ui.toggleShowAll(projectId);
    if (useUiStore.getState().showAllBranches.includes(projectId)) useUiStore.getState().toggleShowAll(projectId, "branches");
    // Rust killed its terminals; their views go too.
    forgetProjectTerminals(projectId);
  }
  return removed;
}

/**
 * A right-click release on a canvas node (the canvas's guard decided it was a click): select
 * it, then open the menu at the pointer when {@link rightClickAction} says so -- a project,
 * session or branch card with at least one enabled entry. A card with nothing to offer or a
 * `more` row is only selected; no menu opens.
 */
export function rightClickNode(target: CanvasTarget, at: MenuPoint): void {
  const ui = useUiStore.getState();
  ui.select(target);
  if (rightClickAction(target, nodeMenuCommands().length > 0) === "menu") ui.openContextMenu(at);
}

/**
 * A right-click on a node: select it, then open the menu at the pointer. A menu with no
 * enabled rows for it (a historic session) draws nothing and closes itself (`ContextMenu`).
 */
export function openContextMenuFor(target: NodeTarget, at: MenuPoint): void {
  const ui = useUiStore.getState();
  ui.select(target);
  ui.openContextMenu(at);
}
