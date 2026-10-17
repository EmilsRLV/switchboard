// The live store mirrors the live-session poller's `LiveSnapshot` (`live_sessions_get`, then
// every `sessions://live`): the state of every session seen this run, the Elsewhere rows and
// the poll-failure banner. Live state only: nothing here is persisted. A busy ↔ idle flip
// arrives here, never as a workspace revision.

import { create } from "zustand";
import type { Banner, ElsewhereRow, LiveSession, LiveSnapshot, SessionState } from "../ipc";

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
