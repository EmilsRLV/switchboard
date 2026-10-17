// Going to the sessions that need the operator (Story 3.3). Two ways in: `attention.next`
// (`ctrl+j`, the palette) visits the session that has waited longest, and a click on an OS
// toast (Rust focuses the window and emits `notify://reveal`) reveals that toast's session.
// Both end the same way: the session's project is expanded when collapsed (persisted, like
// the chevron), the session is drawn (its project shows all children when it sat past the
// cut), selected (which acknowledges it: `state/ui`) and panned into view with the arrow
// keys' reveal. An Elsewhere session's toast opens the Elsewhere tray instead.

import { visibleChildren } from "../canvas/nodes";
import type { RevealRequest } from "../ipc";
import { attentionQueue, markAcknowledging, needsAttention, sessionState, unmarkAcknowledging, useLiveStore } from "../state/live";
import { sameTarget, sendAcknowledge, useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { notify, revealTarget } from "./navigation";
import { setExpanded } from "./nodes";

/** The notice when `attention.next` could not reveal its session. */
export function revealFailedNotice(sessionId: string): string {
  return `Could not go to session ${sessionId.slice(0, 8)}`;
}

/** The sessions on canvas projects that need attention, the one waiting longest first. */
export function attentionTargets(): ReturnType<typeof attentionQueue> {
  return attentionQueue(useWorkspaceStore.getState().snapshot?.children ?? []);
}

/** The `when` of `attention.next`: some session on a canvas project needs attention. */
export function canGoToAttention(): boolean {
  return attentionTargets().length > 0;
}

/** The project a session child sits under, from the workspace store now; `null` when gone. */
function placement(sessionId: string): { projectId: string; expanded: boolean } | null {
  const snapshot = useWorkspaceStore.getState().snapshot;
  const child = snapshot?.children.find((c) => c.kind === "session" && c.id === sessionId);
  const project = child === undefined ? undefined : snapshot?.workspace.projects.find((p) => p.id === child.projectId);
  return project === undefined ? null : { projectId: project.id, expanded: project.expanded };
}

/**
 * Reveal and select session `sessionId` on the canvas: expand its project when collapsed
 * (persisted), show all of the project's children when the session sits past the cut, select
 * it and pan it into view. A session that needs attention is marked as being acknowledged
 * before anything is awaited (so a quick second `ctrl+j` moves on) and acknowledged once
 * selected. Resolves false when it is not a child of a canvas project, the expand failed, or
 * the session or its project went away meanwhile.
 */
export async function revealSession(sessionId: string): Promise<boolean> {
  const before = placement(sessionId);
  if (before === null) return false;
  const acknowledge = needsAttention(sessionState(sessionId));
  if (acknowledge) markAcknowledging(sessionId);
  const fail = () => {
    if (acknowledge) unmarkAcknowledging(sessionId);
    return false;
  };
  if (!before.expanded && !(await setExpanded(before.projectId, true))) return fail();
  const after = placement(sessionId);
  if (after === null) return fail();

  const ui = useUiStore.getState();
  const kids = (useWorkspaceStore.getState().snapshot?.children ?? []).filter((c) => c.projectId === after.projectId);
  const shown = ui.showAll.includes(after.projectId);
  // Only ever turn show-all on: toggling would hide the column's tail when it is already on.
  if (!shown && !visibleChildren(kids, false).visible.some((c) => c.kind === "session" && c.id === sessionId)) {
    ui.toggleShowAll(after.projectId);
  }

  const target = { kind: "session", id: sessionId } as const;
  if (!sameTarget(ui.selection, target)) ui.select(target);
  // The selection subscription skips a session already marked; acknowledge it here.
  if (acknowledge) sendAcknowledge(sessionId);
  revealTarget(target);
  return true;
}

/**
 * `attention.next`: reveal and select the session that has needed attention longest; when
 * that fails, say so in the notice.
 */
export async function goToNextAttention(): Promise<boolean> {
  const next = attentionTargets()[0];
  if (next === undefined) return false;
  const revealed = await revealSession(next.sessionId);
  if (!revealed) notify(revealFailedNotice(next.sessionId));
  return revealed;
}

/**
 * A toast was clicked (Rust already focused the window): when its session still needs
 * attention, reveal and select it on the canvas, or open the Elsewhere tray for an Elsewhere
 * session (opening it acknowledges what it lists). Resolves whether anything was revealed.
 */
export async function revealToastSession(request: RevealRequest): Promise<boolean> {
  const id = request.session_id;
  if (!needsAttention(sessionState(id))) return false;
  if (placement(id) !== null) return revealSession(id);
  if (useLiveStore.getState().snapshot.elsewhere.some((row) => row.session_id === id)) {
    useUiStore.getState().openElsewhere();
    return true;
  }
  return false;
}
