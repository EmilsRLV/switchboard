// Pure helpers behind the canvas nodes: deriving xyflow nodes from the workspace snapshot
// (projects and their children) plus the live status map, selection and drag overrides, the
// card's text, and the geometry the arrow keys search (`nodeRects`, `nearestInDirection`,
// `panToReveal`). No React, no DOM, so all of it is unit-tested in vitest's node environment.

import type { Node } from "@xyflow/react";
import type { ChildNode, NodeTarget, Position, Project, ProjectStatus, ProjectStatusMap, Viewport } from "../ipc";
import type { DragOverrides } from "../state/canvas";

/** What a `ProjectNode` renders from. */
export type ProjectNodeData = {
  project: Project;
  /** `null` while the poller has not reached this project. */
  status: ProjectStatus | null;
  /** True while a duplicate add highlights this node. */
  flashed: boolean;
  /** True while this is the selected node (outline in `--fg`). */
  selected: boolean;
  /** How many children the project has; the chevron and badge show only above 0. */
  childCount: number;
};

/** What a `SessionNode` / `BranchNode` renders from. */
export type ChildNodeData = {
  child: ChildNode;
  selected: boolean;
};

export type ProjectFlowNode = Node<ProjectNodeData, "project">;
export type SessionFlowNode = Node<ChildNodeData, "session">;
export type BranchFlowNode = Node<ChildNodeData, "branch">;
export type CanvasFlowNode = ProjectFlowNode | SessionFlowNode | BranchFlowNode;

/** The card's size (`nodes.css`), so a node placed "at" a point can be centred on it. */
export const CARD_WIDTH = 240;
export const CARD_HEIGHT = 80;

/** A child card's size and the column it sits in under its parent (relative to the card). */
export const CHILD_WIDTH = 208;
export const CHILD_HEIGHT = 40;
export const CHILD_GAP = 8;
export const COLUMN_INDENT = 16;
export const COLUMN_TOP = 92;

/**
 * A press that moves this far or less (client pixels) before release is a click, not a
 * drag: xyflow 12 starts a node drag at `distance > nodeDragThreshold`, and the right-click
 * guard opens the menu on the same rule, so a click never writes a position.
 */
export const DRAG_THRESHOLD = 4;

/**
 * The `zIndex` of a node that is selected or being dragged, so it draws above its siblings
 * (a dragged child is never hidden under its column). xyflow lifts a child to its parent's
 * z + 1 when the parent is higher, so an elevated project keeps its children above it.
 */
export const ELEVATED_Z = 1000;

/** Live-session count on the badge; a constant 0 (hidden) until Epic 3 wires sessions. */
export const LIVE_SESSIONS: number = 0;

/** Longest path shown on a card before the middle is elided. */
export const PATH_MAX_CHARS = 36;

/** Where the `index`-th (0-based) child of a project sits, relative to the parent card. */
export function columnSlot(index: number): Position {
  return { x: COLUMN_INDENT, y: COLUMN_TOP + index * (CHILD_HEIGHT + CHILD_GAP) };
}

/**
 * The position of each of one project's children, relative to the parent card: the stored
 * one when the child was dragged, else its column slot. Slots follow the list order, so a
 * dragged child leaves a gap rather than shifting the others ("session 2 snaps back to slot 2").
 */
export function layoutChildren(children: readonly ChildNode[]): Position[] {
  return children.map((child, index) => (child.position === null ? columnSlot(index) : { ...child.position }));
}

/** The flow-node id of a child: `session:<id>` / `branch:<id>`; project ids stay bare. */
export function childFlowId(child: Pick<ChildNode, "kind" | "id">): string {
  return `${child.kind}:${child.id}`;
}

/** The flow-node id of any node target. */
export function flowIdOf(target: NodeTarget): string {
  return target.kind === "project" ? target.id : childFlowId({ kind: target.kind, id: target.id });
}

/** The reverse of {@link flowIdOf}. */
export function parseFlowId(flowId: string): NodeTarget {
  if (flowId.startsWith("session:")) return { kind: "session", id: flowId.slice("session:".length) };
  if (flowId.startsWith("branch:")) return { kind: "branch", id: flowId.slice("branch:".length) };
  return { kind: "project", id: flowId };
}

/** The command the card's chevron runs: the one of the exclusive pair that applies. */
export function chevronCommandId(project: Pick<Project, "expanded">): "project.expand" | "project.collapse" {
  return project.expanded ? "project.collapse" : "project.expand";
}

/** A right-button press as the canvas recorded it: where, and on which node wrapper (if any). */
export type RightPress = { x: number; y: number; flowId: string | null };

/**
 * What a right-button release means: the node under the press, when there was one and the
 * pointer moved at most {@link DRAG_THRESHOLD} since (else it was a pan, or nothing). The
 * caller selects that node and opens the menu for a project.
 */
