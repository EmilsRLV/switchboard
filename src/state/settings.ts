import { create } from "zustand";
import type { Banner, SettingsSnapshot } from "../ipc";

// Whether the settings pane is showing lives in `state/ui.ts` (`pane === "settings"`), with
// the other panes; this store holds only what the settings snapshot and its actions produce.

export type SettingsState = {
  /** Last snapshot from Rust (`settings_get` or `settings://changed`); `null` until the first. */
  snapshot: SettingsSnapshot | null;
  /** Why no snapshot could be loaded (rejected `settings_get` / listener), if that happened. */
  loadError: string | null;
  /** True while `binaries.redetect` is running (the pane disables its button). */
  actionBusy: boolean;
  /** Why the last `settings.reveal` / `binaries.redetect` failed; cleared when one starts. */
  actionError: string | null;
  applySnapshot: (snapshot: SettingsSnapshot | null) => void;
  setLoadError: (error: string | null) => void;
  setActionBusy: (busy: boolean) => void;
  setActionError: (error: string | null) => void;
};

export const useSettingsStore = create<SettingsState>()((set) => ({
  snapshot: null,
  loadError: null,
  actionBusy: false,
  actionError: null,
  applySnapshot: (snapshot) => set({ snapshot }),
  setLoadError: (loadError) => set({ loadError }),
  setActionBusy: (actionBusy) => set({ actionBusy }),
  setActionError: (actionError) => set({ actionError }),
}));

// A stable empty list so selectors return the same reference while there is no snapshot
// (a fresh `[]` per call would make React's store subscription re-render forever).
const NO_BANNERS: readonly Banner[] = Object.freeze([]);

/** The banners to show in the top strip; empty until a snapshot arrives. */
export function selectBanners(state: SettingsState): readonly Banner[] {
  return state.snapshot?.banners ?? NO_BANNERS;
}
