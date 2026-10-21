// Pure helpers behind stored edges (Story 6.1): which pairs may be linked and as what kind (a
// mirror of Rust's `graph::edge_kind`, for the drag feedback and the "Link to…" list -- Rust
// still decides), the xyflow edges the canvas draws, and the words the inspector and the pick
// list use. No React, no DOM.

import type { Edge as FlowEdge } from "@xyflow/react";
import type { ChildNode, Edge, EdgeKind, NodeRef, Project } from "../ipc";
import { childFlowId, edgeFlowId, flowIdOf, nodeRects, parseFlowId, type CanvasFlowNode, type CanvasTarget } from "./nodes";

/** The id of a session or project card's link handle (the drag source, on its right edge). */
export const LINK_SOURCE_HANDLE = "link-out";
/**
 * An inert anchor on a session or project card's left edge: where an edge leaves its source when
 * the target card lies to the left, so it never sweeps back across the canvas.
 */
export const LINK_SOURCE_LEFT_HANDLE = "link-out-left";
/** The id of the drop target every project, branch and session card carries (the whole card). */
export const LINK_TARGET_HANDLE = "link-in";
/**
 * An inert anchor on every card's right edge: where an edge between two cards of one column ends,
 * so it curves out to the right and back instead of looping across the cards.
 */
export const LINK_TARGET_RIGHT_HANDLE = "link-in-right";
/** The id of the inert "forked from" anchors (Story 4.4), so a fork line never picks a link handle. */
export const FORK_HANDLE = "fork";

/** Refusals, word for word as Rust's `graph::REFUSE_*`: the notice a refused link shows. */
export const REFUSE_SELF = "can't link a node to itself";
export const REFUSE_FROM_BRANCH = "can't link from a branch";
export const REFUSE_PROJECT_TO_SESSION = "can't link a project to a session";
export const REFUSE_FOLDER = "can't link a folder yet: folder targets come later";
export const REFUSE_DUPLICATE = "already linked";
/** A drop on something that is not a link node (a `more` row): refused, with no notice. */
export const REFUSE_NOT_A_NODE = "";

/** What a link from one node to another would be: its kind, or why it is refused. */
export type LinkCheck = { kind: EdgeKind; reason: null } | { kind: null; reason: string };

function refused(reason: string): LinkCheck {
  return { kind: null, reason };
}

/**
 * The kind of an edge from `from` to `to` (Rust's `graph::edge_kind`): `cooperate` between two
 * sessions, `context` from a session or a project to a project or a branch. A folder end, a node
 * to itself, a branch as the source and a project to a session are refused.
 */
export function edgeKindFor(from: NodeRef, to: NodeRef): LinkCheck {
  if (from.type === "folder" || to.type === "folder") return refused(REFUSE_FOLDER);
  if (from.type === to.type && from.id === to.id) return refused(REFUSE_SELF);
  if (from.type === "branch") return refused(REFUSE_FROM_BRANCH);
  if (from.type === "session" && to.type === "session") return { kind: "cooperate", reason: null };
  if (from.type === "project" && to.type === "session") return refused(REFUSE_PROJECT_TO_SESSION);
  return { kind: "context", reason: null };
}

function sameRef(a: NodeRef, b: NodeRef): boolean {
  return a.type === b.type && a.id === b.id;
}

/** True when `edges` already holds `kind` between `from` and `to` (either direction for cooperate). */
export function isDuplicateEdge(edges: readonly Edge[], kind: EdgeKind, from: NodeRef, to: NodeRef): boolean {
  return edges.some(
    (e) =>
      e.kind === kind &&
      ((sameRef(e.from, from) && sameRef(e.to, to)) || (kind === "cooperate" && sameRef(e.from, to) && sameRef(e.to, from))),
  );
}

/** {@link edgeKindFor}, then refused as `already linked` when that edge exists. */
export function checkLink(edges: readonly Edge[], from: NodeRef, to: NodeRef): LinkCheck {
  const check = edgeKindFor(from, to);
  if (check.kind !== null && isDuplicateEdge(edges, check.kind, from, to)) return refused(REFUSE_DUPLICATE);
  return check;
}

