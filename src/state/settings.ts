import { create } from "zustand";
import type { Banner, SettingsSnapshot } from "../ipc";

export type SettingsState = {
  /** Last snapshot from Rust (`settings_get` or `settings://changed`); `null` until the first. */
  snapshot: SettingsSnapshot | null;
  /** Why no snapshot could be loaded (rejected `settings_get` / listener), if that happened. */
  loadError: string | null;
  /** Whether the read-only settings pane is showing. */
  paneOpen: boolean;
  applySnapshot: (snapshot: SettingsSnapshot | null) => void;
  setLoadError: (error: string | null) => void;
  togglePane: () => void;
  openPane: () => void;
  closePane: () => void;
};

export const useSettingsStore = create<SettingsState>()((set) => ({
  snapshot: null,
  loadError: null,
  paneOpen: false,
  applySnapshot: (snapshot) => set({ snapshot }),
  setLoadError: (loadError) => set({ loadError }),
  togglePane: () => set((s) => ({ paneOpen: !s.paneOpen })),
  openPane: () => set({ paneOpen: true }),
  closePane: () => set({ paneOpen: false }),
}));

// A stable empty list so selectors return the same reference while there is no snapshot
// (a fresh `[]` per call would make React's store subscription re-render forever).
const NO_BANNERS: readonly Banner[] = Object.freeze([]);

/** The banners to show in the top strip; empty until a snapshot arrives. */
export function selectBanners(state: SettingsState): readonly Banner[] {
  return state.snapshot?.banners ?? NO_BANNERS;
}
