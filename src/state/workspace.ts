// The workspace store mirrors Rust's `WorkspaceSnapshot` (`workspace_get`, then every
// `workspace://changed`). The frontend never writes `workspace.json`: a viewport change goes
// through `workspaceSetViewport` and comes back as a snapshot.

import { create } from "zustand";
import type { Banner, Viewport, WorkspaceSnapshot } from "../ipc";

export type WorkspaceState = {
  /** Last snapshot from Rust; `null` until the first one arrives. */
  snapshot: WorkspaceSnapshot | null;
  /**
   * Why the last round trip failed (rejected `workspace_get` / listener / viewport write), if
   * it did. Shown as the `workspace.load` banner; cleared by the next successful write.
   */
  loadError: string | null;
  applySnapshot: (snapshot: WorkspaceSnapshot | null) => void;
  setLoadError: (error: string | null) => void;
};

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  snapshot: null,
  loadError: null,
  // Two writes in flight can resolve out of order; Rust numbers every mutation, so a reply
  // older than what is already shown is dropped. `null` always clears.
  applySnapshot: (snapshot) =>
    set((s) => (snapshot !== null && s.snapshot !== null && snapshot.revision < s.snapshot.revision ? {} : { snapshot })),
  setLoadError: (loadError) => set({ loadError }),
}));

/** True when the snapshot lists at least one child for the project (the chevron's condition). */
export function projectHasChildren(projectId: string): boolean {
  return useWorkspaceStore.getState().snapshot?.children.some((child) => child.projectId === projectId) ?? false;
}

// A stable empty list so selectors return the same reference while there is nothing to show
// (a fresh `[]` per call would make React's store subscription re-render forever).
const NO_BANNERS: readonly Banner[] = Object.freeze([]);

/** Id of the synthetic banner that carries `loadError`. */
export const LOAD_ERROR_BANNER_ID = "workspace.load";

// `selectWorkspaceBanners` must return a stable reference for unchanged inputs; the only
// case that builds a new array (a load error) is memoised on the two inputs it reads.
let memoSnapshot: WorkspaceSnapshot | null | undefined;
let memoError: string | null | undefined;
let memoResult: readonly Banner[] = NO_BANNERS;

/**
 * The workspace's banners: Rust's (parse / read / write / version / viewport) followed by a
 * synthetic `workspace.load` one while `loadError` is set. Empty (and reference-stable)
 * until there is something to show.
 */
export function selectWorkspaceBanners(state: WorkspaceState): readonly Banner[] {
  const { snapshot, loadError } = state;
  if (snapshot !== memoSnapshot || loadError !== memoError) {
    memoSnapshot = snapshot;
    memoError = loadError;
    const own = snapshot?.banners ?? NO_BANNERS;
    memoResult = loadError === null ? own : [...own, { id: LOAD_ERROR_BANNER_ID, text: loadError }];
  }
  return memoResult;
}

/**
 * The top strip's list: settings banners first, then the workspace's. Returns one of the
 * inputs (or the shared empty list) when the other is empty, so nothing is allocated in the
 * common case.
 */
export function mergeBanners(settings: readonly Banner[], workspace: readonly Banner[]): readonly Banner[] {
  if (workspace.length === 0) return settings.length === 0 ? NO_BANNERS : settings;
  if (settings.length === 0) return workspace;
  return [...settings, ...workspace];
}

/** A pan of this many pixels or less is not worth a write. */
export const VIEWPORT_PAN_EPSILON = 0.5;
/** A zoom change of this much or less is not worth a write. */
export const VIEWPORT_ZOOM_EPSILON = 0.001;

/**
 * True when `a` and `b` differ by more than 0.5 px on either axis or more than 0.001 in
 * zoom: the end of a gesture is persisted only then, so a click without a drag, or a wheel
 * tick that the zoom limits swallowed, writes nothing.
 */
export function viewportDiffers(a: Viewport, b: Viewport): boolean {
  return (
    Math.abs(a.x - b.x) > VIEWPORT_PAN_EPSILON ||
    Math.abs(a.y - b.y) > VIEWPORT_PAN_EPSILON ||
    Math.abs(a.zoom - b.zoom) > VIEWPORT_ZOOM_EPSILON
  );
}

export type PersistDeps = {
  /** The viewport most recently handed to `send`, acknowledged or not; `null` before the first. */
  lastSent: Viewport | null;
  /** The viewport in the last snapshot from Rust; `undefined` before the first snapshot. */
  stored: Viewport | undefined;
  hasRuntime: boolean;
  /** `workspaceSetViewport`, or a stand-in. Called synchronously, before any await. */
  send: (viewport: Viewport) => Promise<WorkspaceSnapshot>;
  apply: (snapshot: WorkspaceSnapshot) => void;
  fail: (message: string) => void;
};

/**
 * The end-of-gesture decision: send `viewport` to Rust unless it is where the canvas already
 * is. "Already is" means the last viewport *sent*, when there is one, not the last one
 * acknowledged, so a gesture back to the start while a write is in flight is still written.
 * With no stored viewport yet, send. Resolves with the viewport sent, or `null` when
 * skipped; a rejected send is reported through `fail`, never thrown.
 */
export async function persistViewport(viewport: Viewport, deps: PersistDeps): Promise<Viewport | null> {
  const baseline = deps.lastSent ?? deps.stored;
  if (baseline !== undefined && !viewportDiffers(viewport, baseline)) return null;
  if (!deps.hasRuntime) return null;
  try {
    deps.apply(await deps.send(viewport));
  } catch (err) {
    deps.fail(`workspace write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return viewport;
}
