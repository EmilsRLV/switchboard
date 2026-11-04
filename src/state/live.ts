// The live store mirrors the live-session poller's `LiveSnapshot` (`live_sessions_get`, then
// every `sessions://live`): the state of every session seen this run, the Elsewhere rows and
// the poll-failure banner. Live state only: nothing here is persisted. A busy ↔ idle flip
// arrives here, never as a workspace revision.

import { create } from "zustand";
import type { Banner, ChildNode, ElsewhereRow, LiveSession, LiveSnapshot, SessionState } from "../ipc";

export type LiveState = {
  snapshot: LiveSnapshot;
  /** True once the first snapshot arrived (so an older `get` result must not replace a push). */
  received: boolean;
  /** Why the mirror failed (rejected `live_sessions_get` / listener), if it did. */
  loadError: string | null;
  applySnapshot: (snapshot: LiveSnapshot) => void;
  setLoadError: (error: string | null) => void;
};

export const EMPTY_LIVE: LiveSnapshot = Object.freeze({
  sessions: Object.freeze({}) as Record<string, LiveSession>,
  elsewhere: Object.freeze([]) as unknown as ElsewhereRow[],
  banner: null,
});

export const useLiveStore = create<LiveState>()((set) => ({
  snapshot: EMPTY_LIVE,
  received: false,
  loadError: null,
  // A snapshot arriving means the mirror works: an earlier load error clears.
  applySnapshot: (snapshot) => set({ snapshot, received: true, loadError: null }),
  setLoadError: (loadError) => set({ loadError }),
}));

/** Every state but `exited` is a running session: what the badge counts and attach needs. */
export function isLiveState(state: SessionState): boolean {
  return state.kind !== "exited";
}

/** The word a card or tray row shows for a state: its kind, or the raw status for `other`. */
export function stateWord(state: SessionState): string {
  return state.kind === "other" ? state.raw : state.kind;
}

/** Two states read the same (same kind, and the same raw word for `other`). */
export function sameState(a: SessionState | null, b: SessionState | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.kind !== b.kind) return false;
  return a.kind !== "other" || (b.kind === "other" && a.raw === b.raw);
}

/** The live session with this id, when the poll has seen one this run and it is still live. */
export function liveSession(id: string): LiveSession | null {
  const sessions = useLiveStore.getState().snapshot.sessions;
  // An own-property read, so ids like `constructor` find nothing.
  const session = Object.hasOwn(sessions, id) ? sessions[id] : undefined;
  return session !== undefined && isLiveState(session.state) ? session : null;
}

/** Id of the banner that carries the poll failure (`banner` of the snapshot). */
export const LIVE_BANNER_ID = "claude.agents";
/** Id of the synthetic banner that carries `loadError`. */
export const LIVE_LOAD_ERROR_BANNER_ID = "live.load";

const NO_BANNERS: readonly Banner[] = Object.freeze([]);
let memoBanner: string | null | undefined;
let memoError: string | null | undefined;
let memoResult: readonly Banner[] = NO_BANNERS;

/**
 * The live store's banners: `claude.agents` after three failed polls in a row (Rust sets and
 * clears the text), then `live.load` while the mirror itself has failed. Empty and
 * reference-stable otherwise.
 */
export function selectLiveBanners(state: LiveState): readonly Banner[] {
  const banner = state.snapshot.banner;
  if (banner !== memoBanner || state.loadError !== memoError) {
    memoBanner = banner;
    memoError = state.loadError;
    const out: Banner[] = [];
    if (banner !== null) out.push({ id: LIVE_BANNER_ID, text: banner });
    if (state.loadError !== null) out.push({ id: LIVE_LOAD_ERROR_BANNER_ID, text: state.loadError });
    memoResult = out.length === 0 ? NO_BANNERS : out;
  }
  return memoResult;
}

/** How many sessions the Elsewhere tray lists (its chip shows only above 0). */
export function elsewhereCount(): number {
  return useLiveStore.getState().snapshot.elsewhere.length;
}

// --- attention (Story 3.3) -----------------------------------------------------------------

/** `finished` and `waiting`: the session needs the operator (accent card, project glow). */
export function needsAttention(state: SessionState | null | undefined): boolean {
  return state !== null && state !== undefined && (state.kind === "finished" || state.kind === "waiting");
}

