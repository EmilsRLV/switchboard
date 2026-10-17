// UI-only state that no snapshot from Rust carries: which pane (if any) slides in from the
// right, and which project nodes are being flashed (a duplicate add highlights the node that
// is already there). Panes are mutually exclusive: opening one closes the other.

import { create } from "zustand";

export type Pane = "settings" | "import";

/** How long a duplicate-add highlight stays on the existing node. */
export const FLASH_MS = 1500;

export type UiState = {
  /** The open pane, or `null`. */
  pane: Pane | null;
  /** Project ids currently highlighted; reference-stable while unchanged. */
  flashed: readonly string[];
  openPane: (pane: Pane) => void;
  /** Close whichever pane is open (no-op when none is). */
  closePane: () => void;
  /** Open `pane`, or close it when it is the one already open. */
  togglePane: (pane: Pane) => void;
  /** Start highlighting `ids` (adds to any already flashing). */
  flash: (ids: readonly string[]) => void;
  /** Stop highlighting `ids`; others keep flashing. */
  unflash: (ids: readonly string[]) => void;
};

const NO_IDS: readonly string[] = Object.freeze([]);

export const useUiStore = create<UiState>()((set, get) => ({
  pane: null,
  flashed: NO_IDS,
  openPane: (pane) => set({ pane }),
  closePane: () => set({ pane: null }),
  togglePane: (pane) => set({ pane: get().pane === pane ? null : pane }),
  flash: (ids) => {
    if (ids.length === 0) return;
    set((s) => {
      const next = [...s.flashed];
      for (const id of ids) if (!next.includes(id)) next.push(id);
      return next.length === s.flashed.length ? {} : { flashed: next };
    });
  },
  unflash: (ids) => {
    if (ids.length === 0) return;
    set((s) => {
      const next = s.flashed.filter((id) => !ids.includes(id));
      if (next.length === s.flashed.length) return {};
      return { flashed: next.length === 0 ? NO_IDS : next };
    });
  },
}));

/** True when a pane is open: with the palette closed, that is the `when` of `pane.close`. */
export function isPaneOpen(): boolean {
  return useUiStore.getState().pane !== null;
}