export function rightClickTarget(press: RightPress | null, release: Position): NodeTarget | null {
  if (press === null || press.flowId === null) return null;
  if (Math.hypot(release.x - press.x, release.y - press.y) > DRAG_THRESHOLD) return null;
  return parseFlowId(press.flowId);
}

/**
 * What a drop writes: the node target of `flowId` and where it is, preferring the drag
 * override (the last position xyflow reported) over `nodePosition`, which may lag a frame.
 */
export function dropTarget(flowId: string, dragging: DragOverrides, nodePosition: Position): [NodeTarget, Position] {
  const position = override(dragging, flowId) ?? nodePosition;
  return [parseFlowId(flowId), { x: position.x, y: position.y }];
}

/** The override for `id`, if any; an own-property read, so ids like `constructor` find nothing. */
function override(dragging: DragOverrides, id: string): Position | undefined {
  return Object.hasOwn(dragging, id) ? dragging[id] : undefined;
}

/** Everything the node derivation reads. */
export type FlowInputs = {
  projects: readonly Project[];
  statuses: ProjectStatusMap;
  /** Project ids being flashed. */
  flashed: readonly string[];
  /** Every child of every project (collapsed ones too), as the snapshot lists them. */
  children: readonly ChildNode[];
  selection: NodeTarget | null;
  /** Mid-drag positions by flow id; applied last, over everything stored. */
  dragging: DragOverrides;
};

/**
 * The xyflow nodes for the canvas: one `project` node per workspace project at its stored
 * position, followed by its children (`session` / `branch` nodes with `parentId`, positioned
 * relative to the card) when it is expanded. A collapsed project's children are not in the
 * list. Nodes are draggable; selection is the app's, never xyflow's, so `selectable` is off
 * and the selected node is marked in its `data`. Drag overrides win over stored positions.
 * The selected node gets `zIndex` {@link ELEVATED_Z}; a node with a drag override one more,
 * so a dragged card is never covered by a selected sibling.
 *
 * Pass the previous result to keep the identity of every node whose inputs did not change,
 * so a drag frame or a status tick re-renders only the nodes it touched.
 */
export function toFlowNodes(inputs: FlowInputs, previous: readonly CanvasFlowNode[] = []): CanvasFlowNode[] {
  const { projects, statuses, flashed, children, selection, dragging } = inputs;
  const before = new Map<string, CanvasFlowNode>();
  for (const node of previous) before.set(node.id, node);

  const byProject = new Map<string, ChildNode[]>();
  for (const child of children) {
    const list = byProject.get(child.projectId);
    if (list === undefined) byProject.set(child.projectId, [child]);
    else list.push(child);
  }

  const out: CanvasFlowNode[] = [];
  for (const project of projects) {
    const kids = byProject.get(project.id) ?? [];
    const projectDrag = override(dragging, project.id);
    const projectSelected = selection !== null && selection.kind === "project" && selection.id === project.id;
    const next: ProjectFlowNode = {
      id: project.id,
      type: "project",
      position: projectDrag ?? { x: project.position.x, y: project.position.y },
      data: {
        project,
        status: statuses[project.id] ?? null,
        flashed: flashed.includes(project.id),
        selected: projectSelected,
        childCount: kids.length,
      },
      zIndex: layer(projectSelected, projectDrag),
      draggable: true,
      selectable: false,
      connectable: false,
    };
    out.push(reuse(before.get(project.id), next));
    if (!project.expanded) continue;
    const slots = layoutChildren(kids);
    kids.forEach((child, index) => {
      const id = childFlowId(child);
      const childDrag = override(dragging, id);
      const childSelected = selection !== null && selection.kind === child.kind && selection.id === child.id;
      const next: SessionFlowNode | BranchFlowNode = {
        id,
        type: child.kind,
        parentId: project.id,
        position: childDrag ?? slots[index] ?? columnSlot(index),
        data: { child, selected: childSelected },
        zIndex: layer(childSelected, childDrag),
        draggable: true,
        selectable: false,
        connectable: false,
      };
      out.push(reuse(before.get(id), next));
    });
  }
  return out;
}

/** A node's `zIndex`: {@link ELEVATED_Z} + 1 while dragged, {@link ELEVATED_Z} while selected, else 0. */
function layer(selected: boolean, drag: Position | undefined): number {
  if (drag !== undefined) return ELEVATED_Z + 1;
  return selected ? ELEVATED_Z : 0;
}

/** `prev` when it would render exactly as `next`, else `next`. */
function reuse<N extends CanvasFlowNode>(prev: CanvasFlowNode | undefined, next: N): N {
  return prev !== undefined && sameNode(prev, next) ? (prev as N) : next;
}

