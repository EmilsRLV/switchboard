// The actions behind edges (Story 6.1): linking two nodes (a drag between cards, or "Link to…"
// from the keyboard), selecting an edge, labelling and deleting it. Rust owns the edges: the UI
// sends only the two ends, Rust picks the kind and refuses an invalid pair, and its refusal is
// the notice (never a banner, never a throw). The local check (`canvas/edges`) only drives the
// drag feedback and the pick list.

import { checkFlowLink, drawnFlowIds, edgeChoices, linkTargets, nodeRefOf } from "../canvas/edges";
import { edgeAdd, edgeRemove, edgeSetLabel, type Edge, type NodeRef } from "../ipc";
import { usePaletteStore } from "../state/palette";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { notify } from "./navigation";
import { mutate } from "./nodes";
import { openPane } from "./panes";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function workspaceEdges(): readonly Edge[] {
  return useWorkspaceStore.getState().snapshot?.workspace.edges ?? [];
}

/**
 * Ask Rust for an edge from `from` to `to`. Resolves with the new edge, or `null` when Rust
 * refused (its reason is the notice: `can't link a project to a session`, `already linked`, ...).
 * The snapshot with the edge arrives as `workspace://changed`.
 */
export async function link(from: NodeRef, to: NodeRef): Promise<Edge | null> {
  try {
    return await edgeAdd(from, to);
  } catch (err) {
    notify(describe(err));
    return null;
  }
}

/**
 * A drag from one card's handle released on another card that the local check refused (the
 * not-allowed state was showing): the reason is the notice. A release on empty canvas does
 * nothing (`targetFlowId` is `null`).
 */
export function refuseDrop(sourceFlowId: string, targetFlowId: string | null): void {
  if (targetFlowId === null) return;
  const check = checkFlowLink(workspaceEdges(), sourceFlowId, targetFlowId);
  // A drop on something that is no link node (a `more` row) has no reason to show.
  if (check.reason !== null && check.reason !== "") notify(check.reason);
}

/** The node "Link to…" starts from: the selected session or project card, else `null`. */
export function linkSource(): NodeRef | null {
  const ref = nodeRefOf(useUiStore.getState().selection);
  return ref !== null && (ref.type === "session" || ref.type === "project") ? ref : null;
}

/** The `when` of `edge.link` (`e`): a session or project card is selected. */
export function canLink(): boolean {
  return linkSource() !== null;
}

/**
 * `edge.link` ("Link to…", `e`): the palette as a pick list of the selected node's valid targets
 * (`<kind>: <target label> (<project>)`); Enter links, Esc cancels. With nothing to link to, the
 * notice says so.
 */
export function startLink(): boolean {
  const from = linkSource();
  const snapshot = useWorkspaceStore.getState().snapshot;
  if (from === null || snapshot === null) return false;
  const targets = linkTargets(from, snapshot.workspace.projects, snapshot.children, snapshot.workspace.edges);
  if (targets.length === 0) {
    notify("nothing to link to");
    return false;
  }
  useUiStore.getState().closeContextMenu();
  usePaletteStore.getState().openPick({
    placeholder: "Link to…",
    items: targets.map(({ id, title }) => ({ id, title })),
    onPick: (id) => {
      const target = targets.find((t) => t.id === id);
      if (target !== undefined) void link(from, target.to);
    },
  });
  return true;
}

/** The selected edge, while an edge is selected and still stored; else `null`. */
export function selectedEdge(): Edge | null {
  const selection = useUiStore.getState().selection;
  if (selection === null || selection.kind !== "edge") return null;
  return workspaceEdges().find((edge) => edge.id === selection.id) ?? null;
}

/**
 * The `when` of `edge.delete` (Del): an edge is selected. With no edge selected Delete stays
 * unbound (the key does nothing). In a text field (the label) Delete is the field's.
 */
export function canDeleteEdge(): boolean {
  return selectedEdge() !== null;
}

