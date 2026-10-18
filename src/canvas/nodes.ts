// Pure helpers behind the canvas nodes: deriving xyflow nodes from the workspace snapshot
// (projects and their children) plus the live status map, selection and drag overrides, the
// card's text, and the geometry the arrow keys search (`nodeRects`, `nearestInDirection`,
// `panToReveal`). No React, no DOM, so all of it is unit-tested in vitest's node environment.

import type { Node } from "@xyflow/react";
import type {
  ChildKind,
  ChildNode,
  LiveSession,
  NodeTarget,
  Position,
  Project,
  ProjectStatus,
  ProjectStatusMap,
  SessionMeta,
  SessionState,
  Viewport,
} from "../ipc";
import type { DragOverrides } from "../state/canvas";
import { isLiveState, needsAttention, sameState, stateWord } from "../state/live";

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
  /**
   * How many of its session children are live (busy, idle or unrecognised) by the live map,
   * looked up by session id; the `N live` badge shows only above 0.
   */
  liveCount: number;
  /**
   * True while any of its session children (drawn or hidden, collapsed or not) is `finished`
   * or `waiting`: the card glows (Story 3.3).
   */
  attention: boolean;
};

/** What a `SessionNode` / `BranchNode` renders from. */
export type ChildNodeData = {
  child: ChildNode;
  selected: boolean;
  /** The session's state when the poll has seen it this run (live or exited); `null` for a historic session, a stub or a branch. */
  state: SessionState | null;
  /** True while the session is `finished` or `waiting`: the accent card (Story 3.3). */
  attention: boolean;
  /** A `finished` session's last assistant line (Story 4.3); `null` otherwise. */
  lastLine: string | null;
  /** A `waiting` session's reason, the card's tooltip (Story 4.3); `null` otherwise. */
  detail: string | null;
  /** A Stop of the session's Switchboard terminal is under way (Story 4.4): the word reads `stopping`. */
  stopping: boolean;
  /** The title of the session this one was forked from, when that session is listed (Story 4.4). */
  forkedFromTitle: string | null;
};

/** What a `MoreNode` (the `show all (N)` / `show fewer` row) renders from. */
export type MoreNodeData = {
  projectId: string;
  /** Every child of the project, hidden ones included. */
  total: number;
  /** True while the project shows all its children (the row reads `show fewer`). */
  showingAll: boolean;
  selected: boolean;
};

export type ProjectFlowNode = Node<ProjectNodeData, "project">;
export type SessionFlowNode = Node<ChildNodeData, "session">;
export type BranchFlowNode = Node<ChildNodeData, "branch">;
export type MoreFlowNode = Node<MoreNodeData, "more">;
export type CanvasFlowNode = ProjectFlowNode | SessionFlowNode | BranchFlowNode | MoreFlowNode;

/**
 * The synthetic `more` row under a project's column, named by the project's id. It is not a
 * Rust node: it is never moved, has no menu and only toggles the project's `showAll`.
 */
export type MoreTarget = { kind: "more"; id: string };

/** Anything the canvas draws and can select: a node Rust knows, or a `more` row. */
export type CanvasTarget = NodeTarget | MoreTarget;

/** How many children an expanded project shows until `show all` is clicked. */
export const SHOW_LIMIT = 10;

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

/** The flow-node id of a project's `more` row: `more:<projectId>`. */
export function moreFlowId(projectId: string): string {
  return `more:${projectId}`;
}

/** The flow-node id of any canvas target. */
export function flowIdOf(target: CanvasTarget): string {
  if (target.kind === "project") return target.id;
  if (target.kind === "more") return moreFlowId(target.id);
  return childFlowId({ kind: target.kind, id: target.id });
}