function sameNode(a: CanvasFlowNode, b: CanvasFlowNode): boolean {
  if (a.type !== b.type || a.parentId !== b.parentId || a.zIndex !== b.zIndex || !samePosition(a.position, b.position)) {
    return false;
  }
  if (a.type === "project" && b.type === "project") {
    return (
      a.data.flashed === b.data.flashed &&
      a.data.selected === b.data.selected &&
      a.data.childCount === b.data.childCount &&
      sameProject(a.data.project, b.data.project) &&
      sameStatus(a.data.status, b.data.status)
    );
  }
  if (a.type !== "project" && b.type !== "project") {
    return a.data.selected === b.data.selected && sameChild(a.data.child, b.data.child);
  }
  return false;
}

function samePosition(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * Equal in everything a card shows (the position is compared on the node). Rule: every field
 * `ProjectNode` renders must be compared here, or a change to it leaves a stale card;
 * `launchDefaults` is not rendered and is deliberately left out.
 */
function sameProject(a: Project, b: Project): boolean {
  return a === b || (a.id === b.id && a.path === b.path && a.label === b.label && a.expanded === b.expanded && a.color === b.color);
}

function sameChild(a: ChildNode, b: ChildNode): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.projectId === b.projectId &&
      a.kind === b.kind &&
      a.label === b.label &&
      a.detail === b.detail &&
      (a.position === b.position || (a.position !== null && b.position !== null && samePosition(a.position, b.position))))
  );
}

function sameStatus(a: ProjectStatus | null, b: ProjectStatus | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.kind !== b.kind) return false;
  if (a.kind === "repo" && b.kind === "repo") {
    return a.branch === b.branch && a.detached === b.detached && a.dirty === b.dirty && a.ahead === b.ahead && a.behind === b.behind;
  }
  if (a.kind === "git_error" && b.kind === "git_error") return a.message === b.message;
  return true;
}

/** The canvas point whose card (top-left there) is centred on `centre`. */
export function cardTopLeft(centre: Position): Position {
  return { x: centre.x - CARD_WIDTH / 2, y: centre.y - CARD_HEIGHT / 2 };
}

/**
 * A path short enough for a card: the first component (drive or root), an ellipsis and as
 * many trailing components as fit in `max` characters, never fewer than the last one.
 * `B:\projects\very\deep\guild-auth` → `B:\…\deep\guild-auth`. Separator style is kept.
 */
export function shortenPath(path: string, max = PATH_MAX_CHARS): string {
  if (path.length <= max) return path;
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]/).filter((p, i) => p !== "" || i === 0);
  if (parts.length < 3) return path;
  const head = parts[0] === "" ? "" : parts[0];
  let candidate = path;
  for (let keep = parts.length - 1; keep >= 1; keep -= 1) {
    const tail = parts.slice(parts.length - keep).join(sep);
    candidate = `${head}${sep}…${sep}${tail}`;
    if (candidate.length <= max) break;
  }
  return candidate;
}

export type StatusLine = {
  text: string;
  /** `muted` for the non-repo and not-yet-known cases, `normal` for git facts. */
  tone: "normal" | "muted";
  /** Hover text with the detail the line itself does not carry (git's error message). */
  title?: string;
};

/** The card's status line: `master · 2 changed`, `not a git repo`, `folder missing`, … */
export function statusLine(status: ProjectStatus | null): StatusLine {
  if (status === null) return { text: "…", tone: "muted" };
  switch (status.kind) {
    case "repo":
      return {
        text: `${status.branch}${status.detached ? " detached" : ""} · ${status.dirty} changed`,
        tone: "normal",
      };
    case "not_repo":
      return { text: "not a git repo", tone: "muted" };
    case "missing":
      return { text: "folder missing", tone: "muted" };
    case "git_unavailable":
      return { text: "git unavailable", tone: "muted" };
    case "git_error":
      return { text: "git error", tone: "muted", title: status.message };
  }
}

/** `↑n ↓m` when the upstream differs, else `null` (nothing to show). */
export function aheadBehind(status: ProjectStatus | null): string | null {
  if (status === null || status.kind !== "repo") return null;
  if (status.ahead === 0 && status.behind === 0) return null;
  return `↑${status.ahead} ↓${status.behind}`;
}

// --- keyboard navigation geometry -----------------------------------------------------------

/** A rendered node's rectangle in canvas coordinates, as the canvas draws it. */
export type NodeRect = { target: NodeTarget; x: number; y: number; width: number; height: number };

export type Direction = "left" | "right" | "up" | "down";

/** A revealed node keeps at least this many screen pixels from the canvas edge. */
export const REVEAL_MARGIN = 16;

/** How long the pan that reveals an off-screen node takes. */
export const REVEAL_PAN_MS = 150;

/** Perpendicular distance counts this many times the primary-axis distance in an arrow search. */
const PERPENDICULAR_WEIGHT = 2;

