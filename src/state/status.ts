// The status store mirrors the git poller's `project id → ProjectStatus` map
// (`projects_status_get`, then every `projects://status`). Live state only: nothing here is
// persisted, and a project absent from the map has simply not been polled yet.

import { create } from "zustand";
import type { Banner, ProjectStatusMap } from "../ipc";

export type StatusState = {
  statuses: ProjectStatusMap;
  /** True once the first map arrived (so an older `get` result must not replace a push). */
  received: boolean;
  /** Why the mirror failed (rejected `projects_status_get` / listener), if it did. */
  loadError: string | null;
  applyStatuses: (statuses: ProjectStatusMap) => void;
  setLoadError: (error: string | null) => void;
};

const NO_STATUSES: ProjectStatusMap = Object.freeze({});

export const useStatusStore = create<StatusState>()((set) => ({
  statuses: NO_STATUSES,
  received: false,
  loadError: null,
  applyStatuses: (statuses) => set({ statuses, received: true }),
  setLoadError: (loadError) => set({ loadError }),
}));

/** Id of the synthetic banner that carries `loadError`. */
export const STATUS_LOAD_ERROR_BANNER_ID = "status.load";

const NO_BANNERS: readonly Banner[] = Object.freeze([]);
let memoError: string | null | undefined;
let memoResult: readonly Banner[] = NO_BANNERS;

/** A `status.load` banner while the status mirror has failed; empty (and reference-stable) otherwise. */
export function selectStatusBanners(state: StatusState): readonly Banner[] {
  if (state.loadError !== memoError) {
    memoError = state.loadError;
    memoResult = state.loadError === null ? NO_BANNERS : [{ id: STATUS_LOAD_ERROR_BANNER_ID, text: state.loadError }];
  }
  return memoResult;
}