/** The reverse of {@link flowIdOf}. */
export function parseFlowId(flowId: string): CanvasTarget {
  if (flowId.startsWith("session:")) return { kind: "session", id: flowId.slice("session:".length) };
  if (flowId.startsWith("branch:")) return { kind: "branch", id: flowId.slice("branch:".length) };
  if (flowId.startsWith("more:")) return { kind: "more", id: flowId.slice("more:".length) };
  return { kind: "project", id: flowId };
}

/** What {@link visibleChildren} decides for one project's column. */
export type ColumnCut<C> = {
  /** The children drawn, in list order. */
  visible: readonly C[];
  /** Whether the `more` row follows: more children than {@link SHOW_LIMIT}. */
  more: boolean;
  /** The column slot the `more` row takes: after the tenth, or after the last while all show. */
  slotted: number;
  /** Every child, hidden ones included: the N of `show all (N)`. */
  total: number;
};

/**
 * The children an expanded project draws: all of them while `showAll`, else those at list
 * indices below {@link SHOW_LIMIT} (the list is in Rust's order, most relevant first) plus
 * any later one with a stored (dragged) position, which is always drawn. Indices are kept,
 * so every drawn child still sits in its own slot.
 */
export function visibleChildren<C extends { position: Position | null }>(children: readonly C[], showAll: boolean): ColumnCut<C> {
  const total = children.length;
  const more = total > SHOW_LIMIT;
  if (showAll || !more) return { visible: children, more, slotted: total, total };
  const visible = children.filter((child, index) => index < SHOW_LIMIT || child.position !== null);
  return { visible, more, slotted: SHOW_LIMIT, total };
}

