// Keyboard navigation and the project actions of Story 2.4. The arrow commands move the
// selection to the nearest rendered node in that direction (a pure spatial search over the
// same geometry the canvas draws, `canvas/nodes`), panning the viewport minimally when the new
// node is off screen; Enter runs the selected node's default action. The external actions
// (editor, file manager, Claude project dir) are thin calls into Rust, which performs them;
// what cannot run is a transient notice over the canvas top, never a banner and never a throw
// (`runCommand` has no error UI). The two Epic 4 stubs only show what they will do.

import {
  nearestInDirection,
  nearestToPoint,
  nodeRects,
  panToReveal,
  parseFlowId,
  REVEAL_MARGIN,
  REVEAL_PAN_MS,
  visibleChildren,
  type Direction,
  type NodeRect,
} from "../canvas/nodes";
import { projectOpenEditor, projectOpenFolder, projectRevealClaudeDir } from "../ipc";
import { useCanvasStore, viewportCentre, type CanvasElement } from "../state/canvas";
import { NOTICE_MS, sameTarget, selectedProject, useUiStore, type Size } from "../state/ui";
import { projectHasChildren, useWorkspaceStore } from "../state/workspace";
import { setExpanded } from "./nodes";
import type { Timers } from "./projects";

/** The notices the two Epic 4 stubs show. */
export const NEW_SESSION_NOTICE = "New session arrives in Epic 4";
export const PLAIN_TERMINAL_NOTICE = "Plain terminal arrives in Epic 4";

/** The pending end of the notice showing, so a newer notice restarts the clock. */
let noticeTimer: unknown;

/**
 * Show `text` as the notice over the canvas top for `NOTICE_MS`; a newer notice replaces it
 * and restarts the clock.
 */
export function notify(text: string, timers: Timers = globalThis as Timers): void {
  useUiStore.getState().showNotice(text);
  if (noticeTimer !== undefined) timers.clearTimeout(noticeTimer);
  noticeTimer = timers.setTimeout(() => {
    noticeTimer = undefined;
    useUiStore.getState().clearNotice();
  }, NOTICE_MS);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `selection.move.*`: select the nearest node in `direction` from the selected one, or, with
 * nothing selected (or the selected node not drawn), the node nearest the viewport centre;
 * then pan just enough to show it. Resolves to whether the selection moved: no nodes, or
 * nothing in that direction, leaves it as it was.
 */
export function moveSelection(direction: Direction): boolean {
  const snapshot = useWorkspaceStore.getState().snapshot;
  if (snapshot === null) return false;
  const ui = useUiStore.getState();
  const rects = nodeRects(snapshot.workspace.projects, snapshot.children, ui.showAll);
  if (rects.length === 0) return false;
  const from = ui.selection === null ? undefined : rects.find((rect) => sameTarget(rect.target, ui.selection));
  const next = from === undefined ? nearestToPoint(rects, viewportCentre() ?? { x: 0, y: 0 }) : nearestInDirection(from, rects, direction);
  if (next === null) return false;
  ui.select(next.target);
  revealRect(next);
  return true;
}

/**
 * Pan the canvas by the smallest delta that puts `rect` fully inside it (`REVEAL_MARGIN`),
 * zoom unchanged, over `REVEAL_PAN_MS` (instantly under reduced motion); nothing when it is
 * already in view or there is no canvas. The move ends in xyflow's `onMoveEnd`, which
 * persists it like any other pan.
 */
function revealRect(rect: NodeRect): boolean {
  const { instance, element } = useCanvasStore.getState();
  if (instance === null) return false;
  const size = canvasSize(element);
  if (size === null) return false;
  const next = panToReveal(rect, instance.getViewport(), size, REVEAL_MARGIN);
  if (next === null) return false;
  void instance.setViewport(next, { duration: prefersReducedMotion() ? 0 : REVEAL_PAN_MS });
  return true;
}

/** The OS asks for reduced motion (`prefers-reduced-motion: reduce`); false without a window. */
function prefersReducedMotion(): boolean {
  const media = (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia;
  return typeof media === "function" && media("(prefers-reduced-motion: reduce)").matches;
}

/** The canvas's on-screen size: its element's, else the window's; `null` with neither (tests). */
function canvasSize(element: CanvasElement | null): Size | null {
  if (element !== null) {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }
  if (typeof window === "undefined") return null;
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * `selection.activate` (Enter): the selected node's default action. A project with children
 * toggles expand/collapse (persisted); a project's `more` row toggles its `show all` (UI
 * only); a childless project and child cards do nothing (resume and fork arrive in Epic 4).
 * Resolves to whether anything was done.
 */
export async function activateSelection(): Promise<boolean> {
  const ui = useUiStore.getState();
  const snapshot = useWorkspaceStore.getState().snapshot;
  // Only a target that is drawn right now: a `more` row that is gone, or a child hidden past
  // the cut, does nothing.
  if (ui.selection === null || snapshot === null) return false;
  const drawn = nodeRects(snapshot.workspace.projects, snapshot.children, ui.showAll);
  if (!drawn.some((rect) => sameTarget(rect.target, ui.selection))) return false;
  if (ui.selection.kind === "more") {
    ui.toggleShowAll(ui.selection.id);
    return true;
  }
  const project = selectedProject();
  if (project === null || !projectHasChildren(project.id)) return false;
  return setExpanded(project.id, !project.expanded);
}

/**
 * A click on a node (the canvas's `onNodeClick`): close the menu and select it; on a `more`
 * row, also show all (or fewer) of that project's children.
 */
export function clickNode(flowId: string): void {
  const ui = useUiStore.getState();
  ui.closeContextMenu();
  const target = parseFlowId(flowId);
  ui.select(target);
  if (target.kind === "more") ui.toggleShowAll(target.id);
}

/**
 * The `when` of `project.toggleShowAll`: the selected project is expanded and has more
 * children than the column shows by default (so it has a `more` row).
 */
export function canToggleShowAll(): boolean {
  const project = selectedProject();
  if (project === null || !project.expanded) return false;
  const children = useWorkspaceStore.getState().snapshot?.children ?? [];
  return visibleChildren(
    children.filter((child) => child.projectId === project.id),
    false,
  ).more;
}

/** `project.toggleShowAll`: show all (or fewer) of the selected project's children. */
export function toggleShowAllOfSelected(): boolean {
  if (!canToggleShowAll()) return false;
  const project = selectedProject();
  if (project === null) return false;
  useUiStore.getState().toggleShowAll(project.id);
  return true;
}

/** `project.newSession`: a stub until Epic 4; says so. */
export function newSessionStub(): void {
  notify(NEW_SESSION_NOTICE);
}

/** `project.terminal`: a stub until Epic 4; says so. */
export function plainTerminalStub(): void {
  notify(PLAIN_TERMINAL_NOTICE);
}

/** Run one external action; its rejection (Rust's message, or no runtime) is the notice. */
async function external(action: () => Promise<void>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (err) {
    notify(describe(err));
    return false;
  }
}

/** `project.openEditor`: open the project folder with the configured external editor. */
export function openProjectInEditor(projectId: string): Promise<boolean> {
  return external(() => projectOpenEditor(projectId));
}

/** `project.openFolder`: open the project folder in the OS file manager. */
export function openProjectFolder(projectId: string): Promise<boolean> {
  return external(() => projectOpenFolder(projectId));
}

/** `project.revealClaudeDir`: open the project's `~/.claude/projects` directory. */
export function revealClaudeProjectDir(projectId: string): Promise<boolean> {
  return external(() => projectRevealClaudeDir(projectId));
}