/** The state the poll last gave session `id` (exited included); `null` when it has not seen it this run. */
export function sessionState(id: string, sessions: Readonly<Record<string, LiveSession>> = useLiveStore.getState().snapshot.sessions): SessionState | null {
  return Object.hasOwn(sessions, id) ? (sessions[id]?.state ?? null) : null;
}

/**
 * Session ids whose acknowledgement was sent and whose snapshot has not come back yet: they
 * are left out of the `attention.next` queue so a second `ctrl+j` goes on to the next one.
 */
const acknowledging = new Set<string>();

/**
 * Apply Rust's reply to an acknowledgement of `id` sent with `since`: only that session (and
 * its Elsewhere row) is taken from `reply`, and only while the store still shows the turn that
 * was acknowledged, so a newer event already applied is never rolled back.
 */
export function applyAcknowledgement(id: string, since: number | null, reply: LiveSnapshot): void {
  const current = useLiveStore.getState().snapshot;
  const now = Object.hasOwn(current.sessions, id) ? current.sessions[id] : undefined;
  const acked = Object.hasOwn(reply.sessions, id) ? reply.sessions[id] : undefined;
  if (now === undefined || acked === undefined || !needsAttention(now.state) || now.attention_since !== since) return;
  useLiveStore.getState().applySnapshot({
    ...current,
    sessions: { ...current.sessions, [id]: acked },
    elsewhere: current.elsewhere.map((row) => (row.session_id === id ? { ...row, state: acked.state } : row)),
  });
}

/** Note that `id`'s acknowledgement is on its way (see {@link attentionQueue}). */
export function markAcknowledging(id: string): void {
  acknowledging.add(id);
}

/** Forget a pending acknowledgement (it failed, or changed nothing). */
export function unmarkAcknowledging(id: string): void {
  acknowledging.delete(id);
}

/** True while `id`'s acknowledgement is on its way. */
export function isAcknowledging(id: string): boolean {
  return acknowledging.has(id);
}

// A snapshot in which a session no longer needs attention settles its acknowledgement.
useLiveStore.subscribe((live) => {
  for (const id of [...acknowledging]) {
    if (!needsAttention(sessionState(id, live.snapshot.sessions))) acknowledging.delete(id);
  }
});

/**
 * Whether project `projectId` glows: any of its session children (drawn or hidden, collapsed
 * or not) needs attention by the live map, looked up by session id as the cards do.
 */
export function projectAttention(
  projectId: string,
  children: readonly ChildNode[],
  sessions: Readonly<Record<string, LiveSession>> = useLiveStore.getState().snapshot.sessions,
): boolean {
  return children.some((child) => child.projectId === projectId && child.kind === "session" && needsAttention(sessionState(child.id, sessions)));
}

/** A session on a canvas project that needs the operator, as `attention.next` visits it. */
export type AttentionTarget = { sessionId: string; projectId: string; since: number };

/**
 * The sessions on canvas projects (session children, keyed by the child's project) that need
 * attention and are not being acknowledged, the one waiting longest first (`attention_since`,
 * then id).
 */
export function attentionQueue(
  children: readonly ChildNode[],
  sessions: Readonly<Record<string, LiveSession>> = useLiveStore.getState().snapshot.sessions,
): AttentionTarget[] {
  return attentionOrder(children, sessions, (id) => !acknowledging.has(id));
}

/**
 * The session children that need attention, the one waiting longest first (`attention_since`,
 * then id): {@link attentionQueue}'s order, kept to the ids `keep` accepts. Pure: the canvas
 * glow's title (Story 11.5) names the first of a project's, the one `ctrl+j` would pick there.
 */
export function attentionOrder(
  children: readonly ChildNode[],
  sessions: Readonly<Record<string, LiveSession>>,
  keep: (sessionId: string) => boolean = () => true,
): AttentionTarget[] {
  const out: AttentionTarget[] = [];
  const seen = new Set<string>();
  for (const child of children) {
    if (child.kind !== "session" || seen.has(child.id) || !keep(child.id)) continue;
    const session = Object.hasOwn(sessions, child.id) ? sessions[child.id] : undefined;
    if (session === undefined || !needsAttention(session.state)) continue;
    seen.add(child.id);
    out.push({ sessionId: child.id, projectId: child.projectId, since: session.attention_since ?? Number.MAX_SAFE_INTEGER });
  }
  return out.sort((a, b) => a.since - b.since || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
}
