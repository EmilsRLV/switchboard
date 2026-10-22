// The edges-live store mirrors Story 6.3's live edge state (`edges_live_get`, then every
// `edges://live`): what each context edge drawn from a running session does now -- pending,
// applied or failed, with a detail. Rust owns it; runtime only, never persisted. After an app
// restart it is empty, and the inspector says what an edge does at the next launch or resume.

import { create } from "zustand";
import { edgeLiveIn } from "../canvas/edges";
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

/** A context edge from a session: the only kind applied to a running session (Retry, Restart with flags). */
export function isSessionContext(edge: Pick<Edge, "kind" | "from">): boolean {
  return edge.kind === "context" && edge.from.type === "session";
}

/** Whether Retry applies: the edge failed, or a draft holds it back. */
export function canRetryLive(live: EdgeLive | null): boolean {
  return live !== null && (live.state === "failed" || (live.state === "pending" && live.detail === TYPING_DETAIL));
}

/**
 * The inspector's "Now:" line: the live state and its detail (`pending (waiting for idle)`,
 * `applied`, `failed (not confirmed)`); with none, what the edge does at the next launch or
 * resume. `null` for a cooperate edge (nothing to say yet).
 */
export function nowText(edge: Pick<Edge, "kind" | "from">, live: EdgeLive | null): string | null {
  if (live !== null) return live.detail === null ? live.state : `${live.state} (${live.detail})`;
  if (edge.kind !== "context") return null;
  if (edge.from.type === "project") return "--add-dir for every new session on this project";
  return "--add-dir at the next resume";
}
