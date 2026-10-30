// The actions behind edges (Story 6.1): linking two nodes (a drag between cards, or "Link to…"
// from the keyboard), selecting an edge, labelling and deleting it. Rust owns the edges: the UI
// sends only the two ends, Rust picks the kind and refuses an invalid pair, and its refusal is
// the notice (never a banner, never a throw). The local check (`canvas/edges`) only drives the
// drag feedback and the pick list.

import { checkFlowLink, cooperateSides, drawnFlowIds, edgeChoices, linkTargets, nodeRefOf } from "../canvas/edges";
import { edgeAdd, edgeLiveRetry, edgeRemove, edgeRestartWithFlags, edgeSetLabel, type Edge, type NodeRef, type SkippedEdge } from "../ipc";
import { canRetryLive, edgeLive, isCooperate, isSessionContext, useEdgesLiveStore } from "../state/edgesLive";
import { terminalInfo, useTerminalStore } from "../state/terminals";
import { disposeView, restore } from "../terminal/registry";
import { skippedNote } from "./launch";
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
 * is open (or covered by Help): then the edge is only selected ("Inspect edge" opens the inspector).
 */
export function showEdge(id: string): void {
  const ui = useUiStore.getState();
  ui.closeContextMenu();
  ui.select({ kind: "edge", id });
  // Help over a sheet (Story 10.2) counts as that sheet: opening the inspector would drop its form.
  const { pane: open, helpReturn } = useUiStore.getState();
  const pane = open === "help" ? helpReturn : open;
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

/** The sessions of cooperate edge `edge` whose side failed or a draft holds back (Story 6.4). */
export function retryableSides(edge: Edge): string[] {
  if (!isCooperate(edge)) return [];
  return cooperateSides(edge, useEdgesLiveStore.getState().entries)
    .filter((side) => canRetryLive(side.live))
    .map((side) => side.sessionId);
}

/**
 * The `when` of `edge.retry` ("Retry edge", Story 6.3): the selected edge is a context edge from
 * a session whose `/add-dir` failed, or that a draft in the prompt holds back; or (Story 6.4) a
 * cooperate edge with such a side.
 */
export function canRetryEdge(): boolean {
  const edge = selectedEdge();
  if (edge === null) return false;
  return (isSessionContext(edge) && canRetryLive(edgeLive(edge.id))) || retryableSides(edge).length > 0;
}

/**
 * `edge.retry`: run the edge's `/add-dir` injection again, or (with `sessionId`, a cooperate
 * edge's side) send that side's peer line again. A refusal is the notice.
 */
export async function retryEdge(id: string, sessionId?: string): Promise<boolean> {
  try {
    await (sessionId === undefined ? edgeLiveRetry(id) : edgeLiveRetry(id, sessionId));
    return true;
  } catch (err) {
    notify(describe(err));
    return false;
  }
}

/** `edge.retry` on the selected edge: a context edge, or every retryable side of a cooperate edge. */
export async function retrySelectedEdge(): Promise<boolean> {
  const edge = selectedEdge();
  if (edge === null) return false;
  if (!isCooperate(edge)) return retryEdge(edge.id);
  const results = await Promise.all(retryableSides(edge).map((session) => retryEdge(edge.id, session)));
  return results.length > 0 && results.every(Boolean);
}

/**
 * The `when` of `edge.restartWithFlags` ("Restart with flags", Story 6.3): the selected edge is a
 * context edge from a session. Always offered for one, whatever its live state.
 */
export function canRestartEdge(): boolean {
  const edge = selectedEdge();
  return edge !== null && isSessionContext(edge);
}

/** Session ids a Restart with flags was sent for and has not replied yet (Rust guards them too). */
const restarting = new Set<string>();

/** The notice after a Restart with flags: `restarted with flags`, the edges that gave no folder first. */
export function restartedNotice(skipped?: readonly SkippedEdge[]): string {
  const without = skippedNote("restarted without", skipped);
  return without === null ? "restarted with flags" : `${without} · restarted with flags`;
}

/**
 * `edge.restartWithFlags`: Rust stops the edge's session as Stop does, waits for its exit and
 * resumes the same id with its context edges as `--add-dir`. The terminal's view starts afresh on
 * the new run. A refusal (no transcript: nothing was stopped) is the notice.
 */
export async function restartEdge(id: string): Promise<boolean> {
  const edge = workspaceEdges().find((e) => e.id === id);
  const session = edge?.from.type === "session" ? edge.from.id : id;
  if (restarting.has(session)) {
    notify("that session is already restarting");
    return false;
  }
  restarting.add(session);
  try {
    const started = await edgeRestartWithFlags(id);
    const termId = started.term.id;
    // The new run's output counts from 0 again: its view replays the fresh buffer.
    if (terminalInfo(termId) !== null) {
      disposeView(termId);
      useTerminalStore.getState().remove([termId]);
    }
    useTerminalStore.getState().upsert(started.term);
    restore(termId).catch((err: unknown) => notify(describe(err)));
    notify(restartedNotice(started.skipped));
    return true;
  } catch (err) {
    notify(describe(err));
    return false;
  } finally {
    restarting.delete(session);
  }
}

/** `edge.restartWithFlags` on the selected edge. */
export async function restartSelectedEdge(): Promise<boolean> {
  const edge = selectedEdge();
  return edge === null ? false : restartEdge(edge.id);
}