/**
 * The rectangles the arrow keys search: every project card (`CARD_WIDTH × CARD_HEIGHT` at its
 * position) followed, for an expanded project only, by its children (`CHILD_WIDTH ×
 * CHILD_HEIGHT` at the parent's position plus the child's relative position, slot or stored).
 * Collapsed children are not drawn, so they are not candidates. The list order (projects in
 * workspace order, each with its children) is the tie-breaker of the searches.
 */
export function nodeRects(projects: readonly Project[], children: readonly ChildNode[]): NodeRect[] {
  const out: NodeRect[] = [];
  for (const project of projects) {
    out.push({
      target: { kind: "project", id: project.id },
      x: project.position.x,
      y: project.position.y,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    });
    if (!project.expanded) continue;
    const kids = children.filter((child) => child.projectId === project.id);
    const slots = layoutChildren(kids);
    kids.forEach((child, index) => {
      const slot = slots[index] ?? columnSlot(index);
      out.push({
        target: { kind: child.kind, id: child.id },
        x: project.position.x + slot.x,
        y: project.position.y + slot.y,
        width: CHILD_WIDTH,
        height: CHILD_HEIGHT,
      });
    });
  }
  return out;
}

function centreOf(rect: NodeRect): Position {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function sameNodeTarget(a: NodeTarget, b: NodeTarget): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * The rect the selection moves to on an arrow from `from`: among the rects (other than
 * `from`) whose centre lies strictly in the direction's half-plane from `from`'s centre, the
 * one with the smallest `|primary delta| + 2 × |perpendicular delta|`; equal scores go to the
 * earlier one in the list. `null` when nothing lies that way (the selection stays).
 */
export function nearestInDirection(from: NodeRect, rects: readonly NodeRect[], direction: Direction): NodeRect | null {
  const origin = centreOf(from);
  let best: NodeRect | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const rect of rects) {
    if (sameNodeTarget(rect.target, from.target)) continue;
    const centre = centreOf(rect);
    const dx = centre.x - origin.x;
    const dy = centre.y - origin.y;
    let primary: number;
    let perpendicular: number;
    switch (direction) {
      case "right":
        if (!(dx > 0)) continue;
        [primary, perpendicular] = [dx, dy];
        break;
      case "left":
        if (!(dx < 0)) continue;
        [primary, perpendicular] = [-dx, dy];
        break;
      case "down":
        if (!(dy > 0)) continue;
        [primary, perpendicular] = [dy, dx];
        break;
      case "up":
        if (!(dy < 0)) continue;
        [primary, perpendicular] = [-dy, dx];
        break;
    }
    const score = primary + PERPENDICULAR_WEIGHT * Math.abs(perpendicular);
    if (score < bestScore) {
      best = rect;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The rect whose centre is nearest `point` (the viewport centre when an arrow is pressed with
 * nothing selected); ties go to the earlier one in the list. `null` for no rects.
 */
export function nearestToPoint(rects: readonly NodeRect[], point: Position): NodeRect | null {
  let best: NodeRect | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const rect of rects) {
    const centre = centreOf(rect);
    const distance = Math.hypot(centre.x - point.x, centre.y - point.y);
    if (distance < bestDistance) {
      best = rect;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The viewport that shows `rect` with `margin` screen pixels to spare on every side, moved
 * the least from `viewport` (zoom unchanged); `null` when the rect is already fully inside
 * `[margin, size − margin]` on both axes. Screen space is `s = canvas · zoom + pan`. A rect
 * larger than the available area is aligned on its left/top edge.
 */
export function panToReveal(
  rect: NodeRect,
  viewport: Viewport,
  size: { width: number; height: number },
  margin = REVEAL_MARGIN,
): Viewport | null {
  const shift = (start: number, length: number, pan: number, extent: number): number => {
    const screenStart = start * viewport.zoom + pan;
    const screenEnd = screenStart + length * viewport.zoom;
    // Too large to fit: always the leading edge at the margin (stable on repeated reveals).
    if (length * viewport.zoom > extent - 2 * margin) return margin - screenStart;
    if (screenStart < margin) return margin - screenStart;
    if (screenEnd > extent - margin) return extent - margin - screenEnd;
    return 0;
  };
  const dx = shift(rect.x, rect.width, viewport.x, size.width);
  const dy = shift(rect.y, rect.height, viewport.y, size.height);
  if (dx === 0 && dy === 0) return null;
  return { x: viewport.x + dx, y: viewport.y + dy, zoom: viewport.zoom };
}

/** Tauri's drop position (physical pixels) → client (CSS) pixels for `screenToFlowPosition`. */
export function physicalToClient(position: Position, devicePixelRatio: number): Position {
  const dpr = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  return { x: position.x / dpr, y: position.y / dpr };
}