/** `edge.delete` (Del): delete the selected edge at once, no confirmation (an edge is cheap to redraw). */
export async function deleteSelectedEdge(): Promise<boolean> {
  const edge = selectedEdge();
  if (edge === null) return false;
  const done = await mutate("delete edge", () => edgeRemove(edge.id));
  if (done) {
    const ui = useUiStore.getState();
    if (ui.selection?.kind === "edge" && ui.selection.id === edge.id) ui.clearSelection();
  }
  return done;
}

/**
 * Store an edge's label (trimmed by Rust; blank clears it). The same label again sends nothing.
 * A save for an edge that is gone -- already, or by the time Rust sees it (a blur racing Delete) --
 * is dropped silently.
 */
export async function saveEdgeLabel(id: string, label: string): Promise<boolean> {
  const edge = workspaceEdges().find((e) => e.id === id);
  if (edge === undefined) return false;
  const next = label.trim() === "" ? null : label.trim();
  if (next === edge.label) return true;
  let snapshot;
  try {
    snapshot = await edgeSetLabel(id, next);
  } catch (err) {
    if (describe(err) === "unknown edge" || !workspaceEdges().some((e) => e.id === id)) return false;
    useWorkspaceStore.getState().setLoadError(`label edge failed: ${describe(err)}`);
    return false;
  }
  const store = useWorkspaceStore.getState();
  store.applySnapshot(snapshot);
  store.setLoadError(null);
  return true;
}

/** The `when` of `edge.inspect`: an edge is selected and its inspector is not showing. */
export function canInspectEdge(): boolean {
  return selectedEdge() !== null && useUiStore.getState().pane !== "edge";
}

/** `edge.inspect`: open the edge inspector for the selected edge. */
export function inspectSelectedEdge(): void {
  if (selectedEdge() !== null) openPane("edge");
}

/** The sheets an edge click must not replace: closing them loses their form. */
const SHEETS = ["launch", "worktree", "removeWorktree"] as const;

/**
 * Select edge `id` and show its inspector -- unless the launch, worktree or remove-worktree sheet
 * is open: then the edge is only selected ("Inspect edge" opens the inspector).
 */
export function showEdge(id: string): void {
  const ui = useUiStore.getState();
  ui.closeContextMenu();
  ui.select({ kind: "edge", id });
  const pane = useUiStore.getState().pane;
  if (pane === null || !(SHEETS as readonly string[]).includes(pane)) openPane("edge");
}

/** A click on an edge's line (or its label): {@link showEdge}. */
export function clickEdge(id: string): void {
  showEdge(id);
}

/** The flow ids of the cards drawn now. */
function drawnNow(): Set<string> {
  const snapshot = useWorkspaceStore.getState().snapshot;
  if (snapshot === null) return new Set();
  const { showAll, showAllBranches } = useUiStore.getState();
  return drawnFlowIds(snapshot.workspace.projects, snapshot.children, showAll, showAllBranches);
}

/** The "Select edge…" rows of the selected node: its drawn edges. */
function selectableEdges() {
  const node = nodeRefOf(useUiStore.getState().selection);
  const snapshot = useWorkspaceStore.getState().snapshot;
  if (node === null || snapshot === null) return [];
  return edgeChoices(node, snapshot.workspace.edges, drawnNow(), snapshot.workspace.projects, snapshot.children);
}

/** The `when` of `edge.select`: the selected node has at least one drawn edge. */
export function canSelectEdge(): boolean {
  return selectableEdges().length > 0;
}

/**
 * `edge.select` ("Select edge…"): the palette as a pick list of the selected node's drawn edges
 * (`<kind>: <other end> — <label>`); picking one selects it and opens its inspector. The keyboard
 * path to an edge.
 */
export function startSelectEdge(): boolean {
  const choices = selectableEdges();
  if (choices.length === 0) return false;
  useUiStore.getState().closeContextMenu();
  usePaletteStore.getState().openPick({ placeholder: "Select edge…", items: choices, onPick: showEdge });
  return true;
}