/** The `more` row's text: `show all (N)`, or `show fewer` while everything shows. */
export function moreLabel(total: number, showingAll: boolean): string {
  return showingAll ? "show fewer" : `show all (${total})`;
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
export function rightClickTarget(press: RightPress | null, release: Position): CanvasTarget | null {
  if (press === null || press.flowId === null) return null;
  if (Math.hypot(release.x - press.x, release.y - press.y) > DRAG_THRESHOLD) return null;
  return parseFlowId(press.flowId);
}

/**
 * What a right-click release on `target` does once it is selected: open the node menu for a
 * project or session card that has enabled entries, else only select (a historic session,
 * a branch, a `more` row).
 */
export function rightClickAction(target: CanvasTarget, hasMenuItems: boolean): "menu" | "select" {
  return (target.kind === "project" || target.kind === "session") && hasMenuItems ? "menu" : "select";
}

/**
 * What a drop writes: the node target of `flowId` and where it is, preferring the drag
 * override (the last position xyflow reported) over `nodePosition`, which may lag a frame.
 */
export function dropTarget(flowId: string, dragging: DragOverrides, nodePosition: Position): [CanvasTarget, Position] {
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
  selection: CanvasTarget | null;
  /** Mid-drag positions by flow id; applied last, over everything stored. */
  dragging: DragOverrides;
  /** Project ids showing all their children (UI-only); absent means none. */
  showAll?: readonly string[];
  /** Every session the live poll has seen this run, by id (the live store); absent means none. */
  live?: Readonly<Record<string, LiveSession>>;
  /** Session ids whose Switchboard terminal is being stopped (Story 4.4); absent means none. */
  stopping?: readonly string[];
};

/**
 * The xyflow nodes for the canvas: one `project` node per workspace project at its stored
 * position, followed by its children (`session` / `branch` nodes with `parentId`, positioned
 * relative to the card) when it is expanded. A collapsed project's children are not in the
 * list. Past {@link SHOW_LIMIT} children only the first ten are drawn (unless the project
 * is in `showAll`; dragged children always are, see {@link visibleChildren}), and a `more`
 * node follows in the eleventh slot (after the last while all show); hidden children still
 * count in the project's `childCount` (the collapsed badge). Nodes are draggable; selection
 * is the app's, never xyflow's, so `selectable` is off and the selected node is marked in its
 * `data`. Drag overrides win over stored positions.
 * The selected node gets `zIndex` {@link ELEVATED_Z}; a node with a drag override one more,
 * so a dragged card is never covered by a selected sibling.
 *
 * Pass the previous result to keep the identity of every node whose inputs did not change,
 * so a drag frame or a status tick re-renders only the nodes it touched.
 */
export function toFlowNodes(inputs: FlowInputs, previous: readonly CanvasFlowNode[] = []): CanvasFlowNode[] {
  const { projects, statuses, flashed, children, selection, dragging } = inputs;
  const showAll = inputs.showAll ?? [];
  const live = inputs.live ?? NO_LIVE;
  // The card's state by session id, whatever project the live row's cwd maps to.
  const stateOf = (child: ChildNode): SessionState | null =>
    child.kind === "session" && Object.hasOwn(live, child.id) ? (live[child.id]?.state ?? null) : null;
  // The hook's extras (Story 4.3): the last line while finished, the reason while waiting.
  const liveOf = (child: ChildNode) => (child.kind === "session" && Object.hasOwn(live, child.id) ? live[child.id] : undefined);
  const lastLineOf = (child: ChildNode): string | null => {
    const session = liveOf(child);
    return session?.state.kind === "finished" ? (session.last_line ?? null) : null;
  };
  const detailOf = (child: ChildNode): string | null => {
    const session = liveOf(child);
    return session?.state.kind === "waiting" ? (session.detail ?? null) : null;
  };
  const stopping = inputs.stopping ?? [];
  const stoppingOf = (child: ChildNode): boolean => {
    const state = stateOf(child);
    return state !== null && isLiveState(state) && stopping.includes(child.id);
  };
  // Every session's title by id, for a fork's "forked from" (Story 4.4).
  const titles = new Map<string, string>();
  for (const child of children) if (child.kind === "session") titles.set(child.id, child.label);
  const forkedFromTitleOf = (child: ChildNode): string | null =>
    child.forkedFrom === null || child.forkedFrom === undefined ? null : (titles.get(child.forkedFrom) ?? null);
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
        // The badge counts the project's own session children in a live state.
        liveCount: kids.filter((child) => {
          const state = stateOf(child);
          return state !== null && isLiveState(state);
        }).length,
        attention: kids.some((child) => needsAttention(stateOf(child))),
      },
      zIndex: layer(projectSelected, projectDrag),
      draggable: true,
      selectable: false,
      connectable: false,
    };
    out.push(reuse(before.get(project.id), next));
    if (!project.expanded) continue;
    const showingAll = showAll.includes(project.id);
    const { visible, more, slotted, total } = visibleChildren(kids, showingAll);
    const slots = layoutChildren(visible);
    visible.forEach((child, index) => {
      const id = childFlowId(child);
      const childDrag = override(dragging, id);
      const childSelected = selection !== null && selection.kind === child.kind && selection.id === child.id;
      const next: SessionFlowNode | BranchFlowNode = {
        id,
        type: child.kind,
        parentId: project.id,
        position: childDrag ?? slots[index] ?? columnSlot(index),
        data: {
          child,
          selected: childSelected,
          state: stateOf(child),
          attention: needsAttention(stateOf(child)),
          lastLine: lastLineOf(child),
          detail: detailOf(child),
          stopping: stoppingOf(child),
          forkedFromTitle: forkedFromTitleOf(child),
        },
        zIndex: layer(childSelected, childDrag),
        draggable: true,
        selectable: false,
        connectable: false,
      };
      out.push(reuse(before.get(id), next));
    });
    if (more) {
      const id = moreFlowId(project.id);
      const moreSelected = selection !== null && selection.kind === "more" && selection.id === project.id;
      const next: MoreFlowNode = {
        id,
        type: "more",
        parentId: project.id,
        position: columnSlot(slotted),
        data: { projectId: project.id, total, showingAll, selected: moreSelected },
        zIndex: layer(moreSelected, undefined),
        draggable: false,
        selectable: false,
        connectable: false,
      };
      out.push(reuse(before.get(id), next));
    }
  }
  return out;
}