/** The edge end a canvas target names: a project, session or branch card; `null` for a `more` row or an edge. */
export function nodeRefOf(target: CanvasTarget | null): NodeRef | null {
  if (target === null || target.kind === "more" || target.kind === "edge") return null;
  return { type: target.kind, id: target.id };
}

/** The edge end of a flow node id (see {@link nodeRefOf}). */
export function nodeRefOfFlowId(flowId: string): NodeRef | null {
  return nodeRefOf(parseFlowId(flowId));
}

/** The flow id of the card an edge end names; `null` for a folder (not a node). */
export function flowIdOfRef(ref: NodeRef): string | null {
  if (ref.type === "project") return ref.id;
  if (ref.type === "folder") return null;
  return childFlowId({ kind: ref.type, id: ref.id });
}

/** {@link checkLink} for a drag between two flow nodes (xyflow's `isValidConnection`). */
export function checkFlowLink(edges: readonly Edge[], sourceFlowId: string, targetFlowId: string): LinkCheck {
  const from = nodeRefOfFlowId(sourceFlowId);
  const to = nodeRefOfFlowId(targetFlowId);
  if (from === null || to === null) return refused(REFUSE_NOT_A_NODE);
  return checkLink(edges, from, to);
}

/** What a drawn edge renders from. */
export type LinkEdgeData = { edgeId: string; label: string | null; selected: boolean };
export type LinkFlowEdge = FlowEdge<LinkEdgeData, EdgeKind>;

/**
 * The stored edges to draw: one per edge whose two end cards are both drawn (`nodes`), from the
 * source card's link handle to the target card. An edge with a hidden end -- collapsed, cut by the
 * limit, gone from the list, a folder -- is not drawn but stays stored, as fork lines behave. The
 * selected edge is marked (`is-selected`, drawn in `--focus`).
 */
export function linkFlowEdges(edges: readonly Edge[], nodes: readonly CanvasFlowNode[], selection: CanvasTarget | null): LinkFlowEdge[] {
  const drawn = new Set(nodes.filter((n) => n.type !== "more").map((n) => n.id));
  // Each card's column (its project's; a project card heads its own) and absolute x.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const placeOf = (id: string): CardPlace | undefined => {
    const node = byId.get(id);
    if (node === undefined) return undefined;
    const parent = node.parentId === undefined ? undefined : byId.get(node.parentId);
    return { column: node.parentId ?? node.id, x: node.position.x + (parent?.position.x ?? 0) };
  };
  const out: LinkFlowEdge[] = [];
  for (const edge of edges) {
    const source = flowIdOfRef(edge.from);
    const target = flowIdOfRef(edge.to);
    if (source === null || target === null || !drawn.has(source) || !drawn.has(target)) continue;
    const selected = selection !== null && selection.kind === "edge" && selection.id === edge.id;
    out.push({
      id: edgeFlowId(edge.id),
      source,
      target,
      ...edgeSides(placeOf(source), placeOf(target)),
      type: edge.kind,
      data: { edgeId: edge.id, label: edge.label, selected },
      className: selected ? "link-edge is-selected" : "link-edge",
      selectable: false,
      focusable: false,
      deletable: false,
      ariaLabel: edgeAriaLabel(edge),
    });
  }
  return out;
}

/** Where a card sits for routing: its column (the project id) and its absolute canvas x. */
export type CardPlace = { column: string; x: number };

/**
 * Which sides an edge leaves and enters by, from the cards' columns and absolute x:
 * - both cards in one project's column (a session to its own project, two sessions of one
 *   project, a project to its own branch): both right edges, so it curves out and back;
 * - the target to the left of the source: the source's left edge to the target's right edge;
 * - otherwise: the source's right edge (its drag handle) to the target's left edge.
 */
export function edgeSides(source: CardPlace | undefined, target: CardPlace | undefined): { sourceHandle: string; targetHandle: string } {
  if (source !== undefined && target !== undefined) {
    if (source.column === target.column) return { sourceHandle: LINK_SOURCE_HANDLE, targetHandle: LINK_TARGET_RIGHT_HANDLE };
    if (target.x < source.x) return { sourceHandle: LINK_SOURCE_LEFT_HANDLE, targetHandle: LINK_TARGET_RIGHT_HANDLE };
  }
  return { sourceHandle: LINK_SOURCE_HANDLE, targetHandle: LINK_TARGET_HANDLE };
}

