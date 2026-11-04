// The edges-live store mirrors Story 6.3's live edge state (`edges_live_get`, then every
// `edges://live`): what each context edge drawn from a running session does now -- pending,
// applied or failed, with a detail -- and (Story 6.4) each side of a cooperate edge, keyed
// `<edgeId>#<sessionId>`: pending, notified or failed. Rust owns it; runtime only, never
// persisted. After an app restart it is empty, and the inspector says what an edge does at the
// next launch or resume.

import { create } from "zustand";
import { edgeLiveIn, liveStateText, SIDE_NOT_LIVE } from "../canvas/edges";
import type { Edge, EdgeLive, EdgesLiveMap } from "../ipc";

export type EdgesLiveStoreState = {
  entries: EdgesLiveMap;
  /** True once the first map arrived (so an older `get` result must not replace a push). */
  received: boolean;
  /** Why the mirror failed, if it did. */
  loadError: string | null;
  applySnapshot: (entries: EdgesLiveMap) => void;
  setLoadError: (error: string | null) => void;
};

export const EMPTY_EDGES_LIVE: EdgesLiveMap = Object.freeze({}) as EdgesLiveMap;

export const useEdgesLiveStore = create<EdgesLiveStoreState>()((set) => ({
  entries: EMPTY_EDGES_LIVE,
  received: false,
  loadError: null,
  applySnapshot: (entries) => set({ entries, received: true, loadError: null }),
  setLoadError: (loadError) => set({ loadError }),
}));

/** Edge `id`'s live state now, or `null`. */
export function edgeLive(id: string): EdgeLive | null {
  return edgeLiveIn(useEdgesLiveStore.getState().entries, id);
}

/** The pending detail Rust sets while the operator's draft holds the line back (`live_edges::TYPING`). */
export const TYPING_DETAIL = "you're typing — Retry when done";

/** A context edge from a session: the only kind applied to a running session with `/add-dir` (Retry, Restart with flags). */
export function isSessionContext(edge: Pick<Edge, "kind" | "from">): boolean {
  return edge.kind === "context" && edge.from.type === "session";
}

/** A cooperate edge between two sessions (Story 6.4): each running end is sent a peer line, per side. */
export function isCooperate(edge: Pick<Edge, "kind" | "from" | "to">): boolean {
  return edge.kind === "cooperate" && edge.from.type === "session" && edge.to.type === "session";
}

/** Whether Retry applies: the edge failed, or a draft holds it back. */
export function canRetryLive(live: EdgeLive | null): boolean {
  return live !== null && (live.state === "failed" || (live.state === "pending" && live.detail === TYPING_DETAIL));
}

/**
 * The inspector's "Now:" line: the live state and its detail (`pending (waiting for idle)`,
 * `applied`, `failed (not confirmed)`); with none, what the edge does at the next launch or
 * resume. `null` for a cooperate edge (it has one line per side: {@link sideNowText}).
 */
export function nowText(edge: Pick<Edge, "kind" | "from">, live: EdgeLive | null): string | null {
  if (edge.kind !== "context") return null;
  if (live !== null) return liveStateText(live);
  if (edge.from.type === "project") return "--add-dir for every new session on this project";
  return "--add-dir at the next resume";
}

/**
 * One side's "Now:" line of a cooperate edge (Story 6.4): `<name>: notified`, `<name>: pending
 * (waiting for idle)`, `<name>: failed (not confirmed)`; with no live state, the peer is in that
 * session's prompt at its next resume.
 */
export function sideNowText(name: string, live: EdgeLive | null): string {
  return `${name}: ${live === null ? SIDE_NOT_LIVE : liveStateText(live)}`;
}