const NO_LIVE: Readonly<Record<string, LiveSession>> = Object.freeze({});

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
      a.data.liveCount === b.data.liveCount &&
      a.data.attention === b.data.attention &&
      sameProject(a.data.project, b.data.project) &&
      sameStatus(a.data.status, b.data.status)
    );
  }
  if (a.type === "more" && b.type === "more") {
    return (
      a.data.projectId === b.data.projectId &&
      a.data.total === b.data.total &&
      a.data.showingAll === b.data.showingAll &&
      a.data.selected === b.data.selected
    );
  }
  if ((a.type === "session" || a.type === "branch") && (b.type === "session" || b.type === "branch")) {
    return (
      a.data.selected === b.data.selected &&
      a.data.attention === b.data.attention &&
      a.data.lastLine === b.data.lastLine &&
      a.data.detail === b.data.detail &&
      a.data.stopping === b.data.stopping &&
      a.data.forkedFromTitle === b.data.forkedFromTitle &&
      sameState(a.data.state, b.data.state) &&
      sameChild(a.data.child, b.data.child)
    );
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
      a.branchId === b.branchId &&
      a.forkedFrom === b.forkedFrom &&
      sameSession(a.session, b.session) &&
      (a.position === b.position || (a.position !== null && b.position !== null && samePosition(a.position, b.position))))
  );
}

function sameSession(a: SessionMeta | null, b: SessionMeta | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.startedAt === b.startedAt &&
      a.lastActive === b.lastActive &&
      a.branch === b.branch &&
      a.messages === b.messages)
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** From this age on, the card shows the date instead of `Nd`. */
const DATE_AFTER_MS = 7 * DAY_MS;

/**
 * How long ago `lastActive` (ISO 8601) was, as a session card's meta line says it: `now`
 * (under a minute, or in the future), `5m`, `3h`, `2d` (under a week), then the local date,
 * `12 Oct` in the year of `now` or `12 Oct 2025` before it. An unparsable time is `?`.
 */
export function formatAge(lastActive: string, now: number): string {
  const then = Date.parse(lastActive);
  if (Number.isNaN(then)) return "?";
  const age = now - then;
  if (age < MINUTE_MS) return "now";
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)}m`;
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h`;
  if (age < DATE_AFTER_MS) return `${Math.floor(age / DAY_MS)}d`;
  const date = new Date(then);
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === new Date(now).getFullYear() ? day : `${day} ${date.getFullYear()}`;
}

/** The parts of a session card's meta line, as the card lays them out. */
export type SessionCardMeta = {
  /** The state word while the poll has seen the session this run; `null` for a historic one. */
  state: { word: string; tone: SessionStateTone; dot: boolean } | null;
  /** The git branch, the one part that shrinks (ellipsis); `null` when there is none. */
  branch: string | null;
  /** `N msgs` / `1 msg`. */
  count: string;
  /** `now`, `5m`, …; `null` when the last activity is unknown (a live session without a transcript). */
  age: string | null;
  /**
   * A `finished` session's last assistant line (Story 4.3): when set, the card shows it after
   * the state word in place of branch, count and age (muted, one line, ellipsis).
   */
  lastLine: string | null;
};

/** The state word of a session being stopped (Story 4.4): muted, until its process exits. */
export const STOPPING_WORD = "stopping";

/**
 * The parts of a session card's meta line: `[state] · [branch] · N msgs · [age]`. The state
 * word leads while the session is live or exited (`busy` with the pulsing dot, `finished` /
 * `waiting` in the accent with the pulsing dot, the rest muted); the branch is left out when
 * the transcript names none; the age when `lastActive` is unknown. While a live session is
 * being stopped (`stopping`, Story 4.4) the word is `stopping`, muted, with no dot.
 */