/**
 * The flow ids of every card drawn now: the same geometry as the canvas and the arrow keys
 * (collapsed children and those cut by the limit are not drawn).
 */
export function drawnFlowIds(
  projects: readonly Project[],
  children: readonly ChildNode[],
  showAll: readonly string[],
  showAllBranches: readonly string[],
): Set<string> {
  return new Set(nodeRects(projects, children, showAll, showAllBranches).map((rect) => flowIdOf(rect.target)));
}

/** True when both end cards of `edge` are among `drawn` (flow ids): the edge is drawn. */
export function isEdgeDrawn(edge: Pick<Edge, "from" | "to">, drawn: ReadonlySet<string>): boolean {
  const source = flowIdOfRef(edge.from);
  const target = flowIdOfRef(edge.to);
  return source !== null && target !== null && drawn.has(source) && drawn.has(target);
}

/** One row of the "Select edge…" pick list. */
export type EdgeChoice = { id: string; title: string };

/**
 * The "Select edge…" pick list of `node`: its drawn edges (either end), in stored order, each
 * titled `<kind>: <other end> — <label>` (no label part when it has none).
 */
export function edgeChoices(
  node: NodeRef,
  edges: readonly Edge[],
  drawn: ReadonlySet<string>,
  projects: readonly Project[],
  children: readonly ChildNode[],
): EdgeChoice[] {
  const out: EdgeChoice[] = [];
  for (const edge of edges) {
    const other = sameRef(edge.from, node) ? edge.to : sameRef(edge.to, node) ? edge.from : null;
    if (other === null || !isEdgeDrawn(edge, drawn)) continue;
    const end = endText(other, projects, children);
    const label = end.project === null ? end.label : `${end.label} (${end.project})`;
    out.push({ id: edge.id, title: edge.label === null ? `${edge.kind}: ${label}` : `${edge.kind}: ${label} — ${edge.label}` });
  }
  return out;
}

/** An edge's accessible name: `context edge` / `cooperate edge`, then its label. */
export function edgeAriaLabel(edge: Pick<Edge, "kind" | "label">): string {
  return edge.label === null ? `${edge.kind} edge` : `${edge.kind} edge: ${edge.label}`;
}

/** What the inspector and the pick list say about an edge end. */
export type EndText = { label: string; project: string | null };

/**
 * An edge end in words: a project's label, or a child's label with its project's; a node no
 * longer listed is named by its type and id.
 */
export function endText(ref: NodeRef, projects: readonly Project[], children: readonly ChildNode[]): EndText {
  if (ref.type === "project") {
    const project = projects.find((p) => p.id === ref.id);
    return { label: project?.label ?? `project ${ref.id}`, project: null };
  }
  if (ref.type === "folder") return { label: ref.id, project: null };
  const child = children.find((c) => c.kind === ref.type && c.id === ref.id);
  if (child === undefined) return { label: `${ref.type} ${ref.id}`, project: null };
  return { label: child.label, project: projects.find((p) => p.id === child.projectId)?.label ?? null };
}

/** One row of the "Link to…" pick list. */
export type LinkTarget = { id: string; to: NodeRef; kind: EdgeKind; title: string };

/**
 * The "Link to…" pick list of `from` (`e`): every project on the canvas and every child of it
 * (sessions, then branches, as listed; collapsed ones too) that `from` may link to and is not
 * linked to yet, in canvas order, each titled `<kind>: <target label> (<project>)`.
 */
export function linkTargets(
  from: NodeRef,
  projects: readonly Project[],
  children: readonly ChildNode[],
  edges: readonly Edge[],
): LinkTarget[] {
  const out: LinkTarget[] = [];
  const add = (to: NodeRef, label: string, project: string) => {
    const check = checkLink(edges, from, to);
    if (check.kind === null) return;
    out.push({ id: `${to.type}:${to.id}`, to, kind: check.kind, title: `${check.kind}: ${label} (${project})` });
  };
  for (const project of projects) {
    add({ type: "project", id: project.id }, project.label, project.label);
    const kids = children.filter((c) => c.projectId === project.id);
    for (const kind of ["session", "branch"] as const) {
      for (const child of kids) if (child.kind === kind) add({ type: kind, id: child.id }, child.label, project.label);
    }
  }
  return out;
}