export function sessionCardMeta(
  meta: SessionMeta,
  now: number,
  state: SessionState | null,
  lastLine: string | null = null,
  stopping = false,
): SessionCardMeta {
  const halting = stopping && state !== null && isLiveState(state);
  const tone = halting ? "muted" : sessionStateTone(state);
  const line = lastLine?.trim() ?? "";
  return {
    lastLine: !halting && state?.kind === "finished" && line !== "" ? line : null,
    state:
      state === null || tone === null
        ? null
        : { word: halting ? STOPPING_WORD : stateWord(state), tone, dot: tone !== "muted" },
    branch: meta.branch !== null && meta.branch !== "" ? meta.branch : null,
    count: `${meta.messages} ${meta.messages === 1 ? "msg" : "msgs"}`,
    age: meta.lastActive === "" ? null : formatAge(meta.lastActive, now),
  };
}

/** The meta line as one string (the parts of {@link sessionCardMeta} joined by ` · `). */
export function sessionMetaLine(meta: SessionMeta, now: number, state: SessionState | null = null): string {
  const parts = sessionCardMeta(meta, now, state);
  return [parts.state?.word, parts.branch, parts.count, parts.age].filter((p): p is string => p !== null && p !== undefined).join(" · ");
}

/** How a session's state word is drawn (see {@link sessionStateTone}). */
export type SessionStateTone = "busy" | "attention" | "muted";

/**
 * How a session's state word is drawn: `busy` in `--fg` with the pulsing dot, `finished` and
 * `waiting` in the accent with the pulsing dot (attention), every other state (starting, idle,
 * exited, unrecognised) muted. `null` for a historic session (no word).
 */
export function sessionStateTone(state: SessionState | null): SessionStateTone | null {
  if (state === null) return null;
  if (state.kind === "busy") return "busy";
  return needsAttention(state) ? "attention" : "muted";
}

/**
 * A child card's accessible name: `Session <label>` (or `Branch …`), then a `waiting`
 * session's reason, a `finished` session's last line (Story 4.3) and `needs you` while it
 * needs attention.
 */
export function childAriaLabel(
  kind: ChildKind,
  data: Pick<ChildNodeData, "child" | "attention" | "detail" | "lastLine"> & Partial<Pick<ChildNodeData, "stopping" | "forkedFromTitle">>,
): string {
  const parts = [`${kind === "session" ? "Session" : "Branch"} ${data.child.label}`];
  if (data.forkedFromTitle !== null && data.forkedFromTitle !== undefined) parts.push(forkedFromText(data.forkedFromTitle));
  if (data.stopping === true) parts.push(STOPPING_WORD);
  if (data.detail !== null && data.detail !== "") parts.push(`waiting: ${data.detail}`);
  if (data.lastLine !== null && data.lastLine !== "") parts.push(`last line: ${data.lastLine}`);
  if (data.attention) parts.push("needs you");
  return parts.join(", ");
}

/**
 * A session card's `title` attribute: a `waiting` session's reason (`detail`, Story 4.3)
 * first, then the hover text, then a `finished` session's last line (as Rust cut it: at most
 * 200 characters, `…` when cut), then `needs you` while it needs attention.
 */
export function sessionCardTitle(
  data: Pick<ChildNodeData, "child" | "attention" | "detail" | "lastLine"> & Partial<Pick<ChildNodeData, "forkedFromTitle">>,
  meta: SessionMeta,
): string {
  const lines: string[] = [];
  if (data.detail !== null && data.detail !== "") lines.push(data.detail);
  lines.push(sessionHoverText(data.child.label, meta));
  if (data.forkedFromTitle !== null && data.forkedFromTitle !== undefined) lines.push(forkedFromText(data.forkedFromTitle));
  if (data.lastLine !== null && data.lastLine !== "") lines.push(data.lastLine);
  if (data.attention) lines.push("needs you");
  return lines.join("\n");
}

/** A fork's tooltip and accessible-name part (Story 4.4): `forked from <original title>`. */
export function forkedFromText(title: string): string {
  return `forked from ${title}`;
}

/** One "forked from" line the canvas draws (Story 4.4): between two drawn session cards, by flow id. */
export type ForkLine = { id: string; source: string; target: string };

/**
 * The "forked from" lines to draw: one per drawn session card whose child names an original
 * (`forkedFrom`) that is drawn too, from the fork's card to the original's. A rendering of
 * `forkedFrom`, not an edge kind: nothing is stored, and a hidden or unlisted original draws
 * no line.
 */
export function forkLines(nodes: readonly CanvasFlowNode[]): ForkLine[] {
  const drawn = new Set(nodes.filter((n) => n.type === "session").map((n) => n.id));
  const out: ForkLine[] = [];
  for (const node of nodes) {
    if (node.type !== "session") continue;
    const from = node.data.child.forkedFrom;
    if (from === null || from === undefined) continue;
    const target = childFlowId({ kind: "session", id: from });
    if (target === node.id || !drawn.has(target)) continue;
    out.push({ id: `fork:${node.data.child.id}`, source: node.id, target });
  }
  return out;
}

/** How far left of the cards a "forked from" line bows (flow pixels). */
export const FORK_LINE_BOW = 24;

/**
 * The SVG path of a "forked from" line between two cards' left-edge anchors: a cubic curve
 * that bows {@link FORK_LINE_BOW} to the left, so two cards of one column are joined beside
 * the column rather than along its edge.
 */
export function forkLinePath(sourceX: number, sourceY: number, targetX: number, targetY: number): string {
  const bow = Math.min(sourceX, targetX) - FORK_LINE_BOW;
  return `M ${sourceX},${sourceY} C ${bow},${sourceY} ${bow},${targetY} ${targetX},${targetY}`;
}

/** A session card's hover text: the full title and the exact local start and last-active times (each only when known). */
export function sessionHoverText(title: string, meta: SessionMeta): string {
  const exact = (iso: string) => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? iso : new Date(ms).toLocaleString();
  };
  const lines = [title];
  if (meta.startedAt !== "") lines.push(`started ${exact(meta.startedAt)}`);
  if (meta.lastActive !== "") lines.push(`last active ${exact(meta.lastActive)}`);
  return lines.join("\n");
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
export type NodeRect = { target: CanvasTarget; x: number; y: number; width: number; height: number };

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
 * CHILD_HEIGHT` at the parent's position plus the child's relative position, slot or stored)
 * and its `more` row (a child-sized rect in its slot) when it has one. Collapsed children,
 * and children hidden past {@link SHOW_LIMIT}, are not drawn, so they are not candidates. The list order (projects in workspace order, each with its children) is
 * the tie-breaker of the searches.
 */
export function nodeRects(projects: readonly Project[], children: readonly ChildNode[], showAll: readonly string[] = []): NodeRect[] {
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
    const { visible, more, slotted } = visibleChildren(kids, showAll.includes(project.id));
    const slots = layoutChildren(visible);
    visible.forEach((child, index) => {
      const slot = slots[index] ?? columnSlot(index);
      out.push({
        target: { kind: child.kind, id: child.id },
        x: project.position.x + slot.x,
        y: project.position.y + slot.y,
        width: CHILD_WIDTH,
        height: CHILD_HEIGHT,
      });
    });
    if (more) {
      const slot = columnSlot(slotted);
      out.push({
        target: { kind: "more", id: project.id },
        x: project.position.x + slot.x,
        y: project.position.y + slot.y,
        width: CHILD_WIDTH,
        height: CHILD_HEIGHT,
      });
    }
  }
  return out;
}

function centreOf(rect: NodeRect): Position {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function sameNodeTarget(a: CanvasTarget, b: CanvasTarget): boolean {
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
